# Stripe billing — autopay and Pay Now for client invoices

Pairs with `feat/resend-invoicing`, which builds the invoice model, PDF, Resend
email and the admin invoicing UI. This branch is only the Stripe side, coded
against the shared contract below. **Nothing here is deployed, no Stripe
account has been connected, and no real or test charge has been made.**

## What it does

- **Pay Now.** Every invoice that is not on autopay gets one link,
  `https://bitesites.org/api/pay/{token}`. It goes in the invoice email and
  never changes. Opening it sends the client to a Stripe Checkout page for the
  invoice total, paying by card or by US bank account (ACH). Stripe caps a
  Checkout Session at 24 hours, so when the session behind the link has
  lapsed, the link quietly makes a new one. A week-old email still works. A
  paid invoice, a void invoice, or a bank payment that is still settling never
  gets a second checkout.
- **Autopay.** The admin sends the client a one-time setup link (a Checkout
  Session in setup mode, card or ACH). When the client finishes, the webhook
  saves the Stripe customer and payment method on the client and switches
  autopay on. From then on the invoicing side calls `chargeAutopay` after it
  sends each invoice. The charge is made off-session, and the invoice id is the
  idempotency key, so a retried call cannot charge twice. If the charge is
  declined or needs the client (3-D Secure, a closed account), the invoice
  becomes `payment_failed` and a Pay Now link is made as the fallback.
- **Admin panel.** `src/admin/billing/BillingPaymentPanel.jsx` shows payment
  status, the Pay Now link (copy / regenerate), and autopay status (setup link,
  on/off switch). It has **Charge now**, with an inline confirmation, for
  autopay invoices, and links to each Stripe object in the dashboard.

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
  `paid` and `payment_failed`.

Additive, optional fields this module also writes inside the maps it owns.
Nothing on the invoicing side has to read them; the admin panel shows them:

| Field | Meaning |
|---|---|
| `autopay.pendingSetupIntentId` | A bank account is waiting on micro-deposit verification. Autopay stays off until `setup_intent.succeeded`. |
| `payment.processingAt` | An ACH debit was submitted and is settling. The status is unchanged. |
| `payment.lastError` | Why the last charge failed (set with `payment_failed`). |
| `payment.amountPaidCents` | The amount Stripe actually collected. |
| `payment.refundedCents`, `refundedAt`, `fullyRefunded` | From `charge.refunded`. The status is **not** changed: whether a refunded invoice is void is a bookkeeping call for a person. |
| `payment.duplicatePaymentIntentIds` | A second payment arrived for an invoice that was already paid. The first one stays the payment of record. The extra one needs a refund decision. |

## How the invoicing side calls it

```js
// Inside a Cloud Function whose options include `secrets: [...STRIPE_SECRETS]`
const billing = await import('./billing-stripe.js').catch(() => null);
if (billing?.isStripeConfigured()) {
  // at finalize, autopay off:
  const { url, sessionId } = await billing.createPayNowLink({ id, ...invoice }, { id: clientId, ...client });
  // after sending, autopay on:
  const { status, paymentIntentId, payNowUrl } = await billing.chargeAutopay({ id, ...invoice }, { id: clientId, ...client });
}
```

- **Both objects need their document `id`.** The invoice must not be a draft.
- **The calling function must declare the secrets.** Firebase only puts a
  secret into a function's environment when that function lists it.
  `STRIPE_SECRETS` is exported for this. Without it, `isStripeConfigured()`
  returns `false`. That is the safe failure: nothing is charged, and no Pay Now
  link is made.
- `createPayNowLink` returns the stable bitesites.org URL, not the raw Stripe
  URL. It also writes `payment.payNowUrl` and `payment.stripeCheckoutSessionId`
  itself.
- `chargeAutopay` returns one of four statuses: `paid`, `processing` (an ACH
  debit; the webhook settles it in a few business days), `payment_failed`
  (with `payNowUrl`), or `skipped` (autopay isn't enrolled; a Pay Now link was
  made instead and nothing was charged). This module sends **no email**.
  Telling the client about a failed payment is the invoicing side's job, and it
  should use `payNowUrl`.

## Endpoints

| Name | Kind | Who | What |
|---|---|---|---|
| `createAutopaySetupLink({ clientId })` | callable | admin | Setup-mode Checkout (card + ACH). Returns `{ url, sessionId, expiresAt }`. |
| `setAutopay({ clientId, enabled })` | callable | admin | Turns autopay on or off. Refuses `on` unless a payment method is saved. Turning it off keeps the method. |
| `refreshPayNowLink({ invoiceId })` | callable | admin | Expires the current session and makes a new one behind the same URL. |
| `chargeInvoiceNow({ invoiceId })` | callable | admin | The admin's **Charge now**: a deliberate retry with a fresh idempotency key. Refused while an ACH debit is settling or once the invoice is paid. |
| `stripeWebhook` | HTTPS `/api/stripe-webhook` | Stripe | Verifies the signature against the raw body with `STRIPE_WEBHOOK_SECRET`. Idempotent per event id (`stripeEvents/{id}`). |
| `billingPayNow` | HTTPS `/api/pay/{token}` | public | 303 to the open Checkout, a new one, or `/pay/success` / `/pay/cancel`. |

Webhook transitions:

| Event | Effect |
|---|---|
| `checkout.session.completed` (setup) | Saves the customer and method, sets the customer's default, turns autopay on. If the bank still needs verification, it records `pendingSetupIntentId` instead. |
| `setup_intent.succeeded` (autopay setup) | Turns autopay on once micro-deposits verify. |
| `checkout.session.completed` (payment) | `paid` if `payment_status` is `paid`. Otherwise (ACH) it records the intent plus `processingAt`. |
| `checkout.session.async_payment_succeeded` / `_failed` | ACH from Pay Now settles: `paid` or `payment_failed`. |
| `payment_intent.succeeded` | `paid` (for both autopay and Pay Now; idempotent). |
| `payment_intent.payment_failed` | Autopay intents only: `payment_failed` and a Pay Now fallback. A failed attempt inside an open Checkout page is ignored, because the client can try another card on the same page. |
| `charge.refunded` | Records the refund fields. The status is unchanged. |
| `payment_method.detached` | Turns autopay off for any client using that method. |

`payment_failed` never overwrites `paid` or `void`. Live-mode events are
recorded and ignored unless live billing is authorized.

## Security

- `firestore.rules`: an admin may read `billingClients` and `invoices` and edit
  the invoicing fields. **No browser can:**
  - write `autopay`;
  - write any Stripe payment field;
  - set `status: 'payment_failed'`;
  - mark an invoice `paid` except with a manual method (`zelle`, `check`,
    `other`);
  - reopen a Stripe-paid invoice (it can only be voided);
  - delete anything but a draft.

  `billingPayLinks`, `stripeEvents` and `billingChargeAttempts` are server-only.
  The invoicing branch should keep these `match` blocks as they are rather
  than add a second, looser block for the same paths, because Firestore ORs
  matching rules.
- Callables require the `admin` role and App Check.
- Live mode needs **two** things: a live key, and `STRIPE_LIVE_MODE_AUTHORIZED=true`
  in the functions environment. With only a key, `isStripeConfigured()` is
  false, `getStripe()` throws, and the webhook ignores live events.
- `scripts/check-no-secrets.mjs` now also catches `sk_test_`, `rk_live_`,
  `rk_test_` and `whsec_` values, plus dotenv lines for `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET`.

## Fees, and the recommendation for monthly retainer clients

Standard US pricing, checked on stripe.com/pricing and
stripe.com/pricing/local-payment-methods on 2026-11-16. Example invoice
amounts are illustrative:

| Method | Fee | On $1,000 | On $2,500 |
|---|---|---|---|
| Card | 2.9% + 30¢ | $29.30 | $72.80 |
| ACH Direct Debit | 0.8%, capped at $5.00 | $5.00 | $5.00 |

ACH also carries $4 per failed debit and $15 per dispute, and it settles over
several business days (standard timing), where a card settles at once.

**Recommendation:** for monthly retainer invoices of roughly $1,000 or more,
ask the client to enroll autopay with a **bank account (ACH)**. The fee hits
the $5 cap from $625 upward, so on a $2,500 invoice the client saves about
$800 a year compared with a card. The slower settlement doesn't matter for a
monthly retainer. Both card and ACH stay available on every link, so a card
still works as the fallback. Stripe Checkout shows bank account as a payment
option, but it doesn't steer the client toward it, so say so in the setup
email.

## Verified

- `npm run test:billing`: 25 tests run against the Firestore emulator with an
  in-memory Stripe SDK. They cover:
  - Pay Now creation and reuse;
  - the 24-hour expiry with a stable URL;
  - refresh;
  - autopay paid, processing, `requires_action`, decline, not enrolled;
  - the idempotency key equalling the invoice id;
  - the retry key;
  - `setAutopay` guards;
  - setup links;
  - every webhook transition above, signed with Stripe's real signing scheme
    (bad signature and tampered body are rejected; redelivery is a no-op);
  - duplicate-payment flagging, refunds, detach, and live-event ignoring.
- `npm run test:billing-rules`: 28 rule assertions.
- `npm run test:secrets`, `npm run build`, `npm --prefix functions run check`.
- The admin panel and `/pay/*` pages were rendered locally (Vite dev, fixture
  props) and checked visually.

**Not verified:** there have been no calls to Stripe in any mode. When this was
built, Chrome was not signed in to a Stripe dashboard. The Stripe CLI's saved
`BiteSites LLC` test key expired on 2026-09-19. The Firebase CLI's login is
also expired, so the secrets aren't set either.

## Remaining blockers (in order)

1. **Stripe test access.** Sign in to the BiteSites Stripe account in Chrome,
   or run `stripe login --project-name="BiteSites LLC"`. In **test mode**,
   confirm that ACH Direct Debit is enabled under Settings → Payment methods.
   Checkout refuses `us_bank_account` if it isn't.
2. **Firebase CLI login** (`firebase login --reauth`), then
   `firebase functions:secrets:set STRIPE_SECRET_KEY` with the test key.
3. **An end-to-end test-mode run.** Use `stripe listen --forward-to` against the
   functions emulator, a test card (4242…), a test bank account (Stripe's test
   routing number), and a micro-deposit account. Compare the result with the
   tests above.
4. **Merge with `feat/resend-invoicing`.** It mounts `BillingPaymentPanel` on the
   invoice detail page, calls `createPayNowLink` / `chargeAutopay`, declares
   `STRIPE_SECRETS` on those functions, and reconciles any `firestore.rules`
   blocks for `billingClients` / `invoices`.
5. **Deploy authorization** for functions, rules and hosting. That is the
   owner's decision, and it hasn't been given.
6. **After deploy:** register `https://bitesites.org/api/stripe-webhook` with
   the events listed in FIREBASE_SETUP.md, then set `STRIPE_WEBHOOK_SECRET`
   from that endpoint.
7. **Go-live (owner decision):** a live key, `STRIPE_LIVE_MODE_AUTHORIZED=true`,
   `VITE_STRIPE_DASHBOARD_MODE=live`, and the live webhook endpoint registered
   separately.
