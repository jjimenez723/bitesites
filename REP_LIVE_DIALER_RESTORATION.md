# David's live dialer access — October 29, 2026

Follow-up at 5:53 PM Eastern: session creation alone did not establish audio.
Rep call-document reads exceeded the Firestore expression limit, and the browser
used an admin-only heartbeat. Both are repaired in the subsequent release;
see [REP_CONNECTION_REPAIR_20261029.md](REP_CONNECTION_REPAIR_20261029.md).

The October 28 release requires reps to pass AI role-play training and have a
campaign assignment. David has an approved BiteSites rep account, but neither
training access nor a campaign assignment. The owner requested removing his
simulator requirement and restoring live human dialing.

The October 29 exemption backend is already deployed and its downloaded source
matches main `579a662`. Hosting still serves the October 28 page, and deployed
Firestore rules do not recognize exemptions. The six human-call functions retain
external dialing enabled; the AI scheduler and dispatcher remain disabled.

Use the existing account-scoped exemption for David and assign only the original
`local-business-website-growth-aug-2026` campaign. Keep course completion records
separate and leave the other rep and seller accounts unchanged. An exempt rep
must be able to use explicitly assigned campaigns without a global default.

## Restored production access

Published Hosting version `dedd7bc8db4e450e` on October 29 at 4:41 PM Eastern.
Firestore rules were released at 4:41 PM. David's exemption and explicit campaign
assignment were committed atomically at 4:42 PM (`2026-10-29T20:42:09.783847Z`).
Both changes have audit events; a pre-change snapshot is retained in the local
restricted audit directory `/tmp/bitesites-rep-live-audit-20261029`.

- David's `roles` document now has `trainingExemptAccountIds: ['bitesites']`.
  His approval, role, seller scope, and course-pass records are unchanged.
- The original running campaign now includes David in `allowedRepUids`.
  It had 94 ready prospects at verification. No default campaign was set.
- The other rep's role document is unchanged, verified by semantic comparison
  and its original update timestamp.
- Exempt reps open the live human dialer. The training tab and simulator are
  hidden, including for old `?tab=training` bookmarks. Loading and failed access
  checks do not display practice or enable dialing. Explicit campaign assignment
  works without a global onboarding default. Unexempted sellers retain training.
- Rep navigation has no Advanced AI setup link. The manager flow remains available.
- No call, email, training attempt, fake course pass, or recording was created.
  No campaign was unpaused. Existing human dialing remains enabled.

## Verification

- Production build with `npm ci` dependencies from the current main lockfile,
  including Twilio Voice SDK 2.18.4. Existing chunk-size/mixed-import warnings.
- Nine training-access tests and 42 hybrid dialer tests passed.
- `node scripts/test-rep-live-dialer-browser.mjs` passed: exemption without a
  default, single-click human session settings, stale bookmarks, mobile,
  unassigned rep, loading/error/retry, nonexempt and mixed-seller restrictions.
- Existing `node scripts/test-dialer-browser.mjs` passed for audio reconnect,
  notes, history, outcomes, and callbacks.
- `FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node functions/rep-live-access.test.mjs`
  passed using the actual rules and public session callable: exact campaign-list
  query, explicit assignment without a default, human session, denied unrelated
  rep and seller, denied self-grants and malformed assignments, revoked exemption
  blocking refill. All external requests are blocked; no provider call occurs.
- The full rules suite has 167 passes and four failures on both unchanged
  `579a662` and this change, confirmed from fresh emulator databases. Those
  existing tests use rep fixtures without the newer training requirements:
  stored-scope/stale-claim read, schedule read, campaign incident read, and
  eligibility-audit read. This release adds no new full-suite failure.
- Deployed rules exactly match the tested file. Both `bitesites.org` and the
  Firebase origin serve byte-identical tested entry/admin bundles. Firebase
  serves exact build HTML; the custom domain strips two font preconnect tags.
- 46 unchanged files match the prior Hosting hashes, including all marketing
  media and CSS. Only the entry/admin-related JS chunks and index references
  change. Existing Hosting rewrites and headers are preserved.
- The six human-call functions retain their preexisting revisions and enabled
  external-dialing settings. No Functions deployment was performed here.

Production carrier audio and David's own browser microphone were not exercised;
he starts the first real call by pressing **Start dialing** at
https://bitesites.org/admin/outbound?tab=dialer.

## Source and release discipline

The original workspace contains extensive older uncommitted work and was based
on September 23. The latest main was fetched and this change was made separately
in `/Users/cesaryunda/Bitesites3.0/bitesites-rep-live-dialer` on
`codex/restore-rep-live-dialer`, based on `579a662`. Do not deploy the old workspace
wholesale: it lacks the October 27–29 campaign and training authorization changes.
Preserve this rules query correction and exempt-rep navigation in future releases.

The emulator also exposed a pre-existing campaign-list failure: an explicit
`allowedRepUids is list` check cannot be proven by the client's `array-contains`
query. Removing that redundant type check lets the query work; `hasAny` still
requires a list and rejects malformed values. The test exercises the actual
campaign query, denied unscoped queries, and malformed assignment fields.


## Israel Garcia added — October 29, 2026, 4:51 PM Eastern

The owner identified `garc2003` and requested skipping his onboarding too.
Firebase Auth had exactly one matching account: Israel Garcia,
`israelgarc2003@gmail.com`, with a pending profile and no staff role.

Approved that existing profile as a BiteSites `outbound_rep`, synchronized the
Auth claims, granted `trainingExemptAccountIds: ['bitesites']`, and added him to
`local-business-website-growth-aug-2026`. Firestore changes were committed
atomically at `2026-10-29T20:51:02.829791Z`, with exemption and assignment audit
events. Readback verified the profile, stored role, Auth claims, exemption, and
campaign assignment. David's role and all existing campaign assignments are
preserved. No training pass, call, email, or new deployment was created.

Israel should sign out and back in, then open
https://bitesites.org/admin/outbound?tab=dialer. His existing session tokens were
revoked as part of the normal role-promotion flow so refreshed claims take effect.
The scoped before/after snapshots and administrative action record are retained
in `/tmp/bitesites-garc2003-access-20261029`.
