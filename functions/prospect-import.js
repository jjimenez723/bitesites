// The one way a prospect enters BiteSites.
//
// Every path — a scrape job's results, a CSV upload, the Watcher migration, a
// manual add — funnels through `importProspects` here. That is the point:
// normalisation, deduplication, compliance and the `importRuns` audit trail all
// happen once, and a new source cannot skip them by writing to `prospects`
// directly (the Firestore rules deny that to every client, so the only writer
// is the Admin SDK inside this module).
//
// Migrated and scraped prospects arrive as `new` and are NOT callable. They
// become `ready` only when normalisation succeeded, dedupe found nothing
// confirmed, and the record is contactable — and even then a campaign has to
// select them explicitly (§20).

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { buildProspect, normalizeConsent, validateProspect, deterministicId, clean } from './prospect-normalization.js';
import { findDuplicates, duplicateVerdict, dedupeWithinBatch } from './prospect-deduplication.js';
import { LEGACY_ACCOUNT_ID, requireAccountId, readAccountId } from './accounts.js';
import { loadSuppressedNumbers } from './inbound-compliance.js';

const BATCH_LIMIT = 400;   // Firestore allows 500 writes; leave room for activities.

/** The counters an import run reports. One shape everywhere. */
export const emptyCounts = () => ({
  scanned: 0, mapped: 0, created: 0, updated: 0, skipped: 0,
  duplicates: 0, invalid: 0, failed: 0, airbnbExcluded: 0, suppressed: 0
});

export async function createImportRun(db, { sourceSystem, sourceProjectId = '', mode = 'dry_run', collections = [], startedBy = '' }) {
  const ref = db.collection('importRuns').doc();
  await ref.set({
    sourceSystem: clean(sourceSystem, 60),
    sourceProjectId: clean(sourceProjectId, 80),
    mode: mode === 'execute' ? 'execute' : 'dry_run',
    status: 'running',
    collections: collections.slice(0, 30),
    startedBy: clean(startedBy, 128),
    startedAt: FieldValue.serverTimestamp(),
    completedAt: null,
    counts: emptyCounts(),
    cursor: null,
    version: 1
  });
  return ref.id;
}

export async function finishImportRun(db, runId, { status = 'completed', counts, cursor = null, error = '' }) {
  await db.doc(`importRuns/${runId}`).set({
    status,
    counts,
    cursor,
    error: clean(error, 500),
    completedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

/**
 * Errors go in a subcollection, never in the run document.
 * A 40k-row migration with a 3% failure rate is 1200 errors; one document
 * cannot hold them, and the run would fail at the moment it was most useful.
 */
export async function recordImportError(db, runId, { sourceDocumentId = '', reason, detail = '' }) {
  await db.collection(`importRuns/${runId}/errors`).doc().set({
    sourceDocumentId: clean(sourceDocumentId, 200),
    reason: clean(reason, 80),
    detail: clean(detail, 500),
    at: FieldValue.serverTimestamp()
  });
}

/** Firestore-safe: strip `undefined`, which the SDK rejects outright. */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object' && !(value instanceof Date) && !value.toDate && !value._methodName) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefined(entry)])
    );
  }
  return value;
}

// Imports are source refreshes, not permission revocations. A sparse Watcher
// or Byte-Dialer re-export must not erase the seller, phone, evidence, or grant
// time captured from a signed form on an earlier import. Actual withdrawal is
// handled by the DNC/suppression path, which has its own durable audit trail.
function mergeConsentProvenance(previous = {}, incoming = {}) {
  const old = normalizeConsent(previous);
  const next = normalizeConsent({ consent: incoming });
  const incomingBundlePresent = Boolean(
    next.grantId || next.basis !== 'not_recorded' || next.sellerAccountId
    || next.phoneE164 || next.evidenceId || next.record || next.sourceUrl
    || next.formVersion || next.grantedAt
  );
  // Provenance is atomic. Mixing selected fields from two imports can create a
  // grant that no single source ever supplied. A sparse refresh preserves the
  // old bundle byte-for-byte; any substantive new bundle replaces it whole.
  return incomingBundlePresent ? next : old;
}

/**
 * Decide the destination document id.
 *
 * A source with its own stable id gets a deterministic id, which is what makes
 * re-running an import update instead of duplicating (§18). Everything else
 * falls back to the canonical dedupe key, so two CSV uploads of the same list
 * also converge rather than doubling the corpus.
 */
/**
 * The prospect's document id, scoped to its account.
 *
 * The house account keeps its historic, unprefixed ids so that every prospect
 * imported before the account boundary existed still resolves to the same
 * document — a re-import must update the record it created last time, not
 * fork a second copy of the same business.
 *
 * Every other account gets its own id space, because the same NJ property
 * manager can legitimately be a web-design prospect for BiteSites and a
 * restoration prospect for a client. Those are two relationships with separate
 * outreach, separate dispositions and separate attribution; one document
 * cannot hold both.
 */
export function prospectDocumentId(prospect, { accountId = '' } = {}) {
  const resolved = readAccountId(accountId ?? prospect?.accountId, { fallback: LEGACY_ACCOUNT_ID });
  const scope = resolved === LEGACY_ACCOUNT_ID ? [] : [resolved];
  const source = prospect.source || {};
  if (source.sourceCollection && source.sourceDocumentId) {
    return deterministicId(...scope, 'watcher', source.sourceCollection, source.sourceDocumentId);
  }
  if (source.provider && source.providerRecordId) {
    return deterministicId(...scope, source.provider, source.providerRecordId);
  }
  if (prospect.dedupe?.canonicalKey) {
    return deterministicId(...scope, 'prospect', prospect.dedupe.canonicalKey);
  }
  return '';
}

/**
 * Import a batch of raw records.
 *
 * `dryRun` is honoured all the way down — nothing is written, but every record
 * is still normalised, deduplicated against live data and counted, so a dry run
 * reports the numbers the real run will produce.
 */
export async function importProspects(db, records, {
  source = {},
  importRunId = '',
  dryRun = false,
  now = new Date(),
  classify = null,
  onSample = null,
  // Which book of business these prospects belong to. Defaults to the house
  // account so every existing caller keeps its current behaviour, and because
  // that is the safe direction for the mistake: a record that lands on
  // BiteSites by accident simply cannot enter a client campaign, whereas the
  // reverse would put a client's name on outreach they never asked for.
  accountId = LEGACY_ACCOUNT_ID
} = {}) {
  const account = requireAccountId(accountId, { field: 'accountId' });
  const counts = emptyCounts();
  const samples = [];
  const errors = [];

  // 1. Normalise everything first. Batch-level dedupe needs the whole set, and
  //    a record that fails normalisation should never reach a Firestore query.
  const built = [];
  for (const record of records) {
    counts.scanned += 1;
    try {
      if (classify) {
        const verdict = classify(record);
        if (verdict === 'airbnb_record') { counts.airbnbExcluded += 1; counts.skipped += 1; continue; }
        if (verdict === 'internal_test') { counts.skipped += 1; continue; }
        if (verdict === 'invalid_record') { counts.invalid += 1; continue; }
        record.__classification = verdict;
      }

      const prospect = buildProspect(record, { source: { ...source, ...(record.__source || {}) }, importRunId, now });
      const validity = validateProspect(prospect);
      if (!validity.valid) {
        counts.invalid += 1;
        errors.push({ sourceDocumentId: prospect.source.sourceDocumentId || prospect.source.providerRecordId, reason: 'invalid_record', detail: validity.reasons.join(',') });
        continue;
      }

      // A record that arrived already contacted keeps that history as an
      // activity rather than as a lifecycle status it did not earn here.
      prospect.__classification = record.__classification || 'cold_prospect';
      prospect.accountId = account;
      prospect.__batchId = prospectDocumentId(prospect, { accountId: account });
      built.push(prospect);
      counts.mapped += 1;
    } catch (error) {
      counts.failed += 1;
      errors.push({ sourceDocumentId: record?.id || '', reason: 'normalization_failed', detail: String(error?.message || error) });
    }
  }

  // 2. Collapse duplicates inside this batch before touching Firestore — one
  //    scrape page routinely returns the same business twice.
  const { unique, duplicates } = dedupeWithinBatch(built);
  counts.duplicates += duplicates.length;

  // 2b. Anyone who has asked us to stop is suppressed by number, so a fresh
  //     import cannot launder them back into a dialable state. This is the
  //     check that makes an opt-out permanent: without it, buying a list that
  //     happens to contain someone who opted out last quarter would create a
  //     brand new prospect document with no memory of the request, marked
  //     `ready`, and the next campaign would call them.
  const suppressedNumbers = await loadSuppressedNumbers(db, unique.map(entry => entry.phoneE164));

  // 3. Dedupe against live prospects and leads, then write.
  let batch = dryRun ? null : db.batch();
  let pending = 0;
  const written = [];

  for (const prospect of unique) {
    const docId = prospect.__batchId || prospectDocumentId(prospect, { accountId: account });
    if (!docId) { counts.invalid += 1; continue; }

    let matches = [];
    try {
      matches = await findDuplicates(db, prospect, { excludeId: docId, accountId: account });
    } catch (error) {
      counts.failed += 1;
      errors.push({ sourceDocumentId: docId, reason: 'dedupe_failed', detail: String(error?.message || error) });
      continue;
    }

    const verdict = duplicateVerdict(matches);
    // A confirmed match against a DIFFERENT document is a duplicate we do not
    // create. A match against this same id is just the previous import of this
    // record, which is exactly what we want to update.
    const blocking = matches.find(match => match.status === 'confirmed' && !(match.type === 'prospect' && match.id === docId));
    if (blocking) {
      counts.duplicates += 1;
      if (samples.length < 20) samples.push({ id: docId, name: prospect.name, duplicateOf: blocking, action: 'skipped_duplicate' });
      continue;
    }

    prospect.duplicate = verdict;
    // Anything with a possible match, or with nothing dialable, stops in Import
    // Review. `ready` is the only state a campaign can recruit from.
    prospect.lifecycle.status = verdict.status === 'possible' ? 'needs_review'
      : prospect.contactability.complianceStatus === 'blocked' ? 'needs_review'
        : 'ready';

    if (prospect.__classification === 'existing_customer' || prospect.__classification === 'qualified_opportunity') {
      prospect.lifecycle.status = 'needs_review';
    }

    // Suppression outranks every status decided above, including the ones that
    // route a record to a human. Import Review is where an operator can release
    // a record for dialling, and a number on the suppression list is not theirs
    // to release — reversing an opt-out is a deliberate act, not a side effect
    // of someone clearing a review queue.
    if (prospect.phoneE164 && suppressedNumbers.has(prospect.phoneE164)) {
      counts.suppressed += 1;
      prospect.contactability = { ...prospect.contactability, doNotCall: true, complianceStatus: 'blocked' };
      prospect.lifecycle.status = 'do_not_contact';
    }

    delete prospect.__batchId;
    const classification = prospect.__classification;
    delete prospect.__classification;

    const existing = dryRun ? null : await db.doc(`prospects/${docId}`).get();
    const isUpdate = Boolean(existing?.exists);

    if (samples.length < 20) {
      samples.push({ id: docId, name: prospect.name, phoneE164: prospect.phoneE164, action: isUpdate ? 'update' : 'create', duplicate: verdict.status });
    }
    if (onSample) onSample({ id: docId, prospect, action: isUpdate ? 'update' : 'create' });

    if (dryRun) { counts.created += 1; continue; }

    const ref = db.doc(`prospects/${docId}`);
    if (isUpdate) {
      // Never rewrite what a human has since decided. `createdAt`, the team's
      // lifecycle edits and any conversion link survive a re-import; only the
      // source-derived facts refresh.
      const previous = existing.data();
      const merged = stripUndefined({
        ...prospect,
        // Preserve consent evidence and provider identity when a source update
        // contains less provenance than an earlier intake record.
        consent: mergeConsentProvenance(previous, prospect.consent),
        providerContactId: prospect.providerContactId || clean(previous.providerContactId, 200),
        createdAt: previous.createdAt || Timestamp.fromDate(now),
        // A re-import refreshes source-derived facts; it must never move a
        // prospect between books. Ids are account-scoped so this should be
        // unreachable — which is exactly why it is cheap to make certain of.
        accountId: readAccountId(previous.accountId, { fallback: LEGACY_ACCOUNT_ID }),
        lifecycle: {
          ...prospect.lifecycle,
          ...previous.lifecycle,
          // …except a prospect that was blocked for lacking a phone should
          // become workable again once the source supplies one.
          status: previous.lifecycle?.status === 'new' ? prospect.lifecycle.status : previous.lifecycle?.status
        },
        duplicate: previous.duplicate?.reviewedBy ? previous.duplicate : prospect.duplicate,
        updatedAt: Timestamp.fromDate(now)
      });
      batch.set(ref, merged, { merge: true });
      counts.updated += 1;
    } else {
      batch.set(ref, stripUndefined(prospect));
      counts.created += 1;
    }

    batch.set(db.collection(`prospects/${docId}/activities`).doc(), {
      type: isUpdate ? 'imported' : 'discovered',
      classification: classification || 'cold_prospect',
      source: prospect.source.system,
      provider: prospect.source.provider,
      importRunId,
      at: Timestamp.fromDate(now)
    });

    written.push(docId);
    pending += 2;
    if (pending >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); pending = 0; }
  }

  if (!dryRun && pending) await batch.commit();

  if (importRunId && errors.length) {
    for (const error of errors.slice(0, 200)) await recordImportError(db, importRunId, error);
  }

  return { counts, samples, written, errors };
}

// ------------------------------------------------------------- import review

/** Resolve a possible duplicate: keep it, or fold it into the record it matched. */
export async function resolveDuplicate(db, prospectId, { action, reviewedBy, now = new Date() }) {
  const ref = db.doc(`prospects/${prospectId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('Prospect not found');
  const prospect = snapshot.data();

  const stamp = Timestamp.fromDate(now);
  if (action === 'keep') {
    await ref.set({
      duplicate: { ...prospect.duplicate, status: 'unique', reviewedBy: clean(reviewedBy, 128), reviewedAt: stamp },
      lifecycle: { ...prospect.lifecycle, status: prospect.contactability?.validPhone ? 'ready' : 'needs_review' },
      updatedAt: stamp
    }, { merge: true });
  } else if (action === 'merge') {
    await ref.set({
      duplicate: { ...prospect.duplicate, status: 'confirmed', reviewedBy: clean(reviewedBy, 128), reviewedAt: stamp },
      lifecycle: { ...prospect.lifecycle, status: 'archived' },
      updatedAt: stamp
    }, { merge: true });
  } else {
    throw new Error(`Unknown resolution: ${action}`);
  }

  await db.collection(`prospects/${prospectId}/activities`).doc().set({
    type: 'duplicate_resolved', action, reviewedBy: clean(reviewedBy, 128), at: stamp
  });
  return { ok: true };
}
