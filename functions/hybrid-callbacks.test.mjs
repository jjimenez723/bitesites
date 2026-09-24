import assert from 'node:assert/strict';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required.');
process.env.GCLOUD_PROJECT = 'demo-bitesites';
const { initializeApp } = await import('firebase-admin/app');
initializeApp({ projectId: 'demo-bitesites' });
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const { submitHybridDisposition } = await import('./hybrid-session-api.js');
const { applyDisposition, releaseDueTargets, startDialerSession, dialNext } = await import('./outbound-calls.js');
const { eligibleTargets, claimTarget, releaseTarget } = await import('./outbound-contacts.js');
const { evaluateCompliance } = await import('./outbound-compliance.js');
const { pendingCallback } = await import('./callback-schedule.js');
const db = getFirestore();
const NOW = new Date('2030-01-07T15:00:00Z');
const campaignId = 'history-callback-campaign';
const campaign = {
  id: campaignId, accountId: 'bitesites', name: 'History callbacks', provider: 'twilio',
  status: 'running', mode: 'power', callerId: '+15005550006', maxAttempts: 1,
  localStartTime: '09:00', localEndTime: '18:00', allowedDays: ['mon', 'tue', 'wed', 'thu', 'fri']
};
const submit = (data, uid = 'callback-rep') => submitHybridDisposition.run({
  data, auth: { uid, token: { role: 'outbound_rep' } }
});
const schedule = (at, extra = {}) => submit({ callId: 'history-callback', disposition: 'call_later', scheduleOnly: true, followUpAt: at.toISOString(), ...extra });
const targetRef = db.doc('outboundTargets/history-callback');
const callRef = db.doc('calls/history-callback');

try {
  for (const uid of ['callback-rep', 'callback-other']) await db.doc(`roles/${uid}`).set({ role: 'outbound_rep', accountIds: ['bitesites'] });
  await db.doc('dialerSessions/history-callback-session').set({ userUid: 'callback-rep', accountId: 'bitesites', status: 'ended' });
  await db.doc(`outboundCampaigns/${campaignId}`).set(campaign);
  await db.doc('leads/history-callback').set({
    name: 'History Contact', phoneE164: '+15005550141', status: 'contacted', accountId: 'bitesites'
  });
  await targetRef.set({
    accountId: 'bitesites', campaignId, contactType: 'lead', leadId: 'history-callback',
    phoneE164: '+15005550141', timezone: 'America/New_York', priority: 1,
    state: 'completed', attemptCount: 1, maxAttempts: 1,
    lastCallId: 'history-callback', lastAttemptAt: Timestamp.fromDate(NOW), nextAttemptAt: Timestamp.fromDate(NOW)
  });
  await callRef.set({
    direction: 'outbound', status: 'completed', answeredBy: 'human',
    targetId: 'history-callback', campaignId, sessionId: 'history-callback-session', accountId: 'bitesites',
    disposition: 'connected', callNotes: 'Remember these notes.', summary: 'Original summary',
    partnerOutcomes: [{ accountId: 'fine-line-group', outcome: 'introduced' }]
  });

  // Completed calls remain editable after their original session has ended.
  await submit({ callId: 'history-callback', disposition: 'interested' });
  assert.equal((await db.doc('leads/history-callback').get()).get('status'), 'interested');
  for (const weeks of [1, 2, 3]) {
    const at = new Date(NOW.getTime() + weeks * 7 * 86400000);
    await schedule(at);
    const target = (await targetRef.get()).data();
    const call = (await callRef.get()).data();
    assert.equal(target.state, 'call_later');
    assert.equal(target.attemptCount, 1);
    assert.equal(target.callback.attemptNumber, 2);
    assert.equal(target.nextAttemptAt.toMillis(), at.getTime());
    assert.equal(target.lastAttemptAt.toMillis(), NOW.getTime());
    assert.equal(call.disposition, 'interested');
    assert.equal(call.callbackAt.toMillis(), at.getTime());
    assert.equal(call.callNotes, 'Remember these notes.');
    assert.equal(call.summary, 'Original summary');
    assert.equal(call.partnerOutcomes.length, 1);
    assert.equal((await db.doc('leads/history-callback').get()).get('nextFollowUpAt').toMillis(), at.getTime());
    assert.equal((await eligibleTargets(db, campaignId, { now: new Date(at.getTime() - 1) })).length, 0);
    assert.equal((await claimTarget(db, 'history-callback', 'early-session', { now: new Date(at.getTime() - 1) })).reason, 'not_due');
  }
  const dueAt = new Date(NOW.getTime() + 21 * 86400000);
  // Late carrier completion and re-marking Interested must preserve the promise.
  await applyDisposition(db, { targetId: 'history-callback', callId: 'history-callback', disposition: 'completed', campaign, actor: 'provider', now: NOW });
  await submit({ callId: 'history-callback', disposition: 'interested' });
  let target = (await targetRef.get()).data();
  assert.equal(target.state, 'call_later');
  assert.equal(target.nextAttemptAt.toMillis(), dueAt.getTime());
  assert.equal(target.lastAttemptAt.toMillis(), NOW.getTime());
  await Promise.all([schedule(dueAt), releaseTarget(db, 'history-callback', { state: 'completed' })]);
  assert.equal((await targetRef.get()).get('state'), 'call_later');
  await releaseDueTargets(db, { now: new Date(dueAt.getTime() - 1) });
  assert.equal((await targetRef.get()).get('state'), 'call_later');
  await releaseDueTargets(db, { now: dueAt });
  target = (await targetRef.get()).data();
  assert.equal(target.state, 'ready');
  const contact = { phoneE164: target.phoneE164, location: { timezone: target.timezone } };
  const verdict = evaluateCompliance({ target, contact, campaign, now: dueAt });
  assert.equal(verdict.eligible, true, JSON.stringify(verdict));
  assert.ok(evaluateCompliance({ target, contact, campaign, now: new Date(dueAt.getTime() - 1) }).reasons.includes('callback_not_due'));
  assert.ok(evaluateCompliance({ target, contact, campaign, now: dueAt, internalDoNotCall: true }).reasons.includes('do_not_call'));
  assert.ok(evaluateCompliance({ target, contact, campaign, now: new Date('2030-01-28T23:00:00Z') }).reasons.includes('outside_calling_hours'));

  // The real queue/claim/attempt path runs against the mock provider only.
  await db.doc(`outboundCampaigns/${campaignId}`).update({ provider: 'mock' });
  const session = await startDialerSession(db, { campaignId, userUid: 'callback-rep', mode: 'power', now: dueAt });
  await db.doc(`dialerSessions/${session.sessionId}`).update({ operatingMode: 'human' });
  const dialed = await dialNext(db, session.sessionId, { now: dueAt });
  assert.equal(dialed.started.length, 1, JSON.stringify(dialed));
  target = (await targetRef.get()).data();
  assert.equal(target.attemptCount, 2);
  assert.equal(pendingCallback(target), null);
  assert.ok(evaluateCompliance({ target, contact, campaign, now: new Date(dueAt.getTime() + 86400000) }).reasons.includes('max_attempts_reached'));
  await applyDisposition(db, { targetId: 'history-callback', callId: dialed.started[0].callId, disposition: 'no_answer', campaign, now: dueAt });
  assert.equal((await targetRef.get()).get('state'), 'completed');

  await assert.rejects(schedule(new Date('2000-01-01')), { code: 'invalid-argument' });
  await assert.rejects(submit({ callId: 'history-callback', disposition: 'interested', scheduleOnly: true }), { code: 'invalid-argument' });
  await assert.rejects(submit({ callId: 'history-callback', disposition: 'interested' }, 'callback-other'), { code: 'permission-denied' });
  await db.doc('leads/history-callback').update({ doNotCall: true });
  await assert.rejects(schedule(new Date('2030-02-04T15:00:00Z')), { code: 'failed-precondition' });
  assert.equal((await targetRef.get()).get('state'), 'completed');
  // Even a late completion from an older deployed caller cannot undo an opt-out.
  await targetRef.update({ state: 'do_not_call', callback: { sourceCallId: 'history-callback', attemptNumber: 3, scheduledFor: Timestamp.fromDate(dueAt) } });
  await releaseTarget(db, 'history-callback', { state: 'completed' });
  assert.equal((await targetRef.get()).get('state'), 'do_not_call');
  assert.equal((await targetRef.get()).get('callback'), undefined);
  console.log('History callbacks passed: ended-session Interested, 1/2/3-week scheduling, rescheduling, notes preservation, no early calls, late/concurrent completion, one due mock call, consumed allowance, calling hours, DNC and ownership.');
} finally { await db.terminate(); }
