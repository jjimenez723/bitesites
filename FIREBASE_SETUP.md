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

## Outbound calling — built, not deployed

The `/admin/outbound` area (lead discovery, prospects, campaigns, power and
parallel dialing) is implemented and tested but **has not been deployed and is
not production-ready**. It ships inert: with no provider secrets configured,
every provider reports itself unconfigured, every webhook returns
`503 not-configured`, and only the mock dialer works.

Before it can be used for real:

- Provider credentials (see OUTBOUND_CALLING_SETUP.md)
- Live provider webhooks
- GoHighLevel workflow setup, if AI calling is wanted
- **Legal and compliance approval** — the technical controls enforce configured
  settings; they do not make a campaign lawful
- One controlled live test call
- Separate approval before any production data migration

Three documents cover it: **OUTBOUND_CALLING_SETUP.md** (providers, secrets,
webhooks, the compliance checklist), **LEAD_DISCOVERY_SETUP.md** (sources, jobs,
the local worker, enrichment), **WATCHER_MIGRATION.md** (migrating the
`watcher-leads-89349` corpus). **CAPABILITY_INVENTORY.md** records what was
inspected in the source systems and what was deliberately excluded.

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
financeSettings/ledger          Ledger initialization metadata.
financeAccounts/{id}            Client retainers, initial payments, and payout rules.
financeTeam/{id}                Payout participants and expense-pool membership.
financeExpenses/{id}            Recurring/one-time costs with universal or client tags.
financeIncome/{id}              Dated commissions and other one-time revenue.
```

Outbound calling adds a second contact universe. It is deliberately separate
from `leads` — see the note below the collection list.

```
prospects/{id}                  Cold contacts: scraped, imported, migrated. Admin-read, server-write.
  activities/{id}               Append-only audit trail per prospect.
outboundCampaigns/{id}          Calling campaigns. Admin-read; every write goes through a callable.
  events/{id}                   Status changes, for the audit trail.
outboundTargets/{id}            One contact in one campaign. Exactly one of leadId/prospectId is set.
dialerSessions/{id}             A live power or parallel dialing session, plus its heartbeat.
leadResearch/{contactKey}       The sourced call brief. Key is `lead_<id>` or `prospect_<id>`.
scrapeJobs/{id}                 Lead-discovery jobs.
  results/{id}                  Raw provider payloads. Admin-only, deleted after 7 days.
importRuns/{id}                 Migration and CSV import runs, with their counts.
  errors/{id}                   Per-record failures — never in the run document.
outboundCallEvents/{id}         Webhook idempotency ledger. Unreadable and unwritable from any client.
```

**Why `prospects` is not `leads`.** A `lead` is someone who engaged with
BiteSites — a form, a Bit chat, or a Voice AI call — and the Overview and Performance
screens count it as a website conversion. A scraped business engaged with
nothing. Importing 40,000 of them into `leads` would destroy the funnel numbers,
the response-time metrics and the conversion reporting all at once.

A prospect becomes a lead only after **meaningful engagement**: someone answered
a call, a meeting was booked, an email was replied to, or an administrator
qualified it by hand. An attempted call is explicitly not enough —
`promoteProspect` refuses that trigger. Converted leads carry
`source: 'outbound'` and an `acquisition` block naming the campaign, target and
first connected call, so outbound-sourced leads can be excluded from
website-conversion maths.

Calls stay in the **existing** `calls` collection with optional outbound fields
(`direction`, `operator`, `dialerMode`, `campaignId`, `targetId`, `prospectId`,
`disposition`, `attemptNumber`, `cancellationReason`, …), and transcripts stay in
`calls/{id}/turns`. There is no second call-history system. A call with no
`direction` — every call recorded before this feature — is treated as inbound
everywhere it is read.

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
- **Finance is owner-write/admin-read.** Full admins can audit the finance collections,
  but only Jensy's two documented owner addresses can create, edit, or delete ledger rows.
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

2. In the GoHighLevel workflow that runs when a Voice AI call ends, add a **Custom Webhook**
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
what turns a call into a lead. The webhook also accepts `agentId`, `agentName`, and
`agentBusinessName` when those values are available in the workflow; the scheduled
call-log import resolves them directly from GHL's `agentId` either way.

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

A call log carries `id`, `agentId`, `contactId`, `createdAt`, `duration` (seconds), `summary`,
`transcript` (`bot:` / `human:` lines), `trialCall`, `fromNumber` (real calls only), and
`extractedData { name, email, otherDetails, address }`. Contact details come from
`extractedData` — the agent pulls them out during the conversation — so no
`contacts.readonly` scope is needed.

The importer also reads `GET /voice-ai/agents` and resolves each call's `agentId` to
the receiving agent and client. Both `calls.receivingAgent` and
`leads.voice.receivingAgent` retain `{ agentId, agentName, clientName }`, which keeps
Bella / Stone Bellisimo separate from Byte / Bite Sites throughout the dashboard and
post-conversation email flow.

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

**What gets skipped:** calls under 10 seconds. A call with neither an email nor a caller
id is still stored under **Conversations** with its transcript and summary; it simply does
not become a lead. For website calls, the importer matches the GoHighLevel log to the
browser's existing call document by its start time, enriching that row instead of making a
duplicate. Website-demo calls (`trialCall`) *are* imported but tagged `voice.demo`, so
they show a "demo" chip in the dashboard and can be told apart from someone who dialled
the number.

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

## Fine Line CRM dashboard — `/admin/crm`

Read-only view of the Fine Line Group HighLevel pipelines (Client Acquisition
`wGaMTdRFAzIElK5EQUIZ` and Referral Partners `pAjQijCNlnKNmb70H3ip` in location
`LDL5wuJlnVnqk9vn6taD`). The `getFineLineCrm` callable in
[`functions/flg-crm.js`](functions/flg-crm.js) is the only path: admin role
required, App Check enforced, all HighLevel calls server-side. The response is
sanitized — contact emails, phones, property addresses and note fields never
leave the function — and the module contains no write path, so the dashboard
cannot touch the live FLG workflows, stages or tags.

The token is its own secret, separate from the Voice AI poller's
`GHL_API_TOKEN`, so either can be rotated independently:

```bash
firebase functions:secrets:set GHL_CRM_DASHBOARD_TOKEN   # scoped: pipelines + opportunities read
npm run deploy:functions
```

Commission due to BiteSites is read from the `flg__bitesites_commission_*`
opportunity fields plus the `flg - commission due` contact tag; when the due
amount is not stored the dashboard computes collected revenue × rate.
`npm run test:crm` covers the client (pagination, 429/5xx retry, timeouts,
token scrubbing), the sanitizer, and the page's summary/filter/aging maths.

`syncFineLineCommissions` ([`functions/flg-commission-sync.js`](functions/flg-commission-sync.js))
rolls the same commission fields into the Finance board daily: one
deterministic `financeIncome` row per opportunity, joined to the
`fine-line-group` account (created on first run — set its allocations in the
board). `amount` is commission *actually paid*; due-but-unpaid stays in
`expected`/`outstanding` and the notes so monthly revenue is never inflated.
Workflow QA records are filtered out. Heartbeat: `systemHealth/flg-commission-sync`.

## Google Calendar deployment credential

Firebase resolves every `defineSecret` while it analyzes the complete Functions
entrypoint, including during a targeted deploy. The secret must therefore exist
even when Google Calendar mirroring is intentionally disabled. Create the safe
placeholder once so ordinary deploys do not stop for an interactive value:

```bash
printf '{}' | firebase functions:secrets:set GOOGLE_CALENDAR_CREDENTIALS \
  --data-file - --project bitesites-org
```

Firestore remains the calendar book of record and the UI reports Google sync as
disconnected while the value is `{}`. To enable the Google mirror, create a
dedicated Google service account with Calendar API access, download its JSON key,
share the target calendar with the key's `client_email` using **Make changes to
events**, and replace the placeholder with the entire JSON file:

```bash
firebase functions:secrets:set GOOGLE_CALENDAR_CREDENTIALS \
  --data-file /absolute/path/to/service-account-key.json \
  --project bitesites-org
```

Finally, set `googleCalendarId` and `googleSyncEnabled` in the Admin calendar
settings. Never commit the JSON key or place it in a Vite/client environment
variable.

Current BiteSites wiring:

| | |
|---|---|
| Service account | `bitesites-calendar@bitesites-org.iam.gserviceaccount.com` |
| Meetings are written to | `6da92e6a…@group.calendar.google.com` (shared booking calendar) |
| Read for conflicts only | `jensyjimenez723@gmail.com` |

### Blocking time from a calendar we never write to

`busyCalendarIds` in the calendar settings lists calendars consulted for
free/busy and never written to. It exists so a personal commitment stops the
voice agent and the public booking page offering that slot, without any client
meeting ever appearing on the personal calendar.

Each one has to be shared with the service account separately — a service
account can only see what has been shared with it, and Google answers a
calendar it cannot read with `notFound` inside the free/busy response rather
than failing the request. `createGoogleCalendarClient` logs that and skips the
calendar, so an unshared calendar degrades to "no conflicts known", not to a
broken booking flow. It also means an unshared calendar silently fails to
block. To share one:

1. Open Google Calendar as the calendar's owner.
2. Settings for that calendar → **Share with specific people or groups** → **Add people**.
3. Paste `bitesites-calendar@bitesites-org.iam.gserviceaccount.com`.
4. Permission **See only free/busy (hide details)** is enough. Send.

Verify from the console: **Admin → Calendar → Schedule settings** lists the
conflict calendars, and a slot that overlaps a personal event stops being
offered by *Find times* within a minute.

## Commercial analytics and CRM return path

Every new website lead now carries its random browser/session ids, first- and last-touch
source/medium/campaign, landing page, converting CTA, selected pricing plan, and site
release id. The same attribution object is sent to GoHighLevel in the inbound webhook
payload. The admin **Performance** view joins this to qualification, appointments, wins,
contract value, cash collected, direct delivery costs, gross profit, and client outcomes.
High-value funnel events are also rolled into `analyticsDaily/{day}` with hashed per-day
session and visitor deduplication. This keeps conversion totals accurate after the raw-event
heat-map query reaches its deliberate 5,000-document cap.

Stage changes made in Admin → Leads preserve timestamps and append immutable activity
records. GoHighLevel or a calendar workflow can update the same fields automatically via:

```text
POST https://bitesites.org/api/lead-lifecycle
x-webhook-secret: <LEAD_LIFECYCLE_WEBHOOK_SECRET>
```

Set the secret before deployment:

```bash
firebase functions:secrets:set LEAD_LIFECYCLE_WEBHOOK_SECRET
```

Use the `leadId` sent in the original GHL payload whenever possible. A canonical update is:

```json
{
  "eventId": "{{opportunity.id}}-{{opportunity.status}}",
  "leadId": "{{contact.leadId}}",
  "status": "won",
  "appointmentStatus": "attended",
  "scheduledFor": "2026-08-01T14:00:00Z",
  "contractValue": 12000,
  "cashCollected": 6000,
  "loadedLaborCost": 3200,
  "contractorCost": 800,
  "softwareCost": 200
}
```

Supported stages are `new`, `contacted`, `qualified`, `booked`, `proposal`, `won`, and
`lost`. Appointment outcomes are `none`, `booked`, `rescheduled`, `cancelled`, `attended`,
and `no_show`. Reusing `eventId` makes webhook redelivery idempotent. Exact email or phone
matching is available only as a fallback when a workflow cannot preserve `leadId`.

`npm run test:lifecycle` drives the endpoint against the Firestore emulator and verifies
authentication, stage timestamps, appointment outcomes, profit calculation, and redelivery.

### Daily Search Console sync

`syncSearchConsole` reads the final seven-day rolling window every morning, grouped by
date, query, landing page, and device. It stores deterministic rows in `searchMetrics` so
late Search Console adjustments overwrite previous values. The Performance view ranks
high-impression queries with available clicks and the landing pages generating organic
traffic.

The function uses Application Default Credentials with the read-only Search Console scope;
there is no browser token or downloadable service-account key. Setup is:

1. Enable the Search Console API for `bitesites-org`.
2. In Search Console, add the deployed Functions runtime service account as a user of the
   `sc-domain:bitesites.org` property.
3. If the property name differs, set `SEARCH_CONSOLE_SITE_URL` in
   `functions/.env.bitesites-org` before deployment. The default is already
   `sc-domain:bitesites.org`.

Search Console returns its top rows rather than guaranteeing an exhaustive export; the UI
treats these as content opportunities, not a financial ledger.

## Protected pricing and Postmark email

Pricing values now live in the `getServicePricing` callable instead of the public Vite
bundle. Firebase verifies the caller's ID token; any signed-in BiteSites account can see
prices, while admin data still requires the separate `admin` role.

Account creation, confirmation links, admin sign-up notices, password resets and admin
dashboard sends are delivered by Postmark. Lead receipts, team lead alerts, account-access
notices and delayed Bit/Byte feedback requests use the same delivery layer. Set the server
token and a separate webhook secret:

```bash
firebase functions:secrets:set POSTMARK_SERVER_TOKEN
firebase functions:secrets:set POSTMARK_WEBHOOK_SECRET
```

The Postmark server must have `jensy@bitesites.org` (or the whole domain) as a verified
sender. Non-secret runtime settings use these optional Functions environment variables:

```dotenv
POSTMARK_FROM_EMAIL="BiteSites <jensy@bitesites.org>"
ADMIN_NOTIFICATION_EMAIL="jensy@bitesites.org"
APP_URL="https://bitesites.org"
POSTMARK_MESSAGE_STREAM="outbound"
POSTMARK_BROADCAST_STREAM="broadcast"
```

Put overrides in `functions/.env.bitesites-org` for deployment or export them in the
deployment environment. Never put `POSTMARK_SERVER_TOKEN` in a `VITE_` variable.

The first account email or visit to **Admin → Email** seeds ten editable Firestore
templates: account confirmation, password reset, new-account admin notice, inquiry receipt,
conversation feedback, new-lead admin notice, access granted, access removed, operational
alert and client announcement. The dashboard edits `emailTemplates`, sends 1–50 individual messages per
request, previews HTML in a sandboxed iframe and records outcomes in `emailDeliveries`.
System templates can be edited but not deleted. Password-reset requests return the same
response for existing and unknown addresses and are rate-limited per normalized email.

Feedback requests are queued once per Bit chat or Voice AI call, sent after roughly 30 minutes,
and expire after 30 days. A rating link opens `/feedback` and never records a score from the
initial GET, so mailbox security scanners cannot submit feedback. Ratings of 1 or 2 create a
throttled internal operational alert. The on-page rating uses the same callable and stores the
summary on the related chat, call or lead. If someone rates on the page, the queued email is
cancelled instead of asking them a second time.

Broadcasts always receive a visible preferences link plus `List-Unsubscribe` and
`List-Unsubscribe-Post` headers. The preference page controls announcements and conversation
feedback separately; account security and requested service messages remain transactional.

In Postmark, configure Delivery, Bounce, Spam Complaint and Subscription Change webhooks to:

```text
https://postmark:<POSTMARK_WEBHOOK_SECRET>@bitesites.org/api/postmark-events
```

The webhook stores delivery events and suppresses announcements after an unsubscribe or
complaint. Inactive bounces and complaints also block automated transactional sends to the
address. This uses Postmark's supported Basic HTTP authentication. Choose a URL-safe webhook
secret and do not reuse `POSTMARK_SERVER_TOKEN` in the webhook URL.

`pollVoiceCalls` writes a heartbeat to `systemHealth/voice-poll`; `monitorOperations` checks it
every 15 minutes and alerts after 20 minutes without a healthy run. Repeated Postmark failures
and GoHighLevel lead-sync failures also create deduplicated `operationalAlerts` records.

Deploy Functions before deploying the gated frontend, otherwise signed-in users will see
the gate but the pricing callable will not exist:

```bash
npm run deploy:functions
npm run deploy:hosting
```

## Commands

```bash
npm run dev            # Vite dev server
npm run build          # production build to dist/
npm run test:rules     # security-rule assertions against the emulator
npm run test:voice     # recordVoiceCall against the emulator
npm run test:lifecycle # CRM/calendar stage, appointment and economics updates
npm run test:analytics # durable daily funnel aggregation and deduplication
npm run test:import    # the GHL call-log import, live API → emulator
npm run test:role      # setUserRole — role document and auth claim stay in step
npm run test:email     # template rendering, escaping, and Postmark payloads

# Outbound calling and lead discovery. No test places a call, contacts a
# provider, reads a credential, or touches a real Firebase project.
npm run test:prospects        # normalisation — pure, no emulator
npm run test:dedupe           # dedupe, compliance, Airbnb boundary, CSV — pure
npm run test:migration        # the migration tool's pure halves — pure
npm run test:discovery        # discovery jobs, import, resume, the local worker
npm run test:conversion       # prospect → lead, and the shared contact layer
npm run test:outbound         # campaigns, locking, first-answer-wins, dispositions
npm run test:outbound-webhook # webhook authentication and redelivery
npm run test:enrichment       # website fingerprinting, briefs, approval
npm run test:all              # build + every suite above, in order

npm run role -- <email> <admin|client|none>   # grant or revoke portal access
npm run deploy         # build + deploy hosting and Firestore rules/indexes
npm run deploy:rules   # rules and indexes only
npm run deploy:hosting # site only
npm run deploy:functions # pricing, Postmark, lead sync, voice functions, and roles
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
