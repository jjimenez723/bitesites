// Monthly client invoicing: the Firestore state machine behind Admin → Billing.
//
//   draft ──finalize──▶ finalized ──send──▶ sent ──▶ paid
//     │                     │                 └──▶ payment_failed ──▶ paid
//     └──────────── void ◀──┴─────────────────────┘
//
// Every transition is server-side. The browser can read `billingClients` and
// `invoices` (admins only); the one browser write firestore.rules allows is an
// admin recording a manual Zelle/check/other payment on an issued invoice. The
// UI uses the billingMarkPaid callable for that too.
//
// Stripe is optional and owned by another module. At finalize/send this file
// does a guarded dynamic import of ./billing-stripe.js, which (when present)
// exports isStripeConfigured(), createPayNowLink(invoice, client) → { url,
// sessionId } and chargeAutopay(invoice, client) → { status, paymentIntentId }.
// When that module is absent or not configured, invoices still work: no Pay Now
// button, Zelle/check only. `client.autopay` is written only by the Stripe side.
//
// The service takes its collaborators as arguments (Firestore, storage, email
// sender, Stripe loader, clock) so the whole flow runs against the emulator in
// tests without network access.

import { FieldValue } from 'firebase-admin/firestore';
import {
  addDays, billingToday, buildInvoiceLines, clientBillsLeads, finalizeBlocker, formatInvoiceNumber,
  INVOICE_STATUSES, isIsoDate, leadRate, normalizeBillingClient, normalizeLeadCount, PAYMENT_METHODS, periodForMonth,
  priorMonthPeriod, recomputeInvoice, slugify, DEFAULT_DUE_DAYS
} from './billing-math.js';
import { resolveLeadCount } from './billing-leads.js';
import { invoiceFilename, renderInvoicePdf } from './billing-pdf.js';
import { buildInvoiceEmail } from './billing-email.js';

export class BillingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new BillingError(code, message); };

/**
 * Loads ./billing-stripe.js if it exists and reports itself configured.
 * Returns null — never throws — when the file is simply not there, so this
 * branch works before the Stripe branch is merged. Any other import error (the
 * module exists but is broken) is surfaced, because silently dropping card
 * payments would be worse than a visible failure.
 */
export async function loadStripeModule(importer = () => import('./billing-stripe.js')) {
  let mod;
  try {
    mod = await importer();
  } catch (error) {
    // Only "this exact file does not exist" counts as absent. A missing package
    // or helper imported *by* billing-stripe.js is a broken module, not an absent one.
    const missing = error?.code === 'ERR_MODULE_NOT_FOUND'
      && /^Cannot find module '[^']*billing-stripe\.js'/.test(String(error?.message || ''));
    if (missing) return null;
    throw error;
  }
  if (typeof mod?.isStripeConfigured !== 'function') return null;
  return (await mod.isStripeConfigured()) ? mod : null;
}

/** Plain JSON for callable responses: Timestamps become ISO strings. */
export function serialize(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  return value;
}

const AUTOPAY_RESULT = {
  succeeded: 'paid',
  processing: 'sent',
  requires_action: 'payment_failed',
  requires_payment_method: 'payment_failed',
  failed: 'payment_failed',
  canceled: 'payment_failed'
};

export function createBillingService({
  db,
  storage,
  sendEmail,
  loadStripe = loadStripeModule,
  wpLeadsSecret = () => '',
  fetchImpl = fetch,
  now = () => new Date(),
  from = 'BiteSites <jensy@bitesites.org>',
  renderPdf = renderInvoicePdf
}) {
  const clients = () => db.collection('billingClients');
  const invoices = () => db.collection('invoices');
  const stamp = () => FieldValue.serverTimestamp();

  const getClient = async clientId => {
    const snapshot = await clients().doc(String(clientId || '_')).get();
    return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
  };

  const getInvoice = async invoiceId => {
    const snapshot = await invoices().doc(String(invoiceId || '_')).get();
    if (!snapshot.exists) fail('not-found', 'That invoice no longer exists.');
    return { id: snapshot.id, ...snapshot.data() };
  };

  const pdfPathFor = invoice => `invoices/${invoice.clientId}/${invoice.number}-${invoice.id}.pdf`;

  const recordDelivery = (entry) => db.collection('emailDeliveries').add({ ...entry, createdAt: stamp() })
    .catch(error => console.error('[billing] delivery log failed', error?.message));

  async function listBilling({ limit = 200, status = '', clientId = '' } = {}) {
    let query = invoices();
    if (status) {
      if (!INVOICE_STATUSES.includes(status)) fail('invalid-argument', 'Unknown invoice status.');
      query = query.where('status', '==', status);
    }
    if (clientId) query = query.where('clientId', '==', String(clientId));
    const [clientSnapshot, invoiceSnapshot] = await Promise.all([
      clients().get(),
      query.orderBy('issueDate', 'desc').limit(Math.min(Math.max(Number(limit) || 200, 1), 500)).get()
    ]);
    return {
      clients: clientSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      invoices: invoiceSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    };
  }

  async function highestInvoiceNumber(clientId) {
    const snapshot = await invoices().where('clientId', '==', clientId).get();
    return snapshot.docs.reduce((max, doc) => Math.max(max, Number(doc.get('number')) || 0), 0);
  }

  /** Create or update a billing client. Never writes `autopay`. */
  async function saveClient(clientId, input, { uid = '' } = {}) {
    let normalized;
    try { normalized = normalizeBillingClient(input); } catch (error) { fail('invalid-argument', error.message); }
    let id = String(clientId || '').trim();
    if (id && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) fail('invalid-argument', 'Client ids use lowercase letters, numbers and dashes.');
    const existing = id ? await getClient(id) : null;
    if (!existing) {
      id = id || slugify(normalized.name) || clients().doc().id;
      if (await getClient(id)) fail('already-exists', `A billing client with the id "${id}" already exists.`);
    }
    const highest = await highestInvoiceNumber(id);
    if (normalized.invoiceNumberNext <= highest) {
      fail('invalid-argument', `Invoice #${formatInvoiceNumber(highest)} already exists for this client; the next number must be ${highest + 1} or higher.`);
    }
    await clients().doc(id).set({
      ...normalized,
      updatedAt: stamp(),
      updatedBy: uid,
      ...(existing ? {} : { createdAt: stamp() })
    }, { merge: true });
    return getClient(id);
  }

  /**
   * Creates the draft for one client and billing month, idempotently: the
   * document id is `${clientId}_${YYYY-MM}`, so a re-run (or a double click)
   * returns the existing invoice instead of allocating a second number.
   */
  async function createDraft(clientId, periodKey, { trigger = 'manual', uid = '' } = {}) {
    let period;
    try { period = periodForMonth(periodKey); } catch (error) { fail('invalid-argument', error.message); }
    const invoiceId = `${clientId}_${period.periodKey}`;
    const ref = invoices().doc(invoiceId);
    const existing = await ref.get();
    if (existing.exists) return { created: false, invoice: { id: existing.id, ...existing.data() } };
    const client = await getClient(clientId);
    if (!client) fail('not-found', 'That billing client does not exist.');

    // The network call happens before the transaction: transactions retry, and
    // a WordPress request is not something to repeat on contention.
    const lead = clientBillsLeads(client)
      ? await resolveLeadCount(client, period, { secret: wpLeadsSecret(), fetchImpl, now: now() })
      : { leadCount: null, leadPull: null };
    const today = billingToday(now());
    const firstAfterPeriod = addDays(period.periodEnd, 1);
    const issueDate = today > firstAfterPeriod ? today : firstAfterPeriod;
    const lineItems = buildInvoiceLines(client, { periodLabel: period.periodLabel, leadCount: lead.leadCount });
    const { totalCents } = recomputeInvoice({ lineItems, leadCount: lead.leadCount, leadRateCents: leadRate(client), periodLabel: period.periodLabel });

    let created = false;
    let invoice;
    await db.runTransaction(async tx => {
      const clientRef = clients().doc(clientId);
      const [invoiceSnapshot, clientSnapshot] = await Promise.all([tx.get(ref), tx.get(clientRef)]);
      if (invoiceSnapshot.exists) {
        invoice = { id: invoiceSnapshot.id, ...invoiceSnapshot.data() };
        created = false;
        return;
      }
      const next = Number(clientSnapshot.get('invoiceNumberNext')) || 1;
      invoice = {
        clientId,
        clientName: client.name,
        number: formatInvoiceNumber(next),
        issueDate,
        dueDate: addDays(issueDate, DEFAULT_DUE_DAYS),
        periodKey: period.periodKey,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        periodLabel: period.periodLabel,
        lineItems,
        leadCount: lead.leadCount,
        ...(lead.leadPull ? { leadPull: lead.leadPull } : {}),
        totalCents,
        currency: 'usd',
        status: 'draft',
        autopay: client.autopay?.enabled === true,
        payment: {},
        pdfPath: '',
        email: {},
        terms: client.terms || '',
        trigger,
        createdBy: uid
      };
      tx.set(ref, { ...invoice, createdAt: stamp(), updatedAt: stamp() });
      tx.update(clientRef, { invoiceNumberNext: next + 1, updatedAt: stamp() });
      created = true;
    });
    return { created, invoice: { id: invoiceId, ...invoice } };
  }

  async function refreshLeadCount(invoiceId, { uid = '' } = {}) {
    const invoice = await getInvoice(invoiceId);
    if (invoice.status !== 'draft') fail('failed-precondition', 'Lead counts can only change on a draft.');
    const client = await getClient(invoice.clientId);
    if (!client) fail('not-found', 'That billing client does not exist.');
    if (client.leadSource?.type !== 'wordpress') fail('failed-precondition', 'This client’s leads are entered manually.');
    const lead = await resolveLeadCount(client, invoice, { secret: wpLeadsSecret(), fetchImpl, now: now() });
    if (lead.leadCount === null) {
      await invoices().doc(invoiceId).update({ leadPull: { ...lead.leadPull, by: uid }, updatedAt: stamp() });
      fail('unavailable', `Lead count not updated: ${lead.leadPull.error}`);
    }
    return updateDraft(invoiceId, { leadCount: lead.leadCount }, { uid, leadPull: { ...lead.leadPull, by: uid } });
  }

  /** Edit a draft's lines, lead count or dates. Amounts are always re-derived. */
  async function updateDraft(invoiceId, patch = {}, { uid = '', leadPull = null } = {}) {
    const ref = invoices().doc(invoiceId);
    return db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) fail('not-found', 'That invoice no longer exists.');
      const current = snapshot.data();
      if (current.status !== 'draft') fail('failed-precondition', 'Only a draft can be edited.');
      const clientSnapshot = await tx.get(clients().doc(current.clientId));
      const hasLeadPatch = Object.prototype.hasOwnProperty.call(patch, 'leadCount');
      let recomputed;
      try {
        recomputed = recomputeInvoice({
          lineItems: Array.isArray(patch.lineItems) ? patch.lineItems : current.lineItems,
          leadCount: hasLeadPatch ? normalizeLeadCount(patch.leadCount) : current.leadCount,
          leadRateCents: leadRate(clientSnapshot.data()),
          periodLabel: current.periodLabel
        });
      } catch (error) { fail('invalid-argument', error.message); }
      const update = { ...recomputed, updatedAt: stamp(), updatedBy: uid };
      for (const key of ['issueDate', 'dueDate']) {
        if (patch[key] === undefined) continue;
        if (!isIsoDate(patch[key])) fail('invalid-argument', `${key === 'issueDate' ? 'Issue' : 'Due'} date must be a valid date.`);
        update[key] = patch[key];
      }
      const issue = update.issueDate || current.issueDate;
      const due = update.dueDate || current.dueDate;
      if (due < issue) fail('invalid-argument', 'The due date cannot be before the issue date.');
      if (leadPull) update.leadPull = leadPull;
      else if (hasLeadPatch && recomputed.leadCount !== current.leadCount) {
        update.leadPull = { ...(current.leadPull || {}), source: 'manual', status: 'manual_override', at: now().toISOString(), by: uid };
      }
      tx.update(ref, update);
      return { id: invoiceId, ...current, ...update };
    });
  }

  async function storePdf(invoice, client) {
    const pdf = await renderPdf(invoice, client);
    const path = pdfPathFor(invoice);
    await storage.save(path, pdf);
    return { pdf, path };
  }

  /**
   * Locks a draft: decides autopay from the client's current Stripe state,
   * creates the Pay Now link when autopay is off, renders and stores the PDF.
   */
  async function finalize(invoiceId, { uid = '' } = {}) {
    const invoice = await getInvoice(invoiceId);
    const client = await getClient(invoice.clientId);
    const blocker = finalizeBlocker(invoice, client);
    if (blocker) fail('failed-precondition', blocker);
    const autopay = client.autopay?.enabled === true;
    const payment = { ...(invoice.payment || {}) };
    if (!autopay) {
      const stripe = await loadStripe();
      if (stripe) {
        const link = await stripe.createPayNowLink({ ...invoice, autopay }, client);
        if (link?.url) payment.payNowUrl = link.url;
        if (link?.sessionId) payment.stripeCheckoutSessionId = link.sessionId;
      }
    }
    // Autopay is charged right after the first send, so the date printed is the
    // issue date or, when an admin approves later than that, today.
    const today = billingToday(now());
    const autopayChargeDate = today > invoice.issueDate ? today : invoice.issueDate;
    const locked = {
      ...invoice,
      status: 'finalized',
      autopay,
      ...(autopay ? { autopayChargeDate } : {}),
      payment
    };
    const { path } = await storePdf(locked, client);
    const ref = invoices().doc(invoiceId);
    await db.runTransaction(async tx => {
      const latest = await tx.get(ref);
      if (latest.get('status') !== 'draft') fail('aborted', 'This invoice changed while it was being finalized. Refresh and try again.');
      tx.update(ref, {
        status: 'finalized', autopay, payment, pdfPath: path,
        ...(autopay ? { autopayChargeDate } : {}),
        finalizedAt: stamp(), finalizedBy: uid, updatedAt: stamp()
      });
    });
    return { ...locked, pdfPath: path };
  }

  async function readPdf(invoice, client) {
    if (invoice.pdfPath) {
      try { return await storage.read(invoice.pdfPath); } catch (error) {
        console.warn('[billing] stored PDF unavailable, re-rendering', error?.message);
      }
    }
    const { pdf, path } = await storePdf(invoice, client);
    await invoices().doc(invoice.id).update({ pdfPath: path, updatedAt: stamp() });
    return pdf;
  }

  /**
   * Emails the invoice (finalizing a draft first). `resend` re-sends an
   * invoice that already went out. Autopay is charged after the first send.
   */
  async function send(invoiceId, { uid = '', resend = false } = {}) {
    let invoice = await getInvoice(invoiceId);
    if (invoice.status === 'void') fail('failed-precondition', 'A voided invoice cannot be sent.');
    if (invoice.status === 'draft') invoice = await finalize(invoiceId, { uid });
    const firstSend = invoice.status === 'finalized';
    if (!firstSend && !resend) fail('failed-precondition', 'This invoice was already sent. Use Resend to send it again.');
    const client = await getClient(invoice.clientId);
    if (!client) fail('not-found', 'That billing client does not exist.');
    const recipients = client.billingEmails || [];
    if (!recipients.length) fail('failed-precondition', 'Add a billing email for this client before sending.');
    // After a failed autopay charge the stored PDF still promises a charge; the
    // re-sent invoice carries the Pay Now fallback instead, so re-render it.
    let pdf;
    if (invoice.status === 'payment_failed') {
      const stored = await storePdf(invoice, client);
      pdf = stored.pdf;
      await invoices().doc(invoiceId).update({ pdfPath: stored.path, updatedAt: stamp() });
    } else {
      pdf = await readPdf(invoice, client);
    }
    const message = buildInvoiceEmail({ invoice, client, pdf, from });
    const sendCount = (Number(invoice.email?.sendCount) || 0) + 1;
    let result;
    try {
      result = await sendEmail(message, { idempotencyKey: `invoice-${invoiceId}-send-${sendCount}` });
    } catch (error) {
      await recordDelivery({ templateId: 'invoice', kind: 'invoice', recipientCount: recipients.length, invoiceId, status: 'failed', provider: 'resend', error: String(error?.message || '').slice(0, 500) });
      await invoices().doc(invoiceId).update({ 'email.lastError': String(error?.message || '').slice(0, 300), updatedAt: stamp() });
      throw error;
    }
    await recordDelivery({ templateId: 'invoice', kind: 'invoice', recipientCount: recipients.length, invoiceId, sentBy: uid, status: 'sent', provider: 'resend', providerIds: [result?.id].filter(Boolean) });

    const { lastError: _previousError, ...previousEmail } = invoice.email || {};
    const update = {
      // `email` is replaced as a whole map, which also clears any lastError.
      email: { ...previousEmail, resendId: result?.id || '', sentAt: stamp(), to: recipients, lastEvent: 'sent', sendCount },
      updatedAt: stamp()
    };
    if (firstSend) update.status = 'sent';
    let status = firstSend ? 'sent' : invoice.status;

    if (firstSend && invoice.autopay) {
      const stripe = await loadStripe().catch(error => ({ loadError: error }));
      if (!stripe || stripe.loadError) {
        update['payment.autopayError'] = stripe?.loadError ? String(stripe.loadError.message).slice(0, 300) : 'Stripe is not configured; the autopay charge was not attempted.';
      } else {
        try {
          const charge = await stripe.chargeAutopay({ ...invoice, status: 'sent' }, client);
          const next = AUTOPAY_RESULT[charge?.status] || 'payment_failed';
          if (charge?.paymentIntentId) update['payment.stripePaymentIntentId'] = charge.paymentIntentId;
          if (next === 'paid') {
            update['payment.method'] = 'stripe';
            update['payment.paidAt'] = billingToday(now());
          }
          status = next;
          update.status = next;
        } catch (error) {
          status = 'payment_failed';
          update.status = 'payment_failed';
          update['payment.autopayError'] = String(error?.message || error).slice(0, 300);
        }
      }
    }
    // `email` replaces the whole map; dotted payment paths merge.
    await invoices().doc(invoiceId).update(update);
    return { ...invoice, status, email: { ...update.email, sentAt: new Date().toISOString() } };
  }

  async function markPaid(invoiceId, { method, paidAt, note = '', uid = '' } = {}) {
    if (!PAYMENT_METHODS.includes(method) || method === 'stripe') fail('invalid-argument', 'Choose Zelle, check or other.');
    const day = paidAt || billingToday(now());
    if (!isIsoDate(day)) fail('invalid-argument', 'Enter the date the payment arrived.');
    const ref = invoices().doc(invoiceId);
    return db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) fail('not-found', 'That invoice no longer exists.');
      const status = snapshot.get('status');
      if (!['finalized', 'sent', 'payment_failed'].includes(status)) fail('failed-precondition', `A ${status} invoice cannot be marked paid.`);
      tx.update(ref, {
        status: 'paid',
        'payment.method': method,
        'payment.paidAt': day,
        'payment.note': String(note || '').slice(0, 300),
        'payment.recordedBy': uid,
        updatedAt: stamp()
      });
      return { id: invoiceId, status: 'paid' };
    });
  }

  async function voidInvoice(invoiceId, { reason = '', uid = '' } = {}) {
    const ref = invoices().doc(invoiceId);
    return db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) fail('not-found', 'That invoice no longer exists.');
      const status = snapshot.get('status');
      if (status === 'paid') fail('failed-precondition', 'A paid invoice cannot be voided.');
      if (status === 'void') return { id: invoiceId, status: 'void' };
      tx.update(ref, { status: 'void', voidReason: String(reason || '').slice(0, 300), voidedAt: stamp(), voidedBy: uid, updatedAt: stamp() });
      return { id: invoiceId, status: 'void' };
    });
  }

  /** The PDF for preview/download. Drafts render live (watermarked); others come from storage. */
  async function getPdf(invoiceId) {
    const invoice = await getInvoice(invoiceId);
    const client = await getClient(invoice.clientId);
    const pdf = invoice.status === 'draft' ? await renderPdf(invoice, client) : await readPdf(invoice, client);
    return { pdf, filename: invoiceFilename(invoice) };
  }

  /**
   * The 1st-of-the-month job: one draft per active client for the prior month.
   * Clients on approvalMode 'auto' are finalized and sent immediately when
   * nothing blocks them (a failed lead pull does); everything else waits for
   * an admin in Billing.
   */
  async function runMonthlyCycle({ periodKey } = {}) {
    const period = periodKey ? periodForMonth(periodKey) : priorMonthPeriod(now());
    const snapshot = await clients().where('active', '==', true).get();
    const summary = { periodKey: period.periodKey, created: [], existing: [], autoSent: [], needsReview: [], errors: [] };
    for (const doc of snapshot.docs) {
      const client = { id: doc.id, ...doc.data() };
      try {
        const { created, invoice } = await createDraft(client.id, period.periodKey, { trigger: 'schedule' });
        (created ? summary.created : summary.existing).push(invoice.id);
        if (!created || invoice.status !== 'draft') continue;
        const blocker = finalizeBlocker(invoice, client);
        if (client.approvalMode === 'auto' && !blocker) {
          await send(invoice.id, { uid: 'schedule' });
          summary.autoSent.push(invoice.id);
        } else {
          summary.needsReview.push({ id: invoice.id, client: client.name, number: invoice.number, reason: blocker || 'Manual approval', leadPull: invoice.leadPull?.status || '' });
        }
      } catch (error) {
        summary.errors.push({ client: client.name, message: String(error?.message || error).slice(0, 300) });
      }
    }
    return summary;
  }

  return {
    listBilling, getClient, getInvoice, saveClient, createDraft, refreshLeadCount, updateDraft,
    finalize, send, markPaid, voidInvoice, getPdf, runMonthlyCycle
  };
}
