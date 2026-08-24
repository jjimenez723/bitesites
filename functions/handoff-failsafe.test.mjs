// A prospect who asks for a person must never be held on a live leg forever.
// These run against the emulator because the reconciler is a real query over
// `calls`, and because the expiry has to lose cleanly to a rep who accepted
// while the sweep was in flight.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const {
  HANDOFF_ABANDON_GRACE_MS, HANDOFF_ACCEPT_TIMEOUT_MS, abandonHandoff, expireHandoff,
  isHandoffAbandoned, isHandoffExpired, markHandoffFallbackDelivered, reconcileStaleHandoffs
} = await import('./handoff-failsafe.js');
const { requestHumanHandoff } = await import('./hybrid-call-orchestration.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
};

const wipe = async collectionName => {
  const snapshot = await db.collection(collectionName).limit(500).get();
  for (const entry of snapshot.docs) await entry.ref.delete();
};
const reset = async () => {
  for (const name of ['calls', 'dialerSessions', 'callAuditEvents']) await wipe(name);
};

const NOW = new Date('2026-08-24T15:00:00.000Z');
const later = ms => new Date(NOW.getTime() + ms);

const seedCall = async (id, handoff = null, extra = {}) => {
  await db.doc(`calls/${id}`).set({
    campaignId: 'campaign-1', accountId: 'bitesites', sessionId: 'session-1', targetId: 'target-1',
    providerCallId: 'CA-prospect', operator: 'ai', status: 'in_progress',
    control: { controller: 'ai', repUid: '', aiSessionId: 'rt-1', revision: 1 },
    ...(handoff ? { handoff } : {}), ...extra
  });
};
const callDoc = async id => (await db.doc(`calls/${id}`).get()).data();

console.log('\nhuman-handoff SLA');

// 1. The deadline is a fact about the call, written when the prospect asks.
await reset();
await seedCall('call-1');
{
  const requested = await requestHumanHandoff(db, 'call-1', { requestedBy: 'prospect', actorId: 'ai', now: NOW });
  const call = await callDoc('call-1');
  const deadline = call.handoff?.deadlineAt?.toMillis?.();
  check('requesting a human stamps a 30-second deadline',
    requested.ok === true && call.handoff.state === 'requested'
      && deadline === NOW.getTime() + HANDOFF_ACCEPT_TIMEOUT_MS,
    `deadline=${deadline} expected=${NOW.getTime() + HANDOFF_ACCEPT_TIMEOUT_MS}`);
  check('the clock has not run out one second early',
    isHandoffExpired(call, later(HANDOFF_ACCEPT_TIMEOUT_MS - 1000)) === false);
  check('the clock has run out at the deadline',
    isHandoffExpired(call, later(HANDOFF_ACCEPT_TIMEOUT_MS)) === true);
}

// 2. A handoff with no deadline fails closed rather than waiting forever.
check('a pending handoff with no deadline is treated as expired',
  isHandoffExpired({ handoff: { state: 'queued' } }, NOW) === true);
check('a settled handoff is never expired by the clock',
  isHandoffExpired({ handoff: { state: 'completed' } }, later(86_400_000)) === false);

// 3. Expiry tells the AI what to do, once.
{
  const expired = await expireHandoff(db, 'call-1', { source: 'test', now: later(31_000) });
  const call = await callDoc('call-1');
  const audits = await db.collection('callAuditEvents').where('type', '==', 'handoff_expired').get();
  check('expiry records the fallback directive and stays AI-controlled',
    expired.ok === true && expired.idempotent === false
      && call.handoff.state === 'expired' && call.handoff.fallback === 'callback_offered'
      && /callback/i.test(call.handoff.fallbackDirective)
      && call.control.controller === 'ai' && call.status === 'in_progress',
    `state=${call.handoff.state} controller=${call.control.controller}`);
  check('expiry is audited exactly once with the wait it measured',
    audits.size === 1 && audits.docs[0].get('metadata').waitedMs === 31_000,
    `audits=${audits.size}`);

  const again = await expireHandoff(db, 'call-1', { source: 'test', now: later(45_000) });
  const afterAudits = await db.collection('callAuditEvents').where('type', '==', 'handoff_expired').get();
  check('expiring twice is idempotent and does not re-audit',
    again.ok === true && again.idempotent === true && afterAudits.size === 1);
}

// 4. A rep who got there first wins the race.
{
  await reset();
  await seedCall('call-2', {
    state: 'announcing', requestedBy: 'prospect',
    requestedAt: Timestamp.fromDate(NOW), deadlineAt: Timestamp.fromDate(later(30_000))
  });
  const outcome = await expireHandoff(db, 'call-2', { source: 'test', now: later(60_000) });
  const call = await callDoc('call-2');
  check('a rep who accepted mid-sweep keeps the handoff',
    outcome.ok === true && outcome.idempotent === true && call.handoff.state === 'announcing',
    `state=${call.handoff.state}`);
}

// 5. The sweep expires the overdue and leaves the rest alone.
{
  await reset();
  await seedCall('overdue', {
    state: 'queued', requestedAt: Timestamp.fromDate(NOW), deadlineAt: Timestamp.fromDate(later(30_000))
  });
  await seedCall('waiting', {
    state: 'requested', requestedAt: Timestamp.fromDate(NOW), deadlineAt: Timestamp.fromDate(later(120_000))
  });
  await seedCall('settled', {
    state: 'completed', requestedAt: Timestamp.fromDate(NOW), deadlineAt: Timestamp.fromDate(later(30_000))
  });

  const sweep = await reconcileStaleHandoffs(db, { now: later(45_000) });
  check('the sweep expires only the handoff whose deadline passed',
    sweep.expired.length === 1 && sweep.expired[0] === 'overdue'
      && (await callDoc('waiting')).handoff.state === 'requested'
      && (await callDoc('settled')).handoff.state === 'completed',
    JSON.stringify(sweep.expired));
}

// 6. If the AI never makes the offer, the call is ended rather than left open.
{
  const abandonAt = later(45_000 + HANDOFF_ABANDON_GRACE_MS + 1000);
  const beforeGrace = await reconcileStaleHandoffs(db, { now: later(50_000) });
  check('an expired handoff inside the grace window is left for the AI to close',
    beforeGrace.abandoned.length === 0 && (await callDoc('overdue')).status === 'in_progress');

  const sweep = await reconcileStaleHandoffs(db, { now: abandonAt });
  const call = await callDoc('overdue');
  check('an abandoned handoff ends the call and reports the carrier leg',
    sweep.abandoned.length === 1 && sweep.abandoned[0].providerCallId === 'CA-prospect'
      && call.status === 'completed' && call.handoff.state === 'abandoned'
      && call.safeTerminalDisposition === 'handoff_abandoned'
      && call.control.controller === 'none',
    `status=${call.status} state=${call.handoff.state}`);
}

// 7. An AI that did make the offer is left alone.
{
  await reset();
  await seedCall('offered', {
    state: 'expired', requestedAt: Timestamp.fromDate(NOW),
    deadlineAt: Timestamp.fromDate(later(30_000)), expiredAt: Timestamp.fromDate(later(31_000)),
    fallbackDelivered: false
  });
  await markHandoffFallbackDelivered(db, 'offered', { now: later(35_000) });
  const call = await callDoc('offered');
  const sweep = await reconcileStaleHandoffs(db, { now: later(200_000) });
  check('recording the offer stops the abandon sweep',
    isHandoffAbandoned(call, later(200_000)) === false
      && sweep.abandoned.length === 0
      && (await callDoc('offered')).status === 'in_progress',
    JSON.stringify(sweep.abandoned));
}

// 8. Abandoning something that is not expired is refused.
{
  await reset();
  await seedCall('active', {
    state: 'requested', requestedAt: Timestamp.fromDate(NOW), deadlineAt: Timestamp.fromDate(later(30_000))
  });
  const outcome = await abandonHandoff(db, 'active', { now: later(10_000) });
  check('a handoff that has not expired cannot be abandoned',
    outcome.ok === false && outcome.reason === 'handoff_not_expired'
      && (await callDoc('active')).status === 'in_progress',
    outcome.reason);
}

await reset();

const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
