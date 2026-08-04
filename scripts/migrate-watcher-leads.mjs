#!/usr/bin/env node
// Migrate the Watcher / BiteSites-Leads corpus into BiteSites prospects.
//
//   source:      watcher-leads-89349   (read-only — this script never writes to it)
//   destination: bitesites-org         (written only with --execute)
//
// DRY RUN IS THE DEFAULT. Without an explicit `--execute` this script reads,
// transforms, deduplicates against live destination data, counts everything and
// writes nothing. That is not a courtesy: a migration you cannot rehearse is a
// migration you find out about afterwards.
//
//   node scripts/migrate-watcher-leads.mjs --inspect
//   node scripts/migrate-watcher-leads.mjs --dry-run
//   node scripts/migrate-watcher-leads.mjs --dry-run --limit 100
//   node scripts/migrate-watcher-leads.mjs --dry-run --collection smb_leads
//   node scripts/migrate-watcher-leads.mjs --execute
//   node scripts/migrate-watcher-leads.mjs --resume <runId>
//
// Credentials: Application Default Credentials for both projects, which is why
// there is no service-account JSON here and none should ever be committed.
//
//   gcloud auth application-default login
//
// If the two projects need different credentials, point them at separate key
// files with SOURCE_GOOGLE_APPLICATION_CREDENTIALS and
// DEST_GOOGLE_APPLICATION_CREDENTIALS (paths, never contents).
//
// Idempotent: destination ids are deterministic (`watcher_<collection>_<docId>`,
// hashed when that would be unsafe), so re-running updates the same documents
// rather than creating more. Resumable: the run's cursor is persisted after
// every batch, so an interrupted migration continues where it stopped.
//
// AIRBNB IS NEVER MIGRATED. `airbnb_leads` and `airbnb_contacts` are not in the
// collection map at all, and every record from every collection still passes
// through `isAirbnbRecord` — a listing that ended up in an SMB collection is
// excluded and counted, not silently imported.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { initializeApp, cert, applicationDefault } = require_('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require_('firebase-admin/firestore');

const {
  buildProspect, validateProspect, deterministicId, clean
} = await import('../functions/prospect-normalization.js');
const { findDuplicates, duplicateVerdict, dedupeWithinBatch } = await import('../functions/prospect-deduplication.js');
const {
  isAirbnbRecord, classifyWatcherRecord, WatcherWorkflowSource
} = await import('../functions/providers/lead-sources/existing-watcher-source.js');
const { BiteSitesLeadsSource } = await import('../functions/providers/lead-sources/existing-bitesites-leads-source.js');

const SOURCE_PROJECT = process.env.WATCHER_SOURCE_PROJECT || 'watcher-leads-89349';
const DEST_PROJECT = process.env.BITESITES_DEST_PROJECT || 'bitesites-org';

// ---------------------------------------------------------------------------
// Collection map.
//
// Derived from the source repositories' own schema definitions
// (executions/_firebase.py in Watcher-Workflows / BiteSites-Leads) rather than
// guessed. `--inspect` re-derives it from the live project before you trust it.
//
// DELIBERATELY ABSENT, and why:
//   airbnb_leads, airbnb_contacts  - a different ICP, staying in its own app
//   content, videos, lead_generation_log, smartlead_*  - outbound EMAIL/video
//                                    assets, not contacts; out of scope here
//   access, access_requests, spend, run_requests, video_requests - operational
//                                    records of the other application
// ---------------------------------------------------------------------------
const COLLECTION_MAP = {
  smb_leads: { destination: 'prospects', system: 'watcher_leads', grain: 'company' },
  companies: { destination: 'prospects', system: 'watcher_leads', grain: 'company' },
  smb_contacts: { destination: 'prospects', system: 'watcher_leads', grain: 'person' }
};

const EXCLUDED_COLLECTIONS = {
  airbnb_leads: 'Airbnb ICP — stays in its own application',
  airbnb_contacts: 'Airbnb ICP — stays in its own application',
  content: 'Outreach copy, not a contact record',
  videos: 'Video assets, not a contact record',
  lead_generation_log: 'Email-copy generation log',
  smartlead_events: 'Email-sequence telemetry',
  smartlead_config: 'Email-sequence configuration',
  campaign_health_snapshot: 'Email-campaign metrics',
  inbox_health_snapshot: 'Email-deliverability metrics',
  subject_variant_performance: 'Email subject-line A/B metrics',
  access: 'Access control for the other dashboard',
  access_requests: 'Access control for the other dashboard',
  spend: 'Cost accounting for the other pipeline',
  run_requests: 'Job queue for the other pipeline',
  video_requests: 'Job queue for the other pipeline',
  outreach_requests: 'HighLevel SMS/Voice-AI request log',
  kixie_sessions: 'Kixie PowerList session log',
  kixie_call_events: 'Kixie webhook events for the other dashboard'
};

const BATCH_SIZE = 200;
const WRITE_CHUNK = 400;

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const args = { mode: 'dry-run', limit: 0, collection: '', resume: '', yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--inspect') args.mode = 'inspect';
    else if (flag === '--dry-run') args.mode = 'dry-run';
    else if (flag === '--execute') args.mode = 'execute';
    else if (flag === '--limit') args.limit = Math.max(0, Number(argv[++index]) || 0);
    else if (flag === '--collection') args.collection = String(argv[++index] || '');
    else if (flag === '--resume') { args.resume = String(argv[++index] || ''); }
    else if (flag === '--yes') args.yes = true;
    else if (flag === '--help' || flag === '-h') args.mode = 'help';
    else if (flag.startsWith('--')) { console.error(`Unknown flag: ${flag}`); process.exit(2); }
  }
  return args;
}

const HELP = `
migrate-watcher-leads — ${SOURCE_PROJECT} → ${DEST_PROJECT}

  --inspect              Report the source schema and a destination collision count. Reads only.
  --dry-run              (default) Transform and deduplicate everything, write nothing.
  --execute              Actually write. Requires --yes or an interactive confirmation.
  --limit <n>            Stop after n source documents per collection.
  --collection <name>    Restrict to one source collection.
  --resume <runId>       Continue an interrupted run from its stored cursor.
  --yes                  Skip the --execute confirmation prompt (for scripted runs).

Credentials come from Application Default Credentials. Never commit a key file.
`;

// ------------------------------------------------------------------- clients

function initFirestore(name, projectId, credentialEnvVar) {
  const keyPath = process.env[credentialEnvVar];
  const credential = keyPath
    ? cert(JSON.parse(readFileSync(keyPath, 'utf8')))
    : applicationDefault();
  const app = initializeApp({ credential, projectId }, name);
  return getFirestore(app);
}

// ------------------------------------------------------------------ inspect

async function inspectSource(source, dest, args) {
  console.log(`\nSource project: ${SOURCE_PROJECT}`);
  console.log('Reading a small sample per collection. No full dataset is printed.\n');

  const collections = await source.listCollections();
  const names = collections.map(entry => entry.id).sort();

  const report = [];
  for (const name of names) {
    if (args.collection && name !== args.collection) continue;

    const excluded = EXCLUDED_COLLECTIONS[name];
    const mapping = COLLECTION_MAP[name];
    const sample = await source.collection(name).limit(5).get();

    // Firestore has no cheap exact count for a large collection; a bounded
    // probe is honest about being an estimate rather than pretending precision.
    const probe = await source.collection(name).limit(1001).get();
    const approxCount = probe.size > 1000 ? '>1000' : String(probe.size);

    const fields = new Set();
    const timestampFields = new Set();
    const piiFields = new Set();
    let airbnbHits = 0;

    for (const doc of sample.docs) {
      const data = doc.data();
      if (isAirbnbRecord(data)) airbnbHits += 1;
      for (const [key, value] of Object.entries(data)) {
        fields.add(key);
        if (value?.toDate || /(_at|_date|At|Date)$/.test(key)) timestampFields.add(key);
        if (/(email|phone|name|address|contact)/i.test(key)) piiFields.add(key);
      }
    }

    report.push({
      collection: name,
      approxCount,
      sampleFields: [...fields].sort().slice(0, 25),
      timestampFields: [...timestampFields].sort(),
      piiFields: [...piiFields].sort(),
      likelyDuplicateKeys: ['link', 'website', 'phone', 'email'].filter(key => fields.has(key)),
      airbnbRelated: Boolean(excluded?.includes('Airbnb')) || airbnbHits > 0,
      proposedDestination: mapping?.destination || '(not migrated)',
      transformationRequired: mapping ? 'normalise + dedupe + source attribution' : 'n/a',
      safeToMigrate: mapping ? 'yes, after review' : `no — ${excluded || 'not in the collection map'}`
    });
  }

  for (const row of report) {
    console.log(`── ${row.collection}`);
    console.log(`   approx documents      ${row.approxCount}`);
    console.log(`   sample fields         ${row.sampleFields.join(', ') || '(none)'}`);
    console.log(`   timestamp fields      ${row.timestampFields.join(', ') || '(none)'}`);
    console.log(`   personal-data fields  ${row.piiFields.join(', ') || '(none)'}`);
    console.log(`   likely duplicate keys ${row.likelyDuplicateKeys.join(', ') || '(none)'}`);
    console.log(`   airbnb related        ${row.airbnbRelated ? 'YES — excluded' : 'no'}`);
    console.log(`   proposed destination  ${row.proposedDestination}`);
    console.log(`   safe to migrate       ${row.safeToMigrate}\n`);
  }

  // Destination collision report: how many ids we would land on that already
  // exist. On a re-run this should equal the number previously migrated.
  let collisions = 0;
  let checked = 0;
  for (const [name, mapping] of Object.entries(COLLECTION_MAP)) {
    if (args.collection && name !== args.collection) continue;
    const sample = await source.collection(name).limit(50).get().catch(() => null);
    if (!sample) continue;
    for (const doc of sample.docs) {
      checked += 1;
      const id = destinationId(name, doc.id);
      const existing = await dest.doc(`${mapping.destination}/${id}`).get();
      if (existing.exists) collisions += 1;
    }
  }
  console.log(`Destination collisions: ${collisions} of ${checked} sampled ids already exist in ${DEST_PROJECT}.`);
  console.log(collisions ? '(Expected on a re-run — those documents would be UPDATED, not duplicated.)\n' : '');

  return report;
}

// ----------------------------------------------------------------- migration

/** Deterministic destination id — the whole idempotency guarantee (§18). */
const destinationId = (collection, sourceDocId) => deterministicId('watcher', collection, sourceDocId);

function adapterFor(collection) {
  // The BiteSites-Leads fork adds `ghl_contact_id` and consent fields to the
  // same documents; using its adapter for every collection preserves them when
  // present and changes nothing when absent.
  return new BiteSitesLeadsSource();
}

async function migrateCollection({ source, dest, collection, mapping, args, run, counters }) {
  const adapter = adapterFor(collection);
  let cursor = run.cursor?.[collection] || null;
  let processed = 0;

  for (;;) {
    let query = source.collection(collection).orderBy('__name__').limit(BATCH_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;

    const built = [];
    for (const doc of snapshot.docs) {
      counters.scanned += 1;
      processed += 1;
      const data = doc.data();

      const classification = classifyWatcherRecord(data);
      if (classification === 'airbnb_record') {
        counters.airbnbExcluded += 1;
        counters.skipped += 1;
        continue;
      }
      if (classification === 'internal_test') { counters.skipped += 1; continue; }
      if (classification === 'invalid_record') { counters.invalid += 1; continue; }

      let normalized;
      try {
        normalized = adapter.normalize({ ...data, __docId: doc.id });
      } catch (error) {
        counters.failed += 1;
        run.errors.push({ sourceDocumentId: doc.id, reason: 'normalization_failed', detail: String(error?.message || error).slice(0, 300) });
        continue;
      }

      const prospect = buildProspect(normalized, {
        source: {
          system: mapping.system,
          provider: adapter.constructor.id,
          providerRecordId: doc.id,
          sourceProjectId: SOURCE_PROJECT,
          sourceCollection: collection,
          sourceDocumentId: doc.id,
          sourceUrl: normalized.sourceUrl,
          importedAt: new Date()
        },
        importRunId: run.id
      });

      const validity = validateProspect(prospect);
      if (!validity.valid) {
        counters.invalid += 1;
        run.errors.push({ sourceDocumentId: doc.id, reason: 'invalid_record', detail: validity.reasons.join(',') });
        continue;
      }

      prospect.__classification = classification;
      prospect.__destinationId = destinationId(collection, doc.id);
      built.push(prospect);
      counters.mapped += 1;
    }

    // Same-batch duplicates first — a company and its contact row describe one
    // business, and the person-grained collection routinely repeats a company.
    const { unique, duplicates } = dedupeWithinBatch(built);
    counters.duplicates += duplicates.length;

    let batch = args.mode === 'execute' ? dest.batch() : null;
    let pending = 0;

    for (const prospect of unique) {
      const id = prospect.__destinationId;
      const classification = prospect.__classification;
      delete prospect.__destinationId;
      delete prospect.__classification;
      delete prospect.__batchId;

      const matches = await findDuplicates(dest, prospect, { excludeId: id });
      const verdict = duplicateVerdict(matches);
      const blocking = matches.find(match => match.status === 'confirmed' && !(match.type === 'prospect' && match.id === id));
      if (blocking) {
        counters.duplicates += 1;
        if (run.samples.length < 25) run.samples.push({ id, name: prospect.name, action: 'skipped_duplicate', duplicateOf: `${blocking.type}:${blocking.id}` });
        continue;
      }

      prospect.duplicate = verdict;
      // Migrated records are never immediately callable (§20). `ready` still
      // requires a campaign to select them explicitly.
      prospect.lifecycle.status =
        verdict.status === 'possible' ? 'needs_review'
          : classification === 'existing_customer' || classification === 'qualified_opportunity' ? 'needs_review'
            : prospect.contactability.complianceStatus === 'blocked' ? 'needs_review'
              : 'ready';

      const existing = await dest.doc(`prospects/${id}`).get();
      const isUpdate = existing.exists;

      if (run.samples.length < 25) {
        run.samples.push({
          id, name: prospect.name, phoneE164: prospect.phoneE164,
          status: prospect.lifecycle.status, action: isUpdate ? 'update' : 'create',
          classification
        });
      }

      if (args.mode !== 'execute') {
        counters[isUpdate ? 'updated' : 'created'] += 1;
        continue;
      }

      const payload = stripUndefined({
        ...prospect,
        createdAt: isUpdate ? (existing.get('createdAt') || Timestamp.now()) : Timestamp.now(),
        updatedAt: Timestamp.now(),
        // A human decision in the destination always wins over a re-import.
        lifecycle: isUpdate
          ? { ...prospect.lifecycle, ...(existing.get('lifecycle') || {}) }
          : prospect.lifecycle,
        duplicate: isUpdate && existing.get('duplicate')?.reviewedBy
          ? existing.get('duplicate')
          : prospect.duplicate
      });

      batch.set(dest.doc(`prospects/${id}`), payload, { merge: true });
      batch.set(dest.collection(`prospects/${id}/activities`).doc(), {
        type: isUpdate ? 'imported' : 'discovered',
        classification,
        sourceProjectId: SOURCE_PROJECT,
        sourceCollection: collection,
        importRunId: run.id,
        at: Timestamp.now()
      });

      // A previously-contacted record keeps that history rather than arriving
      // as though nobody ever spoke to it.
      if (classification === 'previously_contacted') {
        batch.set(dest.collection(`prospects/${id}/activities`).doc(), {
          type: 'imported_prior_contact',
          note: 'The source system recorded prior outreach to this business.',
          sourceProjectId: SOURCE_PROJECT,
          importRunId: run.id,
          at: Timestamp.now()
        });
        pending += 1;
      }

      counters[isUpdate ? 'updated' : 'created'] += 1;
      pending += 2;
      if (pending >= WRITE_CHUNK) { await batch.commit(); batch = dest.batch(); pending = 0; }
    }

    if (args.mode === 'execute' && pending) await batch.commit();

    cursor = snapshot.docs[snapshot.docs.length - 1];
    run.cursor[collection] = cursor.id;
    await persistRun(dest, run, counters, args);

    if (args.limit && processed >= args.limit) break;
    if (snapshot.size < BATCH_SIZE) break;
  }
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object' && !(value instanceof Date) && !value.toDate && !value._methodName) {
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, stripUndefined(v)])
    );
  }
  return value;
}

/**
 * Persist the run.
 *
 * A dry run writes nothing at all, including its own bookkeeping — otherwise
 * "the default writes no production data" would be false, just in a collection
 * nobody looks at. Dry-run cursors live only in memory, which is also why a dry
 * run is not resumable.
 */
async function persistRun(dest, run, counters, args) {
  if (args.mode !== 'execute') return;
  await dest.doc(`importRuns/${run.id}`).set({
    sourceSystem: 'watcher_leads',
    sourceProjectId: SOURCE_PROJECT,
    mode: 'execute',
    status: run.status,
    collections: run.collections,
    startedBy: run.startedBy,
    startedAt: run.startedAt,
    completedAt: run.completedAt || null,
    counts: counters,
    cursor: run.cursor,
    version: 1
  }, { merge: true });

  for (const error of run.errors.splice(0, 200)) {
    await dest.collection(`importRuns/${run.id}/errors`).doc().set({ ...error, at: FieldValue.serverTimestamp() });
  }
}

async function confirmExecute(args) {
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    console.error('\n--execute needs a confirmation. Re-run with --yes from a non-interactive shell.\n');
    return false;
  }
  process.stdout.write(`\nThis will WRITE prospects into ${DEST_PROJECT}. Type "migrate" to continue: `);
  const answer = await new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', data => resolve(String(data).trim()));
  });
  return answer === 'migrate';
}

// ---------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') { console.log(HELP); return; }

  const source = initFirestore('source', SOURCE_PROJECT, 'SOURCE_GOOGLE_APPLICATION_CREDENTIALS');
  const dest = initFirestore('destination', DEST_PROJECT, 'DEST_GOOGLE_APPLICATION_CREDENTIALS');

  if (args.mode === 'inspect') {
    await inspectSource(source, dest, args);
    return;
  }

  if (args.mode === 'execute' && !(await confirmExecute(args))) {
    console.log('Cancelled. Nothing was written.');
    process.exit(1);
  }

  const collections = Object.entries(COLLECTION_MAP)
    .filter(([name]) => !args.collection || name === args.collection);
  if (!collections.length) {
    console.error(`No mapped collection matches --collection ${args.collection}`);
    console.error(`Mapped: ${Object.keys(COLLECTION_MAP).join(', ')}`);
    process.exit(2);
  }

  const counters = {
    scanned: 0, mapped: 0, created: 0, updated: 0, skipped: 0,
    duplicates: 0, invalid: 0, failed: 0, airbnbExcluded: 0
  };

  const run = {
    id: args.resume || dest.collection('importRuns').doc().id,
    status: 'running',
    collections: collections.map(([name]) => name),
    startedBy: process.env.USER || 'cli',
    startedAt: Timestamp.now(),
    completedAt: null,
    cursor: {},
    errors: [],
    samples: []
  };

  if (args.resume) {
    const previous = await dest.doc(`importRuns/${run.id}`).get();
    if (!previous.exists) { console.error(`No import run ${run.id} to resume.`); process.exit(2); }
    run.cursor = previous.get('cursor') || {};
    Object.assign(counters, previous.get('counts') || {});
    console.log(`Resuming run ${run.id} from ${JSON.stringify(run.cursor)}`);
  }

  console.log(`\nMode: ${args.mode.toUpperCase()}${args.mode === 'dry-run' ? '  (nothing will be written)' : ''}`);
  console.log(`Run id: ${run.id}`);
  console.log(`Collections: ${run.collections.join(', ')}\n`);

  try {
    for (const [collection, mapping] of collections) {
      console.log(`→ ${collection} → ${mapping.destination}`);
      await migrateCollection({ source, dest, collection, mapping, args, run, counters });
    }
    run.status = 'completed';
  } catch (error) {
    run.status = 'failed';
    run.errors.push({ sourceDocumentId: '', reason: 'run_failed', detail: String(error?.message || error).slice(0, 400) });
    console.error(`\nRun failed: ${error?.message || error}`);
  }

  run.completedAt = Timestamp.now();
  await persistRun(dest, run, counters, args);

  console.log('\n── Counts ─────────────────────────────');
  for (const [key, value] of Object.entries(counters)) console.log(`   ${key.padEnd(16)} ${value}`);

  console.log('\n── Transformed sample (first 25) ──────');
  for (const sample of run.samples) {
    console.log(`   [${sample.action}] ${sample.id}  ${sample.name || '(no name)'}  ${sample.phoneE164 || ''}  ${sample.status || ''}`);
  }

  if (args.mode !== 'execute') {
    console.log('\nThis was a DRY RUN. No production data was written.');
    console.log('Re-run with --execute (and separate approval) to apply it.\n');
  } else {
    console.log(`\nRun ${run.id} finished with status ${run.status}.\n`);
  }

  process.exit(run.status === 'failed' ? 1 : 0);
}

// Exported for the test, which drives the pure halves without a live project.
export { parseArgs, destinationId, COLLECTION_MAP, EXCLUDED_COLLECTIONS, stripUndefined };

if (process.argv[1] && process.argv[1].endsWith('migrate-watcher-leads.mjs')) {
  main().catch(error => { console.error(error); process.exit(1); });
}
