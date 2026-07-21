# Firebase setup

Backend for the BiteSites site: form storage, and authentication for the upcoming
admin + client portal.

| | |
|---|---|
| **Project** | `bitesites-org` ([console](https://console.firebase.google.com/project/bitesites-org/overview)) |
| **Owner account** | `jensyjimenez723@gmail.com` |
| **Database** | Cloud Firestore, `nam5` (US multi-region) |
| **Plan** | Spark (free) — no billing enabled |
| **Hosting** | Firebase Hosting |

Already done and verified: project created, Firestore provisioned, web app registered,
security rules written, tested (45 assertions) and deployed, both site forms writing
to Firestore, legal pages live at `/terms` and `/privacy`.

---

## What still needs you

### 1. Turn on Authentication — required before anyone can sign up

This is the one step that cannot be scripted. Firebase blocks the Auth-provisioning
API on the free Spark plan, so it has to be done once in the console. Verified as of
this writing: a sign-up attempt currently fails with `auth/configuration-not-found`.

1. Open **[Authentication → Get started](https://console.firebase.google.com/project/bitesites-org/authentication)**
2. Choose **Email/Password**, toggle **Enable**, and save.
3. Optionally enable **Google** as a second provider.

Then confirm it worked:

```bash
npm run dev     # sign-up will now succeed instead of throwing configuration-not-found
```

### 2. Create your first admin

Roles are stored in a `roles/{uid}` collection that **no client can write to** — this is
what makes self-promotion impossible, so the first admin has to be seeded by hand.

1. Sign up through the site (or add a user under Authentication → Users).
2. Copy that account's **User UID**.
3. In **[Firestore → Data](https://console.firebase.google.com/project/bitesites-org/firestore/data)**,
   create collection `roles`, document ID = the UID, with one field:
   `role` (string) = `admin`.

That account can now read leads and approve other users. Everything else follows from
the app.

### 3. Turn on App Check — strongly recommended

The lead form accepts writes from anonymous visitors, because it has to: it is a public
marketing form on a static site. The rules constrain *shape* (every field is whitelisted,
typed and length-capped, and nothing can be read back), but they cannot tell a real
visitor from a script. **Without App Check, someone who reads your JS bundle can write
well-formed junk leads into the collection.** App Check is what closes that gap.

1. Create a **reCAPTCHA v3** site key at
   [google.com/recaptcha/admin](https://www.google.com/recaptcha/admin) for `bitesites.org`.
2. Register it under
   **[App Check → Apps → BiteSites Web](https://console.firebase.google.com/project/bitesites-org/appcheck)**.
3. Put the site key in `.env.local`:
   ```bash
   cp .env.example .env.local
   # then set VITE_RECAPTCHA_SITE_KEY=...
   ```
4. Rebuild and deploy, confirm requests are passing in the App Check console, then
   switch Firestore to **Enforced**.

App Check stays inert until that variable is set, so local dev keeps working untouched.

### 4. Fill in the legal placeholders

[`src/pages/legal-details.js`](src/pages/legal-details.js) is the single source of truth
for both documents. Confirm before publishing:

- `entity` — the full registered name (e.g. `BiteSites LLC`), not just the brand
- `mailingAddress` — currently `[Street address], New Jersey [ZIP]`
- `contactEmail` / `privacyEmail` — currently `hello@` and `privacy@bitesites.org`

> The Terms and Privacy Policy were written against what this codebase actually does —
> the real form fields, Firestore storage, Google Fonts, and the GoHighLevel-powered
> Voice AI demo. They are a solid, accurate starting point, but they are not legal
> advice. Have a lawyer review them before you rely on them, particularly the liability
> cap and the New Jersey governing-law clause.

### 5. Add a recording notice before the Voice AI call

The Voice AI demo places a real GoHighLevel call, so visitor speech leaves the browser
and may be recorded. Both legal documents now say so. But **a disclosure buried in a
policy page is weak consent.** New Jersey is a one-party-consent state; California,
Pennsylvania, Florida and others require *all* parties to consent, and your visitors
could be anywhere.

Before launch, put a short line in the demo UI itself, above the button that starts the
call — something like *"This places a real AI call. It may be recorded and transcribed."*
That converts a buried term into informed consent at the moment it matters, and costs
one line of JSX in `src/components/VoiceAIReceptionist.jsx`.

---

## Data model

```
leads/{id}         Public form submissions. Anyone may create; only admins may read.
roles/{uid}        role: 'admin' | 'client'. Admin-writable only. The access-control root.
users/{uid}        Self-service profile. Created at sign-up with status 'pending'.
projects/{id}      Client portal records. clientUids[] controls who can read.
```

A lead looks like this (optional fields are omitted rather than stored empty):

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
  read, update and delete are admin-only. Verified against production: an anonymous
  client can submit, cannot read the collection back, and cannot write a malformed doc.
- **Privilege escalation is structurally impossible.** Roles live in a separate
  collection that only an admin can write. A user signing up can only ever create their
  own `users/{uid}` doc with `status: 'pending'`, and cannot later change that status.
- **Admins cannot rewrite lead history** — `createdAt` and `email` are immutable on update.
- **Everything undeclared is denied** by a catch-all `match /{document=**}`.
- Custom claims (`role`) set via the Admin SDK are honoured as a fast path, avoiding a
  document read per rule evaluation.

The Firebase web config in `src/lib/firebase.js` is **public by design** — it identifies
the project and authorises nothing. Never put an Admin SDK service-account key in a
`VITE_`-prefixed variable; those are inlined into the browser bundle.

## Commands

```bash
npm run dev            # Vite dev server
npm run build          # production build to dist/
npm run test:rules     # 45 security-rule assertions against the emulator
npm run deploy         # build + deploy hosting and Firestore rules/indexes
npm run deploy:rules   # rules and indexes only
npm run deploy:hosting # site only
npm run emulators      # local Firestore/Auth emulators
```

`npm run test:rules` needs Java (already present) and uses port 8085.

## Reading leads before the admin UI exists

Until the portal is built, leads are visible in the
[Firestore console](https://console.firebase.google.com/project/bitesites-org/firestore/data/~2Fleads).
Consider adding an email notification — a Cloud Function on `leads` `onCreate` — so
enquiries do not sit unnoticed. That requires the Blaze plan.

## Note on the other BiteSites codebase

The live `bitesites.org` currently serves a **different, Next.js** app
(`../Agency-Intake-Site`) deployed on Cloudflare, which stores its intake in **Supabase**
and uses Cloudflare Turnstile. This repo is the Vite rebuild and is now on Firebase. If
this build is meant to replace the live site, leads will be split across two backends
until the old one is retired — worth planning a migration or a cutover.
