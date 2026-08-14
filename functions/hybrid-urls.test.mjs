import test from 'node:test';
import assert from 'node:assert/strict';

import { hybridOutboundEventsUrl } from './hybrid-urls.js';
import { HybridTwilioDialer } from './providers/calling/hybrid-twilio.js';

test('builds the production Hybrid Twilio callback by default', () => {
  assert.equal(
    hybridOutboundEventsUrl(''),
    'https://bitesites.org/api/hybrid-outbound-events'
  );
});

test('normalizes a configured public app URL', () => {
  assert.equal(
    hybridOutboundEventsUrl('https://staging.example.com/'),
    'https://staging.example.com/api/hybrid-outbound-events'
  );
});

test('the Hybrid callback satisfies Twilio provider readiness', async () => {
  const health = await new HybridTwilioDialer({
    accountSid: 'AC-test',
    authToken: 'test-token',
    twimlAppSid: 'AP-test',
    statusCallbackUrl: hybridOutboundEventsUrl('https://staging.example.com'),
    hybridV2: true
  }).healthCheck();

  assert.deepEqual(health, { ok: true, missing: [] });
});

test('Hybrid Twilio URLs use Firebase Hosting canonical query order', async () => {
  let params = {};
  const provider = new HybridTwilioDialer({
    accountSid: 'AC-test',
    authToken: 'test-token',
    twimlAppSid: 'AP-test',
    statusCallbackUrl: hybridOutboundEventsUrl('https://staging.example.com'),
    hybridV2: true,
    fetchImpl: async (_url, init) => {
      params = Object.fromEntries(new URLSearchParams(init.body));
      return { ok: true, text: async () => JSON.stringify({ sid: 'CA-test' }) };
    }
  });

  await provider.startParallelDialSession({
    targets: [{ id: 'target-a', campaignId: 'campaign-a', phoneE164: '+15555550100' }],
    campaign: { id: 'campaign-a', callerId: '+15555550101', recordCalls: false },
    sessionId: 'session-a',
    concurrency: 3
  });

  const expectedQuery = 'campaignId=campaign-a&legIndex=0&sessionId=session-a&targetId=target-a';
  assert.equal(params.Url, `https://staging.example.com/api/twilio-prospect-twiml?${expectedQuery}`);
  assert.equal(params.StatusCallback, `https://staging.example.com/api/hybrid-outbound-events?${expectedQuery}`);
  assert.equal(params.AsyncAmdStatusCallback, params.StatusCallback);
});
