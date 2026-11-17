// Cloud Functions for Admin → Billing. Thin wrappers: authentication, secrets
// and storage wiring live here; every rule lives in billing-core.js.
//
// Secrets: RESEND_API_KEY (invoice email), WP_LEADS_SECRET (the shared secret
// the CAAH WordPress lead-count plugin checks). See BILLING_INVOICING.md.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { BillingError, createBillingService, serialize } from './billing-core.js';
import { buildMessage, getEmailTemplate, sendResend } from './email.js';
import { BILLING_TIME_ZONE } from './billing-math.js';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const WP_LEADS_SECRET = defineSecret('WP_LEADS_SECRET');

const callOptions = { enforceAppCheck: true, maxInstances: 5, timeoutSeconds: 120, memory: '512MiB' };

// Optional hook for the Stripe module: if ./billing-stripe.js exports
// `stripeSecrets` (an array of defineSecret params), the functions that may
// create a pay link or charge autopay bind them. Absent module → no secrets.
// Import problems are reported by loadStripeModule at call time, not here.
const stripeSecrets = await import('./billing-stripe.js')
  .then(mod => (Array.isArray(mod.stripeSecrets) ? mod.stripeSecrets : []))
  .catch(() => []);
const fromAddress = () => process.env.RESEND_FROM_EMAIL || 'BiteSites <jensy@bitesites.org>';
const appUrl = () => (process.env.APP_URL || 'https://bitesites.org').replace(/\/$/, '');

const storage = {
  bucket: () => getStorage().bucket(),
  async save(path, buffer) {
    await this.bucket().file(path).save(buffer, {
      resumable: false,
      contentType: 'application/pdf',
      metadata: { cacheControl: 'private, max-age=0' }
    });
  },
  async read(path) {
    const [buffer] = await this.bucket().file(path).download();
    return buffer;
  }
};

const service = () => createBillingService({
  db: getFirestore(),
  storage,
  sendEmail: (message, options) => sendResend(RESEND_API_KEY.value(), message, options),
  wpLeadsSecret: () => WP_LEADS_SECRET.value(),
  from: fromAddress()
});

async function requireAdmin(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  const snapshot = await db.doc(`roles/${request.auth.uid}`).get();
  const role = snapshot.exists ? snapshot.get('role') : request.auth.token?.role;
  if (role !== 'admin') throw new HttpsError('permission-denied', 'Only an admin can manage billing.');
  return request.auth.uid;
}

const HTTPS_CODES = new Set(['invalid-argument', 'failed-precondition', 'not-found', 'already-exists', 'aborted', 'unavailable', 'permission-denied']);

// Billing errors carry an HttpsError code; anything else (Resend, Stripe,
// storage) is reported as internal with its message, so the admin can act.
const handler = fn => async request => {
  const uid = await requireAdmin(request);
  try {
    return serialize(await fn(request.data || {}, uid));
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error instanceof BillingError && HTTPS_CODES.has(error.code)) throw new HttpsError(error.code, error.message);
    console.error('[billing]', error);
    throw new HttpsError('internal', String(error?.message || 'Billing request failed.').slice(0, 300));
  }
};

const id = value => {
  const text = String(value || '').trim();
  if (!text || text.length > 120 || text.includes('/')) throw new HttpsError('invalid-argument', 'A valid id is required.');
  return text;
};

export const billingList = onCall(callOptions, handler(data => service().listBilling({ status: data.status || '', clientId: data.clientId || '' })));

export const billingSaveClient = onCall(callOptions, handler((data, uid) =>
  service().saveClient(data.clientId ? id(data.clientId) : '', data.client || {}, { uid })));

export const billingCreateInvoice = onCall({ ...callOptions, secrets: [WP_LEADS_SECRET] }, handler((data, uid) =>
  service().createDraft(id(data.clientId), String(data.periodKey || ''), { trigger: 'manual', uid })));

export const billingRefreshLeadCount = onCall({ ...callOptions, secrets: [WP_LEADS_SECRET] }, handler((data, uid) =>
  service().refreshLeadCount(id(data.invoiceId), { uid })));

export const billingUpdateDraft = onCall(callOptions, handler((data, uid) =>
  service().updateDraft(id(data.invoiceId), data.patch || {}, { uid })));

export const billingFinalizeInvoice = onCall({ ...callOptions, secrets: [...stripeSecrets] }, handler((data, uid) =>
  service().finalize(id(data.invoiceId), { uid })));

export const billingSendInvoice = onCall({ ...callOptions, secrets: [RESEND_API_KEY, ...stripeSecrets] }, handler((data, uid) =>
  service().send(id(data.invoiceId), { uid, resend: data.resend === true })));

export const billingMarkPaid = onCall(callOptions, handler((data, uid) =>
  service().markPaid(id(data.invoiceId), { method: data.method, paidAt: data.paidAt, note: data.note, uid })));

export const billingVoidInvoice = onCall(callOptions, handler((data, uid) =>
  service().voidInvoice(id(data.invoiceId), { reason: data.reason, uid })));

export const billingInvoicePdf = onCall(callOptions, handler(async data => {
  const { pdf, filename } = await service().getPdf(id(data.invoiceId));
  return { filename, contentType: 'application/pdf', base64: Buffer.from(pdf).toString('base64') };
}));

async function notifyAdmin(summary) {
  const attention = summary.needsReview.length + summary.errors.length;
  if (!attention) return;
  const db = getFirestore();
  const template = await getEmailTemplate(db, 'operational_alert');
  const lines = [
    ...summary.needsReview.map(item => `${item.client} #${item.number}: ${item.reason}${item.leadPull === 'failed' ? ' (lead pull failed)' : ''}`),
    ...summary.errors.map(item => `${item.client}: ${item.message}`)
  ];
  const admin = process.env.ADMIN_NOTIFICATION_EMAIL || 'jensy@bitesites.org';
  await sendResend(RESEND_API_KEY.value(), buildMessage({
    from: fromAddress(), to: admin, template, stream: 'transactional', tag: 'billing-review',
    variables: {
      alert_title: `${summary.needsReview.length} invoice draft${summary.needsReview.length === 1 ? '' : 's'} ready for review`,
      alert_message: lines.join(' · ').slice(0, 1800),
      component: 'Billing',
      reference: summary.periodKey,
      admin_url: `${appUrl()}/admin/billing`
    }
  }), { idempotencyKey: `billing-review-${summary.periodKey}` });
}

// 06:00 New York time on the 1st: draft (and, for auto-approval clients, send)
// every active client's invoice for the month that just ended.
export const billingMonthlyInvoices = onSchedule(
  { schedule: '0 6 1 * *', timeZone: BILLING_TIME_ZONE, secrets: [RESEND_API_KEY, WP_LEADS_SECRET, ...stripeSecrets], timeoutSeconds: 300, memory: '512MiB', maxInstances: 1 },
  async () => {
    const summary = await service().runMonthlyCycle();
    console.log('[billing] monthly cycle', JSON.stringify(summary));
    await notifyAdmin(summary).catch(error => console.error('[billing] admin notice failed', error?.message));
  }
);
