# BiteSites outbound AI completion goal specification

**Repository:** `jjimenez723/bitesites`  
**Baseline reviewed:** `main` at `925697f9b62711decaf46c37d4e76e9b5026d060`  
**Purpose:** Finish every engineering task that can be completed safely without placing a real call, enrolling a live GoHighLevel workflow, enabling paid services, deploying production, or inventing legal/consent evidence.

## 1. Goal outcome

Create a feature branch and bring the outbound AI system to an **engineering-complete, production-preflight state**. At completion:

1. The full CI-equivalent test suite is green from a clean install.
2. GitHub Actions can run that suite without missing tools.
3. A read-only, paginated GoHighLevel contact ingestion path exists.
4. An admin can run a no-dial eligibility audit over existing Firestore and GoHighLevel leads and receive counts plus per-lead blocker reasons.
5. No GoHighLevel contact is enrolled in an outbound workflow by the audit/import path.
6. Existing AI consent, DNC, reassigned-number, caller-ID, time-window, seller-boundary, research, campaign-lock, and provider gates remain fail-closed.
7. The live-model evaluation adapter is implemented and testable, but no paid model evaluation runs without explicit owner authorization.
8. Readiness documentation agrees with the code, tests, CI, staging state, and remaining owner/external blockers.
9. The work ends in a reviewable pull request or a clean feature branch with a complete handoff.

This goal does **not** mean the business is legally or operationally authorized to mass-call. Engineering completion and launch authorization must remain separate.

## 2. Non-negotiable safety boundaries

The agent must not:

- place a PSTN/SIP call or call a real phone number;
- enroll a contact in a GoHighLevel outbound workflow;
- mutate live GoHighLevel contacts, workflows, opportunities, tags, DND state, or calendars;
- enable `OUTBOUND_EXTERNAL_DIALING`;
- enable `PAID_PHONE_SCREENING`;
- deploy to production or unpause a production campaign;
- copy production credentials into staging, logs, fixtures, commits, or reports;
- issue consent grants or screening clearances from imported CRM fields alone;
- treat inbound interest, an existing-business relationship, a form submission, a source note, or GHL DND status as written AI/artificial-voice consent;
- weaken `GoHighLevelDialer.capabilities.aiAgentCall = false` merely to make a campaign start;
- claim legal approval, DNC clearance, seller authorization, caller-ID verification, or live-model quality without the required external evidence;
- commit directly to `main`.

If an action creates cost, calls an external provider, changes production state, or relies on legal/business approval, finish all unblocked work and stop with the exact approval or input needed.

## 3. Source-of-truth order

When documents disagree, use this order:

1. Runtime code and tests on the working branch.
2. GitHub Actions logs and locally reproduced command output.
3. Deployed staging smoke-test output from the current deployment.
4. `OUTBOUND_PRODUCTION_READINESS.md` and `OUTBOUND_LAUNCH_AUTHORIZATION.md` after reconciling them to items 1–3.
5. Older setup and planning documents.

Never mark a gate complete because a plan says it is complete when the code, CI, deployed runtime, or evidence says otherwise.

## 4. Files to read before editing

Read these completely and inspect `git status` before changing anything:

- `CLAUDE.md`
- `AGENTS.md`, if present
- `OUTBOUND_PRODUCTION_READINESS.md`
- `OUTBOUND_LAUNCH_AUTHORIZATION.md`
- `STAGING_ENVIRONMENT.md`
- `OUTBOUND_CALLING_SETUP.md`
- `SELLER_CALENDAR_CHECKLIST.md`
- `LEAD_DISCOVERY_SETUP.md`
- `WATCHER_MIGRATION.md`
- `CAPABILITY_INVENTORY.md`
- `package.json`
- `functions/package.json`
- `.github/workflows/hybrid-v2-ci.yml`

Follow the work-claim and same-commit documentation conventions in `CLAUDE.md`.

## 5. Primary implementation files

### CI, dependency, and secret hygiene

- `package.json`
- `package-lock.json`
- `functions/package.json`
- `functions/package-lock.json`
- `services/realtime-sideband/package.json`
- `services/realtime-sideband/package-lock.json`
- `.github/workflows/hybrid-v2-ci.yml`
- `scripts/hybrid.mjs`
- `scripts/check-no-secrets.mjs`
- `scripts/check-no-secrets.test.mjs`

### GoHighLevel contact reading and normalization

- `functions/providers/lead-sources/adapter.js`
- `functions/providers/lead-sources/index.js`
- `functions/providers/lead-sources/existing-watcher-source.js`
- `functions/providers/calling/gohighlevel.js`
- `functions/flg-crm.js`
- `functions/prospect-normalization.js`
- `functions/prospect-import.js`
- `functions/prospect-deduplication.js`
- `functions/outbound-contacts.js`
- `functions/outbound-api.js`
- `functions/index.js`
- `functions/v2-index.js`
- `firestore.rules`
- `firestore.indexes.json`

Expected new modules, unless the existing architecture offers a demonstrably better location:

- `functions/providers/lead-sources/gohighlevel-contacts.js`
- `functions/outbound-eligibility-audit.js`
- `functions/outbound-eligibility-audit.test.mjs`
- `functions/providers/lead-sources/gohighlevel-contacts.test.mjs`

### Eligibility and call-admission controls

- `functions/outbound-compliance.js`
- `functions/pre-dial-screening.js`
- `functions/screening-ingestion.js`
- `functions/consent-grants.js`
- `functions/outbound-calls.js`
- `functions/campaign-circuit-breaker.js`
- `functions/deployment-environment.js`
- `functions/accounts.js`
- `functions/call-plan.js`
- `functions/lead-enrichment.js`
- `functions/hybrid-session-api.js`
- `functions/hybrid-dialer-api.js`
- `functions/providers/calling/index.js`
- `functions/providers/calling/hybrid-twilio.js`

### Admin eligibility-report UI

- `src/admin/outbound/data.js`
- `src/admin/outbound/ProspectList.jsx`
- `src/admin/outbound/LeadQueue.jsx`
- `src/admin/outbound/ImportReview.jsx`
- `src/admin/outbound/ProviderStatus.jsx`
- `src/admin/outbound/SourceBadge.jsx`
- `src/admin/outbound/outbound.css`
- the parent outbound route/component that registers these panels

Expected new UI component:

- `src/admin/outbound/EligibilityAudit.jsx`

### Live-model evaluation

- `functions/conversation-evals.js`
- `functions/conversation-eval-generator.js`
- `functions/conversation-evals.test.mjs`
- `functions/conversation-eval-generator.test.mjs`
- `functions/agent-runtime.js`
- `functions/agent-tools.js`
- `functions/seller-voice-config.js`
- `scripts/evaluate-conversations.mjs`
- `services/realtime-sideband/server.js`

### Calendars, handoff, and deployment follow-up

- `functions/booking-calendar.js`
- `functions/calendar-api.js`
- `functions/handoff-failsafe.js`
- `scripts/calendar-settings.mjs`
- `scripts/staging.mjs`
- `scripts/staging-smoke.mjs`
- `firebase.json`
- `firestore.rules`
- `firestore.indexes.json`

## 6. Milestones

### Milestone 0 — Establish a trustworthy baseline

1. Inspect repository instructions, outstanding work claims, current branch, and dirty files.
2. Preserve unrelated user changes.
3. Create a feature branch such as `feat/outbound-readiness-closeout`.
4. Record the baseline commit and current failures in `OUTBOUND_COMPLETION_PROGRESS.md`.
5. Run the relevant clean-install and test commands before editing.

Do not reinterpret the known `firebase: not found` CI failure as an application-test failure. Fix the CI environment, then let the complete suite provide the application verdict.

### Milestone 1 — Repair CI and repository guardrails

1. Make Firebase CLI availability deterministic from the lockfile. Prefer a pinned root development dependency and package script resolution over a globally installed CLI.
2. Confirm a clean `npm ci`, `npm --prefix functions ci`, and `npm --prefix services/realtime-sideband ci` supplies every command used by CI.
3. Keep the tracked-file secret scan before tests.
4. Extend secret-scanner tests for the credential families actually used by this repository, without logging example secret values.
5. Run `npm audit` for all three packages. Resolve safe fixes; document any remaining moderate issue with package, path, exposure, and reason. No high or critical issue may remain unaddressed.
6. Make `.github/workflows/hybrid-v2-ci.yml` execute the full suite and syntax checks successfully.
7. Add an owner-action note requiring branch protection and the green `Outbound AI CI` check before merge. Do not change repository settings unless separately authorized.

**Milestone acceptance:** A clean local environment can reproduce the workflow, and every workflow step reaches completion.

### Milestone 2 — Reconcile the operational documents

Remove contradictions and duplicated passages while retaining the distinction between staging evidence and production authorization.

At minimum, correct:

- the stale “Decisions still required” section in `STAGING_ENVIRONMENT.md`;
- the obsolete deployment-state and GoHighLevel capability claims in `OUTBOUND_CALLING_SETUP.md`;
- duplicated conversational-evaluation wording in `OUTBOUND_PRODUCTION_READINESS.md`;
- duplicated paid-screening wording in `OUTBOUND_LAUNCH_AUTHORIZATION.md`;
- any statement claiming the full suite is green while current CI is failing;
- any implication that staging approval authorizes production or external calls.

Create or update a compact owner checklist that separates:

- engineering complete;
- staging verified;
- production deployed but disabled;
- internal carrier rehearsal approved;
- external canary authorized;
- wider rollout authorized.

### Milestone 3 — Add a read-only GoHighLevel contact source

Implement a least-privilege reader using HighLevel’s paginated contact search endpoint.

Requirements:

1. Use a dedicated read-only token/secret name rather than reusing a token that can enroll workflows.
2. Scope every request to the configured GHL location and an explicit BiteSites seller account.
3. Support pagination, bounded page sizes, retry/backoff for 429/5xx, request timeouts, and a hard maximum record count per audit.
4. Normalize only fields required for matching and eligibility: GHL contact ID, name/company, phone, timezone/address region where available, DND/channel DND, tags, source, created/updated timestamps, and consent-artifact references.
5. Preserve provider identity and source provenance through `prospect-normalization.js`.
6. Never treat a GHL consent flag as a server-issued BiteSites consent grant.
7. Never call contact create/update/upsert, tag mutation, workflow enrollment, opportunity mutation, or outbound Voice AI endpoints.
8. Tests must use injected/mock HTTP responses and prove the write/enrollment endpoints are never contacted.

The existing `GoHighLevelDialer` remains the calling adapter. The new reader is a lead source, not a dialing shortcut.

### Milestone 4 — Build the no-dial eligibility audit

Add an admin-only audit that evaluates existing Firestore leads/prospects and optionally read-only GHL contacts against the same gates used immediately before dialing.

The audit must:

1. Require an explicit seller/account and campaign policy input.
2. Join each normalized contact to:
   - account alignment;
   - internal suppression and do-not-contact state;
   - immutable `consentGrants` evidence;
   - `preDialScreenings` evidence;
   - previous attempts/retry timing;
   - timezone and current calling window;
   - caller-ID validity;
   - research/call-plan status;
   - campaign incident/safety-lock status;
   - provider capability and deployment admission.
3. Reuse `evaluateCompliance`, `resolveAIVoiceConsent`, and `resolvePreDialScreening`; do not create a second weaker eligibility definition.
4. Perform no dial, provider enrollment, consent issuance, screening clearance, or automatic target import.
5. Return aggregate counts and bounded per-lead results with stable reason codes and human labels.
6. Mask phone numbers in UI/export while retaining stable IDs for an admin to investigate.
7. Distinguish:
   - `eligible_now`;
   - `temporarily_blocked` such as outside calling hours;
   - `evidence_missing` such as consent or screening;
   - `permanently_suppressed` such as DNC/do-not-contact;
   - `configuration_blocked` such as caller ID, provider, calendar, or campaign lock.
8. Include at least these report buckets:
   - total scanned;
   - eligible now;
   - invalid/missing phone;
   - GHL DND/internal DNC/suppressed;
   - account mismatch;
   - written AI consent missing, stale, revoked, seller-mismatched, or phone-mismatched;
   - National DNC evidence missing/matched/stale;
   - entity DNC evidence missing/matched/stale;
   - reassigned-number failure;
   - phone-validation or line-type failure;
   - unknown timezone/outside hours;
   - research or call-plan pending;
   - max attempts/retry delay;
   - campaign incident/provider/deployment block.
9. Support CSV export of the masked report without exporting registry datasets or secret evidence.
10. Show a conspicuous statement that “eligible” means the configured technical gates passed, not legal approval to launch.

**Expected current result:** Watcher and Byte-Dialer records without seller- and phone-bound written AI consent must remain ineligible. Tests must prove that importing or auditing them cannot create a grant.

### Milestone 5 — Preserve and test all fail-closed behavior

Add or update tests proving:

- a GHL contact with no BiteSites grant cannot pass AI eligibility;
- GHL DND blocks the record before any campaign import or provider action;
- one seller’s consent/screening cannot authorize another seller’s call;
- a consent phone mismatch fails;
- revoked/expired consent fails;
- missing, stale, or policy-mismatched screening fails;
- National DNC requires a seller-appropriate dated snapshot identifier;
- reassigned-number verification uses the consent grant date;
- unsupported/unknown line types fail;
- an open campaign incident blocks eligibility and resume;
- resolving an incident does not restart dialing;
- GoHighLevel AI campaign capability remains disabled;
- production external dialing defaults to disabled;
- staging stays non-dialing even if an enable flag is misconfigured;
- the audit performs no external writes and no calls;
- all Firestore audit records, if persisted, are server-written and account-scoped.

### Milestone 6 — Complete the live-model evaluation path without spending money

1. Implement the adapter seam used by `runAdversarialConversationEvaluation({ enableLiveModel: true })`.
2. Keep the deterministic 1,036-dialogue corpus and negative controls unchanged unless a failing case exposes a real defect.
3. Add contract tests using an injected fake model adapter.
4. Add a preflight that reports model, estimated request count, expected cost inputs, seller set, and output path before a paid run.
5. Require an explicit flag plus available credentials for any live execution.
6. Never run the paid evaluation under this goal without separate owner authorization.
7. When later authorized, the required thresholds remain:
   - zero critical failures;
   - at least 95% overall rubric quality;
   - at least 98% qualification precision;
   - 100% grounding for price/time/booking claims.

Engineering completion means the live path is implemented, guarded, and fake-adapter tested. The quality gate remains externally blocked until an authorized live run produces evidence.

### Milestone 7 — Validate the whole repository

Run from a clean install:

```bash
npm ci
npm --prefix functions ci
npm --prefix services/realtime-sideband ci
npm run secrets:check -- --all
npm run test:all
npm --prefix functions run check
npm --prefix services/realtime-sideband run check
```

Also run focused tests for:

- GHL read-only contact pagination and error handling;
- eligibility-audit classification and zero side effects;
- consent grants;
- screening ingestion and pre-dial screening;
- campaign circuit breaker;
- handoff expiry;
- calendars and Firestore rules;
- conversation corpus and live-adapter contract;
- staging environment gate.

If a test is flaky, reproduce and fix it; do not rerun until it happens to pass. Do not delete or skip a safety test to obtain green output.

### Milestone 8 — Staging and final handoff

1. Do not deploy automatically.
2. Prepare the exact staging deployment and smoke commands, expected environment, rollback steps, and owner approvals.
3. If the owner separately authorizes staging deployment during the goal, deploy only to `bitesites-outbound-staging`, then run `npm run smoke:staging -- --with-admin` and record the deployed commit SHA.
4. Production remains untouched and all campaigns remain paused.
5. Create `OUTBOUND_COMPLETION_REPORT.md` containing:
   - branch and commit;
   - files changed;
   - tests and exact results;
   - CI result/link if pushed;
   - vulnerability disposition;
   - eligibility-audit sample using fixtures only;
   - staging status;
   - remaining owner/external blockers;
   - exact next safe action.

## 7. Engineering completion criteria

The goal may be marked engineering-complete only when all of these are true:

- clean-install CI-equivalent commands pass;
- the CI workflow contains every required dependency and reaches every step;
- no high or critical dependency vulnerability is left unresolved or unexplained;
- secret scanning passes and its new coverage tests pass;
- the GHL contact source is read-only, paginated, bounded, account-scoped, and tested;
- the eligibility audit reuses the runtime compliance gates and has zero dialing/provider side effects;
- the admin UI shows aggregate and per-lead blocker data and exports a masked report;
- GHL AI workflow calling remains disabled in BiteSites;
- staging and production dialing gates remain fail-closed;
- the live-model adapter is implemented and fake-adapter tested;
- all readiness documents agree with code and evidence;
- a final report separates completed engineering from missing legal/business/provider evidence;
- the branch is reviewable and contains no unrelated changes.

The goal must **not** be marked launch-ready merely because engineering completion criteria pass.

## 8. External blockers the agent must not fabricate

These remain user, counsel, seller, carrier, or vendor actions:

- counsel-approved AI/artificial-voice consent and disclosure language;
- jurisdiction-specific calling windows, cadence, voicemail, recording, DNC, retention, and revocation policy;
- seller-specific National/state DNC subscriptions and current snapshots;
- paid Twilio Lookup authorization;
- verified caller identity, KYC, STIR/SHAKEN, and representative numbers;
- retained written-consent artifacts for real contacts;
- Stone Bellisimo and Fine Line calendar/host/location/hours/buffer/cancellation values;
- staffed handoff recipients and hours;
- Fine Line emergency-escalation contact;
- daily/monthly/per-connected-call budgets and alerts;
- production secrets and environment values;
- authorized live-model evaluation spend;
- ten named internal participants with seller-specific written consent;
- separate owner authorization for the 25-per-day external canary;
- later 100/day and 500/day promotion approvals.

When blocked by one of these, finish all engineering work that does not require it and record the exact user action needed.

## 9. Progress protocol

Maintain `OUTBOUND_COMPLETION_PROGRESS.md` with one short entry per checkpoint:

- checkpoint;
- changes made;
- evidence/tests;
- remaining work;
- blockers and owner action, if any.

Do not leave work-in-progress markers behind when a milestone is committed. Keep commits scoped by milestone and update the relevant readiness documentation in the same commit as behavior changes.

## 10. Ready-to-paste `/goal`

Paste this from the BiteSites repository workspace:

```text
/goal Implement OUTBOUND_COMPLETION_GOAL_SPEC.md end to end on a feature branch. Keep working milestone by milestone until every Engineering completion criterion in the spec is verified by clean-install test output and the branch is ready for review. Read the listed source-of-truth and focus files first, preserve unrelated user changes, maintain OUTBOUND_COMPLETION_PROGRESS.md, and update readiness documentation in the same commits as behavior changes. Do not place calls, enroll GoHighLevel workflows, mutate live GHL data, enable OUTBOUND_EXTERNAL_DIALING or PAID_PHONE_SCREENING, spend on paid model/screening services, deploy production, unpause campaigns, or fabricate legal, consent, DNC, carrier, calendar, staffing, or budget evidence. Finish all work that is safely possible; if an external approval, credential, paid service, or owner decision blocks the remaining work, stop with the evidence gathered, exact blocker, exact user action required, and the command/checkpoint to resume. Engineering completion is not launch authorization.
```

## 11. Goal controls

- View progress: `/goal`
- Pause: `/goal pause`
- Resume: `/goal resume`
- Clear only after completion or intentional abandonment: `/goal clear`

