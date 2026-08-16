// Fine Line Group CRM — read-only HighLevel dashboard feed.
//
// The admin console's /admin/crm page shows the Fine Line Group pipelines that
// live in HighLevel location LDL5wuJlnVnqk9vn6taD. Everything here is a GET:
// this module deliberately contains no way to write to HighLevel, so a bug in
// the dashboard cannot touch the live workflows, stages, tags or contacts the
// FLG workflow suite depends on.
//
// The token is its own secret — GHL_CRM_DASHBOARD_TOKEN — separate from
// GHL_API_TOKEN (the Voice AI poller's token), so either can be rotated or
// revoked without breaking the other. It binds at deploy time:
//
//   firebase functions:secrets:set GHL_CRM_DASHBOARD_TOKEN
//   npm run deploy:functions
//
// The callable is the only exit: authenticated Firebase users with the admin
// role, App Check enforced, and the response is sanitized to what the
// dashboard renders — no contact emails, phones or addresses leave here.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';

export const GHL_CRM_DASHBOARD_TOKEN = defineSecret('GHL_CRM_DASHBOARD_TOKEN');

export const FLG_LOCATION_ID = 'LDL5wuJlnVnqk9vn6taD';

// The two Fine Line pipelines. The location also holds an unrelated
// "Marketing Pipeline"; the snapshot filters to these two so the dashboard
// never leaks another book of business.
export const FLG_PIPELINES = {
  clientAcquisition: 'wGaMTdRFAzIElK5EQUIZ',
  referralPartners: 'pAjQijCNlnKNmb70H3ip'
};

// Opportunity custom fields, verified against the live location's
// /customFields catalog (see FINAL-WORKFLOW-REPORT.md). Values arrive as
// { id, fieldValueString | fieldValueNumber | fieldValueArray }.
export const FLG_FIELDS = {
  xsnjtkMBsEFqla3oCGmm: 'contactFullName',       // opportunity.flg__contact_full_name
  ph7sQvIhfkhlzojoDj2v: 'services',              // flg__service_requested (multi)
  OJnesr7NydegRtDteT23: 'estimateAmount',        // flg__estimate_amount
  LJlEhN0jRIzV3rLKEf6Z: 'contractAmount',        // flg__contract_amount
  M8Ue8wrwxF4v9VowSgz3: 'collectedRevenue',      // flg__total_collected_revenue
  yV48BztjTPAS2nx6sNmZ: 'commissionRate',        // flg__bitesites_commission_rate (%)
  '7hgwGsHT9KATn2rrzuxs': 'commissionDue',       // flg__bitesites_commission_due
  PaZdwDYUpTdaL04rV1QD: 'commissionPaid',        // flg__bitesites_commission_paid
  Mnl4s0lbkMx4D4Eza4vv: 'referralCount',         // flg__referral_count
  D01C6w9Gn2jIdASwQVuu: 'firstReferralDate',     // flg__first_referral_date
  '3amDngxAfpTaffSpduqo': 'lastReferralDate',    // flg__last_referral_date
  Na3PUMlAtzTeeF8fTUbP: 'referralPartnerBusiness', // flg__referral_partner_business
  zr34a1wQyOt6rinYVyON: 'referralPartnerType',   // flg__referral_partner_type
  '5aWsSm1DHh3CLhmJJLWX': 'referralPartnerContact', // flg__referral_partner_contact
  MgjkZWJpa1qXNmJOannw: 'lossReason',            // flg__loss_reason
  '0YezMAKYJiKDNBq6Npni': 'lastCustomerPaymentDate' // flg__last_customer_payment_date
  // Deliberately unmapped: flg__property_address, flg__lead_notes,
  // flg__payment_notes, flg__referral_notes, flg__loss_notes. Addresses and
  // free-text notes are the PII-heaviest fields and the dashboard has no use
  // for them — they stay in HighLevel.
};

export const COMMISSION_DUE_TAG = 'flg - commission due';

const HL_BASE = 'https://services.leadconnectorhq.com';
const HL_VERSION = '2021-07-28';
const PAGE_LIMIT = 100;       // documented maximum for /opportunities/search
const MAX_PAGES = 30;         // backstop, not an expected depth
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;       // total tries per request (429/5xx retried)

/** An upstream failure the caller can show. Never carries the token. */
export class HighLevelError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'HighLevelError';
    this.status = status;
  }
}

const scrub = (text, token) =>
  token ? String(text).split(token).join('[redacted]') : String(text);

/**
 * Minimal read-only HighLevel v2 client. `fetchImpl` and `sleep` are
 * injectable so tests can mock the wire and skip real backoff waits.
 */
export function createHighLevelClient({
  token,
  locationId = FLG_LOCATION_ID,
  fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  if (!token || token === 'unset' || token.length < 20) {
    throw new HighLevelError('GHL_CRM_DASHBOARD_TOKEN is not configured', 503);
  }

  async function get(path, params = {}) {
    const url = new URL(`${HL_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            Version: HL_VERSION,
            Accept: 'application/json'
          },
          signal: controller.signal
        });

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers?.get?.('retry-after')) || 0;
          lastError = new HighLevelError(`HighLevel returned ${response.status}`, response.status);
          if (attempt < MAX_ATTEMPTS) {
            await sleep(retryAfter > 0 ? retryAfter * 1000 : attempt * 1500);
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          const body = scrub((await response.text()).slice(0, 300), token);
          throw new HighLevelError(`HighLevel returned ${response.status}: ${body}`, response.status);
        }
        return await response.json();
      } catch (error) {
        if (error instanceof HighLevelError) {
          if (attempt >= MAX_ATTEMPTS || (error.status !== 429 && error.status < 500)) throw error;
          lastError = error;
          continue;
        }
        // Abort (timeout) and network failures: retryable, token-free message.
        lastError = new HighLevelError(
          error?.name === 'AbortError' ? 'HighLevel request timed out' : `HighLevel request failed: ${scrub(error?.message || 'network error', token)}`
        );
        if (attempt >= MAX_ATTEMPTS) throw lastError;
        await sleep(attempt * 1500);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new HighLevelError('HighLevel request failed');
  }

  return {
    listPipelines: () => get('/opportunities/pipelines', { locationId }),

    /**
     * Every opportunity in one pipeline, however many pages that takes.
     * Cursor pagination via meta.startAfter/startAfterId; a short page is the
     * end. MAX_PAGES caps a runaway loop at 3,000 rows.
     */
    async listAllOpportunities(pipelineId) {
      const opportunities = [];
      let startAfter;
      let startAfterId;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const body = await get('/opportunities/search', {
          location_id: locationId,
          pipeline_id: pipelineId,
          limit: PAGE_LIMIT,
          startAfter,
          startAfterId
        });
        const batch = Array.isArray(body?.opportunities) ? body.opportunities : [];
        opportunities.push(...batch);
        if (batch.length < PAGE_LIMIT) break;
        startAfter = body?.meta?.startAfter;
        startAfterId = body?.meta?.startAfterId;
        if (!startAfterId) break;
      }
      return opportunities;
    }
  };
}

// ------------------------------------------------------------- sanitization

const text = (value, maxLen = 300) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen)
    : typeof value === 'number' && Number.isFinite(value) ? String(value).slice(0, maxLen)
    : '';

const num = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
};

const isoOrEmpty = value => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
};

const DAY_MS = 24 * 60 * 60 * 1000;
const daysSince = (iso, now) => {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
};

/** Reads { id, fieldValue* } entries into the named FLG fields. */
export function readCustomFields(raw) {
  const out = {};
  for (const entry of Array.isArray(raw) ? raw : []) {
    const key = FLG_FIELDS[entry?.id];
    if (!key) continue;
    if (Array.isArray(entry.fieldValueArray)) out[key] = entry.fieldValueArray.map(v => text(v, 120)).filter(Boolean);
    else if (entry.fieldValueNumber !== undefined) out[key] = num(entry.fieldValueNumber);
    else out[key] = text(entry.fieldValueString ?? entry.fieldValue, 300);
  }
  return out;
}

/**
 * One opportunity, reduced to what the dashboard renders. Contact email,
 * phone, and address never cross this boundary — the name is kept because the
 * opportunity title itself carries it (that is what the naming workflows do).
 */
export function sanitizeOpportunity(raw, { stagesById = new Map(), now = Date.now() } = {}) {
  const fields = readCustomFields(raw?.customFields);
  const tags = ((raw?.contact?.tags) || []).map(tag => text(tag, 80).toLowerCase()).filter(Boolean).slice(0, 30);
  const stage = stagesById.get(raw?.pipelineStageId) || null;

  const createdAt = isoOrEmpty(raw?.createdAt);
  const lastStageChangeAt = isoOrEmpty(raw?.lastStageChangeAt);
  const status = ['open', 'won', 'lost', 'abandoned'].includes(raw?.status) ? raw.status : 'open';

  const commissionRate = num(fields.commissionRate);
  const collectedRevenue = num(fields.collectedRevenue);
  const commissionPaid = num(fields.commissionPaid);
  // The workflow tags `flg - commission due` and records revenue and rate; the
  // due amount field is authoritative when present, computed otherwise.
  const commissionExpected = fields.commissionDue !== undefined && num(fields.commissionDue) > 0
    ? num(fields.commissionDue)
    : Math.round(collectedRevenue * commissionRate) / 100;
  const commissionOutstanding = Math.max(0, num(commissionExpected - commissionPaid));

  return {
    id: text(raw?.id, 100),
    name: text(raw?.name, 300),
    pipelineId: text(raw?.pipelineId, 100),
    stageId: text(raw?.pipelineStageId, 100),
    stageName: stage?.name || '',
    stagePosition: Number.isFinite(stage?.position) ? stage.position : null,
    status,
    value: num(raw?.monetaryValue),
    source: text(raw?.source, 120),
    createdAt,
    updatedAt: isoOrEmpty(raw?.updatedAt),
    lastStageChangeAt,
    lastStatusChangeAt: isoOrEmpty(raw?.lastStatusChangeAt),
    ageDays: daysSince(createdAt, now),
    daysInStage: daysSince(lastStageChangeAt || createdAt, now),
    contactId: text(raw?.contactId, 100),
    contactName: text(raw?.contact?.name, 160) || fields.contactFullName || '',
    companyName: text(raw?.contact?.companyName, 160),
    tags,
    commissionDueTag: tags.includes(COMMISSION_DUE_TAG),
    services: Array.isArray(fields.services) ? fields.services : fields.services ? [fields.services] : [],
    estimateAmount: num(fields.estimateAmount),
    contractAmount: num(fields.contractAmount),
    collectedRevenue,
    commissionRate,
    commissionExpected: num(commissionExpected),
    commissionPaid,
    commissionOutstanding,
    referralCount: num(fields.referralCount),
    firstReferralDate: isoOrEmpty(fields.firstReferralDate),
    lastReferralDate: isoOrEmpty(fields.lastReferralDate),
    referralPartnerBusiness: text(fields.referralPartnerBusiness, 160),
    referralPartnerType: text(fields.referralPartnerType, 80),
    referralPartnerContact: text(fields.referralPartnerContact, 160),
    lossReason: text(fields.lossReason, 120),
    lastCustomerPaymentDate: isoOrEmpty(fields.lastCustomerPaymentDate)
  };
}

const sanitizeStage = stage => ({
  id: text(stage?.id, 100),
  name: text(stage?.name, 160),
  position: Number.isFinite(stage?.position) ? stage.position : 0
});

/**
 * The whole dashboard payload: the two FLG pipelines with their stages, and
 * every opportunity in each, sanitized. Anything from another pipeline in the
 * same location is dropped.
 */
export function buildCrmSnapshot({ pipelines = [], opportunitiesByPipeline = {}, now = Date.now() } = {}) {
  const wanted = new Set(Object.values(FLG_PIPELINES));
  const flgPipelines = pipelines
    .filter(pipeline => wanted.has(pipeline?.id))
    .map(pipeline => ({
      id: pipeline.id,
      name: text(pipeline.name, 160),
      kind: pipeline.id === FLG_PIPELINES.referralPartners ? 'referral' : 'client',
      stages: (pipeline.stages || []).map(sanitizeStage).sort((a, b) => a.position - b.position)
    }));

  const opportunities = [];
  for (const pipeline of flgPipelines) {
    const stagesById = new Map(pipeline.stages.map(stage => [stage.id, stage]));
    for (const raw of opportunitiesByPipeline[pipeline.id] || []) {
      opportunities.push(sanitizeOpportunity(raw, { stagesById, now }));
    }
  }

  return {
    locationId: FLG_LOCATION_ID,
    fetchedAt: new Date(now).toISOString(),
    pipelines: flgPipelines,
    opportunities
  };
}

// ------------------------------------------------------------------ callable

// The caller's role, resolved the way firestore.rules resolves it: custom
// claim first, roles/{uid} document second.
async function callerRole(db, auth) {
  if (auth?.token?.role) return auth.token.role;
  if (!auth?.uid) return '';
  const snapshot = await db.doc(`roles/${auth.uid}`).get();
  return snapshot.exists ? snapshot.get('role') || '' : '';
}

// One HighLevel sweep is ~4 requests. The console refetches on every mount, so
// a short instance-local cache keeps an admin clicking around from hammering
// the HighLevel rate limit; `refresh: true` bypasses it for the manual button.
const SNAPSHOT_CACHE_MS = 60 * 1000;
let cache = { at: 0, snapshot: null };

export async function fetchCrmSnapshot({ token, fetchImpl, sleep, now = Date.now() } = {}) {
  const client = createHighLevelClient({ token, fetchImpl, sleep });
  const pipelineBody = await client.listPipelines();
  const pipelines = Array.isArray(pipelineBody?.pipelines) ? pipelineBody.pipelines : [];

  const opportunitiesByPipeline = {};
  for (const pipelineId of Object.values(FLG_PIPELINES)) {
    opportunitiesByPipeline[pipelineId] = await client.listAllOpportunities(pipelineId);
  }
  return buildCrmSnapshot({ pipelines, opportunitiesByPipeline, now });
}

export const getFineLineCrm = onCall(
  { enforceAppCheck: true, secrets: [GHL_CRM_DASHBOARD_TOKEN], maxInstances: 5, timeoutSeconds: 120 },
  async request => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
    const db = getFirestore();
    if ((await callerRole(db, request.auth)) !== 'admin') {
      throw new HttpsError('permission-denied', 'Only an admin can view the CRM dashboard.');
    }

    const wantFresh = request.data?.refresh === true;
    if (!wantFresh && cache.snapshot && Date.now() - cache.at < SNAPSHOT_CACHE_MS) {
      return { snapshot: cache.snapshot, cached: true };
    }

    try {
      const snapshot = await fetchCrmSnapshot({ token: GHL_CRM_DASHBOARD_TOKEN.value().trim() });
      cache = { at: Date.now(), snapshot };
      return { snapshot, cached: false };
    } catch (error) {
      // The message is already token-free (scrubbed at the client layer), but
      // the status decides what the console tells the admin.
      const status = error instanceof HighLevelError ? error.status : 0;
      console.error('[flg-crm] snapshot failed:', error.message);
      if (status === 503 || status === 401 || status === 403) {
        throw new HttpsError('failed-precondition', 'The HighLevel dashboard token is missing, expired, or lacks access.');
      }
      if (status === 429) {
        throw new HttpsError('resource-exhausted', 'HighLevel is rate limiting. Try again in a minute.');
      }
      throw new HttpsError('unavailable', 'HighLevel could not be reached. Try again shortly.');
    }
  }
);
