// Hybrid AI Dialer V2 control-plane Cloud Functions.
//
// Existing outbound functions remain exported through v2-index.js. These
// endpoints add V2 ownership, handoff, agent configuration, Twilio browser
// access tokens/TwiML, transcript ingestion, and OpenAI/Twilio control hooks.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
import { normalizeOfferTrackKeys } from './offer-tracks.js';
import { buildAgentPreviewRuntime, mintAgentPreviewClientSecret } from './agent-preview.js';
import { applyDisposition, cancelLosingLegs, markDoNotCall } from './outbound-calls.js';
import { getCallingProvider } from './providers/calling/index.js';
import { clean } from './prospect-normalization.js';
import { LEGACY_ACCOUNT_ID, requireAccountId, readAccountId, getAccount } from './accounts.js';
import { assertAccountAccess, assertDocumentAccountAccess, assertOutboundAccess, normalizeAccountScope, resolveAccountAccess } from './account-access.js';
import { maintainHybridCapacity } from './hybrid-capacity.js';
import { hybridOutboundEventsUrl } from './hybrid-urls.js';
import { validHybridTwilioRequest } from './hybrid-twilio-signature.js';
import { hybridCallProgress } from './hybrid-call-progress.js';
import { aiMediaAttachDeadline, failClosedAIMediaAttachment, isAIMediaAttachPending } from './hybrid-media-failsafe.js';
import { externalDialingAdmission } from './deployment-environment.js';
import {
  buildRepTrainingSession, evaluateRepTrainingTranscript, hasRepTrainingAccess,
  hasRepTrainingExemption, nextRepTrainingScenario, publicTrainingScenario,
  repTrainingScenarios
} from './rep-training.js';

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

function hybridTwilioProvider(authToken = secretValue(HYBRID_TWILIO_AUTH_TOKEN)) {
  return getCallingProvider('twilio', {
    accountSid: secretValue(HYBRID_TWILIO_ACCOUNT_SID),
    authToken,
    twimlAppSid: secretValue(HYBRID_TWILIO_TWIML_APP_SID),
    statusCallbackUrl: '',
    hybridV2: true
  });
}

/** End the prospect's PSTN leg after the state machine has failed closed. */
async function endFailedAIMediaPstn(db, callId, {
  reason, source, realtimeCallId = '', provider = null, now = new Date()
} = {}) {
  const result = await failClosedAIMediaAttachment(db, callId, { reason, source, realtimeCallId, now });
  if (!result.ok) return result;
  if (result.shouldTerminateRealtime && result.realtimeCallId) {
    const apiKey = secretValue(HYBRID_OPENAI_API_KEY);
    if (apiKey) {
      try {
        const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(result.realtimeCallId)}/hangup`, {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000)
        });
        await db.doc(`calls/${callId}`).set({
          'media.realtimeHangupAttemptedAt': FieldValue.serverTimestamp(),
          'media.realtimeHangupFailed': !response.ok,
          ...(response.ok ? { 'media.realtimeHangupConfirmedAt': FieldValue.serverTimestamp() } : {}),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      } catch {
        await db.doc(`calls/${callId}`).set({
          'media.realtimeHangupAttemptedAt': FieldValue.serverTimestamp(),
          'media.realtimeHangupFailed': true, updatedAt: FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});
      }
    }
  }
  if (!result.shouldTerminatePstn) return result;
  try {
    await (provider || hybridTwilioProvider()).endCall(result.providerCallId);
    await db.doc(`calls/${callId}`).set({
      'media.pstnEndRequestedAt': FieldValue.serverTimestamp(),
      'media.pstnEndReason': 'ai_media_setup_failed',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    // The terminal state and audit are durable even when a carrier timeout
    // leaves the REST outcome unknown.  The dispatcher/reaper will retry this
    // bounded end request rather than ever restoring AI control.
    await db.doc(`calls/${callId}`).set({
      'media.pstnEndError': clean(error?.message, 300),
      'media.pstnEndLastAttemptAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
  }
  return result;
}

async function rejectOpenAIRealtimeCall(realtimeCallId, { statusCode = 486 } = {}) {
  const apiKey = secretValue(HYBRID_OPENAI_API_KEY);
  if (!apiKey || !realtimeCallId) return { attempted: false };
  try {
    await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(realtimeCallId)}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_code: statusCode }), signal: AbortSignal.timeout(5000)
    });
    return { attempted: true };
  } catch { return { attempted: true, failed: true }; }
}

const callOptions = { enforceAppCheck: false, maxInstances: 20 };
const id = (value, label = 'id') => {
  const result = clean(value, 200);
  if (!result || !/^[A-Za-z0-9_:/.-]+$/.test(result)) throw new HttpsError('invalid-argument', `A valid ${label} is required.`);
  return result;
};

async function requireDialer(request, { manageAgents = false } = {}) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  try {
    const access = assertOutboundAccess(await resolveAccountAccess(db, request.auth), { manage: manageAgents });
    return { db, uid: request.auth.uid, email: clean(request.auth.token?.email, 200), role: access.role, access };
  } catch (error) {
    throw new HttpsError('permission-denied', clean(error.message, 300));
  }
}

const repTrainingProgressId = (uid, accountId) =>
  createHash('sha256').update(`${clean(uid, 160)}:${clean(accountId, 80)}`).digest('hex');

async function requireRepTrainingAccess(db, uid, accountId) {
  const roleSnapshot = await db.doc(`roles/${uid}`).get();
  if (roleSnapshot.get('role') !== 'outbound_rep'
      || !hasRepTrainingAccess(roleSnapshot, accountId)) {
    throw new HttpsError('failed-precondition', 'Pass the required sales practice course before accessing campaign leads or dialing.');
  }
}

function assertRepCampaignAssignment(role, uid, campaign) {
  if (role === 'outbound_rep' && !(campaign?.allowedRepUids || []).includes(uid)) {
    throw new HttpsError('permission-denied', 'A manager must assign this campaign to you before you can dial it.');
  }
}

async function repCanAccessCampaign(db, uid, roleSnapshot, campaignId, accountId) {
  const account = readAccountId(accountId, { fallback: LEGACY_ACCOUNT_ID });
  if (roleSnapshot.get('role') !== 'outbound_rep'
      || !hasRepTrainingAccess(roleSnapshot, account)) return false;
  const campaignSnapshot = campaignId
    ? await db.doc(`outboundCampaigns/${campaignId}`).get()
    : null;
  return Boolean(campaignSnapshot?.exists
    && readAccountId(campaignSnapshot.get('accountId'), { fallback: LEGACY_ACCOUNT_ID }) === account
    && Array.isArray(campaignSnapshot.get('allowedRepUids'))
    && campaignSnapshot.get('allowedRepUids').includes(uid));
}

async function assertRepCampaignAccess(db, uid, access, campaignId, accountId) {
  if (access.role !== 'outbound_rep') return;
  const roleSnapshot = await db.doc(`roles/${uid}`).get();
  if (!hasRepTrainingAccess(roleSnapshot, readAccountId(accountId, { fallback: LEGACY_ACCOUNT_ID }))) {
    throw new HttpsError('failed-precondition', 'Pass the required sales practice course before accessing campaign leads or dialing.');
  }
  if (!(await repCanAccessCampaign(db, uid, roleSnapshot, campaignId, accountId))) {
    throw new HttpsError('permission-denied', 'A manager must assign this campaign to you before you can access its calls.');
  }
}

async function ownedSession(db, sessionId, uid, access) {
  const snapshot = await db.doc(`dialerSessions/${sessionId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Session not found.');
  try { assertDocumentAccountAccess(access, snapshot.data() || {}, { resource: 'dialer session' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  if (snapshot.get('userUid') !== uid) throw new HttpsError('permission-denied', 'That dialer session belongs to another rep.');
  const session = { id: sessionId, ...snapshot.data() };
  await assertRepCampaignAccess(db, uid, access, session.campaignId, session.accountId);
  return session;
}

async function ownedCall(db, callId, uid, access) {
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  try { assertDocumentAccountAccess(access, call, { resource: 'call' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  const session = await ownedSession(db, call.sessionId, uid, access);
  if (call.campaignId !== session.campaignId
      || readAccountId(call.accountId, { fallback: LEGACY_ACCOUNT_ID })
        !== readAccountId(session.accountId, { fallback: LEGACY_ACCOUNT_ID })) {
    throw new HttpsError('permission-denied', 'This call does not belong to your assigned campaign session.');
  }
  return call;
}

async function transferCall(db, callId, uid, access) {
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  try { assertDocumentAccountAccess(access, call, { resource: 'call' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  const transfer = call.staffTransfer || {};
  if (![transfer.fromUid, transfer.toUid].includes(uid)) {
    throw new HttpsError('permission-denied', 'This staff handoff does not belong to you.');
  }
  await assertRepCampaignAccess(db, uid, access, call.campaignId, call.accountId);
  return call;
}

async function staffIdentity(db, uid, fallback = '') {
  const [userSnapshot, roleSnapshot] = await Promise.all([
    db.doc(`users/${uid}`).get(), db.doc(`roles/${uid}`).get()
  ]);
  return {
    uid,
    role: clean(roleSnapshot.get('role'), 80),
    accountIds: normalizeAccountScope(roleSnapshot.get('accountIds')),
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

async function loadKnowledgeChunks(db, knowledgeBaseIds = [], { accountId = '' } = {}) {
  const chunks = [];
  for (const kbId of knowledgeBaseIds.slice(0, 8)) {
    const kbSnapshot = await db.doc(`knowledgeBases/${kbId}`).get();
    if (!kbSnapshot.exists || kbSnapshot.get('status') !== 'active') continue;
    // A profile must never retrieve another seller's sales material merely
    // because someone copied a knowledge-base id into its configuration.
    if (accountId && kbSnapshot.get('accountId') !== accountId) continue;
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

  const chunks = await loadKnowledgeChunks(db, profile.knowledgeBaseIds || [], { accountId: profile.accountId });

  const compiled = compileAgentRuntime({
    profile,
    campaignOverride: campaign.agentOverride || {},
    sessionOverride: call.agentSessionOverride || {},
    campaign,
    // Research is snapshotted at call creation.  The current lead/prospect may
    // have changed while the call was ringing, so it is never a source of
    // runtime research facts.
    contact,
    callPlan: call.callPlan || null,
    targetId: call.targetId,
    knowledgeChunks: chunks
  });
  return { compiled, campaign, profile, contact };
}

// -------------------------------------------------------------- rep/session

export const setHybridAutoTakeover = onCall(callOptions, async request => {
  const { db, uid, role, access } = await requireDialer(request);
  const sessionId = id(request.data?.sessionId, 'session id');
  await ownedSession(db, sessionId, uid, access);
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
  const { db, uid, access } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await ownedCall(db, callId, uid, access);
  const requested = await requestHumanHandoff(db, callId, { requestedBy: 'rep', actorId: uid });
  const session = await ownedSession(db, call.sessionId, uid, access);
  const repBusy = Boolean(session?.rep?.activeCallId && session.rep.activeCallId !== callId);
  if (repBusy) return { ...requested, queued: true, reason: 'rep_busy' };
  const handoff = await beginSmoothHandoff(db, call.sessionId, callId, { repUid: uid });
  return { ...requested, handoff };
});

export const beginHybridListen = onCall(callOptions, async request => {
  const { db, uid, access } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await ownedCall(db, callId, uid, access);
  const result = await setListenState(db, call.sessionId, callId, { repUid: uid, listening: true });
  if (!result.ok) throw new HttpsError('failed-precondition', clean(result.reason, 200));
  return { ok: true, callId, conferenceName: clean(call?.media?.conferenceName, 120) };
});

export const stopHybridListen = onCall(callOptions, async request => {
  const { db, uid, access } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await ownedCall(db, callId, uid, access);
  return setListenState(db, call.sessionId, callId, { repUid: uid, listening: false });
});

export const getHybridVoiceAccessToken = onCall({ ...callOptions, secrets: TWILIO_CONTROL_SECRETS }, async request => {
  const { uid } = await requireDialer(request);
  // A Twilio browser token can originate a client call independently of the
  // campaign queue. Do not let staging bypass the server-side dial admission
  // simply by connecting the browser SDK directly.
  const dialingAdmission = externalDialingAdmission('twilio');
  if (!dialingAdmission.allowed) {
    throw new HttpsError('failed-precondition', `External dialing is disabled (${dialingAdmission.reason}).`);
  }
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
  const { db, uid, access } = await requireDialer(request);
  const campaignId = id(request.data?.campaignId, 'campaign id');
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new HttpsError('not-found', 'Campaign not found.');
  const campaign = { id: campaignId, ...campaignSnapshot.data() };
  try { assertDocumentAccountAccess(access, campaign, { resource: 'campaign' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  assertRepCampaignAssignment(access.role, uid, campaign);
  if (access.role === 'outbound_rep') await requireRepTrainingAccess(db, uid, campaign.accountId);
  const roles = await db.collection('roles')
    .where('role', 'in', ['admin', 'outbound_rep', 'outbound_manager'])
    .limit(100).get();
  const eligible = roles.docs.filter(entry => entry.id !== uid && (
    entry.get('role') === 'admin'
    || (entry.get('role') === 'outbound_rep'
      && normalizeAccountScope(entry.get('accountIds')).includes(campaign.accountId)
      && hasRepTrainingAccess(entry, campaign.accountId)
      && (campaign.allowedRepUids || []).includes(entry.id))
    || (entry.get('role') === 'outbound_manager'
      && normalizeAccountScope(entry.get('accountIds')).includes(campaign.accountId))
  ));
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
  const { db, uid, access } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const toUid = id(request.data?.toUid, 'teammate id');
  if (toUid === uid) throw new HttpsError('invalid-argument', 'Choose another teammate.');
  const call = await ownedCall(db, callId, uid, access);
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
  if (to.role !== 'admin' && !to.accountIds.includes(call.accountId)) {
    throw new HttpsError('permission-denied', 'That teammate is not assigned to this seller account.');
  }
  if (to.role === 'outbound_rep') {
    const campaignSnapshot = call.campaignId
      ? await db.doc(`outboundCampaigns/${call.campaignId}`).get()
      : null;
    if (!campaignSnapshot?.exists) {
      throw new HttpsError('failed-precondition', 'This call is not linked to an available campaign.');
    }
    assertRepCampaignAssignment(to.role, toUid, campaignSnapshot.data());
    await requireRepTrainingAccess(db, toUid, call.accountId);
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
  const { db, uid, access } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await transferCall(db, callId, uid, access);
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
  const { db, uid, access } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await transferCall(db, callId, uid, access);
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
  const { db, uid, access } = await requireDialer(request);
  const callId = id(request.data?.callId, 'call id');
  const call = await transferCall(db, callId, uid, access);
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
  const { db, uid, access } = await requireDialer(request, { manageAgents: true });
  const callId = id(request.data?.callId, 'call id');
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  try { assertDocumentAccountAccess(access, call, { resource: 'call' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
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
  const { db, uid, access } = await requireDialer(request, { manageAgents: true });
  const callId = id(request.data?.callId, 'call id');
  const message = clean(request.data?.message, 500);
  if (!message) throw new HttpsError('invalid-argument', 'Enter a coaching cue.');
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  try { assertDocumentAccountAccess(access, call, { resource: 'call' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
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
  const { db, uid, access } = await requireDialer(request, { manageAgents: true });
  const callId = id(request.data?.callId, 'call id');
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...snapshot.data() };
  try { assertDocumentAccountAccess(access, call, { resource: 'call' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
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
  // The account whose contacts this persona is allowed to speak to. Profiles
  // written before the boundary existed read as the house account, which keeps
  // them usable by BiteSites campaigns and refused by every client campaign.
  accountId: readAccountId(input.accountId ?? existing.accountId, { fallback: LEGACY_ACCOUNT_ID }),
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
    eagerness: profileChoice(input.turnTaking?.eagerness ?? existing.turnTaking?.eagerness, ['low', 'medium', 'high', 'auto'], 'low'),
    allowInterruptions: input.turnTaking?.allowInterruptions ?? existing.turnTaking?.allowInterruptions ?? true,
    noiseReduction: profileChoice(input.turnTaking?.noiseReduction ?? existing.turnTaking?.noiseReduction, ['off', 'near_field', 'far_field'], 'far_field'),
    threshold: profileNumber(input.turnTaking?.threshold ?? existing.turnTaking?.threshold, 0, 1, 0.5),
    prefixPaddingMs: Math.round(profileNumber(input.turnTaking?.prefixPaddingMs ?? existing.turnTaking?.prefixPaddingMs, 0, 2000, 300)),
    silenceDurationMs: Math.round(profileNumber(input.turnTaking?.silenceDurationMs ?? existing.turnTaking?.silenceDurationMs, 100, 5000, 700)),
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
  offerTracks: normalizeOfferTrackKeys(input.offerTracks ?? existing.offerTracks ?? []),
  auditionScript: clean(input.auditionScript ?? existing.auditionScript, 1200),
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
  const { db, access } = await requireDialer(request);
  const snapshot = await db.collection('aiAgentProfiles').orderBy('updatedAt', 'desc').limit(100).get();
  return {
    profiles: snapshot.docs
      .filter(entry => {
        try { assertDocumentAccountAccess(access, entry.data() || {}, { resource: 'AI agent profile' }); return true; }
        catch { return false; }
      })
      .map(entry => ({ id: entry.id, ...entry.data() }))
  };
});

export const createAIAgentProfile = onCall(callOptions, async request => {
  const { db, uid, email, access } = await requireDialer(request, { manageAgents: true });
  // Explicit on create: a persona that does not say whose customers it may
  // speak to is the single most dangerous record in this system.
  try {
    requireAccountId(request.data?.accountId, { field: 'accountId' });
  } catch (error) {
    throw new HttpsError('invalid-argument', error.message);
  }
  try { assertAccountAccess(access, request.data?.accountId); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  const ref = db.collection('aiAgentProfiles').doc();
  const profile = validateProfileInput(normalizeProfileInput(request.data || {}));
  await ref.set({
    ...profile, version: 1, createdBy: email || uid, updatedBy: email || uid,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  });
  return { profileId: ref.id, version: 1 };
});

export const updateAIAgentProfile = onCall(callOptions, async request => {
  const { db, uid, email, access } = await requireDialer(request, { manageAgents: true });
  const profileId = id(request.data?.profileId, 'profile id');
  const ref = db.doc(`aiAgentProfiles/${profileId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Agent profile not found.');
  try { assertDocumentAccountAccess(access, snapshot.data() || {}, { resource: 'AI agent profile' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  const version = Math.max(1, Number(snapshot.get('version')) || 1) + 1;
  const profile = validateProfileInput(normalizeProfileInput(request.data?.profile || {}, snapshot.data()));

  // A persona's account is fixed for life. Campaigns were allowed to select
  // this profile because of the account it declared; moving it would
  // retroactively legitimise every one of those bindings without re-checking
  // any of them.
  const settledAccountId = readAccountId(snapshot.get('accountId'), { fallback: LEGACY_ACCOUNT_ID });
  if (profile.accountId !== settledAccountId) {
    throw new HttpsError(
      'failed-precondition',
      `An agent profile cannot change account (it is "${settledAccountId}"). Create a separate profile instead.`
    );
  }
  await db.doc(`aiAgentProfiles/${profileId}/versions/${String(version - 1).padStart(6, '0')}`).set({
    ...snapshot.data(), archivedAt: FieldValue.serverTimestamp()
  });
  await ref.set({ ...profile, version, updatedBy: email || uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, profileId, version };
});

export const archiveAIAgentProfile = onCall(callOptions, async request => {
  const { db, uid, email, access } = await requireDialer(request, { manageAgents: true });
  const profileId = id(request.data?.profileId, 'profile id');
  const ref = db.doc(`aiAgentProfiles/${profileId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Agent profile not found.');
  try { assertDocumentAccountAccess(access, snapshot.data() || {}, { resource: 'AI agent profile' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  await ref.set({
    status: 'archived', updatedBy: email || uid, updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true };
});

export const previewAIAgentRuntime = onCall(callOptions, async request => {
  const { access } = await requireDialer(request, { manageAgents: true });
  try { assertAccountAccess(access, request.data?.profile?.accountId); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
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
    const { db, uid, access } = await requireDialer(request, { manageAgents: true });
    const apiKey = secretValue(HYBRID_OPENAI_API_KEY);
    if (!apiKey) throw new HttpsError('failed-precondition', 'OpenAI is not configured for agent previews.');

    const mode = clean(request.data?.mode, 20) || 'conversation';
    let profile;
    let preview;
    try {
      profile = validateProfileInput(normalizeProfileInput(request.data?.profile || {}));
      assertAccountAccess(access, profile.accountId);
      profile.id = clean(request.data?.profile?.id, 200) || 'preview';
      profile.version = Math.max(1, Number(request.data?.profile?.version) || 1);
      const knowledgeChunks = await loadKnowledgeChunks(db, profile.knowledgeBaseIds || [], { accountId: profile.accountId });
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

/** A bounded status view for the rep's account-scoped mandatory practice. */
export const getRepTrainingStatus = onCall(callOptions, async request => {
  const { db, uid, role, access } = await requireDialer(request);
  if (role !== 'outbound_rep') throw new HttpsError('permission-denied', 'Sales training is available to sales reps.');
  const accountIds = normalizeAccountScope(access.accountIds);
  const roleSnapshot = await db.doc(`roles/${uid}`).get();
  const passedAccountIds = roleSnapshot.get('trainingPassedAccountIds');
  const accounts = await Promise.all(accountIds.map(async accountId => {
    const [defaultSnapshot, progressSnapshot] = await Promise.all([
      db.doc(`outboundDefaults/${accountId}`).get(),
      db.doc(`repTrainingProgress/${repTrainingProgressId(uid, accountId)}`).get()
    ]);
    const campaignId = clean(defaultSnapshot.get('campaignId'), 200);
    const campaignSnapshot = campaignId ? await db.doc(`outboundCampaigns/${campaignId}`).get() : null;
    const requiredScenarioIds = repTrainingScenarios(accountId).map(scenario => scenario.id);
    const rawCompletedScenarioIds = progressSnapshot.get('completedScenarioIds');
    const completedScenarioIds = Array.isArray(rawCompletedScenarioIds)
      ? rawCompletedScenarioIds.filter(id => requiredScenarioIds.includes(id))
      : [];
    const requiredScenarioCount = requiredScenarioIds.length;
    const defaultCampaign = campaignSnapshot?.exists
      && readAccountId(campaignSnapshot.get('accountId'), { fallback: LEGACY_ACCOUNT_ID }) === accountId
      ? { id: campaignId, name: clean(campaignSnapshot.get('name'), 120) || 'Default campaign' }
      : null;
    const passed = Array.isArray(passedAccountIds)
      && passedAccountIds.includes(accountId)
      && requiredScenarioIds.every(id => completedScenarioIds.includes(id));
    const trainingExempt = hasRepTrainingExemption(roleSnapshot, accountId);
    return {
      accountId,
      accountName: getAccount(accountId)?.label || accountId,
      ready: requiredScenarioIds.length > 0,
      defaultCampaign,
      campaignAssigned: Boolean(defaultCampaign
        && Array.isArray(campaignSnapshot.get('allowedRepUids'))
        && campaignSnapshot.get('allowedRepUids').includes(uid)),
      completedScenarioIds,
      requiredScenarioCount,
      passed,
      trainingExempt,
      progress: progressSnapshot.get('status') || 'not_started'
    };
  }));
  return { accounts };
});

/** Start one fictional prospect role-play for the next required niche. */
export const createRepTrainingSession = onCall(
  { ...callOptions, secrets: [HYBRID_OPENAI_API_KEY] },
  async request => {
    const { db, uid, role, access } = await requireDialer(request);
    if (role !== 'outbound_rep') throw new HttpsError('permission-denied', 'Sales training is available to sales reps.');
    const accountId = clean(request.data?.accountId, 80);
    if (!normalizeAccountScope(access.accountIds).includes(accountId)) {
      throw new HttpsError('permission-denied', 'That seller account is not assigned to you.');
    }
    const apiKey = secretValue(HYBRID_OPENAI_API_KEY);
    if (!apiKey) throw new HttpsError('failed-precondition', 'The AI training coach is not configured.');
    const [defaultSnapshot, progressSnapshot, roleSnapshot] = await Promise.all([
      db.doc(`outboundDefaults/${accountId}`).get(),
      db.doc(`repTrainingProgress/${repTrainingProgressId(uid, accountId)}`).get(),
      db.doc(`roles/${uid}`).get()
    ]);
    const campaignId = clean(defaultSnapshot.get('campaignId'), 200);
    const alreadyPassedAccounts = roleSnapshot.get('trainingPassedAccountIds');
    if (Array.isArray(alreadyPassedAccounts) && alreadyPassedAccounts.includes(accountId)) {
      throw new HttpsError('already-exists', 'You have already passed this account’s required training.');
    }
    if (repTrainingScenarios(accountId).length === 0) {
      throw new HttpsError('failed-precondition', 'No training scenarios are configured for this seller account yet.');
    }
    const requiredScenarioIds = repTrainingScenarios(accountId).map(entry => entry.id);
    let completedScenarioIds = Array.isArray(progressSnapshot.get('completedScenarioIds'))
      ? progressSnapshot.get('completedScenarioIds').filter(id => requiredScenarioIds.includes(id)) : [];
    let scenario = nextRepTrainingScenario(accountId, completedScenarioIds);
    if (!scenario) {
      // A role change clears the authoritative pass flag. If its old progress
      // says every scenario passed, require a fresh course rather than leaving
      // the rep with no way to earn a new pass.
      completedScenarioIds = [];
      scenario = nextRepTrainingScenario(accountId, completedScenarioIds);
      await progressSnapshot.ref.set({
        status: 'in_progress', completedScenarioIds,
        defaultCampaignId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (!scenario) throw new HttpsError('failed-precondition', 'No required training scenarios are configured for this seller account.');

    const progressRef = db.doc(`repTrainingProgress/${repTrainingProgressId(uid, accountId)}`);
    const trainingDayKey = new Date().toISOString().slice(0, 10);
    await db.runTransaction(async transaction => {
      const currentProgress = await transaction.get(progressRef);
      const dailyCount = currentProgress.get('trainingDayKey') === trainingDayKey
        ? Math.max(0, Number(currentProgress.get('trainingAttemptCount')) || 0) : 0;
      if (dailyCount >= 12) {
        throw new HttpsError('resource-exhausted', 'You have reached today’s practice limit. Try again tomorrow.');
      }
      transaction.set(progressRef, {
        trainingDayKey,
        trainingAttemptCount: dailyCount + 1,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    let client;
    try {
      client = await mintAgentPreviewClientSecret({
        apiKey, uid,
        session: buildRepTrainingSession({
          sellerName: getAccount(accountId)?.label || accountId,
          scenario
        })
      });
    } catch (error) {
      throw new HttpsError('internal', clean(error?.message, 350) || 'Could not start the training role-play.');
    }

    const attemptRef = db.collection('repTrainingAttempts').doc();
    await attemptRef.set({
      uid, accountId, campaignId, scenarioId: scenario.id,
      status: 'in_progress', createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60 * 1000)
    });
    return {
      clientSecret: client.value,
      expiresAt: client.expiresAt,
      attemptId: attemptRef.id,
      scenario: publicTrainingScenario(scenario)
    };
  }
);

/** Score a completed role-play and grant default campaign access after all required niches pass. */
export const completeRepTrainingAttempt = onCall(
  { ...callOptions, secrets: [HYBRID_OPENAI_API_KEY], timeoutSeconds: 45 },
  async request => {
    const { db, uid, role, access } = await requireDialer(request);
    if (role !== 'outbound_rep') throw new HttpsError('permission-denied', 'Sales training is available to sales reps.');
    const attemptId = clean(request.data?.attemptId, 200);
    if (!/^[A-Za-z0-9_-]+$/.test(attemptId)) throw new HttpsError('invalid-argument', 'A valid training attempt is required.');
    const attemptRef = db.doc(`repTrainingAttempts/${attemptId}`);
    const initial = await attemptRef.get();
    if (!initial.exists || initial.get('uid') !== uid) throw new HttpsError('not-found', 'Training attempt not found.');
    const accountId = clean(initial.get('accountId'), 80);
    if (!normalizeAccountScope(access.accountIds).includes(accountId)) {
      throw new HttpsError('permission-denied', 'That seller account is not assigned to you.');
    }
    if (['passed', 'failed'].includes(initial.get('status'))) {
      return initial.get('result') || { score: initial.get('score') || 0, passed: initial.get('status') === 'passed' };
    }
    if (initial.get('status') !== 'in_progress') throw new HttpsError('failed-precondition', 'This training attempt is already being reviewed.');
    const expiresAtMs = initial.get('expiresAt')?.toMillis?.();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      await attemptRef.set({ status: 'expired', finishedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw new HttpsError('deadline-exceeded', 'This practice session expired. Start a fresh role-play.');
    }
    const scenario = repTrainingScenarios(accountId).find(entry => entry.id === initial.get('scenarioId'));
    if (!scenario) throw new HttpsError('failed-precondition', 'This training scenario is no longer available.');
    const apiKey = secretValue(HYBRID_OPENAI_API_KEY);
    if (!apiKey) throw new HttpsError('failed-precondition', 'The AI training evaluator is not configured.');

    const transcript = request.data?.transcript;
    const scoringLock = await db.runTransaction(async transaction => {
      const current = await transaction.get(attemptRef);
      if (current.get('uid') !== uid || current.get('status') !== 'in_progress') return false;
      transaction.set(attemptRef, { status: 'scoring', scoringStartedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!scoringLock) throw new HttpsError('failed-precondition', 'This training attempt has already been submitted.');

    try {
      const evaluation = await evaluateRepTrainingTranscript({ apiKey, scenario, transcript, uid });
      const result = await db.runTransaction(async transaction => {
        const [attemptSnapshot, roleSnapshot, progressSnapshot, defaultSnapshot] = await Promise.all([
          transaction.get(attemptRef),
          transaction.get(db.doc(`roles/${uid}`)),
          transaction.get(db.doc(`repTrainingProgress/${repTrainingProgressId(uid, accountId)}`)),
          transaction.get(db.doc(`outboundDefaults/${accountId}`))
        ]);
        if (attemptSnapshot.get('status') !== 'scoring' || attemptSnapshot.get('uid') !== uid) {
          throw new HttpsError('failed-precondition', 'This training attempt is no longer available.');
        }
        if (roleSnapshot.get('role') !== 'outbound_rep'
            || !normalizeAccountScope(roleSnapshot.get('accountIds')).includes(accountId)) {
          throw new HttpsError('permission-denied', 'Your sales-rep access changed during training.');
        }

        const requiredScenarioIds = repTrainingScenarios(accountId).map(entry => entry.id);
        const previous = Array.isArray(progressSnapshot.get('completedScenarioIds'))
          ? progressSnapshot.get('completedScenarioIds').filter(id => requiredScenarioIds.includes(id)) : [];
        const completedScenarioIds = evaluation.passed
          ? [...new Set([...previous, scenario.id])]
          : previous;
        const requiredScenarioCount = repTrainingScenarios(accountId).length;
        const coursePassed = requiredScenarioIds.every(id => completedScenarioIds.includes(id));
        let defaultCampaignId = clean(defaultSnapshot.get('campaignId'), 200);
        let campaignSnapshot = null;
        let campaignRef = null;
        if (coursePassed && defaultCampaignId) {
          campaignRef = db.doc(`outboundCampaigns/${defaultCampaignId}`);
          campaignSnapshot = await transaction.get(campaignRef);
          if (!campaignSnapshot.exists
              || readAccountId(campaignSnapshot.get('accountId'), { fallback: LEGACY_ACCOUNT_ID }) !== accountId) {
            defaultCampaignId = '';
            campaignRef = null;
            campaignSnapshot = null;
          } else {
            const assigned = Array.isArray(campaignSnapshot.get('allowedRepUids')) ? campaignSnapshot.get('allowedRepUids') : [];
            if (!assigned.includes(uid) && assigned.length >= 100) {
              defaultCampaignId = '';
              campaignRef = null;
              campaignSnapshot = null;
            }
          }
        }

        const currentPassedAccounts = Array.isArray(roleSnapshot.get('trainingPassedAccountIds'))
          ? roleSnapshot.get('trainingPassedAccountIds') : [];
        const courseResult = {
          ...evaluation,
          coursePassed,
          completedScenarioCount: completedScenarioIds.length,
          requiredScenarioCount,
          scenario: publicTrainingScenario(scenario),
          assignedCampaign: coursePassed && campaignRef ? {
            id: defaultCampaignId,
            name: clean(campaignSnapshot?.get('name'), 120) || 'Default campaign'
          } : null,
          assignmentPending: coursePassed && !campaignRef
        };
        transaction.set(attemptRef, {
          status: evaluation.passed ? 'passed' : 'failed',
          score: evaluation.score,
          result: courseResult,
          finishedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(db.doc(`repTrainingProgress/${repTrainingProgressId(uid, accountId)}`), {
          uid, accountId, status: coursePassed ? 'passed' : 'in_progress',
          completedScenarioIds,
          requiredScenarioCount,
          ...(coursePassed ? { passedAt: FieldValue.serverTimestamp(), defaultCampaignId } : {}),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        if (coursePassed && !currentPassedAccounts.includes(accountId)) {
          transaction.set(db.doc(`roles/${uid}`), {
            trainingPassedAccountIds: FieldValue.arrayUnion(accountId),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
        if (coursePassed && campaignRef) {
          transaction.set(campaignRef, {
            allowedRepUids: FieldValue.arrayUnion(uid),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
        return courseResult;
      });
      return result;
    } catch (error) {
      await attemptRef.set({ status: 'in_progress', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', clean(error?.message, 300) || 'The AI coach could not score this practice session.');
    }
  }
);

// ------------------------------------------------------------- knowledge KB

export const listAIKnowledgeBases = onCall(callOptions, async request => {
  const { db, access } = await requireDialer(request);
  const snapshot = await db.collection('knowledgeBases').orderBy('updatedAt', 'desc').limit(100).get();
  return {
    knowledgeBases: snapshot.docs
      .filter(entry => {
        try { assertDocumentAccountAccess(access, entry.data() || {}, { resource: 'knowledge base' }); return true; }
        catch { return false; }
      })
      .map(entry => ({ id: entry.id, ...entry.data() }))
  };
});

export const createAIKnowledgeBase = onCall(callOptions, async request => {
  const { db, uid, email, access } = await requireDialer(request, { manageAgents: true });
  try { assertAccountAccess(access, request.data?.accountId); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  const ref = db.collection('knowledgeBases').doc();
  await ref.set({
    accountId: requireAccountId(request.data?.accountId, { field: 'accountId' }),
    name: clean(request.data?.name, 120) || 'Untitled knowledge base',
    description: clean(request.data?.description, 1000),
    status: 'active', version: 1,
    createdBy: email || uid, updatedBy: email || uid,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  });
  return { knowledgeBaseId: ref.id };
});

export const upsertAIKnowledgeDocument = onCall(callOptions, async request => {
  const { db, uid, email, access } = await requireDialer(request, { manageAgents: true });
  const kbId = id(request.data?.knowledgeBaseId, 'knowledge base id');
  const kbSnapshot = await db.doc(`knowledgeBases/${kbId}`).get();
  if (!kbSnapshot.exists) throw new HttpsError('not-found', 'Knowledge base not found.');
  try { assertDocumentAccountAccess(access, kbSnapshot.data() || {}, { resource: 'knowledge base' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
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
  if (['completed', 'cancelled', 'failed'].includes(call.status)) {
    res.status(200).type('text/xml').send('<Response><Hangup/></Response>'); return;
  }
  const room = call?.media?.conferenceName || conferenceName(call.sessionId, call.targetId);
  const identity = clean(String(req.body?.From || '').replace(/^client:/, ''), 121);
  const sessionSnapshot = await db.doc(`dialerSessions/${call.sessionId}`).get();
  const expectedIdentity = `bs_${clean(sessionSnapshot.get('userUid'), 110)}`;
  const transferIdentity = `bs_${clean(call?.staffTransfer?.toUid, 110)}`;
  const transferAllowed = mode === 'assist'
    && ['accepted', 'completed'].includes(call?.staffTransfer?.state)
    && identity === transferIdentity;
  const identityUid = identity.startsWith('bs_') ? identity.slice(3) : '';
  const identityRoleSnapshot = identityUid ? await db.doc(`roles/${identityUid}`).get() : null;
  const identityRole = clean(identityRoleSnapshot?.get('role'), 80);
  const callAccountId = readAccountId(call.accountId, { fallback: LEGACY_ACCOUNT_ID });
  const roleAccountIds = normalizeAccountScope(identityRoleSnapshot?.get('accountIds'));
  const roleCanAccessAccount = identityRole === 'admin'
    || (['outbound_manager', 'outbound_rep'].includes(identityRole) && roleAccountIds.includes(callAccountId));
  const repAllowed = roleCanAccessAccount
    && (identityRole !== 'outbound_rep'
      || await repCanAccessCampaign(db, identityUid, identityRoleSnapshot, call.campaignId, call.accountId));
  const coachAllowed = mode === 'coach'
    && ['admin', 'outbound_manager'].includes(identityRole)
    && call?.coaching?.state === 'monitoring'
    && call?.coaching?.supervisorUid === identityUid;
  if (!identity || !repAllowed || (identity !== expectedIdentity && !transferAllowed && !coachAllowed)) { res.status(403).type('text/plain').send('wrong rep'); return; }
  const label = `${mode}-${clean(sessionSnapshot.get('userUid'), 80)}`.slice(0, 120);
  const participantLabel = mode === 'assist' ? `assist-${call.staffTransfer.toUid}`
    : mode === 'coach' ? `coach-${identityUid}` : label;
  // Twilio uses the callback of the first conference participant. The browser
  // can win that race, so it must supply the same callback as the prospect.
  const callback = `${process.env.PUBLIC_APP_URL || `https://${req.get('host')}`}/api/twilio-conference-events?sessionId=${encodeURIComponent(call.sessionId)}&targetId=${encodeURIComponent(call.targetId)}`;
  res.status(200).type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" muted="${['listen', 'coach'].includes(mode) ? 'true' : 'false'}" startConferenceOnEnter="true" endConferenceOnExit="false" waitUrl="" participantLabel="${xml(participantLabel)}" statusCallback="${xml(callback)}" statusCallbackMethod="POST" statusCallbackEvent="start end join leave mute hold">${xml(room)}</Conference></Dial></Response>`
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

  const provider = hybridTwilioProvider(authToken);
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
  if (['completed', 'cancelled', 'failed'].includes(call.status)) {
    res.status(200).json({ ok: true, ignored: 'call_ended' }); return;
  }
  const stamp = Timestamp.fromDate(event.at);
  const common = { updatedAt: FieldValue.serverTimestamp() };
  if (event.type === 'ringing') common.ringingAt = stamp;
  if (['answered', 'human_answered', 'machine_answered'].includes(event.type)) common.answeredAt = stamp;
  if (event.recordingUrl) common.recordingUrl = event.recordingUrl;
  if (Number.isFinite(event.durationSec)) common.durationSec = event.durationSec;
  await db.runTransaction(async transaction => {
    const current = await transaction.get(callRef);
    if (['completed', 'cancelled', 'failed'].includes(current.get('status'))) return;
    transaction.set(callRef, { ...common, ...hybridCallProgress(current.data(), event.type) }, { merge: true });
  });

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
        await endFailedAIMediaPstn(db, call.id, {
          reason: `runtime_compile_failed: ${clean(error?.message, 240) || 'unknown'}`,
          source: 'runtime_compile', provider, now: event.at
        });
        res.status(200).json({ ok: true, routed: 'ai', aiPending: false, safelyEnded: true, error: 'agent_config_unavailable' }); return;
      }
      const attachDeadlineAt = Timestamp.fromDate(aiMediaAttachDeadline(event.at));
      await callRef.set({
        agent: {
          profileId: runtime.compiled.profileId,
          profileVersion: runtime.compiled.profileVersion,
          effectiveConfigHash: runtime.compiled.effectiveConfigHash,
          callPlanKey: runtime.compiled.callPlanKey,
          callPlanVersion: runtime.compiled.callPlanVersion,
          callPlanHash: runtime.compiled.callPlanHash,
          model: runtime.compiled.model,
          voice: runtime.compiled.voice
        },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await db.doc(`aiMediaJobs/${call.id}`).set({
        callId: call.id, sessionId: call.sessionId, campaignId: call.campaignId,
        accountId: call.accountId || runtime.campaign.accountId,
        conferenceName: call?.media?.conferenceName || conferenceName(call.sessionId, call.targetId),
        status: 'pending',
        attachDeadlineAt,
        runtime: {
          model: runtime.compiled.model,
          voice: runtime.compiled.voice,
          sessionConfig: runtime.compiled.sessionConfig,
          instructions: runtime.compiled.instructions,
          tools: runtime.compiled.tools,
          // Persisted so hybridSidebandControl can re-authorize each tool call
          // against Firestore instead of trusting the media service, which
          // holds only a shared secret and is not a trust boundary.
          permissions: runtime.compiled.permissions,
          offerTracks: runtime.compiled.offerTracks,
          knowledgeBaseIds: runtime.compiled.knowledgeBaseIds,
          profileId: runtime.compiled.profileId,
          profileVersion: runtime.compiled.profileVersion,
          effectiveConfigHash: runtime.compiled.effectiveConfigHash,
          callPlanKey: runtime.compiled.callPlanKey,
          callPlanVersion: runtime.compiled.callPlanVersion,
          callPlanHash: runtime.compiled.callPlanHash,
          handoffPhrase: runtime.compiled.handoffPhrase
        },
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await callRef.set({
        media: {
          ...(call.media || {}), attachState: 'pending',
          attachDeadlineAt
        },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.status(200).json({ ok: true, callId: call.id, routed: routed.controller }); return;
  }

  if (event.type === 'machine_answered') {
    await callRef.set({ answeredBy: 'machine' }, { merge: true });
    res.status(200).json({ ok: true, callId: call.id, machine: true }); return;
  }

  const terminal = new Set(['completed', 'cancelled', 'failed', 'busy', 'no_answer']);
  if (terminal.has(event.type)) {
    await callRef.set({ status: event.type === 'cancelled' ? 'cancelled' : 'completed', endedAt: stamp }, { merge: true });
    const campaignSnapshot = call.campaignId ? await db.doc(`outboundCampaigns/${call.campaignId}`).get() : null;
    const campaign = campaignSnapshot?.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null;
    // A human-handled call needs a disposition before the next prospect starts.
    // Record the hold before capacity maintenance runs so a terminal webhook
    // cannot race the rep's choice of "interested" and place another call.
    if (call.hybridV2 === true && call.humanHandled === true) {
      const sessionRef = db.doc(`dialerSessions/${call.sessionId}`);
      await db.runTransaction(async transaction => {
        const [latestCall, latestSession] = await Promise.all([
          transaction.get(callRef), transaction.get(sessionRef)
        ]);
        if (!latestCall.exists || !latestSession.exists || latestCall.get('disposition')) return;
        const pendingFollowUp = latestSession.get('pendingFollowUp') || {};
        if (pendingFollowUp.callId === call.id) return;
        transaction.set(sessionRef, {
          wrapUpPendingCallId: call.id,
          autoDial: { ...(latestSession.get('autoDial') || {}), state: 'awaiting_disposition' },
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      });
    }
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

export const hybridAIMediaControl = onRequest({
  secrets: [HYBRID_AI_MEDIA_SECRET, HYBRID_OPENAI_API_KEY, HYBRID_TWILIO_ACCOUNT_SID, HYBRID_TWILIO_AUTH_TOKEN, HYBRID_TWILIO_TWIML_APP_SID],
  maxInstances: 30
}, async (req, res) => {
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
    const aiSessionId = clean(req.body?.aiSessionId, 240);
    try {
      await attachAIController(db, callId, aiSessionId, {
      model: req.body?.model,
      voice: req.body?.voice,
      profileId: call?.agent?.profileId,
      profileVersion: call?.agent?.profileVersion,
      effectiveConfigHash: call?.agent?.effectiveConfigHash
      });
    } catch (error) {
      await endFailedAIMediaPstn(db, callId, {
        reason: `sideband_attach_failed: ${clean(error?.message, 240) || 'unknown'}`,
        source: 'media_control_attached', realtimeCallId: aiSessionId
      });
      res.status(409).json({ ok: false, error: 'ai-attach-failed', safelyEnded: true }); return;
    }
    await db.doc(`aiMediaJobs/${callId}`).set({ status: 'active', aiSessionId: clean(req.body?.aiSessionId, 240), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await db.doc(`calls/${callId}`).set({
      'media.attachState': 'active', 'media.attachedAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
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
export const openAIRealtimeIncomingCall = onRequest({
  secrets: [HYBRID_OPENAI_API_KEY, HYBRID_AI_MEDIA_SECRET, HYBRID_TWILIO_ACCOUNT_SID, HYBRID_TWILIO_AUTH_TOKEN, HYBRID_TWILIO_TWIML_APP_SID],
  maxInstances: 30
}, async (req, res) => {
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
  if (!jobSnapshot.exists) {
    await rejectOpenAIRealtimeCall(realtimeCallId);
    res.status(404).json({ error: 'media-job-not-found' }); return;
  }
  const job = jobSnapshot.data() || {};
  const liveCallSnapshot = await db.doc(`calls/${callId}`).get();
  const liveController = clean(liveCallSnapshot.get('control.controller'), 40);
  if (['accepted', 'active'].includes(clean(job.status, 40)) && clean(job.realtimeCallId, 240) === realtimeCallId) {
    res.status(200).json({ ok: true, realtimeCallId, idempotent: true }); return;
  }
  if (['accepted', 'active'].includes(clean(job.status, 40))) {
    await rejectOpenAIRealtimeCall(realtimeCallId);
    res.status(409).json({ error: 'different-realtime-call-already-attached' }); return;
  }
  if (!liveCallSnapshot.exists || !isAIMediaAttachPending(job) || !['ai', 'transitioning'].includes(liveController)) {
    // A webhook can arrive after the deadline worker has already ended the
    // prospect leg.  Reject rather than accidentally resurrecting an AI
    // session from that stale SIP invite.
    await rejectOpenAIRealtimeCall(realtimeCallId);
    res.status(409).json({ error: 'ai-media-not-attachable' }); return;
  }
  const runtime = job.runtime || {};
  const apiKey = secretValue(HYBRID_OPENAI_API_KEY);
  if (!apiKey) {
    await endFailedAIMediaPstn(db, callId, {
      reason: 'openai_api_key_not_configured', source: 'realtime_incoming', realtimeCallId
    });
    res.status(503).json({ error: 'openai-not-configured' }); return;
  }

  let response;
  let body = '';
  try {
    response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(realtimeCallId)}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'realtime',
        model: clean(runtime.model, 120) || 'gpt-realtime-2.1',
        instructions: clean(runtime.instructions, 30000),
        ...sanitizeRealtimeSessionConfig(runtime.sessionConfig, clean(runtime.voice, 120) || 'marin')
      }), signal: AbortSignal.timeout(10_000)
    });
    body = await response.text();
  } catch (error) {
    await rejectOpenAIRealtimeCall(realtimeCallId);
    await endFailedAIMediaPstn(db, callId, {
      reason: `openai_accept_transport_failed: ${clean(error?.message, 240) || 'unknown'}`,
      source: 'realtime_accept', realtimeCallId
    });
    res.status(502).json({ error: 'openai-accept-transport-failed', safelyEnded: true }); return;
  }
  if (!response.ok) {
    // Reject is the documented response for an inbound SIP invite we will not
    // handle.  Regardless of its result, the already-answered PSTN leg is
    // immediately ended through the carrier fail-safe.
    await rejectOpenAIRealtimeCall(realtimeCallId);
    await endFailedAIMediaPstn(db, callId, {
      reason: `openai_accept_failed: ${clean(body, 240) || response.status}`,
      source: 'realtime_accept', realtimeCallId
    });
    res.status(502).json({ error: 'openai-accept-failed', safelyEnded: true }); return;
  }
  let accepted = {};
  try { accepted = JSON.parse(body); } catch { accepted = { raw: clean(body, 1000) }; }
  await db.doc(`aiMediaJobs/${callId}`).set({
    status: 'accepted', realtimeCallId, openAI: { callId: realtimeCallId, wssUrl: clean(accepted?.wss_url, 1000) },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await db.doc(`calls/${callId}`).set({
    'media.attachState': 'accepted', 'media.realtimeCallId': realtimeCallId,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  res.status(200).json({ ok: true, realtimeCallId, wssUrl: clean(accepted?.wss_url, 1000) });
});
