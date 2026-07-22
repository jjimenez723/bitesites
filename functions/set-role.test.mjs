// Drives setUserRole against the Firestore + Auth emulators:  npm run test:role
//
// This function exists because of a specific bug: the Users tab used to revoke
// someone by deleting roles/{uid} and nothing else. The rules read the custom
// auth claim *first* and only fall back to that document, so a revoked admin
// kept a claim still saying "admin" — and a claim lives on the account, not in
// the session, so signing out and back in reissued it. The revoke looked like it
// worked and didn't.
//
// The cases below therefore assert on both halves every time. A test that only
// checked the document would have passed against the broken version.
//
// Lives beside the function so `firebase-admin` resolves to the same copy the
// function uses. `*.test.mjs` is excluded from the deploy in firebase.json.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { setUserRole } = await import('./index.js');
const { getFirestore } = await import('firebase-admin/firestore');
const { getAuth } = await import('firebase-admin/auth');

const db = getFirestore();
const auth = getAuth();

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const describe = title => console.log(`\n${title}`);

// Calls the function the way the SDK would, minus the transport.
const call = (data, authContext) => setUserRole.run({ data, auth: authContext, rawRequest: {} });

// Returns the error code rather than throwing, so a case can assert on it.
const codeOf = async promise => {
  try {
    await promise;
    return 'no-error';
  } catch (error) {
    return error?.code || String(error?.message || error);
  }
};

const claimOf = async uid => (await auth.getUser(uid)).customClaims?.role ?? null;
const roleDocOf = async uid => {
  const snapshot = await db.doc(`roles/${uid}`).get();
  return snapshot.exists ? snapshot.get('role') : null;
};
const statusOf = async uid => {
  const snapshot = await db.doc(`users/${uid}`).get();
  return snapshot.exists ? snapshot.get('status') : null;
};

// ---------------------------------------------------------------- fixtures

const mk = async (uid, email) => {
  await auth.createUser({ uid, email, password: 'test-password-123' }).catch(() => {});
  await db.doc(`users/${uid}`).set({ email, status: 'pending' });
  return uid;
};

await mk('admin_caller', 'admin@example.com');
await mk('second_admin', 'admin2@example.com');
await mk('target', 'target@example.com');
await mk('stale_admin', 'stale@example.com');

// The caller is an admin by document, the way a bootstrapped first admin is.
await db.doc('roles/admin_caller').set({ role: 'admin', email: 'admin@example.com' });

const ADMIN = { uid: 'admin_caller', token: { email: 'admin@example.com' } };

// ------------------------------------------------------------------- cases

describe('who may call it');
check('rejects an unauthenticated caller',
  (await codeOf(call({ uid: 'target', role: 'admin' }, null))) === 'unauthenticated');

check('rejects a signed-in non-admin',
  (await codeOf(call({ uid: 'target', role: 'admin' }, { uid: 'target', token: {} }))) === 'permission-denied');

check('rejects a client trying to promote themselves',
  (await codeOf(call({ uid: 'target', role: 'admin' }, { uid: 'target', token: { role: 'client' } }))) === 'permission-denied');

describe('granting sets both halves');
await call({ uid: 'target', role: 'client' }, ADMIN);
check('writes the role document', (await roleDocOf('target')) === 'client');
check('mints the matching auth claim', (await claimOf('target')) === 'client');
check('marks the profile approved', (await statusOf('target')) === 'approved');

describe('promotion updates the claim, not just the document');
await call({ uid: 'target', role: 'admin' }, ADMIN);
check('role document says admin', (await roleDocOf('target')) === 'admin');
check('claim says admin too', (await claimOf('target')) === 'admin');

describe('revoking clears both halves — the bug this function exists for');
await call({ uid: 'target', role: 'none' }, ADMIN);
check('deletes the role document', (await roleDocOf('target')) === null);
check('CLEARS THE AUTH CLAIM', (await claimOf('target')) === null,
  'the old UI left this set, so a revoked admin stayed admin');
check('returns the profile to pending', (await statusOf('target')) === 'pending');

describe('a claim-only admin is fully revocable');
// Exactly the state `npm run role` produces: claim set, and the document that
// the old revoke path deleted. Revoking has to reach the claim or nothing happens.
await auth.setCustomUserClaims('stale_admin', { role: 'admin' });
await db.doc('roles/stale_admin').set({ role: 'admin', email: 'stale@example.com' });
await call({ uid: 'stale_admin', role: 'none' }, ADMIN);
check('claim-granted admin loses the claim', (await claimOf('stale_admin')) === null);
check('claim-granted admin loses the document', (await roleDocOf('stale_admin')) === null);

describe('guard rails');
check('an admin cannot revoke themselves',
  (await codeOf(call({ uid: 'admin_caller', role: 'none' }, ADMIN))) === 'failed-precondition');

check('an admin cannot demote themselves to client',
  (await codeOf(call({ uid: 'admin_caller', role: 'client' }, ADMIN))) === 'failed-precondition');

check('an admin can still revoke a different admin',
  (await codeOf(call({ uid: 'second_admin', role: 'admin' }, ADMIN))) === 'no-error'
  && (await codeOf(call({ uid: 'second_admin', role: 'none' }, ADMIN))) === 'no-error');

check('rejects an unknown role',
  (await codeOf(call({ uid: 'target', role: 'superuser' }, ADMIN))) === 'invalid-argument');

check('rejects a missing uid',
  (await codeOf(call({ uid: '', role: 'admin' }, ADMIN))) === 'invalid-argument');

check('rejects a uid with no account',
  (await codeOf(call({ uid: 'no_such_user', role: 'admin' }, ADMIN))) === 'not-found');

// ------------------------------------------------------------------ report

const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  for (const entry of failed) console.error(`  ✗ ${entry.name}`);
  process.exit(1);
}
