# Fine Line CRM integration — agent handoff

Written 2026-08-15, at the end of the session that built the `/admin/crm`
dashboard and the commission → finance sync. Everything below is verified
against the live HighLevel location, not assumed. **Nothing from this work has
been deployed** — the owner explicitly requires approval before any deploy.

## Business context (read this first)

- **The Fine Line Group** is a commission client of BiteSites: BiteSites earns
  **10% of revenue Fine Line actually collects** (§4 of the services
  agreement). The machine-readable contract lives in
  [`functions/accounts.js`](functions/accounts.js) under `fine-line-group` —
  lead protection 365 days, 5-business-day rebuttal, **no authority to quote
  construction prices**, `allowResidentialOutbound: false`.
- BiteSites and Fine Line **share one GoHighLevel sub-account** (location
  `LDL5wuJlnVnqk9vn6taD`). `accountId` in this codebase is the boundary GHL
  doesn't draw. Never blur it.
- A completed prior project (report:
  `~/Desktop/Fine Line Group LLC/FINAL-WORKFLOW-REPORT.md`) built and QA'd the
  HighLevel workflow suite: opportunity auto-naming, stage tagging, lost
  guardrails, referral attribution, and the 10% commission calculation. All
  published workflows are verified working. **Do not edit, republish, or
  "improve" those workflows** without the owner asking for it.
- **Reality check the owner knows:** every opportunity currently in the two
  Fine Line pipelines is a synthetic QA record (`FLG Workflow QA …`). No real
  lead has ever entered. There is **no Fine Line website yet**. The funnel's
  front end (tracked phone number, GBP, funnel page, referral outreach) is the
  actual gap — the automations only fire after a lead exists.

## What was built this session

### 1. `/admin/crm` — read-only HighLevel dashboard (complete, tested)

| File | Role |
|---|---|
| [`functions/flg-crm.js`](functions/flg-crm.js) | HighLevel v2 client (GET-only), sanitizer, snapshot builder, `getFineLineCrm` callable |
| [`functions/flg-crm.test.mjs`](functions/flg-crm.test.mjs) | 16 tests: headers, cursor pagination, 429/5xx retry, timeout abort, token scrubbing, PII stripping, commission math, snapshot filtering |
| [`src/admin/Crm.jsx`](src/admin/Crm.jsx) | The page: pipeline toggle, 4 stat tiles, stage funnel, aging chips, commission panel, filters, detail panel |
| [`src/admin/crm-calculations.js`](src/admin/crm-calculations.js) | Pure derivations (summaries, filters, aging buckets, sorting) |
| [`src/admin/crm-calculations.test.mjs`](src/admin/crm-calculations.test.mjs) | 9 tests over those derivations |
| [`src/admin/crm-api.js`](src/admin/crm-api.js) | Callable wrapper |
| [`src/admin/AdminApp.jsx`](src/admin/AdminApp.jsx) | Nav entry "Fine Line CRM" + admin-only route `crm` |
| [`src/admin/admin.css`](src/admin/admin.css) | `.crm-funnel*` styles (inserted above `.lead-primary-action`) |

Security invariants — **preserve all of these in any future change**:

- All HighLevel calls are server-side. The token is
  `defineSecret('GHL_CRM_DASHBOARD_TOKEN')` — already set in Secret Manager,
  binds at deploy. It is deliberately separate from `GHL_API_TOKEN` (the Voice
  AI poller's token) so either rotates independently.
- The token never appears in: Vite variables, frontend code, Firestore, logs,
  error messages, or test fixtures. The client layer scrubs the token from
  upstream error bodies (`scrub()` in flg-crm.js); tests pin this.
  Verified: `grep -rl leadconnectorhq dist/` and `grep -rl GHL_CRM dist/`
  both return 0 files after `npm run build`.
- The callable requires a signed-in user whose role resolves to `admin`
  (custom claim first, `roles/{uid}` doc second — same order as
  firestore.rules) and enforces App Check. 60s per-instance snapshot cache;
  `{ refresh: true }` bypasses it (the page's Refresh button).
- **Phase one is read-only.** `flg-crm.js` contains no write path to
  HighLevel at all — keep it that way unless the owner explicitly starts
  phase two.
- PII boundary: contact **email, phone, property address, and all note
  fields** are stripped server-side and must never cross into the snapshot.
  Names/company stay (the naming workflows embed them in opportunity titles
  anyway). Two tests assert no PII survives anywhere in the payload.

### 2. Commission → Finance ledger sync (complete, tested)

| File | Role |
|---|---|
| [`functions/flg-commission-sync.js`](functions/flg-commission-sync.js) | `buildCommissionLedgerRows` (pure), `ensureFineLineFinanceAccount`, `runCommissionSync`, `syncFineLineCommissions` (onSchedule, daily 06:30) |
| [`functions/flg-commission-sync.test.mjs`](functions/flg-commission-sync.test.mjs) | 8 tests pinning the ledger rules |

Ledger rules (owner-approved design — do not change casually):

- One deterministic `financeIncome` row per opportunity:
  `flg-commission-<oppId>`, merged on every run (idempotent).
- Rows join `financeAccounts/fine-line-group`, created on first run only if
  absent, **never overwritten** — the finance owner sets allocations in the
  board (they start empty; unallocated revenue is visible there by design).
- `amount` = commission **actually paid** (`flg__bitesites_commission_paid`).
  Due-but-unpaid goes in `expected`/`outstanding` fields + notes, never in
  `amount`, so monthly revenue totals cannot be inflated.
- QA records (`/\bworkflow qa\b|\bflg qa\b/i` on name or contact name) are
  filtered out. First real sync therefore writes ~0 rows today — correct.
- Row month = `flg__last_customer_payment_date`, falling back to
  `lastStageChangeAt`, then `createdAt`.
- Heartbeat: `systemHealth/flg-commission-sync` (status ok/failed + row count).
- GHL stays read-only; this writes Firestore only (Admin SDK bypasses the
  owner-only client rules on finance collections — intended).

### 3. Wiring and docs

- [`functions/index.js`](functions/index.js): two export lines (search
  "Fine Line") — `getFineLineCrm`, `syncFineLineCommissions`.
- [`package.json`](package.json): `test:crm` script (all three test files),
  also appended to `test:all:raw`.
- [`FIREBASE_SETUP.md`](FIREBASE_SETUP.md): "Fine Line CRM dashboard" section.

## Verified live facts (probed 2026-08-15 with the real token)

- Location `LDL5wuJlnVnqk9vn6taD` holds three pipelines; the snapshot filters
  to the two Fine Line ones and must keep doing so:
  - **Client Acquisition** `wGaMTdRFAzIElK5EQUIZ` — 14 stages (New Lead →
    … → Contract Signed → Deposit Received → … → Fully Paid)
  - **Referral Partners** `pAjQijCNlnKNmb70H3ip` — 10 stages (Prospect
    Identified → … → Ongoing Referral Partner)
  - "Marketing Pipeline" `xItJe5znRjNZk1eDOfD0` — **not ours, excluded**.
- 33 opportunities total (26 open / 5 lost / 2 won) — all QA records.
- The full opportunity custom-field catalog is mapped in `FLG_FIELDS` in
  flg-crm.js (that constant is the source of truth — contract/estimate/
  collected amounts, commission rate/due/paid, service requested, referral
  partner fields, loss reason, last customer payment date). Deliberately
  unmapped: property address + all four note fields (PII).
- Commission signal: contact tag `flg - commission due` + the commission
  fields. **Gotcha:** the commission workflow records revenue + rate + tag but
  does **not** populate `flg__bitesites_commission_due` — so the code computes
  collected × rate as fallback, preferring the field when filled. Live QA
  deals show expected $100 / outstanding $100 on $1,000 at 10%, matching the
  workflow report exactly.
- API mechanics: `/opportunities/search` uses `location_id`/`pipeline_id`
  (snake_case), limit max 100, cursor pagination via
  `meta.startAfter`/`startAfterId`; a short page is the end. Custom field
  values arrive as `fieldValueString` / `fieldValueNumber` /
  `fieldValueArray`. Header `Version: 2021-07-28` required.
- Separately, the Voice AI call-log API has silent traps (date params ignored,
  `total` not filter-aware, no sort) — documented in FIREBASE_SETUP.md; does
  not affect the opportunities API but don't assume GHL query params work
  without testing an empty window.

## Test / build evidence

```
npm run test:crm     # 33/33 pass (16 server client/sanitizer, 8 ledger, 9 frontend)
npm run build        # passes (chunk-size warnings pre-date this work)
npm run secrets:check# passes (staged files; add `-- --all` for the whole tree)
```

Also verified once end-to-end: `fetchCrmSnapshot` against the live API returned
both pipelines + 33 sanitized opportunities, with no token and no
email/phone-shaped strings anywhere in the payload.

## Deploy state and the owner's standing rules

- **Not deployed.** When the owner approves:
  `npm run deploy:functions && npm run deploy:hosting` (functions first — the
  page calls a callable that must exist).
- **Never deploy anything without explicit approval.** This has been the rule
  the whole session.
- Do **not** use `npm run ship` casually — it `git add .`'s the entire working
  tree (can sweep unrelated WIP) and deploys rules but **not** functions.
- The apex `bitesites.org` is currently served by a **different** Next.js repo
  via Cloudflare; a green Firebase deploy can still leave the apex stale for
  ~24h. The Firebase site is `bitesites-org.web.app`.
- Current branch: `feat/account-separation`, which already carries unrelated
  in-flight changes (hybrid sideband, outbound calls, byte-web). Don't assume
  a clean tree; don't commit unless asked.

## Open items, in the owner's priority order

1. **Deploy approval** for the callable + sync (owner's call).
2. **Tracked phone number** — owner intends to provide Fine Line's real
   business number as the forwarding destination. Needs: owner buys a local
   number in the GHL sub-account UI (billing action), forwarding + recording +
   whisper configured, a recorded-call disclosure, a workflow dropping callers
   into "New Lead", and the number added to `callerIds` in
   `functions/accounts.js` (which then locks FLG dialing to that number).
3. **Finance allocations** — after first deploy/sync, the finance owner
   (Jensy's two emails in firestore.rules are the only client-side writers)
   should set allocations on `financeAccounts/fine-line-group`.
4. **Email** — Fine Line nurture sequences belong in GHL workflows, gated on a
   Fine Line sending subdomain (SPF/DKIM/DMARC; needs their DNS). **Never**
   send cold outreach through the Postmark stack (transactional only — it
   would torch BiteSites deliverability).
5. **Referral-partner outreach** — the repo's `/admin/outbound` system (built,
   inert) is the intended tool for a human-dialed B2B campaign. Prereqs per
   FIREBASE_SETUP.md: provider credentials, live webhooks, **legal/compliance
   sign-off**, one controlled test call. Hard line the owner has accepted:
   **no AI-voice cold calls** (FCC Feb 2024: AI voices are "artificial" under
   TCPA). AI voice is for inbound answering and consented callbacks only.
6. **QA cleanup (optional)** — the 33 QA opportunities could be deleted in the
   HighLevel UI once the owner no longer wants the reference data; the
   dashboard and sync both tolerate them either way (sync filters them, the
   dashboard shows them). Do not delete via API — this project has no GHL
   write path and should keep none.
7. **Site/funnel** — no Fine Line site exists. A one-page GHL funnel with a
   form posting into "New Lead" is the fastest stand-in.

## How to extend safely

- Adding data to the dashboard: extend `FLG_FIELDS` + `sanitizeOpportunity`,
  add a test asserting the new field, and re-check the PII tests still pass.
- Adding a new HighLevel endpoint: go through `createHighLevelClient`'s `get`
  (it owns auth, retry, timeout, scrubbing). Keep it GET-only.
- Anything that would *write* to HighLevel, message contacts, or auto-dial is
  a scope change requiring the owner's explicit go-ahead — surface it, don't
  build it.
