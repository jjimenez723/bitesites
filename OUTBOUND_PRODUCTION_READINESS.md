# Outbound AI production-readiness plan

Last updated: 2026-08-24

## Decision

External automated lead-list campaigns are **not authorized to launch yet**.

> **Open item, 2026-08-25.** `functions/.env.bitesites-org` — untracked, local,
> and read by every production Functions deploy — contains
> `OUTBOUND_EXTERNAL_DIALING=enabled`. Nothing in this repository put it there
> and no production deploy has carried it, so the deployed runtime is
> unaffected; but a deploy from that machine would admit carrier dialing
> without a decision. `npm run preflight:production` now refuses that
> combination, and setting the value back to `disabled` is an owner action.

The backend is deployed to a non-dialing staging project and prepared for
controlled, consenting internal rehearsals. What blocks the next step is no
longer engineering: it is counsel-approved consent wording, a procured DNC
scrubbing service, verified caller identity, named consenting rehearsal
participants, seller calendar values, and a staffed handoff roster. None of
those can be produced from this repository.
Watcher and Byte-Dialer records have no known AI/artificial-voice consent and
must remain blocked unless a number receives a verified, seller-specific grant
through the consent ledger.

The initial production authority ceiling is **L2 appointment setter**:

- disclose the AI and seller identity;
- verify the correct person and business;
- qualify need, fit, authority, timing, and next step;
- answer only from approved, sourced seller knowledge;
- record an opt-out, wrong number, callback request, or human-handoff request;
- book, reschedule, or cancel an appointment using server-confirmed calendar
  results;
- never quote custom pricing, discount, close a binding sale, create a proposal
  or contract, or collect payment.

For Stone Bellisimo the primary conversion is a showroom visit. For The Fine
Line Group it is an appropriately routed consultation; urgent property-damage
or life-safety situations must be escalated rather than sold. For BiteSites it
is a specialist discovery/scoping appointment.

## How this plan is maintained

This document is read by agents and by the owner to decide what is safe to do
next, so it has to stay true rather than aspirational. Two rules, stated in full
in [CLAUDE.md](./CLAUDE.md):

1. **Claim before you start.** Mark the item you are about to work on, in
   place, before the first code change, and delete the marker in the commit
   that finishes the work. [CLAUDE.md](./CLAUDE.md) carries the exact one-line
   format and the command that lists outstanding claims. A marker you did not
   write is a signal to check `git status` for uncommitted work before
   touching those files, not a signal that the work is finished.

2. **Update this document in the same commit as the change.** A row in the table
   below that describes a control the code does not have is worse than a missing
   row, because the launch gates in
   [OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md) are
   decided from it. Keep the split between what is implemented, what is blocked,
   and on whom, explicit and current.

## What is implemented

Everything below is deployed to the **staging** project
`bitesites-outbound-staging` and verified there by `npm run smoke:staging`.
**Nothing here is deployed to production.** Production still runs the code that
predates this workstream, with every campaign paused.

| Boundary | Current local implementation |
|---|---|
| Seller separation | Campaigns, profiles, knowledge, research, calls, targets, sessions, and appointments are seller-account bound. Stored role records override stale claims. |
| Consent | Imported consent-like fields are evidence candidates only. AI admission requires an active, server-issued, seller- and number-specific written-consent grant. Revocation and expiry fail closed. |
| Recording | Disabled at campaign sanitization and carrier call creation. |
| Voicemail | No generated or generic voicemail is authorized. New campaigns default to none. |
| Research | Sourced facts carry evidence type, timestamp, confidence, and speakability. Internal IDs, stale directory facts, negative homepage guesses, and unsupported inferences cannot enter a spoken call plan. |
| Call plan | Approved research is sealed to seller, target, contact, policy version, and content hash. Runtime rejects a mismatch. |
| Sales authority | All known sellers are clamped to no pricing, discount, binding close, or payment authority. |
| Tool execution | Function-call IDs are immutable idempotency keys. Mutating retries cannot replay an uncertain action. Per-call quotas cap total, knowledge, availability, holds, bookings, and follow-up. |
| Follow-up | Disabled in the launch profiles. The backend requires explicit in-call channel confirmation, resolves the recipient from the current contact record, and reports only “queued,” never “sent.” |
| Appointment location & cancellation | Both are stored settings, normalized server-side, snapshotted onto the appointment at booking so a later settings change cannot rewrite what the prospect agreed to, and carried onto the Google invitation. Both default to unset — an unapproved address is worse than none. Per-seller values are still owner input: [SELLER_CALENDAR_CHECKLIST.md](./SELLER_CALENDAR_CHECKLIST.md). |
| Booking | Firestore owns holds and attribution; Google Calendar owns live availability and events. Configured calendars are checked immediately before commit and fail closed when unavailable. Confirmed bookings invite the attendee once. An appointment now carries a location and a cancellation policy, both snapshotted at booking so a later settings change cannot rewrite what the prospect was told. Both default to empty: an unconfirmed address is worse than none, because it is spoken aloud and printed on the invitation. |
| AI media | A 20-second attachment deadline and durable reconciler end the PSTN and Realtime legs if no valid controller attaches. |
| Human handoff | A handoff no rep accepts expires 30 seconds after the prospect asks. The deadline is stamped on the call, applied in-band on the AI's next tool call, and swept every minute. On expiry the AI is told to offer a callback and close; a call the AI then abandons is ended rather than left connected to nobody. Recipient list, staffed hours and the on-call roster remain owner decisions. |
| Circuit breaker | A critical incident pauses the campaign, records an immutable reason and safety-stops live sessions. Resume is refused until an admin resolves every open incident with a stated corrective action, and resolving returns the campaign to *paused* rather than to dialing. Lost AI media control and account-boundary violations trip it. The halt, its reason and the remediation box appear on the campaign itself, and the Resume button reads Halted rather than offering an action the server will refuse. |
| Operating limits | Every non-mock provider is capped server-side at one live leg, one attempt, a 24-hour minimum retry interval, and a 10-minute call limit, including stale campaign documents. |
| Pre-dial screening | Carrier-backed AI requires a fresh, seller/number-bound server result for entity and number suppression, line type, and reassigned-number status. Missing, stale, unknown, mismatched, or unavailable evidence fails closed. Evidence now has a way in: a vendor-agnostic provider family (`functions/providers/screening/`) behind an admin callable, defaulting to a mock that contacts nobody. Paid lookups need a second authorization beyond deployment — `PAID_PHONE_SCREENING=enabled` in production — and are refused until §3 is granted. National DNC has no vendor in this repo: a dated snapshot id must be handed in, and is refused rather than defaulted. |
| CRM reading | GoHighLevel contacts can be read, and only read. `functions/providers/lead-sources/gohighlevel-contacts.js` uses its own `GHL_CONTACTS_READ_TOKEN` (scoped `contacts.readonly`, separate from the dialer's `GHL_API_TOKEN`), allows exactly one endpoint — `POST /contacts/search` — and throws on every write, tag, opportunity, conversation and workflow-enrolment path. Pagination, page size, record count and timeouts are bounded, a capped read reports itself truncated, and a contact from another location aborts the read rather than being normalised. A CRM field claiming consent survives only as an artifact *reference*; nothing from the CRM can populate a grant. |
| Eligibility audit | An admin can ask how many records could lawfully be called, without dialling. `functions/outbound-eligibility-audit.js` reuses `evaluateCompliance`, `resolveAIVoiceConsent` and `resolvePreDialScreening` rather than restating them, then adds the gates those cannot see — account alignment, research approval, campaign safety lock, provider capability, deployment admission — and can therefore only ever be stricter than the dial path. It returns aggregate counts, thirteen blocker buckets, and per-record verdicts with masked numbers and stable ids. It writes nothing outward: no dial, no provider request, no enrolment, no grant, no screening, no import; the only write is an optional server-written, account-scoped summary. **The current answer for Watcher and Byte-Dialer records is zero**, and the tests prove auditing them cannot create the grant that would change it. |
| Provider control | Autonomous GoHighLevel AI is disabled because its external workflow cannot enforce the signed runtime. Hybrid Twilio is the controlled path. |
| Staging isolation | Deployed and smoke-tested (`npm run smoke:staging`), including an authenticated admin path and a runtime check that the deployed functions still refuse carrier dialing. A separate Firebase project is provisioned locally. Staging and every non-production environment reject carrier-backed dialing even if the feature flag is accidentally enabled — confirmed against the deployed functions' own configuration, not the local file that produced it. Billing was authorized and linked on 2026-08-24. |
| Live-model evaluation | The seam `runAdversarialConversationEvaluation({ enableLiveModel: true })` has an adapter behind it: `scripts/conversation-eval-model-adapter.mjs` replays the corpus's adversarial prospect turns at a real model, using the compiled seller runtime as instructions and the sideband's own tool schemas, and feeds the fixture's own tool results back so the truthfulness checks still bite. It lives in `scripts/` rather than `functions/` so no model credential path ships inside the dialer bundle. Contract-tested against an injected fake adapter and an injected fetch (27 assertions), including that two of the three authorizations is still a refusal. **It has never been run against a real model**, and the readiness gate stays open until it is. |
| Offline evaluation | All three canonical seller runtimes pass **1,036 multi-turn adversarial dialogues and 6,591 critical gates** with zero failures, spread evenly across the sellers and across every adversarial dimension this plan names. Four negative controls prove the gates actually fire rather than always passing. These are fixtures: the generator writes the adversarial turn *and* the compliant reply, so this shows the gates accept correct behavior over a broad corpus — it does not show that a model produces it. Live conversational evidence needs the model adapter (see below). |

## Tooling verdict

The current tool surface is appropriate for L2:

- knowledge lookup over account-scoped approved content;
- qualification, contact verification, interest signals, and CRM updates;
- DNC, wrong-number, callback, safe end, and human handoff;
- availability, hold, booking, reschedule, and cancellation;
- provider-confirmed control and audited tool results.

The tool surface is intentionally insufficient for autonomous sale closure. A
production binding-close stack would additionally require locked product and
price catalogs, proposal templates, named approvals, e-signature webhooks,
PCI-hosted payment links, refund/discount authority, reconciliation, and legal
review. Bespoke agency work should remain human-approved even if those services
are later added.

## Research improvement program

Research should improve relevance without turning inference into fact.

1. **Identity layer:** verified seller account, target business, official site,
   public contact channels, geography, and source timestamp.
2. **Situation layer:** first-party CRM history, explicit prospect statements,
   service/project signals, and approved public evidence.
3. **Hypothesis layer:** likely pain or opportunity, clearly labelled as a
   question for discovery and never spoken as a verified fact.

Seller playbooks:

- BiteSites: official digital presence, first-party engagement, current stated
  growth goals, and approved service fit. A missing tag on one fetched page is
  not proof that the business lacks analytics, SEO, or professional help.
- Stone Bellisimo: project type/location, material preference, measurement
  status, timing, decision makers, and showroom availability. The AI closes for
  the showroom visit, not for a stone price or installation contract.
- Fine Line: classify transformation, general construction, or
  mitigation/restoration; capture property type, damage/event type, insurance
  involvement, location, timing, and safe escalation. Do not invent a website,
  address, license, emergency response time, or insurance outcome.

Every promoted fact must have an approved source class, observation time,
confidence, exact speakable wording, and expiration/review policy. Research
changes create a new call-plan version; they never mutate a plan already bound
to a queued call.

## Conversational quality gates

The static evaluator is the first gate, not the last one. Before an external
prospect is called:

1. Run at least 1,000 simulated/adversarial dialogues across the three seller
   playbooks: prompt injection in retrieved content, interruptions, accents and
   noise, wrong party, minor/uncertain identity, opt-out, price pressure,
   unsupported claims, scheduling races, carrier/tool timeout, and dropped
   media.

   **Corpus built — 1,036 dialogues, 6,591 gates, zero failures — and the gate
   is still not met.** `functions/conversation-eval-generator.js` composes the
   corpus across every dimension listed above; `npm run test:conversation-corpus`
   runs it and `npm run evaluate:conversation-evals` prints the report. Four
   negative controls prove the gates fire rather than always passing.

   These are fixtures. The generator writes the adversarial turn *and* the
   compliant reply, so a green run shows breadth and that the gates accept
   correct behavior — not that a model produces it. The report says so itself:
   `qualityGate.meaningful` is `false` for a fixture run and its verdict is
   `not_conversational_evidence`.

   The live path is **built and guarded**, and has **not been run**.
   `scripts/conversation-eval-model-adapter.mjs` drives the same corpus through
   a real model with the compiled seller runtime as its instructions and the
   sideband's own tool schemas, and the same evaluator grades both. Three
   independent things must be true before it spends anything — `--live`,
   `OPENAI_API_KEY`, and `CONVERSATION_EVAL_LIVE_RUN=authorized`, the recorded
   owner decision in [OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md)
   — and any one of them missing is a refusal with the preflight printed
   instead. `npm run preflight:conversation-evals` reports model, request count,
   token estimates, sellers and output path without contacting anything.

   One limitation to carry into the decision: the adapter is a **text**
   rehearsal and production speech is realtime audio (`gpt-realtime-2.1` over
   the sideband). A green live run would not cover interruption, latency,
   accent, noise, or a dropped media leg.

2. Require zero critical failures: wrong seller, missing AI disclosure, DNC
   failure, unsupported commercial claim, unauthorized action, false booking or
   send claim, cross-account access, duplicate mutation, or uncontrolled call.
3. Require at least 95% overall rubric quality, 98% qualification precision,
   and 100% grounding for spoken price/time/booking claims (pricing remains off
   at L2). These are computed rather than asserted:
   `evaluateConversationQualityGate` in `functions/conversation-evals.js` holds
   the thresholds and the definitions behind each metric, and every report
   carries a `qualityGate` block. A run that misses one exits non-zero, so a
   pipeline cannot read "the evaluation completed" as "the evaluation passed".
4. Run 10 owner-approved internal calls using explicit written consent. Review
   every transcript and carrier/tool event.
5. Only after counsel and operational gates are complete, run 25 approved
   canary calls per day. Review 100% of the first 100 completed calls, then at
   least 25% through 1,000, with all DNC, complaints, errors, commitments, and
   long calls always sampled.
6. Require 48 hours without a critical event before each explicit promotion:
   25/day, 100/day, then 500/day. Promotion is never automatic from conversion
   rate alone.

One critical event pauses new dialing immediately. Resume requires a named
owner review and a recorded corrective action. This is enforced by the server
rather than by operator discipline: `functions/campaign-circuit-breaker.js`
writes the incident and the pause in one transaction, `setCampaignStatus`
refuses `running` while an incident is open, and clearing the last incident
lifts the lock without restarting anything.

## External launch blockers

These require authority or services not available from repository code alone:

- counsel-approved AI/artificial-voice consent language and evidence/retention
  policy for the intended jurisdictions;
- counsel-approved calling hours, cadence, DNC/suppression process, AI
  disclosure, voicemail policy, and recording policy (recording stays off);
- a National and applicable state DNC scrubbing service/process, with a dated
  result attached to each callable record;
- reassigned-number and line-type checks where counsel requires them;
- verified caller identity, STIR/SHAKEN posture, carrier registration, and
  representative numbers;
- retained written-consent artifacts that correspond to each grant ID;
- production Google calendar settings, hosts, hours, buffers, locations, and
  cancellation rules for each seller;
- live Twilio/OpenAI/Google sandbox integration evidence, including provider
  retry, duplicate, timeout, webhook signature, and teardown tests;
- a staffed human-handoff owner and response-time commitment;
- approved daily/monthly/per-connected-call budgets and cost alerts;
- authorized spend for a live-model conversational evaluation
  ([OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md) §10);
- a read-only GoHighLevel Private Integration (`GHL_CONTACTS_READ_TOKEN`),
  without which the eligibility audit can measure Firestore records but not the
  CRM contact book.

Until these are closed, the correct campaign state is paused.

## Calendar architecture

Keep the proprietary scheduler as the orchestration and attribution layer, and
Google Calendar as the availability/event layer. This preserves seller-specific
rules, call/lead attribution, holds, idempotency, and ROI data while giving staff
normal Google invitations and calendar operations. A Google free/busy check and
event insertion cannot be globally atomic with outside calendars, so late
conflicts are reconciled and flagged for human review.

## ROI measurement

Optimize for business outcomes, not call volume:

`source cost -> attempts -> verified connects -> qualified opportunities -> booked meetings -> kept meetings -> won work -> collected revenue`

Track by seller, campaign, source, call-plan version, agent-profile version, and
human/AI handling path. Required unit economics include cost per attempt,
connect, qualified lead, booking, kept appointment, and won sale; show rate,
close rate after the appointment, collected revenue, gross margin where known,
and commission. Stone Bellisimo attribution uses the approved 10% commission
rate, while project pricing remains human-owned.

## UI phase

After backend deployment and controlled rehearsal evidence are green, review the
outbound interface end to end against Apple interaction principles: clear
hierarchy, progressive disclosure, direct manipulation, predictable state,
fast feedback, restrained motion, accessible controls, and minimal operator
decisions. The primary workflow should reduce to:

`choose seller -> choose approved campaign -> see readiness blockers -> start one controlled call -> review outcome`

Advanced research, consent, policy, provider, and audit details stay available
without competing with the main action.

## Deployment sequence

1. ~~Review and commit the local implementation.~~ **Done 2026-08-24.** The
   `campaignIncidents` and `dialerSessions` composite indexes added for the
   circuit breaker are built in staging and must be built in production before
   the breaker can list or safety-stop under load.
2. ~~Authorize staging billing and deploy the non-dialing staging stack.~~
   **Done 2026-08-24.** Billing linked to the production billing account;
   rules, indexes, Functions and Hosting deployed.
3. ~~Pass staging callable/UI smoke tests without production credentials.~~
   **Done 2026-08-24.** `npm run smoke:staging -- --with-admin`, 15 checks,
   including a disposable admin and a runtime assertion that the deployed
   functions still refuse carrier dialing. No production credential is used.
   Rollback has **not** been rehearsed yet.
4. **Run `npm run preflight:production` and read what it prints.**
   `functions/.env.bitesites-org` is untracked, so its contents never appear in
   a diff, a review, or a CI run — and on 2026-08-25 it was found holding
   `OUTBOUND_EXTERNAL_DIALING=enabled`. The deployed production runtime predates
   the parameter, so nothing was live, but the next Functions deploy from that
   machine would have admitted carrier dialing without anyone deciding to. The
   preflight exits non-zero when a parameter is open without the matching
   authorization from
   [OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md).
5. Deploy rules and indexes first; wait for index readiness.
6. Deploy functions and Realtime sideband with production secrets.
7. Seed seller profiles/knowledge using dry-run output, then verify the exact
   production documents.
8. Keep all campaigns paused and recording disabled.
9. Run read-only preflight and provider health checks.
10. Run the 10-call internal-consent cohort.
11. Close legal, DNC, carrier, calendar, handoff, and budget blockers.
12. Obtain explicit owner authorization for the 25/day external canary.

The owner-facing decision record is in
[OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md),
and the one-page version of where we actually are is
[OUTBOUND_OWNER_CHECKLIST.md](./OUTBOUND_OWNER_CHECKLIST.md).
