# BiteSites

Marketing site for BiteSites — React + Vite, built as a static bundle.

```bash
npm install
npm run dev        # http://localhost:5173
```

## Backend

Form submissions and authentication run on Firebase (project `bitesites-org`). Both the
intake form and the Bit chat write directly to Firestore from the browser; there is no
API server to run. Access is enforced by `firestore.rules` and gated by App Check, and
a Cloud Function syncs each new lead into GoHighLevel. Current service pricing is served
only to authenticated accounts, and Postmark handles branded account and admin email.

See **[FIREBASE_SETUP.md](FIREBASE_SETUP.md)** for the data model, the security model,
and the remaining setup steps.

```bash
npm run test:rules                 # security-rule test suite (45 assertions)
npm run test:email                 # HTML template rendering and escaping
npm run role -- you@example.com admin   # grant portal access
npm run deploy                     # build + deploy site and Firestore rules
npm run deploy:functions           # deploy the GoHighLevel lead sync
```

## Brand consistency

Every user-facing screen and state—including sign-in, access-denied, empty,
error, and loading states—must include the BiteSites logo and use the established
brand styles. Do not expose implementation or administrator instructions to end
users; present clear, branded guidance instead.

## Legal

`/terms` and `/privacy` are generated from [`src/pages/legal-details.js`](src/pages/legal-details.js).
Update the entity name, address and contact emails there before publishing.
