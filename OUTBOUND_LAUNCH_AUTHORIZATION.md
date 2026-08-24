# Outbound AI launch authorization record

Last updated: 2026-08-24

This document separates business decisions already supplied by the owner from
permissions that still require an explicit decision or an outside authority.
It does not authorize external dialing by itself. The production campaign must
remain paused until every external-canary gate is evidenced and signed off.

## Owner decisions recorded

| Decision | Recorded direction | Runtime consequence |
|---|---|---|
| Initial AI authority | Appointment setter, not autonomous seller | The AI may disclose, qualify, answer from approved knowledge, hand off, and book a confirmed next step. Pricing, discounts, binding acceptance, contracts, and payment are hard-disabled. |
| Recording | Continue unrecorded | Campaign sanitization and Twilio call creation keep recording off. There is no “record first, ask later” path. |
| Approval owner | BiteSites owner initially; representatives later | Consent grants and research approval remain admin-only. Role/account scopes are required before additional representatives receive access. |
| Stop policy | Pause immediately on a critical event | New dialing fails closed. Cross-seller access, missing DNC persistence, unsupported commercial commitments, uncontrolled connected calls, or false tool-result claims exhaust the rollout error budget. |
| Stone Bellisimo motion | Countertop qualification; showroom visit is the close | The caller cannot quote stone/project pricing. Stone attribution uses the owner-confirmed 10% commission rate. |
| Fine Line motion | Construction, transformation, and mitigation/restoration qualification | The caller books an assessment, does not quote work, promise emergency response, diagnose damage, or claim insurance coverage. Life-safety situations stop the sales flow. |
| BiteSites privacy | Private business address must never be publicized | The client-importable seller registry and runtime contain no BiteSites address. |
| Calendar architecture | Google Calendar plus proprietary booking | Firestore owns holds, policy, attribution, and audit; Google owns live availability, the event, and attendee invitation. |
| Operating posture | Verify backend first, then simplify UI | Staging and deterministic evaluations precede any external canary. The admin UI exposes blockers and keeps advanced controls out of the primary workflow. |

## Exact authorizations still required

These are not implied by “continue” because they create cost, external account
state, or legal reliance.

1. **Staging billing:** authorize linking `bitesites-outbound-staging` to the
   same Firebase billing account used by BiteSites production. This can incur
   Google Cloud usage charges. External dialing remains technically disabled.
2. **Staging deployment:** after billing is linked, authorize the first deploy
   of rules, indexes, Functions, and Hosting to the staging project. No
   production deploy is included.
3. **Paid screening:** authorize paid Twilio Lookup line-type and reassigned-
   number checks, plus procurement/enrollment for National and applicable
   state DNC scrubbing. A carrier-backed AI call remains blocked without a
   fresh server-held screening result.
4. **Legal policy:** obtain counsel-approved, jurisdiction-specific decisions
   for artificial/AI voice consent, disclosure wording, DNC and state-list
   process, calling windows, cadence, consent retention/revocation, voicemail,
   and the unrecorded posture. Watcher and Byte-Dialer rows are not evidence of
   consent and remain ineligible.
5. **Internal rehearsal cohort:** identify the exact internal numbers and
   participants who will give written, seller-specific AI/artificial-voice
   consent for the first ten calls. This is the first allowed carrier cohort.
6. **Seller calendars:** approve each seller's Google calendar/host, timezone,
   hours, buffers, lead time, booking horizon, location, cancellation rules,
   and handoff contact. For Stone, confirm showroom visiting hours and the
   person who receives the appointment. For Fine Line, confirm assessment
   coverage and emergency escalation contact.
7. **Human handoff:** approve the staffed hours, recipient list, maximum answer
   time, and fallback when nobody accepts. Recommended initial SLA: offer a
   callback rather than hold the prospect if no named person accepts within
   30 seconds.
8. **Budget:** approve initial limits. Recommended: one concurrent call, one
   attempt per target, no retry inside 24 hours, ten-minute hard duration,
   $50/day, $500/month, and a $3 all-in warning ceiling per connected AI call.
9. **External canary:** after legal, carrier, calendar, screening, and ten-call
   evidence are green, separately authorize at most 25 eligible calls per day.
   This is not authorized now and cannot be inferred from a staging approval.

## Promotion evidence

| Stage | Required evidence | Promotion authority |
|---|---|---|
| Offline backend | Full test suite; zero critical seller/tool/policy evaluation failures | Engineering owner |
| Non-dialing staging | Separate Firebase project; no production bindings; external-dialing gate proven; deployed callable/UI smoke test | Engineering owner after billing/deploy authorization |
| Internal carrier rehearsal | Ten specifically consented internal calls; 100% transcript/event review; no critical failures; provider retry/teardown evidence | Business owner |
| External canary | Counsel sign-off; fresh DNC/reassigned/line checks; verified caller identity; calendars and human handoff staffed; budget alerts | Business owner, explicit 25/day authorization |
| Wider rollout | 48-hour stable cohort, zero critical failures, reviewed quality and unit economics | Business owner for each 100/day and 500/day step |

## Research-to-conversation contract

Research is useful only when its source and permitted spoken use survive all
the way to the live call.

1. Ingest first-party CRM history, official seller/target sources, approved
   public-business records, and source-specific trigger data into structured
   observations.
2. Store source URL or record ID, observation time, evidence type, confidence,
   expiration, and one of `speakable`, `discovery_only`, or `never_speak`.
3. Convert observations into seller-specific hypotheses and questions. A
   hypothesis is never promoted to a factual opener.
4. Require human approval during the initial rollout, then seal the approved
   call plan to seller, target, contact, policy version, and content hash.
5. Let the runtime use the plan for the opener, discovery order, objection
   handling, qualification, and next-best authorized action. Tool results—not
   model confidence—control booking, follow-up, DNC, and handoff claims.
6. Feed dispositions, kept appointments, won work, collected revenue, and cost
   back into source/call-plan/version reporting. Do not let calls rewrite their
   own playbook automatically.

Source ROI is measured incrementally by seller and cohort:

`source cost -> eligible targets -> connects -> qualified opportunities -> booked appointments -> kept appointments -> won work -> collected revenue`

Start with first-party CRM and official business sources because they have the
best verification and attribution. Add paid sources only through controlled
cohorts, retaining a source when its incremental kept-appointment or collected-
revenue lift exceeds acquisition plus research cost without increasing DNC,
complaint, or bad-data rates.

## Capability ceiling

The current tool bench is sufficient to close for a verified appointment. It
is intentionally insufficient to close a binding agency, countertop, or
construction sale. A later productized-sale level would require a locked,
versioned catalog; server-calculated price/tax/scope; named proposal approval;
e-signature state from verified webhooks; PCI-hosted payment links; refund and
discount authority; and financial reconciliation. Bespoke work should retain
human approval even after that infrastructure exists.
