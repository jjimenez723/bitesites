# Outbound owner checklist

Last updated: 2026-08-25

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
| No-dial eligibility audit reusing the runtime gates | ✅ proven stricter than the dial path, proven side-effect free |
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

## 3. Production deployed but disabled — ❌ **not done**

Production still runs the code that predates this workstream, with every
campaign paused.

Before a production Functions deploy:

- [ ] **Run `npm run preflight:production`.** `functions/.env.bitesites-org` is
      untracked, so whatever it contains is deployed without appearing in any
      diff, review, or CI run. On 2026-08-25 it held
      `OUTBOUND_EXTERNAL_DIALING=enabled`.
- [ ] Set `OUTBOUND_EXTERNAL_DIALING=disabled` there unless stage 5 has been
      granted. A deploy is not the moment to decide whether strangers may be
      called.
- [ ] Confirm `PAID_PHONE_SCREENING=disabled` unless §3 has been granted.
- [ ] Build the `campaignIncidents` and `dialerSessions` composite indexes in
      production; the circuit breaker cannot list or safety-stop under load
      without them.
- [ ] Deploy rules and indexes first, wait for index readiness, then Functions.
- [ ] Confirm every campaign is still paused afterwards.

**Decider:** business owner. Deploying disabled code is still a production
change.

---

## 4. Internal carrier rehearsal — ❌ **not authorised**

Ten calls to ten named internal participants who have each given written,
seller-specific AI/artificial-voice consent. The first carrier cohort.

- [ ] Ten named participants and their numbers
- [ ] Written, seller-specific consent for each, retained, with an artifact id
      that a `consentGrants` entry can point at
- [ ] A consent grant issued through the ledger for each number
- [ ] Fresh pre-dial screening for each number — which needs stage 3's paid
      screening authorisation, or a DNC snapshot handed in by hand
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
