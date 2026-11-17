# Billing: monthly client invoicing and Resend email

> **🚧 IN PROGRESS** — 2026-11-16 — Resend replaces Postmark; monthly client invoicing (CAAH pilot) — `functions/email.js`, `functions/index.js`, `functions/hybrid-session-api.js`, `functions/billing-*.js`, `functions/billing-assets/`, `src/admin/Billing*.jsx`, `src/admin/billing/`, `src/admin/AdminApp.jsx`, `firestore.rules`, `firestore.indexes.json`, `firebase.json`, `storage.rules`, `integrations/wordpress/bitesites-lead-count/`, `scripts/seed-billing.mjs`, `FIREBASE_SETUP.md`, `README.md`

Branch: `feat/resend-invoicing`. Stripe autopay / Pay Now is built separately on
`feat/stripe-autopay` against the shared contract below.

## Plan

1. Swap every Postmark send path to Resend (REST), port the delivery webhook to
   Resend's Svix-signed webhooks, rename secrets to `RESEND_API_KEY` /
   `RESEND_WEBHOOK_SECRET`.
2. `billingClients` + `invoices` data model, admin-only rules.
3. Lead Generation line at $75/lead, count pulled from the CAAH WordPress lead
   table through a small secured plugin, with manual override.
4. Monthly scheduled draft creation, sequential per-client numbering.
5. Server-side PDF matching the foundation invoice (CAAH #011).
6. Branded invoice email through Resend with the PDF attached.
7. Admin Billing UI.
8. Emulator-only seed for CAAH, tests, sample PDF.
