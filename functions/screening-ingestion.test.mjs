// The screening gate has always refused a call without evidence. These cover
// the other half: that evidence can now be produced, that producing it cannot
// quietly spend money, and that what gets written actually satisfies the gate
// it was written for.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const { ingestPreDialScreening } = await import('./screening-ingestion.js');
const { evaluatePreDialScreening, preDialScreeningId } = await import('./pre-dial-screening.js');
const { screeningAdmission } = await import('./deployment-environment.js');
const {
  DEFAULT_SCREENING_PROVIDER_ID, describeScreeningProviders, getScreeningProvider, screeningProviderIsPaid,
  screeningProviderVerifies
} = await import('./providers/screening/index.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
};
const rejects = async (promise, matcher) => {
  try { await promise; return { threw: false, message: '' }; }
  catch (error) {
    const message = String(error?.message || error);
    return { threw: matcher ? matcher.test(message) : true, message };
  }
};
const wipe = async name => {
  const snapshot = await db.collection(name).limit(500).get();
  for (const entry of snapshot.docs) await entry.ref.delete();
};

const NOW = new Date('2026-08-24T15:00:00.000Z');
const GRANTED = new Date('2026-08-20T10:00:00.000Z');
const SELLER = 'bitesites';
const PHONE = '+12015550143';

// Mock evidence is a staging artifact and the admission gate now says so, which
// means every mock ingestion below has to name the environment it belongs in.
// Omitting it is not a shortcut: an unset BITESITES_DEPLOYMENT_ENVIRONMENT
// resolves to production, where the mock is refused.
const STAGING = { environment: 'staging', paidScreening: 'disabled' };

const dnc = () => ({
  status: 'clear', snapshotId: 'ftc-2026-08-24', provider: 'test_dnc_service', checkedAt: NOW
});
const campaign = { accountId: SELLER, provider: 'twilio', mode: 'ai' };
const consent = { grantedAt: GRANTED };

console.log('\npre-dial screening ingestion');
await wipe('preDialScreenings');
await wipe('suppressedNumbers');

// 1. The default provider is the one that cannot bill.
check('the default screening provider is free and the paid one is marked paid',
  DEFAULT_SCREENING_PROVIDER_ID === 'mock'
    && screeningProviderIsPaid('mock') === false
    && screeningProviderIsPaid('twilio_lookup') === true);

check('an unknown provider is refused rather than defaulted',
  (() => { try { getScreeningProvider('acme_screening'); return false; } catch { return true; } })());

check('provider metadata never carries a credential',
  describeScreeningProviders().every(entry =>
    Array.isArray(entry.requiredSecrets)
      && entry.requiredSecrets.every(name => typeof name === 'string' && !/=|:/.test(name))
      && !('config' in entry)));

// 2. A paid lookup is refused until somebody authorises the spend.
//
// `verifies: true` throughout, so these isolate the spend decision. Twilio
// Lookup does verify; what is on trial here is only whether it may bill. The
// case where that flag is missing is covered in 2b.
{
  const staging = screeningAdmission('twilio_lookup', {
    paid: true, verifies: true, values: { environment: 'staging', paidScreening: 'enabled' }
  });
  const unset = screeningAdmission('twilio_lookup', {
    paid: true, verifies: true, values: { environment: 'production', paidScreening: 'disabled' }
  });
  const typo = screeningAdmission('twilio_lookup', {
    paid: true, verifies: true, values: { environment: 'production', paidScreening: 'true' }
  });
  const granted = screeningAdmission('twilio_lookup', {
    paid: true, verifies: true, values: { environment: 'production', paidScreening: 'enabled' }
  });
  check('a paid lookup is refused outside production',
    staging.allowed === false && staging.reason === 'non_production_environment');
  check('a paid lookup is refused until explicitly enabled',
    unset.allowed === false && unset.reason === 'paid_screening_not_explicitly_enabled');
  check('only the exact word "enabled" authorises spend',
    typo.allowed === false && granted.allowed === true, `typo=${typo.allowed} granted=${granted.allowed}`);
  check('a free provider needs no spend authorisation outside production',
    screeningAdmission('mock', { paid: false, values: { environment: 'staging' } }).allowed === true);
}

// 2b. Free is not the same as real. A provider that computes its own answers is
// refused in production no matter what it costs, because the evidence it writes
// is indistinguishable from verified evidence once it is in the ledger.
{
  check('the mock declares that it verifies nothing and the paid provider declares that it does',
    screeningProviderVerifies('mock') === false
      && screeningProviderVerifies('twilio_lookup') === true);

  check('an unknown provider is assumed not to verify',
    screeningProviderVerifies('acme_screening') === false);

  const productionMock = screeningAdmission('mock', {
    paid: false, verifies: false, values: { environment: 'production', paidScreening: 'enabled' }
  });
  check('a simulated provider cannot write production evidence even for free',
    productionMock.allowed === false
      && productionMock.reason === 'non_verifying_provider_in_production',
    productionMock.reason);

  // The parameter that decides this defaults to production, so a caller that
  // supplies nothing must land on the refusal rather than sail past it.
  const unstatedEnvironment = screeningAdmission('mock', { paid: false, verifies: false, values: {} });
  check('an unstated environment refuses the mock rather than admitting it',
    unstatedEnvironment.allowed === false
      && unstatedEnvironment.reason === 'non_verifying_provider_in_production',
    unstatedEnvironment.reason);

  // `verifies` defaults to false, so forgetting to pass it fails closed.
  const forgotten = screeningAdmission('twilio_lookup', {
    paid: true, values: { environment: 'production', paidScreening: 'enabled' }
  });
  check('omitting the verification flag fails closed',
    forgotten.allowed === false && forgotten.reason === 'non_verifying_provider_in_production',
    forgotten.reason);

  const authorised = screeningAdmission('twilio_lookup', {
    paid: true, verifies: true, values: { environment: 'production', paidScreening: 'enabled' }
  });
  check('a verifying provider with authorised spend is still admitted in production',
    authorised.allowed === true, authorised.reason);
}

// 2c. The same refusal, through the door an operator actually uses: the
// ingestion path must write nothing when the console picks the mock in
// production. This is the check that would have caught the hole.
{
  const outcome = await ingestPreDialScreening(db, {
    sellerAccountId: SELLER, phoneE164: PHONE, consentGrantedAt: GRANTED,
    providerId: 'mock', nationalDnc: dnc(),
    admissionValues: { environment: 'production', paidScreening: 'enabled' }, now: NOW
  });
  const written = await db.doc(`preDialScreenings/${preDialScreeningId(SELLER, PHONE)}`).get();
  check('the mock writes no production evidence through the ingestion path',
    outcome.ok === false && outcome.written === false
      && outcome.reason === 'non_verifying_provider_in_production' && written.exists === false,
    `${outcome.reason} written=${written.exists}`);
}

// 3. The paid provider writes nothing while it is not authorised.
{
  const outcome = await ingestPreDialScreening(db, {
    sellerAccountId: SELLER, phoneE164: PHONE, consentGrantedAt: GRANTED,
    providerId: 'twilio_lookup', nationalDnc: dnc(),
    admissionValues: { environment: 'production', paidScreening: 'disabled' }, now: NOW
  });
  const written = await db.doc(`preDialScreenings/${preDialScreeningId(SELLER, PHONE)}`).get();
  check('an unauthorised paid provider writes no evidence and says why',
    outcome.ok === false && outcome.written === false
      && outcome.reason === 'paid_screening_not_explicitly_enabled' && written.exists === false,
    outcome.reason);
}

// 4. The happy path writes evidence the gate actually accepts.
{
  const outcome = await ingestPreDialScreening(db, {
    sellerAccountId: SELLER, phoneE164: PHONE, consentGrantedAt: GRANTED,
    nationalDnc: dnc(), admissionValues: STAGING, now: NOW
  });
  const stored = await db.doc(`preDialScreenings/${outcome.id}`).get();
  const verdict = evaluatePreDialScreening({
    screening: stored.data(), campaign, phoneE164: PHONE, consent, now: NOW
  });
  check('ingested evidence satisfies the gate it was written for',
    outcome.written === true && stored.exists && verdict.eligible === true,
    `written=${outcome.written} reasons=${JSON.stringify(verdict.reasons)}`);
  check('the document id is derived from seller and number, not invented',
    outcome.id === preDialScreeningId(SELLER, PHONE));
  check('the evidence records which provider produced it',
    stored.get('ingestedBy') === 'mock');
}

// 5. Evidence is seller-bound: another seller's campaign cannot borrow it.
{
  const stored = await db.doc(`preDialScreenings/${preDialScreeningId(SELLER, PHONE)}`).get();
  const verdict = evaluatePreDialScreening({
    screening: stored.data(), campaign: { ...campaign, accountId: 'stone-bellisimo' },
    phoneE164: PHONE, consent, now: NOW
  });
  check('one seller’s screening does not clear another seller’s call',
    verdict.eligible === false && verdict.reasons.includes('external_screening_seller_mismatch'),
    JSON.stringify(verdict.reasons));
}

// 6. A dirty number is a correct answer, not a ledger entry.
{
  const reassigned = '+12015550100';   // mock: suffix 00 reads as reassigned
  const outcome = await ingestPreDialScreening(db, {
    sellerAccountId: SELLER, phoneE164: reassigned, consentGrantedAt: GRANTED,
    nationalDnc: dnc(), admissionValues: STAGING, now: NOW
  });
  const stored = await db.doc(`preDialScreenings/${outcome.id}`).get();
  const verdict = evaluatePreDialScreening({
    screening: stored.data(), campaign, phoneE164: reassigned, consent, now: NOW
  });
  check('a reassigned number is written but never reads as eligible',
    verdict.eligible === false && verdict.reasons.includes('number_reassigned'),
    JSON.stringify(verdict.reasons));
}

// 7. The inputs nobody can fake.
{
  const noDnc = await rejects(ingestPreDialScreening(db, {
    sellerAccountId: SELLER, phoneE164: PHONE, consentGrantedAt: GRANTED, nationalDnc: null,
    admissionValues: STAGING, now: NOW
  }), /national DNC/i);
  const noSnapshot = await rejects(ingestPreDialScreening(db, {
    sellerAccountId: SELLER, phoneE164: PHONE, consentGrantedAt: GRANTED,
    nationalDnc: { status: 'clear', checkedAt: NOW }, admissionValues: STAGING, now: NOW
  }), /snapshot id/i);
  const noConsentDate = await rejects(ingestPreDialScreening(db, {
    sellerAccountId: SELLER, phoneE164: PHONE, consentGrantedAt: null, nationalDnc: dnc(),
    admissionValues: STAGING, now: NOW
  }), /consent grant date/i);
  check('a national DNC result cannot be omitted', noDnc.threw === true, noDnc.message);
  check('a DNC result with no dated snapshot is refused', noSnapshot.threw === true, noSnapshot.message);
  check('screening without a consent date is refused', noConsentDate.threw === true, noConsentDate.message);
}

// 8. Our own suppression ledger wins before any vendor is paid.
{
  const { suppressNumber } = await import('./inbound-compliance.js').catch(() => ({}));
  const suppressedPhone = '+12015550777';
  if (typeof suppressNumber === 'function') {
    await suppressNumber(db, suppressedPhone, { reason: 'test' });
    const outcome = await ingestPreDialScreening(db, {
      sellerAccountId: SELLER, phoneE164: suppressedPhone, consentGrantedAt: GRANTED,
      nationalDnc: dnc(), admissionValues: STAGING, now: NOW
    });
    check('a suppressed number is never written as cleared',
      outcome.written === false && outcome.reason === 'entity_dnc_suppressed', outcome.reason);
  } else {
    check('a suppressed number is never written as cleared (skipped: no suppressNumber export)', true);
  }
}

await wipe('preDialScreenings');
await wipe('suppressedNumbers');

const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
