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
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile,
  onAuthStateChanged
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
  'auth/operation-not-allowed': 'Email sign-in is not enabled for this project yet.'
};

export const friendlyAuthError = error =>
  AUTH_ERRORS[error?.code] || 'Something went wrong. Please try again.';

const clean = (value, maxLen) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

export async function signUp({ email, password, displayName = '', company = '', phone = '' }) {
  if (!password || password.length < 8) {
    throw new Error('Please choose a password of at least 8 characters.');
  }

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

  await setDoc(doc(db, 'users', user.uid), profile);

  try {
    await sendEmailVerification(user);
  } catch (error) {
    console.warn('[auth] verification email failed', error);
  }

  return user;
}

export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, clean(email, 200).toLowerCase(), password);
}

export const signOutUser = () => signOut(auth);

export const resetPassword = email =>
  sendPasswordResetEmail(auth, clean(email, 200).toLowerCase());

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

    const [role, profile] = await Promise.all([resolveRole(user), fetchProfile(user)]);
    callback({ user, role, profile, loading: false });
  });
}

export const isAdmin = role => role === 'admin';
export const isApprovedClient = (role, profile) =>
  role === 'client' && profile?.status === 'approved';
