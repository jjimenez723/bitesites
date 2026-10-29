import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { twilioFormSignature } from './hybrid-twilio-signature.js';

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('A local Firestore emulator is required; production access is forbidden.');
}
const projectId = 'demo-rep-live-dialer';
process.env.GCLOUD_PROJECT = projectId;
process.env.PUBLIC_APP_URL = 'https://example.test';
process.env.TWILIO_AUTH_TOKEN = 'local-test-token';
const app = initializeApp({ projectId });
const db = getFirestore(app);
const env = await initializeTestEnvironment({ projectId, firestore: {
  host: '127.0.0.1', port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]),
  rules: readFileSync('firestore.rules', 'utf8')
} });
const { startHybridDialerSession, heartbeatHybridDialerSession } = await import('./hybrid-session-api.js');
const { getRepTrainingStatus, twilioHybridBrowserTwiML } = await import('./hybrid-dialer-api.js');
const { dialNext } = await import('./outbound-calls.js');
const { MockDialer } = await import('./providers/calling/mock-dialer.js');
const capabilities = MockDialer.capabilities;
MockDialer.capabilities = { ...capabilities, conferenceControl:true, listenOnly:true, attachAI:true, detachAI:true, hybridOrchestration:true };
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('External requests forbidden');
  return originalFetch(url, options);
};
const uid = 'exempt-test-rep';
const campaignId = 'assigned-live-list';
const invoke = (handler, data = {}, actor = uid) => handler.run({ data, auth:{uid:actor,token:{}},rawRequest:{} });
const start = () => invoke(startHybridDialerSession, {campaignId,operatingMode:'human',concurrency:1,agentProfileId:''});
const client = env.authenticatedContext(uid).firestore();
const campaignRef = doc(client, 'outboundCampaigns', campaignId);
async function browserJoin(actor=uid, signed=true) {
  const body={callId:'test-live-call',From:`client:bs_${actor}`,mode:'human'};
  const path='/api/twilio-browser-twiml';
  const signature=twilioFormSignature(`https://example.test${path}`,body,'local-test-token');
  let status,text;
  const res={status(code){status=code;return res;},type(){return res;},send(value){text=value;return res;}};
  await twilioHybridBrowserTwiML({method:'POST',body,query:{},originalUrl:path,
    get:name=>name==='x-twilio-signature'?(signed?signature:'invalid'):'example.test'},res);
  return {status,text};
}
try {
  await db.doc(`roles/${uid}`).set({ role:'outbound_rep',accountIds:['bitesites'] });
  await db.doc('roles/other-test-rep').set({role:'outbound_rep',accountIds:['bitesites']});
  await db.doc(`outboundCampaigns/${campaignId}`).set({
    name:'Assigned live list',accountId:'bitesites',provider:'mock',status:'running',
    mode:'parallel',concurrency:1,allowedRepUids:[],requireResearchApproval:false,createdAt:new Date()
  });
  await assertFails(getDoc(campaignRef));
  await assert.rejects(start(), /assign this campaign/);

  await db.doc(`roles/${uid}`).update({trainingExemptAccountIds:['bitesites']});
  await assertFails(getDoc(campaignRef));
  await assert.rejects(start(), /assign this campaign/);
  await db.doc(`outboundCampaigns/${campaignId}`).update({allowedRepUids:[uid]});
  await assertSucceeds(getDoc(campaignRef));
  const rows = await assertSucceeds(getDocs(query(collection(client,'outboundCampaigns'),
    where('accountId','in',['bitesites']),where('allowedRepUids','array-contains',uid),orderBy('createdAt','desc'),limit(200))));
  assert.equal(rows.size,1);
  await assertFails(getDocs(query(collection(client,'outboundCampaigns'),where('accountId','==','bitesites'))));
  await assertFails(getDocs(query(collection(client,'outboundCampaigns'),where('allowedRepUids','array-contains',uid))));
  for (const [key, value] of [['string',uid],['map',{[uid]:true}],['empty',[]]]) {
    await db.doc(`outboundCampaigns/malformed-${key}`).set({accountId:'bitesites',allowedRepUids:value});
    await assertFails(getDoc(doc(client,'outboundCampaigns',`malformed-${key}`)));
  }

  const status = await invoke(getRepTrainingStatus);
  assert.equal(status.accounts[0].trainingExempt,true);
  assert.equal(status.accounts[0].passed,false);
  assert.equal(status.accounts[0].defaultCampaign,null);
  assert.equal(status.accounts[0].campaignAssigned,false,'The status field refers only to a default; explicit assignments still work.');
  const session = await start();
  assert.equal(session.operatingMode,'human');
  assert.equal(session.concurrency,1);
  await assertSucceeds(getDoc(doc(client,'dialerSessions',session.sessionId)));
  await db.doc('calls/test-live-call').set({
    direction:'outbound', accountId:'bitesites',campaignId,sessionId:session.sessionId,
    status:'ringing',control:{controller:'human',repUid:uid},humanHandled:true
  });
  await assertSucceeds(getDoc(doc(client,'calls','test-live-call')));
  const joined=await browserJoin();
  assert.equal(joined.status,200);
  assert.match(joined.text, /<Conference[^>]+muted="false"/);
  assert.equal((await browserJoin('other-test-rep')).status,403);
  assert.equal((await browserJoin(uid,false)).status,401);
  await db.doc('calls/test-live-call/turns/one').set({sequence:1,text:'Test call'});
  await assertSucceeds(getDocs(query(collection(client,'calls','test-live-call','turns'),orderBy('sequence'))));
  await assertSucceeds(getDocs(query(collection(client,'calls'),where('direction','==','outbound'),
    where('accountId','==','bitesites'),where('campaignId','==',campaignId))));
  await assert.rejects(invoke(heartbeatHybridDialerSession,{sessionId:session.sessionId},'other-test-rep'),
    error=>error.code==='permission-denied');
  await invoke(heartbeatHybridDialerSession,{sessionId:session.sessionId});
  assert.ok((await db.doc(`dialerSessions/${session.sessionId}`).get()).get('lastHeartbeatAt'));
  for (const patch of [
    {direction:'inbound'}, {accountId:'stone-bellisimo'}, {campaignId:'unassigned'},
  ]) {
    await db.doc('calls/denied-call').set({direction:'outbound',accountId:'bitesites',campaignId,...patch});
    await assertFails(getDoc(doc(client,'calls','denied-call')));
  }
  await db.doc('calls/denied-call').delete();
  await db.doc(`outboundCampaigns/${campaignId}`).update({allowedRepUids:[]});
  await assertFails(getDoc(doc(client,'calls','test-live-call')));
  await assertFails(getDoc(doc(client,'dialerSessions',session.sessionId)));
  await db.doc(`outboundCampaigns/${campaignId}`).update({allowedRepUids:[uid]});
  await db.doc(`roles/${uid}`).update({trainingExemptAccountIds:[]});
  await assertFails(getDoc(doc(client,'calls','test-live-call')));
  assert.equal((await browserJoin()).status,403);
  await db.doc(`roles/${uid}`).update({trainingExemptAccountIds:['bitesites']});
  await db.doc('calls/test-live-call').delete();
  const result = await dialNext(db,session.sessionId);
  assert.equal(result.reason,'no_eligible_targets');
  assert.deepEqual(result.started,[]);

  const other = env.authenticatedContext('other-test-rep').firestore();
  await assertFails(getDoc(doc(other,'outboundCampaigns',campaignId)));
  await assertFails(updateDoc(doc(client,'roles',uid),{trainingPassedAccountIds:['bitesites']}));
  await assertFails(updateDoc(campaignRef,{allowedRepUids:[uid,'other-test-rep']}));
  await db.doc(`roles/${uid}`).update({trainingExemptAccountIds:[]});
  await assertFails(getDoc(campaignRef));
  assert.equal((await dialNext(db,session.sessionId)).reason,'rep_training_required');
  await db.doc(`roles/${uid}`).update({trainingExemptAccountIds:['bitesites'],accountIds:['stone-bellisimo']});
  await assertFails(getDoc(campaignRef));
  await assert.rejects(start(), error => error.code === 'permission-denied');
  assert.equal((await db.collection('calls').get()).size,0);
  console.log('Rep access checks passed: exempt/assigned rep session, live call/transcript/history reads, owned heartbeat, signed browser conference join; invalid signature, other rep, cross-account, unassigned, self-grant and revoked access denied. No calls placed.');
} finally {
  globalThis.fetch = originalFetch;
  MockDialer.capabilities = capabilities;
  await env.clearFirestore();
  await env.cleanup();
  await deleteApp(app);
}
