// Native browser transport for Byte, the homepage voice agent.
//
// Replaces the GoHighLevel shadow-DOM bridge (ghl-voice.js) with the same
// stack the dialer already runs: the server mints a short-lived OpenAI
// Realtime client secret compiled from the Byte persona, the browser opens a
// WebRTC session with it, and every tool call the model makes is relayed to
// /api/byte-tools where the server decides and acts. No OpenAI key, no
// persona text, and no tool authority ever exist in this bundle.
//
// The exported surface deliberately matches ghl-voice.js so the receptionist
// component swaps engines with an import change: load/start/end, an observed
// state machine ('idle' | 'connecting' | 'listening' | 'speaking' | 'ended' |
// 'unavailable'), and a transcript feed of { role: 'visitor' | 'byte', text }.

import { sessionId } from './analytics';
import {
  CONTINUE_TRUNCATED_RESPONSE_INSTRUCTION,
  MAX_RESPONSE_CONTINUATIONS,
  isOutputAudioDrained,
  realtimeResponseOutcome
} from '../admin/outbound/realtime-audio-lifecycle';

const GREETING_INSTRUCTION = 'Greet the visitor now — briefly and warmly, as Byte. One short line of who you are, then ask what brought them in. Do not pitch.';

const NUDGE_INSTRUCTION = 'The visitor has gone quiet. Without commenting on the silence, re-engage them now in one or two short sentences that move toward the most useful next step — the question they left open, booking the 20-minute call, or asking directly what date and time works for them.';

const FAREWELL_INSTRUCTION = 'The visitor has stayed quiet. Call the request_rating tool, say one warm goodbye sentence that invites the quick one-to-five rating, and call the end_call tool with reason visitor_left — all in this same turn.';

// How long Byte waits in silence before re-engaging, then before saying
// goodbye. The persona is told to close rather than sit in listening mode.
const SILENCE_NUDGE_MS = 12_000;
const SILENCE_FAREWELL_MS = 20_000;
const SILENCE_HANGUP_MS = 30_000;

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

/**
 * The GHL engine had a widget to preload; the native engine has nothing
 * heavier than this module. Kept for interface compatibility with the
 * component's warm-on-intent calls.
 */
export function loadVoiceAgent() {
  return Promise.resolve();
}

function transcriptEvent(event) {
  if (event?.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
    return { role: 'visitor', text: String(event.transcript).trim() };
  }
  if (event?.type === 'response.output_audio_transcript.done' && event.transcript) {
    return { role: 'byte', text: String(event.transcript).trim() };
  }
  return null;
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
  if (typeof RTCPeerConnection === 'undefined') throw new Error('This browser does not support live voice calls.');
  if (!navigator?.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone.');

  setState('connecting');

  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel('oai-events');
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);

  let microphone = null;
  let stopped = false;
  let sessionTimer = null;
  let goodbyeTimer = null;
  let finalized = false;
  let sessionInfo = null;
  let pendingContinuationResponseId = '';
  let continuationAttempts = 0;
  // Set when a tool result says the call is over: the next completed response
  // is Byte's goodbye, and the call hangs up once its audio has drained.
  let windingDown = false;
  let endAfterDrainId = '';
  const startedMs = Date.now();
  const handledToolCalls = new Set();
  // Tool relays in flight. While one is pending the visible state is
  // 'thinking', so a calendar lookup reads as work rather than dead air.
  let pendingTools = 0;
  // Silence watchdog: VAD never fires on nothing, so without this the session
  // just listens forever at a quiet visitor. Nudge once, close on the second.
  let silenceTimer = null;
  let lastActivityMs = Date.now();
  let silenceNudges = 0;
  const touchActivity = () => { lastActivityMs = Date.now(); };

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
      if (silenceTimer) clearInterval(silenceTimer);
      window.removeEventListener('pagehide', onPageHide);
      finalize(reason);
      try { channel.close(); } catch { /* already closed */ }
      try { peer.close(); } catch { /* already closed */ }
      microphone?.getTracks().forEach(track => track.stop());
      audio.srcObject = null;
      audio.remove();
      if (activeCall === call) activeCall = null;
      setState(finalState);
    }
  };

  const onPageHide = () => finalize('page_closed');
  window.addEventListener('pagehide', onPageHide);

  const send = payload => {
    if (channel.readyState === 'open') channel.send(JSON.stringify(payload));
  };

  /**
   * The model asked for a tool. The page is a relay, nothing more: forward
   * name and arguments with the session token, hand whatever the server said
   * back to the model, and let it keep talking. When the server marks the
   * result call-ending, arm the wind-down so Byte's goodbye finishes first.
   */
  const relayToolCall = async item => {
    if (!item?.call_id || handledToolCalls.has(item.call_id)) return;
    handledToolCalls.add(item.call_id);

    let args = {};
    try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch { args = {}; }

    pendingTools += 1;
    touchActivity();
    if (!stopped && !windingDown && state !== 'speaking') setState('thinking');

    let result = {
      ok: false, error: 'relay_failed',
      note: 'The request did not reach the server even after retries. Say the action did not go through — never claim it did — then continue the conversation and try the same tool once more when it matters.'
    };
    try {
      const response = await postJsonWithRetry('/api/byte-tools', {
        sessionId: sessionInfo.sessionId,
        sessionToken: sessionInfo.sessionToken,
        action: 'tool',
        tool: item.name,
        args
      });
      if (response?.payload && typeof response.payload === 'object' && Object.keys(response.payload).length) {
        result = response.payload;
      }
    } catch { /* keep the relay_failed result */ }

    pendingTools = Math.max(0, pendingTools - 1);
    touchActivity();
    if (stopped) return;
    if (result.showsRating === true) ratingRequested = true;
    if (result.endsCall === true) {
      windingDown = true;
      // Belt and braces: if the goodbye's drain event never arrives, hang up
      // anyway rather than leaving a dead session looking live.
      goodbyeTimer = setTimeout(() => call.stop('ended', 'agent_ended'), 20000);
    }
    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) }
    });
    send({ type: 'response.create' });
  };

  peer.addEventListener('track', event => {
    audio.srcObject = event.streams[0];
    audio.play().catch(() => { /* resumes on the user's gesture */ });
  });
  peer.addEventListener('connectionstatechange', () => {
    if (['failed', 'disconnected', 'closed'].includes(peer.connectionState) && !stopped) {
      call.stop('ended', 'connection_lost');
    }
  });
  channel.addEventListener('close', () => {
    if (!stopped) call.stop('ended', 'remote_ended');
  });

  channel.addEventListener('message', message => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }

    const line = transcriptEvent(event);
    if (line?.text) emitTranscript(line);

    if (event.type === 'output_audio_buffer.started') {
      touchActivity();
      setState('speaking');
    }
    if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared'].includes(event.type) && !windingDown) {
      touchActivity();
      setState(pendingTools > 0 ? 'thinking' : 'listening');
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      pendingContinuationResponseId = '';
      continuationAttempts = 0;
      touchActivity();
      silenceNudges = 0;
      setState('listening');
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      touchActivity();
      silenceNudges = 0;
    }

    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      relayToolCall(event.item);
    }

    const outcome = realtimeResponseOutcome(event);
    if (outcome) {
      if (outcome.truncatedByTokenLimit && !windingDown
          && continuationAttempts < MAX_RESPONSE_CONTINUATIONS) {
        continuationAttempts += 1;
        pendingContinuationResponseId = outcome.responseId;
      } else if (windingDown && !endAfterDrainId) {
        // This completed response is the goodbye; stop once it has played out.
        endAfterDrainId = outcome.responseId;
      }
    }

    if (isOutputAudioDrained(event, endAfterDrainId)) {
      call.stop('ended', 'agent_ended');
    } else if (isOutputAudioDrained(event, pendingContinuationResponseId)) {
      pendingContinuationResponseId = '';
      send({
        type: 'response.create',
        response: {
          instructions: CONTINUE_TRUNCATED_RESPONSE_INSTRUCTION,
          metadata: { response_purpose: 'max_tokens_continuation' }
        }
      });
    }
  });

  try {
    microphone = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    microphone.getAudioTracks().forEach(track => peer.addTrack(track, microphone));

    const mint = await postJson('/api/byte-session', {
      callId,
      sid: sessionId(),
      path: window.location?.pathname || '/'
    });
    if (!mint.ok || !mint.payload?.clientSecret) {
      throw new Error(mint.status === 429
        ? 'Byte is talking with a few people at once right now. Give it a minute and try again.'
        : 'The voice agent could not start. Please try again in a moment.');
    }
    sessionInfo = mint.payload;

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionInfo.clientSecret}`, 'Content-Type': 'application/sdp' },
      body: offer.sdp
    });
    const answerSdp = await sdpResponse.text();
    if (!sdpResponse.ok) throw new Error('The voice connection could not be established.');
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    await new Promise((resolve, reject) => {
      if (channel.readyState === 'open') { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('The voice agent took too long to connect.')), 15000);
      channel.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      channel.addEventListener('close', () => { clearTimeout(timer); reject(new Error('The voice agent closed before it connected.')); }, { once: true });
    });
    if (stopped) throw new Error('The call was stopped.');

    activeCall = call;
    setState('listening');
    send({
      type: 'response.create',
      response: { instructions: GREETING_INSTRUCTION, metadata: { response_purpose: 'greeting' } }
    });

    sessionTimer = setTimeout(
      () => call.stop('ended', 'time_limit'),
      Number(sessionInfo.maxSessionMs) || 10 * 60_000
    );

    touchActivity();
    silenceTimer = setInterval(() => {
      // Only the listening state counts as silence — speaking, thinking, and
      // wind-down all mean the conversation is moving without the visitor.
      if (stopped || windingDown || pendingTools > 0 || state !== 'listening') {
        touchActivity();
        return;
      }
      const quietFor = Date.now() - lastActivityMs;
      const threshold = silenceNudges === 0 ? SILENCE_NUDGE_MS
        : silenceNudges === 1 ? SILENCE_FAREWELL_MS
          : SILENCE_HANGUP_MS;
      if (quietFor < threshold) return;
      touchActivity();
      silenceNudges += 1;
      if (silenceNudges > 2) {
        // The farewell response never ended the call — close it ourselves
        // rather than leaving a dead session looking live.
        call.stop('ended', 'visitor_inactive');
        return;
      }
      send({
        type: 'response.create',
        response: {
          instructions: silenceNudges === 1 ? NUDGE_INSTRUCTION : FAREWELL_INSTRUCTION,
          metadata: { response_purpose: silenceNudges === 1 ? 'silence_nudge' : 'silence_farewell' }
        }
      });
    }, 1000);

    return call;
  } catch (error) {
    call.stop('idle', 'start_failed');
    throw error;
  }
}
