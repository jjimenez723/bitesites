# Outbound completion — progress log

Working document for `OUTBOUND_COMPLETION_GOAL_SPEC.md`. One short entry per
checkpoint: what changed, what proves it, what is left, and who is blocking.

**Branch:** `feat/outbound-readiness-closeout`
**Baseline commit:** `925697f9b62711decaf46c37d4e76e9b5026d060` (`main`)

Unrelated uncommitted work was present on `main` at branch time and is being
left alone: admin-UI accessibility edits across `src/admin/` plus the untracked
`src/admin/row-activate.js`, and a `.claude/settings.json` permission entry.
None of it is committed by this workstream.

---

## Checkpoint 0 — baseline

**Changes:** Branch created. No code touched yet.

**Evidence:** `npm run test:all` run from the pre-existing `node_modules` on a
machine where the Firebase CLI happens to be installed globally
(`/opt/homebrew/bin/firebase`). Result recorded in checkpoint 1.

**Findings that set the work up:**

- `firebase` is not a dependency of any of the three packages, but 20 of the
  test scripts invoke `firebase emulators:exec`. CI installs only from the
  lockfiles, so `Outbound AI CI` fails at the first emulator test with
  `firebase: not found`. This is an environment failure, not an application
  failure — the suite has never reached a verdict in CI.
- No outstanding work claims anywhere in the repo (the greppable marker
  CLAUDE.md defines returned nothing); no other agent's work is in flight.

**Remaining:** milestones 1–8.

**Blockers:** none at this checkpoint.

---

## Checkpoint 1 — CI and repository guardrails (milestone 1)

**Changes:**

- `firebase-tools@15.28.1` pinned as a root devDependency. Twenty test scripts
  shell out to `firebase emulators:exec`; nothing installed it. The CLI now
  resolves from `node_modules/.bin` on every machine that ran `npm ci`, and CI
  asserts that with `npx --no-install firebase --version` before the suite.
- `actions/setup-java@v4` (Temurin 17) added to the workflow. The Firestore and
  Auth emulators are Java programs; the runner image supplies a JDK today, and
  a pinned one means the suite does not start failing the week it stops.
- npm caching keyed on all three lockfiles; job timeout raised 30 → 45 minutes.
- An owner-action note at the top of the workflow: branch protection and a
  required `Outbound AI CI / validate` check. Repository settings were **not**
  changed — that needs the owner.
- Dependency vulnerabilities resolved to zero across all three packages via
  scoped `overrides` (`teeny-request > uuid`, `gaxios > uuid`,
  `@google-cloud/pubsub > @opentelemetry/core`). Scoped rather than global on
  purpose: a bare `uuid` override also downgrades `universal-analytics`, which
  wants a newer major than the advisory floor. `npm audit fix --force` was
  **not** used — it proposes downgrading `firebase-admin` 14 → 10 and
  `firebase-functions` 7 → 4, which is a larger break than the moderate
  advisory it closes.
- Secret scanner extended to the credential families this repository actually
  holds: Google API keys, Google OAuth refresh tokens, JWTs and HighLevel
  `pit-` tokens, Twilio account/API-key SIDs, and dotenv-shaped assignments of
  any secret name the repo owns. Two rules make it usable rather than noisy —
  an entropy filter, so `ACaaaa…` in an existing signature fixture is not a
  finding, and a path exemption for `src/`, where the Firebase web config and
  reCAPTCHA site key are public by design.

**Evidence** (clean install, this branch):

```
npm ci; npm --prefix functions ci; npm --prefix services/realtime-sideband ci
npx --no-install firebase --version   → 15.28.1
npm run secrets:check -- --all        → 352 tracked files scanned, passed
npm run test:all                      → 381 node:test assertions, 0 failed;
                                        16 emulator suites, 0 failed
npm --prefix functions run check      → passed
npm --prefix services/realtime-sideband run check → passed
exit 0
```

`npm run test:secrets` covers the new rules with 15 assertions, including that
a finding never carries the matched value into a log.

`npm audit` → 0 vulnerabilities in root, `functions/`, and
`services/realtime-sideband/`.

**Remaining:** milestones 2–8.

**Blockers:** branch protection is an owner action; nothing here is blocked on
it.

---

## Checkpoint 2 — CRM reading and the no-dial audit (milestones 3, 4, 5)

**Changes:**

- `functions/providers/lead-sources/gohighlevel-contacts.js` — a read-only
  GoHighLevel contact source. Its own secret (`GHL_CONTACTS_READ_TOKEN`, scoped
  `contacts.readonly`), a one-entry endpoint allow-list that throws on every
  write/enrolment path, bounded pagination with retry/backoff on 429 and 5xx,
  per-request timeouts, a hard record cap that reports itself truncated, and a
  refusal to normalise a contact from another GoHighLevel location.
- `functions/outbound-eligibility-audit.js` — the audit. It **calls** the
  dialer's gates rather than restating them, then adds the ones
  `evaluateCompliance` cannot see (account alignment, research approval,
  campaign safety lock, provider capability, deployment admission), so it can
  only ever be stricter. Five outcome classes, thirteen blocker buckets,
  per-record verdicts with masked numbers and stable ids, masked CSV export.
- `runOutboundEligibilityAudit` callable, admin-gated, with the CRM read
  narrowed to owner/admin — a bulk read of the shared sub-account is a
  different privilege from a report about records BiteSites already holds.
- `src/admin/outbound/EligibilityAudit.jsx` + its own stylesheet, and a new
  Eligibility Audit tab under Admin.
- `prospects` gained `gohighlevel` as a source system and
  `source.recordCreatedAt` / `source.recordUpdatedAt`. A CRM contact recorded
  as `scraper` was a provenance lie, and `importedAt` cannot distinguish a
  contact edited last week from one untouched since 2019.
- `outboundEligibilityAudits` Firestore rules: readable by the seller's
  operators, written only by the server.

**Evidence:**

```
npm run test:ghl-contacts       → 20 assertions, 0 failed
npm run test:eligibility-audit  → 69 assertions, 0 failed
npm run test:rules              → 161 assertions, 0 failed (158 before)
npm run test:prospects/dedupe/migration/crm → 94 assertions, 0 failed
npm run build                   → ok
npm --prefix functions run check → ok
```

The audit tests assert the things that would be easy to get quietly wrong:

- every reason the dialer would give appears in the audit's reasons, and the
  audit never reports a record eligible that `evaluateCompliance` refuses;
- running the audit issues no grant, clears no screening, creates no research
  brief, imports nothing, starts no session, and leaves every target's state
  and attempt count untouched;
- the only GoHighLevel request made is `POST /contacts/search`;
- a CRM field saying `consent_basis: written_opt_in` produces
  `basis: 'not_recorded'` and an empty grant id;
- GoHighLevel `aiAgentCall` is still `false`, external dialing still defaults
  to disabled, and staging stays non-dialing with the flag misconfigured;
- no unmasked phone number appears in the report, the CSV, or the stored
  summary.

**Expected current result, confirmed:** a Watcher-style prospect with no
seller- and number-bound grant is `evidence_missing`, and auditing it cannot
create the grant that would change that.

**Remaining:** milestones 2, 6, 7, 8.

**Blockers:** `GHL_CONTACTS_READ_TOKEN` does not exist yet — creating the
read-only Private Integration in GoHighLevel is an owner action. Until then
the audit runs over Firestore scopes and refuses the CRM scope with a
`failed-precondition` naming the secret.

---

## Checkpoint 3 — the live-model path, built and guarded (milestone 6)

**Changes:**

- `scripts/conversation-eval-model-adapter.mjs` fills the seam
  `runAdversarialConversationEvaluation({ enableLiveModel: true })` has always
  had and nothing has ever occupied. It replays the corpus's adversarial
  *prospect* turns at a real model, using the compiled seller runtime as
  instructions and the sideband's own `TOOL_SCHEMAS`, and feeds the fixture's
  own tool results back so the booking-truthfulness checks still bite.
  In `scripts/` rather than `functions/` deliberately — `conversation-evals.js`
  says in its header that it contains no OpenAI client, and putting one in the
  deployed bundle beside the dialer would undo that.
- Admission requires three independent things: `--live`, `OPENAI_API_KEY`, and
  `CONVERSATION_EVAL_LIVE_RUN=authorized`. Two of three is a refusal, and a
  near-miss value (`enabled`, `true`, `authorized-later`) is a refusal. The
  refusal prints the preflight so the reader learns what it would have cost.
- `npm run preflight:conversation-evals` — model, sellers, request count, token
  estimates, output path, and the authorizations required. It refuses to invent
  a dollar total: supply `--input-rate`/`--output-rate` and it does the
  arithmetic, otherwise it reports the inputs and says why.
- `evaluateConversationQualityGate` computes the thresholds the readiness plan
  states in prose — 0 critical failures, ≥95% rubric quality, ≥98%
  qualification precision, 100% grounding — with the definition of each metric
  written down beside it. Every report now carries a `qualityGate` block, and a
  fixture run reports `meaningful: false` / `not_conversational_evidence` so a
  green fixture report cannot be waved at the gate.
- The corpus and its four negative controls are unchanged, and a test asserts
  the counts (1,036 / 28 / 4) so a refactor cannot quietly shrink the evidence.

**Evidence:**

```
npm run test:conversation-adapter → 27 assertions, 0 failed
npm run test:conversation-evals   →  6 assertions, 0 failed
npm run test:conversation-corpus  →  5 assertions, 0 failed
npm run test:agent-runtime        → 48 assertions, 0 failed
npm run preflight:conversation-evals → 1,036 scenarios, ~3,851 requests,
                                       ~11.6M prompt tokens, cost withheld
node scripts/evaluate-conversations.mjs --live → exit 2, refused
```

**Remaining:** milestones 2 (partly done), 7, 8.

**Blockers:** the live evaluation has **not been run** and must not be under
this goal. It needs an owner decision to spend, now recorded as item 10 of
`OUTBOUND_LAUNCH_AUTHORIZATION.md`. Note also that the adapter is a text
rehearsal; production speech is realtime audio, so even an authorized green run
is necessary and not sufficient for the conversational gate.

---

## Checkpoint 4 — documents reconciled, and one finding (milestone 2)

**Finding, and it is the important part of this checkpoint.**
`functions/.env.bitesites-org` — untracked, local, and read by every
`firebase deploy --only functions` — contains `OUTBOUND_EXTERNAL_DIALING=enabled`
alongside `BITESITES_DEPLOYMENT_ENVIRONMENT=production`. Together those are the
two conditions `resolveOutboundDeploymentPolicy` requires to admit a
carrier-backed call.

What is and is not true about that:

- **Nothing is live.** The deployed production functions predate the parameter
  entirely, and every campaign is paused. Even with the deployment gate open, a
  call still needs a consent grant, a fresh screening and a running campaign —
  none of which exist. (The caller ID is not missing: `+12015524949` is
  provisioned and registered in `accounts.js`. The carrier-side verified
  identity and STIR/SHAKEN attestation are what remain, and those are a
  different thing.)
- **Nothing in this repository put it there.** `scripts/staging.mjs` writes
  `disabled` and cannot target production; no other script writes that file.
- **A production Functions deploy from that machine would have carried it**,
  and no diff, review, or CI run would have shown it.

The value was **not changed**. It is the owner's local environment, it was set
deliberately by someone, and silently flipping a deploy-time policy flag is the
same class of unreviewed change that created the problem. What was added
instead is the check that would have caught it:

- `scripts/production-preflight.mjs` + `npm run preflight:production` — reads
  the production dotenv, prints the three policy parameters, and exits non-zero
  when one is open without its matching authorization
  (`OUTBOUND_CANARY_AUTHORIZATION`, `PAID_SCREENING_AUTHORIZATION`). Same shape
  as `screeningAdmission`: a flag alone is never enough. 10 assertions, wired
  into `npm run test:staging-infra`.

**Document changes:**

- `OUTBOUND_OWNER_CHECKLIST.md` — new. Six stages on one page: engineering
  complete, staging verified, production deployed-but-disabled, internal
  rehearsal, external canary, wider rollout. Each with its evidence, its
  decider, and its honest current state. Linked from CLAUDE.md and both
  outbound documents.
- `STAGING_ENVIRONMENT.md` — the "Decisions still required" section listed
  billing and staging deployment, both granted and completed on 2026-08-24. It
  now lists what is actually open (rollback never rehearsed, the Twilio
  subaccount question, calendar test identities) and says plainly that
  approving any of them approves nothing about production. The duplicated
  deploy-trap section is gone, and the `PAID_PHONE_SCREENING` warning was
  stale — the key has since been added to the production dotenv.
- `OUTBOUND_CALLING_SETUP.md` — the status table said rules and Functions were
  "not deployed"; they are deployed to staging and not to production, and it
  now says which. The capability matrix advertised GoHighLevel **AI agent
  calls ✅**; that has been `false` in code since the provider control was
  added, and the footnote now explains why. The DNC checklist line said
  "not implemented" when what is missing is a procured vendor, not code.
- `OUTBOUND_PRODUCTION_READINESS.md` — the duplicated conversational-evaluation
  paragraph is gone; the deployment sequence gained the production preflight as
  a numbered step; the finding above is recorded at the top.
- `OUTBOUND_LAUNCH_AUTHORIZATION.md` — the duplicated half of §3 is gone, and
  §10 records the live-model evaluation spend as its own decision.

**Evidence:** `npm run test:staging-infra` → 17 assertions, 0 failed.

**Remaining:** milestones 7, 8.

**Blockers, owner action:**

1. Decide whether `OUTBOUND_EXTERNAL_DIALING` should be `disabled` in
   `functions/.env.bitesites-org`. It should be, unless the 25/day canary in
   §9 has been granted — and it has not.
2. Branch protection on `main` with `Outbound AI CI / validate` required.
3. Create `GHL_CONTACTS_READ_TOKEN`.

---

## Checkpoint 5 — whole-repository validation and handoff (milestones 7, 8)

**Changes:**

- `OUTBOUND_COMPLETION_REPORT.md` — branch, commits, files, exact test results,
  vulnerability disposition, a fixture-only eligibility-audit sample, staging
  status with the rollback procedure and its unrehearsed caveat, every owner
  and external blocker, and the one command that should happen next.
- Two things found while re-reading the diff, both fixed:
  - the audit reported `no_valid_phone` for a target whose prospect had been
    deleted. The number is on the target; what is missing is the record behind
    it. It now reports `contact_missing`, which is the code the dialer already
    uses for the same condition.
  - `readAll` called a read truncated whenever it used its two-hundredth page,
    including when the provider had simply run out of contacts on that page. It
    now tracks exhaustion separately. A report that cries truncation is a
    report whose truncation warning gets ignored.
- `recordClassification` added per row, with `recordClasses` counts and a
  column in the console. Until launch the campaign is always blocked on
  something, so every row inherited `configuration_blocked` and the per-record
  picture disappeared. The audit sample below is what made that obvious.
- The work-claim marker is removed from the spec, and the progress log no
  longer contains a literal copy of the marker text — `grep -rn "IN PROGRESS"`
  now returns nothing, which is what CLAUDE.md asks for.

**Evidence** — clean install, final tree:

```
npm ci ×3; npx --no-install firebase --version → 15.28.1
npm run secrets:check -- --all → 363 files, passed
npm run test:all               → 438 node:test assertions, 0 failed
                                 17 emulator suites, 0 failed
npm --prefix functions run check           → passed
npm --prefix services/realtime-sideband run check → passed
npm audit (all three packages)             → 0 vulnerabilities
exit 0
```

**Remaining:** nothing that can be done from this repository.

**Blockers, owner action, in the order they matter:**

1. `OUTBOUND_EXTERNAL_DIALING=enabled` in `functions/.env.bitesites-org`.
   `npm run preflight:production` refuses it. Not changed here — it is the
   owner's environment and a deploy-time policy flag is a decision, not a typo
   to silently correct.
2. Branch protection on `main` with `Outbound AI CI / validate` required.
3. `GHL_CONTACTS_READ_TOKEN`, scoped `contacts.readonly`.
4. The spend decisions (§3 paid screening, §10 live-model evaluation) and every
   legal, carrier, calendar, staffing and budget item in
   `OUTBOUND_OWNER_CHECKLIST.md` stages 4–6.

The branch is **not pushed**. `git push -u origin feat/outbound-readiness-closeout`
is ready when the owner wants CI to run on it.

### Addendum to checkpoint 5 — the suite is not hermetic on a developer machine

A validation re-run failed with `ENOTFOUND services.leadconnectorhq.com` during
a DNS outage. Not a regression and not flakiness: `functions/voice-import.test.mjs`
reads a **read-only** GoHighLevel token from `~/.ghl-token` and pulls the live
call log into the emulator on purpose, and skips itself when that file is
absent. CI has no such file, so CI never contacts a provider.

`OUTBOUND_CALLING_SETUP.md` claimed no automated test contacts a provider or
reads a credential. On a machine holding that token, both were false. The claim
is corrected; the test is not changed, because the coverage it buys — a repeat
caller collapsing to one lead against real data shapes — is real and the test
already fails safe without the token.

Recorded because it is also a disclosure: running `npm run test:all` during
this work made read-only GoHighLevel API calls from this machine. Nothing was
created, tagged, enrolled, or mutated.

### Addendum 2 — an emulator port race, and a measurement flaw

A later re-run failed with `Firestore Emulator has exited with code: 1 …
Address already in use` while starting `npm run test:analytics`. `test:all:raw`
boots `firebase emulators:exec` seventeen times in sequence against the pinned
ports in `firebase.json`, and one boot found the previous instance's socket not
yet released. `npm run test:analytics` passes on its own; nothing on this
branch touches it. It can hit CI too — the durable fix is to run the
emulator-backed suites inside a single `emulators:exec` instead of seventeen,
which is a restructuring this branch did not attempt.

Also fixed: the validation harness. `{ step; step; } > log; echo "EXIT=$?"`
reports only the *last* command's status, so a failing `npm run test:all`
followed by three successful `npm audit` calls read as `EXIT=0`. The final run
records every step's status individually. Five full-suite runs total: three
green, two failed for the environmental reasons above.
