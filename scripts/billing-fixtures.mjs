// The CAAH billing client as the emulator seed, the sample renderer and the
// tests use it. Business details only (public address, retainer lines); no lead
// data, and the billing email is a Resend test sink, not the client's inbox.
// The real client record is entered in Admin → Billing.

export const CAAH_CLIENT_ID = 'caah';

export const CAAH_BILLING_CLIENT = Object.freeze({
  name: 'Clifton Ave Animal Hospital',
  contactName: '',
  billingEmails: ['delivered@resend.dev'],
  address: '851 Van Houten Ave, Suite #3, Clifton, 07013',
  lineItems: [
    { description: 'Monthly SEO Audit', amountCents: 60000 },
    { description: 'Ad Campaign Maintenance', amountCents: 60000 },
    { description: 'Web Maintenance', amountCents: 40000 },
    { description: 'Market Research', amountCents: 20000 }
  ],
  leadRateCents: 7500,
  leadSource: { type: 'wordpress', endpoint: 'https://cliftonaveanimalhospital.com/wp-json/bitesites/v1/lead-count' },
  approvalMode: 'manual',
  // Invoice #011 is the one dated December 1, 2026 (for November 2026).
  invoiceNumberNext: 11,
  terms: 'Payment is due within 15-30 days of the invoice dates',
  active: true,
  autopay: { enabled: false }
});
