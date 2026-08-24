// Deadlines for a human handoff that nobody accepts.
//
// `requestHumanHandoff` moves a call to `requested`, and `beginSmoothHandoff`
// parks it in `queued` when the rep is busy. Neither state had an expiry, so a
// prospect who asked for a person could be held on a live carrier leg
// indefinitely while the AI waited for a rep who was never coming.
//
// The owner-approved SLA is to offer a callback rather than hold the line. That
// is a promise about elapsed time, so it is enforced in three layers rather than
// one, the same way the AI media watchdog is:
//
//   1. A deadline is stamped when the handoff is requested, so it is a fact
//      about the call rather than a timer living in one process.
//   2. Anything that touches the call applies `isHandoffExpired` in-band, so the
//      AI is told to offer a callback the moment it next acts.
//   3. A durable reconciler sweeps calls nobody touched, and ends the ones where
//      the AI itself went away and left a prospect connected to nothing.
//
// Expiry deliberately leaves the AI in control. The prospect asked for a human
// and is about to be told one is not available; taking away the voice that has
// to say so would strand them a second time.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { clean } from './prospect-normalization.js';
import { HANDOFF_ACCEPT_TIMEOUT_MS, recordCallAuditEvent } from './hybrid-call-orchestration.js';

export { HANDOFF_ACCEPT_TIMEOUT_MS };

/**
 * How long after expiry the AI has to make the offer before we assume it is not
 * going to. Generous on purpose: the AI may be mid-sentence, and cutting off a
 * live apology is worse than a few extra seconds of call.
 */
export const HANDOFF_ABANDON_GRACE_MS = 60_000;

/** States where a human is still expected and the clock is running. */
export const HANDOFF_PENDING_STATES = Object.freeze(['requested', 'queued']);

/** States that mean the handoff question is settled, one way or another. */
export const HANDOFF_SETTLED_STATES = Object.freeze([
  'announcing', 'joining_human', 'completed', 'failed', 'expired', 'abandoned'
]);

const stamp = now => Timestamp.fromDate(now instanceof Date ? now : new Date(now));

const millis = value => {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const nowMillis = now => (now instanceof Date ? now : new Date(now)).getTime();

export function handoffDeadline(now = new Date(), timeoutMs = HANDOFF_ACCEPT_TIMEOUT_MS) {
  return new Date(nowMillis(now) + timeoutMs);
}

export function isHandoffPending(call) {
  return HANDOFF_PENDING_STATES.includes(clean(call?.handoff?.state, 40));
}

/**
 * A pending handoff whose deadline has passed.
 *
 * A pending handoff with no deadline at all is treated as expired rather than
 * as immortal: that shape can only come from a partial write or a build that
 * predates this module, and the failure mode of guessing wrong in the other
 * direction is a prospect held forever.
 */
export function isHandoffExpired(call, now = new Date()) {
  if (!isHandoffPending(call)) return false;
  const deadline = millis(call?.handoff?.deadlineAt);
  return deadline <= 0 || deadline <= nowMillis(now);
}

/**
 * Expired, the AI was told to offer a callback, and it never did. Either the
 * runtime died or it is ignoring the directive; both leave a live prospect
 * attached to a call with nobody driving it.
 */
export function isHandoffAbandoned(call, now = new Date(), graceMs = HANDOFF_ABANDON_GRACE_MS) {
  if (clean(call?.handoff?.state, 40) !== 'expired') return false;
  if (call?.handoff?.fallbackDelivered === true) return false;
  const expiredAt = millis(call?.handoff?.expiredAt);
  if (expiredAt <= 0) return true;
  return expiredAt + graceMs <= nowMillis(now);
}

/** What the runtime should do next, in words the agent prompt can use. */
export const HANDOFF_FALLBACK_DIRECTIVE =
  'No colleague is available right now. Apologise briefly, offer to arrange a callback '
  + 'at a time that suits them, and end the call politely. Do not promise a named person '
  + 'or a specific time unless a tool result confirms it.';

/**
 * Make an unanswered handoff terminal exactly once.
 *
 * Returns a descriptor rather than throwing: every caller is already handling
 * something else when it runs this, and the expiry is not worth losing that
 * work to a secondary error.
 */
export async function expireHandoff(db, callId, {
  reason = 'handoff_not_accepted', source = 'handoff_failsafe', now = new Date()
} = {}) {
  const safeCallId = clean(callId, 200);
  if (!safeCallId) throw new Error('callId is required');
  const callRef = db.doc(`calls/${safeCallId}`);

  const result = await db.runTransaction(async tx => {
    const snapshot = await tx.get(callRef);
    if (!snapshot.exists) return { ok: false, reason: 'call_missing' };
    const call = snapshot.data() || {};
    const state = clean(call?.handoff?.state, 40);

    // A rep accepted while the sweep was in flight. Their handoff wins.
    if (HANDOFF_SETTLED_STATES.includes(state)) {
      return { ok: true, idempotent: true, state };
    }
    if (!isHandoffPending(call)) return { ok: false, reason: 'no_pending_handoff', state };

    const at = stamp(now);
    tx.set(callRef, {
      handoff: {
        ...(call.handoff || {}),
        state: 'expired',
        expiredAt: at,
        expiryReason: clean(reason, 160),
        expirySource: clean(source, 100),
        fallback: 'callback_offered',
        fallbackDirective: HANDOFF_FALLBACK_DIRECTIVE,
        fallbackDelivered: false
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      ok: true, idempotent: false, state: 'expired',
      sessionId: clean(call.sessionId, 200), campaignId: clean(call.campaignId, 200),
      waitedMs: Math.max(0, nowMillis(now) - millis(call?.handoff?.requestedAt))
    };
  });

  if (result.ok && !result.idempotent) {
    await recordCallAuditEvent(db, 'handoff_expired', {
      callId: safeCallId, sessionId: result.sessionId, campaignId: result.campaignId,
      actorType: 'system', actorId: clean(source, 100),
      metadata: { reason: clean(reason, 160), waitedMs: result.waitedMs }, now
    });
  }
  return result;
}

/**
 * Record that the AI actually made the offer, so the abandon sweep leaves the
 * call alone while the prospect is answering.
 */
export async function markHandoffFallbackDelivered(db, callId, { now = new Date() } = {}) {
  const safeCallId = clean(callId, 200);
  if (!safeCallId) throw new Error('callId is required');
  await db.doc(`calls/${safeCallId}`).set({
    handoff: { fallbackDelivered: true, fallbackDeliveredAt: stamp(now) },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true };
}

/**
 * End a call the AI abandoned after the offer was due.
 *
 * Terminal state is written before any carrier teardown for the same reason the
 * media failsafe does it: a transport timeout can leave the carrier result
 * unknown, but Firestore must never keep advertising a live AI-handled call
 * that nothing is driving. The caller receives the provider id it needs to hang
 * the leg up.
 */
export async function abandonHandoff(db, callId, {
  source = 'handoff_reconciler', now = new Date()
} = {}) {
  const safeCallId = clean(callId, 200);
  if (!safeCallId) throw new Error('callId is required');
  const callRef = db.doc(`calls/${safeCallId}`);

  const result = await db.runTransaction(async tx => {
    const snapshot = await tx.get(callRef);
    if (!snapshot.exists) return { ok: false, reason: 'call_missing' };
    const call = snapshot.data() || {};
    if (clean(call?.handoff?.state, 40) !== 'expired') {
      return { ok: false, reason: 'handoff_not_expired', state: clean(call?.handoff?.state, 40) };
    }
    if (call.status === 'completed' || call.safeTerminalDisposition) {
      return { ok: true, idempotent: true };
    }

    const at = stamp(now);
    const revision = Math.max(0, Number(call?.control?.revision) || 0) + 1;
    tx.set(callRef, {
      status: 'completed', endedAt: at, operator: 'none',
      disposition: 'handoff_abandoned', safeTerminalDisposition: 'handoff_abandoned',
      handoff: { ...(call.handoff || {}), state: 'abandoned', abandonedAt: at },
      control: { controller: 'none', repUid: '', aiSessionId: '', changedAt: at, revision },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      ok: true, idempotent: false,
      providerCallId: clean(call.providerCallId, 200),
      shouldTerminatePstn: Boolean(clean(call.providerCallId, 200)),
      sessionId: clean(call.sessionId, 200), campaignId: clean(call.campaignId, 200)
    };
  });

  if (result.ok && !result.idempotent) {
    await recordCallAuditEvent(db, 'handoff_abandoned', {
      callId: safeCallId, sessionId: result.sessionId, campaignId: result.campaignId,
      actorType: 'system', actorId: clean(source, 100), metadata: {}, now
    });
  }
  return result;
}

/**
 * Durable backstop for calls nothing else touched.
 *
 * Queries by state and filters the deadline in memory: the pending set is small
 * (one entry per live call awaiting a rep), and an inequality on a nested field
 * would need its own composite index for a collection this hot.
 */
export async function reconcileStaleHandoffs(db, { now = new Date(), limit = 100 } = {}) {
  const pending = await db.collection('calls')
    .where('handoff.state', 'in', [...HANDOFF_PENDING_STATES, 'expired'])
    .limit(limit).get();

  const expired = [];
  const abandoned = [];
  for (const entry of pending.docs) {
    const call = entry.data() || {};
    if (isHandoffExpired(call, now)) {
      const outcome = await expireHandoff(db, entry.id, {
        reason: 'handoff_accept_timeout', source: 'handoff_reconciler', now
      });
      if (outcome.ok && !outcome.idempotent) expired.push(entry.id);
      continue;
    }
    if (isHandoffAbandoned(call, now)) {
      const outcome = await abandonHandoff(db, entry.id, { source: 'handoff_reconciler', now });
      if (outcome.ok && !outcome.idempotent) abandoned.push({ id: entry.id, providerCallId: outcome.providerCallId });
    }
  }
  return { scanned: pending.size, expired, abandoned };
}
