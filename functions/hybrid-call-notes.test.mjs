import assert from 'node:assert/strict';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required.');
process.env.GCLOUD_PROJECT = 'demo-bitesites';
const { initializeApp } = await import('firebase-admin/app');
initializeApp({ projectId: 'demo-bitesites' });
const { getFirestore } = await import('firebase-admin/firestore');
const { saveHybridCallNotes } = await import('./hybrid-session-api.js');
const db = getFirestore();
const save = (data, uid = 'notes-rep', role = 'outbound_rep') => saveHybridCallNotes.run({ data, auth: uid ? { uid, token: { role } } : null });
try {
  for (const uid of ['notes-rep', 'other-rep', 'outside-rep']) {
    await db.doc(`roles/${uid}`).set({ role: 'outbound_rep', accountIds: [uid === 'outside-rep' ? 'other-account' : 'bitesites'] });
  }
  await db.doc('dialerSessions/notes-session').set({ userUid: 'notes-rep', accountId: 'bitesites', status: 'active' });
  await db.doc('calls/notes-call').set({ direction: 'outbound', status: 'connected', sessionId: 'notes-session', accountId: 'bitesites', companyName: 'Test Business', phoneE164: '+15005550006', summary: 'Original outcome summary' });
  const notes = 'Spoke with Sam.\nNeeds a website refresh.\nCall Friday after 2.';
  await save({ callId: 'notes-call', notes });
  let call = (await db.doc('calls/notes-call').get()).data();
  assert.equal(call.callNotes, notes);
  assert.equal(call.notesUpdatedBy, 'notes-rep');
  assert.ok(call.notesUpdatedAt);
  assert.equal(call.summary, 'Original outcome summary');
  assert.equal(call.companyName, 'Test Business');
  assert.equal(call.phoneE164, '+15005550006');
  await db.doc('calls/notes-call').update({ status: 'completed', disposition: 'completed' });
  await db.doc('dialerSessions/notes-session').update({ status: 'ended' });
  await save({ callId: 'notes-call', notes: `${notes}\nSend examples first.` });
  call = (await db.doc('calls/notes-call').get()).data();
  assert.equal(call.status, 'completed');
  assert.match(call.callNotes, /Send examples first/);
  for (const uid of ['other-rep', 'outside-rep']) {
    await assert.rejects(save({ callId: 'notes-call', notes: 'unauthorized edit' }, uid), { code: 'permission-denied' });
  }
  await assert.rejects(save({ callId: 'notes-call', notes }, null), { code: 'unauthenticated' });
  await assert.rejects(save({ callId: 'notes-call', notes: 'x'.repeat(2001) }), { code: 'invalid-argument' });
  await assert.rejects(save({ callId: 'notes-call', notes: { forged: true } }), { code: 'invalid-argument' });
  await assert.rejects(save({ callId: 'missing-call', notes }), { code: 'not-found' });
  await db.doc('calls/notes-inbound').set({ direction: 'inbound', accountId: 'bitesites', sessionId: 'notes-session' });
  await assert.rejects(save({ callId: 'notes-inbound', notes }), { code: 'failed-precondition' });
  await save({ callId: 'notes-call', notes: '' });
  assert.equal((await db.doc('calls/notes-call').get()).get('callNotes'), '');
  console.log('Call notes passed: multiline autosave, saved identity, persistence after hangup/session end, access controls, input validation, and explicit clearing.');
} finally { await db.terminate(); }
