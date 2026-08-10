# BiteSites Hybrid Dialer V2 — Deployment Runbook

This runbook takes the code in `agent/hybrid-ai-dialer-v2` from a green build to a controlled live deployment. Do not place production calls until the final verification section passes with numbers owned or explicitly authorized by the project team.

## Automated setup

Use the repository automation instead of running each workspace manually:

```bash
npm run setup                # Node/dependencies/build/tests plus non-secret preflight
npm run preflight:hybrid     # local + Firebase/Google Cloud readiness report
npm run configure:hybrid     # consume exported credentials without writing them to disk
npm run dry-run:hybrid       # validate the targeted Firebase deployment without changes
npm run bootstrap:sideband   # create a scale-to-zero URL before the OpenAI webhook exists
npm run deploy:hybrid        # gated deploy after preflight and validation pass
```

`configure:hybrid` reads the secret names listed below from the current process environment, sends populated values directly to Firebase Secret Manager over stdin, and never prints or writes those values. It also generates `AI_MEDIA_WEBHOOK_SECRET` when that shared secret does not exist. Set `OPENAI_PROJECT_ID` in the same process; the script writes only that public identifier and `PUBLIC_APP_URL` to the ignored Functions parameter file.

When `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are supplied and no browser key or TwiML App is stored yet, the command verifies the Twilio account, creates/reuses the `BiteSites Hybrid Voice` TwiML App with the production callback, creates the browser Voice API key, and stores the returned one-time key secret directly in Secret Manager.

For example, export the values in your current terminal (do not save this command in shell history), run `npm run configure:hybrid`, and then unset them. The command is incremental: existing secrets remain in place and only supplied values receive a new version.

The deploy command targets only the Hybrid V2 Functions plus Hosting and Firestore. It does not redeploy unrelated legacy Kixie, discovery, email, or lifecycle functions, so those providers do not need to be reconfigured for this release.
During Firebase analysis, the command temporarily selects `functions/hybrid-index.js` and always restores the normal package entrypoint in a `finally` block.
The Cloud Run phase creates or reuses a dedicated `bitesites-sideband` service account and grants it access only to the three sideband secrets.

OpenAI webhook setup is intentionally two-phase. After the initial credentials are configured, `bootstrap:sideband` deploys the service with a nonfunctional placeholder webhook secret and `min=0`, verifies `/health`, and prints the webhook URL. Create the `realtime.call.incoming` webhook at that URL, store its real signing secret with `configure:hybrid`, and only then run the final deploy. The final deploy replaces the placeholder with the Secret Manager binding and sets `min=1` for persistent sideband sockets.

## 1. Production architecture

- **Firebase Functions + Firestore** are the control plane: authentication, call ownership, DNC, call state, AI profiles, prompt compilation, transcripts, audit events, voicemail policy, and carrier control.
- **Twilio Programmable Voice** originates the PSTN calls, runs AMD, hosts one conference per prospect call, and provides browser audio through the Voice SDK.
- **OpenAI Realtime SIP** supplies one isolated AI voice session for each answered overflow call routed to AI.
- **Realtime sideband service** maintains the long-lived server-side OpenAI Realtime connection, transcript stream, approved tool calls, and smooth-handoff coordination. It has neither Firebase Admin credentials nor Twilio credentials.

## 2. Firebase server configuration

The following values are server-only. Never place them in the Vite/browser environment or Firestore documents.

### Secret Manager values

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_API_KEY_SID`
- `TWILIO_API_KEY_SECRET`
- `TWILIO_TWIML_APP_SID`
- `AI_MEDIA_WEBHOOK_SECRET`
- `OPENAI_API_KEY` only for the compatibility Firebase OpenAI endpoint; the live sideband service also requires its own server-side binding to the same or a separately scoped OpenAI key.

`AI_MEDIA_WEBHOOK_SECRET` should be a new high-entropy value and must match the value supplied to the sideband service. It is not an API key presented to the browser.

### Firebase deployment parameters

- `PUBLIC_APP_URL=https://bitesites.org`
- `OPENAI_PROJECT_ID=<OpenAI project identifier used for Realtime SIP>`

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

## 4. OpenAI Realtime setup

Use an OpenAI project intended for the BiteSites calling workload.

The Firebase parameter `OPENAI_PROJECT_ID` is used to address the OpenAI Realtime SIP destination when BiteSites creates an AI overflow leg.

Create an OpenAI project webhook for `realtime.call.incoming` and point it to the deployed sideband service:

`https://<sideband-service-domain>/openai/webhook`

Store the webhook signing secret as `OPENAI_WEBHOOK_SECRET` on the sideband service. The service verifies the OpenAI webhook signature before accepting a Realtime call.

The sideband service accepts the incoming Realtime call using the server-compiled profile, campaign/session overrides, approved knowledge, voice, model, and bounded tool list. The browser never sends the final system instructions directly to OpenAI.

## 5. Deploy the Realtime sideband service

The service lives in `services/realtime-sideband` and is containerized with its included `Dockerfile`.

Required runtime values:

- `OPENAI_API_KEY`
- `OPENAI_WEBHOOK_SECRET`
- `AI_MEDIA_WEBHOOK_SECRET`
- `FIREBASE_CONTROL_URL=https://bitesites.org/api/hybrid-sideband-control`
- `FIREBASE_CARRIER_URL=https://bitesites.org/api/hybrid-ai-carrier-control`
- `PORT` supplied by the hosting platform

The service must support long-lived outbound WebSocket connections. On Cloud Run, keep CPU available while an instance is alive so Realtime sideband sockets are not suspended after the webhook response returns.

The only intentionally public application endpoints on the sideband service are its OpenAI webhook receiver and health endpoint. All call mutations go back through the bounded Firebase control surface.

## 6. Deploy Firebase and Hosting

Before deployment:

1. Run the repository secret scanner.
2. Run the root production build.
3. Run `npm run test:hybrid-dialer`.
4. Run `npm run test:agent-runtime`.
5. Run the Functions syntax check.
6. Run the sideband syntax check.

Then deploy the Firestore rules/indexes, Firebase Functions, and Firebase Hosting rewrites from this branch.

Do not merge/deploy if the Hybrid Dialer V2 CI workflow is red.

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
- Confirm prospect and AI transcript turns appear live with speaker labels.
- Click **Listen** and verify the rep hears both sides while the rep microphone is not sent to the conference.
- Stop listening and verify the AI conversation continues.

### Test D — smooth takeover

- Click **Take Over** on an AI call.
- Confirm the AI speaks the configured handoff phrase.
- Confirm the browser human leg does not join until the AI output audio buffer has actually finished.
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
- Sideband health endpoint is healthy.
- Twilio credentials, API key, TwiML App, caller ID, and callbacks are configured.
- OpenAI API/project/webhook configuration is valid.
- All controlled live tests above pass.
- Campaign consent basis, calling hours, AI/recording disclosures, voicemail scripts, DNC handling, and jurisdiction-specific requirements have been reviewed for the intended audience.

## 10. Current access model

The current operational release remains **admin-operated** because the existing console and outbound Firestore reads are admin-only. This supports the current small team by assigning the dialer users existing admin access.

The V2 backend state model is already rep-scoped by `userUid` and prevents one session from controlling another rep's calls. A future least-privilege `outbound_rep` / `outbound_manager` console role should be released only together with matching Firestore query/rule scoping; do not expose those backend role names in the UI before the read model is properly isolated.
