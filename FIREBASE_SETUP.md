# Firebase setup

Backend for the BiteSites site: form storage, and authentication for the admin +
client portal.

| | |
|---|---|
| **Project** | `bitesites-org` ([console](https://console.firebase.google.com/project/bitesites-org/overview)) |
| **Owner account** | `jensyjimenez723@gmail.com` |
| **Database** | Cloud Firestore, `nam5` (US multi-region) |
| **Plan** | Blaze (pay-as-you-go) |
| **Hosting** | Firebase Hosting — https://bitesites-org.web.app |
| **App Check** | reCAPTCHA Enterprise, **enforced** on Firestore |

## Status

Live and verified against production:

- Firestore provisioned, security rules deployed, **83 rule assertions passing**
- Both site forms (intake + Bit chat) writing to `leads`
- **Email/Password auth enabled** — sign-up works, and a user cannot approve or
  promote themselves (both blocked in production, not just in tests)
- **Google sign-in built** — the console's "Continue with Google" button is wired
  and verified as far as the OAuth handler; it stays inert until the provider is
  switched on in the Firebase console (step 1 below)
- **App Check enforced** — an identical write was rejected without an attestation
  token and accepted with one
- Legal pages live at `/terms` and `/privacy`
- Authorized auth domains: `localhost`, `bitesites.org`, `www.bitesites.org`,
  `bitesites-org.web.app`, `bitesites-org.firebaseapp.com`

---

## What still needs you

### 1. Switch on Google sign-in

This is the one step that cannot be scripted. Enabling `google.com` needs an OAuth
2.0 client, and Google publishes no API for creating one — the Firebase console
provisions it for you behind the toggle. Everything on our side is already built.

1. [Firebase console → Authentication → Sign-in method](https://console.firebase.google.com/project/bitesites-org/authentication/providers)
2. Add provider → **Google** → Enable
3. Set the support email, then **Save**

That is the whole step; the console mints the OAuth client and wires the redirect
URI to `https://bitesites-org.firebaseapp.com/__/auth/handler` automatically. All
five domains the console runs on are already authorised, so nothing else changes.

To confirm it took:

```bash
gcloud auth print-access-token | xargs -I{} curl -s -H "Authorization: Bearer {}" \
  -H "x-goog-user-project: bitesites-org" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/bitesites-org/defaultSupportedIdpConfigs"
```

Before the toggle this returns `{}`. After, it lists a `google.com` entry with
`"enabled": true`.

**Signing in with Google grants no access on its own.** A Google account lands in
exactly the same place a new email account does — `users/{uid}` with status
`pending` and no `roles/{uid}` document, which every rule reads as "no access".
Granting the role is still step 2.

### 2. Create your first admin

Roles live in `roles/{uid}`, which **no client can write** — that is what makes
self-promotion impossible, so roles have to be granted with admin credentials.

1. Sign up through the site with the address you want to be the admin.
2. Run:

```bash
npm run role -- you@yourdomain.com admin
```

That writes `roles/{uid}`, sets a matching custom auth claim, and marks the profile
approved. Sign out and back in for the claim to reach the token.

The same script manages everyone else:

```bash
npm run role -- client@theircompany.com client   # approve a client
npm run role -- someone@example.com none         # revoke all access
```

It authenticates with your gcloud Application Default Credentials, so there is no
service-account key to create or leak. Verified working end to end: grant writes both
the document and the claim, revoke clears both.

### 3. Fill in the legal placeholders

[`src/pages/legal-details.js`](src/pages/legal-details.js) is the single source of truth
for both documents:

- `entity` — the full registered name (e.g. `BiteSites LLC`), not just the brand
- `mailingAddress` — currently `[Street address], New Jersey [ZIP]`
- `contactEmail` / `privacyEmail` — currently `hello@` and `privacy@bitesites.org`

> The Terms and Privacy Policy were written against what this codebase actually does —
> the real form fields, Firestore storage, Google Fonts, and the GoHighLevel-powered
> Voice AI demo. They are a solid, accurate starting point, but they are not legal
> advice. Have a lawyer review them before you rely on them, particularly the liability
> cap and the New Jersey governing-law clause.

### 4. Add a recording notice before the Voice AI call

The Voice AI demo places a real GoHighLevel call, so visitor speech leaves the browser
and may be recorded. Both legal documents say so. But **a disclosure buried in a policy
page is weak consent.** New Jersey is one-party-consent; California, Pennsylvania and
Florida require *all* parties to consent, and your visitors could be anywhere.

Put a short line in the demo UI itself, above the button that starts the call —
*"This places a real AI call. It may be recorded and transcribed."* That turns a buried
term into informed consent at the moment it matters.

### 5. Give the GoHighLevel sync its webhook URL

The Cloud Function that pushes leads into GHL is deployed but inert until you supply
the Inbound Webhook URL. Two commands — see "Lead notifications" below.

### 6. Byte's calls — done, nothing needed

Byte's leads arrive via `pollVoiceCalls`, which reads the GoHighLevel Voice AI call-log
API every 5 minutes. It is deployed and running; the history has been imported. See
"Byte's calls, the other way" below.

The `recordVoiceCall` webhook is the optional real-time alternative — it needs a Custom
Webhook action added by hand in the GHL workflow builder. Both can run at once; the
deterministic ids stop them duplicating each other.

---

## Data model

```
leads/{id}         Public form submissions. Anyone may create; only admins may read.
roles/{uid}        role: 'admin' | 'client'. Admin-writable only. The access-control root.
users/{uid}        Self-service profile. Created at sign-up with status 'pending'.
projects/{id}      Client portal records. clientUids[] controls who can read.
```

A lead (optional fields are omitted rather than stored empty):

```js
{
  name, email, businessSize, services[], preferredContactMethod,  // required
  phone, businessName, roleInCompany, urgencyTag, projectDetails, // optional
  customAnswers: { businessSize: 'about a dozen of us' },         // free-text chat answers
  source: 'intake_form' | 'bit_chat' | 'byte_voice',
  status: 'new',                    // client cannot choose; admins triage afterwards
  createdAt,                        // must equal server time — a forged value is rejected
  pagePath, referrer, userAgent,
  voice: { callId, providerCallId, durationSec, summary, recordingUrl }  // byte_voice only
}
```

`byte_voice` is the one source a browser cannot write: the rules restrict client
submissions to the other two, and Byte's leads are created server-side by
`recordVoiceCall` through the Admin SDK. That is deliberate — otherwise anyone could
forge a lead that looks like a booked call.

## Security model

- **Leads are append-only from the browser.** Create is public and heavily validated;
  read, update and delete are admin-only.
- **App Check gates every Firestore request.** The rules validate the *shape* of a
  lead; App Check attests the request came from this site in a real browser. Together
  they close both halves of the problem.
- **Privilege escalation is structurally impossible.** Roles live in a collection **no
  client may write at all** (see below). A signing-up user can only create their own
  `users/{uid}` doc with `status: 'pending'`, and cannot later change that status.
- **Admins cannot rewrite lead history** — `createdAt` and `email` are immutable on update.
- **Everything undeclared is denied** by a catch-all `match /{document=**}`.
- Custom claims (`role`) set via the Admin SDK are honoured as a fast path, avoiding a
  document read per rule evaluation.

### Why a role change goes through a Cloud Function

A role is **two** things that must move together:

| | |
|---|---|
| `roles/{uid}` | the document the rules fall back to |
| `role` custom claim | the fast path the rules check **first** |

A browser can write the document but cannot mint a claim — that needs the Admin SDK.
The Users tab used to revoke someone by deleting the document alone, which left a
revoked admin holding a claim that still said `admin`. Because the rules prefer the
claim, **that person kept full admin access**, and since a claim lives on the account
rather than in the session, signing out and back in simply reissued it. The revoke
looked like it worked and didn't.

So `roles/{uid}` is now `allow write: if false` for every client, admins included, and
the Users tab calls the **`setUserRole`** callable instead. It sets both halves or
neither, and calls `revokeRefreshTokens` so the ID token already sitting in that
person's browser dies immediately rather than carrying the old claim for up to an hour.
`npm run role` does the same thing from a terminal and remains the way out if the
console is ever unreachable.

An admin cannot change their own access through the callable — that is a guard rail
against the last admin locking everyone out, not a security control. Use `npm run role`
if you mean it.

Covered by `npm run test:role` (19 assertions, Firestore + Auth emulators). The case
named `CLEARS THE AUTH CLAIM` is the regression test for the bug above.

> **Deploy functions before rules.** The rules deny the browser's old write path, so
> if the rules land first the Users tab cannot change roles until the function catches
> up. `npm run deploy:functions && npm run deploy:rules` is the safe order.

The Firebase web config and the reCAPTCHA site key in `src/lib/firebase.js` are **public
by design** — they identify the project and authorise nothing. Never put an Admin SDK
service-account key in a `VITE_`-prefixed variable; those are inlined into the bundle.

### Consequence of App Check enforcement

Any script using the **client** SDK against production is now blocked — that is the
point. Server-side or scripted access must use the **Admin SDK with a service account**,
which bypasses App Check legitimately. `npm run test:rules` is unaffected: it runs
against the emulator, which does not evaluate App Check.

If local development ever fails attestation (a LAN IP, a tunnel URL — `localhost` itself
is already a registered reCAPTCHA domain), create a debug token under
[App Check → Apps → Manage debug tokens](https://console.firebase.google.com/project/bitesites-org/appcheck)
and put it in `.env.local` as `VITE_APPCHECK_DEBUG_TOKEN`. Delete it when you are done —
a debug token is a standing bypass.

## Lead notifications — GoHighLevel sync

[`functions/index.js`](functions/index.js) holds `syncLeadToGoHighLevel`, a Firestore
trigger that fires on every new `leads/{id}` and POSTs the lead to a GoHighLevel
**Inbound Webhook**, so web enquiries land in the same pipeline as the calls the voice
agent books.

It is deployed, but **inert until you give it a URL** — the secret currently holds the
placeholder `unset`, and anything that is not an `http(s)` URL is skipped quietly.

**To switch it on:**

1. In GoHighLevel, create a workflow with an **Inbound Webhook** trigger and copy its URL.
2. Store it and redeploy:

```bash
firebase functions:secrets:set GHL_WEBHOOK_URL   # paste the URL when prompted
npm run deploy:functions                         # secrets bind at deploy time
```

The payload includes `firstName` / `lastName` / `email` / `phone` / `companyName`, a
`source` of "Website - intake form" or "Website - Bit chat", `tags` like
`service:web_development` and `timeline:asap`, a human-readable `notes` summary, and a
`raw` object with the unmapped values. Map whatever you need inside the GHL workflow —
that keeps the mapping editable there rather than hard-coded in the function.

**Failure behaviour:** the function never rethrows. A CRM outage cannot lose a lead,
because the lead is already committed to Firestore before the trigger runs. The outcome
is written back onto the lead document:

```js
crm: { synced: true,  at }                      // delivered
crm: { synced: false, error: '...', at }        // delivery failed, lead still safe
crm: { synced: false, reason: 'not-configured' } // no URL set yet
```

So you can find unsynced leads with a `where('crm.synced', '==', false)` query.

If you would rather create contacts directly than go through a workflow, the v2 API
(`POST https://services.leadconnectorhq.com/contacts/` with a Private Integration token,
a `Version: 2021-07-28` header and a `locationId`) is a drop-in replacement for the
`postJson` call.

## Byte's calls — `recordVoiceCall`

The sync above runs one way. Byte's calls run the other: GoHighLevel owns the call, the
audio, the transcript and the contact it captures, and none of it reaches Firestore on
its own. The browser only records the *shape* of the session — when it started, how it
progressed, how it ended. That is why voice enquiries never appeared under **Leads**.

[`functions/index.js`](functions/index.js) holds `recordVoiceCall`, an HTTPS endpoint
GoHighLevel posts a finished call to. For each call it:

* attaches the transcript, summary and recording to the matching `calls/{id}` document —
  creating one if the call never came through the site widget, so calls placed to the
  real number appear under **Conversations** too;
* creates `leads/{id}` with `source: 'byte_voice'` whenever the call captured an email or
  a phone number, so Byte's leads sit in the same list as the intake form's and Bit's;
* links the two together, so opening a Byte lead shows the call it came from.

**To switch it on:**

1. Pick a long random secret and store it:

```bash
head -c 32 /dev/urandom | base64          # something to paste
firebase functions:secrets:set VOICE_WEBHOOK_SECRET
npm run deploy:functions                  # secrets bind at deploy time
```

2. In the GoHighLevel workflow that runs when a Byte call ends, add a **Custom Webhook**
   action:

```
POST https://us-central1-bitesites-org.cloudfunctions.net/recordVoiceCall
Header:  x-webhook-secret: <the secret from step 1>
Body (JSON):
{
  "callId":     "{{message.id}}",
  "email":      "{{contact.email}}",
  "phone":      "{{contact.phone}}",
  "name":       "{{contact.full_name}}",
  "duration":   "{{message.duration}}",
  "summary":    "{{message.summary}}",
  "transcript": "{{message.transcript}}"
}
```

Field names are flexible — `call_id`, `contact.email`, `first_name` + `last_name`,
`recording_url`, `call_duration` and several other spellings are all understood, and
anything nested under `contact` or `customData` is read too. Only two things matter:
`callId` (or `call_id`) makes redelivery safe, and at least one of `email` / `phone` is
what turns a call into a lead.

**Behaviour worth knowing:**

* **Fails closed.** Until `VOICE_WEBHOOK_SECRET` is a real value the endpoint answers
  `503` to everything. It creates leads, so an open one is a spam funnel.
* **Idempotent.** The lead id is derived from the call id, so GHL's retries cannot
  create a duplicate lead or a doubled transcript.
* **Retries are wanted.** Failures answer `500` precisely so GHL tries again — a dropped
  call summary is a lost lead.
* **Invents nothing.** No contact details means no lead, just a recorded call. Services
  are read from `service:*` tags and left empty otherwise.
* **No loop.** `syncLeadToGoHighLevel` skips `byte_voice` leads, since they are already
  contacts in GHL.

**Matching a call to the browser's record:** GHL never learns the id the browser
generated, so pass `sid` back if your workflow can carry it. Failing that the function
attaches to the most recent unclaimed call in the last two hours and logs that it did —
exact for one call at a time, which is the reality of a marketing site.

`npm run test:voice` exercises all of this against the emulator.

## Byte's calls, the other way — `pollVoiceCalls`

The webhook above needs a Custom Webhook action wired up by hand, because **workflows
are read-only over the API** — there is no endpoint that creates or edits one, whatever
scopes a token carries. So the path that actually runs today needs no GHL configuration
at all: it reads the Voice AI call-log API on a schedule.

`pollVoiceCalls` runs every 5 minutes, re-scanning a two-day window, and imports any
call that has a way to reach someone. `importVoiceHistory` is the same code over an
explicit date range, used once to bring the back catalogue in.

**API contract**, verified against the live API in July 2026:

```
GET services.leadconnectorhq.com/voice-ai/dashboard/call-logs
    Authorization: Bearer <private integration token>
    Version: 2021-07-28
    ?locationId= &page=(1-based) &pageSize=(max 50, 422 above)
→ { callLogs[], total, page, pageSize }
```

A call log carries `id`, `contactId`, `createdAt`, `duration` (seconds), `summary`,
`transcript` (`bot:` / `human:` lines), `trialCall`, `fromNumber` (real calls only), and
`extractedData { name, email, otherDetails, address }`. Contact details come from
`extractedData` — the agent pulls them out during the conversation — so no
`contacts.readonly` scope is needed.

**Three API traps, all of them silent:**

1. **`startDate` / `endDate` do nothing.** They are accepted without complaint — no 422,
   no warning — and then ignored: asking for March alone returns July calls. All date
   filtering happens in `fetchCallLogs`, not in the query.
2. **`total` is not filter-aware either**, so it cannot be used to drive pagination. A
   short page is the only reliable end.
3. **There is no sort parameter.** Results come back newest first, which is the one
   helpful accident — it is what lets `fetchCallLogs` stop as soon as it runs past the
   window instead of re-downloading the whole history every five minutes.

Trap 1 is easy to "verify" wrongly: because results are newest-first, page one of a
recent-dates query looks correctly filtered whether or not the filter works. Check a
window that should be *empty* (a future year) or an old one, never a recent one.

**Setup** (already done for `bitesites-org`):

```bash
firebase functions:secrets:set GHL_API_TOKEN --data-file ~/.ghl-token
npm run deploy:functions
```

The token is a location-scoped Private Integration token with Voice AI **read** access
only. `GHL_LOCATION_ID` is a plain constant in the code, not a secret — it is visible in
the GoHighLevel URL bar.

**One lead per person, not per call.** Leads are keyed on GoHighLevel's `contactId`, so
a prospect who rings four times is one lead carrying four calls, not four rows to work
through. A repeat call fills in blanks (an email they only gave the second time) but
never touches `status` or `createdAt` — triage belongs to whoever is working the lead,
and `createdAt` tracks the *first* call so the list sorts by when someone actually
turned up rather than when the import ran.

**Idempotency.** The poller re-scans the same window every five minutes, so each call
document records the lead it was counted against; a call that has already been folded in
is never counted twice. Without that, `callCount` would climb forever.

**What gets skipped:** calls under 10 seconds, and calls with neither an email nor a
caller id — a conversation nobody left contact details on is not a lead. Website-demo
calls (`trialCall`) *are* imported but tagged `voice.demo`, so they show a "demo" chip in
the dashboard and can be told apart from someone who dialled the number.

**Backfill** over any range — always dry-run first:

```bash
SECRET=$(firebase functions:secrets:access VOICE_WEBHOOK_SECRET)
URL=https://us-central1-bitesites-org.cloudfunctions.net/importVoiceHistory
curl -X POST -H "x-webhook-secret: $SECRET" \
  "$URL?startDate=2026-01-01&endDate=2026-12-31&includeDemo=false&dryRun=true"
```

`npm run test:import` exercises the whole pipeline against the **live** GHL API (read
only) writing into the emulator, so it catches drift in the real payload shape. It skips
itself if `~/.ghl-token` is absent.

## Commands

```bash
npm run dev            # Vite dev server
npm run build          # production build to dist/
npm run test:rules     # security-rule assertions against the emulator
npm run test:voice     # recordVoiceCall against the emulator
npm run test:import    # the GHL call-log import, live API → emulator
npm run test:role      # setUserRole — role document and auth claim stay in step
npm run role -- <email> <admin|client|none>   # grant or revoke portal access
npm run deploy         # build + deploy hosting and Firestore rules/indexes
npm run deploy:rules   # rules and indexes only
npm run deploy:hosting # site only
npm run deploy:functions # lead sync, Byte call webhook, and setUserRole
npm run emulators      # local Firestore/Auth emulators
```

`npm run test:rules` needs Java (already present) and uses port 8085.

## Reading leads before the admin UI exists

Leads are visible in the
[Firestore console](https://console.firebase.google.com/project/bitesites-org/firestore/data/~2Fleads).

## Note on the other BiteSites codebase

The live `bitesites.org` currently serves a **different, Next.js** app
(`../Agency-Intake-Site`) deployed on Cloudflare, which stores its intake in **Supabase**
and uses Cloudflare Turnstile. This repo is the Vite rebuild and is on Firebase. If this
build is meant to replace the live site, leads will be split across two backends until
the old one is retired — worth planning a migration or a cutover.
