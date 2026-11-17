# Billing: monthly client invoicing and Resend email

Branch `feat/billing-integration` (merges `feat/resend-invoicing` and
`feat/stripe-autopay`). Pilot client: Clifton Ave Animal Hospital (CAAH). Stripe
collection is in [STRIPE_BILLING.md](STRIPE_BILLING.md); the production steps are in
[PRODUCTION_BILLING_CUTOVER.md](PRODUCTION_BILLING_CUTOVER.md).

## Status — what is true today

**Implemented and tested locally (code only):**

- All email goes through Resend (`functions/email.js` → `sendResend`); Postmark is gone
  from the code. Delivery webhooks arrive at `/api/resend-events` (`recordResendEvent`),
  verified with Svix signatures.
- `billingClients` / `invoices` data model and one strict rule block per collection:
  admins read, Cloud Functions write; the only browser write is an admin recording a
  manual Zelle/check/other payment on an issued invoice (`npm run test:billing-rules`).
  Two composite indexes, a deny-all `storage.rules`.
- Monthly cycle (`billingMonthlyInvoices`, 06:00 America/New_York on the 1st), per-client
  sequential numbering, lead count pulled from WordPress with manual override,
  server-side PDF matching the CAAH #011 foundation, invoice email with the PDF attached,
  Admin → Billing screen.
- WordPress plugin source in `integrations/wordpress/bitesites-lead-count/`.

**Deployed to staging and proven end to end (2026-11-16)** — `bitesites-outbound-staging`,
Stripe test mode, real Resend sending to `jensy@bitesites.org` only, real Stripe and
Resend webhooks. `bitesites.org` is verified in Resend. Results:

| Flow (staging, Stripe test mode, real webhooks) | Result |
|---|---|
| Admin → Billing: add client "CAAH (staging test)", 4 retainer lines, $75/lead, manual approval, next #11 | Saved; `#011` next |
| Create November 2026 draft → lead count 12 (fake) → Save → Finalize → Send | `#011` $2,700; PDF stored in Storage with bank + card links on the staging origin; email to `jensy@bitesites.org` only |
| Resend delivery | Resend log: sent → delivered; `/api/resend-events` (Svix-verified) set `email.lastEvent = delivered` |
| Pay Now by bank → **Financial Connections instant login** (test institution "Test (OAuth)", account "Success") → Pay | `checkout.session.completed` → processing → `payment_intent.succeeded` + `async_payment_succeeded` → **paid** (~17 s); link afterwards → `/pay/success?status=paid` |
| Bank autopay setup link (from the Payment panel) → instant login → Success account | `checkout.session.completed` + `setup_intent.succeeded` → autopay **on** |
| September draft `#012` → Send (autopay) | charge `processing` → `payment_intent.succeeded` → **paid** |
| New setup link → "Insufficient Funds" account → August `#013` → Send | `payment_intent.payment_failed` → **payment_failed**, `lastError` set, Pay Now fallback link minted; Resend re-renders the PDF with bank/card links and no autopay promise; bank and card links redirect to Checkout |
| `billingMonthlyInvoices` run twice via Cloud Scheduler | Run 1: created exactly one draft (`#014`, October, awaiting lead count) + review notice; run 2: `existing`, nothing created, numbering unchanged |

Known gaps: the "Test (Non-OAuth)" institution's login spinner never finished in
Chrome (twice); the OAuth test institution worked end to end, so instant
verification is proven but that one test bank is not. The invoice email logo
points at `https://bitesites.org/email/…`, which only exists after a production
Hosting deploy, so staging mail shows a broken logo.

**Not done — production (see PRODUCTION_BILLING_CUTOVER.md):** nothing is deployed to
`bitesites-org` and no production secret is set; the WordPress plugin is not installed
on cliftonaveanimalhospital.com; the real CAAH billing client (with its real billing
email) does not exist; Postmark is still configured in production.

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

At finalize/send, `functions/billing-core.js` loads `functions/billing-stripe.js`. If
`isStripeConfigured()` is false (no key bound, or a live key without
`STRIPE_LIVE_MODE_AUTHORIZED`) invoices still work: no Pay Now button, Zelle/check only.
An import failure is surfaced rather than silently dropping online payments.

- Autopay off → `createPayNowLink(invoice, client)` before the PDF is rendered;
  `{ url, sessionId }` → `payment.payNowUrl` (the stable `{BILLING_SITE_ORIGIN}/api/pay/{token}`
  link), `payment.stripeCheckoutSessionId`. The PDF and email render it bank first
  via `payNowOptions` (`functions/billing-pay-options.js`): **Pay by bank (ACH)**
  primary, **Pay by card** (`?method=card`) secondary.
- Autopay on → no link; the PDF and email say "Autopay enabled — your card on file will
  be charged on {date}." ({date} is the issue date, or the finalize date if later; stored
  as `autopayChargeDate`.) After the first send, `chargeAutopay(invoice, client)`;
  `succeeded` → `paid` (method `stripe`), `processing` → stays `sent` until the webhook
  settles it, anything else → `payment_failed` with a Pay Now fallback link. Re-sending a
  `payment_failed` invoice re-renders the PDF, so it carries the Pay Now options instead
  of the autopay promise.
- `functions/billing-api.js` imports `stripeSecrets` statically and binds them to
  finalize, send and the monthly job.
- UI: `src/admin/billing/BillingPaymentPanel.jsx` is mounted on every invoice as
  `<BillingPaymentPanel invoice client onChange />` behind an error boundary. Payment
  status changes made by Stripe webhooks are the Stripe side's to write.

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

**Each invoice bills exactly its own month.** A month is midnight on the 1st to midnight
on the next 1st, New York time (DST-correct), so consecutive invoices touch end to end
with no overlap and no gap. Three guards keep it that way:

- One invoice per client per month (id `{clientId}_{YYYY-MM}`); re-runs return the
  existing draft and never pull again.
- A month can't be drafted until it is over in New York (`failed-precondition`
  otherwise), so a count is never taken from an unfinished month.
- BiteSites rejects a count unless the plugin reports `timezone: America/New_York`
  (plugin v1.1+). v1.0 split months at the site clock (UTC on CAAH), which moved leads
  from the last evening of a month into the next.

Pull failures say what to fix (key mismatch, header stripped, plugin inactive, key not
set on the site, timeout, redirect, non-JSON response, old plugin) — see
`describeLeadCountError` in `functions/billing-leads.js`.

## PDF and email

`functions/billing-pdf.js` (pdfkit) reproduces the foundation: Letter, Montserrat
(bundled under `functions/billing-assets/fonts/`, SIL OFL), the repo's BiteSites logo,
issuer block, `INVOICE #011`, BILLED TO / ADDRESS / DATE, the three-column table and the
right-aligned "Payable to" block with Zelle, checks and terms. Added: a row of two
clickable buttons between the table and "Payable to" — **Pay by bank (ACH)** (filled)
and **Pay by card** (outlined) — when autopay is off and a link exists, or the autopay
notice; a "Due by" line; DRAFT/VOID watermarks. Totals print with a thousands separator (`$2,700`).

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
`functions/billing-api.js` (admin role; App Check enforced everywhere except a
`staging` deploy, whose frontend has no App Check key). The Payment panel below the
invoice (Stripe) shows the bank and card Pay Now links, autopay setup links, autopay
on/off and "Charge now".

## Commands

```bash
npm run test:email            # Resend payloads, batch, errors, Svix webhook verification
npm run test:billing          # math, lead pull fallback, PDF/email, emulator state machine
npm run test:billing-stripe   # Stripe autopay/Pay Now/webhook → Firestore, fake Stripe SDK
npm run test:billing-rules    # billing rules: admins read; only manual mark-paid from a browser
npm run test:billing-browser  # Admin → Billing in Chromium with faked callables
npm run test:rules            # includes billing rules
php integrations/wordpress/bitesites-lead-count/tests/lead-count.test.php
npm run billing:sample        # samples/CAAH_INVOICE_011_sample*.pdf + email HTML (gitignored)
firebase emulators:exec --only firestore --project demo-bitesites "npm run seed:billing"  # emulator only
```

## Before deploy (owner)

The ordered, production-specific version of this list (with rollback for each step) is
[PRODUCTION_BILLING_CUTOVER.md](PRODUCTION_BILLING_CUTOVER.md). Steps 1–3 and the
Storage bucket were done for **staging** on 2026-11-16; none were done for production.

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
