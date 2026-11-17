// Billing state machine against the Firestore emulator. Email, storage, Stripe
// and the WordPress endpoint are in-memory fakes: nothing leaves the machine.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createBillingService, loadStripeModule } from './billing-core.js';
import { CAAH_BILLING_CLIENT, CAAH_CLIENT_ID } from '../scripts/billing-fixtures.mjs';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run this test through the Firestore emulator.');
if (!getApps().length) initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();
const secret = randomBytes(24).toString('hex');

// 06:00 New York on December 1, 2026: the scheduled run that produces #011.
const DEC_1 = new Date('2026-12-01T11:00:00Z');

function harness({ leadCount = 12, leadStatus = 200, stripe = null, now = DEC_1 } = {}) {
  const files = new Map();
  const sent = [];
  const leadRequests = [];
  const service = createBillingService({
    db,
    now: () => now,
    wpLeadsSecret: () => secret,
    storage: {
      save: async (path, buffer) => { files.set(path, Buffer.from(buffer)); },
      read: async path => { if (!files.has(path)) throw new Error('missing'); return files.get(path); }
    },
    sendEmail: async (message, options) => { sent.push({ message, options }); return { id: `email_${sent.length}` }; },
    loadStripe: async () => stripe,
    fetchImpl: async url => {
      leadRequests.push(url);
      return { ok: leadStatus < 300, status: leadStatus, json: async () => ({ count: leadCount }) };
    }
  });
  return { service, files, sent, leadRequests };
}

const fakeStripe = ({ chargeStatus = 'succeeded' } = {}) => {
  const calls = { links: [], charges: [] };
  return {
    calls,
    isStripeConfigured: () => true,
    createPayNowLink: async (invoice, client) => { calls.links.push({ invoice, client }); return { url: `https://checkout.stripe.com/c/pay/cs_test_${invoice.id}`, sessionId: `cs_test_${invoice.id}` }; },
    chargeAutopay: async (invoice, client) => { calls.charges.push({ invoice, client }); return { status: chargeStatus, paymentIntentId: 'pi_test_1' }; }
  };
};

const seedCaah = (overrides = {}) => db.doc(`billingClients/${CAAH_CLIENT_ID}`).set({ ...CAAH_BILLING_CLIENT, ...overrides });

beforeEach(async () => {
  for (const name of ['billingClients', 'invoices', 'emailDeliveries']) await db.recursiveDelete(db.collection(name));
});
after(async () => db.terminate());

test('the December 1 run drafts CAAH #011 for November with the pulled lead count', async () => {
  await seedCaah();
  const { service, leadRequests } = harness({ leadCount: 12 });
  const summary = await service.runMonthlyCycle();
  assert.equal(summary.periodKey, '2026-11');
  assert.deepEqual(summary.created, ['caah_2026-11']);
  assert.equal(summary.needsReview[0].reason, 'Manual approval', 'CAAH waits for manual approval');
  const invoice = (await db.doc('invoices/caah_2026-11').get()).data();
  assert.equal(invoice.number, '011');
  assert.equal(invoice.status, 'draft');
  assert.equal(invoice.issueDate, '2026-12-01');
  assert.equal(invoice.dueDate, '2026-12-31');
  assert.equal(invoice.periodLabel, 'November 2026');
  assert.equal(invoice.leadCount, 12);
  assert.equal(invoice.leadPull.status, 'pulled');
  assert.equal(invoice.totalCents, 270000);
  assert.equal(invoice.currency, 'usd');
  assert.equal(invoice.autopay, false);
  assert.match(leadRequests[0], /start=2026-11-01&end=2026-12-01/);
  assert.equal((await db.doc('billingClients/caah').get()).get('invoiceNumberNext'), 12);
});

test('numbering is sequential per client and a re-run never allocates a second number', async () => {
  await seedCaah();
  await db.doc('billingClients/other').set({ ...CAAH_BILLING_CLIENT, name: 'Other Client', invoiceNumberNext: 1, leadSource: { type: 'manual' } });
  const { service } = harness();
  const first = await service.createDraft('caah', '2026-11');
  const again = await service.createDraft('caah', '2026-11');
  const [concurrentA, concurrentB] = await Promise.all([service.createDraft('caah', '2026-12'), service.createDraft('caah', '2026-12')]);
  const other = await service.createDraft('other', '2026-11');
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.invoice.number, '011');
  assert.equal(concurrentA.invoice.number, '012');
  assert.equal(concurrentB.invoice.number, '012');
  assert.equal([concurrentA, concurrentB].filter(result => result.created).length, 1);
  assert.equal(other.invoice.number, '001');
  assert.equal((await db.doc('billingClients/caah').get()).get('invoiceNumberNext'), 13);
  // Lowering the counter below an issued number is refused.
  await assert.rejects(service.saveClient('caah', { ...CAAH_BILLING_CLIENT, invoiceNumberNext: 12 }), /next number must be 13/);
});

test('a failed lead pull leaves the count empty, blocks finalizing, and a manual count unblocks it', async () => {
  await seedCaah();
  const { service, sent } = harness({ leadStatus: 401 });
  const { invoice } = await service.createDraft('caah', '2026-11');
  assert.equal(invoice.leadCount, null);
  assert.equal(invoice.leadPull.status, 'failed');
  assert.match(invoice.leadPull.error, /rejected the lead-count secret/);
  assert.equal(invoice.totalCents, 180000);
  await assert.rejects(service.finalize(invoice.id), /lead count/);
  await assert.rejects(service.refreshLeadCount(invoice.id), /Lead count not updated/);
  const edited = await service.updateDraft(invoice.id, { leadCount: 4 }, { uid: 'admin-1' });
  assert.equal(edited.totalCents, 210000);
  assert.equal(edited.leadPull.status, 'manual_override');
  const stored = (await db.doc(`invoices/${invoice.id}`).get()).data();
  assert.equal(stored.lineItems.at(-1).description, 'Lead Generation — 4 leads × $75.00');
  await service.send(invoice.id, { uid: 'admin-1' });
  assert.equal(sent.length, 1);
});

test('without the Stripe module: finalize stores a PDF, no Pay Now link, Zelle/check only', async () => {
  await seedCaah();
  assert.equal(await loadStripeModule(), null, 'the real loader returns null while functions/billing-stripe.js is absent');
  const { service, files, sent } = harness({ stripe: null });
  const { invoice } = await service.createDraft('caah', '2026-11');
  const finalized = await service.finalize(invoice.id, { uid: 'admin-1' });
  assert.equal(finalized.status, 'finalized');
  assert.equal(finalized.payment.payNowUrl, undefined);
  assert.equal(finalized.pdfPath, 'invoices/caah/011-caah_2026-11.pdf');
  assert.equal(files.get(finalized.pdfPath).subarray(0, 5).toString(), '%PDF-');
  await assert.rejects(service.updateDraft(invoice.id, { leadCount: 1 }), /Only a draft/);

  const result = await service.send(invoice.id, { uid: 'admin-1' });
  assert.equal(result.status, 'sent');
  assert.equal(sent[0].options.idempotencyKey, 'invoice-caah_2026-11-send-1');
  assert.deepEqual(sent[0].message.to, ['delivered@resend.dev']);
  assert.doesNotMatch(sent[0].message.html, />Pay Now</);
  assert.equal(sent[0].message.attachments[0].filename, 'BiteSites-Invoice-011.pdf');
  const stored = (await db.doc(`invoices/${invoice.id}`).get()).data();
  assert.equal(stored.status, 'sent');
  assert.equal(stored.email.resendId, 'email_1');
  assert.equal(stored.email.lastEvent, 'sent');
  assert.deepEqual(stored.email.to, ['delivered@resend.dev']);
  assert.ok(stored.email.sentAt);

  await assert.rejects(service.send(invoice.id), /already sent/);
  await service.send(invoice.id, { resend: true });
  assert.equal(sent[1].options.idempotencyKey, 'invoice-caah_2026-11-send-2');
  assert.equal((await db.doc(`invoices/${invoice.id}`).get()).get('email.sendCount'), 2);

  await service.markPaid(invoice.id, { method: 'zelle', paidAt: '2026-12-09', uid: 'admin-1' });
  const paid = (await db.doc(`invoices/${invoice.id}`).get()).data();
  assert.equal(paid.status, 'paid');
  assert.equal(paid.payment.method, 'zelle');
  assert.equal(paid.payment.paidAt, '2026-12-09');
  await assert.rejects(service.voidInvoice(invoice.id), /paid invoice cannot be voided/);
  const deliveries = await db.collection('emailDeliveries').where('kind', '==', 'invoice').get();
  assert.equal(deliveries.size, 2);
});

test('with Stripe and autopay off: finalize creates the Pay Now link and the email carries it', async () => {
  await seedCaah();
  const stripe = fakeStripe();
  const { service, sent } = harness({ stripe });
  const { invoice } = await service.createDraft('caah', '2026-11');
  await service.send(invoice.id, { uid: 'admin-1' }); // a draft is finalized, then sent
  const stored = (await db.doc(`invoices/${invoice.id}`).get()).data();
  assert.equal(stored.payment.payNowUrl, 'https://checkout.stripe.com/c/pay/cs_test_caah_2026-11');
  assert.equal(stored.payment.stripeCheckoutSessionId, 'cs_test_caah_2026-11');
  assert.equal(stripe.calls.links[0].invoice.id, 'caah_2026-11');
  assert.equal(stripe.calls.charges.length, 0);
  assert.match(sent[0].message.html, /cs_test_caah_2026-11"[^>]*>Pay Now</);
});

test('with autopay on: no pay link, the email says when the card is charged, and the charge follows the send', async () => {
  await seedCaah({ autopay: { enabled: true, stripeCustomerId: 'cus_test', defaultPaymentMethodId: 'pm_test' } });
  const stripe = fakeStripe({ chargeStatus: 'succeeded' });
  const { service, sent } = harness({ stripe });
  const { invoice } = await service.createDraft('caah', '2026-11');
  await service.send(invoice.id);
  const stored = (await db.doc(`invoices/${invoice.id}`).get()).data();
  assert.equal(stripe.calls.links.length, 0);
  assert.equal(stripe.calls.charges.length, 1);
  assert.match(sent[0].message.html, /Autopay enabled — your card on file will be charged on December 1, 2026\./);
  assert.equal(stored.autopay, true);
  assert.equal(stored.status, 'paid');
  assert.equal(stored.payment.method, 'stripe');
  assert.equal(stored.payment.stripePaymentIntentId, 'pi_test_1');
});

test('a declined autopay charge marks the invoice payment_failed; it can still be paid by check', async () => {
  await seedCaah({ autopay: { enabled: true, stripeCustomerId: 'cus_test' } });
  const { service } = harness({ stripe: fakeStripe({ chargeStatus: 'requires_payment_method' }) });
  const { invoice } = await service.createDraft('caah', '2026-11');
  await service.send(invoice.id);
  assert.equal((await db.doc(`invoices/${invoice.id}`).get()).get('status'), 'payment_failed');
  await service.markPaid(invoice.id, { method: 'check', paidAt: '2026-12-15' });
  assert.equal((await db.doc(`invoices/${invoice.id}`).get()).get('status'), 'paid');
});

test('auto-approval clients are finalized and sent by the monthly run; void stops a draft', async () => {
  await seedCaah({ approvalMode: 'auto' });
  const { service, sent } = harness({ leadCount: 3 });
  const summary = await service.runMonthlyCycle();
  assert.deepEqual(summary.autoSent, ['caah_2026-11']);
  assert.equal(sent.length, 1);
  assert.equal((await db.doc('invoices/caah_2026-11').get()).get('status'), 'sent');

  const { invoice } = await service.createDraft('caah', '2026-12');
  await service.voidInvoice(invoice.id, { reason: 'Duplicate' });
  await assert.rejects(service.send(invoice.id), /voided invoice/);
  const { pdf } = await service.getPdf('caah_2026-11');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('client edits never touch autopay, which belongs to the Stripe side', async () => {
  await seedCaah({ autopay: { enabled: true, stripeCustomerId: 'cus_keep' } });
  const { service } = harness();
  await service.saveClient('caah', { ...CAAH_BILLING_CLIENT, billingEmails: ['delivered@resend.dev'], autopay: { enabled: false } });
  const stored = (await db.doc('billingClients/caah').get()).data();
  assert.deepEqual(stored.autopay, { enabled: true, stripeCustomerId: 'cus_keep' });
  const created = await service.saveClient('', { ...CAAH_BILLING_CLIENT, name: 'Field Day', leadRateCents: 0, leadSource: { type: 'manual' } });
  assert.equal(created.id, 'field-day');
  assert.equal(created.autopay, undefined);
});
