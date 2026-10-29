# Outbound owner checklist

Last updated: 2026-10-29

Current October 29 checkpoint: David's BiteSites training exemption and original
campaign assignment are active, and Israel has the same approved access. The
simulator is hidden for exempt reps. A later rep audio failure was traced to
excessive Firestore rule evaluation and the wrong heartbeat endpoint; the
5:53 PM Eastern release repairs both, with subsequent production evidence of
browser participants. The 6:54 PM release removes avoidable post-pickup waits
through early audio preparation and direct human routing. New latency needs
live confirmation; see [REP_PICKUP_LATENCY_20261029.md](REP_PICKUP_LATENCY_20261029.md).

Six stages, in order. Each one is a different question with a different
decider, and none of them implies the next. The long-form reasoning lives in
[OUTBOUND_PRODUCTION_READINESS.md](./OUTBOUND_PRODUCTION_READINESS.md) and the
decisions themselves in
[OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md); this is
the one-page version, kept short enough to actually be read before a deploy.

The stage a document *claims* is worth less than the evidence beside it. Where
a row says "not done", it is not a gap somebody forgot — it is the honest state.

If the terms here are opaque — "consent grant", "pre-dial screening" — read
[OUTBOUND_HANDOFF.md](./OUTBOUND_HANDOFF.md) first. It explains what each of
them actually is and why there are none.

---

## 1. Engineering complete — ✅ **met** (2026-08-25)

Everything that can be built and proven without spending money, calling a
stranger, or relying on outside approval.

| Evidence | State |
|---|---|
| Clean-install CI-equivalent suite passes | ✅ `npm ci` ×3, `npm run secrets:check -- --all`, `npm run test:all`, both `check` scripts |
| CI workflow reaches every step | ✅ Firebase CLI pinned from the lockfile, JDK installed for the emulators |
| No unresolved high/critical dependency advisory | ✅ zero advisories at any severity in all three packages |
| Secret scanning covers this repo's credential families | ✅ `npm run test:secrets` |
| Read-only GoHighLevel contact source | ✅ one permitted endpoint, own credential, bounded, tested |
| Screening evidence can be produced from the console | ✅ 2026-08-25 — the callable existed with no client, so the evidence the dial gate demands had no way to come into existence outside a test |
| A simulated screening provider cannot write production evidence | ✅ 2026-08-25 — it could until then, and nothing downstream could tell the difference |
| No-dial eligibility audit reusing the runtime gates | ✅ proven stricter than the dial path, proven side-effect free |
| Mandatory sales-rep role-play and default campaign access | ✅ training deployed 2026-10-28; account-scoped exemptions deployed October 29; David is exempt and explicitly assigned without a global default |
| Live-model evaluation adapter, guarded and fake-adapter tested | ✅ built; **not run** |
| Readiness documents agree with the code | ✅ this pass |

**Decider:** engineering owner. **Done.** This is not authorisation to launch.

---

## 2. Staging verified — ✅ **met** (2026-08-24), with one gap

| Evidence | State |
|---|---|
| Separate Firebase project, no production bindings | ✅ `bitesites-outbound-staging` |
| Rules, indexes, Functions, Hosting deployed | ✅ |
| `npm run smoke:staging -- --with-admin` passes | ✅ 15 checks, including a disposable admin |
| The **deployed** runtime refuses carrier dialing | ✅ read from the live function's own configuration |
| Rollback rehearsed | ❌ **never attempted** |

**Decider:** engineering owner, after the billing/deploy authorisations that
were granted on 2026-08-24. Approving staging authorises **nothing** about
production.

---

## 3. Production deployed — ✅ **base release 2026-09-08; follow-up 2026-10-27**

> **Deploy notes — 2026-09-08, authorization §11 (human-only rep dialing).**
> `npm run preflight:production` refused first, exactly as designed, until
> `OUTBOUND_CANARY_AUTHORIZATION=authorized` was supplied; it then reported
> `BITESITES_DEPLOYMENT_ENVIRONMENT=production`,
> `OUTBOUND_EXTERNAL_DIALING=enabled`, `PAID_PHONE_SCREENING=disabled` and no
> unauthorised capability. Deployed in order: `firestore:rules,firestore:indexes`
> (rules already current, indexes unchanged — the human-led pickup query is
> served by the existing `campaignId, state, nextAttemptAt, priority` index),
> then Functions, then Hosting. `dialHybridTargets` and
> `startHybridDialerSession` were confirmed updated by their deployed
> `updateTime`, and the released Hosting bundle was confirmed to contain the new
> dialer. The quota warnings in the Functions log are the usual per-minute
> mutation retries on a ~117-function codebase; the deploy exited 0.
>
> **What this deploy did not do:** it placed no call, unpaused no campaign,
> seeded no data, and issued no consent grant. §11 is human-only; an artificial
> voice remains closed on per-number consent and screening regardless of the
> flag.

**Follow-up release — 2026-10-27:** PR #5 adds manager-controlled rep campaign
assignment, rep display names, the interested-call email pause, and mobile
reconnect recovery. It was merged as `28849bf` and deployed to `bitesites-org`
after `Outbound AI CI / validate` passed. Firestore rules/indexes, Functions,
Hosting, and the Realtime sideband were updated. Production preflights used
`OUTBOUND_EXTERNAL_DIALING=disabled` and `PAID_PHONE_SCREENING=disabled`. The
sideband health endpoint returned `ok: true`; new callable endpoints returned
`UNAUTHENTICATED` when invoked without a signed-in user.

This release changed no production profiles, roles, campaign assignments, or
dialer records. Alex's display name can be entered by a manager from Campaign
Builder. The temporary Bergen test account remains `Jensy Jimenez` and remains
an `outbound_rep`. No campaign was unpaused and no call was placed. **The
deployment's external-dialing and paid-screening flags were disabled**, so the
new manager workflow was live but reps could not place calls until human dialing
was separately enabled.

**Human-only dialing activation — 2026-10-28:** the owner authorized opening
human rep dialing under §11. These six ACTIVE Functions now have
`OUTBOUND_EXTERNAL_DIALING=enabled`:
`getHybridVoiceAccessToken`, `dialHybridTargets`, `endHybridCall`,
`submitHybridDisposition`, `resumeHybridAutoDial`, and
`recordHybridCallEvent`. The AI scheduler `runAICampaigns`, AI dispatcher
`dispatchHybridAIToSip`, and `PAID_PHONE_SCREENING` remain disabled. The local
production parameter file remains `OUTBOUND_EXTERNAL_DIALING=disabled` so a
broad future deploy does not open extra paths; explicitly set the §11 value and
authorization only when redeploying the approved human functions.

At activation, there were no active dialer sessions and no reps assigned to the
authorized running Twilio campaign. Other Twilio campaigns were paused. The
manager assignment workflow is live; a manager must assign a salesperson in
Campaign Builder before they can dial. No call was placed and no production
campaign, rep, or role record was changed.

**Production release — 2026-10-28:** mandatory AI role-play training now
gates campaign reads, call history, calendar entries, warm transfers, browser
softphone joins, and human dialing at the server and Firestore-rule layers.
Reps can pass three seller-specific practice scenarios before a default is
chosen; passing records training completion but grants no lead access until a
manager selects a default campaign, which then auto-assigns trained reps. The
practice uses fictional adults and no real leads or carrier calls. The server
scores a transcript submitted by the browser; it does not independently verify
the speaker or transcript. The deployment passed the production dry run and
release checks. Production currently has no default campaign or training
attempt/progress records; reps can practice, but a manager must choose a
campaign before they can access its leads or dial.

**Rep training exemptions — on `main` 2026-10-29, not deployed:** an admin can grant or revoke a training exemption for a specific rep and seller account. The exemption remains distinct from a completed course, does not grant campaign assignment, and does not change other call gates. No production role or campaign record has been changed by this work. Production has no default campaign, so exempt reps will still need a manager to choose one before they can access campaign leads or dial.

**Rep sign-in correction — 2026-10-28:** production logs identified the
training-status 500 as a missing `node:crypto` `createHash` import. The
separate Firestore permission error came from the always-mounted warm-transfer
listener querying calls by account, while rep reads are limited to assigned
campaigns. The import is fixed, and rep transfer reads now query only campaigns
already returned by the rep-authorized campaign list. The supporting composite
index is READY. Only `getRepTrainingStatus` and Hosting were redeployed; the
live function is ACTIVE, the released app bundle is current, and no post-release
function errors were present at verification. No Firestore rules or sales
roles, training, campaign, or dialer records changed, and the human-dialing
functions were not redeployed.

**Rep training role-play 500 — found 2026-10-29, fix not yet deployed:** the 2026-10-28 correction redeployed only `getRepTrainingStatus`, but the same progress-ID helper is bundled into `createRepTrainingSession` and `completeRepTrainingAttempt`, which kept the pre-fix build from `f6bd355`. Every **Start role-play** therefore fails with `INTERNAL` (`ReferenceError: createHash is not defined`), and finishing an attempt would fail the same way, so no rep can complete training in production. The code fix is already on `main`; the two functions need a targeted redeploy, which awaits the owner’s authorization under `CLAUDE.md`. Steps are in `HYBRID_DIALER_DEPLOYMENT.md` §11.

The following notes preserve dated production findings so their historical
context stays clear alongside the current deployment state.

### Historical production state and current gate

The following was read from production on 2026-08-25 and describes that
historical state, not the current 2026-10-27 release:

- The **deployed** runtime then had `OUTBOUND_EXTERNAL_DIALING=enabled`
  (functions last deployed 2026-08-25 20:25 UTC). The gate has been open in
  production the whole time this document described it as shut. Nothing dialed,
  because campaigns were paused and the AI path has no consent — but the
  outermost gate was not the thing holding the line.
- §11 authorized **human-only** dialing. The external gate is enabled only on
  the six approved Quick Dial Functions listed above. The AI scheduler and
  dispatcher are deployed but their external-dialing admission remains closed;
  paid screening is disabled.

A third thing, found 2026-09-08 by trying to use the console the way a rep
would: with §11 granted and the flag on, the rep dialer **still could not place
a call**. Every one of the campaign's targets sat in `pending` behind the AI
call-plan approval gate, which the dial path applied to human sessions too, so
the dialer reported "prepare and approve at least one call plan" and offered a
four-step guided workflow instead of a call. The human-led pickup gate was
fixed and deployed by 2026-09-08; campaign access and interested-call wrap-up
were added in the 2026-10-27 release. Human dialing is now enabled for the
approved campaign, subject to its rep-assignment check.

**Controls applied during the 2026-10-27 production release:**

- ✅ `npm run preflight:production` passed with
  `OUTBOUND_EXTERNAL_DIALING=disabled` and `PAID_PHONE_SCREENING=disabled`.
- ✅ Rules and indexes deployed before Functions; the two new indexes reached
  READY.
- ✅ Functions and Realtime sideband deployed; sideband health returned
  `ok: true`.
- ✅ No production role, profile, campaign assignment, or dialer record was
  modified; no campaign was unpaused and no call was placed.

**Decider:** business owner. Deploying disabled code is still a production
change.

---

## 4. Internal carrier rehearsal — ❌ **not authorised**

Ten calls to ten named internal participants who have each given written,
seller-specific AI/artificial-voice consent. The first carrier cohort.

**Ten is the evidence bar for promoting to §5, not a threshold the code
enforces.** One consenting person with one grant and one screening record is
enough to make the system dial, and the owner calling their own phone is a
legitimate first call — it makes all four gates real once, at the smallest
possible blast radius. Do not read the ten as a reason to wait; read it as what
you need before asking to call a stranger.

Run it from [OUTBOUND_FIRST_CALL_RUNBOOK.md](./OUTBOUND_FIRST_CALL_RUNBOOK.md),
which walks one number end to end, names every gate, and has the deploy
sequence and exact console fields.

- [ ] Ten named participants and their numbers
- [ ] Written, seller-specific consent for each, retained, with an artifact id
      that a `consentGrants` entry can point at. The wording to sign is drafted
      at [AI_VOICE_CONSENT_v1.md](./AI_VOICE_CONSENT_v1.md) and is **not yet
      counsel-approved**
- [ ] A consent grant issued through the ledger for each number
- [ ] Fresh pre-dial screening for each number — which needs stage 3's paid
      screening authorisation **and** a DNC snapshot handed in by hand. Both,
      not either: the DNC snapshot has never been something code could supply,
      and since 2026-08-25 a non-verifying provider cannot write production
      evidence, so the paid lookup is the only route to the other three answers.
      National DNC access is free for up to five area codes, so the cost here is
      an enrollment and a few cents of Twilio Lookup
- [ ] 100% transcript and carrier/tool event review afterwards
- [ ] Provider retry, duplicate, timeout, webhook-signature and teardown
      evidence

**Decider:** business owner. **Blocked on:** the named participants and their
consent, which cannot come from this repository.

---

## 5. External canary — ❌ **not authorised**

At most 25 eligible calls per day. Everything in §4 plus everything counsel and
the carriers require.

- [ ] Counsel-approved AI/artificial-voice consent wording, disclosure, calling
      windows, cadence, voicemail, recording, retention and revocation policy
      for the intended jurisdictions
- [ ] National and applicable state DNC subscription, with a dated snapshot
      attached to each callable record
- [ ] Verified caller identity, KYC, STIR/SHAKEN attestation and A2P/carrier
      registration for the numbers that will dial. Note this is the *carrier*
      work, not the numbers: `+12015524949` is provisioned in the shared Twilio
      account and registered to Stone Bellisimo and Fine Line in `accounts.js`.
      BiteSites declares no allow-list, so any E.164 caller ID passes its
      account check — declaring one is worth doing before the canary
- [ ] Seller calendars: Stone Bellisimo and Fine Line have **none** and would
      book against generic defaults —
      [SELLER_CALENDAR_CHECKLIST.md](./SELLER_CALENDAR_CHECKLIST.md)
- [ ] A staffed human-handoff recipient list and hours; Fine Line's emergency
      escalation contact
- [ ] Daily/monthly/per-connected-call budgets and cost alerts
- [ ] A conversational evaluation run against a **live model**, meeting the
      thresholds — which needs its own spend authorisation (§10)
- [ ] Explicit, separate authorisation for 25/day. It cannot be inferred from a
      staging approval or a production deploy.

**Decider:** business owner, explicitly, per cohort.

---

## 6. Wider rollout — ❌ **not authorised**

100/day, then 500/day. Each step is its own decision.

- [ ] 48 hours with zero critical events before each promotion
- [ ] 100% of the first 100 completed calls reviewed, then ≥25% through 1,000,
      with every DNC, complaint, error, commitment and long call sampled
- [ ] Reviewed quality and unit economics, not conversion rate alone

**Decider:** business owner, once per step.

---

## Repository housekeeping the owner has to do

Neither of these can be done from inside a commit:

- [ ] **Branch protection on `main`**, with **Outbound AI CI / validate**
      required and "Require branches to be up to date before merging" on.
      Without it a red run on an outbound safety test can be merged by anyone.
- [ ] **`GHL_CONTACTS_READ_TOKEN`** — a GoHighLevel Private Integration scoped
      to `contacts.readonly` and no write scopes. Until it exists, the
      eligibility audit runs over Firestore only and refuses the CRM scope.
