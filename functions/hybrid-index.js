// Hybrid Dialer V2 deployment entrypoint.
//
// The deployment automation temporarily selects this file so Firebase analyzes
// only Hybrid V2 exports. Existing legacy Functions remain deployed and do not
// force unrelated Kixie/discovery credentials into a Hybrid-only release.

import { getApps, initializeApp } from 'firebase-admin/app';

// `hybrid-index.js` is used as a standalone deployment entrypoint by
// scripts/hybrid.mjs. Unlike v2-index.js it does not import index.js, so it
// must initialise the Admin SDK itself before any callable uses Firestore.
// Guarding the call keeps this module safe when it is imported alongside the
// legacy entrypoint in tests or future deployment manifests.
if (!getApps().length) initializeApp();

export * from './outbound-api.js';
export * from './hybrid-dialer-api.js';
export * from './hybrid-session-api.js';
export * from './hybrid-ai-sip-dispatch.js';
export * from './hybrid-sideband-control.js';
export * from './calendar-api.js';
export * from './hybrid-ai-carrier-control.js';
export * from './hybrid-voicemail.js';
