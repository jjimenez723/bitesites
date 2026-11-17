// Browser side of Stripe billing. Every action that touches money or autopay
// goes through a Cloud Function (functions/billing-stripe-api.js); the
// browser only reads invoices and billing clients, which firestore.rules
// allows for admins.

import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../../lib/firebase';

const functions = getFunctions(app, 'us-central1');
const call = name => async data => (await httpsCallable(functions, name)(data)).data;

export const createAutopaySetupLink = (clientId, method = 'bank') => call('createAutopaySetupLink')({ clientId, method });
export const setAutopay = (clientId, enabled) => call('setAutopay')({ clientId, enabled });
export const refreshPayNowLink = invoiceId => call('refreshPayNowLink')({ invoiceId });
export const chargeInvoiceNow = invoiceId => call('chargeInvoiceNow')({ invoiceId });

// The admin bundle cannot tell a test key from a live one, so the dashboard
// links follow the build: VITE_STRIPE_DASHBOARD_MODE=live once live billing is
// authorized, test otherwise.
const live = import.meta.env.VITE_STRIPE_DASHBOARD_MODE === 'live';
const DASHBOARD_PATHS = {
  customer: 'customers',
  payment_intent: 'payments',
  checkout_session: 'checkout/sessions',
  payment_method: 'payment_methods'
};

export function stripeDashboardUrl(kind, id) {
  if (!id) return '';
  return `https://dashboard.stripe.com${live ? '' : '/test'}/${DASHBOARD_PATHS[kind] || kind}/${encodeURIComponent(id)}`;
}

export const stripeDashboardIsLive = live;

export const formatCents = cents => (Number.isFinite(cents)
  ? (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  : '—');

export function formatWhen(value) {
  const date = value?.toDate?.() || (value instanceof Date ? value : value ? new Date(value) : null);
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : '';
}

export const errorMessage = error => String(error?.message || error || 'Something went wrong.')
  .replace(/^FirebaseError:\s*/, '');
