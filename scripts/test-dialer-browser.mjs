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
 if(u.pathname==='/__dialer-check')return route.fulfill({contentType:'text/html',body:`<html><head><link rel="stylesheet" href="/src/admin/outbound/outbound.css"></head><body class="bs-admin"><div id="root"></div><script type="module">
 import React from '/node_modules/.vite/deps/react.js';
 import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js'; const {createRoot}=ReactDOM;
 import RefreshRuntime from '/@react-refresh';
 RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
 const {default:QuickDial}=await import('/src/admin/outbound/QuickDial.jsx');
 const campaign={id:'campaign',name:'Test list',provider:'twilio',status:'running',counts:{ready:1}};
 const root=createRoot(document.getElementById('root'));
 root.render(React.createElement(QuickDial,{campaignId:'campaign',campaigns:[campaign]}));
 window.showCallHistory=async()=>{
   const {default:CallHistory}=await import('/src/admin/outbound/CallHistory.jsx');
   const source=await (await fetch('/src/admin/outbound/CallHistory.jsx')).text();
   const routerUrl=source.match(/from "([^"]+react-router-dom[^"]*)"/)[1];
   const {MemoryRouter}=await import(routerUrl);
   root.render(React.createElement(MemoryRouter,null,React.createElement(CallHistory,{campaignId:'campaign',campaigns:[campaign]})));
 };
 window.showLeads=async()=>{
   const {default:Leads}=await import('/src/admin/Leads.jsx');
   const source=await (await fetch('/src/admin/Leads.jsx')).text();
   const {MemoryRouter}=await import(source.match(/from "([^"]+react-router-dom[^"]*)"/)[1]);
   root.render(React.createElement(MemoryRouter,null,React.createElement(Leads)));
 };
 </script></body></html>`});
 if(/^\/src\/admin\/outbound\/data(?:\.js)?$/.test(u.pathname))return route.fulfill({contentType:'application/javascript',body:`
 import React from '/node_modules/.vite/deps/react.js'; const {useState,useSyncExternalStore}=React;
 let snapshot={session:{status:'active',activeCallIds:['test-call'],rep:{activeCallId:''},autoDial:{enabled:true}},rows:[{id:'test-call',status:'dialing',companyName:'Test Lead',phoneE164:'+15005550006',contactName:'Sam Test',control:{controller:'unassigned'},startedAt:new Date()}]};
 const listeners=new Set();
 window.changeDialer=(patch)=>{snapshot={...snapshot,...patch};listeners.forEach(fn=>fn())};
 window.dialerSnapshot=()=>snapshot;window.noteWrites=[];window.outcomeWrites=[];
 const useSnapshot=()=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>snapshot);
 export const outbound={saveCallNotes:async(callId,notes)=>{window.noteWrites.push({callId,notes});window.changeDialer({rows:snapshot.rows.map(row=>row.id===callId?{...row,callNotes:notes}:row)})},hybridDisposition:async(payload)=>{window.outcomeWrites.push(payload);window.changeDialer({rows:snapshot.rows.map(row=>row.id===payload.callId?{...row,disposition:payload.disposition}:row)});return {ok:true}},endHybridCall:async(callId)=>{window.changeDialer({rows:snapshot.rows.map(row=>row.id===callId?{...row,status:'completed',humanHandled:true}:row)});return {ok:true}},getActiveHybridSession:async()=>({}),startHybridSession:async()=>({sessionId:'session'}),dialHybrid:async()=>({started:['test-call']})};
 export const toDate=v=>v?new Date(v):null;
 export function useLiveDoc(path){const s=useSnapshot();return {data:path?.startsWith('calls/')?s.rows.find(row=>row.id===path.split('/')[1]):path?s.session:null}}
 export const LIST_CAP=200;
 export function useOutboundCalls(){const s=useSnapshot();return {rows:s.rows,loading:false,capped:false,refresh:()=>{}}}
 export function useLiveCalls(ids){const s=useSnapshot();return {rows:ids.length?s.rows:[]}}
 export function useSessionHeartbeat(){}
 export function useAction(){const [busy,setBusy]=useState(false);const[error,setError]=useState('');return{busy,error,run:async fn=>{setBusy(true);try{return await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}}}
 `});
 if(/^\/src\/admin\/data(?:\.js)?$/.test(u.pathname))return route.fulfill({contentType:'application/javascript',body:`
 export const toDate=v=>v?new Date(v):null;
 export const useLeads=()=>({rows:[{id:'interested-lead',name:'Interested Contact',status:'interested',source:'outbound'},{id:'new-lead',name:'New Contact',status:'new',source:'intake_form'}],loading:false,refresh:async()=>{}});
 export const setLeadStatus=async()=>{},saveLeadCommercial=async()=>{},loadLeadActivities=async()=>[];
 `});
 if(u.pathname==='/src/admin/Transcript.jsx')return route.fulfill({contentType:'application/javascript',body:'export default function Transcript(){return null}'});
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
 await page.getByRole('textbox',{name:'Call notes',exact:true}).fill('Spoke with Sam.\nInterested in a website refresh.');
 await page.getByText('Saved to call history',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.noteWrites.some(row=>row.callId==='test-call'&&row.notes.includes('website refresh')));
 await page.getByRole('textbox',{name:'Call notes',exact:true}).fill('Spoke with Sam.\nFollow up Friday.');
 await page.evaluate(()=>{const s=window.dialerSnapshot();window.changeDialer({rows:[{...s.rows[0],status:'completed',humanHandled:true}]})});
 await page.getByText('Call ended — say how it went',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.noteWrites.at(-1)?.notes==='Spoke with Sam.\nFollow up Friday.');
 if(await page.getByRole('textbox',{name:'Call notes',exact:true}).inputValue()!=='Spoke with Sam.\nFollow up Friday.')throw new Error('Notes were lost after hangup');
 await page.evaluate(()=>{const s=window.dialerSnapshot();window.changeDialer({
   session:{...s.session,activeCallIds:['test-call','interested-call'],rep:{activeCallId:'interested-call'}},
   rows:[...s.rows,{id:'interested-call',status:'connected',companyName:'Interested Business',control:{controller:'human'},startedAt:new Date()}]
 })});
 await page.locator('.quickdial-controls:not(.quickdial-pending-wrap)').getByRole('button',{name:'Interested',exact:true}).click();
 await page.waitForFunction(()=>window.outcomeWrites.some(row=>row.callId==='interested-call'&&row.disposition==='interested'&&!row.followUpAt));
 await page.waitForFunction(()=>window.dialerSnapshot().rows.find(row=>row.id==='interested-call').status==='completed');
 await page.evaluate(()=>window.showCallHistory());
 const historyRow=page.getByRole('row').filter({hasText:'Test Lead'});
 await historyRow.waitFor();
 if(!(await historyRow.innerText()).includes('(500) 555-0006'))throw new Error('History omitted the phone number');
 if(!(await historyRow.innerText()).includes('Follow up Friday.'))throw new Error('History omitted saved notes');
 await historyRow.click();
 const detail=page.getByRole('dialog',{name:'Test Lead',exact:true});
 await detail.waitFor();
 const savedNotes=await detail.getByRole('textbox',{name:'Call notes',exact:true}).inputValue();
 if(savedNotes!=='Spoke with Sam.\nFollow up Friday.')throw new Error('Full notes did not retain line breaks');
 await detail.getByRole('textbox',{name:'Call notes',exact:true}).fill(savedNotes+'\nSend examples before Friday.');
 await page.getByText('Saved to call history',{exact:true}).waitFor();
 await detail.getByRole('button',{name:'Close',exact:true}).click();
 await historyRow.click();
 if(!(await detail.getByRole('textbox',{name:'Call notes',exact:true}).inputValue()).includes('Send examples before Friday.'))throw new Error('History edits did not persist after reopening');
 await detail.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(()=>{const s=window.dialerSnapshot();window.changeDialer({rows:[...s.rows,{id:'empty-history-call',companyName:'No Notes Business',status:'completed',startedAt:new Date()}]})});
 await page.getByRole('row').filter({hasText:'No Notes Business'}).click();
 const emptyDetail=page.getByRole('dialog',{name:'No Notes Business',exact:true});
 const emptyNotes=emptyDetail.getByRole('textbox',{name:'Call notes',exact:true});
 if(await emptyNotes.inputValue()!=='')throw new Error('Another call\'s notes leaked into an empty call');
 await emptyNotes.fill('Forgot to add this during the call.');
 await emptyDetail.getByRole('button',{name:'Close',exact:true}).click();
 await page.waitForFunction(()=>window.noteWrites.some(row=>row.callId==='empty-history-call'&&row.notes==='Forgot to add this during the call.'));
 await page.getByRole('row').filter({hasText:'No Notes Business'}).click();
 if(await emptyNotes.inputValue()!=='Forgot to add this during the call.')throw new Error('Notes added to an empty history call did not persist');
 await emptyNotes.fill('');
 await page.getByText('Saved to call history',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.noteWrites.at(-1)?.callId==='empty-history-call'&&window.noteWrites.at(-1)?.notes==='');
 await page.evaluate(()=>window.showLeads());
 await page.getByRole('combobox',{name:'Lead status',exact:true}).selectOption('interested');
 await page.getByRole('row').filter({hasText:'Interested Contact'}).waitFor();
 if(await page.getByRole('row').filter({hasText:'New Contact'}).count())throw new Error('Interested category includes unrelated leads');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser passed: audio/reconnect, live Interested outcome without meeting time, autosaved notes through hangup, editable/empty history notes, reopen/clear persistence, and Interested lead filtering. No external network calls.');
}finally{await browser.close(); await server.close()}
