// Drives Admin → Billing in a real browser with the real React screen and the
// real invoice arithmetic. Only the Cloud Function calls are faked (in-page),
// so no account, email, Stripe or WordPress request is made.
//
//   node scripts/test-billing-browser.mjs
//   BILLING_SHOTS=samples node scripts/test-billing-browser.mjs   # also saves screenshots
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { buildInvoiceLines, recomputeInvoice, totalCents } from '../functions/billing-math.js';
import { CAAH_BILLING_CLIENT } from './billing-fixtures.mjs';

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require('playwright');
const shots = process.env.BILLING_SHOTS || '';

const lineItems = buildInvoiceLines(CAAH_BILLING_CLIENT, { periodLabel: 'November 2026', leadCount: null });
const seed = {
  clients: [{ id: 'caah', ...CAAH_BILLING_CLIENT }],
  invoices: [{
    id: 'caah_2026-11', clientId: 'caah', clientName: CAAH_BILLING_CLIENT.name, number: '011',
    issueDate: '2026-12-01', dueDate: '2026-12-31', periodStart: '2026-11-01', periodEnd: '2026-11-30',
    periodLabel: 'November 2026', lineItems, leadCount: null, totalCents: totalCents(lineItems), currency: 'usd',
    status: 'draft', autopay: false, payment: {}, pdfPath: '', email: {},
    leadPull: { source: 'wordpress', status: 'failed', at: '2026-12-01T11:00:00.000Z', error: 'The WordPress site rejected the lead-count secret.' }
  }]
};

// The fake billing-api module: same exports as src/admin/billing-api.js.
const fakeApi = `
const state = ${JSON.stringify(seed)};
const clone = value => JSON.parse(JSON.stringify(value));
const find = id => state.invoices.find(invoice => invoice.id === id);
window.__billingCalls = [];
const log = (name, data) => window.__billingCalls.push({ name, data });
export const listBilling = async () => { log('list'); return clone(state); };
export const saveBillingClient = async (id, client) => { log('saveClient', { id, client }); Object.assign(state.clients.find(c => c.id === id) || {}, client); return client; };
export const createInvoice = async () => { throw new Error('not used'); };
export const refreshLeadCount = async id => { log('pull', id); throw new Error('functions/unavailable: Lead count not updated: The WordPress site rejected the lead-count secret.'); };
export const updateInvoiceDraft = async (id, patch) => {
  log('update', { id, patch });
  const invoice = find(id);
  const result = await window.recompute({ ...patch, periodLabel: invoice.periodLabel });
  Object.assign(invoice, result, { issueDate: patch.issueDate, dueDate: patch.dueDate, leadPull: { ...invoice.leadPull, status: 'manual_override' } });
  return clone(invoice);
};
export const finalizeInvoice = async id => { log('finalize', id); Object.assign(find(id), { status: 'finalized' }); };
export const sendInvoice = async (id, options = {}) => {
  log('send', { id, options });
  const invoice = find(id);
  if (invoice.leadCount === null) throw new Error('functions/failed-precondition: Enter or pull the lead count before finalizing.');
  Object.assign(invoice, { status: 'sent', email: { resendId: 'email_1', sentAt: '2026-12-01T15:00:00.000Z', to: ['delivered@resend.dev'], lastEvent: 'sent', sendCount: (invoice.email.sendCount || 0) + 1 } });
};
export const markInvoicePaid = async (id, payment) => { log('paid', { id, payment }); Object.assign(find(id), { status: 'paid', payment: { method: payment.method, paidAt: payment.paidAt } }); };
export const voidInvoice = async id => { log('void', id); Object.assign(find(id), { status: 'void' }); };
export const invoicePdfUrl = async () => ({ url: URL.createObjectURL(new Blob(['%PDF-1.3'], { type: 'application/pdf' })), filename: 'BiteSites-Invoice-011.pdf' });
`;

const page = `<html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/admin/admin.css"></head><body class="bs-admin"><div class="admin-shell"><main class="admin-main" id="root"></main></div><script type="module">
  import React from '/node_modules/.vite/deps/react.js';
  import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
  import RefreshRuntime from '/@react-refresh';
  RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  const {default: Billing} = await import('/src/admin/Billing.jsx');
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Billing));
</script></body></html>`;

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
const errors = [];

async function open(viewport) {
  const tab = await browser.newPage({ viewport });
  tab.on('pageerror', error => errors.push(error.message));
  tab.on('dialog', dialog => dialog.accept());
  tab.setDefaultTimeout(10000);
  await tab.exposeFunction('recompute', input => recomputeInvoice({ ...input, leadRateCents: 7500 }));
  await tab.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname === '/__billing') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: page });
    if (url.pathname === '/src/admin/billing-api.js') return route.fulfill({ contentType: 'application/javascript', body: fakeApi });
    return route.continue();
  });
  return tab;
}

const fits = async (tab, label) => {
  if (await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`${label} scrolls sideways`);
};
const expectText = async (tab, text) => tab.getByText(text, { exact: false }).first().waitFor();

try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const tab = await open(viewport);
    await tab.goto(new URL('/__billing', base).href);
    await tab.getByRole('heading', { name: 'Billing' }).waitFor();
    await expectText(tab, '#011');
    await expectText(tab, 'Lead count needed');
    await fits(tab, `invoice list on ${name}`);
    if (shots) await tab.screenshot({ path: `${shots}/billing-list-${name}.png`, fullPage: true });

    await tab.getByRole('button', { name: 'Open' }).click();
    await tab.getByRole('dialog', { name: 'Invoice #011' }).waitFor();
    await expectText(tab, 'WordPress pull failed');
    // Pull failure surfaces the server's reason and leaves the draft as it was.
    await tab.getByRole('button', { name: 'Pull from WordPress' }).click();
    await expectText(tab, 'Lead count not updated');
    // Sending without a count is refused by the server and the reason is shown.
    await tab.getByRole('button', { name: 'Approve & send' }).click();
    await expectText(tab, 'Enter or pull the lead count before finalizing.');

    await tab.getByLabel('Leads this period').fill('12');
    await expectText(tab, '12 × $75.00');
    await tab.getByRole('button', { name: 'Save draft' }).click();
    await expectText(tab, 'Invoice #011 saved.');
    await tab.locator('.billing-detail-summary strong').filter({ hasText: '$2,700.00' }).waitFor();
    if (shots) await tab.screenshot({ path: `${shots}/billing-draft-${name}.png`, fullPage: false });
    await fits(tab, `invoice detail on ${name}`);

    await tab.getByRole('button', { name: 'Approve & send' }).click();
    await expectText(tab, 'Invoice #011 sent.');
    await tab.getByRole('dialog').getByText('Sent', { exact: true }).first().waitFor();
    await tab.getByRole('button', { name: 'Resend' }).waitFor();
    await tab.getByRole('button', { name: 'Mark paid' }).click();
    await expectText(tab, 'Invoice #011 marked paid.');
    await tab.getByRole('dialog').getByText('Paid', { exact: true }).first().waitFor();
    if (await tab.getByRole('button', { name: 'Void' }).count()) throw new Error('A paid invoice still offers Void');

    const calls = await tab.evaluate(() => window.__billingCalls.map(call => call.name));
    for (const expected of ['update', 'send', 'paid']) if (!calls.includes(expected)) throw new Error(`Missing ${expected} call`);
    const update = await tab.evaluate(() => window.__billingCalls.find(call => call.name === 'update').data.patch);
    if (update.leadCount !== 12) throw new Error('The lead count was not sent to the server');

    await tab.keyboard.press('Escape');
    await tab.getByRole('button', { name: 'Clients' }).click();
    await expectText(tab, 'Clifton Ave Animal Hospital');
    await expectText(tab, '$75.00/lead · WordPress');
    await expectText(tab, '#011');
    await fits(tab, `client list on ${name}`);
    await tab.getByRole('button', { name: 'Edit' }).click();
    await tab.getByRole('dialog', { name: 'Edit Clifton Ave Animal Hospital' }).waitFor();
    if (shots) await tab.screenshot({ path: `${shots}/billing-client-${name}.png`, fullPage: false });
    await tab.close();
  }
  if (errors.length) throw new Error(`Page errors: ${errors.join(' | ')}`);
  console.log('PASS: billing admin flow on desktop and phone (list, lead count, save, send, mark paid, client edit)');
} finally {
  await browser.close();
  await server.close();
}
