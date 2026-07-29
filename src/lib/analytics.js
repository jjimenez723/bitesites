// First-party behavioural analytics.
//
// Everything the admin dashboard charts comes from here: page views, every
// click (including the ones that hit nothing — those are the interesting ones),
// how far people scroll, and which sections they actually stop on.
//
// Design notes:
//   * Events are queued in memory and flushed as a single writeBatch. A visitor
//     clicking around a page would otherwise cost one Firestore write per click.
//   * A session is capped at MAX_EVENTS so a stuck mouse (or a bored teenager)
//     cannot run the bill up. The cap is recorded rather than silently applied.
//   * Nothing here identifies a person. The visitor id is a random string in
//     localStorage used only to tell a returning browser from a new one; there
//     is no cross-site anything, and it never leaves this project.
//   * Positions are stored as fractions of the viewport/page, not pixels, so a
//     phone click and a desktop click land in the same coordinate space and the
//     click map stays meaningful across screen sizes.

import { firestore, warmFirestore } from './firestore';

const SESSION_KEY = 'bs.sid';
const VISITOR_KEY = 'bs.vid';
const GEO_SESSION_KEY = 'bs.geo';
const ATTRIBUTION_KEY = 'bs.attribution';
const INTENT_SESSION_KEY = 'bs.intent';

// A deployment can provide its commit or release id. Keeping it on every event
// makes before/after comparisons honest when the page changes mid-campaign.
const SITE_VERSION = String(import.meta.env.VITE_SITE_VERSION || import.meta.env.VITE_GIT_SHA || 'development')
  .trim().slice(0, 80);

const MAX_EVENTS_PER_SESSION = 300;
const FLUSH_SIZE = 20;
const FLUSH_INTERVAL = 4000;
const SCROLL_MARKS = [25, 50, 75, 100];

// Mirrors the `analyticsEvent` whitelist in firestore.rules. Anything not on
// this list is dropped before it can be rejected server-side.
// A type added here and *not* added to firestore.rules rejects the whole
// writeBatch it lands in, and flush() has already spliced those events off the
// queue — so the loss is silent and takes every unrelated event in the batch
// with it. The two lists change together or not at all.
const EVENT_TYPES = [
  'page_view', 'click', 'section_view', 'scroll_depth',
  'form_start', 'form_submit', 'chat_open', 'call_open', 'outbound',
  'portfolio_project_view', 'portfolio_progress', 'portfolio_video_health',
  'form_step', 'form_error', 'lead_created',
  'pricing_view', 'pricing_unlock', 'plan_select',
  'signup_start', 'signup_step', 'signup_complete', 'signup_error',
  'booking_click', 'chat_progress', 'call_state'
];

// `value` is capped at 100000 by the rules, and a dwell or load time is the one
// number here that can plausibly run past it. Clamping client-side keeps an
// unusually long visit from taking a batch of good events down with it.
export const analyticsDuration = ms => Math.max(0, Math.min(100000, Math.round(ms)));

const randomId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const clean = (value, maxLen) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLen) : '';

// A fraction, rounded to four places. Firestore stores a double either way, but
// the shorter number keeps the documents small and the charts stable.
const fraction = value => Math.round(Math.min(1, Math.max(0, value)) * 1e4) / 1e4;

function storedId(storage, key) {
  try {
    const existing = storage.getItem(key);
    if (existing) return existing;
    const created = randomId();
    storage.setItem(key, created);
    return created;
  } catch {
    // Private browsing, blocked storage, embedded webview — fall back to an
    // in-memory id so the session still reports as one session.
    return randomId();
  }
}

function storedJson(storage, key, fallback = null) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
}

const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia)\./i;

function currentTouch() {
  const params = new URLSearchParams(window.location.search);
  const referrer = clean(document.referrer, 400);
  let referrerHost = '';
  try { referrerHost = referrer ? new URL(referrer).hostname.replace(/^www\./, '') : ''; } catch { /* malformed */ }

  const explicitSource = clean(params.get('utm_source'), 100);
  const source = explicitSource || referrerHost || 'direct';
  const medium = clean(params.get('utm_medium'), 100)
    || (referrerHost ? (SEARCH_HOSTS.test(referrerHost) ? 'organic' : 'referral') : 'direct');

  const touch = {
    source,
    medium,
    landingPage: clean(window.location.pathname, 300) || '/',
    capturedAt: new Date().toISOString()
  };
  const optional = {
    campaign: clean(params.get('utm_campaign'), 160),
    content: clean(params.get('utm_content'), 160),
    term: clean(params.get('utm_term'), 160),
    referrer
  };
  for (const [key, value] of Object.entries(optional)) if (value) touch[key] = value;
  return touch;
}

function resolveAttribution() {
  const current = currentTouch();
  const previous = storedJson(window.localStorage, ATTRIBUTION_KEY, null);
  const first = previous?.first?.source ? previous.first : current;
  // Conventional last-non-direct attribution: a later direct visit should not
  // erase the channel that actually introduced the visitor.
  const last = current.source === 'direct' && previous?.last?.source ? previous.last : current;
  const attribution = { first, last };
  saveJson(window.localStorage, ATTRIBUTION_KEY, attribution);
  return attribution;
}

function campaignQuery() {
  const input = new URLSearchParams(window.location.search);
  const output = new URLSearchParams();
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = clean(input.get(key), 160);
    if (value) output.set(key, value);
  }
  const serialized = output.toString();
  return serialized ? `?${serialized}` : '';
}

let state = null;

function device() {
  const width = window.innerWidth;
  if (width <= 620) return 'mobile';
  if (width <= 1024) return 'tablet';
  return 'desktop';
}

// Location is resolved by a same-origin function from the request IP. The
// function writes the coarse result itself, so the browser never receives the
// visitor's IP or a location payload that could be tampered with. A session
// storage flag keeps reloads from spending another lookup; the server also
// deduplicates by session as a second line of defence.
async function recordLocation() {
  if (!state) return;

  const key = `${GEO_SESSION_KEY}.${state.sessionId}`;
  try {
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, 'pending');
  } catch {
    // Storage can be unavailable in private browsing. Server-side
    // deduplication still makes retrying harmless.
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch('/api/visit-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sid: state.sessionId,
        vid: state.visitorId,
        path: clean(window.location.pathname, 300) || '/',
        device: device()
      }),
      signal: controller.signal,
      keepalive: true
    });
    if (!response.ok) throw new Error(`location endpoint returned ${response.status}`);
    try { window.sessionStorage.setItem(key, 'recorded'); } catch { /* optional */ }
  } catch {
    // Location is an enhancement, never a reason to interrupt the site. Clear
    // the optimistic flag so another page load in this session may retry.
    try { window.sessionStorage.removeItem(key); } catch { /* optional */ }
  } finally {
    window.clearTimeout(timeout);
  }
}

// The day key lets the dashboard bucket by date without reading a timestamp
// back out and re-deriving the visitor's calendar day.
const dayKey = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ queueing

function enqueue(type, payload = {}) {
  if (!state || !EVENT_TYPES.includes(type)) return;

  if (state.count >= MAX_EVENTS_PER_SESSION) {
    if (!state.cappedReported) {
      state.cappedReported = true;
      console.info('[analytics] session event cap reached — no longer recording');
    }
    return;
  }
  state.count += 1;

  // `ts` is stamped at flush time instead of here: serverTimestamp() is a
  // Firestore sentinel, and this runs long before the SDK is loaded. It still
  // resolves to request.time either way, which is what the rules check.
  const event = {
    _id: randomId(),
    type,
    sid: state.sessionId,
    vid: state.visitorId,
    path: clean(window.location.pathname, 300) || '/',
    day: dayKey(),
    device: device(),
    version: SITE_VERSION
  };

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === '') continue;
    event[key] = value;
  }

  state.queue.push(event);
  if (state.queue.length >= FLUSH_SIZE) flush();
}

async function flush() {
  if (!state || state.flushing || !state.queue.length) return;

  const pending = state.queue.splice(0, 400);
  state.flushing = true;
  try {
    const { sdk, db } = await firestore();
    const batch = sdk.writeBatch(db);
    const events = sdk.collection(db, 'events');
    for (const event of pending) {
      const { _id, ...data } = event;
      batch.set(sdk.doc(events, _id), { ...data, ts: sdk.serverTimestamp() });
    }
    await batch.commit();
  } catch (error) {
    // A failed batch is atomic. Put the exact same event ids back at the front so
    // a transient network/App Check failure does not quietly turn the dashboard
    // into fiction; stable ids make a retry idempotent if the response was lost.
    if (state) state.queue.unshift(...pending);
    // Analytics must never break the site or spam the console on every flush.
    // One warning per session is enough to notice a misconfigured rule.
    if (!state.warned) {
      state.warned = true;
      console.warn('[analytics] events could not be recorded', error);
    }
  } finally {
    if (state) state.flushing = false;
  }
}

// ------------------------------------------------------------- click labelling

const ACTIONABLE = 'a,button,[role="button"],[role="tab"],summary,input,select,textarea,label';

// What did they actually click? Preference order: an explicit data-track label,
// then the accessible name of the nearest control, then the element itself —
// so the dashboard shows "Start Your Project" rather than "button.btn.btn-ai".
function describeTarget(node) {
  const tracked = node.closest?.('[data-track]');
  if (tracked) {
    return {
      label: clean(tracked.dataset.track, 80),
      interactive: true,
      href: clean(tracked.getAttribute?.('href'), 300)
    };
  }

  const control = node.closest?.(ACTIONABLE);
  if (control) {
    const name =
      control.getAttribute('aria-label') ||
      control.getAttribute('title') ||
      control.textContent ||
      control.getAttribute('placeholder') ||
      control.getAttribute('name') ||
      control.tagName.toLowerCase();
    return {
      label: clean(name, 80),
      interactive: true,
      href: clean(control.getAttribute('href'), 300)
    };
  }

  // A click on nothing still matters — a cluster of them is a control people
  // expected to exist. Label it by its container so the pattern is readable.
  const container = node.closest?.('[class]');
  const className = container?.className;
  const hint = typeof className === 'string' ? className.split(/\s+/)[0] : node.tagName?.toLowerCase();
  return { label: clean(`(no action) ${hint || 'page'}`, 80), interactive: false, href: '' };
}

// The nearest identifiable region, used to group clicks by page area.
function sectionOf(node) {
  const section = node.closest?.('section[id], section, header, footer, aside, [data-section]');
  if (!section) return '';
  return clean(
    section.dataset?.section || section.id || section.className?.split?.(/\s+/)[0] || section.tagName.toLowerCase(),
    60
  );
}

// -------------------------------------------------------------------- public

export function trackEvent(type, payload) {
  enqueue(type, payload);
}

/** Records an interaction the UI knows about but the DOM cannot name. */
export const trackInteraction = (label, extra = {}) =>
  enqueue('click', { label: clean(label, 80), interactive: true, ...extra });

export function sessionId() {
  return state?.sessionId || '';
}

export function visitorId() {
  return state?.visitorId || '';
}

/**
 * Records the commercial context behind a later lead. Pricing and CTA controls
 * set this without putting it in React state, so every conversion path shares it.
 */
export function setConversionIntent(input = {}) {
  const intent = {};
  for (const [key, max] of [['cta', 120], ['plan', 120], ['service', 80]]) {
    const value = clean(input[key], max);
    if (value) intent[key] = value;
  }
  if (state) state.intent = { ...(state.intent || {}), ...intent };
  saveJson(window.sessionStorage, INTENT_SESSION_KEY, state?.intent || intent);
}

/** A privacy-limited snapshot safe to attach to a lead or CRM payload. */
export function analyticsContext() {
  const attribution = state?.attribution || resolveAttribution();
  const intent = state?.intent || storedJson(window.sessionStorage, INTENT_SESSION_KEY, {});
  return {
    sid: state?.sessionId || storedId(window.sessionStorage, SESSION_KEY),
    vid: state?.visitorId || storedId(window.localStorage, VISITOR_KEY),
    siteVersion: SITE_VERSION,
    attribution: {
      first: attribution.first,
      last: attribution.last,
      conversion: {
        path: clean(window.location.pathname, 300) || '/',
        ...intent
      }
    }
  };
}

/**
 * Wires up capture for the life of the page.
 * @returns {() => void} cleanup
 */
export function startAnalytics() {
  if (state) return () => {};

  state = {
    sessionId: storedId(window.sessionStorage, SESSION_KEY),
    visitorId: storedId(window.localStorage, VISITOR_KEY),
    attribution: resolveAttribution(),
    intent: storedJson(window.sessionStorage, INTENT_SESSION_KEY, {}),
    queue: [],
    count: 0,
    flushing: false,
    warned: false,
    cappedReported: false,
    scrollMark: 0,
    seenSections: new Set(),
    startedForms: new Set(),
    seenFormSteps: new Set()
  };

  // Fetch the SDK during the first idle gap — early enough that a visitor who
  // bounces in under four seconds still gets their page view recorded, late
  // enough that it costs the initial render nothing.
  warmFirestore();

  enqueue('page_view', {
    referrer: clean(document.referrer, 400),
    // Keep only known campaign labels. Arbitrary query parameters sometimes
    // contain emails, tokens, or search text and do not belong in analytics.
    query: clean(campaignQuery(), 300),
    source: state.attribution.last.source,
    medium: state.attribution.last.medium,
    campaign: state.attribution.last.campaign,
    content: state.attribution.last.content,
    term: state.attribution.last.term,
    vw: window.innerWidth,
    vh: window.innerHeight
  });

  recordLocation();

  const onClick = event => {
    const node = event.target;
    if (!node || node.nodeType !== 1) return;

    const { label, interactive, href } = describeTarget(node);
    const pageHeight = Math.max(1, document.documentElement.scrollHeight);

    enqueue('click', {
      label,
      interactive,
      section: sectionOf(node),
      // Viewport-relative x, page-relative y: x tells you where across the
      // layout, y tells you how deep into the page.
      x: fraction(event.clientX / Math.max(1, window.innerWidth)),
      y: fraction((event.clientY + window.scrollY) / pageHeight),
      vw: window.innerWidth,
      vh: window.innerHeight
    });

    if (href === '#start' || href?.endsWith?.('/#start')) {
      setConversionIntent({ cta: label });
    }

    // An outbound link is a conversion of sorts — the booking calendar, a live
    // portfolio site — so it is worth separating from ordinary clicks.
    // The section comes along so a click through to a live client site can be
    // attributed to the project that sent it. The portfolio story panel carries
    // a per-project data-section for exactly this reason — without it every one
    // of these links reads "Visit the live project" and tells you nothing.
    if (href && /^https?:\/\//i.test(href) && !href.includes(window.location.host)) {
      enqueue('outbound', { label, href, section: sectionOf(node) });
      if (/calendar\.app\.google|calendly\.com|\/book(?:ing)?\b/i.test(href)) {
        setConversionIntent({ cta: label });
        enqueue('booking_click', { label, href, cta: label, step: 'calendar_opened' });
      }
    }
  };

  const onScroll = () => {
    const doc = document.documentElement;
    const scrollable = Math.max(1, doc.scrollHeight - window.innerHeight);
    const depth = Math.round(((window.scrollY + window.innerHeight) / doc.scrollHeight) * 100);
    if (scrollable < 200) return;

    for (const mark of SCROLL_MARKS) {
      if (depth >= mark && state.scrollMark < mark) {
        state.scrollMark = mark;
        enqueue('scroll_depth', { value: mark });
      }
    }
  };

  // "Seen" means half a second in view, not a pixel of overlap — otherwise a
  // fast scroll to the footer reports every section as read.
  const dwellTimers = new Map();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const id = entry.target.dataset?.section || entry.target.id;
      if (!id) continue;

      if (!entry.isIntersecting) {
        window.clearTimeout(dwellTimers.get(id));
        dwellTimers.delete(id);
        continue;
      }
      if (state.seenSections.has(id) || dwellTimers.has(id)) continue;

      dwellTimers.set(id, window.setTimeout(() => {
        dwellTimers.delete(id);
        if (state.seenSections.has(id)) return;
        state.seenSections.add(id);
        enqueue('section_view', { section: clean(id, 60) });
      }, 500));
    }
  }, { threshold: .35 });

  // Sections mount with the app, so observe on the next frame.
  const observeFrame = window.requestAnimationFrame(() => {
    document.querySelectorAll('section[id], [data-section]').forEach(node => observer.observe(node));
  });

  const onFocusIn = event => {
    const field = event.target?.closest?.('input,select,textarea');
    const form = field?.closest?.('form');
    if (!form) return;
    const name = clean(form.className || form.id || 'form', 60);
    if (!state.startedForms.has(name)) {
      state.startedForms.add(name);
      enqueue('form_start', { label: name });
    }
    const step = clean(field.name || field.id || field.type || field.tagName.toLowerCase(), 80);
    const key = `${name}:${step}`;
    if (!step || state.seenFormSteps.has(key)) return;
    state.seenFormSteps.add(key);
    enqueue('form_step', { label: name, step });
  };

  const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };

  document.addEventListener('click', onClick, { capture: true, passive: true });
  document.addEventListener('focusin', onFocusIn, { capture: true, passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flush);
  const timer = window.setInterval(flush, FLUSH_INTERVAL);

  return () => {
    document.removeEventListener('click', onClick, { capture: true });
    document.removeEventListener('focusin', onFocusIn, { capture: true });
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flush);
    window.clearInterval(timer);
    window.cancelAnimationFrame(observeFrame);
    dwellTimers.forEach(window.clearTimeout);
    observer.disconnect();
    flush();
    state = null;
  };
}
