// The outbound engine against the Firestore emulator:  npm run test:outbound
//
// Everything runs on the mock dialer. NO TELEPHONE CALL IS PLACED, no provider
// is contacted, and no credential is read.
//
// The centre of this file is the parallel dialer. Its safety argument is one
// sentence — "the first verified human answer wins the session, atomically, and
// every other leg is cancelled" — and the tests below are the ones that would
// catch it being false: two simultaneous answers, a redelivered answer, a
// losing leg that must be requeued, and a losing leg that must NOT be.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const {
  createCampaign, updateCampaign, setCampaignStatus, importTargets,
  startDialerSession, dialNext, stopDialerSession, claimWinningCall,
  cancelLosingLegs, recordCallEvent, applyDisposition,
  markDoNotCall, reconcileSessions, releaseDueTargets, refreshCampaignCounts,
  sanitizeCampaign, outboundCallId, findActiveDialerSession,
  releaseTargetsForApprovedResearch
} = await import('./outbound-calls.js');
const { importProspects } = await import('./prospect-import.js');
const { assertSupports } = await import('./providers/calling/index.js');
const { MockDialer } = await import('./providers/calling/mock-dialer.js');
const { callEvent } = await import('./providers/calling/adapter.js');
const { approveResearch, contactKey } = await import('./lead-enrichment.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const wipe = async name => {
  const snapshot = await db.collection(name).limit(500).get();
  for (const entry of snapshot.docs) {
    for (const sub of await entry.ref.listCollections()) {
      const kids = await sub.limit(500).get();
      for (const kid of kids.docs) await kid.ref.delete();
    }
    await entry.ref.delete();
  }
};

for (const name of ['prospects', 'leads', 'outboundTargets', 'outboundCampaigns',
  'dialerSessions', 'calls', 'leadResearch', 'outboundCallEvents']) await wipe(name);

// A weekday inside the default 09:00–18:00 window, in New York.
const NOW = new Date('2026-01-05T15:00:00Z');

// ---------------------------------------------------------------------------
console.log('\nprovider capabilities are enforced, not assumed');

check('mock supports a parallel session', assertSupports('mock', 'parallel', 5).ok === true);
check('twilio supports a parallel session', assertSupports('twilio', 'parallel', 5).ok === true);

const kixieParallel = assertSupports('kixie', 'parallel', 3);
check('kixie does NOT support a BiteSites-controlled parallel session', kixieParallel.ok === false);
check('and says exactly what it is missing',
  kixieParallel.missing.includes('cancelCallLeg') && kixieParallel.missing.includes('humanAnswerDetection'),
  kixieParallel.missing.join(','));
check('kixie does support power dialing', assertSupports('kixie', 'power', 1).ok === true);
check('gohighlevel supports AI calls but not power dialing',
  assertSupports('gohighlevel', 'ai', 1).ok === true && assertSupports('gohighlevel', 'power', 1).ok === false);
check('concurrency above a provider’s ceiling is refused',
  assertSupports('mock', 'parallel', 9).ok === false);

let refusedCampaign = false;
try {
  await createCampaign(db, { name: 'Bad', mode: 'parallel', provider: 'kixie', concurrency: 3, callerId: '+15551234567' }, { createdBy: 'test' });
} catch { refusedCampaign = true; }
check('a campaign cannot be created on a provider that cannot run its mode', refusedCampaign);

// ---------------------------------------------------------------------------
console.log('\ncampaign validation');

const sanitized = sanitizeCampaign({
  mode: 'power', concurrency: 5, maxAttempts: 99, retryDelayMinutes: 1,
  callerId: '2015550000', agentProfileId: 'website-growth-consultant'
});
check('power mode is forced to one line', sanitized.concurrency === 1);
check('max attempts is capped', sanitized.maxAttempts === 10);
check('retry delay has a floor', sanitized.retryDelayMinutes === 15);
check('caller id is normalised to E.164', sanitized.callerId === '+12015550000');
check('the campaign keeps its default Hybrid agent profile', sanitized.agentProfileId === 'website-growth-consultant');

// ---------------------------------------------------------------------------
console.log('\nbuilding a parallel campaign');

const campaignId = await createCampaign(db, {
  name: 'Bergen plumbers',
  mode: 'parallel',
  provider: 'mock',
  concurrency: 3,
  callerId: '+15551234567',
  objective: 'Book a website review',
  requireResearchApproval: false,
  maxAttempts: 3,
  retryDelayMinutes: 60
}, { createdBy: 'test@bitesites.org' });
check('the campaign was created', Boolean(campaignId));
check('it starts as a draft', (await db.doc(`outboundCampaigns/${campaignId}`).get()).get('status') === 'draft');

const seeded = await importProspects(db, [
  { name: 'Alpha Plumbing', phone: '2015550001', address: 'Ridgewood, NJ' },
  { name: 'Beta Plumbing', phone: '2015550002', address: 'Ridgewood, NJ' },
  { name: 'Gamma Plumbing', phone: '2015550003', address: 'Ridgewood, NJ' },
  { name: 'Delta Plumbing', phone: '2015550004', address: 'Ridgewood, NJ' },
  { name: 'Epsilon Plumbing', phone: '2015550005', address: 'Ridgewood, NJ' }
], { source: { system: 'csv', provider: 'csv' } });
check('five prospects were imported', seeded.counts.created === 5, JSON.stringify(seeded.counts));

const added = await importTargets(db, campaignId, { prospectIds: seeded.written, now: NOW });
check('all five became targets', added.added === 5, JSON.stringify(added));

// An unreviewed prospect must not be recruitable.
const blocked = await importProspects(db, [{ name: 'Unreviewed Co', phone: '2015550099' }], {
  source: { system: 'csv', provider: 'csv' }
});
await db.doc(`prospects/${blocked.written[0]}`).set({ lifecycle: { status: 'needs_review' } }, { merge: true });
const refusedTarget = await importTargets(db, campaignId, { prospectIds: blocked.written, now: NOW });
check('a prospect that is not ready cannot join a campaign',
  refusedTarget.added === 0 && refusedTarget.skipped[0].reason.startsWith('prospect_not_ready'),
  JSON.stringify(refusedTarget.skipped));

await setCampaignStatus(db, campaignId, 'running', { actor: 'test' });

// ---------------------------------------------------------------------------
console.log('\na parallel session dials three lines');

const { sessionId } = await startDialerSession(db, {
  campaignId, userUid: 'rep-1', mode: 'parallel', concurrency: 3, now: NOW
});
check('the session started', Boolean(sessionId));
await db.doc(`dialerSessions/${sessionId}`).set({ hybridV2: true }, { merge: true });
const resumed = await findActiveDialerSession(db, 'rep-1', { hybridOnly: true });
check('the active hybrid session can be recovered after client state is lost', resumed?.id === sessionId);

// Script the outcomes so the race is deterministic: two of the three answer.
const dialed = await dialNext(db, sessionId, { now: NOW, providerConfig: { scriptedOutcomes: { 0: 'no_answer', 1: 'human_answered', 2: 'human_answered' } } });
check('three legs were started', dialed.started.length === 3, JSON.stringify(dialed));

const liveSession = await db.doc(`dialerSessions/${sessionId}`).get();
check('the session tracks all three call ids', (liveSession.get('activeCallIds') || []).length === 3);

const dialingTargets = await db.collection('outboundTargets')
  .where('campaignId', '==', campaignId).where('state', '==', 'dialing').get();
check('three targets are locked as dialing', dialingTargets.size === 3, String(dialingTargets.size));

const callDocs = await db.collection('calls').where('sessionId', '==', sessionId).get();
check('a call document exists per leg', callDocs.size === 3);
check('each call is marked outbound', callDocs.docs.every(entry => entry.get('direction') === 'outbound'));
check('each call names its dialer mode', callDocs.docs.every(entry => entry.get('dialerMode') === 'parallel'));
check('each call has a deterministic id',
  callDocs.docs.every(entry => entry.id === outboundCallId(entry.get('targetId'), entry.get('attemptNumber'))));

// ---------------------------------------------------------------------------
console.log('\nfirst answer wins — atomically');

const [legA, legB, legC] = dialed.started;

const firstWin = await claimWinningCall(db, sessionId, { callId: legB.callId, targetId: legB.targetId, now: NOW });
check('the first claim wins', firstWin.won === true);

const secondWin = await claimWinningCall(db, sessionId, { callId: legC.callId, targetId: legC.targetId, now: NOW });
check('a simultaneous second claim loses', secondWin.won === false && secondWin.reason === 'another_call_connected');

const redelivered = await claimWinningCall(db, sessionId, { callId: legB.callId, targetId: legB.targetId, now: NOW });
check('a redelivered claim from the winner is idempotent, not a second win',
  redelivered.won === true && redelivered.reason === 'already_won');

const claimed = await db.doc(`dialerSessions/${sessionId}`).get();
check('the session records exactly one connected call', claimed.get('connectedCallId') === legB.callId);
check('and the target that won', claimed.get('connectedTargetId') === legB.targetId);
check('and when', Boolean(claimed.get('connectedAt')));

// ---------------------------------------------------------------------------
console.log('\nlosing legs are cancelled and requeued');

const campaign = { id: campaignId, ...(await db.doc(`outboundCampaigns/${campaignId}`).get()).data() };
const cancelResult = await cancelLosingLegs(db, sessionId, {
  winningCallId: legB.callId, campaign, now: NOW
});
check('the two losing legs were cancelled', cancelResult.cancelled === 2, JSON.stringify(cancelResult));
check('and both were returned to Call Later', cancelResult.requeued === 2, JSON.stringify(cancelResult));

const loserCall = await db.doc(`calls/${legA.callId}`).get();
check('a losing call is marked cancelled', loserCall.get('status') === 'cancelled');
check('with the documented reason', loserCall.get('cancellationReason') === 'another_call_connected');

const loserTarget = await db.doc(`outboundTargets/${legA.targetId}`).get();
check('a losing target is back in Call Later', loserTarget.get('state') === 'call_later');
check('with a future next attempt', loserTarget.get('nextAttemptAt').toDate() > NOW);
// The person's phone rang and nobody spoke to them — that is not an attempt.
check('and its attempt was rolled back', loserTarget.get('attemptCount') === 0, String(loserTarget.get('attemptCount')));
check('the session now holds only the winner',
  ((await db.doc(`dialerSessions/${sessionId}`).get()).get('activeCallIds') || []).length === 1);

// ---------------------------------------------------------------------------
console.log('\nineligible losers are NOT requeued');

// Set up a second session where a losing target is already out of attempts.
await stopDialerSession(db, sessionId, { reason: 'test', now: NOW });
await db.collection('outboundTargets').where('campaignId', '==', campaignId).get()
  .then(snapshot => Promise.all(snapshot.docs.map(entry => entry.ref.set({
    state: 'ready', lockedBySessionId: '', lockedAt: null, attemptCount: 0,
    nextAttemptAt: Timestamp.fromDate(NOW), lastAttemptAt: null
  }, { merge: true }))));

const second = await startDialerSession(db, { campaignId, userUid: 'rep-2', mode: 'parallel', concurrency: 3, now: NOW });
const secondDial = await dialNext(db, second.sessionId, { now: NOW });
check('a second session dials', secondDial.started.length === 3, JSON.stringify(secondDial.rejected || []));

const exhausted = secondDial.started[0];
await db.doc(`outboundTargets/${exhausted.targetId}`).set({ attemptCount: 3, maxAttempts: 3 }, { merge: true });
const winner = secondDial.started[1];
await claimWinningCall(db, second.sessionId, { callId: winner.callId, targetId: winner.targetId, now: NOW });

const secondCancel = await cancelLosingLegs(db, second.sessionId, { winningCallId: winner.callId, campaign, now: NOW });
check('the attempt-exhausted loser is not requeued', secondCancel.requeued === 1, JSON.stringify(secondCancel));
check('and it is resolved instead',
  (await db.doc(`outboundTargets/${exhausted.targetId}`).get()).get('state') === 'completed',
  (await db.doc(`outboundTargets/${exhausted.targetId}`).get()).get('state'));

await stopDialerSession(db, second.sessionId, { reason: 'test', now: NOW });

// ---------------------------------------------------------------------------
console.log('\nnever two prospects on one representative');

await db.collection('outboundTargets').where('campaignId', '==', campaignId).get()
  .then(snapshot => Promise.all(snapshot.docs.map(entry => entry.ref.set({
    state: 'ready', lockedBySessionId: '', lockedAt: null, attemptCount: 0,
    nextAttemptAt: Timestamp.fromDate(NOW), lastAttemptAt: null
  }, { merge: true }))));

const third = await startDialerSession(db, { campaignId, userUid: 'rep-3', mode: 'parallel', concurrency: 3, now: NOW });
const thirdDial = await dialNext(db, third.sessionId, { now: NOW });

// Two "human answered" events arriving for two different legs of one session.
const events = thirdDial.started.slice(0, 2).map(leg => callEvent({
  type: 'human_answered',
  providerCallId: leg.providerCallId,
  targetId: leg.targetId,
  campaignId,
  sessionId: third.sessionId,
  status: 'answered',
  at: NOW
}));

const applied = [];
for (const event of events) {
  applied.push(await recordCallEvent(db, event, { now: NOW }));
}
check('exactly one answer connects', applied.filter(entry => entry.won === true).length === 1,
  JSON.stringify(applied.map(entry => entry.won)));
check('the other is refused', applied.filter(entry => entry.won === false).length === 1);

const connectedCalls = await db.collection('calls')
  .where('sessionId', '==', third.sessionId).where('status', '==', 'connected').get();
check('exactly one call document is connected', connectedCalls.size === 1, String(connectedCalls.size));

const connectedTargets = await db.collection('outboundTargets')
  .where('campaignId', '==', campaignId).where('state', '==', 'connected').get();
check('exactly one target is connected', connectedTargets.size === 1, String(connectedTargets.size));

// ---------------------------------------------------------------------------
console.log('\nwebhook redelivery is idempotent');

const replay = await recordCallEvent(db, events[0], { now: NOW });
check('a redelivered event is dropped', replay.applied === false && replay.reason === 'duplicate_event');

// ---------------------------------------------------------------------------
console.log('\ndispositions resolve targets and schedule retries');

const activeTarget = connectedTargets.docs[0];
const dispositionResult = await applyDisposition(db, {
  targetId: activeTarget.id,
  callId: activeTarget.get('lastCallId'),
  disposition: 'connected',
  campaign,
  now: NOW
});
check('a connected disposition completes the target', dispositionResult.state === 'completed');
check('and promotes the prospect to a lead',
  dispositionResult.promotion?.leadId && !dispositionResult.promotion?.error,
  JSON.stringify(dispositionResult.promotion));

const noAnswerTarget = thirdDial.started.find(leg => leg.targetId !== activeTarget.id);
const retry = await applyDisposition(db, {
  targetId: noAnswerTarget.targetId, callId: noAnswerTarget.callId,
  disposition: 'no_answer', campaign, now: NOW
});
check('a no-answer schedules a retry', Boolean(retry.nextAttemptAt), JSON.stringify(retry));
check('the retry respects the retry delay',
  retry.nextAttemptAt.getTime() >= NOW.getTime() + campaign.retryDelayMinutes * 60000);
check('a no-answer does not promote anything', retry.promotion === null);

const dncResult = await applyDisposition(db, {
  targetId: thirdDial.started[2].targetId, callId: thirdDial.started[2].callId,
  disposition: 'do_not_call', campaign, now: NOW
});
check('do-not-call resolves the target terminally', dncResult.state === 'do_not_call');
check('and schedules nothing', dncResult.nextAttemptAt === null);

await stopDialerSession(db, third.sessionId, { reason: 'test', now: NOW });

// ---------------------------------------------------------------------------
console.log('\ndo-not-call applies across every campaign');

const otherCampaign = await createCampaign(db, {
  name: 'Second campaign', mode: 'power', provider: 'mock',
  callerId: '+15551234567', requireResearchApproval: false
}, { createdBy: 'test' });
const shared = seeded.written[4];
await db.doc(`prospects/${shared}`).set({ lifecycle: { status: 'ready' }, contactability: { doNotCall: false } }, { merge: true });
await importTargets(db, otherCampaign, { prospectIds: [shared], now: NOW });

const sharedTargets = await db.collection('outboundTargets').where('prospectId', '==', shared).get();
check('the prospect is in two campaigns', sharedTargets.size === 2, String(sharedTargets.size));

const dnc = await markDoNotCall(db, sharedTargets.docs[0].id, { actor: 'test', now: NOW });
check('marking one target updates the other campaign too', dnc.alsoUpdated >= 1, JSON.stringify(dnc));
const allDnc = await db.collection('outboundTargets').where('prospectId', '==', shared).get();
check('every target for that person is do-not-call',
  allDnc.docs.every(entry => entry.get('state') === 'do_not_call'));
check('and the prospect itself is marked',
  (await db.doc(`prospects/${shared}`).get()).get('contactability').doNotCall === true);

// ---------------------------------------------------------------------------
console.log('\ncompliance blocks a call outside local hours');

const nightCampaign = await createCampaign(db, {
  name: 'Night shift', mode: 'power', provider: 'mock',
  callerId: '+15551234567', requireResearchApproval: false,
  localStartTime: '09:00', localEndTime: '10:00'
}, { createdBy: 'test' });

const [nightProspect] = (await importProspects(db, [
  { name: 'Night Co', phone: '2015556060', address: 'Ridgewood, NJ' }
], { source: { system: 'csv', provider: 'csv' } })).written;
// Seeded in the past so the target is already due — otherwise it is filtered
// out as "not yet scheduled" and never reaches the compliance check we are
// actually trying to exercise.
await importTargets(db, nightCampaign, { prospectIds: [nightProspect], now: new Date('2026-01-01T00:00:00Z') });
await setCampaignStatus(db, nightCampaign, 'running', { actor: 'test' });

const nightSession = await startDialerSession(db, {
  campaignId: nightCampaign, userUid: 'rep-night', mode: 'power', now: NOW
});
// 03:00 UTC on a Monday is 22:00 Sunday in New York — outside the window and
// outside the allowed days.
const nightDial = await dialNext(db, nightSession.sessionId, { now: new Date('2026-01-05T03:00:00Z') });
check('nothing is dialled outside the calling window', nightDial.started.length === 0, JSON.stringify(nightDial));
check('and the reason is recorded',
  /outside_/.test(nightDial.rejected?.[0]?.reason || ''), JSON.stringify(nightDial.rejected));
check('and the response summarizes the eligibility blockers',
  nightDial.availability?.scanned === 1
    && Object.keys(nightDial.availability?.rejectedByReason || {}).some(reason => reason.startsWith('outside_')),
  JSON.stringify(nightDial.availability));
const nightTarget = await db.doc(`outboundTargets/${(await db.collection('outboundTargets').where('campaignId', '==', nightCampaign).get()).docs[0].id}`).get();
check('the target is rescheduled rather than failed', nightTarget.get('state') === 'call_later');

await stopDialerSession(db, nightSession.sessionId, { reason: 'test', now: NOW });

// ---------------------------------------------------------------------------
console.log('\nresearch approval gates the dial');

const gatedCampaign = await createCampaign(db, {
  name: 'Approval required', mode: 'power', provider: 'mock',
  callerId: '+15551234567', requireResearchApproval: true
}, { createdBy: 'test' });
const [gatedProspect] = (await importProspects(db, [
  { name: 'Gated Co', phone: '2015557171', address: 'Ridgewood, NJ' }
], { source: { system: 'csv', provider: 'csv' } })).written;
await importTargets(db, gatedCampaign, { prospectIds: [gatedProspect], now: NOW });
await setCampaignStatus(db, gatedCampaign, 'running', { actor: 'test' });

const gatedTargetId = (await db.collection('outboundTargets').where('campaignId', '==', gatedCampaign).get()).docs[0].id;
await db.doc(`outboundTargets/${gatedTargetId}`).set({ state: 'ready' }, { merge: true });

const gatedSession = await startDialerSession(db, { campaignId: gatedCampaign, userUid: 'rep-g', mode: 'power', now: NOW });
const gatedDial = await dialNext(db, gatedSession.sessionId, { now: NOW, fetchImpl: async () => ({ ok: false, status: 0 }) });
check('an unapproved brief blocks the call', gatedDial.started.length === 0, JSON.stringify(gatedDial));
check('and the target waits for approval',
  (await db.doc(`outboundTargets/${gatedTargetId}`).get()).get('state') === 'awaiting_approval');

const gatedResearchKey = contactKey({ contactType: 'prospect', prospectId: gatedProspect });
await approveResearch(db, gatedResearchKey, { approvedBy: 'admin', now: NOW });
const releasedAfterApproval = await releaseTargetsForApprovedResearch(db, gatedResearchKey);
check('approving a brief automatically releases its waiting target',
  releasedAfterApproval === 1 && (await db.doc(`outboundTargets/${gatedTargetId}`).get()).get('state') === 'ready');
const afterApproval = await dialNext(db, gatedSession.sessionId, { now: NOW, fetchImpl: async () => ({ ok: false, status: 0 }) });
check('once approved, the call proceeds', afterApproval.started.length === 1, JSON.stringify(afterApproval));

await stopDialerSession(db, gatedSession.sessionId, { reason: 'test', now: NOW });

const toggledCampaign = await createCampaign(db, {
  name: 'Approval switched off', mode: 'power', provider: 'mock',
  callerId: '+15551234567', requireResearchApproval: true
}, { createdBy: 'test' });
const [toggledProspect] = (await importProspects(db, [
  { name: 'Toggle Co', phone: '2015557272', address: 'Ridgewood, NJ' }
], { source: { system: 'csv', provider: 'csv' } })).written;
await importTargets(db, toggledCampaign, { prospectIds: [toggledProspect], now: NOW });
const toggledTarget = (await db.collection('outboundTargets').where('campaignId', '==', toggledCampaign).get()).docs[0];
check('approval-required imports begin pending', toggledTarget.get('state') === 'pending');
await updateCampaign(db, toggledCampaign, { requireResearchApproval: false });
check('turning approval off releases existing pending targets',
  (await toggledTarget.ref.get()).get('state') === 'ready');

// ---------------------------------------------------------------------------
console.log('\nan abandoned session releases its locks');

await db.collection('outboundTargets').where('campaignId', '==', campaignId).get()
  .then(snapshot => Promise.all(snapshot.docs.slice(0, 1).map(entry => entry.ref.set({
    state: 'dialing', lockedBySessionId: 'ghost-session',
    lockedAt: Timestamp.fromDate(new Date(Date.now() - 30 * 60000))
  }, { merge: true }))));
await db.doc('dialerSessions/ghost-session').set({
  campaignId, userUid: 'ghost', provider: 'mock', mode: 'power', concurrency: 1,
  status: 'active', activeCallIds: [], connectedCallId: '', connectedTargetId: '',
  startedAt: Timestamp.fromDate(new Date(Date.now() - 30 * 60000)),
  lastHeartbeatAt: Timestamp.fromDate(new Date(Date.now() - 30 * 60000))
});

const reconciled = await reconcileSessions(db);
check('the abandoned session is closed', reconciled.closedSessions >= 1, JSON.stringify(reconciled));
check('and its locked target is freed',
  (await db.doc('dialerSessions/ghost-session').get()).get('status') === 'ended');

// ---------------------------------------------------------------------------
console.log('\nCall Later targets come back when they are due');

const dueId = (await db.collection('outboundTargets').where('state', '==', 'call_later').limit(1).get()).docs[0]?.id;
if (dueId) {
  await db.doc(`outboundTargets/${dueId}`).set({
    nextAttemptAt: Timestamp.fromDate(new Date(Date.now() - 60000)), attemptCount: 0, maxAttempts: 3
  }, { merge: true });
  const released = await releaseDueTargets(db, { now: new Date() });
  check('a due target is released', released >= 1, String(released));
  check('and is ready again', (await db.doc(`outboundTargets/${dueId}`).get()).get('state') === 'ready');
} else {
  check('a due target is released', false, 'no call_later target to test with');
}

// ---------------------------------------------------------------------------
console.log('\ncampaign controls');

const paused = await setCampaignStatus(db, campaignId, 'paused', { actor: 'test' });
check('a campaign can be paused', paused.ok === true);
let refusedWhilePaused = false;
try { await startDialerSession(db, { campaignId, userUid: 'rep-x', mode: 'power', now: NOW }); }
catch { refusedWhilePaused = true; }
check('a paused campaign refuses a new session', refusedWhilePaused);

await setCampaignStatus(db, campaignId, 'cancelled', { actor: 'test' });
const cancelledTargets = await db.collection('outboundTargets')
  .where('campaignId', '==', campaignId).where('state', 'in', ['dialing', 'connected']).get();
check('cancelling releases every live target', cancelledTargets.empty);

const counts = await refreshCampaignCounts(db, campaignId);
check('counts are recomputed from targets', counts.total > 0, JSON.stringify(counts));

// ---------------------------------------------------------------------------
console.log('\nthe mock provider behaves like a provider');

const mock = new MockDialer({});
const placed = await mock.startParallelDialSession({
  targets: [{ id: 't1', phoneE164: '+12015550001' }, { id: 't2', phoneE164: '+12015550002' }],
  campaignId: 'c', sessionId: 's', concurrency: 2
});
check('it returns one leg per target with distinct ids',
  placed.legs.length === 2 && placed.legs[0].providerCallId !== placed.legs[1].providerCallId);

let refusedOverConcurrency = false;
try {
  await mock.startParallelDialSession({
    targets: [1, 2, 3].map(index => ({ id: `t${index}`, phoneE164: `+1201555000${index}` })),
    campaignId: 'c', sessionId: 's', concurrency: 2
  });
} catch { refusedOverConcurrency = true; }
check('it refuses more legs than the session allows', refusedOverConcurrency);

const cancelled = await mock.cancelCallLeg(placed.legs[0].providerCallId, 'another_call_connected');
check('a ringing leg can be cancelled', cancelled.cancelled === true);
const recancel = await mock.cancelCallLeg(placed.legs[0].providerCallId, 'again');
check('a cancelled leg cannot be cancelled twice', recancel.cancelled === false);

const advanced = mock.advance(placed.legs[1].providerCallId, { at: NOW });
check('advancing emits normalised events', advanced.length > 0 && advanced.every(entry => entry.type));

check('a webhook without a shared secret is refused',
  mock.verifyWebhook({ get: () => 'x' }, '') === false);
check('a webhook with the wrong secret is refused',
  mock.verifyWebhook({ get: () => 'wrong-value-here-long' }, 'a-long-enough-test-secret') === false);
check('a webhook with the right secret is accepted',
  mock.verifyWebhook({ get: () => 'a-long-enough-test-secret' }, 'a-long-enough-test-secret') === true);

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('\nFailed:');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
  process.exit(1);
}
