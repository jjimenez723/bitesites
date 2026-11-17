// Callable wrappers for Admin → Billing. Every billing write is server-side
// (functions/billing-api.js); the browser never writes billingClients/invoices.
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';

const functions = getFunctions(app, 'us-central1');
const call = async (name, data = {}) => (await httpsCallable(functions, name, { timeout: 130_000 })(data)).data;

export const listBilling = (filters = {}) => call('billingList', filters);
export const saveBillingClient = (clientId, client) => call('billingSaveClient', { clientId, client });
export const createInvoice = (clientId, periodKey) => call('billingCreateInvoice', { clientId, periodKey });
export const refreshLeadCount = invoiceId => call('billingRefreshLeadCount', { invoiceId });
export const updateInvoiceDraft = (invoiceId, patch) => call('billingUpdateDraft', { invoiceId, patch });
export const finalizeInvoice = invoiceId => call('billingFinalizeInvoice', { invoiceId });
export const sendInvoice = (invoiceId, { resend = false } = {}) => call('billingSendInvoice', { invoiceId, resend });
export const markInvoicePaid = (invoiceId, payment) => call('billingMarkPaid', { invoiceId, ...payment });
export const voidInvoice = (invoiceId, reason) => call('billingVoidInvoice', { invoiceId, reason });

/** The invoice PDF as an object URL (revoke it when done). */
export async function invoicePdfUrl(invoiceId) {
  const { base64, contentType, filename } = await call('billingInvoicePdf', { invoiceId });
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  return { url: URL.createObjectURL(new Blob([bytes], { type: contentType })), filename };
}
