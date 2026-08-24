// Deduplication, compliance and the Airbnb boundary — all pure, all runnable
// with plain `node --test`.
//
//   npm run test:dedupe
//
// The assertions that matter most are the negative ones. A dedupe that merges
// too eagerly loses a real prospect and can point a call at the wrong number;
// a compliance check that passes too eagerly authorises a call at 6am.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMatch, dedupeWithinBatch, duplicateVerdict } from './prospect-deduplication.js';
import { buildProspect } from './prospect-normalization.js';
import {
  evaluateAIVoiceConsent, evaluateCompliance, withinCallingWindow, localClock, nextWindowOpening, requiredDisclosures
} from './outbound-compliance.js';
import {
  isAirbnbRecord, isInternalTestRecord, classifyWatcherRecord
} from './providers/lead-sources/existing-watcher-source.js';
import { parseCsv, mapHeaders, csvToRecords } from './providers/lead-sources/csv-source.js';

const make = overrides => buildProspect({ name: 'Joes Plumbing', phone: '2015550142', ...overrides }, { source: overrides.__source || {} });

// ------------------------------------------------------------------- matching

test('a shared phone number is a confirmed match', () => {
  const result = classifyMatch(make({}), make({ name: 'Different Name Entirely' }));
  assert.equal(result.status, 'confirmed');
  assert.ok(result.reasons.includes('phone'));
});

test('a shared business domain is a confirmed match; a directory host is not', () => {
  const site = classifyMatch(
    make({ phone: '2015550001', website: 'https://joes.com' }),
    make({ phone: '2015550002', website: 'http://www.joes.com/about' })
  );
  assert.equal(site.status, 'confirmed');

  const directory = classifyMatch(
    make({ name: 'Joes', phone: '2015550001', website: 'https://facebook.com/joes' }),
    make({ name: 'Mikes', phone: '2015550002', website: 'https://facebook.com/mikes' })
  );
  assert.equal(directory.status, 'unique');
});

test('a shared free-mail address only suggests a review', () => {
  const result = classifyMatch(
    make({ name: 'Joes Plumbing', phone: '2015550001', email: 'shared@gmail.com' }),
    make({ name: 'Marys Bakery', phone: '2015550002', email: 'shared@gmail.com' })
  );
  assert.equal(result.status, 'possible');
  assert.ok(result.reasons.includes('free_email'));
});

test('a same-named business in a different town is never silently merged', () => {
  const a = buildProspect({ name: "Joe's Pizza", phone: '2015550001', address: 'Ridgewood, NJ' }, { source: {} });
  const b = buildProspect({ name: 'JOES PIZZA', phone: '9735550002', address: 'Montclair, NJ' }, { source: {} });
  const result = classifyMatch(a, b);
  assert.equal(result.status, 'possible', 'a name-only match must stay reviewable, not confirmed');
  assert.ok(result.reasons.includes('company_name'));
});

test('weak signals do not add up to a confirmation', () => {
  // Same name, same city, same free-mail address: three weak reasons. Summing
  // them would cross the confirm threshold and merge two real businesses.
  const a = buildProspect({ name: 'Acme', phone: '2015550001', email: 'a@gmail.com', address: 'Ridgewood, NJ' }, { source: {} });
  const b = buildProspect({ name: 'Acme', phone: '2015550002', email: 'a@gmail.com', address: 'Ridgewood, NJ' }, { source: {} });
  const result = classifyMatch(a, b);
  assert.equal(result.status, 'possible');
  assert.ok(result.confidence < 0.8);
});

test('the same source document is always the same record', () => {
  const source = { sourceProjectId: 'watcher-leads-89349', sourceCollection: 'smb_leads', sourceDocumentId: 'doc1' };
  const a = buildProspect({ name: 'A', phone: '2015550001' }, { source });
  const b = buildProspect({ name: 'A renamed', phone: '2015550009' }, { source });
  assert.equal(classifyMatch(a, b).status, 'confirmed');
});

// --------------------------------------------------------------- batch dedupe

test('duplicates inside one batch collapse, and near-matches survive flagged', () => {
  const batch = [
    make({ name: 'Joes Plumbing', phone: '2015550142' }),
    make({ name: 'Joes Plumbing LLC', phone: '(201) 555-0142' }),   // same phone → confirmed
    make({ name: 'Joes Plumbing', phone: '2015559999', __source: {} }), // same name, different phone
    make({ name: 'Marys Bakery', phone: '9735550001' })
  ];
  const { unique, duplicates } = dedupeWithinBatch(batch);
  assert.equal(duplicates.length, 1, 'the identical phone should fold in');
  assert.equal(unique.length, 3);
  const flagged = unique.find(entry => entry.duplicate?.status === 'possible');
  assert.ok(flagged, 'the same-name/different-phone record should be flagged for review');
});

test('duplicateVerdict reports the strongest match', () => {
  const verdict = duplicateVerdict([
    { type: 'lead', id: 'lead1', status: 'confirmed', confidence: 0.95, reasons: ['phone'] },
    { type: 'prospect', id: 'p1', status: 'possible', confidence: 0.4, reasons: ['company_name'] }
  ]);
  assert.equal(verdict.status, 'confirmed');
  assert.equal(verdict.duplicateOfType, 'lead');
  assert.equal(duplicateVerdict([]).status, 'unique');
});

// ----------------------------------------------------------------- compliance

const CAMPAIGN = {
  mode: 'power',
  provider: 'mock',
  callerId: '+15551234567',
  allowedDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  localStartTime: '09:00',
  localEndTime: '18:00',
  maxAttempts: 3,
  retryDelayMinutes: 60
};

// 2026-01-05 is a Monday. 15:00 UTC is 10:00 in New York.
const MONDAY_10AM_NY = new Date('2026-01-05T15:00:00Z');
const MONDAY_6AM_NY = new Date('2026-01-05T11:00:00Z');
const SATURDAY_NY = new Date('2026-01-10T15:00:00Z');

test('local clock reads the contact’s wall time, not the server’s', () => {
  const clock = localClock(MONDAY_10AM_NY, 'America/New_York');
  assert.equal(clock.weekday, 'mon');
  assert.equal(clock.hour, 10);
  assert.equal(localClock(MONDAY_10AM_NY, 'America/Los_Angeles').hour, 7);
});

test('the calling window is enforced by local time and by day', () => {
  assert.equal(withinCallingWindow(MONDAY_10AM_NY, 'America/New_York', CAMPAIGN).allowed, true);
  assert.equal(withinCallingWindow(MONDAY_6AM_NY, 'America/New_York', CAMPAIGN).reason, 'outside_calling_hours');
  assert.equal(withinCallingWindow(SATURDAY_NY, 'America/New_York', CAMPAIGN).reason, 'outside_allowed_days');
  // 10:00 in New York is 07:00 in Los Angeles — same instant, different verdict.
  assert.equal(withinCallingWindow(MONDAY_10AM_NY, 'America/Los_Angeles', CAMPAIGN).reason, 'outside_calling_hours');
});

test('an unknown timezone is never callable', () => {
  assert.equal(withinCallingWindow(MONDAY_10AM_NY, '', CAMPAIGN).reason, 'unknown_timezone');

  // 208 is Idaho, which straddles two zones and is deliberately absent from the
  // area-code map — so nothing can resolve a timezone for this target.
  const verdict = evaluateCompliance({
    target: { phoneE164: '+12085550142', timezone: '' },
    contact: {},
    campaign: CAMPAIGN,
    now: MONDAY_10AM_NY
  });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.reasons.includes('unknown_timezone'));
});

test('a known area code is enough to resolve a timezone when the record has none', () => {
  const verdict = evaluateCompliance({
    target: { phoneE164: '+12015550142', timezone: '' },
    contact: {},
    campaign: CAMPAIGN,
    now: MONDAY_10AM_NY
  });
  assert.equal(verdict.timezone, 'America/New_York');
  assert.equal(verdict.eligible, true);
});

test('compliance blocks DNC, attempt exhaustion, retry delay and a bad caller ID', () => {
  const base = {
    target: { phoneE164: '+12015550142', timezone: 'America/New_York', attemptCount: 0, maxAttempts: 3 },
    contact: {},
    campaign: CAMPAIGN,
    now: MONDAY_10AM_NY
  };
  assert.equal(evaluateCompliance(base).eligible, true);

  assert.ok(evaluateCompliance({ ...base, internalDoNotCall: true }).reasons.includes('do_not_call'));
  assert.ok(evaluateCompliance({ ...base, suppressed: true }).reasons.includes('suppressed'));
  assert.ok(evaluateCompliance({
    ...base, target: { ...base.target, attemptCount: 3 }
  }).reasons.includes('max_attempts_reached'));
  assert.ok(evaluateCompliance({
    ...base, target: { ...base.target, lastAttemptAt: new Date(MONDAY_10AM_NY.getTime() - 10 * 60000) }
  }).reasons.includes('retry_delay_not_elapsed'));
  assert.ok(evaluateCompliance({
    ...base, campaign: { ...CAMPAIGN, callerId: '5551234567' }
  }).reasons.includes('invalid_caller_id'));
  assert.ok(evaluateCompliance({
    ...base, target: { ...base.target, phoneE164: '' }
  }).reasons.includes('no_valid_phone'));
});

test('AI voice consent is target-level, seller-specific, and fail-closed', () => {
  const target = {
    phoneE164: '+12015550142', timezone: 'America/New_York', attemptCount: 0,
    consent: {
      grantId: 'consent-grant-42', verificationState: 'verified', status: 'active',
      basis: 'written_opt_in', sellerAccountId: 'bitesites', phoneE164: '+12015550142',
      evidenceArtifactId: 'artifact-42', disclosureVersion: 'ai-voice-v1',
      reviewedBy: 'compliance-owner', reviewedAt: new Date('2026-01-01T13:00:00Z'),
      grantedAt: new Date('2026-01-01T12:00:00Z'), checkedAt: MONDAY_10AM_NY
    }
  };
  const campaign = { ...CAMPAIGN, mode: 'ai', accountId: 'bitesites' };

  assert.equal(evaluateAIVoiceConsent({ target, campaign }).eligible, true);
  assert.equal(evaluateCompliance({ target, campaign, now: MONDAY_10AM_NY }).eligible, true);

  const noSnapshot = evaluateCompliance({
    target: { phoneE164: target.phoneE164, timezone: target.timezone }, campaign, now: MONDAY_10AM_NY
  });
  assert.equal(noSnapshot.eligible, false);
  assert.ok(noSnapshot.reasons.includes('ai_consent_not_documented'));
  assert.ok(noSnapshot.reasons.includes('ai_consent_seller_mismatch'));

  const wrongSeller = evaluateAIVoiceConsent({
    target: { ...target, consent: { ...target.consent, sellerAccountId: 'fine-line-group' } }, campaign
  });
  assert.equal(wrongSeller.eligible, false);
  assert.ok(wrongSeller.reasons.includes('ai_consent_seller_mismatch'));

  const wrongNumber = evaluateAIVoiceConsent({
    target: { ...target, consent: { ...target.consent, phoneE164: '+12015550999' } }, campaign
  });
  assert.equal(wrongNumber.eligible, false);
  assert.ok(wrongNumber.reasons.includes('ai_consent_phone_mismatch'));

  const importedTextIsNotProof = evaluateAIVoiceConsent({
    target: {
      ...target,
      consent: {
        basis: 'written_opt_in', sellerAccountId: 'bitesites', phoneE164: target.phoneE164,
        record: 'yes', evidenceId: 'anything', grantedAt: new Date('2026-01-01T12:00:00Z')
      }
    },
    campaign
  });
  assert.equal(importedTextIsNotProof.eligible, false);
  assert.ok(importedTextIsNotProof.reasons.includes('ai_consent_not_documented'));

  // The same consent fields do not change the established human call gate.
  assert.equal(evaluateCompliance({
    target: { phoneE164: target.phoneE164, timezone: target.timezone }, campaign: { ...campaign, mode: 'power' }, now: MONDAY_10AM_NY
  }).eligible, true);
});

test('carrier-backed AI also requires an independently resolved pre-dial screening', () => {
  const target = {
    phoneE164: '+12015550142', timezone: 'America/New_York', attemptCount: 0,
    consent: {
      grantId: 'consent-grant-99', verificationState: 'verified', status: 'active',
      basis: 'written_opt_in', sellerAccountId: 'bitesites', phoneE164: '+12015550142',
      evidenceArtifactId: 'artifact-99', disclosureVersion: 'ai-voice-v1',
      reviewedBy: 'compliance-owner', reviewedAt: new Date('2026-01-01T13:00:00Z'),
      grantedAt: new Date('2026-01-01T12:00:00Z'), checkedAt: MONDAY_10AM_NY
    }
  };
  const campaign = { ...CAMPAIGN, mode: 'ai', provider: 'twilio', accountId: 'bitesites' };
  const missing = evaluateCompliance({ target, campaign, now: MONDAY_10AM_NY });
  assert.equal(missing.eligible, false);
  assert.ok(missing.reasons.includes('external_screening_missing'));

  const cleared = evaluateCompliance({
    target, campaign, now: MONDAY_10AM_NY,
    externalScreening: {
      eligible: true, reasons: [], id: 'screen_opaque', checkedAt: MONDAY_10AM_NY,
      expiresAt: new Date('2026-02-01T15:00:00Z'), lineType: 'mobile'
    }
  });
  assert.equal(cleared.eligible, true);
  assert.equal(cleared.externalScreening.id, 'screen_opaque');
});

test('the next window opening is inside the window, and never today when today is over', () => {
  const opening = nextWindowOpening(new Date('2026-01-05T23:30:00Z'), 'America/New_York', CAMPAIGN);
  assert.ok(opening, 'an opening should exist within the week');
  assert.equal(withinCallingWindow(opening, 'America/New_York', CAMPAIGN).allowed, true);

  // A campaign whose allowed days never include the next few days still finds one.
  const weekendOnly = nextWindowOpening(MONDAY_10AM_NY, 'America/New_York', { ...CAMPAIGN, allowedDays: ['sat'] });
  assert.equal(localClock(weekendOnly, 'America/New_York').weekday, 'sat');
});

test('disclosures are data, not prose baked into a prompt', () => {
  const ai = requiredDisclosures({ aiDisclosureRequired: true, recordingDisclosureRequired: true });
  assert.equal(ai.length, 3);
  assert.ok(ai.some(line => /AI assistant/i.test(line)));
  assert.ok(ai.some(line => /recorded/i.test(line)));
  // The opt-out line is unconditional — it is present even when both
  // disclosures are switched off.
  const minimal = requiredDisclosures({ aiDisclosureRequired: false, recordingDisclosureRequired: false });
  assert.equal(minimal.length, 1);
  assert.ok(/not to be called again/i.test(minimal[0]));
});

// ------------------------------------------------------------ airbnb boundary

test('Airbnb records are recognised by source, by field and by value', () => {
  assert.ok(isAirbnbRecord({ source: 'airbnb' }));
  assert.ok(isAirbnbRecord({ sources: ['places', 'airbnb'] }));
  assert.ok(isAirbnbRecord({ is_airbnb: true }));
  assert.ok(isAirbnbRecord({ host_name: 'Dana' }));
  assert.ok(isAirbnbRecord({ room_type: 'Entire home' }));
  assert.ok(isAirbnbRecord({ photo_quality: 7 }));
  assert.ok(isAirbnbRecord({ descriptor: 'short_term_rental' }));
  assert.ok(isAirbnbRecord({ link: 'https://www.airbnb.com/rooms/12345' }));

  assert.ok(!isAirbnbRecord({ name: 'Joes Plumbing', source: 'places', phone: '2015550142' }));
});

test('internal test records are recognised and never migrated as prospects', () => {
  assert.ok(isInternalTestRecord({ name: 'Test Business' }));
  assert.ok(isInternalTestRecord({ email: 'a@example.com' }));
  assert.ok(!isInternalTestRecord({ name: 'Contest Catering', email: 'hi@contestcatering.com' }));
});

test('source records classify into the documented buckets', () => {
  assert.equal(classifyWatcherRecord({ source: 'airbnb' }), 'airbnb_record');
  assert.equal(classifyWatcherRecord({ name: 'Test Co', phone: '2015550142' }), 'internal_test');
  assert.equal(classifyWatcherRecord({ name: 'A', phone: '2015550142', status: 'won' }), 'existing_customer');
  assert.equal(classifyWatcherRecord({ name: 'A', phone: '2015550142', status: 'qualified' }), 'qualified_opportunity');
  assert.equal(classifyWatcherRecord({ name: 'A', phone: '2015550142', status: 'contacted' }), 'previously_contacted');
  assert.equal(classifyWatcherRecord({ name: 'A' }), 'invalid_record');
  assert.equal(classifyWatcherRecord({ name: 'A', phone: '2015550142' }), 'cold_prospect');
});

// -------------------------------------------------------------------- the CSV

test('the CSV reader survives quoted commas, embedded newlines and a BOM', () => {
  const csv = '﻿Name,Phone,Notes\n"Joes, Plumbing",2015550142,"line one\nline two"\nMarys,9735550001,\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['Joes, Plumbing', '2015550142', 'line one\nline two']);
  assert.equal(rows[0][0], 'Name', 'the BOM must not become part of the first header');
});

test('doubled quotes are one literal quote', () => {
  const rows = parseCsv('a\n"He said ""hi"""\n');
  assert.equal(rows[1][0], 'He said "hi"');
});

test('header aliases map the exports people actually paste in', () => {
  const mapping = mapHeaders(['Business Name', 'Primary Phone', 'E-Mail', 'Web Site', 'Nonsense']);
  assert.deepEqual(Object.values(mapping), ['companyName', 'phone', 'email', 'website']);
});

test('csvToRecords produces flat records and reports what it ignored', () => {
  const { records, unmapped } = csvToRecords('Company,Phone,City,State,Widgets\nJoes,2015550142,Ridgewood,NJ,7\n');
  assert.equal(records.length, 1);
  assert.equal(records[0].companyName, 'Joes');
  assert.equal(records[0].address.city, 'Ridgewood');
  assert.equal(records[0].address.region, 'NJ');
  assert.deepEqual(unmapped, ['Widgets']);
});
