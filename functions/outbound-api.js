// The Cloud Functions surface for the outbound feature.
//
// Everything below is a thin, validating shell over the modules that hold the
// logic. That split is deliberate: `onCall`/`onRequest` wrappers cannot be
// tested without the Functions runtime, so keeping them empty of decisions
// means the decisions are all in modules that `node --test` and the emulator
// can reach directly.
//
// Rules for this file, from §41:
//   * Callables require authentication AND an effective admin role, validate
//     every input, return small normalised objects, and never return a secret.
//   * Webhooks validate a provider signature or shared secret, reject anything
//     that is not a POST, fail closed when the secret is unset, use
//     deterministic event ids, and are safe to redeliver.
//   * Secrets are read from Secret Manager at call time, never from Firestore
//     and never sent to the browser.

import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { describeLeadSources } from './providers/lead-sources/index.js';
import { describeCallingProviders, getCallingProvider } from './providers/calling/index.js';
import {
  createDiscoveryJob, runDiscoverySlice, claimJobForWorker, heartbeatJob,
  submitDiscoveryResults, finishJob, recoverStaleJobs, pruneRawResults
} from './lead-discovery.js';
import { importProspects, createImportRun, finishImportRun, resolveDuplicate } from './prospect-import.js';
import { requireAccountId, sanitizePartnerOutcomes } from './accounts.js';
import { csvToRecords } from './providers/lead-sources/csv-source.js';
import { promoteProspect } from './prospect-conversion.js';
import {
  createCampaign, updateCampaign, setCampaignStatus, importTargets,
  startDialerSession, heartbeatSession, dialNext, stopDialerSession,
  runAICampaignSlice, recordCallEvent, applyDisposition, moveToCallLater,
  markDoNotCall, reconcileSessions, releaseDueTargets, refreshCampaignCounts,
  ensureResearch, releaseTargetsForApprovedResearch,
  prepareCampaignResearchBatch, approveCampaignResearchBatch
} from './outbound-calls.js';
import { contactKey, approveResearch, loadResearch, researchContact, saveResearch } from './lead-enrichment.js';
import { loadContactForTarget } from './outbound-contacts.js';
import { clean } from './prospect-normalization.js';
import { hybridOutboundEventsUrl } from './hybrid-urls.js';

// ------------------------------------------------------------------- secrets

export const KIXIE_API_KEY = defineSecret('KIXIE_API_KEY');
export const KIXIE_BUSINESS_ID = defineSecret('KIXIE_BUSINESS_ID');
export const KIXIE_POWERLIST_ID = defineSecret('KIXIE_POWERLIST_ID');
export const KIXIE_WEBHOOK_SECRET = defineSecret('KIXIE_WEBHOOK_SECRET');
export const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
export const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
export const TWILIO_TWIML_APP_SID = defineSecret('TWILIO_TWIML_APP_SID');
export const OUTBOUND_WEBHOOK_SECRET = defineSecret('OUTBOUND_WEBHOOK_SECRET');
export const LEAD_SOURCE_API_KEY = defineSecret('LEAD_SOURCE_API_KEY');
export const GHL_OUTBOUND_WORKFLOW_ID = defineSecret('GHL_OUTBOUND_WORKFLOW_ID');
export const DISCOVERY_WORKER_SECRET = defineSecret('DISCOVERY_WORKER_SECRET');

const OUTBOUND_SECRETS = [
  KIXIE_API_KEY, KIXIE_BUSINESS_ID, KIXIE_POWERLIST_ID, KIXIE_WEBHOOK_SECRET,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_TWIML_APP_SID,
  OUTBOUND_WEBHOOK_SECRET, GHL_OUTBOUND_WORKFLOW_ID
];

// Provider credentials are optional on the settings screen. Binding every
// possible provider secret here prevents this read-only callable from being
// deployed until Kixie and GoHighLevel have also been configured. Twilio is
// the active provider for this project; the unbound adapters still report
// their missing secret names through `healthCheck()` below.
const OUTBOUND_CONFIG_SECRETS = [
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_TWIML_APP_SID
];

const secretValue = secret => {
  try {
    const value = secret.value() || '';
    return value === 'unset' ? '' : value;
  } catch {
    return '';
  }
};

/**
 * Provider config, assembled per call from Secret Manager.
 *
 * Built fresh each time rather than cached in a module constant: a rotated
 * secret should take effect on the next invocation, not on the next cold start.
 */
function providerConfigFor(providerId, { requestUrl = '' } = {}) {
  const webhookUrl = process.env.OUTBOUND_WEBHOOK_URL
    || (requestUrl ? new URL('/api/outbound-events', requestUrl).toString() : '');

  switch (providerId) {
    case 'kixie':
      return {
        apiKey: secretValue(KIXIE_API_KEY),
        businessId: secretValue(KIXIE_BUSINESS_ID),
        powerlistId: secretValue(KIXIE_POWERLIST_ID)
      };
    case 'twilio':
      return {
        accountSid: secretValue(TWILIO_ACCOUNT_SID),
        authToken: secretValue(TWILIO_AUTH_TOKEN),
        twimlAppSid: secretValue(TWILIO_TWIML_APP_SID),
        statusCallbackUrl: webhookUrl
      };
    case 'gohighlevel':
      return {
        token: process.env.GHL_API_TOKEN || '',
        locationId: process.env.GHL_LOCATION_ID || 'LDL5wuJlnVnqk9vn6taD',
        workflowId: secretValue(GHL_OUTBOUND_WORKFLOW_ID)
      };
    default:
      return {};
  }
}

// --------------------------------------------------------------------- guards

async function callerRole(db, auth) {
  if (auth?.token?.role) return auth.token.role;
  const snapshot = await db.doc(`roles/${auth.uid}`).get();
  return snapshot.exists ? snapshot.get('role') || '' : '';
}

/** Every callable in this file starts here. */
async function requireAdmin(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  const role = await callerRole(db, request.auth);
  if (!['admin', 'outbound_manager'].includes(role)) {
    throw new HttpsError('permission-denied', 'Only an admin or outbound manager can manage outbound calling.');
  }
  return { db, uid: request.auth.uid, email: request.auth.token?.email || '', role };
}

async function requireOutboundStaff(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  const role = await callerRole(db, request.auth);
  if (!['admin', 'outbound_rep', 'outbound_manager'].includes(role)) {
    throw new HttpsError('permission-denied', 'This account cannot use outbound calling.');
  }
  return { db, uid: request.auth.uid, email: request.auth.token?.email || '', role };
}

const str = (value, maxLen = 200) => clean(value, maxLen);

const requireId = (value, label) => {
  const id = str(value, 200);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpsError('invalid-argument', `A valid ${label} is required.`);
  return id;
};

const idList = (value, max = 2000) =>
  (Array.isArray(value) ? value : [])
    .map(entry => str(entry, 200))
    .filter(entry => /^[A-Za-z0-9_-]+$/.test(entry))
    .slice(0, max);

const callOptions = { enforceAppCheck: false, maxInstances: 10 };

// ------------------------------------------------------------ configuration

/** What the dashboard can offer. Capability flags and secret NAMES only. */
export const getOutboundConfig = onCall({ ...callOptions, secrets: OUTBOUND_CONFIG_SECRETS }, async request => {
  await requireOutboundStaff(request);

  const providers = await Promise.all(describeCallingProviders().map(async provider => {
    let health = { ok: false, missing: provider.requiredSecrets };
    try {
      const providerConfig = providerConfigFor(provider.id);
      // The dashboard describes the Hybrid V2 dialer. Its Twilio callbacks use
      // the deployed Hybrid endpoint, which is derived from PUBLIC_APP_URL;
      // OUTBOUND_WEBHOOK_URL belongs only to the retained legacy dialer.
      if (provider.id === 'twilio') {
        providerConfig.statusCallbackUrl = hybridOutboundEventsUrl();
        providerConfig.hybridV2 = true;
      }
      health = await getCallingProvider(provider.id, providerConfig).healthCheck();
    } catch { /* keep the pessimistic default */ }
    return { ...provider, configured: health.ok, missingSecrets: health.missing || [] };
  }));

  return {
    leadSources: describeLeadSources(),
    callingProviders: providers,
    // A standing reminder rather than a one-off banner: the controls in this
    // feature are technical, and technical controls are not legal approval.
    complianceNotice: 'These controls enforce configured settings only. Consent basis, calling hours, recording and AI disclosure, scripts and opt-out handling must be approved by legal counsel before any live campaign.'
  };
});

// -------------------------------------------------------------- discovery

export const createLeadDiscoveryJob = onCall({ ...callOptions, secrets: [LEAD_SOURCE_API_KEY] }, async request => {
  const { db, email } = await requireAdmin(request);
  const jobId = await createDiscoveryJob(db, {
    provider: str(request.data?.provider, 40),
    criteria: request.data?.criteria || {},
    accountId: request.data?.accountId,
    createdBy: email,
    sourceOptions: { apiKey: secretValue(LEAD_SOURCE_API_KEY) }
  }).catch(error => { throw new HttpsError('invalid-argument', clean(error?.message, 300)); });
  return { jobId };
});

export const runLeadDiscoveryJob = onCall({ ...callOptions, timeoutSeconds: 540, secrets: [LEAD_SOURCE_API_KEY] }, async request => {
  const { db } = await requireAdmin(request);
  const jobId = requireId(request.data?.jobId, 'job id');
  const result = await runDiscoverySlice(db, jobId, {
    budgetMs: 420_000,
    sourceOptions: { apiKey: secretValue(LEAD_SOURCE_API_KEY) }
  }).catch(error => { throw new HttpsError('internal', clean(error?.message, 300)); });
  return result;
});

export const pauseLeadDiscoveryJob = onCall(callOptions, async request => {
  const { db } = await requireAdmin(request);
  const jobId = requireId(request.data?.jobId, 'job id');
  await db.doc(`scrapeJobs/${jobId}`).set({ status: 'paused' }, { merge: true });
  return { ok: true };
});

export const cancelLeadDiscoveryJob = onCall(callOptions, async request => {
  const { db } = await requireAdmin(request);
  const jobId = requireId(request.data?.jobId, 'job id');
  await db.doc(`scrapeJobs/${jobId}`).set({
    status: 'cancelled', completedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true };
});

/**
 * The local worker's only door.
 *
 * A worker gets a shared secret, not Firestore credentials — §13 is explicit
 * that it must not have unrestricted write access. Everything it submits is
 * re-normalised and re-deduplicated by the Admin SDK on this side.
 */
export const discoveryWorker = onRequest({ secrets: [DISCOVERY_WORKER_SECRET], maxInstances: 5 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
    return;
  }
  const expected = clean(secretValue(DISCOVERY_WORKER_SECRET), 200);
  if (expected.length < 16 || expected === 'unset') {
    console.error('[discovery] DISCOVERY_WORKER_SECRET is not set — refusing the request');
    res.status(503).json({ error: 'not-configured' });
    return;
  }
  const provided = clean(req.get('x-worker-secret'), 200);
  if (provided.length !== expected.length || provided !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const db = getFirestore();
  const workerId = clean(req.body?.workerId, 80);
  if (!workerId) { res.status(400).json({ error: 'workerId is required' }); return; }

  try {
    switch (clean(req.body?.action, 30)) {
      case 'claim': {
        const job = await claimJobForWorker(db, workerId);
        res.json({ job });
        return;
      }
      case 'heartbeat': {
        const result = await heartbeatJob(db, requireId(req.body?.jobId, 'job id'), workerId, {
          cursor: req.body?.cursor,
          progress: req.body?.progress
        });
        res.json(result);
        return;
      }
      case 'submit': {
        const result = await submitDiscoveryResults(db, requireId(req.body?.jobId, 'job id'), workerId, req.body?.records || []);
        res.json(result);
        return;
      }
      case 'finish': {
        const result = await finishJob(db, requireId(req.body?.jobId, 'job id'), workerId, {
          status: req.body?.status === 'failed' ? 'failed' : 'completed',
          error: req.body?.error
        });
        res.json(result);
        return;
      }
      default:
        res.status(400).json({ error: 'unknown-action' });
    }
  } catch (error) {
    // Bounded and credential-free: this response goes to a machine on somebody's
    // laptop, and the message ends up in its log.
    res.status(400).json({ error: clean(error?.message, 300) });
  }
});

// ---------------------------------------------------------------- prospects

export const importProspectCsv = onCall({ ...callOptions, timeoutSeconds: 300 }, async request => {
  const { db, email } = await requireAdmin(request);
  const csvText = String(request.data?.csvText || '');
  // 5MB of CSV is roughly 40k rows — past that it belongs in the migration
  // script, which can stream, rather than in a callable's request body.
  if (!csvText || csvText.length > 5_000_000) throw new HttpsError('invalid-argument', 'Provide a CSV under 5MB.');

  const dryRun = request.data?.dryRun !== false;
  // Which book these prospects join. Explicit on every import: a spreadsheet of
  // Hudson County property managers is a client list or a house list, and only
  // the person uploading it knows which.
  let accountId;
  try {
    accountId = requireAccountId(request.data?.accountId, { field: 'accountId' });
  } catch (error) {
    throw new HttpsError('invalid-argument', error.message);
  }

  const { records, unmapped } = csvToRecords(csvText);
  if (!records.length) throw new HttpsError('invalid-argument', 'No data rows were found in that file.');

  const runId = dryRun ? '' : await createImportRun(db, {
    sourceSystem: 'csv', mode: 'execute', collections: ['csv'], startedBy: email, accountId
  });

  const result = await importProspects(db, records, {
    source: { system: 'csv', provider: 'csv' },
    importRunId: runId,
    accountId,
    dryRun
  });

  if (runId) await finishImportRun(db, runId, { counts: result.counts });

  return {
    dryRun, runId, counts: result.counts, samples: result.samples,
    unmappedColumns: unmapped, rows: records.length
  };
});

export const resolveProspectDuplicate = onCall(callOptions, async request => {
  const { db, email } = await requireAdmin(request);
  const prospectId = requireId(request.data?.prospectId, 'prospect id');
  const action = str(request.data?.action, 20);
  if (!['keep', 'merge'].includes(action)) throw new HttpsError('invalid-argument', 'Action must be keep or merge.');
  return resolveDuplicate(db, prospectId, { action, reviewedBy: email });
});

export const promoteProspectToLead = onCall(callOptions, async request => {
  const { db, email } = await requireAdmin(request);
  const prospectId = requireId(request.data?.prospectId, 'prospect id');
  const trigger = str(request.data?.trigger, 40) || 'manual_qualification';
  const manualReason = str(request.data?.manualReason, 120);
  const contactStatus = str(request.data?.contactStatus, 40);
  if (trigger === 'manual_qualification') {
    if (!manualReason) throw new HttpsError('invalid-argument', 'Choose why this prospect should be added to Leads.');
    if (!['not_contacted', 'external_contact', 'unknown'].includes(contactStatus)) {
      throw new HttpsError('invalid-argument', 'Confirm whether contact occurred outside BiteSites.');
    }
  }
  const result = await promoteProspect(db, prospectId, {
    trigger,
    campaignId: str(request.data?.campaignId, 200),
    targetId: str(request.data?.targetId, 200),
    manualReason,
    manualNotes: str(request.data?.manualNotes, 2000),
    contactStatus,
    actor: email
  }).catch(error => { throw new HttpsError('failed-precondition', clean(error?.message, 300)); });
  return result;
});

// ---------------------------------------------------------------- campaigns

export const createOutboundCampaign = onCall(callOptions, async request => {
  const { db, email } = await requireAdmin(request);
  const campaignId = await createCampaign(db, request.data || {}, { createdBy: email })
    .catch(error => { throw new HttpsError('invalid-argument', clean(error?.message, 300)); });
  return { campaignId };
});

export const updateOutboundCampaign = onCall(callOptions, async request => {
  const { db } = await requireAdmin(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  return updateCampaign(db, campaignId, request.data?.campaign || {})
    .catch(error => { throw new HttpsError('invalid-argument', clean(error?.message, 300)); });
});

const statusCallable = status => onCall(callOptions, async request => {
  const { db, email } = await requireAdmin(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  return setCampaignStatus(db, campaignId, status, { actor: email })
    .catch(error => { throw new HttpsError('failed-precondition', clean(error?.message, 300)); });
});

export const startOutboundCampaign = statusCallable('running');
export const pauseOutboundCampaign = statusCallable('paused');
export const resumeOutboundCampaign = statusCallable('running');
export const cancelOutboundCampaign = statusCallable('cancelled');

export const importOutboundTargets = onCall({ ...callOptions, timeoutSeconds: 300 }, async request => {
  const { db } = await requireAdmin(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  return importTargets(db, campaignId, {
    prospectIds: idList(request.data?.prospectIds),
    leadIds: idList(request.data?.leadIds),
    priority: Number(request.data?.priority) || 50
  }).catch(error => { throw new HttpsError('invalid-argument', clean(error?.message, 300)); });
});

// ----------------------------------------------------------------- research

export const researchOutboundContact = onCall({ ...callOptions, timeoutSeconds: 120 }, async request => {
  const { db } = await requireAdmin(request);
  const contactType = str(request.data?.contactType, 20);
  if (!['lead', 'prospect'].includes(contactType)) throw new HttpsError('invalid-argument', 'contactType must be lead or prospect.');
  const contactId = requireId(request.data?.contactId, 'contact id');

  const key = contactKey({
    contactType,
    leadId: contactType === 'lead' ? contactId : '',
    prospectId: contactType === 'prospect' ? contactId : ''
  });

  if (request.data?.refresh !== true) {
    const cached = await loadResearch(db, key);
    if (cached) return { key, research: cached, cached: true };
  }

  const contact = await loadContactForTarget(db, {
    contactType,
    leadId: contactType === 'lead' ? contactId : '',
    prospectId: contactType === 'prospect' ? contactId : ''
  });
  if (!contact) throw new HttpsError('not-found', 'That contact no longer exists.');

  const research = await researchContact(db, { contactType, contact });
  await saveResearch(db, key, research);
  return { key, research, cached: false };
});

export const approveLeadResearch = onCall(callOptions, async request => {
  const { db, email } = await requireAdmin(request);
  const key = str(request.data?.key, 200);
  if (!/^(?:lead|prospect)_[A-Za-z0-9_-]+$/.test(key)) throw new HttpsError('invalid-argument', 'A valid research key is required.');
  try {
    await approveResearch(db, key, { approvedBy: email, edits: request.data?.edits || null });
    const releasedTargets = await releaseTargetsForApprovedResearch(db, key);
    return { ok: true, releasedTargets };
  } catch (error) {
    throw new HttpsError('not-found', clean(error?.message, 300));
  }
});

export const prepareTargetForDialing = onCall({ ...callOptions, timeoutSeconds: 120 }, async request => {
  const { db } = await requireAdmin(request);
  const targetId = requireId(request.data?.targetId, 'target id');
  const snapshot = await db.doc(`outboundTargets/${targetId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Target not found.');
  const target = { id: targetId, ...snapshot.data() };
  const campaignSnapshot = await db.doc(`outboundCampaigns/${target.campaignId}`).get();
  const campaign = { id: target.campaignId, ...(campaignSnapshot.data() || {}) };
  const result = await ensureResearch(db, target, campaign);
  await refreshCampaignCounts(db, target.campaignId);
  return { ok: result.ok, reason: result.reason || '', research: result.research || null };
});

export const prepareCampaignResearch = onCall({ ...callOptions, timeoutSeconds: 540 }, async request => {
  const { db } = await requireAdmin(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  return prepareCampaignResearchBatch(db, campaignId, { limit: 12, concurrency: 4 })
    .catch(error => { throw new HttpsError('internal', clean(error?.message, 300)); });
});

export const approveCampaignResearch = onCall({ ...callOptions, timeoutSeconds: 120 }, async request => {
  const { db, email } = await requireAdmin(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  return approveCampaignResearchBatch(db, campaignId, { approvedBy: email, limit: 200 })
    .catch(error => { throw new HttpsError('internal', clean(error?.message, 300)); });
});

// ------------------------------------------------------------------ dialing

export const startPowerDialerSession = onCall({ ...callOptions, secrets: OUTBOUND_SECRETS }, async request => {
  const { db, uid } = await requireAdmin(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  const { sessionId } = await startDialerSession(db, { campaignId, userUid: uid, mode: 'power' })
    .catch(error => { throw new HttpsError('failed-precondition', clean(error?.message, 300)); });
  return { sessionId };
});

export const startParallelDialerSession = onCall({ ...callOptions, secrets: OUTBOUND_SECRETS }, async request => {
  const { db, uid } = await requireAdmin(request);
  const campaignId = requireId(request.data?.campaignId, 'campaign id');
  const concurrency = Math.max(1, Math.min(5, Number(request.data?.concurrency) || 1));
  const { sessionId } = await startDialerSession(db, { campaignId, userUid: uid, mode: 'parallel', concurrency })
    .catch(error => { throw new HttpsError('failed-precondition', clean(error?.message, 300)); });
  return { sessionId, concurrency };
});

export const dialNextTargets = onCall({ ...callOptions, timeoutSeconds: 180, secrets: OUTBOUND_SECRETS }, async request => {
  const { db, uid } = await requireAdmin(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');

  const snapshot = await db.doc(`dialerSessions/${sessionId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Session not found.');
  // A session belongs to the person who started it. Anything else lets one
  // admin drive another admin's softphone.
  if (snapshot.get('userUid') !== uid) throw new HttpsError('permission-denied', 'That session belongs to another user.');

  const campaignSnapshot = await db.doc(`outboundCampaigns/${snapshot.get('campaignId')}`).get();
  const providerId = campaignSnapshot.get('provider') || 'mock';

  return dialNext(db, sessionId, { providerConfig: providerConfigFor(providerId) })
    .catch(error => { throw new HttpsError('internal', clean(error?.message, 300)); });
});

export const heartbeatDialerSession = onCall(callOptions, async request => {
  const { db } = await requireAdmin(request);
  return heartbeatSession(db, requireId(request.data?.sessionId, 'session id'));
});

export const stopDialerSessionCall = onCall({ ...callOptions, secrets: OUTBOUND_SECRETS }, async request => {
  const { db } = await requireAdmin(request);
  const sessionId = requireId(request.data?.sessionId, 'session id');
  const snapshot = await db.doc(`dialerSessions/${sessionId}`).get();
  const providerId = snapshot.get('provider') || 'mock';
  return stopDialerSession(db, sessionId, { reason: str(request.data?.reason, 60) || 'ended', providerConfig: providerConfigFor(providerId) });
});

export const submitCallDisposition = onCall({ ...callOptions, secrets: OUTBOUND_SECRETS }, async request => {
  const { db, email } = await requireAdmin(request);
  const targetId = requireId(request.data?.targetId, 'target id');
  const disposition = str(request.data?.disposition, 40);
  const partnerOutcomes = sanitizePartnerOutcomes(request.data?.partnerOutcomes);

  const targetSnapshot = await db.doc(`outboundTargets/${targetId}`).get();
  if (!targetSnapshot.exists) throw new HttpsError('not-found', 'Target not found.');
  const campaignSnapshot = await db.doc(`outboundCampaigns/${targetSnapshot.get('campaignId')}`).get();
  const campaign = campaignSnapshot.exists ? { id: campaignSnapshot.id, ...campaignSnapshot.data() } : null;

  const result = await applyDisposition(db, {
    targetId,
    callId: str(request.data?.callId, 200) || targetSnapshot.get('lastCallId') || '',
    disposition,
    notes: str(request.data?.notes, 2000),
    partnerOutcomes,
    campaign,
    actor: email
  });

  // The call document gets the human's verdict too, so History shows what the
  // rep decided rather than only what the carrier reported.
  const callId = str(request.data?.callId, 200) || targetSnapshot.get('lastCallId') || '';
  if (callId) {
    await db.doc(`calls/${callId}`).set({
      disposition,
      summary: str(request.data?.notes, 2000),
      partnerOutcomes,
      dispositionBy: email,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  return result;
});

export const moveTargetToCallLater = onCall(callOptions, async request => {
  const { db } = await requireOutboundStaff(request);
  const targetId = requireId(request.data?.targetId, 'target id');
  const snapshot = await db.doc(`outboundTargets/${targetId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Target not found.');
  const campaignSnapshot = await db.doc(`outboundCampaigns/${snapshot.get('campaignId')}`).get();
  return moveToCallLater(db, targetId, {
    minutes: Number(request.data?.minutes) || 1440,
    reason: str(request.data?.reason, 60) || 'requested',
    campaign: campaignSnapshot.exists ? campaignSnapshot.data() : null
  });
});

export const markTargetDoNotCall = onCall(callOptions, async request => {
  const { db, email } = await requireOutboundStaff(request);
  return markDoNotCall(db, requireId(request.data?.targetId, 'target id'), { actor: email });
});

// ----------------------------------------------------------------- webhooks

/**
 * One endpoint for every calling provider's events.
 *
 * The provider is named in the path (`?provider=twilio`) so each adapter can do
 * its own verification — a real signature for Twilio, a shared header for Kixie
 * and GoHighLevel — rather than a lowest-common-denominator check that would
 * make the strongest provider as weak as the weakest.
 */
export const recordOutboundCallEvent = onRequest({ secrets: OUTBOUND_SECRETS, maxInstances: 10 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const providerId = clean(req.query?.provider || req.body?.provider, 40) || 'mock';
  let provider;
  try {
    provider = getCallingProvider(providerId, providerConfigFor(providerId, { requestUrl: `https://${req.get('host') || 'localhost'}` }));
  } catch {
    res.status(400).json({ error: 'unknown-provider' });
    return;
  }

  const secret = providerId === 'kixie'
    ? clean(secretValue(KIXIE_WEBHOOK_SECRET), 200)
    : providerId === 'twilio'
      ? clean(secretValue(TWILIO_AUTH_TOKEN), 200)
      : clean(secretValue(OUTBOUND_WEBHOOK_SECRET), 200);

  // Fail closed. A placeholder secret must never be a working credential on an
  // endpoint that moves targets and writes call history.
  if (!secret || secret.length < 16 || secret === 'unset') {
    console.error(`[outbound] webhook secret for ${providerId} is not set — refusing the request`);
    res.status(503).json({ error: 'not-configured' });
    return;
  }

  let authorised = false;
  try { authorised = provider.verifyWebhook(req, secret); } catch { authorised = false; }
  if (!authorised) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  let event;
  try {
    event = provider.normalizeWebhookEvent(req.body, {
      targetId: clean(req.query?.targetId, 200),
      campaignId: clean(req.query?.campaignId, 200),
      sessionId: clean(req.query?.sessionId, 200)
    });
  } catch (error) {
    console.error('[outbound] could not normalise a webhook payload', clean(error?.message, 200));
    // 200, not 500: a payload we cannot parse will not parse on redelivery
    // either, and asking the provider to retry it forever helps nobody.
    res.status(200).json({ ok: true, ignored: 'unparseable' });
    return;
  }
  if (!event) { res.status(200).json({ ok: true, ignored: 'not-an-outbound-event' }); return; }

  try {
    const db = getFirestore();
    const result = await recordCallEvent(db, event, {
      eventDocId: `${providerId}_${event.providerCallId || event.targetId}_${event.type}_${Math.floor(event.at.getTime() / 1000)}`,
      providerConfig: providerConfigFor(providerId)
    });
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    // A genuine server-side failure IS worth retrying, so this one is a 500.
    console.error('[outbound] failed to apply a call event', clean(error?.message, 300));
    res.status(500).json({ error: 'apply-failed' });
  }
});

// ---------------------------------------------------------------- schedules

/** Retries, stale locks, abandoned sessions, expired raw payloads. */
export const reconcileOutbound = onSchedule(
  { schedule: 'every 5 minutes', timeoutSeconds: 300, secrets: OUTBOUND_SECRETS },
  async () => {
    const db = getFirestore();
    const sessions = await reconcileSessions(db);
    const released = await releaseDueTargets(db);
    const jobs = await recoverStaleJobs(db);
    console.log(`[outbound] reconcile: ${JSON.stringify({ ...sessions, released, recoveredJobs: jobs })}`);
  }
);

/** Drive AI campaigns forward, one bounded slice at a time. */
export const runAICampaigns = onSchedule(
  { schedule: 'every 5 minutes', timeoutSeconds: 540, secrets: OUTBOUND_SECRETS },
  async () => {
    const db = getFirestore();
    const running = await db.collection('outboundCampaigns')
      .where('status', '==', 'running')
      .where('mode', '==', 'ai')
      .limit(5).get();

    for (const entry of running.docs) {
      try {
        const result = await runAICampaignSlice(db, entry.id, {
          limit: 5,
          providerConfig: providerConfigFor(entry.get('provider') || 'mock')
        });
        console.log(`[outbound] ai campaign ${entry.id}: started ${result.started.length}, rejected ${result.rejected.length}`);
      } catch (error) {
        console.error(`[outbound] ai campaign ${entry.id} failed`, clean(error?.message, 300));
        await db.doc(`outboundCampaigns/${entry.id}`).set({
          lastError: clean(error?.message, 300),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }
  }
);

/** Nightly: prune expired raw scrape payloads and refresh campaign counters. */
export const outboundNightlyMaintenance = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'America/New_York', timeoutSeconds: 540 },
  async () => {
    const db = getFirestore();
    let pruned = 0;
    // Bounded loop: a nightly job that deletes until it is done can run for
    // hours after a large scrape and collide with the next night's run.
    for (let pass = 0; pass < 10; pass += 1) {
      const removed = await pruneRawResults(db);
      pruned += removed;
      if (!removed) break;
    }

    const campaigns = await db.collection('outboundCampaigns')
      .where('status', 'in', ['running', 'paused', 'ready']).limit(50).get();
    for (const entry of campaigns.docs) await refreshCampaignCounts(db, entry.id);

    console.log(`[outbound] nightly: pruned ${pruned} raw results, recounted ${campaigns.size} campaigns`);
  }
);
