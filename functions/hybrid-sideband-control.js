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
import { sanitizeRealtimeSessionConfig } from './agent-runtime.js';
import { executeAgentTool, TERMINAL_TOOLS } from './agent-tools.js';
import { createGoogleCalendarClient, loadCalendarSettings } from './booking-calendar.js';
import { LEGACY_ACCOUNT_ID, readAccountId } from './accounts.js';

const AI_MEDIA_WEBHOOK_SECRET = defineSecret('AI_MEDIA_WEBHOOK_SECRET');
const GOOGLE_CALENDAR_CREDENTIALS = defineSecret('GOOGLE_CALENDAR_CREDENTIALS');

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

/**
 * Google Calendar client for this invocation, or null when the calendar has
 * not been connected. Booking works either way: Firestore is the book of
 * record and Google is the mirror.
 */
async function calendarClient(db, accountId) {
  const account = readAccountId(accountId, { fallback: LEGACY_ACCOUNT_ID });
  const settings = await loadCalendarSettings(db, account).catch(() => null);
  if (!settings || settings.googleSyncEnabled === false) return null;
  return createGoogleCalendarClient({
    credentialsJson: secretValue(GOOGLE_CALENDAR_CREDENTIALS),
    calendarId: settings.googleCalendarId,
    impersonate: settings.googleImpersonate
  });
}

export const DEFAULT_HANDOFF_PHRASE =
  'I’m going to bring a member of our team into the conversation now.';

/**
 * Every controller a call can be under. Bounded as an enum rather than with
 * `clean()`, which exists to scrub imported contact data and so maps the
 * literal string 'none' to '' — correct for a scraped company name, wrong here,
 * where 'none' is a real state meaning the call has no operator and the AI leg
 * must be torn down. Routing that value through the scrubber silently deleted
 * the signal, and the sideband's `controller === 'none'` hangup never fired.
 */
const CALL_CONTROLLERS = new Set(['ai', 'human', 'transitioning', 'none', 'unassigned']);

const controllerState = value => {
  const out = typeof value === 'string' ? value.trim() : '';
  return CALL_CONTROLLERS.has(out) ? out : '';
};

/**
 * What the sideband polls for, every 500ms, for the whole length of every AI
 * call — so each document read here is billed 7,200 times per call-hour, per
 * concurrent call. It is the hottest read path in the system and the one worth
 * keeping honest.
 *
 * The sideband acts on exactly three values: the controller, the handoff state,
 * and the phrase to speak. The first two live on the call document, which the
 * caller has already loaded. This used to additionally read the dialer session
 * — purely to return a `rep` block that nothing on the receiving end ever
 * looked at — and the media job, for a phrase that only matters on the single
 * tick where a handoff is being announced. Both are now off the steady-state
 * path, taking the poll from three document reads to one.
 *
 * Handoff timing is deliberately untouched: a takeover or an opt-out is still
 * observed on the very next tick, from the same freshly-read call document as
 * before. Only reads nothing acted on were removed.
 */
export async function pollControlPayload(db, { callId, call }) {
  const state = clean(call?.handoff?.state, 40);
  // The phrase is read fresh at the moment it is about to be spoken, so a
  // late edit to the compiled runtime still reaches the caller's ear.
  const phrase = state === 'announcing'
    ? clean((await db.doc(`aiMediaJobs/${callId}`).get()).get('runtime.handoffPhrase'), 500)
      || DEFAULT_HANDOFF_PHRASE
    : '';
  return {
    ok: true,
    controller: controllerState(call?.control?.controller),
    handoff: { state, requestedBy: clean(call?.handoff?.requestedBy, 40), phrase }
  };
}

export const hybridSidebandControl = onRequest(
  {
    secrets: [AI_MEDIA_WEBHOOK_SECRET, GOOGLE_CALENDAR_CREDENTIALS],
    maxInstances: 50,
    timeoutSeconds: 60
  },
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
          model: clean(runtime.model, 120) || 'gpt-realtime-2.1',
          voice: clean(runtime.voice, 120) || 'marin',
          sessionConfig: sanitizeRealtimeSessionConfig(runtime.sessionConfig, clean(runtime.voice, 120) || 'marin'),
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
      res.json(await pollControlPayload(db, { callId, call }));
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

    // Single authorization path for every tool the agent can call. The media
    // service names a tool; this endpoint decides whether that call was ever
    // granted, by re-reading the compiled runtime rather than believing the
    // caller. See agent-tools.js.
    if (action === 'agent_tool') {
      const jobSnapshot = await db.doc(`aiMediaJobs/${callId}`).get();
      if (!jobSnapshot.exists) { res.status(404).json({ error: 'media-job-not-found' }); return; }
      const tool = clean(req.body?.tool, 80);
      if (!tool) { res.status(400).json({ error: 'tool-required' }); return; }

      const result = await executeAgentTool(db, {
        call,
        job: jobSnapshot.data() || {},
        tool,
        args: req.body?.args,
        actorId: clean(req.body?.realtimeCallId, 160) || 'ai',
        google: await calendarClient(db, call.accountId).catch(() => null)
      }).catch(error => {
        console.error('[sideband-control] tool execution failed', tool, error);
        return { ok: false, error: 'server_action_failed' };
      });

      // The model decides what to say; the service needs to know whether to
      // wind the call down after saying it.
      res.json({ ...result, endsCall: result?.ending === true || TERMINAL_TOOLS.includes(tool) });
      return;
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
