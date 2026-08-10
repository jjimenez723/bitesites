// Internal control surface for the Realtime sideband service.
//
// The Cloud Run sideband has no broad Firestore credential. It receives one
// high-entropy shared secret and can perform only these bounded, auditable
// actions. This keeps transcripts/tools/handoffs behind the same Firebase-owned
// invariants as the browser dialer.

import { timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import {
  attachAIController,
  beginSmoothHandoff,
  requestHumanHandoff,
  recordCallAuditEvent
} from './hybrid-call-orchestration.js';
import { markDoNotCall } from './outbound-calls.js';
import { clean } from './prospect-normalization.js';

const AI_MEDIA_WEBHOOK_SECRET = defineSecret('AI_MEDIA_WEBHOOK_SECRET');

const secretValue = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};

function authorized(req) {
  const expected = clean(secretValue(AI_MEDIA_WEBHOOK_SECRET), 300);
  const provided = clean(req.get('x-ai-media-secret'), 300);
  return expected.length >= 24 && provided.length === expected.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

const validCallId = value => {
  const result = clean(value, 200);
  return /^[A-Za-z0-9_-]+$/.test(result) ? result : '';
};

function safeTimestamp(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? Timestamp.fromDate(date) : null;
}

export const hybridSidebandControl = onRequest(
  { secrets: [AI_MEDIA_WEBHOOK_SECRET], maxInstances: 50, timeoutSeconds: 60 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return;
    }
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }

    const db = getFirestore();
    const callId = validCallId(req.body?.callId);
    if (!callId) { res.status(400).json({ error: 'callId-required' }); return; }
    const callRef = db.doc(`calls/${callId}`);
    const callSnapshot = await callRef.get();
    if (!callSnapshot.exists) { res.status(404).json({ error: 'call-not-found' }); return; }
    const call = { id: callId, ...callSnapshot.data() };
    const action = clean(req.body?.action, 60);

    if (action === 'prepare') {
      const jobSnapshot = await db.doc(`aiMediaJobs/${callId}`).get();
      if (!jobSnapshot.exists) { res.status(404).json({ error: 'media-job-not-found' }); return; }
      const job = jobSnapshot.data() || {};
      if (!['dispatching', 'sip_dialing', 'sip_connected', 'accepted', 'active'].includes(job.status)) {
        res.status(409).json({ error: 'media-job-not-ready', status: job.status || 'unknown' }); return;
      }
      const runtime = job.runtime || {};
      res.json({
        ok: true,
        callId,
        sessionId: clean(call.sessionId, 200),
        campaignId: clean(call.campaignId, 200),
        runtime: {
          model: clean(runtime.model, 120) || 'gpt-realtime',
          voice: clean(runtime.voice, 120) || 'marin',
          instructions: clean(runtime.instructions, 30000),
          tools: Array.isArray(runtime.tools) ? runtime.tools.slice(0, 30).map(value => clean(value, 80)).filter(Boolean) : [],
          handoffPhrase: clean(runtime.handoffPhrase, 500) || 'I’m going to bring a member of our team into the conversation now.',
          profileId: clean(runtime.profileId, 200),
          profileVersion: Math.max(0, Number(runtime.profileVersion) || 0),
          effectiveConfigHash: clean(runtime.effectiveConfigHash, 128)
        }
      });
      return;
    }

    if (action === 'attached') {
      const realtimeCallId = clean(req.body?.realtimeCallId, 240);
      if (!realtimeCallId) { res.status(400).json({ error: 'realtimeCallId-required' }); return; }
      const result = await attachAIController(db, callId, realtimeCallId, {
        model: req.body?.model,
        voice: req.body?.voice,
        profileId: call?.agent?.profileId,
        profileVersion: call?.agent?.profileVersion,
        effectiveConfigHash: call?.agent?.effectiveConfigHash
      }).catch(error => ({ ok: false, reason: clean(error?.message, 300) }));
      if (!result.ok) { res.status(409).json(result); return; }
      await db.doc(`aiMediaJobs/${callId}`).set({
        status: 'active', realtimeCallId, aiSessionId: realtimeCallId,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      res.json({ ok: true }); return;
    }

    if (action === 'poll_control') {
      const sessionSnapshot = await db.doc(`dialerSessions/${call.sessionId}`).get();
      const jobSnapshot = await db.doc(`aiMediaJobs/${callId}`).get();
      res.json({
        ok: true,
        controller: clean(call?.control?.controller, 40),
        handoff: {
          state: clean(call?.handoff?.state, 40),
          requestedBy: clean(call?.handoff?.requestedBy, 40),
          phrase: clean(jobSnapshot.get('runtime.handoffPhrase'), 500)
            || 'I’m going to bring a member of our team into the conversation now.'
        },
        rep: sessionSnapshot.exists ? {
          state: clean(sessionSnapshot.get('rep.state'), 40),
          activeCallId: clean(sessionSnapshot.get('rep.activeCallId'), 200),
          uid: clean(sessionSnapshot.get('userUid'), 160)
        } : null
      });
      return;
    }

    if (action === 'handoff_phrase_spoken') {
      const result = await db.runTransaction(async tx => {
        const fresh = await tx.get(callRef);
        if (!fresh.exists) return { ok: false, reason: 'call_missing' };
        const data = fresh.data();
        if (data?.control?.controller !== 'transitioning') return { ok: false, reason: 'not_transitioning' };
        if (data?.handoff?.state === 'joining_human') return { ok: true, idempotent: true };
        if (data?.handoff?.state !== 'announcing') return { ok: false, reason: `handoff_${clean(data?.handoff?.state, 40)}` };
        tx.set(callRef, {
          handoff: { ...data.handoff, state: 'joining_human', announcementCompletedAt: FieldValue.serverTimestamp() },
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return { ok: true, idempotent: false };
      });
      if (result.ok && !result.idempotent) {
        await recordCallAuditEvent(db, 'handoff_announcement_completed', {
          callId, sessionId: call.sessionId, campaignId: call.campaignId,
          actorType: 'ai', actorId: clean(req.body?.realtimeCallId, 160)
        });
      }
      res.status(result.ok ? 200 : 409).json(result); return;
    }

    if (action === 'transcript') {
      const speaker = ['prospect', 'ai', 'human', 'system'].includes(req.body?.speaker)
        ? req.body.speaker : 'system';
      const text = clean(req.body?.text, 4000);
      if (!text) { res.status(400).json({ error: 'text-required' }); return; }
      const sequence = Math.max(0, Number(req.body?.sequence) || Date.now());
      const turnId = String(sequence).padStart(16, '0').slice(-20);
      await db.doc(`calls/${callId}/turns/${turnId}`).set({
        sequence, speaker, text, final: req.body?.final !== false,
        modelEventId: clean(req.body?.modelEventId, 200),
        startedAt: safeTimestamp(req.body?.startedAt),
        endedAt: safeTimestamp(req.body?.endedAt),
        createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
      res.json({ ok: true, turnId }); return;
    }

    if (action === 'prospect_requested_human') {
      const requested = await requestHumanHandoff(db, callId, {
        requestedBy: 'prospect', actorId: clean(req.body?.realtimeCallId, 160) || 'ai'
      }).catch(error => ({ ok: false, reason: clean(error?.message, 300) }));
      if (!requested.ok) { res.status(409).json(requested); return; }
      const sessionSnapshot = await db.doc(`dialerSessions/${call.sessionId}`).get();
      const autoEnabled = sessionSnapshot.get('takeover.autoEnabled') === true;
      const repState = sessionSnapshot.get('rep.state');
      const repFree = !sessionSnapshot.get('rep.activeCallId') && ['available', 'listening', undefined].includes(repState);
      let handoff = null;
      if (autoEnabled && repFree) {
        handoff = await beginSmoothHandoff(db, call.sessionId, callId, {
          repUid: sessionSnapshot.get('userUid')
        }).catch(error => ({ started: false, reason: clean(error?.message, 300) }));
      }
      res.json({ ok: true, requested, autoEnabled, repFree, handoff }); return;
    }

    if (action === 'do_not_call') {
      await markDoNotCall(db, call.targetId, { actor: clean(req.body?.realtimeCallId, 160) || 'ai' });
      await recordCallAuditEvent(db, 'dnc_marked', {
        callId, sessionId: call.sessionId, campaignId: call.campaignId,
        actorType: 'ai', actorId: clean(req.body?.realtimeCallId, 160)
      });
      res.json({ ok: true }); return;
    }

    if (action === 'agent_signal') {
      const signalType = clean(req.body?.signalType, 60);
      const value = clean(req.body?.value, 500);
      if (!signalType) { res.status(400).json({ error: 'signalType-required' }); return; }
      await recordCallAuditEvent(db, 'ai_signal', {
        callId, sessionId: call.sessionId, campaignId: call.campaignId,
        actorType: 'ai', actorId: clean(req.body?.realtimeCallId, 160),
        metadata: { signalType, value }
      });
      res.json({ ok: true }); return;
    }

    res.status(400).json({ error: 'unknown-action' });
  }
);
