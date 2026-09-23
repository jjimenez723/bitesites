import assert from 'node:assert/strict';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required.');
process.env.GCLOUD_PROJECT = 'demo-bitesites';
const { initializeApp } = await import('firebase-admin/app');
initializeApp({ projectId: 'demo-bitesites' });
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const { submitHybridDisposition } = await import('./hybrid-session-api.js');
const db = getFirestore();
const stamp = Timestamp.fromDate(new Date('2026-09-22T15:00:00Z'));
const submit = (callId, uid = 'interested-rep') => submitHybridDisposition.run({
  data: { callId, disposition: 'interested' },
  auth: { uid, token: { role: 'outbound_rep', email: `${uid}@example.test` } }
});

async function seed(id, { leadId, answered = true, phoneE164 = '+15005550101' } = {}) {
  if (!leadId) await db.doc(`prospects/${id}`).set({
    name: 'Sam Test', companyName: 'Interested Business', phoneE164,
    email: `${id}@example.test`, lifecycle: { status: 'ready' }
  });
  await db.doc(`outboundTargets/${id}`).set({
    accountId: 'bitesites', campaignId: 'interested-campaign',
    contactType: leadId ? 'lead' : 'prospect',
    ...(leadId ? { leadId } : { prospectId: id }),
    state: 'connected', attemptCount: 1, lastCallId: id
  });
  await db.doc(`calls/${id}`).set({
    direction: 'outbound', status: answered ? 'connected' : 'completed',
    answeredBy: answered ? 'human' : 'machine',
    ...(answered ? { connectedAt: stamp } : {}),
    accountId: 'bitesites', campaignId: 'interested-campaign',
    sessionId: 'interested-session', targetId: id,
    ...(leadId ? { leadId } : { prospectId: id }),
    callNotes: 'Asked for examples. Follow up next week.'
  });
}

try {
  for (const uid of ['interested-rep', 'interested-other-rep']) {
    await db.doc(`roles/${uid}`).set({ role: 'outbound_rep', accountIds: ['bitesites'] });
  }
  await db.doc('dialerSessions/interested-session').set({ userUid: 'interested-rep', accountId: 'bitesites', status: 'active' });
  await db.doc('outboundCampaigns/interested-campaign').set({ accountId: 'bitesites', status: 'running' });

  await seed('interested-new');
  const result = await submit('interested-new');
  assert.equal(result.ok, true);
  assert.equal(result.state, 'completed');
  assert.equal(result.promotion.created, true);
  const leadRef = db.doc(`leads/${result.promotion.leadId}`);
  const lead = (await leadRef.get()).data();
  assert.equal(lead.status, 'interested');
  assert.equal(lead.businessName, 'Interested Business');
  assert.equal(lead.acquisition.firstConnectedCallId, 'interested-new');
  assert.ok(lead.stageTimestamps.interested);
  assert.ok(lead.firstResponseAt);
  assert.equal(lead.appointment, undefined);
  const call = (await db.doc('calls/interested-new').get()).data();
  assert.equal(call.disposition, 'interested');
  assert.equal(call.callNotes, 'Asked for examples. Follow up next week.');
  assert.equal(call.wrapUp.status, 'completed');
  assert.equal(call.wrapUp.followUpAt, undefined);

  // Retrying uses the target's new lead reference and adds no duplicate stage event.
  await submit('interested-new');
  assert.equal((await leadRef.collection('activities').where('type', '==', 'stage_change').get()).size, 1);
  assert.equal((await db.collection('leads').where('phoneE164', '==', '+15005550101').get()).size, 1);

  const existingFields = {
    name: 'Existing Lead', email: 'existing-interested@example.test',
    phoneE164: '+15005550102', status: 'contacted', owner: 'Sales rep',
    createdAt: stamp, firstResponseAt: stamp,
    economics: { contractValue: 2000 }, stageTimestamps: { contacted: stamp }
  };
  await db.doc('leads/interested-existing').set(existingFields);
  await seed('interested-existing-call', { leadId: 'interested-existing' });
  await submit('interested-existing-call');
  let existing = (await db.doc('leads/interested-existing').get()).data();
  assert.equal(existing.status, 'interested');
  for (const key of ['email', 'owner', 'createdAt', 'firstResponseAt', 'economics']) {
    assert.deepEqual(existing[key], existingFields[key]);
  }
  assert.deepEqual(existing.stageTimestamps.contacted, stamp);

  // A prospect matching an existing lead is linked, with no second lead created.
  await db.doc('leads/interested-existing').update({ status: 'contacted' });
  await seed('interested-linked', { phoneE164: '+15005550102' });
  const linked = await submit('interested-linked');
  assert.equal(linked.promotion.leadId, 'interested-existing');
  assert.equal(linked.promotion.linked, true);
  existing = (await db.doc('leads/interested-existing').get()).data();
  assert.equal(existing.status, 'interested');
  assert.equal(existing.owner, existingFields.owner);
  assert.equal((await db.collection('leads').where('phoneE164', '==', '+15005550102').get()).size, 1);

  // An unsuccessful promotion must remain an error in the dialer.
  await seed('interested-unanswered', { answered: false, phoneE164: '+15005550103' });
  await assert.rejects(submit('interested-unanswered'), { code: 'failed-precondition' });
  assert.equal((await db.doc('calls/interested-unanswered').get()).get('disposition'), undefined);
  assert.equal((await db.collection('leads').where('phoneE164', '==', '+15005550103').get()).size, 0);
  await assert.rejects(submit('interested-new', 'interested-other-rep'), { code: 'permission-denied' });

  console.log('Interested passed: promotion without a meeting, existing lead reuse, deduplication, stage history, preserved notes/details, error reporting and operator access.');
} finally { await db.terminate(); }
