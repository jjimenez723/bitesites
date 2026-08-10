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
import { defineSecret, defineString } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { clean } from './prospect-normalization.js';

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const OPENAI_PROJECT_ID = defineString('OPENAI_PROJECT_ID', { default: '' });
const PUBLIC_APP_URL = defineString('PUBLIC_APP_URL', { default: 'https://bitesites.org' });

const secrets = [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN];
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
    throw new Error(detail);
  }
  try { return JSON.parse(text); } catch { throw new Error('Twilio returned invalid JSON'); }
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
    if (job.status !== 'pending' || job.sipCallSid) return;

    const projectId = clean(OPENAI_PROJECT_ID.value(), 160);
    if (!projectId) {
      await after.ref.set({
        status: 'failed', error: 'OPENAI_PROJECT_ID is not configured',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    const db = getFirestore();
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
        media: { aiParticipantSid: clean(created.sid, 200) },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      await after.ref.set({
        status: 'failed', error: clean(error?.message, 500),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await db.doc(`calls/${callId}`).set({
        aiAttachError: clean(error?.message, 500), updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
      throw error;
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
    await db.doc(`aiMediaJobs/${callId}`).set(update, { merge: true });
    if (status === 'failed' || status === 'busy' || status === 'no-answer') {
      await db.doc(`calls/${callId}`).set({
        aiAttachError: `AI SIP participant ${status}`,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.status(200).json({ ok: true });
  }
);
