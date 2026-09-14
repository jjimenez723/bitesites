import {createRequire} from 'node:module';
import {createServer} from 'vite';
const require=createRequire(process.cwd()+'/package.json');
const {chromium}=require('playwright');
const server=await createServer({server:{host:'127.0.0.1',port:0}});
await server.listen();
const base=server.resolvedUrls.local[0];
let browser;
try { browser=await chromium.launch({headless:true}); } catch(error) { await server.close(); throw error; }
const page=await browser.newPage();
const errors=[];
page.on('pageerror',e=>{errors.push(e.message);console.log('Browser error:',e.message)});page.setDefaultTimeout(10000);
await page.route('**/*',async route=>{
 const u=new URL(route.request().url());
 if(u.hostname!=='127.0.0.1')return route.abort();
 if(u.pathname==='/__dialer-check')return route.fulfill({contentType:'text/html',body:`<html><body><div id="root"></div><script type="module">
 import React from '/node_modules/.vite/deps/react.js';
 import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js'; const {createRoot}=ReactDOM;
 import RefreshRuntime from '/@react-refresh';
 RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
 const {default:QuickDial}=await import('/src/admin/outbound/QuickDial.jsx');
 const campaign={id:'campaign',name:'Test list',provider:'twilio',status:'running',counts:{ready:1}};
 createRoot(document.getElementById('root')).render(React.createElement(QuickDial,{campaignId:'campaign',campaigns:[campaign]}));
 </script></body></html>`});
 if(/^\/src\/admin\/outbound\/data(?:\.js)?$/.test(u.pathname))return route.fulfill({contentType:'application/javascript',body:`
 import React from '/node_modules/.vite/deps/react.js'; const {useState,useSyncExternalStore}=React;
 let snapshot={session:{status:'active',activeCallIds:['test-call'],rep:{activeCallId:''},autoDial:{enabled:true}},rows:[{id:'test-call',status:'dialing',companyName:'Test Lead',control:{controller:'unassigned'},startedAt:new Date()}]};
 const listeners=new Set();
 window.changeDialer=(patch)=>{snapshot={...snapshot,...patch};listeners.forEach(fn=>fn())};
 window.dialerSnapshot=()=>snapshot;
 const useSnapshot=()=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>snapshot);
 export const outbound={getActiveHybridSession:async()=>({}),startHybridSession:async()=>({sessionId:'session'}),dialHybrid:async()=>({started:['test-call']})};
 export const toDate=v=>v?new Date(v):null;
 export function useLiveDoc(path){const s=useSnapshot();return {data:path?s.session:null}}
 export function useLiveCalls(ids){const s=useSnapshot();return {rows:ids.length?s.rows:[]}}
 export function useSessionHeartbeat(){}
 export function useAction(){const [busy,setBusy]=useState(false);const[error,setError]=useState('');return{busy,error,run:async fn=>{setBusy(true);try{return await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}}}
 `});
 if(/^\/src\/admin\/outbound\/voice-client(?:\.js)?$/.test(u.pathname))return route.fulfill({contentType:'application/javascript',body:`
 import {createVoiceSession} from '/src/admin/outbound/voice-session.js';
 window.fakeCalls=[];
 const voice=createVoiceSession({getDevice:async()=>({connect:async()=>{
 const listeners={};const call={status:()=> 'connecting',mute:v=>{},isMuted:()=>false,on:(e,fn)=>(listeners[e]??=[]).push(fn),emit:(e,v)=>(listeners[e]||[]).forEach(fn=>fn(v)),disconnect:()=>{}};
 window.fakeCalls.push(call);return call;
 }})});
 export const hybridVoiceState=voice.getState,subscribeHybridVoice=voice.subscribe,joinHybridCall=voice.join,leaveHybridVoice=voice.leave,setHybridVoiceMuted=voice.setMuted;
 export async function prepareHybridVoice(){}
 `});
 return route.continue();
});
try{
 await page.goto(new URL('/__dialer-check',base).href);
 await page.getByRole('button',{name:'Start dialing',exact:true}).click();
 await page.getByText('Placing the call. Waiting for the carrier to confirm ringing…',{exact:true}).waitFor();
 await page.evaluate(()=>window.changeDialer({rows:[{...window.dialerSnapshot().rows[0],status:'ringing',ringingAt:new Date()}]}));
 await page.getByText('The carrier is ringing this number.',{exact:false}).waitFor();
 await page.evaluate(()=>{const s=window.dialerSnapshot();window.changeDialer({session:{...s.session,rep:{activeCallId:'test-call'}},rows:[{...s.rows[0],status:'connected',answeredAt:new Date(),control:{controller:'human'}}]})});
 await page.getByText('The lead answered. Connecting your microphone…',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.fakeCalls.length===1);
 await page.evaluate(()=>window.fakeCalls[0].emit('error',Object.assign(new Error('Microphone unavailable'),{code:31401})));
 await page.getByRole('button',{name:'Reconnect audio',exact:true}).click();
 await page.waitForFunction(()=>window.fakeCalls.length===2);
 await page.evaluate(()=>window.fakeCalls[1].emit('accept'));
 await page.getByText('Connected — your microphone is live.',{exact:true}).waitFor();
 await page.evaluate(()=>{const s=window.dialerSnapshot();window.changeDialer({rows:[{...s.rows[0],status:'completed',humanHandled:true}]})});
 await page.getByText('Call ended — say how it went',{exact:true}).waitFor();
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser passed: placing → carrier ringing → audio connecting → SDK failure → reconnect → accepted audio → ended/wrap-up. No external network calls.');
}finally{await browser.close(); await server.close()}
