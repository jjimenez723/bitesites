import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimToolExecution,
  executeAgentTool,
  toolArgumentsHash
} from './agent-tools.js';
import { TOOL_SCHEMAS } from '../services/realtime-sideband/tool-schemas.js';

const clone = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(clone) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  : value;
const merge = (left = {}, right = {}) => Object.fromEntries(new Set([...Object.keys(left), ...Object.keys(right)]).values()
  .map(key => [key, left[key] && right[key] && typeof left[key] === 'object' && typeof right[key] === 'object'
    && !Array.isArray(left[key]) && !Array.isArray(right[key]) ? merge(left[key], right[key]) : clone(right[key] ?? left[key]) ]));

function fakeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([path, value]) => [path, clone(value)]));
  let sequence = 0;
  const snapshot = path => {
    const data = docs.get(path);
    return {
      exists: data !== undefined, id: path.split('/').at(-1), ref: ref(path),
      data: () => clone(data),
      get: field => String(field).split('.').reduce((current, key) => current?.[key], data)
    };
  };
  const set = (path, data, options = {}) => {
    docs.set(path, options.merge ? merge(docs.get(path), data) : clone(data));
  };
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snapshot(path), set: async (data, options) => set(path, data, options) });
  return {
    doc: ref,
    collection: path => ({ doc: () => ref(`${path}/generated-${++sequence}`) }),
    runTransaction: async work => work({
      get: async entry => snapshot(entry.path),
      set: (entry, data, options) => set(entry.path, data, options)
    }),
    read: path => clone(docs.get(path)),
    all: () => [...docs.entries()]
  };
}

const claim = (db, requestId, tool, args = {}) => claimToolExecution(db, {
  callId: 'call-1', requestId, tool, argsHash: toolArgumentsHash(args), now: new Date('2026-08-24T12:00:00Z')
});

test('canonical argument hashing binds keys by value rather than property order', () => {
  assert.equal(toolArgumentsHash({ query: 'hours', filter: { a: 1, b: 2 } }),
    toolArgumentsHash({ filter: { b: 2, a: 1 }, query: 'hours' }));
});

test('follow-up schema requires an explicit confirmation but has no recipient field', () => {
  const schema = TOOL_SCHEMAS.send_approved_followup.parameters;
  assert.ok(schema.required.includes('prospectConfirmed'));
  assert.equal(schema.properties.prospectConfirmed.type, 'boolean');
  assert.equal('destination' in schema.properties, false);
  assert.equal('recipient' in schema.properties, false);
});

test('a claimed request cannot be replayed or rebound to another tool/argument set', async () => {
  const db = fakeDb();
  assert.equal((await claim(db, 'call_same', 'lookup_knowledge', { query: 'hours' })).state, 'claimed');
  const duplicate = await claim(db, 'call_same', 'lookup_knowledge', { query: 'hours' });
  assert.equal(duplicate.state, 'unknown');
  assert.equal(duplicate.result.error, 'tool_execution_unknown');
  const rebound = await claim(db, 'call_same', 'check_availability', { requestedWindow: 'tomorrow' });
  assert.equal(rebound.state, 'rejected');
  assert.equal(rebound.result.error, 'tool_request_binding_mismatch');
});

test('hard per-tool and total quotas reject before a handler can run', async () => {
  const db = fakeDb();
  for (let index = 0; index < 4; index += 1) assert.equal((await claim(db, `call_k${index}`, 'lookup_knowledge', { query: String(index) })).state, 'claimed');
  assert.equal((await claim(db, 'call_k4', 'lookup_knowledge', { query: 'five' })).result.error, 'tool_quota_lookup_knowledge_exceeded');
  for (let index = 0; index < 2; index += 1) assert.equal((await claim(db, `call_a${index}`, 'check_availability', { requestedWindow: String(index) })).state, 'claimed');
  assert.equal((await claim(db, 'call_a2', 'check_availability', { requestedWindow: 'three' })).result.error, 'tool_quota_check_availability_exceeded');
  assert.equal((await claim(db, 'call_hold1', 'hold_slot', { slotId: 'one' })).state, 'claimed');
  assert.equal((await claim(db, 'call_hold2', 'hold_slot', { slotId: 'two' })).result.error, 'tool_quota_active_hold_exceeded');
  assert.equal((await claim(db, 'call_book1', 'book_meeting', { holdId: 'one' })).state, 'claimed');
  assert.equal((await claim(db, 'call_book2', 'book_meeting', { holdId: 'two' })).result.error, 'tool_quota_book_meeting_exceeded');
  assert.equal((await claim(db, 'call_follow1', 'send_approved_followup', { channel: 'email' })).state, 'claimed');
  assert.equal((await claim(db, 'call_follow2', 'schedule_callback', { whenIso: '2026-08-30T10:00:00Z' })).result.error, 'tool_quota_followup_exceeded');

  const totalDb = fakeDb();
  for (let index = 0; index < 20; index += 1) assert.equal((await claim(totalDb, `call_t${index}`, 'record_qualification', { field: String(index) })).state, 'claimed');
  assert.equal((await claim(totalDb, 'call_t20', 'record_qualification', { field: '20' })).result.error, 'tool_quota_total_exceeded');
});

test('a duplicate completed request returns its exact stored result without repeating the handler', async () => {
  const db = fakeDb();
  const call = { id: 'call-1', sessionId: 'session-1', campaignId: 'campaign-1' };
  const job = { callId: 'call-1', runtime: { tools: ['lookup_knowledge'], knowledgeBaseIds: [] } };
  const first = await executeAgentTool(db, {
    call, job, tool: 'lookup_knowledge', requestId: 'call_lookup', args: { query: 'hours' }, nowMs: Date.now()
  });
  const second = await executeAgentTool(db, {
    call, job, tool: 'lookup_knowledge', requestId: 'call_lookup', args: { query: 'hours' }, nowMs: Date.now()
  });
  assert.deepEqual(second, first);
  assert.equal(db.read('calls/call-1/toolExecutionState/ledger').counts.total, 1);
});

test('malformed, unauthorized, and cross-call tool requests fail closed before a ledger claim', async () => {
  const db = fakeDb();
  const call = { id: 'call-1', sessionId: 'session-1', campaignId: 'campaign-1' };
  const permitted = { callId: 'call-1', runtime: { tools: ['lookup_knowledge'], knowledgeBaseIds: [] } };
  assert.equal((await executeAgentTool(db, {
    call, job: permitted, tool: 'lookup_knowledge', requestId: '../unsafe', args: { query: 'hours' }
  })).error, 'invalid_tool_request');
  assert.equal((await executeAgentTool(db, {
    call, job: { ...permitted, callId: 'call-2' }, tool: 'lookup_knowledge', requestId: 'call_cross', args: { query: 'hours' }
  })).error, 'invalid_tool_request');
  assert.equal((await executeAgentTool(db, {
    call, job: permitted, tool: 'lookup_knowledge', requestId: 'call_array', args: []
  })).error, 'invalid_tool_arguments');
  assert.equal((await executeAgentTool(db, {
    call, job: { callId: 'call-1', runtime: { tools: [] } }, tool: 'lookup_knowledge', requestId: 'call_denied', args: { query: 'hours' }
  })).error, 'tool_not_permitted');
  assert.equal(db.all().some(([path]) => path.includes('/toolExecutions/')), false);
});

test('follow-up requires live channel confirmation and queues only a server-resolved recipient', async () => {
  const seed = {
    'outboundTargets/target-1': { contactType: 'prospect', prospectId: 'prospect-1' },
    'prospects/prospect-1': { email: 'owner@example.com', phoneE164: '+12015550123', contactability: {} },
    'followupTemplates/template-email': { status: 'active', channel: 'email' }
  };
  const db = fakeDb(seed);
  const call = { id: 'call-1', sessionId: 'session-1', campaignId: 'campaign-1', targetId: 'target-1', prospectId: 'prospect-1' };
  const job = {
    callId: 'call-1', runtime: {
      tools: ['send_approved_followup'], permissions: { maySendEmail: true }
    }
  };
  const denied = await executeAgentTool(db, {
    call, job, tool: 'send_approved_followup', requestId: 'call_follow_denied',
    args: { channel: 'email', templateId: 'template-email' }
  });
  assert.equal(denied.error, 'channel_confirmation_required');
  assert.equal(db.all().some(([path]) => path.startsWith('followupQueue/')), false);

  const deliveryDb = fakeDb(seed);
  const queued = await executeAgentTool(deliveryDb, {
    call, job, tool: 'send_approved_followup', requestId: 'call_follow_queued',
    args: { channel: 'email', templateId: 'template-email', prospectConfirmed: true }
  });
  assert.equal(queued.ok, true);
  assert.match(queued.note, /Queued for delivery/);
  const queue = deliveryDb.all().find(([path]) => path.startsWith('followupQueue/'))?.[1];
  assert.equal(queue.destination.value, 'owner@example.com');
  assert.equal(queue.confirmation.prospectConfirmed, true);
  assert.equal(queue.destination.resolvedFrom, 'current_contact_record');
});
