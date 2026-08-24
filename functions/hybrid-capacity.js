// Server-owned capacity maintenance for Hybrid Dialer V2.
//
// Once auto dial is enabled, every terminal call creates a vacancy. This
// module serializes refills per session, compacts the live call list, and asks
// the existing compliance-aware dialer for only the number of missing legs.

import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { dialNext } from './outbound-calls.js';
import { recordCallAuditEvent } from './hybrid-call-orchestration.js';
import { clean } from './prospect-normalization.js';
import { resolveCampaignOperatingLimits } from './outbound-compliance.js';

export const TERMINAL_HYBRID_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const LEASE_MS = 120_000;

export function hybridVacancies(concurrency, calls = [], operatingMode = 'hybrid', repBusy = false) {
  const configured = Math.max(1, Math.min(5, Number(concurrency) || 1));
  // Human-only mode may fan out several ringing legs while the rep is free,
  // but once one person answers that single connected call occupies the whole
  // human capacity until it ends.
  const desired = operatingMode === 'human' && repBusy ? 1 : configured;
  const live = calls.filter(call => call && !TERMINAL_HYBRID_STATUSES.has(call.status));
  return Math.max(0, desired - live.length);
}

export const effectiveHybridConcurrency = session =>
  resolveCampaignOperatingLimits(session || {}).concurrency;

async function liveCallsForSession(db, session) {
  const ids = [...new Set((session.activeCallIds || []).filter(Boolean))].slice(-100);
  if (!ids.length) return [];
  const snapshots = await db.getAll(...ids.map(callId => db.doc(`calls/${callId}`)));
  return snapshots
    .filter(snapshot => snapshot.exists)
    .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
    .filter(call => !TERMINAL_HYBRID_STATUSES.has(call.status));
}

async function initializeHybridCalls(db, session, started, actorId) {
  const profileId = clean(session.agentProfileId, 200);
  for (const entry of started) {
    await db.doc(`calls/${entry.callId}`).set({
      hybridV2: true,
      // `dialNext` stamps every leg it places as human-operated because it is
      // also the V1 power/parallel dialer. A Hybrid V2 leg has no operator until
      // a verified human answer is routed, so undo that guess here and record
      // the session's ownership mode rather than the transport mode.
      operator: 'unassigned',
      humanHandled: false,
      aiHandled: false,
      dialerMode: ['human', 'hybrid', 'ai'].includes(session.operatingMode) ? session.operatingMode : 'hybrid',
      control: { controller: 'unassigned', repUid: '', aiSessionId: '', revision: 0 },
      handoff: { requestedBy: '', requestedAt: null, state: 'none', priority: 0, completedAt: null },
      media: {
        conferenceSid: '', conferenceName: '', prospectParticipantSid: '',
        aiParticipantSid: '', humanParticipantSid: '', listenerParticipantSid: '', streamSid: '', recordingSid: ''
      },
      agent: {
        profileId,
        profileName: clean(session.agentProfileName, 120),
        profileVersion: Math.max(1, Number(session.agentProfileVersion) || 1),
        effectiveConfigHash: '', model: '', voice: ''
      },
      agentSessionOverride: session.agentSessionOverride || {},
      analytics: {
        humanTalkSec: 0, aiTalkSec: 0, listenSec: 0,
        takeoverCount: 0, prospectRequestedHuman: false
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await recordCallAuditEvent(db, 'call_dialed', {
      callId: entry.callId,
      sessionId: session.id,
      campaignId: session.campaignId,
      actorType: actorId ? 'rep' : 'system',
      actorId,
      metadata: { targetId: entry.targetId, automatic: !actorId }
    });
  }
}

async function acquireLease(db, sessionId, token, now) {
  const ref = db.doc(`dialerSessions/${sessionId}`);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { acquired: false, reason: 'session_missing' };
    const session = snapshot.data();
    if (session.status !== 'active') return { acquired: false, reason: `session_${session.status}` };
    if (session.hybridV2 !== true || session?.autoDial?.enabled !== true) {
      return { acquired: false, reason: 'auto_dial_disabled' };
    }
    const leaseUntil = session?.autoDial?.refillLeaseUntil?.toMillis?.() || 0;
    if (leaseUntil > now.getTime()) return { acquired: false, reason: 'refill_in_progress' };
    transaction.set(ref, {
      autoDial: {
        ...(session.autoDial || {}),
        state: 'refilling',
        refillLeaseToken: token,
        refillLeaseUntil: Timestamp.fromDate(new Date(now.getTime() + LEASE_MS)),
        lastRefillStartedAt: Timestamp.fromDate(now)
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { acquired: true };
  });
}

async function releaseLease(db, sessionId, token, state, detail = {}) {
  const ref = db.doc(`dialerSessions/${sessionId}`);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.get('autoDial.refillLeaseToken') !== token) return;
    transaction.set(ref, {
      autoDial: {
        ...(snapshot.get('autoDial') || {}),
        state,
        refillLeaseToken: '',
        refillLeaseUntil: null,
        lastRefillFinishedAt: Timestamp.fromDate(new Date()),
        ...detail
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

export async function maintainHybridCapacity(db, sessionId, {
  providerConfig = {}, actorId = '', now = new Date()
} = {}) {
  const token = randomUUID();
  const lease = await acquireLease(db, sessionId, token, now);
  if (!lease.acquired) return { started: [], reason: lease.reason };

  const started = [];
  let lastResult = { reason: 'at_capacity' };
  let finalState = 'running';
  try {
    // Recheck after each provider round. A second call may terminate while the
    // first vacancy is being filled; the lease holder then fills that vacancy
    // too instead of dropping the competing terminal callback.
    for (let round = 0; round < 5; round += 1) {
      const snapshot = await db.doc(`dialerSessions/${sessionId}`).get();
      if (!snapshot.exists) { lastResult = { reason: 'session_missing' }; break; }
      const session = { id: sessionId, ...snapshot.data() };
      if (session.status !== 'active' || session?.autoDial?.enabled !== true) {
        lastResult = { reason: session.status !== 'active' ? `session_${session.status}` : 'auto_dial_disabled' };
        break;
      }

      const liveCalls = await liveCallsForSession(db, session);
      await db.doc(`dialerSessions/${sessionId}`).set({
        activeCallIds: liveCalls.map(call => call.id),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      const vacancies = hybridVacancies(
        effectiveHybridConcurrency(session),
        liveCalls,
        session.operatingMode,
        Boolean(session?.rep?.activeCallId)
      );
      if (!vacancies) { lastResult = { reason: 'at_capacity' }; break; }

      lastResult = await dialNext(db, sessionId, { now: new Date(), providerConfig, maxNewCalls: vacancies });
      const placed = lastResult.started || [];
      if (!placed.length) {
        finalState = lastResult.reason === 'no_eligible_targets' ? 'waiting_for_targets' : 'running';
        break;
      }
      await initializeHybridCalls(db, session, placed, actorId);
      started.push(...placed);
    }
    return { ...lastResult, started };
  } catch (error) {
    finalState = 'error';
    await releaseLease(db, sessionId, token, finalState, { lastError: clean(error?.message, 300) });
    throw error;
  } finally {
    if (finalState !== 'error') {
      await releaseLease(db, sessionId, token, finalState, { lastError: '' });
    }
  }
}
