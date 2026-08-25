// How many of these people could we actually, lawfully call — and why not?
//
// The dialer already answers that question, one target at a time, at the
// moment it is about to dial. What nobody could answer was the aggregate: an
// operator looking at nine thousand imported Watcher rows had no way to learn
// that zero of them are callable, or which of eleven different reasons applies
// to which record. The honest answer to "when can we launch?" starts here.
//
// ---------------------------------------------------------------------------
// The rule this module lives under
// ---------------------------------------------------------------------------
//
// **It reuses the dialer's gates; it does not restate them.** `evaluateCompliance`,
// `resolveAIVoiceConsent` and `resolvePreDialScreening` are imported and called,
// not re-implemented. A second, kinder definition of "eligible" is the failure
// mode this whole module could produce: a report that says 4,000 numbers are
// ready, an operator who believes it, and a dial path that refuses every one of
// them — or worse, a report that is kinder than the dial path in a way nobody
// notices until a call goes out.
//
// The audit may only ever be *stricter*. It adds gates the pure compliance
// function cannot see (account alignment, research approval, the campaign's own
// provider/deployment/safety-lock state) and it never removes one.
// `outbound-eligibility-audit.test.mjs` asserts that directly.
//
// **It writes nothing outward.** No dial, no provider request, no workflow
// enrolment, no consent grant, no screening clearance, no target import. It
// reads Firestore, optionally reads GoHighLevel through the read-only contact
// source, and returns a report. The only write it can perform is an audit
// summary document, server-written and account-scoped, and only when the caller
// asks for one.
//
// **"Eligible" is a technical verdict.** It means the gates configured today
// passed. It is not legal advice, not counsel sign-off, and not authorisation
// to launch a campaign. `ELIGIBILITY_DISCLAIMER` travels with every report and
// every export so that sentence cannot be lost between the server and a
// screenshot in a meeting.

import { Timestamp } from 'firebase-admin/firestore';

import {
  evaluateCompliance, resolveAIVoiceConsent, nextWindowOpening, localClock,
  COMPLIANCE_REASON_LABELS
} from './outbound-compliance.js';
import { requiresExternalPreDialScreening, resolvePreDialScreening } from './pre-dial-screening.js';
import { loadSuppressedNumbers } from './inbound-compliance.js';
import { loadContactForTarget } from './outbound-contacts.js';
import { contactKey, loadResearch, RESEARCH_EVIDENCE_POLICY_VERSION } from './lead-enrichment.js';
import { campaignSafetyLockEngaged, campaignSafetyLockReason } from './campaign-circuit-breaker.js';
import { assertSupports } from './providers/calling/index.js';
import { externalDialingAdmission } from './deployment-environment.js';
import {
  checkAccountAlignment, ACCOUNT_MISMATCH_LABELS, accountMismatchLabel, requireAccountId
} from './accounts.js';
import { clean, normalizePhone, resolveTimezone } from './prospect-normalization.js';
import { readGoHighLevelContacts } from './providers/lead-sources/gohighlevel-contacts.js';

export const ELIGIBILITY_AUDIT_POLICY_VERSION = 'outbound-eligibility-audit/2026-08-25';

export const ELIGIBILITY_DISCLAIMER =
  '“Eligible” here means every technical gate configured in this system passed for '
  + 'this record right now. It is not legal advice, not counsel approval, and not '
  + 'authorisation to run a campaign. External approvals — consent wording, DNC '
  + 'subscriptions, caller identity, budgets — are tracked in '
  + 'OUTBOUND_LAUNCH_AUTHORIZATION.md and none of them are checked here.';

export const DEFAULT_SCAN_LIMIT = 500;
export const MAX_SCAN_LIMIT = 2000;
export const MAX_REPORTED_ROWS = 1000;

export const AUDIT_SCOPES = Object.freeze(['campaign_targets', 'account_prospects', 'account_leads']);

/**
 * The five outcomes, worst first. Order is precedence: a record blocked for
 * more than one reason is reported under the most severe one, so a suppressed
 * number is never filed under "outside calling hours" and quietly re-tried.
 */
export const AUDIT_CLASSES = Object.freeze([
  'permanently_suppressed',
  'configuration_blocked',
  'evidence_missing',
  'temporarily_blocked',
  'eligible_now'
]);

export const AUDIT_CLASS_LABELS = Object.freeze({
  eligible_now: 'Eligible now',
  temporarily_blocked: 'Blocked for now',
  evidence_missing: 'Missing evidence',
  permanently_suppressed: 'Must not be called',
  configuration_blocked: 'Blocked by configuration'
});

/**
 * Reason code → outcome class.
 *
 * `max_attempts_reached` sits under `permanently_suppressed` because it is
 * terminal for this campaign and the dialer treats it that way. The class is a
 * coarse bucket; the reason code and its label carry the precision, and the UI
 * shows both.
 */
const REASON_CLASSES = Object.freeze({
  // Somebody asked us to stop, or the number cannot be called at all.
  do_not_call: 'permanently_suppressed',
  do_not_contact: 'permanently_suppressed',
  suppressed: 'permanently_suppressed',
  crm_do_not_disturb: 'permanently_suppressed',
  invalid_number: 'permanently_suppressed',
  number_reassigned: 'permanently_suppressed',
  max_attempts_reached: 'permanently_suppressed',

  // Something an administrator configured, or failed to.
  invalid_caller_id: 'configuration_blocked',
  caller_id_not_registered: 'configuration_blocked',
  invalid_calling_window: 'configuration_blocked',
  campaign_safety_lock: 'configuration_blocked',
  provider_cannot_place_ai_calls: 'configuration_blocked',
  external_dialing_disabled: 'configuration_blocked',
  account_unresolved: 'configuration_blocked',
  campaign_account_mismatch: 'configuration_blocked',
  campaign_account_unresolved: 'configuration_blocked',
  target_account_mismatch: 'configuration_blocked',
  target_account_unresolved: 'configuration_blocked',
  contact_account_mismatch: 'configuration_blocked',
  contact_account_unresolved: 'configuration_blocked',
  crm_account_mismatch: 'configuration_blocked',
  no_account_tag: 'configuration_blocked',

  // We do not hold what the gate requires.
  no_valid_phone: 'evidence_missing',
  unknown_timezone: 'evidence_missing',
  ai_consent_not_documented: 'evidence_missing',
  ai_consent_seller_mismatch: 'evidence_missing',
  ai_consent_phone_mismatch: 'evidence_missing',
  ai_consent_revoked: 'evidence_missing',
  ai_consent_expired: 'evidence_missing',
  ai_consent_unverified: 'evidence_missing',
  external_screening_missing: 'evidence_missing',
  external_screening_policy_mismatch: 'evidence_missing',
  external_screening_seller_mismatch: 'evidence_missing',
  external_screening_phone_mismatch: 'evidence_missing',
  external_screening_not_cleared: 'evidence_missing',
  external_screening_stale: 'evidence_missing',
  national_dnc_not_cleared: 'evidence_missing',
  entity_dnc_not_cleared: 'evidence_missing',
  reassigned_number_not_cleared: 'evidence_missing',
  reassigned_number_consent_date_mismatch: 'evidence_missing',
  phone_validation_not_cleared: 'evidence_missing',
  line_type_not_callable: 'evidence_missing',
  research_not_approved: 'evidence_missing',
  research_stale_policy: 'evidence_missing',

  // True right now, false later today.
  outside_calling_hours: 'temporarily_blocked',
  outside_allowed_days: 'temporarily_blocked',
  retry_delay_not_elapsed: 'temporarily_blocked',
  research_missing: 'temporarily_blocked'
});

/** Labels the audit owns; everything else comes from the compliance module. */
const AUDIT_REASON_LABELS = Object.freeze({
  crm_do_not_disturb: 'The CRM contact is marked do-not-disturb',
  crm_account_mismatch: 'The CRM contact is tagged for a different seller',
  campaign_safety_lock: 'The campaign is halted by the safety circuit breaker',
  provider_cannot_place_ai_calls: 'The campaign provider cannot place controlled AI calls',
  external_dialing_disabled: 'External dialing is disabled in this deployment',
  research_missing: 'No research brief exists for this contact yet',
  research_not_approved: 'The research brief has not been approved',
  research_stale_policy: 'The research brief predates the current evidence policy',
  ai_consent_revoked: 'The written AI consent for this number was revoked',
  ai_consent_expired: 'The written AI consent for this number has expired',
  ai_consent_unverified: 'No matching grant exists in the consent ledger'
});

export const ELIGIBILITY_REASON_LABELS = Object.freeze({
  ...COMPLIANCE_REASON_LABELS,
  ...ACCOUNT_MISMATCH_LABELS,
  ...AUDIT_REASON_LABELS
});

/**
 * The report buckets an operator actually asks about, and which reasons feed
 * each. A reason may appear in more than one bucket only if that is genuinely
 * what an operator means by the question; here every reason has one home.
 */
export const AUDIT_BUCKETS = Object.freeze([
  ['eligible_now', 'Eligible now', []],
  ['invalid_or_missing_phone', 'Invalid or missing phone', ['no_valid_phone', 'invalid_number']],
  ['dnc_or_suppressed', 'CRM DND, internal DNC, or suppressed',
    ['do_not_call', 'do_not_contact', 'suppressed', 'crm_do_not_disturb']],
  ['account_mismatch', 'Account mismatch',
    ['account_unresolved', 'campaign_account_mismatch', 'campaign_account_unresolved',
      'target_account_mismatch', 'target_account_unresolved', 'contact_account_mismatch',
      'contact_account_unresolved', 'crm_account_mismatch', 'no_account_tag']],
  ['ai_consent', 'Written AI consent missing, stale, revoked, or mismatched',
    ['ai_consent_not_documented', 'ai_consent_seller_mismatch', 'ai_consent_phone_mismatch',
      'ai_consent_revoked', 'ai_consent_expired', 'ai_consent_unverified']],
  ['national_dnc', 'National DNC evidence missing, matched, or stale', ['national_dnc_not_cleared']],
  ['entity_dnc', 'Seller DNC evidence missing, matched, or stale', ['entity_dnc_not_cleared']],
  ['reassigned_number', 'Reassigned-number check failed',
    ['number_reassigned', 'reassigned_number_not_cleared', 'reassigned_number_consent_date_mismatch']],
  ['phone_validation_or_line_type', 'Phone validation or line type failed',
    ['phone_validation_not_cleared', 'line_type_not_callable']],
  ['screening_record', 'Pre-dial screening record missing, stale, or mismatched',
    ['external_screening_missing', 'external_screening_policy_mismatch',
      'external_screening_seller_mismatch', 'external_screening_phone_mismatch',
      'external_screening_not_cleared', 'external_screening_stale']],
  ['timezone_or_hours', 'Unknown timezone or outside calling hours',
    ['unknown_timezone', 'outside_calling_hours', 'outside_allowed_days', 'invalid_calling_window']],
  ['research_or_call_plan', 'Research or call plan pending',
    ['research_missing', 'research_not_approved', 'research_stale_policy']],
  ['attempts_or_retry', 'Max attempts reached or retry delay not elapsed',
    ['max_attempts_reached', 'retry_delay_not_elapsed']],
  ['campaign_provider_or_deployment', 'Campaign incident, provider, or deployment block',
    ['campaign_safety_lock', 'provider_cannot_place_ai_calls', 'external_dialing_disabled',
      'invalid_caller_id', 'caller_id_not_registered']]
]);

const BUCKET_FOR_REASON = new Map(
  AUDIT_BUCKETS.flatMap(([id, , reasons]) => reasons.map(reason => [reason, id]))
);

export const reasonLabel = reason =>
  ELIGIBILITY_REASON_LABELS[reason]
  || accountMismatchLabel(reason)
  || String(reason || '').replaceAll('_', ' ');

/** Unmapped reasons get their own class rather than being silently dropped. */
export const classifyReason = reason => REASON_CLASSES[reason] || 'configuration_blocked';

export function classifyReasons(reasons = []) {
  if (!reasons.length) return 'eligible_now';
  const classes = new Set(reasons.map(classifyReason));
  return AUDIT_CLASSES.find(entry => classes.has(entry)) || 'configuration_blocked';
}

export const bucketsForReasons = (reasons = []) =>
  [...new Set(reasons.map(reason => BUCKET_FOR_REASON.get(reason)).filter(Boolean))];

/**
 * Country code, area code, last two digits. Everything else is dots.
 *
 * The area code stays because the timezone verdict is derived from it, and an
 * operator who cannot see it cannot sanity-check "unknown timezone" against
 * "this is obviously a New Jersey number". Investigating a specific record is
 * done through the stable record id, which the report carries in full.
 */
export function maskPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return '';
  const nanp = /^\+1(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  if (nanp) return `+1 (${nanp[1]}) •••-••${nanp[4]}`;
  const digits = phone.slice(1);
  if (digits.length <= 4) return `+${'•'.repeat(digits.length)}`;
  return `+${digits.slice(0, 2)}${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-2)}`;
}

const asDate = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    try { return asDate(value.toDate()); } catch { return null; }
  }
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
};

const localTimeIn = (timezone, now) => {
  if (!timezone) return '';
  try {
    const clock = localClock(now, timezone);
    return `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
  } catch { return ''; }
};

// ---------------------------------------------------------------------------
// Campaign-level readiness
// ---------------------------------------------------------------------------

/**
 * The blockers that apply to every record in the campaign at once.
 *
 * Reported separately *and* folded into each row. Separately, because "no
 * record is eligible because external dialing is off" is one fact about the
 * deployment and not four thousand facts about people. Folded in, because a row
 * that says `eligible_now` while the deployment refuses to dial would be a lie
 * of exactly the kind this module exists to prevent.
 */
export function evaluateCampaignReadiness(campaign = {}, { deploymentValues = null } = {}) {
  const reasons = [];
  const automatedVoice = campaign.mode === 'ai';
  const provider = clean(campaign.provider, 40) || 'mock';

  if (campaignSafetyLockEngaged(campaign)) reasons.push('campaign_safety_lock');

  const support = automatedVoice ? assertSupports(provider, 'ai', 1) : { ok: true, missing: [] };
  if (!support.ok) reasons.push('provider_cannot_place_ai_calls');

  const admission = externalDialingAdmission(provider, deploymentValues);
  if (!admission.allowed) reasons.push('external_dialing_disabled');

  // `checkAccountAlignment` compares account ids, not documents — passing a
  // campaign object resolves to no account and reports every campaign as
  // unresolved.
  const alignment = checkAccountAlignment({
    expected: campaign.accountId,
    callerId: campaign.callerId
  });
  if (!alignment.aligned) reasons.push(alignment.reason);

  return {
    ready: reasons.length === 0,
    reasons,
    provider,
    automatedVoice,
    safetyLockReason: campaignSafetyLockReason(campaign),
    providerMissingCapabilities: support.missing || [],
    deployment: {
      allowed: admission.allowed,
      environment: admission.environment,
      reason: admission.reason
    }
  };
}

// ---------------------------------------------------------------------------
// One record
// ---------------------------------------------------------------------------

/**
 * Distinguish *why* the AI-consent gate refused, for reporting only.
 *
 * `evaluateAIVoiceConsent` collapses missing, revoked and expired into one
 * verdict, which is correct for admission — all three mean "do not call" — and
 * useless for an operator deciding what to fix. These sub-reasons are derived
 * from the ledger snapshot the gate already read; they never change the
 * verdict, only explain it.
 */
function consentDetail(consent = {}, now = new Date()) {
  const extra = [];
  const revoked = Boolean(consent.revokedAt) || consent.status === 'revoked';
  const expiresAt = asDate(consent.expiresAt);
  if (revoked) extra.push('ai_consent_revoked');
  else if (expiresAt && expiresAt.getTime() <= now.getTime()) extra.push('ai_consent_expired');
  else if (consent.verificationState !== 'verified') extra.push('ai_consent_unverified');
  return extra;
}

/**
 * Everything the audit knows about one contact, as a row.
 *
 * `db` is used only for reads. The three gate helpers it calls
 * (`resolveAIVoiceConsent`, `resolvePreDialScreening`, `loadResearch`) are all
 * `get()`-only, and `evaluateCompliance` is pure.
 */
export async function auditRecord(db, {
  campaign, campaignReadiness, target, contact, suppressed = false,
  extraReasons = [], now = new Date()
} = {}) {
  const automatedVoice = campaignReadiness.automatedVoice;
  const phoneE164 = normalizePhone(target?.phoneE164 || contact?.phoneE164);

  const consent = automatedVoice && phoneE164
    ? await resolveAIVoiceConsent(db, { target, campaign, phoneE164, now })
    : (target?.consent || {});

  const externalScreening = automatedVoice && phoneE164
    && requiresExternalPreDialScreening({ campaign, automatedVoice })
    ? await resolvePreDialScreening(db, { campaign, phoneE164, consent, now })
    : { eligible: true, reasons: [] };

  const compliance = evaluateCompliance({
    target: { ...target, consent },
    contact,
    campaign,
    now,
    suppressed,
    internalDoNotCall: contact?.contactability?.doNotCall === true || contact?.doNotCall === true,
    automatedVoice,
    externalScreening
  });

  // Gates the pure compliance function cannot see. Added, never subtracted.
  const auditReasons = [...extraReasons];

  const alignment = checkAccountAlignment({
    expected: campaign.accountId,
    target: clean(target?.accountId, 80) || undefined,
    contact: clean(contact?.accountId, 80) || undefined
  });
  if (!alignment.aligned) auditReasons.push(alignment.reason);

  if (automatedVoice && compliance.reasons.includes('ai_consent_not_documented')) {
    auditReasons.push(...consentDetail(consent, now));
  }

  const research = await resolveResearchStatus(db, { target, campaign, now });
  if (research.reason) auditReasons.push(research.reason);

  const recordReasons = [...new Set([...compliance.reasons, ...auditReasons])];
  const reasons = [...new Set([...recordReasons, ...campaignReadiness.reasons])];

  const timezone = compliance.timezone
    || contact?.location?.timezone
    || resolveTimezone({ region: contact?.address?.region, phoneE164 });

  return {
    id: clean(contact?.id || target?.id, 200),
    recordType: clean(contact?.type || target?.contactType || 'contact', 40),
    targetId: clean(target?.id, 200),
    accountId: clean(target?.accountId || contact?.accountId || campaign.accountId, 80),

    name: clean(contact?.companyName || contact?.name, 160),
    phoneMasked: maskPhone(phoneE164),
    hasDialablePhone: Boolean(phoneE164),
    timezone,
    localTime: localTimeIn(timezone, now),
    nextWindowOpensAt: compliance.localTimeAllowed
      ? null
      : nextWindowOpening(now, timezone, campaign),

    // The record's own verdict, and the verdict including the campaign-wide
    // blockers. Both are reported: an operator fixing consent needs the first,
    // and an operator asking "can we dial today" needs the second.
    recordReady: recordReasons.length === 0,
    eligibleNow: reasons.length === 0,
    classification: classifyReasons(reasons),
    reasons,
    labels: reasons.map(reasonLabel),
    buckets: bucketsForReasons(reasons),

    attemptCount: Number(target?.attemptCount || 0),
    lastAttemptAt: asDate(target?.lastAttemptAt),
    state: clean(target?.state, 40),

    // Identifiers and status only. No consent text, no screening evidence, no
    // registry data — an audit export is not a way to get the DNC file out.
    consent: {
      grantId: clean(consent?.grantId, 200),
      status: clean(consent?.status, 40),
      verificationState: clean(consent?.verificationState, 40)
    },
    screening: {
      id: clean(externalScreening?.id, 200),
      eligible: externalScreening?.eligible === true,
      expiresAt: asDate(externalScreening?.expiresAt)
    },
    research: { status: research.status, approved: research.approved },
    source: {
      system: clean(contact?.source?.system, 60),
      provider: clean(contact?.source?.provider, 60),
      recordId: clean(contact?.source?.providerRecordId || contact?.providerContactId, 200)
    }
  };
}

/**
 * Research status, read only.
 *
 * The dial path calls `ensureResearch`, which will *create* a brief when one is
 * missing and rewrite the target's state. Neither is acceptable here: an audit
 * that researches four hundred contacts has fetched four hundred websites and
 * moved four hundred targets, which is a side effect however read-only it
 * looks from the operator's chair.
 */
async function resolveResearchStatus(db, { target, campaign, now }) {
  if (!target?.contactType || (!target.leadId && !target.prospectId)) {
    return { status: 'not_applicable', approved: false, reason: '' };
  }
  const key = contactKey({
    contactType: target.contactType, leadId: target.leadId, prospectId: target.prospectId
  });
  const research = await loadResearch(db, key, { now });
  if (!research) return { status: 'missing', approved: false, reason: 'research_missing' };
  if (research.accountId !== campaign.accountId
    || research.evidencePolicyVersion !== RESEARCH_EVIDENCE_POLICY_VERSION) {
    return { status: 'stale', approved: false, reason: 'research_stale_policy' };
  }
  const approved = research.approved === true;
  if (campaign.requireResearchApproval && !approved) {
    return { status: clean(research.status, 40) || 'ready', approved: false, reason: 'research_not_approved' };
  }
  return { status: clean(research.status, 40) || 'ready', approved, reason: '' };
}

// ---------------------------------------------------------------------------
// Gathering candidates
// ---------------------------------------------------------------------------

/**
 * A target-and-contact pair for each record in scope.
 *
 * `campaign_targets` walks the campaign's real targets, which is the most
 * faithful scope — attempt counts and states are the ones the dialer would
 * see. The two account scopes synthesise a never-attempted target so a prospect
 * that has not been added to a campaign can still be measured against it.
 */
async function gatherFirestoreCandidates(db, { campaign, scope, limit }) {
  const candidates = [];

  if (scope === 'campaign_targets') {
    const snapshot = await db.collection('outboundTargets')
      .where('campaignId', '==', campaign.id)
      .limit(limit)
      .get();
    for (const doc of snapshot.docs) {
      const target = { id: doc.id, ...doc.data() };
      const contact = await loadContactForTarget(db, target);
      candidates.push({
        target,
        contact: contact || {},
        extraReasons: contact ? [] : ['no_valid_phone']
      });
    }
    return candidates;
  }

  const collection = scope === 'account_leads' ? 'leads' : 'prospects';
  const snapshot = await db.collection(collection)
    .where('accountId', '==', campaign.accountId)
    .limit(limit)
    .get();

  for (const doc of snapshot.docs) {
    const record = { id: doc.id, ...doc.data() };
    const isLead = collection === 'leads';
    const contact = isLead
      ? {
        id: doc.id,
        type: 'lead',
        accountId: record.accountId || '',
        name: record.name || '',
        companyName: record.businessName || '',
        phoneE164: record.phoneE164 || normalizePhone(record.phone),
        address: record.address || {},
        location: { timezone: record.timezone || '' },
        lifecycle: { status: record.status || 'new' },
        contactability: { doNotCall: record.doNotCall === true },
        consent: record.consent && typeof record.consent === 'object' ? record.consent : {}
      }
      : { ...record, type: 'prospect' };

    candidates.push({
      // A prospect that has never been a target has never been attempted. The
      // synthetic target says exactly that rather than inheriting a state.
      target: {
        id: '',
        accountId: contact.accountId,
        contactType: isLead ? 'lead' : 'prospect',
        ...(isLead ? { leadId: doc.id } : { prospectId: doc.id }),
        phoneE164: contact.phoneE164,
        consent: contact.consent || {},
        attemptCount: 0,
        lastAttemptAt: null,
        state: 'ready'
      },
      contact,
      extraReasons: []
    });
  }
  return candidates;
}

/**
 * GoHighLevel contacts, read-only, mapped into the same pair shape.
 *
 * Two audit-only reasons are added here. `crm_do_not_disturb` makes the CRM's
 * own opt-out visible as its own bucket instead of disappearing into the
 * generic do-not-call reason, and `crm_account_mismatch` fires when the
 * contact's tags say it belongs to a different seller — the only boundary that
 * exists inside a shared GoHighLevel sub-account.
 */
async function gatherGoHighLevelCandidates({ campaign, goHighLevel, limit }) {
  const read = await readGoHighLevelContacts(
    { ...goHighLevel, accountId: campaign.accountId, maxRecords: limit },
    goHighLevel.criteria || {}
  );

  const candidates = read.contacts.map(entry => {
    const extraReasons = [];
    if (entry.doNotCall) extraReasons.push('crm_do_not_disturb');
    if (entry.crmAccountId && entry.crmAccountId !== campaign.accountId) {
      extraReasons.push('crm_account_mismatch');
    } else if (!entry.crmAccountId) {
      extraReasons.push(entry.crmAccountReason === 'no_account_tag' ? 'no_account_tag' : 'account_unresolved');
    }

    return {
      target: {
        id: '',
        accountId: campaign.accountId,
        contactType: '',
        phoneE164: entry.phoneE164,
        // Nothing from the CRM becomes consent. The empty object is what makes
        // the AI gate refuse, and it is deliberate rather than incidental.
        consent: {},
        attemptCount: 0,
        lastAttemptAt: null,
        state: 'ready'
      },
      contact: {
        id: entry.providerContactId,
        type: 'gohighlevel_contact',
        accountId: entry.crmAccountId || '',
        name: entry.name,
        companyName: entry.companyName,
        phoneE164: entry.phoneE164,
        address: { region: entry.region, city: entry.city, postalCode: entry.postalCode },
        location: { timezone: entry.timezone },
        contactability: { doNotCall: entry.doNotCall },
        providerContactId: entry.providerContactId,
        source: { system: 'gohighlevel', provider: 'gohighlevel_contacts', providerRecordId: entry.providerContactId }
      },
      extraReasons
    };
  });

  return { candidates, truncated: read.truncated, pages: read.pages, requests: read.requests };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Run the audit for one seller and one campaign policy.
 *
 * The campaign is required, and required to belong to the account, because
 * every gate below is campaign-relative: the calling window, the caller id, the
 * provider, the retry policy and the consent seller all come from it. An audit
 * with no campaign would have to invent a policy, and an invented policy
 * produces an invented answer.
 */
export async function runEligibilityAudit(db, {
  accountId,
  campaignId,
  scopes = ['campaign_targets'],
  limit = DEFAULT_SCAN_LIMIT,
  goHighLevel = null,
  deploymentValues = null,
  now = new Date()
} = {}) {
  const seller = requireAccountId(accountId, { field: 'accountId' });
  const id = clean(campaignId, 200);
  if (!id) throw new Error('A campaign id is required — every eligibility gate is campaign-relative');

  const snapshot = await db.doc(`outboundCampaigns/${id}`).get();
  if (!snapshot.exists) throw new Error('Campaign not found');
  const campaign = { id: snapshot.id, ...snapshot.data() };
  if (clean(campaign.accountId, 80) !== seller) {
    throw new Error('That campaign belongs to a different account');
  }

  const scanLimit = Math.max(1, Math.min(MAX_SCAN_LIMIT, Number(limit) || DEFAULT_SCAN_LIMIT));
  const requestedScopes = AUDIT_SCOPES.filter(scope => scopes.includes(scope));
  if (!requestedScopes.length && !goHighLevel) {
    throw new Error(`At least one scope is required (${AUDIT_SCOPES.join(', ')})`);
  }

  const campaignReadiness = evaluateCampaignReadiness(campaign, { deploymentValues });

  const candidates = [];
  const scopeCounts = {};
  for (const scope of requestedScopes) {
    const found = await gatherFirestoreCandidates(db, { campaign, scope, limit: scanLimit });
    scopeCounts[scope] = found.length;
    candidates.push(...found);
  }

  let crm = null;
  if (goHighLevel) {
    const read = await gatherGoHighLevelCandidates({ campaign, goHighLevel, limit: scanLimit });
    scopeCounts.gohighlevel_contacts = read.candidates.length;
    candidates.push(...read.candidates);
    crm = { truncated: read.truncated, pages: read.pages, requests: read.requests };
  }

  const truncated = candidates.length > scanLimit || crm?.truncated === true
    || requestedScopes.some(scope => scopeCounts[scope] === scanLimit);
  const scanned = candidates.slice(0, scanLimit);

  const suppressedNumbers = await loadSuppressedNumbers(
    db, scanned.map(entry => entry.target?.phoneE164 || entry.contact?.phoneE164).filter(Boolean)
  );

  const rows = [];
  for (const candidate of scanned) {
    rows.push(await auditRecord(db, {
      campaign,
      campaignReadiness,
      target: candidate.target,
      contact: candidate.contact,
      extraReasons: candidate.extraReasons,
      suppressed: suppressedNumbers.has(normalizePhone(
        candidate.target?.phoneE164 || candidate.contact?.phoneE164
      )),
      now
    }));
  }

  return summarizeEligibilityAudit({
    campaign, seller, rows, scopeCounts, campaignReadiness, crm, truncated, scanLimit, now
  });
}

function summarizeEligibilityAudit({
  campaign, seller, rows, scopeCounts, campaignReadiness, crm, truncated, scanLimit, now
}) {
  const counts = Object.fromEntries(AUDIT_CLASSES.map(entry => [entry, 0]));
  const buckets = Object.fromEntries(AUDIT_BUCKETS.map(([bucketId]) => [bucketId, 0]));
  const reasonCounts = {};

  for (const row of rows) {
    counts[row.classification] = (counts[row.classification] || 0) + 1;
    if (row.eligibleNow) buckets.eligible_now += 1;
    for (const bucket of row.buckets) buckets[bucket] = (buckets[bucket] || 0) + 1;
    for (const reason of row.reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  return {
    kind: 'outbound_eligibility_audit',
    policyVersion: ELIGIBILITY_AUDIT_POLICY_VERSION,
    disclaimer: ELIGIBILITY_DISCLAIMER,
    generatedAt: now,
    accountId: seller,
    campaign: {
      id: campaign.id,
      name: clean(campaign.name, 160),
      mode: clean(campaign.mode, 20),
      provider: campaignReadiness.provider,
      callerId: maskPhone(campaign.callerId),
      status: clean(campaign.status, 40),
      requireResearchApproval: campaign.requireResearchApproval !== false,
      callingWindow: {
        localStartTime: clean(campaign.localStartTime, 5),
        localEndTime: clean(campaign.localEndTime, 5),
        allowedDays: Array.isArray(campaign.allowedDays) ? campaign.allowedDays : []
      }
    },
    campaignReadiness: {
      ready: campaignReadiness.ready,
      reasons: campaignReadiness.reasons,
      labels: campaignReadiness.reasons.map(reasonLabel),
      deployment: campaignReadiness.deployment,
      providerMissingCapabilities: campaignReadiness.providerMissingCapabilities,
      safetyLockReason: campaignReadiness.safetyLockReason
    },
    totals: {
      scanned: rows.length,
      eligibleNow: rows.filter(row => row.eligibleNow).length,
      // Records whose own gates pass and which only the campaign-wide blockers
      // are holding. When the two numbers differ, the difference is entirely
      // configuration, and saying so is more useful than a column of zeroes.
      recordReady: rows.filter(row => row.recordReady).length,
      scanLimit,
      truncated
    },
    classes: counts,
    buckets,
    reasons: reasonCounts,
    scopeCounts,
    crm,
    // Bounded on purpose: a callable that returns forty thousand rows is a
    // callable that times out, and the counts above are what the decision is
    // actually made from.
    rows: rows.slice(0, MAX_REPORTED_ROWS),
    rowsTruncated: rows.length > MAX_REPORTED_ROWS
  };
}

// ---------------------------------------------------------------------------
// Export and persistence
// ---------------------------------------------------------------------------

const csvCell = value => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/**
 * The masked report as CSV.
 *
 * Carries record ids, verdicts and reason codes. It deliberately carries no
 * unmasked phone number, no consent text, no screening evidence, and no
 * registry data — the DNC snapshot and the consent artifacts are the things
 * this system is supposed to be careful with, and a spreadsheet emailed around
 * an office is the least careful place they could end up.
 */
export function eligibilityAuditCsv(report) {
  const header = [
    'record_id', 'record_type', 'target_id', 'account_id', 'name', 'phone_masked',
    'timezone', 'local_time', 'classification', 'eligible_now', 'record_ready',
    'attempt_count', 'reasons', 'reason_labels'
  ];
  const lines = [
    `# ${ELIGIBILITY_DISCLAIMER}`,
    `# policy=${report.policyVersion} account=${report.accountId} campaign=${report.campaign?.id || ''}`,
    header.join(',')
  ];
  for (const row of report.rows || []) {
    lines.push([
      row.id, row.recordType, row.targetId, row.accountId, row.name, row.phoneMasked,
      row.timezone, row.localTime, row.classification, row.eligibleNow, row.recordReady,
      row.attemptCount, row.reasons.join(' '), row.labels.join('; ')
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Persist the counts, and only the counts.
 *
 * Per-record rows are returned to the caller and not stored: they are a
 * snapshot of a moment, they contain contact identifiers, and re-reading a
 * stale one is how somebody ends up acting on last month's verdict. The summary
 * is worth keeping because the launch gates are argued from it.
 */
export async function persistEligibilityAudit(db, report, { actor = '', actorUid = '' } = {}) {
  const id = `audit_${report.accountId}_${report.campaign.id}_${report.generatedAt.toISOString().replaceAll(/[:.]/g, '')}`
    .slice(0, 200);
  await db.doc(`outboundEligibilityAudits/${id}`).set({
    kind: report.kind,
    policyVersion: report.policyVersion,
    accountId: report.accountId,
    campaignId: report.campaign.id,
    campaignName: report.campaign.name,
    generatedAt: Timestamp.fromDate(report.generatedAt),
    totals: report.totals,
    classes: report.classes,
    buckets: report.buckets,
    reasons: report.reasons,
    scopeCounts: report.scopeCounts,
    campaignReadiness: {
      ready: report.campaignReadiness.ready,
      reasons: report.campaignReadiness.reasons
    },
    actor: clean(actor, 200),
    actorUid: clean(actorUid, 200)
  });
  return { id };
}
