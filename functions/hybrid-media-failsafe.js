// Fail-closed ownership for the short interval between a human answer and a
// verified Realtime media attachment.  A live PSTN participant must never be
// left alone in a conference while the AI setup is merely "in progress".

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { clean } from './prospect-normalization.js';
import { recordCallAuditEvent } from './hybrid-call-orchestration.js';

// The SIP dispatch, OpenAI accept and sideband connection all happen after a
// human has answered.  Twenty seconds is deliberately shorter than a natural
// unanswered conversation, but leaves normal provider signalling headroom.
export const AI_MEDIA_ATTACH_TIMEOUT_MS = 20_000;

export const AI_MEDIA_ATTACH_PENDING = new Set([
  'pending', 'dispatching', 'sip_dialing', 'sip_connected', 'accepted'
]);

export const AI_MEDIA_ATTACH_TERMINAL = new Set(['active', 'failed', 'ended']);

const stamp = now => Timestamp.fromDate(now instanceof Date ? now : new Date());

const millis = value => {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

export function aiMediaAttachDeadline(now = new Date(), timeoutMs = AI_MEDIA_ATTACH_TIMEOUT_MS) {
  return new Date((now instanceof Date ? now : new Date(now)).getTime() + timeoutMs);
}

export function isAIMediaAttachPending(job) {
  return AI_MEDIA_ATTACH_PENDING.has(clean(job?.status, 60));
}

export function isAIMediaAttachExpired(job, now = new Date()) {
  if (!isAIMediaAttachPending(job)) return false;
  const deadline = millis(job?.attachDeadlineAt);
  // A job without a deadline is an invalid legacy/partial write.  Failing it
  // closed is safer than dispatching a second live PSTN leg without a timer.
  return deadline <= 0 || deadline <= (now instanceof Date ? now : new Date(now)).getTime();
}

/**
 * Make a failed AI attachment terminal exactly once.
 *
 * This function intentionally changes the control-plane state before a caller
 * attempts carrier teardown.  A transport timeout may make the carrier result
 * unknown, but it must never leave Firestore advertising an AI-controlled call
 * after the runtime has failed.  The caller receives the immutable provider
 * identifiers it needs to end the PSTN and Realtime legs.
 */
export async function failClosedAIMediaAttachment(db, callId, {
  reason = 'media_attachment_failed', source = 'media_failsafe', realtimeCallId = '', now = new Date()
} = {}) {
  const safeCallId = clean(callId, 200);
  if (!safeCallId) throw new Error('callId is required');
  const callRef = db.doc(`calls/${safeCallId}`);
  const jobRef = db.doc(`aiMediaJobs/${safeCallId}`);
  const result = await db.runTransaction(async tx => {
    const [callSnapshot, jobSnapshot] = await Promise.all([tx.get(callRef), tx.get(jobRef)]);
    if (!callSnapshot.exists) return { ok: false, reason: 'call_missing' };
    const call = callSnapshot.data() || {};
    const currentController = clean(call?.control?.controller, 40);
    const terminal = call?.media?.attachState === 'failed'
      || call?.safeTerminalDisposition === 'ai_media_setup_failed';
    const job = jobSnapshot.exists ? jobSnapshot.data() || {} : {};
    const resolvedRealtimeId = clean(realtimeCallId || job.realtimeCallId || job?.openAI?.callId, 240);

    // A rep may have already completed a takeover while a delayed SIP failure
    // arrives.  Never tear down a human-controlled call in that race.
    const aiOwned = ['ai', 'transitioning', 'none'].includes(currentController)
      || (!currentController && (call.operator === 'ai' || jobSnapshot.exists));
    if (!aiOwned && !terminal) {
      return { ok: false, reason: 'call_no_longer_ai_controlled', controller: currentController };
    }
    if (terminal) {
      return {
        ok: true, idempotent: true,
        // A previous transaction may have recorded the terminal state just
        // before the process died.  Keep retrying only the external teardown
        // until it is durably requested; never duplicate the terminal audit.
        shouldTerminatePstn: Boolean(clean(call.providerCallId, 200))
          && !call?.media?.pstnEndRequestedAt && !call?.media?.pstnEndConfirmedAt,
        shouldTerminateRealtime: Boolean(resolvedRealtimeId) && !call?.media?.realtimeHangupConfirmedAt,
        providerCallId: clean(call.providerCallId, 200), realtimeCallId: resolvedRealtimeId,
        sessionId: clean(call.sessionId, 200), campaignId: clean(call.campaignId, 200)
      };
    }

    const at = stamp(now);
    const failure = clean(reason, 300) || 'media_attachment_failed';
    const nextRevision = Math.max(0, Number(call?.control?.revision) || 0) + 1;
    tx.set(callRef, {
      status: 'completed', endedAt: at, operator: 'none', disposition: 'ai_media_setup_failed',
      safeTerminalDisposition: 'ai_media_setup_failed',
      aiAttachError: failure,
      control: {
        controller: 'none', repUid: '', aiSessionId: '', changedAt: at, revision: nextRevision
      },
      media: {
        ...(call.media || {}), attachState: 'failed', attachFailureReason: failure,
        attachFailureSource: clean(source, 100), attachFailedAt: at
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (jobSnapshot.exists) {
      tx.set(jobRef, {
        status: 'failed', error: failure, failureSource: clean(source, 100),
        failedAt: at, realtimeCallId: resolvedRealtimeId || clean(job.realtimeCallId, 240),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    const targetId = clean(call.targetId, 200);
    if (targetId) {
      tx.set(db.doc(`outboundTargets/${targetId}`), {
        state: 'completed', lastDisposition: 'ai_media_setup_failed',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return {
      ok: true, idempotent: false, shouldTerminatePstn: Boolean(clean(call.providerCallId, 200)),
      shouldTerminateRealtime: Boolean(resolvedRealtimeId),
      providerCallId: clean(call.providerCallId, 200), realtimeCallId: resolvedRealtimeId,
      sessionId: clean(call.sessionId, 200), campaignId: clean(call.campaignId, 200), failure
    };
  });

  if (result.ok && !result.idempotent) {
    await recordCallAuditEvent(db, 'ai_media_attachment_failed', {
      callId: safeCallId, sessionId: result.sessionId, campaignId: result.campaignId,
      actorType: 'system', actorId: clean(source, 100), metadata: { reason: result.failure || reason }, now
    });
  }
  return result;
}
