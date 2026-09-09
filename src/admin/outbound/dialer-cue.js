const SOUND_KEY = 'bitesites.quickDial.sound';

let audioContext = null;

function context() {
  if (typeof window === 'undefined') return null;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

export function readDialerSoundPreference() {
  try { return window.localStorage.getItem(SOUND_KEY) !== 'off'; }
  catch { return true; }
}

export function writeDialerSoundPreference(enabled) {
  try { window.localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); }
  catch { /* Private browsing can make localStorage unavailable. */ }
}

// Browsers only allow audio after a click. Start and Call next use that click
// to unlock this tiny cue before the server begins placing a call.
export async function primeDialerCue() {
  const audio = context();
  if (audio?.state === 'suspended') await audio.resume();
  return Boolean(audio && audio.state === 'running');
}

export function playDialerCue() {
  const audio = context();
  if (!audio || audio.state !== 'running') return false;

  const startAt = audio.currentTime + 0.01;
  [[660, 0], [880, 0.1]].forEach(([frequency, offset]) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, startAt + offset);
    gain.gain.setValueAtTime(0.0001, startAt + offset);
    gain.gain.exponentialRampToValueAtTime(0.055, startAt + offset + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.085);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(startAt + offset);
    oscillator.stop(startAt + offset + 0.09);
  });
  return true;
}
