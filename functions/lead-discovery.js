// Server-controlled lead discovery.
//
// React never scrapes. The dashboard creates a `scrapeJobs/{jobId}` document
// and this module runs it — either inside a Cloud Function (for API-shaped
// sources like Places and the mock) or, for anything that needs a real browser,
// by handing the job to an authenticated local worker.
//
// Why a local worker at all: a headless Chromium needs ~1GB and minutes of
// runtime, will meet CAPTCHAs and anti-bot interstitials, and depends on cookie
// state — none of which belongs in a callable function with a 9-minute ceiling
// and no display. §13 lists the options; the local-worker protocol below is the
// one that needs no new infrastructure. The worker never gets Firestore write
// access: it claims a job, heartbeats, and submits normalised batches through
// `submitDiscoveryResults`, which re-validates everything with the Admin SDK.
//
// Stale claims expire. A worker that dies mid-job must not park its job forever.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getLeadSource, validateCriteria } from './providers/lead-sources/index.js';
import { importProspects } from './prospect-import.js';
import { clean, normalizeList } from './prospect-normalization.js';
import { requireAccountId } from './accounts.js';

export const JOB_STATUSES = [
  'draft', 'queued', 'running', 'paused', 'awaiting_local_worker',
  'processing', 'completed', 'failed', 'cancelled'
];

// A worker that has not checked in for this long has lost the job.
export const WORKER_HEARTBEAT_TTL_MS = 3 * 60 * 1000;

// Raw provider payloads are a retention problem, not an asset: they are the
// only place personal data sits un-normalised, and Firestore charges to store
// them forever. Seven days is enough to debug a bad import.
export const RAW_RESULT_TTL_DAYS = 7;

export const emptyProgress = () => ({
  discovered: 0, processed: 0, valid: 0, duplicates: 0, rejected: 0, imported: 0
});

/** Normalise and bound what the dashboard asked for. */
export function sanitizeCriteria(input = {}) {
  const criteria = {
    keywords: normalizeList(input.keywords, { maxItems: 10, maxLen: 60 }),
    category: clean(input.category, 60),
    location: clean(input.location, 160),
    radiusMiles: Math.max(0, Math.min(100, Number(input.radiusMiles) || 0)),
    maximumResults: Math.max(1, Math.min(1000, Number(input.maximumResults) || 100))
  };
  if (Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lng))) {
    criteria.lat = Number(input.lat);
    criteria.lng = Number(input.lng);
  }
  return criteria;
}

export async function createDiscoveryJob(db, {
  provider, criteria, accountId, createdBy, executionMode = '', sourceOptions = {}
}) {
  const account = requireAccountId(accountId, { field: 'accountId' });
  const clean_ = sanitizeCriteria(criteria);
  const validity = validateCriteria(clean_);
  if (!validity.valid) throw new Error(validity.errors.join(' '));

  // Configuration is injected by the callable from Secret Manager. Keeping it
  // out of the job document means provider credentials never reach Firestore or
  // the browser, while still letting validateConfig fail before a queued job
  // burns a function invocation.
  const source = getLeadSource(provider, sourceOptions);
  const config = await source.validateConfig(clean_);
  if (!config.valid) throw new Error(config.errors.join(' '));

  const mode = executionMode || source.constructor.executionMode;
  const ref = db.collection('scrapeJobs').doc();
  await ref.set({
    provider: source.constructor.id,
    accountId: account,
    status: mode === 'local_runner' ? 'awaiting_local_worker' : 'queued',
    criteria: clean_,
    progress: emptyProgress(),
    execution: {
      mode: mode === 'local_runner' ? 'local_runner' : 'cloud_function',
      workerId: '',
      cursor: null,
      attempt: 0,
      lastHeartbeatAt: null
    },
    createdBy: clean(createdBy, 128),
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    error: ''
  });
  return ref.id;
}

/**
 * Run one slice of a cloud-executable job.
 *
 * Deliberately time-boxed rather than run-to-completion: a Cloud Function that
 * loops until the provider is exhausted will be killed mid-page, and the cursor
 * it never wrote is the difference between resuming and starting over. So each
 * invocation does as much as it safely can, persists the cursor, and leaves the
 * job `running` for the scheduler to pick up again.
 */
export async function runDiscoverySlice(db, jobId, { budgetMs = 240000, now = () => new Date(), sourceOptions = {} } = {}) {
  const ref = db.doc(`scrapeJobs/${jobId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('Job not found');
  const job = snapshot.data();

  if (['completed', 'failed', 'cancelled', 'paused'].includes(job.status)) {
    return { status: job.status, progress: job.progress, done: true };
  }
  if (job.execution?.mode === 'local_runner') {
    return { status: job.status, progress: job.progress, done: false, note: 'awaiting a local worker' };
  }

  const started = Date.now();
  const source = getLeadSource(job.provider, sourceOptions);
  const progress = { ...emptyProgress(), ...job.progress };
  let cursor = job.execution?.cursor || null;
  let done = false;
  let error = '';

  await ref.set({
    status: 'running',
    startedAt: job.startedAt || FieldValue.serverTimestamp(),
    execution: { ...job.execution, attempt: Number(job.execution?.attempt || 0) + 1 }
  }, { merge: true });

  try {
    // do/while, not while: a slice must always fetch at least one page. A
    // budget check at the top means a tight budget (or a slow cold start) can
    // return with `running` and no cursor, and the scheduler then re-runs a job
    // that never advances — a loop that looks busy and never finishes.
    do {
      const page = await source.discover(job.criteria, cursor);
      const records = (page.records || []).slice(0, job.criteria.maximumResults - progress.discovered);
      progress.discovered += records.length;
      cursor = page.cursor || null;

      if (records.length) {
        // Raw results are stored first, and separately from the prospects. A
        // reviewer asking "where did this fact come from" needs the provider's
        // own words, and a normalisation bug needs a payload to re-run against.
        const rawBatch = db.batch();
        for (const [index, record] of records.entries()) {
          rawBatch.set(db.collection(`scrapeJobs/${jobId}/results`).doc(), {
            raw: JSON.parse(JSON.stringify(record)),
            identity: source.sourceIdentity(record),
            index: progress.processed + index,
            capturedAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromMillis(Date.now() + RAW_RESULT_TTL_DAYS * 86400000)
          });
        }
        await rawBatch.commit();

        const normalized = records.map(record => ({
          ...source.normalize(record),
          __source: { ...source.sourceIdentity(record), searchJobId: jobId }
        }));

        const result = await importProspects(db, normalized, {
          source: { system: 'scraper', provider: job.provider, searchJobId: jobId },
          importRunId: '',
          accountId: requireAccountId(job.accountId, { field: 'job.accountId' }),
          now: now()
        });

        progress.processed += records.length;
        progress.valid += result.counts.mapped;
        progress.duplicates += result.counts.duplicates;
        progress.rejected += result.counts.invalid + result.counts.failed;
        progress.imported += result.counts.created + result.counts.updated;
      }

      await ref.set({ progress, execution: { ...job.execution, cursor } }, { merge: true });

      if (page.done || !records.length) { done = true; break; }
    } while (Date.now() - started < budgetMs && progress.discovered < job.criteria.maximumResults);
  } catch (caught) {
    error = clean(caught?.message, 400) || 'Discovery failed';
  }

  const finalStatus = error ? 'failed'
    : done || progress.discovered >= job.criteria.maximumResults ? 'completed'
      : 'running';

  await ref.set({
    status: finalStatus,
    progress,
    error,
    execution: { ...job.execution, cursor },
    ...(finalStatus === 'completed' ? { completedAt: FieldValue.serverTimestamp() } : {}),
    ...(finalStatus === 'failed' ? { failedAt: FieldValue.serverTimestamp() } : {})
  }, { merge: true });

  return { status: finalStatus, progress, done: finalStatus !== 'running', error };
}

// ------------------------------------------------------- local-worker protocol

/**
 * A worker claims the oldest job awaiting one. The claim is transactional, so
 * two workers polling the same queue cannot both take it.
 */
export async function claimJobForWorker(db, workerId, { now = new Date() } = {}) {
  const candidates = await db.collection('scrapeJobs')
    .where('status', 'in', ['awaiting_local_worker', 'processing'])
    .orderBy('createdAt', 'asc')
    .limit(10)
    .get();

  for (const entry of candidates.docs) {
    const claimed = await db.runTransaction(async transaction => {
      const fresh = await transaction.get(entry.ref);
      if (!fresh.exists) return null;
      const job = fresh.data();

      const heartbeat = job.execution?.lastHeartbeatAt?.toDate?.() || null;
      const heldByAnother = job.status === 'processing'
        && job.execution?.workerId
        && job.execution.workerId !== workerId
        && heartbeat
        && now.getTime() - heartbeat.getTime() < WORKER_HEARTBEAT_TTL_MS;
      if (heldByAnother) return null;

      transaction.update(entry.ref, {
        status: 'processing',
        startedAt: job.startedAt || Timestamp.fromDate(now),
        execution: {
          ...job.execution,
          workerId: clean(workerId, 80),
          lastHeartbeatAt: Timestamp.fromDate(now),
          attempt: Number(job.execution?.attempt || 0) + 1
        }
      });
      return {
        id: entry.id,
        provider: job.provider,
        accountId: requireAccountId(job.accountId, { field: 'job.accountId' }),
        criteria: job.criteria,
        cursor: job.execution?.cursor || null
      };
    });
    if (claimed) return claimed;
  }
  return null;
}

export async function heartbeatJob(db, jobId, workerId, { cursor, progress, now = new Date() } = {}) {
  const ref = db.doc(`scrapeJobs/${jobId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('Job not found');
  const job = snapshot.data();
  if (job.execution?.workerId !== workerId) throw new Error('This job is held by another worker');

  const update = {
    execution: { ...job.execution, lastHeartbeatAt: Timestamp.fromDate(now) }
  };
  if (cursor !== undefined) update.execution.cursor = cursor;
  if (progress) update.progress = { ...emptyProgress(), ...job.progress, ...progress };
  await ref.set(update, { merge: true });
  return { ok: true, status: job.status };
}

/**
 * A worker submits one batch of ALREADY-NORMALISED records.
 *
 * The worker's normalisation is not trusted — everything still goes through
 * `importProspects`, which re-runs `buildProspect`, dedupe and validation with
 * the Admin SDK. The worker's job is to fetch, not to decide what is stored.
 */
export async function submitDiscoveryResults(db, jobId, workerId, records, { now = new Date() } = {}) {
  const ref = db.doc(`scrapeJobs/${jobId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('Job not found');
  const job = snapshot.data();
  if (job.execution?.workerId !== workerId) throw new Error('This job is held by another worker');
  if (['cancelled', 'completed', 'failed'].includes(job.status)) throw new Error(`Job is ${job.status}`);

  const capped = Array.isArray(records) ? records.slice(0, 500) : [];
  const result = await importProspects(db, capped.map(record => ({ ...record, __source: { provider: job.provider, searchJobId: jobId } })), {
    source: { system: 'scraper', provider: job.provider, searchJobId: jobId },
    accountId: requireAccountId(job.accountId, { field: 'job.accountId' }),
    now
  });

  const progress = { ...emptyProgress(), ...job.progress };
  progress.discovered += capped.length;
  progress.processed += capped.length;
  progress.valid += result.counts.mapped;
  progress.duplicates += result.counts.duplicates;
  progress.rejected += result.counts.invalid + result.counts.failed;
  progress.imported += result.counts.created + result.counts.updated;

  await ref.set({
    progress,
    execution: { ...job.execution, lastHeartbeatAt: Timestamp.fromDate(now) }
  }, { merge: true });

  return { accepted: capped.length, counts: result.counts, progress };
}

export async function finishJob(db, jobId, workerId, { status = 'completed', error = '' } = {}) {
  const ref = db.doc(`scrapeJobs/${jobId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('Job not found');
  const job = snapshot.data();
  if (workerId && job.execution?.workerId !== workerId) throw new Error('This job is held by another worker');

  await ref.set({
    status: status === 'failed' ? 'failed' : 'completed',
    error: clean(error, 400),
    ...(status === 'failed' ? { failedAt: FieldValue.serverTimestamp() } : { completedAt: FieldValue.serverTimestamp() })
  }, { merge: true });
  return { ok: true };
}

/** Free jobs whose worker stopped checking in. Run from a scheduled function. */
export async function recoverStaleJobs(db, { now = new Date() } = {}) {
  const stale = await db.collection('scrapeJobs').where('status', '==', 'processing').limit(50).get();
  let recovered = 0;
  for (const entry of stale.docs) {
    const heartbeat = entry.get('execution')?.lastHeartbeatAt?.toDate?.() || null;
    if (heartbeat && now.getTime() - heartbeat.getTime() < WORKER_HEARTBEAT_TTL_MS) continue;
    await entry.ref.set({
      status: 'awaiting_local_worker',
      execution: { ...entry.get('execution'), workerId: '' },
      error: 'Worker stopped reporting; job returned to the queue.'
    }, { merge: true });
    recovered += 1;
  }
  return recovered;
}

/** Delete raw provider payloads past their retention window (§14). */
export async function pruneRawResults(db, { now = new Date(), limit = 400 } = {}) {
  const expired = await db.collectionGroup('results')
    .where('expiresAt', '<=', Timestamp.fromDate(now))
    .limit(limit)
    .get();
  if (expired.empty) return 0;
  const batch = db.batch();
  for (const entry of expired.docs) batch.delete(entry.ref);
  await batch.commit();
  return expired.size;
}
