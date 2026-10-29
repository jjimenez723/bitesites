import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createServer } from 'vite';
import { chromium } from 'playwright';

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('Local Firestore emulator required. Production access forbidden.');
}
const projectId = 'demo-rep-audio-browser';
const port = Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]);
const env = await initializeTestEnvironment({ projectId, firestore: {
  host:'127.0.0.1', port, rules:readFileSync('firestore.rules','utf8')
} });
const app = initializeApp({ projectId });
const db = getFirestore(app);
const requests = [];
const server = await createServer({ server:{host:'127.0.0.1',port:0}, plugins:[{
  name:'local-rep-connection-fixtures', enforce:'pre',
  transform(source,id) {
    if (id.endsWith('/src/lib/firebase.js')) return `
      import {initializeApp} from 'firebase/app';
      import {getFirestore,connectFirestoreEmulator} from 'firebase/firestore';
      export const app=initializeApp({projectId:'${projectId}',apiKey:'emulator-only'});
      export const db=getFirestore(app);
      connectFirestoreEmulator(db,'127.0.0.1',${port},{mockUserToken:{sub:'rep',role:'outbound_rep',accountIds:['bitesites']}});
    `;
    if (id.endsWith('/src/admin/outbound/data.js')) return source.replace(
      "import('firebase/functions')", "Promise.resolve({getFunctions:()=>null,httpsCallable:(_,name)=>async payload=>({data:await window.invokeDialer(name,payload)})})"
    );
  }
}] });
let browser;
try {
  await db.doc('roles/rep').set({role:'outbound_rep',accountIds:['bitesites'],trainingExemptAccountIds:['bitesites']});
  await db.doc('outboundCampaigns/campaign').set({accountId:'bitesites',allowedRepUids:['rep']});
  await db.doc('dialerSessions/session').set({
    accountId:'bitesites',campaignId:'campaign',userUid:'rep',status:'active',
    operatingMode:'human',concurrency:1,activeCallIds:['test-call'],
    rep:{state:'available',activeCallId:''},autoDial:{enabled:true}
  });
  await db.doc('calls/test-call').set({
    direction:'outbound',accountId:'bitesites',campaignId:'campaign',sessionId:'session',
    status:'ringing',companyName:'Rep connection test',startedAt:new Date(),
    control:{controller:'unassigned'}
  });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  // The fixture and emulator use separate loopback ports; no public host is allowed.
  browser = await chromium.launch({headless:true,args:['--disable-features=LocalNetworkAccessChecks']});
  const page = await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
  page.setDefaultTimeout(15000);
  await page.exposeFunction('invokeDialer',async (name,payload)=>{
    requests.push({name,payload});
    if(name==='getActiveHybridDialerSession')return {};
    if(name==='startHybridDialerSession')return {sessionId:'session'};
    if(name==='dialHybridTargets')return {started:['test-call']};
    if(name==='heartbeatHybridDialerSession')return {ok:true};
    if(name==='stopHybridDialerSession')return {ok:true};
    throw new Error(`Unexpected callable ${name}`);
  });
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='127.0.0.1')return route.abort();
    if(url.pathname==='/__rep-audio')return route.fulfill({contentType:'text/html',body:`
      <div id="root"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};
      window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      const {default:QuickDial}=await import('/src/admin/outbound/QuickDial.jsx');
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(QuickDial,{
        role:'outbound_rep',campaignId:'campaign',campaigns:[{id:'campaign',name:'Assigned list',status:'running',provider:'twilio',counts:{ready:1}}]
      }));
      </script>`});
    if(/^\/src\/admin\/outbound\/voice-client(?:\.js)?$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:`
      import {createVoiceSession} from '/src/admin/outbound/voice-session.js';
      window.audioJoins=[];
      const voice=createVoiceSession({getDevice:async()=>({connect:async options=>{
        const handlers={};const call={status:()=> 'connecting',mute:()=>{},isMuted:()=>false,
          on:(event,fn)=>(handlers[event]??=[]).push(fn),
          emit:event=>(handlers[event]||[]).forEach(fn=>fn()),disconnect:()=>{}};
        window.audioJoins.push({options,call});return call;
      }})});
      export const hybridVoiceState=voice.getState,subscribeHybridVoice=voice.subscribe,
        joinHybridCall=voice.join,leaveHybridVoice=voice.leave,setHybridVoiceMuted=voice.setMuted;
      export async function prepareHybridVoice(){}
    `});
    return route.continue();
  });
  await page.goto(new URL('/__rep-audio',base).href);
  await page.getByRole('button',{name:'Start dialing',exact:true}).click();
  await page.getByText('The carrier is ringing this number.',{exact:false}).waitFor().catch(async error=>{
    console.error('Rep test screen:',await page.locator('body').innerText(),requests,errors);throw error;
  });
  assert.ok(requests.some(row=>row.name==='heartbeatHybridDialerSession'&&row.payload.sessionId==='session'));
  await db.doc('dialerSessions/session').update({rep:{state:'busy',activeCallId:'test-call'}});
  await db.doc('calls/test-call').update({status:'connected',answeredAt:new Date(),humanHandled:true,control:{controller:'human',repUid:'rep'}});
  await page.waitForFunction(()=>window.audioJoins.length===1);
  assert.equal(await page.evaluate(()=>window.audioJoins[0].options.params.callId),'test-call');
  await page.evaluate(()=>window.audioJoins[0].call.emit('accept'));
  await page.getByText('Connected — your microphone is live.',{exact:true}).waitFor();
  await db.doc('outboundCampaigns/campaign').update({allowedRepUids:[]});
  // Deliver another live update so the emulator re-evaluates the listener.
  await db.doc('calls/test-call').update({updatedAt:new Date()});
  await db.doc('dialerSessions/session').update({lastHeartbeatAt:new Date()});
  await page.getByRole('alert').filter({hasText:'Live call updates are interrupted'}).waitFor();
  await page.getByRole('button',{name:'Stop dialing',exact:true}).click();
  assert.ok(requests.some(row=>row.name==='stopHybridDialerSession'));
  assert.deepEqual(errors,[]);
  console.log('Rep browser connection passed: actual rules and live Firestore hooks, rep heartbeat endpoint, answered-call audio join, revoked-access alert and Stop control. Carrier audio simulated; no external calls.');
} finally {
  await browser?.close();
  await server.close();
  await env.clearFirestore();
  await env.cleanup();
  await deleteApp(app);
}
