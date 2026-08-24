import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_MEDIA_ATTACH_TIMEOUT_MS,
  aiMediaAttachDeadline,
  failClosedAIMediaAttachment,
  isAIMediaAttachExpired,
  isAIMediaAttachPending
} from './hybrid-media-failsafe.js';

const clone = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(clone) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  : value;

const merge = (left = {}, right = {}) => Object.fromEntries(new Set([...Object.keys(left), ...Object.keys(right)]).values()
  .map(key => [key, left[key] && right[key] && typeof left[key] === 'object' && typeof right[key] === 'object'
    && !Array.isArray(left[key]) && !Array.isArray(right[key]) ? merge(left[key], right[key]) : clone(right[key] ?? left[key]) ]));

function fakeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([path, value]) => [path, clone(value)]));
  let auditSequence = 0;
  const ref = path => ({ path, get: async () => snapshot(path), set: async (data, options) => write(path, data, options) });
  const snapshot = path => {
    const value = docs.get(path);
    return {
      exists: value !== undefined,
      data: () => clone(value),
      get: field => String(field).split('.').reduce((current, key) => current?.[key], value)
    };
  };
  const write = (path, data, options = {}) => {
    docs.set(path, options.merge ? merge(docs.get(path), data) : clone(data));
  };
  return {
    doc: ref,
    collection: name => ({ doc: () => ref(`${name}/audit-${++auditSequence}`) }),
    runTransaction: async work => work({
      get: async entry => snapshot(entry.path),
      set: (entry, data, options) => write(entry.path, data, options)
    }),
    read: path => clone(docs.get(path)),
    audits: () => [...docs.entries()].filter(([path]) => path.startsWith('callAuditEvents/'))
  };
}

test('media attachment deadlines are explicit and only pending states can expire', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');
  const deadline = aiMediaAttachDeadline(now);
  assert.equal(deadline.getTime() - now.getTime(), AI_MEDIA_ATTACH_TIMEOUT_MS);
  assert.equal(isAIMediaAttachPending({ status: 'accepted' }), true);
  assert.equal(isAIMediaAttachPending({ status: 'active' }), false);
  assert.equal(isAIMediaAttachExpired({ status: 'pending' }, now), true, 'a partial job fails closed');
  assert.equal(isAIMediaAttachExpired({ status: 'accepted', attachDeadlineAt: deadline }, deadline), true);
  assert.equal(isAIMediaAttachExpired({ status: 'active', attachDeadlineAt: deadline }, deadline), false);
});

test('a failed attachment atomically ends AI control, the target and the media job', async () => {
  const db = fakeDb({
    'calls/call-1': {
      sessionId: 'session-1', campaignId: 'campaign-1', targetId: 'target-1', providerCallId: 'CA-prospect',
      control: { controller: 'ai', revision: 2 }, media: { attachState: 'accepted' }
    },
    'aiMediaJobs/call-1': { status: 'accepted', realtimeCallId: 'rtc-1' }
  });
  const now = new Date('2026-08-24T12:00:00.000Z');
  const result = await failClosedAIMediaAttachment(db, 'call-1', {
    reason: 'sideband_attach_failed', source: 'test', now
  });

  assert.equal(result.ok, true);
  assert.equal(result.shouldTerminatePstn, true);
  assert.equal(result.shouldTerminateRealtime, true);
  assert.equal(result.providerCallId, 'CA-prospect');
  assert.equal(result.realtimeCallId, 'rtc-1');
  assert.equal(db.read('calls/call-1').control.controller, 'none');
  assert.equal(db.read('calls/call-1').safeTerminalDisposition, 'ai_media_setup_failed');
  assert.equal(db.read('calls/call-1').disposition, 'ai_media_setup_failed');
  assert.equal(db.read('calls/call-1').media.attachState, 'failed');
  assert.equal(db.read('aiMediaJobs/call-1').status, 'failed');
  assert.equal(db.read('outboundTargets/target-1').lastDisposition, 'ai_media_setup_failed');
  assert.equal(db.audits().length, 1);
});

test('a retry never restores control or emits a duplicate terminal audit', async () => {
  const db = fakeDb({
    'calls/call-1': {
      sessionId: 'session-1', campaignId: 'campaign-1', targetId: 'target-1', providerCallId: 'CA-prospect',
      control: { controller: 'ai', revision: 2 }
    },
    'aiMediaJobs/call-1': { status: 'accepted', realtimeCallId: 'rtc-1' }
  });
  await failClosedAIMediaAttachment(db, 'call-1', { reason: 'first', source: 'test' });
  const retry = await failClosedAIMediaAttachment(db, 'call-1', { reason: 'second', source: 'test' });

  assert.equal(retry.idempotent, true);
  assert.equal(retry.shouldTerminatePstn, true, 'a crashed teardown may be retried');
  assert.equal(retry.shouldTerminateRealtime, true, 'a crashed realtime teardown may be retried');
  assert.equal(db.read('calls/call-1').control.controller, 'none');
  assert.equal(db.audits().length, 1);
});

test('a delayed media failure cannot end a human-controlled takeover', async () => {
  const db = fakeDb({
    'calls/call-1': {
      sessionId: 'session-1', campaignId: 'campaign-1', targetId: 'target-1', providerCallId: 'CA-prospect',
      control: { controller: 'human', revision: 3 }
    },
    'aiMediaJobs/call-1': { status: 'accepted', realtimeCallId: 'rtc-1' }
  });
  const result = await failClosedAIMediaAttachment(db, 'call-1', { reason: 'late_sip_failure', source: 'test' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'call_no_longer_ai_controlled');
  assert.equal(db.read('calls/call-1').control.controller, 'human');
  assert.equal(db.audits().length, 0);
});

test('a partial AI-owned call with no controller still fails closed', async () => {
  const db = fakeDb({
    'calls/call-partial': {
      operator: 'ai', targetId: 'target-partial', providerCallId: 'CA-partial', media: { attachState: 'pending' }
    },
    'aiMediaJobs/call-partial': { status: 'pending', realtimeCallId: 'rtc-partial' }
  });
  const result = await failClosedAIMediaAttachment(db, 'call-partial', {
    reason: 'partial_controller_state', source: 'test'
  });
  assert.equal(result.ok, true);
  assert.equal(db.read('calls/call-partial').safeTerminalDisposition, 'ai_media_setup_failed');
  assert.equal(db.read('calls/call-partial').control.controller, 'none');
});

test('realtime teardown retries until provider success is confirmed', async () => {
  const db = fakeDb({
    'calls/call-retry': {
      operator: 'ai', providerCallId: 'CA-retry', safeTerminalDisposition: 'ai_media_setup_failed',
      media: { attachState: 'failed', realtimeHangupAttemptedAt: new Date() }
    },
    'aiMediaJobs/call-retry': { status: 'failed', realtimeCallId: 'rtc-retry' }
  });
  const retry = await failClosedAIMediaAttachment(db, 'call-retry', { source: 'test' });
  assert.equal(retry.shouldTerminateRealtime, true);

  db.read('calls/call-retry');
  await db.doc('calls/call-retry').set({ media: { realtimeHangupConfirmedAt: new Date() } }, { merge: true });
  const confirmed = await failClosedAIMediaAttachment(db, 'call-retry', { source: 'test' });
  assert.equal(confirmed.shouldTerminateRealtime, false);
});
