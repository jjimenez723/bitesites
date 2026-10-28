// Hybrid Dialer V2 session APIs.
//
// These wrap the proven V1 target locking/compliance/dial preparation logic but
// initialize and operate sessions using the V2 rep/controller model. The public
// UI should use these functions rather than the legacy start/dial functions.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

import {
  startDialerSession,
  findActiveDialerSession,
  heartbeatSession,
  stopDialerSession,
  applyDisposition,
  markDoNotCall
} from './outbound-calls.js';
import { getCallingProvider, assertSupports } from './providers/calling/index.js';
import { clean } from './prospect-normalization.js';
import { recordCallAuditEvent, releaseRepFromCall } from './hybrid-call-orchestration.js';
import { maintainHybridCapacity } from './hybrid-capacity.js';
import { hybridOutboundEventsUrl } from './hybrid-urls.js';
import { warmSidebandForSession } from './hybrid-sideband-warmup.js';
import {
  LEGACY_ACCOUNT_ID, readAccountId, checkAccountAlignment, accountMismatchLabel,
  sanitizePartnerOutcomes
} from './accounts.js';
import { assertDocumentAccountAccess, assertOutboundAccess, resolveAccountAccess } from './account-access.js';
import { resolveCampaignOperatingLimits } from './outbound-compliance.js';
import { buildLeadOutreachTemplate, buildMessage, sendPostmark } from './email.js';

/**
 * A persona may only speak to the account its campaign serves.
 *
 * The campaign builder already refuses a cross-account default, but the profile
 * for a live session is chosen again here and can be supplied straight by the
 * caller — so a rep on a client campaign could otherwise start a session with
 * the house persona. This is that same check at the point the override happens.
 */
function assertProfileServesAccount(profileSnapshot, campaignAccountId) {
  if (!profileSnapshot?.exists) return;
  const verdict = checkAccountAlignment({
    expected: readAccountId(campaignAccountId, { fallback: LEGACY_ACCOUNT_ID }),
    profile: readAccountId(profileSnapshot.get('accountId'), { fallback: LEGACY_ACCOUNT_ID })
  });
  if (!verdict.aligned) {
    throw new HttpsError(
      'failed-precondition',
      `${accountMismatchLabel(verdict.reason)} — this campaign serves "${verdict.expected}".`
    );
  }
}

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_TWIML_APP_SID = defineSecret('TWILIO_TWIML_APP_SID');
const TWILIO_API_KEY_SID = defineSecret('TWILIO_API_KEY_SID');
const TWILIO_API_KEY_SECRET = defineSecret('TWILIO_API_KEY_SECRET');
const POSTMARK_SERVER_TOKEN = defineSecret('POSTMARK_SERVER_TOKEN');

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

function assertRepCampaignAssignment(role, uid, campaign) {
  if (role === 'outbound_rep' && !(campaign?.allowedRepUids || []).includes(uid)) {
    throw new HttpsError('permission-denied', 'A manager must assign this campaign to you before you can dial it.');
  }
}

const normalizedEmail = value => clean(value, 200).toLowerCase();
const emailKey = email => createHash('sha256').update(normalizedEmail(email)).digest('hex');
const validEmail = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

async function requireDialer(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  try {
    const access = assertOutboundAccess(await resolveAccountAccess(db, request.auth));
    return { db, uid: request.auth.uid, email: clean(request.auth.token?.email, 200), role: access.role, access };
  } catch (error) {
    throw new HttpsError('permission-denied', clean(error.message, 300));
  }
}

async function requireOwnedSession(db, sessionId, uid, access) {
  const snapshot = await db.doc(`dialerSessions/${sessionId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Session not found.');
  try { assertDocumentAccountAccess(access, snapshot.data() || {}, { resource: 'dialer session' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  if (snapshot.get('userUid') !== uid) throw new HttpsError('permission-denied', 'That session belongs to another rep.');
  return { id: sessionId, ...snapshot.data() };
}

async function requireCallOperator(db, call, uid, access) {
  try { assertDocumentAccountAccess(access, call, { resource: 'call' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  const snapshot = await db.doc(`dialerSessions/${call.sessionId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Session not found.');
  const transfer = call.staffTransfer || {};
  const originalOperator = snapshot.get('userUid') === uid
    && !(transfer.state === 'completed' && transfer.fromUid === uid);
  const transferredOperator = transfer.state === 'completed' && transfer.toUid === uid;
  if (!originalOperator && !transferredOperator) {
    throw new HttpsError('permission-denied', 'You are not the active operator for this call.');
  }
  return { id: call.sessionId, ...snapshot.data() };
}

function twilioConfig() {
  return {
    accountSid: secretValue(TWILIO_ACCOUNT_SID),
    authToken: secretValue(TWILIO_AUTH_TOKEN),
    twimlAppSid: secretValue(TWILIO_TWIML_APP_SID),
    apiKeySid: secretValue(TWILIO_API_KEY_SID),
    apiKeySecret: secretValue(TWILIO_API_KEY_SECRET),
    statusCallbackUrl: hybridOutboundEventsUrl(),
    hybridV2: true
  };
}

/** Restore the active server session after a tab switch, navigation or reload. */
export const getActiveHybridDialerSession = onCall(callOptions, async request => {
  const { db, uid, access } = await requireDialer(request);
  const session = await findActiveDialerSession(db, uid, { hybridOnly: true });
  if (!session) return { session: null };
  try { assertDocumentAccountAccess(access, session, { resource: 'dialer session' }); }
  catch (error) { return { session: null }; }
  return {
    session: {
      sessionId: session.id,
      campaignId: clean(session.campaignId, 200),
      status: clean(session.status, 40),
      concurrency: resolveCampaignOperatingLimits(session).concurrency,
      operatingMode: ['human', 'hybrid', 'ai'].includes(session.operatingMode) ? session.operatingMode : 'hybrid',
      autoTakeover: session.takeover?.autoEnabled === true,
      agentProfileId: clean(session.agentProfileId, 200),
      agentProfileName: clean(session.agentProfileName, 120)
    }
  };
});

/** Start a Hybrid V2 session within the server-owned launch ceiling. */
export const startHybridDialerSession = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, role, access } = await requireDialer(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new HttpsError('not-found', 'Campaign not found.');
  const campaign = { id: campaignId, ...campaignSnapshot.data() };
  try { assertDocumentAccountAccess(access, campaign, { resource: 'campaign' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  assertRepCampaignAssignment(role, uid, campaign);
  const concurrency = resolveCampaignOperatingLimits({
    ...campaign,
    concurrency: Math.max(1, Math.min(5, Number(request.data?.concurrency) || 1))
  }).concurrency;
  const operatingMode = ['human', 'hybrid', 'ai'].includes(request.data?.operatingMode)
    ? request.data.operatingMode : 'hybrid';

  const support = assertSupports(campaign.provider, 'parallel', concurrency, { hybrid: true });
  if (!support.ok) {
    throw new HttpsError(
      'failed-precondition',
      `Provider "${campaign.provider}" cannot run Hybrid Dialer V2: missing ${support.missing.join(', ')}.`
    );
  }

  const campaignProfileId = clean(campaign.agentProfileId || campaign.agentId, 200);
  const requestedProfileId = clean(request.data?.agentProfileId || campaignProfileId, 200);
  if (operatingMode !== 'human' && !requestedProfileId) throw new HttpsError('failed-precondition', 'Choose an AI agent profile before starting AI-assisted calling.');
  const profileSnapshot = requestedProfileId ? await db.doc(`aiAgentProfiles/${requestedProfileId}`).get() : null;
  if (requestedProfileId && (!profileSnapshot?.exists || profileSnapshot.get('status') === 'archived')) {
    throw new HttpsError('failed-precondition', 'The selected AI agent profile is unavailable.');
  }
  assertProfileServesAccount(profileSnapshot, campaign.accountId);

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

  const autoTakeover = operatingMode === 'hybrid'
    && role !== 'outbound_rep' && request.data?.autoTakeover === true;
  await db.doc(`dialerSessions/${sessionId}`).set({
    hybridV2: true,
    userRole: role,
    concurrency,
    operatingMode,
    detachedAllowed: operatingMode === 'ai',
    autoDial: { enabled: false, state: 'idle', refillLeaseToken: '', refillLeaseUntil: null },
    wrapUpPendingCallId: '',
    pendingFollowUp: null,
    rep: { state: 'available', activeCallId: '', listeningCallId: '' },
    takeover: { autoEnabled: autoTakeover },
    agentProfileId: requestedProfileId,
    agentProfileName: clean(profileSnapshot?.get('name'), 120),
    agentProfileVersion: Math.max(1, Number(profileSnapshot?.get('version')) || 1),
    agentSessionOverride: sessionOverride,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await recordCallAuditEvent(db, 'session_started', {
    sessionId, campaignId, actorType: 'rep', actorId: uid,
    metadata: { hybridV2: true, concurrency, agentProfileId: requestedProfileId }
  });

  // The earliest honest signal that AI calls are coming. Nothing is dialled for
  // at least as long as it takes the rep to pick a campaign and hit dial, so
  // the sideband has ample runway to be up before the first prospect answers.
  await warmSidebandForSession({ operatingMode });

  return {
    sessionId,
    concurrency,
    autoTakeover,
    operatingMode,
    agentProfileId: requestedProfileId
  };
});

/** Heartbeat is ownership-checked so outbound_rep does not need the admin-only legacy callable. */
export const heartbeatHybridDialerSession = onCall(callOptions, async request => {
  const { db, uid, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  const beat = await heartbeatSession(db, sessionId);
  // Every 45 seconds for the life of the session, so the sideband stays up for
  // exactly as long as this rep could put a prospect in front of the AI — and
  // scales to zero once they close the dialer. Best-effort by construction: a
  // failed warm-up costs a cold start, never a dropped heartbeat.
  await warmSidebandForSession(session);
  return beat;
});

/** Change who owns future human answers without ending the server-side stream. */
export const setHybridOperatingMode = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  const operatingMode = ['human', 'hybrid', 'ai'].includes(request.data?.operatingMode)
    ? request.data.operatingMode : '';
  if (!operatingMode) throw new HttpsError('invalid-argument', 'Choose Human, Hybrid, or AI calling.');
  const agentProfileId = clean(request.data?.agentProfileId || session.agentProfileId, 200);
  if (operatingMode !== 'human' && !agentProfileId) {
    throw new HttpsError('failed-precondition', 'Choose an AI agent profile before enabling AI calling.');
  }
  const profileSnapshot = agentProfileId ? await db.doc(`aiAgentProfiles/${agentProfileId}`).get() : null;
  if (agentProfileId && (!profileSnapshot?.exists || profileSnapshot.get('status') === 'archived')) {
    throw new HttpsError('failed-precondition', 'The selected AI agent profile is unavailable.');
  }
  // Switching operating mode mid-session re-picks the persona, so the account
  // check has to run again here and not only at session start.
  if (profileSnapshot?.exists) {
    const sessionCampaign = await db.doc(`outboundCampaigns/${session.campaignId}`).get();
    assertProfileServesAccount(profileSnapshot, sessionCampaign.get('accountId'));
  }
  const agentProfileName = clean(profileSnapshot?.get('name'), 120);
  const agentProfileVersion = Math.max(1, Number(profileSnapshot?.get('version')) || 1);
  await db.doc(`dialerSessions/${sessionId}`).set({
    operatingMode,
    detachedAllowed: operatingMode === 'ai',
    agentProfileId,
    agentProfileName,
    agentProfileVersion,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  // A session that starts human-only never warms the sideband, so switching it
  // into an AI mode is its own first signal — and the switch can be followed by
  // a dial immediately.
  await warmSidebandForSession({ operatingMode });
  if (agentProfileId) {
    for (const callId of (session.activeCallIds || []).slice(-100)) {
      const callRef = db.doc(`calls/${callId}`);
      const callSnapshot = await callRef.get();
      if (!callSnapshot.exists || ['completed', 'cancelled', 'failed'].includes(callSnapshot.get('status'))) continue;
      await callRef.set({
        agent: {
          ...(callSnapshot.get('agent') || {}),
          profileId: agentProfileId,
          profileName: agentProfileName,
          profileVersion: agentProfileVersion,
          effectiveConfigHash: '', model: '', voice: ''
        },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }
  const refill = await maintainHybridCapacity(db, sessionId, { providerConfig: twilioConfig(), actorId: uid })
    .catch(error => ({ started: [], reason: clean(error?.message, 200) || 'refill_failed' }));
  await recordCallAuditEvent(db, 'session_operating_mode_changed', {
    sessionId,
    campaignId: session.campaignId,
    actorType: 'rep',
    actorId: uid,
    metadata: { operatingMode, agentProfileId }
  });
  return { ok: true, operatingMode, agentProfileId, agentProfileName, started: refill.started || [] };
});

/** Resize a running session without terminating calls above the new ceiling. */
export const setHybridConcurrency = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  const concurrency = Number(request.data?.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new HttpsError('invalid-argument', 'Concurrent lines must be between 1 and 5.');
  }
  const campaignSnapshot = await db.doc(`outboundCampaigns/${session.campaignId}`).get();
  const providerId = clean(campaignSnapshot.get('provider'), 40);
  const effectiveConcurrency = resolveCampaignOperatingLimits({
    provider: providerId,
    concurrency
  }).concurrency;
  if (effectiveConcurrency !== concurrency) {
    throw new HttpsError(
      'failed-precondition',
      `Carrier-backed campaigns are currently limited to ${effectiveConcurrency} concurrent line.`
    );
  }
  const support = assertSupports(providerId, 'parallel', concurrency, { hybrid: true });
  if (!support.ok) {
    throw new HttpsError('failed-precondition', `The provider cannot run ${concurrency} lines: ${support.missing.join(', ')}.`);
  }
  await db.doc(`dialerSessions/${sessionId}`).set({
    concurrency,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  const refill = await maintainHybridCapacity(db, sessionId, { providerConfig: twilioConfig(), actorId: uid })
    .catch(error => ({ started: [], reason: clean(error?.message, 200) || 'refill_failed' }));
  await recordCallAuditEvent(db, 'session_concurrency_changed', {
    sessionId,
    campaignId: session.campaignId,
    actorType: 'rep',
    actorId: uid,
    metadata: { from: Math.max(1, Number(session.concurrency) || 1), to: concurrency }
  });
  return { ok: true, concurrency, started: refill.started || [] };
});

/** Start server-owned auto dialing at the session's configured concurrency. */
export const dialHybridTargets = onCall({ ...callOptions, timeoutSeconds: 180, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, role, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  if (session.hybridV2 !== true) throw new HttpsError('failed-precondition', 'This is not a Hybrid Dialer V2 session.');
  // A session without an explicit mode routes as Hybrid inside `routeDecision`,
  // which silently puts the rep on the first answered call. Sessions started
  // before calling modes existed must be replaced, not guessed at.
  if (!['human', 'hybrid', 'ai'].includes(session.operatingMode)) {
    throw new HttpsError(
      'failed-precondition',
      'This session was started before calling modes existed and has no Human/Hybrid/AI ownership. End it and start a new session before dialing.'
    );
  }
  if (session.status !== 'active') return { started: [], reason: `session_${session.status}`, verifiedState: 'blocked' };
  if (session.wrapUpPendingCallId || session.pendingFollowUp?.status === 'awaiting_email'
      || session.pendingFollowUp?.status === 'sending') {
    throw new HttpsError('failed-precondition', 'Finish the last call’s outcome or interested-lead follow-up before dialing again.');
  }

  const nonTerminal = [];
  for (const callId of (session.activeCallIds || []).slice(-20)) {
    const snapshot = await db.doc(`calls/${callId}`).get();
    if (!snapshot.exists) continue;
    const status = snapshot.get('status');
    if (!['completed', 'cancelled', 'failed'].includes(status)) nonTerminal.push(callId);
  }
  if (nonTerminal.length) {
    const result = { started: [], reason: 'batch_in_progress', activeCallIds: nonTerminal, verifiedState: 'blocked' };
    await db.doc(`dialerSessions/${sessionId}`).set({
      lastDialAttempt: {
        state: 'blocked', reason: 'batch_in_progress', requestedAt: FieldValue.serverTimestamp(),
        startedCallIds: [], requestedBy: uid
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await recordCallAuditEvent(db, 'dial_preflight_blocked', {
      sessionId, campaignId: session.campaignId, actorType: 'rep', actorId: uid,
      metadata: { reason: 'batch_in_progress', activeCalls: nonTerminal.length }
    });
    return result;
  }

  const campaignSnapshot = await db.doc(`outboundCampaigns/${session.campaignId}`).get();
  if (!campaignSnapshot.exists) throw new HttpsError('not-found', 'Campaign not found.');
  const campaign = { id: campaignSnapshot.id, ...campaignSnapshot.data() };
  try { assertDocumentAccountAccess(access, campaign, { resource: 'campaign' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  assertRepCampaignAssignment(role, uid, campaign);
  const providerId = campaignSnapshot.get('provider');
  if (providerId !== 'twilio') throw new HttpsError('failed-precondition', 'Hybrid V2 currently requires Twilio.');

  await db.doc(`dialerSessions/${sessionId}`).set({
    connectedCallId: '', connectedTargetId: '', connectedAt: null,
    autoDial: {
      ...(session.autoDial || {}), enabled: true, state: 'starting',
      startedAt: FieldValue.serverTimestamp(), lastError: ''
    },
    rep: { state: 'available', activeCallId: '', listeningCallId: '' },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  const result = await maintainHybridCapacity(db, sessionId, { providerConfig: twilioConfig(), actorId: uid })
    .catch(error => { throw new HttpsError('internal', clean(error?.message, 300)); });

  const verifiedState = (result.started || []).length ? 'provider_accepted' : 'blocked';
  await db.doc(`dialerSessions/${sessionId}`).set({
    lastDialAttempt: {
      state: verifiedState,
      reason: clean(result.reason, 100),
      requestedAt: FieldValue.serverTimestamp(),
      startedCallIds: (result.started || []).map(entry => entry.callId).slice(0, 5),
      requestedBy: uid,
      availability: {
        scanned: Math.max(0, Number(result.availability?.scanned) || 0),
        rejectedByReason: result.availability?.rejectedByReason || {}
      }
    },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, verifiedState === 'provider_accepted' ? 'dial_provider_accepted' : 'dial_preflight_blocked', {
    sessionId, campaignId: session.campaignId, actorType: 'rep', actorId: uid,
    metadata: { reason: clean(result.reason, 100), started: (result.started || []).length }
  });

  return { ...result, verifiedState };
});

export const stopHybridDialerSession = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  await db.doc(`dialerSessions/${sessionId}`).set({
    autoDial: { ...(session.autoDial || {}), enabled: false, state: 'stopped' },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
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
  const { db, uid, access } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...callSnapshot.data() };
  await requireCallOperator(db, call, uid, access);
  if (call.provider !== 'twilio') throw new HttpsError('failed-precondition', 'Hybrid call control currently requires Twilio.');

  const provider = getCallingProvider('twilio', twilioConfig());
  if (call.providerCallId) await provider.endCall(call.providerCallId)
    .catch(error => { throw new HttpsError('internal', clean(error?.message, 300)); });
  const now = new Date();
  await db.doc(`calls/${callId}`).set({
    status: 'completed',
    endedAt: Timestamp.fromDate(now),
    endedBy: uid,
    endRequestedAt: Timestamp.fromDate(now),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  const campaignSnapshot = call.campaignId ? await db.doc(`outboundCampaigns/${call.campaignId}`).get() : null;
  const campaign = campaignSnapshot?.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null;
  if (call.targetId) {
    await applyDisposition(db, {
      targetId: call.targetId,
      callId,
      disposition: 'completed',
      campaign,
      actor: uid,
      now
    });
  }
  if (call?.control?.controller === 'human' || call?.control?.controller === 'transitioning') {
    await releaseRepFromCall(db, call.sessionId, call.id, {
      repUid: call?.control?.repUid || '', now
    }).catch(() => null);
  }
  await recordCallAuditEvent(db, 'call_end_requested', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid
  });
  const refill = await maintainHybridCapacity(db, call.sessionId, { providerConfig: twilioConfig() })
    .catch(async error => {
      await db.doc(`dialerSessions/${call.sessionId}`).set({
        autoDial: { state: 'error', lastError: clean(error?.message, 300) },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { started: [], reason: 'refill_failed' };
    });
  return { ok: true, replacementCalls: (refill.started || []).length };
});

/** Explicit DNC action. Kept separate from End Call by contract. */
export const markHybridCallDoNotCall = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, email, access } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...callSnapshot.data() };
  await requireCallOperator(db, call, uid, access);

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
/** Notes are saved independently of disposition and carrier call state. */
export const saveHybridCallNotes = onCall(callOptions, async request => {
  const { db, uid, access } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const notes = request.data?.notes;
  if (typeof notes !== 'string' || notes.length > 2000) {
    throw new HttpsError('invalid-argument', 'Call notes must be text of 2,000 characters or fewer.');
  }
  const snapshot = await db.doc(`calls/${callId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = snapshot.data();
  if (call.direction !== 'outbound') throw new HttpsError('failed-precondition', 'Choose an outbound call.');
  await requireCallOperator(db, call, uid, access);
  await snapshot.ref.update({
    callNotes: notes,
    notesUpdatedAt: FieldValue.serverTimestamp(),
    notesUpdatedBy: uid,
    updatedAt: FieldValue.serverTimestamp()
  });
  return { ok: true };
});

export const submitHybridDisposition = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, email, access } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...callSnapshot.data() };
  const session = await requireCallOperator(db, call, uid, access);
  const campaignSnapshot = await db.doc(`outboundCampaigns/${call.campaignId}`).get();
  const disposition = clean(request.data?.disposition, 40);
  const scheduleOnly = request.data?.scheduleOnly === true;
  if (scheduleOnly && disposition !== 'call_later') throw new HttpsError('invalid-argument', 'Choose a callback outcome.');
  const allowedDispositions = new Set([
    'connected', 'interested', 'qualified', 'booked_meeting', 'call_later', 'not_interested',
    'voicemail', 'no_answer', 'wrong_number', 'do_not_call'
  ]);
  if (!allowedDispositions.has(disposition)) throw new HttpsError('invalid-argument', 'Choose a valid call outcome.');
  const followUpAtRaw = clean(request.data?.followUpAt, 80);
  const partnerOutcomes = sanitizePartnerOutcomes(request.data?.partnerOutcomes);
  const followUpAt = followUpAtRaw ? new Date(followUpAtRaw) : null;
  if (followUpAtRaw && Number.isNaN(followUpAt?.getTime())) throw new HttpsError('invalid-argument', 'Enter a valid follow-up time.');
  if (['booked_meeting', 'call_later'].includes(disposition) && !followUpAt) {
    throw new HttpsError('invalid-argument', 'This outcome requires a follow-up time.');
  }
  if (disposition === 'call_later' && followUpAt <= new Date()) {
    throw new HttpsError('invalid-argument', 'Choose a callback time in the future.');
  }
  const result = await applyDisposition(db, {
    targetId: call.targetId,
    callId,
    disposition,
    notes: clean(request.data?.notes, 2000),
    partnerOutcomes,
    campaign: campaignSnapshot.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null,
    actor: email || uid,
    requestedFollowUpAt: followUpAt
  });
  if (!result.ok) {
    throw new HttpsError('failed-precondition', result.reason === 'target_missing'
      ? 'The target for this call could not be found.' : result.reason || 'Could not save this call outcome.');
  }
  await db.doc(`calls/${callId}`).set({
    ...(!scheduleOnly ? {
      disposition,
      ...(typeof request.data?.notes === 'string' ? { summary: clean(request.data.notes, 2000) } : {}),
      ...(Array.isArray(request.data?.partnerOutcomes) ? { partnerOutcomes } : {}),
      dispositionBy: email || uid,
      wrapUp: {
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        completedBy: email || uid,
        ...(followUpAt ? { followUpAt } : {})
      }
    } : {}),
    ...(disposition === 'call_later' ? { callbackAt: followUpAt, callbackScheduledBy: uid } : {}),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  const promotedLeadId = result?.leadId;
  if (followUpAt && promotedLeadId) {
    await db.doc(`leads/${promotedLeadId}`).set({
      nextActionAt: followUpAt,
      nextFollowUpAt: followUpAt,
      nextActionType: disposition === 'booked_meeting' ? 'meeting' : 'callback',
      nextActionCallId: callId,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  await recordCallAuditEvent(db, 'disposition_recorded', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid, metadata: { disposition, followUpAt: followUpAtRaw }
  });
  if (!scheduleOnly && session.hybridV2 === true) {
    const sessionRef = db.doc(`dialerSessions/${session.id}`);
    if (disposition === 'interested') {
      const leadId = clean(result.leadId, 200);
      if (!leadId) throw new HttpsError('failed-precondition', 'The interested contact could not be saved as a lead.');
      const leadSnapshot = await db.doc(`leads/${leadId}`).get();
      if (!leadSnapshot.exists) throw new HttpsError('failed-precondition', 'The interested lead could not be found.');
      await sessionRef.set({
        wrapUpPendingCallId: '',
        pendingFollowUp: { callId, leadId, status: 'awaiting_email', campaignId: call.campaignId },
        autoDial: { ...(session.autoDial || {}), enabled: false, state: 'paused_for_followup' },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      await sessionRef.set({
        ...(session.wrapUpPendingCallId === callId ? { wrapUpPendingCallId: '' } : {}),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      if (session.status === 'active' && session.autoDial?.enabled === true) {
        await maintainHybridCapacity(db, session.id, { providerConfig: twilioConfig(), actorId: uid })
          .catch(error => console.error('[hybrid-capacity] disposition refill failed', clean(error?.message, 300)));
      }
    }
  }
  return result;
});

/** Pause new calls immediately; an already-connected call is left untouched. */
export const pauseHybridAutoDial = onCall(callOptions, async request => {
  const { db, uid, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  if (session.hybridV2 !== true) throw new HttpsError('failed-precondition', 'This is not a Hybrid Dialer V2 session.');
  await db.doc(`dialerSessions/${sessionId}`).set({
    autoDial: { ...(session.autoDial || {}), enabled: false, state: 'paused_by_rep' },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'auto_dial_paused', {
    sessionId, campaignId: session.campaignId, actorType: 'rep', actorId: uid,
    metadata: { reason: 'rep_pause' }
  });
  return { ok: true, enabled: false };
});

/** Only resume after the pending disposition and any interested follow-up are handled. */
export const resumeHybridAutoDial = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, role, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  if (session.hybridV2 !== true) throw new HttpsError('failed-precondition', 'This is not a Hybrid Dialer V2 session.');
  if (session.wrapUpPendingCallId) {
    throw new HttpsError('failed-precondition', 'Record the last call outcome before resuming.');
  }
  if (session.pendingFollowUp?.status === 'awaiting_email' || session.pendingFollowUp?.status === 'sending') {
    throw new HttpsError('failed-precondition', 'Send the interested lead’s follow-up email or continue without one before resuming.');
  }
  const campaignSnapshot = await db.doc(`outboundCampaigns/${session.campaignId}`).get();
  if (!campaignSnapshot.exists) throw new HttpsError('not-found', 'Campaign not found.');
  const campaign = { id: campaignSnapshot.id, ...campaignSnapshot.data() };
  try { assertDocumentAccountAccess(access, campaign, { resource: 'campaign' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  assertRepCampaignAssignment(role, uid, campaign);
  if (campaign.status === 'paused' || campaign.status === 'cancelled') {
    throw new HttpsError('failed-precondition', `This campaign is ${campaign.status}. Ask a manager to resume it before dialing.`);
  }
  await db.doc(`dialerSessions/${sessionId}`).set({
    autoDial: { ...(session.autoDial || {}), enabled: true, state: 'starting', lastError: '' },
    pendingFollowUp: null,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  const result = await maintainHybridCapacity(db, sessionId, { providerConfig: twilioConfig(), actorId: uid });
  await recordCallAuditEvent(db, 'auto_dial_resumed', {
    sessionId, campaignId: session.campaignId, actorType: 'rep', actorId: uid,
    metadata: { started: (result.started || []).length }
  });
  return { ok: true, enabled: true, started: result.started || [], reason: result.reason || '' };
});

async function requirePendingFollowUp(db, session, role, uid, access) {
  const pending = session.pendingFollowUp || {};
  if (!pending.callId || !pending.leadId || !['awaiting_email', 'sending', 'sent', 'skipped'].includes(pending.status)) {
    throw new HttpsError('failed-precondition', 'There is no interested-call follow-up to open.');
  }
  const [callSnapshot, campaignSnapshot, leadSnapshot] = await Promise.all([
    db.doc(`calls/${pending.callId}`).get(),
    db.doc(`outboundCampaigns/${session.campaignId}`).get(),
    db.doc(`leads/${pending.leadId}`).get()
  ]);
  if (!callSnapshot.exists || callSnapshot.get('disposition') !== 'interested'
      || callSnapshot.get('sessionId') !== session.id
      || callSnapshot.get('campaignId') !== session.campaignId
      || (pending.campaignId && pending.campaignId !== session.campaignId)
      || !campaignSnapshot.exists || !leadSnapshot.exists) {
    throw new HttpsError('failed-precondition', 'The interested-call follow-up could not be verified.');
  }
  const campaign = { id: campaignSnapshot.id, ...campaignSnapshot.data() };
  assertRepCampaignAssignment(role, uid, campaign);
  const lead = leadSnapshot.data() || {};
  try { assertDocumentAccountAccess(access, campaign, { resource: 'campaign' }); }
  catch (error) { throw new HttpsError('permission-denied', clean(error.message, 300)); }
  const leadAccountId = readAccountId(lead.accountId, { fallback: LEGACY_ACCOUNT_ID });
  if (leadAccountId !== campaign.accountId || leadAccountId !== session.accountId) {
    throw new HttpsError('permission-denied', 'The lead and campaign belong to different accounts.');
  }
  return { pending, campaign, call: { id: callSnapshot.id, ...callSnapshot.data() }, lead, leadRef: leadSnapshot.ref };
}

/** Return the server-resolved recipient for the rep's own pending interested lead. */
export const getHybridFollowUpContext = onCall(callOptions, async request => {
  const { db, uid, role, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  const { pending, lead } = await requirePendingFollowUp(db, session, role, uid, access);
  const email = normalizedEmail(lead.email);
  const preference = validEmail(email) ? await db.doc(`emailPreferences/${emailKey(email)}`).get() : null;
  return {
    callId: pending.callId,
    leadId: pending.leadId,
    name: clean(lead.name, 120),
    businessName: clean(lead.businessName, 200),
    email,
    emailAvailable: validEmail(email) && lead.doNotEmail !== true && preference?.get('transactionalBlocked') !== true,
    emailBlockReason: !validEmail(email) ? 'missing_address'
      : lead.doNotEmail === true ? 'do_not_email'
        : preference?.get('transactionalBlocked') === true ? 'suppressed' : '',
    status: pending.status
  };
});

/** Send an explicitly composed follow-up to the lead's stored email address. */
export const sendHybridFollowUpEmail = onCall(
  { ...callOptions, secrets: [POSTMARK_SERVER_TOKEN], timeoutSeconds: 30 },
  async request => {
    const { db, uid, role, access } = await requireDialer(request);
    const sessionId = requireId(request.data?.sessionId, 'session id');
    const session = await requireOwnedSession(db, sessionId, uid, access);
    const { pending, call, lead, leadRef } = await requirePendingFollowUp(db, session, role, uid, access);
    const subject = clean(request.data?.subject, 200);
    const message = typeof request.data?.message === 'string' ? request.data.message.trim().slice(0, 10000) : '';
    const email = normalizedEmail(lead.email);
    if (pending.status !== 'awaiting_email') throw new HttpsError('failed-precondition', 'This follow-up is already being sent or is complete.');
    if (!subject || !message) throw new HttpsError('invalid-argument', 'Add an email subject and message before sending.');
    if (!validEmail(email)) throw new HttpsError('failed-precondition', 'This lead does not have a valid email address.');
    if (lead.doNotEmail === true) throw new HttpsError('failed-precondition', 'This lead is marked do not email.');
    const preference = await db.doc(`emailPreferences/${emailKey(email)}`).get();
    if (preference.get('transactionalBlocked') === true) {
      throw new HttpsError('failed-precondition', 'Email delivery to this address is suppressed.');
    }

    const sessionRef = db.doc(`dialerSessions/${sessionId}`);
    await db.runTransaction(async transaction => {
      const latest = await transaction.get(sessionRef);
      const current = latest.get('pendingFollowUp') || {};
      if (latest.get('userUid') !== uid || current.callId !== call.id || current.status !== 'awaiting_email') {
        throw new HttpsError('failed-precondition', 'This follow-up has already been handled.');
      }
      transaction.set(sessionRef, {
        pendingFollowUp: { ...current, status: 'sending' },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    const from = process.env.POSTMARK_FROM_EMAIL || 'BiteSites <jensy@bitesites.org>';
    const stream = process.env.POSTMARK_MESSAGE_STREAM || 'outbound';
    let result;
    try {
      result = await sendPostmark(POSTMARK_SERVER_TOKEN.value(), buildMessage({
        from,
        to: email,
        template: buildLeadOutreachTemplate(),
        variables: {
          first_name: clean(lead.name, 120).split(/\s+/)[0] || 'there',
          subject_line: subject,
          headline: subject,
          preheader: message.replace(/\s+/g, ' ').slice(0, 140),
          message
        },
        stream,
        tag: 'rep-call-follow-up'
      }));
    } catch (error) {
      await sessionRef.set({
        pendingFollowUp: { ...pending, status: 'awaiting_email' },
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      throw new HttpsError('internal', clean(error?.message, 300) || 'Could not send the follow-up email.');
    }

    // Delivery succeeded; a secondary CRM/audit problem must not invite a duplicate send.
    await sessionRef.set({
      pendingFollowUp: { ...pending, status: 'sent', sentAt: FieldValue.serverTimestamp(), sentBy: uid },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await Promise.all([
      leadRef.set({ lastOutboundEmailAt: FieldValue.serverTimestamp(), lastOutboundEmailBy: uid }, { merge: true })
        .catch(error => console.error('[hybrid-follow-up] lead update failed', clean(error?.message, 200))),
      leadRef.collection('activities').add({
        type: 'outbound_email_sent', callId: call.id, campaignId: session.campaignId,
        actor: uid, recipientKey: emailKey(email), subject: clean(subject, 200),
        createdAt: FieldValue.serverTimestamp()
      }).catch(error => console.error('[hybrid-follow-up] activity log failed', clean(error?.message, 200))),
      db.collection('emailDeliveries').add({
        templateId: 'lead-follow-up', kind: 'lead-follow-up', recipientCount: 1,
        recipientKey: emailKey(email), leadId: pending.leadId,
        sentBy: uid, status: 'sent', postmark: [result.MessageID].filter(Boolean),
        createdAt: FieldValue.serverTimestamp()
      }).catch(error => console.error('[hybrid-follow-up] delivery log failed', clean(error?.message, 200)))
    ]);
    await recordCallAuditEvent(db, 'interested_follow_up_email_sent', {
      callId: call.id, sessionId, campaignId: session.campaignId,
      actorType: 'rep', actorId: uid, metadata: { recipientKey: emailKey(email) }
    }).catch(error => console.error('[hybrid-follow-up] audit write failed', clean(error?.message, 200)));
    return { ok: true, email, status: 'sent' };
  }
);

/** Explicitly let a rep continue without sending the optional follow-up email. */
export const skipHybridFollowUpEmail = onCall(callOptions, async request => {
  const { db, uid, role, access } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid, access);
  const { pending } = await requirePendingFollowUp(db, session, role, uid, access);
  if (pending.status !== 'awaiting_email') throw new HttpsError('failed-precondition', 'This follow-up is already being sent or is complete.');
  await db.doc(`dialerSessions/${sessionId}`).set({
    pendingFollowUp: { ...pending, status: 'skipped', skippedAt: FieldValue.serverTimestamp(), skippedBy: uid },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await recordCallAuditEvent(db, 'interested_follow_up_email_skipped', {
    callId: pending.callId, sessionId, campaignId: session.campaignId,
    actorType: 'rep', actorId: uid
  });
  return { ok: true, status: 'skipped' };
});
