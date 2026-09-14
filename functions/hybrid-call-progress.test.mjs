import test from 'node:test';
import assert from 'node:assert/strict';
import { hybridCallProgress } from './hybrid-call-progress.js';
import { HybridTwilioDialer } from './providers/calling/hybrid-twilio.js';
import { TwilioDialer } from './providers/calling/twilio.js';

for (const [label, Adapter, hybridV2] of [
  ['Hybrid', HybridTwilioDialer, true], ['Hybrid legacy', HybridTwilioDialer, false], ['Legacy', TwilioDialer, false]
]) test(`${label} sends four repeated status callback parameters on the wire`, async () => {
  const requests = [];
  const provider = new Adapter({ accountSid: 'AC-test', authToken: 'test', twimlAppSid: 'AP-test',
    statusCallbackUrl: 'https://example.com/api/hybrid-outbound-events', hybridV2,
    fetchImpl: async (url, init) => { requests.push(new URLSearchParams(init.body)); return { ok: true, text: async () => JSON.stringify({ sid: 'CA-test' }) }; }
  });
  await provider.startPowerDialSession({ targets: [{ id: 'target', phoneE164: '+15005550006' }], campaign: { id: 'campaign', callerId: '+15005550006' }, sessionId: 'session' });
  assert.deepEqual(requests[0].getAll('StatusCallbackEvent'), ['initiated', 'ringing', 'answered', 'completed']);
  assert.equal(requests[0].get('Timeout'), '25');
  assert.equal(requests[0].get('AsyncAmd'), 'true');
});

for (const answeredBy of ['human', 'machine_end_beep', 'machine_end_other']) test(`completed with AnsweredBy=${answeredBy} remains terminal`, () => {
  const event = new HybridTwilioDialer().normalizeWebhookEvent({ CallSid: 'CA-test', CallStatus: 'completed', AnsweredBy: answeredBy, CallDuration: '18' });
  assert.equal(event.type, 'completed');
  assert.equal(event.disposition, '');
});

test('carrier progress distinguishes ringing from answered and cannot regress a call', () => {
  assert.deepEqual(hybridCallProgress({ status: 'dialing' }, 'ringing'), { status: 'ringing' });
  assert.deepEqual(hybridCallProgress({ status: 'ringing' }, 'answered'), { status: 'open' });
  assert.deepEqual(hybridCallProgress({ status: 'open', answeredAt: new Date() }, 'ringing'), {});
  assert.deepEqual(hybridCallProgress({ status: 'connected', control: { controller: 'human' } }, 'ringing'), {});
  assert.deepEqual(hybridCallProgress({ status: 'completed' }, 'machine_answered'), {});
  assert.deepEqual(hybridCallProgress({ status: 'cancelled' }, 'answered'), {});
});
