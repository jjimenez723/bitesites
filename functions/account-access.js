// Account-scoped authorization for multi-seller outbound operations.
//
// A role answers what a user may do; `accountIds` answers whose data they may
// touch. Keeping those decisions separate prevents a representative assigned
// to one seller from gaining visibility into every seller that shares the same
// Firebase project and CRM.

import { ACCOUNT_IDS, requireAccountId } from './accounts.js';
import { clean } from './prospect-normalization.js';

export const OUTBOUND_ROLES = Object.freeze(['admin', 'outbound_rep', 'outbound_manager']);

export function normalizeAccountScope(value) {
  const input = Array.isArray(value) ? value : [];
  return [...new Set(input.map(entry => clean(entry, 120)).filter(entry => ACCOUNT_IDS.includes(entry)))]
    .sort()
    .slice(0, ACCOUNT_IDS.length);
}

/** Resolve the signed-in user's role and seller scope from claims + role doc. */
export async function resolveAccountAccess(db, auth) {
  if (!auth?.uid) return { uid: '', role: '', accountIds: [], allAccounts: false };
  const roleSnapshot = await db.doc(`roles/${auth.uid}`).get();
  const stored = roleSnapshot.exists ? roleSnapshot.data() || {} : {};
  // The roles document is written in the same Admin SDK operation as a role
  // change.  It must win over a cached custom claim, otherwise a just-revoked
  // manager can retain their old seller scope until Firebase refreshes tokens.
  const role = roleSnapshot.exists ? clean(stored.role, 80) : clean(auth?.token?.role, 80);
  const claimScope = normalizeAccountScope(auth?.token?.accountIds);
  const storedScope = normalizeAccountScope(stored.accountIds);
  const accountIds = role === 'admin'
    ? [...ACCOUNT_IDS]
    : (roleSnapshot.exists ? storedScope : claimScope);
  return {
    uid: auth.uid,
    role,
    accountIds,
    allAccounts: role === 'admin'
  };
}

export function hasAccountAccess(access, accountId) {
  let account;
  try { account = requireAccountId(accountId, { field: 'accountId' }); }
  catch { return false; }
  return access?.allAccounts === true || normalizeAccountScope(access?.accountIds).includes(account);
}

export function assertOutboundAccess(access, { manage = false } = {}) {
  const allowedRoles = manage ? ['admin', 'outbound_manager'] : OUTBOUND_ROLES;
  if (!allowedRoles.includes(access?.role)) {
    throw new Error(manage
      ? 'Only an admin or outbound manager can manage outbound calling.'
      : 'This account cannot use outbound calling.');
  }
  if (access.role !== 'admin' && normalizeAccountScope(access.accountIds).length === 0) {
    throw new Error('No seller accounts are assigned to this outbound role.');
  }
  return access;
}

export function assertAccountAccess(access, accountId) {
  const account = requireAccountId(accountId, { field: 'accountId' });
  if (!hasAccountAccess(access, account)) {
    throw new Error(`This user is not assigned to the ${account} seller account.`);
  }
  return account;
}

/**
 * Account ids on operational rows are an authorization boundary, not a
 * cosmetic label.  Admins retain break-glass access to legacy rows; delegated
 * roles fail closed instead of treating an omitted id as BiteSites.
 */
export function assertDocumentAccountAccess(access, document, { resource = 'resource' } = {}) {
  if (access?.allAccounts === true) {
    const raw = clean(document?.accountId, 120);
    return ACCOUNT_IDS.includes(raw) ? raw : '';
  }
  const accountId = clean(document?.accountId, 120);
  if (!ACCOUNT_IDS.includes(accountId)) {
    throw new Error(`This ${resource} has no seller account and is restricted to an admin.`);
  }
  return assertAccountAccess(access, accountId);
}

/** Read a resource, then enforce the document's seller boundary. */
export async function requireDocumentAccountAccess(db, access, path, { resource = 'resource' } = {}) {
  const snapshot = await db.doc(path).get();
  if (!snapshot.exists) throw new Error(`${resource[0].toUpperCase()}${resource.slice(1)} not found.`);
  const data = { id: snapshot.id, ...snapshot.data() };
  assertDocumentAccountAccess(access, data, { resource });
  return data;
}
