// Reading GoHighLevel contacts, and only reading them.
//
// There is already a GoHighLevel adapter in this repository:
// `providers/calling/gohighlevel.js`. It upserts contacts and enrols them in a
// published workflow whose first action places a Voice AI call. That is a
// dialer, and enrolment is irreversible — once a contact is in the workflow
// there is nothing to cancel.
//
// This module is the opposite thing and must stay the opposite thing. It
// answers one question — *what contacts does the CRM already hold, and what do
// they say about themselves?* — so that the eligibility audit can tell an
// operator how many of them could lawfully be called, without a single contact
// being created, tagged, enrolled, or otherwise touched.
//
// Four properties keep that true, and each is enforced rather than intended:
//
//   1. **A different credential.** `GHL_CONTACTS_READ_TOKEN`, not
//      `GHL_API_TOKEN`. A Private Integration scoped to `contacts.readonly`
//      cannot enrol a workflow even if this file were wrong. Reusing the
//      write-capable token would make every other guarantee here a promise
//      rather than a boundary.
//
//   2. **An endpoint allow-list.** `#request` refuses any method/path pair that
//      is not `POST /contacts/search`. Upsert, tag mutation, workflow
//      enrolment, opportunities and the Voice AI endpoints are not "avoided" —
//      they are unreachable, and `assertReadOnlyRequest` throws if a future
//      edit tries.
//
//   3. **Bounded work.** Page size, page count, total records and per-request
//      timeout all have ceilings. An audit that walks an unbounded contact
//      book is an audit that times out in production and gets re-run until it
//      does not, which is how a "read-only" job becomes a quota incident.
//
//   4. **Consent stays evidence.** A GoHighLevel contact can carry a custom
//      field that says `consent_basis: written_opt_in`. That is somebody's CRM
//      note. `normalize()` deliberately refuses to map any GHL field onto the
//      grant fields — basis, grant id, consenting seller, consented number,
//      grant time — so an imported row cannot become permission. What it does
//      carry through is the *reference*: where the artifact is, which form
//      version, which evidence id, so a reviewer can go and read it before
//      issuing a real grant through `consent-grants.js`.

import { LeadSourceAdapter } from './adapter.js';
import { GoHighLevelDialer } from '../calling/gohighlevel.js';
import { clean, normalizeList, normalizePhone, toDate } from '../../prospect-normalization.js';
import { accountFromCrmTags, requireAccountId } from '../../accounts.js';

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';
const SEARCH_PATH = '/contacts/search';

/** The only request this adapter may ever make. */
const ALLOWED_REQUESTS = Object.freeze([`POST ${SEARCH_PATH}`]);

// Named so a refusal is greppable in a log. Every one of these has a
// documented HighLevel endpoint that this adapter must never reach.
export const FORBIDDEN_WRITE_PATHS = Object.freeze([
  '/contacts/upsert',
  '/contacts/{contactId}',
  '/contacts/{contactId}/tags',
  '/contacts/{contactId}/workflow/{workflowId}',
  '/contacts/{contactId}/campaigns/{campaignId}',
  '/opportunities',
  '/conversations/messages',
  '/voice-ai/agents'
]);

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_MAX_RECORDS = 2000;
// A hard ceiling on one audit. Not a tuning knob: a caller asking for more than
// this is asking for a different tool.
export const MAX_RECORDS = 5000;
export const MAX_PAGES = 200;
export const DEFAULT_TIMEOUT_MS = 10000;
export const MAX_TIMEOUT_MS = 30000;
export const DEFAULT_RETRIES = 3;

export class GoHighLevelReadOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoHighLevelReadOnlyViolation';
  }
}

export class GoHighLevelContactsError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'GoHighLevelContactsError';
    this.status = status;
  }
}

/**
 * The boundary, as a function, so a test can assert it directly rather than by
 * observing that a particular call happened not to be made.
 */
export function assertReadOnlyRequest(method, path) {
  const signature = `${String(method || '').toUpperCase()} ${String(path || '')}`;
  if (!ALLOWED_REQUESTS.includes(signature)) {
    throw new GoHighLevelReadOnlyViolation(
      `${signature} is not a read-only GoHighLevel request — this adapter may only call ${ALLOWED_REQUESTS.join(', ')}`
    );
  }
  return signature;
}

const bounded = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
};

const customFieldEntries = raw => {
  const fields = Array.isArray(raw?.customFields) ? raw.customFields
    : Array.isArray(raw?.custom_fields) ? raw.custom_fields : [];
  return fields
    .map(entry => ({
      key: clean(entry?.key ?? entry?.fieldKey ?? entry?.id ?? entry?.field_id, 120).toLowerCase(),
      value: clean(entry?.value ?? entry?.field_value ?? entry?.fieldValue, 500)
    }))
    .filter(entry => entry.key && entry.value);
};

const customField = (entries, ...names) => {
  for (const name of names) {
    const found = entries.find(entry => entry.key === name || entry.key.endsWith(`.${name}`));
    if (found) return found.value;
  }
  return '';
};

/**
 * The channels this contact has switched off, for reporting.
 *
 * The *verdict* — may this number be dialled at all — is
 * `GoHighLevelDialer.contactIsDnd`, imported rather than reimplemented. Two
 * definitions of "did this person opt out" is the drift that ends with the
 * audit calling a contact eligible that the dialer would have refused.
 */
export function dndChannels(raw = {}) {
  const settings = raw?.dndSettings && typeof raw.dndSettings === 'object' ? raw.dndSettings : {};
  const channels = Object.entries(settings)
    .filter(([, value]) => String(value?.status || '').toLowerCase() === 'active')
    .map(([key]) => String(key));
  if (raw?.dnd === true) channels.unshift('all');
  return [...new Set(channels)];
}

/**
 * A GoHighLevel contact reduced to what matching and eligibility need.
 *
 * Everything else is left behind on purpose. A normaliser that keeps sixty
 * provider fields produces a document nobody can query and an audit report
 * that leaks CRM notes into a CSV.
 */
export function normalizeGoHighLevelContact(raw = {}) {
  const entries = customFieldEntries(raw);
  const tags = normalizeList(raw?.tags, { maxItems: 25, maxLen: 60 });
  const account = accountFromCrmTags(tags);
  const phoneE164 = normalizePhone(raw?.phone);
  const name = clean(raw?.contactName ?? raw?.name, 200);
  const firstName = clean(raw?.firstName ?? raw?.first_name, 80);
  const lastName = clean(raw?.lastName ?? raw?.last_name, 80);

  return {
    providerContactId: clean(raw?.id ?? raw?.contactId ?? raw?.contact_id, 200),
    locationId: clean(raw?.locationId ?? raw?.location_id, 200),

    name: name || [firstName, lastName].filter(Boolean).join(' '),
    firstName,
    lastName,
    companyName: clean(raw?.companyName ?? raw?.company_name ?? raw?.businessName, 200),

    phone: clean(raw?.phone, 60),
    phoneE164,
    email: clean(raw?.email, 254),

    timezone: clean(raw?.timezone, 80),
    region: clean(raw?.state ?? raw?.address?.state, 60),
    city: clean(raw?.city ?? raw?.address?.city, 80),
    postalCode: clean(raw?.postalCode ?? raw?.postal_code, 20),
    country: clean(raw?.country, 8),

    // The customer's own opt-out. Read from the same rule the dialer uses.
    doNotCall: GoHighLevelDialer.contactIsDnd(raw),
    dndChannels: dndChannels(raw),

    tags,
    // Which book of business the CRM says this contact belongs to. `''` with a
    // reason when the tags are missing or contradictory — never a guess, and
    // never the account the caller happened to ask about.
    crmAccountId: account.accountId,
    crmAccountReason: account.reason,

    source: clean(raw?.source, 120),
    createdAt: toDate(raw?.dateAdded ?? raw?.date_added ?? raw?.createdAt) || null,
    updatedAt: toDate(raw?.dateUpdated ?? raw?.date_updated ?? raw?.updatedAt) || null,

    // Pointers to consent paperwork, never the permission itself. See the file
    // header: nothing here reaches `consent.basis`, `consent.grantId`, the
    // consenting seller, the consented number, or the grant time.
    consentArtifacts: entries
      .filter(entry => entry.key.includes('consent'))
      .slice(0, 10)
      .map(entry => ({ key: entry.key, value: entry.value }))
  };
}

/**
 * The flat field bag `buildProspect` consumes.
 *
 * Note what is absent: no `consentBasis`, no `consentGrantId`, no
 * `consentSellerAccountId`, no `consentPhoneE164`, no `consentGrantedAt`.
 * `normalizeConsent` reads exactly those names, so leaving them out is what
 * guarantees an imported GoHighLevel row lands as `basis: 'not_recorded'` with
 * an empty grant id no matter what the CRM's custom fields claim.
 */
export function toProspectFields(raw = {}) {
  const contact = normalizeGoHighLevelContact(raw);
  const entries = customFieldEntries(raw);
  return {
    name: contact.name || contact.companyName,
    companyName: contact.companyName,
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone,
    email: contact.email,
    website: clean(raw?.website, 500),
    timezone: contact.timezone,
    address: {
      line1: clean(raw?.address1 ?? raw?.address, 200),
      city: contact.city,
      region: contact.region,
      postalCode: contact.postalCode,
      country: contact.country
    },
    tags: contact.tags,
    doNotCall: contact.doNotCall,
    providerContactId: contact.providerContactId,
    externalId: contact.providerContactId,
    sourceCreatedAt: contact.createdAt,
    sourceUpdatedAt: contact.updatedAt,

    // Evidence references only — see the doc comment above.
    consentRecord: customField(entries, 'consent_record', 'consent_text', 'consent_note'),
    consentSourceUrl: customField(entries, 'consent_source_url', 'consent_url', 'consent_link'),
    consentFormVersion: customField(entries, 'consent_form_version', 'consent_version'),
    consentEvidenceId: customField(entries, 'consent_evidence_id', 'consent_artifact_id')
  };
}

export class GoHighLevelContactsSource extends LeadSourceAdapter {
  static id = 'gohighlevel_contacts';
  static label = 'GoHighLevel contacts (read-only)';
  static executionMode = 'cloud_function';
  // Deliberately not GHL_API_TOKEN. See the file header.
  static requiredSecrets = ['GHL_CONTACTS_READ_TOKEN'];
  static supportsRadius = false;
  static supportsKeywords = true;

  static sourceSystem = 'gohighlevel';

  constructor(config = {}) {
    super(config);
    this.token = String(config.token || '');
    this.locationId = String(config.locationId || '');
    // Every request is bound to one seller. There is no "read the whole
    // sub-account" mode, because all three sellers share one GoHighLevel
    // location and the tag is the only boundary between their books.
    this.accountId = String(config.accountId || '');
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.sleepImpl = config.sleepImpl
      || (ms => new Promise(resolve => { setTimeout(resolve, ms); }));
    this.pageSize = bounded(config.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    this.maxRecords = bounded(config.maxRecords, DEFAULT_MAX_RECORDS, 1, MAX_RECORDS);
    this.timeoutMs = bounded(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    this.retries = bounded(config.retries, DEFAULT_RETRIES, 0, 5);
    /** Every request signature this instance made, for tests and for audit records. */
    this.requestLog = [];
  }

  async validateConfig() {
    const errors = [];
    if (!this.token) errors.push('GHL_CONTACTS_READ_TOKEN is not configured.');
    if (!this.locationId) errors.push('A GoHighLevel location id is required.');
    try { requireAccountId(this.accountId, { field: 'accountId' }); }
    catch (error) { errors.push(error.message); }
    return {
      valid: errors.length === 0,
      errors,
      warnings: errors.length ? [] : [
        'This source reads contacts. It cannot create, tag, enrol or otherwise change anything in GoHighLevel.'
      ]
    };
  }

  async healthCheck() {
    const missing = [];
    if (!this.token) missing.push('GHL_CONTACTS_READ_TOKEN');
    if (!this.locationId) missing.push('GHL_LOCATION_ID');
    return { ok: missing.length === 0, missing, detail: missing.length ? '' : 'read-only' };
  }

  /** Discovery jobs run over criteria; this source is driven by the audit. */
  supports() { return true; }

  sourceIdentity(raw = {}) {
    return {
      provider: GoHighLevelContactsSource.id,
      providerRecordId: clean(raw?.id ?? raw?.contactId, 200)
    };
  }

  normalize(raw = {}) { return toProspectFields(raw); }

  async #request(method, path, payload) {
    const signature = assertReadOnlyRequest(method, path);
    if (!this.token) throw new GoHighLevelContactsError('GHL_CONTACTS_READ_TOKEN is not configured');
    if (!this.locationId) throw new GoHighLevelContactsError('A GoHighLevel location id is required');
    this.requestLog.push(signature);

    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) {
        // Exponential, and capped: a Cloud Function that sleeps thirty seconds
        // to be polite has spent the caller's timeout being polite.
        await this.sleepImpl(Math.min(4000, 250 * 2 ** (attempt - 1)));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(BASE_URL + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            Version: API_VERSION,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } catch (error) {
        lastError = new GoHighLevelContactsError(
          error?.name === 'AbortError'
            ? 'GoHighLevel contact search timed out'
            : `Could not reach GoHighLevel: ${String(error?.message || error).slice(0, 200)}`
        );
        continue;
      } finally {
        clearTimeout(timer);
      }

      // 429 and 5xx are the provider asking us to come back; everything else is
      // a decision we should not paper over by retrying.
      if (response.status === 429 || response.status >= 500) {
        lastError = new GoHighLevelContactsError(
          `GoHighLevel returned HTTP ${response.status}`, response.status
        );
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        let detail = `GoHighLevel returned HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(text);
          const message = Array.isArray(parsed?.message) ? parsed.message.join('; ') : parsed?.message;
          if (message) detail = String(message).replace(/\s+/g, ' ').slice(0, 360);
        } catch { /* keep the status-only message */ }
        throw new GoHighLevelContactsError(detail, response.status);
      }
      if (!text) return {};
      try { return JSON.parse(text); }
      catch { throw new GoHighLevelContactsError('GoHighLevel returned an invalid JSON response'); }
    }
    throw lastError || new GoHighLevelContactsError('GoHighLevel contact search failed');
  }

  /**
   * One page of contacts.
   *
   * `cursor` is HighLevel's `searchAfter` array, carried through opaquely. The
   * sort is fixed and ascending so that the cursor is stable: sorting by "most
   * recently updated" while the CRM is being edited underneath means a
   * paginated read can see the same contact twice and miss another entirely.
   */
  async discover(criteria = {}, cursor = null) {
    const pageLimit = bounded(criteria.pageSize, this.pageSize, 1, MAX_PAGE_SIZE);
    const filters = [];
    if (criteria.updatedAfter) {
      const since = toDate(criteria.updatedAfter);
      if (since) {
        filters.push({ field: 'dateUpdated', operator: 'range', value: { gte: since.toISOString() } });
      }
    }
    for (const tag of normalizeList(criteria.tags, { maxItems: 5, maxLen: 60 })) {
      filters.push({ field: 'tags', operator: 'eq', value: tag });
    }

    const payload = {
      locationId: this.locationId,
      pageLimit,
      sort: [{ field: 'dateAdded', direction: 'asc' }],
      ...(clean(criteria.query, 120) ? { query: clean(criteria.query, 120) } : {}),
      ...(filters.length ? { filters } : {}),
      ...(Array.isArray(cursor) && cursor.length ? { searchAfter: cursor } : {})
    };

    const body = await this.#request('POST', SEARCH_PATH, payload);
    const contacts = Array.isArray(body?.contacts) ? body.contacts : [];

    // Refuse a page from a location we did not ask for. A misconfigured token
    // that can see a second sub-account is a seller-boundary violation, and
    // silently normalising those rows is exactly how one seller's list ends up
    // in another seller's audit.
    const foreign = contacts.find(contact => {
      const id = clean(contact?.locationId ?? contact?.location_id, 200);
      return id && id !== this.locationId;
    });
    if (foreign) {
      throw new GoHighLevelContactsError(
        'GoHighLevel returned a contact from a different location than the one requested'
      );
    }

    const last = contacts[contacts.length - 1];
    const nextCursor = Array.isArray(body?.searchAfter) ? body.searchAfter
      : Array.isArray(last?.searchAfter) ? last.searchAfter : null;

    return {
      records: contacts,
      cursor: nextCursor,
      done: contacts.length < pageLimit || !nextCursor,
      total: Number.isFinite(Number(body?.total)) ? Number(body.total) : null
    };
  }

  /**
   * Every page, up to the record and page ceilings.
   *
   * Returns `truncated: true` rather than throwing when it stops early, and the
   * caller is expected to say so out loud — a report that silently covered the
   * first two thousand of nine thousand contacts reads as complete.
   */
  async readAll(criteria = {}) {
    const limit = bounded(criteria.maxRecords, this.maxRecords, 1, MAX_RECORDS);
    const records = [];
    let cursor = null;
    let pages = 0;
    let total = null;
    let truncated = false;
    // Distinguishes "the provider ran out of contacts" from "we ran out of
    // pages". Counting pages alone would call a read that finished naturally on
    // its two-hundredth page truncated, and a report that cries truncation is a
    // report whose truncation warning gets ignored.
    let exhausted = false;

    while (pages < MAX_PAGES) {
      const page = await this.discover(criteria, cursor);
      pages += 1;
      if (total === null) total = page.total;
      for (const record of page.records) {
        if (records.length >= limit) { truncated = true; break; }
        records.push(record);
      }
      if (page.done) exhausted = true;
      if (truncated || exhausted) break;
      cursor = page.cursor;
    }
    if (!exhausted) truncated = true;

    return { records, pages, total, truncated, requests: [...this.requestLog] };
  }
}

/**
 * Read contacts for one seller without holding an adapter instance.
 * The audit calls this; nothing else needs to.
 */
export async function readGoHighLevelContacts(config = {}, criteria = {}) {
  const source = new GoHighLevelContactsSource(config);
  const validation = await source.validateConfig();
  if (!validation.valid) throw new GoHighLevelContactsError(validation.errors.join(' '));
  const page = await source.readAll(criteria);
  return {
    ...page,
    contacts: page.records.map(normalizeGoHighLevelContact),
    accountId: source.accountId,
    locationId: source.locationId
  };
}
