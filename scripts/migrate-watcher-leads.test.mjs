// The migration tool's pure halves:  npm run test:migration
//
// Runs with plain `node --test`. It deliberately never opens a connection to
// either Firebase project — the point of a migration test that touches a live
// project is entirely lost, and §45 forbids modifying source or destination
// production data.
//
// What it does pin: the collection map (including everything excluded and why),
// the deterministic id scheme that makes a re-run idempotent, the argument
// parser's dry-run-by-default behaviour, and the Airbnb exclusion.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, destinationId, COLLECTION_MAP, EXCLUDED_COLLECTIONS, stripUndefined
} from './migrate-watcher-leads.mjs';
import {
  isAirbnbRecord, classifyWatcherRecord, WatcherWorkflowSource
} from '../functions/providers/lead-sources/existing-watcher-source.js';
import { BiteSitesLeadsSource } from '../functions/providers/lead-sources/existing-bitesites-leads-source.js';
import { buildProspect, validateProspect } from '../functions/prospect-normalization.js';

test('the default mode is dry-run, and nothing else', () => {
  assert.equal(parseArgs([]).mode, 'dry-run');
  assert.equal(parseArgs(['--limit', '100']).mode, 'dry-run');
  assert.equal(parseArgs(['--collection', 'smb_leads']).mode, 'dry-run');
  // Only the explicit flag can turn on writing.
  assert.equal(parseArgs(['--execute']).mode, 'execute');
  assert.equal(parseArgs(['--inspect']).mode, 'inspect');
});

test('arguments parse into bounded values', () => {
  const args = parseArgs(['--limit', '250', '--collection', 'smb_leads', '--resume', 'run123', '--yes']);
  assert.equal(args.limit, 250);
  assert.equal(args.collection, 'smb_leads');
  assert.equal(args.resume, 'run123');
  assert.equal(args.yes, true);
  assert.equal(parseArgs(['--limit', '-5']).limit, 0);
  assert.equal(parseArgs(['--limit', 'abc']).limit, 0);
});

test('the collection map covers only contact-bearing collections', () => {
  assert.deepEqual(Object.keys(COLLECTION_MAP).sort(), ['companies', 'smb_contacts', 'smb_leads']);
  assert.ok(Object.values(COLLECTION_MAP).every(entry => entry.destination === 'prospects'));
});

test('every Airbnb collection is explicitly excluded, with a reason', () => {
  for (const name of ['airbnb_leads', 'airbnb_contacts']) {
    assert.ok(EXCLUDED_COLLECTIONS[name], `${name} must be listed as excluded`);
    assert.match(EXCLUDED_COLLECTIONS[name], /Airbnb/);
    assert.ok(!COLLECTION_MAP[name], `${name} must not be in the migration map`);
  }
});

test('the email-outreach and operational collections are excluded too', () => {
  for (const name of ['content', 'videos', 'lead_generation_log', 'smartlead_events',
    'access', 'spend', 'run_requests', 'outreach_requests', 'kixie_sessions']) {
    assert.ok(EXCLUDED_COLLECTIONS[name], `${name} should be listed with a reason`);
    assert.ok(!COLLECTION_MAP[name]);
  }
});

test('destination ids are deterministic, so a re-run updates rather than duplicates', () => {
  assert.equal(destinationId('smb_leads', 'abc123'), 'watcher_smb_leads_abc123');
  assert.equal(destinationId('smb_leads', 'abc123'), destinationId('smb_leads', 'abc123'));
  // Two source collections must never collide on the same id.
  assert.notEqual(destinationId('smb_leads', 'x'), destinationId('companies', 'x'));
  // An id with unsafe characters hashes rather than being rewritten.
  const unsafe = destinationId('smb_leads', 'a/b');
  assert.ok(unsafe.startsWith('watcher_h'));
  assert.notEqual(unsafe, destinationId('smb_leads', 'a_b'));
});

test('a Watcher SMB record maps onto the prospect shape', () => {
  const source = {
    __docId: 'hash-of-link',
    link: 'https://www.yelp.com/biz/joes-plumbing',
    name: 'JOES PLUMBING LLC',
    source: 'places',
    sources: ['places', 'yelp'],
    industry: 'Plumbing Contractor',
    field: 'plumbing',
    location: 'Ridgewood, NJ',
    phone: '(201) 555-0142',
    website: 'www.joesplumbing.com',
    email: 'Info@JoesPlumbing.com',
    google_rating: 4.5,
    google_review_count: 61,
    score: 82,
    reason: 'DIY site, no analytics',
    contact_first_name: 'Dana',
    contact_last_name: 'Okafor'
  };

  const normalized = new BiteSitesLeadsSource().normalize(source);
  const prospect = buildProspect(normalized, {
    source: {
      system: 'watcher_leads',
      provider: 'bitesites_leads',
      providerRecordId: source.__docId,
      sourceProjectId: 'watcher-leads-89349',
      sourceCollection: 'smb_leads',
      sourceDocumentId: source.__docId
    }
  });

  assert.equal(prospect.companyName, 'Joes Plumbing LLC');
  assert.equal(prospect.phoneE164, '+12015550142');
  assert.equal(prospect.email, 'info@joesplumbing.com');
  assert.equal(prospect.website, 'https://joesplumbing.com');
  assert.equal(prospect.address.city, 'Ridgewood');
  assert.equal(prospect.address.region, 'NJ');
  assert.equal(prospect.location.timezone, 'America/New_York');
  assert.equal(prospect.firstName, 'Dana');
  assert.equal(prospect.business.category, 'plumbing');
  assert.equal(prospect.lifecycle.score, 82);
  assert.equal(prospect.notes, 'DIY site, no analytics');
  assert.equal(validateProspect(prospect).valid, true);
});

test('source attribution is preserved on every migrated record', () => {
  const prospect = buildProspect({ name: 'A', phone: '2015550142' }, {
    source: {
      system: 'watcher_leads',
      sourceProjectId: 'watcher-leads-89349',
      sourceCollection: 'smb_leads',
      sourceDocumentId: 'doc-1'
    },
    importRunId: 'run-1'
  });
  assert.equal(prospect.source.system, 'watcher_leads');
  assert.equal(prospect.source.sourceProjectId, 'watcher-leads-89349');
  assert.equal(prospect.source.sourceCollection, 'smb_leads');
  assert.equal(prospect.source.sourceDocumentId, 'doc-1');
  assert.ok(prospect.source.importedAt);
  assert.equal(prospect.importRunId, 'run-1');
});

test('the BiteSites-Leads fork’s CRM and consent fields survive the mapping', () => {
  const normalized = new BiteSitesLeadsSource().normalize({
    __docId: 'd1', name: 'A', phone: '2015550142',
    ghl_contact_id: 'ghl-abc', consent_basis: 'written_opt_in',
    consent_record: 'Signed at the trade show', dnc: true
  });
  assert.equal(normalized.providerContactId, 'ghl-abc');
  assert.equal(normalized.consentBasis, 'written_opt_in');
  assert.equal(normalized.doNotCall, true);

  const prospect = buildProspect(normalized, { source: { system: 'bitesites_leads' } });
  assert.equal(prospect.contactability.doNotCall, true);
});

test('an Airbnb record is refused by the adapter, not silently stripped', () => {
  const listing = { __docId: 'd', name: 'Cozy Loft', source: 'airbnb', host_name: 'Dana', room_type: 'Entire home' };
  assert.ok(isAirbnbRecord(listing));
  assert.equal(classifyWatcherRecord(listing), 'airbnb_record');
  assert.throws(() => new WatcherWorkflowSource().normalize(listing), /Airbnb/);
});

test('an Airbnb row hiding in an SMB collection is still caught', () => {
  // The source project's own routing rule only holds for rows its pipeline
  // wrote; a hand-edited or half-migrated document is exactly the one that
  // would slip through a source-field-only check.
  const smuggled = { __docId: 'd', name: 'A Business', phone: '2015550142', is_superhost: true };
  assert.ok(isAirbnbRecord(smuggled));
  assert.equal(classifyWatcherRecord(smuggled), 'airbnb_record');
});

test('records classify into buckets that decide migration behaviour', () => {
  const base = { name: 'A', phone: '2015550142' };
  assert.equal(classifyWatcherRecord(base), 'cold_prospect');
  assert.equal(classifyWatcherRecord({ ...base, status: 'contacted' }), 'previously_contacted');
  assert.equal(classifyWatcherRecord({ ...base, status: 'won' }), 'existing_customer');
  assert.equal(classifyWatcherRecord({ ...base, status: 'booked' }), 'qualified_opportunity');
  assert.equal(classifyWatcherRecord({ name: 'Sample Business' }), 'internal_test');
  assert.equal(classifyWatcherRecord({ name: 'A' }), 'invalid_record');
});

test('undefined is stripped before a Firestore write', () => {
  const cleaned = stripUndefined({
    a: 1, b: undefined, c: { d: undefined, e: 'keep' }, f: [1, undefined, 3], g: null
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['a', 'c', 'f', 'g']);
  assert.deepEqual(Object.keys(cleaned.c), ['e']);
  assert.equal(cleaned.g, null, 'null is a legitimate stored value; only undefined is dropped');
});

test('a Date survives stripUndefined unchanged', () => {
  const date = new Date('2026-01-05T15:00:00Z');
  assert.equal(stripUndefined({ at: date }).at.getTime(), date.getTime());
});

test('the migrated sources cannot be used to start a discovery job', () => {
  // A job that could pull from the source project would be a second,
  // unaudited migration path.
  assert.equal(new WatcherWorkflowSource().supports({}), false);
  assert.equal(WatcherWorkflowSource.executionMode, 'local_runner');
  assert.rejects(() => new WatcherWorkflowSource().discover({}), /migration script/);
  assert.rejects(() => new BiteSitesLeadsSource().discover({}), /migration script/);
});
