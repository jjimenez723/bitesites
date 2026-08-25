# Outbound calling — setup, providers, and what is not ready

> **2026-08-24 safety update:** Production authority and rollout limits are now
> governed by [OUTBOUND_PRODUCTION_READINESS.md](./OUTBOUND_PRODUCTION_READINESS.md).
> Where this older setup guide describes three-to-five live lines, autonomous
> GoHighLevel AI, recording, or a looser retry policy, the readiness plan and
> server-enforced one-leg/one-attempt/unrecorded L2 ceiling take precedence.

> **Nothing in this document makes an outbound campaign lawful.** The controls
> described here are technical: they enforce settings an administrator
> configured. Consent basis, jurisdictions, calling hours, recording and AI
> disclosure, scripts, opt-out handling, automated-dialing rules and
> telemarketing registration all require review and sign-off by legal counsel
> **before** a live campaign runs. The compliance checklist at the end of this
> document is a starting point for that conversation, not a substitute for it.

## Status

| Piece | State |
|---|---|
| Provider-neutral architecture | Implemented and tested |
| Mock dialer | Implemented, fully exercised — this is what the tests run on |
| Kixie adapter | Implemented for what Kixie documents; **unverified against a live account** |
| GoHighLevel outbound | Autonomous AI **disabled** — an external workflow cannot enforce the signed runtime, so `capabilities.aiAgentCall` is `false` and a campaign cannot be created that way |
| GoHighLevel contact reading | Read-only lead source, separate `contacts.readonly` credential, one permitted endpoint; feeds the no-dial eligibility audit and cannot start a call |
| Twilio / Hybrid V2 | Controlled adapter, browser voice, AI sideband and fail-safe implemented; **live end-to-end canary still required** |
| Firestore rules and indexes | Implemented and tested; deployed to **staging** 2026-08-24; **not deployed to production** |
| Cloud Functions | Implemented; deployed to **staging** 2026-08-24 and smoke-tested there; **not deployed to production** |
| Provider webhooks | Endpoint implemented; **no provider is configured to call it** |
| Pre-dial screening | Ingestion path implemented and admission-denied; National/state DNC has **no vendor procured** |
| Eligibility audit | Implemented — an admin can measure a list against every dial-time gate without dialling |
| Legal / compliance review | **Not done** |
| Live test call | **Not performed** |

**This feature is not production-ready.** Every row marked *unverified* or *not
done* has to be closed first.

## Architecture

```
Browser (admin console)
  └─ callable functions only — never a provider credential, never a phone call
      └─ Cloud Functions (Admin SDK)
          ├─ outbound-calls.js      campaigns, targets, sessions, the state machine
          ├─ outbound-contacts.js   one contact layer over leads + prospects, locking
          ├─ outbound-compliance.js DNC, calling hours, attempts, disclosures
          ├─ lead-enrichment.js     the sourced brief
          └─ providers/calling/     mock | kixie | gohighlevel | twilio
                └─ provider APIs

provider webhook ──▶ /api/outbound-events?provider=<id> ──▶ recordOutboundCallEvent
```

The browser never places a call, never holds a credential, and never decides
which of several ringing lines won. All three are server-side.

## Provider capability matrix

Rendered live in **Outbound Calls → Settings**, from the same flags the server
enforces. Reproduced here for reference.

| Capability | Mock | Kixie | GoHighLevel | Twilio |
|---|:--:|:--:|:--:|:--:|
| Start a call on demand | ✅ | ❌ | ✅¹ | ✅ |
| AI agent calls | ✅ | ❌ | ❌⁸ | ❌ |
| Power dialing | ✅ | ✅² | ❌ | ✅ |
| **BiteSites-controlled parallel dialing** | ✅ | ❌ | ❌ | ✅ |
| Per-leg call ids | ✅ | ✅ | ❌³ | ✅ |
| Human-answer detection | ✅ | ❌⁴ | ❌ | ✅ (AMD) |
| Cancel a ringing leg | ✅ | ❌ | ❌ | ✅ |
| Browser audio for the rep | ✅ | ✅⁵ | ❌ | ✅⁶ |
| Signed webhooks | ✅ | ❌⁷ | ❌⁷ | ✅ |
| Recordings | ✅ | ✅ | ✅ | ✅ |
| Max concurrency BiteSites controls | 5 | 1 | 1 | 5 |

1. Indirectly — by enrolling a contact in a published workflow whose first
   action is a Voice AI outbound call.
2. Through the Kixie PowerCall agent, from a PowerList BiteSites prepared.
3. No call id exists at enrolment; it arrives with the completion webhook.
4. Kixie's AI Human Detect runs inside Kixie. BiteSites is told the outcome, not
   the moment of detection.
5. In the PowerCall extension, not in the BiteSites dashboard.
6. Requires a TwiML application and a Voice SDK token endpoint — **not built**.
7. Shared custom header, compared in constant time. That is a secret, not a
   signature.
8. Was ✅. Turned off deliberately: a published GoHighLevel workflow owns its
   own prompt, retries, recording and tool surface, so it cannot prove it is
   executing the signed BiteSites call manifest. `assertSupports('gohighlevel',
   'ai')` therefore fails and an AI campaign cannot be created on it. The rest
   of this row's ✅ marks — power dialing, per-leg ids, cancellation — were
   already ❌, which is why Twilio is the controlled path.

### Kixie — verified findings

§29 asked for verification before implementing a production Kixie adapter. What
this repository has evidence for is the automation endpoint
`https://apig.kixie.com/app/event` with `eventname: "updatepowerlist"`, which
the BiteSites-Leads fork already uses in production
(`~/Dialer/functions/kixie.py`, `docs/kixie-parallel-dialer.md`).

**That endpoint adds a contact to a PowerList. It does not place a call.**

In the Kixie model, the human agent opens PowerCall, selects the PowerList, and
Kixie's own Multi-Line PowerDialer dials it. Kixie — not BiteSites — decides how
many lines run, which answer wins, and which legs get dropped.

So BiteSites cannot: start a specific call on demand, cancel one ringing leg, or
run its own first-answer-wins transaction. §33 requires a *server-authoritative*
state machine that cancels losing legs; Kixie cannot provide the primitives for
one, and `assertSupports('kixie', 'parallel', n)` therefore returns
`ok: false` and a campaign cannot be created that way. **No capability has been
faked.**

What BiteSites does get back, through the `answeredcall`/`endcall`/`disposition`
webhooks, is a per-call id, a status, a disposition, a duration and a recording
URL — enough to keep call history, target states and campaign metrics accurate.

**Still unverified** (needs a live Kixie account): whether the API is enabled on
the plan, whether custom webhook headers can be configured, the exact event
payload shape for the specific account, and whether the PowerList concurrency is
configurable 1–5.

### Recommendation

**Twilio Programmable Voice is the provider for a genuinely custom parallel
dialer.** It is the only one here that exposes all four primitives the state
machine needs: a per-leg call SID at creation (`POST /Calls`), Answering Machine
Detection, a documented cancel (`POST /Calls/{sid}` with `Status=canceled`) that
works while a leg is ringing, and real request-signature validation.

The adapter is implemented. What is **not** built and would be needed before a
rep can hear a call in the browser:

- A TwiML application and its voice URL
- A Voice SDK access-token endpoint
- Caller-ID registration, A2P/STIR-SHAKEN attestation

If a hosted parallel dialer is acceptable instead of a custom one, Orum and
Nooks are the products in that category; if power dialing matters more than
custom parallel dialing, PhoneBurner and JustCall are. **None of these was
evaluated here.**

## Secrets

Server-side only, in Google Secret Manager. Never in `.env`, never in source,
never in a `VITE_` variable, never in Firestore.

```bash
# The webhook endpoint every provider posts to (a high-entropy value you generate)
firebase functions:secrets:set OUTBOUND_WEBHOOK_SECRET

# Kixie
firebase functions:secrets:set KIXIE_API_KEY
firebase functions:secrets:set KIXIE_BUSINESS_ID
firebase functions:secrets:set KIXIE_POWERLIST_ID
firebase functions:secrets:set KIXIE_WEBHOOK_SECRET

# Twilio
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_TWIML_APP_SID

# GoHighLevel outbound (GHL_API_TOKEN already exists for the inbound integration)
firebase functions:secrets:set GHL_OUTBOUND_WORKFLOW_ID

# GoHighLevel contact reading for the no-dial eligibility audit. A Private
# Integration scoped to contacts.readonly, deliberately NOT the write-capable
# GHL_API_TOKEN — see LEAD_DISCOVERY_SETUP.md.
firebase functions:secrets:set GHL_CONTACTS_READ_TOKEN

# Lead discovery
firebase functions:secrets:set LEAD_SOURCE_API_KEY      # Google Places
firebase functions:secrets:set DISCOVERY_WORKER_SECRET  # the local scraping worker
```

Every webhook **fails closed**: an unset secret, or the literal placeholder
`unset`, or anything shorter than 16 characters, returns `503 not-configured`
rather than accepting the request.

## Webhook setup

Add a Hosting rewrite so providers get a stable BiteSites URL:

```json
{ "source": "/api/outbound-events",
  "function": { "functionId": "recordOutboundCallEvent", "region": "us-central1" } }
```

Then, per provider:

**Kixie** — create real-time webhooks for `answeredcall`, `endcall` and
`disposition` (optionally `startcall`) pointing at
`https://bitesites.org/api/outbound-events?provider=kixie`, with the custom
header `X-BiteSites-Kixie-Secret: <KIXIE_WEBHOOK_SECRET>`. Do not put the secret
in the URL.

**GoHighLevel** — point the workflow's completion webhook at
`https://bitesites.org/api/outbound-events?provider=gohighlevel` with
`X-Webhook-Secret: <OUTBOUND_WEBHOOK_SECRET>`. Pass through the
`bitesites_campaign_id` and `bitesites_target_id` custom fields; without them
the event is correctly ignored as inbound.

**Twilio** — no manual setup. The adapter sets `StatusCallback` per call, with
identity in the query string, and validates `X-Twilio-Signature` against the
auth token.

## GoHighLevel workflow setup

§30 warns against assuming the existing call-log endpoint can initiate calls. It
cannot. Outbound goes through workflow enrolment:

1. In the target sub-account, create a Private Integration with `contacts.write`
   and `conversations/message.write`.
2. Activate LC Phone or a supported Twilio connection; complete number
   verification and A2P registration.
3. Enable outbound Voice AI, accept its terms, complete KYC if prompted.
4. Publish a workflow whose **first action** is the Voice AI outbound call.
5. Add custom fields `bitesites_campaign_id`, `bitesites_target_id`,
   `bitesites_contact_type` so completion events can be matched deterministically
   rather than by timestamp proximity.
6. Copy the workflow ID into `GHL_OUTBOUND_WORKFLOW_ID`.

The workflow owns timing, retries, concurrency and the agent prompt. BiteSites
hands over a contact and a brief and loses control until an event returns —
which is why `requireResearchApproval` matters most for this provider.

## What the existing integration keeps doing

Untouched: `syncLeadToGoHighLevel`, `recordVoiceCall`, `pollVoiceCalls`,
`importVoiceHistory`, the Byte browser voice widget, transcript import,
call-to-lead linking and provider-call-id deduplication.

The outbound normaliser returns `null` for any GoHighLevel payload without
BiteSites campaign metadata, so the inbound and outbound paths cannot fight over
an event, and no outbound call creates a duplicate `byte_voice` lead.

Calls with no `direction` field — every call recorded before this feature — are
treated as inbound everywhere they are read.

## The dialer modes

**AI** (`runAICampaigns`, every 5 minutes): lock a target → compliance → local
time → brief → approval if required → provider contact → start the call → store
the provider call id → `dialing` → authenticated events → transcript, recording,
disposition → update the contact → activity → retry/Call Later/complete →
promote only under the conversion rules.

**Power**: lock one target, show its brief, one call, wait, capture a
disposition, then the next. Two users cannot hold the same target.

**Parallel** (1–5 lines): lock up to N, one call record and one provider leg
each, process every event independently, and on the first **verified human**
answer run a Firestore transaction that only wins if no `connectedCallId` is set.
The winner is bridged; every other leg is cancelled at the provider and marked
`cancellationReason: "another_call_connected"`. Eligible losers return to Call
Later with a safe `nextAttemptAt` **and their attempt rolled back** — their phone
rang and nobody spoke to them. Losers that are invalid, opted out or
attempt-exhausted are resolved, not requeued.

## Emergency stop

**Pause the campaign.** Every entry point re-reads campaign status, so a paused
campaign stops recruiting within one poll. Cancelling additionally releases every
lock. To stop everything at once, pause each running campaign — Outbound Calls →
Campaigns, the Pause button. To disable the feature entirely, remove the
`runAICampaigns` schedule and redeploy.

## Test commands

```bash
npm run test:prospects          # normalisation (pure)
npm run test:dedupe             # dedupe, compliance, Airbnb boundary, CSV (pure)
npm run test:migration          # the migration tool's pure halves
npm run test:discovery          # discovery + import, emulator
npm run test:conversion         # prospect → lead, emulator
npm run test:outbound           # the dialer state machine, emulator
npm run test:outbound-webhook   # webhook auth + redelivery, emulator
npm run test:enrichment         # research + brief, emulator
npm run test:rules              # Firestore security rules
npm run test:all                # everything, plus the build
```

No automated test places a call, mutates provider state, or touches a real
Firebase project.

**One exception, and it is deliberate.** `npm run test:import`
(`functions/voice-import.test.mjs`) reads a **read-only** GoHighLevel token from
`~/.ghl-token` and pulls the live call log into the emulator, because the
properties it pins — a repeat caller collapsing to one lead, `createdAt` being
the call's own date — only show up against real data shapes. It **skips itself**
when that file is absent, so CI never contacts a provider and never reads a
credential. On a developer machine that has the token, `npm run test:all` does
both, read-only. It also means the suite needs DNS on such a machine: a network
outage fails that one test with `ENOTFOUND services.leadconnectorhq.com` rather
than skipping it.

## Deployment order

> The order below is for a **production** deploy, which has not happened for
> this workstream. Staging has its own helper and its own guard rails —
> [STAGING_ENVIRONMENT.md](./STAGING_ENVIRONMENT.md). Run
> `npm run preflight:production` first: `functions/.env.bitesites-org` is
> untracked, so whatever it says is deployed without ever appearing in a diff.

1. `npm run test:all`
1. `npm run preflight:production`
2. `npm run deploy:functions` — **before** the rules, so nothing depends on an
   undeployed function
3. `firebase deploy --only firestore:indexes`
4. `firebase deploy --only firestore:rules`
5. Configure provider webhooks
6. Rehearse the whole flow on the **mock** provider
7. `node scripts/migrate-watcher-leads.mjs --inspect` then `--dry-run`
8. Review the dry-run results
9. One explicitly approved live test call to a consented number you control
10. `npm run deploy:hosting`
11. Production migration — **only after separate approval**

> `npm run ship` now deploys Functions first, followed by Hosting and, when you
> answer `Y`, Firestore rules and indexes. This preserves the required deployment
> order for this feature.

## Compliance checklist for legal review

Every item is a decision for counsel, not a setting with a right default.

- [ ] Consent basis for each list, and whether a scraped number has one
- [ ] Jurisdictions in scope; state-level rules beyond the federal baseline
- [ ] Calling hours (the default here is 09:00–18:00 local, tighter than the
      federal 8am–9pm — confirm the intended window)
- [ ] Whether an unknown timezone should block a call (it does)
- [ ] Recording and transcription disclosure, including two-party-consent states
- [ ] AI disclosure wording and placement
- [ ] Approved call scripts and objection handling
- [ ] Opt-out handling, retention, and propagation across campaigns
- [ ] Whether this system constitutes an ATDS in the relevant jurisdictions
- [ ] Abandoned-call rate limits for parallel dialing
- [ ] National and state DNC registry scrubbing — **no vendor is procured**.
      The ledger and the ingestion path exist and fail closed without a dated
      snapshot id from a real service; the internal DNC list is a suppression
      record, not a registry check, and no code can substitute for the
      subscription
- [ ] Caller-ID registration and STIR/SHAKEN attestation
- [ ] Data retention for recordings, transcripts and raw scrape payloads
- [ ] Privacy notice coverage for cold contacts
- [ ] Provider terms — Google Places caching and redistribution limits in
      particular
