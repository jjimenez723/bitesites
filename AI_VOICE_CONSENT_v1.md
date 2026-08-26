# AI voice consent — disclosure version `ai-voice-consent-v1`

Created 2026-08-25. **Draft. Not counsel-approved.** See
[Before this is used on anyone](#before-this-is-used-on-anyone).

Every other document in this repository describes a control that refuses to
call someone. This one describes the only thing that ever makes a call
possible: a person agreeing, in writing, that a machine may phone them.

Nothing like it existed until now. That is why the consent ledger has zero
entries — not a code gap, not an oversight in a checklist, but the fact that
nobody had written the thing there was to sign.

---

## What the law is asking for

An AI voice is an *artificial voice* under the TCPA. The FCC said so
explicitly in February 2024, and the ruling covers exactly what this system
does: real-time, LLM-driven, human-sounding conversation. It is not a grey
area and it is not a question of how good the voice is.

For a **telemarketing** call — which is what all three sellers are making — the
federal framework requires **prior express written consent**, which is a term
of art with parts. The agreement has to:

1. be **in writing** and bear the **signature** of the person being called
   (an E-SIGN-compliant electronic signature counts — a typed name plus a
   timestamped, authenticated submission is a signature);
2. **name the seller** that is authorized to call;
3. **contain the specific phone number** the person is authorizing;
4. **clearly and conspicuously disclose** that by signing, the person
   authorizes that seller to deliver telemarketing calls **using an artificial
   or prerecorded voice**; and
5. **clearly and conspicuously disclose** that signing is **not a condition**
   of buying anything.

Miss any one of those and what you hold is a friendly note, not consent. The
form below exists to make missing one hard.

Two things worth knowing about the ground shifting underneath this:

- A February 2026 Fifth Circuit decision (*Bradford v. Sovereign Pest Control*)
  read the statute as requiring only prior express consent for prerecorded
  calls to wireless numbers. That binds Texas, Louisiana and Mississippi. The
  FCC's written-consent framework still applies everywhere else, including New
  Jersey, where `+12015524949` is.
- Federal law is a floor. States add their own rules, several of them
  specifically about AI voices, and a few are stricter about consent, calling
  windows and disclosure than anything here. Counsel decides which states you
  are actually calling into.

The posture this repository takes is: **collect real written consent
everywhere, from everyone, regardless of which circuit they are in.** Consent
that is valid under the strictest reading is valid under all of them, and the
alternative is a compliance position that changes when somebody moves house.

## What this repository requires on top of the law

The consent ledger is deliberately stricter than the federal minimum in two
places. Both are worth understanding before you design a form around them,
because neither will bend:

- **Consent is per seller.** One grant authorizes one `sellerAccountId`. A
  person who signs for BiteSites has not consented to a call from Stone
  Bellisimo, and `consent-grants.js` will not let one grant cover both. This is
  why the form below comes in three versions rather than one with checkboxes.
  Whatever happens to the FCC's one-to-one consent rule in litigation, this
  design does not depend on the outcome.
- **Consent is never inferred.** No CRM field, no source label, no "they
  filled in a form once", no verbal yes on a previous call. The only route into
  the ledger is a named admin reviewing a retained document and typing an
  attestation that they personally read it.

---

## The form

Three versions, one per seller. They differ only in the seller name, the
description of what the call is about, and the contact block — everything
structural is identical, because the structural parts are the parts the law
cares about.

Print it, or put it behind an authenticated web form that records a timestamp
and IP. Both are signatures. Neither is better than the other legally; paper is
faster when you need one signature today, and an e-sign flow only starts paying
off somewhere past a few dozen.

### Version A — BiteSites

> **Permission to contact me using an automated AI voice**
>
> **BiteSites** builds and maintains websites and related digital services for
> small businesses.
>
> By signing below, I authorize **BiteSites** to make telemarketing and sales
> calls to the telephone number I have written below **using an artificial or
> prerecorded voice, including an automated AI voice assistant**, and using an
> automatic telephone dialing system. I understand that the caller on these
> calls may be software rather than a person, and that it will identify itself
> as such at the start of the call.
>
> **I am not required to sign this agreement in order to buy any goods or
> services from BiteSites, and signing is not a condition of any purchase.**
>
> I understand that:
>
> - I can withdraw this permission at any time, for any reason, by telling the
>   caller to stop calling, by emailing the address below, or by any other
>   reasonable method — and that BiteSites must honor it.
> - These calls are **not recorded**. If that ever changes, BiteSites will ask
>   for my separate permission on the call before any recording starts.
> - This permission applies only to **BiteSites**. It does not permit calls
>   from any other company.
> - This permission covers only the single telephone number written below.
>
> Telephone number I am authorizing: `+1 ______________________`
>
> Full name: `______________________________________`
>
> Signature: `__________________________`  Date: `______________`
>
> Email (for opt-out and a copy of this form): `_____________________________`
>
> To withdraw permission: reply STOP to any message, tell the caller to stop
> calling, or email **[opt-out address]**. BiteSites, **[contact address —
> see note below]**. Disclosure version `ai-voice-consent-v1`.

> **Note on the BiteSites address.** `OUTBOUND_LAUNCH_AUTHORIZATION.md` records
> an owner decision that the private business address must never be published,
> and the seller registry contains no BiteSites address for that reason. A
> consent form is a published document. Use a mailing address you are willing
> to have in a stranger's filing cabinet, or an email-only contact. Do not
> resolve this by pasting the home address in.

### Version B — Stone Bellisimo

Identical to Version A, replacing the seller name throughout with **Stone
Bellisimo**, and the description with:

> **Stone Bellisimo** supplies and installs natural stone and countertop
> surfaces.

Stone Bellisimo's conversion is a showroom visit, so add to the bullet list:

> - The purpose of these calls is to understand my project and, if it is a fit,
>   to arrange a showroom visit. The caller cannot quote prices.

### Version C — The Fine Line Group

Identical to Version A, replacing the seller name throughout with **The Fine
Line Group**, and the description with:

> **The Fine Line Group** provides construction, property transformation, and
> damage mitigation and restoration services.

Fine Line's motion is an assessment booking, and the runtime is already
hard-blocked from promising emergency response or insurance coverage. Say the
same thing on the form:

> - The purpose of these calls is to understand my situation and, if it is a
>   fit, to arrange an assessment. The caller cannot quote work, promise
>   emergency response, diagnose damage, or say whether insurance will cover
>   anything.
> - **If I have an emergency, I will call emergency services rather than wait
>   for a call back.**

---

## Turning a signature into a grant

Each signed form becomes exactly one ledger entry. The mapping is mechanical:

| Ledger field | What to put in it |
|---|---|
| `sellerAccountId` | `bitesites`, `stone-bellisimo`, or `fine-line-group` — whichever version they signed |
| `phoneE164` | The number written on the form, in E.164. Not another number you have for them |
| `contactType` / `contactId` | The Firestore `prospects/` or `leads/` document for this person. The server checks that its `accountId` and phone match the evidence and refuses if either has drifted |
| `evidenceType` | `signed_agreement` for paper, `signed_web_form` for a web submission, `digital_signature` for e-sign |
| `evidenceArtifactId` | The retained document's ID — see the scheme below |
| `disclosureVersion` | `ai-voice-consent-v1`. If you change a word of the form, this becomes `-v2` |
| `grantedAt` | The date on the signature. Not the date you typed it in |
| `expiresAt` | Optional. Leave empty for the internal ten; consider a horizon for strangers |
| `attestation` | 20+ characters, written by the reviewer, in the first person |

### The artifact ID scheme

`evidenceArtifactId` accepts `A-Z a-z 0-9 . _ : -`. Use:

```
aivc-v1-<seller>-<YYYYMMDD>-<NN>
```

For example `aivc-v1-bitesites-20260826-03` — the third BiteSites consent
signed on 26 August 2026. Name the retained scan or PDF exactly that, so a
document and its ledger entry can be matched by anyone later without asking
anyone. Keep them somewhere retained and backed up, and put that location in
`sourceUrl` if it has an HTTPS one.

### The attestation

It is a free-text field with a 20-character floor, and it exists so that
issuing a grant is an act by a named person rather than a click. Write what is
actually true. Something like:

> I have read the signed `ai-voice-consent-v1` form retained as
> `aivc-v1-bitesites-20260826-03`. It bears a signature, names BiteSites, names
> this exact number, and discloses both the artificial-voice authorization and
> that signing is not a condition of purchase.

Do not paste the same sentence ten times without reading ten documents. The
attestation is the part of this system a regulator would read first, and it is
the part that is trivially disprovable if it is not true.

---

## Collecting signatures

**Start with one: your own.** You can sign Version A for your own mobile number.
You are the person being called, giving BiteSites permission to call you with an
AI voice — a real signature from a real person who genuinely agrees, which is
exactly what the ledger wants. That single form is enough to make the first call
happen; see
[OUTBOUND_FIRST_CALL_RUNBOOK.md](./OUTBOUND_FIRST_CALL_RUNBOOK.md).

Ten people who work for you, each signing one of the three versions, is the
cohort you want before asking to call a stranger — enough calls to actually
learn something. The steps below are the same either way.

Do it on paper. An e-signature integration is a week of work and a vendor
relationship to serve ten signatures you can collect in an afternoon, and
nothing in the ledger prefers one over the other.

1. Pick the ten and which seller each is consenting for. Note that a person can
   sign more than one version if you want them in more than one cohort — that
   is two grants, not one.
2. Print the right version for each. Fill in nothing for them; the number has
   to be theirs, written by them.
3. Collect the signatures. Scan each one to `aivc-v1-<seller>-<date>-<NN>.pdf`.
4. Store the scans somewhere retained, backed up, and access-controlled. These
   are the documents that justify the calls.
5. Enter each one at **Outbound Calls → AI Consent**, then approve it in the
   same screen. Approval is the second act, deliberately.

Then screen them — consent alone does not make a number callable. That is the
next document:
[OUTBOUND_FIRST_CALL_RUNBOOK.md](./OUTBOUND_FIRST_CALL_RUNBOOK.md).

---

## Before this is used on anyone

**This is a drafted form, not legal advice, and it has not been reviewed by
counsel.** It was written against the federal framework as it stands in August
2026. What it does not and cannot decide:

- whether the wording is adequate in every state you intend to call into, and
  which states those are;
- calling windows, cadence, and per-state AI-voice disclosure requirements;
- consent retention and revocation policy, and how long a grant should live;
- whether a horizon on `expiresAt` should be mandatory rather than optional;
- the opt-out address and the contact block, which are business facts;
- whether the unrecorded posture holds in two-party-consent states once
  recording is ever considered.

`OUTBOUND_LAUNCH_AUTHORIZATION.md` §4 is exactly this, and it is still open.
For the internal ten — people who work for you, who know what they are signing
up for, and who can be told to stop at any time — the risk of running ahead of
counsel is one you can weigh yourself. For anyone else it is not, and the
external canary gate exists to stop that decision being made by momentum.

## Sources

- [FCC Declaratory Ruling, AI-generated voices are "artificial" under the TCPA (FCC 24-17)](https://docs.fcc.gov/public/attachments/FCC-24-17A1.pdf)
- [Wilson Sonsini — FCC Rules AI-Generated Voices Are "Artificial" Under the TCPA](https://www.wsgr.com/en/insights/fcc-rules-ai-generated-voices-are-artificial-under-the-tcpa.html)
- [Wiley — FCC Announces TCPA Restrictions Cover AI-Generated Voices in Outbound Calls](https://www.wiley.law/alert-FCC-Extends-Regulatory-Reach-Over-AI-Announces-TCPA-Restrictions-Cover-AI-Generated-Voices-in-Outbound-Calls)
- [FTC — Q&A for Telemarketers & Sellers About DNC Provisions in the TSR](https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0)
