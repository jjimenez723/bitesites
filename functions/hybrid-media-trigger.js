// Firestore-driven media synchronizer for Hybrid Dialer V2.
//
// Firebase owns durable state; Twilio/OpenAI media reacts to that state. This
// trigger attaches an OpenAI Realtime SIP participant when a call is routed to
// AI, removes that participant after a confirmed human takeover, and handles
// AMD machine answers without starting a conversational AI session.

import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { clean } from './prospect-normalization.js';

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const OPENAI_PROJECT_ID = defineSecret('OPENAI_PROJECT_ID');

const API_BASE = 'https://api.twilio.com/2010-04-01';

const value = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};

async function twilioPost(path, params) {
  const accountSid = value(TWILIO_ACCOUNT_SID);
  const authToken = value(TWILIO_AUTH_TOKEN);
  if (!accountSid || !authToken) throw new Error('Twilio is not configured');
  const response = await fetch(`${API_BASE}/Accounts/${accountSid}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams(params).toString()
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Twilio ${response.status}: ${clean(text, 500)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

async function attachAI(db, callId, call) {
  if (call?.control?.controller !== 'ai') return;
  if (!call?.media?.conferenceSid) return;
  if (call?.media?.aiParticipantSid) return;

  const jobRef = db.doc(`aiMediaJobs/${callId}`);
  const jobSnapshot = await jobRef.get();
  if (!jobSnapshot.exists || !['pending', 'retry'].includes(jobSnapshot.get('status'))) return;

  // Claim the attach operation transactionally so duplicate Firestore trigger
  // deliveries cannot originate two AI SIP participants.
  const claimed = await db.runTransaction(async transaction => {
    const current = await transaction.get(jobRef);
    if (!current.exists || !['pending', 'retry'].includes(current.get('status'))) return false;
    transaction.set(jobRef, {
      status: 'attaching', attachStartedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  });
  if (!claimed) return;

  const projectId = clean(value(OPENAI_PROJECT_ID), 200);
  if (!projectId) {
    await jobRef.set({ status: 'failed', error: 'OPENAI_PROJECT_ID is not configured', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return;
  }

  const campaignSnapshot = await db.doc(`outboundCampaigns/${call.campaignId}`).get();
  const callerId = clean(campaignSnapshot.get('callerId'), 40);
  if (!callerId) {
    await jobRef.set({ status: 'failed', error: 'Campaign callerId is missing', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return;
  }

  const callbackOrigin = (process.env.PUBLIC_APP_URL || 'https://bitesites.org').replace(/\/$/, '');
  const sipTarget = `sip:${projectId}@sip.api.openai.com;transport=tls?X-BiteSites-Call-ID=${encodeURIComponent(callId)}`;

  try {
    const participant = await twilioPost(
      `/Conferences/${encodeURIComponent(call.media.conferenceSid)}/Participants.json`,
      {
        From: callerId,
        To: sipTarget,
        EarlyMedia: 'true',
        Beep: 'false',
        EndConferenceOnExit: 'false',
        Label: `ai-${callId}`.slice(0, 128),
        StatusCallback: `${callbackOrigin}/api/twilio-conference-events?sessionId=${encodeURIComponent(call.sessionId)}&targetId=${encodeURIComponent(call.targetId)}`,
        StatusCallbackMethod: 'POST',
        StatusCallbackEvent: 'initiated ringing answered completed'
      }
    );
    const participantCallSid = clean(participant.call_sid || participant.callSid || participant.sid, 200);
    await Promise.all([
      db.doc(`calls/${callId}`).set({
        media: { ...(call.media || {}), aiParticipantSid: participantCallSid },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }),
      jobRef.set({
        status: 'sip_dialing', aiParticipantSid: participantCallSid,
        sipTargetCreatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })
    ]);
  } catch (error) {
    await jobRef.set({
      status: 'retry', error: clean(error?.message, 500), updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    throw error;
  }
}

async function cleanupAI(db, callId, before, after) {
  if (before?.control?.controller === 'human' || after?.control?.controller !== 'human') return;
  const aiParticipantSid = clean(before?.media?.aiParticipantSid || after?.media?.aiParticipantSid, 200);
  if (!aiParticipantSid) return;
  try {
    await twilioPost(`/Calls/${encodeURIComponent(aiParticipantSid)}.json`, { Status: 'completed' });
  } catch (error) {
    console.warn('[hybrid-media] could not end AI participant', callId, error?.message || error);
  }
  await db.doc(`aiMediaJobs/${callId}`).set({
    status: 'handoff_completed', endedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function handleMachineAnswer(db, callId, before, after) {
  if (before?.answeredBy === 'machine' || after?.answeredBy !== 'machine') return;
  const providerCallId = clean(after.providerCallId, 200);
  if (!providerCallId) return;
  const campaignSnapshot = await db.doc(`outboundCampaigns/${after.campaignId}`).get();
  const policy = campaignSnapshot.get('voicemailPolicy') || 'retry';
  const message = clean(campaignSnapshot.get('voicemailMessage'), 1000);
  const publicUrl = (process.env.PUBLIC_APP_URL || 'https://bitesites.org').replace(/\/$/, '');

  try {
    if (policy === 'leave_message' && message) {
      await twilioPost(`/Calls/${encodeURIComponent(providerCallId)}.json`, {
        Url: `${publicUrl}/api/twilio-voicemail-twiml?callId=${encodeURIComponent(callId)}`,
        Method: 'POST'
      });
    } else {
      await twilioPost(`/Calls/${encodeURIComponent(providerCallId)}.json`, { Status: 'completed' });
    }
  } catch (error) {
    console.warn('[hybrid-media] machine-answer handling failed', callId, error?.message || error);
  }
}

export const syncHybridCallMedia = onDocumentUpdated(
  {
    document: 'calls/{callId}',
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_PROJECT_ID],
    maxInstances: 30,
    timeoutSeconds: 60
  },
  async event => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    if (after.hybridV2 !== true) return;
    const callId = event.params.callId;
    const db = getFirestore();

    await handleMachineAnswer(db, callId, before, after);
    await cleanupAI(db, callId, before, after);
    await attachAI(db, callId, after);
  }
);
