// The account boundary is pure, so this runs with plain `node --test` — no
// emulator, no credentials, no network. Every case below is a way two books of
// business could bleed into each other.
//
//   npm run test:accounts

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNTS, ACCOUNT_IDS, LEGACY_ACCOUNT_ID,
  PARTNER_ACCOUNT_IDS, PARTNER_OUTCOME_IDS, sanitizePartnerOutcomes,
  isKnownAccount, getAccount, requireAccountId, readAccountId,
  accountForCrmTag, accountFromCrmTags, crmTagForAccount, policyForAccount,
  bindingAllowed, callerIdAllowed, workflowAllowed,
  checkAccountAlignment, accountMismatchLabel
} from './accounts.js';

// ------------------------------------------------------------------ registry

test('the registry is frozen so no caller can add an account at runtime', () => {
  assert.throws(() => { ACCOUNTS.rogue = { id: 'rogue' }; }, TypeError);
  assert.throws(() => { ACCOUNTS.bitesites.crmTag = 'client:other'; }, TypeError);
  assert.equal(isKnownAccount('rogue'), false);
});

test('every account declares a distinct CRM tag', () => {
  const tags = ACCOUNT_IDS.map(id => ACCOUNTS[id].crmTag.toLowerCase());
  assert.equal(new Set(tags).size, tags.length, 'two accounts share a CRM tag');
  for (const tag of tags) assert.match(tag, /^client:/);
});

test('the legacy fallback names a real account', () => {
  assert.ok(isKnownAccount(LEGACY_ACCOUNT_ID));
});

test('Stone Bellisimo is a first-class account', () => {
  assert.equal(requireAccountId('stone-bellisimo'), 'stone-bellisimo');
  assert.equal(accountForCrmTag('client:stone-bellisimo'), 'stone-bellisimo');
  assert.equal(policyForAccount('stone-bellisimo').canQuotePricing, false);
  assert.equal(policyForAccount('stone-bellisimo').commissionRate, 10);
  assert.equal(ACCOUNTS['stone-bellisimo'].sales.primaryConversion, 'showroom_visit');
});

test('each seller has a distinct legal identity and sales motion', () => {
  assert.equal(ACCOUNTS.bitesites.legalName, 'BiteSites L.L.C.');
  assert.equal(ACCOUNTS.bitesites.sales.category, 'digital_services');
  assert.equal(ACCOUNTS['fine-line-group'].legalName, 'The Fine Line Group LLC');
  assert.equal(ACCOUNTS['fine-line-group'].sales.category, 'construction_restoration');
  assert.equal(ACCOUNTS['fine-line-group'].sales.primaryConversion, 'project_assessment');
  assert.equal(ACCOUNTS['stone-bellisimo'].legalName, 'Stonebellisimo LLC');
  assert.equal(ACCOUNTS['stone-bellisimo'].sales.category, 'stone_countertops');
});

test('BiteSites private address is never present in the client-importable registry', () => {
  assert.equal(ACCOUNTS.bitesites.publicIdentity.addressPublic, false);
  assert.equal(ACCOUNTS.bitesites.publicIdentity.address, '');
});

test('the confirmed public contact fields do not invent Fine Line website or address details', () => {
  assert.equal(ACCOUNTS['fine-line-group'].publicIdentity.phone, '+15517552278');
  assert.equal(ACCOUNTS['fine-line-group'].publicIdentity.website, '');
  assert.equal(ACCOUNTS['fine-line-group'].publicIdentity.address, '');
  assert.equal(ACCOUNTS['stone-bellisimo'].publicIdentity.addressPublic, true);
});

test('partner outcomes accept only known partner entities and bounded outcomes', () => {
  const rows = sanitizePartnerOutcomes([
    { accountId: 'stone-bellisimo', outcome: 'interested', notes: 'Asked for samples.' },
    { accountId: 'fine-line-group', outcome: 'introduced', notes: 'Restoration discussed.' },
    { accountId: 'bitesites', outcome: 'referral_partner' },
    { accountId: 'stone-bellisimo', outcome: 'invented' }
  ]);
  assert.deepEqual(rows, [
    { accountId: 'fine-line-group', outcome: 'introduced', notes: 'Restoration discussed.' },
    { accountId: 'stone-bellisimo', outcome: 'interested', notes: 'Asked for samples.' }
  ]);
  assert.deepEqual(PARTNER_ACCOUNT_IDS, ['fine-line-group', 'stone-bellisimo']);
  assert.ok(PARTNER_OUTCOME_IDS.includes('referral_partner'));
});

// ------------------------------------------------------------- write guards

test('requireAccountId refuses anything that is not a known account', () => {
  assert.equal(requireAccountId('fine-line-group'), 'fine-line-group');
  assert.equal(requireAccountId('  bitesites  '), 'bitesites');

  for (const bad of ['', null, undefined, 'Bitesites', 'fineline', 'fine_line_group', 0, {}]) {
    assert.throws(() => requireAccountId(bad), /required|not a known account/,
      `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('requireAccountId never falls back — a missing account is an error, not bitesites', () => {
  assert.throws(() => requireAccountId(''), /required/);
});

test('the error names the field so the operator knows which input was wrong', () => {
  assert.throws(() => requireAccountId('', { field: 'campaign.accountId' }), /campaign\.accountId is required/);
});

// -------------------------------------------------------------- read guards

test('readAccountId applies a fallback only when one is passed explicitly', () => {
  assert.equal(readAccountId('fine-line-group'), 'fine-line-group');
  assert.equal(readAccountId(''), '');
  assert.equal(readAccountId(undefined), '');
  assert.equal(readAccountId('', { fallback: LEGACY_ACCOUNT_ID }), 'bitesites');
  // An unknown fallback is not a licence to invent one.
  assert.equal(readAccountId('', { fallback: 'nonsense' }), '');
});

test('an unknown stored value never resolves, even with a fallback', () => {
  // A document carrying a deleted account id must not silently become the
  // fallback account — that is the same bug as defaulting, one layer down.
  assert.equal(readAccountId('retired-client', { fallback: 'bitesites' }), 'bitesites');
  assert.equal(readAccountId('retired-client'), '');
});

// --------------------------------------------------------------- CRM tags

test('CRM tags map to accounts and unknown tags map to nothing', () => {
  assert.equal(accountForCrmTag('client:fineline'), 'fine-line-group');
  assert.equal(accountForCrmTag('CLIENT:FINELINE'), 'fine-line-group');
  assert.equal(accountForCrmTag('client:bitesites'), 'bitesites');
  assert.equal(accountForCrmTag('customer'), '');
  assert.equal(accountForCrmTag(''), '');
  assert.equal(accountForCrmTag(null), '');
});

test('a contact with exactly one account tag resolves', () => {
  const result = accountFromCrmTags(['lead', 'client:fineline', 'restoration']);
  assert.equal(result.accountId, 'fine-line-group');
  assert.equal(result.reason, '');
});

test('a contact with no account tag is quarantined, not defaulted', () => {
  const result = accountFromCrmTags(['lead', 'newsletter']);
  assert.equal(result.accountId, '');
  assert.equal(result.reason, 'no_account_tag');
});

test('a contact carrying two account tags is an error rather than a coin flip', () => {
  // This is the exact shape of the bug the separation exists to prevent: a
  // contact that is somehow in both books must stop and be looked at.
  const result = accountFromCrmTags(['client:bitesites', 'client:fineline']);
  assert.equal(result.accountId, '');
  assert.equal(result.reason, 'ambiguous_account_tags:bitesites+fine-line-group');
});

test('duplicate copies of the same tag are not ambiguity', () => {
  const result = accountFromCrmTags(['client:fineline', 'client:fineline']);
  assert.equal(result.accountId, 'fine-line-group');
});

test('non-array tag input does not throw', () => {
  assert.equal(accountFromCrmTags(undefined).reason, 'no_account_tag');
  assert.equal(accountFromCrmTags('client:fineline').reason, 'no_account_tag');
});

test('crmTagForAccount round-trips', () => {
  for (const id of ACCOUNT_IDS) assert.equal(accountForCrmTag(crmTagForAccount(id)), id);
});

// ---------------------------------------------------------------- policy

test('Fine Line may not quote pricing — §1 of the agreement', () => {
  assert.equal(policyForAccount('fine-line-group').canQuotePricing, false);
  assert.equal(policyForAccount('fine-line-group').commissionRate, 10);
  assert.equal(policyForAccount('fine-line-group').leadProtectionDays, 365);
  assert.equal(policyForAccount('fine-line-group').rebuttalBusinessDays, 5);
});

test('no account permits residential outbound', () => {
  for (const id of ACCOUNT_IDS) {
    assert.equal(policyForAccount(id).allowResidentialOutbound, false, `${id} allows residential outbound`);
  }
});

test('policy for an unknown account is null, not an empty object that reads as permissive', () => {
  assert.equal(policyForAccount('nope'), null);
  assert.equal(getAccount('nope'), null);
});

// ------------------------------------------------------------- bindings

test('BiteSites preserves legacy caller ids while accepting the partner line', () => {
  assert.deepEqual(ACCOUNTS.bitesites.callerIds, []);
  assert.equal(callerIdAllowed('bitesites', '+12012989723'), true);
  assert.equal(callerIdAllowed('bitesites', '+12015524949'), true);
});

test('once a list is declared it is exhaustive', () => {
  // The rule itself, independent of which accounts are configured today —
  // otherwise this test would pass simply because every list is still empty.
  assert.equal(bindingAllowed([], '+12015551607'), true);
  assert.equal(bindingAllowed(undefined, '+12015551607'), true);
  assert.equal(bindingAllowed(['+12015551607'], '+12015551607'), true);
  assert.equal(bindingAllowed(['+12015551607'], '+19735550000'), false);
  assert.equal(bindingAllowed(['+12015551607'], ''), false);
  // Comparison is exact: a number stored in another format is not a match, so
  // callers must normalise to E.164 before asking.
  assert.equal(bindingAllowed(['+12015551607'], '(201) 555-1607'), false);
});

test('Fine Line and Stone Bellisimo share only the partnership line', () => {
  assert.deepEqual(ACCOUNTS['fine-line-group'].callerIds, ['+12015524949']);
  assert.deepEqual(ACCOUNTS['stone-bellisimo'].callerIds, ['+12015524949']);
  assert.equal(callerIdAllowed('fine-line-group', '+12015524949'), true);
  assert.equal(callerIdAllowed('stone-bellisimo', '+12015524949'), true);
  assert.equal(callerIdAllowed('fine-line-group', '+12019211607'), false);
});

test('an unknown account is allowed nothing', () => {
  assert.equal(callerIdAllowed('nope', '+12015551607'), false);
  assert.equal(workflowAllowed('nope', 'wf_123'), false);
});

// ------------------------------------------------------------- alignment

test('everything agreeing is aligned', () => {
  const verdict = checkAccountAlignment({
    expected: 'fine-line-group',
    campaign: 'fine-line-group',
    target: 'fine-line-group',
    profile: 'fine-line-group'
  });
  assert.equal(verdict.aligned, true);
  assert.equal(verdict.reason, '');
});

test('the load-bearing case: a BiteSites target cannot ride a Fine Line campaign', () => {
  const verdict = checkAccountAlignment({
    expected: 'fine-line-group',
    campaign: 'fine-line-group',
    target: 'bitesites'
  });
  assert.equal(verdict.aligned, false);
  assert.equal(verdict.reason, 'target_account_mismatch');
  assert.equal(verdict.expected, 'fine-line-group');
  assert.equal(verdict.found, 'bitesites');
});

test('a Fine Line campaign cannot use the BiteSites persona', () => {
  const verdict = checkAccountAlignment({
    expected: 'fine-line-group',
    campaign: 'fine-line-group',
    profile: 'bitesites'
  });
  assert.equal(verdict.aligned, false);
  assert.equal(verdict.reason, 'profile_account_mismatch');
});

test('an unresolvable expected account fails closed', () => {
  const verdict = checkAccountAlignment({ expected: '', campaign: 'bitesites' });
  assert.equal(verdict.aligned, false);
  assert.equal(verdict.reason, 'account_unresolved');
});

test('a part that names no account fails rather than being assumed to match', () => {
  const verdict = checkAccountAlignment({ expected: 'fine-line-group', target: '' });
  assert.equal(verdict.aligned, false);
  assert.equal(verdict.reason, 'target_account_unresolved');
});

test('absent parts are not checked, present ones are', () => {
  // A call site asserts only what it has actually loaded.
  const verdict = checkAccountAlignment({ expected: 'bitesites', campaign: 'bitesites' });
  assert.equal(verdict.aligned, true);
});

test('legacy documents align only when the caller opts into the fallback', () => {
  const withFallback = checkAccountAlignment({
    expected: 'bitesites', target: '', legacyFallback: LEGACY_ACCOUNT_ID
  });
  assert.equal(withFallback.aligned, true);

  const without = checkAccountAlignment({ expected: 'bitesites', target: '' });
  assert.equal(without.aligned, false);
});

test('the legacy fallback cannot smuggle a record into a client account', () => {
  // A target with no accountId is a BiteSites-era record. Granting the
  // fallback must never make it eligible for Fine Line work.
  const verdict = checkAccountAlignment({
    expected: 'fine-line-group', target: '', legacyFallback: LEGACY_ACCOUNT_ID
  });
  assert.equal(verdict.aligned, false);
  assert.equal(verdict.reason, 'target_account_mismatch');
  assert.equal(verdict.found, 'bitesites');
});

test('an unregistered caller id fails alignment', () => {
  const verdict = checkAccountAlignment({
    expected: 'nope', callerId: '+12015551607'
  });
  assert.equal(verdict.aligned, false);
  assert.equal(verdict.reason, 'account_unresolved');
});

test('an empty caller id is not checked — campaigns may inherit a number later', () => {
  const verdict = checkAccountAlignment({ expected: 'bitesites', callerId: '' });
  assert.equal(verdict.aligned, true);
});

// ---------------------------------------------------------------- labels

test('every mismatch reason has a human label', () => {
  const reasons = [
    'account_unresolved', 'campaign_account_mismatch', 'target_account_mismatch',
    'contact_account_mismatch', 'profile_account_mismatch',
    'caller_id_not_registered', 'workflow_not_registered', 'no_account_tag',
    'ambiguous_account_tags:bitesites+fine-line-group'
  ];
  for (const reason of reasons) {
    const label = accountMismatchLabel(reason);
    assert.ok(label && label !== 'Account separation check failed', `no label for ${reason}`);
  }
});
