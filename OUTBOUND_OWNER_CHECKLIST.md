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
| Screening evidence can be produced from the console | ✅ 2026-08-25 — the callable existed with no client, so the evidence the dial gate demands had no way to come into existence outside a test |
| A simulated screening provider cannot write production evidence | ✅ 2026-08-25 — it could until then, and nothing downstream could tell the difference |
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

## 3. Production deployed but disabled — ❌ **not done**, and no longer the shape of what is happening

Production still runs the code that predates this workstream. Two things read
from the live project on 2026-08-25 that this stage did not anticipate:

- The **deployed** runtime already has `OUTBOUND_EXTERNAL_DIALING=enabled`
  (functions last deployed 2026-08-25 20:25 UTC). The gate has been open in
  production the whole time this document described it as shut. Nothing dialed,
  because campaigns were paused and the AI path has no consent — but the
  outermost gate was not the thing holding the line.
- Under §11 the owner has authorized **human-only** dialing, so a campaign is
  intended to run rather than stay paused. "Deployed but disabled" is no longer
  the target state for the rep dialer; it is still the target state for anything
  with an artificial voice.

Before a production Functions deploy:

- [ ] **Run `npm run preflight:production`.** `functions/.env.bitesites-org` is
      untracked, so whatever it contains is deployed without appearing in any
      diff, review, or CI run. On 2026-08-25 it held
      `OUTBOUND_EXTERNAL_DIALING=enabled`.
- [ ] **`OUTBOUND_EXTERNAL_DIALING` is now `enabled`** — set 2026-08-25 under
      the new §11 of `OUTBOUND_LAUNCH_AUTHORIZATION.md` (human-only rep
      dialing). It is deliberate, not drift. Two consequences for this deploy:
      `npm run preflight:production` **fails** unless
      `OUTBOUND_CANARY_AUTHORIZATION=authorized` is exported in the same shell,
      and the deploy notes must name §11 rather than §5 or §9. Setting the flag
      does **not** admit an AI voice — that path fails closed on per-number
      consent and screening no matter what this value says.
- [ ] Confirm `PAID_PHONE_SCREENING=disabled` unless §3 has been granted. Note
      that §3 is now required *before* the rehearsal rather than after it: the
      only screening provider admitted in production is the paid one, so no §3
      means no screening evidence and therefore no calls.
- [ ] Build the `campaignIncidents` and `dialerSessions` composite indexes in
      production; the circuit breaker cannot list or safety-stop under load
      without them. Both are declared in `firestore.indexes.json`, so
      `npm run deploy:rules` builds them — what needs watching is that they
      report Enabled before Functions go out.
- [ ] Deploy rules and indexes first, wait for index readiness, then Functions.
- [ ] Confirm every campaign is still paused afterwards.

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
