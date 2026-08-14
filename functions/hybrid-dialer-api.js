// Hybrid AI Dialer V2 control-plane Cloud Functions.
//
// Existing outbound functions remain exported through v2-index.js. These
// endpoints add V2 ownership, handoff, agent configuration, Twilio browser
// access tokens/TwiML, transcript ingestion, and OpenAI/Twilio control hooks.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import {
  routeVerifiedHumanAnswer,
  requestHumanHandoff,
  beginSmoothHandoff,
  completeSmoothHandoff,
  failSmoothHandoff,
  setListenState,
  releaseRepFromCall,
  nextAutoTakeoverCall,
  attachAIController,
  recordCallAuditEvent
} from './hybrid-call-orchestration.js';
import { compileAgentRuntime, runtimePreview, sanitizeRealtimeSessionConfig } from './agent-runtime.js';
import { buildAgentPreviewRuntime, mintAgentPreviewClientSecret } from './agent-preview.js';
import { applyDisposition, cancelLosingLegs, markDoNotCall } from './outbound-calls.js';
import { getCallingProvider } from './providers/calling/index.js';
import { clean } from './prospect-normalization.js';
import { maintainHybridCapacity } from './hybrid-capacity.js';
import { hybridOutboundEventsUrl } from './hybrid-urls.js';
import { validHybridTwilioRequest } from './hybrid-twilio-signature.js';

export const HYBRID_TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
export const HYBRID_TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
export const HYBRID_TWILIO_API_KEY_SID = defineSecret('TWILIO_API_KEY_SID');
export const HYBRID_TWILIO_API_KEY_SECRET = defineSecret('TWILIO_API_KEY_SECRET');
export const HYBRID_TWILIO_TWIML_APP_SID = defineSecret('TWILIO_TWIML_APP_SID');
export const HYBRID_AI_MEDIA_SECRET = defineSecret('AI_MEDIA_WEBHOOK_SECRET');
export const HYBRID_OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

const TWILIO_CONTROL_SECRETS = [
  HYBRID_TWILIO_ACCOUNT_SID,
  HYBRID_TWILIO_AUTH_TOKEN,
  HYBRID_TWILIO_API_KEY_SID,
  HYBRID_TWILIO_API_KEY_SECRET,
  HYBRID_TWILIO_TWIML_APP_SID
];

const secretValue = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};

const callOptions = { enforceAppCheck: false, maxInstances: 20 };
const id = (value, label = 'id') => {
  const result = clean(value, 200);
  if (!result || !/^[A-Za-z0-9_:/.-]+$/.test(result)) throw new HttpsError('invalid-argument', `A valid ${label} is required.`);
  return result;
};

async function callerRole(db, auth) {
  if (auth?.token?.role) return clean(auth.token.role, 80);
  const snapshot = await db.doc(`roles/${auth.uid}`).get();
  return snapshot.exists ? clean(snapshot.get('role'), 80) : '';
}

async function requireDialer(request, { manageAgents = false } = {}) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  const role = await callerRole(db, request.auth);
  const dialerRoles = new Set(['admin', 'outbound_rep', 'outbound_manager']);
  if (!dialerRoles.has(role)) throw new HttpsError('permission-denied', 'This account cannot use the outbound dialer.');
  if (manageAgents && !['admin', 'outbound_manager'].includes(role)) {
    throw new HttpsError('permission-denied', 'This account cannot manage AI agent profiles.');
  }
  return { db, uid: request.auth.uid, email: clean(request.auth.token?.email, 200), role };
}

async function ownedSession(db, sessionId, uid) {
  const snapshot = await db.doc(`dialerSessions/${sessionId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Session not found.');
  if (snapshot.get('userUid') !== uid) throw new HttpsError('permission-denied', 'That dialer session belongs to another rep.');
  return { id: sessionId, ...snapshot.data() };
}

async function ownedCall(db, callId, uid) {
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  await ownedSession(db, call.sessionId, uid);
  return call;
}

async function transferCall(db, callId, uid) {
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  const transfer = call.staffTransfer || {};
  if (![transfer.fromUid, transfer.toUid].includes(uid)) {
    throw new HttpsError('permission-denied', 'This staff handoff does not belong to you.');
  }
  return call;
}

async function staffIdentity(db, uid, fallback = '') {
  const [userSnapshot, roleSnapshot] = await Promise.all([
    db.doc(`users/${uid}`).get(), db.doc(`roles/${uid}`).get()
  ]);
  return {
    uid,
    role: clean(roleSnapshot.get('role'), 80),
    email: clean(userSnapshot.get('email') || roleSnapshot.get('email'), 200),
    name: clean(userSnapshot.get('displayName'), 120)
      || clean(userSnapshot.get('email') || roleSnapshot.get('email'), 200).split('@')[0]
      || clean(fallback, 120)
      || 'Teammate'
  };
}

const xml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const conferenceName = (sessionId, targetId) => {
  const token = createHmac('sha256', 'bitesites-conference-v2')
    .update(`${clean(sessionId, 200)}:${clean(targetId, 200)}`).digest('hex').slice(0, 40);
  return `bs_${token}`;
};

const base64url = input => Buffer.from(input).toString('base64url');

function createTwilioVoiceToken({ accountSid, apiKeySid, apiKeySecret, appSid, identity, ttl = 900 }) {
  const now = Math.floor(Date.now() / 1000);
  const boundedTtl = Math.max(60, Math.min(3600, Number(ttl) || 900));
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${apiKeySid}-${now}-${randomBytes(6).toString('hex')}`,
    grants: {
      identity: clean(identity, 121),
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: appSid }
      }
    },
    iat: now,
    exp: now + boundedTtl,
    iss: apiKeySid,
    sub: accountSid
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', apiKeySecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function twilioSignatureValid(req, authToken) {
  const signature = String(req.get?.('x-twilio-signature') || '');
  const publicOrigin = process.env.PUBLIC_APP_URL || `https://${req.get?.('host') || ''}`;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return validHybridTwilioRequest({
    signature,
    body,
    authToken,
    originalUrl: req.originalUrl || req.url || '',
    publicOrigin
  });
}

async function findCallByProviderSid(db, providerCallId) {
  const snapshot = await db.collection('calls').where('providerCallId', '==', providerCallId).limit(1).get();
  return snapshot.empty ? null : { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

async function loadKnowledgeChunks(db, knowledgeBaseIds = []) {
  const chunks = [];
  for (const kbId of knowledgeBaseIds.slice(0, 8)) {
    const kbSnapshot = await db.doc(`knowledgeBases/${kbId}`).get();
    if (!kbSnapshot.exists || kbSnapshot.get('status') !== 'active') continue;
    const docs = await db.collection(`knowledgeBases/${kbId}/documents`).where('status', '==', 'active').limit(8).get();
    for (const entry of docs.docs) {
      chunks.push({ sourceId: `${kbId}/${entry.id}`, title: entry.get('title'), text: entry.get('text'), version: entry.get('version') });
      if (chunks.length >= 8) break;
    }
    if (chunks.length >= 8) break;
  }
  return chunks;
}

async function loadEffectiveRuntime(db, call) {
  const campaignSnapshot = await db.doc(`outboundCampaigns/${call.campaignId}`).get();
  const campaign = campaignSnapshot.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : {};
  const profileId = clean(call?.agent?.profileId || campaign.agentProfileId || campaign.agentId, 200);
  if (!profileId) throw new Error('No AI agent profile is configured for this campaign/call');
  const profileSnapshot = await db.doc(`aiAgentProfiles/${profileId}`).get();
  if (!profileSnapshot.exists || profileSnapshot.get('status') === 'archived') throw new Error('AI agent profile is unavailable');
  const profile = { id: profileSnapshot.id, ...profileSnapshot.data() };

  const contactCollection = call.prospectId ? 'prospects' : 'leads';
  const contactId = call.prospectId || call.leadId;
  const contactSnapshot = contactId ? await db.doc(`${contactCollection}/${contactId}`).get() : null;
  const contact = contactSnapshot?.exists ? { id: contactSnapshot.id, ...contactSnapshot.data() } : {};

  const chunks = await loadKnowledgeChunks(db, profile.knowledgeBaseIds || []);

  const compiled = compileAgentRuntime({
    profile,
    campaignOverride: campaign.agentOverride || {},
    sessionOverride: call.agentSessionOverride || {},
    campaign,
    contact: { ...contact, researchSummary: call.researchSummary || '' },
    knowledgeChunks: chunks
  });
  return { compiled, campaign, profile, contact };
}

// -------------------------------------------------------------- rep/session

export const setHybridAutoTakeover = onCall(callOptions, async request => {
  const { db, uid, role } = await requireDialer(request);
  const sessionId = id(request.data?.sessionId, 'session id');
  await ownedSession(db, sessionId, uid);
  const enabled = request.data?.enabled === true;
  if (role === 'outbound_rep' && enabled) {
    throw new HttpsError('permission-denied', 'Auto Takeover is locked off in guided rep mode.');
  }
  await db.doc(`dialerSessions/${sessionId}`).set({
    takeover: { autoEnabled: enabled }, updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'auto_takeover_changed', {
    sessionId, actorType: 'rep', actorId: uid, metadata: { enabled }
  });
  return { ok: true, enabled };
});

export const requestHybridTakeover = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await ownedCall(db, callId, uid);
  const requested = await requestHumanHandoff(db, callId, { requestedBy: 'rep', actorId: uid });
  const session = await ownedSession(db, call.sessionId, uid);
  const repBusy = Boolean(session?.rep?.activeCallId && session.rep.activeCallId !== callId);
  if (repBusy) return { ...requested, queued: true, reason: 'rep_busy' };
  const handoff = await beginSmoothHandoff(db, call.sessionId, callId, { repUid: uid });
  return { ...requested, handoff };
});

export const beginHybridListen = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await ownedCall(db, callId, uid);
  const result = await setListenState(db, call.sessionId, callId, { repUid: uid, listening: true });
  if (!result.ok) throw new HttpsError('failed-precondition', clean(result.reason, 200));
  return { ok: true, callId, conferenceName: clean(call?.media?.conferenceName, 120) };
});

export const stopHybridListen = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await ownedCall(db, callId, uid);
  return setListenState(db, call.sessionId, callId, { repUid: uid, listening: false });
});

export const getHybridVoiceAccessToken = onCall({ ...callOptions, secrets: TWILIO_CONTROL_SECRETS }, async request => {
  const { uid } = await requireDialer(request);
  const accountSid = secretValue(HYBRID_TWILIO_ACCOUNT_SID);
  const apiKeySid = secretValue(HYBRID_TWILIO_API_KEY_SID);
  const apiKeySecret = secretValue(HYBRID_TWILIO_API_KEY_SECRET);
  const appSid = secretValue(HYBRID_TWILIO_TWIML_APP_SID);
  if (![accountSid, apiKeySid, apiKeySecret, appSid].every(Boolean)) {
    throw new HttpsError('failed-precondition', 'Twilio browser voice credentials are not configured.');
  }
  const identity = `bs_${clean(uid, 110)}`;
  return {
    token: createTwilioVoiceToken({ accountSid, apiKeySid, apiKeySecret, appSid, identity }),
    identity,
    expiresIn: 900
  };
});

// ---------------------------------------------------------- staff handoffs

/** A bounded, role-filtered directory for warm transfer and coaching requests. */
export const listHybridTransferAgents = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const roles = await db.collection('roles')
    .where('role', 'in', ['admin', 'outbound_rep', 'outbound_manager'])
    .limit(100).get();
  const eligible = roles.docs.filter(entry => entry.id !== uid);
  const profiles = eligible.length
    ? await db.getAll(...eligible.map(entry => db.doc(`users/${entry.id}`)))
    : [];
  const activeSessions = await db.collection('dialerSessions').where('status', '==', 'active').limit(100).get();
  const sessionByUid = new Map(activeSessions.docs.map(entry => [entry.get('userUid'), entry.data()]));
  return {
    agents: eligible.map((entry, index) => {
      const profile = profiles[index]?.exists ? profiles[index].data() : {};
      const active = sessionByUid.get(entry.id);
      const onCall = Boolean(active?.rep?.activeCallId);
      return {
        uid: entry.id,
        role: clean(entry.get('role'), 80),
        name: clean(profile?.displayName, 120)
          || clean(profile?.email || entry.get('email'), 200).split('@')[0]
          || 'Teammate',
        availability: onCall ? 'on_call' : 'available'
      };
    })
  };
});

/** Ask a specific teammate to join the same live conference. */
export const requestHybridStaffTransfer = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const toUid = id(request.data?.toUid, 'teammate id');
  if (toUid === uid) throw new HttpsError('invalid-argument', 'Choose another teammate.');
  const call = await ownedCall(db, callId, uid);
  if (['completed', 'cancelled', 'failed'].includes(call.status)) {
    throw new HttpsError('failed-precondition', 'This call has already ended.');
  }
  if (call.control?.controller !== 'human') {
    throw new HttpsError('failed-precondition', 'Join the call before requesting a staff handoff.');
  }
  if (['requested', 'accepted'].includes(call.staffTransfer?.state)) {
    throw new HttpsError('already-exists', 'A staff handoff is already in progress.');
  }
  const [from, to] = await Promise.all([staffIdentity(db, uid), staffIdentity(db, toUid)]);
  if (!['admin', 'outbound_rep', 'outbound_manager'].includes(to.role)) {
    throw new HttpsError('failed-precondition', 'That teammate does not have outbound call access.');
  }
  await db.doc(`calls/${callId}`).set({
    staffTransfer: {
      state: 'requested', fromUid: uid, fromName: from.name,
      toUid, toName: to.name,
      note: clean(request.data?.note, 1000),
      handoffSummary: clean(request.data?.handoffSummary, 2000),
      requestedAt: FieldValue.serverTimestamp(), acceptedAt: null,
      completedAt: null, cancelledAt: null
    },
    media: { ...(call.media || {}), assistParticipantSid: '' },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'staff_transfer_requested', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid, metadata: { toUid }
  });
  return { ok: true, toUid, toName: to.name };
});

export const acceptHybridStaffTransfer = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await transferCall(db, callId, uid);
  if (call.staffTransfer?.toUid !== uid) throw new HttpsError('permission-denied', 'Only the requested teammate can accept.');
  if (call.staffTransfer?.state !== 'requested') throw new HttpsError('failed-precondition', 'This handoff is no longer waiting.');
  await db.doc(`calls/${callId}`).set({
    staffTransfer: { ...call.staffTransfer, state: 'accepted', acceptedAt: FieldValue.serverTimestamp() },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'staff_transfer_accepted', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid, metadata: { fromUid: call.staffTransfer.fromUid }
  });
  return { ok: true };
});

export const declineHybridStaffTransfer = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await transferCall(db, callId, uid);
  const transfer = call.staffTransfer || {};
  const state = transfer.toUid === uid ? 'declined' : 'cancelled';
  await db.doc(`calls/${callId}`).set({
    staffTransfer: {
      ...transfer, state,
      cancelledAt: FieldValue.serverTimestamp(),
      cancellationReason: clean(request.data?.reason, 300)
    },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, `staff_transfer_${state}`, {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid
  });
  return { ok: true, state };
});

/** Finish the warm handoff only after the receiving teammate has joined. */
export const completeHybridStaffTransfer = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await transferCall(db, callId, uid);
  const transfer = call.staffTransfer || {};
  if (transfer.fromUid !== uid) throw new HttpsError('permission-denied', 'The current call owner must complete the handoff.');
  if (transfer.state !== 'accepted') throw new HttpsError('failed-precondition', 'The receiving teammate must join before transfer can complete.');
  const sessionRef = db.doc(`dialerSessions/${call.sessionId}`);
  const callRef = db.doc(`calls/${callId}`);
  await db.runTransaction(async transaction => {
    const [freshCall, sessionSnapshot] = await Promise.all([
      transaction.get(callRef), transaction.get(sessionRef)
    ]);
    const currentTransfer = freshCall.get('staffTransfer') || {};
    if (currentTransfer.state !== 'accepted') throw new Error('The handoff state changed.');
    if (!freshCall.get('media.assistParticipantSid')) {
      throw new HttpsError('failed-precondition', 'The receiving teammate is still connecting to the call.');
    }
    const control = freshCall.get('control') || {};
    transaction.set(callRef, {
      staffTransfer: { ...currentTransfer, state: 'completed', completedAt: FieldValue.serverTimestamp() },
      control: { ...control, controller: 'human', repUid: currentTransfer.toUid, revision: Number(control.revision || 0) + 1 },
      operatorUid: currentTransfer.toUid,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (sessionSnapshot.exists && sessionSnapshot.get('rep.activeCallId') === callId) {
      transaction.set(sessionRef, {
        rep: { state: 'available', activeCallId: '', listeningCallId: '' },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });
  await recordCallAuditEvent(db, 'staff_transfer_completed', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid,
    metadata: { fromUid: transfer.fromUid, toUid: transfer.toUid }
  });
  return { ok: true, newOperatorUid: transfer.toUid };
});

// -------------------------------------------------------- supervisor coaching

export const beginHybridCoachMonitor = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request, { manageAgents: true });
  const callId = id(request.data?.callId, 'call id');
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  if (call.direction !== 'outbound' || ['completed', 'cancelled', 'failed'].includes(call.status)) {
    throw new HttpsError('failed-precondition', 'Only a live outbound call can be monitored.');
  }
  const coach = await staffIdentity(db, uid);
  await db.doc(`calls/${callId}`).set({
    coaching: {
      ...(call.coaching || {}), state: 'monitoring', supervisorUid: uid,
      supervisorName: coach.name, startedAt: FieldValue.serverTimestamp(), endedAt: null
    },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'supervisor_monitor_started', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'supervisor', actorId: uid
  });
  return { ok: true, supervisorName: coach.name };
});

export const sendHybridCoachCue = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request, { manageAgents: true });
  const callId = id(request.data?.callId, 'call id');
  const message = clean(request.data?.message, 500);
  if (!message) throw new HttpsError('invalid-argument', 'Enter a coaching cue.');
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  if (call.coaching?.state !== 'monitoring' || call.coaching?.supervisorUid !== uid) {
    throw new HttpsError('failed-precondition', 'Start private monitor mode before sending a cue.');
  }
  const coach = await staffIdentity(db, uid);
  await db.doc(`calls/${callId}`).set({
    coaching: {
      ...call.coaching,
      latestCue: {
        message, supervisorUid: uid, supervisorName: coach.name,
        at: FieldValue.serverTimestamp()
      }
    },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'supervisor_coaching_cue', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'supervisor', actorId: uid, metadata: { message }
  });
  return { ok: true };
});

export const endHybridCoachMonitor = onCall(callOptions, async request => {
  const { db, uid } = await requireDialer(request, { manageAgents: true });
  const callId = id(request.data?.callId, 'call id');
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  if (call.coaching?.supervisorUid && call.coaching.supervisorUid !== uid) {
    throw new HttpsError('permission-denied', 'Another supervisor owns this monitor session.');
  }
  await db.doc(`calls/${callId}`).set({
    coaching: { ...(call.coaching || {}), state: 'ended', endedAt: FieldValue.serverTimestamp() },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'supervisor_monitor_ended', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'supervisor', actorId: uid
  });
  return { ok: true };
});

// ---------------------------------------------------------- agent profiles

const profileChoice = (value, choices, fallback) => choices.includes(value) ? value : fallback;
const profileNumber = (value, minimum, maximum, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
};

const normalizeProfileInput = (input = {}, existing = {}) => ({
  name: clean(input.name ?? existing.name, 120) || 'Untitled agent',
  description: clean(input.description ?? existing.description, 1000),
  status: input.status === 'archived' ? 'archived' : 'active',
  personality: {
    preset: clean(input.personality?.preset ?? existing.personality?.preset, 80),
    tone: clean(input.personality?.tone ?? existing.personality?.tone, 500),
    pacing: profileChoice(input.personality?.pacing ?? existing.personality?.pacing, ['measured', 'natural', 'brisk', 'fast'], 'natural'),
    formality: profileChoice(input.personality?.formality ?? existing.personality?.formality, ['casual', 'professional', 'formal'], 'professional'),
    languagePolicy: clean(input.personality?.languagePolicy ?? existing.personality?.languagePolicy, 500),
    energy: profileChoice(input.personality?.energy ?? existing.personality?.energy, ['low', 'balanced', 'high'], 'balanced'),
    emotion: profileChoice(input.personality?.emotion ?? existing.personality?.emotion, ['neutral', 'warm', 'enthusiastic', 'empathetic', 'calm'], 'warm'),
    accent: clean(input.personality?.accent ?? existing.personality?.accent, 300),
    pauseStyle: profileChoice(input.personality?.pauseStyle ?? existing.personality?.pauseStyle, ['minimal', 'natural', 'deliberate'], 'natural'),
    fillerWords: profileChoice(input.personality?.fillerWords ?? existing.personality?.fillerWords, ['none', 'minimal', 'natural'], 'minimal'),
    responseLength: profileChoice(input.personality?.responseLength ?? existing.personality?.responseLength, ['brief', 'concise', 'balanced', 'detailed'], 'concise'),
    pronunciationGuidance: clean(input.personality?.pronunciationGuidance ?? existing.personality?.pronunciationGuidance, 1000)
  },
  turnTaking: {
    mode: profileChoice(input.turnTaking?.mode ?? existing.turnTaking?.mode, ['semantic_vad', 'server_vad'], 'semantic_vad'),
    eagerness: profileChoice(input.turnTaking?.eagerness ?? existing.turnTaking?.eagerness, ['low', 'medium', 'high', 'auto'], 'medium'),
    allowInterruptions: input.turnTaking?.allowInterruptions ?? existing.turnTaking?.allowInterruptions ?? true,
    noiseReduction: profileChoice(input.turnTaking?.noiseReduction ?? existing.turnTaking?.noiseReduction, ['off', 'near_field', 'far_field'], 'far_field'),
    threshold: profileNumber(input.turnTaking?.threshold ?? existing.turnTaking?.threshold, 0, 1, 0.5),
    prefixPaddingMs: Math.round(profileNumber(input.turnTaking?.prefixPaddingMs ?? existing.turnTaking?.prefixPaddingMs, 0, 2000, 300)),
    silenceDurationMs: Math.round(profileNumber(input.turnTaking?.silenceDurationMs ?? existing.turnTaking?.silenceDurationMs, 100, 5000, 500)),
    idleTimeoutMs: Math.round(profileNumber(input.turnTaking?.idleTimeoutMs ?? existing.turnTaking?.idleTimeoutMs, 0, 120000, 10000))
  },
  responseSettings: {
    maxOutputTokens: Math.round(profileNumber(input.responseSettings?.maxOutputTokens ?? existing.responseSettings?.maxOutputTokens, 64, 4096, 512)),
    reasoningEffort: profileChoice(input.responseSettings?.reasoningEffort ?? existing.responseSettings?.reasoningEffort, ['minimal', 'low', 'medium', 'high', 'xhigh'], 'low')
  },
  objective: {
    mode: ['qualify', 'sell', 'book', 'support', 'custom'].includes(input.objective?.mode)
      ? input.objective.mode : existing.objective?.mode || 'custom',
    primaryGoal: clean(input.objective?.primaryGoal ?? existing.objective?.primaryGoal, 1000),
    successCriteria: (input.objective?.successCriteria ?? existing.objective?.successCriteria ?? []).slice(0, 20).map(value => clean(value, 300)).filter(Boolean)
  },
  permissions: {
    mayQuotePricing: input.permissions?.mayQuotePricing ?? existing.permissions?.mayQuotePricing ?? false,
    mayOfferDiscount: input.permissions?.mayOfferDiscount ?? existing.permissions?.mayOfferDiscount ?? false,
    maxDiscountPercent: Math.max(0, Math.min(100, Number(input.permissions?.maxDiscountPercent ?? existing.permissions?.maxDiscountPercent) || 0)),
    mayBookMeeting: input.permissions?.mayBookMeeting ?? existing.permissions?.mayBookMeeting ?? true,
    mayCloseSale: input.permissions?.mayCloseSale ?? existing.permissions?.mayCloseSale ?? false,
    mayCollectPayment: input.permissions?.mayCollectPayment ?? existing.permissions?.mayCollectPayment ?? false,
    maySendSms: input.permissions?.maySendSms ?? existing.permissions?.maySendSms ?? false,
    maySendEmail: input.permissions?.maySendEmail ?? existing.permissions?.maySendEmail ?? false
  },
  rules: {
    requiredDisclosures: (input.rules?.requiredDisclosures ?? existing.rules?.requiredDisclosures ?? []).slice(0, 20).map(value => clean(value, 500)).filter(Boolean),
    prohibitedClaims: (input.rules?.prohibitedClaims ?? existing.rules?.prohibitedClaims ?? []).slice(0, 30).map(value => clean(value, 500)).filter(Boolean),
    escalationRules: (input.rules?.escalationRules ?? existing.rules?.escalationRules ?? []).slice(0, 20).map(value => clean(value, 500)).filter(Boolean),
    objectionRules: (input.rules?.objectionRules ?? existing.rules?.objectionRules ?? []).slice(0, 30).map(value => clean(value, 700)).filter(Boolean)
  },
  handoffPhrase: clean(input.handoffPhrase ?? existing.handoffPhrase, 500) || 'I’m going to bring a member of our team into the conversation now.',
  advancedInstructions: clean(input.advancedInstructions ?? existing.advancedInstructions, 5000),
  knowledgeBaseIds: (input.knowledgeBaseIds ?? existing.knowledgeBaseIds ?? []).slice(0, 20).map(value => clean(value, 200)).filter(Boolean),
  model: clean(input.model ?? existing.model, 120) || 'gpt-realtime-2.1',
  voice: profileChoice(input.voiceSettings?.builtInVoice ?? input.voice ?? existing.voiceSettings?.builtInVoice ?? existing.voice, ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'], 'marin'),
  voiceSettings: {
    source: (input.voiceSettings?.source ?? existing.voiceSettings?.source) === 'custom' ? 'custom' : 'built_in',
    builtInVoice: profileChoice(input.voiceSettings?.builtInVoice ?? input.voice ?? existing.voiceSettings?.builtInVoice ?? existing.voice, ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'], 'marin'),
    customVoiceId: clean(input.voiceSettings?.customVoiceId ?? existing.voiceSettings?.customVoiceId, 160),
    playbackSpeed: profileNumber(input.voiceSettings?.playbackSpeed ?? existing.voiceSettings?.playbackSpeed, 0.25, 1.5, 1)
  }
});

function validateProfileInput(profile) {
  if (profile.voiceSettings?.source === 'custom'
    && !/^voice_[A-Za-z0-9_-]+$/.test(profile.voiceSettings?.customVoiceId || '')) {
    throw new HttpsError('invalid-argument', 'Enter a valid custom voice ID beginning with voice_.');
  }
  return profile;
}

export const listAIAgentProfiles = onCall(callOptions, async request => {
  const { db } = await requireDialer(request);
  const snapshot = await db.collection('aiAgentProfiles').orderBy('updatedAt', 'desc').limit(100).get();
  return { profiles: snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() })) };
});

export const createAIAgentProfile = onCall(callOptions, async request => {
  const { db, uid, email } = await requireDialer(request, { manageAgents: true });
  const ref = db.collection('aiAgentProfiles').doc();
  const profile = validateProfileInput(normalizeProfileInput(request.data || {}));
  await ref.set({
    ...profile, version: 1, createdBy: email || uid, updatedBy: email || uid,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  });
  return { profileId: ref.id, version: 1 };
});

export const updateAIAgentProfile = onCall(callOptions, async request => {
  const { db, uid, email } = await requireDialer(request, { manageAgents: true });
  const profileId = id(request.data?.profileId, 'profile id');
  const ref = db.doc(`aiAgentProfiles/${profileId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Agent profile not found.');
  const version = Math.max(1, Number(snapshot.get('version')) || 1) + 1;
  const profile = validateProfileInput(normalizeProfileInput(request.data?.profile || {}, snapshot.data()));
  await db.doc(`aiAgentProfiles/${profileId}/versions/${String(version - 1).padStart(6, '0')}`).set({
    ...snapshot.data(), archivedAt: FieldValue.serverTimestamp()
  });
  await ref.set({ ...profile, version, updatedBy: email || uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, profileId, version };
});

export const archiveAIAgentProfile = onCall(callOptions, async request => {
  const { db, uid, email } = await requireDialer(request, { manageAgents: true });
  const profileId = id(request.data?.profileId, 'profile id');
  await db.doc(`aiAgentProfiles/${profileId}`).set({
    status: 'archived', updatedBy: email || uid, updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true };
});

export const previewAIAgentRuntime = onCall(callOptions, async request => {
  await requireDialer(request, { manageAgents: true });
  const compiled = compileAgentRuntime({
    profile: request.data?.profile || {},
    campaignOverride: request.data?.campaignOverride || {},
    sessionOverride: request.data?.sessionOverride || {},
    campaign: request.data?.campaign || {},
    contact: request.data?.contact || {},
    knowledgeChunks: []
  });
  return runtimePreview(compiled);
});

/** Mint one short-lived OpenAI credential for a browser-only draft preview. */
export const createAIAgentPreviewSession = onCall(
  { ...callOptions, secrets: [HYBRID_OPENAI_API_KEY] },
  async request => {
    const { db, uid } = await requireDialer(request, { manageAgents: true });
    const apiKey = secretValue(HYBRID_OPENAI_API_KEY);
    if (!apiKey) throw new HttpsError('failed-precondition', 'OpenAI is not configured for agent previews.');

    const mode = clean(request.data?.mode, 20) || 'conversation';
    let profile;
    let preview;
    try {
      profile = validateProfileInput(normalizeProfileInput(request.data?.profile || {}));
      profile.id = clean(request.data?.profile?.id, 200) || 'preview';
      profile.version = Math.max(1, Number(request.data?.profile?.version) || 1);
      const knowledgeChunks = await loadKnowledgeChunks(db, profile.knowledgeBaseIds || []);
      preview = buildAgentPreviewRuntime({ profile, knowledgeChunks, mode });
    } catch (error) {
      throw new HttpsError('invalid-argument', clean(error?.message, 400) || 'The agent preview configuration is invalid.');
    }

    let secret;
    try {
      secret = await mintAgentPreviewClientSecret({ apiKey, uid, session: preview.session });
    } catch (error) {
      throw new HttpsError('internal', clean(error?.message, 400) || 'Could not start the agent preview.');
    }

    return {
      clientSecret: secret.value,
      expiresAt: secret.expiresAt,
      mode,
      model: preview.compiled.model,
      voice: preview.compiled.voice,
      effectiveConfigHash: preview.compiled.effectiveConfigHash
    };
  }
);

// ------------------------------------------------------------- knowledge KB

export const listAIKnowledgeBases = onCall(callOptions, async request => {
  const { db } = await requireDialer(request);
  const snapshot = await db.collection('knowledgeBases').orderBy('updatedAt', 'desc').limit(100).get();
  return { knowledgeBases: snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() })) };
});

export const createAIKnowledgeBase = onCall(callOptions, async request => {
  const { db, uid, email } = await requireDialer(request, { manageAgents: true });
  const ref = db.collection('knowledgeBases').doc();
  await ref.set({
    name: clean(request.data?.name, 120) || 'Untitled knowledge base',
    description: clean(request.data?.description, 1000),
    status: 'active', version: 1,
    createdBy: email || uid, updatedBy: email || uid,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  });
  return { knowledgeBaseId: ref.id };
});

export const upsertAIKnowledgeDocument = onCall(callOptions, async request => {
  const { db, uid, email } = await requireDialer(request, { manageAgents: true });
  const kbId = id(request.data?.knowledgeBaseId, 'knowledge base id');
  const kbSnapshot = await db.doc(`knowledgeBases/${kbId}`).get();
  if (!kbSnapshot.exists) throw new HttpsError('not-found', 'Knowledge base not found.');
  const documentId = clean(request.data?.documentId, 200) || db.collection(`knowledgeBases/${kbId}/documents`).doc().id;
  const ref = db.doc(`knowledgeBases/${kbId}/documents/${documentId}`);
  const prior = await ref.get();
  const version = Math.max(0, Number(prior.get('version')) || 0) + 1;
  const text = clean(request.data?.text, 20000);
  if (!text) throw new HttpsError('invalid-argument', 'Knowledge document text is required.');
  await ref.set({
    title: clean(request.data?.title, 200) || 'Untitled document',
    text, status: request.data?.status === 'archived' ? 'archived' : 'active', version,
    updatedBy: email || uid,
    createdAt: prior.exists ? prior.get('createdAt') : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await db.doc(`knowledgeBases/${kbId}`).set({
    version: Math.max(1, Number(kbSnapshot.get('version')) || 1) + 1,
    updatedBy: email || uid,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true, documentId, version };
});

// -------------------------------------------------------------- Twilio TwiML

/** TwiML executed on the outbound prospect leg. */
export const twilioHybridProspectTwiML = onRequest({ secrets: [HYBRID_TWILIO_AUTH_TOKEN], maxInstances: 30 }, async (req, res) => {
  if (!twilioSignatureValid(req, secretValue(HYBRID_TWILIO_AUTH_TOKEN))) {
    res.status(401).type('text/plain').send('unauthorized'); return;
  }
  const sessionId = clean(req.query?.sessionId || req.body?.sessionId, 200);
  const targetId = clean(req.query?.targetId || req.body?.targetId, 200);
  if (!sessionId || !targetId) { res.status(400).type('text/plain').send('missing routing metadata'); return; }
  const room = conferenceName(sessionId, targetId);
  const callSid = clean(req.body?.CallSid, 200);
  if (callSid) {
    const db = getFirestore();
    const call = await findCallByProviderSid(db, callSid);
    if (call) await db.doc(`calls/${call.id}`).set({
      media: { ...(call.media || {}), conferenceName: room, prospectParticipantSid: callSid },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  const callback = `${process.env.PUBLIC_APP_URL || `https://${req.get('host')}`}/api/twilio-conference-events?sessionId=${encodeURIComponent(sessionId)}&targetId=${encodeURIComponent(targetId)}`;
  res.status(200).type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="" participantLabel="prospect" statusCallback="${xml(callback)}" statusCallbackMethod="POST" statusCallbackEvent="start end join leave mute hold">${xml(room)}</Conference></Dial></Response>`
  );
});

/** TwiML App Voice URL for browser Voice SDK joins. */
export const twilioHybridBrowserTwiML = onRequest({ secrets: [HYBRID_TWILIO_AUTH_TOKEN], maxInstances: 30 }, async (req, res) => {
  if (!twilioSignatureValid(req, secretValue(HYBRID_TWILIO_AUTH_TOKEN))) {
    res.status(401).type('text/plain').send('unauthorized'); return;
  }
  const callId = clean(req.body?.callId || req.query?.callId, 200);
  const requestedMode = clean(req.body?.mode || req.query?.mode, 20);
  const mode = ['listen', 'assist', 'coach'].includes(requestedMode) ? requestedMode : 'human';
  if (!callId) { res.status(400).type('text/plain').send('missing callId'); return; }
  const db = getFirestore();
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) { res.status(404).type('text/plain').send('call not found'); return; }
  const call = snapshot.data();
  const room = call?.media?.conferenceName || conferenceName(call.sessionId, call.targetId);
  const identity = clean(String(req.body?.From || '').replace(/^client:/, ''), 121);
  const sessionSnapshot = await db.doc(`dialerSessions/${call.sessionId}`).get();
  const expectedIdentity = `bs_${clean(sessionSnapshot.get('userUid'), 110)}`;
  const transferIdentity = `bs_${clean(call?.staffTransfer?.toUid, 110)}`;
  const transferAllowed = mode === 'assist'
    && ['accepted', 'completed'].includes(call?.staffTransfer?.state)
    && identity === transferIdentity;
  const identityUid = identity.startsWith('bs_') ? identity.slice(3) : '';
  const coachRoleSnapshot = mode === 'coach' && identityUid ? await db.doc(`roles/${identityUid}`).get() : null;
  const coachAllowed = mode === 'coach'
    && ['admin', 'outbound_manager'].includes(clean(coachRoleSnapshot?.get('role'), 80))
    && call?.coaching?.state === 'monitoring'
    && call?.coaching?.supervisorUid === identityUid;
  if (!identity || (identity !== expectedIdentity && !transferAllowed && !coachAllowed)) { res.status(403).type('text/plain').send('wrong rep'); return; }
  const label = `${mode}-${clean(sessionSnapshot.get('userUid'), 80)}`.slice(0, 120);
  const participantLabel = mode === 'assist' ? `assist-${call.staffTransfer.toUid}`
    : mode === 'coach' ? `coach-${identityUid}` : label;
  res.status(200).type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" muted="${['listen', 'coach'].includes(mode) ? 'true' : 'false'}" startConferenceOnEnter="true" endConferenceOnExit="false" participantLabel="${xml(participantLabel)}">${xml(room)}</Conference></Dial></Response>`
  );
});

export const twilioHybridConferenceEvent = onRequest({ secrets: [HYBRID_TWILIO_AUTH_TOKEN], maxInstances: 30 }, async (req, res) => {
  if (!twilioSignatureValid(req, secretValue(HYBRID_TWILIO_AUTH_TOKEN))) { res.status(401).json({ error: 'unauthorized' }); return; }
  const db = getFirestore();
  const sessionId = clean(req.query?.sessionId, 200);
  const targetId = clean(req.query?.targetId, 200);
  const conferenceSid = clean(req.body?.ConferenceSid, 200);
  const callSid = clean(req.body?.CallSid, 200);
  const label = clean(req.body?.ParticipantLabel, 128);
  const event = clean(req.body?.StatusCallbackEvent, 80);
  if (sessionId && targetId) {
    const targetSnapshot = await db.doc(`outboundTargets/${targetId}`).get();
    const callId = targetSnapshot.exists ? clean(targetSnapshot.get('lastCallId'), 200) : '';
    if (callId) {
      const callSnapshot = await db.doc(`calls/${callId}`).get();
      const media = callSnapshot.exists ? callSnapshot.get('media') || {} : {};
      const update = { conferenceSid: conferenceSid || media.conferenceSid, conferenceName: media.conferenceName || conferenceName(sessionId, targetId) };
      if (label === 'prospect' && callSid) update.prospectParticipantSid = callSid;
      if (label.startsWith('human-') && callSid) update.humanParticipantSid = callSid;
      if (label.startsWith('listen-') && callSid) update.listenerParticipantSid = callSid;
      if (label.startsWith('assist-') && callSid) {
        update.assistParticipantSid = event === 'participant-leave' ? '' : callSid;
      }
      if (label.startsWith('coach-') && callSid) {
        update.coachParticipantSid = event === 'participant-leave' ? '' : callSid;
      }
      await db.doc(`calls/${callId}`).set({ media: { ...media, ...update }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (event === 'participant-join' && label.startsWith('human-') && callSnapshot.get('control.controller') === 'transitioning') {
        const repUid = clean(label.slice('human-'.length), 160);
        await completeSmoothHandoff(db, sessionId, callId, { repUid, humanParticipantSid: callSid }).catch(() => {});
      }
    }
  }
  res.status(200).json({ ok: true });
});

// --------------------------------------------------------- Twilio call event

export const recordHybridCallEvent = onRequest({
  secrets: [
    HYBRID_TWILIO_ACCOUNT_SID,
    HYBRID_TWILIO_AUTH_TOKEN,
    HYBRID_TWILIO_TWIML_APP_SID,
    HYBRID_AI_MEDIA_SECRET
  ],
  maxInstances: 30
}, async (req, res) => {
  if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return; }
  const authToken = secretValue(HYBRID_TWILIO_AUTH_TOKEN);
  if (!twilioSignatureValid(req, authToken)) { res.status(401).json({ error: 'unauthorized' }); return; }

  const provider = getCallingProvider('twilio', {
    accountSid: secretValue(HYBRID_TWILIO_ACCOUNT_SID),
    authToken,
    twimlAppSid: secretValue(HYBRID_TWILIO_TWIML_APP_SID),
    statusCallbackUrl: ''
  });
  const event = provider.normalizeWebhookEvent(req.body, {
    targetId: clean(req.query?.targetId, 200),
    campaignId: clean(req.query?.campaignId, 200),
    sessionId: clean(req.query?.sessionId, 200)
  });
  if (!event) { res.status(200).json({ ok: true, ignored: true }); return; }

  const db = getFirestore();
  const eventId = `hybrid_twilio_${clean(event.providerCallId || event.targetId, 160)}_${clean(event.type, 40)}_${Math.floor(event.at.getTime() / 1000)}`;
  const eventRef = db.doc(`outboundCallEvents/${eventId.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  const accepted = await db.runTransaction(async transaction => {
    const prior = await transaction.get(eventRef);
    if (prior.exists) return false;
    transaction.set(eventRef, { ...event, receivedAt: FieldValue.serverTimestamp(), hybridV2: true });
    return true;
  });
  if (!accepted) { res.status(200).json({ ok: true, duplicate: true }); return; }

  const call = await findCallByProviderSid(db, event.providerCallId);
  if (!call) { res.status(200).json({ ok: true, ignored: 'call_not_found' }); return; }
  const callRef = db.doc(`calls/${call.id}`);
  const stamp = Timestamp.fromDate(event.at);
  const common = { updatedAt: FieldValue.serverTimestamp() };
  if (event.type === 'ringing') common.ringingAt = stamp;
  if (['answered', 'human_answered', 'machine_answered'].includes(event.type)) common.answeredAt = stamp;
  if (event.recordingUrl) common.recordingUrl = event.recordingUrl;
  if (Number.isFinite(event.durationSec)) common.durationSec = event.durationSec;
  await callRef.set(common, { merge: true });

  if (event.type === 'human_answered') {
    const routed = await routeVerifiedHumanAnswer(db, call.sessionId, call.id, { targetId: call.targetId, now: event.at });
    if (routed.controller === 'none') {
      await provider.endCall(call.providerCallId).catch(() => {});
      const campaignSnapshot = call.campaignId ? await db.doc(`outboundCampaigns/${call.campaignId}`).get() : null;
      await applyDisposition(db, {
        targetId: call.targetId,
        callId: call.id,
        disposition: 'completed',
        campaign: campaignSnapshot?.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null,
        actor: 'system',
        now: event.at
      }).catch(() => {});
      res.status(200).json({ ok: true, callId: call.id, routed: 'none' }); return;
    }
    if (routed.controller === 'human') {
      const sessionSnapshot = await db.doc(`dialerSessions/${call.sessionId}`).get();
      if (sessionSnapshot.get('operatingMode') === 'human') {
        const campaignSnapshot = await db.doc(`outboundCampaigns/${call.campaignId}`).get();
        await cancelLosingLegs(db, call.sessionId, {
          winningCallId: call.id,
          campaign: campaignSnapshot.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null,
          now: event.at,
          providerConfig: {
            accountSid: secretValue(HYBRID_TWILIO_ACCOUNT_SID),
            authToken,
            twimlAppSid: secretValue(HYBRID_TWILIO_TWIML_APP_SID),
            statusCallbackUrl: hybridOutboundEventsUrl(),
            hybridV2: true
          }
        });
      }
    }
    if (routed.controller === 'ai') {
      let runtime;
      try { runtime = await loadEffectiveRuntime(db, call); }
      catch (error) {
        await callRef.set({ aiAttachError: clean(error?.message, 300), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        res.status(200).json({ ok: true, routed: 'ai', aiPending: false, error: 'agent_config_unavailable' }); return;
      }
      await callRef.set({
        agent: {
          profileId: runtime.compiled.profileId,
          profileVersion: runtime.compiled.profileVersion,
          effectiveConfigHash: runtime.compiled.effectiveConfigHash,
          model: runtime.compiled.model,
          voice: runtime.compiled.voice
        },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await db.doc(`aiMediaJobs/${call.id}`).set({
        callId: call.id, sessionId: call.sessionId, campaignId: call.campaignId,
        conferenceName: call?.media?.conferenceName || conferenceName(call.sessionId, call.targetId),
        status: 'pending',
        runtime: {
          model: runtime.compiled.model,
          voice: runtime.compiled.voice,
          sessionConfig: runtime.compiled.sessionConfig,
          instructions: runtime.compiled.instructions,
          tools: runtime.compiled.tools,
          profileId: runtime.compiled.profileId,
          profileVersion: runtime.compiled.profileVersion,
          effectiveConfigHash: runtime.compiled.effectiveConfigHash,
          handoffPhrase: runtime.compiled.handoffPhrase
        },
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.status(200).json({ ok: true, callId: call.id, routed: routed.controller }); return;
  }

  if (event.type === 'machine_answered') {
    await callRef.set({ answeredBy: 'machine', status: 'open' }, { merge: true });
    res.status(200).json({ ok: true, callId: call.id, machine: true }); return;
  }

  const terminal = new Set(['completed', 'cancelled', 'failed', 'busy', 'no_answer']);
  if (terminal.has(event.type)) {
    await callRef.set({ status: event.type === 'cancelled' ? 'cancelled' : 'completed', endedAt: stamp }, { merge: true });
    const campaignSnapshot = call.campaignId ? await db.doc(`outboundCampaigns/${call.campaignId}`).get() : null;
    const campaign = campaignSnapshot?.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null;
    await applyDisposition(db, {
      targetId: call.targetId,
      callId: call.id,
      disposition: event.disposition || event.type,
      campaign,
      actor: 'provider',
      now: event.at
    }).catch(() => {});
    if (call?.control?.controller === 'human' || call?.control?.controller === 'transitioning') {
      const release = await releaseRepFromCall(db, call.sessionId, call.id, { repUid: call?.control?.repUid || '', now: event.at }).catch(() => null);
      if (release?.autoTakeover) {
        const next = await nextAutoTakeoverCall(db, call.sessionId).catch(() => null);
        if (next) await beginSmoothHandoff(db, call.sessionId, next.id, { repUid: (await db.doc(`dialerSessions/${call.sessionId}`).get()).get('userUid') }).catch(() => {});
      }
    }
    await maintainHybridCapacity(db, call.sessionId, {
      providerConfig: {
        accountSid: secretValue(HYBRID_TWILIO_ACCOUNT_SID),
        authToken,
        twimlAppSid: secretValue(HYBRID_TWILIO_TWIML_APP_SID),
        statusCallbackUrl: hybridOutboundEventsUrl(),
        hybridV2: true
      }
    }).catch(async error => {
      console.error('[hybrid-capacity] terminal refill failed', clean(error?.message, 300));
      await db.doc(`dialerSessions/${call.sessionId}`).set({
        autoDial: { state: 'error', lastError: clean(error?.message, 300) },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
  }

  res.status(200).json({ ok: true, callId: call.id, type: event.type });
});

// ----------------------------------------------------------- AI media bridge

function mediaSecretOk(req) {
  const expected = clean(secretValue(HYBRID_AI_MEDIA_SECRET), 300);
  const provided = clean(req.get('x-ai-media-secret'), 300);
  return expected.length >= 24 && expected.length === provided.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export const hybridAIMediaControl = onRequest({ secrets: [HYBRID_AI_MEDIA_SECRET], maxInstances: 30 }, async (req, res) => {
  if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return; }
  if (!mediaSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  const db = getFirestore();
  const callId = clean(req.body?.callId, 200);
  if (!callId) { res.status(400).json({ error: 'callId-required' }); return; }
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) { res.status(404).json({ error: 'call-not-found' }); return; }
  const call = { id: callId, ...callSnapshot.data() };
  const action = clean(req.body?.action, 60);

  if (action === 'attached') {
    await attachAIController(db, callId, clean(req.body?.aiSessionId, 240), {
      model: req.body?.model,
      voice: req.body?.voice,
      profileId: call?.agent?.profileId,
      profileVersion: call?.agent?.profileVersion,
      effectiveConfigHash: call?.agent?.effectiveConfigHash
    });
    await db.doc(`aiMediaJobs/${callId}`).set({ status: 'active', aiSessionId: clean(req.body?.aiSessionId, 240), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true }); return;
  }

  if (action === 'transcript') {
    const speaker = ['prospect', 'ai', 'human', 'system'].includes(req.body?.speaker) ? req.body.speaker : 'system';
    const text = clean(req.body?.text, 4000);
    if (!text) { res.status(400).json({ error: 'text-required' }); return; }
    const sequence = Math.max(0, Number(req.body?.sequence) || Date.now());
    const turnId = String(sequence).padStart(16, '0').slice(-20);
    await db.doc(`calls/${callId}/turns/${turnId}`).set({
      sequence, speaker, text, final: req.body?.final !== false,
      modelEventId: clean(req.body?.modelEventId, 200),
      startedAt: req.body?.startedAt ? Timestamp.fromDate(new Date(req.body.startedAt)) : null,
      endedAt: req.body?.endedAt ? Timestamp.fromDate(new Date(req.body.endedAt)) : null,
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true, turnId }); return;
  }

  if (action === 'prospect_requested_human') {
    const result = await requestHumanHandoff(db, callId, { requestedBy: 'prospect', actorId: 'ai' });
    const sessionSnapshot = await db.doc(`dialerSessions/${call.sessionId}`).get();
    const autoEnabled = sessionSnapshot.get('takeover.autoEnabled') === true;
    const repFree = !sessionSnapshot.get('rep.activeCallId') && ['available', 'listening', undefined].includes(sessionSnapshot.get('rep.state'));
    let handoff = null;
    if (autoEnabled && repFree) {
      handoff = await beginSmoothHandoff(db, call.sessionId, callId, { repUid: sessionSnapshot.get('userUid') });
    }
    res.json({ ok: true, result, autoEnabled, repFree, handoff }); return;
  }

  if (action === 'do_not_call') {
    await markDoNotCall(db, call.targetId, { actor: 'ai' });
    await recordCallAuditEvent(db, 'dnc_marked', { callId, sessionId: call.sessionId, campaignId: call.campaignId, actorType: 'ai', actorId: clean(req.body?.aiSessionId, 160) });
    res.json({ ok: true }); return;
  }

  if (action === 'handoff_failed') {
    const result = await failSmoothHandoff(db, call.sessionId, callId, {
      repUid: clean(req.body?.repUid, 160), reason: clean(req.body?.reason, 160) || 'media_failure'
    });
    res.json(result); return;
  }

  res.status(400).json({ error: 'unknown-action' });
});

// ------------------------------------------------------- OpenAI SIP webhook

/**
 * OpenAI Realtime SIP incoming-call webhook.
 *
 * The realtime runtime/service is expected to originate a SIP participant to
 * OpenAI with an X-BiteSites-Call-ID header. This endpoint accepts the call with
 * the precompiled server-side runtime and writes the returned session metadata
 * to aiMediaJobs. Persistent monitoring/tool events belong in the media runtime,
 * not in this short HTTP request.
 */
export const openAIRealtimeIncomingCall = onRequest({ secrets: [HYBRID_OPENAI_API_KEY, HYBRID_AI_MEDIA_SECRET], maxInstances: 30 }, async (req, res) => {
  // OpenAI webhook signature verification should be terminated by the dedicated
  // media runtime in production. This Firebase endpoint is intentionally gated
  // behind our media secret when invoked by that runtime, not exposed as the
  // primary public OpenAI webhook.
  if (!mediaSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  const db = getFirestore();
  const callId = clean(req.body?.callId || req.body?.bitesitesCallId, 200);
  const realtimeCallId = clean(req.body?.realtimeCallId || req.body?.data?.call_id, 240);
  if (!callId || !realtimeCallId) { res.status(400).json({ error: 'missing-call-identifiers' }); return; }
  const jobSnapshot = await db.doc(`aiMediaJobs/${callId}`).get();
  if (!jobSnapshot.exists) { res.status(404).json({ error: 'media-job-not-found' }); return; }
  const runtime = jobSnapshot.get('runtime') || {};
  const apiKey = secretValue(HYBRID_OPENAI_API_KEY);
  if (!apiKey) { res.status(503).json({ error: 'openai-not-configured' }); return; }

  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(realtimeCallId)}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'realtime',
      model: clean(runtime.model, 120) || 'gpt-realtime-2.1',
      instructions: clean(runtime.instructions, 30000),
      ...sanitizeRealtimeSessionConfig(runtime.sessionConfig, clean(runtime.voice, 120) || 'marin')
    })
  });
  const body = await response.text();
  if (!response.ok) { res.status(502).json({ error: 'openai-accept-failed', detail: clean(body, 500) }); return; }
  let accepted = {};
  try { accepted = JSON.parse(body); } catch { accepted = { raw: clean(body, 1000) }; }
  await db.doc(`aiMediaJobs/${callId}`).set({
    status: 'accepted', realtimeCallId, openAI: { callId: realtimeCallId, wssUrl: clean(accepted?.wss_url, 1000) },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  res.status(200).json({ ok: true, realtimeCallId, wssUrl: clean(accepted?.wss_url, 1000) });
});
