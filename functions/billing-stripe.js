// Stripe payment collection for monthly client invoices.
//
// This module is the Stripe half of invoicing. The invoice model, PDF, email
// and admin invoicing UI live on the invoicing side (feat/resend-invoicing),
// which reaches this file through a guarded dynamic import:
//
//   const stripe = await import('./billing-stripe.js').catch(() => null);
//   if (stripe?.isStripeConfigured()) { ... }
//
// Shared contract (see STRIPE_BILLING.md):
//   * billingClients/{clientId}.autopay — written only here.
//   * invoices/{invoiceId}.payment and the transitions to 'paid' and
//     'payment_failed' — written only here.
//
// Any Cloud Function that calls into this module must list STRIPE_SECRETS in
// its `secrets` option, or the key is not in its environment and
// isStripeConfigured() correctly reports false.
//
// Live mode is refused unless STRIPE_LIVE_MODE_AUTHORIZED=true is set in the
// functions environment. That flag is an owner decision, not a deploy detail:
// a live key alone is not enough to move money from this code.

import Stripe from 'stripe';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';

export const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
export const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
export const STRIPE_SECRETS = [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET];

export const SITE_ORIGIN = String(process.env.BILLING_SITE_ORIGIN || 'https://bitesites.org').replace(/\/+$/, '');

// Stripe's ceiling for a Checkout Session is 24 hours after creation. The
// emailed link is a stable bitesites.org URL that mints a fresh session when
// the old one has lapsed, so a client opening a week-old email still pays.
const CHECKOUT_LIFETIME_SECONDS = 24 * 60 * 60 - 120;
const SESSION_REUSE_MARGIN_SECONDS = 10 * 60;
const STRIPE_MIN_CHARGE_CENTS = 50;
const PAYMENT_METHOD_TYPES = Object.freeze(['card', 'us_bank_account']);

const PAY_LINKS = 'billingPayLinks';
const STRIPE_EVENTS = 'stripeEvents';
const CHARGE_ATTEMPTS = 'billingChargeAttempts';

// ------------------------------------------------------------------ config

const secretValue = (secret, name) => {
  try {
    const value = secret.value();
    if (value) return String(value).trim();
  } catch { /* not bound in this function; fall back to the plain env */ }
  return String(process.env[name] || '').trim();
};

export const stripeSecretKey = () => secretValue(STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY');
export const stripeWebhookSecret = () => secretValue(STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET');

export const liveModeAuthorized = () => String(process.env.STRIPE_LIVE_MODE_AUTHORIZED || '').trim() === 'true';

export function stripeKeyMode(key = stripeSecretKey()) {
  const match = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(String(key || ''));
  return match ? match[1] : '';
}

/** True only when a usable key is bound and its mode is allowed. Never throws. */
export function isStripeConfigured() {
  try {
    if (testStripe) return true;
    const mode = stripeKeyMode();
    if (mode === 'test') return true;
    return mode === 'live' && liveModeAuthorized();
  } catch {
    return false;
  }
}

let testStripe = null;
let cachedStripe = null;
let cachedKey = '';

/** Tests inject a fake SDK here; production never calls it. */
export function __setStripeForTests(fake) {
  testStripe = fake || null;
}

export class BillingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function getStripe() {
  if (testStripe) return testStripe;
  const key = stripeSecretKey();
  const mode = stripeKeyMode(key);
  if (!mode) throw new BillingError('failed-precondition', 'Stripe is not configured (STRIPE_SECRET_KEY is missing).');
  if (mode === 'live' && !liveModeAuthorized()) {
    throw new BillingError('failed-precondition', 'A live Stripe key is bound but live billing is not authorized (STRIPE_LIVE_MODE_AUTHORIZED).');
  }
  if (!cachedStripe || cachedKey !== key) {
    cachedStripe = new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: 'BiteSites billing' } });
    cachedKey = key;
  }
  return cachedStripe;
}

// ----------------------------------------------------------------- helpers

const db = () => getFirestore();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const invoiceIdOf = invoice => text(invoice?.id || invoice?.invoiceId, 200);
const clientIdOf = (client, invoice) => text(client?.id || client?.clientId || invoice?.clientId, 200);

function assertPayableInvoice(invoice) {
  const invoiceId = invoiceIdOf(invoice);
  if (!invoiceId) throw new BillingError('invalid-argument', 'The invoice has no id.');
  const total = invoice?.totalCents;
  if (!Number.isInteger(total) || total < STRIPE_MIN_CHARGE_CENTS) {
    throw new BillingError('invalid-argument', `Invoice ${invoiceId} total must be a whole number of cents, at least ${STRIPE_MIN_CHARGE_CENTS}.`);
  }
  if ((invoice.currency || 'usd') !== 'usd') throw new BillingError('invalid-argument', 'Only USD invoices are supported.');
  if (invoice.status === 'void') throw new BillingError('failed-precondition', `Invoice ${invoiceId} is void.`);
  if (invoice.status === 'draft') throw new BillingError('failed-precondition', `Invoice ${invoiceId} is still a draft.`);
  return invoiceId;
}

function invoiceMetadata(invoice, clientId, source) {
  return {
    invoiceId: invoiceIdOf(invoice),
    clientId,
    invoiceNumber: text(String(invoice?.number ?? ''), 100),
    source
  };
}

const describeInvoice = invoice => {
  const number = text(String(invoice?.number ?? ''), 100);
  const period = text(invoice?.periodLabel, 100);
  return `BiteSites invoice${number ? ` ${number}` : ''}${period ? ` — ${period}` : ''}`;
};

export async function loadInvoice(invoiceId) {
  const snapshot = await db().doc(`invoices/${invoiceId}`).get();
  if (!snapshot.exists) throw new BillingError('not-found', `Invoice ${invoiceId} does not exist.`);
  return { id: snapshot.id, ...snapshot.data() };
}

export async function loadClient(clientId) {
  const snapshot = await db().doc(`billingClients/${clientId}`).get();
  if (!snapshot.exists) throw new BillingError('not-found', `Billing client ${clientId} does not exist.`);
  return { id: snapshot.id, ...snapshot.data() };
}

/**
 * The client's Stripe customer, created on first use and remembered on
 * billingClients/{clientId}.autopay.stripeCustomerId. Creating it does not
 * enable autopay.
 */
export async function ensureStripeCustomer(client) {
  const clientId = clientIdOf(client);
  if (!clientId) throw new BillingError('invalid-argument', 'The billing client has no id.');
  const existing = text(client?.autopay?.stripeCustomerId, 100);
  if (existing) return existing;

  // Re-read so two concurrent first uses converge on one customer.
  const fresh = await loadClient(clientId).catch(() => client);
  const stored = text(fresh?.autopay?.stripeCustomerId, 100);
  if (stored) return stored;

  const emails = Array.isArray(client.billingEmails) ? client.billingEmails.filter(Boolean) : [];
  const customer = await getStripe().customers.create({
    name: text(client.name, 200) || undefined,
    email: text(emails[0], 200) || undefined,
    metadata: { clientId }
  }, { idempotencyKey: `customer:${clientId}` });

  await db().doc(`billingClients/${clientId}`).set({
    autopay: {
      enabled: Boolean(fresh?.autopay?.enabled),
      stripeCustomerId: customer.id,
      updatedAt: FieldValue.serverTimestamp()
    }
  }, { merge: true });
  return customer.id;
}

// ----------------------------------------------------------------- Pay Now

/** The public, never-expiring URL that goes in the invoice email. */
export const payNowUrlForToken = token => `${SITE_ORIGIN}/api/pay/${token}`;

async function findPayLink(invoiceId) {
  const snapshot = await db().collection(PAY_LINKS).where('invoiceId', '==', invoiceId).limit(1).get();
  return snapshot.empty ? null : { token: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

async function createCheckoutSession(invoice, clientId, customerId, attempt) {
  const invoiceId = invoiceIdOf(invoice);
  const metadata = invoiceMetadata(invoice, clientId, 'pay_now');
  return getStripe().checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    client_reference_id: invoiceId,
    payment_method_types: [...PAYMENT_METHOD_TYPES],
    payment_method_options: {
      us_bank_account: {
        verification_method: 'automatic',
        financial_connections: { permissions: ['payment_method'] }
      }
    },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: invoice.totalCents,
        product_data: {
          name: describeInvoice(invoice),
          ...(text(invoice.periodLabel, 100) ? { description: text(invoice.periodLabel, 100) } : {})
        }
      }
    }],
    metadata,
    payment_intent_data: { metadata, description: describeInvoice(invoice) },
    success_url: `${SITE_ORIGIN}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE_ORIGIN}/pay/cancel`,
    expires_at: nowSeconds() + CHECKOUT_LIFETIME_SECONDS
  }, { idempotencyKey: `paynow:${invoiceId}:${attempt}` });
}

async function issueSession(invoice, client, link) {
  const invoiceId = invoiceIdOf(invoice);
  const clientId = clientIdOf(client, invoice);
  const customerId = await ensureStripeCustomer({ ...client, id: clientId });
  const attempt = (Number(link?.attempts) || 0) + 1;
  const session = await createCheckoutSession(invoice, clientId, customerId, attempt);
  const token = link?.token || randomBytes(24).toString('base64url');
  const url = payNowUrlForToken(token);

  const batch = db().batch();
  batch.set(db().doc(`${PAY_LINKS}/${token}`), {
    invoiceId,
    clientId,
    attempts: attempt,
    sessionId: session.id,
    sessionUrl: session.url,
    sessionExpiresAt: Timestamp.fromMillis((session.expires_at || nowSeconds() + CHECKOUT_LIFETIME_SECONDS) * 1000),
    updatedAt: FieldValue.serverTimestamp(),
    ...(link ? {} : { createdAt: FieldValue.serverTimestamp() })
  }, { merge: true });
  batch.set(db().doc(`invoices/${invoiceId}`), {
    payment: { payNowUrl: url, stripeCheckoutSessionId: session.id },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await batch.commit();
  return { url, sessionId: session.id, checkoutUrl: session.url };
}

/**
 * Pay Now for one invoice. Returns the stable bitesites.org link (which is
 * what payment.payNowUrl stores and what the email should carry) and the
 * Checkout Session behind it right now. Calling it again for the same invoice
 * reuses the same link and the open session.
 */
export async function createPayNowLink(invoice, client) {
  assertPayableInvoice(invoice);
  if (invoice.status === 'paid') throw new BillingError('failed-precondition', `Invoice ${invoiceIdOf(invoice)} is already paid.`);
  const link = await findPayLink(invoiceIdOf(invoice));
  if (link?.sessionId && link.sessionExpiresAt?.toMillis?.() > Date.now() + SESSION_REUSE_MARGIN_SECONDS * 1000) {
    const session = await getStripe().checkout.sessions.retrieve(link.sessionId).catch(() => null);
    if (session?.status === 'open') {
      return { url: payNowUrlForToken(link.token), sessionId: session.id, checkoutUrl: session.url };
    }
  }
  return issueSession(invoice, client, link);
}

/** Expire whatever session the link holds and mint a new one behind the same URL. */
export async function refreshPayNowLinkForInvoice(invoiceId) {
  const invoice = await loadInvoice(invoiceId);
  assertPayableInvoice(invoice);
  if (invoice.status === 'paid') throw new BillingError('failed-precondition', `Invoice ${invoiceId} is already paid.`);
  const client = await loadClient(invoice.clientId);
  const link = await findPayLink(invoiceId);
  if (link?.sessionId) {
    const stripe = getStripe();
    const old = await stripe.checkout.sessions.retrieve(link.sessionId).catch(() => null);
    if (old?.status === 'open') await stripe.checkout.sessions.expire(old.id).catch(() => null);
  }
  return issueSession(invoice, client, link);
}

/**
 * Where /api/pay/{token} should send the visitor. Never reveals anything
 * about the invoice beyond what the Stripe page itself shows.
 */
export async function resolvePayLink(token) {
  const safe = /^[A-Za-z0-9_-]{16,64}$/.test(String(token || '')) ? token : '';
  if (!safe) return `${SITE_ORIGIN}/pay/cancel?reason=invalid`;
  const snapshot = await db().doc(`${PAY_LINKS}/${safe}`).get();
  if (!snapshot.exists) return `${SITE_ORIGIN}/pay/cancel?reason=invalid`;
  const link = { token: safe, ...snapshot.data() };
  const invoice = await loadInvoice(link.invoiceId).catch(() => null);
  if (!invoice || invoice.status === 'void') return `${SITE_ORIGIN}/pay/cancel?reason=unavailable`;
  if (invoice.status === 'paid') return `${SITE_ORIGIN}/pay/success?status=paid`;

  const stripe = getStripe();
  if (link.sessionId) {
    const session = await stripe.checkout.sessions.retrieve(link.sessionId).catch(() => null);
    const fresh = (session?.expires_at || 0) > nowSeconds() + 60;
    if (session?.status === 'open' && fresh) return session.url;
    // Completed but not yet paid: a bank debit is settling. Do not mint a
    // second session that could collect the same invoice twice.
    if (session?.status === 'complete' && session.payment_status !== 'paid' && invoice.status !== 'payment_failed') {
      return `${SITE_ORIGIN}/pay/success?status=processing`;
    }
  }
  const client = await loadClient(invoice.clientId);
  const issued = await issueSession(invoice, client, link);
  return issued.checkoutUrl;
}

// ---------------------------------------------------------- invoice state

/**
 * The only path to status 'paid' for a Stripe payment. Idempotent: the
 * synchronous charge result and the webhook both land here.
 */
export async function markInvoicePaid(invoiceId, { paymentIntentId = '', sessionId = '', amountCents = null } = {}) {
  const ref = db().doc(`invoices/${invoiceId}`);
  return db().runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { changed: false, reason: 'missing' };
    const invoice = snapshot.data();
    if (invoice.status === 'paid') {
      const recorded = invoice.payment?.stripePaymentIntentId || '';
      if (!paymentIntentId || recorded === paymentIntentId) return { changed: false, reason: 'already-paid' };
      // A second, different payment for an invoice that is already paid. Keep
      // the first as the payment of record and flag this one for a refund
      // decision instead of silently overwriting it.
      console.error('[billing] second payment for a paid invoice', { invoiceId, paymentIntentId });
      tx.set(ref, {
        payment: { duplicatePaymentIntentIds: FieldValue.arrayUnion(paymentIntentId) },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { changed: false, reason: 'duplicate-payment' };
    }
    if (Number.isInteger(amountCents) && Number.isInteger(invoice.totalCents) && amountCents !== invoice.totalCents) {
      // Money arrived, so the invoice is paid; the mismatch is recorded for a
      // human rather than hidden.
      console.warn('[billing] paid amount differs from invoice total', { invoiceId, amountCents, totalCents: invoice.totalCents });
    }
    const payment = {
      paidAt: FieldValue.serverTimestamp(),
      method: 'stripe',
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      ...(sessionId ? { stripeCheckoutSessionId: sessionId } : {}),
      ...(Number.isInteger(amountCents) ? { amountPaidCents: amountCents } : {}),
      lastError: FieldValue.delete()
    };
    tx.set(ref, { status: 'paid', payment, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { changed: true };
  });
}

/** 'payment_failed' never overwrites 'paid' or 'void'. */
export async function markInvoicePaymentFailed(invoiceId, { paymentIntentId = '', message = '' } = {}) {
  const ref = db().doc(`invoices/${invoiceId}`);
  return db().runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { changed: false, reason: 'missing' };
    const invoice = snapshot.data();
    if (invoice.status === 'paid' || invoice.status === 'void') return { changed: false, reason: invoice.status };
    tx.set(ref, {
      status: 'payment_failed',
      payment: {
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
        lastError: text(message, 500) || 'Payment failed.'
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { changed: true };
  });
}

async function recordProcessing(invoiceId, { paymentIntentId = '', sessionId = '' }) {
  await db().doc(`invoices/${invoiceId}`).set({
    payment: {
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      ...(sessionId ? { stripeCheckoutSessionId: sessionId } : {}),
      processingAt: FieldValue.serverTimestamp()
    },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

// ----------------------------------------------------------------- autopay

async function nextChargeAttempt(invoiceId) {
  const ref = db().doc(`${CHARGE_ATTEMPTS}/${invoiceId}`);
  return db().runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const count = (snapshot.exists ? Number(snapshot.get('count')) || 0 : 0) + 1;
    tx.set(ref, { count, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return count;
  });
}

async function fallBackToPayNow(invoiceId) {
  try {
    const invoice = await loadInvoice(invoiceId);
    const client = await loadClient(invoice.clientId);
    return await createPayNowLink(invoice, client);
  } catch (error) {
    console.error('[billing] Pay Now fallback failed', { invoiceId, message: error.message });
    return null;
  }
}

/**
 * Charge the client's saved payment method for this invoice, off-session.
 *
 * Returns { status, paymentIntentId, payNowUrl? } where status is:
 *   'paid'           — card charged; invoice marked paid.
 *   'processing'     — bank debit submitted; the webhook settles it in days.
 *   'payment_failed' — declined or needs the client; invoice marked
 *                      payment_failed and a Pay Now link generated.
 *   'skipped'        — autopay is not enrolled for this client; a Pay Now
 *                      link was generated instead. Nothing was charged.
 *
 * The first attempt uses the invoice id as the Stripe idempotency key, so a
 * retried call can never charge twice. A deliberate retry (`retry: true`,
 * the admin's "Charge now" after a failure) uses a fresh key.
 */
export async function chargeAutopay(invoice, client, { retry = false } = {}) {
  const invoiceId = assertPayableInvoice(invoice);
  const clientId = clientIdOf(client, invoice);
  if (invoice.status === 'paid') {
    return { status: 'paid', paymentIntentId: invoice.payment?.stripePaymentIntentId || null };
  }
  const autopay = client?.autopay || {};
  if (!autopay.enabled || !autopay.defaultPaymentMethodId || !autopay.stripeCustomerId) {
    const link = await fallBackToPayNow(invoiceId);
    return { status: 'skipped', paymentIntentId: null, payNowUrl: link?.url || null };
  }

  // Stripe forgets idempotency keys after 24 hours, so a repeat of the
  // automatic charge is also answered from the PaymentIntent already on the
  // invoice instead of creating another one. Even a deliberate retry never
  // starts a second charge while one is settling or after one succeeded.
  const existingIntentId = text(invoice.payment?.stripePaymentIntentId, 100);
  if (existingIntentId) {
    const existing = await getStripe().paymentIntents.retrieve(existingIntentId).catch(() => null);
    if (existing?.status === 'succeeded') {
      await settlePaid(invoiceId, { paymentIntentId: existing.id, amountCents: existing.amount_received ?? existing.amount });
      return { status: 'paid', paymentIntentId: existing.id };
    }
    if (existing?.status === 'processing') return { status: 'processing', paymentIntentId: existing.id };
    if (!retry && existing?.metadata?.source === 'autopay') {
      return { status: 'payment_failed', paymentIntentId: existing.id, payNowUrl: invoice.payment?.payNowUrl || null };
    }
  }

  const idempotencyKey = retry ? `${invoiceId}:retry-${await nextChargeAttempt(invoiceId)}` : invoiceId;
  let intent;
  try {
    intent = await getStripe().paymentIntents.create({
      amount: invoice.totalCents,
      currency: 'usd',
      customer: autopay.stripeCustomerId,
      payment_method: autopay.defaultPaymentMethodId,
      payment_method_types: [...PAYMENT_METHOD_TYPES],
      off_session: true,
      confirm: true,
      description: describeInvoice(invoice),
      metadata: invoiceMetadata(invoice, clientId, 'autopay')
    }, { idempotencyKey });
  } catch (error) {
    // Declines arrive as errors carrying the PaymentIntent they failed on. An
    // invalid request (a detached or unusable payment method) also means the
    // client has to act. Network and Stripe-side errors are rethrown: the
    // idempotency key makes the caller's retry safe.
    const failedIntent = error?.raw?.payment_intent || error?.payment_intent || null;
    const clientMustAct = ['StripeCardError', 'StripeInvalidRequestError'].includes(error?.type);
    if (!failedIntent && !clientMustAct) throw error;
    const paymentIntentId = failedIntent?.id || null;
    await markInvoicePaymentFailed(invoiceId, { paymentIntentId, message: error.message });
    const link = await fallBackToPayNow(invoiceId);
    return { status: 'payment_failed', paymentIntentId, payNowUrl: link?.url || null, message: text(error.message, 300) };
  }

  if (intent.status === 'succeeded') {
    await settlePaid(invoiceId, { paymentIntentId: intent.id, amountCents: intent.amount_received ?? intent.amount });
    return { status: 'paid', paymentIntentId: intent.id };
  }
  if (intent.status === 'processing') {
    await recordProcessing(invoiceId, { paymentIntentId: intent.id });
    return { status: 'processing', paymentIntentId: intent.id };
  }
  // requires_action (3DS on an off-session card), requires_payment_method,
  // canceled: the client has to act, so they get a link.
  const message = intent.last_payment_error?.message || `Payment needs the client (${intent.status}).`;
  await markInvoicePaymentFailed(invoiceId, { paymentIntentId: intent.id, message });
  const link = await fallBackToPayNow(invoiceId);
  return { status: 'payment_failed', paymentIntentId: intent.id, payNowUrl: link?.url || null, message: text(message, 300) };
}

/** A Checkout Session in setup mode the admin sends to the client to enroll. */
export async function createAutopaySetupLinkForClient(clientId) {
  const client = await loadClient(clientId);
  const customerId = await ensureStripeCustomer(client);
  const metadata = { clientId, source: 'autopay_setup' };
  const session = await getStripe().checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    currency: 'usd',
    payment_method_types: [...PAYMENT_METHOD_TYPES],
    payment_method_options: {
      us_bank_account: {
        verification_method: 'automatic',
        financial_connections: { permissions: ['payment_method'] }
      }
    },
    metadata,
    setup_intent_data: { metadata, description: `Autopay for ${text(client.name, 120) || 'BiteSites invoices'}` },
    success_url: `${SITE_ORIGIN}/pay/success?setup=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE_ORIGIN}/pay/cancel?setup=1`,
    expires_at: nowSeconds() + CHECKOUT_LIFETIME_SECONDS
  });
  return {
    url: session.url,
    sessionId: session.id,
    expiresAt: new Date((session.expires_at || nowSeconds() + CHECKOUT_LIFETIME_SECONDS) * 1000).toISOString()
  };
}

/** Admin switch. Turning on requires a saved payment method. */
export async function setAutopayForClient(clientId, enabled) {
  const client = await loadClient(clientId);
  const autopay = client.autopay || {};
  if (enabled && !(autopay.stripeCustomerId && autopay.defaultPaymentMethodId)) {
    throw new BillingError('failed-precondition', 'Autopay needs a saved payment method. Send the client the autopay setup link first.');
  }
  await db().doc(`billingClients/${clientId}`).set({
    autopay: { enabled: Boolean(enabled), updatedAt: FieldValue.serverTimestamp() }
  }, { merge: true });
  return { enabled: Boolean(enabled) };
}

async function enrollAutopay(clientId, customerId, paymentMethodId) {
  if (!clientId || !paymentMethodId) return { changed: false };
  if (customerId) {
    await getStripe().customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    }).catch(error => console.warn('[billing] could not set customer default payment method', error.message));
  }
  await db().doc(`billingClients/${clientId}`).set({
    autopay: {
      enabled: true,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      defaultPaymentMethodId: paymentMethodId,
      pendingSetupIntentId: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    }
  }, { merge: true });
  return { changed: true };
}

/** After an invoice is paid, close any Pay Now page still open for it. */
async function expireOpenPayNowSession(invoiceId, keepSessionId = '') {
  try {
    const link = await findPayLink(invoiceId);
    if (!link?.sessionId || link.sessionId === keepSessionId) return;
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(link.sessionId);
    if (session?.status === 'open') await stripe.checkout.sessions.expire(session.id);
  } catch (error) {
    console.warn('[billing] could not expire Pay Now session', { invoiceId, message: error.message });
  }
}

async function settlePaid(invoiceId, details) {
  const result = await markInvoicePaid(invoiceId, details);
  if (result.changed) await expireOpenPayNowSession(invoiceId, details.sessionId);
  return result;
}

// ----------------------------------------------------------------- webhook

const objectId = value => (typeof value === 'string' ? value : value?.id || '');

async function invoiceIdForPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return '';
  const intent = await getStripe().paymentIntents.retrieve(paymentIntentId).catch(() => null);
  return text(intent?.metadata?.invoiceId, 200);
}

async function handleCheckoutCompleted(session) {
  if (session.mode === 'setup') {
    const clientId = text(session.metadata?.clientId, 200);
    if (!clientId) return 'setup-without-client';
    const setupIntent = typeof session.setup_intent === 'object' && session.setup_intent
      ? session.setup_intent
      : await getStripe().setupIntents.retrieve(objectId(session.setup_intent));
    const customerId = objectId(session.customer) || objectId(setupIntent.customer);
    if (setupIntent.status === 'succeeded') {
      await enrollAutopay(clientId, customerId, objectId(setupIntent.payment_method));
      return 'autopay-enrolled';
    }
    // Bank accounts verified by micro-deposits finish later, via
    // setup_intent.succeeded. Autopay stays off until then.
    await db().doc(`billingClients/${clientId}`).set({
      autopay: {
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        pendingSetupIntentId: setupIntent.id,
        updatedAt: FieldValue.serverTimestamp()
      }
    }, { merge: true });
    return 'autopay-pending-verification';
  }

  const invoiceId = text(session.metadata?.invoiceId || session.client_reference_id, 200);
  if (!invoiceId) return 'payment-without-invoice';
  const paymentIntentId = objectId(session.payment_intent);
  if (session.payment_status === 'paid') {
    await settlePaid(invoiceId, { paymentIntentId, sessionId: session.id, amountCents: session.amount_total ?? null });
    return 'invoice-paid';
  }
  await recordProcessing(invoiceId, { paymentIntentId, sessionId: session.id });
  return 'invoice-processing';
}

/**
 * Apply one verified Stripe event to Firestore. Pure state transitions; the
 * HTTP layer (billing-stripe-api.js) verifies the signature and the ledger in
 * processStripeEvent makes redelivery a no-op.
 */
export async function applyStripeEvent(event) {
  const object = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(object);

    case 'checkout.session.async_payment_succeeded': {
      const invoiceId = text(object.metadata?.invoiceId || object.client_reference_id, 200);
      if (!invoiceId) return 'ignored';
      await settlePaid(invoiceId, { paymentIntentId: objectId(object.payment_intent), sessionId: object.id, amountCents: object.amount_total ?? null });
      return 'invoice-paid';
    }

    case 'checkout.session.async_payment_failed': {
      const invoiceId = text(object.metadata?.invoiceId || object.client_reference_id, 200);
      if (!invoiceId) return 'ignored';
      await markInvoicePaymentFailed(invoiceId, { paymentIntentId: objectId(object.payment_intent), message: 'The bank payment failed.' });
      return 'invoice-payment-failed';
    }

    case 'payment_intent.succeeded': {
      const invoiceId = text(object.metadata?.invoiceId, 200);
      if (!invoiceId) return 'ignored';
      await settlePaid(invoiceId, { paymentIntentId: object.id, amountCents: object.amount_received ?? object.amount });
      return 'invoice-paid';
    }

    case 'payment_intent.payment_failed': {
      const invoiceId = text(object.metadata?.invoiceId, 200);
      // A failed attempt inside an open Checkout page is not a failed
      // invoice: the client can try another card on the same page. Bank
      // debits from Checkout fail through checkout.session.async_payment_failed.
      if (!invoiceId || object.metadata?.source !== 'autopay') return 'ignored';
      const failed = await markInvoicePaymentFailed(invoiceId, {
        paymentIntentId: object.id,
        message: object.last_payment_error?.message || 'The automatic payment failed.'
      });
      if (!failed.changed) return 'ignored-invoice-' + (failed.reason || 'unchanged');
      await fallBackToPayNow(invoiceId);
      return 'invoice-payment-failed';
    }

    case 'setup_intent.succeeded': {
      if (object.metadata?.source !== 'autopay_setup') return 'ignored';
      await enrollAutopay(text(object.metadata?.clientId, 200), objectId(object.customer), objectId(object.payment_method));
      return 'autopay-enrolled';
    }

    case 'charge.refunded': {
      const paymentIntentId = objectId(object.payment_intent);
      const invoiceId = text(object.metadata?.invoiceId, 200) || await invoiceIdForPaymentIntent(paymentIntentId);
      if (!invoiceId) return 'ignored';
      // A refund is recorded, not hidden. The invoice status stays as it was:
      // whether a refunded invoice is void is a bookkeeping decision for the
      // invoicing side, not something a webhook should guess.
      await db().doc(`invoices/${invoiceId}`).set({
        payment: {
          refundedCents: Number(object.amount_refunded) || 0,
          refundedAt: FieldValue.serverTimestamp(),
          fullyRefunded: Boolean(object.refunded)
        },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return 'invoice-refund-recorded';
    }

    case 'payment_method.detached': {
      const paymentMethodId = object.id;
      if (!paymentMethodId) return 'ignored';
      const snapshot = await db().collection('billingClients')
        .where('autopay.defaultPaymentMethodId', '==', paymentMethodId).get();
      await Promise.all(snapshot.docs.map(doc => doc.ref.set({
        autopay: {
          enabled: false,
          defaultPaymentMethodId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp()
        }
      }, { merge: true })));
      return snapshot.empty ? 'ignored' : 'autopay-disabled';
    }

    default:
      return 'ignored';
  }
}

/**
 * Idempotent wrapper: an event id is applied once. The ledger entry is
 * written after the transition succeeds, so a failure leaves no entry and
 * Stripe's retry runs the (idempotent) transition again.
 */
export async function processStripeEvent(event) {
  if (!event?.id || !event?.type) throw new BillingError('invalid-argument', 'Not a Stripe event.');
  const ref = db().doc(`${STRIPE_EVENTS}/${event.id}`);
  if ((await ref.get()).exists) return { duplicate: true, outcome: 'duplicate' };

  let outcome;
  if (event.livemode && !liveModeAuthorized()) {
    outcome = 'ignored-live-mode-not-authorized';
  } else {
    outcome = await applyStripeEvent(event);
  }
  await ref.set({
    type: event.type,
    livemode: Boolean(event.livemode),
    outcome,
    stripeCreated: Number(event.created) || null,
    processedAt: FieldValue.serverTimestamp()
  });
  return { duplicate: false, outcome };
}

/** Signature check against the raw request body. Throws on any mismatch. */
export function verifyStripeEvent(rawBody, signature, secret = stripeWebhookSecret()) {
  if (!secret) throw new BillingError('failed-precondition', 'STRIPE_WEBHOOK_SECRET is not configured.');
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}
