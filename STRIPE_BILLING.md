# Stripe billing — autopay and Pay Now for client invoices

Pairs with `feat/resend-invoicing`, which builds the invoice model, PDF, Resend
email and the admin invoicing UI. This branch is only the Stripe side, coded
against the shared contract below. **Nothing is deployed and nothing has run
in live mode.** Every flow below was run end to end in Stripe **test mode**
against the local Functions emulator (see *Verified*).

## Bank first

Monthly retainers are collected by **bank transfer (ACH Direct Debit)** by
default, with card as the alternative.

Stripe Checkout no longer accepts `payment_method_types` as of API
`2026-10-28`, and neither do PaymentIntents. Methods now come from a Payment
Method Configuration. On a page that offers both methods, Checkout lists card
first. So every Checkout here offers exactly **one** method:

| Configuration (created on first use, found by name after) | Enabled | Used for |
|---|---|---|
| `BiteSites invoices — bank (ACH) only` | `us_bank_account` | Pay Now (default), autopay setup (default), charging a saved bank account |
| `BiteSites invoices — card only` | `card` | "Pay by card instead", card autopay setup, charging a saved card |

Every other method is set **off** in both configurations, including Klarna,
Affirm, Cash App and Link. The account's own default configuration is
untouched. To pin specific configurations, set `STRIPE_PMC_BANK` /
`STRIPE_PMC_CARD`.

The bank page uses Financial Connections **instant verification**, and falls
back to **micro-deposits** (`verification_method: 'automatic'`) when the
client's bank isn't supported. If a client cancels either page, the cancel
page offers the other method behind the same link.

## What it does

- **Pay Now.** Every invoice that is not on autopay gets one link,
  `https://bitesites.org/api/pay/{token}`, which opens the bank page. The
  card alternative is the same link plus `?method=card`. Both go in the email
  and the PDF, and neither ever changes.
  - Stripe caps a Checkout Session at 24 hours. When the session behind a link
    has lapsed, the link makes a new one, so a week-old email still works.
  - A paid or void invoice never gets a second checkout.
  - Neither does a bank payment that is still settling, through either link.
  - When one method pays, any open page for the other is expired.
- **Autopay.** The admin sends the client a one-time setup link, which opens a
  bank setup page by default or a card one on request.
  - **Enrollment:** when the client finishes, the webhook saves the Stripe
    customer and payment method and turns autopay on. Bank accounts waiting on
    micro-deposits stay pending until `setup_intent.succeeded`.
  - **Charging:** from then on the invoicing side calls `chargeAutopay` after it
    sends each invoice. The charge is off-session, and the invoice id is the
    idempotency key, so a retried call can't charge twice.
  - **Settling:** a bank debit returns `processing`. The webhook marks the
    invoice `paid` when it settles, or `payment_failed` (with a Pay Now link as
    the fallback) if the bank returns it.
- **Admin panel.** `src/admin/billing/BillingPaymentPanel.jsx` shows payment
  status. It has the **bank link first** ("Pay by bank (ACH) — send this
  link"), the card alternative under it, and regenerate.
  - **Autopay:** "Send bank (ACH) setup link" is the primary button; "Card
    setup link instead" sits beside it, next to the on/off switch.
  - **Charging:** **Charge now** asks for confirmation on the page first.
  - **Dashboard:** every Stripe object links to its page in the Stripe
    dashboard.

## Shared contract

This is fixed: the invoicing side codes against it.

- `billingClients/{clientId}`: `{ name, contactName, billingEmails[], address,
  lineItems, leadRateCents, leadSource, approvalMode, invoiceNumberNext, terms,
  active, autopay: { enabled, stripeCustomerId?, defaultPaymentMethodId?,
  updatedAt? } }`. Only this module writes `autopay`.
- `invoices/{invoiceId}`: `{ clientId, number, issueDate, dueDate, periodStart,
  periodEnd, periodLabel, lineItems[], leadCount, totalCents, currency: 'usd',
  status: 'draft'|'finalized'|'sent'|'paid'|'payment_failed'|'void', autopay,
  payment: { payNowUrl?, stripeCheckoutSessionId?, stripePaymentIntentId?,
  paidAt?, method?: 'stripe'|'zelle'|'check'|'other' }, pdfPath, email,
  createdAt, updatedAt }`. This module owns `payment` and the transitions to
  `paid` and `payment_failed`. `payment.payNowUrl` is always the bank link.

This module also writes some additive, optional fields inside the maps it
owns. Nothing on the invoicing side has to read them:

| Field | Meaning |
|---|---|
| `autopay.pendingSetupIntentId` | A bank account is waiting on micro-deposit verification. Autopay stays off until `setup_intent.succeeded`. |
| `payment.processingAt` | An ACH debit was submitted and is settling. The status is unchanged. |
| `payment.lastError` | Why the last charge failed (set with `payment_failed`). |
| `payment.amountPaidCents` | The amount Stripe actually collected. |
| `payment.refundedCents`, `refundedAt`, `fullyRefunded` | From `charge.refunded`. The status is **not** changed: whether a refunded invoice is void is a bookkeeping call for a person. |
| `payment.duplicatePaymentIntentIds` | A second payment arrived for an invoice that was already paid. The first stays the payment of record; the extra one needs a refund decision. |

## How the invoicing side calls it

```js
// Inside a Cloud Function whose options include `secrets: stripeSecrets`
const billing = await import('./billing-stripe.js').catch(() => null);
if (billing?.isStripeConfigured()) {
  // at finalize, autopay off (a draft being finalized is accepted):
  const { url, cardUrl, sessionId } = await billing.createPayNowLink({ id, ...invoice }, { id: clientId, ...client });
  // after sending, autopay on:
  const { status, paymentIntentId, payNowUrl } = await billing.chargeAutopay({ id, ...invoice }, { id: clientId, ...client });
}
```

- **Both objects need their document `id`.**
- **The calling function must declare the secrets.** `stripeSecrets` (also
  `STRIPE_SECRETS`) is the array the invoicing loader in
  `functions/billing-api.js` already looks for. Without it,
  `isStripeConfigured()` is `false`. That is the safe failure: nothing is
  charged and no link is made.
- **`chargeAutopay` speaks PaymentIntent statuses,** which matches
  `AUTOPAY_RESULT` in the invoicing branch:
  - `succeeded` — paid;
  - `processing` — ACH settling; leave it `sent`;
  - `failed` — declined, needs the client, or not enrolled
    (`reason: 'not_enrolled'`). The invoice is marked `payment_failed` and
    `payNowUrl` is ready.
- **This module sends no email.** Telling the client about a failure is the
  invoicing side's job.
- **Email and PDF copy: bank first.** `payNowOptions(invoice)` returns both
  links in order, with their wording:
  1. **Pay by bank (ACH)** — "Recommended. Connect your bank securely; no card
     fees." This is the primary button.
  2. **Pay by card** — the secondary link.

  `PAYMENT_METHOD_COPY` holds the same strings. On `feat/resend-invoicing`, the
  single "Pay Now" button in `billing-email.js` (and `paymentNotice` in
  `billing-pdf.js`) should render these two in that order. That change belongs
  on the invoicing branch and has **not** been made yet.

## Endpoints

| Name | Kind | Who | What |
|---|---|---|---|
| `createAutopaySetupLink({ clientId, method? })` | callable | admin | Setup-mode Checkout. Bank by default, `method: 'card'` for card. Returns `{ url, sessionId, method, expiresAt }`. |
| `setAutopay({ clientId, enabled })` | callable | admin | Turns autopay on or off. Refuses `on` without a saved payment method. Turning it off keeps the method. |
| `refreshPayNowLink({ invoiceId })` | callable | admin | Expires the link's open sessions and makes a new bank one behind the same URL. |
| `chargeInvoiceNow({ invoiceId })` | callable | admin | The admin's **Charge now**: a deliberate retry with a fresh idempotency key. Refused while an ACH debit is settling or once the invoice is paid. |
| `stripeWebhook` | HTTPS `/api/stripe-webhook` | Stripe | Verifies the signature against the raw body with `STRIPE_WEBHOOK_SECRET`. Idempotent per event id (`stripeEvents/{id}`). |
| `billingPayNow` | HTTPS `/api/pay/{token}[?method=card]` | public | 303 to the open Checkout for that method, a new one, or `/pay/success` / `/pay/cancel`. |

Webhook transitions:

| Event | Effect |
|---|---|
| `checkout.session.completed` (setup) | Saves the customer and method, sets the customer's default, turns autopay on. If the bank account still needs micro-deposits, it records `pendingSetupIntentId` instead. |
| `setup_intent.succeeded` (autopay setup) | Turns autopay on once micro-deposits verify. |
| `checkout.session.completed` (payment) | Sets `paid` if `payment_status` is `paid`. Otherwise (ACH) it records the intent and `processingAt`. |
| `checkout.session.async_payment_succeeded` / `_failed` | ACH from Pay Now settles: `paid` or `payment_failed`. |
| `payment_intent.succeeded` | Sets `paid` (autopay and Pay Now; idempotent). |
| `payment_intent.payment_failed` | Autopay intents only: `payment_failed` plus a Pay Now fallback. A failed attempt inside an open Checkout page is ignored, because the client can retry on the same page. |
| `charge.refunded` | Records the refund fields. The status is unchanged. |
| `payment_method.detached` | Turns autopay off for any client using that method. |

`payment_failed` never overwrites `paid` or `void`. Live-mode events are
recorded and ignored unless live billing is authorized.

Errors are only blamed on the client when they really are the client's.
`chargeAutopay` marks an invoice `payment_failed` on:
- a decline;
- a needed action (such as 3-D Secure);
- an invalid request about the payment method itself: detached, missing, or no
  mandate.

Any other bad request, network error or Stripe error is thrown instead. The
idempotency key makes a retry safe.

## Security

- **`firestore.rules`:** an admin may read `billingClients` and `invoices` and
  edit the invoicing fields. **No browser can:**
  - write `autopay`;
  - write any Stripe payment field;
  - set `status: 'payment_failed'`;
  - mark an invoice `paid` except with a manual method (`zelle`, `check`,
    `other`);
  - reopen a Stripe-paid invoice (it can only be voided);
  - delete anything but a draft.

  `billingPayLinks`, `stripeEvents` and `billingChargeAttempts` are
  server-only. The invoicing branch should keep these `match` blocks as they
  are and not add a second, looser block for the same paths: Firestore ORs
  matching rules.
- **Callables** require the `admin` role and App Check.
- **Live mode needs two things:** a live key, and
  `STRIPE_LIVE_MODE_AUTHORIZED=true` in the functions environment. With only a
  key, `isStripeConfigured()` is false, `getStripe()` throws, and the webhook
  ignores live events.
- **`scripts/check-no-secrets.mjs`** also catches:
  - `sk_test_`, `rk_live_`, `rk_test_` and `whsec_` values;
  - dotenv lines for `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`;
  - any `*.secret.local` file. That's the Functions emulator's secret file,
    and it's also gitignored.

## Fees

Standard US pricing, checked on stripe.com/pricing and
stripe.com/pricing/local-payment-methods on 2026-11-16. The invoice amounts
are illustrative:

| Method | Fee | On $1,000 | On $2,500 |
|---|---|---|---|
| Card | 2.9% + 30¢ | $29.30 | $72.80 |
| ACH Direct Debit | 0.8%, capped at $5.00 | $5.00 | $5.00 |

ACH also carries $4 per failed debit and $15 per dispute. It settles over
several business days at standard timing; a card settles at once. The ACH fee
hits the $5 cap from $625 upward. On a $2,500 monthly invoice, bank saves
about $800 a year against card.

## Verified

### Unit and emulator tests

- `npm run test:billing`: 31 tests against the Firestore emulator, using an
  in-memory Stripe SDK. Webhooks are signed with Stripe's real signing scheme.
  The tests cover:
  - the bank-only and card-only configurations, and that neither Checkout
    sessions nor PaymentIntents send `payment_method_types`;
  - instant verification options;
  - `payNowOptions` order;
  - the card alternative behind the same link;
  - cross-method expiry;
  - errors not blamed on the client;
  - every earlier case: 24-hour re-mint, refresh, idempotency keys, `setAutopay`
    guards, every webhook transition, refunds, detach, duplicates, and live-event
    ignoring.
- `npm run test:billing-rules` (28), the existing `npm run test:rules` (171),
  `npm run test:secrets`, `npm run build`, and
  `npm --prefix functions run check`.

### End to end in Stripe test mode (2026-11-16)

Setup: the BiteSites LLC sandbox, the local Functions emulator, and
`stripe listen` forwarding to `stripeWebhook` with real signatures. Every
forwarded event got a 200.

| Flow | Result |
|---|---|
| Bank autopay setup link → Checkout (bank only, instant + manual) → manual entry `110000000 / 000123456789` | `checkout.session.completed` → autopay **pending verification**. Micro-deposits verified (32, 45) → `setup_intent.succeeded` → autopay **on**, method saved |
| `chargeAutopay` on that bank account | `processing`; invoice stays `sent` → `payment_intent.succeeded` about 15 s later → **paid** |
| Bank account `000111111116` (Stripe's "could not be located" test account) | `processing` → `payment_intent.payment_failed` → **payment_failed**, `lastError` set, Pay Now link generated |
| Pay Now by bank: `/api/pay/{token}` → bank-only Checkout → manual entry | `checkout.session.completed` (unpaid) → processing. Opening the link again, by bank or card, → `/pay/success?status=processing` with no second checkout. Micro-deposits verified → `payment_intent.succeeded` + `async_payment_succeeded` → **paid** |
| Pay Now by card: `/api/pay/{token}?method=card` → card-only Checkout, 4242… | **paid** (`amountPaidCents` recorded). The link afterwards → `/pay/success?status=paid` |

Two problems surfaced in the first test-mode run and are fixed:
- the API no longer accepts `payment_method_types`;
- a bad request was being marked as the client's failure.

The admin panel and the `/pay/*` pages, including the cancel page's "Pay by
card instead", were rendered locally and checked visually.

**Not verified in test mode:**
- Financial Connections instant verification. The test institution's login
  never finished loading in the automated browser, so the manual
  micro-deposit path was used. The Checkout session is configured for
  instant-first; a person should click through it once.
- Anything on a deployed instance. Nothing is deployed.

## Secrets

- **Staging** (`bitesites-outbound-staging`): `STRIPE_SECRET_KEY` (the test key)
  is set, version 1. It was set with the `jensyjimenez723@gmail.com` Firebase
  account, because `jensy@bitesites.org` has no access to that project.
  `STRIPE_WEBHOOK_SECRET` is **not** set. The `stripe listen` secret only works
  for local forwarding; the staging value comes from a webhook endpoint
  registered after a staging deploy.
- **Production** (`bitesites-org`): nothing is set. To set it later, once
  authorized:

  ```bash
  firebase functions:secrets:set STRIPE_SECRET_KEY --project bitesites-org       # sk_live_… (or rk_live_…), after go-live approval
  firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project bitesites-org   # whsec_… from the live endpoint https://bitesites.org/api/stripe-webhook
  # plus, in functions/.env.bitesites-org:  STRIPE_LIVE_MODE_AUTHORIZED=true
  # and for the admin build:                VITE_STRIPE_DASHBOARD_MODE=live
  ```

- **Local:** `functions/.secret.local` (gitignored) holds the test key and the
  `stripe listen` signing secret for the emulator.

## Remaining (in order)

1. **Merge with `feat/resend-invoicing`.**
   - Mount `BillingPaymentPanel` (`invoice`, `client`, `onChange`).
   - Make the email and PDF bank-first using `payNowOptions`, in place of the
     single "Pay Now" button.
   - Reconcile `firestore.rules` for `billingClients` / `invoices`.
   - The invoicing side's `AUTOPAY_RESULT` already maps `succeeded`,
     `processing` and `failed`.
2. **Deploy authorization** for functions, rules and hosting. That's the
   owner's decision, staging included; none has been given.
3. **After a staging deploy:** register
   `https://bitesites-outbound-staging.web.app/api/stripe-webhook` in the
   sandbox with the events in FIREBASE_SETUP.md, and set its signing secret as
   `STRIPE_WEBHOOK_SECRET --project bitesites-outbound-staging`. Then click
   through the instant-verification bank flow once.
4. **Live ACH** (owner decision, not touched):
   - In the live dashboard, confirm the account is activated and that ACH
     Direct Debit is available under Settings → Payment methods. Stripe's
     support article says Standard accounts using PaymentIntents should
     already have it.
   - On first live use the code creates its two configurations in the live
     account. The account's default configuration doesn't need ACH turned on.
   - Then set the production secrets above and register the live webhook
     endpoint.
