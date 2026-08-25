// The no-dial eligibility audit.
//
// Two questions, and the second one matters more than the first.
//
//   1. Does it classify correctly? Does a Watcher row with no grant land in
//      "consent missing", does a revoked grant say revoked, does an unknown
//      line type block?
//   2. Is it ever kinder than the dialer, and does running it change anything?
//
// The second is what makes this file long. An audit that reports four thousand
// callable numbers because it forgot a gate is worse than no audit — an
// operator would believe it — and an audit that quietly creates a consent
// grant, imports a target, or contacts a provider while "just reporting" is
// worse still. Both are asserted against the emulator rather than a fake,
// because "wrote nothing" is a claim about a database.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const {
  runEligibilityAudit, evaluateCampaignReadiness, eligibilityAuditCsv,
  persistEligibilityAudit, maskPhone, classifyReasons, bucketsForReasons,
  ELIGIBILITY_DISCLAIMER, MAX_SCAN_LIMIT, AUDIT_BUCKETS
} = await import('./outbound-eligibility-audit.js');
const { evaluateCompliance } = await import('./outbound-compliance.js');
const { RESEARCH_EVIDENCE_POLICY_VERSION } = await import('./lead-enrichment.js');
const {
  PRE_DIAL_SCREENING_POLICY_VERSION, preDialScreeningId, screeningPhoneHash
} = await import('./pre-dial-screening.js');
const { suppressNumber } = await import('./inbound-compliance.js');

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

const wipe = async collectionName => {
  const snapshot = await db.collection(collectionName).limit(500).get();
  for (const entry of snapshot.docs) {
    for (const nested of await entry.ref.listCollections()) {
      const children = await nested.limit(500).get();
      for (const child of children.docs) await child.ref.delete();
    }
    await entry.ref.delete();
  }
};

const COLLECTIONS = [
  'outboundCampaigns', 'outboundTargets', 'prospects', 'leads', 'consentGrants',
  'consentEvidenceCandidates', 'preDialScreenings', 'leadResearch', 'suppressedNumbers',
  'outboundEligibilityAudits', 'campaignIncidents', 'dialerSessions', 'calls'
];
const reset = async () => { for (const name of COLLECTIONS) await wipe(name); };

const countAll = async name => (await db.collection(name).limit(50).get()).size;

// A Tuesday, mid-afternoon in New Jersey, so a default calling window is open.
const NOW = new Date('2026-08-25T18:00:00.000Z');
const ACCOUNT = 'bitesites';
const CAMPAIGN = 'campaign-audit';
const PHONE = '+12015550142';

const seedCampaign = async (extra = {}) => {
  await db.doc(`outboundCampaigns/${CAMPAIGN}`).set({
    accountId: ACCOUNT,
    name: 'Audit rehearsal',
    status: 'paused',
    mode: 'ai',
    provider: 'mock',
    concurrency: 1,
    maxAttempts: 1,
    retryDelayMinutes: 1440,
    callerId: '+12015524949',
    requireResearchApproval: true,
    allowedDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    localStartTime: '00:00',
    localEndTime: '23:59',
    createdAt: Timestamp.fromDate(NOW),
    ...extra
  });
};

const seedProspect = async (id, extra = {}) => {
  await db.doc(`prospects/${id}`).set({
    type: 'outbound_prospect',
    accountId: ACCOUNT,
    name: `Prospect ${id}`,
    companyName: `Company ${id}`,
    phoneE164: PHONE,
    location: { timezone: 'America/New_York' },
    address: { region: 'NJ' },
    lifecycle: { status: 'ready' },
    contactability: { doNotCall: false },
    consent: {},
    source: { system: 'watcher_leads', provider: 'watcher_workflow', providerRecordId: 'w-1' },
    createdAt: Timestamp.fromDate(NOW),
    ...extra
  });
};

const seedTarget = async (id, prospectId, extra = {}) => {
  await db.doc(`outboundTargets/${id}`).set({
    campaignId: CAMPAIGN,
    accountId: ACCOUNT,
    contactType: 'prospect',
    prospectId,
    phoneE164: PHONE,
    state: 'ready',
    attemptCount: 0,
    priority: 50,
    consent: {},
    createdAt: Timestamp.fromDate(NOW),
    ...extra
  });
};

const seedGrant = async (grantId, extra = {}) => {
  await db.doc(`consentGrants/${grantId}`).set({
    basis: 'written_opt_in',
    sellerAccountId: ACCOUNT,
    phoneE164: PHONE,
    evidenceArtifactId: 'artifact-1',
    disclosureVersion: 'disclosure-v1',
    grantedAt: Timestamp.fromDate(new Date('2026-06-01T00:00:00.000Z')),
    reviewedAt: Timestamp.fromDate(new Date('2026-06-01T00:00:00.000Z')),
    reviewedBy: 'owner@bitesites.test',
    status: 'active',
    ...extra
  });
};

const seedResearch = async (prospectId, extra = {}) => {
  await db.doc(`leadResearch/prospect_${prospectId}`).set({
    accountId: ACCOUNT,
    evidencePolicyVersion: RESEARCH_EVIDENCE_POLICY_VERSION,
    status: 'ready',
    approved: true,
    summary: 'Synthetic brief',
    ...extra
  });
};

const fresh = (from = NOW) => ({
  checkedAt: Timestamp.fromDate(new Date(from.getTime() - 86400000)),
  expiresAt: Timestamp.fromDate(new Date(from.getTime() + 86400000))
});

const seedScreening = async (extra = {}) => {
  const id = preDialScreeningId(ACCOUNT, PHONE);
  await db.doc(`preDialScreenings/${id}`).set({
    policyVersion: PRE_DIAL_SCREENING_POLICY_VERSION,
    sellerAccountId: ACCOUNT,
    phoneHash: screeningPhoneHash(ACCOUNT, PHONE),
    status: 'cleared',
    ...fresh(),
    nationalDnc: { status: 'clear', snapshotId: 'dnc-20260601', provider: 'a-real-service', ...fresh() },
    entityDnc: { status: 'clear', provider: 'bitesites_suppression_ledger', ...fresh() },
    reassignedNumber: { status: 'no', lastVerifiedDate: '20260601', provider: 'twilio_lookup_v2', ...fresh() },
    phoneValidation: { valid: true, provider: 'twilio_lookup_v2', ...fresh() },
    lineType: { type: 'mobile', provider: 'twilio_lookup_v2', ...fresh() },
    ...extra
  });
  return id;
};

/** A campaign, prospect, target, grant, screening and brief that all agree. */
const seedFullyEligible = async ({ campaign = {}, grantId = 'grant-ok' } = {}) => {
  await seedCampaign(campaign);
  await seedProspect('p-ok', { consent: { grantId } });
  await seedTarget('t-ok', 'p-ok', { consent: { grantId } });
  await seedGrant(grantId);
  await seedScreening();
  await seedResearch('p-ok');
};

const audit = (options = {}) => runEligibilityAudit(db, {
  accountId: ACCOUNT, campaignId: CAMPAIGN, scopes: ['campaign_targets'], now: NOW, ...options
});

const rowFor = (report, id) => report.rows.find(row => row.id === id || row.targetId === id);

// ---------------------------------------------------------------------------
console.log('\noutbound eligibility audit');

// 1. It refuses to invent a policy.
{
  await reset();
  await seedCampaign();

  const noCampaign = await rejects(audit({ campaignId: '' }), /campaign id is required/i);
  const missing = await rejects(audit({ campaignId: 'nope' }), /not found/i);
  const wrongAccount = await rejects(
    audit({ accountId: 'fine-line-group' }), /different account/i
  );
  const unknownAccount = await rejects(audit({ accountId: 'not-a-seller' }), /not a known account/i);
  const noScope = await rejects(audit({ scopes: [] }), /at least one scope/i);

  check('an audit without a campaign policy is refused', noCampaign.threw, noCampaign.message);
  check('a missing campaign is reported, not invented', missing.threw, missing.message);
  check('one seller cannot audit another seller’s campaign', wrongAccount.threw, wrongAccount.message);
  check('an unknown account is refused', unknownAccount.threw, unknownAccount.message);
  check('a scopeless audit is refused rather than silently empty', noScope.threw, noScope.message);
}

// 2. The expected current result: Watcher rows are not callable, and auditing
//    them cannot make them callable.
{
  await reset();
  await seedCampaign();
  for (const index of [1, 2, 3]) {
    await seedProspect(`p-w${index}`, { consent: {} });
    await seedTarget(`t-w${index}`, `p-w${index}`);
  }

  const report = await audit();
  const row = rowFor(report, 't-w1');

  check('every Watcher row without a grant is ineligible',
    report.totals.scanned === 3 && report.totals.eligibleNow === 0 && report.totals.recordReady === 0,
    JSON.stringify(report.totals));
  check('the blocker is named as missing written AI consent',
    row.reasons.includes('ai_consent_not_documented') && row.buckets.includes('ai_consent'),
    row.reasons.join(','));
  check('a record with no ledger entry says the ledger has no entry',
    row.reasons.includes('ai_consent_unverified'), row.reasons.join(','));
  check('the record is classified as missing evidence',
    row.classification === 'evidence_missing', row.classification);
  check('auditing issued no consent grant and no screening clearance',
    (await countAll('consentGrants')) === 0
    && (await countAll('consentEvidenceCandidates')) === 0
    && (await countAll('preDialScreenings')) === 0);
  check('auditing started no call and no dialer session',
    (await countAll('calls')) === 0 && (await countAll('dialerSessions')) === 0);
  check('auditing left every target exactly as it found it',
    (await db.doc('outboundTargets/t-w1').get()).data().state === 'ready'
    && (await db.doc('outboundTargets/t-w1').get()).data().attemptCount === 0);
  check('auditing created no research brief',
    (await countAll('leadResearch')) === 0);
}

// 3. The happy path exists, so a zero is a finding rather than a bug.
{
  await reset();
  await seedFullyEligible();
  const report = await audit();
  const row = rowFor(report, 't-ok');

  check('a record with grant, screening, brief and an open window is eligible',
    report.totals.eligibleNow === 1 && row.eligibleNow && row.classification === 'eligible_now',
    row.reasons.join(','));
  check('campaign readiness is reported separately and is ready here',
    report.campaignReadiness.ready === true, report.campaignReadiness.reasons.join(','));
  check('the eligible row still reports no unmasked number',
    row.phoneMasked === maskPhone(PHONE) && !JSON.stringify(row).includes(PHONE), row.phoneMasked);
}

// 4. The audit is never kinder than the dialer.
{
  await reset();
  await seedFullyEligible();
  await seedProspect('p-blocked', { consent: {} });
  await seedTarget('t-blocked', 'p-blocked');

  const report = await audit();
  let strictEverywhere = true;
  let detail = '';

  for (const row of report.rows) {
    const target = (await db.doc(`outboundTargets/${row.targetId}`).get()).data();
    const contact = (await db.doc(`prospects/${target.prospectId}`).get()).data();
    const campaign = (await db.doc(`outboundCampaigns/${CAMPAIGN}`).get()).data();
    const grantId = target.consent?.grantId || '';
    const grant = grantId ? (await db.doc(`consentGrants/${grantId}`).get()).data() : null;
    const consent = grant ? { ...grant, grantId, verificationState: 'verified' } : {};

    const dialer = evaluateCompliance({
      target: { ...target, consent }, contact, campaign: { ...campaign, id: CAMPAIGN }, now: NOW,
      automatedVoice: true, externalScreening: { eligible: true, reasons: [] }
    });
    const missed = dialer.reasons.filter(reason => !row.reasons.includes(reason));
    if (missed.length) { strictEverywhere = false; detail = `${row.targetId}: ${missed.join(',')}`; }
    if (row.eligibleNow && !dialer.eligible) {
      strictEverywhere = false;
      detail = `${row.targetId} reported eligible while the dialer refuses it`;
    }
  }
  check('every reason the dialer would give appears in the audit, and none is dropped',
    strictEverywhere, detail);
}

// 5. Seller isolation. One seller's evidence never authorises another's call.
{
  await reset();
  await seedFullyEligible();
  await db.doc('consentGrants/grant-ok').set({ sellerAccountId: 'fine-line-group' }, { merge: true });

  const report = await audit();
  const row = rowFor(report, 't-ok');
  check('a grant issued to another seller does not authorise this one',
    !row.eligibleNow && row.reasons.includes('ai_consent_seller_mismatch'), row.reasons.join(','));
}

// 6. The grant has to be for this number.
{
  await reset();
  await seedFullyEligible();
  await db.doc('consentGrants/grant-ok').set({ phoneE164: '+12015550199' }, { merge: true });

  const report = await audit();
  const row = rowFor(report, 't-ok');
  check('a grant for a different number does not authorise this one',
    !row.eligibleNow && row.reasons.includes('ai_consent_phone_mismatch'), row.reasons.join(','));
}

// 7. Revocation and expiry, distinguished for the operator.
{
  await reset();
  await seedFullyEligible();
  await db.doc('consentGrants/grant-ok').set({
    status: 'revoked', revokedAt: Timestamp.fromDate(new Date('2026-07-01T00:00:00.000Z'))
  }, { merge: true });
  const revoked = rowFor(await audit(), 't-ok');

  await db.doc('consentGrants/grant-ok').set({
    status: 'active', revokedAt: null,
    expiresAt: Timestamp.fromDate(new Date('2026-07-01T00:00:00.000Z'))
  }, { merge: true });
  const expired = rowFor(await audit(), 't-ok');

  check('a revoked grant fails, and says it was revoked',
    !revoked.eligibleNow && revoked.reasons.includes('ai_consent_not_documented')
    && revoked.reasons.includes('ai_consent_revoked'), revoked.reasons.join(','));
  check('an expired grant fails, and says it expired',
    !expired.eligibleNow && expired.reasons.includes('ai_consent_expired'), expired.reasons.join(','));
}

// 8. Screening: every source has to agree, and the audit says which did not.
{
  const provider = { provider: 'twilio' };
  const cases = [
    ['a missing screening record', async () => { await db.doc(`preDialScreenings/${preDialScreeningId(ACCOUNT, PHONE)}`).delete(); },
      'external_screening_missing'],
    ['an obsolete screening policy', async () => { await seedScreening({ policyVersion: 'ai-pre-dial-screening/2020-01-01' }); },
      'external_screening_policy_mismatch'],
    ['a screening bound to another seller', async () => { await seedScreening({ sellerAccountId: 'stone-bellisimo' }); },
      'external_screening_seller_mismatch'],
    ['a screening bound to another number', async () => { await seedScreening({ phoneHash: screeningPhoneHash(ACCOUNT, '+12015550199') }); },
      'external_screening_phone_mismatch'],
    ['an expired screening', async () => {
      await seedScreening({
        checkedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z')),
        expiresAt: Timestamp.fromDate(new Date('2026-02-01T00:00:00.000Z'))
      });
    }, 'external_screening_stale'],
    ['a national DNC result with no dated snapshot id', async () => {
      await seedScreening({ nationalDnc: { status: 'clear', snapshotId: '', ...fresh() } });
    }, 'national_dnc_not_cleared'],
    ['a seller DNC match', async () => {
      await seedScreening({ entityDnc: { status: 'suppressed', ...fresh() } });
    }, 'entity_dnc_not_cleared'],
    ['a reassigned number', async () => {
      await seedScreening({ reassignedNumber: { status: 'yes', lastVerifiedDate: '20260601', ...fresh() } });
    }, 'number_reassigned'],
    ['a reassigned check that did not use the consent date', async () => {
      await seedScreening({ reassignedNumber: { status: 'no', lastVerifiedDate: '19990101', ...fresh() } });
    }, 'reassigned_number_consent_date_mismatch'],
    ['a number the carrier could not validate', async () => {
      await seedScreening({ phoneValidation: { valid: false, ...fresh() } });
    }, 'phone_validation_not_cleared'],
    ['an unknown line type', async () => {
      await seedScreening({ lineType: { type: 'unknown', ...fresh() } });
    }, 'line_type_not_callable'],
    ['a pager line type', async () => {
      await seedScreening({ lineType: { type: 'pager', ...fresh() } });
    }, 'line_type_not_callable']
  ];

  let allBlocked = true;
  const misses = [];
  for (const [label, mutate, expected] of cases) {
    await reset();
    await seedFullyEligible({ campaign: provider });
    await mutate();
    const row = rowFor(await audit(), 't-ok');
    if (row.eligibleNow || !row.reasons.includes(expected)) {
      allBlocked = false;
      misses.push(`${label} → ${row.reasons.join(',')}`);
    }
  }
  check('every screening defect blocks the record and is named', allBlocked, misses.join(' | '));
}

// 9. A carrier-backed AI campaign with no screening at all cannot be eligible.
{
  await reset();
  await seedFullyEligible({ campaign: { provider: 'twilio' } });
  await db.doc(`preDialScreenings/${preDialScreeningId(ACCOUNT, PHONE)}`).delete();
  const row = rowFor(await audit(), 't-ok');
  check('a carrier provider requires screening evidence the mock does not',
    !row.eligibleNow && row.buckets.includes('screening_record'), row.reasons.join(','));
}

// 10. Internal suppression and do-not-contact.
{
  await reset();
  await seedFullyEligible();
  await suppressNumber(db, PHONE, { reason: 'asked us to stop', source: 'test' });
  const suppressed = rowFor(await audit(), 't-ok');

  await reset();
  await seedFullyEligible();
  await db.doc('prospects/p-ok').set({ contactability: { doNotCall: true } }, { merge: true });
  const dnc = rowFor(await audit(), 't-ok');

  check('a suppressed number is permanently blocked',
    !suppressed.eligibleNow && suppressed.reasons.includes('suppressed')
    && suppressed.classification === 'permanently_suppressed', suppressed.reasons.join(','));
  check('an internal do-not-call is permanently blocked',
    !dnc.eligibleNow && dnc.reasons.includes('do_not_call')
    && dnc.classification === 'permanently_suppressed', dnc.reasons.join(','));
}

// 11. Time, attempts and research — the blockers that pass on their own.
{
  await reset();
  await seedFullyEligible({ campaign: { localStartTime: '09:00', localEndTime: '09:30', allowedDays: ['mon'] } });
  const outsideHours = rowFor(await audit(), 't-ok');

  await reset();
  await seedFullyEligible();
  await db.doc('outboundTargets/t-ok').set({ attemptCount: 3 }, { merge: true });
  const attempts = rowFor(await audit(), 't-ok');

  await reset();
  await seedFullyEligible();
  await db.doc('leadResearch/prospect_p-ok').set({ approved: false }, { merge: true });
  const unapproved = rowFor(await audit(), 't-ok');

  await reset();
  await seedFullyEligible();
  await db.doc('leadResearch/prospect_p-ok').delete();
  const noBrief = rowFor(await audit(), 't-ok');
  // Counted here rather than with the other assertions: the next scenario
  // re-seeds a brief, and a count taken afterwards would be measuring that one.
  const briefsAfterAudit = await countAll('leadResearch');

  await reset();
  await seedFullyEligible();
  await db.doc('prospects/p-ok').set({ location: { timezone: '' }, address: {}, phoneE164: '+442071234567' }, { merge: true });
  await db.doc('outboundTargets/t-ok').set({ phoneE164: '+442071234567' }, { merge: true });
  const noZone = rowFor(await audit(), 't-ok');

  check('a closed calling window is a temporary block, not a permanent one',
    !outsideHours.eligibleNow && outsideHours.classification === 'temporarily_blocked'
    && outsideHours.buckets.includes('timezone_or_hours'), outsideHours.reasons.join(','));
  check('a closed window reports when it next opens',
    outsideHours.nextWindowOpensAt instanceof Date, String(outsideHours.nextWindowOpensAt));
  check('an attempt-exhausted target is reported and bucketed',
    !attempts.eligibleNow && attempts.reasons.includes('max_attempts_reached')
    && attempts.buckets.includes('attempts_or_retry'), attempts.reasons.join(','));
  check('an unapproved brief blocks a campaign that requires approval',
    !unapproved.eligibleNow && unapproved.reasons.includes('research_not_approved'), unapproved.reasons.join(','));
  check('a missing brief is reported without the audit going and building one',
    !noBrief.eligibleNow && noBrief.reasons.includes('research_missing')
    && briefsAfterAudit === 0, `${noBrief.reasons.join(',')} briefs=${briefsAfterAudit}`);
  check('an unknown timezone blocks rather than defaulting to a window',
    !noZone.eligibleNow && noZone.reasons.includes('unknown_timezone'), noZone.reasons.join(','));
}

// 12. Campaign-wide blockers: the circuit breaker, the provider, the deployment.
{
  await reset();
  await seedFullyEligible();
  await db.doc(`outboundCampaigns/${CAMPAIGN}`).set({
    safetyLock: { engaged: true, openIncidents: 1, reason: 'ai_media_control_failure' }
  }, { merge: true });
  const halted = await audit();
  const haltedRow = rowFor(halted, 't-ok');

  check('an open campaign incident blocks every record in the campaign',
    halted.campaignReadiness.ready === false
    && halted.campaignReadiness.reasons.includes('campaign_safety_lock')
    && halted.totals.eligibleNow === 0
    && haltedRow.reasons.includes('campaign_safety_lock')
    && haltedRow.classification === 'configuration_blocked',
    haltedRow.reasons.join(','));
  check('a halted campaign still reports which records are otherwise ready',
    halted.totals.recordReady === 1, JSON.stringify(halted.totals));

  await reset();
  await seedFullyEligible({ campaign: { provider: 'gohighlevel' } });
  const ghl = await audit();
  check('GoHighLevel remains unable to run a controlled AI campaign',
    ghl.campaignReadiness.reasons.includes('provider_cannot_place_ai_calls')
    && ghl.campaignReadiness.providerMissingCapabilities.includes('aiAgentCall')
    && ghl.totals.eligibleNow === 0,
    ghl.campaignReadiness.reasons.join(','));
}

// 13. The deployment gate, read through the audit.
{
  await reset();
  await seedFullyEligible({ campaign: { provider: 'twilio' } });

  const defaults = evaluateCampaignReadiness(
    { accountId: ACCOUNT, mode: 'ai', provider: 'twilio', callerId: '+12015524949' },
    { deploymentValues: {} }
  );
  const stagingMisconfigured = evaluateCampaignReadiness(
    { accountId: ACCOUNT, mode: 'ai', provider: 'twilio', callerId: '+12015524949' },
    { deploymentValues: { environment: 'staging', externalDialing: 'enabled' } }
  );
  const production = evaluateCampaignReadiness(
    { accountId: ACCOUNT, mode: 'ai', provider: 'twilio', callerId: '+12015524949' },
    { deploymentValues: { environment: 'production', externalDialing: 'enabled' } }
  );

  const report = await audit({ deploymentValues: { environment: 'staging', externalDialing: 'enabled' } });

  check('external dialing defaults to disabled',
    defaults.reasons.includes('external_dialing_disabled')
    && defaults.deployment.reason === 'external_dialing_not_explicitly_enabled',
    defaults.deployment.reason);
  check('staging stays non-dialing even with the enable flag set',
    stagingMisconfigured.reasons.includes('external_dialing_disabled')
    && stagingMisconfigured.deployment.reason === 'non_production_environment',
    stagingMisconfigured.deployment.reason);
  check('only production plus an explicit opt-in clears the deployment gate',
    production.deployment.allowed === true, production.deployment.reason);
  check('a misconfigured staging deployment produces zero eligible records',
    report.totals.eligibleNow === 0
    && report.campaignReadiness.reasons.includes('external_dialing_disabled'),
    report.campaignReadiness.reasons.join(','));
}

// 14. Caller identity and account alignment.
{
  await reset();
  await seedFullyEligible({ campaign: { callerId: '' } });
  const noCallerId = await audit();

  await reset();
  await seedFullyEligible({ campaign: { accountId: ACCOUNT } });
  await db.doc('outboundTargets/t-ok').set({ accountId: 'stone-bellisimo' }, { merge: true });
  const mismatched = rowFor(await audit(), 't-ok');

  await reset();
  await seedFullyEligible({ campaign: { accountId: 'fine-line-group', callerId: '+19735550000' } });
  const unregistered = evaluateCampaignReadiness({
    accountId: 'fine-line-group', mode: 'ai', provider: 'mock', callerId: '+19735550000'
  });

  check('a campaign with no caller ID blocks every record',
    noCallerId.totals.eligibleNow === 0
    && noCallerId.rows[0].reasons.includes('invalid_caller_id'),
    noCallerId.rows[0].reasons.join(','));
  check('a target bound to another account is a configuration block',
    !mismatched.eligibleNow && mismatched.reasons.includes('target_account_mismatch')
    && mismatched.buckets.includes('account_mismatch'), mismatched.reasons.join(','));
  check('a caller ID not registered to the seller is refused',
    unregistered.reasons.includes('caller_id_not_registered'), unregistered.reasons.join(','));
}

// 15. GoHighLevel, read-only, through the audit.
{
  const LOCATION = 'LDL5wuJlnVnqk9vn6taD';
  const ghlContact = (id, extra = {}) => ({
    id, locationId: LOCATION, contactName: `CRM ${id}`, companyName: `CRM Co ${id}`,
    phone: PHONE, timezone: 'America/New_York', state: 'NJ',
    tags: ['client:bitesites'], dateAdded: '2026-01-01T00:00:00.000Z', ...extra
  });

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        contacts: [
          ghlContact('crm-plain'),
          ghlContact('crm-dnd', { dnd: true }),
          ghlContact('crm-other-seller', { tags: ['client:fineline'] }),
          ghlContact('crm-untagged', { tags: [] }),
          ghlContact('crm-claims-consent', {
            customFields: [
              { key: 'consent_basis', value: 'written_opt_in' },
              { key: 'consent_grant_id', value: 'crm-invented-grant' }
            ]
          })
        ]
      })
    };
  };

  await reset();
  await seedCampaign();
  const report = await audit({
    scopes: [],
    goHighLevel: { token: 'read-only', locationId: LOCATION, fetchImpl, sleepImpl: async () => {}, pageSize: 25 }
  });

  const find = id => report.rows.find(row => row.id === id);

  check('GoHighLevel contacts are audited without any of them becoming eligible',
    report.totals.scanned === 5 && report.totals.eligibleNow === 0, JSON.stringify(report.totals));
  check('a CRM contact with no BiteSites grant cannot pass AI eligibility',
    find('crm-plain').reasons.includes('ai_consent_not_documented'),
    find('crm-plain').reasons.join(','));
  check('CRM do-not-disturb blocks the record and gets its own bucket',
    find('crm-dnd').reasons.includes('crm_do_not_disturb')
    && find('crm-dnd').buckets.includes('dnc_or_suppressed')
    && find('crm-dnd').classification === 'permanently_suppressed',
    find('crm-dnd').reasons.join(','));
  check('a contact tagged for another seller is refused, not reassigned',
    find('crm-other-seller').reasons.includes('crm_account_mismatch'),
    find('crm-other-seller').reasons.join(','));
  check('a contact with no account tag is refused rather than defaulted',
    find('crm-untagged').reasons.includes('no_account_tag'),
    find('crm-untagged').reasons.join(','));
  check('a CRM field claiming written consent does not create a grant',
    find('crm-claims-consent').reasons.includes('ai_consent_not_documented')
    && find('crm-claims-consent').consent.grantId === ''
    && (await countAll('consentGrants')) === 0,
    find('crm-claims-consent').reasons.join(','));
  check('the audit only ever asked GoHighLevel to search',
    calls.length === 1 && calls[0].method === 'POST'
    && calls[0].url === 'https://services.leadconnectorhq.com/contacts/search',
    JSON.stringify(calls));
  check('auditing GoHighLevel imported nothing into Firestore',
    (await countAll('prospects')) === 0 && (await countAll('outboundTargets')) === 0
    && (await countAll('leads')) === 0, 'a read must not create records');
  check('the CRM read is reported, including which requests it made',
    report.crm && report.crm.requests.length === 1 && report.crm.pages === 1,
    JSON.stringify(report.crm));
}

// 16. Prospect and lead scopes, for records never added to a campaign.
{
  await reset();
  await seedCampaign();
  await seedProspect('p-loose');
  await db.doc('leads/l-loose').set({
    accountId: ACCOUNT, name: 'Loose Lead', businessName: 'Loose Co',
    phoneE164: PHONE, timezone: 'America/New_York', status: 'new', consent: {}
  });

  const report = await audit({ scopes: ['account_prospects', 'account_leads'] });
  check('prospects and leads can be audited before they are ever targets',
    report.totals.scanned === 2
    && report.scopeCounts.account_prospects === 1
    && report.scopeCounts.account_leads === 1,
    JSON.stringify(report.scopeCounts));
  check('a record that has never been a target reports zero attempts',
    report.rows.every(row => row.attemptCount === 0 && row.targetId === ''));
  check('neither scope wrote anything',
    (await countAll('outboundTargets')) === 0 && (await countAll('leadResearch')) === 0);
}

// 17. Bounds and truncation.
{
  await reset();
  await seedCampaign();
  for (const index of [1, 2, 3, 4, 5]) {
    await seedProspect(`p-b${index}`);
    await seedTarget(`t-b${index}`, `p-b${index}`);
  }
  const capped = await audit({ limit: 2 });
  const oversized = await audit({ limit: 10 ** 6 });

  check('the scan limit is honoured and truncation is announced',
    capped.totals.scanned === 2 && capped.totals.truncated === true && capped.totals.scanLimit === 2,
    JSON.stringify(capped.totals));
  check('an absurd limit is clamped rather than obeyed',
    oversized.totals.scanLimit === MAX_SCAN_LIMIT, String(oversized.totals.scanLimit));
}

// 18. The report and its export.
{
  await reset();
  await seedFullyEligible();
  await seedProspect('p-w9');
  await seedTarget('t-w9', 'p-w9');
  const report = await audit();
  const csv = eligibilityAuditCsv(report);

  check('the report says out loud what "eligible" does and does not mean',
    report.disclaimer === ELIGIBILITY_DISCLAIMER && csv.includes(ELIGIBILITY_DISCLAIMER));
  check('every bucket in the schema is present in the counts',
    AUDIT_BUCKETS.every(([id]) => Object.prototype.hasOwnProperty.call(report.buckets, id)));
  check('the class counts add up to the number of records scanned',
    Object.values(report.classes).reduce((sum, value) => sum + value, 0) === report.totals.scanned,
    JSON.stringify(report.classes));
  check('the CSV export masks every number and exports no evidence',
    !csv.includes(PHONE) && !csv.includes('dnc-20260601') && !csv.includes('artifact-1')
    && !csv.includes('disclosure-v1'),
    'the export must not carry registry or consent evidence');
  check('the CSV carries the stable record id an admin investigates with',
    csv.includes('p-ok') && csv.includes('record_id'));
  check('the campaign caller ID is masked in the report too',
    report.campaign.callerId === maskPhone('+12015524949'), report.campaign.callerId);
  check('no unmasked phone number appears anywhere in the report',
    !JSON.stringify(report).includes(PHONE));
}

// 19. Persistence is a summary, server-written, and account-scoped.
{
  await reset();
  await seedFullyEligible();
  const report = await audit();
  const { id } = await persistEligibilityAudit(db, report, { actor: 'owner@bitesites.test', actorUid: 'uid-1' });
  const stored = (await db.doc(`outboundEligibilityAudits/${id}`).get()).data();

  check('the persisted audit is scoped to one account and one campaign',
    stored.accountId === ACCOUNT && stored.campaignId === CAMPAIGN);
  check('the persisted audit keeps counts, not people',
    typeof stored.totals.scanned === 'number' && stored.rows === undefined
    && !JSON.stringify(stored).includes(PHONE));
  check('the persisted audit records who ran it',
    stored.actor === 'owner@bitesites.test' && stored.actorUid === 'uid-1');
}

// 20. Pure classification, exercised directly.
{
  check('the worst reason decides the class',
    classifyReasons(['outside_calling_hours', 'do_not_call']) === 'permanently_suppressed'
    && classifyReasons(['outside_calling_hours', 'ai_consent_not_documented']) === 'evidence_missing'
    && classifyReasons(['outside_calling_hours']) === 'temporarily_blocked'
    && classifyReasons([]) === 'eligible_now');
  check('an unrecognised reason is classified rather than dropped',
    classifyReasons(['something_new_nobody_mapped']) === 'configuration_blocked');
  check('masking keeps the area code and hides the subscriber number',
    maskPhone('+12015550142') === '+1 (201) •••-••42' && maskPhone('') === ''
    && !maskPhone('+12015550142').includes('5550142'));
  check('reasons map onto the buckets an operator asks about',
    bucketsForReasons(['ai_consent_phone_mismatch']).includes('ai_consent')
    && bucketsForReasons(['line_type_not_callable']).includes('phone_validation_or_line_type')
    && bucketsForReasons(['number_reassigned']).includes('reassigned_number'));
}

await reset();

const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
