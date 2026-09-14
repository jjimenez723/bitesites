import test from 'node:test';
import assert from 'node:assert/strict';
import { primeDialerCue, startDialerRingback } from './dialer-cue.js';

test('ringback repeats while ringing and cleanup silences it immediately', async () => {
  const originalWindow = globalThis.window;
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const oscillators = [];
  let repeat, cancelled = false;
  class AudioContext {
    state = 'suspended'; currentTime = 0; destination = {};
    async resume() { this.state = 'running'; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() {
      const node = { frequency: {}, connect() {}, disconnect() { this.disconnected = true; }, start() {}, stop(at) { if (at === undefined) this.stoppedNow = true; } };
      oscillators.push(node); return node;
    }
  }
  globalThis.window = { AudioContext };
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 6000); repeat = fn; return 123; };
  globalThis.clearInterval = id => { assert.equal(id, 123); cancelled = true; };
  try {
    const stopLocked = startDialerRingback();
    assert.equal(oscillators.length, 0);
    stopLocked();
    await primeDialerCue();
    const stop = startDialerRingback();
    assert.deepEqual(oscillators.map(node => node.frequency.value), [440, 480]);
    repeat();
    assert.equal(oscillators.length, 4);
    stop();
    assert.ok(cancelled);
    assert.ok(oscillators.every(node => node.stoppedNow && node.disconnected));
  } finally {
    globalThis.window = originalWindow;
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});
