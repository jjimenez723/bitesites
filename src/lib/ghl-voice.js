/**
 * Headless bridge to the GoHighLevel (LeadConnector) voice AI widget.
 *
 * The widget is loaded exactly as GHL ships it — so contacts, call limits,
 * captcha and the Retell session keep working — but its own markup is pushed
 * off-screen by the `chat-widget` rules in voice-receptionist.css. The BiteSites
 * voice UI is the only thing on screen: it reads the call state from, and clicks
 * the controls inside, the widget's (open) shadow root.
 *
 * The widget is configured as an embedded voiceAiChat, so it renders its orb
 * immediately — there is no launcher bubble to open first.
 */

const WIDGET_ID = '6a5eeefbfd9ec29d7c9be305';
const LOADER_SRC = 'https://widgets.leadconnectorhq.com/loader.js';
const RESOURCES_URL = 'https://widgets.leadconnectorhq.com/chat-widget/loader.js';
const READY_TIMEOUT = 25000;
const POLL_INTERVAL = 120;

// The orb keeps its call state in a class on `.voice-orb-widget`; the avatar
// layout (GHL's other voice display mode) is matched on its own markup below.
const ORB_STATES = [['is-connecting', 'connecting'], ['is-listening', 'listening'], ['is-speaking', 'speaking'], ['is-success', 'ended'], ['is-idle', 'idle']];
const LIVE_STATES = ['connecting', 'listening', 'speaking'];

let loadPromise = null;
let endPromise = null;

const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));

export const isLiveState = state => LIVE_STATES.includes(state);

function injectLoader() {
  if (document.querySelector(`script[src="${LOADER_SRC}"]`)) return;
  const script = document.createElement('script');
  script.src = LOADER_SRC;
  script.async = true;
  // The loader reads its options off the script tag and appends the widget to
  // this script's parent, so it has to live in the body.
  script.setAttribute('data-resources-url', RESOURCES_URL);
  script.setAttribute('data-widget-id', WIDGET_ID);
  document.body.appendChild(script);
}

function readControls() {
  const host = document.querySelector('chat-widget');
  const root = host?.shadowRoot;
  if (!root) return null;

  const stage = root.querySelector('.voice-orb-stage');
  if (stage) return { host, root, orb: root.querySelector('.voice-orb-widget'), start: stage, end: stage };

  const start = root.querySelector('.lc_text-widget--voice-talk-button, .lc_text-widget--voice-call-again-btn');
  const end = root.querySelector('.lc_text-widget--voice-end-call-btn, .lc_text-widget--end-call-button');
  return start || end ? { host, root, orb: null, start, end } : null;
}

/** @returns {'loading'|'idle'|'connecting'|'listening'|'speaking'|'ended'} */
export function readVoiceState() {
  const controls = readControls();
  if (!controls) return 'loading';

  if (controls.orb) {
    const match = ORB_STATES.find(([className]) => controls.orb.classList.contains(className));
    return match ? match[1] : 'idle';
  }

  const { root } = controls;
  if (root.querySelector('.lc_text-widget--voice-call-ended-screen')) return 'ended';
  if (root.querySelector('.lc_text-widget--voice-connecting-spinner')) return 'connecting';
  if (root.querySelector('.lc_text-widget--voice-active-call')) return 'listening';
  return 'idle';
}

/** Loads the widget once and resolves when its voice controls exist. */
export function loadVoiceAgent() {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const ready = readControls();
    if (ready) {
      resolve(ready);
      return;
    }

    injectLoader();
    const deadline = Date.now() + READY_TIMEOUT;
    const poll = window.setInterval(() => {
      const controls = readControls();
      if (controls) {
        window.clearInterval(poll);
        controls.host.setAttribute('aria-hidden', 'true');
        resolve(controls);
      } else if (Date.now() > deadline) {
        window.clearInterval(poll);
        reject(new Error('GoHighLevel voice widget did not load'));
      }
    }, POLL_INTERVAL);
  });

  // A failed load should not be cached forever — let the next attempt retry.
  loadPromise.catch(() => { loadPromise = null; });
  return loadPromise;
}

/**
 * Calls `listener` whenever the widget's call state changes.
 * @returns {() => void} cleanup
 */
export function observeVoiceState(listener) {
  let observer;
  let cancelled = false;
  let last = readVoiceState();

  const emit = () => {
    const next = readVoiceState();
    if (next === last) return;
    last = next;
    listener(next);
  };

  loadVoiceAgent().then(controls => {
    if (cancelled) return;
    emit();
    observer = new MutationObserver(emit);
    observer.observe(controls.root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  }).catch(() => {
    if (!cancelled) listener('unavailable');
  });

  return () => {
    cancelled = true;
    observer?.disconnect();
  };
}

/** Starts (or restarts, after a finished call) the GHL voice conversation. */
export async function startVoiceCall() {
  await loadVoiceAgent();
  if (isLiveState(readVoiceState())) return;
  readControls()?.start?.click();
}

// The widget renders a live transcript in some configurations and not others,
// and it does not version its class names for us. Rather than pin one selector
// that will rot, scan the shadow root for anything that looks like a transcript
// line and infer the speaker from its class list. If the widget stops rendering
// text entirely this returns nothing, which is the correct outcome: the
// authoritative transcript is the one GoHighLevel posts to `recordVoiceCall`.
const TRANSCRIPT_CONTAINER = '[class*="transcript"], [class*="messages"], [class*="conversation"]';
const TRANSCRIPT_LINE = '[class*="message"], [class*="transcript-item"], [class*="bubble"], li, p';
const VISITOR_HINTS = ['user', 'visitor', 'human', 'customer', 'you', 'outgoing', 'right'];

/**
 * Best-effort read of the transcript the widget has rendered so far.
 * @returns {Array<{role: 'visitor'|'byte', text: string}>}
 */
export function readVoiceTranscript() {
  const root = readControls()?.root;
  if (!root) return [];

  const container = root.querySelector(TRANSCRIPT_CONTAINER);
  if (!container) return [];

  const lines = [];
  for (const node of container.querySelectorAll(TRANSCRIPT_LINE)) {
    // Only take leaf-ish nodes, or a nested wrapper repeats its parent's text.
    if (node.querySelector(TRANSCRIPT_LINE)) continue;

    const text = node.textContent?.trim().replace(/\s+/g, ' ') ?? '';
    if (!text || text.length > 2000) continue;

    const signature = `${node.className} ${node.parentElement?.className ?? ''}`.toLowerCase();
    const role = VISITOR_HINTS.some(hint => signature.includes(hint)) ? 'visitor' : 'byte';
    lines.push({ role, text });
  }
  return lines;
}

/**
 * Calls `listener` with each newly rendered transcript line.
 * @returns {() => void} cleanup
 */
export function observeVoiceTranscript(listener) {
  let observer;
  let cancelled = false;
  let seen = 0;

  const emit = () => {
    const lines = readVoiceTranscript();
    // The widget re-renders the whole list, so track progress by count and only
    // forward what is new. A line that is edited in place is not re-sent.
    if (lines.length <= seen) {
      if (lines.length < seen) seen = lines.length;
      return;
    }
    for (const line of lines.slice(seen)) listener(line);
    seen = lines.length;
  };

  loadVoiceAgent().then(controls => {
    if (cancelled) return;
    emit();
    observer = new MutationObserver(emit);
    observer.observe(controls.root, { subtree: true, childList: true, characterData: true });
  }).catch(() => { /* no widget, no transcript — the webhook fills the gap */ });

  return () => {
    cancelled = true;
    observer?.disconnect();
  };
}

/** Hangs up, retrying because the widget ignores a hangup while it connects. */
export function endVoiceCall() {
  if (!loadPromise) return Promise.resolve();
  // Close and unmount can both ask to hang up; one loop is enough.
  if (endPromise) return endPromise;

  endPromise = (async () => {
    const deadline = Date.now() + 6000;
    while (isLiveState(readVoiceState()) && Date.now() < deadline) {
      readControls()?.end?.click();
      await delay(400);
    }
    endPromise = null;
  })();

  return endPromise;
}
