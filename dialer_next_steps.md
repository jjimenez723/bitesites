# Outbound calling — prompts for every remaining step

The feature is built and tested (555 assertions, 13 suites) but **nothing is
deployed and no call has ever been placed**. Each section below is a
self-contained prompt: paste one into a fresh session (or hand it to an
engineer) and it carries enough context to be actioned without re-reading the
whole codebase.

Run them in order. Steps 1–4 are prerequisites for everything else; steps 5–9
can be parallelised once 4 is done; steps 10–14 are strictly sequential and
gated on human approval.

**Shared context to prepend to any prompt below if the session is fresh:**

> You are working in the BiteSites repository at
> `/Users/maxj/Documents/BiteSites/Bitesites 2` (React 19 + Vite + Firebase,
> project `bitesites-org`). An outbound calling and lead discovery feature was
> recently implemented and is documented in `CAPABILITY_INVENTORY.md`,
> `OUTBOUND_CALLING_SETUP.md`, `LEAD_DISCOVERY_SETUP.md` and
> `WATCHER_MIGRATION.md`. Read the relevant ones before changing anything.
> The feature is not deployed. Never place a live call, never write to
> production data, and never commit a credential.

---

## Phase 1 — Get it running (blocking, in order)

### Step 1 — Inspect the source Firebase project — completed 2026-08-12

> Completed against live Firestore. The source remained read-only; the verified
> collection map and exact counts are recorded in `WATCHER_MIGRATION.md` and
> `CAPABILITY_INVENTORY.md`.
>
> Authenticate and close that gap:
>
> 1. `gcloud auth application-default login` with an account holding
>    `roles/datastore.viewer` on `watcher-leads-89349`.
> 2. Run `node scripts/migrate-watcher-leads.mjs --inspect`.
> 3. Compare the output against the collection table in
>    `CAPABILITY_INVENTORY.md` and the `COLLECTION_MAP` /
>    `EXCLUDED_COLLECTIONS` constants in the migration script.
>
> Report: any collection the live project has that appears in neither the map
> nor the exclusion list (**stop and decide where it belongs before doing
> anything else**); any field present live but absent from the field mapping in
> `WATCHER_MIGRATION.md`; the approximate document count per collection; and the
> destination collision count.
>
> Then update `CAPABILITY_INVENTORY.md` — replace the "Not verified" callout and
> the approximate-count column with real figures, and note the date and the
> project the counts came from.
>
> Do not run `--dry-run` or `--execute` yet. Do not modify the source project.
>
> Done when: `--inspect` runs clean, every live collection is accounted for in
> the map or the exclusion list with a reason, and the inventory no longer
> contains an unverified-count disclaimer.

### Step 2 — Deploy Cloud Functions

> Deploy the outbound Cloud Functions to `bitesites-org`. Functions go **first**,
> before rules and indexes — §49 and `OUTBOUND_CALLING_SETUP.md` both require it,
> because the new Firestore rules assume the callables that own those
> collections' writes already exist.
>
> Before deploying:
>
> 1. `npm run test:all` must pass end to end.
> 2. Set the two secrets that are needed for anything to function at all, even
>    with no provider configured:
>    ```bash
>    firebase functions:secrets:set OUTBOUND_WEBHOOK_SECRET   # generate high-entropy
>    firebase functions:secrets:set DISCOVERY_WORKER_SECRET   # generate high-entropy
>    ```
>    Do not set any provider secret yet — the feature is designed to ship inert.
> 3. Confirm the 27 new exports at the bottom of `functions/index.js` are all
>    re-exported from `functions/outbound-api.js` and none is missing.
>
> Deploy with `npm run deploy:functions`. **Do not use `npm run ship`** — it runs
> `git add .` and deploys hosting and rules but not functions, which is exactly
> the wrong order here.
>
> After deploying, run `firebase functions:list` and record the deployed URLs for
> `recordOutboundCallEvent` and `discoveryWorker`. Add both as Hosting rewrites
> in `firebase.json` (`/api/outbound-events` and `/api/discovery-worker`) so
> providers get stable BiteSites URLs — but do not deploy hosting yet.
>
> Verify: `curl -X GET <recordOutboundCallEvent URL>` returns **405**, and
> `curl -X POST` with no secret returns **503 not-configured** (fail-closed).
>
> Done when: all 27 functions are listed, the two probes return 405 and 503, and
> no existing function (`syncLeadToGoHighLevel`, `recordVoiceCall`,
> `pollVoiceCalls`, the email functions) has been removed or errored.

### Step 3 — Deploy Firestore indexes

> Deploy the 21 new composite indexes in `firestore.indexes.json` to
> `bitesites-org`: `firebase deploy --only firestore:indexes`.
>
> Index builds are asynchronous. Watch the Firestore console until every new
> index reads **Enabled** rather than Building — a query against a still-building
> index fails with `failed-precondition`, which the admin UI surfaces as "That
> query needs a Firestore index that has not been deployed yet".
>
> Each index in the file carries a `"//"` comment naming the module and function
> whose query it backs. Spot-check three of them by finding that call site and
> confirming the field order matches.
>
> Done when: every new index is Enabled, and no pre-existing index was dropped
> (compare against `git show HEAD:firestore.indexes.json`).

### Step 4 — Deploy Firestore rules

> Deploy the updated `firestore.rules` to `bitesites-org`:
> `firebase deploy --only firestore:rules`.
>
> Rules are the actual security boundary for this feature, so verify before and
> after:
>
> 1. `npm run test:rules` — 136 assertions must pass.
> 2. After deploying, confirm in the live app that the **existing** behaviour
>    still works: submit a lead through the public form, open a Bit chat, load
>    the admin Leads and Conversations screens, and load a client-portal project
>    as a client account. Any of these breaking means the new blocks damaged
>    something above them.
>
> The new blocks are: `prospects` (+ `activities`), `outboundCampaigns`
> (+ `events`), `outboundTargets`, `dialerSessions`, `leadResearch`, `scrapeJobs`
> (+ `results`), `importRuns` (+ `errors`), `outboundCallEvents`. All are
> admin-read and effectively server-write; `outboundCallEvents` is closed to
> every client entirely.
>
> Done when: rules are live, the 136 assertions pass against them, and every
> pre-existing flow above still works.

---

## Phase 2 — Prove it works without a phone network

### Step 5 — End-to-end rehearsal on the mock provider

> The whole outbound flow is designed to be rehearsed with no provider, no
> credential and no telephone network. Do that now, in the deployed app, before
> configuring any real provider.
>
> Sign in to `/admin/outbound` as an admin and walk the full path:
>
> 1. **Lead Discovery** — create a job on the `mock` source (any category, any
>    location, 40 results). Run it. Confirm the progress row shows discovered /
>    imported / duplicates / rejected as separate numbers, and that the
>    deliberate near-duplicates the mock source emits are caught.
> 2. **Prospects** — confirm the imported records have E.164 phones, a resolved
>    timezone, and a source badge naming the discovery job. Open one and check
>    the "Where this record came from" block resolves.
> 3. **Import Review** — upload a small CSV (include a quoted comma, an embedded
>    newline, a duplicate row and a row with no phone). Confirm the preview
>    appears **before** any write, the counts are right, and the import button
>    only appears after the preview.
> 4. **Campaigns** — create a `parallel` campaign on the `mock` provider with
>    concurrency 3. Try to switch its provider to `kixie` and confirm the form
>    refuses with a capability explanation. Add ~10 ready prospects.
> 5. **Live Dialer** — start a parallel session, dial, and confirm exactly one
>    leg connects, the others show as cancelled, and the connected leg is
>    unmistakable. Record a disposition; confirm the target resolves and a
>    prospect that "connected" is promoted to a lead.
> 6. **Call Later** — confirm the cancelled legs are back with the reason
>    "A parallel leg won" and their attempt count rolled back.
> 7. **History** — confirm the calls appear with `direction: outbound`, and that
>    **Conversations → Byte · voice → Inbound** still shows the old calls (they
>    have no `direction` field and must still render).
> 8. **Settings** — confirm every real provider reads "Not configured" and names
>    the secrets it wants, and that no secret *value* appears anywhere.
>
> Report anything that behaves differently from the emulator tests. Fix bugs in
> the module, not in the UI — the modules are what the tests cover.
>
> Done when: all eight steps pass in the deployed app, and no pre-existing
> screen regressed.

---

## Phase 3 — Providers (parallelisable after Step 4)

### Step 6 — Verify and enable Google Places

> `functions/providers/lead-sources/google-places.js` is implemented against the
> Places API (New) `places:searchText` contract but has **never been run with a
> real key**. Verify it before enabling it.
>
> Research first, from current official documentation — do not rely on what the
> adapter's comments claim:
>
> - The current field mask syntax and which of the requested fields are billed at
>   which SKU tier. The mask in the adapter is deliberately narrow; confirm every
>   field in it is actually used by `normalize()` and drop any that is not.
> - The **caching and redistribution terms**. These are stricter than most APIs
>   and they directly constrain how long a Places result may live in a
>   `prospects` collection. This is the finding most likely to change the design.
>   Write what you find into `LEAD_DISCOVERY_SETUP.md`.
> - The real pagination ceiling (the adapter assumes 20/page, 3 pages).
>
> Then: create a restricted API key (Places API only, with an application
> restriction), `firebase functions:secrets:set LEAD_SOURCE_API_KEY`, redeploy
> functions, and run one small live job (10 results, a category and town you can
> verify by hand).
>
> Confirm: the results are real businesses, phones normalise to E.164, addresses
> parse into city/region/postcode, the timezone resolves, and duplicates against
> existing prospects are caught.
>
> If the terms prohibit storing results the way `prospects` does, **stop and
> report** rather than proceeding — that is a design decision, not an
> implementation detail.
>
> Done when: a live job completes, the terms question is answered in writing in
> `LEAD_DISCOVERY_SETUP.md`, and the "unverified" warnings in that file and in
> the adapter's header comment are replaced with what was actually confirmed.

### Step 7 — Verify Kixie against a live account

> `functions/providers/calling/kixie.js` reports Kixie as **unable** to run a
> BiteSites-controlled parallel dialer, and `assertSupports('kixie','parallel')`
> refuses to create such a campaign. That conclusion came from Kixie's documented
> automation endpoint plus the working implementation in
> `~/Dialer/functions/kixie.py` — **not from a live account**.
>
> With access to a real Kixie account, verify or refute each capability flag in
> `KixieDialer.capabilities` and each entry in `KixieDialer.limitations`:
>
> - Is the automation API enabled on this plan? (It may need Kixie Support.)
> - Does any documented endpoint **initiate a specific call**, or is
>   `updatepowerlist` really the only write path?
> - Can an individual ringing leg be cancelled?
> - Is there a signed webhook envelope, or only custom headers?
> - Are per-leg call ids present on `answeredcall` / `endcall` / `disposition`?
> - Is PowerList line count configurable 1–5, and by whom?
>
> Capture one real webhook payload of each type (redact PII) and check it against
> `normalizeWebhookEvent` — it accepts both nested
> (`data.powerlistContactDetails.result.extraData`) and flattened shapes; confirm
> which this account sends.
>
> **If a capability turns out to be supported, do not just flip the flag.**
> Implement it, add a test to `functions/outbound-webhook.test.mjs` or
> `functions/outbound-calls.test.mjs`, and only then change `capabilities`. The
> parallel dialer's safety argument depends on `cancelCallLeg` and
> `humanAnswerDetection` being real.
>
> Then configure: the four Kixie secrets, real-time webhooks for `answeredcall`,
> `endcall` and `disposition` pointing at
> `https://bitesites.org/api/outbound-events?provider=kixie` with the header
> `X-BiteSites-Kixie-Secret`, and a PowerList containing **only test numbers you
> control**.
>
> Done when: every capability flag and limitation reflects a verified fact, the
> matrix in `OUTBOUND_CALLING_SETUP.md` matches, and a test PowerList
> preparation reaches `ready` with webhooks returning to the dashboard.

### Step 8 — Set up and verify GoHighLevel outbound Voice AI

> `functions/providers/calling/gohighlevel.js` starts outbound AI calls by
> enrolling a contact in a published workflow. §30 is explicit that the existing
> call-log endpoint cannot initiate calls, and this path has **never been run**.
>
> In the target GHL sub-account:
>
> 1. Private Integration with `contacts.write` and
>    `conversations/message.write`.
> 2. LC Phone or a supported Twilio connection, with number verification and A2P
>    registration complete.
> 3. Outbound Voice AI enabled, terms accepted, KYC done if prompted.
> 4. A published workflow whose **first action** is the Voice AI outbound call.
> 5. Custom fields `bitesites_campaign_id`, `bitesites_target_id`,
>    `bitesites_contact_type` — without these, completion events cannot be matched
>    deterministically and §35 forbids falling back to timestamp proximity.
> 6. `firebase functions:secrets:set GHL_OUTBOUND_WORKFLOW_ID`.
>
> Then verify the two things most likely to be wrong:
>
> - **Contact upsert does not duplicate.** Enrol a contact that already exists in
>   GHL and confirm one contact, not two.
> - **The inbound path is untouched.** Trigger a normal Byte browser voice call
>   and confirm `recordVoiceCall` still handles it, still creates its
>   `byte_voice` lead, and that the outbound normaliser correctly returns `null`
>   for that payload (it has no BiteSites campaign metadata). Then confirm an
>   outbound call does **not** create a duplicate `byte_voice` lead.
> - **DND is honoured.** Set a test contact to DND in GHL and confirm the call is
>   refused before enrolment.
>
> Use a consented test contact you control. Report what the workflow owns that
> BiteSites cannot override — timing, retries, the agent prompt — and whether
> `requireResearchApproval` is sufficient compensation.
>
> Done when: a test contact is enrolled, a call completes, its event returns and
> updates the target and call history, and the inbound path is provably
> unaffected.

### Step 9 — Build the Twilio browser-audio path

> Twilio is the recommended provider for a genuinely BiteSites-controlled
> parallel dialer — it is the only one exposing per-leg SIDs, AMD, a documented
> cancel and real signature validation. `functions/providers/calling/twilio.js`
> implements the REST contract, but **the piece that lets a rep actually hear a
> call does not exist**.
>
> Build the missing pieces:
>
> 1. A **TwiML application** and its voice URL, plus a TwiML endpoint that
>    bridges the winning leg to the rep's browser client. `cancelLosingLegs` in
>    `functions/outbound-calls.js` already cancels the others — the TwiML only
>    has to connect the winner.
> 2. A **Voice SDK access-token endpoint** (a new callable, admin-only,
>    short-lived tokens, identity scoped to the signed-in uid). It must not
>    return the auth token or any long-lived credential.
> 3. Wire `@twilio/voice-sdk` into `src/admin/outbound/DialerControls.jsx` —
>    **lazily imported**, like `firebase/functions` in
>    `src/admin/outbound/data.js`, so it never enters the public marketing
>    bundle. Verify with a build and a grep over `dist/assets/index-*.js`.
> 4. Caller-ID registration and A2P / STIR-SHAKEN attestation on the account.
>
> Keep the first-answer-wins transaction where it is. It is a correctness
> property of BiteSites' own data and must not move into a provider adapter.
>
> Test against the emulator with a mocked Twilio (`fetchImpl` is injectable on
> the adapter) before touching a real account, and extend
> `functions/outbound-webhook.test.mjs` with AMD `AnsweredBy` cases for the real
> payloads you observe.
>
> Done when: a rep can hear a mock-then-real call in the browser, AMD
> distinguishes a human from a greeting on real calls, losing legs are cancelled
> at Twilio, the signature check passes on real webhooks, and the public bundle
> is unchanged.

---

## Phase 4 — Approval gates (sequential, human-blocked)

### Step 10 — Migration dry run and review — completed 2026-08-12

> With Step 1 done and credentials in place, rehearse the Watcher migration.
> Read `WATCHER_MIGRATION.md` first.
>
> ```bash
> node scripts/migrate-watcher-leads.mjs --dry-run --limit 100
> node scripts/migrate-watcher-leads.mjs --dry-run --collection smb_leads
> node scripts/migrate-watcher-leads.mjs --dry-run
> ```
>
> A dry run writes nothing at all, including its own `importRuns` record — that
> is deliberate and it is why a dry run is not resumable.
>
> Review and report:
>
> - The nine counters: scanned, mapped, created, updated, skipped, duplicates,
>   invalid, failed, **airbnbExcluded**.
> - The transformed sample (first 25) — eyeball names, phones, statuses,
>   classifications by hand against the source documents.
> - **A zero Airbnb-exclusion count is suspicious, not reassuring** — if the
>   source has an Airbnb ICP and nothing was excluded, the filter is not running.
> - A high invalid count usually means a field mapping is wrong, not that the
>   data is bad. Investigate before accepting it.
> - Whether any record classified `existing_customer` or `qualified_opportunity`
>   is one the team would be embarrassed to cold-call.
>
> Take a source backup (`gcloud firestore export`) before proceeding further.
>
> Do **not** run `--execute`. Record the run's numbers and hand them to the
> repository owner with an explicit ask for approval.
>
> Done when: dry-run counts are understood and defensible, a source export
> exists, and the numbers are in front of the owner.

### Step 11 — Assemble the compliance review pack

> `OUTBOUND_CALLING_SETUP.md` ends with a 15-item checklist for legal counsel.
> Nothing in this system makes a campaign lawful; the controls only enforce
> settings an administrator configured.
>
> Assemble what counsel needs to actually answer those items:
>
> - The **consent basis** for every list that will be dialled, per source. A
>   scraped number's basis is the question, not a formality.
> - The exact **calling window** defaults and what they are today (09:00–18:00
>   local, weekdays — deliberately tighter than the federal 8am–9pm) and what the
>   business wants them to be.
> - The **disclosure text** the AI agent will actually say, generated by
>   `requiredDisclosures()` in `functions/outbound-compliance.js`. Give counsel
>   the literal strings, not a description of them.
> - The **call scripts** and objection handling.
> - Which **jurisdictions** are in scope, and whether two-party-consent recording
>   states are among them.
> - Whether this constitutes an **ATDS** in those jurisdictions.
> - **Abandoned-call rate limits** for parallel dialing at concurrency 3–5.
> - Data retention for recordings, transcripts and raw scrape payloads (raw
>   payloads currently expire after 7 days; research caches 14 days).
>
> Flag explicitly: **national and state DNC registry scrubbing is not
> implemented.** The internal Do Not Call list is a suppression list, not a
> registry check. If counsel requires registry scrubbing, that is new work — see
> Step 15.
>
> Done when: counsel has signed off, or has returned a list of required changes.
> Record the outcome and the date in `OUTBOUND_CALLING_SETUP.md`, replacing the
> "Legal / compliance review: **Not done**" row in the status table.

### Step 12 — One controlled live test call

> This is the first real telephone call the system will place. It requires
> explicit approval from the repository owner and a signed-off compliance
> position from Step 11.
>
> Set up:
>
> - A campaign containing **exactly one target**: a number you personally
>   control, with recorded consent.
> - `maxAttempts: 1`.
> - `requireResearchApproval: true`, and approve the brief by hand first — read
>   it and confirm every "verified fact" is actually true of that business.
> - The calling window set to right now, so nothing is deferred.
>
> Place the call. Then verify, in this order:
>
> 1. The **disclosures were actually spoken** — AI identity first, recording
>    second. Listen to the recording.
> 2. Say "please don't call me again" mid-call and confirm the agent honours it
>    immediately without arguing.
> 3. The call appears in `calls` with `direction: outbound`, the right operator
>    and dialer mode, a disposition, a duration and a recording URL.
> 4. The transcript is under `calls/{id}/turns` and renders in the console.
> 5. The target resolved to the right state; a retry was or was not scheduled as
>    expected.
> 6. If the outcome was `do_not_call`, the prospect is marked and **every other
>    campaign's target for that person is too**.
> 7. Replay the provider webhook (most consoles have a redeliver button) and
>    confirm nothing changes — no second call record, no doubled transcript.
>
> Report anything the agent said that was not in the approved brief. That is the
> failure mode the whole sourcing design exists to prevent.
>
> Done when: all seven verifications pass, and the recording is reviewed by a
> human who is willing to have that call made to a stranger.

### Step 13 — Deploy hosting

> With functions, indexes and rules live and the flow rehearsed, deploy the
> frontend: `npm run deploy:hosting`.
>
> Before deploying, confirm the public bundle is unaffected:
>
> ```bash
> npm run build
> grep -o "outboundTargets\|dialerSessions\|prospects/" dist/assets/index-*.js
> ```
>
> That must return nothing. The outbound feature lives entirely inside the
> lazily-loaded admin chunk; anything leaking into `index-*.js` means an import
> boundary broke.
>
> Also confirm the `firebase.json` rewrites added in Step 2
> (`/api/outbound-events`, `/api/discovery-worker`) ship with this deploy.
>
> **Note the Cloudflare caveat**: `bitesites.org` is served via Cloudflare, so a
> green `firebase deploy` can still leave the apex domain serving stale content
> for up to 24 hours. Verify against the `*.web.app` URL first, then purge the
> Cloudflare cache and re-check the apex.
>
> Done when: `/admin/outbound` loads on the live domain, the public marketing
> site is byte-identical in behaviour, and both API rewrites respond.

### Step 14 — Production migration — completed 2026-08-12

> **This requires separate, explicit written approval from the repository owner.**
> Do not run it on the strength of this document.
>
> Preconditions, all of which must already be true:
>
> - Step 1 (`--inspect`) done and the collection map verified against live data.
> - Step 10 (`--dry-run`) done, counts reviewed and accepted.
> - A source export exists.
> - Rules and indexes are live (Steps 3–4).
>
> Then:
>
> ```bash
> node scripts/migrate-watcher-leads.mjs --execute
> ```
>
> It will ask you to type `migrate`. Record the run id it prints.
>
> If it is interrupted: `node scripts/migrate-watcher-leads.mjs --resume <runId>`.
> The cursor is persisted after every batch, per collection.
>
> After it completes, verify:
>
> - **Outbound Calls → Import Review → Import runs** shows the run with counts
>   matching the dry run within a reasonable margin (a large divergence means
>   something changed in the source between runs — investigate before accepting).
> - Spot-check 20 migrated prospects against their source documents.
> - No prospect is in a campaign. Migrated records must be non-callable until a
>   campaign explicitly selects them.
> - The Airbnb exclusion count is non-zero and matches the dry run.
> - `leads` is unchanged — check the total count before and after. A single new
>   lead here means the separation broke.
>
> Rollback strategy is a **batch archive**, not a delete: query `prospects` by
> `importRunId` and set `lifecycle.status: 'archived'`, which preserves source
> attribution for audit.
>
> Done when: counts reconcile, spot-checks pass, `leads` is untouched, and the
> run id is recorded in `WATCHER_MIGRATION.md`.

---

## Phase 5 — Known gaps (not blocking launch, but real)

### Step 15 — Implement DNC registry scrubbing

> The internal Do Not Call list is a suppression list. It is **not** a check
> against the national or state DNC registries, and
> `OUTBOUND_CALLING_SETUP.md` says so explicitly rather than implying coverage.
>
> If Step 11 established that registry scrubbing is required:
>
> - Choose a scrubbing provider and read its terms and SLA.
> - Add it as a check inside `evaluateCompliance()` in
>   `functions/outbound-compliance.js` — that function is the single place every
>   caller (the queue view, the power dialer, the parallel dialer, the AI runner)
>   reaches the same verdict from, and a check added anywhere else will be
>   bypassed by one of them.
> - Cache results with an expiry; registries change and a stale pass is worse
>   than no check.
> - Add the reason to `COMPLIANCE_REASON_LABELS` so the queue explains itself.
> - Add tests to `functions/prospect-deduplication.test.mjs` (which owns the
>   compliance cases) covering: on-registry blocks, cache expiry, and provider
>   failure — a scrubbing provider that is down must **fail closed**.
>
> Done when: a target on the registry cannot be dialled by any of the four
> callers, the failure mode is closed rather than open, and the checklist item
> in `OUTBOUND_CALLING_SETUP.md` is ticked.

### Step 16 — Build a real local scraping worker

> `LEAD_DISCOVERY_SETUP.md` documents a local-worker protocol
> (`claim` → `heartbeat` → `submit` → `finish`) and the server side is
> implemented and tested (`functions/lead-discovery.js`, `discoveryWorker` in
> `functions/outbound-api.js`). **No worker exists.**
>
> Build one — a standalone Node script or a Cloud Run job — for sources that
> genuinely need a browser.
>
> Constraints that are not negotiable:
>
> - The worker gets `DISCOVERY_WORKER_SECRET` and nothing else. **No Firestore
>   credentials.** Everything it submits is re-normalised and re-deduplicated
>   server-side; its job is to fetch, not to decide what is stored.
> - Heartbeat at least every 3 minutes or the claim is lost to
>   `recoverStaleJobs`.
> - Submit at most 500 records per call.
> - Records use the flat shape `LeadSourceAdapter.normalize()` returns.
> - Respect robots.txt and the target site's terms. Identify honestly, as
>   `researchContact`'s fetcher already does.
>
> The example client in `LEAD_DISCOVERY_SETUP.md` is the starting point.
>
> Done when: a worker claims a real job, scrapes, submits batches, and finishes;
> killing it mid-run returns the job to the queue within 3 minutes and a second
> worker resumes it.

### Step 17 — Monitoring and alerting

> The feature has no alerting. The existing codebase has a pattern for it —
> `createOperationalAlert()` and `monitorOperations` in `functions/index.js`,
> which write deduplicated `operationalAlerts` records and notify.
>
> Wire the outbound feature into it. The conditions worth waking someone for:
>
> - A campaign in `running` that has started **zero** calls in an hour while
>   having ready targets — usually a provider credential or a calling-window
>   misconfiguration.
> - Provider webhook failures, or webhooks silent for longer than expected while
>   calls are in `dialing`.
> - `reconcileSessions` freeing an unusual number of stale locks — a sign
>   sessions are dying mid-call.
> - A discovery job failing repeatedly, or bouncing between
>   `processing` and `awaiting_local_worker`.
> - An AI campaign slice throwing (currently only logged and stored on the
>   campaign as `lastError`).
>
> Do not alert on: cancelled parallel legs (that is the design working), or
> compliance rejections (that is the guardrail working).
>
> Add a small operational view to **Outbound Calls → Settings** showing the last
> reconcile result and any campaign carrying a `lastError`.
>
> Done when: each condition raises a deduplicated alert, and the two
> non-conditions provably do not.

### Step 18 — Retire the parallel systems

> There are now three places a BiteSites lead can live: this repository's
> `bitesites-org`, the `watcher-leads-89349` project behind `~/Dialer`, and —
> per the note at the end of `FIREBASE_SETUP.md` — a separate Next.js app
> (`../Agency-Intake-Site`) on Cloudflare storing intake in Supabase.
>
> Once the migration (Step 14) is verified, decide and execute the endgame:
>
> - Does the `~/Dialer` dashboard get switched off, or does it keep running for
>   the Airbnb ICP? If it keeps running, confirm nothing in it writes to a
>   collection BiteSites now owns, and that its Kixie/GHL webhooks do not
>   conflict with the BiteSites ones on the same accounts.
> - What happens to the Supabase intake in `Agency-Intake-Site`? Leads split
>   across two backends is the problem `FIREBASE_SETUP.md` already flags, and
>   outbound conversion attribution makes it worse — a prospect promoted here
>   will not see a lead that lives there.
> - Rotate the two `serviceAccount.json` files flagged in
>   `CAPABILITY_INVENTORY.md`. They are correctly git-ignored, but a long-lived
>   key sitting in a file on a laptop is a key that can leak, and the migration
>   no longer needs one.
>
> Done when: there is one authoritative home for a BiteSites lead, the others
> are documented as read-only or retired, and the service-account keys are
> rotated.
