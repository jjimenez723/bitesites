# Production billing cutover — runbook (prepared, NOT run)

Resend replaces Postmark, monthly client invoicing goes live, and Stripe collects
payments bank-first (ACH), card as backup. Pilot client: Clifton Ave Animal Hospital (CAAH).

**Nothing in this file has been run against production.** Every step below is a
production write and needs the owner's explicit authorization for that step
(CLAUDE.md: no production deploy without authorization for that specific action).
The same code was deployed to and proven on staging first; see the integration PR and
`STAGING_ENVIRONMENT.md`.

## Decisions the owner must make first

| Decision | Why it blocks |
|---|---|
| **CAAH's real billing email address(es)** | The CAAH record cannot be created without it. Staging used `jensy@bitesites.org` only. |
| **Go-live date** | The schedule runs 06:00 New York on the 1st. Going live before Dec 1 2026 means the first automatic draft is CAAH #011 for November 2026. |
| **Live Stripe go-live** (`STRIPE_LIVE_MODE_AUTHORIZED=true`) | A live key alone moves no money; this flag is the owner's decision. |
| **Live ACH availability** on the Stripe account | Bank-first Pay Now and bank autopay need ACH Direct Debit active in live mode. |
| **CAAH WordPress plugin install** | Lead counts are manual until the endpoint is live on cliftonaveanimalhospital.com. |

Conventions: every command names `--project bitesites-org` explicitly and runs from a
clean checkout of `main` after the integration PR is merged. Never print a secret: pipe
it (`--data-file -`). Use the Firebase login that has production access.

## 0. Preconditions (read-only checks)

```bash
git checkout main && git pull && git status --short          # clean
npm ci --include=dev && npm --prefix functions ci --include=dev
npm run test:email && npm run test:billing && npm run test:billing-stripe \
  && npm run test:billing-rules && npm run test:rules && npm run test:secrets && npm run build
npm run preflight:production                                  # must pass; prints the policy params
firebase functions:secrets:get RESEND_API_KEY --project bitesites-org   # expect "not found" before step 1
```

Confirm in the Resend dashboard (team `bitesites`) that `bitesites.org` is **Verified**.

## 1. Secrets (production)

| # | Command | Rollback |
|---|---|---|
| 1.1 | `firebase functions:secrets:set RESEND_API_KEY --project bitesites-org --data-file ~/.config/bitesites/resend-api-key.local` | `firebase functions:secrets:destroy RESEND_API_KEY --project bitesites-org` (only before any deploy uses it) |
| 1.2 | `firebase functions:secrets:set WP_LEADS_SECRET --project bitesites-org --data-file ~/.config/bitesites/wp-leads-secret.local` | same, `destroy WP_LEADS_SECRET` |
| 1.3 | `RESEND_WEBHOOK_SECRET` — set in step 4.2 from the live Resend webhook. A deploy fails while it is missing, so either do 4.2 first (the webhook can exist before the function) or set a placeholder now and replace it in 4.2. | `destroy`, or add a new version |
| 1.4 | Live Stripe key (owner decision): `firebase functions:secrets:set STRIPE_SECRET_KEY --project bitesites-org` (paste `sk_live_…` or a restricted `rk_live_…` at the prompt, or `--data-file -` from a pipe) | `firebase functions:secrets:destroy STRIPE_SECRET_KEY --project bitesites-org` → `isStripeConfigured()` goes false; invoices fall back to Zelle/check |
| 1.5 | `STRIPE_WEBHOOK_SECRET` — from step 4.1 | as above |

The functions env for production is `functions/.env.bitesites-org` (untracked, local).
Add, and review in the diff of that file before deploying:

```dotenv
BILLING_SITE_ORIGIN=https://bitesites.org
APP_URL=https://bitesites.org
# Only after the owner authorizes live Stripe (step 3):
STRIPE_LIVE_MODE_AUTHORIZED=true
```

Admin build: `VITE_STRIPE_DASHBOARD_MODE=live` in the production `.env` (dashboard links
only). Rollback: remove the lines; with `STRIPE_LIVE_MODE_AUTHORIZED` absent a live key
is refused and live webhook events are ignored.

## 2. Storage bucket

`storage.rules` is deny-all; invoice PDFs are written by the Admin SDK to the default
bucket. Confirm it exists (staging had none and needed one created):

```bash
gcloud storage buckets list --project bitesites-org --format="value(name)" | grep firebasestorage.app
```

If missing: Firebase console → Storage → Get started (US multi-region or `us-central1`).
No rollback needed; the bucket is empty until the first finalize.

## 3. Live Stripe ACH activation check (owner, dashboard, read-only until approved)

1. Stripe dashboard **live** mode → Settings → Business: account activated, payouts on.
2. Settings → Payment methods: **ACH Direct Debit** available/enabled for the account.
   (The code creates its own two configurations, `BiteSites invoices — bank (ACH) only`
   and `… — card only`, on first live use; the default configuration is untouched.)
3. Settings → Financial Connections: enabled (instant bank verification).
4. Decide go-live → set 1.4 and `STRIPE_LIVE_MODE_AUTHORIZED=true`.

Rollback: destroy the live key (1.4) or remove the flag and redeploy functions.

## 4. Webhooks (live)

### 4.1 Stripe (live mode)

Endpoint `https://bitesites.org/api/stripe-webhook`, events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `payment_intent.succeeded`,
`payment_intent.payment_failed`, `setup_intent.succeeded`, `charge.refunded`,
`payment_method.detached`.

Dashboard (live) → Developers → Webhooks → Add endpoint, or the API with the live key.
Copy the signing secret to the clipboard and pipe it:
`pbpaste | tr -d '\n' | firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project bitesites-org --data-file - && printf '' | pbcopy`

Rollback: disable/delete the endpoint in the dashboard.

### 4.2 Resend

Resend dashboard (team `bitesites`) → Webhooks → Add: `https://bitesites.org/api/resend-events`,
events `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.complained`, `email.failed`. Copy the signing secret →
`pbpaste | tr -d '\n' | firebase functions:secrets:set RESEND_WEBHOOK_SECRET --project bitesites-org --data-file - && printf '' | pbcopy`

Rollback: disable the webhook; the function answers 401 to anything unsigned.

## 5. Deploy

```bash
npm run preflight:production
npm run build
firebase deploy --only firestore:rules,firestore:indexes,storage,functions,hosting --project bitesites-org
```

Expect the CLI to ask to delete `recordPostmarkEvent` (answer yes; Postmark is gone from
the code). Bit/Byte keep `minInstances: 1` in production (`warmInstances`), so the CLI
may ask to confirm the minimum bill — that is the existing production setting, not new.
Read the log, not only the exit code (STAGING_ENVIRONMENT.md: the Artifact Registry
cleanup step can fail after Functions deployed and before Hosting released).

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://bitesites.org/api/stripe-webhook   # 400 invalid-signature (not 404/503)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://bitesites.org/api/resend-events    # 401 (not 404/503)
curl -s -o /dev/null -w '%{http_code}\n' https://bitesites.org/email/bitesites-invoice-logo.png  # 200
```

Then send one Resend test event from the dashboard (→ 200 in Resend's webhook log), and a
Stripe test event is not possible in live mode — wait for the first real one.

Rollback: Hosting → `firebase hosting:clone bitesites-org:live@<previous-version> bitesites-org:live`
(or console → Hosting → release history → Roll back). Functions → check out the previous
`main` commit and `firebase deploy --only functions --project bitesites-org` (Postmark
secrets must still exist for that; do not delete them before step 8). Rules → redeploy
the previous `firestore.rules` the same way.

## 6. Create the real CAAH billing client (Admin → Billing → Clients)

- Name `Clifton Ave Animal Hospital`, address `851 Van Houten Ave, Suite #3, Clifton, 07013`
- Billing email: **the address the owner confirms** (not decided yet)
- Retainer lines: `Monthly SEO Audit` $600, `Ad Campaign Maintenance` $600,
  `Web Maintenance` $400, `Market Research` $200
- $75/lead; approval **manual**; next invoice number **11**
- Lead source: `manual` until step 7 passes, then `wordpress` with endpoint
  `https://www.cliftonaveanimalhospital.com/wp-json/bitesites/v1/lead-count`

Rollback: set the client inactive (the schedule skips inactive clients). Invoice numbers
are never reused, so do not create a test invoice against the real client.

Autopay (optional, client's choice): from an invoice's Payment panel, "Send bank (ACH)
setup link" → email it to the client yourself → autopay turns on when they finish.

## 7. CAAH WordPress lead-count plugin (separate site, separate gates)

Follow `/Users/maxj/Local Sites/cliftonaveanimalhospital1/artifacts/bitesites-lead-billing/INSTALL.md`
exactly (JetBackup restore point first, MU plugin upload, `BITESITES_LEADS_SECRET` in
`wp-config.php` equal to `WP_LEADS_SECRET`). Then in Admin → Billing open a draft and
"Pull lead count"; compare with Team View for the same month. Rollback is in that file
(remove the MU plugin and the constant); BiteSites falls back to manual entry.

## 8. Retire Postmark — only after one week of clean Resend sending

Clean = Resend logs show deliveries for every transactional email type, no unexplained
bounces/complaints, and `emailMessageStatus` updates arriving from `/api/resend-events`.

1. Postmark dashboard: delete the webhook that pointed at the old
   `recordPostmarkEvent` endpoint; then archive the server.
2. Secrets: `firebase functions:secrets:destroy POSTMARK_SERVER_TOKEN --project bitesites-org`
   and `… POSTMARK_WEBHOOK_SECRET …`.
3. DNS (Cloudflare account `300windsorrd@gmail.com`, zone `bitesites.org`): delete the
   `pm-bounces` CNAME and the `…pm._domainkey` TXT (Postmark DKIM). Leave SPF/DKIM for
   Resend, MX, DMARC and every other record untouched (CLOUDFLARE_REDIRECTS.md).

Rollback: re-create the DNS records from a Cloudflare export taken immediately before
step 8.3 (`Export` in the DNS tab — take it), re-add the secrets, redeploy the previous
functions commit.

## 9. After go-live

- Dec 1 2026 06:00 ET: `billingMonthlyInvoices` drafts CAAH #011 (November 2026) and
  emails the admin a review notice. Review lead count → Approve & send.
- Watch: `invoices/{id}.email.lastEvent` (delivered), Stripe dashboard payments,
  `stripeEvents` ledger outcomes.
