// Firestore reads and callable invocations for the outbound feature.
//
// Same contract as src/admin/data.js: every collection here is admin-only in
// firestore.rules, so an unauthorised query fails with permission-denied rather
// than returning something. Reads are capped for the same reason as elsewhere —
// a prospect corpus grows without bound and a screen that silently pulls 40k
// documents is a surprise bill.
//
// Writes are conspicuously absent. Prospects, targets, sessions, campaigns and
// research are all server-owned; the browser calls a function, and the function
// holds the invariants (normalise before storing, one lock per target, one
// winner per session). A `setDoc` from here could not honour any of them.

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
    ? 'This account does not have admin access to outbound data.'
    : error?.code === 'failed-precondition'
      ? 'That query needs a Firestore index that has not been deployed yet — run npm run deploy:rules.'
      : error?.message || 'Could not load data.';

/** Generic one-shot loader, matching the shape the rest of the console uses. */
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
 * Live subscription, for the two places where polling would be wrong: a running
 * discovery job and an active dialer session. Everywhere else uses the one-shot
 * loader — a live listener on a 500-row table is a listener that re-renders on
 * every unrelated write.
 */
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

export const useCampaigns = () =>
  useOutboundQuery(() => ({
    cap: LIST_CAP,
    q: query(collection(db, 'outboundCampaigns'), orderBy('createdAt', 'desc'), limit(LIST_CAP))
  }), []);

export const useProspects = ({ status = 'all', system = 'all' } = {}) =>
  useOutboundQuery(() => {
    const clauses = [];
    // One equality filter at a time. Combining status + system would need a
    // third composite index for a filter pair nobody has asked for yet.
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
  useOutboundQuery(() => {
    if (!campaignId) return null;
    const clauses = [where('campaignId', '==', campaignId)];
    if (states?.length) clauses.push(where('state', 'in', states.slice(0, 10)));
    return {
      cap: TARGET_CAP,
      q: query(collection(db, 'outboundTargets'), ...clauses, orderBy('nextAttemptAt', 'asc'), limit(TARGET_CAP))
    };
  }, [campaignId, (states || []).join(',')]);

export const useOutboundCalls = (campaignId) =>
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

/**
 * firebase/functions is imported lazily and only once.
 *
 * Every other admin screen does the same (see `setRole` in ../data.js): pulling
 * the callable SDK into the module graph statically would drag it into the
 * admin chunk for anyone who never opens this page.
 */
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

  createDiscoveryJob: (provider, criteria) => callable('createLeadDiscoveryJob', { provider, criteria }),
  runDiscoveryJob: jobId => callable('runLeadDiscoveryJob', { jobId }),
  pauseDiscoveryJob: jobId => callable('pauseLeadDiscoveryJob', { jobId }),
  cancelDiscoveryJob: jobId => callable('cancelLeadDiscoveryJob', { jobId }),

  importCsv: (csvText, dryRun = true) => callable('importProspectCsv', { csvText, dryRun }),
  resolveDuplicate: (prospectId, action) => callable('resolveProspectDuplicate', { prospectId, action }),
  promoteProspect: (prospectId, trigger) => callable('promoteProspectToLead', { prospectId, trigger }),

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

  startPowerSession: campaignId => callable('startPowerDialerSession', { campaignId }),
  startParallelSession: (campaignId, concurrency) =>
    callable('startParallelDialerSession', { campaignId, concurrency }),
  dialNext: sessionId => callable('dialNextTargets', { sessionId }),
  heartbeat: sessionId => callable('heartbeatDialerSession', { sessionId }),
  stopSession: (sessionId, reason) => callable('stopDialerSessionCall', { sessionId, reason }),
  disposition: payload => callable('submitCallDisposition', payload),
  callLater: (targetId, minutes, reason) => callable('moveTargetToCallLater', { targetId, minutes, reason }),
  doNotCall: targetId => callable('markTargetDoNotCall', { targetId })
};

/**
 * Keep a dialer session alive while the tab is open.
 *
 * The server treats a session with no heartbeat for two minutes as abandoned
 * and releases its locks, which is what stops a closed laptop from holding a
 * queue hostage. Beating every 45 seconds leaves room for one lost request.
 */
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

/** Shared async-action state, so every button in the feature behaves the same. */
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
