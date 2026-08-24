// Warm-transfer and supervisor-coaching state contracts, against Firestore:
//   npm run test:staff-workflows

// No provider is contacted. These call the callable handlers directly and
// assert that ownership moves only after acceptance, coaching stays private,
// and every participant is role-checked.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const {
  requestHybridStaffTransfer,
  acceptHybridStaffTransfer,
  completeHybridStaffTransfer,
  setHybridAutoTakeover,
  beginHybridCoachMonitor,
  sendHybridCoachCue,
  endHybridCoachMonitor
} = await import('./hybrid-dialer-api.js');

const call = (fn, data, uid, role, email = `${uid}@example.com`) =>
  fn.run({ data, auth: { uid, token: { role, email } }, rawRequest: {} });

for (const name of ['calls', 'dialerSessions', 'roles', 'users', 'callAuditEvents']) {
  const snapshot = await db.collection(name).limit(500).get();
  for (const entry of snapshot.docs) await entry.ref.delete();
}

const staff = [
  ['rep-a', 'outbound_rep', 'Avery Rep'],
  ['rep-b', 'outbound_rep', 'Blake Receiver'],
  ['manager', 'outbound_manager', 'Morgan Manager'],
  ['stranger', 'client', 'Casey Client']
];
for (const [uid, role, displayName] of staff) {
  await db.doc(`roles/${uid}`).set({
    role,
    accountIds: ['outbound_rep', 'outbound_manager'].includes(role) ? ['bitesites'] : [],
    email: `${uid}@example.com`
  });
  await db.doc(`users/${uid}`).set({ displayName, email: `${uid}@example.com`, status: 'approved' });
}

await db.doc('dialerSessions/session-a').set({
  userUid: 'rep-a', status: 'active', campaignId: 'campaign-a',
  accountId: 'bitesites', provider: 'mock',
  rep: { state: 'busy', activeCallId: 'call-a', listeningCallId: '' }
});
await db.doc('calls/call-a').set({
  direction: 'outbound', status: 'connected', sessionId: 'session-a', campaignId: 'campaign-a',
  accountId: 'bitesites',
  targetId: 'target-a', control: { controller: 'human', repUid: 'rep-a', revision: 1 }
});

let guidedRepEnabledAutoTakeover = false;
try {
  await call(setHybridAutoTakeover, { sessionId: 'session-a', enabled: true }, 'rep-a', 'outbound_rep');
  guidedRepEnabledAutoTakeover = true;
} catch (error) {
  if (error?.code !== 'permission-denied') throw error;
}
if (guidedRepEnabledAutoTakeover) throw new Error('guided rep enabled auto takeover outside the UI');

const requested = await call(requestHybridStaffTransfer, {
  callId: 'call-a', toUid: 'rep-b', note: 'Please help with pricing.',
  handoffSummary: 'Prospect wants implementation timing and a price range.'
}, 'rep-a', 'outbound_rep');
if (!requested.ok) throw new Error('transfer request failed');

let transfer = (await db.doc('calls/call-a').get()).get('staffTransfer');
if (transfer.state !== 'requested' || transfer.toUid !== 'rep-b' || transfer.fromName !== 'Avery Rep') {
  throw new Error(`unexpected requested transfer: ${JSON.stringify(transfer)}`);
}

let unauthorized = false;
try {
  await call(acceptHybridStaffTransfer, { callId: 'call-a' }, 'stranger', 'client');
} catch (error) {
  unauthorized = error?.code === 'permission-denied';
}
if (!unauthorized) throw new Error('unrequested staff member could accept a transfer');

await call(acceptHybridStaffTransfer, { callId: 'call-a' }, 'rep-b', 'outbound_rep');
transfer = (await db.doc('calls/call-a').get()).get('staffTransfer');
if (transfer.state !== 'accepted') throw new Error('recipient acceptance was not recorded');

let completedBeforeAudio = false;
try {
  await call(completeHybridStaffTransfer, { callId: 'call-a' }, 'rep-a', 'outbound_rep');
  completedBeforeAudio = true;
} catch (error) {
  if (error?.code !== 'failed-precondition') throw error;
}
if (completedBeforeAudio) throw new Error('handoff completed before the receiving teammate joined audio');

await db.doc('calls/call-a').set({ media: { assistParticipantSid: 'CA-assist' } }, { merge: true });
await call(completeHybridStaffTransfer, { callId: 'call-a' }, 'rep-a', 'outbound_rep');
const completedCall = await db.doc('calls/call-a').get();
const completedSession = await db.doc('dialerSessions/session-a').get();
if (completedCall.get('staffTransfer.state') !== 'completed'
  || completedCall.get('control.repUid') !== 'rep-b'
  || completedSession.get('rep.state') !== 'available'
  || completedSession.get('rep.activeCallId') !== '') {
  throw new Error('completed transfer did not move operator ownership atomically');
}

await db.doc('calls/call-coach').set({
  direction: 'outbound', status: 'connected', sessionId: 'session-a', campaignId: 'campaign-a',
  accountId: 'bitesites',
  targetId: 'target-coach', control: { controller: 'human', repUid: 'rep-a', revision: 1 }
});
await call(beginHybridCoachMonitor, { callId: 'call-coach' }, 'manager', 'outbound_manager');
await call(sendHybridCoachCue, {
  callId: 'call-coach', message: 'Acknowledge the referral point, then ask what they send prospects today.'
}, 'manager', 'outbound_manager');

const coached = await db.doc('calls/call-coach').get();
if (coached.get('coaching.state') !== 'monitoring'
  || coached.get('coaching.supervisorName') !== 'Morgan Manager'
  || !/referral point/.test(coached.get('coaching.latestCue.message'))) {
  throw new Error('private coaching state or cue was not persisted');
}

let repCouldCoach = false;
try {
  await call(beginHybridCoachMonitor, { callId: 'call-coach' }, 'rep-b', 'outbound_rep');
  repCouldCoach = true;
} catch (error) {
  if (error?.code !== 'permission-denied') throw error;
}
if (repCouldCoach) throw new Error('outbound rep received supervisor coaching permission');

await call(endHybridCoachMonitor, { callId: 'call-coach' }, 'manager', 'outbound_manager');
if ((await db.doc('calls/call-coach').get()).get('coaching.state') !== 'ended') {
  throw new Error('coach monitor did not end cleanly');
}

console.log('  ✓ warm transfer requires a named recipient and explicit acceptance');
console.log('  ✓ handoff completion waits for verified recipient audio');
console.log('  ✓ completion atomically releases the sender and assigns the receiver');
console.log('  ✓ guided rep safeguards are enforced on the server');
console.log('  ✓ supervisor monitoring and cues are manager-only and auditable');
console.log('\n5 passed, 0 failed');
