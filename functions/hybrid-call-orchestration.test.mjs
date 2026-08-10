import test from 'node:test';
import assert from 'node:assert/strict';

import {
  routeDecision,
  handoffAllowed,
  handoffPriority,
  selectAuthorizedAutoTakeover
} from './hybrid-call-orchestration.js';

const session = (rep = {}) => ({
  status: 'active', userUid: 'rep-a', rep: { state: 'available', activeCallId: '', listeningCallId: '', ...rep }
});
const call = (control = {}, handoff = {}) => ({
  control: { controller: 'unassigned', revision: 0, ...control },
  handoff: { state: 'none', requestedBy: '', priority: 0, ...handoff }
});

test('free rep receives first verified human answer', () => {
  assert.deepEqual(routeDecision({ session: session(), call: call() }), {
    controller: 'human', idempotent: false, reason: 'rep_available'
  });
});

test('busy rep routes additional verified human answer to AI instead of cancelling', () => {
  assert.deepEqual(routeDecision({
    session: session({ state: 'busy', activeCallId: 'call-a' }),
    call: call()
  }), {
    controller: 'ai', idempotent: false, reason: 'rep_busy'
  });
});

test('two sibling calls can both independently resolve while only one is human', () => {
  const first = routeDecision({ session: session(), call: call() });
  assert.equal(first.controller, 'human');
  const second = routeDecision({
    session: session({ state: 'busy', activeCallId: 'call-a' }),
    call: call()
  });
  assert.equal(second.controller, 'ai');
});

test('already-routed call is idempotent', () => {
  assert.deepEqual(routeDecision({
    session: session({ state: 'busy', activeCallId: 'call-a' }),
    call: call({ controller: 'ai', revision: 2 })
  }), {
    controller: 'ai', idempotent: true, reason: 'already_routed'
  });
});

test('only prospect or rep can authorize handoff', () => {
  assert.equal(handoffAllowed(call({ controller: 'ai' }, { requestedBy: 'prospect', state: 'requested' })), true);
  assert.equal(handoffAllowed(call({ controller: 'ai' }, { requestedBy: 'rep', state: 'requested' })), true);
  assert.equal(handoffAllowed(call({ controller: 'ai' }, { requestedBy: 'ai', state: 'requested' })), false);
  assert.equal(handoffAllowed(call({ controller: 'ai' }, { requestedBy: '', state: 'requested' })), false);
});

test('prospect request outranks rep request for auto takeover', () => {
  assert.equal(handoffPriority('prospect') > handoffPriority('rep'), true);
  const selected = selectAuthorizedAutoTakeover([
    { id: 'rep-request', ...call({ controller: 'ai' }, { requestedBy: 'rep', state: 'queued', priority: 80, requestedAt: new Date('2026-08-10T01:00:00Z') }) },
    { id: 'prospect-request', ...call({ controller: 'ai' }, { requestedBy: 'prospect', state: 'requested', priority: 100, requestedAt: new Date('2026-08-10T01:01:00Z') }) }
  ]);
  assert.equal(selected.id, 'prospect-request');
});

test('older request wins when priorities match', () => {
  const selected = selectAuthorizedAutoTakeover([
    { id: 'newer', ...call({ controller: 'ai' }, { requestedBy: 'rep', state: 'requested', priority: 80, requestedAt: new Date('2026-08-10T01:02:00Z') }) },
    { id: 'older', ...call({ controller: 'ai' }, { requestedBy: 'rep', state: 'requested', priority: 80, requestedAt: new Date('2026-08-10T01:01:00Z') }) }
  ]);
  assert.equal(selected.id, 'older');
});

test('AI-rated hot lead without authorized request is never auto-transferred', () => {
  const selected = selectAuthorizedAutoTakeover([
    { id: 'hot', score: 99, ...call({ controller: 'ai' }, { requestedBy: '', state: 'requested', priority: 999 }) }
  ]);
  assert.equal(selected, null);
});
