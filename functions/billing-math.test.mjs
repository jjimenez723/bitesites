import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, billingToday, buildInvoiceLines, finalizeBlocker, formatInvoiceNumber, formatLongDate, formatMoney,
  formatUsDate, leadLineDescription, normalizeBillingClient, periodForMonth, priorMonthPeriod, recomputeInvoice, totalCents
} from './billing-math.js';
import { CAAH_BILLING_CLIENT } from '../scripts/billing-fixtures.mjs';

test('the CAAH retainer matches the foundation invoice and adds $75 per lead', () => {
  const noLeads = buildInvoiceLines(CAAH_BILLING_CLIENT, { periodLabel: 'November 2026', leadCount: null });
  assert.deepEqual(noLeads.map(line => [line.description, line.amountCents]), [
    ['Monthly SEO Audit', 60000], ['Ad Campaign Maintenance', 60000], ['Web Maintenance', 40000],
    ['Market Research', 20000], ['Lead Generation', 0]
  ]);
  assert.equal(totalCents(noLeads), 180000, 'the foundation total is $1800 with no lead count');
  const twelve = buildInvoiceLines(CAAH_BILLING_CLIENT, { periodLabel: 'November 2026', leadCount: 12 });
  const leadLine = twelve.at(-1);
  assert.equal(leadLine.description, 'Lead Generation — 12 leads × $75.00');
  assert.equal(leadLine.quantity, 12);
  assert.equal(leadLine.unitCents, 7500);
  assert.equal(leadLine.amountCents, 90000);
  assert.equal(totalCents(twelve), 270000);
  assert.ok(twelve.every(line => line.periodLabel === 'November 2026'));
  assert.equal(leadLineDescription(1), 'Lead Generation — 1 lead × $75.00');
  assert.equal(leadLineDescription(0), 'Lead Generation — 0 leads × $75.00');
});

test('amounts are always re-derived from quantity × unit, never trusted from input', () => {
  const result = recomputeInvoice({
    lineItems: [
      { kind: 'retainer', description: 'Web Maintenance', quantity: 1, unitCents: 40000, amountCents: 1 },
      { kind: 'custom', description: 'Extra landing page', quantity: 2, unitCents: 12550 },
      { kind: 'leads', description: 'anything', unitCents: 7500, amountCents: 999999 }
    ],
    leadCount: 3,
    periodLabel: 'November 2026'
  });
  assert.deepEqual(result.lineItems.map(line => line.amountCents), [40000, 25100, 22500]);
  assert.equal(result.lineItems[2].description, 'Lead Generation — 3 leads × $75.00');
  assert.equal(result.totalCents, 87600);
  assert.throws(() => recomputeInvoice({ lineItems: [{ description: 'x', quantity: 1.5, unitCents: 1 }], leadCount: 0 }), /whole numbers/);
  assert.throws(() => recomputeInvoice({ lineItems: [{ description: 'x', unitCents: -5 }], leadCount: 0 }), /zero or more/);
  assert.throws(() => recomputeInvoice({ lineItems: [], leadCount: -1 }), /lead count/);
  assert.throws(() => recomputeInvoice({ lineItems: [{ description: '', unitCents: 5 }], leadCount: 0 }), /description/);
});

test('money, dates and numbers print the way the foundation invoice does', () => {
  assert.equal(formatMoney(60000), '$600');
  assert.equal(formatMoney(180000), '$1,800');
  assert.equal(formatMoney(7500, { cents: true }), '$75.00');
  assert.equal(formatMoney(60050), '$600.50');
  assert.equal(formatInvoiceNumber(11), '011');
  assert.equal(formatInvoiceNumber(1234), '1234');
  assert.throws(() => formatInvoiceNumber(0));
  assert.equal(formatUsDate('2026-12-01'), '12/1/2026');
  assert.equal(formatLongDate('2026-12-31'), 'December 31, 2026');
  assert.equal(addDays('2026-12-01', 30), '2026-12-31');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
});

test('billing months are computed in New York time, including across the year boundary', () => {
  assert.deepEqual(periodForMonth('2026-11'), { periodKey: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-30', periodLabel: 'November 2026' });
  assert.equal(periodForMonth('2028-02').periodEnd, '2028-02-29');
  // 06:00 on Dec 1 in New York is 11:00 UTC.
  assert.equal(priorMonthPeriod(new Date('2026-12-01T11:00:00Z')).periodKey, '2026-11');
  // 02:00 UTC on Dec 1 is still Nov 30 in New York: the prior month is October.
  assert.equal(billingToday(new Date('2026-12-01T02:00:00Z')), '2026-11-30');
  assert.equal(priorMonthPeriod(new Date('2026-12-01T02:00:00Z')).periodKey, '2026-10');
  assert.equal(priorMonthPeriod(new Date('2027-01-01T12:00:00Z')).periodKey, '2026-12');
  assert.throws(() => periodForMonth('2026-13'));
});

test('a draft cannot be finalized without a lead count when it bills leads', () => {
  const lineItems = buildInvoiceLines(CAAH_BILLING_CLIENT, { periodLabel: 'November 2026', leadCount: null });
  const draft = { status: 'draft', lineItems, leadCount: null, issueDate: '2026-12-01', dueDate: '2026-12-31' };
  assert.match(finalizeBlocker(draft, CAAH_BILLING_CLIENT), /lead count/);
  assert.equal(finalizeBlocker({ ...draft, leadCount: 0 }, CAAH_BILLING_CLIENT), '');
  assert.match(finalizeBlocker({ ...draft, status: 'sent', leadCount: 4 }, CAAH_BILLING_CLIENT), /Only a draft/);
});

test('client validation normalises input and never accepts autopay from the admin form', () => {
  const client = normalizeBillingClient({
    ...CAAH_BILLING_CLIENT,
    billingEmails: 'Billing@Example.com, ops@example.com billing@example.com',
    autopay: { enabled: true, stripeCustomerId: 'cus_x' }
  });
  assert.deepEqual(client.billingEmails, ['billing@example.com', 'ops@example.com']);
  assert.equal('autopay' in client, false);
  assert.equal(client.approvalMode, 'manual');
  assert.equal(client.invoiceNumberNext, 11);
  assert.throws(() => normalizeBillingClient({ ...CAAH_BILLING_CLIENT, billingEmails: ['nope'] }), /valid email/);
  assert.throws(() => normalizeBillingClient({ ...CAAH_BILLING_CLIENT, leadSource: { type: 'wordpress', endpoint: 'http://insecure.example' } }), /https/);
  assert.deepEqual(normalizeBillingClient({ ...CAAH_BILLING_CLIENT, leadSource: { type: 'manual', endpoint: 'x' } }).leadSource, { type: 'manual' });
});
