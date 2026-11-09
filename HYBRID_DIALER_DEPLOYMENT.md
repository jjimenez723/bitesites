# BiteSites Hybrid Dialer V2 — Deployment Runbook

This runbook takes the code in `agent/hybrid-ai-dialer-v2` from a green build to a controlled live deployment. Do not place production calls until the final verification section passes with numbers owned or explicitly authorized by the project team.

## Automated setup

Use the repository automation instead of running each workspace manually:

```bash
npm run setup                # Node/dependencies/build/tests plus non-secret preflight
npm run preflight:hybrid     # local + Firebase/Google Cloud readiness report
npm run configure:hybrid     # consume exported credentials without writing them to disk
npm run dry-run:hybrid       # validate the targeted Firebase deployment without changes
npm run deploy:hybrid        # gated deploy after preflight and validation pass
```

`configure:hybrid` reads the secret names listed below from the current process environment, sends populated values directly to Firebase Secret Manager over stdin, and never prints or writes those values. It also generates `AI_MEDIA_WEBHOOK_SECRET` when that shared secret does not exist, and makes sure `PUBLIC_APP_URL` is in the ignored Functions parameter file without touching anything else there.

When `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are supplied and no browser key or TwiML App is stored yet, the command verifies the Twilio account, creates/reuses the `BiteSites Hybrid Voice` TwiML App with the production callback, creates the browser Voice API key, and stores the returned one-time key secret directly in Secret Manager.

For example, export the values in your current terminal (do not save this command in shell history), run `npm run configure:hybrid`, and then unset them. The command is incremental: existing secrets remain in place and only supplied values receive a new version.

The deploy command targets the Hybrid V2 Functions plus Hosting and Firestore, including the new training and default-campaign callables. It does not redeploy unrelated legacy Kixie, email, or lifecycle functions, so those providers do not need to be reconfigured for this release.
During Firebase analysis, the command temporarily selects `functions/hybrid-index.js` and always restores the normal package entrypoint in a `finally` block.
There is no Cloud Run service any more: since 2026-11-07 the AI voice runs on ElevenLabs (section 4).

**Human-gate parameter note:** the local production parameter file intentionally
keeps `OUTBOUND_EXTERNAL_DIALING=disabled`. A broad Hybrid deploy propagates
that fail-closed value, including to the human browser-token endpoint. If the
separately approved §11 human-only gate is already open, restore only
`getHybridVoiceAccessToken`, `dialHybridTargets`, `endHybridCall`,
`submitHybridDisposition`, `resumeHybridAutoDial`, and `recordHybridCallEvent`
with `OUTBOUND_EXTERNAL_DIALING=enabled` and the §11 deploy authorization.
Leave AI dispatch functions and paid screening disabled.


## 1. Production architecture

- **Firebase Functions + Firestore** are the control plane: authentication, call ownership, DNC, call state, AI profiles, prompt compilation, transcripts, audit events, voicemail policy, and carrier control.
- **Twilio Programmable Voice** originates the PSTN calls, runs AMD, hosts one conference per prospect call, and provides browser audio through the Voice SDK.
- **ElevenLabs Agents over SIP** supplies one isolated AI voice session for each answered call routed to AI. Twilio dials the ElevenLabs SIP endpoint and joins that leg to the call's conference. ElevenLabs holds no Firebase or Twilio credentials: it fetches each call's compiled settings from `/api/hybrid-ai-call-init`, runs every tool through `/api/hybrid-ai-tools`, and posts the transcript to `/api/hybrid-ai-post-call` when the call ends. See `functions/live-call-elevenlabs.js`.

## 2. Firebase server configuration

The following values are server-only. Never place them in the Vite/browser environment or Firestore documents.

### Secret Manager values

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_API_KEY_SID`
- `TWILIO_API_KEY_SECRET`
- `TWILIO_TWIML_APP_SID`
- `AI_MEDIA_WEBHOOK_SECRET`
- `ELEVENLABS_API_KEY` (already used by Bit, Byte and rep practice)
- `ELEVENLABS_SIP_PASSWORD`: the password Twilio presents to the ElevenLabs SIP trunk
- `ELEVENLABS_WEBHOOK_SECRET`: the post-call webhook signing secret, written by the setup script

`AI_MEDIA_WEBHOOK_SECRET` should be a high-entropy value. The setup script copies it into an ElevenLabs workspace secret, which ElevenLabs sends as the `x-ai-media-secret` header on every tool call and initiation webhook. It is never presented to a browser. No OpenAI key or project is used.

### Firebase deployment parameters

- `PUBLIC_APP_URL=https://bitesites.org`

Deploy the parameters with the same Firebase project that serves `bitesites.org`.

## 3. Twilio setup

### Programmable Voice number / caller ID

Use a Twilio number or other caller ID that the account is authorized to present. Campaign `callerId` values must match a number the Twilio account may actually use.

### Browser Voice API key

Create a Twilio API Key for browser Voice access. Store the SID and secret as `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`. The secret must never be sent directly to the browser; Firebase signs short-lived Voice access tokens.

### TwiML App

Create or select the TwiML App referenced by `TWILIO_TWIML_APP_SID` and configure its Voice Request URL as:

`https://bitesites.org/api/twilio-browser-twiml`

Method: `POST`.

The browser Voice SDK connects only through the short-lived token and this TwiML route. The TwiML route checks that the Twilio client identity corresponds to the rep who owns the dialer session before joining the conference.

### Twilio callback endpoints

The application generates the callback URLs for prospect legs, conference events, AI SIP legs, and voicemail. Do not point Hybrid V2 calls back to the legacy first-answer-wins webhook.

Relevant hosted routes are:

- `https://bitesites.org/api/hybrid-outbound-events`
- `https://bitesites.org/api/twilio-prospect-twiml`
- `https://bitesites.org/api/twilio-browser-twiml`
- `https://bitesites.org/api/twilio-conference-events`
- `https://bitesites.org/api/twilio-ai-participant-twiml`
- `https://bitesites.org/api/twilio-ai-sip-events`
- `https://bitesites.org/api/twilio-hybrid-voicemail`

Twilio signatures are validated on the Twilio-facing HTTP endpoints.

## 4. ElevenLabs setup for AI calls

AI calling moved from OpenAI Realtime to ElevenLabs on 2026-11-07 (branch `feat/elevenlabs-live-calls`). **ElevenLabs setup ran on 2026-11-08 with the owner's go-ahead**: `ELEVENLABS_SIP_PASSWORD` is in Secret Manager, and the account has the header secret, 18 webhook tools, the `BiteSites Live Calls` agent, the tool-free preview agent, a password-protected SIP trunk entry (`bitesites-live-calls`) and the account's initiation webhook pointing at `/api/hybrid-ai-call-init`. The Grooming Cove's agents were checked afterwards and still have that webhook turned off. **The Functions are not deployed**, so no AI call can reach these yet, and none has been tested.

The signed post-call webhook was **not** created: the ElevenLabs API key lacks the `webhooks_write` permission. It is optional. The minute reconciler fetches each transcript from ElevenLabs after the AI leg ends (`syncPendingTranscripts`), using only the existing key. To add the faster webhook later, create an HMAC webhook for `https://bitesites.org/api/hybrid-ai-post-call` in the ElevenLabs dashboard, store its signing secret as `ELEVENLABS_WEBHOOK_SECRET`, attach it to the `BiteSites Live Calls` agent only (never as the account default), and put its id in `functions/live-call-agent-ids.js`.

1. Create the SIP password once and store it: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | firebase functions:secrets:set ELEVENLABS_SIP_PASSWORD --data-file - --project bitesites-org`.
2. With the owner's go-ahead (it changes account-wide ElevenLabs settings), run `scripts/setup-live-call-agents.mjs` (done 2026-11-08; rerun after changing a tool or the agent settings) as shown at the top of that file. It creates the header secret, one webhook tool per grantable tool, the live-call agent, a tool-free preview agent, a SIP trunk entry protected by the password, a post-call webhook used only by this agent (its signing secret goes straight into Secret Manager), and the account's initiation webhook URL. It refuses to replace an initiation webhook that belongs to someone else: this ElevenLabs account also holds The Grooming Cove's agents.
3. Commit the regenerated `functions/live-call-agent-ids.js`.

The pieces and what each is trusted to do:

| Piece | Job | Guard |
|---|---|---|
| `dispatchHybridAIToSip` | Has Twilio dial `sip:<user>@sip.rtc.elevenlabs.io:5061;transport=tls` with `X-BiteSites-Call-ID` | Staging gate, setup check, one claim per call |
| `hybridAICallInit` | Attaches the AI as controller and returns the compiled prompt, a fixed opening line with the AI disclosure, and the voice | Header secret, our agent id only, call must still be routed to AI |
| `hybridAITools` | Runs every tool through `executeAgentTool` | Header secret, conversation must be the one attached to that call, grant re-checked from Firestore |
| `reconcileHybridAIMediaAttachments` | Every minute, also fetches transcripts of ended AI calls into `calls/{id}/turns`; gives up after 30 minutes and marks `transcriptMissing` | Our agent only, finished conversations only |
| `hybridAIPostCall` | Optional faster transcript path (not configured) | HMAC signature, our agent only, matching conversation |
| `hybridAIHandoffCarrier` | On a handoff, mutes the AI and plays the handoff line to the conference; ends the AI leg once a person owns the call | Firestore trigger on `calls/{id}` |
| `hybridAIHandoffAnnouncement`, `hybridAIHandoffAudio` | The handoff line, spoken in the agent's own voice by ElevenLabs text-to-speech | Twilio signature; per-call HMAC token |
| `twilioHybridAISipEvent` | If the AI leg ends while the AI still owns the call, ends the prospect's leg too | Twilio signature |

What changed in behavior, compared with the OpenAI sideband:

- **No live transcript during the call.** ElevenLabs gives the server no stream of an in-progress phone call, so transcripts arrive within about a minute of the call ending. A rep can still listen live.
- **The opening line is fixed** ("Hi, this is an AI assistant calling on behalf of <legal seller>. Do you have a quick minute?"), so the AI disclosure no longer depends on the model.
- **Handoff timing.** The rep joins while the handoff line plays, instead of after the AI's audio buffer drained. If the announcement fails, the handoff still completes.
- **Voice model.** ElevenLabs requires English agents to use `eleven_flash_v2`, which is what the agent, the handoff line and the preview sample use.
- **Hang-up.** The agent hangs up with ElevenLabs' built-in end-call tool (`end_call`), after the server `end_call` tool (shown to the agent as `record_call_outcome`) records the outcome.
- **Tool retries.** ElevenLabs sends no per-call tool id, so a retry is recognized by conversation, tool and arguments, and gets the stored result.

None of this has been tested on a real call. Section 8 still applies in full before any AI call reaches a prospect.

## 6. Deploy Firebase and Hosting

Before deployment:

1. Run the repository secret scanner.
2. Run the root production build.
3. Run `npm run test:hybrid-dialer`.
4. Run `npm run test:agent-runtime`.
5. Run the Functions syntax check.

Then deploy the Firestore rules/indexes, Firebase Functions, and Firebase Hosting rewrites from this branch.

Do not merge/deploy if the Outbound AI CI workflow is red.

## 7. Configure an AI agent before dialing

In `/admin/outbound`:

1. Open **AI Agents**.
2. Create an agent profile.
3. Set personality/tone, objective, permissions, disclosures, prohibited claims, handoff phrase, model, and voice.
4. Create/select any approved knowledge bases.
5. Validate the runtime preview.
6. Associate/select the profile when starting the Hybrid Dialer.

A session may add a temporary day/session instruction, but lower-priority configuration cannot grant capabilities that the saved profile denied.

## 8. Controlled live verification

Run this sequence with numbers owned by or explicitly authorized for testing.

### Test A — single human answer

- Start a Hybrid session.
- Launch the three-call batch with only one controlled number expected to answer.
- Confirm the browser prompts for microphone access on the rep's launch action.
- Confirm the answered human is routed to the rep.
- Confirm browser audio joins the same Twilio conference.
- End the call and confirm the next batch can be launched without starting a new session.

### Test B — simultaneous human answers

- Arrange for at least two controlled numbers to answer close together.
- Confirm exactly one answer becomes `human` for the rep.
- Confirm the second answer remains connected and becomes `ai` rather than being cancelled.
- Confirm the two conversations are isolated.

### Test C — transcript and listen

- Let the AI conversation continue.
- Confirm prospect and AI transcript turns appear, with speaker labels, once the call ends (ElevenLabs sends them after the call).
- Click **Listen** and verify the rep hears both sides while the rep microphone is not sent to the conference.
- Stop listening and verify the AI conversation continues.

### Test D — smooth takeover

- Click **Take Over** on an AI call.
- Confirm the AI goes quiet and the configured handoff phrase plays in the agent's voice.
- Confirm the rep's browser leg joins while or right after the phrase plays.
- Confirm the rep then joins the existing conference and the prospect is not redialed.
- Confirm the AI SIP leg exits after human ownership is established.

### Test E — prospect asks for a human

- Have the test prospect explicitly ask for a human.
- Confirm the call receives the `Human requested` priority state.
- With Auto Takeover off, confirm no automatic transfer occurs.
- With Auto Takeover on and the rep free, confirm the smooth handoff begins.
- With the rep busy, confirm the request remains queued rather than interrupting the rep's current call.

### Test F — DNC

- Have the prospect explicitly say not to call again.
- Confirm the AI invokes the bounded DNC tool.
- Confirm the contact becomes globally suppressed through the existing DNC model.
- Confirm the current PSTN prospect leg terminates.
- Confirm a future campaign/session cannot dial the suppressed number.

### Test G — voicemail

- Send one test call to a controlled voicemail endpoint.
- Verify AMD classifies the call as a machine.
- Confirm no conversational AI is attached.
- Confirm the configured campaign voicemail policy either leaves the approved message or ends/requeues the target.

### Test H — audit/history

For the above calls, verify the stored call/audit data contains the expected rep/session/campaign/target attribution, controller transitions, agent profile/version/hash, transcript, disposition, DNC/handoff events, timestamps, and recording metadata when recording is enabled.

## 9. Production enablement gate

Production outbound dialing should remain disabled until all of the following are true:

- Firebase Functions and Hosting are deployed from a green commit.
- `scripts/setup-live-call-agents.mjs` has run and `functions/live-call-agent-ids.js` is committed.
- Twilio credentials, API key, TwiML App, caller ID, and callbacks are configured.
- The ElevenLabs agent, SIP trunk, initiation webhook and post-call webhook are configured, and one test call has reached `hybridAICallInit`.
- All controlled live tests above pass.
- Campaign consent basis, calling hours, AI/recording disclosures, voicemail scripts, DNC handling, and jurisdiction-specific requirements have been reviewed for the intended audience.

## 10. Current access model

The repository supports least-privilege `outbound_rep` and
`outbound_manager` roles. This branch adds campaign-level rep assignment:
managers create campaigns and select which active sales reps may dial each
one. Rep campaign queries require the rep UID in
`allowedRepUids`; Firestore rules and the server's session-start and
dial/refill checks enforce the same account and assignment boundary. Older
campaigns with no assignments are manager-only until edited.

For human-led calls, terminal webhooks hold the next refill until the rep saves
an outcome. `interested` disables auto-dial and opens a rep-composed email to
the lead's stored address; email suppression and campaign/session ownership
are checked server-side. The rep explicitly sends or skips the message and
resumes dialing. These campaign-assignment and follow-up changes were deployed
on 2026-10-27 with owner authorization. Current production state and the later
rep-training release are recorded in
[OUTBOUND_OWNER_CHECKLIST.md](./OUTBOUND_OWNER_CHECKLIST.md).

## 11. Rep sign-in correction — 2026-10-28

`getRepTrainingStatus` failed with `ReferenceError: createHash is not defined`;
its module now imports `createHash` from `node:crypto`. The rep portal's
warm-transfer listener also used an account-wide calls query that could not
prove assigned-campaign access under Firestore rules. Rep queries now filter by
campaign IDs already returned by the rep-authorized campaign list. The matching
`calls` composite index was created directly and reached READY; this preserved
the existing live indexes not declared in the repository index file. The
targeted release updated only `getRepTrainingStatus` and Hosting. Firestore
rules and human-dialing functions were not redeployed.

**Earlier October 29 checkpoint — before the backend redeployment.** `repTrainingProgressId` is also
called by `createRepTrainingSession` and `completeRepTrainingAttempt`. Each
Cloud Function keeps its own bundle, so those two still run the pre-fix
`f6bd355` build deployed 2026-10-28 at 15:52–15:53 UTC, and every training
session start returns 500 (`hybrid-dialer-api.js:153`). A targeted release must
cover every deployed function whose bundle contains the changed module, not
only the one that surfaced the error. The fix needs:

```bash
# functions/package.json "main" set to hybrid-index.js, as scripts/hybrid.mjs does;
# functions/.env.bitesites-org present (its five values match the live functions).
firebase deploy --only functions:createRepTrainingSession,functions:completeRepTrainingAttempt --project bitesites-org
```

Deployed from `f0d9b19`, this changes exactly the `node:crypto` import line.
Deployed from a later `main`, it also carries the training-exemption code,
which has its own release decision. It awaits the owner’s authorization.


### Rep onboarding release — not yet authorized

This release needs Hosting plus `getRepTrainingStatus`, `createRepTrainingSession`, `completeRepTrainingAttempt`, and the two new functions `getRepCourse` and `submitRepCourseQuiz`. Every one bundles the changed training modules, so none can be left out. It changes no Firestore rules or indexes and does not touch dialing functions. `createRepTrainingSession` and `completeRepTrainingAttempt` now need the `ELEVENLABS_API_KEY` secret, which was set on 2026-11-06, and no longer use `OPENAI_API_KEY`. The 12 practice agents already exist in ElevenLabs, and their ids are in `functions/rep-practice-agents.js`. Attempts started before this release have no conversation id and must be restarted.

## 12. David's live-dialer restoration — October 29, 2026

The owner identified David's `555yunda` email and requested removing his
simulator requirement. The current backend already recognizes account-scoped
exemptions. Published Hosting and Firestore rules, corrected an assigned-campaign
query rejection, and applied David's exemption plus original campaign assignment
in one guarded administrative commit. The rep opens the human dialer directly;
no default campaign or invented training result is required. The other rep's
record is unchanged. No call was placed. Exact evidence and known test limitations
are in [REP_LIVE_DIALER_RESTORATION.md](REP_LIVE_DIALER_RESTORATION.md).

The earlier §11 missing-import checkpoint is historical: both role-play
functions had been redeployed before this task. Their downloaded October 29
source archives match main's corrected training helper and API. No real
role-play or evaluation was run during David's access restoration.
