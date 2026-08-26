# Make the first call — every step, every link

Rewritten 2026-08-25. This replaces the vaguer version. One phone call, to one
number, from a standing start. Nothing is left as "arrange consent" or "procure
DNC" — if a step needs a URL, the URL is here.

---

## Three answers first

**You need one consenting person, not ten.** The "ten internal participants" in
[OUTBOUND_OWNER_CHECKLIST.md](./OUTBOUND_OWNER_CHECKLIST.md) is a rehearsal
cohort size, chosen so you learn enough to justify calling strangers afterwards.
It is not law and no code enforces it. The system will dial when **one** number
has a grant, a screening record, and the gates below. Make it your own phone.

**What you are signing.** You sign as *the person being called* — giving
BiteSites written permission to phone your number with an AI voice. You are on
both sides of the paper, which is fine: it is a real signature from a real
person who genuinely agrees, which is exactly what the ledger is asking for.
The wording is [AI_VOICE_CONSENT_v1.md](./AI_VOICE_CONSENT_v1.md), Version A.
Print it, fill in your own mobile number, sign it, scan it. Five minutes.

**Why it still takes more than five minutes.** Consent is one of fourteen things
the dial path checks. The rest are below, in order, with nothing skipped.

---

## Everything that must be true before one number can ring

This is the authoritative list — `AUDIT_BUCKETS` in
`functions/outbound-eligibility-audit.js`, which is what the Eligibility Audit
screen reports against. Steps that clear each one are in brackets.

| Gate | What it wants | Cleared by |
|---|---|---|
| Contact record | A `prospects/` or `leads/` doc, right seller, right phone | Step 4 |
| Valid phone | E.164, parseable | Step 4 |
| Not suppressed | Not on your own DNC ledger | automatic |
| Account match | Contact, campaign and target all the same seller | Steps 4–5 |
| **AI consent** | Written, seller-specific, unrevoked, unexpired grant | Steps 1, 7 |
| **National DNC** | Dated snapshot ID, checked ≤31 days ago | Steps 2, 8 |
| Entity DNC | Your own list — free, already works | automatic |
| **Reassigned number** | Twilio Lookup says "no", dated to the consent date | Steps 3, 8 |
| **Line type + validation** | A real, callable line | Steps 3, 8 |
| Screening record | Fresh, bound to this seller and number | Step 8 |
| Timezone + hours | Local calling window | automatic for a geographic area code — see note |
| **Research / call plan** | A brief that exists *and* is approved | Step 9 |
| Attempts / retry | Not already attempted | automatic |
| Campaign, provider, caller ID, deployment | Unpaused, Twilio, registered caller ID, dialing enabled | Steps 5, 6, 11, 12 |

The five in **bold** are the ones that need something from outside this
repository. Everything else you can do in the console today.

**On timezone:** it is derived from the area code, so `+1201…` resolves to
`America/New_York` with nothing to configure. A toll-free number (800, 888, …)
resolves to nothing and fails with `unknown_timezone`. Use a geographic mobile
number and this gate is free. You also have to actually be inside the calling
window when you dial — this is not a step, but it will block you at 7am.

---

## Step 1 — Sign the consent form (5 minutes)

1. Open [AI_VOICE_CONSENT_v1.md](./AI_VOICE_CONSENT_v1.md), copy **Version A —
   BiteSites** into a document.
2. Fill in the opt-out email and the contact address. Do **not** use your home
   address — there is a recorded owner decision that the BiteSites private
   address is never published, and a consent form is a published document. An
   email-only contact is fine.
3. Print, write your own mobile number in the number field, sign, date.
4. Scan it and name the file exactly:
   `aivc-v1-bitesites-20260826-01.pdf` (use the real signature date).
5. Put it somewhere retained and backed up. That filename is the
   `evidenceArtifactId` you will type in step 7.

## Step 2 — Enroll for National DNC (free, but start it now)

**→ [telemarketing.donotcall.gov](https://telemarketing.donotcall.gov)**

The first five area codes cost nothing. You need one. Beyond five it is $82 per
area code for FY2026, capped at $22,626 — not your problem at this scale.

1. Register your organization. You get a **Subscription Account Number (SAN)**.
2. Download the list for your own number's area code.
3. Check your number against it. If your own number is on the registry, stop —
   pick a different number, or remove yourself from the registry first and wait.
4. Write down the snapshot as `san-<YOUR-SAN>-20260826`. That exact string goes
   into the DNC snapshot ID field in step 8.

Start this first — organization registration is the one step with a queue in
front of it that is not under your control.

Reference: [FTC fee schedule for FY2026](https://www.ftc.gov/news-events/news/press-releases/2025/08/telemarketer-fees-access-ftcs-national-do-not-call-registry-increase-2026)
· [FTC Q&A on DNC provisions](https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0)

## Step 3 — Authorize paid screening (§3), and record it

This is a decision, not a task. You are authorizing Twilio Lookup's line-type
and reassigned-number packages. **At one number it costs well under a dollar.**

There is no way around it: since 2026-08-25 a provider that does not query an
outside authority cannot write screening evidence in production, and Twilio
Lookup is the only one that does. No §3, no screening, no call.

Write the decision into
[OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md) §3 —
date it and say what you approved. The document is the record; the flag in step
6 is just the mechanism.

Confirm the credentials exist: **[Twilio Console](https://console.twilio.com)** →
Account → API keys & tokens. The functions read `TWILIO_ACCOUNT_SID` and
`TWILIO_AUTH_TOKEN` from Secret Manager.

## Step 4 — Create your own prospect record

The consent grant has to point at a contact document whose seller and phone
match the evidence. There is no "add one prospect" button — the path is a CSV
import.

**→ [bitesites.org/admin/outbound](https://bitesites.org/admin/outbound) →
Build → Prospects**

Paste a two-line CSV:

```csv
name,company,phone,email
Your Name,BiteSites,+12015550123,you@example.com
```

Use your real mobile in E.164. Import as a **dry run first**, read what it says
it will do, then run it for real against the **BiteSites** account.

Then find the document ID — you need it in step 7:

**→ [Firestore console](https://console.firebase.google.com/project/bitesites-org/firestore/data/~2Fprospects)**
→ `prospects` → find your row → copy the document ID.

## Step 5 — Create the campaign

**→ Outbound → Operate → Campaigns → new campaign**

| Field | Value |
|---|---|
| Account | **BiteSites** |
| Mode | AI |
| Provider | Twilio |
| Caller ID | `+12015524949` |
| Simultaneous lines | 1 |
| Default AI agent | see below |
| Objective / script | whatever you want it to try to book |

On the caller ID: `+12015524949` is provisioned in your shared Twilio account
and registered to Stone Bellisimo and Fine Line in `accounts.js`. **BiteSites
declares no allow-list, so any valid E.164 passes its account check** — which is
why this walkthrough uses BiteSites. Carrier-side verification (STIR/SHAKEN,
A2P) is still missing and your call may show as "Spam Likely". For calling
yourself, that does not matter.

If the agent dropdown says *no agents belong to BiteSites yet*, create one
first: **Build → AI Agents**. A campaign in AI mode without an agent profile
cannot dial.

Leave the campaign **paused**. It is created paused and it stays that way until
step 12.

## Step 6 — Deploy 1: screening on, dialing off

Edit `functions/.env.bitesites-org`:

```bash
PAID_PHONE_SCREENING=enabled
OUTBOUND_EXTERNAL_DIALING=disabled     # leave this alone
```

Then:

```bash
PAID_SCREENING_AUTHORIZATION=authorized npm run preflight:production
npm run deploy:rules          # rules + indexes
```

Wait for the `campaignIncidents` and `dialerSessions` indexes to say **Enabled**
at **→ [Firestore indexes](https://console.firebase.google.com/project/bitesites-org/firestore/indexes)**.
They are declared in `firestore.indexes.json`, so the deploy creates them; they
just take a few minutes to build. Then:

```bash
npm run deploy:functions
```

This makes screening possible and dialing still impossible. That separation is
the entire reason there are two deploys.

> **Do not use `npm run ship`.** It runs `git add .` across the whole working
> tree and pushes before deploying. There is uncommitted work in this repo that
> is not yours.

Functions deploys on this codebase log alarming "Quota Exceeded" and "failed to
update function" warnings that are just internal retries. Trust the exit code.

## Step 7 — Enter the consent grant

**→ Outbound → Admin → AI Consent**

| Field | Value |
|---|---|
| Seller | BiteSites |
| Contact record | Prospect |
| Contact ID | the document ID from step 4 |
| Consented number | your mobile, E.164 |
| Subject name | your name |
| Written evidence type | Signed agreement |
| Evidence artifact ID | `aivc-v1-bitesites-20260826-01` |
| Disclosure version | `ai-voice-consent-v1` |
| Granted at | **the date you actually signed**, not today |
| Expires at | leave empty |
| Reviewer attestation | write it yourself, 20+ chars, first person |

`grantedAt` matters more than it looks — step 8 compares it to the
reassigned-number answer to the day. Get it wrong and you get
`reassigned_number_consent_date_mismatch` much later with no obvious cause.

Then **Review and issue grant** on the candidate that appears below. Saving
evidence and issuing the grant are two separate acts, on purpose. Do both.

## Step 8 — Screen the number

**→ Outbound → Admin → AI Consent → Pre-dial screening**

| Field | Value |
|---|---|
| Consented number | pick your grant from the dropdown |
| Screening provider | `Twilio Lookup v2` |
| National DNC service | `ftc_telemarketing_donotcall_gov` |
| DNC snapshot ID | `san-<YOUR-SAN>-20260826` from step 2 |
| DNC checked on | the date you downloaded the list |

Costs a few cents. Valid for 31 days.

If it refuses, the panel says which of these it is:

| Message | Fix |
|---|---|
| `paid_screening_not_explicitly_enabled` | Step 6 did not carry the flag. Redeploy. |
| `non_verifying_provider_in_production` | You left it on the mock. Pick Twilio Lookup. |
| `number_reassigned` | The consent date is wrong, or the number genuinely moved. |
| `line_type_not_callable` | Twilio thinks it is not a voice line. Different number. |
| `entity_dnc_suppressed` | You are on your own DNC list. Stop. |

## Step 9 — Import the target and approve its research

Two things, both easy to forget, and both hard blocks.

1. **Import into the campaign.** Outbound → Prospects → select your record →
   import into the campaign from step 5.
2. **Prepare and approve the research.** Outbound → Operate → **Queue**, with
   your campaign selected. A target with no approved call plan fails with
   `research_missing` or `research_not_approved`, and neither is obvious from
   the dialer screen.

## Step 10 — Ask the system if it agrees

**→ Outbound → Admin → Eligibility Audit**, on your campaign.

It runs the same gates the dialer runs, only stricter, and dials nothing. It
should now say **1 eligible**.

If it says zero it will name the bucket and the reason. That answer is
authoritative — it is reading the exact evidence the dial path will read. Do not
proceed hoping it is being pessimistic. It is not.

Expect to land here two or three times. This screen is the fast loop; everything
before it is setup.

## Step 11 — Deploy 2: dialing on

One word:

```bash
# functions/.env.bitesites-org
OUTBOUND_EXTERNAL_DIALING=enabled
```

```bash
OUTBOUND_CANARY_AUTHORIZATION=authorized npm run preflight:production
npm run deploy:functions
```

The environment variable is the record that a named person authorized carrier
dialing on a named day. Note in your deploy notes that this is §5 — the
rehearsal — not §9, because the variable cannot tell them apart.

## Step 12 — Unpause and dial

**→ Outbound → Operate → Campaigns** → resume your campaign.
**→ Outbound → Operate → Live Dialer** → dial.

Your phone rings. Answer it. Talk to it.

- Recording is off and stays off.
- A critical event pauses the campaign in the same transaction that records it,
  and blocks resume until an admin clears it with a stated corrective action.
  If that fires, read the incident before touching anything.

## Step 13 — Stand down the same day

```bash
# functions/.env.bitesites-org
OUTBOUND_EXTERNAL_DIALING=disabled
PAID_PHONE_SCREENING=disabled
```

```bash
npm run preflight:production      # no authorization variables needed now
npm run deploy:functions
```

Leaving dialing enabled between cohorts is how the next accident happens.

---

## What this does not give you

Calling yourself proves the machine works. It authorizes nothing about calling
anyone else, and none of these are satisfied by getting through it cleanly:

- counsel review of the consent wording (§4) — required before a stranger sees it
- verified caller identity: KYC, STIR/SHAKEN, A2P for `+12015524949` (§9)
- calendars for Stone Bellisimo and The Fine Line Group — they have **none** and
  would book against generic defaults
  ([SELLER_CALENDAR_CHECKLIST.md](./SELLER_CALENDAR_CHECKLIST.md))
- a staffed human-handoff roster, and Fine Line's emergency escalation contact
- budgets and cost alerts (§8)
- a live-model conversational evaluation (§10)
- explicit 25/day authorization (§9)

Scaling from one call to ten is just repeating steps 1, 7 and 8 per person. The
cohort size was never the hard part.
