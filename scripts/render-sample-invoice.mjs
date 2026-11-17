// Renders sample invoice PDFs and the invoice email HTML into samples/ (gitignored)
// so the layout can be checked against the foundation invoice without Firebase.
//
//   node scripts/render-sample-invoice.mjs [leadCount]
//
// The lead count is FAKE sample data (default 12). Nothing is sent anywhere.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInvoiceLines, totalCents } from '../functions/billing-math.js';
import { renderInvoicePdf } from '../functions/billing-pdf.js';
import { buildInvoiceEmail } from '../functions/billing-email.js';
import { CAAH_BILLING_CLIENT } from './billing-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'samples');
mkdirSync(out, { recursive: true });

const leadCount = Number(process.argv[2] ?? 12);
const client = { ...CAAH_BILLING_CLIENT, billingEmails: ['delivered@resend.dev'] };
const periodLabel = 'November 2026';
const lineItems = buildInvoiceLines(client, { periodLabel, leadCount });
const base = {
  clientId: 'caah', number: '011', issueDate: '2026-12-01', dueDate: '2026-12-31',
  periodStart: '2026-11-01', periodEnd: '2026-11-30', periodLabel,
  lineItems, leadCount, totalCents: totalCents(lineItems), currency: 'usd'
};

const variants = {
  'CAAH_INVOICE_011_sample.pdf': { ...base, status: 'finalized', autopay: false, payment: { payNowUrl: 'https://bitesites.org/api/pay/sample_token_0123456789' } },
  'CAAH_INVOICE_011_sample_autopay.pdf': { ...base, status: 'finalized', autopay: true, payment: {} },
  'CAAH_INVOICE_011_sample_draft.pdf': { ...base, status: 'draft', autopay: false, payment: {} }
};

for (const [name, invoice] of Object.entries(variants)) {
  writeFileSync(join(out, name), await renderInvoicePdf(invoice, client));
  console.log(join(out, name));
}

const email = buildInvoiceEmail({
  invoice: variants['CAAH_INVOICE_011_sample.pdf'], client,
  pdf: Buffer.from('%PDF-sample'), from: 'BiteSites <jensy@bitesites.org>'
});
writeFileSync(join(out, 'CAAH_INVOICE_011_email.html'), email.html);
writeFileSync(join(out, 'CAAH_INVOICE_011_email.txt'), email.text);
console.log(join(out, 'CAAH_INVOICE_011_email.html'));
