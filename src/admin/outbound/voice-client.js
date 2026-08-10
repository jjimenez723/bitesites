// Browser softphone for Hybrid Dialer V2.
//
// The SDK is intentionally lazy-loaded so the public marketing bundle and
// outbound screens that never open Live Dialer do not pay for WebRTC code.
// Access tokens are short-lived and issued by Firebase; no Twilio credential is
// present in browser source or Firestore.

import { outbound } from './data';

let devicePromise = null;
let currentCall = null;
let currentMode = '';
let currentCallId = '';

async function buildDevice() {
  const [{ Device }, tokenResult] = await Promise.all([
    import('@twilio/voice-sdk'),
    outbound.voiceToken()
  ]);
  const device = new Device(tokenResult.token, {
    edge: 'roaming',
    closeProtection: 'A BiteSites sales call is still connected.',
    allowIncomingWhileBusy: false,
    appName: 'BiteSites Hybrid Dialer',
    appVersion: '2'
  });

  device.on('tokenWillExpire', async () => {
    try {
      const fresh = await outbound.voiceToken();
      device.updateToken(fresh.token);
    } catch (error) {
      console.error('[hybrid-voice] token refresh failed', error);
    }
  });
  device.on('error', error => console.error('[hybrid-voice] device error', error));
  return device;
}

export async function hybridVoiceDevice() {
  if (!devicePromise) devicePromise = buildDevice();
  return devicePromise;
}

function clearCurrent(call) {
  if (call && currentCall !== call) return;
  currentCall = null;
  currentMode = '';
  currentCallId = '';
}

/**
 * Join one active call. `listen` joins server-muted and does not request a local
 * microphone track; `human` requests the microphone and joins unmuted.
 */
export async function joinHybridCall(callId, mode = 'human') {
  if (!callId) throw new Error('A call id is required.');
  if (!['listen', 'human'].includes(mode)) throw new Error('Mode must be listen or human.');

  if (currentCall && currentCallId === callId && currentMode === mode) return currentCall;
  if (currentCall) {
    try { currentCall.disconnect(); } catch { /* already disconnected */ }
    clearCurrent();
  }

  const device = await hybridVoiceDevice();
  const call = await device.connect({
    params: { callId, mode },
    rtcConstraints: { audio: mode === 'human' }
  });
  currentCall = call;
  currentMode = mode;
  currentCallId = callId;

  call.on('disconnect', () => clearCurrent(call));
  call.on('cancel', () => clearCurrent(call));
  call.on('reject', () => clearCurrent(call));
  call.on('error', error => {
    console.error('[hybrid-voice] call error', error);
    clearCurrent(call);
  });
  return call;
}

export function leaveHybridVoice() {
  if (currentCall) {
    try { currentCall.disconnect(); } catch { /* no-op */ }
  }
  clearCurrent();
}

export function hybridVoiceState() {
  return { connected: Boolean(currentCall), callId: currentCallId, mode: currentMode };
}

export async function destroyHybridVoice() {
  leaveHybridVoice();
  if (!devicePromise) return;
  try {
    const device = await devicePromise;
    device.destroy();
  } finally {
    devicePromise = null;
  }
}
