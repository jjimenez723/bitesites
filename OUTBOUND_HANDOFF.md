# Outbound handoff — what this is, and why it has not called anyone

Written 2026-08-25, at the end of the branch `feat/outbound-readiness-closeout`.

The other documents in this repository describe *controls*. This one describes
the *situation*, in plain language, because the controls have names like
"pre-dial screening evidence" and it is entirely reasonable to read that and
ask what on earth we are talking about.

---

## The whole thing in five sentences

You are building a system that phones small businesses with an AI voice, on
behalf of three sellers — BiteSites, Stone Bellisimo, and The Fine Line Group —
and books an appointment. The code to do that is written, tested, and works. It
is currently incapable of calling anyone, on purpose, because it demands
paperwork before every single call and **none of that paperwork exists for a
single phone number**.

The paperwork is not a technicality invented by this codebase. It is the
difference between cold-calling with a robot and doing so lawfully.

---

## The four things a call needs, and why each one is empty

Before the system will dial one number with an AI voice, four things have to be
true. Here is what each actually is, why it exists, and why there are currently
zero of them.

### 1. A consent grant — "this person agreed, in writing, that an AI may call them"

**What it is.** One row saying: *this specific phone number*, for *this specific
seller*, gave *written* permission to be called by an artificial voice, on
*this date*, having seen *this version of the disclosure* — and here is the ID
of the document they signed. An admin has to type a 20+ character attestation
saying they personally read that document.

**Why it exists.** An AI/artificial voice calling a stranger is a different
legal thing from a human doing it, and in the US it generally needs prior
express written consent. "They filled in a contact form once" is not that.
"They're an existing customer" is not that. "The CRM has a consent checkbox" is
not that either — the code explicitly refuses to turn a CRM field into a grant,
because a checkbox somebody clicked in GoHighLevel is not evidence anyone
agreed to a robot call.

**Why there are zero.** Because nobody has ever asked anyone. The leads in this
system came from two places: the Watcher corpus (businesses scraped off the
internet) and the old Byte-Dialer. Nobody in either list was ever shown a form
that said "an AI may call this number on behalf of BiteSites." There is no code
gap here. There is a business step — collecting consent — that has never been
designed or run once.

**What would create one.** A real signed thing (web form, agreement,
e-signature), then Outbound Calls → AI Consent → enter the number, the seller,
the artifact ID, the disclosure version, the date, and the attestation. Two
clicks after the hard part, which is the signature.

**What changed on 2026-08-25.** The thing to sign now exists in draft:
[AI_VOICE_CONSENT_v1.md](./AI_VOICE_CONSENT_v1.md) is the disclosure wording,
in three seller-specific versions, with the field-by-field mapping from a
signature to a ledger entry. It has **not** been reviewed by counsel, and it
says so in its own first line. It does not make the consent problem go away; it
removes the excuse that nobody knew what the form should say.

### 2. A pre-dial screening record — "this number is legal and real, checked recently"

**What it is.** A dated record, no more than 31 days old, that answers four
separate questions about the number:

| Question | Who answers it | Status |
|---|---|---|
| Is it on the **National Do Not Call registry**? | a subscription service | **not enrolled — but free at our scale** |
| Is it on **our own** do-not-call list? | us, free, already works | ✅ working |
| Was it **reassigned** to a different person since consent? | Twilio Lookup, billed per number | switched off |
| Is it a **real, callable line** (not a fax, pager, or dead number)? | Twilio Lookup, billed per number | switched off |

**Why it exists.** Consent answers "may we call this person." It does not
answer "is this still their number" or "have they since told the government to
stop calling them." Those are separate facts with expiry dates. Calling a
number that got reassigned to someone else means an AI cold-calls a stranger
using consent that a different human gave.

**Why there are zero.** Two of the four answers have to be bought and nobody
has bought them. There is no DNC vendor in this repository at all — the code
demands you hand it a dated snapshot ID from whatever service you enroll with,
and refuses to default to "clear," because "we didn't check" and "we checked
and it's fine" must never look the same.

**Worth knowing:** at ten-number rehearsal scale the Twilio Lookup spend is
cents, not a budget line. The authorization is blocking something trivially
cheap.

**And the DNC question is now answered: the first five area codes are free.**
That was checked on 2026-08-25 rather than assumed. The FTC charges $82 per area
code for FY2026 and caps a single entity at $22,626 for all of them, but the
first five cost nothing. Ten internal numbers will almost certainly span fewer
than five, so the national DNC line item for the rehearsal is **$0** — what it
costs is an enrollment at
[telemarketing.donotcall.gov](https://telemarketing.donotcall.gov) and the time
to download and check. This was the cheapest unlock on the list and it turned
out to be free.

**One thing got stricter, not looser.** Producing screening evidence in
production now requires a provider that actually asks an outside authority, and
the only one of those is the paid Twilio Lookup. Until 2026-08-25 an admin could
select the mock provider in production and mint a fully-passing screening record
whose reassignment and line-type verdicts were derived from the last two digits
of the phone number — the dial gate reads the verdicts, not which provider wrote
them. That is closed. The consequence for planning is that §3 is no longer
optional for the rehearsal: no paid screening authorization, no screening
evidence, no calls.

### 3. External dialing switched on — the master switch

**What it is.** One deploy-time flag. Off means the system physically cannot
create a carrier call, no matter what else is configured.

**Why it exists.** So that a half-configured system, or a bug, or a wrong click,
cannot ring a real phone.

**Where it actually stands.** ✅ **Resolved 2026-08-25 — it is off.**

It had been on. `functions/.env.bitesites-org` on this machine said
`OUTBOUND_EXTERNAL_DIALING=enabled`, and that file is untracked, so it never
showed up in a diff or a review and a production deploy from here would have
carried it. Nothing was ever live — production runs older code and the other
three gates were empty — but it was the one live hazard on this page.

It is now `disabled`, and `npm run preflight:production` passes. Two reasons for
resolving it that way rather than leaving it on:

- On, it bought nothing. Zero consent grants, zero screening records, every
  campaign paused — it was the single open gate standing in front of three
  closed ones.
- Off, the production deploy in stage 3 of the checklist becomes safe to run
  today, because a deploy is how this file reaches the runtime. On, that deploy
  was blocked.

Turning it back on for the rehearsal is one word plus
`OUTBOUND_CANARY_AUTHORIZATION=authorized` in the shell at deploy time. The
sequence is in
[OUTBOUND_FIRST_CALL_RUNBOOK.md](./OUTBOUND_FIRST_CALL_RUNBOOK.md).

### 4. Verified caller identity — the carrier paperwork

**What it is.** The phone companies knowing who you are: KYC, STIR/SHAKEN
attestation, A2P registration for the numbers that dial.

**Why it exists.** Without it your calls get labelled "Spam Likely" and
increasingly just get blocked. This is self-interest as much as compliance.

**Where it stands.** You **do** have a number — `+12015524949`, provisioned in
the shared Twilio account and registered to Stone Bellisimo and Fine Line in
`accounts.js`. I previously wrote that you didn't; that was wrong. What is
missing is the carrier-side verification for it, which is a different job from
owning the number.

---

## So what does "engineering complete" mean, if it can't call anyone?

It means every part that is *code* is finished and proven. Specifically: the
system knows how to make the call, and it correctly refuses to. Both halves
matter — a system that dials when it shouldn't is worse than one that never
dials.

What the branch added on top of that:

- **You can now ask "how many of these could we actually call?"** and get a
  real answer with reasons attached, without dialling anything. Outbound Calls
  → Eligibility Audit. Today the answer is zero, and the report tells you it is
  zero because of consent and screening, not because something is broken.
- **CI actually runs the tests now.** It never did — nothing installed the
  Firebase CLI, so the job died before reaching the application suite.
- **A production deploy can no longer switch something on without you noticing.**

---

## The shortest real path to a first phone call

The cheapest way to make all four gates real once is to call **one** person who
has signed something: yourself. One grant, one screening record, your own phone.
The system does not count participants — it checks evidence per number.

Ten is the cohort you want *before asking to call a stranger*, because ten calls
is enough to learn something. It is not a prerequisite for the first call, and
reading it as one has cost time already.

Step by step, with commands, this is now
[OUTBOUND_FIRST_CALL_RUNBOOK.md](./OUTBOUND_FIRST_CALL_RUNBOOK.md). In outline,
and none of these can be skipped:

1. ~~**Write the consent form.**~~ **Drafted 2026-08-25** —
   [AI_VOICE_CONSENT_v1.md](./AI_VOICE_CONSENT_v1.md), three seller-specific
   versions. Counsel still has to see this wording; it is the same wording that
   will later face strangers.
2. **Get ten internal people to sign it.** Real signatures, retained, each with
   an ID you can type in.
3. **Enroll for DNC** at telemarketing.donotcall.gov and check the ten numbers.
   Free for up to five area codes. You need a dated snapshot ID; the code will
   not proceed without one.
4. **Authorize Twilio Lookup** (§3) so line-type and reassigned-number checks
   can run. Cents at this scale, and now genuinely required rather than
   preferable.
5. **Deploy production with dialing still off but screening on** — run
   `npm run preflight:production` first. The two composite indexes are declared
   in `firestore.indexes.json`, so deploying rules and indexes builds them.
6. **Enter the ten grants**, then **screen the ten numbers**, both through
   Outbound Calls → AI Consent.
7. **Then, and only then**, turn on external dialing for the rehearsal, make
   the ten calls, and review every transcript.

Steps 1 and 2 are the long pole and they are not technical — step 1 is now a
draft awaiting counsel rather than a blank page. Everything after step 2 is
days, not weeks.

---

## If I were picking one thing to do this week

Steps 1 and 2. Not because they are urgent, but because **every other item on
every checklist in this repository is downstream of somebody signing a piece of
paper**, and that has been true since before this branch started. The
engineering has been ahead of the paperwork for a while, and more engineering
will not close the gap.

The second thing was deciding the `OUTBOUND_EXTERNAL_DIALING` flag, because that
one was a live hazard rather than a plan. That is done — it is off, and turning
it on is now a deliberate two-part act rather than something a deploy could do
by accident.

So: signatures. Ten of them. Everything else on this page is waiting on that.

---

## Where the detail lives

| Document | What it is for |
|---|---|
| [OUTBOUND_OWNER_CHECKLIST.md](./OUTBOUND_OWNER_CHECKLIST.md) | The six stages, one page, who decides each |
| [AI_VOICE_CONSENT_v1.md](./AI_VOICE_CONSENT_v1.md) | The form people sign, and what makes it count |
| [OUTBOUND_FIRST_CALL_RUNBOOK.md](./OUTBOUND_FIRST_CALL_RUNBOOK.md) | The ten-call rehearsal, in order, with commands |
| [OUTBOUND_COMPLETION_REPORT.md](./OUTBOUND_COMPLETION_REPORT.md) | What this branch changed, with test evidence |
| [OUTBOUND_PRODUCTION_READINESS.md](./OUTBOUND_PRODUCTION_READINESS.md) | Every control, in detail |
| [OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md) | The decisions made and the ones outstanding |
| [SELLER_CALENDAR_CHECKLIST.md](./SELLER_CALENDAR_CHECKLIST.md) | Stone and Fine Line have no calendar yet |

If you only read one other thing, read the owner checklist.
