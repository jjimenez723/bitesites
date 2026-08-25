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

### 2. A pre-dial screening record — "this number is legal and real, checked recently"

**What it is.** A dated record, no more than 31 days old, that answers four
separate questions about the number:

| Question | Who answers it | Status |
|---|---|---|
| Is it on the **National Do Not Call registry**? | a subscription service | **not purchased** |
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
cheap. Worth checking too whether the FTC's National DNC registry still offers
telemarketers free access for a small number of area codes — if it does, that
is the cheapest unlock on this entire list. Confirm it; don't take my word.

### 3. External dialing switched on — the master switch

**What it is.** One deploy-time flag. Off means the system physically cannot
create a carrier call, no matter what else is configured.

**Why it exists.** So that a half-configured system, or a bug, or a wrong click,
cannot ring a real phone.

**Where it actually stands.** This is the one thing that is *not* off.
`functions/.env.bitesites-org` on this machine says
`OUTBOUND_EXTERNAL_DIALING=enabled`. That file is untracked, so it never shows
up in a diff or a review, and a production deploy from here would have carried
it. Nothing is live — production runs older code and the other three gates are
empty — but this is the one item on this page that needs a decision today.
`npm run preflight:production` now refuses it.

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

The intended first cohort is ten calls to ten people who work for you, who have
each signed something. That is the cheapest way to make all four gates real
once, on people who will forgive you.

In order, and none of these can be skipped:

1. **Write the consent form.** What an AI voice call is, which seller, that
   they can opt out. Counsel should see this wording — it is the same wording
   that will later face strangers.
2. **Get ten internal people to sign it.** Real signatures, retained, each with
   an ID you can type in.
3. **Enter the ten grants** through Outbound Calls → AI Consent.
4. **Solve DNC for ten numbers.** Enroll somewhere, or confirm the free tier
   exists. You need a dated snapshot ID; the code will not proceed without one.
5. **Authorize Twilio Lookup** (§3) so line-type and reassigned-number checks
   can run. Cents at this scale.
6. **Deploy production with dialing still off** — run
   `npm run preflight:production` first, and build the two missing composite
   indexes.
7. **Then, and only then**, turn on external dialing for the rehearsal, make
   the ten calls, and review every transcript.

Steps 1 and 2 are the long pole and they are not technical. Everything after
step 3 is days, not weeks.

---

## If I were picking one thing to do this week

Steps 1 and 2. Not because they are urgent, but because **every other item on
every checklist in this repository is downstream of somebody signing a piece of
paper**, and that has been true since before this branch started. The
engineering has been ahead of the paperwork for a while, and more engineering
will not close the gap.

The second thing: decide the `OUTBOUND_EXTERNAL_DIALING` flag, because that one
is a live hazard rather than a plan.

---

## Where the detail lives

| Document | What it is for |
|---|---|
| [OUTBOUND_OWNER_CHECKLIST.md](./OUTBOUND_OWNER_CHECKLIST.md) | The six stages, one page, who decides each |
| [OUTBOUND_COMPLETION_REPORT.md](./OUTBOUND_COMPLETION_REPORT.md) | What this branch changed, with test evidence |
| [OUTBOUND_PRODUCTION_READINESS.md](./OUTBOUND_PRODUCTION_READINESS.md) | Every control, in detail |
| [OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md) | The decisions made and the ones outstanding |
| [SELLER_CALENDAR_CHECKLIST.md](./SELLER_CALENDAR_CHECKLIST.md) | Stone and Fine Line have no calendar yet |

If you only read one other thing, read the owner checklist.
