// Authentication for the upcoming admin + client portal.
//
// Access model (enforced in firestore.rules, mirrored here):
//   * Anyone may create an account. Signing up writes users/{uid} with
//     status "pending" and grants no data access whatsoever.
//   * Authorisation lives in roles/{uid}, which only an admin can write. A user
//     therefore cannot promote themselves — not by tampering with the client,
//     not by replaying a request.
//   * Admins may also be marked with a `role` custom claim via the Admin SDK,
//     which avoids a document read on every rule evaluation.

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  sendEmailVerification
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { app, db } from './firebase';

// The auth instance lives here rather than in ./firebase so that the marketing
// bundle, which only ever wants `db`, does not also ship the auth SDK.
const auth = getAuth(app);

const AUTH_ERRORS = {
  'auth/email-already-in-use': 'An account with that email already exists.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/weak-password': 'Please choose a password of at least 8 characters.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network unavailable. Please check your connection.',
  'auth/operation-not-allowed': 'That sign-in method is not enabled for this project yet.',
  'auth/popup-closed-by-user': 'Sign-in window closed before it finished.',
  'auth/cancelled-popup-request': 'Sign-in window closed before it finished.',
  'auth/user-disabled': 'That account has been disabled.',
  'auth/unauthorized-domain': 'This address is not on the project’s authorised sign-in domains.',
  'auth/account-exists-with-different-credential':
    'That email already has a password account here. Sign in with your password first.'
};

export const friendlyAuthError = error =>
  AUTH_ERRORS[error?.code] || 'Something went wrong. Please try again.';

const clean = (value, maxLen) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

// Set while signUp() is mid-flight. onAuthStateChanged fires the instant the
// account exists, so without this the session watcher would race signUp to
// write users/{uid} and the bare profile could clobber the richer one.
let signUpInFlight = false;

// Creates users/{uid} the first time an account is seen. Google sign-in is
// self-service, so this is where a brand-new account gets its profile record.
// Status is pinned to "pending", which grants nothing: access comes only from
// roles/{uid}, and no client can write that. Returns null if the write fails —
// a missing profile row must never block an already-authorised admin.
async function ensureProfile(user) {
  if (!user?.email) return null;

  const reference = doc(db, 'users', user.uid);
  const profile = {
    email: user.email,
    status: 'pending',
    createdAt: serverTimestamp()
  };
  const name = clean(user.displayName, 120);
  if (name) profile.displayName = name;

  try {
    await setDoc(reference, profile);
  } catch (error) {
    console.warn('[auth] could not create the profile record', error);
    return null;
  }
  return { uid: user.uid, ...profile };
}

export async function signUp({ email, password, displayName = '', company = '', phone = '' }) {
  if (!password || password.length < 8) {
    throw new Error('Please choose a password of at least 8 characters.');
  }

  signUpInFlight = true;
  try {
    const credential = await createUserWithEmailAndPassword(
      auth,
      clean(email, 200).toLowerCase(),
      password
    );
    const { user } = credential;

    const name = clean(displayName, 120);
    if (name) await updateProfile(user, { displayName: name });

    // Profile shape is whitelisted by firestore.rules; status is pinned to
    // "pending" there too, so this cannot be forged into an approved account.
    const profile = {
      email: user.email,
      status: 'pending',
      createdAt: serverTimestamp()
    };
    if (name) profile.displayName = name;
    const companyName = clean(company, 160);
    if (companyName) profile.company = companyName;
    const phoneNumber = clean(phone, 40);
    if (phoneNumber) profile.phone = phoneNumber;

    // Deliver the verification message before creating the profile document.
    // The document trigger handles the internal new-account notification, and
    // must never race this customer-facing confirmation email.
    try {
      await sendEmailVerification(user, { url: 'https://bitesites.org/#pricing' });
    } catch (error) {
      // Account creation succeeded. The signed-in member can use the resend
      // control, which presents a clear message if Firebase asks for a pause.
      console.warn('[auth] could not send initial verification email', error?.code);
    }

    await setDoc(doc(db, 'users', user.uid), profile);

    return user;
  } finally {
    signUpInFlight = false;
  }
}

export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, clean(email, 200).toLowerCase(), password);
}

// ------------------------------------------------------------------- Google
//
// Google sign-in changes who can *authenticate*, never who can *see anything*.
// A Google account lands in exactly the same place a new email account does:
// users/{uid} with status "pending" and no roles/{uid} document, which every
// rule in firestore.rules reads as "no access". An admin still has to grant the
// role from the Users tab.
//
// What it buys on the security side is that the password stops existing here:
// whatever 2FA, hardware key or passkey guards the Google account now guards the
// console too, and there is no credential left for us to leak or for anyone to
// stuff. Prefer it over the password form.

const googleProvider = new GoogleAuthProvider();
// Always show the account chooser. Without it a shared machine silently reuses
// whichever Google session is already open in the browser, which is the wrong
// default for a console someone else may walk up to.
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Popups are the better flow — they keep the page, and its App Check token,
// alive. Some browsers (older iOS Safari, in-app webviews, hardened popup
// blockers) refuse them outright, and only then do we fall back to a redirect.
const POPUP_UNAVAILABLE = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
  'auth/web-storage-unsupported'
]);

// Resolves to the user on the popup path. On the redirect path the browser
// navigates away and nothing after this runs — completeRedirectSignIn picks the
// result back up when the page reloads.
export async function signInWithGoogle() {
  try {
    const { user } = await signInWithPopup(auth, googleProvider);
    return user;
  } catch (error) {
    if (!POPUP_UNAVAILABLE.has(error?.code)) throw error;
    await signInWithRedirect(auth, googleProvider);
    return null;
  }
}

// Call once when the sign-in screen mounts. onAuthStateChanged already handles
// the happy path; this exists so a redirect that *failed* surfaces as a message
// instead of dumping the user back on the login form with no explanation.
export async function completeRedirectSignIn() {
  const result = await getRedirectResult(auth);
  return result?.user || null;
}

export const signOutUser = () => signOut(auth);

// Password links are generated by Firebase Admin and delivered through the
// editable BiteSites Postmark template. The callable always returns the same
// message so the form cannot be used to discover registered email addresses.
export async function resetPassword(email) {
  const { getFunctions, httpsCallable } = await import('firebase/functions');
  const call = httpsCallable(getFunctions(app, 'us-central1'), 'requestPasswordReset');
  const { data } = await call({ email: clean(email, 200).toLowerCase() });
  return data;
}

export async function resendConfirmation() {
  const user = auth.currentUser;
  if (!user?.email) throw new Error('Sign in to resend your confirmation email.');

  // Firebase sends this directly, so account confirmation remains available
  // while the transactional-email provider is awaiting approval.
  try {
    await sendEmailVerification(user, { url: 'https://bitesites.org/#pricing' });
    return { ok: true, alreadyVerified: false };
  } catch (error) {
    if (error?.code === 'auth/too-many-requests') {
      throw new Error('For your security, please wait a few minutes before requesting another confirmation email.');
    }
    if (error?.code === 'auth/unauthorized-continue-uri') {
      throw new Error('Confirmation email is temporarily unavailable. Please contact BiteSites support.');
    }
    throw new Error('We could not send your confirmation email just now. Please try again shortly.');
  }
}

export async function fetchServicePricing() {
  const { getFunctions, httpsCallable } = await import('firebase/functions');
  const call = httpsCallable(getFunctions(app, 'us-central1'), 'getServicePricing');
  const { data } = await call();
  return data?.pricing || null;
}

// Resolves the caller's effective role: custom claim first, then roles/{uid}.
// Returns 'admin' | 'client' | '' (no access yet).
export async function resolveRole(user) {
  if (!user) return '';

  try {
    const token = await user.getIdTokenResult();
    if (token.claims?.role) return token.claims.role;
  } catch (error) {
    console.warn('[auth] could not read token claims', error);
  }

  try {
    const snapshot = await getDoc(doc(db, 'roles', user.uid));
    return snapshot.exists() ? snapshot.data().role || '' : '';
  } catch (error) {
    console.warn('[auth] could not read role document', error);
    return '';
  }
}

export async function fetchProfile(user) {
  if (!user) return null;
  const snapshot = await getDoc(doc(db, 'users', user.uid));
  return snapshot.exists() ? { uid: user.uid, ...snapshot.data() } : null;
}

// Emits { user, role, profile, loading:false } on every auth change.
export function watchSession(callback) {
  return onAuthStateChanged(auth, async user => {
    if (!user) return callback({ user: null, role: '', profile: null, loading: false });

    const [role, existing] = await Promise.all([resolveRole(user), fetchProfile(user)]);

    // A Google account signing in for the first time has authenticated but has
    // no profile row yet. Creating it here covers both the popup and the
    // redirect flow; signUp writes its own richer row, so stand clear of that.
    const profile = existing || (signUpInFlight ? null : await ensureProfile(user));

    callback({ user, role, profile, loading: false });
  });
}

export const isAdmin = role => role === 'admin';
export const isApprovedClient = (role, profile) =>
  role === 'client' && profile?.status === 'approved';
