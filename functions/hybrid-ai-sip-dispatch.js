// Hybrid Dialer V2 — attach one isolated ElevenLabs agent participant to every
// AI-controlled Twilio conference.
//
// Firebase remains the control plane: Firestore says a call needs AI, this
// trigger claims that job exactly once, and Twilio dials the ElevenLabs SIP
// endpoint. ElevenLabs carries the media; no long-lived audio socket is kept
// inside a Firebase Function. See live-call-elevenlabs.js for the whole path.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import { clean } from './prospect-normalization.js';
import {
  AI_MEDIA_ATTACH_PENDING, failClosedAIMediaAttachment, isAIMediaAttachExpired
} from './hybrid-media-failsafe.js';
import { externalDialingAdmission } from './deployment-environment.js';
import { liveCallSipUri, transcriptTurns } from './live-call-elevenlabs.js';
import { LIVE_CALL_AGENT_IDS } from './live-call-agent-ids.js';

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
// The password Twilio uses to authenticate to our ElevenLabs SIP trunk.
const ELEVENLABS_SIP_PASSWORD = defineSecret('ELEVENLABS_SIP_PASSWORD');
const ELEVENLABS_API_KEY = defineSecret('ELEVENLABS_API_KEY');
// Give up on a transcript ElevenLabs still has not finished after this long.
const TRANSCRIPT_WAIT_MS = 30 * 60 * 1000;
const PUBLIC_APP_URL = defineString('PUBLIC_APP_URL', { default: 'https://bitesites.org' });

const secrets = [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ELEVENLABS_SIP_PASSWORD];
export const TWILIO_SECRETS = [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN];
const API_BASE = 'https://api.twilio.com/2010-04-01';

export const secretValue = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};

const xml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const publicUrl = () => String(PUBLIC_APP_URL.value() || 'https://bitesites.org').replace(/\/$/, '');

export function twilioSignatureValid(req, authToken) {
  const signature = String(req.get?.('x-twilio-signature') || '');
  if (!authToken || !signature) return false;
  let url;
  try {
    const original = req.originalUrl || req.url || '';
    url = original.startsWith('http') ? original : new URL(original, publicUrl()).toString();
  } catch { return false; }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const payload = Object.keys(body).sort().reduce((acc, key) => acc + key + body[key], url);
  const expected = createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function twilioPost(path, params) {
  const accountSid = secretValue(TWILIO_ACCOUNT_SID);
  const authToken = secretValue(TWILIO_AUTH_TOKEN);
  if (!accountSid || !authToken) throw new Error('Twilio credentials are not configured');
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(`${API_BASE}/Accounts/${accountSid}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams(params).toString()
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = `Twilio returned HTTP ${response.status}`;
    try { detail = clean(JSON.parse(text)?.message, 400) || detail; } catch { /* status is enough */ }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  try { return JSON.parse(text); } catch { throw new Error('Twilio returned invalid JSON'); }
}

/**
 * Every asynchronous AI media failure converges here so the prospect leg is
 * ended even when the AI side never answered or dropped mid-setup. The AI's
 * own leg is ended too, which hangs up ElevenLabs.
 */
export async function terminateFailedAIMedia(db, callId, { reason, source, now = new Date() } = {}) {
  const result = await failClosedAIMediaAttachment(db, callId, { reason, source, now });
  if (!result.ok) return result;
  const aiLeg = clean((await db.doc(`aiMediaJobs/${callId}`).get().catch(() => null))?.get?.('sipCallSid'), 200);
  if (aiLeg) {
    await db.doc(`aiMediaJobs/${callId}`).set({ endRequestedBy: 'server' }, { merge: true }).catch(() => {});
    await twilioPost(`/Calls/${encodeURIComponent(aiLeg)}.json`, { Status: 'completed' }).catch(() => {});
  }
  if (!result.shouldTerminatePstn) return result;
  return endProspectLeg(db, callId, result.providerCallId, 'ai_media_setup_failed');
}

/** End the prospect's carrier leg, recording why. A leg already gone is fine. */
export async function endProspectLeg(db, callId, providerCallId, reason) {
  const result = { ok: true, providerCallId };
  try {
    await twilioPost(`/Calls/${encodeURIComponent(providerCallId)}.json`, { Status: 'completed' });
    await db.doc(`calls/${callId}`).set({
      'media.pstnEndRequestedAt': FieldValue.serverTimestamp(),
      'media.pstnEndReason': reason,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    if ([400, 404].includes(Number(error?.status))) {
      await db.doc(`calls/${callId}`).set({
        'media.pstnEndRequestedAt': FieldValue.serverTimestamp(),
        'media.pstnEndReason': `${reason}_already_terminal`,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
      return result;
    }
    await db.doc(`calls/${callId}`).set({
      'media.pstnEndError': clean(error?.message, 300),
      'media.pstnEndLastAttemptAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
    return { ok: false, providerCallId };
  }
  return result;
}

async function waitForMediaAttachmentDeadline(db, callId, deadlineAt) {
  const deadlineMs = typeof deadlineAt?.toMillis === 'function'
    ? deadlineAt.toMillis() : new Date(deadlineAt || 0).getTime();
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return { expired: false };
  const delayMs = Math.max(0, deadlineMs - Date.now());
  if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  const snapshot = await db.doc(`aiMediaJobs/${callId}`).get();
  if (!snapshot.exists || !isAIMediaAttachExpired(snapshot.data(), new Date())) return { expired: false };
  await terminateFailedAIMedia(db, callId, {
    reason: 'ai_media_attach_timeout', source: 'attachment_deadline'
  });
  return { expired: true };
}

/**
 * A pending media job is claimed transactionally before any external call is
 * made. Firestore trigger redelivery therefore cannot create a second AI SIP
 * participant for the same prospect call.
 */
export const dispatchHybridAIToSip = onDocumentWritten(
  { document: 'aiMediaJobs/{callId}', secrets, maxInstances: 50, timeoutSeconds: 60 },
  async event => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const callId = clean(event.params.callId, 200);
    const job = after.data() || {};
    const db = getFirestore();
    if (job.status === 'failed' || isAIMediaAttachExpired(job, new Date())) {
      await terminateFailedAIMedia(db, callId, {
        reason: clean(job.error, 300) || (job.status === 'failed' ? 'ai_media_job_failed' : 'ai_media_attach_timeout'),
        source: job.failureSource || 'media_job_trigger'
      });
      return;
    }
    if (job.status !== 'pending' || job.sipCallSid) return;

    // Defense in depth: a staging project must never create an AI SIP leg,
    // even if a stale trigger/document bypassed the dialer admission gate.
    // `terminateFailedAIMedia` only tears down an already-existing carrier leg;
    // it never originates a new external call.
    const dialingAdmission = externalDialingAdmission('twilio');
    if (!dialingAdmission.allowed) {
      await terminateFailedAIMedia(db, callId, {
        reason: `external_dialing_disabled:${dialingAdmission.reason}`,
        source: 'sip_dispatch_environment_gate'
      });
      return;
    }

    const sipPassword = secretValue(ELEVENLABS_SIP_PASSWORD);
    if (!LIVE_CALL_AGENT_IDS.agent || !LIVE_CALL_AGENT_IDS.sipUser || !sipPassword) {
      await terminateFailedAIMedia(db, callId, {
        reason: 'ElevenLabs live calling is not set up', source: 'sip_dispatch'
      });
      return;
    }

    const claimed = await db.runTransaction(async tx => {
      const fresh = await tx.get(after.ref);
      if (!fresh.exists || fresh.get('status') !== 'pending' || fresh.get('sipCallSid')) return false;
      tx.set(after.ref, {
        status: 'dispatching', dispatchStartedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return true;
    });
    if (!claimed) return;

    try {
      // Twilio forwards X-* URI headers in the SIP INVITE, and ElevenLabs passes
      // them to our initiation webhook, which maps the SIP call back to this
      // Firestore call without timestamp guessing.
      const to = liveCallSipUri({ sipUser: LIVE_CALL_AGENT_IDS.sipUser, callId });
      const base = publicUrl();
      const created = await twilioPost('/Calls.json', {
        To: to,
        From: 'BiteSitesAI',
        SipAuthUsername: LIVE_CALL_AGENT_IDS.sipUser,
        SipAuthPassword: sipPassword,
        Url: `${base}/api/twilio-ai-participant-twiml?callId=${encodeURIComponent(callId)}`,
        Method: 'POST',
        StatusCallback: `${base}/api/twilio-ai-sip-events?callId=${encodeURIComponent(callId)}`,
        StatusCallbackMethod: 'POST',
        StatusCallbackEvent: 'initiated ringing answered completed',
        Timeout: '20'
      });

      await after.ref.set({
        status: 'sip_dialing', sipCallSid: clean(created.sid, 200),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await db.doc(`calls/${callId}`).set({
        media: { aiParticipantSid: clean(created.sid, 200), attachState: 'sip_dialing' },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      // Keep this bounded watchdog alive for the exact deadline.  A scheduled
      // reconciler below is the durable fallback if an invocation dies first.
      await waitForMediaAttachmentDeadline(db, callId, job.attachDeadlineAt);
    } catch (error) {
      await terminateFailedAIMedia(db, callId, {
        reason: clean(error?.message, 500) || 'sip_dispatch_failed', source: 'sip_dispatch'
      });
    }
  }
);

/**
 * Store an ElevenLabs conversation as this call's turns. Used by the minute
 * reconciler (which fetches finished conversations) and by the optional signed
 * post-call webhook, so a transcript lands even if one of them is missing.
 */
export async function storeCallTranscript(db, callId, conversation = {}) {
  const batch = db.batch();
  for (const turn of transcriptTurns(conversation)) {
    batch.set(db.doc(`calls/${callId}/turns/${String(turn.sequence).padStart(6, '0')}`), {
      sequence: turn.sequence, speaker: turn.speaker, text: turn.text, final: true,
      startedAt: turn.startedAt ? Timestamp.fromDate(turn.startedAt) : null,
      source: 'elevenlabs', createdAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  batch.set(db.doc(`aiMediaJobs/${callId}`), {
    transcriptPending: false,
    transcriptStoredAt: FieldValue.serverTimestamp(),
    elevenLabs: {
      durationSecs: Math.max(0, Number(conversation?.metadata?.call_duration_secs) || 0),
      terminationReason: clean(conversation?.metadata?.termination_reason, 200)
    },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await batch.commit();
}

/** Fetch transcripts for AI calls that have ended. */
async function syncPendingTranscripts(db, now = new Date()) {
  const apiKey = secretValue(ELEVENLABS_API_KEY);
  if (!apiKey) return;
  const pending = await db.collection('aiMediaJobs').where('transcriptPending', '==', true).limit(20).get();
  for (const entry of pending.docs) {
    const conversationId = clean(entry.get('conversationId'), 240);
    const since = entry.get('transcriptPendingSince')?.toMillis?.() || 0;
    const tooOld = since && now.getTime() - since > TRANSCRIPT_WAIT_MS;
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
        headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(10_000)
      });
      const conversation = response.ok ? await response.json() : null;
      if (conversation?.agent_id === LIVE_CALL_AGENT_IDS.agent && ['done', 'failed'].includes(conversation.status)) {
        await storeCallTranscript(db, entry.id, conversation);
        continue;
      }
    } catch (error) {
      console.warn('[live-call] transcript fetch failed', entry.id, error?.message);
    }
    if (tooOld) {
      await entry.ref.set({ transcriptPending: false, transcriptMissing: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  }
}

/** Durable recovery if an attachment watchdog invocation is interrupted. */
export const reconcileHybridAIMediaAttachments = onSchedule(
  { schedule: 'every 1 minutes', timeoutSeconds: 120, secrets: [...secrets, ELEVENLABS_API_KEY] },
  async () => {
    const db = getFirestore();
    await syncPendingTranscripts(db).catch(error => console.warn('[live-call] transcript sync failed', error?.message));
    const [pending, failed] = await Promise.all([
      db.collection('aiMediaJobs').where('status', 'in', [...AI_MEDIA_ATTACH_PENDING]).limit(100).get(),
      db.collection('aiMediaJobs').where('status', '==', 'failed').limit(100).get()
    ]);
    const now = new Date();
    for (const entry of pending.docs) {
      if (!isAIMediaAttachExpired(entry.data(), now)) continue;
      await terminateFailedAIMedia(db, entry.id, {
        reason: 'ai_media_attach_timeout', source: 'attachment_reconciler', now
      });
    }
    for (const entry of failed.docs) {
      await terminateFailedAIMedia(db, entry.id, {
        reason: clean(entry.get('error'), 300) || 'ai_media_job_failed',
        source: clean(entry.get('failureSource'), 100) || 'attachment_reconciler', now
      });
    }
  }
);

/** TwiML for the Twilio -> ElevenLabs SIP leg after ElevenLabs answers. */
export const twilioHybridAIParticipantTwiML = onRequest(
  { secrets: [TWILIO_AUTH_TOKEN], maxInstances: 50 },
  async (req, res) => {
    if (!twilioSignatureValid(req, secretValue(TWILIO_AUTH_TOKEN))) {
      res.status(401).type('text/plain').send('unauthorized'); return;
    }
    const callId = clean(req.query?.callId || req.body?.callId, 200);
    if (!callId) { res.status(400).type('text/plain').send('missing callId'); return; }
    const db = getFirestore();
    const callSnapshot = await db.doc(`calls/${callId}`).get();
    if (!callSnapshot.exists) { res.status(404).type('text/plain').send('call not found'); return; }
    const call = callSnapshot.data();
    if (call?.control?.controller !== 'ai' && call?.control?.controller !== 'transitioning') {
      res.status(409).type('text/plain').send('call no longer needs AI'); return;
    }
    const room = clean(call?.media?.conferenceName, 120);
    if (!room) { res.status(409).type('text/plain').send('conference not ready'); return; }
    const conferenceCallback = `${publicUrl()}/api/twilio-conference-events?sessionId=${encodeURIComponent(call.sessionId)}&targetId=${encodeURIComponent(call.targetId)}`;
    res.status(200).type('text/xml').send(
      // This stays false because a successful AI-to-human handoff removes the
      // SIP participant while the prospect and rep must remain connected.  On
      // every pre-attachment failure `terminateFailedAIMedia` explicitly ends
      // the prospect's carrier leg instead of relying on conference exit.
      `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false" participantLabel="${xml(`ai-${callId}`)}" statusCallback="${xml(conferenceCallback)}" statusCallbackMethod="POST" statusCallbackEvent="join leave">${xml(room)}</Conference></Dial></Response>`
    );
  }
);

/** Carrier lifecycle for the AI SIP participant. */
export const twilioHybridAISipEvent = onRequest(
  { secrets: [TWILIO_AUTH_TOKEN], maxInstances: 50 },
  async (req, res) => {
    if (!twilioSignatureValid(req, secretValue(TWILIO_AUTH_TOKEN))) {
      res.status(401).json({ error: 'unauthorized' }); return;
    }
    const callId = clean(req.query?.callId, 200);
    if (!callId) { res.status(400).json({ error: 'callId-required' }); return; }
    const status = clean(req.body?.CallStatus, 60).toLowerCase();
    const sipCallSid = clean(req.body?.CallSid, 200);
    const update = {
      sipCallSid,
      sipStatus: status,
      updatedAt: FieldValue.serverTimestamp()
    };
    if (status === 'in-progress') update.status = 'sip_connected';
    if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
      update.status = status === 'completed' ? 'ended' : 'failed';
      update.endedAt = FieldValue.serverTimestamp();
    }
    const db = getFirestore();
    const priorJob = await db.doc(`aiMediaJobs/${callId}`).get();
    const wasActive = priorJob.exists && priorJob.get('status') === 'active';
    // Once an attached conversation's leg is over, the minute reconciler
    // fetches its transcript from ElevenLabs.
    if (update.endedAt && priorJob.get('conversationId') && !priorJob.get('transcriptStoredAt')) {
      Object.assign(update, { transcriptPending: true, transcriptPendingSince: FieldValue.serverTimestamp() });
    }
    await db.doc(`aiMediaJobs/${callId}`).set(update, { merge: true });
    if (status === 'failed' || status === 'busy' || status === 'no-answer' || (status === 'completed' && !wasActive)) {
      await terminateFailedAIMedia(db, callId, {
        reason: `AI SIP participant ${status}`, source: 'sip_status_callback'
      });
    } else if (status === 'completed' && priorJob.get('endRequestedBy') !== 'server') {
      // The AI hung up (or dropped) on its own. If it was still the only one
      // talking to the prospect, the call is over: never leave a person alone
      // in a silent conference. During a handoff the rep is already joining.
      const call = (await db.doc(`calls/${callId}`).get()).data() || {};
      if (call?.control?.controller === 'ai' && call.providerCallId && !call.endedAt) {
        await endProspectLeg(db, callId, call.providerCallId, 'ai_ended_call');
      }
    }
    res.status(200).json({ ok: true });
  }
);
