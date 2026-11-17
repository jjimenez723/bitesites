// Cloud Function endpoints for Stripe billing. The logic lives in
// billing-stripe.js so the invoicing side can import it without pulling in
// these handlers; this file only adds authentication and HTTP.
//
//   Callables (admin only):
//     createAutopaySetupLink({ clientId, method? })  -> { url, sessionId, method, expiresAt }  (bank by default)
//     setAutopay({ clientId, enabled })         -> { enabled }
//     refreshPayNowLink({ invoiceId })          -> { url, sessionId }
//     chargeInvoiceNow({ invoiceId })           -> { status, paymentIntentId, payNowUrl? }
//
//   HTTPS:
//     stripeWebhook     POST /api/stripe-webhook   (Stripe-Signature verified)
//     billingPayNow     GET  /api/pay/{token}[?method=card]  (bank Checkout by default)

import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

import {
  BillingError,
  STRIPE_SECRETS,
  chargeAutopay,
  createAutopaySetupLinkForClient,
  isStripeConfigured,
  loadClient,
  loadInvoice,
  processStripeEvent,
  refreshPayNowLinkForInvoice,
  resolvePayLink,
  setAutopayForClient,
  verifyStripeEvent,
  SITE_ORIGIN
} from './billing-stripe.js';
import { callableAppCheckEnforced } from './deployment-environment.js';

// App Check is enforced except on the staging project (callableAppCheckEnforced).
const callOptions = { enforceAppCheck: callableAppCheckEnforced(), secrets: STRIPE_SECRETS, maxInstances: 5 };

const id = value => {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(clean)) throw new HttpsError('invalid-argument', 'A valid id is required.');
  return clean;
};

async function requireBillingAdmin(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const snapshot = await getFirestore().doc(`roles/${request.auth.uid}`).get();
  const role = snapshot.exists ? snapshot.get('role') || '' : request.auth.token?.role || '';
  if (role !== 'admin') throw new HttpsError('permission-denied', 'Only an admin can manage billing.');
  if (!isStripeConfigured()) throw new HttpsError('failed-precondition', 'Stripe is not configured on this deployment.');
}

async function asHttps(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error instanceof BillingError) throw new HttpsError(error.code, error.message);
    console.error('[billing] callable failed', { message: error.message, type: error.type });
    throw new HttpsError('internal', error?.type?.startsWith?.('Stripe') ? `Stripe: ${error.message}` : 'Billing request failed.');
  }
}

export const createAutopaySetupLink = onCall(callOptions, async request => {
  await requireBillingAdmin(request);
  const clientId = id(request.data?.clientId);
  const method = request.data?.method === 'card' ? 'card' : 'bank';
  return asHttps(() => createAutopaySetupLinkForClient(clientId, { method }));
});

export const setAutopay = onCall(callOptions, async request => {
  await requireBillingAdmin(request);
  const clientId = id(request.data?.clientId);
  if (typeof request.data?.enabled !== 'boolean') throw new HttpsError('invalid-argument', 'enabled must be true or false.');
  return asHttps(() => setAutopayForClient(clientId, request.data.enabled));
});

export const refreshPayNowLink = onCall(callOptions, async request => {
  await requireBillingAdmin(request);
  const invoiceId = id(request.data?.invoiceId);
  return asHttps(async () => {
    const { url, sessionId } = await refreshPayNowLinkForInvoice(invoiceId);
    return { url, sessionId };
  });
});

/** The admin's "Charge now". A deliberate retry, so it gets a fresh idempotency key. */
export const chargeInvoiceNow = onCall(callOptions, async request => {
  await requireBillingAdmin(request);
  const invoiceId = id(request.data?.invoiceId);
  return asHttps(async () => {
    const invoice = await loadInvoice(invoiceId);
    if (!invoice.autopay) throw new BillingError('failed-precondition', 'This invoice is not an autopay invoice. Use the Pay Now link.');
    if (!['finalized', 'sent', 'payment_failed'].includes(invoice.status)) {
      throw new BillingError('failed-precondition', `An invoice that is ${invoice.status} cannot be charged.`);
    }
    const client = await loadClient(invoice.clientId);
    if (!client.autopay?.enabled) throw new BillingError('failed-precondition', 'Autopay is off for this client.');
    return chargeAutopay(invoice, client, { retry: true });
  });
});

export const stripeWebhook = onRequest({ secrets: STRIPE_SECRETS, maxInstances: 5, timeoutSeconds: 60 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return; }
  let event;
  try {
    event = verifyStripeEvent(req.rawBody, req.get('stripe-signature'));
  } catch (error) {
    const unconfigured = error instanceof BillingError;
    res.status(unconfigured ? 503 : 400).json({ error: unconfigured ? 'not-configured' : 'invalid-signature' });
    return;
  }
  try {
    const result = await processStripeEvent(event);
    res.status(200).json({ received: true, ...result });
  } catch (error) {
    // A 5xx makes Stripe redeliver; the transitions are idempotent.
    console.error('[billing] webhook processing failed', { eventId: event.id, type: event.type, message: error.message });
    res.status(500).json({ error: 'processing-failed' });
  }
});

export const billingPayNow = onRequest({ secrets: STRIPE_SECRETS, maxInstances: 5, timeoutSeconds: 30 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.set('Allow', 'GET').status(405).send('Method not allowed'); return; }
  const token = String(req.path || '').split('/').filter(Boolean).pop() || '';
  try {
    if (!isStripeConfigured()) throw new Error('Stripe is not configured');
    res.redirect(303, await resolvePayLink(token, req.query?.method === 'card' ? 'card' : 'bank'));
  } catch (error) {
    console.error('[billing] pay link failed', { message: error.message });
    res.redirect(303, `${SITE_ORIGIN}/pay/cancel?reason=error`);
  }
});
