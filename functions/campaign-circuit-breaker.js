// Server-owned campaign safety lock.
//
// Ending the affected call is not a sufficient response to a critical safety
// failure. If AI media control is lost, or a target is dialled for the wrong
// seller, the *next* target is about to be dialled under the same broken
// condition. This module is the one place allowed to halt a campaign, and it
// halts it in the same transaction that records why — so there is no window in
// which an incident exists but dialing continues, and none in which dialing
// stopped but nobody can say what happened.
//
// Three rules hold this together:
//
//   1. The incident body is immutable. It is written with `tx.create` under a
//      deterministic id and fingerprinted, so a redelivered webhook re-opens
//      nothing and a rewritten reason is detectable.
//   2. Resume is refused while any incident is unresolved. `setCampaignStatus`
//      consults the lock, so every start/resume entry point inherits the rule.
//   3. Resolving never resumes. Clearing the lock returns the campaign to a
//      *paused* campaign an operator may choose to restart, never to a running
//      one. A safety stop that undoes itself is not a safety stop.

import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { clean } from './prospect-normalization.js';

const INCIDENT_PREFIX = 'campaign_incident_';

/**
 * The failures that halt a whole campaign rather than one call.
 *
 * Deliberately short. A reason belongs here only when continuing to dial would
 * repeat the fault on the next target — not merely because the event is bad.
 * A prospect hanging up angrily is bad; it is not a broken control plane.
 */
export const CRITICAL_INCIDENT_REASONS = Object.freeze({
  ai_media_control_failure:
    'The AI runtime failed to take verified control of a live carrier leg.',
  account_boundary_violation:
    'A target was reached under a campaign belonging to a different seller account.',
  compliance_control_failure:
    'A required compliance control did not execute or could not be evidenced.',
  unauthorized_commitment:
    'The runtime attempted an action outside its authorized sales ceiling.'
});

export const isCriticalIncidentReason = reason =>
  Object.hasOwn(CRITICAL_INCIDENT_REASONS, clean(reason, 80));

export const incidentFingerprint = value =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const text = (value, max = 200) => clean(value, max);

const asDate = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    try { return asDate(value.toDate()); } catch { return null; }
  }
  return null;
};

const iso = value => asDate(value)?.toISOString() || '';

/**
 * One incident per (campaign, reason, subject).
 *
 * The subject is the call, session or target the failure attached to. A carrier
 * webhook that is delivered three times, or a reconciler that sweeps the same
 * stuck call every minute, must converge on one incident rather than opening a
 * backlog an admin has to clear one by one.
 */
export function incidentIdFor({ campaignId, reason, subjectId = '' }) {
  const key = `${text(campaignId, 200)}|${text(reason, 80)}|${text(subjectId, 200)}`;
  return `${INCIDENT_PREFIX}${incidentFingerprint(key).slice(0, 48)}`;
}

/**
 * The immutable core of an incident. `status`, `resolvedAt`, `resolvedBy` and
 * `remediation` are deliberately excluded: resolution is an append, and the
 * fingerprint has to survive it so tampering with the *reason* stays visible.
 */
const incidentComparable = incident => ({
  schemaVersion: 1,
  campaignId: text(incident.campaignId, 200),
  accountId: text(incident.accountId, 100),
  reason: text(incident.reason, 80),
  severity: text(incident.severity, 20),
  source: text(incident.source, 100),
  detail: text(incident.detail, 500),
  callId: text(incident.callId, 200),
  sessionId: text(incident.sessionId, 200),
  targetId: text(incident.targetId, 200),
  detectedAt: iso(incident.detectedAt)
});

export const incidentIntegrityHolds = incident =>
  text(incident?.bodyHash, 100) === incidentFingerprint(incidentComparable(incident || {}));

/**
 * Is this campaign currently halted by the breaker?
 *
 * Reads the stored shape defensively: a campaign written before this module
 * existed has no `safetyLock` at all, and must not be treated as halted.
 */
export function campaignSafetyLockEngaged(campaign) {
  const lock = campaign?.safetyLock;
  if (!lock) return false;
  return lock.engaged === true || Number(lock.openIncidents) > 0;
}

export function campaignSafetyLockReason(campaign) {
  const lock = campaign?.safetyLock;
  if (!campaignSafetyLockEngaged(campaign)) return '';
  return text(lock?.reason, 80) || 'critical_safety_incident';
}

const lockedMessage = campaign => {
  const reason = campaignSafetyLockReason(campaign);
  const explanation = CRITICAL_INCIDENT_REASONS[reason] || 'A critical safety incident is unresolved.';
  return `Campaign halted by the safety circuit breaker: ${explanation} `
    + 'An admin must resolve the open incident, then start the campaign explicitly.';
};

/**
 * Refuse a transition that would put a halted campaign back on the phone.
 *
 * `paused`, `cancelled`, `completed` and `failed` stay available — an operator
 * must always be able to move a halted campaign *further* from dialing.
 */
export function assertCampaignMayDial(campaign) {
  if (campaignSafetyLockEngaged(campaign)) throw new Error(lockedMessage(campaign));
  return true;
}

/**
 * Engage the lock inside a transaction the caller already owns.
 *
 * Performs its own reads, so it must be called before the caller's first write:
 * Firestore forbids a read after a write in the same transaction. Returns a
 * descriptor rather than throwing, because the caller is normally already
 * handling a failure and must not lose that work to a secondary error.
 */
export async function engageCampaignSafetyLock(tx, db, {
  campaignId, accountId = '', reason, source = '', detail = '',
  callId = '', sessionId = '', targetId = '', now = new Date()
}) {
  const safeCampaignId = text(campaignId, 200);
  const safeReason = text(reason, 80);
  if (!safeCampaignId) return { engaged: false, skipped: 'no_campaign' };
  if (!isCriticalIncidentReason(safeReason)) return { engaged: false, skipped: 'reason_not_critical' };

  const subjectId = text(callId, 200) || text(sessionId, 200) || text(targetId, 200);
  const incidentId = incidentIdFor({ campaignId: safeCampaignId, reason: safeReason, subjectId });
  const campaignRef = db.doc(`outboundCampaigns/${safeCampaignId}`);
  const incidentRef = db.doc(`campaignIncidents/${incidentId}`);

  const [campaignSnapshot, incidentSnapshot] = await Promise.all([
    tx.get(campaignRef), tx.get(incidentRef)
  ]);
  if (!campaignSnapshot.exists) return { engaged: false, skipped: 'campaign_missing', incidentId };

  const campaign = campaignSnapshot.data() || {};
  // Already recorded. The campaign was halted by the first delivery; saying so
  // again would inflate the open-incident count an admin has to clear.
  if (incidentSnapshot.exists) {
    return { engaged: false, idempotent: true, incidentId, campaignId: safeCampaignId };
  }

  const at = Timestamp.fromDate(now instanceof Date ? now : new Date(now));
  const incident = {
    schemaVersion: 1,
    campaignId: safeCampaignId,
    accountId: text(accountId, 100) || text(campaign.accountId, 100),
    reason: safeReason,
    severity: 'critical',
    source: text(source, 100),
    detail: text(detail, 500),
    callId: text(callId, 200),
    sessionId: text(sessionId, 200),
    targetId: text(targetId, 200),
    detectedAt: at
  };
  incident.bodyHash = incidentFingerprint(incidentComparable(incident));
  incident.status = 'open';
  incident.openedAt = at;
  incident.resolvedAt = null;
  incident.resolvedBy = '';
  incident.remediation = '';
  incident.createdAt = FieldValue.serverTimestamp();

  const previousStatus = text(campaign.status, 40);
  const lock = campaign.safetyLock || {};
  const openIncidents = Math.max(0, Number(lock.openIncidents) || 0) + 1;

  // `create`, not `set`: if a concurrent transaction won the race the whole
  // transaction retries and the idempotent branch above takes over.
  tx.create(incidentRef, incident);
  tx.create(db.collection(`campaignIncidentEvents/${incidentId}/events`).doc('opened'), {
    schemaVersion: 1, type: 'opened', reason: safeReason, campaignId: safeCampaignId,
    source: text(source, 100), detail: text(detail, 500), at
  });
  tx.set(campaignRef, {
    status: 'paused',
    pausedAt: at,
    safetyLock: {
      engaged: true,
      openIncidents,
      reason: safeReason,
      incidentId,
      // What to put back if the halt turns out to be spurious. Recorded here
      // because the status is about to be overwritten with `paused`.
      statusBeforeLock: text(lock.statusBeforeLock, 40) || previousStatus,
      engagedAt: lock.engagedAt || at,
      clearedAt: null
    },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  tx.create(db.collection(`outboundCampaigns/${safeCampaignId}/events`).doc(), {
    type: 'safety_lock_engaged', status: 'paused', incidentId, reason: safeReason,
    actor: text(source, 128) || 'system', at
  });

  return {
    engaged: true, incidentId, campaignId: safeCampaignId, reason: safeReason,
    previousStatus, openIncidents
  };
}

/**
 * Engage the lock from a caller that is not already inside a transaction.
 */
export async function tripCampaignCircuitBreaker(db, details = {}) {
  return db.runTransaction(tx => engageCampaignSafetyLock(tx, db, details));
}

/**
 * End every live session on a halted campaign.
 *
 * Runs after the breaker transaction commits, never inside it: ending a session
 * cancels carrier legs, and provider I/O inside a transaction would be retried
 * on contention. The pause has already landed by this point, so a session that
 * survives a failure here can no longer recruit a new target.
 *
 * `stopSession` is injectable so tests can observe the teardown without a
 * carrier; production resolves `stopDialerSession` lazily, which also keeps
 * this module free of an import cycle with outbound-calls.js.
 */
export async function safetyStopCampaignSessions(db, campaignId, {
  reason = 'safety_lock_engaged', now = new Date(), providerConfig = {}, stopSession, limit = 25
} = {}) {
  const safeCampaignId = text(campaignId, 200);
  if (!safeCampaignId) return { stopped: [], failed: [] };
  const stop = stopSession || (await import('./outbound-calls.js')).stopDialerSession;

  const sessions = await db.collection('dialerSessions')
    .where('campaignId', '==', safeCampaignId)
    .where('status', '==', 'active')
    .limit(limit).get();

  const stopped = [];
  const failed = [];
  for (const entry of sessions.docs) {
    try {
      await stop(db, entry.id, { reason: text(reason, 60), now, providerConfig });
      stopped.push(entry.id);
    } catch (error) {
      // One session refusing to tear down must not strand the others. The
      // campaign is already paused; report and continue.
      console.error(`[breaker] could not stop session ${entry.id}: ${error?.message || error}`);
      failed.push({ sessionId: entry.id, error: text(error?.message, 300) });
    }
  }
  return { stopped, failed };
}

/**
 * Admin remediation. Clears one incident and, when it was the last one, the
 * lock — leaving the campaign paused.
 */
export async function resolveCampaignIncident(db, {
  incidentId, actor = '', actorUid = '', remediation, now = new Date()
} = {}) {
  const safeIncidentId = text(incidentId, 200);
  if (!safeIncidentId) throw new Error('An incident id is required');
  const remediationText = text(remediation, 2000);
  // The point of the gate is that a human states what was done about it.
  if (remediationText.length < 10) {
    throw new Error('Describe the corrective action taken before resolving the incident');
  }

  const incidentRef = db.doc(`campaignIncidents/${safeIncidentId}`);
  return db.runTransaction(async tx => {
    const incidentSnapshot = await tx.get(incidentRef);
    if (!incidentSnapshot.exists) throw new Error('Incident not found');
    const incident = { id: safeIncidentId, ...incidentSnapshot.data() };
    if (text(incident.status, 20) === 'resolved') {
      return { resolved: false, idempotent: true, incidentId: safeIncidentId, lockCleared: false };
    }
    if (!incidentIntegrityHolds(incident)) {
      throw new Error('Incident record failed its integrity check and cannot be resolved');
    }

    const campaignId = text(incident.campaignId, 200);
    const campaignRef = db.doc(`outboundCampaigns/${campaignId}`);
    const campaignSnapshot = await tx.get(campaignRef);
    const at = Timestamp.fromDate(now instanceof Date ? now : new Date(now));

    tx.update(incidentRef, {
      status: 'resolved', resolvedAt: at,
      resolvedBy: text(actor, 200), resolvedByUid: text(actorUid, 200),
      remediation: remediationText, updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection(`campaignIncidentEvents/${safeIncidentId}/events`).doc('resolved'), {
      schemaVersion: 1, type: 'resolved', campaignId, at,
      actor: text(actor, 200), actorUid: text(actorUid, 200), remediation: remediationText
    });

    let lockCleared = false;
    if (campaignSnapshot.exists) {
      const campaign = campaignSnapshot.data() || {};
      const lock = campaign.safetyLock || {};
      const openIncidents = Math.max(0, (Math.max(0, Number(lock.openIncidents) || 0) - 1));
      lockCleared = openIncidents === 0;
      tx.set(campaignRef, {
        // Note what is *not* here: `status`. A resolved incident returns the
        // campaign to a normal paused campaign; restarting it stays a separate,
        // deliberate, audited operator action.
        safetyLock: {
          ...lock,
          engaged: !lockCleared,
          openIncidents,
          clearedAt: lockCleared ? at : (lock.clearedAt || null)
        },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      tx.create(db.collection(`outboundCampaigns/${campaignId}/events`).doc(), {
        type: lockCleared ? 'safety_lock_cleared' : 'safety_incident_resolved',
        incidentId: safeIncidentId, actor: text(actor, 128), at
      });
    }

    return {
      resolved: true, idempotent: false, incidentId: safeIncidentId,
      campaignId, lockCleared, requiresManualStart: true
    };
  });
}

/** Open incidents for one campaign, newest first. */
export async function listCampaignIncidents(db, campaignId, { status = '', limit = 50 } = {}) {
  const safeCampaignId = text(campaignId, 200);
  if (!safeCampaignId) return [];
  let query = db.collection('campaignIncidents').where('campaignId', '==', safeCampaignId);
  if (status) query = query.where('status', '==', text(status, 20));
  const snapshot = await query.orderBy('detectedAt', 'desc').limit(Math.min(200, Math.max(1, limit))).get();
  return snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));
}
