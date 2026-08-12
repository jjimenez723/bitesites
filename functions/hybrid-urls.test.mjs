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
