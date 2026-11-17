# Stripe billing — autopay and Pay Now for client invoices

> **🚧 IN PROGRESS** — 2026-11-16 — Stripe autopay + Pay Now for monthly invoices — `functions/billing-stripe.js`, `functions/billing-stripe-api.js`, `functions/v2-index.js`, `functions/package.json`, `firestore.rules`, `firebase.json`, `src/admin/billing/*`, `src/pages/Pay*.jsx`, `src/main.jsx`, `scripts/check-no-secrets.mjs`, `scripts/test-billing-rules.mjs`, `FIREBASE_SETUP.md`, `.env.example`, `package.json`

Pairs with `feat/resend-invoicing` (invoice model, PDF, Resend email, admin
invoicing UI). This branch builds only the Stripe side against the shared
contract below. Not deployed.
