#!/usr/bin/env node
// Attach unambiguous, exact phone/email matches from the BiteSites GHL location.
//
// Dry-run is the default. `--execute` writes only the new `crmMatches` field.
// A match means a CRM contact is associated with this prospect; it does not
// verify that the person owns or works at the business, and it grants no
// contact consent. Ambiguous or unmatched CRM records are never written.
//
//   node scripts/enrich-prospects-from-ghl.mjs --project bitesites-org
//   node scripts/enrich-prospects-from-ghl.mjs --project bitesites-org --execute

import { execFileSync } from 'node:child_process';
import {
  normalizeEmail,
  normalizePhone
} from '../functions/prospect-normalization.js';
import {
  GoHighLevelContactsSource,
  normalizeGoHighLevelContact
} from '../functions/providers/lead-sources/gohighlevel-contacts.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const project = option('--project', '');
const execute = flag('--execute');
const locationId = 'LDL5wuJlnVnqk9vn6taD';
const accountId = 'bitesites';
const database = '(default)';
if (flag('--help')) {
  console.log('Usage: node scripts/enrich-prospects-from-ghl.mjs --project <project-id> [--execute]');
  console.log('Dry-run is the default. Writes only exact, unique contact associations to crmMatches.');
  process.exit(0);
}
if (!project) throw new Error('Pass --project explicitly; no implicit Firebase project is used.');

const firestoreToken = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
const ghlToken = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=GHL_CONTACTS_READ_TOKEN', `--project=${project}`], { encoding: 'utf8' }).trim();
const apiRoot = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(database)}/documents`;

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
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  return { stringValue: String(value) };
}
async function getProspects() {
  const documents = [];
  let pageToken = '';
  do {
    const url = new URL(`${apiRoot}/prospects`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${firestoreToken}` } });
    if (!response.ok) throw new Error(`Firestore read returned HTTP ${response.status}`);
    const page = await response.json();
    documents.push(...(page.documents || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return documents.map(document => ({
    id: document.name.split('/').at(-1),
    updateTime: document.updateTime,
    ...decodeFields(document.fields || {})
  }));
}
async function commit(writes) {
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await fetch(`${apiRoot}:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${firestoreToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes })
    });
    if (response.ok) return response.json();
    if (![429, 500, 503].includes(response.status) || attempt === 8) {
      const body = await response.json().catch(() => ({}));
      const detail = String(body?.error?.message || 'no provider detail')
        .replace(/projects\/[^\s,]+/g, '[document]')
        .replace(/\s+/g, ' ').slice(0, 240);
      throw new Error(`Firestore commit returned HTTP ${response.status}: ${detail}`);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30000, retryAfter * 1000)
      : Math.min(30000, 1000 * (2 ** attempt));
    console.log(`Firestore throttled a batch; retrying in ${Math.ceil(delayMs / 1000)}s (${attempt + 1}/8)`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

const source = new GoHighLevelContactsSource({
  token: ghlToken,
  locationId,
  accountId,
  locationAccountId: accountId,
  pageSize: 100,
  maxRecords: 5000
});
const [documents, crm] = await Promise.all([getProspects(), source.readAll({})]);
if (crm.truncated || (crm.total !== null && crm.records.length !== crm.total)) {
  throw new Error('The GHL read was incomplete; no Firestore changes were made.');
}

const byPhone = new Map();
const byEmail = new Map();
function add(index, key, prospectId) {
  if (!key) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(prospectId);
}
for (const prospect of documents) {
  add(byPhone, normalizePhone(prospect.phoneE164 || prospect.phone), prospect.id);
  add(byEmail, normalizeEmail(prospect.email), prospect.id);
  for (const contact of Array.isArray(prospect.contacts) ? prospect.contacts : []) {
    add(byPhone, normalizePhone(contact.phoneE164 || contact.phone), prospect.id);
    add(byEmail, normalizeEmail(contact.email), prospect.id);
  }
}

const contactsByProspect = new Map();
let matchedByPhone = 0;
let matchedByEmail = 0;
let matchedByBoth = 0;
let matchedWithName = 0;
let ambiguous = 0;
let unmatched = 0;
let recordsWithName = 0;
for (const raw of crm.records) {
  const contact = normalizeGoHighLevelContact(raw);
  if (contact.name || contact.firstName || contact.lastName) recordsWithName += 1;
  const phoneIds = contact.phoneE164 ? (byPhone.get(contact.phoneE164) || new Set()) : new Set();
  const email = normalizeEmail(contact.email);
  const emailIds = email ? (byEmail.get(email) || new Set()) : new Set();
  const prospects = new Set([...phoneIds, ...emailIds]);
  if (!prospects.size) { unmatched += 1; continue; }
  if (prospects.size !== 1 || phoneIds.size > 1 || emailIds.size > 1) { ambiguous += 1; continue; }
  const matchedOn = [];
  if (phoneIds.size === 1) matchedOn.push('phoneE164');
  if (emailIds.size === 1) matchedOn.push('email');
  if (!matchedOn.length) { unmatched += 1; continue; }
  if (phoneIds.size === 1 && emailIds.size === 1) matchedByBoth += 1;
  else if (phoneIds.size === 1) matchedByPhone += 1;
  else matchedByEmail += 1;
  const prospectId = [...prospects][0];
  if (contact.name || contact.firstName || contact.lastName) matchedWithName += 1;
  const entry = {
    provider: 'gohighlevel',
    locationId,
    providerContactId: contact.providerContactId,
    name: contact.name,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: normalizeEmail(contact.email),
    phoneE164: contact.phoneE164,
    role: 'unknown',
    relationshipToBusiness: 'unknown',
    ownerVerified: false,
    matchMethod: matchedOn.length === 2 ? 'exact_phone_and_email' : `exact_${matchedOn[0]}`,
    sourceUpdatedAt: contact.updatedAt ? new Date(contact.updatedAt).toISOString() : ''
  };
  if (!contactsByProspect.has(prospectId)) contactsByProspect.set(prospectId, []);
  contactsByProspect.get(prospectId).push(entry);
}

const writes = [];
let existing = 0;
for (const prospect of documents) {
  const entries = contactsByProspect.get(prospect.id) || [];
  if (!entries.length) continue;
  const prior = Array.isArray(prospect.crmMatches) ? prospect.crmMatches : [];
  const knownIds = new Set(prior.map(entry => entry?.providerContactId).filter(Boolean));
  const additions = entries.filter(entry => !knownIds.has(entry.providerContactId));
  if (!additions.length) { existing += entries.length; continue; }
  writes.push({
    update: {
      name: `projects/${project}/databases/${database}/documents/prospects/${encodeURIComponent(prospect.id)}`,
      fields: { crmMatches: encodeValue([...prior, ...additions]) }
    },
    updateMask: { fieldPaths: ['crmMatches'] },
    currentDocument: { updateTime: prospect.updateTime }
  });
}
const uniqueProspectsMatched = contactsByProspect.size;
const crmRecordsMatched = matchedByPhone + matchedByEmail + matchedByBoth;
const maxContactsOnOneProspect = Math.max(0, ...[...contactsByProspect.values()].map(entries => entries.length));
console.log(`GHL contact enrichment — ${project}/${database}/prospects`);
console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}; GHL ${crm.records.length}/${crm.total} contacts in ${crm.pages} pages; prospects ${documents.length}`);
console.log(JSON.stringify({
  contactsWithNames: recordsWithName,
  exactUniqueMatches: crmRecordsMatched,
  exactMatchesWithNames: matchedWithName,
  matchedByPhone,
  matchedByEmail,
  matchedByBoth,
  prospectDocumentsMatched: uniqueProspectsMatched,
  maxGhlContactsForOneProspect: maxContactsOnOneProspect,
  ambiguous,
  unmatched,
  alreadyLinked: existing,
  prospectDocumentsToUpdate: writes.length,
  ownerNamesVerified: 0
}, null, 2));
if (!execute) {
  console.log('Dry run only; no Firestore documents were changed.');
  process.exit(0);
}

let committed = 0;
for (let offset = 0; offset < writes.length; offset += 100) {
  const batch = writes.slice(offset, offset + 100);
  await commit(batch);
  committed += batch.length;
  console.log(`Committed ${committed}/${writes.length} prospect documents`);
  await new Promise(resolve => setTimeout(resolve, 150));
}
console.log(`Done: linked ${crmRecordsMatched - existing} GHL contacts. Role and ownership remain unknown; no consent or lifecycle fields were changed.`);
