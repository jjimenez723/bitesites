// Bounded carrier actions for the Realtime sideband.
//
// The AI service is never given Twilio credentials. When an approved server
// action needs to end the live PSTN prospect leg (for example an explicit DNC),
// it asks this endpoint. The endpoint can only act on a Hybrid V2 call document
// and exposes no generic dial/transfer primitive.

import { timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { getCallingProvider } from './providers/calling/index.js';
import { clean } from './prospect-normalization.js';
import { recordCallAuditEvent } from './hybrid-call-orchestration.js';

const AI_MEDIA_WEBHOOK_SECRET = defineSecret('AI_MEDIA_WEBHOOK_SECRET');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_TWIML_APP_SID = defineSecret('TWILIO_TWIML_APP_SID');
const secrets = [AI_MEDIA_WEBHOOK_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_TWIML_APP_SID];

const secretValue = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};

function authorized(req) {
  const expected = clean(secretValue(AI_MEDIA_WEBHOOK_SECRET), 300);
  const provided = clean(req.get('x-ai-media-secret'), 300);
  return expected.length >= 24 && provided.length === expected.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function provider() {
  return getCallingProvider('twilio', {
    accountSid: secretValue(TWILIO_ACCOUNT_SID),
    authToken: secretValue(TWILIO_AUTH_TOKEN),
    twimlAppSid: secretValue(TWILIO_TWIML_APP_SID),
    statusCallbackUrl: '',
    hybridV2: true
  });
}

export const hybridAICarrierControl = onRequest(
  { secrets, maxInstances: 40, timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return;
    }
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const callId = clean(req.body?.callId, 200);
    if (!/^[A-Za-z0-9_-]+$/.test(callId)) { res.status(400).json({ error: 'callId-required' }); return; }
    const action = clean(req.body?.action, 60);
    if (action !== 'end_prospect_call') { res.status(400).json({ error: 'unknown-action' }); return; }

    const db = getFirestore();
    const snapshot = await db.doc(`calls/${callId}`).get();
    if (!snapshot.exists) { res.status(404).json({ error: 'call-not-found' }); return; }
    const call = { id: callId, ...snapshot.data() };
    if (call.hybridV2 !== true || call.provider !== 'twilio') {
      res.status(409).json({ error: 'not-hybrid-twilio' }); return;
    }
    if (!call.providerCallId) { res.status(409).json({ error: 'provider-call-id-missing' }); return; }

    try {
      await provider().endCall(call.providerCallId);
      await db.doc(`calls/${callId}`).set({
        endRequestedAt: FieldValue.serverTimestamp(),
        endedBy: clean(req.body?.actor, 160) || 'ai',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await recordCallAuditEvent(db, 'call_end_requested', {
        callId, sessionId: call.sessionId, campaignId: call.campaignId,
        actorType: 'ai', actorId: clean(req.body?.actor, 160) || 'ai',
        metadata: { reason: clean(req.body?.reason, 120) || 'ai_server_action' }
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ error: 'carrier-end-failed', detail: clean(error?.message, 400) });
    }
  }
);
