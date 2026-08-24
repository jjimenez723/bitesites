// Hybrid AI Dialer V2 — provider-neutral ownership and handoff state machine.
//
// This module intentionally owns no Twilio/OpenAI details. It is the correctness
// boundary for who controls a connected call and for the invariant that one rep
// may speak on at most one call at a time while any number of sibling calls may
// remain AI-controlled.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { clean } from './prospect-normalization.js';
import { evaluateAIVoiceConsent, resolveAIVoiceConsent } from './outbound-compliance.js';
import {
  requiresExternalPreDialScreening, resolvePreDialScreening
} from './pre-dial-screening.js';

export const CALL_CONTROLLERS = ['unassigned', 'human', 'ai', 'transitioning', 'none'];
export const REP_STATES = ['available', 'busy', 'listening', 'transitioning', 'offline'];
export const HANDOFF_STATES = ['none', 'requested', 'queued', 'announcing', 'joining_human', 'completed', 'cancelled', 'failed'];

const timestamp = value => Timestamp.fromDate(value instanceof Date ? value : new Date());

const control = call => ({
  controller: CALL_CONTROLLERS.includes(call?.control?.controller) ? call.control.controller : 'unassigned',
  repUid: clean(call?.control?.repUid, 160),
  aiSessionId: clean(call?.control?.aiSessionId, 240),
  revision: Math.max(0, Number(call?.control?.revision) || 0)
});

const rep = session => ({
  state: REP_STATES.includes(session?.rep?.state) ? session.rep.state : 'available',
  activeCallId: clean(session?.rep?.activeCallId, 200),
  listeningCallId: clean(session?.rep?.listeningCallId, 200)
});

export function routeDecision({ session, call }) {
  const current = control(call);
  if (current.controller !== 'unassigned') {
    return { controller: current.controller, idempotent: true, reason: 'already_routed' };
  }

  const currentRep = rep(session);
  const repFree = currentRep.state === 'available' && !currentRep.activeCallId;
  const operatingMode = ['human', 'hybrid', 'ai'].includes(session?.operatingMode)
    ? session.operatingMode : 'hybrid';
  if (operatingMode === 'ai') {
    return { controller: 'ai', idempotent: false, reason: 'ai_only_mode' };
  }
  if (operatingMode === 'human' && !repFree) {
    return { controller: 'none', idempotent: false, reason: 'human_rep_busy' };
  }
  return repFree
    ? { controller: 'human', idempotent: false, reason: 'rep_available' }
    : { controller: 'ai', idempotent: false, reason: 'rep_busy' };
}

export function handoffPriority(requestedBy) {
  return requestedBy === 'prospect' ? 100 : requestedBy === 'rep' ? 80 : 0;
}

export function handoffAllowed(call) {
  return call?.handoff?.requestedBy === 'prospect' || call?.handoff?.requestedBy === 'rep';
}

export function selectAuthorizedAutoTakeover(calls = []) {
  return calls
    .filter(call => control(call).controller === 'ai')
    .filter(call => handoffAllowed(call))
    .filter(call => ['requested', 'queued'].includes(call?.handoff?.state))
    .sort((a, b) => {
      const priorityDelta = Number(b?.handoff?.priority || 0) - Number(a?.handoff?.priority || 0);
      if (priorityDelta) return priorityDelta;
      const aAt = a?.handoff?.requestedAt?.toMillis?.() || new Date(a?.handoff?.requestedAt || 0).getTime() || 0;
      const bAt = b?.handoff?.requestedAt?.toMillis?.() || new Date(b?.handoff?.requestedAt || 0).getTime() || 0;
      return aAt - bAt;
    })[0] || null;
}

async function audit(db, type, {
  callId = '', sessionId = '', campaignId = '', actorType = 'system', actorId = '', metadata = {}, now = new Date()
} = {}) {
  const bounded = {};
  for (const [key, value] of Object.entries(metadata || {}).slice(0, 20)) {
    const safeKey = clean(key, 60).replace(/[^A-Za-z0-9_-]/g, '_');
    if (!safeKey) continue;
    if (typeof value === 'number' || typeof value === 'boolean') bounded[safeKey] = value;
    else bounded[safeKey] = clean(value, 300);
  }
  await db.collection('callAuditEvents').doc().set({
    type: clean(type, 80), callId: clean(callId, 200), sessionId: clean(sessionId, 200),
    campaignId: clean(campaignId, 200), actorType: clean(actorType, 30), actorId: clean(actorId, 160),
    metadata: bounded, at: timestamp(now), createdAt: FieldValue.serverTimestamp()
  });
}

/**
 * Route a verified human answer without cancelling siblings.
 *
 * Exactly one transaction decides whether this call gets the rep or an isolated
 * AI controller. Simultaneous answers therefore produce at most one human call,
 * while every other answered call remains alive and is assigned to AI.
 */
export async function routeVerifiedHumanAnswer(db, sessionId, callId, {
  targetId = '', now = new Date()
} = {}) {
  const sessionRef = db.doc(`dialerSessions/${sessionId}`);
  const callRef = db.doc(`calls/${callId}`);
  const targetRef = targetId ? db.doc(`outboundTargets/${targetId}`) : null;

  const result = await db.runTransaction(async transaction => {
    const [sessionSnapshot, callSnapshot] = await Promise.all([
      transaction.get(sessionRef), transaction.get(callRef)
    ]);
    if (!sessionSnapshot.exists) return { routed: false, reason: 'session_missing' };
    if (!callSnapshot.exists) return { routed: false, reason: 'call_missing' };

    const session = sessionSnapshot.data();
    const call = callSnapshot.data();
    const current = control(call);
    if (current.controller !== 'unassigned') {
      return { routed: true, controller: current.controller, reason: 'already_routed', idempotent: true };
    }
    if (session.status !== 'active') return { routed: false, reason: `session_${session.status}` };

    const decision = routeDecision({ session, call });
    const nextRevision = current.revision + 1;
    const stamp = timestamp(now);

    if (decision.controller === 'human') {
      transaction.set(callRef, {
        status: 'connected', answeredBy: 'human', connectedAt: stamp,
        operator: 'human', humanHandled: true,
        control: {
          controller: 'human', repUid: clean(session.userUid, 160), aiSessionId: '',
          changedAt: stamp, revision: nextRevision
        }
      }, { merge: true });
      transaction.set(sessionRef, {
        rep: { state: 'busy', activeCallId: callId, listeningCallId: '' },
        lastHeartbeatAt: stamp
      }, { merge: true });
    } else if (decision.controller === 'ai') {
      transaction.set(callRef, {
        status: 'connected', answeredBy: 'human', connectedAt: stamp,
        operator: 'ai', aiHandled: true,
        control: {
          controller: 'ai', repUid: '', aiSessionId: '', changedAt: stamp, revision: nextRevision
        }
      }, { merge: true });
    } else {
      transaction.set(callRef, {
        status: 'completed', answeredBy: 'human', connectedAt: stamp, endedAt: stamp,
        operator: 'none',
        control: {
          controller: 'none', repUid: '', aiSessionId: '', changedAt: stamp, revision: nextRevision
        }
      }, { merge: true });
    }

    if (targetRef) transaction.set(targetRef, {
      state: decision.controller === 'none' ? 'completed' : 'connected',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { routed: true, controller: decision.controller, reason: decision.reason, idempotent: false };
  });

  if (result.routed && !result.idempotent) {
    await audit(db, result.controller === 'human' ? 'rep_connected'
      : result.controller === 'ai' ? 'ai_routing_required' : 'human_mode_overflow_ended', {
      callId, sessionId, actorType: 'system', metadata: { reason: result.reason }, now
    });
  }
  return result;
}

/** Record the provider/model AI session once the media runtime is attached. */
export async function attachAIController(db, callId, aiSessionId, {
  model = '', voice = '', profileId = '', profileVersion = 0, effectiveConfigHash = '', now = new Date()
} = {}) {
  const ref = db.doc(`calls/${callId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('Call not found');
  const call = snapshot.data();
  const current = control(call);
  if (current.controller !== 'ai') throw new Error(`Call is controlled by ${current.controller}, not ai`);

  // A Hybrid session can begin human-only and later route an answered leg to
  // AI. Requiring consent only when the leg was dialled would leave that path
  // as an escape hatch, so re-check the target snapshot immediately before
  // media is attached. Do not fall back to mutable contact/campaign metadata.
  const targetId = clean(call.targetId, 200);
  const campaignId = clean(call.campaignId, 200);
  if (!targetId || !campaignId) throw new Error('AI voice consent cannot be verified for this call');
  const [targetSnapshot, campaignSnapshot] = await Promise.all([
    db.doc(`outboundTargets/${targetId}`).get(),
    db.doc(`outboundCampaigns/${campaignId}`).get()
  ]);
  if (!targetSnapshot.exists || !campaignSnapshot.exists) {
    throw new Error('AI voice consent cannot be verified for this call');
  }
  const target = targetSnapshot.data();
  const campaign = campaignSnapshot.data();
  const resolvedConsent = await resolveAIVoiceConsent(db, {
    target,
    campaign,
    phoneE164: call.phoneE164 || targetSnapshot.get('phoneE164'),
    now
  });
  const consent = evaluateAIVoiceConsent({
    target: { ...target, consent: resolvedConsent },
    campaign,
    phoneE164: call.phoneE164 || targetSnapshot.get('phoneE164')
  });
  if (!consent.eligible) {
    throw new Error(`AI voice consent is not valid: ${consent.reasons.join(', ')}`);
  }
  if (requiresExternalPreDialScreening({ campaign, automatedVoice: true })) {
    const screening = await resolvePreDialScreening(db, {
      campaign,
      phoneE164: call.phoneE164 || targetSnapshot.get('phoneE164'),
      consent: resolvedConsent,
      now
    });
    if (!screening.eligible) {
      throw new Error(`AI pre-dial screening is not valid: ${screening.reasons.join(', ')}`);
    }
  }

  await ref.set({
    operator: 'ai',
    aiHandled: true,
    control: {
      controller: 'ai', repUid: '', aiSessionId: clean(aiSessionId, 240),
      changedAt: timestamp(now), revision: current.revision + 1
    },
    agent: {
      profileId: clean(profileId, 200), profileVersion: Math.max(0, Number(profileVersion) || 0),
      effectiveConfigHash: clean(effectiveConfigHash, 128), model: clean(model, 120), voice: clean(voice, 120)
    },
    aiStartedAt: timestamp(now),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await audit(db, 'ai_attached', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'ai', actorId: clean(aiSessionId, 160), metadata: { profileId, profileVersion }, now
  });
  return { ok: true };
}

/**
 * Queue/record a human handoff. AI may request this only on behalf of an
 * explicit prospect request; autonomous "hot lead" transfer is not accepted.
 */
export async function requestHumanHandoff(db, callId, {
  requestedBy, actorId = '', now = new Date()
} = {}) {
  if (!['prospect', 'rep'].includes(requestedBy)) throw new Error('Handoff requester must be prospect or rep');
  const ref = db.doc(`calls/${callId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('Call not found');
  const call = snapshot.data();
  if (control(call).controller !== 'ai') throw new Error('Only AI-controlled calls can request handoff');

  if (requestedBy === 'rep') {
    const sessionSnapshot = await db.doc(`dialerSessions/${call.sessionId}`).get();
    if (!sessionSnapshot.exists || sessionSnapshot.get('userUid') !== actorId) {
      throw new Error('Rep cannot take over another rep session');
    }
  }

  const state = call?.handoff?.state;
  if (['requested', 'queued', 'announcing', 'joining_human', 'completed'].includes(state)) {
    return { ok: true, idempotent: true, state };
  }

  const priority = handoffPriority(requestedBy);
  await ref.set({
    handoff: {
      requestedBy, requestedAt: timestamp(now), state: 'requested', priority, completedAt: null
    },
    ...(requestedBy === 'prospect' ? { analytics: { prospectRequestedHuman: true } } : {}),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await audit(db, requestedBy === 'prospect' ? 'prospect_requested_human' : 'handoff_requested', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: requestedBy === 'rep' ? 'rep' : 'prospect', actorId, metadata: { priority }, now
  });
  return { ok: true, idempotent: false, state: 'requested', priority };
}

/** Reserve a free rep and begin a smooth handoff. */
export async function beginSmoothHandoff(db, sessionId, callId, {
  repUid, now = new Date()
} = {}) {
  const sessionRef = db.doc(`dialerSessions/${sessionId}`);
  const callRef = db.doc(`calls/${callId}`);
  const result = await db.runTransaction(async transaction => {
    const [sessionSnapshot, callSnapshot] = await Promise.all([
      transaction.get(sessionRef), transaction.get(callRef)
    ]);
    if (!sessionSnapshot.exists || !callSnapshot.exists) return { started: false, reason: 'missing_record' };
    const session = sessionSnapshot.data();
    const call = callSnapshot.data();
    if (session.userUid !== repUid) return { started: false, reason: 'wrong_rep' };
    if (session.status !== 'active') return { started: false, reason: `session_${session.status}` };
    if (!handoffAllowed(call)) return { started: false, reason: 'handoff_not_authorized' };
    if (control(call).controller !== 'ai') return { started: false, reason: 'call_not_ai_controlled' };

    const currentRep = rep(session);
    if (currentRep.activeCallId && currentRep.activeCallId !== callId) {
      transaction.set(callRef, { handoff: { ...call.handoff, state: 'queued' } }, { merge: true });
      return { started: false, reason: 'rep_busy', queued: true };
    }
    if (!['available', 'listening'].includes(currentRep.state) && currentRep.activeCallId !== callId) {
      transaction.set(callRef, { handoff: { ...call.handoff, state: 'queued' } }, { merge: true });
      return { started: false, reason: `rep_${currentRep.state}`, queued: true };
    }

    const stamp = timestamp(now);
    const current = control(call);
    transaction.set(sessionRef, {
      rep: { state: 'transitioning', activeCallId: callId, listeningCallId: '' },
      lastHeartbeatAt: stamp
    }, { merge: true });
    transaction.set(callRef, {
      control: {
        controller: 'transitioning', repUid: clean(repUid, 160), aiSessionId: current.aiSessionId,
        changedAt: stamp, revision: current.revision + 1
      },
      handoff: { ...call.handoff, state: 'announcing' },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { started: true, reason: 'reserved' };
  });

  if (result.started) await audit(db, 'handoff_announcing', { callId, sessionId, actorType: 'rep', actorId: repUid, now });
  return result;
}

/** Mark the media-layer handoff complete after the human participant is confirmed. */
export async function completeSmoothHandoff(db, sessionId, callId, {
  repUid, humanParticipantSid = '', now = new Date()
} = {}) {
  const sessionRef = db.doc(`dialerSessions/${sessionId}`);
  const callRef = db.doc(`calls/${callId}`);
  const result = await db.runTransaction(async transaction => {
    const [sessionSnapshot, callSnapshot] = await Promise.all([
      transaction.get(sessionRef), transaction.get(callRef)
    ]);
    if (!sessionSnapshot.exists || !callSnapshot.exists) return { ok: false, reason: 'missing_record' };
    const session = sessionSnapshot.data();
    const call = callSnapshot.data();
    if (session.userUid !== repUid) return { ok: false, reason: 'wrong_rep' };
    if (session?.rep?.activeCallId !== callId) return { ok: false, reason: 'rep_not_reserved' };
    if (control(call).controller === 'human') return { ok: true, idempotent: true };
    if (control(call).controller !== 'transitioning') return { ok: false, reason: 'not_transitioning' };

    const stamp = timestamp(now);
    const current = control(call);
    transaction.set(callRef, {
      operator: 'human',
      humanHandled: true,
      control: {
        controller: 'human', repUid: clean(repUid, 160), aiSessionId: '',
        changedAt: stamp, revision: current.revision + 1
      },
      handoff: { ...call.handoff, state: 'completed', completedAt: stamp },
      media: { ...(call.media || {}), humanParticipantSid: clean(humanParticipantSid, 200), aiParticipantSid: '' },
      humanJoinedAt: stamp,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(sessionRef, {
      rep: { state: 'busy', activeCallId: callId, listeningCallId: '' },
      lastHeartbeatAt: stamp
    }, { merge: true });
    return { ok: true, idempotent: false };
  });

  if (result.ok && !result.idempotent) await audit(db, 'handoff_completed', { callId, sessionId, actorType: 'rep', actorId: repUid, now });
  return result;
}

/** Restore AI control after a failed handoff so the prospect is not stranded. */
export async function failSmoothHandoff(db, sessionId, callId, {
  repUid = '', reason = 'media_failure', now = new Date()
} = {}) {
  const sessionRef = db.doc(`dialerSessions/${sessionId}`);
  const callRef = db.doc(`calls/${callId}`);
  await db.runTransaction(async transaction => {
    const [sessionSnapshot, callSnapshot] = await Promise.all([
      transaction.get(sessionRef), transaction.get(callRef)
    ]);
    if (!sessionSnapshot.exists || !callSnapshot.exists) return;
    const call = callSnapshot.data();
    const current = control(call);
    if (current.controller !== 'transitioning') return;
    const stamp = timestamp(now);
    transaction.set(callRef, {
      operator: 'ai',
      aiHandled: true,
      control: {
        controller: 'ai', repUid: '', aiSessionId: current.aiSessionId,
        changedAt: stamp, revision: current.revision + 1
      },
      handoff: { ...call.handoff, state: 'failed', failureReason: clean(reason, 160) },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (sessionSnapshot.get('rep.activeCallId') === callId) {
      transaction.set(sessionRef, { rep: { state: 'available', activeCallId: '', listeningCallId: '' } }, { merge: true });
    }
  });
  await audit(db, 'handoff_failed', { callId, sessionId, actorType: 'system', actorId: repUid, metadata: { reason }, now });
  return { ok: true };
}

export async function setListenState(db, sessionId, callId, {
  repUid, listening, now = new Date()
} = {}) {
  const sessionRef = db.doc(`dialerSessions/${sessionId}`);
  const callRef = db.doc(`calls/${callId}`);
  const result = await db.runTransaction(async transaction => {
    const [sessionSnapshot, callSnapshot] = await Promise.all([
      transaction.get(sessionRef), transaction.get(callRef)
    ]);
    if (!sessionSnapshot.exists || !callSnapshot.exists) return { ok: false, reason: 'missing_record' };
    const session = sessionSnapshot.data();
    const call = callSnapshot.data();
    if (session.userUid !== repUid) return { ok: false, reason: 'wrong_rep' };
    if (control(call).controller !== 'ai') return { ok: false, reason: 'call_not_ai_controlled' };
    const currentRep = rep(session);
    if (listening && currentRep.activeCallId) return { ok: false, reason: 'rep_busy' };
    if (listening && currentRep.listeningCallId && currentRep.listeningCallId !== callId) return { ok: false, reason: 'already_listening' };

    transaction.set(sessionRef, {
      rep: listening
        ? { state: 'listening', activeCallId: '', listeningCallId: callId }
        : { state: 'available', activeCallId: '', listeningCallId: '' },
      lastHeartbeatAt: timestamp(now)
    }, { merge: true });
    return { ok: true };
  });
  if (result.ok) await audit(db, listening ? 'listen_started' : 'listen_stopped', {
    callId, sessionId, actorType: 'rep', actorId: repUid, now
  });
  return result;
}

/** Release rep ownership when a human-controlled call ends. */
export async function releaseRepFromCall(db, sessionId, callId, {
  repUid = '', now = new Date()
} = {}) {
  const ref = db.doc(`dialerSessions/${sessionId}`);
  const result = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { released: false, reason: 'session_missing' };
    const session = snapshot.data();
    if (repUid && session.userUid !== repUid) return { released: false, reason: 'wrong_rep' };
    if (session?.rep?.activeCallId && session.rep.activeCallId !== callId) {
      return { released: false, reason: 'different_active_call' };
    }
    transaction.set(ref, {
      rep: { state: 'available', activeCallId: '', listeningCallId: '' },
      lastHeartbeatAt: timestamp(now)
    }, { merge: true });
    return { released: true, autoTakeover: session?.takeover?.autoEnabled === true };
  });
  if (result.released) await audit(db, 'rep_released', { callId, sessionId, actorType: 'rep', actorId: repUid, now });
  return result;
}

/** Load only the session's already-known calls; avoids a new compound index. */
export async function nextAutoTakeoverCall(db, sessionId) {
  const snapshot = await db.doc(`dialerSessions/${sessionId}`).get();
  if (!snapshot.exists || snapshot.get('takeover.autoEnabled') !== true) return null;
  const ids = (snapshot.get('activeCallIds') || []).slice(0, 50);
  const calls = [];
  for (const id of ids) {
    const callSnapshot = await db.doc(`calls/${id}`).get();
    if (callSnapshot.exists) calls.push({ id, ...callSnapshot.data() });
  }
  return selectAuthorizedAutoTakeover(calls);
}

export { audit as recordCallAuditEvent };
