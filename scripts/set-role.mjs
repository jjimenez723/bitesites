// Grant or revoke a portal role.
//
//   npm run role -- someone@example.com admin
//   npm run role -- someone@example.com client
//   npm run role -- someone@example.com outbound_rep
//   npm run role -- someone@example.com outbound_manager
//   npm run role -- someone@example.com outbound_rep bitesites
//   npm run role -- someone@example.com none      (revoke)
//
// Roles live in roles/{uid}, which no client can write — that is what makes
// self-promotion impossible, so this has to run with admin credentials. It uses
// your gcloud Application Default Credentials, so there is no service-account
// key to create or leak. If it complains about credentials, run:
//
//   gcloud auth application-default login
//
// The role is written in two places on purpose. The roles/{uid} document is
// authoritative; claims are a compatible bootstrap/cache for services outside
// Firestore. Approving a client also flips users/{uid} out of "pending".

const PROJECT_ID = 'bitesites-org';

// ADC carries whatever quota project gcloud was last pointed at, which is often
// some other project and makes every call 403. Pin it before the auth library
// loads — hence the dynamic imports below, which ESM would otherwise hoist.
process.env.GOOGLE_CLOUD_QUOTA_PROJECT ||= PROJECT_ID;

const { initializeApp, applicationDefault } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
const { normalizeAccountScope } = await import('../functions/account-access.js');

const VALID = ['admin', 'client', 'outbound_rep', 'outbound_manager', 'none'];
const [email, role, accountScope = ''] = process.argv.slice(2);

if (!email || !role || !VALID.includes(role)) {
  console.error('Usage: npm run role -- <email> <admin|client|outbound_rep|outbound_manager|none> [comma-separated-account-ids]');
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });

const auth = getAuth();
const db = getFirestore();

const fail = message => {
  console.error(message);
  process.exit(1);
};

let user;
try {
  user = await auth.getUserByEmail(email);
} catch (error) {
  if (error.code === 'auth/user-not-found') {
    fail(`No account for ${email}. Have them sign up first, then re-run this.`);
  }
  fail(`Could not look up ${email}: ${error.message}`);
}

const { uid } = user;

try {
  if (role === 'none') {
    const claims = { ...(user.customClaims || {}) };
    delete claims.role;
    delete claims.accountIds;
    await db.doc(`roles/${uid}`).set({
      role: 'revoked', accountIds: [], email,
      revokedAt: FieldValue.serverTimestamp(), revokedBy: 'role-cli'
    });
    await auth.setCustomUserClaims(uid, Object.keys(claims).length ? claims : null);
    await auth.revokeRefreshTokens(uid);
    await db.doc(`users/${uid}`).set({ status: 'pending' }, { merge: true });
    console.log(`Revoked all roles from ${email} (${uid}).`);
  } else {
    const accountIds = normalizeAccountScope(accountScope.split(',').map(value => value.trim()).filter(Boolean));
    if (['outbound_rep', 'outbound_manager'].includes(role) && !accountIds.length) {
      fail('Outbound roles require at least one valid seller account id.');
    }
    await db.doc(`roles/${uid}`).set({
      role,
      accountIds: ['outbound_rep', 'outbound_manager'].includes(role) ? accountIds : [],
      email,
      grantedAt: FieldValue.serverTimestamp(), grantedBy: 'role-cli'
    });
    const claims = { ...(user.customClaims || {}), role };
    delete claims.accountIds;
    if (['outbound_rep', 'outbound_manager'].includes(role)) claims.accountIds = accountIds;
    await auth.setCustomUserClaims(uid, claims);
    await auth.revokeRefreshTokens(uid);
    // A role is only useful to a client whose profile is out of "pending".
    await db.doc(`users/${uid}`).set({ status: 'approved' }, { merge: true });
    console.log(`Granted "${role}" to ${email} (${uid}).`);
  }
} catch (error) {
  fail(`Failed to update role: ${error.message}`);
}

console.log('They must sign out and back in for refreshed UI claims; the stored role boundary is already active.');
