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
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

const env = import.meta.env;

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyBK6c_9hF0gECJa-BL4kEmvDuq6ik3nqGU',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'bitesites-org.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'bitesites-org',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'bitesites-org.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '334264806949',
  appId: env.VITE_FIREBASE_APP_ID || '1:334264806949:web:e0443029f3c49fbb6259cc'
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// App Check is what actually stops a script from hammering the public lead form.
// It stays off until a reCAPTCHA v3 site key is provided so local dev and
// previews keep working without extra setup. See FIREBASE_SETUP.md step 4.
const recaptchaSiteKey = env.VITE_RECAPTCHA_SITE_KEY;

if (recaptchaSiteKey) {
  if (env.DEV && env.VITE_APPCHECK_DEBUG_TOKEN) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = env.VITE_APPCHECK_DEBUG_TOKEN;
  }
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true
    });
  } catch (error) {
    console.warn('[firebase] App Check failed to initialise', error);
  }
}
