import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === '/__rep-check') return route.fulfill({ contentType: 'text/html', body: `
      <div id="root" class="bs-admin"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};
      window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
      const {default:OutboundCalls}=await import('/src/admin/OutboundCalls.jsx');
      const source=await (await fetch('/src/admin/OutboundCalls.jsx')).text();
      const {MemoryRouter}=await import(source.match(/from "([^"]+react-router-dom[^"]*)"/)[1]);
      const root=ReactDOM.createRoot(document.getElementById('root'));
      window.renderRep=(options={})=>{
        window.testOptions=options;
        root.render(React.createElement(MemoryRouter,{key:Math.random(),initialEntries:[options.path||'/admin/outbound']},
          React.createElement(OutboundCalls,{role:options.role||'outbound_rep',currentUid:'test-rep'})));
      };
      window.renderRep();
      </script>` });
    if (/\/outbound\/data(?:\.js)?$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: `
      import React from '/node_modules/.vite/deps/react.js';
      window.starts=[]; window.dials=[]; window.scopes=[];
      const campaign={id:'assigned-campaign',name:'Assigned live list',accountId:'bitesites',provider:'twilio',status:'running',counts:{ready:94}};
      const account={accountId:'bitesites',accountName:'BiteSites',trainingExempt:true,passed:false,campaignAssigned:false,defaultCampaign:null,completedScenarioIds:[],requiredScenarioCount:3,ready:true};
      export const outbound={
        config:async()=>({accountIds:['bitesites'],allAccounts:false}),
        repTrainingStatus:async()=>{
          if(window.testOptions.delay) await new Promise(resolve=>window.releaseStatus=resolve);
          if(window.testOptions.error) throw new Error('Status unavailable');
          return {accounts:window.testOptions.accounts||[account]};
        },
        getActiveHybridSession:async()=>({}),
        startHybridSession:async(campaignId,options)=>{window.starts.push({campaignId,...options});return{sessionId:'test-session'}},
        dialHybrid:async sessionId=>{window.dials.push(sessionId);return{started:['test-call']}}
      };
      export function useCampaigns(ids,all,role,uid){
        window.scopes.push({ids,all,role,uid});
        return {rows:window.testOptions.unassigned?[]:all||ids.includes('bitesites')?[campaign]:[],loading:false,refresh:()=>{}};
      }
      export const toDate=v=>v?new Date(v):null;
      export const useLiveDoc=()=>({data:null,loading:false});
      export const useLiveCalls=()=>({rows:[]});
      export const useSessionHeartbeat=()=>{};
      export function useAction(){const[busy,setBusy]=React.useState(false);const[error,setError]=React.useState('');return{busy,error,run:async fn=>{setBusy(true);try{return await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}}}
    ` });
    if (/\/outbound\/(CampaignList|LeadDiscovery|ProspectList|ProspectDetail|ImportReview|LeadQueue|DialerControls|CallLaterQueue|CallHistory|ProviderStatus|AgentProfiles|AppointmentCalendar|TransferInbox|TeamCallCoach|ConsentRegistry|EligibilityAudit)\.jsx$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'application/javascript', body: 'export default function OtherScreen(){return null}' });
    }
    if (/\/outbound\/voice-client(?:\.js)?$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: `
      const state={connected:false,callId:'',muted:false,error:''};
      export const hybridVoiceState=()=>state,subscribeHybridVoice=()=>()=>{},leaveHybridVoice=()=>{},setHybridVoiceMuted=()=>{};
      export const prepareHybridVoice=async()=>{},joinHybridCall=async()=>{};
    ` });
    if (/\/outbound\/agent-preview-client(?:\.js)?$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: `
      export const startAgentPreview=async()=>{throw new Error('Practice must never start during these checks')};
    ` });
    return route.continue();
  });

  await page.goto(new URL('/__rep-check', base).href);
  const start = page.getByRole('button', { name: 'Start dialing', exact: true });
  await start.waitFor();
  assert.equal(await start.isEnabled(), true);
  assert.equal(await page.getByRole('tab', { name: 'AI Training' }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'AI sales practice' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Advanced', exact: true }).count(), 0);
  await start.click();
  await page.waitForFunction(() => window.dials.length === 1);
  assert.deepEqual(await page.evaluate(() => window.starts[0]), {
    campaignId: 'assigned-campaign', operatingMode: 'human', concurrency: 1, agentProfileId: ''
  });

  // An old bookmark cannot put an exempt rep back into the simulator.
  await page.evaluate(() => window.renderRep({ path: '/admin/outbound?tab=training' }));
  await start.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start role-play' }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await start.scrollIntoViewIfNeeded();
  assert.equal(await start.isVisible(), true);

  // Exemption removes practice only; it must not manufacture a campaign.
  await page.evaluate(() => window.renderRep({ unassigned: true }));
  await page.getByRole('heading', { name: 'No campaigns assigned yet' }).waitFor();
  assert.equal(await start.count(), 0);

  // A slow/failed status read cannot show practice or enable calls.
  await page.evaluate(() => window.renderRep({ delay: true }));
  await page.getByRole('status').filter({ hasText: 'Checking your calling access' }).waitFor();
  assert.equal(await start.count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'AI sales practice' }).count(), 0);
  await page.evaluate(() => window.releaseStatus());
  await start.waitFor();
  await page.evaluate(() => window.renderRep({ error: true }));
  await page.getByRole('alert').waitFor();
  assert.equal(await start.count(), 0);
  await page.evaluate(() => { window.testOptions.error = false; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await start.waitFor();

  // Unexempted reps keep their onboarding gate, including mixed seller scopes.
  for (const mixed of [false, true]) {
    await page.evaluate(mixed => window.renderRep({ path: '/admin/outbound?tab=dialer', accounts: [
      ...(mixed ? [{ accountId:'bitesites',trainingExempt:true,passed:false,campaignAssigned:false }] : []),
      { accountId:mixed?'stone-bellisimo':'bitesites',accountName:'Assigned seller',trainingExempt:false,passed:false,campaignAssigned:false,completedScenarioIds:[],requiredScenarioCount:3,ready:true }
    ] }), mixed);
    await page.getByRole('heading', { name: 'AI sales practice' }).waitFor();
    assert.equal(await start.count(), 0);
    assert.equal(await page.getByRole('tab', { name: 'AI Training' }).count(), 1);
  }
  assert.deepEqual(errors, []);
  console.log('Rep browser checks passed: exemption without default, live human start, stale training link, mobile, unassigned rep, loading/error/retry, unchanged training and seller boundaries. External requests blocked.');
} finally {
  await browser?.close();
  await server.close();
}
