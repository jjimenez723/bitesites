import assert from 'node:assert/strict';
import { test } from 'node:test';

import { twilioSignature, validTwilioRequest } from './twilio-compliance.js';

const url = 'https://bitesites.org/api/twilio-compliance-status';
const authToken = 'test-auth-token';
const body = {
  AccountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  CustomerProfileSid: 'BUbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  Status: 'twilio-approved'
};

test('accepts a correctly signed Twilio compliance callback', () => {
  const signature = twilioSignature(url, body, authToken);
  assert.equal(validTwilioRequest({ signature, body, authToken, url }), true);
});

test('rejects tampered callback fields', () => {
  const signature = twilioSignature(url, body, authToken);
  assert.equal(validTwilioRequest({
    signature,
    body: { ...body, Status: 'twilio-rejected' },
    authToken,
    url
  }), false);
});

test('signs the exact capitalization used by Trust Hub bundle callbacks', () => {
  const trustHubBody = {
    AccountSID: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    BundleSID: 'BUbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    Status: 'twilio-rejected',
    FailureReason: 'The business address could not be verified.'
  };
  const signature = twilioSignature(url, trustHubBody, authToken);
  assert.equal(validTwilioRequest({ signature, body: trustHubBody, authToken, url }), true);
});
