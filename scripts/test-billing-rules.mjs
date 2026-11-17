// Security rules for billing (BILLING_INVOICING.md, STRIPE_BILLING.md):
//   npm run test:billing-rules
//
// One strict rule set for billingClients and invoices. Admins read; Cloud
// Functions write. The only browser write is an admin recording a manual
// (Zelle / check / other) payment on an issued invoice. The negative cases are
// the point: a browser — even an admin's — must not be able to create or edit a
// client, switch autopay on, create or renumber an invoice, rewrite a Stripe
// payment field, claim a Stripe payment happened, or mark an invoice
// payment_failed.

import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-bitesites',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 }
});

let passed = 0;
const failures = [];
async function it(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { failures.push(label); console.log(`  ✗ ${label}\n      ${error.message?.split('\n')[0]}`); }
}

const client = (overrides = {}) => ({
  name: 'Example Co', billingEmails: ['billing@example.com'], leadRateCents: 5000, active: true, ...overrides
});
const invoice = (overrides = {}) => ({
  clientId: 'client_a', number: 'INV-1', totalCents: 200000, currency: 'usd', status: 'sent', autopay: false, payment: {}, ...overrides
});

await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async context => {
  const db = context.firestore();
  await setDoc(doc(db, 'roles', 'admin_doc'), { role: 'admin' });
  await setDoc(doc(db, 'roles', 'client_ok'), { role: 'client' });
  await setDoc(doc(db, 'billingClients', 'client_a'), client({ autopay: { enabled: false, stripeCustomerId: 'cus_x' } }));
  await setDoc(doc(db, 'invoices', 'inv_sent'), invoice({ payment: { payNowUrl: 'https://bitesites.org/api/pay/tok', stripeCheckoutSessionId: 'cs_1' } }));
  await setDoc(doc(db, 'invoices', 'inv_stripe_paid'), invoice({ status: 'paid', payment: { method: 'stripe', stripePaymentIntentId: 'pi_1' } }));
  await setDoc(doc(db, 'invoices', 'inv_draft'), invoice({ status: 'draft' }));
  await setDoc(doc(db, 'invoices', 'inv_failed'), invoice({ status: 'payment_failed', payment: { lastError: 'declined', payNowUrl: 'https://bitesites.org/api/pay/tok' } }));
  await setDoc(doc(db, 'invoices', 'inv_void'), invoice({ status: 'void' }));
  await setDoc(doc(db, 'billingPayLinks', 'tok'), { invoiceId: 'inv_sent' });
});

const admin = testEnv.authenticatedContext('admin_doc', { email: 'admin@bitesites.org' }).firestore();
const clientUser = testEnv.authenticatedContext('client_ok', { email: 'c@example.com' }).firestore();
const anon = testEnv.unauthenticatedContext().firestore();

console.log('\nbillingClients');
await it('admin can read a billing client', () => assertSucceeds(getDoc(doc(admin, 'billingClients', 'client_a'))));
await it('a client-role user cannot read billing clients', () => assertFails(getDoc(doc(clientUser, 'billingClients', 'client_a'))));
await it('anonymous cannot read billing clients', () => assertFails(getDoc(doc(anon, 'billingClients', 'client_a'))));
await it('admin cannot create a client from the browser (billingSaveClient does)', () =>
  assertFails(setDoc(doc(admin, 'billingClients', 'client_b'), client())));
await it('admin cannot edit a client from the browser', () =>
  assertFails(updateDoc(doc(admin, 'billingClients', 'client_a'), { name: 'Renamed Co' })));
await it('admin cannot rewind invoice numbering', () =>
  assertFails(updateDoc(doc(admin, 'billingClients', 'client_a'), { invoiceNumberNext: 1 })));
await it('admin cannot switch autopay on from the browser', () =>
  assertFails(updateDoc(doc(admin, 'billingClients', 'client_a'), { 'autopay.enabled': true })));
await it('admin cannot swap the saved payment method', () =>
  assertFails(updateDoc(doc(admin, 'billingClients', 'client_a'), { 'autopay.defaultPaymentMethodId': 'pm_other' })));
await it('admin cannot delete a billing client', () => assertFails(deleteDoc(doc(admin, 'billingClients', 'client_a'))));

console.log('\ninvoices');
await it('admin can read an invoice', () => assertSucceeds(getDoc(doc(admin, 'invoices', 'inv_sent'))));
await it('a client-role user cannot read invoices', () => assertFails(getDoc(doc(clientUser, 'invoices', 'inv_sent'))));
await it('admin cannot create an invoice from the browser, even a draft', () =>
  assertFails(setDoc(doc(admin, 'invoices', 'inv_new'), invoice({ status: 'draft' }))));
await it('admin cannot finalize from the browser', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_draft'), { status: 'finalized' })));
await it('admin cannot change an issued amount', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_sent'), { totalCents: 1 })));
await it('admin cannot rewrite the Pay Now URL', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_sent'), { 'payment.payNowUrl': 'https://evil.example/pay' })));
await it('admin cannot set a Stripe payment intent', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_sent'), { 'payment.stripePaymentIntentId': 'pi_fake' })));
await it('admin cannot mark an invoice payment_failed', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_sent'), { status: 'payment_failed' })));
await it('admin cannot claim a Stripe payment', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_sent'), { status: 'paid', 'payment.method': 'stripe' })));
await it('admin cannot mark paid without a manual method', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_sent'), { status: 'paid' })));
await it('admin cannot smuggle a Stripe field into a manual mark-paid', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_sent'), { status: 'paid', 'payment.method': 'zelle', 'payment.stripePaymentIntentId': 'pi_fake' })));
await it('admin cannot change the total while marking paid', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_sent'), { status: 'paid', 'payment.method': 'check', totalCents: 1 })));
await it('admin cannot mark a draft or a void invoice paid', async () => {
  await assertFails(updateDoc(doc(admin, 'invoices', 'inv_draft'), { status: 'paid', 'payment.method': 'zelle' }));
  await assertFails(updateDoc(doc(admin, 'invoices', 'inv_void'), { status: 'paid', 'payment.method': 'zelle' }));
});
await it('a client-role user cannot mark paid', () =>
  assertFails(updateDoc(doc(clientUser, 'invoices', 'inv_sent'), { status: 'paid', 'payment.method': 'zelle' })));
await it('admin can record a Zelle payment and mark paid', () =>
  assertSucceeds(updateDoc(doc(admin, 'invoices', 'inv_sent'), { status: 'paid', 'payment.method': 'zelle', 'payment.paidAt': '2026-12-09', 'payment.note': 'conf 123' })));
await it('admin can record a check after an autopay failure', () =>
  assertSucceeds(updateDoc(doc(admin, 'invoices', 'inv_failed'), { status: 'paid', 'payment.method': 'check', 'payment.paidAt': '2026-12-10' })));
await it('admin cannot reopen a Stripe-paid invoice', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_stripe_paid'), { status: 'sent' })));
await it('admin cannot void from the browser (billingVoidInvoice does)', () =>
  assertFails(updateDoc(doc(admin, 'invoices', 'inv_stripe_paid'), { status: 'void' })));
await it('admin cannot delete an invoice, even a draft', async () => {
  await assertFails(deleteDoc(doc(admin, 'invoices', 'inv_draft')));
  await assertFails(deleteDoc(doc(admin, 'invoices', 'inv_sent')));
});

console.log('\nserver-only billing collections');
await it('admin cannot read Pay Now link tokens', () => assertFails(getDoc(doc(admin, 'billingPayLinks', 'tok'))));
await it('admin cannot write the Stripe event ledger', () => assertFails(setDoc(doc(admin, 'stripeEvents', 'evt_1'), { type: 'x' })));
await it('admin cannot write charge attempts', () => assertFails(setDoc(doc(admin, 'billingChargeAttempts', 'inv_sent'), { count: 0 })));

await testEnv.cleanup();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
