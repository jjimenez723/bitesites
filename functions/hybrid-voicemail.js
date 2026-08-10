// Hybrid Dialer V2 voicemail handling.
//
// Async AMD may classify a machine after the PSTN leg has already entered its
// conference. This trigger removes that machine from the human/AI routing path,
// records the voicemail outcome, and either redirects the existing call to a
// short voicemail message or ends it according to the campaign policy.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { applyDisposition } from './outbound-calls.js';
import { getCallingProvider } from './providers/calling/index.js';
import { clean } from './prospect-normalization.js';

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_TWIML_APP_SID = defineSecret('TWILIO_TWIML_APP_SID');
const PUBLIC_APP_URL = defineString('PUBLIC_APP_URL', { default: 'https://bitesites.org' });
const secrets = [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_TWIML_APP_SID];

const secretValue = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};
const baseUrl = () => String(PUBLIC_APP_URL.value() || 'https://bitesites.org').replace(/\/$/, '');
const xml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function twilioConfig() {
  return {
    accountSid: secretValue(TWILIO_ACCOUNT_SID),
    authToken: secretValue(TWILIO_AUTH_TOKEN),
    twimlAppSid: secretValue(TWILIO_TWIML_APP_SID),
    statusCallbackUrl: '',
    hybridV2: true
  };
}

function twilioSignatureValid(req) {
  const token = secretValue(TWILIO_AUTH_TOKEN);
  const signature = String(req.get?.('x-twilio-signature') || '');
  if (!token || !signature) return false;
  let url;
  try {
    const original = req.originalUrl || req.url || '';
    url = original.startsWith('http') ? original : new URL(original, baseUrl()).toString();
  } catch { return false; }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const payload = Object.keys(body).sort().reduce((acc, key) => acc + key + body[key], url);
  const expected = createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function campaignFor(db, call) {
  if (!call.campaignId) return null;
  const snapshot = await db.doc(`outboundCampaigns/${call.campaignId}`).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function restoreVoicemailDisposition(db, callId, call) {
  if (!call.targetId) return;
  const campaign = await campaignFor(db, call);
  const policy = campaign?.voicemailPolicy || 'retry';
  if (policy === 'none') return;
  await applyDisposition(db, {
    targetId: call.targetId,
    callId,
    disposition: 'voicemail',
    campaign,
    actor: 'provider:amd'
  }).catch(() => {});
}

export const handleHybridMachineAnswer = onDocumentWritten(
  { document: 'calls/{callId}', secrets, maxInstances: 40, timeoutSeconds: 60 },
  async event => {
    const before = event.data?.before?.exists ? event.data.before.data() : {};
    const afterSnapshot = event.data?.after;
    if (!afterSnapshot?.exists) return;
    const after = afterSnapshot.data() || {};
    const callId = clean(event.params.callId, 200);
    if (after.hybridV2 !== true || after.provider !== 'twilio' || after.answeredBy !== 'machine') return;

    const db = getFirestore();

    // The carrier's later completed callback can legitimately arrive after the
    // AMD path. Re-assert voicemail after completion so retry/call-later state is
    // not replaced by a generic terminal carrier status.
    if (after.status === 'completed' && before.status !== 'completed') {
      await restoreVoicemailDisposition(db, callId, after);
      return;
    }

    if (after?.voicemailHandling?.handled === true) return;
    const claimed = await db.runTransaction(async tx => {
      const fresh = await tx.get(afterSnapshot.ref);
      if (!fresh.exists || fresh.get('answeredBy') !== 'machine') return false;
      if (fresh.get('voicemailHandling.handled') === true || fresh.get('voicemailHandling.processing') === true) return false;
      tx.set(afterSnapshot.ref, {
        voicemailHandling: { processing: true, handled: false },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return true;
    });
    if (!claimed) return;

    const campaign = await campaignFor(db, after);
    const policy = campaign?.voicemailPolicy || 'retry';
    const provider = getCallingProvider('twilio', twilioConfig());

    try {
      if (policy !== 'none' && after.targetId) {
        await applyDisposition(db, {
          targetId: after.targetId,
          callId,
          disposition: 'voicemail',
          campaign,
          actor: 'provider:amd'
        });
      }

      if (after.providerCallId) {
        if (policy === 'leave_message') {
          await provider.redirectCall(
            after.providerCallId,
            `${baseUrl()}/api/twilio-hybrid-voicemail?callId=${encodeURIComponent(callId)}`
          );
        } else {
          await provider.endCall(after.providerCallId);
        }
      }

      await afterSnapshot.ref.set({
        status: policy === 'leave_message' ? 'voicemail' : after.status,
        voicemailHandling: {
          processing: false, handled: true, policy,
          handledAt: FieldValue.serverTimestamp()
        },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      await afterSnapshot.ref.set({
        voicemailHandling: {
          processing: false, handled: false, policy,
          error: clean(error?.message, 400)
        },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      throw error;
    }
  }
);

/** Message played on the existing PSTN leg when voicemailPolicy=leave_message. */
export const twilioHybridVoicemailTwiML = onRequest(
  { secrets: [TWILIO_AUTH_TOKEN], maxInstances: 40 },
  async (req, res) => {
    if (!twilioSignatureValid(req)) {
      res.status(401).type('text/plain').send('unauthorized'); return;
    }
    const callId = clean(req.query?.callId || req.body?.callId, 200);
    if (!callId) { res.status(400).type('text/plain').send('missing callId'); return; }
    const db = getFirestore();
    const callSnapshot = await db.doc(`calls/${callId}`).get();
    if (!callSnapshot.exists) { res.status(404).type('text/plain').send('call not found'); return; }
    const campaign = await campaignFor(db, callSnapshot.data());
    const message = clean(campaign?.voicemailMessage, 700)
      || 'Hi, this is BiteSites. We were trying to reach you regarding your business. We will follow up another time. Thank you.';
    res.status(200).type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(message)}</Say><Hangup/></Response>`
    );
  }
);
