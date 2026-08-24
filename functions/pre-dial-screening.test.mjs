import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRE_DIAL_SCREENING_POLICY_VERSION,
  composePreDialScreening,
  evaluatePreDialScreening,
  preDialScreeningId,
  queryTwilioLookupScreening,
  requiresExternalPreDialScreening
} from './pre-dial-screening.js';

const NOW = new Date('2026-08-24T16:00:00Z');
const CONSENT_AT = new Date('2026-08-01T12:00:00Z');
const CAMPAIGN = { accountId: 'stone-bellisimo', provider: 'twilio' };
const PHONE = '+12015550142';

const cleared = () => composePreDialScreening({
  sellerAccountId: CAMPAIGN.accountId,
  phoneE164: PHONE,
  consentGrantedAt: CONSENT_AT,
  nationalDnc: { status: 'clear', snapshotId: 'dnc-2026-08-20', provider: 'registry_import' },
  entityDnc: { status: 'clear' },
  lookup: {
    provider: 'twilio_lookup_v2', phoneValid: true, lineType: 'mobile',
    reassignedStatus: 'no', lastVerifiedDate: '20260801'
  },
  now: NOW
});

test('carrier-backed AI requires screening while mock and human paths do not', () => {
  assert.equal(requiresExternalPreDialScreening({ campaign: CAMPAIGN, automatedVoice: true }), true);
  assert.equal(requiresExternalPreDialScreening({ campaign: { ...CAMPAIGN, provider: 'mock' }, automatedVoice: true }), false);
  assert.equal(requiresExternalPreDialScreening({ campaign: CAMPAIGN, automatedVoice: false }), false);
});

test('screening ids are deterministic, seller-bound and never expose the phone', () => {
  const one = preDialScreeningId('stone-bellisimo', PHONE);
  assert.equal(one, preDialScreeningId('stone-bellisimo', PHONE));
  assert.notEqual(one, preDialScreeningId('bitesites', PHONE));
  assert.equal(one.includes('2015550142'), false);
});

test('all independent checks produce an eligible verdict', () => {
  const result = evaluatePreDialScreening({
    screening: cleared(), campaign: CAMPAIGN, phoneE164: PHONE,
    consent: { grantedAt: CONSENT_AT }, now: NOW
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(cleared().policyVersion, PRE_DIAL_SCREENING_POLICY_VERSION);
});

test('missing, stale, DNC, reassigned, mismatched and unknown-line evidence fails closed', () => {
  assert.deepEqual(evaluatePreDialScreening({
    screening: null, campaign: CAMPAIGN, phoneE164: PHONE,
    consent: { grantedAt: CONSENT_AT }, now: NOW
  }).reasons, ['external_screening_missing']);

  const unsafe = cleared();
  unsafe.phoneHash = 'wrong';
  unsafe.nationalDnc.status = 'match';
  unsafe.reassignedNumber.status = 'yes';
  unsafe.reassignedNumber.lastVerifiedDate = '20260701';
  unsafe.lineType.type = 'unknown';
  unsafe.expiresAt = new Date('2026-08-23T00:00:00Z');
  const result = evaluatePreDialScreening({
    screening: unsafe, campaign: CAMPAIGN, phoneE164: PHONE,
    consent: { grantedAt: CONSENT_AT }, now: NOW
  });
  for (const reason of [
    'external_screening_phone_mismatch', 'national_dnc_not_cleared', 'number_reassigned',
    'reassigned_number_consent_date_mismatch', 'line_type_not_callable', 'external_screening_stale'
  ]) assert.ok(result.reasons.includes(reason), reason);
});

test('Twilio Lookup request binds the paid packages to the consent date', async () => {
  let observed;
  const result = await queryTwilioLookupScreening({
    phoneE164: PHONE,
    consentGrantedAt: CONSENT_AT,
    accountSid: `AC${'a'.repeat(32)}`,
    authToken: 'test-token',
    fetchImpl: async (url, options) => {
      observed = { url: String(url), options };
      return new Response(JSON.stringify({
        phone_number: PHONE,
        valid: true,
        line_type_intelligence: { type: 'fixedVoip', error_code: null },
        reassigned_number: { is_number_reassigned: 'no', error_code: null }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const url = new URL(observed.url);
  assert.equal(url.searchParams.get('Fields'), 'line_type_intelligence,reassigned_number');
  assert.equal(url.searchParams.get('LastVerifiedDate'), '20260801');
  assert.match(observed.options.headers.Authorization, /^Basic /);
  assert.equal(result.lineType, 'fixedVoip');
  assert.equal(result.reassignedStatus, 'no');
});

test('Lookup refuses mismatched provider data and never treats an outage as clear', async () => {
  await assert.rejects(() => queryTwilioLookupScreening({
    phoneE164: PHONE,
    consentGrantedAt: CONSENT_AT,
    accountSid: `AC${'b'.repeat(32)}`,
    authToken: 'test-token',
    fetchImpl: async () => new Response(JSON.stringify({
      phone_number: '+12015550143', valid: true,
      line_type_intelligence: { type: 'mobile' },
      reassigned_number: { is_number_reassigned: 'no' }
    }), { status: 200 })
  }), /different phone number/);

  await assert.rejects(() => queryTwilioLookupScreening({
    phoneE164: PHONE,
    consentGrantedAt: CONSENT_AT,
    accountSid: `AC${'c'.repeat(32)}`,
    authToken: 'test-token',
    fetchImpl: async () => { throw new Error('network'); }
  }), /unavailable/);
});
