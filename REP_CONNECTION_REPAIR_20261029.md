# Rep connection repair — October 29, 2026

Owner request: repair David and Israel's live human calls after they reported
30 minutes without reaching anyone. The earlier access restoration allowed
session creation, but did not verify actual browser audio.

Production evidence at 21:37 UTC: multiple David calls reached answered/human
status and a prospect conference participant, but no browser participant. No
rep browser TwiML requests occurred. Rep heartbeat requests returned 403 while
an administrator's heartbeat and browser join succeeded. The UI uses the legacy
admin heartbeat endpoint and suppresses its errors.

## Cause and repair

The actual rules rejected an exempt, assigned rep's `calls/{id}` read with
"maximum of 1000 expressions". The call rule repeated the full seller/training
check that its campaign check already performed. Removing the duplicate check
restores call, transcript and scoped history reads while retaining training,
seller and campaign authorization. The prior access test covered campaign
listing and session creation, so it missed this later failure.

The shared heartbeat hook now calls the existing ownership-checked
`heartbeatHybridDialerSession`, which accepts reps. Quick Dial displays live
subscription/check-in failures, keeps Stop accessible when session reads fail,
and prevents starting another session while an existing session ID is retained.

Published Hosting version `46c11a18ce89bd67` and Firestore rules on October 29
at 5:53 PM Eastern (`2026-10-29T21:53:26.841Z` Hosting release).
No Functions were redeployed. The earlier simulator exemptions and original
campaign assignments for David and Israel remain in place.

## Verification

- Regression reproduced against the prior rules, then passed with the repair.
- Expanded `functions/rep-live-access.test.mjs`: real session creation, rep
  heartbeat, live call/transcript/history reads, signed browser conference join;
  invalid signatures, other rep, wrong seller, unassigned campaign, self-grants
  and revoked access denied. No external requests allowed.
- `scripts/test-rep-call-connection.mjs`: Chromium uses actual Firestore rules
  and the actual data hooks. An answered call reaches the rep and triggers the
  audio join; the correct heartbeat is invoked; revoked access displays an
  error and retains Stop. Only callables and carrier audio are simulated.
- Existing dialer and exempt-rep browser suites passed, including reconnect,
  notes, wrap-up, history, callbacks, mobile and training boundaries.
- Production build and `git diff --check` passed. Full rules suite remains
  167 passed / four preexisting training-fixture failures, identical to the
  previous release; see `REP_LIVE_DIALER_RESTORATION.md` for the exact failures.
- At 5:54 PM Eastern, the custom domain and Firebase origin served exact tested
  bundles `index-BSLfmzEQ.js` and `AdminApp-BJ-_tAXP.js`; deployed rules exactly
  matched the tested file. All six human-calling Functions remained enabled;
  AI scheduling/dispatch and paid screening remained disabled.
- At 5:55 PM Eastern, no calls had started since publication, so no production
  conversation or rep check-in was available to confirm yet.

Real microphone/carrier conversation after this release still requires the reps
to refresh their pages and make their normal calls. Local tests prove the
previously blocked read/join path, not live microphone quality or answer rate.

No carrier call initiated by this repair. Production data and source snapshots
are retained privately under `/tmp/bitesites-rep-connections-20261029`.
