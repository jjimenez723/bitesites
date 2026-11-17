# Billing: monthly client invoicing and Resend email

Branch `feat/resend-invoicing`. Pilot client: Clifton Ave Animal Hospital (CAAH).
Stripe autopay / Pay Now is built separately on `feat/stripe-autopay` against the shared
contract below.

## Status — what is true today

**Implemented and tested locally (code only):**

- All email goes through Resend (`functions/email.js` → `sendResend`); Postmark is gone
  from the code. Delivery webhooks arrive at `/api/resend-events` (`recordResendEvent`),
  verified with Svix signatures.
- `billingClients` / `invoices` data model, admin-read / server-write Firestore rules,
  two composite indexes, a deny-all `storage.rules`.
- Monthly cycle (`billingMonthlyInvoices`, 06:00 America/New_York on the 1st), per-client
  sequential numbering, lead count pulled from WordPress with manual override,
  server-side PDF matching the CAAH #011 foundation, invoice email with the PDF attached,
  Admin → Billing screen.
- WordPress plugin source in `integrations/wordpress/bitesites-lead-count/`.

**Not done — needs the owner (see "Before deploy"):** nothing is deployed, no secret is
set, the Resend domain is not verified, the WordPress plugin is not installed on
cliftonaveanimalhospital.com, the Resend webhook is not configured, the real CAAH
billing client (with its real billing email) has not been created in production. No
real email has been sent; sending was tested with mocks only.

## Data model (shared contract)

`billingClients/{clientId}`

| Field | Notes |
|---|---|
| `name`, `contactName`, `billingEmails[]`, `address`, `terms`, `active` | Edited in Admin → Billing |
| `lineItems: [{ description, amountCents }]` | Monthly retainer lines |
| `leadRateCents` | 7500 = $75/lead; 0 leaves the Lead Generation line off |
| `leadSource: { type: 'wordpress' \| 'manual', endpoint? }` | |
| `approvalMode: 'manual' \| 'auto'` | CAAH is `manual` |
| `invoiceNumberNext` | Allocated in a transaction; cannot be set at or below an issued number |
| `autopay: { enabled, stripeCustomerId?, defaultPaymentMethodId?, updatedAt? }` | **Written only by the Stripe side.** Billing reads it; client saves never touch it |

`invoices/{invoiceId}` — id is `${clientId}_${YYYY-MM}`, so one invoice per client per
month and a re-run is a no-op.

| Field | Notes |
|---|---|
| `clientId`, `number` (`"011"`), `currency: 'usd'` | |
| `issueDate`, `dueDate`, `periodStart`, `periodEnd` | ISO calendar dates `YYYY-MM-DD` (New York), `periodEnd` inclusive. Due = issue + 30 days |
| `periodLabel` | `November 2026` |
| `lineItems: [{ kind, description, periodLabel, quantity, unitCents, amountCents }]` | `kind` is `retainer`, `leads` or `custom`; amounts are always `quantity × unitCents`, recomputed on the server |
| `leadCount` | `null` until pulled or entered; a lead-billing draft cannot be finalized while null |
| `totalCents` | |
| `status` | `draft` → `finalized` → `sent` → `paid`; `payment_failed`; `void` |
| `autopay: bool` | Snapshot of `client.autopay.enabled` at finalize |
| `payment: { payNowUrl?, stripeCheckoutSessionId?, stripePaymentIntentId?, paidAt?, method?, note?, autopayError? }` | Manual payments store `paidAt` as `YYYY-MM-DD` |
| `pdfPath` | `invoices/{clientId}/{number}-{invoiceId}.pdf` in the default Storage bucket |
| `email: { resendId?, sentAt?, to?, lastEvent?, sendCount?, lastError? }` | `lastEvent` is updated by the Resend webhook |
| `createdAt`, `updatedAt` | Server timestamps |

Additive fields Billing also writes: `clientName`, `periodKey`, `leadPull` (`{ source,
status: pulled|failed|awaiting_entry|manual_override, at, error? }`), `terms`, `trigger`,
`autopayChargeDate`, `finalizedAt`, `voidReason`, audit uids.

### Stripe hand-off

At finalize/send, `functions/billing-core.js` does a guarded dynamic import of
`functions/billing-stripe.js`. If the file is absent (or `isStripeConfigured()` is false)
invoices still work: no Pay Now button, Zelle/check only. If the file exists but fails to
import (for example a missing `stripe` package), the error is surfaced rather than
silently dropping card payments.

- Autopay off → `createPayNowLink(invoice, client)` before the PDF is rendered;
  `{ url, sessionId }` → `payment.payNowUrl`, `payment.stripeCheckoutSessionId`.
- Autopay on → no link; the PDF and email say "Autopay enabled — your card on file will
  be charged on {date}." ({date} is the issue date, or the finalize date if later; stored
  as `autopayChargeDate`.) After the first send, `chargeAutopay(invoice, client)`;
  `succeeded` → `paid` (method `stripe`), `processing` → stays `sent`, anything else →
  `payment_failed`.
- Optional: `billing-stripe.js` may export `stripeSecrets` (an array of `defineSecret`
  params); `functions/billing-api.js` binds them to finalize, send and the monthly job.
- UI: `src/admin/billing/BillingPaymentPanel.jsx` (default or named export) is mounted
  in the invoice panel as `<BillingPaymentPanel invoice client onChange />` behind an error
  boundary; it renders nothing until the file exists. Payment status changes made by
  Stripe webhooks are the Stripe side's to write.

## Monthly cycle

`billingMonthlyInvoices` runs at 06:00 New York on the 1st. For each `active` client it
creates the prior month's draft (next number, retainer lines, lead line). A WordPress
client's count is pulled first; any failure leaves `leadCount: null` with the reason in
`leadPull`. `approvalMode: 'auto'` clients with nothing blocking are finalized and sent at
once; everything else waits in Admin → Billing, and the admin gets one "invoice drafts
ready for review" email (operational alert template). CAAH's seed has
`invoiceNumberNext: 11`, so the December 1, 2026 run produces #011 for November 2026.

## Lead Generation ($75/lead)

`Lead Generation — N leads × $75.00`. N comes from the WordPress pull or the admin's
manual entry on the draft; the admin can always override before sending. The plugin
(`integrations/wordpress/bitesites-lead-count/`) reads `{prefix}caah_leads` — the table
Team View reads — and applies Team View's rules (exclude test/eval rows, collapse repeats
by name/email/phone within the month). It returns counts only, behind
`X-BiteSites-Secret` = `WP_LEADS_SECRET`. See its README for install steps.

## PDF and email

`functions/billing-pdf.js` (pdfkit) reproduces the foundation: Letter, Montserrat
(bundled under `functions/billing-assets/fonts/`, SIL OFL), the repo's BiteSites logo,
issuer block, `INVOICE #011`, BILLED TO / ADDRESS / DATE, the three-column table and the
right-aligned "Payable to" block with Zelle, checks and terms. Added: a Pay Now button
(clickable link) when autopay is off and a link exists, or the autopay notice; a "Due
by" line; DRAFT/VOID watermarks. Totals print with a thousands separator (`$2,700`).

`functions/billing-email.js` builds the Resend message from `jensy@bitesites.org`
(reply-to the same), branded HTML + text, the PDF attached, the same payment call to
action, Zelle/check details either way. The logo is
`https://bitesites.org/email/bitesites-invoice-logo.png` (`public/email/`), live after a
hosting deploy. Each send uses `Idempotency-Key: invoice-{id}-send-{n}` and is logged in
`emailDeliveries`.

## Admin → Billing

Invoices (status/client filters) and Clients tabs. The invoice panel edits draft lines,
lead count (pull or manual), dates; previews the PDF; Finalize, Approve & send, Resend,
Mark paid (Zelle/check/other), Void. All actions are callables in
`functions/billing-api.js` (admin role, App Check).

## Commands

```bash
npm run test:email            # Resend payloads, batch, errors, Svix webhook verification
npm run test:billing          # math, lead pull fallback, PDF/email, emulator state machine
npm run test:billing-browser  # Admin → Billing in Chromium with faked callables
npm run test:rules            # includes billing rules
php integrations/wordpress/bitesites-lead-count/tests/lead-count.test.php
npm run billing:sample        # samples/CAAH_INVOICE_011_sample*.pdf + email HTML (gitignored)
firebase emulators:exec --only firestore --project demo-bitesites "npm run seed:billing"  # emulator only
```

## Before deploy (owner)

1. **Resend:** add and verify `bitesites.org` as a sending domain (SPF/DKIM records in
   Cloudflare DNS; keep the existing MX/DMARC records).
2. **Secrets:** `firebase functions:secrets:set RESEND_API_KEY`,
   `RESEND_WEBHOOK_SECRET` (the endpoint's `whsec_…` value from step 3) and
   `WP_LEADS_SECRET` (≥ 24 random characters). A deploy fails while any is missing.
3. **Resend webhook:** endpoint `https://bitesites.org/api/resend-events`, events
   `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
   `email.complained`, `email.failed`.
4. **Firebase Storage:** confirm the default bucket exists; deploy `storage.rules`.
5. **WordPress:** install the plugin on cliftonaveanimalhospital.com through that site's
   deployment gates, with `BITESITES_LEADS_SECRET` = `WP_LEADS_SECRET` in `wp-config.php`;
   check one month's count against Team View.
6. **Deploy authorization:** functions (removes `recordPostmarkEvent`, adds
   `recordResendEvent` and the billing functions), Firestore rules and indexes, storage
   rules, hosting (the `/api/resend-events` rewrite and the email logo). Then remove the
   Postmark webhook and retire the Postmark secrets.
7. **CAAH record:** in Admin → Billing add Clifton Ave Animal Hospital with its real
   billing email, the four retainer lines, $75/lead, WordPress endpoint
   `https://cliftonaveanimalhospital.com/wp-json/bitesites/v1/lead-count`, manual
   approval, next number 11.
