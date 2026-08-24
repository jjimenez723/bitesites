// The breaker's whole claim is that a halt and its record land together, and
// that nothing short of a named human decision puts the campaign back on the
// phone. Both are cross-document properties, so this runs against the Firestore
// emulator: an in-process fake whose runTransaction just calls the callback
// cannot falsify either one.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const {
  CRITICAL_INCIDENT_REASONS, campaignSafetyLockEngaged, incidentIdFor,
  listCampaignIncidents, resolveCampaignIncident, safetyStopCampaignSessions,
  tripCampaignCircuitBreaker
} = await import('./campaign-circuit-breaker.js');
const { setCampaignStatus, startDialerSession } = await import('./outbound-calls.js');
const { failClosedAIMediaAttachment } = await import('./hybrid-media-failsafe.js');

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

const NOW = new Date('2026-08-24T15:00:00.000Z');
const CAMPAIGN = 'campaign-breaker';
const ACCOUNT = 'bitesites';

const seedCampaign = async (extra = {}) => {
  await db.doc(`outboundCampaigns/${CAMPAIGN}`).set({
    accountId: ACCOUNT, name: 'Breaker rehearsal', status: 'running', mode: 'ai',
    provider: 'mock', concurrency: 1, maxAttempts: 1,
    createdAt: Timestamp.fromDate(NOW), ...extra
  });
};

const campaignDoc = async () => (await db.doc(`outboundCampaigns/${CAMPAIGN}`).get()).data();

const reset = async () => {
  for (const name of [
    'outboundCampaigns', 'campaignIncidents', 'campaignIncidentEvents', 'dialerSessions',
    'calls', 'aiMediaJobs', 'outboundTargets', 'callAuditEvents'
  ]) await wipe(name);
};

// ---------------------------------------------------------------------------
console.log('\ncampaign circuit breaker');

await reset();
await seedCampaign();

// 1. A critical failure halts the campaign and records why, together.
const firstTrip = await tripCampaignCircuitBreaker(db, {
  campaignId: CAMPAIGN, accountId: ACCOUNT, reason: 'account_boundary_violation',
  source: 'outbound_dialer', detail: 'target resolved to account "stone-bellisimo"',
  targetId: 'target-1', now: NOW
});
{
  const campaign = await campaignDoc();
  const incident = (await db.doc(`campaignIncidents/${firstTrip.incidentId}`).get()).data();
  const opened = await db.doc(`campaignIncidentEvents/${firstTrip.incidentId}/events/opened`).get();
  check('a critical incident pauses the campaign and records itself in one write',
    firstTrip.engaged === true && campaign.status === 'paused'
      && campaignSafetyLockEngaged(campaign) && incident?.status === 'open'
      && incident?.reason === 'account_boundary_violation' && opened.exists,
    `engaged=${firstTrip.engaged} status=${campaign.status} incident=${incident?.status}`);
  check('the incident names the seller account, the subject and the reason',
    incident?.accountId === ACCOUNT && incident?.targetId === 'target-1'
      && incident?.severity === 'critical' && Boolean(incident?.bodyHash),
    JSON.stringify({ accountId: incident?.accountId, targetId: incident?.targetId }));
  check('the lock remembers the status it interrupted',
    campaign.safetyLock?.statusBeforeLock === 'running', campaign.safetyLock?.statusBeforeLock);
}

// 2. Redelivery must not open a second incident.
{
  const again = await tripCampaignCircuitBreaker(db, {
    campaignId: CAMPAIGN, accountId: ACCOUNT, reason: 'account_boundary_violation',
    source: 'outbound_dialer', detail: 'redelivered', targetId: 'target-1', now: NOW
  });
  const campaign = await campaignDoc();
  const all = await listCampaignIncidents(db, CAMPAIGN);
  check('a redelivered failure is idempotent rather than a second incident',
    again.engaged === false && again.idempotent === true && all.length === 1
      && Number(campaign.safetyLock?.openIncidents) === 1,
    `incidents=${all.length} open=${campaign.safetyLock?.openIncidents}`);
}

// 3. Resume is refused; moving further from the phone is not.
{
  const resume = await rejects(setCampaignStatus(db, CAMPAIGN, 'running', { actor: 'owner' }), /circuit breaker/i);
  const afterResume = await campaignDoc();
  check('resume is refused while the incident is unresolved',
    resume.threw === true && afterResume.status === 'paused', resume.message);

  await setCampaignStatus(db, CAMPAIGN, 'paused', { actor: 'owner' });
  check('pausing a halted campaign is still allowed', (await campaignDoc()).status === 'paused');

  const session = await rejects(
    startDialerSession(db, { campaignId: CAMPAIGN, userUid: 'operator-1', mode: 'power', now: NOW }));
  check('no dialer session may open on a halted campaign', session.threw === true, session.message);
}

// 4. Resolution demands a stated corrective action, and never resumes dialing.
{
  const bare = await rejects(
    resolveCampaignIncident(db, { incidentId: firstTrip.incidentId, actor: 'owner', now: NOW }),
    /corrective action/i);
  check('resolving without a corrective action is refused', bare.threw === true, bare.message);

  const resolved = await resolveCampaignIncident(db, {
    incidentId: firstTrip.incidentId, actor: 'owner@bitesites.org', actorUid: 'uid-owner',
    remediation: 'Rebound the campaign to the BiteSites account and re-imported the target list.',
    now: NOW
  });
  const campaign = await campaignDoc();
  const incident = (await db.doc(`campaignIncidents/${firstTrip.incidentId}`).get()).data();
  const event = await db.doc(`campaignIncidentEvents/${firstTrip.incidentId}/events/resolved`).get();
  check('resolving clears the lock, records the remediation and leaves the campaign paused',
    resolved.resolved === true && resolved.lockCleared === true
      && campaignSafetyLockEngaged(campaign) === false && campaign.status === 'paused'
      && incident.status === 'resolved' && incident.resolvedBy === 'owner@bitesites.org'
      && event.exists && event.get('remediation').includes('Rebound'),
    `status=${campaign.status} lockCleared=${resolved.lockCleared}`);
  check('resolution is an append: the incident reason survives it unchanged',
    incident.reason === 'account_boundary_violation' && incident.detail.includes('stone-bellisimo'));

  const repeat = await resolveCampaignIncident(db, {
    incidentId: firstTrip.incidentId, actor: 'owner', remediation: 'Duplicate click on resolve.', now: NOW
  });
  check('resolving twice is idempotent', repeat.resolved === false && repeat.idempotent === true);

  await setCampaignStatus(db, CAMPAIGN, 'running', { actor: 'owner' });
  check('an explicit start is accepted once the lock is clear', (await campaignDoc()).status === 'running');
}

// 5. Two incidents need two resolutions.
{
  await reset();
  await seedCampaign();
  const a = await tripCampaignCircuitBreaker(db, {
    campaignId: CAMPAIGN, accountId: ACCOUNT, reason: 'account_boundary_violation',
    source: 'dialer', targetId: 'target-a', now: NOW
  });
  const b = await tripCampaignCircuitBreaker(db, {
    campaignId: CAMPAIGN, accountId: ACCOUNT, reason: 'compliance_control_failure',
    source: 'dialer', targetId: 'target-b', now: NOW
  });
  check('a different failure on the same campaign opens its own incident',
    a.incidentId !== b.incidentId && Number((await campaignDoc()).safetyLock?.openIncidents) === 2,
    String((await campaignDoc()).safetyLock?.openIncidents));

  await resolveCampaignIncident(db, {
    incidentId: a.incidentId, actor: 'owner', remediation: 'Corrected the account binding.', now: NOW
  });
  const partly = await campaignDoc();
  const stillBlocked = await rejects(setCampaignStatus(db, CAMPAIGN, 'running', { actor: 'owner' }), /circuit breaker/i);
  check('the lock holds while any incident is unresolved',
    campaignSafetyLockEngaged(partly) === true && Number(partly.safetyLock?.openIncidents) === 1
      && stillBlocked.threw === true,
    `open=${partly.safetyLock?.openIncidents}`);

  await resolveCampaignIncident(db, {
    incidentId: b.incidentId, actor: 'owner', remediation: 'Re-ran the compliance control and evidenced it.', now: NOW
  });
  check('clearing the last incident lifts the lock',
    campaignSafetyLockEngaged(await campaignDoc()) === false);
}

// 6. A tampered incident cannot be resolved.
{
  await reset();
  await seedCampaign();
  const trip = await tripCampaignCircuitBreaker(db, {
    campaignId: CAMPAIGN, accountId: ACCOUNT, reason: 'unauthorized_commitment',
    source: 'agent_runtime', detail: 'quoted a price', callId: 'call-x', now: NOW
  });
  await db.doc(`campaignIncidents/${trip.incidentId}`).set({ reason: 'compliance_control_failure' }, { merge: true });
  const tampered = await rejects(
    resolveCampaignIncident(db, { incidentId: trip.incidentId, actor: 'owner', remediation: 'Nothing to see here.', now: NOW }),
    /integrity/i);
  check('a rewritten incident fails its integrity check and cannot be resolved',
    tampered.threw === true, tampered.message);
  check('the campaign stays halted when resolution is refused',
    campaignSafetyLockEngaged(await campaignDoc()) === true);
}

// 7. The AI media path trips the breaker and ends the live session.
{
  await reset();
  await seedCampaign();
  await db.doc('dialerSessions/session-live').set({
    campaignId: CAMPAIGN, accountId: ACCOUNT, userUid: 'operator-1', provider: 'mock', mode: 'ai',
    concurrency: 1, status: 'active', activeCallIds: ['call-1'], connectedCallId: '',
    connectedTargetId: '', startedAt: Timestamp.fromDate(NOW), lastHeartbeatAt: Timestamp.fromDate(NOW)
  });
  await db.doc('outboundTargets/target-live').set({
    campaignId: CAMPAIGN, accountId: ACCOUNT, state: 'dialing', lockedBySessionId: 'session-live'
  });
  await db.doc('calls/call-1').set({
    campaignId: CAMPAIGN, accountId: ACCOUNT, sessionId: 'session-live', targetId: 'target-live',
    providerCallId: 'CA-prospect', operator: 'ai', status: 'in_progress',
    control: { controller: 'ai', revision: 2 }, media: { attachState: 'accepted' }
  });
  await db.doc('aiMediaJobs/call-1').set({ status: 'accepted', realtimeCallId: 'rtc-1' });

  const outcome = await failClosedAIMediaAttachment(db, 'call-1', {
    reason: 'sideband_attach_failed', source: 'reconciler', now: NOW
  });
  const campaign = await campaignDoc();
  const session = (await db.doc('dialerSessions/session-live').get()).data();
  const incidentId = incidentIdFor({
    campaignId: CAMPAIGN, reason: 'ai_media_control_failure', subjectId: 'call-1'
  });
  const incident = (await db.doc(`campaignIncidents/${incidentId}`).get()).data();

  check('losing AI media control halts the campaign, not just the call',
    outcome.ok === true && outcome.breaker?.engaged === true
      && campaign.status === 'paused' && incident?.reason === 'ai_media_control_failure',
    `breaker=${JSON.stringify(outcome.breaker?.engaged)} status=${campaign.status}`);
  check('the call still fails closed for the caller doing carrier teardown',
    outcome.shouldTerminatePstn === true && outcome.providerCallId === 'CA-prospect');
  check('the live session is safety-stopped once the pause is durable',
    session.status === 'ended' && outcome.breaker?.sessions?.stopped?.includes('session-live'),
    `session=${session.status} stopped=${JSON.stringify(outcome.breaker?.sessions?.stopped)}`);
}

// 8. Guard rails on what may trip the breaker at all.
{
  await reset();
  await seedCampaign();
  const notCritical = await tripCampaignCircuitBreaker(db, {
    campaignId: CAMPAIGN, reason: 'prospect_was_rude', source: 'test', now: NOW
  });
  const missing = await tripCampaignCircuitBreaker(db, {
    campaignId: 'campaign-does-not-exist', reason: 'ai_media_control_failure', source: 'test', now: NOW
  });
  check('only enumerated critical reasons may halt a campaign',
    notCritical.engaged === false && notCritical.skipped === 'reason_not_critical'
      && campaignSafetyLockEngaged(await campaignDoc()) === false,
    notCritical.skipped);
  check('a missing campaign is reported, not invented',
    missing.engaged === false && missing.skipped === 'campaign_missing', missing.skipped);
  check('every critical reason carries an operator-facing explanation',
    Object.values(CRITICAL_INCIDENT_REASONS).every(text => typeof text === 'string' && text.length > 20));

  const noSessions = await safetyStopCampaignSessions(db, CAMPAIGN, { now: NOW });
  check('safety-stopping a campaign with no live session is a no-op',
    noSessions.stopped.length === 0 && noSessions.failed.length === 0);
}

await reset();

const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
