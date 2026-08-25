# Outbound completion report

**Branch:** `feat/outbound-readiness-closeout`
**Baseline:** `925697f` on `main`
**Date:** 2026-08-25
**Spec:** [OUTBOUND_COMPLETION_GOAL_SPEC.md](./OUTBOUND_COMPLETION_GOAL_SPEC.md)
**Working log:** [OUTBOUND_COMPLETION_PROGRESS.md](./OUTBOUND_COMPLETION_PROGRESS.md)

Engineering completion is met. **Launch authorization is not**, and the two are
different things — see [OUTBOUND_OWNER_CHECKLIST.md](./OUTBOUND_OWNER_CHECKLIST.md)
for which of the six stages we are actually on.

No call was placed. No GoHighLevel contact was created, tagged, or enrolled. No
consent grant or screening clearance was issued. Nothing was deployed. No
campaign was unpaused. No paid service was contacted.

---

## Read this first

`functions/.env.bitesites-org` — untracked, local, and read by every
`firebase deploy --only functions` — contains:

```
BITESITES_DEPLOYMENT_ENVIRONMENT=production
OUTBOUND_EXTERNAL_DIALING=enabled
```

Together those are the two conditions `resolveOutboundDeploymentPolicy`
requires to admit a carrier-backed call.

- **Nothing is live.** The deployed production functions predate the parameter
  entirely and every campaign is paused. Even with this gate open, a call still
  needs a consent grant, a fresh pre-dial screening, and a running campaign —
  and no consent grant or screening record exists. The caller ID is **not** one
  of the missing pieces: `+12015524949` is provisioned in the shared Twilio
  account and registered to Stone Bellisimo and Fine Line in `accounts.js`,
  and BiteSites declares no allow-list, so any E.164 number passes
  `callerIdAllowed` for it. What is still outstanding on caller identity is the
  carrier-side work — verified identity, KYC, STIR/SHAKEN attestation, A2P
  registration — which is a different thing from having a number.
- **Nothing in this repository set it.** `scripts/staging.mjs` writes `disabled`
  and cannot target production. No other script writes that file.
- **A production Functions deploy from this machine would have carried it**, and
  no diff, review, or CI run would have shown anyone.

The value was **not changed** — it is the owner's local environment and
silently flipping a deploy-time policy flag is the same unreviewed change that
created the problem. What was added is the check that catches it:

```bash
npm run preflight:production
```

It currently exits 1 with the reason. See **Owner actions** below.

---

## Commits

| Commit | What |
|---|---|
| `0c72f31` | Track and claim the spec; open the progress log with the baseline |
| `ac743e5` | Milestone 1 — CI toolchain, dependency advisories, secret scanner |
| `40792f0` | Milestones 3–5 — read-only GoHighLevel source, eligibility audit, fail-closed tests |
| `14c6286` | Milestone 6 — live-model adapter, admission, preflight, computed thresholds |
| `c73e5a2` | Milestone 2 — document reconciliation, owner checklist, production preflight |

36 files changed. New modules:

- `functions/providers/lead-sources/gohighlevel-contacts.js` (+ tests)
- `functions/outbound-eligibility-audit.js` (+ tests)
- `scripts/conversation-eval-model-adapter.mjs` (+ tests)
- `scripts/production-preflight.mjs` (+ tests)
- `src/admin/outbound/EligibilityAudit.jsx`, `eligibility.css`
- `OUTBOUND_OWNER_CHECKLIST.md`

**Unrelated work left alone.** `main` carried uncommitted admin-UI
accessibility edits (`src/admin/*.jsx`, `admin.css`, the untracked
`src/admin/row-activate.js`) and a `.claude/settings.json` permission entry.
None of it is committed by this branch. The one file where the two workstreams
would have collided — `src/admin/outbound/outbound.css` — was avoided by
putting the audit's styles in their own `eligibility.css`.

---

## Tests

Clean install, this branch, `npm ci` in all three packages first.

Every step's status is recorded individually, because a green tail can hide a
red middle: `npm run test:all` is followed by three `npm audit` calls, and the
exit code of a `{ …; }` group is only the last command's.

| Step | Result |
|---|---|
| `npm ci` (root, `functions/`, `services/realtime-sideband/`) | PASS |
| `npx --no-install firebase --version` | PASS — `15.28.1`, resolved from the lockfile, not a global install |
| `npm run secrets:check -- --all` | PASS — 363 tracked files scanned |
| `npm run test:all` | PASS — **438 `node:test` assertions, 0 failed; 17 emulator suites, 0 failed** |
| `npm --prefix functions run check` | PASS |
| `npm --prefix services/realtime-sideband run check` | PASS |
| `npm audit` ×3 | PASS — 0 vulnerabilities each |
| overall | **0** |

Focused suites, each run individually:

| Suite | Result |
|---|---|
| `npm run test:ghl-contacts` | 20 / 0 |
| `npm run test:eligibility-audit` | 72 / 0 |
| `npm run test:consent` | passed (emulator) |
| `npm run test:pre-dial-screening` | passed |
| `npm run test:screening-ingestion` | passed (emulator) |
| `npm run test:breaker` | passed (emulator) |
| `npm run test:handoff` | passed (emulator) |
| `npm run test:calendar` | passed |
| `npm run test:rules` | 161 / 0 (158 before this branch) |
| `npm run test:conversation-corpus` | 5 / 0 — 1,036 dialogues, 6,591 gates |
| `npm run test:conversation-adapter` | 27 / 0 |
| `npm run test:staging-infra` | 17 / 0 (includes the new production preflight) |
| `npm run test:staging-gate` | passed (emulator) |

Nothing was skipped, deleted, or rerun-until-green. Three failures were found
during development and all three were fixed rather than worked around:
`checkAccountAlignment` takes account *ids*, not documents; one audit assertion
counted a collection after a later scenario had re-seeded it; and the audit
reported `no_valid_phone` for a target whose prospect record had been deleted,
when the number was on the target and what was missing was the record behind it.

### Five full-suite runs, and what the two failures were

Reported because "it passed" is a weaker claim than the log supports, and
because both failures are worth knowing about.

| Run | Result |
|---|---|
| 1, 2 | green (pre-cleanup tree) |
| 3 | **failed** — DNS outage; see below |
| 4 | **failed** — `Firestore Emulator has exited with code: 1 … Address already in use` while starting `npm run test:analytics` |
| 5 | green, final tree, every step checked individually |

Neither failure is a code defect and neither was resolved by rerunning until it
passed:

- **Run 4** is an emulator port race. `test:all:raw` boots
  `firebase emulators:exec` seventeen times in sequence against pinned ports
  (`firestore: 8085` in `firebase.json`), and one boot found the previous
  instance's socket not yet released. `npm run test:analytics` passes on its
  own, and the suite is unchanged by this branch. **It can happen in CI too** —
  a job that fails this way should be re-run, and the durable fix would be to
  run the emulator-backed suites inside one `emulators:exec` rather than
  seventeen, which is a restructuring this branch deliberately did not attempt.
- **Run 3** is the next section.

### The suite is not hermetic on a developer machine

One validation run failed with `ENOTFOUND services.leadconnectorhq.com` during
a DNS outage. That is not a regression, and it is not flakiness — it is
`npm run test:import` (`functions/voice-import.test.mjs`) behaving exactly as
designed. It reads a **read-only** GoHighLevel token from `~/.ghl-token` and
pulls the live call log into the emulator, because the properties it pins only
appear against real data shapes, and it **skips itself** when that file is
absent.

Consequences worth knowing:

- **CI never contacts a provider and never reads a credential**, because the
  runner has no `~/.ghl-token`.
- **On this machine it does.** `npm run test:all` during this work made
  read-only GoHighLevel API calls (`GET /voice-ai/dashboard/call-logs`,
  `GET /voice-ai/agents`). Nothing was created, tagged, enrolled or mutated.
- `OUTBOUND_CALLING_SETUP.md` claimed no automated test contacts a provider or
  reads a credential. That was false on such a machine, and the claim has been
  corrected rather than the test changed — the coverage is deliberate and worth
  keeping.

---

## CI

**Not pushed.** Pushing creates remote state and starts a CI run, and that was
not part of what was asked. The branch is ready:

```bash
git push -u origin feat/outbound-readiness-closeout
```

The workflow will now reach every step. Before this branch it could not: no
package depended on the Firebase CLI, twenty test scripts invoke
`firebase emulators:exec`, and the job died at the first emulator test with
`firebase: not found` — so the application suite had never actually reported a
verdict in CI. Fixed by pinning `firebase-tools@15.28.1` as a root
devDependency, installing a JDK for the emulators rather than inheriting one,
and asserting `npx --no-install firebase --version` before the suite runs.

---

## Dependency vulnerabilities

**Zero at any severity**, in all three packages, verified in the clean-install
run.

The baseline had 9 moderate at root and 7 in `functions/`, every one of them
chaining to two advisories: `uuid <11.1.1` (GHSA-w5hq-g745-h8pq) and
`@opentelemetry/core <2.8.0` (GHSA-8988-4f7v-96qf). Resolved with scoped
`overrides`:

```json
"overrides": {
  "teeny-request": { "uuid": "^11.1.1" },
  "gaxios": { "uuid": "^11.1.1" },
  "@google-cloud/pubsub": { "@opentelemetry/core": "^2.8.0" }
}
```

Scoped rather than global because a bare `uuid` override also drags
`universal-analytics` back a major. `npm audit fix --force` was **not** used: it
proposes downgrading `firebase-admin` 14 → 10 and `firebase-functions` 7 → 4,
which is a far larger break than the moderate it closes.

---

## Eligibility audit — sample

Fixtures only. Five synthetic Watcher-shaped prospects, an AI campaign on the
Twilio provider, staging deployment values. No real contact, no network, no CRM
read. Reproduced by seeding the same records the emulator test seeds.

```
totals            { scanned: 5, eligibleNow: 0, recordReady: 0, truncated: false }

campaignReadiness ready: false
                  provider_cannot_place_ai_calls   (twilio: aiAgentCall is false —
                                                    an AI campaign runs through the
                                                    hybrid session path, not the
                                                    plain adapter)
                  external_dialing_disabled        (environment: staging)

classes           permanently_suppressed 1 · configuration_blocked 4
recordClasses     permanently_suppressed 1 · evidence_missing 4

buckets           ai_consent                       5
                  research_or_call_plan            5
                  campaign_provider_or_deployment  5
                  screening_record                 4
                  invalid_or_missing_phone         1
                  dnc_or_suppressed                1
```

One CSV row, unedited:

```
w-1,prospect,t-w-1,bitesites,Synthetic Co w-1,+1 (201) •••-••42,America/New_York,
14:00,configuration_blocked,evidence_missing,false,false,0,
ai_consent_not_documented ai_consent_seller_mismatch ai_consent_phone_mismatch
external_screening_missing ai_consent_unverified research_missing
provider_cannot_place_ai_calls external_dialing_disabled,…
```

Three things this shows:

- **Zero eligible, which is the correct answer.** Watcher and Byte-Dialer
  records have no seller- and number-bound written AI consent, and the tests
  prove auditing them cannot create one.
- **`recordClassification` is the useful column while the campaign is blocked.**
  Every row inherits the campaign-wide blockers, so `classification` reads
  `configuration_blocked` for all of them; the record-only verdict says the
  real problem is missing evidence.
- **The number is masked and the evidence is not exported.** The CSV carries no
  unmasked phone, no DNC snapshot id, no consent artifact id, no disclosure
  version — the record id is what an admin investigates with.

---

## Staging

Unchanged by this branch. Deployed 2026-08-24 to `bitesites-outbound-staging`
and not redeployed. **No staging deploy was performed here**, because that
authorization covers the deploy that happened, not a new one.

If a staging deploy is wanted, the exact sequence:

```bash
npm run test:all
npm run preflight:staging                 # refuses a production project or auth domain
npm run dry-run:staging                   # read-only, but does contact Firebase
npm run deploy:staging -- --confirm-staging-deploy=bitesites-outbound-staging
npm run smoke:staging -- --with-admin     # 15 checks against the deployed runtime
git rev-parse HEAD                        # record the deployed SHA
```

Expected environment afterwards, read from the deployed function's own
configuration rather than the local file that produced it:
`BITESITES_DEPLOYMENT_ENVIRONMENT=staging`, `OUTBOUND_EXTERNAL_DIALING=disabled`,
`PAID_PHONE_SCREENING` not enabled. The smoke test asserts exactly that.

**Rollback — never rehearsed, and this is the honest gap.** The procedure would
be: `git checkout <previous SHA>`, re-run `npm run deploy:staging` with the same
confirmation flag, then `npm run smoke:staging -- --with-admin`. Firestore rules
and indexes roll back with it; Hosting can also be reverted from the Firebase
console's release history. Two things are unknown because nobody has tried:
how long a full Functions redeploy takes, and whether an index created by the
newer deploy causes a problem when the older code returns. Rehearse it on
staging before it is ever needed on production.

---

## Owner and external blockers

Nothing below can be produced from this repository.

**Immediate, and the reason this section is first:**

1. **`OUTBOUND_EXTERNAL_DIALING` in `functions/.env.bitesites-org`.** Decide
   whether it should be `enabled`. It should not be, unless
   [OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md) §9 —
   the 25/day external canary — has been granted, and it has not. Set it to
   `disabled` and `npm run preflight:production` will pass.

**Repository settings:**

2. **Branch protection on `main`**, with `Outbound AI CI / validate` required
   and "Require branches to be up to date before merging" on.

**Credentials:**

3. **`GHL_CONTACTS_READ_TOKEN`** — a GoHighLevel Private Integration scoped to
   `contacts.readonly` with no write scopes. Until it exists the eligibility
   audit measures Firestore records and refuses the CRM scope with a
   `failed-precondition` that names the secret.

**Spend decisions:**

4. **Paid screening** (§3) — Twilio Lookup line-type and reassigned-number
   checks, plus a National/state DNC subscription. No vendor is procured for
   DNC and no code can substitute for one.
5. **Live-model evaluation** (§10) — roughly 3,900 requests and 12M prompt
   tokens for the full corpus; `--limit` exists for a smaller first cohort.
   `npm run preflight:conversation-evals` prints the sizing.

**Legal, carrier and operational:**

6. Counsel-approved AI/artificial-voice consent wording, disclosure, calling
   windows, cadence, voicemail, recording, retention and revocation policy.
7. Verified caller identity, KYC, STIR/SHAKEN posture, registered numbers.
8. Retained written-consent artifacts corresponding to each grant id.
9. Ten named internal rehearsal participants with seller-specific written
   consent.
10. Stone Bellisimo and Fine Line calendars — **neither has one**, and a booking
    would otherwise land on generic defaults
    ([SELLER_CALENDAR_CHECKLIST.md](./SELLER_CALENDAR_CHECKLIST.md)).
11. Staffed handoff recipients and hours; Fine Line's emergency escalation
    contact.
12. Daily/monthly/per-connected-call budgets and cost alerts.
13. Separate, explicit authorization for the 25/day external canary, and later
    for 100/day and 500/day.

---

## What is still not proven

Stated plainly, because a report that reads as finished is the most dangerous
artifact here.

- **No live model has ever run the corpus.** The adapter is built, guarded and
  contract-tested against a fake. A fixture run reports
  `qualityGate.meaningful: false` for exactly this reason.
- **Even an authorized live run would be a text rehearsal.** Production speech
  is realtime audio; a green text run says nothing about interruption, latency,
  accent, noise, or a dropped media leg.
- **No provider has been contacted by any of this branch's code.** Twilio,
  GoHighLevel and OpenAI are all exercised through injected fetches in every
  test added here. The new GoHighLevel reader has never seen a real HighLevel
  response, so its pagination and error handling are proven against the
  documented shape, not against the account. (The one pre-existing test that
  does reach GoHighLevel is described under **Tests** above; it is read-only
  and it skips itself in CI.)
- **Rollback has never been rehearsed**, on staging or anywhere.
- **Production has not been deployed** with any of this code.

---

## The exact next safe action

```bash
npm run preflight:production
```

Read what it prints, then decide item 1 above. Nothing else in this report
should happen before that one does.
