// The Watcher-Workflows corpus (Firebase project `watcher-leads-89349`).
//
// This adapter is a MAPPING, not a crawler. BiteSites Cloud Functions have no
// credentials for the source project and must not grow any — §15/§17 of the
// brief put every cross-project read in `scripts/migrate-watcher-leads.mjs`,
// which runs locally under a human's Application Default Credentials. So
// `discover()` here reads batches that the migration script (or a local worker)
// has already submitted through the authenticated ingestion endpoint, and the
// valuable part of the file is `normalize()`: the field-by-field translation
// from that project's `smb_leads` document into a BiteSites prospect.
//
// AIRBNB BOUNDARY. The source project carries a second ICP — `airbnb_leads`,
// `airbnb_contacts`, and listing fields (host, nightly price, photos, room
// type, occupancy) — which stays in its own application. `isAirbnbRecord` below
// is the single test for it, and `normalize()` refuses rather than silently
// dropping the fields, so an Airbnb row cannot arrive here unnoticed.

import { LeadSourceAdapter } from './adapter.js';
import { clean, normalizeList } from '../../prospect-normalization.js';

// The Watcher `smb_leads` shape (see executions/_firebase.py in that repo):
//   link, name, source, sources[], source_count, industry, field, location,
//   review_count, score, reason, services, ingest_status, checkpoint_run_id,
//   phone, website, email, email_domain_type, google_rating,
//   google_review_count, website_backfill_status, contact_first_name,
//   contact_last_name, additional_contacts[], enrichment_*, verification_*,
//   descriptor, status, assigned_to, notes
export const WATCHER_SMB_FIELDS = [
  'link', 'name', 'source', 'sources', 'source_count', 'industry', 'field',
  'location', 'review_count', 'score', 'reason', 'services', 'ingest_status',
  'phone', 'website', 'email', 'google_rating', 'google_review_count',
  'contact_first_name', 'contact_last_name', 'descriptor', 'status',
  'assigned_to', 'notes'
];

// Field names and values that only exist because of the Airbnb ICP. Matching is
// case-insensitive and substring-based on purpose: the point is to catch a
// row that carries listing data under a name we have not seen, not to be exact.
const AIRBNB_FIELD_MARKERS = [
  'airbnb', 'is_airbnb', 'host_name', 'host_listings_count', 'is_superhost',
  'room_type', 'nightly', 'photo_quality', 'photo_issues', 'needs_photo_review',
  'max_photo_width', 'occupancy', 'reservation', 'listing_id'
];

const AIRBNB_VALUE_MARKERS = ['airbnb', 'air bnb', 'short_term_rental', 'short-term rental', 'nightly rate'];

/**
 * Is this source record part of the Airbnb ICP?
 *
 * Mirrors the source project's own `is_airbnb_lead()` (source == 'airbnb' or
 * 'airbnb' in sources) and then goes further, because that test only holds for
 * rows the pipeline wrote. A hand-edited or half-migrated document is exactly
 * the one that would slip through.
 */
export function isAirbnbRecord(raw = {}) {
  if (raw.is_airbnb === true) return true;
  if (String(raw.source || '').toLowerCase().includes('airbnb')) return true;
  if ((raw.sources || []).some(entry => String(entry).toLowerCase().includes('airbnb'))) return true;
  if (String(raw.descriptor || '').toLowerCase().includes('short_term_rental')) return true;

  for (const key of Object.keys(raw)) {
    const lower = key.toLowerCase();
    if (AIRBNB_FIELD_MARKERS.some(marker => lower.includes(marker))) return true;
  }
  for (const key of ['link', 'website', 'industry', 'field', 'category']) {
    const value = String(raw[key] || '').toLowerCase();
    if (AIRBNB_VALUE_MARKERS.some(marker => value.includes(marker))) return true;
  }
  return false;
}

/** Records that exist to test the pipeline, not to be called. */
export function isInternalTestRecord(raw = {}) {
  const haystack = [raw.name, raw.email, raw.website, raw.link, raw.notes]
    .map(value => String(value || '').toLowerCase()).join(' ');
  if (/\b(test|sample|dummy|example|placeholder|do not call|lorem)\b/.test(haystack)) return true;
  return /@(?:example\.(?:com|org|net)|test\.com|invalid)\b/.test(haystack);
}

/**
 * How a Watcher record should be treated on arrival (§20).
 * Nothing here promotes a record into a campaign — that is always explicit.
 */
export function classifyWatcherRecord(raw = {}) {
  if (isAirbnbRecord(raw)) return 'airbnb_record';
  if (isInternalTestRecord(raw)) return 'internal_test';

  const status = String(raw.status || '').toLowerCase();
  if (['won', 'customer', 'client'].includes(status)) return 'existing_customer';
  if (['qualified', 'booked', 'proposal', 'opportunity'].includes(status)) return 'qualified_opportunity';
  if (['contacted', 'replied', 'sent', 'emailed', 'called'].includes(status)) return 'previously_contacted';
  if (!raw.phone && !raw.email) return 'invalid_record';
  return 'cold_prospect';
}

export class WatcherWorkflowSource extends LeadSourceAdapter {
  static id = 'watcher_workflow';
  static label = 'Watcher Workflows corpus (migrated)';
  // Ingested by scripts/migrate-watcher-leads.mjs or a local worker; this
  // function never opens a connection to the source project.
  static executionMode = 'local_runner';
  static requiredSecrets = [];
  static supportsKeywords = false;

  static sourceSystem = 'watcher_leads';
  static sourceProjectId = 'watcher-leads-89349';

  async validateConfig() {
    return {
      valid: true,
      errors: [],
      warnings: ['Records arrive through scripts/migrate-watcher-leads.mjs — this source cannot start a job on its own.']
    };
  }

  supports() { return false; }

  async discover() {
    // Deliberately not implemented. A job that could pull from the source
    // project would be a second, unaudited migration path.
    throw new Error('watcher_workflow ingests through the migration script; it cannot run a discovery job.');
  }

  sourceIdentity(raw = {}) {
    return {
      provider: WatcherWorkflowSource.id,
      // The source's own doc id is a hash of `link`, which is what makes a
      // re-run of the migration update rather than duplicate.
      providerRecordId: clean(raw.__docId || raw.id, 200)
    };
  }

  normalize(raw = {}) {
    if (isAirbnbRecord(raw)) {
      throw new Error('Airbnb records are excluded from BiteSites outbound and must not be normalised here.');
    }

    return {
      name: raw.name,
      companyName: raw.name,
      firstName: raw.contact_first_name,
      lastName: raw.contact_last_name,
      phone: raw.phone,
      email: raw.email,
      website: raw.website,
      // `location` in the source is a free-text 'Ridgewood, NJ' string.
      address: raw.location,
      category: raw.field || raw.industry,
      categories: normalizeList(raw.services ?? raw.industry, { maxItems: 8 }),
      rating: raw.google_rating ?? raw.rating,
      reviewCount: raw.google_review_count ?? raw.review_count,
      score: raw.score,
      notes: raw.reason || raw.notes,
      tags: normalizeList(raw.sources, { maxItems: 8, maxLen: 40 }),
      externalId: clean(raw.__docId || raw.id, 200),
      sourceUrl: raw.link
    };
  }
}
