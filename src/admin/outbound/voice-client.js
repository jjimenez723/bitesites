// Lazy-loaded browser softphone; all credentials remain on the server.
import { outbound } from './data';
import { createVoiceSession } from './voice-session';

let devicePromise = null;

const deviceIsDestroyed = device => device?.state === 'destroyed';
const destroyedDeviceError = error => /device.{0,40}destroyed|destroyed.{0,40}device/i.test(error?.message || '');

function forgetDevice(device) {
  const pending = devicePromise;
  if (!pending) return;
  pending.then(current => {
    if (current === device && devicePromise === pending) devicePromise = null;
  }).catch(() => {
    if (devicePromise === pending) devicePromise = null;
  });
}

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
    try {
      const token = (await outbound.voiceToken()).token;
      if (deviceIsDestroyed(device)) {
        forgetDevice(device);
        return;
      }
      device.updateToken(token);
    } catch (error) {
      if (deviceIsDestroyed(device) || destroyedDeviceError(error)) {
        forgetDevice(device);
        voice.deviceError(new Error('Call audio disconnected. Tap Reconnect audio to try again.'));
      } else voice.deviceError(error);
    }
  });
  device.on('destroyed', () => forgetDevice(device));
  device.on('error', error => {
    if (deviceIsDestroyed(device) || destroyedDeviceError(error)) {
      forgetDevice(device);
      voice.deviceError(new Error('Call audio disconnected. Tap Reconnect audio to try again.'));
      return;
    }
    voice.deviceError(error);
  });
  return device;
}

export async function hybridVoiceDevice() {
  const current = devicePromise;
  if (current) {
    try {
      const existing = await current;
      if (!deviceIsDestroyed(existing)) return existing;
    } catch (error) {
      if (devicePromise !== current) return hybridVoiceDevice();
      devicePromise = null;
      throw error;
    }
    if (devicePromise !== current) return hybridVoiceDevice();
    devicePromise = null;
  }

  const pending = buildDevice();
  devicePromise = pending;
  try {
    const device = await pending;
    if (deviceIsDestroyed(device)) {
      if (devicePromise === pending) devicePromise = null;
      throw new Error('Call audio closed before connecting. Tap Reconnect audio to try again.');
    }
    return device;
  } catch (error) {
    if (devicePromise === pending) devicePromise = null;
    throw error;
  }
}

const voice = createVoiceSession({
  getDevice: async () => {
    let device = await hybridVoiceDevice();
    // Recovered sessions can sit idle past the 15-minute token lifetime.
    const token = (await outbound.voiceToken()).token;
    if (deviceIsDestroyed(device)) {
      forgetDevice(device);
      device = await hybridVoiceDevice();
    }
    if (deviceIsDestroyed(device)) {
      throw new Error('Call audio closed before connecting. Tap Reconnect audio to try again.');
    }
    try {
      device.updateToken(token);
    } catch (error) {
      if (!deviceIsDestroyed(device) && !destroyedDeviceError(error)) throw error;
      forgetDevice(device);
      device = await hybridVoiceDevice();
      if (deviceIsDestroyed(device)) {
        throw new Error('Call audio closed before connecting. Tap Reconnect audio to try again.');
      }
      device.updateToken(token);
    }
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
  if (!pending) return;
  const device = await pending.catch(() => null);
  if (device && !deviceIsDestroyed(device)) device.destroy();
}
