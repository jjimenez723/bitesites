// Firestore reads and callable invocations for the outbound feature.
//
// All writes flow through Cloud Functions. Hybrid Dialer V2 adds live call and
// transcript subscriptions plus the rep/session/agent-profile callables needed
// for AI overflow, listen-only monitoring, and smooth takeover.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc, onSnapshot
} from 'firebase/firestore';
import { app, db } from '../../lib/firebase';

export const PROSPECT_CAP = 500;
export const TARGET_CAP = 500;
export const LIST_CAP = 200;

export { toDate } from '../data';

const rows = snapshot => snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));

const friendlyError = error =>
  error?.code === 'permission-denied'
    ? 'This account does not have access to outbound data.'
    : error?.code === 'failed-precondition'
      ? 'That query needs a Firestore index that has not been deployed yet — run npm run deploy:rules.'
      : error?.message || 'Could not load data.';

export function useOutboundQuery(build, deps = []) {
  const [state, setState] = useState({ rows: [], loading: true, error: null, capped: false });

  const run = useCallback(async () => {
    setState(current => ({ ...current, loading: true, error: null }));
    try {
      const built = build();
      if (!built) { setState({ rows: [], loading: false, error: null, capped: false }); return; }
      const snapshot = await getDocs(built.q);
      const list = rows(snapshot);
      setState({ rows: list, loading: false, error: null, capped: built.cap ? list.length >= built.cap : false });
    } catch (error) {
      console.error('[outbound] query failed', error);
      setState({ rows: [], loading: false, capped: false, error: friendlyError(error) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { run(); }, [run]);
  return { ...state, refresh: run };
}

/**
 * A query that stays subscribed after its first result. Operational dialer
 * data uses this hook so provider webhooks and another admin tab are reflected
 * without a manual Refresh click.
 */
export function useLiveOutboundQuery(build, deps = []) {
  const [state, setState] = useState({ rows: [], loading: true, error: null, capped: false });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let built;
    try {
      built = build();
    } catch (error) {
      setState({ rows: [], loading: false, capped: false, error: friendlyError(error) });
      return undefined;
    }
    if (!built) {
      setState({ rows: [], loading: false, error: null, capped: false });
      return undefined;
    }

    setState(current => ({ ...current, loading: true, error: null }));
    return onSnapshot(
      built.q,
      snapshot => {
        const list = rows(snapshot);
        setState({ rows: list, loading: false, error: null, capped: built.cap ? list.length >= built.cap : false });
      },
      error => {
        console.error('[outbound] live query failed', error);
        setState({ rows: [], loading: false, capped: false, error: friendlyError(error) });
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision]);

  return { ...state, refresh };
}

export function useLiveDoc(path) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!path) { setState({ data: null, loading: false, error: null }); return undefined; }
    const unsubscribe = onSnapshot(
      doc(db, path),
      snapshot => setState({ data: snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null, loading: false, error: null }),
      error => setState({ data: null, loading: false, error: friendlyError(error) })
    );
    return unsubscribe;
  }, [path]);
  return state;
}

/**
 * Subscribe to the bounded set of active call documents in a dialer session.
 * Firestore does not support an ergonomic live `documentId in [...]` query for
 * a changing client-side array without extra indexes, so each known call gets
 * its own tiny listener and the results are recombined in session order.
 */
export function useLiveCalls(callIds = []) {
  const key = (callIds || []).join('|');
  const [state, setState] = useState({ rows: [], loading: Boolean(callIds?.length), error: null });
  useEffect(() => {
    const ids = (callIds || []).filter(Boolean).slice(-20);
    if (!ids.length) { setState({ rows: [], loading: false, error: null }); return undefined; }
    const values = new Map();
    const initialized = new Set();
    setState({ rows: [], loading: true, error: null });
    const unsubscribers = ids.map(callId => onSnapshot(
      doc(db, 'calls', callId),
      snapshot => {
        values.set(callId, snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
        initialized.add(callId);
        setState({ rows: ids.map(id => values.get(id)).filter(Boolean), loading: initialized.size < ids.length, error: null });
      },
      error => setState(current => ({ ...current, loading: false, error: friendlyError(error) }))
    ));
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Live, speaker-labelled transcript for one active call. */
export function useCallTurns(callId) {
  const [state, setState] = useState({ rows: [], loading: Boolean(callId), error: null });
  useEffect(() => {
    if (!callId) { setState({ rows: [], loading: false, error: null }); return undefined; }
    const q = query(
      collection(db, 'calls', callId, 'turns'),
      orderBy('sequence', 'asc'),
      limit(250)
    );
    return onSnapshot(
      q,
      snapshot => setState({ rows: rows(snapshot), loading: false, error: null }),
      error => setState({ rows: [], loading: false, error: friendlyError(error) })
    );
  }, [callId]);
  return state;
}

/** Live warm-transfer requests addressed to the signed-in teammate. */
export const useIncomingHybridTransfers = uid =>
  useLiveOutboundQuery(() => {
    if (!uid) return null;
    return {
      cap: 20,
      q: query(
        collection(db, 'calls'),
        where('direction', '==', 'outbound'),
        where('staffTransfer.toUid', '==', uid),
        limit(20)
      )
    };
  }, [uid]);

/** Manager view of currently connected outbound calls for private coaching. */
export const useTeamLiveCalls = () =>
  useLiveOutboundQuery(() => ({
    cap: 100,
    q: query(
      collection(db, 'calls'),
      where('direction', '==', 'outbound'),
      where('status', '==', 'connected'),
      limit(100)
    )
  }), []);

export const useCampaigns = () =>
  useLiveOutboundQuery(() => ({
    cap: LIST_CAP,
    q: query(collection(db, 'outboundCampaigns'), orderBy('createdAt', 'desc'), limit(LIST_CAP))
  }), []);

export const useProspects = ({ status = 'all', system = 'all' } = {}) =>
  useOutboundQuery(() => {
    const clauses = [];
    if (status !== 'all') clauses.push(where('lifecycle.status', '==', status));
    else if (system !== 'all') clauses.push(where('source.system', '==', system));
    return {
      cap: PROSPECT_CAP,
      q: query(collection(db, 'prospects'), ...clauses, orderBy('createdAt', 'desc'), limit(PROSPECT_CAP))
    };
  }, [status, system]);

export const useReviewQueue = () =>
  useOutboundQuery(() => ({
    cap: PROSPECT_CAP,
    q: query(
      collection(db, 'prospects'),
      where('duplicate.status', '==', 'possible'),
      orderBy('createdAt', 'desc'),
      limit(PROSPECT_CAP)
    )
  }), []);

export const useNeedsReview = () =>
  useOutboundQuery(() => ({
    cap: PROSPECT_CAP,
    q: query(
      collection(db, 'prospects'),
      where('lifecycle.status', '==', 'needs_review'),
      orderBy('createdAt', 'desc'),
      limit(PROSPECT_CAP)
    )
  }), []);

export const useScrapeJobs = () =>
  useOutboundQuery(() => ({
    cap: LIST_CAP,
    q: query(collection(db, 'scrapeJobs'), orderBy('createdAt', 'desc'), limit(LIST_CAP))
  }), []);

export const useTargets = (campaignId, { states = null } = {}) =>
  useLiveOutboundQuery(() => {
    if (!campaignId) return null;
    const clauses = [where('campaignId', '==', campaignId)];
    if (states?.length) clauses.push(where('state', 'in', states.slice(0, 10)));
    return {
      cap: TARGET_CAP,
      q: query(collection(db, 'outboundTargets'), ...clauses, orderBy('nextAttemptAt', 'asc'), limit(TARGET_CAP))
    };
  }, [campaignId, (states || []).join(',')]);

export const useOutboundCalls = campaignId =>
  useOutboundQuery(() => {
    const clauses = campaignId && campaignId !== 'all'
      ? [where('campaignId', '==', campaignId)]
      : [where('direction', '==', 'outbound')];
    return {
      cap: LIST_CAP,
      q: query(collection(db, 'calls'), ...clauses, orderBy('startedAt', 'desc'), limit(LIST_CAP))
    };
  }, [campaignId]);

export const useImportRuns = () =>
  useOutboundQuery(() => ({
    cap: 100,
    q: query(collection(db, 'importRuns'), orderBy('startedAt', 'desc'), limit(100))
  }), []);

/**
 * Appointments in a window. Live, because the voice agent books into this same
 * calendar mid-call — a rep looking at today's schedule needs to see a meeting
 * appear the moment an agent closes one.
 */
export const useAppointments = ({ fromMs, toMs }) =>
  useLiveOutboundQuery(() => {
    if (!fromMs || !toMs) return null;
    return {
      cap: LIST_CAP,
      q: query(
        collection(db, 'appointments'),
        where('startAt', '>=', new Date(fromMs)),
        where('startAt', '<', new Date(toMs)),
        orderBy('startAt', 'asc'),
        limit(LIST_CAP)
      )
    };
  }, [fromMs, toMs]);

export const calendar = {
  settings: accountId => callable('getCalendarSettings', { accountId }),
  saveSettings: (accountId, settings) => callable('updateCalendarSettings', { accountId, settings }),
  availability: (accountId, options) => callable('getCalendarAvailability', { ...(options || {}), accountId }),
  book: (accountId, booking) => callable('bookAppointment', { ...booking, accountId }),
  reschedule: (accountId, appointmentId, slotId) =>
    callable('rescheduleAppointmentCall', { accountId, appointmentId, slotId }),
  cancel: (accountId, appointmentId, reason) =>
    callable('cancelAppointmentCall', { accountId, appointmentId, reason }),
  setOutcome: (accountId, appointmentId, outcome) =>
    callable('setAppointmentOutcome', { accountId, appointmentId, outcome })
};

export async function loadProspect(id) {
  const snapshot = await getDoc(doc(db, 'prospects', id));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

export async function loadProspectActivities(id) {
  const snapshot = await getDocs(query(
    collection(db, 'prospects', id, 'activities'), orderBy('at', 'desc'), limit(50)
  ));
  return rows(snapshot);
}

export async function loadResearchDoc(key) {
  const snapshot = await getDoc(doc(db, 'leadResearch', key));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

// ------------------------------------------------------------------ callables

let functionsPromise = null;

async function callable(name, payload) {
  if (!functionsPromise) {
    functionsPromise = import('firebase/functions').then(module => ({
      httpsCallable: module.httpsCallable,
      functions: module.getFunctions(app, 'us-central1')
    }));
  }
  const { httpsCallable, functions } = await functionsPromise;
  const { data } = await httpsCallable(functions, name)(payload || {});
  return data;
}

export const outbound = {
  config: () => callable('getOutboundConfig'),

  createDiscoveryJob: (provider, criteria, accountId) =>
    callable('createLeadDiscoveryJob', { provider, criteria, accountId }),
  runDiscoveryJob: jobId => callable('runLeadDiscoveryJob', { jobId }),
  pauseDiscoveryJob: jobId => callable('pauseLeadDiscoveryJob', { jobId }),
  cancelDiscoveryJob: jobId => callable('cancelLeadDiscoveryJob', { jobId }),

  importCsv: (csvText, dryRun = true, accountId = '') => callable('importProspectCsv', { csvText, dryRun, accountId }),
  resolveDuplicate: (prospectId, action) => callable('resolveProspectDuplicate', { prospectId, action }),
  promoteProspect: (prospectId, trigger, context = {}) =>
    callable('promoteProspectToLead', { prospectId, trigger, ...context }),

  createCampaign: campaign => callable('createOutboundCampaign', campaign),
  updateCampaign: (campaignId, campaign) => callable('updateOutboundCampaign', { campaignId, campaign }),
  startCampaign: campaignId => callable('startOutboundCampaign', { campaignId }),
  pauseCampaign: campaignId => callable('pauseOutboundCampaign', { campaignId }),
  resumeCampaign: campaignId => callable('resumeOutboundCampaign', { campaignId }),
  cancelCampaign: campaignId => callable('cancelOutboundCampaign', { campaignId }),
  addTargets: (campaignId, { prospectIds, leadIds, priority }) =>
    callable('importOutboundTargets', { campaignId, prospectIds, leadIds, priority }),

  research: (contactType, contactId, refresh = false) =>
    callable('researchOutboundContact', { contactType, contactId, refresh }),
  approveResearch: (key, edits) => callable('approveLeadResearch', { key, edits }),
  prepareTarget: targetId => callable('prepareTargetForDialing', { targetId }),
  prepareCampaignResearch: campaignId => callable('prepareCampaignResearch', { campaignId }),
  approveCampaignResearch: campaignId => callable('approveCampaignResearch', { campaignId }),

  // Legacy dialer actions retained for compatibility and emulator rehearsal.
  startPowerSession: campaignId => callable('startPowerDialerSession', { campaignId }),
  startParallelSession: (campaignId, concurrency) =>
    callable('startParallelDialerSession', { campaignId, concurrency }),
  dialNext: sessionId => callable('dialNextTargets', { sessionId }),
  heartbeat: sessionId => callable('heartbeatDialerSession', { sessionId }),
  stopSession: (sessionId, reason) => callable('stopDialerSessionCall', { sessionId, reason }),
  disposition: payload => callable('submitCallDisposition', payload),
  callLater: (targetId, minutes, reason) => callable('moveTargetToCallLater', { targetId, minutes, reason }),
  doNotCall: targetId => callable('markTargetDoNotCall', { targetId }),

  // Hybrid Dialer V2.
  getActiveHybridSession: () => callable('getActiveHybridDialerSession'),
  startHybridSession: (campaignId, { agentProfileId, sessionOverride = {}, autoTakeover = false, operatingMode = 'hybrid', concurrency = 3 } = {}) =>
    callable('startHybridDialerSession', { campaignId, agentProfileId, sessionOverride, autoTakeover, operatingMode, concurrency }),
  setHybridOperatingMode: (sessionId, operatingMode, agentProfileId = '') =>
    callable('setHybridOperatingMode', { sessionId, operatingMode, agentProfileId }),
  setHybridConcurrency: (sessionId, concurrency) =>
    callable('setHybridConcurrency', { sessionId, concurrency }),
  dialHybrid: sessionId => callable('dialHybridTargets', { sessionId }),
  stopHybridSession: (sessionId, reason = 'ended') => callable('stopHybridDialerSession', { sessionId, reason }),
  endHybridCall: callId => callable('endHybridCall', { callId }),
  dncHybridCall: callId => callable('markHybridCallDoNotCall', { callId }),
  hybridDisposition: payload => callable('submitHybridDisposition', payload),
  setAutoTakeover: (sessionId, enabled) => callable('setHybridAutoTakeover', { sessionId, enabled }),
  requestTakeover: callId => callable('requestHybridTakeover', { callId }),
  beginListen: callId => callable('beginHybridListen', { callId }),
  stopListen: callId => callable('stopHybridListen', { callId }),
  voiceToken: () => callable('getHybridVoiceAccessToken'),
  listTransferAgents: () => callable('listHybridTransferAgents'),
  requestStaffTransfer: (callId, toUid, note = '', handoffSummary = '') =>
    callable('requestHybridStaffTransfer', { callId, toUid, note, handoffSummary }),
  acceptStaffTransfer: callId => callable('acceptHybridStaffTransfer', { callId }),
  declineStaffTransfer: (callId, reason = '') => callable('declineHybridStaffTransfer', { callId, reason }),
  completeStaffTransfer: callId => callable('completeHybridStaffTransfer', { callId }),
  beginCoachMonitor: callId => callable('beginHybridCoachMonitor', { callId }),
  sendCoachCue: (callId, message) => callable('sendHybridCoachCue', { callId, message }),
  endCoachMonitor: callId => callable('endHybridCoachMonitor', { callId }),

  // AI agent profiles / knowledge bases.
  listAgentProfiles: () => callable('listAIAgentProfiles'),
  createAgentProfile: profile => callable('createAIAgentProfile', profile),
  updateAgentProfile: (profileId, profile) => callable('updateAIAgentProfile', { profileId, profile }),
  archiveAgentProfile: profileId => callable('archiveAIAgentProfile', { profileId }),
  previewAgentRuntime: payload => callable('previewAIAgentRuntime', payload),
  createAgentPreviewSession: (profile, mode) => callable('createAIAgentPreviewSession', { profile, mode }),
  listKnowledgeBases: () => callable('listAIKnowledgeBases'),
  createKnowledgeBase: payload => callable('createAIKnowledgeBase', payload),
  upsertKnowledgeDocument: payload => callable('upsertAIKnowledgeDocument', payload)
};

export function useSessionHeartbeat(sessionId) {
  const active = useRef(sessionId);
  active.current = sessionId;
  useEffect(() => {
    if (!sessionId) return undefined;
    const tick = () => { if (active.current === sessionId) outbound.heartbeat(sessionId).catch(() => {}); };
    const timer = setInterval(tick, 45000);
    tick();
    return () => clearInterval(timer);
  }, [sessionId]);
}

export function useAction() {
  const [state, setState] = useState({ busy: false, error: '', message: '' });
  const run = useCallback(async (fn, successMessage = '') => {
    setState({ busy: true, error: '', message: '' });
    try {
      const result = await fn();
      setState({ busy: false, error: '', message: successMessage });
      return result;
    } catch (error) {
      setState({ busy: false, error: error?.message || 'That did not work.', message: '' });
      return null;
    }
  }, []);
  return { ...state, run, clear: () => setState({ busy: false, error: '', message: '' }) };
}
