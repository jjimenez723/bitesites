// Hybrid Dialer V2 session APIs.
//
// These wrap the proven V1 target locking/compliance/dial preparation logic but
// initialize and operate sessions using the V2 rep/controller model. The public
// UI should use these functions rather than the legacy start/dial functions.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import {
  startDialerSession,
  heartbeatSession,
  dialNext,
  stopDialerSession,
  applyDisposition,
  markDoNotCall
} from './outbound-calls.js';
import { getCallingProvider, assertSupports } from './providers/calling/index.js';
import { clean } from './prospect-normalization.js';
import { recordCallAuditEvent } from './hybrid-call-orchestration.js';

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_TWIML_APP_SID = defineSecret('TWILIO_TWIML_APP_SID');
const TWILIO_API_KEY_SID = defineSecret('TWILIO_API_KEY_SID');
const TWILIO_API_KEY_SECRET = defineSecret('TWILIO_API_KEY_SECRET');

const HYBRID_SECRETS = [
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_TWIML_APP_SID,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET
];

const secretValue = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};

const callOptions = { enforceAppCheck: false, maxInstances: 20 };
const requireId = (value, label) => {
  const result = clean(value, 200);
  if (!result || !/^[A-Za-z0-9_-]+$/.test(result)) throw new HttpsError('invalid-argument', `A valid ${label} is required.`);
  return result;
};

async function roleFor(db, auth) {
  if (auth?.token?.role) return clean(auth.token.role, 80);
  const snapshot = await db.doc(`roles/${auth.uid}`).get();
  return snapshot.exists ? clean(snapshot.get('role'), 80) : '';
}

async function requireDialer(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  const role = await roleFor(db, request.auth);
  if (!['admin', 'outbound_rep', 'outbound_manager'].includes(role)) {
    throw new HttpsError('permission-denied', 'This account cannot use the outbound dialer.');
  }
  return { db, uid: request.auth.uid, email: clean(request.auth.token?.email, 200), role };
}

async function requireOwnedSession(db, sessionId, uid) {
  const snapshot = await db.doc(`dialerSessions/${sessionId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Session not found.');
  if (snapshot.get('userUid') !== uid) throw new HttpsError('permission-denied', 'That session belongs to another rep.');
  return { id: sessionId, ...snapshot.data() };
}

function twilioConfig() {
  const publicUrl = (process.env.PUBLIC_APP_URL || 'https://bitesites.org').replace(/\/$/, '');
  return {
    accountSid: secretValue(TWILIO_ACCOUNT_SID),
    authToken: secretValue(TWILIO_AUTH_TOKEN),
    twimlAppSid: secretValue(TWILIO_TWIML_APP_SID),
    apiKeySid: secretValue(TWILIO_API_KEY_SID),
    apiKeySecret: secretValue(TWILIO_API_KEY_SECRET),
    statusCallbackUrl: `${publicUrl}/api/hybrid-outbound-events`,
    hybridV2: true
  };
}

/** Current product default is three simultaneous outbound legs per rep. */
export const startHybridDialerSession = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid } = await requireDialer(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new HttpsError('not-found', 'Campaign not found.');
  const campaign = { id: campaignId, ...campaignSnapshot.data() };
  const concurrency = 3;

  const support = assertSupports(campaign.provider, 'parallel', concurrency, { hybrid: true });
  if (!support.ok) {
    throw new HttpsError(
      'failed-precondition',
      `Provider "${campaign.provider}" cannot run Hybrid Dialer V2: missing ${support.missing.join(', ')}.`
    );
  }

  const requestedProfileId = clean(request.data?.agentProfileId || campaign.agentProfileId || campaign.agentId, 200);
  if (!requestedProfileId) throw new HttpsError('failed-precondition', 'Choose an AI agent profile before starting the hybrid dialer.');
  const profileSnapshot = await db.doc(`aiAgentProfiles/${requestedProfileId}`).get();
  if (!profileSnapshot.exists || profileSnapshot.get('status') === 'archived') {
    throw new HttpsError('failed-precondition', 'The selected AI agent profile is unavailable.');
  }

  const { sessionId } = await startDialerSession(db, {
    campaignId,
    userUid: uid,
    mode: 'parallel',
    concurrency
  }).catch(error => { throw new HttpsError('failed-precondition', clean(error?.message, 300)); });

  const sessionOverride = request.data?.sessionOverride && typeof request.data.sessionOverride === 'object'
    ? JSON.parse(JSON.stringify(request.data.sessionOverride))
    : {};
  const overrideJson = JSON.stringify(sessionOverride);
  if (overrideJson.length > 12000) throw new HttpsError('invalid-argument', 'Session override is too large.');

  await db.doc(`dialerSessions/${sessionId}`).set({
    hybridV2: true,
    concurrency,
    rep: { state: 'available', activeCallId: '', listeningCallId: '' },
    takeover: { autoEnabled: request.data?.autoTakeover === true },
    agentProfileId: requestedProfileId,
    agentProfileVersion: Math.max(1, Number(profileSnapshot.get('version')) || 1),
    agentSessionOverride: sessionOverride,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await recordCallAuditEvent(db, 'session_started', {
    sessionId, campaignId, actorType: 'rep', actorId: uid,
    metadata: { hybridV2: true, concurrency, agentProfileId: requestedProfileId }
  });

  return {
    sessionId,
    concurrency,
    autoTakeover: request.data?.autoTakeover === true,
    agentProfileId: requestedProfileId
  };
});

/** Heartbeat is ownership-checked so outbound_rep does not need the admin-only legacy callable. */
export const heartbeatHybridDialerSession = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  await requireOwnedSession(db, sessionId, uid);
  return heartbeatSession(db, sessionId);
});

/**
 * Launch exactly one three-leg batch at a time. This prevents repeated clicks
 * from turning a 3-line product setting into 6/9/12 concurrent PSTN calls.
 */
export const dialHybridTargets = onCall({ ...callOptions, timeoutSeconds: 180, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid);
  if (session.hybridV2 !== true) throw new HttpsError('failed-precondition', 'This is not a Hybrid Dialer V2 session.');
  if (session.status !== 'active') return { started: [], reason: `session_${session.status}` };

  const nonTerminal = [];
  for (const callId of (session.activeCallIds || []).slice(-20)) {
    const snapshot = await db.doc(`calls/${callId}`).get();
    if (!snapshot.exists) continue;
    const status = snapshot.get('status');
    if (!['completed', 'cancelled', 'failed'].includes(status)) nonTerminal.push(callId);
  }
  if (nonTerminal.length) return { started: [], reason: 'batch_in_progress', activeCallIds: nonTerminal };

  const campaignSnapshot = await db.doc(`outboundCampaigns/${session.campaignId}`).get();
  const providerId = campaignSnapshot.get('provider');
  if (providerId !== 'twilio') throw new HttpsError('failed-precondition', 'Hybrid V2 currently requires Twilio.');

  await db.doc(`dialerSessions/${sessionId}`).set({
    connectedCallId: '', connectedTargetId: '', connectedAt: null,
    rep: { state: 'available', activeCallId: '', listeningCallId: '' },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  const result = await dialNext(db, sessionId, { providerConfig: twilioConfig() })
    .catch(error => { throw new HttpsError('internal', clean(error?.message, 300)); });

  const profileId = clean(session.agentProfileId, 200);
  for (const started of result.started || []) {
    await db.doc(`calls/${started.callId}`).set({
      hybridV2: true,
      control: { controller: 'unassigned', repUid: '', aiSessionId: '', revision: 0 },
      handoff: { requestedBy: '', requestedAt: null, state: 'none', priority: 0, completedAt: null },
      media: {
        conferenceSid: '', conferenceName: '', prospectParticipantSid: '',
        aiParticipantSid: '', humanParticipantSid: '', listenerParticipantSid: '', streamSid: '', recordingSid: ''
      },
      agent: {
        profileId,
        profileVersion: Math.max(1, Number(session.agentProfileVersion) || 1),
        effectiveConfigHash: '', model: '', voice: ''
      },
      agentSessionOverride: session.agentSessionOverride || {},
      analytics: {
        humanTalkSec: 0, aiTalkSec: 0, listenSec: 0,
        takeoverCount: 0, prospectRequestedHuman: false
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await recordCallAuditEvent(db, 'call_dialed', {
      callId: started.callId, sessionId, campaignId: session.campaignId,
      actorType: 'rep', actorId: uid, metadata: { targetId: started.targetId }
    });
  }
  return result;
});

export const stopHybridDialerSession = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid);
  const result = await stopDialerSession(db, sessionId, {
    reason: clean(request.data?.reason, 60) || 'ended',
    providerConfig: session.provider === 'twilio' ? twilioConfig() : {}
  });
  await recordCallAuditEvent(db, 'session_ended', {
    sessionId, campaignId: session.campaignId, actorType: 'rep', actorId: uid,
    metadata: { reason: clean(request.data?.reason, 60) || 'ended' }
  });
  return result;
});

/** End the live phone call only. This never marks DNC. */
export const endHybridCall = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...callSnapshot.data() };
  await requireOwnedSession(db, call.sessionId, uid);
  if (call.provider !== 'twilio') throw new HttpsError('failed-precondition', 'Hybrid call control currently requires Twilio.');

  const provider = getCallingProvider('twilio', twilioConfig());
  if (call.providerCallId) await provider.endCall(call.providerCallId)
    .catch(error => { throw new HttpsError('internal', clean(error?.message, 300)); });
  await db.doc(`calls/${callId}`).set({
    endedBy: uid, endRequestedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'call_end_requested', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid
  });
  return { ok: true };
});

/** Explicit DNC action. Kept separate from End Call by contract. */
export const markHybridCallDoNotCall = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, email } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...callSnapshot.data() };
  await requireOwnedSession(db, call.sessionId, uid);

  await markDoNotCall(db, call.targetId, { actor: email || uid });
  if (call.provider === 'twilio' && call.providerCallId) {
    const provider = getCallingProvider('twilio', twilioConfig());
    await provider.endCall(call.providerCallId).catch(() => {});
  }
  await db.doc(`calls/${callId}`).set({
    disposition: 'do_not_call', dispositionBy: email || uid,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'dnc_marked', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid
  });
  return { ok: true };
});

/** Record a rep disposition against any call in the rep's session. */
export const submitHybridDisposition = onCall(callOptions, async request => {
  const { db, uid, email } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...callSnapshot.data() };
  await requireOwnedSession(db, call.sessionId, uid);
  const campaignSnapshot = await db.doc(`outboundCampaigns/${call.campaignId}`).get();
  const disposition = clean(request.data?.disposition, 40);
  const result = await applyDisposition(db, {
    targetId: call.targetId,
    callId,
    disposition,
    notes: clean(request.data?.notes, 2000),
    campaign: campaignSnapshot.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null,
    actor: email || uid
  });
  await db.doc(`calls/${callId}`).set({
    disposition,
    summary: clean(request.data?.notes, 2000),
    dispositionBy: email || uid,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'disposition_recorded', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid, metadata: { disposition }
  });
  return result;
});
