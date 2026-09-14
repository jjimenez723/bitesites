// Lazy-loaded browser softphone; all credentials remain on the server.
import { outbound } from './data';
import { createVoiceSession } from './voice-session';

let devicePromise = null;

async function buildDevice() {
  const [{ Device }, tokenResult] = await Promise.all([
    import('@twilio/voice-sdk'), outbound.voiceToken()
  ]);
  const device = new Device(tokenResult.token, {
    edge: 'roaming',
    closeProtection: 'A BiteSites sales call is still connected.',
    allowIncomingWhileBusy: false,
    appName: 'BiteSites Hybrid Dialer',
    appVersion: '2'
  });
  device.on('tokenWillExpire', async () => {
    try { device.updateToken((await outbound.voiceToken()).token); }
    catch (error) { voice.deviceError(error); }
  });
  device.on('error', error => voice.deviceError(error));
  return device;
}

export async function hybridVoiceDevice() {
  if (!devicePromise) devicePromise = buildDevice().catch(error => {
    devicePromise = null;
    throw error;
  });
  return devicePromise;
}

const voice = createVoiceSession({
  getDevice: async () => {
    const device = await hybridVoiceDevice();
    // Recovered sessions can sit idle past the 15-minute token lifetime.
    device.updateToken((await outbound.voiceToken()).token);
    return device;
  }
});

// Invoke microphone access directly from Start / Call next / Reconnect.
export async function prepareHybridVoice() {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support microphone access.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => track.stop());
  await hybridVoiceDevice();
  return true;
}

export const joinHybridCall = voice.join;
export const leaveHybridVoice = voice.leave;
export const hybridVoiceState = voice.getState;
export const subscribeHybridVoice = voice.subscribe;
export const setHybridVoiceMuted = voice.setMuted;

export async function destroyHybridVoice() {
  leaveHybridVoice();
  const pending = devicePromise;
  devicePromise = null;
  if (pending) (await pending).destroy();
}
