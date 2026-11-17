// The customer-facing Pay Now options for an invoice, bank first.
//
// Pure and dependency-free so the PDF and email renderers can use it without
// loading the Stripe SDK or Firebase. billing-stripe.js re-exports everything
// here; it is the single source for the wording and the URL shape.
//
//   bank — "Pay by bank (ACH)", the primary button. 0.8% capped at $5.
//   card — "Pay by card", the secondary option. 2.9% + 30¢.

export const SITE_ORIGIN = String(process.env.BILLING_SITE_ORIGIN || 'https://bitesites.org').replace(/\/+$/, '');

export const PAYMENT_METHODS = Object.freeze(['bank', 'card']);
export const DEFAULT_PAYMENT_METHOD = 'bank';

export const normalizeMethod = value => (value === 'card' ? 'card' : DEFAULT_PAYMENT_METHOD);

/** Customer-facing wording, shared by the email, PDF and admin panel. */
export const PAYMENT_METHOD_COPY = Object.freeze({
  bank: { label: 'Pay by bank (ACH)', note: 'Recommended. Connect your bank securely; no card fees.' },
  card: { label: 'Pay by card', note: 'Card payments are accepted too.' }
});

/** The public, never-expiring URLs that go in the invoice email and PDF. */
export const payNowUrlForToken = (token, method = DEFAULT_PAYMENT_METHOD) =>
  `${SITE_ORIGIN}/api/pay/${token}${normalizeMethod(method) === 'card' ? '?method=card' : ''}`;

/**
 * Both Pay Now options for an invoice that already has a link, bank first.
 * The invoicing side renders these instead of a single "Pay Now" button.
 * Returns [] unless payment.payNowUrl is this deployment's stable pay link.
 */
export function payNowOptions(invoice, { origin = SITE_ORIGIN } = {}) {
  const raw = invoice?.payment?.payNowUrl;
  const url = typeof raw === 'string' ? raw.trim().slice(0, 500) : '';
  const base = String(origin || '').replace(/\/+$/, '');
  if (!url || !base || !url.startsWith(`${base}/api/pay/`)) return [];
  const stable = url.split('?')[0];
  return PAYMENT_METHODS.map(method => ({
    method,
    url: method === 'card' ? `${stable}?method=card` : stable,
    primary: method === DEFAULT_PAYMENT_METHOD,
    ...PAYMENT_METHOD_COPY[method]
  }));
}
