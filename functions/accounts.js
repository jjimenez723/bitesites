// Which book of business a record belongs to, and what may touch it.
//
// BiteSites and its commission clients share one GoHighLevel sub-account, so
// GHL itself draws no boundary between them. `accountId` is that boundary, and
// this module is its only definition — pure and synchronous, like
// `outbound-compliance.js`, so the campaign builder, the importer, the dialer
// and the CRM ingest all reach the same verdict from the same inputs.
//
// The rule that shapes everything here: an account mismatch is never resolved
// by picking a side. A prospect whose account cannot be established does not
// get dialled by whichever persona happens to be attached to the campaign — it
// stops. Silent defaulting is how a web-design lead ends up being asked about
// water damage, and there is no way to un-send that call.
//
// Two properties are deliberate:
//
//   * Identity lives in code, not Firestore. An account id, its CRM tag and
//     its policy cannot be mistyped into existence by an operator, and every
//     comparison in the system resolves against this one table.
//
//   * Bindings fail closed only once declared. An account that lists no caller
//     ids has no opinion about caller ids, so existing BiteSites campaigns keep
//     running unchanged; an account that lists one rejects everything else.
//     New accounts are therefore locked from their first day without a
//     migration, which is the only version of this that actually gets adopted.

/**
 * Every account the platform runs work for.
 *
 * `policy` is the contract, made machine-readable. It is not documentation:
 * `canQuotePricing` is read by the agent compiler, and `leadProtectionDays`
 * and `rebuttalBusinessDays` are read by the attribution ledger. When an
 * agreement changes, this is the line that changes.
 */
export const ACCOUNTS = Object.freeze({
  bitesites: Object.freeze({
    id: 'bitesites',
    label: 'BiteSites',
    // The house account. Its own prospecting, its own site leads, its own
    // voice agent.
    crmTag: 'client:bitesites',
    // Empty preserves legacy BiteSites campaigns. The new partnership line is
    // available, but BiteSites does not yet declare an exhaustive allow-list.
    callerIds: Object.freeze([]),
    workflowIds: Object.freeze([]),
    policy: Object.freeze({
      canQuotePricing: true,
      allowResidentialOutbound: false,
      commissionRate: 0,
      leadProtectionDays: 0,
      rebuttalBusinessDays: 0
    })
  }),

  'fine-line-group': Object.freeze({
    id: 'fine-line-group',
    label: 'The Fine Line Group',
    crmTag: 'client:fineline',
    // Partnership-acquisition line provisioned in the shared Twilio account.
    callerIds: Object.freeze(['+12015524949']),
    workflowIds: Object.freeze([]),
    policy: Object.freeze({
      // §1 of the services agreement: no authority to quote construction
      // prices without prior written authorisation. The agent qualifies and
      // books; pricing escalates to the client.
      canQuotePricing: false,
      // Residential outbound is off by decision, not by contract. Facebook and
      // Nextdoor solicitations convert to inbound before anything dials them.
      allowResidentialOutbound: false,
      // §4 — 10% of revenue actually collected.
      commissionRate: 10,
      // §7 — a lead stays protected 12 months from introduction.
      leadProtectionDays: 365,
      // §3 — the client has 5 business days to rebut an agency-sourced lead.
      rebuttalBusinessDays: 5
    })
  }),

  'stone-bellisimo': Object.freeze({
    id: 'stone-bellisimo',
    label: 'Stone Bellisimo',
    crmTag: 'client:stone-bellisimo',
    callerIds: Object.freeze(['+12015524949']),
    workflowIds: Object.freeze([]),
    policy: Object.freeze({
      // No Stone Bellisimo pricing or residential cold outreach is approved
      // through this console. Representatives introduce and qualify only.
      canQuotePricing: false,
      allowResidentialOutbound: false,
      commissionRate: 0,
      leadProtectionDays: 0,
      rebuttalBusinessDays: 0
    })
  })
});

/**
 * The account a record belongs to when it predates `accountId`.
 *
 * Only ever applied on READ, and only by callers that pass it explicitly. Every
 * write path demands a real account id.
 */
export const LEGACY_ACCOUNT_ID = 'bitesites';

export const ACCOUNT_IDS = Object.freeze(Object.keys(ACCOUNTS));

/** Entities a representative may introduce as referral/service partners. */
export const PARTNER_ACCOUNT_IDS = Object.freeze([
  'fine-line-group',
  'stone-bellisimo'
]);

export const PARTNER_OUTCOME_IDS = Object.freeze([
  'not_mentioned',
  'introduced',
  'interested',
  'meeting_requested',
  'referral_partner',
  'not_interested'
]);

const asString = value => (typeof value === 'string' ? value.trim() : '');

/** Does this id name an account we know about? */
export function isKnownAccount(value) {
  return Object.prototype.hasOwnProperty.call(ACCOUNTS, asString(value));
}

/** The account record, or null. Never throws — for readers and reporting. */
export function getAccount(value) {
  return isKnownAccount(value) ? ACCOUNTS[asString(value)] : null;
}

/**
 * The account id for a write, or an exception.
 *
 * There is no fallback on purpose. A campaign, target or lead that cannot say
 * which book it belongs to must not be created — a record with the wrong
 * account is worse than a record that failed to save, because the second one
 * announces itself.
 */
export function requireAccountId(value, { field = 'accountId' } = {}) {
  const id = asString(value);
  if (!id) throw new Error(`${field} is required — every record belongs to exactly one account`);
  if (!isKnownAccount(id)) {
    throw new Error(`${field} "${id}" is not a known account (${ACCOUNT_IDS.join(', ')})`);
  }
  return id;
}

/**
 * The account id for a read, falling back for documents written before this
 * module existed. The fallback is a parameter rather than a default so that
 * every place granting legacy tolerance is greppable.
 */
export function readAccountId(value, { fallback = '' } = {}) {
  const id = asString(value);
  if (isKnownAccount(id)) return id;
  return isKnownAccount(fallback) ? asString(fallback) : '';
}

/** `client:fineline` → `fine-line-group`. Unknown tags return '' — never a guess. */
export function accountForCrmTag(tag) {
  const wanted = asString(tag).toLowerCase();
  if (!wanted) return '';
  for (const account of Object.values(ACCOUNTS)) {
    if (account.crmTag.toLowerCase() === wanted) return account.id;
  }
  return '';
}

/**
 * Resolve an account from a CRM contact's tags.
 *
 * Ambiguity is a failure, not a tie to be broken. A contact carrying both
 * `client:bitesites` and `client:fineline` is a data error somebody has to look
 * at, and picking the first one hides it forever.
 */
export function accountFromCrmTags(tags = []) {
  const matches = new Set();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const id = accountForCrmTag(tag);
    if (id) matches.add(id);
  }
  if (matches.size === 1) return { accountId: [...matches][0], reason: '' };
  if (matches.size === 0) return { accountId: '', reason: 'no_account_tag' };
  return { accountId: '', reason: `ambiguous_account_tags:${[...matches].sort().join('+')}` };
}

export function crmTagForAccount(value) {
  return getAccount(value)?.crmTag || '';
}

export function policyForAccount(value) {
  return getAccount(value)?.policy || null;
}

/**
 * Bound and validate the per-partner result captured during call wrap-up.
 * One row per known partner prevents a crafted client payload from writing
 * arbitrary entities or unbounded notes into call/contact documents.
 */
export function sanitizePartnerOutcomes(input = []) {
  const rows = Array.isArray(input) ? input : [];
  const byAccount = new Map();
  for (const row of rows.slice(0, PARTNER_ACCOUNT_IDS.length * 2)) {
    const accountId = asString(row?.accountId);
    const outcome = asString(row?.outcome);
    if (!PARTNER_ACCOUNT_IDS.includes(accountId) || !PARTNER_OUTCOME_IDS.includes(outcome)) continue;
    byAccount.set(accountId, Object.freeze({
      accountId,
      outcome,
      notes: asString(row?.notes).slice(0, 500)
    }));
  }
  return PARTNER_ACCOUNT_IDS.filter(id => byAccount.has(id)).map(id => byAccount.get(id));
}

/**
 * The fail-closed-once-declared rule, in one place.
 *
 * An empty list means the account has not been configured yet and holds no
 * opinion; a non-empty one is exhaustive. Exported so the rule can be tested
 * directly rather than through whichever accounts happen to be configured
 * today — a test that passes only because every list is currently empty is not
 * testing anything.
 */
export function bindingAllowed(declared, value) {
  if (!Array.isArray(declared) || !declared.length) return true;
  return declared.includes(asString(value));
}

/**
 * Is `callerId` allowed to place calls for `accountId`?
 *
 * Numbers are compared as given; callers normalise to E.164 first.
 */
export function callerIdAllowed(accountId, callerId) {
  const account = getAccount(accountId);
  if (!account) return false;
  return bindingAllowed(account.callerIds, callerId);
}

/** Is `workflowId` one of this account's GoHighLevel workflows? */
export function workflowAllowed(accountId, workflowId) {
  const account = getAccount(accountId);
  if (!account) return false;
  return bindingAllowed(account.workflowIds, workflowId);
}

/**
 * The central guard: does everything about to take part in a call agree on
 * which account it serves?
 *
 * Returns a verdict rather than throwing, because callers want different
 * things from a mismatch — the campaign builder refuses the write, the dialer
 * parks the target and carries on with the rest of the queue. Both must reach
 * the same conclusion, which is why they share this function.
 *
 * Every argument is optional. An absent one is not checked; a present one that
 * disagrees fails. That lets each call site assert exactly what it has loaded
 * without inventing values it does not know.
 */
export function checkAccountAlignment({
  expected,
  campaign = undefined,
  target = undefined,
  contact = undefined,
  profile = undefined,
  callerId = undefined,
  workflowId = undefined,
  legacyFallback = ''
} = {}) {
  const want = readAccountId(expected, { fallback: legacyFallback });
  if (!want) {
    return { aligned: false, reason: 'account_unresolved', expected: '', found: '' };
  }

  const parts = [
    ['campaign', campaign],
    ['target', target],
    ['contact', contact],
    ['profile', profile]
  ];

  for (const [name, value] of parts) {
    if (value === undefined || value === null) continue;
    const found = readAccountId(value, { fallback: legacyFallback });
    if (!found) {
      return { aligned: false, reason: `${name}_account_unresolved`, expected: want, found: asString(value) };
    }
    if (found !== want) {
      return { aligned: false, reason: `${name}_account_mismatch`, expected: want, found };
    }
  }

  if (callerId !== undefined && callerId !== null && asString(callerId) && !callerIdAllowed(want, callerId)) {
    return { aligned: false, reason: 'caller_id_not_registered', expected: want, found: asString(callerId) };
  }

  if (workflowId !== undefined && workflowId !== null && asString(workflowId) && !workflowAllowed(want, workflowId)) {
    return { aligned: false, reason: 'workflow_not_registered', expected: want, found: asString(workflowId) };
  }

  return { aligned: true, reason: '', expected: want, found: want };
}

/** Human-readable reasons, for the console and for alert bodies. */
export const ACCOUNT_MISMATCH_LABELS = Object.freeze({
  account_unresolved: 'No account could be established for this record',
  campaign_account_unresolved: 'The campaign does not name a known account',
  campaign_account_mismatch: 'The campaign belongs to a different account',
  target_account_unresolved: 'The target does not name a known account',
  target_account_mismatch: 'The target belongs to a different account',
  contact_account_unresolved: 'The contact does not name a known account',
  contact_account_mismatch: 'The contact belongs to a different account',
  profile_account_unresolved: 'The agent profile does not name a known account',
  profile_account_mismatch: 'The agent profile belongs to a different account',
  caller_id_not_registered: 'That caller ID is not registered to this account',
  workflow_not_registered: 'That workflow is not registered to this account',
  no_account_tag: 'The CRM contact carries no account tag',
});

export function accountMismatchLabel(reason) {
  if (ACCOUNT_MISMATCH_LABELS[reason]) return ACCOUNT_MISMATCH_LABELS[reason];
  if (String(reason || '').startsWith('ambiguous_account_tags:')) {
    return 'The CRM contact carries more than one account tag';
  }
  return 'Account separation check failed';
}
