import assert from 'node:assert/strict';
import { twilioFormSignature } from './hybrid-twilio-signature.js';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required; production access forbidden.');
process.env.GCLOUD_PROJECT = 'demo-hybrid-pickup';
process.env.PUBLIC_APP_URL = 'https://example.com';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_ACCOUNT_SID = 'AC-test';
process.env.TWILIO_TWIML_APP_SID = 'AP-test';
const { initializeApp } = await import('firebase-admin/app');
initializeApp({ projectId: 'demo-hybrid-pickup' });
const { getFirestore } = await import('firebase-admin/firestore');
const { recordHybridCallEvent, twilioHybridBrowserTwiML, twilioHybridProspectTwiML, twilioHybridConferenceEvent } = await import('./hybrid-dialer-api.js');
const { prospectConferenceTwiml } = await import('./hybrid-conference.js');
const { initializeHybridCalls } = await import('./hybrid-capacity.js');
const db = getFirestore();
const previousFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Live provider access forbidden in webhook test'); };
async function post(handler, path, body, query = {}) {
  let code, result;
  const res = { set() { return res; }, status(value) { code = value; return res; }, type() { return res; }, json(value) { result = value; return res; }, send(value) { result = value; return res; } };
  const signature = twilioFormSignature(`https://example.com${path}`, body, 'test-auth-token');
  await handler({ method: 'POST', body, query, originalUrl: path, get: name => name === 'x-twilio-signature' ? signature : 'example.com' }, res);
  assert.equal(code, 200, JSON.stringify(result));
  return result;
}
try {
  for (const collection of ['roles', 'calls', 'dialerSessions', 'outboundTargets', 'outboundCampaigns', 'outboundCallEvents']) {
    for (const doc of (await db.collection(collection).get()).docs) await doc.ref.delete();
  }
  await db.doc('roles/rep').set({role:'outbound_rep',accountIds:['bitesites'],trainingExemptAccountIds:['bitesites']});
  await db.doc('dialerSessions/session').set({ userUid: 'rep', status: 'active', operatingMode: 'human', concurrency: 1, provider: 'mock', accountId: 'bitesites', hybridV2: true, autoDial: { enabled: false }, activeCallIds: ['test-call'], rep: { state: 'available', activeCallId: '' } });
  await db.doc('outboundTargets/target').set({ lastCallId: 'test-call', campaignId: 'campaign', accountId: 'bitesites', state: 'dialing' });
  await db.doc('outboundCampaigns/campaign').set({ accountId: 'bitesites', provider: 'mock', status: 'paused', allowedRepUids:['rep'] });
  await db.doc('calls/test-call').set({ hybridV2:true, direction:'outbound', status: 'dialing', agent: 'human', providerCallId: 'CA-test', sessionId: 'session', targetId: 'target', campaignId: 'campaign', accountId: 'bitesites', control: { controller: 'unassigned', revision: 0 } });
  const event = body => post(recordHybridCallEvent, '/api/hybrid-outbound-events', { CallSid: 'CA-test', ...body });
  await event({ CallStatus: 'ringing' });
  assert.equal((await db.doc('calls/test-call').get()).get('status'), 'ringing');
  // Browser conference can be prepared during ringing, before any AMD result.
  const twiml = await post(twilioHybridBrowserTwiML, '/api/twilio-browser-twiml', { callId: 'test-call', From: 'client:bs_rep', mode: 'human' });
  assert.match(twiml, /statusCallback="https:\/\/example.com\/api\/twilio-conference-events\?sessionId=session&amp;targetId=target"/);
  assert.match(twiml, /waitUrl=""/);
  assert.match(twiml, /muted="false"/);
  const inline = prospectConferenceTwiml({ sessionId: 'session', targetId: 'target', publicUrl: 'https://example.com' });
  assert.equal(inline.match(/>(bs_[a-f0-9]+)<\/Conference>/)[1], twiml.match(/>(bs_[a-f0-9]+)<\/Conference>/)[1], 'Browser and inline prospect must enter the same room');
  // Inline calls bypass the prospect TwiML endpoint entirely. Conference
  // events still persist all metadata needed for subsequent call control.
  const conferencePath = '/api/twilio-conference-events?sessionId=session&targetId=target';
  const conferenceQuery = { sessionId: 'session', targetId: 'target' };
  await Promise.all([
    post(twilioHybridConferenceEvent, conferencePath, { ConferenceSid: 'CF-prepared', CallSid: 'CA-browser', ParticipantLabel: 'human-rep', StatusCallbackEvent: 'participant-join' }, conferenceQuery),
    post(twilioHybridConferenceEvent, conferencePath, { ConferenceSid: 'CF-prepared', CallSid: 'CA-test', ParticipantLabel: 'prospect', StatusCallbackEvent: 'participant-join' }, conferenceQuery)
  ]);
  const joined = await db.doc('calls/test-call').get();
  assert.equal(joined.get('media.prospectParticipantSid'), 'CA-test');
  assert.equal(joined.get('media.humanParticipantSid'), 'CA-browser');
  assert.equal(joined.get('media.conferenceSid'), 'CF-prepared');
  const fallback = await post(twilioHybridProspectTwiML, '/api/twilio-prospect-twiml?sessionId=session&targetId=target', { CallSid: 'CA-test' }, conferenceQuery);
  assert.equal(fallback, inline, 'Already queued URL-based calls must keep identical conference behavior');
  await event({ CallStatus: 'in-progress' });
  let answered = await db.doc('calls/test-call').get();
  assert.equal(answered.get('status'), 'connected');
  assert.equal(answered.get('control.controller'), 'human');
  assert.equal(answered.get('answeredBy'), 'unknown', 'Carrier pickup must not invent a verified person');
  const pickedUpAt = answered.get('answeredAt').toMillis();
  const assignedAt = answered.get('connectedAt').toMillis();
  assert.equal((await db.doc('dialerSessions/session').get()).get('rep.activeCallId'), 'test-call');
  // An immediate pickup/browser join can beat the dialer's post-dial setup.
  await db.doc('calls/test-call').set({ media: { conferenceSid: 'CF-prepared', humanParticipantSid: 'CA-browser' } }, { merge: true });
  await initializeHybridCalls(db, { id: 'session', operatingMode: 'human', campaignId: 'campaign' }, [{ callId: 'test-call', targetId: 'target' }], 'rep');
  answered = await db.doc('calls/test-call').get();
  assert.equal(answered.get('control.controller'), 'human', 'Initialization cannot erase an immediate pickup');
  assert.equal(answered.get('humanHandled'), true);
  assert.equal(answered.get('media.conferenceSid'), 'CF-prepared');
  assert.equal(answered.get('media.humanParticipantSid'), 'CA-browser');
  assert.equal(Object.hasOwn(answered.get('agent'), '0'), false, 'Legacy string agent is replaced by structured metadata');
  await event({ AnsweredBy: 'human' });
  answered = await db.doc('calls/test-call').get();
  assert.equal(answered.get('answeredBy'), 'human');
  assert.equal(answered.get('control.revision'), 1, 'Late AMD must not assign the rep again');
  assert.equal(answered.get('answeredAt').toMillis(), pickedUpAt);
  assert.equal(answered.get('connectedAt').toMillis(), assignedAt);
  await event({ AnsweredBy: 'machine_end_beep' });
  answered = await db.doc('calls/test-call').get();
  assert.equal(answered.get('answeredBy'), 'machine');
  assert.equal(answered.get('control.controller'), 'human', 'Late AMD must not take audio away from a rep');
  assert.equal(answered.get('status'), 'connected');
  const listen = await post(twilioHybridBrowserTwiML, '/api/twilio-browser-twiml', { callId: 'test-call', From: 'client:bs_rep', mode: 'listen' });
  assert.match(listen, /muted="true"/);
  await event({ CallStatus: 'completed', AnsweredBy: 'human', CallDuration: '15' });
  assert.equal((await db.doc('calls/test-call').get()).get('status'), 'completed');
  assert.equal((await db.doc('dialerSessions/session').get()).get('wrapUpPendingCallId'), 'test-call', 'Direct pickup retains required disposition before next call');
  assert.equal((await db.doc('dialerSessions/session').get()).get('rep.activeCallId'), '', 'Completion frees the rep for the next call');
  await event({ AnsweredBy: 'machine_end_beep' });
  assert.equal((await db.doc('calls/test-call').get()).get('status'), 'completed');
  const ended = await post(twilioHybridBrowserTwiML, '/api/twilio-browser-twiml', { callId: 'test-call', From: 'client:bs_rep', mode: 'human' });
  assert.equal(ended, '<Response><Hangup/></Response>');

  for (const mode of ['hybrid', 'ai', 'human']) {
    const callId = `test-${mode}`;
    await db.doc(`dialerSessions/${mode}`).set({ userUid: 'rep', status: 'active', operatingMode: mode, concurrency: mode === 'human' ? 3 : 1, rep: { state: 'available', activeCallId: '' } });
    await db.doc(`calls/${callId}`).set({ status: 'ringing', providerCallId: `CA-${mode}`, sessionId: mode, accountId:'bitesites', campaignId:'campaign', control: { controller: 'unassigned', revision: 0 } });
    const result = await post(recordHybridCallEvent, '/api/hybrid-outbound-events', { CallSid: `CA-${mode}`, CallStatus: 'in-progress' });
    assert.equal(result.reason, 'awaiting_human_detection');
    assert.equal((await db.doc(`calls/${callId}`).get()).get('control.controller'), 'unassigned');
    assert.equal((await db.doc(`aiMediaJobs/${callId}`).get()).exists, false);
  }
  await post(recordHybridCallEvent, '/api/hybrid-outbound-events', { CallSid: 'CA-hybrid', AnsweredBy: 'human' });
  assert.equal((await db.doc('calls/test-hybrid').get()).get('control.controller'), 'human', 'Hybrid still routes a verified human');
  console.log('Passed: browser audio before pickup; immediate human-only assignment without AMD; late classification preserves audio/timestamps; completion and ended-call guards; hybrid/AI still require verified human detection.');
} finally {
  globalThis.fetch = previousFetch;
  await db.terminate();
}
