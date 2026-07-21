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

- Firestore provisioned, security rules deployed, **45 rule assertions passing**
- Both site forms (intake + Bit chat) writing to `leads`
- **Email/Password auth enabled** — sign-up works, and a user cannot approve or
  promote themselves (both blocked in production, not just in tests)
- **App Check enforced** — an identical write was rejected without an attestation
  token and accepted with one
- Legal pages live at `/terms` and `/privacy`
- Authorized auth domains: `localhost`, `bitesites.org`, `www.bitesites.org`,
  `bitesites-org.web.app`, `bitesites-org.firebaseapp.com`

---

## What still needs you

### 1. Create your first admin

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

### 2. Fill in the legal placeholders

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

### 3. Add a recording notice before the Voice AI call

The Voice AI demo places a real GoHighLevel call, so visitor speech leaves the browser
and may be recorded. Both legal documents say so. But **a disclosure buried in a policy
page is weak consent.** New Jersey is one-party-consent; California, Pennsylvania and
Florida require *all* parties to consent, and your visitors could be anywhere.

Put a short line in the demo UI itself, above the button that starts the call —
*"This places a real AI call. It may be recorded and transcribed."* That turns a buried
term into informed consent at the moment it matters.

### 4. Give the GoHighLevel sync its webhook URL

The Cloud Function that pushes leads into GHL is deployed but inert until you supply
the Inbound Webhook URL. Two commands — see "Lead notifications" below.

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
  source: 'intake_form' | 'bit_chat',
  status: 'new',                    // client cannot choose; admins triage afterwards
  createdAt,                        // must equal server time — a forged value is rejected
  pagePath, referrer, userAgent
}
```

## Security model

- **Leads are append-only from the browser.** Create is public and heavily validated;
  read, update and delete are admin-only.
- **App Check gates every Firestore request.** The rules validate the *shape* of a
  lead; App Check attests the request came from this site in a real browser. Together
  they close both halves of the problem.
- **Privilege escalation is structurally impossible.** Roles live in a collection only
  an admin can write. A signing-up user can only create their own `users/{uid}` doc with
  `status: 'pending'`, and cannot later change that status.
- **Admins cannot rewrite lead history** — `createdAt` and `email` are immutable on update.
- **Everything undeclared is denied** by a catch-all `match /{document=**}`.
- Custom claims (`role`) set via the Admin SDK are honoured as a fast path, avoiding a
  document read per rule evaluation.

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

## Commands

```bash
npm run dev            # Vite dev server
npm run build          # production build to dist/
npm run test:rules     # 45 security-rule assertions against the emulator
npm run role -- <email> <admin|client|none>   # grant or revoke portal access
npm run deploy         # build + deploy hosting and Firestore rules/indexes
npm run deploy:rules   # rules and indexes only
npm run deploy:hosting # site only
npm run deploy:functions # the GoHighLevel lead sync
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
