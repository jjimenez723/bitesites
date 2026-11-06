// Native browser transport for Byte, the homepage voice agent.
//
// The server mints a single-use link to Byte's locked ElevenLabs agent, and the
// browser opens the voice session with it. Every tool the agent asks for is
// relayed to /api/byte-tools, where the server decides and acts. No API key, no
// persona text, and no tool authority ever exist in this bundle.
//
// The exported surface: load/start/end, an observed state machine ('idle' |
// 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' |
// 'unavailable'), and a transcript feed of { role: 'visitor' | 'byte', text }.

import { sessionId } from './analytics';

// Keep in step with the tools Byte is granted in functions/byte-persona.js.
const TOOL_NAMES = [
  'lookup_knowledge', 'lookup_approved_pricing', 'check_availability', 'hold_slot', 'book_meeting',
  'save_contact_details', 'request_human_followup', 'record_interest_signal', 'request_rating', 'end_call'
];

const LIVE_STATES = ['connecting', 'listening', 'thinking', 'speaking'];
export const isLiveState = state => LIVE_STATES.includes(state);

let state = 'idle';
const stateListeners = new Set();
const transcriptListeners = new Set();
let activeCall = null;
// Set when Byte calls request_rating. A form cannot go over a live call, so
// the request is held here until the widget tears the call screen down.
let ratingRequested = false;

function setState(next) {
  if (state === next) return;
  state = next;
  stateListeners.forEach(listener => { try { listener(state); } catch { /* listener error */ } });
}

export function readVoiceState() {
  return state;
}

export function observeVoiceState(listener) {
  stateListeners.add(listener);
  try { listener(state); } catch { /* listener error */ }
  return () => stateListeners.delete(listener);
}

/**
 * Did Byte ask for the rating on this call? Read synchronously as the call
 * closes — no listener, because nothing renders from it directly: it only
 * decides whether the widget reveals its post-call rating screen.
 */
export function voiceRatingRequested() {
  return ratingRequested;
}

export function observeVoiceTranscript(listener) {
  transcriptListeners.add(listener);
  return () => transcriptListeners.delete(listener);
}

const emitTranscript = line => {
  transcriptListeners.forEach(listener => { try { listener(line); } catch { /* listener error */ } });
};

const loadVoiceClient = () => import('@elevenlabs/client');

/** Fetch the voice code early, when a visitor shows intent, so the call opens faster. */
export function loadVoiceAgent() {
  return loadVoiceClient().catch(() => {});
}

async function postJson(url, body, { keepalive = false } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* handled by status */ }
  return { ok: response.ok, status: response.status, payload };
}

/**
 * One flaky fetch must not read as "the booking system is down" mid-call, so
 * tool relays retry transient failures — a thrown fetch, a 5xx, or an empty
 * body — with a short backoff before the model is told anything went wrong.
 */
async function postJsonWithRetry(url, body, attempts = 3) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await postJson(url, body);
      const payload = response.payload && typeof response.payload === 'object' ? response.payload : {};
      if (Object.keys(payload).length && (response.ok || response.status < 500)) return response;
      last = response;
    } catch { last = null; }
    if (attempt < attempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return last;
}

/** Ends whichever call is active. Safe to call at any time, from any path. */
export function endVoiceCall() {
  const call = activeCall;
  if (!call) return;
  activeCall = null;
  call.stop('ended', 'client_ended');
}

export async function startVoiceCall({ callId = '' } = {}) {
  if (activeCall) endVoiceCall();
  ratingRequested = false;
  if (!navigator?.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone.');

  setState('connecting');

  let conversation = null;
  let stopped = false;
  let sessionTimer = null;
  let goodbyeTimer = null;
  let finalized = false;
  let sessionInfo = null;
  // Set when a tool result says the call is over: Byte says goodbye, and the
  // call hangs up once that audio has finished.
  let windingDown = false;
  let spokeGoodbye = false;
  let mode = 'listening';
  const startedMs = Date.now();
  // Tool relays in flight. While one is pending the visible state is
  // 'thinking', so a calendar lookup reads as work rather than dead air.
  let pendingTools = 0;

  const finalize = reason => {
    if (finalized || !sessionInfo) return;
    finalized = true;
    // keepalive so the record closes even when the page is being torn down.
    postJson('/api/byte-tools', {
      sessionId: sessionInfo.sessionId,
      sessionToken: sessionInfo.sessionToken,
      action: 'finalize',
      reason,
      durationSec: Math.round((Date.now() - startedMs) / 1000)
    }, { keepalive: true }).catch(() => {});
  };

  const call = {
    stop(finalState = 'ended', reason = 'client_ended') {
      if (stopped) return;
      stopped = true;
      if (sessionTimer) clearTimeout(sessionTimer);
      if (goodbyeTimer) clearTimeout(goodbyeTimer);
      window.removeEventListener('pagehide', onPageHide);
      finalize(reason);
      conversation?.endSession().catch(() => {});
      if (activeCall === call) activeCall = null;
      setState(finalState);
    }
  };

  const onPageHide = () => finalize('page_closed');
  window.addEventListener('pagehide', onPageHide);

  /**
   * The agent asked for a tool. The page is a relay, nothing more: forward name
   * and arguments with the session token, and hand back whatever the server
   * said. When the result ends the call, arm the wind-down so Byte's goodbye
   * finishes first.
   */
  const relayToolCall = async (tool, args) => {
    pendingTools += 1;
    if (!stopped && !windingDown && state !== 'speaking') setState('thinking');

    let result = {
      ok: false, error: 'relay_failed',
      note: 'The request did not reach the server even after retries. Say the action did not go through — never claim it did — then continue the conversation and try again if the visitor wants.'
    };
    try {
      const response = await postJsonWithRetry('/api/byte-tools', {
        sessionId: sessionInfo.sessionId,
        sessionToken: sessionInfo.sessionToken,
        action: 'tool',
        tool,
        args: args && typeof args === 'object' ? args : {}
      });
      if (response?.payload && typeof response.payload === 'object' && Object.keys(response.payload).length) {
        result = response.payload;
      }
    } catch { /* keep the relay_failed result */ }

    pendingTools = Math.max(0, pendingTools - 1);
    if (!stopped && !windingDown && state === 'thinking' && !pendingTools) setState(mode);
    if (result.showsRating === true) ratingRequested = true;
    if (result.endsCall === true && !windingDown) {
      windingDown = true;
      // If the goodbye never finishes, hang up anyway rather than leaving a
      // dead session looking live.
      goodbyeTimer = setTimeout(() => call.stop('ended', 'agent_ended'), 20000);
    }
    return JSON.stringify(result);
  };

  try {
    // Ask for the mic first, so a blocked mic doesn't use up a session.
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    microphone.getTracks().forEach(track => track.stop());

    const [mint, { Conversation }] = await Promise.all([
      postJson('/api/byte-session', { callId, sid: sessionId(), path: window.location?.pathname || '/' }),
      loadVoiceClient()
    ]);
    if (!mint.ok || !mint.payload?.signedUrl) {
      throw new Error(mint.status === 429
        ? 'Byte is talking with a few people at once right now. Give it a minute and try again.'
        : 'The voice agent could not start. Please try again in a moment.');
    }
    sessionInfo = mint.payload;
    if (stopped) throw new Error('The call was stopped.');

    activeCall = call;
    conversation = await Conversation.startSession({
      signedUrl: sessionInfo.signedUrl,
      connectionType: 'websocket',
      clientTools: Object.fromEntries(TOOL_NAMES.map(name => [name, args => relayToolCall(name, args)])),
      onMessage: ({ role, message }) => {
        const text = String(message || '').trim();
        if (text) emitTranscript({ role: role === 'user' ? 'visitor' : 'byte', text });
      },
      onModeChange: ({ mode: next }) => {
        mode = next === 'speaking' ? 'speaking' : 'listening';
        if (stopped) return;
        if (mode === 'speaking') spokeGoodbye = windingDown;
        if (mode === 'listening' && windingDown && spokeGoodbye) {
          call.stop('ended', 'agent_ended');
          return;
        }
        setState(mode === 'listening' && pendingTools > 0 ? 'thinking' : mode);
      },
      onDisconnect: () => call.stop('ended', 'remote_ended'),
      onError: () => call.stop('ended', 'connection_lost')
    });
    if (stopped) {
      conversation.endSession().catch(() => {});
      throw new Error('The call was stopped.');
    }
    if (state === 'connecting') setState('listening');

    sessionTimer = setTimeout(
      () => call.stop('ended', 'time_limit'),
      Number(sessionInfo.maxSessionMs) || 10 * 60_000
    );

    return call;
  } catch (error) {
    call.stop('idle', 'start_failed');
    throw error;
  }
}
