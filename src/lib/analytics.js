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
  'portfolio_project_view', 'portfolio_progress', 'portfolio_video_health'
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

let state = null;

function device() {
  const width = window.innerWidth;
  if (width <= 620) return 'mobile';
  if (width <= 1024) return 'tablet';
  return 'desktop';
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
    type,
    sid: state.sessionId,
    vid: state.visitorId,
    path: clean(window.location.pathname, 300) || '/',
    day: dayKey(),
    device: device()
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
    for (const event of pending) batch.set(sdk.doc(events), { ...event, ts: sdk.serverTimestamp() });
    await batch.commit();
  } catch (error) {
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

/**
 * Wires up capture for the life of the page.
 * @returns {() => void} cleanup
 */
export function startAnalytics() {
  if (state) return () => {};

  state = {
    sessionId: storedId(window.sessionStorage, SESSION_KEY),
    visitorId: storedId(window.localStorage, VISITOR_KEY),
    queue: [],
    count: 0,
    flushing: false,
    warned: false,
    cappedReported: false,
    scrollMark: 0,
    seenSections: new Set(),
    startedForms: new Set()
  };

  // Fetch the SDK during the first idle gap — early enough that a visitor who
  // bounces in under four seconds still gets their page view recorded, late
  // enough that it costs the initial render nothing.
  warmFirestore();

  enqueue('page_view', {
    referrer: clean(document.referrer, 400),
    // The landing query string is where campaign attribution lives.
    query: clean(window.location.search, 300),
    vw: window.innerWidth,
    vh: window.innerHeight
  });

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

    // An outbound link is a conversion of sorts — the booking calendar, a live
    // portfolio site — so it is worth separating from ordinary clicks.
    // The section comes along so a click through to a live client site can be
    // attributed to the project that sent it. The portfolio story panel carries
    // a per-project data-section for exactly this reason — without it every one
    // of these links reads "Visit the live project" and tells you nothing.
    if (href && /^https?:\/\//i.test(href) && !href.includes(window.location.host)) {
      enqueue('outbound', { label, href, section: sectionOf(node) });
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
    if (state.startedForms.has(name)) return;
    state.startedForms.add(name);
    enqueue('form_start', { label: name });
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
