// Hybrid Dialer V2 — attach one isolated OpenAI Realtime SIP participant to
// every AI-controlled Twilio conference.
//
// Firebase remains the control plane: Firestore says a call needs AI, this
// trigger claims that job exactly once, and Twilio creates the SIP leg. OpenAI
// carries the realtime media; no long-lived audio socket is kept inside a
// Firebase Function.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { clean } from './prospect-normalization.js';
import {
  AI_MEDIA_ATTACH_PENDING, failClosedAIMediaAttachment, isAIMediaAttachExpired
} from './hybrid-media-failsafe.js';
import { externalDialingAdmission } from './deployment-environment.js';

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const OPENAI_PROJECT_ID = defineString('OPENAI_PROJECT_ID', { default: '' });
const PUBLIC_APP_URL = defineString('PUBLIC_APP_URL', { default: 'https://bitesites.org' });

const secrets = [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_API_KEY];
const API_BASE = 'https://api.twilio.com/2010-04-01';

const secretValue = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};

const xml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const publicUrl = () => String(PUBLIC_APP_URL.value() || 'https://bitesites.org').replace(/\/$/, '');

function twilioSignatureValid(req, authToken) {
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

async function twilioPost(path, params) {
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

async function hangupRealtimeCall(realtimeCallId) {
  const apiKey = secretValue(OPENAI_API_KEY);
  if (!apiKey || !realtimeCallId) return { attempted: false };
  try {
    const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(realtimeCallId)}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000)
    });
    return { attempted: true, ok: response.ok };
  } catch { return { attempted: true, ok: false }; }
}

/**
 * The only process that holds both carrier and OpenAI credentials.  Every
 * asynchronous AI media failure converges here so the prospect leg is ended
 * even when the sideband service itself has crashed or lost its request.
 */
async function terminateFailedAIMedia(db, callId, { reason, source, realtimeCallId = '', now = new Date() } = {}) {
  const result = await failClosedAIMediaAttachment(db, callId, { reason, source, realtimeCallId, now });
  if (!result.ok) return result;
  if (result.shouldTerminateRealtime && result.realtimeCallId) {
    const hangup = await hangupRealtimeCall(result.realtimeCallId);
    if (hangup.attempted) {
      await db.doc(`calls/${callId}`).set({
        'media.realtimeHangupAttemptedAt': FieldValue.serverTimestamp(),
        'media.realtimeHangupFailed': hangup.ok !== true,
        ...(hangup.ok ? { 'media.realtimeHangupConfirmedAt': FieldValue.serverTimestamp() } : {}),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
    }
  }
  if (!result.shouldTerminatePstn) return result;
  try {
    await twilioPost(`/Calls/${encodeURIComponent(result.providerCallId)}.json`, { Status: 'completed' });
    await db.doc(`calls/${callId}`).set({
      'media.pstnEndRequestedAt': FieldValue.serverTimestamp(),
      'media.pstnEndReason': 'ai_media_setup_failed',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    if ([400, 404].includes(Number(error?.status))) {
      await db.doc(`calls/${callId}`).set({
        'media.pstnEndRequestedAt': FieldValue.serverTimestamp(),
        'media.pstnEndReason': 'ai_media_setup_failed_already_terminal',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
      return result;
    }
    await db.doc(`calls/${callId}`).set({
      'media.pstnEndError': clean(error?.message, 300),
      'media.pstnEndLastAttemptAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
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
    reason: 'ai_media_attach_timeout', source: 'attachment_deadline',
    realtimeCallId: clean(snapshot.get('realtimeCallId'), 240)
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
        source: job.failureSource || 'media_job_trigger', realtimeCallId: clean(job.realtimeCallId, 240)
      });
      return;
    }
    if (job.status !== 'pending' || job.sipCallSid) return;

    // Defense in depth: a staging project must never create an OpenAI SIP leg,
    // even if a stale trigger/document bypassed the dialer admission gate.
    // `terminateFailedAIMedia` only tears down an already-existing carrier leg;
    // it never originates a new external call.
    const dialingAdmission = externalDialingAdmission('twilio');
    if (!dialingAdmission.allowed) {
      await terminateFailedAIMedia(db, callId, {
        reason: `external_dialing_disabled:${dialingAdmission.reason}`,
        source: 'sip_dispatch_environment_gate', realtimeCallId: clean(job.realtimeCallId, 240)
      });
      return;
    }

    const projectId = clean(OPENAI_PROJECT_ID.value(), 160);
    if (!projectId) {
      await terminateFailedAIMedia(db, callId, {
        reason: 'OPENAI_PROJECT_ID is not configured', source: 'sip_dispatch'
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
      // Twilio forwards X-* URI headers in the SIP INVITE. OpenAI includes those
      // headers in realtime.call.incoming, which deterministically maps the SIP
      // call back to this Firestore call without timestamp guessing.
      const sipHeader = `X-BiteSites-Call-ID=${encodeURIComponent(callId)}`;
      const to = `sip:${projectId}@sip.api.openai.com;transport=tls?${sipHeader}`;
      const base = publicUrl();
      const created = await twilioPost('/Calls.json', {
        To: to,
        From: 'BiteSitesAI',
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

/** Durable recovery if an attachment watchdog invocation is interrupted. */
export const reconcileHybridAIMediaAttachments = onSchedule(
  { schedule: 'every 1 minutes', timeoutSeconds: 120, secrets },
  async () => {
    const db = getFirestore();
    const [pending, failed] = await Promise.all([
      db.collection('aiMediaJobs').where('status', 'in', [...AI_MEDIA_ATTACH_PENDING]).limit(100).get(),
      db.collection('aiMediaJobs').where('status', '==', 'failed').limit(100).get()
    ]);
    const now = new Date();
    for (const entry of pending.docs) {
      if (!isAIMediaAttachExpired(entry.data(), now)) continue;
      await terminateFailedAIMedia(db, entry.id, {
        reason: 'ai_media_attach_timeout', source: 'attachment_reconciler',
        realtimeCallId: clean(entry.get('realtimeCallId'), 240), now
      });
    }
    for (const entry of failed.docs) {
      await terminateFailedAIMedia(db, entry.id, {
        reason: clean(entry.get('error'), 300) || 'ai_media_job_failed',
        source: clean(entry.get('failureSource'), 100) || 'attachment_reconciler',
        realtimeCallId: clean(entry.get('realtimeCallId'), 240), now
      });
    }
  }
);

/** TwiML for the Twilio -> OpenAI SIP leg after OpenAI answers. */
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
    await db.doc(`aiMediaJobs/${callId}`).set(update, { merge: true });
    if (status === 'failed' || status === 'busy' || status === 'no-answer' || (status === 'completed' && !wasActive)) {
      await terminateFailedAIMedia(db, callId, {
        reason: `AI SIP participant ${status}`, source: 'sip_status_callback'
      });
    }
    res.status(200).json({ ok: true });
  }
);
