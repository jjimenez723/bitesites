# BiteSites

Marketing site for BiteSites — React + Vite, built as a static bundle.

```bash
npm install
npm run dev        # http://localhost:5173
```

## Backend

Form submissions and authentication run on Firebase (project `bitesites-org`). Both the
intake form and the Bit chat write directly to Firestore from the browser; there is no
API server to run. See **[FIREBASE_SETUP.md](FIREBASE_SETUP.md)** for the data model,
the security model, and the remaining setup steps.

```bash
npm run test:rules # security-rule test suite (45 assertions)
npm run deploy     # build + deploy site and Firestore rules to Firebase Hosting
```

## Legal

`/terms` and `/privacy` are generated from [`src/pages/legal-details.js`](src/pages/legal-details.js).
Update the entity name, address and contact emails there before publishing.
