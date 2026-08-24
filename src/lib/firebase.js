// Firebase app bootstrap.
//
// The values below are the project's *public* web config. Unlike a server key,
// a Firebase web config is designed to ship in the client bundle — it identifies
// the project, it does not authorise anything. All actual access control lives in
// firestore.rules, and abuse protection comes from App Check (see below).
//
// Each value can still be overridden per-environment with a VITE_FIREBASE_* var,
// which is useful for pointing a staging build at a separate project.

import { initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

const env = import.meta.env;

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyBK6c_9hF0gECJa-BL4kEmvDuq6ik3nqGU',
  // OAuth redirects are served from the verified Firebase Hosting custom domain.
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'bitesites.org',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'bitesites-org',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'bitesites-org.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '334264806949',
  appId: env.VITE_FIREBASE_APP_ID || '1:334264806949:web:e0443029f3c49fbb6259cc'
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Local UI rehearsals must never read or mutate production by accident. Vite
// development connects to emulators only when the ignored local environment
// explicitly opts in; production/staging builds never enter this branch.
if (env.DEV && env.VITE_USE_FIREBASE_EMULATORS === 'true') {
  const [host, rawPort] = String(env.VITE_FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085').split(':');
  connectFirestoreEmulator(db, host || '127.0.0.1', Number(rawPort) || 8085);
}

// firebase/auth is not exported from here on purpose: only the admin dashboard
// signs anyone in, and re-exporting it would drag the whole auth SDK into any
// bundle that only wanted `db`. See ./auth.js, which owns the instance.

// App Check is what actually stops a script from hammering the public lead form.
// The rules validate the *shape* of a lead; App Check attests that the request
// came from this site in a real browser. A reCAPTCHA Enterprise site key is
// public — it is embedded in the page by design — so it ships as the default.
const recaptchaSiteKey =
  env.VITE_RECAPTCHA_SITE_KEY || '6Lf0cV0tAAAAAGZIrvImMY7t-5MYmA6Xd2tGBC3M';
const appCheckEnabled = env.VITE_APPCHECK_ENABLED !== 'false';

// On localhost, register a debug token in the Firebase console instead of
// solving a live reCAPTCHA challenge. Set the var to `true` to have the SDK
// print a fresh token to the browser console on first run.
if (env.DEV && env.VITE_APPCHECK_DEBUG_TOKEN) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN =
    env.VITE_APPCHECK_DEBUG_TOKEN === 'true' ? true : env.VITE_APPCHECK_DEBUG_TOKEN;
}

// Firestore App Check enforcement also applies to signed-in admin reads. Keep
// App Check enabled in development so localhost receives a real attestation;
// otherwise Auth succeeds but every Firestore request is rejected. For LAN IPs
// and tunnels, use the debug-token path above instead.
if (appCheckEnabled) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true
    });
  } catch (error) {
    // Never let attestation failure blank the marketing site — a lead that cannot
    // be attested should surface as a failed submit, not a broken page.
    console.warn('[firebase] App Check failed to initialise', error);
  }
}
