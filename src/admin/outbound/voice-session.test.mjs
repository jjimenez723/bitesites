import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createVoiceSession } from './voice-session.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
class FakeCall extends EventEmitter {
  muted = false;
  disconnected = false;
  status() { return 'connecting'; }
  mute(value) { this.muted = value; this.emit('mute', value); }
  isMuted() { return this.muted; }
  disconnect() { this.disconnected = true; this.emit('disconnect'); }
}
function fixture(options = {}) {
  const calls = [];
  const connects = [];
  const voice = createVoiceSession({
    getDevice: async () => ({ connect: async params => {
      connects.push(params);
      const call = new FakeCall(); calls.push(call); return call;
    } }), ...options
  });
  return { voice, calls, connects };
}

test('waits for accept and shares a pending join between card and workspace', async () => {
  const { voice, calls, connects } = fixture();
  const first = voice.join('lead-1');
  const second = voice.join('lead-1');
  assert.equal(first, second);
  await tick();
  assert.equal(connects.length, 1);
  assert.equal(voice.getState().connected, false);
  assert.equal(voice.getState().connecting, true);
  calls[0].emit('accept');
  assert.equal(await first, calls[0]);
  assert.equal(voice.getState().connected, true);
  voice.leave();
});

test('an asynchronous SDK error rejects the join and allows a fresh retry', async () => {
  const { voice, calls } = fixture();
  const first = voice.join('lead-1');
  const rejected = assert.rejects(first, /permission denied.*31401/);
  await tick();
  calls[0].emit('error', Object.assign(new Error('Microphone permission denied'), { code: 31401 }));
  await rejected;
  assert.equal(voice.getState().connected, false);
  assert.match(voice.getState().error, /permission denied/);
  const retry = voice.join('lead-1');
  await tick();
  calls[1].emit('accept');
  await retry;
  assert.equal(voice.getState().error, '');
  voice.leave();
});

for (const mode of ['listen', 'coach']) test(`${mode} acquires valid audio constraints and mutes before acceptance`, async () => {
  const { voice, calls, connects } = fixture();
  const joining = voice.join('lead-1', mode);
  await tick();
  assert.equal(connects[0].rtcConstraints.audio, true);
  assert.equal(calls[0].muted, true);
  calls[0].emit('accept');
  await joining;
  assert.equal(voice.getState().muted, true);
  assert.throws(() => voice.setMuted(false), /not connected/);
  voice.leave();
});

test('leaving during device loading never starts a stale connection', async () => {
  let resolveDevice;
  let connects = 0;
  const voice = createVoiceSession({ getDevice: () => new Promise(resolve => { resolveDevice = resolve; }) });
  const pending = voice.join('old-call');
  const rejected = assert.rejects(pending, /cancelled/);
  voice.leave();
  resolveDevice({ connect: () => { connects++; } });
  await rejected; await tick();
  assert.equal(connects, 0);
  assert.equal(voice.getState().callId, '');
});

test('leaving while connect is pending disconnects the late SDK call', async () => {
  let resolveCall;
  const voice = createVoiceSession({ getDevice: async () => ({ connect: () => new Promise(resolve => { resolveCall = resolve; }) }) });
  const pending = voice.join('old-call');
  const rejected = assert.rejects(pending, /cancelled/);
  await tick();
  voice.leave();
  const stale = new FakeCall();
  resolveCall(stale);
  await rejected; await tick();
  assert.equal(stale.disconnected, true);
  assert.equal(voice.getState().connected, false);
});

test('a silent connection times out and cannot stay falsely connected', async () => {
  const { voice } = fixture({ timeoutMs: 15 });
  await assert.rejects(voice.join('lead-1'), /timed out/);
  assert.equal(voice.getState().connecting, false);
  assert.equal(voice.getState().connected, false);
});

test('an accepted call publishes network interruptions and a later disconnect', async () => {
  const { voice, calls } = fixture();
  let updates = 0;
  const unsubscribe = voice.subscribe(() => { updates++; });
  const pending = voice.join('lead-1');
  await tick(); calls[0].emit('accept'); await pending;
  calls[0].emit('reconnecting');
  assert.equal(voice.getState().connected, false);
  calls[0].emit('reconnected');
  assert.equal(voice.getState().connected, true);
  calls[0].emit('disconnect');
  assert.match(voice.getState().error, /disconnected/);
  assert.equal(voice.getState().connected, false);
  assert.ok(updates >= 5);
  unsubscribe(); voice.leave();
});
