import test from 'node:test';
import assert from 'node:assert/strict';

import { hybridOutboundEventsUrl } from './hybrid-urls.js';
import { HybridTwilioDialer } from './providers/calling/hybrid-twilio.js';
import { TwilioDialer } from './providers/calling/twilio.js';
import { conferenceName, prospectConferenceTwiml } from './hybrid-conference.js';

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
  assert.equal(params.Url, undefined, 'A Url would override inline TwiML and bring the pickup-time fetch back');
  assert.equal(params.ApplicationSid, undefined);
  assert.equal(params.Twiml, prospectConferenceTwiml({ sessionId: 'session-a', targetId: 'target-a', publicUrl: 'https://staging.example.com' }));
  assert.match(params.Twiml, /statusCallback="https:\/\/staging.example.com\/api\/twilio-conference-events\?sessionId=session-a&amp;targetId=target-a"/);
  assert.ok(params.Twiml.includes(`>${conferenceName('session-a', 'target-a')}</Conference>`));
  assert.ok(params.Twiml.length < 4000);
  assert.equal(params.StatusCallback, `https://staging.example.com/api/hybrid-outbound-events?${expectedQuery}`);
  assert.equal(params.AsyncAmdStatusCallback, params.StatusCallback);
});

test('Hybrid Twilio never records before the answered party grants consent', async () => {
  let params = {};
  const provider = new HybridTwilioDialer({
    accountSid: 'AC-test', authToken: 'test-token', twimlAppSid: 'AP-test',
    statusCallbackUrl: hybridOutboundEventsUrl('https://staging.example.com'),
    hybridV2: true,
    fetchImpl: async (_url, init) => {
      params = Object.fromEntries(new URLSearchParams(init.body));
      return { ok: true, text: async () => JSON.stringify({ sid: 'CA-test' }) };
    }
  });

  await provider.startPowerDialSession({
    targets: [{ id: 'target-a', campaignId: 'campaign-a', phoneE164: '+15555550100' }],
    // Even a stale or operator-enabled campaign flag cannot start recording
    // before the in-call consent gate exists.
    campaign: { id: 'campaign-a', callerId: '+15555550101', recordCalls: true },
    sessionId: 'session-a'
  });

  assert.equal(params.Record, undefined);
  assert.equal(params.RecordingStatusCallback, undefined);
  assert.equal(params.TimeLimit, '600');
  assert.match(params.Twiml, /participantLabel="prospect"/);
  assert.match(params.Twiml, /beep="false"/);
  assert.match(params.Twiml, /waitUrl=""/);
  assert.match(params.Twiml, /endConferenceOnExit="true"/);
});

test('conference rooms stay isolated by session and target and callback values are escaped', () => {
  assert.notEqual(conferenceName('session-a', 'target-a'), conferenceName('session-b', 'target-a'));
  assert.notEqual(conferenceName('session-a', 'target-a'), conferenceName('session-a', 'target-b'));
  const twiml = prospectConferenceTwiml({ sessionId: 'session&"', targetId: 'target<', publicUrl: 'https://example.com/' });
  assert.match(twiml, /sessionId=session%26%22&amp;targetId=target%3C/);
  assert.match(twiml, /statusCallbackEvent="start end join leave mute hold"/);
});

test('legacy Twilio never records from call creation either', async () => {
  let params = {};
  const provider = new TwilioDialer({
    accountSid: 'AC-test', authToken: 'test-token', twimlAppSid: 'AP-test',
    statusCallbackUrl: 'https://staging.example.com/api/outbound-events',
    fetchImpl: async (_url, init) => {
      params = Object.fromEntries(new URLSearchParams(init.body));
      return { ok: true, text: async () => JSON.stringify({ sid: 'CA-test' }) };
    }
  });

  await provider.startPowerDialSession({
    targets: [{ id: 'target-a', campaignId: 'campaign-a', phoneE164: '+15555550100' }],
    campaign: { id: 'campaign-a', callerId: '+15555550101', recordCalls: true },
    sessionId: 'session-a'
  });

  assert.equal(params.Record, undefined);
  assert.equal(params.RecordingStatusCallback, undefined);
  assert.equal(params.TimeLimit, '600');
});
