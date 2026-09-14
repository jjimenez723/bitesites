import assert from 'node:assert/strict';
import { twilioFormSignature } from './hybrid-twilio-signature.js';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required; production access forbidden.');
process.env.GCLOUD_PROJECT = 'demo-bitesites';
process.env.PUBLIC_APP_URL = 'https://example.com';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_ACCOUNT_SID = 'AC-test';
process.env.TWILIO_TWIML_APP_SID = 'AP-test';
const { initializeApp } = await import('firebase-admin/app');
initializeApp({ projectId: 'demo-bitesites' });
const { getFirestore } = await import('firebase-admin/firestore');
const { recordHybridCallEvent, twilioHybridBrowserTwiML } = await import('./hybrid-dialer-api.js');
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
  for (const collection of ['calls', 'dialerSessions', 'outboundTargets', 'outboundCampaigns', 'outboundCallEvents']) {
    for (const doc of (await db.collection(collection).get()).docs) await doc.ref.delete();
  }
  await db.doc('dialerSessions/session').set({ userUid: 'rep', status: 'active', operatingMode: 'human', provider: 'mock', accountId: 'bitesites', hybridV2: true, autoDial: { enabled: false }, activeCallIds: ['test-call'], rep: { state: 'available', activeCallId: '' } });
  await db.doc('outboundTargets/target').set({ lastCallId: 'test-call', campaignId: 'campaign', accountId: 'bitesites', state: 'dialing' });
  await db.doc('outboundCampaigns/campaign').set({ accountId: 'bitesites', provider: 'mock', status: 'paused' });
  await db.doc('calls/test-call').set({ status: 'dialing', providerCallId: 'CA-test', sessionId: 'session', targetId: 'target', campaignId: 'campaign', accountId: 'bitesites', control: { controller: 'unassigned', revision: 0 } });
  const event = body => post(recordHybridCallEvent, '/api/hybrid-outbound-events', { CallSid: 'CA-test', ...body });
  await event({ CallStatus: 'ringing' });
  assert.equal((await db.doc('calls/test-call').get()).get('status'), 'ringing');
  await event({ CallStatus: 'in-progress' });
  assert.equal((await db.doc('calls/test-call').get()).get('status'), 'open');
  await event({ AnsweredBy: 'human' });
  assert.equal((await db.doc('calls/test-call').get()).get('control.controller'), 'human');
  const twiml = await post(twilioHybridBrowserTwiML, '/api/twilio-browser-twiml', { callId: 'test-call', From: 'client:bs_rep', mode: 'human' });
  assert.match(twiml, /statusCallback="https:\/\/example.com\/api\/twilio-conference-events\?sessionId=session&amp;targetId=target"/);
  assert.match(twiml, /waitUrl=""/);
  assert.match(twiml, /muted="false"/);
  const listen = await post(twilioHybridBrowserTwiML, '/api/twilio-browser-twiml', { callId: 'test-call', From: 'client:bs_rep', mode: 'listen' });
  assert.match(listen, /muted="true"/);
  await event({ CallStatus: 'completed', AnsweredBy: 'human', CallDuration: '15' });
  assert.equal((await db.doc('calls/test-call').get()).get('status'), 'completed');
  await event({ AnsweredBy: 'machine_end_beep' });
  assert.equal((await db.doc('calls/test-call').get()).get('status'), 'completed');
  const ended = await post(twilioHybridBrowserTwiML, '/api/twilio-browser-twiml', { callId: 'test-call', From: 'client:bs_rep', mode: 'human' });
  assert.equal(ended, '<Response><Hangup/></Response>');
  console.log('Passed: signed ringing → answer → human assignment → authorized browser conference → completion; late AMD cannot reopen a call; ended calls reject audio joins.');
} finally {
  globalThis.fetch = previousFetch;
  await db.terminate();
}
