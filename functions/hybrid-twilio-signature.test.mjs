import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hybridWebhookUrlCandidates,
  twilioFormSignature,
  validHybridTwilioRequest
} from './hybrid-twilio-signature.js';

const authToken = 'test-auth-token';
const publicOrigin = 'https://bitesites.org';
const body = { CallSid: 'CA123', CallStatus: 'ringing', To: '+19085550100' };
const canonicalPath = '/api/hybrid-outbound-events?campaignId=campaign-a&legIndex=0&sessionId=session-a&targetId=target-a';
const canonicalUrl = `${publicOrigin}${canonicalPath}`;
const legacyUrl = `${publicOrigin}/api/hybrid-outbound-events?campaignId=campaign-a&targetId=target-a&sessionId=session-a&legIndex=0`;

test('accepts the canonical query order used by newly created hybrid calls', () => {
  assert.equal(validHybridTwilioRequest({
    signature: twilioFormSignature(canonicalUrl, body, authToken),
    body, authToken, originalUrl: canonicalPath, publicOrigin
  }), true);
});

test('accepts the exact legacy order after Firebase canonicalises the forwarded query', () => {
  assert.deepEqual(hybridWebhookUrlCandidates(canonicalPath, publicOrigin), [canonicalUrl, legacyUrl]);
  assert.equal(validHybridTwilioRequest({
    signature: twilioFormSignature(legacyUrl, body, authToken),
    body, authToken, originalUrl: canonicalPath, publicOrigin
  }), true);
});

test('does not accept arbitrary metadata permutations or tampered form values', () => {
  const arbitraryUrl = `${publicOrigin}/api/hybrid-outbound-events?legIndex=0&campaignId=campaign-a&targetId=target-a&sessionId=session-a`;
  assert.equal(validHybridTwilioRequest({
    signature: twilioFormSignature(arbitraryUrl, body, authToken),
    body, authToken, originalUrl: canonicalPath, publicOrigin
  }), false);
  assert.equal(validHybridTwilioRequest({
    signature: twilioFormSignature(legacyUrl, body, authToken),
    body: { ...body, CallStatus: 'completed' },
    authToken, originalUrl: canonicalPath, publicOrigin
  }), false);
});

test('does not add a legacy candidate to unrelated webhook query strings', () => {
  assert.deepEqual(
    hybridWebhookUrlCandidates('/api/twilio-conference-events?sessionId=session-a&targetId=target-a', publicOrigin),
    [`${publicOrigin}/api/twilio-conference-events?sessionId=session-a&targetId=target-a`]
  );
});
