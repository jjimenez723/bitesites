// Campaigns, targets, dialer sessions, and the state machine that keeps them
// honest.
//
// The one property this file exists to guarantee: a representative is never
// connected to two people, and a prospect is never called by two sessions. Both
// are enforced by Firestore transactions rather than by ordering — provider
// webhooks arrive out of order, get redelivered, and occasionally arrive twice
// within the same millisecond, and any design that assumes otherwise works
// perfectly until the first time two people answer at once.
//
// The parallel dialer's first-answer-wins claim (`claimWinningCall`) is the
// centre of it. Only a transaction that finds no `connectedCallId` on the
// session may win; everything else becomes a loser leg, gets cancelled at the
// provider, and — if it is still eligible — goes back to Call Later with a safe
// `nextAttemptAt`. Targets that are invalid, opted out or attempt-exhausted do
// NOT go back (§33.13).
//
// Calls live in the existing `calls` collection with the optional outbound
// fields from §34, and transcripts stay in `calls/{id}/turns`. Nothing here
// creates a second call-history system, and an older call with no `direction`
// still renders — every reader treats a missing `direction` as inbound.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getCallingProvider, assertSupports } from './providers/calling/index.js';
import {
  evaluateCompliance, requiredDisclosures, nextWindowOpening, resolveAIVoiceConsent,
  resolveCampaignOperatingLimits
} from './outbound-compliance.js';
import {
  loadContactForTarget, updateContactAfterAttempt, recordContactActivity,
  claimTarget, releaseTarget, eligibleTargets, lockIsStale, TARGET_STATES
} from './outbound-contacts.js';
import { promoteProspect } from './prospect-conversion.js';
import {
  contactKey, loadResearch, saveResearch, researchContact, buildCallBrief,
  validateResearchEvidence, RESEARCH_EVIDENCE_POLICY_VERSION
} from './lead-enrichment.js';
import { clean, normalizeConsent, normalizePhone, resolveTimezone, deterministicId } from './prospect-normalization.js';
import { normalizeOfferTrackKeys } from './offer-tracks.js';
import { sealCallPlanSnapshot } from './call-plan.js';
import {
  assertCampaignMayDial, campaignSafetyLockEngaged, safetyStopCampaignSessions, tripCampaignCircuitBreaker
} from './campaign-circuit-breaker.js';
import { warmSidebandForSession } from './hybrid-sideband-warmup.js';
import { isSuppressed, suppressNumber } from './inbound-compliance.js';
import {
  requiresExternalPreDialScreening, resolvePreDialScreening
} from './pre-dial-screening.js';
import { externalDialingAdmission } from './deployment-environment.js';
import {
  LEGACY_ACCOUNT_ID, requireAccountId, readAccountId,
  checkAccountAlignment, accountMismatchLabel, sanitizePartnerOutcomes
} from './accounts.js';

export const CAMPAIGN_STATUSES = ['draft', 'researching', 'ready', 'running', 'paused', 'completed', 'cancelled', 'failed'];
export const CAMPAIGN_MODES = ['ai', 'power', 'parallel'];

export const emptyCampaignCounts = () => ({
  total: 0, pending: 0, ready: 0, dialing: 0, connected: 0,
  completed: 0, callLater: 0, failed: 0, doNotCall: 0
});

// A session that stops heartbeating is abandoned; its locks and its live legs
// must both be cleaned up, or the campaign quietly runs out of targets.
export const SESSION_HEARTBEAT_TTL_MS = 2 * 60 * 1000;

const asDate = value => (value?.toDate ? value.toDate() : value instanceof Date ? value : null);

// ------------------------------------------------------------------ campaigns

/** Validate and bound everything an administrator can set on a campaign. */
export function sanitizeCampaign(input = {}, { existing = null } = {}) {
  const mode = CAMPAIGN_MODES.includes(input.mode) ? input.mode : existing?.mode || 'power';
  const provider = clean(input.provider, 40) || existing?.provider || 'mock';
  const operatingLimits = resolveCampaignOperatingLimits({
    provider,
    concurrency: input.concurrency ?? existing?.concurrency,
    maxAttempts: input.maxAttempts ?? existing?.maxAttempts,
    retryDelayMinutes: input.retryDelayMinutes ?? existing?.retryDelayMinutes
  });

  return {
    name: clean(input.name, 120) || existing?.name || 'Untitled campaign',
    // Which book of business this campaign serves. Campaigns created before
    // the account boundary existed carry none, so an update falls back rather
    // than failing; `createCampaign` demands an explicit one, which is what
    // stops a new campaign from ever being ambiguous.
    accountId: readAccountId(input.accountId ?? existing?.accountId, { fallback: LEGACY_ACCOUNT_ID }),
    mode,
    provider,
    // Power and AI modes are one call at a time by definition; storing a higher
    // number would make the queue view lie about what will happen.
    concurrency: mode === 'parallel' ? operatingLimits.concurrency : 1,
    callerId: normalizePhone(input.callerId ?? existing?.callerId),
    // agentProfileId is the Hybrid V2 field. Preserve agentId as a legacy
    // fallback while making the profile selected in Campaign Builder the
    // default for every new dialer session.
    agentProfileId: clean(input.agentProfileId ?? existing?.agentProfileId, 200),
    agentId: clean(input.agentId ?? existing?.agentId, 120),
    // A campaign may re-aim its shared persona at a different service without
    // editing the profile. Only server-owned track keys survive, so this can
    // never become a free-text prompt channel.
    agentOverride: {
      offerTracks: normalizeOfferTrackKeys(input.agentOverride?.offerTracks ?? existing?.agentOverride?.offerTracks)
    },
    script: clean(input.script, 8000),
    objective: clean(input.objective, 500),
    bookingRules: clean(input.bookingRules, 500),
    escalationRules: clean(input.escalationRules, 500),
    timezonePolicy: ['contact_local', 'campaign_fixed'].includes(input.timezonePolicy) ? input.timezonePolicy : 'contact_local',
    allowedDays: Array.isArray(input.allowedDays) && input.allowedDays.length
      ? input.allowedDays.map(day => String(day).toLowerCase().slice(0, 3)).filter(day => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(day))
      : ['mon', 'tue', 'wed', 'thu', 'fri'],
    localStartTime: /^\d{1,2}:\d{2}$/.test(input.localStartTime || '') ? input.localStartTime : '09:00',
    localEndTime: /^\d{1,2}:\d{2}$/.test(input.localEndTime || '') ? input.localEndTime : '19:00',
    maxAttempts: operatingLimits.maxAttempts,
    retryDelayMinutes: operatingLimits.retryDelayMinutes,
    voicemailPolicy: ['none', 'leave_message', 'retry'].includes(input.voicemailPolicy) ? input.voicemailPolicy : 'none',
    requireResearchApproval: input.requireResearchApproval !== false,
    // These are enforced capabilities, not campaign-level opt-outs. Recording
    // stays off until the in-call consent command exists; AI disclosure stays
    // on for every campaign that may attach an artificial voice.
    recordingDisclosureRequired: false,
    aiDisclosureRequired: true,
    consentBasis: ['written_opt_in', 'inbound_request', 'existing_business_relationship', 'not_recorded'].includes(input.consentBasis)
      ? input.consentBasis : 'not_recorded',
    suppressionTags: Array.isArray(input.suppressionTags) ? input.suppressionTags.slice(0, 20).map(tag => clean(tag, 40)) : [],
    recordCalls: false
  };
}

/**
 * Everything that will speak on a campaign's behalf must belong to the same
 * account as the campaign.
 *
 * Run on create and on every update, because the second one is the dangerous
 * one: a campaign built correctly and then re-pointed at another account's
 * persona is exactly how a client's contacts get called by the wrong voice.
 */
async function assertCampaignBindings(db, campaign) {
  const profileId = campaign.agentProfileId;
  let profileAccountId;

  if (profileId) {
    const snapshot = await db.doc(`aiAgentProfiles/${profileId}`).get();
    if (!snapshot.exists) throw new Error('The selected agent profile no longer exists');
    // A profile written before the boundary existed belongs to the house
    // account. That makes it usable by BiteSites campaigns and refused by
    // every client campaign, which is the safe direction for the mistake.
    profileAccountId = readAccountId(snapshot.get('accountId'), { fallback: LEGACY_ACCOUNT_ID });
  }

  const verdict = checkAccountAlignment({
    expected: campaign.accountId,
    profile: profileAccountId,
    callerId: campaign.callerId
  });

  if (!verdict.aligned) {
    throw new Error(
      `${accountMismatchLabel(verdict.reason)} — campaign is "${verdict.expected || 'unset'}", `
      + `found "${verdict.found || 'unset'}"`
    );
  }
}

export async function createCampaign(db, input, { createdBy }) {
  // Deliberate on create, tolerant on update: a new campaign that does not say
  // which book it serves is a bug waiting to happen, and there is no legacy
  // record to protect here.
  requireAccountId(input?.accountId, { field: 'accountId' });

  const campaign = sanitizeCampaign(input);
  const support = assertSupports(campaign.provider, campaign.mode, campaign.concurrency);
  if (!support.ok) {
    throw new Error(`Provider "${campaign.provider}" cannot run a ${campaign.mode} campaign: missing ${support.missing.join(', ')}`);
  }
  await assertCampaignBindings(db, campaign);

  const ref = db.collection('outboundCampaigns').doc();
  await ref.set({
    ...campaign,
    status: 'draft',
    counts: emptyCampaignCounts(),
    createdBy: clean(createdBy, 128),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    startedAt: null,
    pausedAt: null,
    completedAt: null
  });
  return ref.id;
}

export async function updateCampaign(db, campaignId, input) {
  const ref = db.doc(`outboundCampaigns/${campaignId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('Campaign not found');
  const existing = snapshot.data();

  const campaign = sanitizeCampaign({ ...existing, ...input }, { existing });
  const support = assertSupports(campaign.provider, campaign.mode, campaign.concurrency);
  if (!support.ok) {
    throw new Error(`Provider "${campaign.provider}" cannot run a ${campaign.mode} campaign: missing ${support.missing.join(', ')}`);
  }

  // A campaign's account is fixed for life. Its targets were admitted by
  // comparing them against it, so moving the campaign would silently reclassify
  // every one of them — and the targets are the records that carry attribution
  // and, eventually, commission.
  const settledAccountId = readAccountId(existing.accountId, { fallback: LEGACY_ACCOUNT_ID });
  if (campaign.accountId !== settledAccountId) {
    throw new Error(
      `A campaign cannot change account (it is "${settledAccountId}"). `
      + 'Create a new campaign under the other account and import its targets there.'
    );
  }
  await assertCampaignBindings(db, campaign);

  await ref.set({ ...campaign, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  // Targets imported while approval was required intentionally start in a
  // preparation state. If an operator later turns that gate off, leaving those
  // targets there forever makes the campaign setting look saved while the
  // dialer still reports an empty queue. Release them in bounded batches.
  if (existing.requireResearchApproval !== false && campaign.requireResearchApproval === false) {
    let released = 0;
    while (true) {
      const waiting = await db.collection('outboundTargets')
        .where('campaignId', '==', campaignId)
        .where('state', 'in', ['pending', 'researching', 'awaiting_approval'])
        .limit(400)
        .get();
      if (waiting.empty) break;
      const batch = db.batch();
      for (const entry of waiting.docs) {
        batch.set(entry.ref, {
          state: 'ready',
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
      await batch.commit();
      released += waiting.size;
      if (waiting.size < 400) break;
    }
    if (released) await refreshCampaignCounts(db, campaignId);
  }
  return { ok: true };
}

/**
 * The statuses that put a campaign back on the phone. Only these are refused
 * while the safety circuit breaker holds an unresolved critical incident.
 */
const DIALING_STATUSES = new Set(['running']);

/**
 * Campaign lifecycle. `pause` is the emergency stop: it flips the status, and
 * every entry point below re-reads it, so an in-flight session stops recruiting
 * new targets within one poll rather than at the end of its list.
 */
export async function setCampaignStatus(db, campaignId, status, { actor = '' } = {}) {
  if (!CAMPAIGN_STATUSES.includes(status)) throw new Error(`Unknown campaign status: ${status}`);
  const ref = db.doc(`outboundCampaigns/${campaignId}`);

  // Transactional because of the safety lock: reading the lock and writing
  // `running` as two separate operations leaves a window in which a breaker
  // trip lands between them and is immediately overwritten by the resume.
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new Error('Campaign not found');

    // The only transition the breaker forbids. Pausing, cancelling or closing
    // a halted campaign stays available: an operator must always be able to
    // move it further from the phone, never back onto it.
    if (DIALING_STATUSES.has(status)) assertCampaignMayDial(snapshot.data() || {});

    const update = { status, updatedAt: FieldValue.serverTimestamp() };
    if (status === 'running') update.startedAt = snapshot.get('startedAt') || FieldValue.serverTimestamp();
    if (status === 'paused') update.pausedAt = FieldValue.serverTimestamp();
    if (status === 'completed' || status === 'cancelled') update.completedAt = FieldValue.serverTimestamp();
    tx.set(ref, update, { merge: true });

    tx.create(db.collection(`outboundCampaigns/${campaignId}/events`).doc(), {
      type: 'status_change', status, actor: clean(actor, 128), at: FieldValue.serverTimestamp()
    });
  });

  // Cancelling releases every lock; an operator who hits cancel expects the
  // queue to be free, not held by a session that has not noticed yet.
  if (status === 'cancelled') {
    const held = await db.collection('outboundTargets')
      .where('campaignId', '==', campaignId)
      .where('state', 'in', ['dialing', 'connected'])
      .limit(200).get();
    for (const entry of held.docs) {
      await releaseTarget(db, entry.id, { state: 'cancelled' });
    }
  }
  return { ok: true };
}

/**
 * Which target states roll up into each campaign counter. Every state a target
 * can hold belongs to exactly one bucket, so the buckets sum to `total` unless
 * a target carries a state this map does not know about.
 */
const CAMPAIGN_COUNT_BUCKETS = {
  pending: ['pending', 'researching', 'awaiting_approval'],
  ready: ['ready'],
  dialing: ['dialing'],
  connected: ['connected'],
  completed: ['completed'],
  callLater: ['call_later', 'no_answer', 'voicemail', 'busy'],
  doNotCall: ['do_not_call'],
  failed: ['failed', 'invalid_number', 'cancelled']
};

/**
 * Recount a campaign from its targets.
 *
 * This runs on nearly every mutation path — each disposition, each release,
 * each import — so its read cost is the campaign's read cost. Counting used to
 * scan the target documents, which billed one read per target and silently
 * stopped at 5,000, so a large campaign both cost the most and was the one
 * reporting wrong numbers. Server-side aggregation bills one read per 1,000
 * index entries scanned instead of one per document, and has no such cap: a
 * 5,000-target campaign recounts for roughly 14 reads rather than 5,000.
 *
 * The `campaignId == x AND state in [...]` filters are served by the existing
 * (campaignId, state, ...) composite index prefix; no new index is required.
 */
export async function refreshCampaignCounts(db, campaignId) {
  const scoped = db.collection('outboundTargets').where('campaignId', '==', campaignId);
  const buckets = Object.entries(CAMPAIGN_COUNT_BUCKETS);
  const [total, ...tallies] = await Promise.all([
    scoped.count().get(),
    ...buckets.map(([, states]) => scoped.where('state', 'in', states).count().get())
  ]);

  const counts = emptyCampaignCounts();
  counts.total = total.data().count;
  buckets.forEach(([bucket], index) => { counts[bucket] = tallies[index].data().count; });

  await db.doc(`outboundCampaigns/${campaignId}`).set({ counts, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return counts;
}

// -------------------------------------------------------------------- targets

/** Deterministic target id, so adding the same contact twice is a no-op. */
export const targetId = (campaignId, contactType, contactId) =>
  deterministicId('tgt', campaignId, contactType, contactId);

/**
 * Re-verify a claimed target's account immediately before it is dialled.
 *
 * The import gate already checked this, but a queue can outlive the
 * assumptions it was built under — a campaign edited, a target written by an
 * older build, a migration half-applied. Both dial paths call this after
 * claiming and before anything reaches a provider, so it is the check that
 * actually has to be true.
 *
 * Returns true when the target was rejected, and the caller moves on.
 */
async function rejectedForAccountMismatch(db, { target, campaign, campaignAccountId, now, rejected }) {
  const verdict = checkAccountAlignment({
    expected: campaignAccountId,
    target: readAccountId(target.accountId, { fallback: LEGACY_ACCOUNT_ID })
  });
  if (verdict.aligned) return false;

  // Terminal, and deliberately not requeued: this is a data fault rather than
  // a bad moment to call, and a target that silently retries is a target
  // nobody ever investigates.
  await releaseTarget(db, target.id, {
    state: 'failed',
    extra: {
      complianceStatus: 'blocked',
      complianceReasons: ['account_mismatch'],
      accountMismatch: {
        expected: verdict.expected,
        found: verdict.found,
        at: Timestamp.fromDate(now)
      }
    }
  });
  console.error(
    `[outbound] target ${target.id} belongs to "${verdict.found || 'unresolved'}" but campaign `
    + `${campaign.id} serves "${verdict.expected}" — not dialled`
  );
  rejected.push({ targetId: target.id, reason: 'account_mismatch' });

  // Reaching the wrong seller's contact is not a per-target data fault to log
  // and step past. The campaign's account binding is wrong, so the next target
  // is queued to repeat it. Halt the campaign, not just this leg.
  const breaker = await tripCampaignCircuitBreaker(db, {
    campaignId: campaign.id,
    accountId: verdict.expected,
    reason: 'account_boundary_violation',
    source: 'outbound_dialer',
    detail: `target resolved to account "${verdict.found || 'unresolved'}"`,
    targetId: target.id,
    now
  }).catch(error => {
    // Never let the halt's own failure resurrect the dial loop: the caller
    // still treats this target as rejected, and the campaign stays suspect.
    console.error(`[outbound] could not halt campaign ${campaign.id}: ${error?.message || error}`);
    return { engaged: false, failed: true };
  });

  return { rejected: true, halted: breaker.engaged || breaker.idempotent || breaker.failed || false,
    incidentId: breaker.incidentId || '' };
}

/**
 * Add prospects and/or leads to a campaign.
 *
 * A prospect that is not `ready` is refused rather than quietly added: §20's
 * rule is that a migrated or scraped record stays non-callable until
 * normalisation, dedupe, compliance and any required review are done, and the
 * only way to keep that true is for this door to be the narrow one.
 */
export async function importTargets(db, campaignId, { prospectIds = [], leadIds = [], priority = 50, now = new Date() }) {
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new Error('Campaign not found');
  const campaign = campaignSnapshot.data();
  const campaignAccountId = readAccountId(campaign.accountId, { fallback: LEGACY_ACCOUNT_ID });
  const operatingLimits = resolveCampaignOperatingLimits(campaign);

  const added = [];
  const skipped = [];
  let batch = db.batch();
  let pending = 0;

  const push = async (contactType, contactId) => {
    const collection = contactType === 'lead' ? 'leads' : 'prospects';
    const snapshot = await db.doc(`${collection}/${contactId}`).get();
    if (!snapshot.exists) { skipped.push({ contactId, reason: 'not_found' }); return; }
    const contact = snapshot.data();

    // The account gate, ahead of every other check: a contact from another book
    // is not a candidate that failed to qualify, it is one that should never
    // have been offered. Records predating the boundary read as house-account,
    // so they stay available to BiteSites campaigns and are refused by every
    // client campaign — the mistake only fails in the safe direction.
    const contactAccountId = readAccountId(contact.accountId, { fallback: LEGACY_ACCOUNT_ID });
    const verdict = checkAccountAlignment({ expected: campaignAccountId, contact: contactAccountId });
    if (!verdict.aligned) {
      skipped.push({ contactId, reason: `account_mismatch_${verdict.found || 'unresolved'}` });
      return;
    }

    if (contactType === 'prospect') {
      const status = contact.lifecycle?.status;
      if (!['ready', 'approved', 'call_later'].includes(status)) {
        skipped.push({ contactId, reason: `prospect_not_ready_${status || 'unknown'}` });
        return;
      }
      if (contact.duplicate?.status === 'confirmed') { skipped.push({ contactId, reason: 'confirmed_duplicate' }); return; }
    }

    const phoneE164 = contact.phoneE164 || normalizePhone(contact.phone);
    if (!phoneE164) { skipped.push({ contactId, reason: 'no_phone' }); return; }
    if (contact.contactability?.doNotCall === true || contact.doNotCall === true) {
      skipped.push({ contactId, reason: 'do_not_call' });
      return;
    }

    const id = targetId(campaignId, contactType, contactId);
    const existing = await db.doc(`outboundTargets/${id}`).get();
    if (existing.exists) { skipped.push({ contactId, reason: 'already_in_campaign' }); return; }

    const timezone = contact.location?.timezone
      || resolveTimezone({ region: contact.address?.region, phoneE164 });

    batch.set(db.doc(`outboundTargets/${id}`), {
      campaignId,
      // Stamped rather than inferred from the campaign at dial time. The
      // dialer re-checks this against the campaign before every call, and a
      // check that reads the same field twice is not a check.
      accountId: campaignAccountId,
      contactType,
      // Exactly one is populated (§24). The other is null, not absent, so a
      // query on it behaves the same for every document.
      leadId: contactType === 'lead' ? contactId : null,
      prospectId: contactType === 'prospect' ? contactId : null,
      phoneE164,
      timezone,
      priority: Math.max(0, Math.min(100, Number(priority) || 50)),
      state: campaign.requireResearchApproval ? 'pending' : 'ready',
      researchStatus: 'none',
      researchApproved: false,
      complianceStatus: 'pending',
      complianceReasons: [],
      attemptCount: 0,
      maxAttempts: operatingLimits.maxAttempts,
      nextAttemptAt: Timestamp.fromDate(now),
      lastAttemptAt: null,
      lastCallId: '',
      lastDisposition: '',
      providerContactId: clean(contact.providerContactId, 200),
      // A campaign label never authorises an individual phone number. Stamp
      // the imported consent evidence to the target so an AI call can be
      // verified against the exact seller and number admitted to this queue.
      consent: normalizeConsent(contact),
      lockedBySessionId: '',
      lockedAt: null,
      createdAt: Timestamp.fromDate(now),
      updatedAt: Timestamp.fromDate(now)
    });
    pending += 1;
    added.push(id);

    if (contactType === 'prospect') {
      batch.set(db.collection(`prospects/${contactId}/activities`).doc(), {
        type: 'added_to_campaign', campaignId, at: Timestamp.fromDate(now)
      });
      pending += 1;
    }

    if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
  };

  for (const id of prospectIds.slice(0, 2000)) await push('prospect', id);
  for (const id of leadIds.slice(0, 2000)) await push('lead', id);
  if (pending) await batch.commit();

  await refreshCampaignCounts(db, campaignId);
  return { added: added.length, skipped };
}

// ------------------------------------------------------------------- research

/** Ensure an approved (or approval-not-required) brief exists for a target. */
export async function ensureResearch(db, target, campaign, { fetchImpl, now = new Date() } = {}) {
  const contact = await loadContactForTarget(db, target);
  if (!contact) return { ok: false, reason: 'contact_missing' };

  const key = contactKey({ contactType: target.contactType, leadId: target.leadId, prospectId: target.prospectId });
  let research = await loadResearch(db, key, { now });
  if (research && (research.accountId !== campaign.accountId
    || research.evidencePolicyVersion !== RESEARCH_EVIDENCE_POLICY_VERSION)) {
    research = null;
  }

  if (!research) {
    research = await researchContact(db, { contactType: target.contactType, contact, campaign, fetchImpl, now });
    await saveResearch(db, key, research);
    await recordContactActivity(db, contact, { type: 'research_completed', confidence: research.confidence, at: Timestamp.fromDate(now) });
  }

  if (campaign.requireResearchApproval && !research.approved) {
    await db.doc(`outboundTargets/${target.id}`).set({
      state: 'awaiting_approval', researchStatus: 'ready', updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: false, reason: 'awaiting_approval', research, contact };
  }

  const update = {
    researchStatus: research.status,
    researchApproved: Boolean(research.approved),
    updatedAt: FieldValue.serverTimestamp()
  };
  // prepareTargetForDialing operates on pending targets, while dialNext calls
  // this after a target has already been claimed and changed to `dialing`.
  // Only the preparation states should be released here; resetting a claimed
  // target to ready would make it available to a second session.
  if (['pending', 'researching', 'awaiting_approval'].includes(target.state)) update.state = 'ready';
  await db.doc(`outboundTargets/${target.id}`).set(update, { merge: true });

  return { ok: true, research, contact };
}

/** Release every queued target backed by a newly approved research brief. */
export async function releaseTargetsForApprovedResearch(db, key, accountId) {
  const match = /^(lead|prospect)_([A-Za-z0-9_-]+)$/.exec(clean(key, 200));
  if (!match) throw new Error('A valid research key is required');
  let resolvedAccountId = clean(accountId, 120);
  if (!resolvedAccountId) {
    const researchSnapshot = await db.doc(`leadResearch/${key}`).get();
    resolvedAccountId = researchSnapshot.exists ? clean(researchSnapshot.get('accountId'), 120) : '';
  }
  if (!resolvedAccountId) return 0;
  const [, contactType, contactId] = match;
  const field = contactType === 'lead' ? 'leadId' : 'prospectId';
  const snapshot = await db.collection('outboundTargets').where(field, '==', contactId).limit(500).get();
  const waiting = snapshot.docs.filter(entry =>
    entry.get('accountId') === resolvedAccountId
    && ['pending', 'researching', 'awaiting_approval'].includes(entry.get('state')));
  if (!waiting.length) return 0;

  const batch = db.batch();
  for (const entry of waiting) {
    batch.set(entry.ref, {
      state: 'ready',
      researchStatus: 'ready',
      researchApproved: true,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  await batch.commit();
  await Promise.all([...new Set(waiting.map(entry => entry.get('campaignId')).filter(Boolean))]
    .map(id => refreshCampaignCounts(db, id)));
  return waiting.length;
}

/** Generate/cache research for one bounded slice of a campaign's waiting queue. */
export async function prepareCampaignResearchBatch(db, campaignId, {
  limit = 12, concurrency = 4, now = new Date(), fetchImpl
} = {}) {
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new Error('Campaign not found');
  const campaign = { id: campaignId, ...campaignSnapshot.data() };
  const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 12));
  const boundedConcurrency = Math.max(1, Math.min(6, Number(concurrency) || 4));
  const snapshot = await db.collection('outboundTargets')
    .where('campaignId', '==', campaignId)
    .where('state', 'in', ['pending', 'researching'])
    .limit(boundedLimit)
    .get();
  const targets = snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));
  const summary = { processed: 0, prepared: 0, awaitingApproval: 0, ready: 0, failed: 0 };
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const target = targets[cursor];
      cursor += 1;
      await db.doc(`outboundTargets/${target.id}`).set({
        state: 'researching', researchStatus: 'researching', updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      try {
        const result = await ensureResearch(db, { ...target, state: 'researching' }, campaign, { fetchImpl, now });
        summary.processed += 1;
        if (result.ok) {
          summary.prepared += 1;
          summary.ready += 1;
        } else if (result.reason === 'awaiting_approval') {
          summary.prepared += 1;
          summary.awaitingApproval += 1;
        } else {
          summary.failed += 1;
          await db.doc(`outboundTargets/${target.id}`).set({
            state: 'failed', researchStatus: 'failed', researchError: clean(result.reason, 200),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
      } catch (error) {
        summary.processed += 1;
        summary.failed += 1;
        await db.doc(`outboundTargets/${target.id}`).set({
          state: 'failed', researchStatus: 'failed', researchError: clean(error?.message, 200),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(boundedConcurrency, targets.length) }, () => worker()));
  if (targets.length) await refreshCampaignCounts(db, campaignId);
  return { ...summary, hasMore: targets.length === boundedLimit };
}

/** Approve one bounded slice of generated briefs and release those targets. */
export async function approveCampaignResearchBatch(db, campaignId, {
  approvedBy = '', limit = 200, now = new Date()
} = {}) {
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new Error('Campaign not found');
  const campaign = { id: campaignId, ...campaignSnapshot.data() };
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 200));
  const snapshot = await db.collection('outboundTargets')
    .where('campaignId', '==', campaignId)
    .where('state', '==', 'awaiting_approval')
    .limit(boundedLimit)
    .get();
  if (snapshot.empty) return { processed: 0, approved: 0, missingResearch: 0, invalidResearch: 0, hasMore: false };

  const entries = snapshot.docs.map(entry => ({
    target: entry,
    key: contactKey({
      contactType: entry.get('contactType'),
      leadId: entry.get('leadId'),
      prospectId: entry.get('prospectId')
    })
  }));
  const researchRefs = entries.map(entry => db.doc(`leadResearch/${entry.key}`));
  const researchSnapshots = await db.getAll(...researchRefs);
  const batch = db.batch();
  let approved = 0;
  let missingResearch = 0;
  let invalidResearch = 0;
  const stamp = Timestamp.fromDate(now);

  entries.forEach((entry, index) => {
    if (!researchSnapshots[index].exists) {
      missingResearch += 1;
      batch.set(entry.target.ref, {
        state: 'pending', researchStatus: 'none', researchApproved: false,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }
    const research = researchSnapshots[index].data();
    const evidenceFailures = validateResearchEvidence(research, { now });
    if (research.accountId !== campaign.accountId) evidenceFailures.push('seller_account_mismatch');
    if (evidenceFailures.length) {
      invalidResearch += 1;
      batch.set(entry.target.ref, {
        state: 'pending', researchStatus: 'invalid_evidence', researchApproved: false,
        researchError: `Evidence review required: ${evidenceFailures.join(', ')}`,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }
    approved += 1;
    batch.set(researchRefs[index], {
      approved: true, approvedBy: clean(approvedBy, 128), approvedAt: stamp,
      evidencePolicyVersion: RESEARCH_EVIDENCE_POLICY_VERSION,
      version: FieldValue.increment(1)
    }, { merge: true });
    batch.set(entry.target.ref, {
      state: 'ready', researchStatus: 'ready', researchApproved: true,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();
  await refreshCampaignCounts(db, campaignId);
  return {
    processed: entries.length,
    approved,
    missingResearch,
    invalidResearch,
    hasMore: entries.length === boundedLimit
  };
}

// ------------------------------------------------------------------ call docs

/**
 * Deterministic call id: one document per (target, attempt).
 *
 * This is what makes a redelivered provider event update the existing call
 * rather than write a second one — the alternative, an auto-id at leg start,
 * gives every retry its own document and quietly triples the campaign metrics.
 */
export const outboundCallId = (targetId_, attemptNumber) =>
  deterministicId('outcall', targetId_, String(attemptNumber));

async function createCallDoc(db, {
  target, campaign, session, providerCallId, attemptNumber, operator, dialerMode, now,
  contact = {}, research = null
}) {
  const callId = outboundCallId(target.id, attemptNumber);
  const address = contact.address && typeof contact.address === 'object' ? contact.address : {};
  const safeResearch = research && typeof research === 'object' ? research : null;
  await db.doc(`calls/${callId}`).set({
    // Existing inbound-shaped fields, so Conversations.jsx renders it without
    // a special case and older readers keep working.
    agent: operator === 'ai' ? 'byte' : 'human',
    channel: 'voice',
    status: 'open',
    startedAt: Timestamp.fromDate(now),

    // §34 outbound fields.
    direction: 'outbound',
    accountId: campaign.accountId,
    operator,
    dialerMode,
    campaignId: campaign.id,
    targetId: target.id,
    leadId: target.leadId || '',
    prospectId: target.prospectId || '',
    sessionId: session?.id || '',
    provider: campaign.provider,
    providerCallId: clean(providerCallId, 200),
    providerContactId: clean(target.providerContactId, 200),
    disposition: '',
    attemptNumber,
    ringingAt: null,
    answeredAt: null,
    connectedAt: null,
    endedAt: null,
    durationSec: 0,
    summary: '',
    recordingUrl: '',
    transcriptRecorded: false,
    cancellationReason: '',

    // Snapshot the human-facing context at dial time. A prospect can later be
    // edited or converted to a lead, but the rep must always be able to see the
    // exact brief and identity that governed this attempt.
    displayName: clean(contact.companyName || contact.name || contact.firstName, 160),
    companyName: clean(contact.companyName || contact.businessName || contact.name, 160),
    contactName: clean([contact.firstName, contact.lastName].filter(Boolean).join(' '), 120),
    phoneE164: clean(contact.phoneE164 || target.phoneE164, 40),
    website: clean(contact.website, 500),
    businessCategory: clean(contact.business?.category || contact.category, 120),
    contactLocation: {
      city: clean(address.city, 120),
      region: clean(address.region, 80),
      country: clean(address.country, 80),
      timezone: clean(contact.location?.timezone || target.timezone, 100)
    },
    callPlan: safeResearch ? sealCallPlanSnapshot({
      key: clean(safeResearch.id || `${target.contactType}_${target.leadId || target.prospectId}`, 200),
      status: safeResearch.approved ? 'approved' : 'draft',
      approved: safeResearch.approved === true,
      approvedBy: clean(safeResearch.approvedBy, 160),
      sellerAccountId: campaign.accountId,
      targetId: target.id,
      contactType: target.contactType,
      contactId: target.leadId || target.prospectId,
      version: Math.max(1, Number(safeResearch.version) || 1),
      evidencePolicyVersion: Math.max(0, Number(safeResearch.evidencePolicyVersion) || 0),
      summary: clean(safeResearch.summary, 3000),
      suggestedOpening: clean(safeResearch.suggestedOpening, 2000),
      verifiedFacts: (safeResearch.verifiedFacts || []).slice(0, 20).map(fact => ({
        id: clean(fact.id, 80), text: clean(fact.text, 700), sourceId: clean(fact.sourceId, 80),
        evidenceType: clean(fact.evidenceType, 40), observedAt: clean(fact.observedAt, 50),
        confidence: Math.max(0, Math.min(1, Number(fact.confidence) || 0)),
        speakable: fact.speakable === true
      })),
      hypotheses: (safeResearch.hypotheses || []).slice(0, 20).map(value => clean(value, 500)).filter(Boolean),
      likelyNeeds: (safeResearch.likelyNeeds || []).slice(0, 20).map(value => clean(value, 500)).filter(Boolean),
      talkingPoints: (safeResearch.talkingPoints || []).slice(0, 20).map(value => clean(value, 700)).filter(Boolean),
      likelyObjections: (safeResearch.likelyObjections || []).slice(0, 20).map(value => clean(value, 700)).filter(Boolean),
      confidence: Math.max(0, Math.min(1, Number(safeResearch.confidence) || 0)),
    }) : sealCallPlanSnapshot({
      key: '', status: 'missing', approved: false, approvedBy: '', version: 0, evidencePolicyVersion: 0,
      sellerAccountId: campaign.accountId, targetId: target.id,
      contactType: target.contactType, contactId: target.leadId || target.prospectId,
      summary: '', suggestedOpening: '', verifiedFacts: [], hypotheses: [],
      likelyNeeds: [], talkingPoints: [], likelyObjections: []
    })
  }, { merge: true });
  return callId;
}

// ------------------------------------------------------------------- sessions

/** Find the server-authoritative session a rep should resume after navigation/reload. */
export async function findActiveDialerSession(db, userUid, { hybridOnly = false } = {}) {
  const snapshot = await db.collection('dialerSessions')
    .where('userUid', '==', clean(userUid, 128))
    .where('status', '==', 'active')
    .orderBy('startedAt', 'desc')
    .limit(10)
    .get();
  const entry = snapshot.docs.find(doc => !hybridOnly || doc.get('hybridV2') === true);
  return entry ? { id: entry.id, ...entry.data() } : null;
}

export async function startDialerSession(db, { campaignId, userUid, mode, concurrency = 1, now = new Date() }) {
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new Error('Campaign not found');
  const campaign = { id: campaignId, ...campaignSnapshot.data() };

  if (campaign.status === 'paused' || campaign.status === 'cancelled') {
    throw new Error(`Campaign is ${campaign.status}`);
  }
  // Defence in depth. The breaker pauses the campaign, so the check above
  // normally catches this — but a stale document, or a status written by an
  // older build, must not be able to open a session on a halted campaign.
  assertCampaignMayDial(campaign);

  const operatingLimits = resolveCampaignOperatingLimits({ ...campaign, concurrency });
  const requested = mode === 'parallel' ? operatingLimits.concurrency : 1;
  const support = assertSupports(campaign.provider, mode, requested);
  if (!support.ok) {
    throw new Error(`Provider "${campaign.provider}" cannot run a ${mode} session: missing ${support.missing.join(', ')}`);
  }

  // One live session per user per campaign. Two would fight over the same
  // targets and, in parallel mode, over the same rep's audio.
  const existing = await db.collection('dialerSessions')
    .where('userUid', '==', userUid)
    .where('status', '==', 'active')
    .limit(5).get();
  for (const entry of existing.docs) {
    const heartbeat = asDate(entry.get('lastHeartbeatAt'));
    if (heartbeat && now.getTime() - heartbeat.getTime() < SESSION_HEARTBEAT_TTL_MS) {
      throw new Error('You already have an active dialer session. Close it before starting another.');
    }
    await stopDialerSession(db, entry.id, { reason: 'superseded' });
  }

  const ref = db.collection('dialerSessions').doc();
  await ref.set({
    campaignId,
    accountId: campaign.accountId,
    userUid: clean(userUid, 128),
    provider: campaign.provider,
    mode,
    concurrency: requested,
    status: 'active',
    activeCallIds: [],
    connectedCallId: '',
    connectedTargetId: '',
    startedAt: Timestamp.fromDate(now),
    connectedAt: null,
    endedAt: null,
    lastHeartbeatAt: Timestamp.fromDate(now)
  });
  return { sessionId: ref.id, campaign };
}

export async function heartbeatSession(db, sessionId, { now = new Date() } = {}) {
  await db.doc(`dialerSessions/${sessionId}`).set({ lastHeartbeatAt: Timestamp.fromDate(now) }, { merge: true });
  return { ok: true };
}

/**
 * Dial the next batch for a session.
 *
 * One function for both modes because everything except the leg count is
 * identical: lock, compliance-check, brief, dial, record. Sharing it means the
 * compliance gate cannot be present in one mode and missing in the other.
 */
export async function dialNext(db, sessionId, {
  now = new Date(), providerConfig = {}, fetchImpl, maxNewCalls = null
} = {}) {
  const sessionRef = db.doc(`dialerSessions/${sessionId}`);
  const sessionSnapshot = await sessionRef.get();
  if (!sessionSnapshot.exists) throw new Error('Session not found');
  const session = { id: sessionId, ...sessionSnapshot.data() };
  if (session.status !== 'active') return { started: [], reason: `session_${session.status}` };
  if (session.connectedCallId) return { started: [], reason: 'already_connected' };

  const campaignSnapshot = await db.doc(`outboundCampaigns/${session.campaignId}`).get();
  if (!campaignSnapshot.exists) throw new Error('Campaign not found');
  const campaign = { id: session.campaignId, ...campaignSnapshot.data() };
  // Checked before the status so a halted campaign reports why it stopped
  // rather than the generic pause the breaker wrote on its way past.
  if (campaignSafetyLockEngaged(campaign)) {
    return { started: [], reason: 'campaign_safety_lock', incidentId: clean(campaign.safetyLock?.incidentId, 200) };
  }
  if (campaign.status === 'paused' || campaign.status === 'cancelled') {
    return { started: [], reason: `campaign_${campaign.status}` };
  }
  // A separate Firebase project is not enough to make an outbound rehearsal
  // safe: shared carrier credentials could still reach real phones. Refuse
  // carrier-backed calls before we warm a sideband, lock a target or contact a
  // provider. Mock dialing remains available to emulator tests.
  const dialingAdmission = externalDialingAdmission(campaign.provider);
  if (!dialingAdmission.allowed) {
    return { started: [], reason: 'external_dialing_disabled', admission: dialingAdmission };
  }
  const campaignAccountId = readAccountId(campaign.accountId, { fallback: LEGACY_ACCOUNT_ID });

  const configured = session.mode === 'parallel'
    ? resolveCampaignOperatingLimits({ ...campaign, concurrency: session.concurrency }).concurrency
    : 1;
  const wanted = maxNewCalls === null
    ? configured
    : Math.max(0, Math.min(configured, Number(maxNewCalls) || 0));
  if (!wanted) return { started: [], reason: 'at_capacity' };
  // Over-fetch: compliance will reject some of them, and a session that dials
  // three of five wanted legs is a slower session, not a broken one.
  // Looking at only nine records made a 500-target queue appear empty whenever
  // its first few entries were outside their local calling windows. Scan a
  // bounded but useful slice; research still runs only until enough eligible
  // legs have been claimed.
  const scanLimit = Math.max(60, wanted * 20);
  const candidates = await eligibleTargets(db, session.campaignId, { limit: scanLimit, now });

  // Wake the AI media service now, while these legs are still ringing.
  //
  // This is the last point with any slack in it. The sideband is not attached
  // until after a prospect picks up and Twilio confirms a human, so once that
  // happens every millisecond of container start is silence on a live call.
  // Ringing is the runway — several seconds of it — and starting the instance
  // here spends that time instead of the prospect's.
  //
  // It belongs here rather than on the dialer's heartbeat because this path is
  // reached with no browser attached at all: autoDial refills run from a
  // provider webhook, and detached AI sessions are deliberately exempt from the
  // abandoned-session reaper.
  if (candidates.length) await warmSidebandForSession(session);

  const provider = getCallingProvider(campaign.provider, providerConfig);
  const started = [];
  const rejected = [];
  const contacts = {};
  const claimedTargets = [];

  for (const candidate of candidates) {
    if (claimedTargets.length >= wanted) break;

    const claim = await claimTarget(db, candidate.id, sessionId, { now });
    if (!claim.claimed) { rejected.push({ targetId: candidate.id, reason: claim.reason }); continue; }
    const target = claim.target;

    const mismatch = await rejectedForAccountMismatch(db, { target, campaign, campaignAccountId, now, rejected });
    if (mismatch.halted) {
      // Every remaining candidate in this slice belongs to the same mis-bound
      // campaign, so hand the claimed ones back rather than working through
      // them, and end the session that was about to dial them.
      for (const claimed of claimedTargets) await releaseTarget(db, claimed.id, { state: 'ready' });
      await safetyStopCampaignSessions(db, session.campaignId, {
        reason: 'account_boundary_violation', now, providerConfig
      });
      return { started: [], rejected, reason: 'campaign_safety_lock', incidentId: mismatch.incidentId };
    }
    if (mismatch.rejected) continue;

    const contact = await loadContactForTarget(db, target);
    if (!contact) {
      await releaseTarget(db, target.id, { state: 'failed' });
      rejected.push({ targetId: target.id, reason: 'contact_missing' });
      continue;
    }

    // One read per leg actually being dialled, deliberately not batched: the
    // suppression list is the record of someone having asked us to stop, and it
    // is worth a document read to be sure we are reading it for the number we
    // are about to ring rather than one resolved earlier in the slice.
    const automatedVoice = ['ai', 'hybrid'].includes(session.operatingMode);
    const phoneE164 = contact.phoneE164 || target.phoneE164;
    const consent = automatedVoice
      ? await resolveAIVoiceConsent(db, { target, campaign, phoneE164, now })
      : target.consent;
    const externalScreening = requiresExternalPreDialScreening({ campaign, automatedVoice })
      ? await resolvePreDialScreening(db, { campaign, phoneE164, consent, now })
      : { eligible: true, reasons: [] };
    const compliance = evaluateCompliance({
      target: { ...target, consent }, contact, campaign, now,
      internalDoNotCall: contact.contactability?.doNotCall === true || contact.doNotCall === true,
      suppressed: await isSuppressed(db, phoneE164),
      automatedVoice,
      externalScreening
    });

    if (!compliance.eligible) {
      const terminal = compliance.reasons.some(reason =>
        ['do_not_call', 'do_not_contact', 'suppressed', 'max_attempts_reached', 'no_valid_phone', 'invalid_number',
          'ai_consent_not_documented', 'ai_consent_seller_mismatch', 'ai_consent_phone_mismatch'].includes(reason));
      const requeueAt = terminal ? null : nextWindowOpening(now, compliance.timezone, campaign) || new Date(now.getTime() + 3600_000);
      await releaseTarget(db, target.id, {
        state: terminal
          ? (compliance.reasons.includes('do_not_call') || compliance.reasons.includes('do_not_contact')
            || compliance.reasons.includes('suppressed') ? 'do_not_call' : 'completed')
          : 'call_later',
        nextAttemptAt: requeueAt,
        extra: { complianceStatus: 'blocked', complianceReasons: compliance.reasons.slice(0, 8) }
      });
      rejected.push({ targetId: target.id, reason: compliance.reasons[0] });
      continue;
    }

    const briefResult = await ensureResearch(db, target, campaign, { fetchImpl, now });
    if (!briefResult.ok) {
      await releaseTarget(db, target.id, {
        state: briefResult.reason === 'awaiting_approval' ? 'awaiting_approval' : 'failed'
      });
      rejected.push({ targetId: target.id, reason: briefResult.reason });
      continue;
    }

    contacts[target.id] = {
      ...contact,
      researchSummary: briefResult.research?.summary || '',
      compliance
    };
    claimedTargets.push({ ...target, compliance, research: briefResult.research });
  }

  if (!claimedTargets.length) {
    const liveCounts = rejected.length
      ? await refreshCampaignCounts(db, session.campaignId)
      : (campaign.counts || emptyCampaignCounts());
    const rejectedByReason = rejected.reduce((summary, entry) => {
      const reason = clean(entry.reason, 100) || 'unknown';
      summary[reason] = (summary[reason] || 0) + 1;
      return summary;
    }, {});
    return {
      started: [],
      rejected,
      reason: 'no_eligible_targets',
      availability: {
        counts: liveCounts,
        scanned: candidates.length,
        rejectedByReason
      }
    };
  }

  // Dial. A provider failure releases the legs it did claim — a locked target
  // with no call attached is a target nobody can reach.
  let legs = [];
  try {
    const request = { targets: claimedTargets, contacts, campaign, sessionId, concurrency: wanted };
    const result = session.mode === 'parallel'
      ? await provider.startParallelDialSession(request)
      : await provider.startPowerDialSession(request);
    legs = result.legs || [];
  } catch (error) {
    for (const target of claimedTargets) await releaseTarget(db, target.id, { state: 'ready' });
    throw error;
  }

  const activeCallIds = [];
  for (const leg of legs) {
    const target = claimedTargets.find(entry => entry.id === leg.targetId);
    if (!target) continue;
    const attemptNumber = Number(target.attemptCount || 0) + 1;
    const callId = await createCallDoc(db, {
      target, campaign, session,
      providerCallId: leg.providerCallId,
      attemptNumber,
      operator: 'human',
      dialerMode: session.mode,
      now,
      contact: contacts[target.id] || {},
      research: target.research || null
    });
    await db.doc(`outboundTargets/${target.id}`).set({
      state: leg.providerCallId ? 'dialing' : 'ready',
      attemptCount: attemptNumber,
      lastAttemptAt: Timestamp.fromDate(now),
      lastCallId: callId,
      complianceStatus: 'eligible',
      complianceReasons: [],
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    activeCallIds.push(callId);
    started.push({ targetId: target.id, callId, providerCallId: leg.providerCallId });
  }

  await sessionRef.set({
    activeCallIds: FieldValue.arrayUnion(...activeCallIds),
    lastHeartbeatAt: Timestamp.fromDate(now)
  }, { merge: true });

  const liveCounts = await refreshCampaignCounts(db, session.campaignId);

  return {
    started,
    rejected,
    requiresAgentAction: legs.some(leg => !leg.providerCallId),
    availability: {
      counts: liveCounts,
      scanned: candidates.length,
      rejectedByReason: rejected.reduce((summary, entry) => {
        const reason = clean(entry.reason, 100) || 'unknown';
        summary[reason] = (summary[reason] || 0) + 1;
        return summary;
      }, {})
    }
  };
}

/**
 * Run one slice of an AI campaign.
 *
 * Same gate order as the human dialer — lock, comply, brief, dial — because the
 * AI path is the one where nobody is watching. The difference is that the brief
 * is handed to the provider rather than rendered on a screen, so
 * `requiredDisclosures` is folded into it here and an unapproved brief blocks
 * the call outright when the campaign says it must.
 */
export async function runAICampaignSlice(db, campaignId, {
  limit = 5, now = new Date(), providerConfig = {}, fetchImpl
} = {}) {
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new Error('Campaign not found');
  const campaign = { id: campaignId, ...campaignSnapshot.data() };
  if (campaignSafetyLockEngaged(campaign)) return { started: [], reason: 'campaign_safety_lock' };
  if (campaign.status !== 'running') return { started: [], reason: `campaign_${campaign.status}` };
  if (campaign.mode !== 'ai') return { started: [], reason: 'not_an_ai_campaign' };
  const dialingAdmission = externalDialingAdmission(campaign.provider);
  if (!dialingAdmission.allowed) {
    return { started: [], reason: 'external_dialing_disabled', admission: dialingAdmission };
  }
  const campaignAccountId = readAccountId(campaign.accountId, { fallback: LEGACY_ACCOUNT_ID });

  const support = assertSupports(campaign.provider, 'ai', 1);
  if (!support.ok) throw new Error(`Provider "${campaign.provider}" cannot place AI calls: missing ${support.missing.join(', ')}`);

  const provider = getCallingProvider(campaign.provider, providerConfig);
  const candidates = await eligibleTargets(db, campaignId, { limit: limit * 3, now });
  const started = [];
  const rejected = [];

  // The autonomous path has no dialer session, no browser and no heartbeat —
  // this scheduled slice is the only thing that knows AI calls are imminent, so
  // it is the only place that can wake the sideband before they ring.
  if (candidates.length) await warmSidebandForSession({ mode: 'ai' });

  // The AI runner is its own "session" so the same locking, cancellation and
  // reconciliation code paths apply. A campaign without one would need a second
  // set of stale-lock rules.
  const sessionId = `ai_${campaignId}`;
  await db.doc(`dialerSessions/${sessionId}`).set({
    campaignId, accountId: campaign.accountId, userUid: 'system:ai', provider: campaign.provider, mode: 'ai',
    concurrency: 1, status: 'active', activeCallIds: [], connectedCallId: '',
    connectedTargetId: '', startedAt: Timestamp.fromDate(now), connectedAt: null,
    endedAt: null, lastHeartbeatAt: Timestamp.fromDate(now)
  }, { merge: true });

  for (const candidate of candidates) {
    if (started.length >= limit) break;

    const claim = await claimTarget(db, candidate.id, sessionId, { now });
    if (!claim.claimed) { rejected.push({ targetId: candidate.id, reason: claim.reason }); continue; }
    const target = claim.target;

    const mismatch = await rejectedForAccountMismatch(db, { target, campaign, campaignAccountId, now, rejected });
    if (mismatch.halted) {
      // Ends this slice's own `ai_` session too, which cancels the legs it
      // already started. A halted campaign keeps no live calls.
      await safetyStopCampaignSessions(db, campaignId, {
        reason: 'account_boundary_violation', now, providerConfig
      });
      return { started, rejected, reason: 'campaign_safety_lock', incidentId: mismatch.incidentId };
    }
    if (mismatch.rejected) continue;

    const contact = await loadContactForTarget(db, target);
    if (!contact) {
      await releaseTarget(db, target.id, { state: 'failed' });
      rejected.push({ targetId: target.id, reason: 'contact_missing' });
      continue;
    }

    const phoneE164 = contact.phoneE164 || target.phoneE164;
    const consent = await resolveAIVoiceConsent(db, { target, campaign, phoneE164, now });
    // The interactive dialer has always resolved this. The autonomous runner
    // did not, so `evaluateCompliance` defaulted it to null and every AI
    // campaign on a carrier provider was blocked as `external_screening_missing`
    // no matter what evidence the ledger held. Fails closed either way, but it
    // could never be unblocked.
    const externalScreening = requiresExternalPreDialScreening({ campaign, automatedVoice: true })
      ? await resolvePreDialScreening(db, { campaign, phoneE164, consent, now })
      : { eligible: true, reasons: [] };
    const compliance = evaluateCompliance({
      target: { ...target, consent }, contact, campaign, now,
      internalDoNotCall: contact.contactability?.doNotCall === true || contact.doNotCall === true,
      suppressed: await isSuppressed(db, phoneE164),
      automatedVoice: true,
      externalScreening
    });
    if (!compliance.eligible) {
      const terminal = compliance.reasons.some(reason =>
        ['do_not_call', 'do_not_contact', 'suppressed', 'max_attempts_reached', 'no_valid_phone', 'invalid_number',
          'ai_consent_not_documented', 'ai_consent_seller_mismatch', 'ai_consent_phone_mismatch'].includes(reason));
      const optedOut = ['do_not_call', 'do_not_contact', 'suppressed']
        .some(reason => compliance.reasons.includes(reason));
      await releaseTarget(db, target.id, {
        // An opt-out is not a completed call. Recording it as `completed` made
        // the autonomous runner's queue disagree with the interactive dialer's
        // about the same person, and hid opt-outs from the campaign counters.
        state: terminal ? (optedOut ? 'do_not_call' : 'completed') : 'call_later',
        nextAttemptAt: terminal ? null : (nextWindowOpening(now, compliance.timezone, campaign) || new Date(now.getTime() + 3600_000)),
        extra: { complianceStatus: 'blocked', complianceReasons: compliance.reasons.slice(0, 8) }
      });
      rejected.push({ targetId: target.id, reason: compliance.reasons[0] });
      continue;
    }

    const briefResult = await ensureResearch(db, target, campaign, { fetchImpl, now });
    if (!briefResult.ok) {
      await releaseTarget(db, target.id, {
        state: briefResult.reason === 'awaiting_approval' ? 'awaiting_approval' : 'failed'
      });
      rejected.push({ targetId: target.id, reason: briefResult.reason });
      continue;
    }

    const brief = buildCallBrief({
      research: briefResult.research,
      campaign,
      compliance: { ...compliance, disclosures: requiredDisclosures(compliance) },
      contact
    });

    let placed;
    try {
      placed = await provider.startAICall({ target, contact, campaign, brief, sessionId });
    } catch (error) {
      await releaseTarget(db, target.id, {
        state: 'failed',
        extra: { lastDisposition: 'failed', lastError: clean(error?.message, 300) }
      });
      rejected.push({ targetId: target.id, reason: clean(error?.message, 120) });
      continue;
    }

    const attemptNumber = Number(target.attemptCount || 0) + 1;
    const callId = await createCallDoc(db, {
      target: { ...target, providerContactId: placed.providerContactId || target.providerContactId },
      campaign,
      session: { id: sessionId },
      providerCallId: placed.providerCallId,
      attemptNumber,
      operator: 'ai',
      dialerMode: 'ai',
      now,
      contact,
      research: briefResult.research || null
    });

    await db.doc(`outboundTargets/${target.id}`).set({
      state: 'dialing',
      attemptCount: attemptNumber,
      lastAttemptAt: Timestamp.fromDate(now),
      lastCallId: callId,
      providerContactId: clean(placed.providerContactId || target.providerContactId, 200),
      complianceStatus: 'eligible',
      complianceReasons: [],
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    started.push({ targetId: target.id, callId, providerCallId: placed.providerCallId || '' });
  }

  await refreshCampaignCounts(db, campaignId);
  return { started, rejected };
}

/**
 * The first-answer-wins claim.
 *
 * Only a transaction that finds no `connectedCallId` may set one. Everything
 * else is a loser and is told so by the return value, which is what the caller
 * uses to cancel it. Two simultaneous answers therefore produce exactly one
 * winner regardless of arrival order, and a redelivered "answered" for the call
 * that already won is idempotent rather than a second connection.
 */
export async function claimWinningCall(db, sessionId, { callId, targetId: winningTargetId, now = new Date() }) {
  const ref = db.doc(`dialerSessions/${sessionId}`);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { won: false, reason: 'session_missing' };
    const session = snapshot.data();

    if (session.connectedCallId) {
      return {
        won: session.connectedCallId === callId,
        reason: session.connectedCallId === callId ? 'already_won' : 'another_call_connected',
        connectedCallId: session.connectedCallId
      };
    }
    if (session.status !== 'active') return { won: false, reason: `session_${session.status}` };

    transaction.update(ref, {
      connectedCallId: callId,
      connectedTargetId: winningTargetId,
      connectedAt: Timestamp.fromDate(now)
    });
    return { won: true, reason: 'won' };
  });
}

/**
 * Cancel every leg of a session except the winner, and requeue the ones that
 * are still worth calling.
 *
 * §33.13 is the rule that stops this from being a simple loop: a target that is
 * invalid, opted out or out of attempts must NOT go back to Call Later. It has
 * already been resolved, and requeueing it would have the campaign dial an
 * invalid number until `maxAttempts` runs out on its own.
 */
export async function cancelLosingLegs(db, sessionId, { winningCallId, campaign, now = new Date(), providerConfig = {} }) {
  const sessionSnapshot = await db.doc(`dialerSessions/${sessionId}`).get();
  if (!sessionSnapshot.exists) return { cancelled: 0, requeued: 0 };
  const session = sessionSnapshot.data();

  const provider = getCallingProvider(session.provider || campaign?.provider || 'mock', providerConfig);
  let cancelled = 0;
  let requeued = 0;

  for (const callId of session.activeCallIds || []) {
    if (callId === winningCallId) continue;
    const callRef = db.doc(`calls/${callId}`);
    const callSnapshot = await callRef.get();
    if (!callSnapshot.exists) continue;
    const call = callSnapshot.data();
    if (['completed', 'cancelled'].includes(call.status)) continue;

    if (call.providerCallId) {
      await provider.cancelCallLeg(call.providerCallId, 'another_call_connected').catch(() => {});
    }

    await callRef.set({
      status: 'cancelled',
      cancellationReason: 'another_call_connected',
      endedAt: Timestamp.fromDate(now)
    }, { merge: true });
    cancelled += 1;

    if (!call.targetId) continue;
    const targetRef = db.doc(`outboundTargets/${call.targetId}`);
    const targetSnapshot = await targetRef.get();
    if (!targetSnapshot.exists) continue;
    const target = targetSnapshot.data();

    const operatingLimits = resolveCampaignOperatingLimits(campaign);
    const terminal =
      target.state === 'do_not_call'
      || target.state === 'invalid_number'
      || Number(target.attemptCount || 0) >= Math.min(
        Number(target.maxAttempts ?? operatingLimits.maxAttempts),
        operatingLimits.maxAttempts
      );

    if (terminal) {
      await releaseTarget(db, call.targetId, { state: target.state === 'dialing' ? 'completed' : target.state });
      continue;
    }

    // A cancelled leg was never really an attempt — the person's phone rang and
    // nobody spoke to them. Rolling the attempt back is what keeps a five-line
    // session from burning five attempts to make one conversation.
    const retryAt = nextWindowOpening(
      new Date(now.getTime() + operatingLimits.retryDelayMinutes * 60000),
      target.timezone,
      campaign
    ) || new Date(now.getTime() + operatingLimits.retryDelayMinutes * 60000);

    await releaseTarget(db, call.targetId, {
      state: 'call_later',
      nextAttemptAt: retryAt,
      extra: {
        attemptCount: Math.max(0, Number(target.attemptCount || 1) - 1),
        lastDisposition: 'cancelled',
        requeueReason: 'another_call_connected'
      }
    });
    requeued += 1;
  }

  await db.doc(`dialerSessions/${sessionId}`).set({ activeCallIds: winningCallId ? [winningCallId] : [] }, { merge: true });
  return { cancelled, requeued };
}

export async function stopDialerSession(db, sessionId, { reason = 'ended', now = new Date(), providerConfig = {} } = {}) {
  const ref = db.doc(`dialerSessions/${sessionId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { ok: false };
  const session = snapshot.data();

  // Load the campaign rather than passing null: `cancelLosingLegs` schedules
  // requeues from its calling window and retry delay, and without it every
  // target released here would be rescheduled against the defaults instead of
  // the campaign the operator configured.
  const campaignSnapshot = session.campaignId
    ? await db.doc(`outboundCampaigns/${session.campaignId}`).get()
    : null;
  const campaign = campaignSnapshot?.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null;

  // End the winner too — the whole session is over, not just the losers.
  await cancelLosingLegs(db, sessionId, { winningCallId: '', campaign, now, providerConfig });

  const held = await db.collection('outboundTargets')
    .where('lockedBySessionId', '==', sessionId).limit(50).get();
  for (const entry of held.docs) {
    if (entry.get('state') === 'dialing') await releaseTarget(db, entry.id, { state: 'ready' });
    else await releaseTarget(db, entry.id, { state: entry.get('state') });
  }

  await ref.set({ status: 'ended', endedReason: clean(reason, 60), endedAt: Timestamp.fromDate(now) }, { merge: true });
  if (session.campaignId) await refreshCampaignCounts(db, session.campaignId);
  return { ok: true };
}

// -------------------------------------------------------------- call events

const TERMINAL_EVENTS = new Set(['completed', 'voicemail', 'busy', 'no_answer', 'failed', 'cancelled']);

const STATE_FOR_DISPOSITION = {
  connected: 'completed',
  booked_meeting: 'completed',
  qualified: 'completed',
  not_interested: 'completed',
  call_later: 'call_later',
  do_not_call: 'do_not_call',
  wrong_number: 'invalid_number',
  invalid_number: 'invalid_number',
  voicemail: 'voicemail',
  no_answer: 'no_answer',
  busy: 'busy',
  failed: 'failed',
  cancelled: 'cancelled'
};

/**
 * Apply one normalised provider event.
 *
 * Idempotent by construction: the event is recorded under a deterministic id
 * first, and a second delivery of the same id returns early without touching a
 * target, a contact or a campaign counter.
 */
export async function recordCallEvent(db, event, { eventDocId, now = new Date(), providerConfig = {} } = {}) {
  const id = eventDocId || `${event.providerCallId || event.targetId}_${event.type}`;
  const eventRef = db.doc(`outboundCallEvents/${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 400)}`);

  const isNew = await db.runTransaction(async transaction => {
    const existing = await transaction.get(eventRef);
    if (existing.exists) return false;
    transaction.set(eventRef, {
      type: event.type,
      providerCallId: event.providerCallId,
      targetId: event.targetId,
      campaignId: event.campaignId,
      sessionId: event.sessionId,
      disposition: event.disposition,
      receivedAt: Timestamp.fromDate(now)
    });
    return true;
  });
  if (!isNew) return { applied: false, reason: 'duplicate_event' };

  // Find the call. The provider id is authoritative; the target id is the
  // fallback for providers (GoHighLevel, Kixie before dialling) that have no
  // call id at the moment the leg is created.
  let callSnapshot = null;
  if (event.providerCallId) {
    const byProvider = await db.collection('calls').where('providerCallId', '==', event.providerCallId).limit(1).get();
    if (!byProvider.empty) callSnapshot = byProvider.docs[0];
  }
  if (!callSnapshot && event.targetId) {
    const byTarget = await db.collection('calls')
      .where('targetId', '==', event.targetId)
      .orderBy('startedAt', 'desc').limit(1).get();
    if (!byTarget.empty) callSnapshot = byTarget.docs[0];
  }
  if (!callSnapshot) return { applied: false, reason: 'call_not_found' };

  const call = callSnapshot.data();
  const callRef = callSnapshot.ref;
  const stamp = Timestamp.fromDate(event.at instanceof Date ? event.at : now);

  const update = { updatedAt: FieldValue.serverTimestamp() };
  if (!call.providerCallId && event.providerCallId) update.providerCallId = event.providerCallId;
  if (event.type === 'ringing') update.ringingAt = stamp;
  if (event.type === 'answered' || event.type === 'human_answered') update.answeredAt = stamp;
  if (event.recordingUrl) update.recordingUrl = event.recordingUrl;
  if (event.disposition) update.disposition = event.disposition;
  if (Number.isFinite(event.durationSec)) update.durationSec = event.durationSec;
  if (TERMINAL_EVENTS.has(event.type)) {
    update.status = event.type === 'cancelled' ? 'cancelled' : 'completed';
    update.endedAt = stamp;
  } else {
    update.status = 'open';
  }
  await callRef.set(update, { merge: true });

  if (Array.isArray(event.transcript) && event.transcript.length) {
    const batch = db.batch();
    for (const [index, turn] of event.transcript.slice(0, 400).entries()) {
      // Deterministic turn ids keep a redelivered transcript from doubling.
      batch.set(db.doc(`calls/${callSnapshot.id}/turns/${String(index).padStart(4, '0')}`), {
        role: turn.role === 'contact' ? 'visitor' : 'byte',
        kind: 'transcript',
        text: clean(turn.text, 2000),
        at: stamp
      });
    }
    batch.set(callRef, { transcriptRecorded: true }, { merge: true });
    await batch.commit();
  }

  const campaignSnapshot = call.campaignId ? await db.doc(`outboundCampaigns/${call.campaignId}`).get() : null;
  const campaign = campaignSnapshot?.exists ? { id: call.campaignId, ...campaignSnapshot.data() } : null;

  // A human answer in a parallel session is the moment the whole thing turns on.
  let winner = null;
  if (event.type === 'human_answered' && call.sessionId) {
    winner = await claimWinningCall(db, call.sessionId, { callId: callSnapshot.id, targetId: call.targetId, now });
    if (winner.won) {
      await callRef.set({ connectedAt: stamp, status: 'connected' }, { merge: true });
      await db.doc(`outboundTargets/${call.targetId}`).set({ state: 'connected', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await cancelLosingLegs(db, call.sessionId, { winningCallId: callSnapshot.id, campaign, now, providerConfig });
    } else {
      // Lost the race. Cancel this leg rather than leaving the prospect on a
      // line nobody is on — this is the "never connect two prospects to one
      // representative" requirement, enforced from the losing side too.
      const provider = getCallingProvider(call.provider || 'mock', providerConfig);
      if (call.providerCallId) await provider.cancelCallLeg(call.providerCallId, 'another_call_connected').catch(() => {});
      await callRef.set({ status: 'cancelled', cancellationReason: 'another_call_connected', endedAt: stamp }, { merge: true });
      return { applied: true, callId: callSnapshot.id, won: false, reason: winner.reason };
    }
  }

  if (TERMINAL_EVENTS.has(event.type) && call.targetId) {
    await applyDisposition(db, {
      targetId: call.targetId,
      callId: callSnapshot.id,
      disposition: event.disposition || (event.type === 'cancelled' ? 'cancelled' : event.type),
      campaign,
      now,
      actor: 'provider'
    });
  }

  if (call.campaignId) await refreshCampaignCounts(db, call.campaignId);
  return { applied: true, callId: callSnapshot.id, won: winner?.won ?? null };
}

/**
 * Resolve a target after an attempt: set its state, schedule the retry, write
 * the outcome back to the contact, and promote when the outcome earns it.
 */
export async function applyDisposition(db, {
  targetId: id, callId, disposition, campaign, notes = '', actor = '',
  requestedFollowUpAt = null, partnerOutcomes = [], now = new Date()
}) {
  const targetRef = db.doc(`outboundTargets/${id}`);
  const snapshot = await targetRef.get();
  if (!snapshot.exists) return { ok: false, reason: 'target_missing' };
  const target = { id, ...snapshot.data() };

  const state = STATE_FOR_DISPOSITION[disposition] || 'completed';
  const attemptCount = Number(target.attemptCount || 0);
  const operatingLimits = resolveCampaignOperatingLimits(campaign);
  const maxAttempts = Math.min(
    Number(target.maxAttempts ?? operatingLimits.maxAttempts),
    operatingLimits.maxAttempts
  );
  const exhausted = attemptCount >= maxAttempts;
  const safePartnerOutcomes = sanitizePartnerOutcomes(partnerOutcomes);

  let nextAttemptAt = null;
  const retryable = ['call_later', 'no_answer', 'voicemail', 'busy'].includes(state);
  if (retryable && !exhausted) {
    const requested = requestedFollowUpAt instanceof Date
      ? requestedFollowUpAt
      : requestedFollowUpAt ? new Date(requestedFollowUpAt) : null;
    if (state === 'call_later' && requested && !Number.isNaN(requested.getTime()) && requested > now) {
      // A rep-confirmed callback is a promise to the prospect, so it takes
      // precedence over the campaign's generic retry window.
      nextAttemptAt = requested;
    } else {
      const earliest = new Date(now.getTime() + operatingLimits.retryDelayMinutes * 60000);
      nextAttemptAt = nextWindowOpening(earliest, target.timezone, campaign) || earliest;
    }
  }

  await releaseTarget(db, id, {
    // A retryable outcome with no attempts left is finished, not pending.
    state: retryable && exhausted ? 'completed' : state,
    nextAttemptAt,
    extra: {
      lastDisposition: clean(disposition, 60),
      lastCallId: clean(callId, 200),
      lastAttemptAt: Timestamp.fromDate(now),
      requeueReason: retryable ? clean(disposition, 60) : '',
      ...(notes ? { notes: clean(notes, 2000) } : {}),
      ...(safePartnerOutcomes.length ? { partnerOutcomes: safePartnerOutcomes } : {})
    }
  });

  const contact = await loadContactForTarget(db, target);
  if (contact) {
    await updateContactAfterAttempt(db, contact, { disposition, callId, campaignId: target.campaignId, at: now });
    if (safePartnerOutcomes.length) {
      await recordContactActivity(db, contact, {
        type: 'partner_conversation',
        callId: clean(callId, 200),
        campaignId: clean(target.campaignId, 200),
        partnerOutcomes: safePartnerOutcomes,
        actor: clean(actor, 200),
        at: Timestamp.fromDate(now)
      });
    }
  }

  // Promotion happens here and nowhere else, and only for outcomes that mean a
  // person actually engaged (§7, §10).
  let promotion = null;
  if (target.contactType === 'prospect' && target.prospectId
      && ['connected', 'booked_meeting', 'qualified'].includes(disposition)) {
    promotion = await promoteProspect(db, target.prospectId, {
      trigger: disposition === 'booked_meeting' ? 'meeting_booked' : 'call_answered',
      campaignId: target.campaignId,
      targetId: id,
      firstConnectedCallId: callId,
      actor,
      now
    }).catch(error => ({ error: clean(error?.message, 200) }));
  }

  if (target.campaignId) await refreshCampaignCounts(db, target.campaignId);
  return { ok: true, state, nextAttemptAt, promotion, partnerOutcomes: safePartnerOutcomes };
}

// -------------------------------------------------------- operator actions

export async function moveToCallLater(db, id, { minutes = 1440, reason = 'requested', campaign = null, now = new Date() }) {
  const snapshot = await db.doc(`outboundTargets/${id}`).get();
  if (!snapshot.exists) throw new Error('Target not found');
  const target = snapshot.data();
  const earliest = new Date(now.getTime() + Math.max(15, Math.min(43200, Number(minutes) || 1440)) * 60000);
  const nextAttemptAt = nextWindowOpening(earliest, target.timezone, campaign) || earliest;
  await releaseTarget(db, id, {
    state: 'call_later',
    nextAttemptAt,
    extra: { requeueReason: clean(reason, 60), lastDisposition: 'call_later' }
  });
  if (target.campaignId) await refreshCampaignCounts(db, target.campaignId);
  return { ok: true, nextAttemptAt };
}

export async function markDoNotCall(db, id, { actor = '', now = new Date() } = {}) {
  const snapshot = await db.doc(`outboundTargets/${id}`).get();
  if (!snapshot.exists) throw new Error('Target not found');
  const target = { id, ...snapshot.data() };

  await releaseTarget(db, id, { state: 'do_not_call', extra: { lastDisposition: 'do_not_call' } });

  const contact = await loadContactForTarget(db, target);
  if (contact) {
    // Nested maps, not dotted keys — see the note in outbound-contacts.js.
    await contact.ref.set(
      contact.type === 'lead'
        ? { doNotCall: true, updatedAt: FieldValue.serverTimestamp() }
        : {
          contactability: { doNotCall: true },
          lifecycle: { status: 'do_not_contact' },
          updatedAt: FieldValue.serverTimestamp()
        },
      { merge: true }
    );
    await recordContactActivity(db, contact, { type: 'do_not_contact', actor: clean(actor, 128), at: Timestamp.fromDate(now) });
  }

  // An opt-out that only survives as long as the record we happen to hold is
  // not an opt-out either. Marking the contact covers this prospect document;
  // suppressing the number covers the person, including the case where they are
  // re-imported months later from a different list under a brand new document
  // that has never heard of this request.
  await suppressNumber(db, contact?.phoneE164 || target.phoneE164, {
    actor, reason: 'do_not_call', source: 'outbound', now, FieldValue
  }).catch(error => console.warn('[outbound] number suppression failed', clean(error?.message, 200)));

  // Every other campaign gets the same answer. An opt-out that only applies to
  // the campaign the person happened to be called from is not an opt-out.
  const others = await db.collection('outboundTargets')
    .where(target.contactType === 'lead' ? 'leadId' : 'prospectId', '==', target.contactType === 'lead' ? target.leadId : target.prospectId)
    .limit(100).get();
  for (const entry of others.docs) {
    if (entry.id === id) continue;
    await releaseTarget(db, entry.id, { state: 'do_not_call', extra: { lastDisposition: 'do_not_call' } });
  }

  if (target.campaignId) await refreshCampaignCounts(db, target.campaignId);
  return { ok: true, alsoUpdated: Math.max(0, others.size - 1) };
}

// ------------------------------------------------------------- housekeeping

/** Free targets whose session died, and close sessions that stopped reporting. */
export async function reconcileSessions(db, { now = new Date(), providerConfig = {} } = {}) {
  let closedSessions = 0;
  const sessions = await db.collection('dialerSessions').where('status', '==', 'active').limit(50).get();
  for (const entry of sessions.docs) {
    if (entry.get('hybridV2') === true && entry.get('detachedAllowed') === true) continue;
    const heartbeat = asDate(entry.get('lastHeartbeatAt'));
    if (heartbeat && now.getTime() - heartbeat.getTime() < SESSION_HEARTBEAT_TTL_MS) continue;
    await stopDialerSession(db, entry.id, { reason: 'abandoned', now, providerConfig });
    closedSessions += 1;
  }

  let freedTargets = 0;
  const locked = await db.collection('outboundTargets').where('state', '==', 'dialing').limit(200).get();
  for (const entry of locked.docs) {
    const target = entry.data();
    if (!lockIsStale(target, now)) continue;
    await releaseTarget(db, entry.id, { state: 'ready' });
    freedTargets += 1;
  }

  return { closedSessions, freedTargets };
}

/** Bring Call Later targets back when their retry time arrives. */
export async function releaseDueTargets(db, { now = new Date(), limit = 300 } = {}) {
  const due = await db.collection('outboundTargets')
    .where('state', 'in', ['call_later', 'no_answer', 'voicemail', 'busy'])
    .where('nextAttemptAt', '<=', Timestamp.fromDate(now))
    .limit(limit).get();

  let released = 0;
  const campaignLimits = new Map();
  for (const entry of due.docs) {
    const target = entry.data();
    let operatingLimits = campaignLimits.get(target.campaignId);
    if (!operatingLimits) {
      const campaignSnapshot = target.campaignId
        ? await db.doc(`outboundCampaigns/${target.campaignId}`).get()
        : null;
      // Missing/legacy campaign provenance takes the same conservative path as
      // an unknown live provider: one attempt and no automatic retry.
      operatingLimits = resolveCampaignOperatingLimits(campaignSnapshot?.exists ? campaignSnapshot.data() : {});
      if (target.campaignId) campaignLimits.set(target.campaignId, operatingLimits);
    }
    const effectiveMaxAttempts = Math.min(
      Number(target.maxAttempts || operatingLimits.maxAttempts),
      operatingLimits.maxAttempts
    );
    if (Number(target.attemptCount || 0) >= effectiveMaxAttempts) {
      await releaseTarget(db, entry.id, { state: 'completed' });
      continue;
    }
    await releaseTarget(db, entry.id, { state: 'ready' });
    released += 1;
  }
  return released;
}

export { TARGET_STATES, requiredDisclosures, buildCallBrief };
