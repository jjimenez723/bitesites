import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceLines, totalCents } from './billing-math.js';
import { invoiceFilename, paymentNotice, renderInvoicePdf } from './billing-pdf.js';
import { buildInvoiceEmail, invoiceSubject } from './billing-email.js';
import { CAAH_BILLING_CLIENT } from '../scripts/billing-fixtures.mjs';

const PAY_URL = 'https://checkout.stripe.com/c/pay/cs_test_sample';
const invoiceWith = (overrides = {}) => {
  const lineItems = buildInvoiceLines(CAAH_BILLING_CLIENT, { periodLabel: 'November 2026', leadCount: 12 });
  return {
    id: 'caah_2026-11', clientId: 'caah', number: '011', issueDate: '2026-12-01', dueDate: '2026-12-31',
    periodStart: '2026-11-01', periodEnd: '2026-11-30', periodLabel: 'November 2026',
    lineItems, leadCount: 12, totalCents: totalCents(lineItems), currency: 'usd',
    status: 'finalized', autopay: false, payment: {}, ...overrides
  };
};
const pageCount = pdf => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length;

test('payment notice: Pay Now without autopay, a dated notice with it, Zelle/check only otherwise', () => {
  assert.deepEqual(paymentNotice(invoiceWith({ payment: { payNowUrl: PAY_URL } })), { kind: 'pay_now', url: PAY_URL, text: 'Pay Now' });
  assert.equal(paymentNotice(invoiceWith({ autopay: true, payment: { payNowUrl: PAY_URL } })).text,
    'Autopay enabled — your card on file will be charged on December 1, 2026.');
  assert.equal(paymentNotice(invoiceWith()).kind, 'manual');
  assert.equal(paymentNotice(invoiceWith({ payment: { payNowUrl: 'javascript:alert(1)' } })).kind, 'manual');
  assert.match(paymentNotice(invoiceWith({ status: 'paid', payment: { paidAt: '2026-12-09', method: 'zelle' } })).text, /Paid on December 9, 2026/);
});

test('renders a one-page Letter PDF with a clickable Pay Now link only when autopay is off', async () => {
  const withLink = await renderInvoicePdf(invoiceWith({ payment: { payNowUrl: PAY_URL } }), CAAH_BILLING_CLIENT);
  assert.equal(withLink.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(withLink), 1);
  assert.match(withLink.toString('latin1'), /\/MediaBox \[0 0 612 792\]/);
  assert.ok(withLink.includes(Buffer.from(PAY_URL)), 'the Pay Now button links to the pay URL');
  assert.ok(withLink.includes(Buffer.from('Montserrat')), 'Montserrat is embedded');

  const autopay = await renderInvoicePdf(invoiceWith({ autopay: true, payment: { payNowUrl: PAY_URL } }), CAAH_BILLING_CLIENT);
  assert.equal(autopay.includes(Buffer.from(PAY_URL)), false, 'no Pay Now link when the card on file is charged');
  assert.equal(invoiceFilename(invoiceWith()), 'BiteSites-Invoice-011.pdf');
});

test('a long invoice flows onto a second page instead of overprinting', async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ kind: 'custom', description: `Additional deliverable ${index + 1} with a longer description that wraps`, periodLabel: 'November 2026', quantity: 1, unitCents: 1000, amountCents: 1000 }));
  const pdf = await renderInvoicePdf(invoiceWith({ lineItems: many, totalCents: 12000 }), CAAH_BILLING_CLIENT);
  assert.equal(pageCount(pdf), 2);
});

test('the invoice email attaches the PDF and mirrors the payment call to action', () => {
  const pdf = Buffer.from('%PDF-1.3 sample');
  const payNow = buildInvoiceEmail({ invoice: invoiceWith({ payment: { payNowUrl: PAY_URL } }), client: CAAH_BILLING_CLIENT, pdf, from: 'BiteSites <jensy@bitesites.org>' });
  assert.equal(payNow.subject, 'Invoice #011 from BiteSites — November 2026 — $2,700');
  assert.deepEqual(payNow.to, ['delivered@resend.dev']);
  assert.equal(payNow.reply_to, 'jensy@bitesites.org');
  assert.equal(payNow.attachments[0].filename, 'BiteSites-Invoice-011.pdf');
  assert.equal(Buffer.from(payNow.attachments[0].content, 'base64').toString(), '%PDF-1.3 sample');
  assert.match(payNow.html, new RegExp(`href="${PAY_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*>Pay Now<`));
  assert.match(payNow.html, /Lead Generation — 12 leads × \$75\.00/);
  assert.match(payNow.html, /Zelle:<\/strong> 3472774506/);
  assert.match(payNow.html, /bitesites-invoice-logo\.png/);
  assert.match(payNow.text, /Pay Now: https:\/\/checkout\.stripe\.com/);
  assert.match(payNow.text, /Due by December 31, 2026/);
  assert.ok(payNow.tags.some(tag => tag.name === 'category' && tag.value === 'invoice'));

  const autopay = buildInvoiceEmail({ invoice: invoiceWith({ autopay: true, payment: { payNowUrl: PAY_URL } }), client: CAAH_BILLING_CLIENT, pdf, from: 'x@bitesites.org' });
  assert.doesNotMatch(autopay.html, />Pay Now</);
  assert.match(autopay.html, /Autopay enabled — your card on file will be charged on December 1, 2026\./);
  assert.match(autopay.html, /Zelle:/, 'Zelle and check details stay either way');
  assert.equal(invoiceSubject(invoiceWith()), 'Invoice #011 from BiteSites — November 2026 — $2,700');
});

test('the invoice email escapes client-provided text and refuses to send without a recipient or PDF', () => {
  const client = { ...CAAH_BILLING_CLIENT, contactName: '<script>alert(1)</script>' };
  const lineItems = [{ kind: 'custom', description: '<img src=x onerror=alert(1)>', periodLabel: 'November 2026', quantity: 1, unitCents: 100, amountCents: 100 }];
  const message = buildInvoiceEmail({ invoice: invoiceWith({ lineItems, totalCents: 100 }), client, pdf: Buffer.from('x'), from: 'x@bitesites.org' });
  assert.doesNotMatch(message.html, /<script>|<img src=x/);
  assert.throws(() => buildInvoiceEmail({ invoice: invoiceWith(), client: { ...CAAH_BILLING_CLIENT, billingEmails: [] }, pdf: Buffer.from('x') }), /billing email/);
  assert.throws(() => buildInvoiceEmail({ invoice: invoiceWith(), client: CAAH_BILLING_CLIENT, pdf: null }), /PDF/);
});

test('the Stripe loader treats only a missing billing-stripe.js as absent', async () => {
  const { loadStripeModule } = await import('./billing-core.js');
  const notFound = message => () => { const error = new Error(message); error.code = 'ERR_MODULE_NOT_FOUND'; throw error; };
  assert.equal(await loadStripeModule(), null, 'functions/billing-stripe.js is not on this branch');
  assert.equal(await loadStripeModule(notFound("Cannot find module '/srv/functions/billing-stripe.js' imported from /srv/functions/billing-core.js")), null);
  await assert.rejects(loadStripeModule(notFound("Cannot find package 'stripe' imported from /srv/functions/billing-stripe.js")), /stripe/);
  await assert.rejects(loadStripeModule(notFound("Cannot find module '/srv/functions/stripe-helpers.js' imported from /srv/functions/billing-stripe.js")), /helpers/);
  assert.equal(await loadStripeModule(async () => ({ isStripeConfigured: () => false })), null);
  const configured = { isStripeConfigured: async () => true };
  assert.equal(await loadStripeModule(async () => configured), configured);
});
