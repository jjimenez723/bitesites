# Human pickup latency — October 29, 2026

The owner reports delay after someone answers, before both sides hear one
another. The 5:53 PM access fix now succeeds in production: Israel and another
operator have browser conference participants, and rep heartbeats return 200.

The latest code waits for asynchronous human classification before opening
browser audio, fetches another token per join, and fetches prospect TwiML after
pickup. At 22:17 UTC the prospect handler took 2.84 seconds and the browser
handler took 3.26 seconds; browser TwiML was not requested until six seconds
after the prospect TwiML request. These are avoidable post-answer waits.

Earlier implementations remain in the older shared workspace but were dropped
from later main releases. Reconcile only these latency repairs with the current
training, campaign assignment, wrap-up and destroyed-device safeguards. Preserve
one-line human calling and all AI/recording authorization boundaries.

## Reconciled implementation

- Quick Dial prepares the authorized one-line human conference during dialing
  and ringing. It still waits for server assignment plus accepted browser audio
  before showing a connected conversation. Reconnect is available during ringing.
- The signed pickup webhook assigns one-line human sessions immediately. AMD
  later refines classification without taking away audio or resetting pickup
  timestamps. Hybrid, AI and parallel sessions still require verified human
  detection. Unknown answers are not falsely labeled human.
- New calls include inline prospect conference instructions, removing the
  pickup-time HTTP/database fetch. The signed legacy endpoint stays compatible.
- Voice credentials are reused until shortly before expiry, refreshed on SDK
  expiry events, and cleared when leaving the dialer. Microphone permission and
  device preparation run concurrently. Destroyed-device recovery is retained.
- Initialization preserves callbacks that arrived first, and participant events
  merge only their own fields so simultaneous joins cannot erase each other.
- Voicemail is available as a human-call outcome. Required wrap-up and the
  Interested follow-up pause remain enforced.

## Validation

- 51 dialer, token-cache and audio-preparation unit tests pass.
- The signed-webhook emulator suite covers audio before pickup, immediate
  routing, late classification, simultaneous participant callbacks, fast-answer
  initialization, required disposition hold, and AI/parallel detection boundaries.
- The browser test uses actual Firestore rules/subscriptions and the actual
  voice client with only the carrier SDK substituted. It proves early audio,
  no premature connected label, connection/token reuse, expiry refresh, mobile
  destroyed-device recovery, rep heartbeat and revocation error handling.
- Existing dialer and exemption browser suites pass; production build, function
  syntax checks and tracked-file secret scanning pass.
- The outbound engine passes 147 assertions, and the Interested workflow suite
  passes. Those older fixtures were updated to provide the current required
  stored roles, campaign assignments and training exemptions. Their initial
  failures were missing authorization fixtures, not carrier failures.
- Actual carrier audio quality and the new pickup-to-audio latency are not
  measured by these local tests. No real call is initiated by this work.

Provider behavior verified against the official
[Twilio Call API](https://www.twilio.com/docs/voice/api/call-resource) and
[asynchronous AMD documentation](https://www.twilio.com/docs/voice/answering-machine-detection).

## Production release

Published October 29 at 6:54 PM Eastern. Both live origins serve the exact tested
`index-FtXYefui.js` and `AdminApp-DZJhfVfw.js`. Existing Firestore rules remain
byte-identical to the earlier rep-read repair.

Nine targeted Functions report ACTIVE. Downloaded source archives match all
eight checked calling/access modules, including the unchanged training and
campaign gates. Existing runtime configuration values are preserved. The five
updated human call/refill handlers remain enabled; the four session-setting and
conference/TwiML handlers keep their previous disabled external-dialing flag.
The voice-token endpoint remains enabled, while AI scheduling/dispatch and
paid screening remain disabled. Unsigned carrier requests return HTTP 401.

The legacy prospect endpoint's rollout spent several minutes assigning traffic
after its new revision was ready. Hosting was published separately during that
wait; the combined deployment then also completed with the same tested assets.
Restricted release metadata, before/after configuration, source archives, test
logs and read-only timing evidence are in `/tmp/bitesites-rep-latency-20261029`.

Reps must stop any open session, refresh the page, and start again to load the
new browser preparation. No prospect was called by deployment or verification.
