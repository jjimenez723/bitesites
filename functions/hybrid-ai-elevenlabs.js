// The endpoints ElevenLabs calls during an AI phone call, and the trigger that
// carries out a handoff. The flow is described in live-call-elevenlabs.js.
//
// Every endpoint fails closed: a missing secret, a call that is not ours, or a
// conversation that does not match the one attached to the call is refused,
// and an AI that cannot be attached ends the prospect's call rather than
// leaving them on a silent line.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import { attachAIController, recordCallAuditEvent } from './hybrid-call-orchestration.js';
import { clean } from './prospect-normalization.js';
import { executeAgentTool, TERMINAL_TOOLS } from './agent-tools.js';
import { createGoogleCalendarClient, loadCalendarSettings } from './booking-calendar.js';
import { LEGACY_ACCOUNT_ID, readAccountId } from './accounts.js';
import {
  callIdFromInitiation, initiationResponse, liveCallVoiceId, LIVE_CALL_TTS_MODEL,
  parseToolRequest, toolReply, toolRequestId, transcriptTurns, verifyElevenLabsSignature, CALL_ID_VARIABLE
} from './live-call-elevenlabs.js';
import { LIVE_CALL_AGENT_IDS } from './live-call-agent-ids.js';
import {
  endProspectLeg, publicUrl, secretValue, terminateFailedAIMedia, twilioPost, twilioSignatureValid, TWILIO_SECRETS
} from './hybrid-ai-sip-dispatch.js';

const AI_MEDIA_WEBHOOK_SECRET = defineSecret('AI_MEDIA_WEBHOOK_SECRET');
const ELEVENLABS_API_KEY = defineSecret('ELEVENLABS_API_KEY');
const ELEVENLABS_WEBHOOK_SECRET = defineSecret('ELEVENLABS_WEBHOOK_SECRET');
const GOOGLE_CALENDAR_CREDENTIALS = defineSecret('GOOGLE_CALENDAR_CREDENTIALS');
const [, TWILIO_AUTH_TOKEN] = TWILIO_SECRETS;

const ATTACHABLE = new Set(['dispatching', 'sip_dialing', 'sip_connected']);

function mediaSecretOk(req) {
  const expected = clean(secretValue(AI_MEDIA_WEBHOOK_SECRET), 300);
  const provided = clean(req.get('x-ai-media-secret'), 300);
  return expected.length >= 24 && provided.length === expected.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/** A short signature so only Twilio, given our announcement TwiML, can fetch the audio. */
const audioToken = callId => createHmac('sha256', secretValue(AI_MEDIA_WEBHOOK_SECRET))
  .update(`handoff-audio:${callId}`).digest('hex').slice(0, 32);

async function calendarClient(db, accountId) {
  const account = readAccountId(accountId, { fallback: LEGACY_ACCOUNT_ID });
  const settings = await loadCalendarSettings(db, account).catch(() => null);
  if (!settings || settings.googleSyncEnabled === false) return null;
  return createGoogleCalendarClient({
    credentialsJson: secretValue(GOOGLE_CALENDAR_CREDENTIALS),
    calendarId: settings.googleCalendarId,
    impersonate: settings.googleImpersonate,
    busyCalendarIds: settings.busyCalendarIds
  });
}

/**
 * ElevenLabs asks for this call's settings the moment our SIP leg reaches it.
 * This is where the AI becomes the call's controller, so a refusal here means
 * the AI never speaks and the prospect's leg is ended.
 */
export const hybridAICallInit = onRequest(
  { secrets: [AI_MEDIA_WEBHOOK_SECRET, ...TWILIO_SECRETS], maxInstances: 50, timeoutSeconds: 20 },
  async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return; }
    if (!mediaSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!LIVE_CALL_AGENT_IDS.agent || clean(req.body?.agent_id, 120) !== LIVE_CALL_AGENT_IDS.agent) {
      res.status(403).json({ error: 'unknown-agent' }); return;
    }
    const callId = callIdFromInitiation(req.body);
    const conversationId = clean(req.body?.conversation_id, 240);
    if (!callId || !conversationId) { res.status(400).json({ error: 'missing-call-identifiers' }); return; }

    const db = getFirestore();
    const [jobSnapshot, callSnapshot] = await Promise.all([
      db.doc(`aiMediaJobs/${callId}`).get(), db.doc(`calls/${callId}`).get()
    ]);
    if (!jobSnapshot.exists || !callSnapshot.exists) { res.status(404).json({ error: 'call-not-found' }); return; }
    const job = jobSnapshot.data() || {};
    const call = callSnapshot.data() || {};

    // A retried webhook for the conversation already attached gets the same answer.
    if (job.status === 'active' && job.conversationId === conversationId) {
      res.json(initiationResponse({ callId, runtime: job.runtime })); return;
    }
    if (!ATTACHABLE.has(clean(job.status, 40)) || call?.control?.controller !== 'ai') {
      // A late invite after the deadline worker ended the call must not bring the AI back.
      res.status(409).json({ error: 'ai-media-not-attachable' }); return;
    }

    let response;
    try {
      response = initiationResponse({ callId, runtime: job.runtime });
      const attached = await attachAIController(db, callId, conversationId, {
        model: 'elevenlabs', voice: liveCallVoiceId(job.runtime?.voice),
        profileId: call?.agent?.profileId, profileVersion: call?.agent?.profileVersion,
        effectiveConfigHash: call?.agent?.effectiveConfigHash
      });
      if (attached && attached.ok === false) throw new Error(clean(attached.reason, 200) || 'attach refused');
    } catch (error) {
      await terminateFailedAIMedia(db, callId, {
        reason: `elevenlabs_attach_failed: ${clean(error?.message, 220) || 'unknown'}`, source: 'elevenlabs_init'
      });
      res.status(409).json({ error: 'ai-attach-failed', safelyEnded: true }); return;
    }

    await db.doc(`aiMediaJobs/${callId}`).set({
      status: 'active', conversationId, aiSessionId: conversationId, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await db.doc(`calls/${callId}`).set({
      'media.attachState': 'active', 'media.attachedAt': FieldValue.serverTimestamp(),
      'media.aiConversationId': conversationId, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    res.json(response);
  }
);

/**
 * The single path for every tool the phone agent calls. The agent names a
 * tool; executeAgentTool decides whether this call was ever granted it.
 */
export const hybridAITools = onRequest(
  { secrets: [AI_MEDIA_WEBHOOK_SECRET, GOOGLE_CALENDAR_CREDENTIALS, ...TWILIO_SECRETS], maxInstances: 50, timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return; }
    if (!mediaSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const { callId, conversationId, tool, args } = parseToolRequest(req.body);
    if (!callId || !conversationId || !tool) { res.status(400).json({ ok: false, error: 'missing-fields' }); return; }

    const db = getFirestore();
    const [jobSnapshot, callSnapshot] = await Promise.all([
      db.doc(`aiMediaJobs/${callId}`).get(), db.doc(`calls/${callId}`).get()
    ]);
    const job = jobSnapshot.data() || {};
    // The conversation must be the one this call attached, so one call's
    // agent can never act on another call.
    if (!jobSnapshot.exists || !callSnapshot.exists || job.conversationId !== conversationId) {
      res.status(403).json({ ok: false, error: 'not-this-call' }); return;
    }
    const call = { id: callId, ...callSnapshot.data() };

    const result = await executeAgentTool(db, {
      call, job, tool, args,
      requestId: toolRequestId({ conversationId, tool, args }),
      actorId: conversationId,
      google: await calendarClient(db, call.accountId).catch(() => null)
    }).catch(error => {
      console.error('[live-call] tool execution failed', tool, error);
      return { ok: false, error: 'server_action_failed' };
    });

    if (tool === 'mark_do_not_call' && result?.ok !== false && call.providerCallId) {
      // An opt-out is an immediate stop, not a cue for one more sentence.
      await endProspectLeg(db, callId, call.providerCallId, 'explicit_do_not_call');
      await recordCallAuditEvent(db, 'call_end_requested', {
        callId, sessionId: call.sessionId, campaignId: call.campaignId,
        actorType: 'ai', actorId: conversationId, metadata: { reason: 'explicit_do_not_call' }
      });
    }
    const endsCall = result?.ending === true || TERMINAL_TOOLS.includes(tool);
    res.json(toolReply(result || { ok: false }, { endsCall: endsCall && tool !== 'mark_do_not_call' }));
  }
);

/** Store the transcript once the call is over. Signed by ElevenLabs. */
export const hybridAIPostCall = onRequest(
  { secrets: [ELEVENLABS_WEBHOOK_SECRET], maxInstances: 20, timeoutSeconds: 60 },
  async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return; }
    if (!verifyElevenLabsSignature(req.rawBody, req.get('elevenlabs-signature'), secretValue(ELEVENLABS_WEBHOOK_SECRET))) {
      res.status(401).json({ error: 'unauthorized' }); return;
    }
    const type = clean(req.body?.type, 60);
    const data = req.body?.data || {};
    if (type !== 'post_call_transcription' || data.agent_id !== LIVE_CALL_AGENT_IDS.agent) {
      res.json({ ok: true, ignored: true }); return;
    }
    const callId = clean(data?.conversation_initiation_client_data?.dynamic_variables?.[CALL_ID_VARIABLE], 200);
    const db = getFirestore();
    const jobSnapshot = callId ? await db.doc(`aiMediaJobs/${callId}`).get() : null;
    if (!jobSnapshot?.exists || jobSnapshot.get('conversationId') !== clean(data.conversation_id, 240)) {
      res.json({ ok: true, ignored: true }); return;
    }

    const batch = db.batch();
    for (const turn of transcriptTurns(data)) {
      batch.set(db.doc(`calls/${callId}/turns/${String(turn.sequence).padStart(6, '0')}`), {
        sequence: turn.sequence, speaker: turn.speaker, text: turn.text, final: true,
        startedAt: turn.startedAt ? Timestamp.fromDate(turn.startedAt) : null,
        source: 'elevenlabs_post_call', createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    batch.set(db.doc(`aiMediaJobs/${callId}`), {
      transcriptStoredAt: FieldValue.serverTimestamp(),
      elevenLabs: {
        durationSecs: Math.max(0, Number(data?.metadata?.call_duration_secs) || 0),
        terminationReason: clean(data?.metadata?.termination_reason, 200)
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await batch.commit();
    res.json({ ok: true });
  }
);

/**
 * Handoffs are carried out on the carrier, because ElevenLabs offers no way for
 * our server to speak into a live call. When a handoff starts announcing, the
 * AI is muted and Twilio plays the handoff line, in the agent's own voice, to
 * the conference. When a person takes the call, or nobody owns it any more,
 * the AI's leg is ended.
 */
export const hybridAIHandoffCarrier = onDocumentUpdated(
  { document: 'calls/{callId}', secrets: [AI_MEDIA_WEBHOOK_SECRET, ...TWILIO_SECRETS], maxInstances: 50, timeoutSeconds: 30 },
  async event => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    const aiLeg = clean(after?.media?.aiParticipantSid, 200);
    if (!aiLeg) return;
    const callId = clean(event.params.callId, 200);
    const db = getFirestore();
    const conferenceSid = clean(after?.media?.conferenceSid, 200);

    if (after?.handoff?.state === 'announcing' && before?.handoff?.state !== 'announcing') {
      try {
        if (!conferenceSid) throw new Error('conference not known');
        await twilioPost(`/Conferences/${encodeURIComponent(conferenceSid)}/Participants/${encodeURIComponent(aiLeg)}.json`, { Muted: 'true' });
        await twilioPost(`/Conferences/${encodeURIComponent(conferenceSid)}.json`, {
          AnnounceUrl: `${publicUrl()}/api/hybrid-ai-handoff-announcement?callId=${encodeURIComponent(callId)}`,
          AnnounceMethod: 'POST'
        });
      } catch (error) {
        console.warn('[live-call] handoff announcement failed; continuing the handoff', callId, error?.message);
      }
      // The rep joins while the line plays. Waiting for the end of the audio
      // would leave the prospect with nobody if the announcement failed.
      const callRef = db.doc(`calls/${callId}`);
      const moved = await db.runTransaction(async tx => {
        const fresh = (await tx.get(callRef)).data() || {};
        if (fresh?.control?.controller !== 'transitioning' || fresh?.handoff?.state !== 'announcing') return false;
        tx.set(callRef, {
          handoff: { ...fresh.handoff, state: 'joining_human', announcementCompletedAt: FieldValue.serverTimestamp() },
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return true;
      });
      if (moved) {
        await recordCallAuditEvent(db, 'handoff_announcement_completed', {
          callId, sessionId: after.sessionId, campaignId: after.campaignId, actorType: 'system', actorId: 'carrier'
        });
      }
      return;
    }

    const controller = after?.control?.controller;
    const aiWasInvolved = ['ai', 'transitioning'].includes(before?.control?.controller);
    if (aiWasInvolved && ['human', 'none'].includes(controller)) {
      const jobRef = db.doc(`aiMediaJobs/${callId}`);
      const job = (await jobRef.get()).data() || {};
      if (['ended', 'failed'].includes(job.status) || job.endRequestedBy === 'server') return;
      await jobRef.set({ endRequestedBy: 'server', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await twilioPost(`/Calls/${encodeURIComponent(aiLeg)}.json`, { Status: 'completed' })
        .catch(error => console.warn('[live-call] could not end the AI leg', callId, error?.message));
    }
  }
);

/** TwiML Twilio fetches for the handoff announcement. */
export const hybridAIHandoffAnnouncement = onRequest(
  { secrets: [AI_MEDIA_WEBHOOK_SECRET, ...TWILIO_SECRETS], maxInstances: 30 },
  async (req, res) => {
    if (!twilioSignatureValid(req, secretValue(TWILIO_AUTH_TOKEN))) {
      res.status(401).type('text/plain').send('unauthorized'); return;
    }
    const callId = clean(req.query?.callId, 200);
    if (!/^[A-Za-z0-9_-]+$/.test(callId)) { res.status(400).type('text/plain').send('missing callId'); return; }
    const audio = `${publicUrl()}/api/hybrid-ai-handoff-audio?callId=${encodeURIComponent(callId)}&token=${audioToken(callId)}`;
    res.status(200).type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${audio.replace(/&/g, '&amp;')}</Play></Response>`
    );
  }
);

/** The handoff line in the agent's own ElevenLabs voice. */
export const hybridAIHandoffAudio = onRequest(
  { secrets: [AI_MEDIA_WEBHOOK_SECRET, ELEVENLABS_API_KEY], maxInstances: 30, timeoutSeconds: 30 },
  async (req, res) => {
    const callId = clean(req.query?.callId, 200);
    const token = clean(req.query?.token, 64);
    const expected = callId ? audioToken(callId) : '';
    if (!expected || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      res.status(401).type('text/plain').send('unauthorized'); return;
    }
    const job = (await getFirestore().doc(`aiMediaJobs/${callId}`).get()).data() || {};
    const text = clean(job?.runtime?.handoffPhrase, 500)
      || 'I’m going to bring a member of our team into the conversation now.';
    const voiceId = liveCallVoiceId(job?.runtime?.elevenLabsVoiceId || job?.runtime?.voice);
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: { 'xi-api-key': secretValue(ELEVENLABS_API_KEY), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: LIVE_CALL_TTS_MODEL }),
        signal: AbortSignal.timeout(10_000)
      }
    ).catch(() => null);
    if (!response?.ok) { res.status(502).type('text/plain').send('audio unavailable'); return; }
    res.status(200).set('Cache-Control', 'no-store').type('audio/mpeg').send(Buffer.from(await response.arrayBuffer()));
  }
);
