# Outbound AI production-readiness plan

Last updated: 2026-08-24

## Decision

External automated lead-list campaigns are **not authorized to launch yet**.
The backend is being prepared for controlled, consenting internal rehearsals.
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

## What is implemented locally

Nothing in this section has been deployed by this workstream.

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
| Booking | Firestore owns holds and attribution; Google Calendar owns live availability and events. Configured calendars are checked immediately before commit and fail closed when unavailable. Confirmed bookings invite the attendee once. |
| AI media | A 20-second attachment deadline and durable reconciler end the PSTN and Realtime legs if no valid controller attaches. |
| Human handoff | A handoff no rep accepts expires 30 seconds after the prospect asks. The deadline is stamped on the call, applied in-band on the AI's next tool call, and swept every minute. On expiry the AI is told to offer a callback and close; a call the AI then abandons is ended rather than left connected to nobody. Recipient list, staffed hours and the on-call roster remain owner decisions. |
| Circuit breaker | A critical incident pauses the campaign, records an immutable reason and safety-stops live sessions. Resume is refused until an admin resolves every open incident with a stated corrective action, and resolving returns the campaign to *paused* rather than to dialing. Lost AI media control and account-boundary violations trip it. The halt, its reason and the remediation box appear on the campaign itself, and the Resume button reads Halted rather than offering an action the server will refuse. |
| Operating limits | Every non-mock provider is capped server-side at one live leg, one attempt, a 24-hour minimum retry interval, and a 10-minute call limit, including stale campaign documents. |
| Pre-dial screening | Carrier-backed AI requires a fresh, seller/number-bound server result for entity and number suppression, line type, and reassigned-number status. Missing, stale, unknown, mismatched, or unavailable evidence fails closed. |
| Provider control | Autonomous GoHighLevel AI is disabled because its external workflow cannot enforce the signed runtime. Hybrid Twilio is the controlled path. |
| Staging isolation | A separate Firebase project is provisioned locally. Staging and every non-production environment reject carrier-backed dialing even if the feature flag is accidentally enabled. Deployment awaits owner-authorized billing. |
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

   **Corpus built — 1,036 dialogues, every dimension covered**
   (`npm run test:conversation-corpus`, `npm run evaluate:conversation-evals`).
   **The gate is not yet met.** The corpus is deterministic fixtures, so it
   proves breadth and that the gates fire, not that a live model behaves this
   way under the same pressure. Closing this gate means running the same corpus
   through `runAdversarialConversationEvaluation({ enableLiveModel: true })`
   with a real model adapter and reviewing the rubric scores in items 2 and 3.
2. Require zero critical failures: wrong seller, missing AI disclosure, DNC
   failure, unsupported commercial claim, unauthorized action, false booking or
   send claim, cross-account access, duplicate mutation, or uncontrolled call.
3. Require at least 95% overall rubric quality, 98% qualification precision,
   and 100% grounding for spoken price/time/booking claims (pricing remains off
   at L2).
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
- approved daily/monthly/per-connected-call budgets and cost alerts.

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

1. Review and commit the local implementation. The `campaignIncidents` and
   `dialerSessions` composite indexes added for the circuit breaker must be
   built before the breaker can list or safety-stop under load.
2. Authorize staging billing and deploy the non-dialing staging stack.
3. Pass staging callable/UI smoke tests without production credentials.
4. Deploy rules and indexes first; wait for index readiness.
5. Deploy functions and Realtime sideband with production secrets.
6. Seed seller profiles/knowledge using dry-run output, then verify the exact
   production documents.
7. Keep all campaigns paused and recording disabled.
8. Run read-only preflight and provider health checks.
9. Run the 10-call internal-consent cohort.
10. Close legal, DNC, carrier, calendar, handoff, and budget blockers.
11. Obtain explicit owner authorization for the 25/day external canary.

The owner-facing decision record is in
[OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md).
