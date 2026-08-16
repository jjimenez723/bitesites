// Hybrid Dialer V2 session APIs.
//
// These wrap the proven V1 target locking/compliance/dial preparation logic but
// initialize and operate sessions using the V2 rep/controller model. The public
// UI should use these functions rather than the legacy start/dial functions.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

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

async function requireCallOperator(db, call, uid) {
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
  const { db, uid } = await requireDialer(request);
  const session = await findActiveDialerSession(db, uid, { hybridOnly: true });
  if (!session) return { session: null };
  return {
    session: {
      sessionId: session.id,
      campaignId: clean(session.campaignId, 200),
      status: clean(session.status, 40),
      concurrency: Math.max(1, Number(session.concurrency) || 3),
      operatingMode: ['human', 'hybrid', 'ai'].includes(session.operatingMode) ? session.operatingMode : 'hybrid',
      autoTakeover: session.takeover?.autoEnabled === true,
      agentProfileId: clean(session.agentProfileId, 200),
      agentProfileName: clean(session.agentProfileName, 120)
    }
  };
});

/** Start a Hybrid V2 session with one to five simultaneous outbound legs. */
export const startHybridDialerSession = onCall({ ...callOptions, secrets: HYBRID_SECRETS }, async request => {
  const { db, uid, role } = await requireDialer(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  const campaignSnapshot = await db.doc(`outboundCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists) throw new HttpsError('not-found', 'Campaign not found.');
  const campaign = { id: campaignId, ...campaignSnapshot.data() };
  const concurrency = Math.max(1, Math.min(5, Number(request.data?.concurrency) || 3));
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
    concurrency,
    operatingMode,
    detachedAllowed: operatingMode === 'ai',
    autoDial: { enabled: false, state: 'idle', refillLeaseToken: '', refillLeaseUntil: null },
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
  const { db, uid } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid);
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
  const { db, uid } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid);
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
  const { db, uid } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid);
  const concurrency = Number(request.data?.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new HttpsError('invalid-argument', 'Concurrent lines must be between 1 and 5.');
  }
  const campaignSnapshot = await db.doc(`outboundCampaigns/${session.campaignId}`).get();
  const providerId = clean(campaignSnapshot.get('provider'), 40);
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
  const { db, uid } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid);
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
  const { db, uid } = await requireDialer(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const session = await requireOwnedSession(db, sessionId, uid);
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
  const { db, uid } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...callSnapshot.data() };
  await requireCallOperator(db, call, uid);
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
  const { db, uid, email } = await requireDialer(request);
  const callId = requireId(request.data?.callId, 'call id');
  const callSnapshot = await db.doc(`calls/${callId}`).get();
  if (!callSnapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = { id: callId, ...callSnapshot.data() };
  await requireCallOperator(db, call, uid);

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
  await requireCallOperator(db, call, uid);
  const campaignSnapshot = await db.doc(`outboundCampaigns/${call.campaignId}`).get();
  const disposition = clean(request.data?.disposition, 40);
  const allowedDispositions = new Set([
    'connected', 'qualified', 'booked_meeting', 'call_later', 'not_interested',
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
  await db.doc(`calls/${callId}`).set({
    disposition,
    summary: clean(request.data?.notes, 2000),
    partnerOutcomes,
    dispositionBy: email || uid,
    wrapUp: {
      status: 'completed',
      completedAt: FieldValue.serverTimestamp(),
      completedBy: email || uid,
      ...(followUpAt ? { followUpAt } : {})
    },
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  const promotedLeadId = result?.promotion?.leadId;
  if (followUpAt && promotedLeadId) {
    await db.doc(`leads/${promotedLeadId}`).set({
      nextActionAt: followUpAt,
      nextActionType: disposition === 'booked_meeting' ? 'meeting' : 'callback',
      nextActionCallId: callId,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  await recordCallAuditEvent(db, 'disposition_recorded', {
    callId, sessionId: call.sessionId, campaignId: call.campaignId,
    actorType: 'rep', actorId: uid, metadata: { disposition, followUpAt: followUpAtRaw }
  });
  return result;
});
