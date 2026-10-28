#!/usr/bin/env node
// Add a versioned business taxonomy to the existing BiteSites prospects.
//
// The default is a read-only dry run. `--execute` writes only `taxonomy` and,
// where it is a recognized US state, uppercases `address.region`. The original
// region spelling stays in `taxonomy.sourceRegion`. Lifecycle, contactability,
// consent, campaigns, tags, and source category fields are not changed.
//
//   node scripts/backfill-prospect-taxonomy.mjs --project bitesites-org
//   node scripts/backfill-prospect-taxonomy.mjs --project bitesites-org --execute
//   node scripts/backfill-prospect-taxonomy.mjs --project bitesites-org --execute --limit 250

import { execFileSync } from 'node:child_process';
import { normalizeProspectTaxonomy } from '../functions/prospect-normalization.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const project = option('--project', '');
const execute = flag('--execute');
const limitArg = Number(option('--limit', '0'));
const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.trunc(limitArg) : Infinity;
const database = '(default)';

if (flag('--help')) {
  console.log('Usage: node scripts/backfill-prospect-taxonomy.mjs --project <project-id> [--execute] [--limit <n>]');
  console.log('Defaults to dry-run. Writes only taxonomy and recognized address.region values.');
  process.exit(0);
}
if (!project) throw new Error('Pass --project explicitly; no implicit Firebase project is used.');

const apiRoot = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(database)}/documents`;
const authToken = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();

function decodeValue(value = {}) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}
function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}
function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) } };
  }
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: String(value) };
}
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${authToken}`, ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Firestore API returned HTTP ${response.status}`);
  return response.json();
}
async function listProspects() {
  const documents = [];
  let pageToken = '';
  while (documents.length < limit) {
    const url = new URL(`${apiRoot}/prospects`);
    url.searchParams.set('pageSize', String(Math.min(1000, limit - documents.length)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await request(url);
    documents.push(...(page.documents || []));
    pageToken = page.nextPageToken || '';
    if (!pageToken) break;
  }
  return documents.slice(0, limit);
}
async function commit(writes) {
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await fetch(`${apiRoot}:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes })
    });
    if (response.ok) return response.json();
    if (![429, 500, 503].includes(response.status) || attempt === 8) {
      // Keep provider bodies out of logs: a rejected write response may include
      // document paths or values. updateTime preconditions prevent stale writes.
      throw new Error(`Firestore commit returned HTTP ${response.status}; no write values were logged`);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30000, retryAfter * 1000)
      : Math.min(30000, 1000 * (2 ** attempt));
    console.log(`Firestore throttled a batch; retrying in ${Math.ceil(delayMs / 1000)}s (${attempt + 1}/8)`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const docs = await listProspects();
const plans = [];
const stateCounts = new Map();
const nicheCounts = new Map();
const reviewCounts = new Map();
let missingPrimaryCategory = 0;
let stateUpdates = 0;
for (const document of docs) {
  const raw = decodeFields(document.fields || {});
  const region = typeof raw.address?.region === 'string' ? raw.address.region : '';
  const sourceRegion = typeof raw.taxonomy?.sourceRegion === 'string'
    ? raw.taxonomy.sourceRegion
    : region;
  const taxonomy = normalizeProspectTaxonomy({
    primaryCategory: raw.business?.category || '',
    categories: raw.business?.categories || [],
    region: sourceRegion
  });
  if (!raw.business?.category) missingPrimaryCategory += 1;
  if (taxonomy.stateCode) stateCounts.set(taxonomy.stateCode, (stateCounts.get(taxonomy.stateCode) || 0) + 1);
  if (taxonomy.primaryNicheId) nicheCounts.set(taxonomy.primaryNicheId, (nicheCounts.get(taxonomy.primaryNicheId) || 0) + 1);
  for (const reason of taxonomy.reviewReasons) reviewCounts.set(reason, (reviewCounts.get(reason) || 0) + 1);

  const update = { name: document.name, fields: { taxonomy: encodeValue(taxonomy) } };
  const fieldPaths = ['taxonomy'];
  if (taxonomy.stateCode && region !== taxonomy.stateCode) {
    update.fields.address = encodeValue({ region: taxonomy.stateCode });
    fieldPaths.push('address.region');
    stateUpdates += 1;
  }
  const currentTaxonomy = raw.taxonomy || null;
  const changed = stableStringify(currentTaxonomy) !== stableStringify(taxonomy)
    || fieldPaths.includes('address.region');
  if (!changed) continue;
  plans.push({
    update,
    updateMask: { fieldPaths },
    currentDocument: { updateTime: document.updateTime }
  });
}

console.log(`Prospect taxonomy backfill — ${project}/${database}/prospects`);
console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}; scanned ${docs.length}; planned ${plans.length}; valid state casing updates ${stateUpdates}`);
console.log(`Records missing a source category: ${missingPrimaryCategory}`);
console.log(`Review reasons: ${JSON.stringify(Object.fromEntries([...reviewCounts].sort()))}`);
console.log(`State counts: ${JSON.stringify(Object.fromEntries([...stateCounts].sort()))}`);
console.log(`Top niches: ${JSON.stringify(Object.fromEntries([...nicheCounts].sort((a, b) => b[1] - a[1]).slice(0, 20)))}`);
if (!execute) {
  console.log('Dry run only; no Firestore documents were changed.');
  process.exit(0);
}

let committed = 0;
for (let offset = 0; offset < plans.length; offset += 100) {
  const batch = plans.slice(offset, offset + 100);
  await commit(batch);
  committed += batch.length;
  console.log(`Committed ${committed}/${plans.length}`);
  await new Promise(resolve => setTimeout(resolve, 150));
}
console.log(`Done: ${committed} prospect documents updated.`);
