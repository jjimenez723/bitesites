// Seeds the CAAH billing client into the Firestore EMULATOR only.
//
//   firebase emulators:exec --only firestore --project demo-bitesites "npm run seed:billing"
//   # or, with emulators already running:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npm run seed:billing
//
// It refuses to run without FIRESTORE_EMULATOR_HOST, and refuses any project id
// that is not a demo-* project, so it can never write to production. The real
// CAAH record (with its real billing email) is created in Admin → Billing.
//
// Seeded: four retainer lines (SEO audit $600, ad maintenance $600, web
// maintenance $400, market research $200), $75/lead from the WordPress lead
// endpoint, manual approval, and invoiceNumberNext = 11 so the Dec 1, 2026
// invoice (November 2026) is #011.

import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { CAAH_BILLING_CLIENT, CAAH_CLIENT_ID } from './billing-fixtures.mjs';

const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'demo-bitesites';
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to seed: FIRESTORE_EMULATOR_HOST is not set. This script only writes to the emulator.');
  process.exit(1);
}
if (!projectId.startsWith('demo-')) {
  console.error(`Refusing to seed project "${projectId}": only demo-* emulator projects are allowed.`);
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();
const ref = db.doc(`billingClients/${CAAH_CLIENT_ID}`);
const existing = await ref.get();
if (existing.exists && !process.argv.includes('--force')) {
  console.log(`billingClients/${CAAH_CLIENT_ID} already exists in ${projectId}; pass --force to overwrite.`);
  process.exit(0);
}
await ref.set({ ...CAAH_BILLING_CLIENT, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
console.log(`Seeded billingClients/${CAAH_CLIENT_ID} in emulator project ${projectId} (next invoice #011).`);
