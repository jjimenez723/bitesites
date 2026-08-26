#!/usr/bin/env node
// Fill `phoneIntel` on the existing prospect corpus.
//
// DRY RUN IS THE DEFAULT. Without `--execute` nothing is written to a contact
// document; the run still resolves every number, reports the line-type
// breakdown the real run will produce, and populates the shared exchange cache.
// Caching during a rehearsal is deliberate — see the note in
// `functions/phone-intelligence.js`.
//
//   node scripts/backfill-phone-intelligence.mjs --dry-run --limit 200
//   node scripts/backfill-phone-intelligence.mjs --execute --limit 1000
//   node scripts/backfill-phone-intelligence.mjs --execute            # the lot
//   node scripts/backfill-phone-intelligence.mjs --execute --resume
//   node scripts/backfill-phone-intelligence.mjs --execute --collection leads
//
// Credentials: Application Default Credentials.
//
//   gcloud auth application-default login
//
// ---------------------------------------------------------------------------
// About the upstream server, because this is the part worth reading
// ---------------------------------------------------------------------------
//
// localcallingguide.com is a non-commercial project run by an individual, and
// it says so. This script therefore paces itself (`--throttle`, default 1500ms
// between live requests), caches every answer for six months, and only ever
// makes a request for an exchange it has never seen. The 12,695-prospect corpus
// contains 5,683 distinct exchanges, so a full first run is about 5,683
// requests spread over roughly two and a half hours, and every run after that
// is nearly free.
//
// If this becomes routine, stop using the mirror: pull the authoritative NANPA
// CO Code / Thousands-Block reports and feed them through
// `ingestExchangeRecords`. One file beats thousands of requests.
//
// Interrupt it whenever you like. The cursor is written to disk after every
// batch and `--resume` continues from it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { backfillPhoneIntel, EXCHANGE_TTL_DAYS } from '../functions/phone-intelligence.js';

const PROJECT_ID = 'bitesites-org';
const STATE_PATH = '.cache/phone-intelligence-backfill.json';

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const execute = has('--execute');
const collection = valueOf('--collection', 'prospects');
const limit = Number(valueOf('--limit', '0')) || Infinity;
const throttleMs = Number(valueOf('--throttle', '1500'));
const refresh = has('--refresh');
const resume = has('--resume');
const batchSize = 200;

if (has('--help')) {
  console.log(readFileSync(new URL(import.meta.url).pathname, 'utf8').split('\n')
    .filter(line => line.startsWith('//')).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

function readState() {
  if (!resume || !existsSync(STATE_PATH)) return { cursor: '' };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { return { cursor: '' }; }
}

function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '—');

async function main() {
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();

  const state = readState();
  console.log(`Phone intelligence backfill — ${PROJECT_ID}/${collection}`);
  console.log(`  mode:     ${execute ? 'EXECUTE (writes contact documents)' : 'dry run (writes nothing to contacts)'}`);
  console.log(`  throttle: ${throttleMs}ms between live requests`);
  console.log(`  cache:    ${EXCHANGE_TTL_DAYS} days per exchange`);
  if (state.cursor) console.log(`  resuming after: ${state.cursor}`);
  console.log('');

  const totals = { scanned: 0, updated: 0, skipped: 0, fetched: 0, cached: 0, errors: 0, byLineType: {} };
  let cursor = state.cursor || '';
  const startedAt = Date.now();

  for (;;) {
    const remaining = limit === Infinity ? batchSize : Math.min(batchSize, limit - totals.updated);
    if (remaining <= 0) break;

    const stats = await backfillPhoneIntel(db, {
      collection,
      cursor,
      limit: remaining,
      pageSize: batchSize,
      throttleMs,
      refresh,
      dryRun: !execute
    });

    totals.scanned += stats.scanned;
    totals.updated += stats.updated;
    totals.skipped += stats.skipped;
    totals.fetched += stats.fetched;
    totals.cached += stats.cached;
    totals.errors += stats.errors;
    for (const [type, count] of Object.entries(stats.byLineType)) {
      totals.byLineType[type] = (totals.byLineType[type] || 0) + count;
    }

    cursor = stats.cursor;
    if (execute) writeState({ cursor, updatedAt: new Date().toISOString(), totals });

    const mins = Math.round((Date.now() - startedAt) / 60000);
    console.log(
      `  ${totals.updated} enriched (${totals.fetched} live lookups, ${totals.cached} cache hits, `
      + `${totals.skipped} already done, ${totals.errors} errors) — ${mins}m`
    );

    if (stats.done || !stats.updated) break;
  }

  const resolved = Object.entries(totals.byLineType).reduce((sum, [, n]) => sum + n, 0);
  console.log('\nLine types');
  for (const [type, count] of Object.entries(totals.byLineType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(16)} ${String(count).padStart(6)}  ${pct(count, resolved)}`);
  }
  if (totals.errors) {
    console.log(`\n${totals.errors} lookups failed and were left unknown. Re-run to retry them;`
      + ' a failure is never cached.');
  }
  if (!execute) console.log('\nDry run. Nothing was written to a contact document. Re-run with --execute.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
