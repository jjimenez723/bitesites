import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch (error) { await server.close(); throw error; }
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.hostname !== '127.0.0.1') return route.abort();
  if (url.pathname === '/__booking-check') return route.fulfill({ contentType: 'text/html', body: `
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/typography.css"></head><body style="margin:0"><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    const {default:Book}=await import('/src/pages/Book.jsx');
    const source=await(await fetch('/src/pages/Book.jsx')).text();
    const {MemoryRouter}=await import(source.match(/from "([^"]+react-router-dom[^"]*)"/)[1]);
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(Book)));
    </script></body></html>` });
  if (/^\/src\/lib\/booking(?:\.js)?$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: `
    const hosts=[{id:'jensy-jimenez',name:'Jensy Jimenez',available:true},{id:'jonathan-arroyo',name:'Jonathan Arroyo',available:true}];
    window.bookingLoads=[];window.bookingSubmissions=[];
    export async function loadBookingSlots({hostId}){
      window.bookingLoads.push(hostId);
      const start=new Date();start.setHours(15,0,0,0);
      const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(start);
      const data={hosts,hostId,hostName:hosts.find(h=>h.id===hostId).name,timezone:'America/New_York',durationMinutes:20,meetingTitle:'BiteSites strategy call',horizonEndMs:Date.now()+14*86400000,
        days:hostId==='jonathan-arroyo'?[{date,slots:[{slotId:'jonathan-slot',startMs:start.getTime()}]}]:[]};
      if(hostId==='jensy-jimenez'&&window.bookingLoads.length>1) return new Promise(resolve=>window.resolveSlowJensy=()=>resolve(data));
      return data;
    }
    export const bookingErrorMessage=(error,fallback)=>error.message||fallback;
    export async function bookConsultation(data){window.bookingSubmissions.push(data);return new Promise(resolve=>window.confirmMeeting=()=>resolve({hostId:data.hostId,hostName:'Jonathan Arroyo',confirmationRef:'BS-TEST',durationMinutes:20,meetUrl:'https://meet.google.com/test-only'}));}
  ` });
  return route.continue();
});
try {
  await page.goto(new URL('/__booking-check', base).href);
  await page.getByRole('radio', { name: 'Jensy Jimenez', exact: true }).waitFor();
  await page.getByText(/No times with Jensy Jimenez/).waitFor();
  await page.getByRole('radio', { name: 'Jonathan Arroyo', exact: true }).check();
  await page.locator('.book-time').click();
  await page.getByLabel('Name', { exact: true }).fill('Test Client');
  await page.getByLabel('Email', { exact: true }).fill('client@example.test');
  await page.getByRole('radio', { name: 'Jensy Jimenez', exact: true }).check();
  assert.equal(await page.locator('.book-form').count(), 0, 'Switching hosts clears the selected time');
  await page.waitForFunction(() => typeof window.resolveSlowJensy === 'function');
  await page.getByRole('radio', { name: 'Jonathan Arroyo', exact: true }).check();
  await page.locator('.book-time').waitFor();
  await page.evaluate(() => window.resolveSlowJensy());
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.book-time').count(), 1, 'A stale Jensy response cannot overwrite Jonathan’s times');
  await page.locator('.book-time').click();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Test Client');
  assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'client@example.test');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile picker fits viewport');
  assert.equal(await page.locator('.book-month').evaluate(element => getComputedStyle(element).position), 'static', 'Month navigation stays inside the picker');
  await page.screenshot({ path: '/tmp/bitesites-booking-hosts.png', fullPage: true });
  await page.getByRole('button', { name: 'Confirm booking', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: 'Jensy Jimenez', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.confirmMeeting());
  await page.getByRole('heading', { name: 'You’re booked', exact: true }).waitFor();
  await page.locator('.book-receipt').getByText('Jonathan Arroyo', { exact: true }).waitFor();
  const submissions = await page.evaluate(() => window.bookingSubmissions);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].hostId, 'jonathan-arroyo');
  assert.equal(submissions[0].slotId, 'jonathan-slot');
  assert.deepEqual(errors, []);
  console.log('Booking browser passed: full Jensy calendar → Jonathan, stale response protection, preserved client details, mobile layout, submission lock, and named confirmation.');
} finally { await browser.close(); await server.close(); }
