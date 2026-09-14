# Admin dialer repair — 2026-09-14

Production Twilio diagnostics showed warning **21626** on each recent outbound
call: `initiated ringing answered completed` was submitted as one REST form
value. Twilio requires repeated `StatusCallbackEvent` keys. The rejected list
prevented ringing and completion updates; a recent call was still `open` in
Firestore after Twilio had completed it. The two answered calls inspected from
September 14 were classified as `machine_end_other`, with no browser leg.

The fix sends repeated form keys, persists carrier progress, and prevents late
answer classification from reopening a completed call. Completion takes
precedence when a callback also contains `AnsweredBy`.

Browser audio now shares pending joins between the call card and workspace,
waits for the SDK's `accept` event, reports asynchronous errors and timeouts,
refreshes access tokens before joining, and supports reconnecting audio. Listen
and coach modes use valid microphone constraints while remaining muted locally
and in TwiML. Both conference entry paths specify the conference callback.

The portal plays local ringback only after a carrier ringing event and stops it
when the call is answered or ends. Assignment alone no longer displays a live
microphone.

Validation:

- Production build and function syntax checks passed on the Node 22 workflow.
- `npm run test:hybrid-dialer`: 42 tests passed.
- `node --test functions/hybrid-twilio-signature.test.mjs`: 4 tests passed.
- Existing Firestore emulator suites: 147 outbound, 49 webhook, and 5 staff
  workflow checks passed.
- `npm run test:hybrid-webhook`: signed ringing, answer, rep assignment,
  conference TwiML, completion, and delayed AMD checks passed against the emulator.
- `npm run test:dialer-browser`: Chromium exercised placing a call, ringing,
  pending audio, SDK failure, reconnect, accepted audio, and wrap-up. The test
  blocks external network access and substitutes the carrier connection.

Deployment preserves the existing production parameters: human dialing remains
enabled under the recorded authorization in `OUTBOUND_LAUNCH_AUTHORIZATION.md`
§11; paid screening remains disabled. No prospect data or calling permissions
were changed as part of testing. No live phone call was placed during this
repair, so two-way audio on the user's microphone and network still requires
a live retry after reloading the portal.

Deployment completed successfully at approximately 19:17 UTC. All nine updated
functions report `ACTIVE`. The live admin HTML and JavaScript match the tested
build, including a byte-for-byte check of the admin bundle. A signed request to
the production browser TwiML endpoint for an already completed call returned
the new `<Hangup/>` response without writing call data or placing a phone call.
The operator's previous session was confirmed ended with auto dialing stopped.

## Call notes and readable history

History now shows the stored business/contact names, phone number, outcome,
duration, and a notes preview. The detail panel shows full multiline notes and
their save time alongside the existing call details.

Quick Dial and the advanced live workspace share a call-scoped notes editor.
Notes save independently of disposition, after a short typing pause and on
blur/navigation, with a local draft backup and an explicit retry for failed
saves. Saves for the same call are serialized. The authenticated
`saveHybridCallNotes` callable checks account access and call ownership, accepts
up to 2,000 characters, and also allows the operator to finish notes after the
call or session ends. Notes do not replace the provider's summary or outcome.

Validation: five draft lifecycle tests and the Firestore emulator notes test
passed, including access rejection, multiline storage, and saving after hangup.
The browser check covers typing during a connected call, autosaving, hangup,
and finding the business, phone, and full notes in History. The production build
also passed.

References: [Twilio error 21626](https://www.twilio.com/docs/api/errors/21626),
[SDK call acceptance](https://www.twilio.com/docs/voice/sdks/javascript/twiliocall),
[conference callback ownership](https://www.twilio.com/docs/voice/twiml/conference).
