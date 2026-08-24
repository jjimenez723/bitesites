import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAccountAccess,
  assertOutboundAccess,
  hasAccountAccess,
  normalizeAccountScope,
  resolveAccountAccess
} from './account-access.js';

const dbWithRole = data => ({
  doc: () => ({ get: async () => ({ exists: Boolean(data), data: () => data || {} }) })
});

test('account scopes contain only known, unique seller ids', () => {
  assert.deepEqual(
    normalizeAccountScope(['stone-bellisimo', 'bitesites', 'stone-bellisimo', 'unknown']),
    ['bitesites', 'stone-bellisimo']
  );
});

test('an admin has every account regardless of an omitted scope', async () => {
  const access = await resolveAccountAccess(dbWithRole({ role: 'admin' }), { uid: 'owner', token: {} });
  assert.equal(access.allAccounts, true);
  assert.equal(hasAccountAccess(access, 'fine-line-group'), true);
  assert.doesNotThrow(() => assertOutboundAccess(access, { manage: true }));
});

test('a role document is authoritative over a conflicting account claim', async () => {
  const access = await resolveAccountAccess(
    dbWithRole({ role: 'outbound_rep', accountIds: ['bitesites'] }),
    { uid: 'rep', token: { role: 'outbound_rep', accountIds: ['stone-bellisimo'] } }
  );
  assert.deepEqual(access.accountIds, ['bitesites']);
  assert.equal(hasAccountAccess(access, 'stone-bellisimo'), false);
  assert.equal(hasAccountAccess(access, 'bitesites'), true);
  assert.throws(() => assertAccountAccess(access, 'fine-line-group'), /not assigned/);
});

test('a stored revoke or scope reduction overrides stale elevated custom claims', async () => {
  const access = await resolveAccountAccess(
    dbWithRole({ role: 'outbound_rep', accountIds: ['bitesites'] }),
    { uid: 'rep', token: { role: 'admin', accountIds: ['stone-bellisimo'] } }
  );
  assert.equal(access.role, 'outbound_rep');
  assert.equal(access.allAccounts, false);
  assert.deepEqual(access.accountIds, ['bitesites']);
  assert.equal(hasAccountAccess(access, 'stone-bellisimo'), false);
  assert.throws(() => assertOutboundAccess(access, { manage: true }), /Only an admin or outbound manager/);
});

test('a legacy unscoped outbound role fails closed', async () => {
  const access = await resolveAccountAccess(
    dbWithRole({ role: 'outbound_manager' }),
    { uid: 'manager', token: { role: 'outbound_manager' } }
  );
  assert.throws(() => assertOutboundAccess(access), /No seller accounts/);
});

test('a manager can manage only an assigned seller', async () => {
  const access = await resolveAccountAccess(
    dbWithRole({ role: 'outbound_manager', accountIds: ['fine-line-group'] }),
    { uid: 'manager', token: {} }
  );
  assert.doesNotThrow(() => assertOutboundAccess(access, { manage: true }));
  assert.equal(assertAccountAccess(access, 'fine-line-group'), 'fine-line-group');
  assert.throws(() => assertAccountAccess(access, 'stone-bellisimo'), /not assigned/);
});
