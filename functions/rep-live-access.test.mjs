import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('A local Firestore emulator is required; production access is forbidden.');
}
const projectId = 'demo-rep-live-dialer';
process.env.GCLOUD_PROJECT = projectId;
const app = initializeApp({ projectId });
const db = getFirestore(app);
const env = await initializeTestEnvironment({ projectId, firestore: {
  host: '127.0.0.1', port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]),
  rules: readFileSync('firestore.rules', 'utf8')
} });
const { startHybridDialerSession } = await import('./hybrid-session-api.js');
const { getRepTrainingStatus } = await import('./hybrid-dialer-api.js');
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
  console.log('Rep access checks passed: exemption plus explicit assignment opens human session without a default; rules enforce account/assignment, self-grants fail, revocation blocks refill, other rep remains denied. No calls placed.');
} finally {
  globalThis.fetch = originalFetch;
  MockDialer.capabilities = capabilities;
  await env.clearFirestore();
  await env.cleanup();
  await deleteApp(app);
}
