// What kind of line is behind a phone number, derived from public numbering data.
//
// ---------------------------------------------------------------------------
// THIS IS TRIAGE DATA. IT IS NOT SCREENING EVIDENCE. IT NEVER BECOMES CONSENT.
// ---------------------------------------------------------------------------
//
// Everything here answers "what was this block of numbers handed out for?" —
// which is useful for prioritising a queue, for spotting that a quarter of a
// scraped corpus is mobile, and for deciding what to pay a carrier to verify.
// It answers none of the questions `pre-dial-screening.js` asks. Specifically:
//
//   * It cannot see number portability. A landline ported to a mobile keeps its
//     original NPA-NXX forever, so a number this module calls `landline` may be
//     ringing in someone's pocket. Estimates of ported US numbers run to a large
//     minority of all numbers, and nothing in the free data marks them.
//   * It is not a DNC check, a reassignment check, or a validity check.
//   * The upstream source disclaims completeness and correctness (see SOURCE).
//
// So `phoneIntel.evidenceGrade` is the constant `triage`, every write goes to
// the prospect/lead document, and **nothing in this file writes to
// `preDialScreenings` or `consentGrants`**. That separation is deliberate and
// load-bearing: in August 2026 this repository had a defect where a provider
// that verified nothing could write production screening evidence that the dial
// gate then accepted. Do not reintroduce that shape by teaching the compliance
// path to read `phoneIntel`. Twilio Lookup remains the only registered provider
// that can answer the compliance questions, and it costs money on purpose.
//
// ---------------------------------------------------------------------------
// Why the key is NPA-NXX-X and not NPA-NXX
// ---------------------------------------------------------------------------
//
// Thousands-block pooling splits a single central-office code into ten blocks
// of 1,000 numbers, and the blocks can belong to different carriers of
// different types. Verified live on 2026-08-26, 201-552 alone splits as:
//
//   block 0, 1, 8 -> OMNIPOINT COMMUNICATIONS (W, wireless)
//   block 2       -> COMCAST IP PHONE (C)
//   block 5       -> CABLEVISION LIGHTPATH (C)
//   block A       -> the whole-code record, used when no block record exists
//
// Classifying 201-552-4949 from the code's first record would have called it
// wireless when block 4 is a CLEC. One HTTP request returns every block, so
// keying on the block costs nothing extra and is simply correct.

import { clean } from './prospect-normalization.js';

// No `Timestamp` or `FieldValue` import, unlike its neighbours in this
// directory, and the reason is not style.
//
// This module is called from two places that resolve `firebase-admin` to two
// different installed copies: the Functions runtime uses `functions/node_modules`,
// while `scripts/backfill-phone-intelligence.mjs` runs from the repository root
// and gets the root copy. A `Timestamp` minted by one copy fails the other's
// `instanceof` check, and Firestore rejects the write with "Detected an object
// of type Timestamp that doesn't match the expected instance".
//
// Plain JS `Date` has no such problem — the client converts it on the way out
// regardless of which copy created it. So every time written here is a `Date`,
// and `readTime` below tolerates whichever shape comes back on the way in.

/**
 * The source, and its terms, recorded here rather than in a commit message.
 *
 * localcallingguide.com republishes NANPA/telecom numbering data and offers an
 * XML query endpoint. Checked 2026-08-26: `robots.txt` disallows only
 * `/cgi-bin/`, and this endpoint is not under it. The site describes itself as
 * a **non-commercial project** and states that commercial use is at your own
 * risk and that the data is not guaranteed complete or correct.
 *
 * That shapes how this module behaves, and the constraints are not negotiable
 * decoration:
 *
 *   * Every result is cached for `EXCHANGE_TTL_DAYS`, so an exchange is fetched
 *     once and reused by every number behind it. The 12,695-prospect corpus has
 *     5,683 distinct exchanges — the cache is the difference between 5,683
 *     requests and 12,075.
 *   * `backfillPhoneIntel` throttles and takes a hard `limit`. Do not remove it.
 *   * The bot identifies itself, exactly as the research fetcher does.
 *
 * If this becomes a routine bulk dependency, move to the authoritative NANPA
 * CO Code / Thousands-Block reports and feed them through
 * `ingestExchangeRecords` instead. That is one file download rather than
 * thousands of requests against a volunteer's server, and it is the better
 * citizen as well as the better data.
 */
export const SOURCE_ID = 'localcallingguide_xmlprefix';
export const SOURCE_URL = 'https://localcallingguide.com/xmlprefix.php';
export const USER_AGENT = 'BiteSitesResearchBot/1.0 (+https://bitesites.org/; contact@bitesites.org)';

/** Numbering assignments change rarely; a stale block is a wrong answer for months either way. */
export const EXCHANGE_TTL_DAYS = 180;
export const PHONE_INTEL_EVIDENCE_GRADE = 'triage';
export const PHONE_INTEL_VERSION = 1;

const FETCH_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2_000_000;

/**
 * NANPA company types.
 *
 * `W` is wireless. `I` is the incumbent local exchange carrier — a traditional
 * landline. `C` is a competitive carrier, which in practice is where most
 * business VoIP lives; it is deliberately not called "landline", because a CLEC
 * block is exactly where a softphone or a forwarded mobile tends to sit.
 * Anything else stays unknown rather than being guessed into a bucket.
 */
export const LINE_TYPE_BY_COMPANY_TYPE = Object.freeze({
  W: 'wireless',
  I: 'landline',
  C: 'voip_or_clec'
});

/** Line types where an unattended artificial voice is the highest-risk choice. */
export const ELEVATED_RISK_LINE_TYPES = Object.freeze(['wireless']);

const digitsOf = value => String(value || '').replace(/\D/g, '');

/**
 * Sanitiser for identifier fields, as opposed to prose.
 *
 * `clean` is the repository's text sanitiser and it maps the string "0" to "".
 * That is fine for a carrier name and wrong for anything whose legitimate value
 * can *be* "0" — which here means the thousands-block digit. It bit this file
 * twice: once in the parser, where it silently dropped every block-0 record,
 * and once in `buildPhoneIntel`, where it stored an empty `block` on 194
 * production rows before anyone looked. Line types were still correct both
 * times because resolution uses the raw digit, but a record you cannot audit
 * back to its block is a record you have to take on faith.
 *
 * Identifiers are short, known-shape and never rendered as prose, so a trim and
 * a length cap is the whole job.
 */
const identifier = (value, maxLen) => String(value ?? '').trim().slice(0, maxLen);

/**
 * Split a US/Canada number into the parts the numbering data is keyed by.
 * Returns null for anything outside NANP, including toll-free — a toll-free
 * number has no geographic exchange and asking for one returns noise.
 */
export function exchangeKeyFor(phoneE164) {
  const match = /^\+1([2-9]\d{2})([2-9]\d{2})(\d)\d{3}$/.exec(String(phoneE164 || '').trim());
  if (!match) return null;
  const [, npa, nxx, block] = match;
  // Toll-free codes are assigned nationally with no rate centre, so a lookup
  // would burn a request to learn nothing.
  if (TOLL_FREE_NPAS.has(npa)) return null;
  return { npa, nxx, block, exchangeId: `${npa}-${nxx}` };
}

const TOLL_FREE_NPAS = new Set(['800', '833', '844', '855', '866', '877', '888']);

/**
 * Pull every `<prefixdata>` record out of an XML response.
 *
 * A hand-rolled extractor rather than an XML dependency: the response carries a
 * large DOCTYPE entity table, the fields wanted are five flat scalars, and the
 * repository already parses provider HTML this way in `lead-enrichment.js`.
 * Malformed input yields an empty list, never a throw — an upstream outage must
 * degrade to "unknown", not to a failed import.
 */
export function parseExchangeXml(xml) {
  const text = String(xml || '');
  const records = [];
  const blockPattern = /<prefixdata>([\s\S]*?)<\/prefixdata>/g;
  let match;
  while ((match = blockPattern.exec(text)) !== null) {
    const body = match[1];
    // Two readers on purpose. `clean` is the repository's text sanitiser and it
    // treats the string "0" as empty — reasonable for a company name, fatal for
    // a thousands-block digit, where block 0 is a real block and dropping it
    // silently reclassified every number in it. Raw for identifiers, cleaned
    // for anything that will be rendered.
    const raw = name => {
      const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
      return found ? found[1].trim().slice(0, 160) : '';
    };
    const field = name => clean(raw(name), 160);
    const npa = digitsOf(raw('npa'));
    const nxx = digitsOf(raw('nxx'));
    if (npa.length !== 3 || nxx.length !== 3) continue;
    // `x` is the thousands-block digit, or `A` when the record covers the whole
    // code. Anything else is a shape this parser does not claim to understand.
    const rawBlock = raw('x').toUpperCase();
    const block = /^[0-9]$/.test(rawBlock) ? rawBlock : rawBlock === 'A' ? 'A' : '';
    if (!block) continue;
    const companyType = field('company-type').toUpperCase().slice(0, 1);
    records.push({
      npa,
      nxx,
      block,
      companyType,
      lineType: LINE_TYPE_BY_COMPANY_TYPE[companyType] || '',
      carrier: field('company-name'),
      ocn: field('ocn'),
      rateCenter: field('rc'),
      region: field('region'),
      lata: field('lata')
    });
  }
  return records;
}

/** Records keyed by block, which is the shape the cache document stores. */
export function blocksFromRecords(records = []) {
  const blocks = {};
  for (const record of records) {
    if (!record?.block) continue;
    // First record wins. The endpoint returns the whole-code `A` row and the
    // per-block rows together, and a later duplicate for the same block is a
    // historical artefact rather than a correction.
    if (!blocks[record.block]) {
      blocks[record.block] = {
        companyType: record.companyType,
        lineType: record.lineType,
        carrier: record.carrier,
        ocn: record.ocn,
        rateCenter: record.rateCenter,
        region: record.region,
        lata: record.lata
      };
    }
  }
  return blocks;
}

/**
 * The block record covering a specific number.
 * Falls back to the whole-code `A` record, which is what exists for codes that
 * were never pooled. Returns null when neither is present.
 */
export function resolveBlock(blocks = {}, block = '') {
  if (block && blocks[block]) return blocks[block];
  if (blocks.A) return blocks.A;
  return null;
}

/** The `phoneIntel` sub-document. Always the same shape, so a query can rely on it. */
export function buildPhoneIntel({ key, record, source = SOURCE_ID, now = new Date() } = {}) {
  const resolved = record || {};
  const lineType = clean(resolved.lineType, 20);
  return {
    version: PHONE_INTEL_VERSION,
    // The single most important field on this object. It is a constant, not a
    // parameter, so no caller can talk this data into a higher grade.
    evidenceGrade: PHONE_INTEL_EVIDENCE_GRADE,
    status: lineType ? 'resolved' : 'unknown',
    lineType,
    // Kept beside the mapped value so an operator can see the raw NANPA code
    // rather than trusting this file's mapping of it.
    companyType: identifier(resolved.companyType, 4),
    carrier: clean(resolved.carrier, 120),
    ocn: identifier(resolved.ocn, 12),
    rateCenter: clean(resolved.rateCenter, 80),
    region: identifier(resolved.region, 8),
    lata: identifier(resolved.lata, 8),
    exchangeId: identifier(key?.exchangeId, 12),
    block: identifier(key?.block, 2),
    // Portability is the known blind spot; storing it as an explicit false is
    // the difference between "we checked and it is fine" and "we never asked".
    portabilityChecked: false,
    source: clean(source, 60),
    checkedAt: now
  };
}

/** The shape written when a number cannot be looked up at all. */
export function unresolvablePhoneIntel({ reason = 'no_nanp_exchange', now = new Date() } = {}) {
  return {
    ...buildPhoneIntel({ key: null, record: null, source: SOURCE_ID, now }),
    status: 'not_applicable',
    reason: clean(reason, 60)
  };
}

const expiryFrom = (now, ttlDays) => new Date(now.getTime() + ttlDays * 86_400_000);

/**
 * A stored time, whatever shape it comes back as.
 *
 * Firestore hands back a `Timestamp`, an in-memory fake hands back whatever it
 * was given, and this module writes plain `Date`s for the reason at the top of
 * the file. All three have to read the same, and an unparseable value must mean
 * "no expiry recorded" rather than "expired in 1970".
 */
/**
 * Firestore status codes that mean "ask again", not "you asked wrongly".
 * 4 DEADLINE_EXCEEDED, 8 RESOURCE_EXHAUSTED, 10 ABORTED, 13 INTERNAL,
 * 14 UNAVAILABLE. Anything else is a bug in the caller and must surface.
 */
const TRANSIENT_FIRESTORE_CODES = new Set([4, 8, 10, 13, 14]);

/**
 * Retry a Firestore write through a transient failure.
 *
 * A backfill spends most of its life asleep between throttled lookups, and a
 * gRPC channel that has been idle for seconds at a time will eventually have a
 * commit time out. Observed on the first production run: 200 documents in, a
 * single `set` failed with DEADLINE_EXCEEDED after 514 seconds and took the
 * whole process with it. The cursor meant no work was lost, but a job that
 * needs babysitting every few hundred records is a job nobody finishes.
 */
export async function withFirestoreRetry(operation, {
  attempts = 4,
  baseDelayMs = 500,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const code = Number(error?.code);
      if (!TRANSIENT_FIRESTORE_CODES.has(code) || attempt === attempts - 1) throw error;
      await sleepImpl(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function readTime(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') {
    try { return value.toDate(); } catch { return null; }
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * One exchange, from cache when possible.
 *
 * The cache is the whole point: 12,075 numbers collapse to 5,683 exchanges, and
 * an exchange is worth re-reading roughly twice a year. A cached miss (an
 * exchange the source has no record of) is cached too — otherwise every import
 * re-asks the same unanswerable question.
 */
export async function lookupExchange(db, key, {
  fetchImpl = globalThis.fetch,
  now = new Date(),
  ttlDays = EXCHANGE_TTL_DAYS,
  force = false,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!key?.exchangeId) return { blocks: {}, cached: false, fetched: false, reason: 'no_exchange' };
  const ref = db.doc(`numberingExchanges/${key.exchangeId}`);
  const snapshot = await withFirestoreRetry(() => ref.get(), { sleepImpl });
  if (!force && snapshot.exists) {
    const expiresAt = readTime(snapshot.get('expiresAt'));
    if (!expiresAt || expiresAt.getTime() > now.getTime()) {
      return { blocks: snapshot.get('blocks') || {}, cached: true, fetched: false };
    }
  }

  const url = `${SOURCE_URL}?npa=${key.npa}&nxx=${key.nxx}`;
  let records = [];
  let error = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml,text/xml' },
        signal: controller.signal,
        redirect: 'follow'
      });
      if (!response?.ok) throw new Error(`source responded ${response?.status ?? 'with no status'}`);
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES) throw new Error('source response too large');
      records = parseExchangeXml(body);
    } finally {
      clearTimeout(timer);
    }
  } catch (caught) {
    error = clean(caught?.message, 200) || 'lookup_failed';
  }

  if (error) {
    // A transient upstream failure must not poison the cache with an empty
    // answer that then reads as authoritative for six months.
    return { blocks: snapshot.exists ? snapshot.get('blocks') || {} : {}, cached: snapshot.exists, fetched: false, error };
  }

  const blocks = blocksFromRecords(records);
  await withFirestoreRetry(() => ref.set({
    npa: key.npa,
    nxx: key.nxx,
    blocks,
    blockCount: Object.keys(blocks).length,
    source: SOURCE_ID,
    fetchedAt: now,
    expiresAt: expiryFrom(now, ttlDays),
    updatedAt: now
  }, { merge: true }), { sleepImpl });
  return { blocks, cached: false, fetched: true };
}

/**
 * Resolve one number to a `phoneIntel` object without writing a contact record.
 * Separated from the document update so the console can show an operator what a
 * number resolves to before anything is stored.
 */
export async function resolvePhoneIntel(db, phoneE164, options = {}) {
  const now = options.now || new Date();
  const key = exchangeKeyFor(phoneE164);
  if (!key) return { intel: unresolvablePhoneIntel({ now }), key: null, fetched: false };
  const result = await lookupExchange(db, key, { ...options, now });
  const record = resolveBlock(result.blocks, key.block);
  const intel = buildPhoneIntel({ key, record, now });
  if (result.error) intel.reason = clean(result.error, 60);
  return { intel, key, fetched: result.fetched, cached: result.cached, error: result.error || '' };
}

/**
 * Fill `phoneIntel` on a bounded slice of a collection.
 *
 * Bounded, throttled and resumable on purpose — see SOURCE. `throttleMs` is the
 * gap between *network* calls; cache hits do not wait, which is what makes a
 * re-run over an already-enriched corpus fast and free.
 *
 * The query deliberately does not filter on `phoneIntel` — a Firestore
 * inequality/missing-field filter would need its own index and would skip
 * documents written before the field existed, which is every document today.
 * Instead it pages by document id and skips in memory, so a resumed run picks
 * up exactly where `cursor` left off.
 */
export async function backfillPhoneIntel(db, {
  collection = 'prospects',
  limit = 250,
  pageSize = 200,
  cursor = '',
  fetchImpl = globalThis.fetch,
  now = new Date(),
  ttlDays = EXCHANGE_TTL_DAYS,
  throttleMs = 1500,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  refresh = false,
  // A rehearsal writes no contact document, but it DOES populate the exchange
  // cache. That is deliberate and worth stating plainly: the cache is shared,
  // idempotent and the expensive half of the job, so a dry run that discarded
  // it would make the real run fetch all 5,683 exchanges a second time from a
  // volunteer's server. Rehearsing the cheap half twice is not worth that.
  dryRun = false,
  onProgress = null
} = {}) {
  const stats = {
    scanned: 0, updated: 0, skipped: 0, fetched: 0, cached: 0, errors: 0,
    byLineType: {}, cursor: clean(cursor, 400), done: false
  };
  let last = stats.cursor;

  while (stats.updated < limit) {
    let query = db.collection(collection).orderBy('__name__').limit(pageSize);
    if (last) query = query.startAfter(last);
    // Reads need the same retry as writes, and for the same reason. The first
    // production run died here, not on a write: a throttled loop leaves the
    // gRPC channel idle long enough that the next page query times out.
    const page = await withFirestoreRetry(() => query.get(), { sleepImpl });
    if (page.empty) { stats.done = true; break; }

    for (const doc of page.docs) {
      // The cursor must name the last document actually handled. Advancing it
      // before the limit check would hand back a cursor pointing past a
      // document this run never touched, and a resumed run would skip it.
      if (stats.updated >= limit) break;
      stats.scanned += 1;

      const existing = doc.get('phoneIntel');
      if (!refresh && existing?.version === PHONE_INTEL_VERSION && existing?.status !== 'unknown') {
        stats.skipped += 1;
        last = doc.id;
        continue;
      }
      const phoneE164 = doc.get('phoneE164') || '';
      const key = exchangeKeyFor(phoneE164);
      if (!key) {
        if (!dryRun) {
          await withFirestoreRetry(
            () => doc.ref.set({ phoneIntel: unresolvablePhoneIntel({ now }), updatedAt: now }, { merge: true }),
            { sleepImpl }
          );
        }
        stats.updated += 1;
        stats.byLineType.not_applicable = (stats.byLineType.not_applicable || 0) + 1;
        last = doc.id;
        continue;
      }

      const result = await lookupExchange(db, key, { fetchImpl, now, ttlDays });
      if (result.error) stats.errors += 1;
      if (result.fetched) stats.fetched += 1;
      if (result.cached) stats.cached += 1;

      const record = resolveBlock(result.blocks, key.block);
      const intel = buildPhoneIntel({ key, record, now });
      if (!dryRun) {
        await withFirestoreRetry(
          () => doc.ref.set({ phoneIntel: intel, updatedAt: now }, { merge: true }),
          { sleepImpl }
        );
      }
      stats.updated += 1;
      last = doc.id;
      const bucket = intel.lineType || 'unknown';
      stats.byLineType[bucket] = (stats.byLineType[bucket] || 0) + 1;
      if (onProgress) onProgress({ ...stats, cursor: last });

      // Only a live request earns a pause.
      if (result.fetched && throttleMs > 0) await sleepImpl(throttleMs);
    }

    if (page.size < pageSize) { stats.done = true; break; }
  }

  stats.cursor = last;
  return stats;
}

/**
 * Load exchange records from an authoritative bulk file.
 *
 * The upgrade path named in SOURCE. Rows are whatever a NANPA CO Code or
 * Thousands-Block report parses into; this only requires npa, nxx, block and a
 * company type, so a caller can map a report's columns without this module
 * knowing the report's layout. Bulk-loaded exchanges get a source of
 * `nanpa_bulk` so a later reader can tell which answers came from the
 * authoritative file and which from the community mirror.
 */
export async function ingestExchangeRecords(db, rows = [], { now = new Date(), ttlDays = EXCHANGE_TTL_DAYS } = {}) {
  const grouped = new Map();
  for (const row of rows) {
    const npa = digitsOf(row?.npa).slice(0, 3);
    const nxx = digitsOf(row?.nxx).slice(0, 3);
    if (npa.length !== 3 || nxx.length !== 3) continue;
    const rawBlock = String(row?.block ?? '').trim().toUpperCase();
    const block = /^[0-9]$/.test(rawBlock) ? rawBlock : rawBlock === 'A' ? 'A' : '';
    if (!block) continue;
    const companyType = String(row?.companyType || '').toUpperCase().slice(0, 1);
    const id = `${npa}-${nxx}`;
    if (!grouped.has(id)) grouped.set(id, { npa, nxx, records: [] });
    grouped.get(id).records.push({
      npa, nxx, block, companyType,
      lineType: LINE_TYPE_BY_COMPANY_TYPE[companyType] || '',
      carrier: clean(row?.carrier, 120),
      ocn: identifier(row?.ocn, 12),
      rateCenter: clean(row?.rateCenter, 80),
      region: identifier(row?.region, 8),
      lata: identifier(row?.lata, 8)
    });
  }

  let written = 0;
  for (const [id, entry] of grouped) {
    const blocks = blocksFromRecords(entry.records);
    await withFirestoreRetry(() => db.doc(`numberingExchanges/${id}`).set({
      npa: entry.npa,
      nxx: entry.nxx,
      blocks,
      blockCount: Object.keys(blocks).length,
      source: 'nanpa_bulk',
      fetchedAt: now,
      expiresAt: expiryFrom(now, ttlDays),
      updatedAt: now
    }, { merge: true }));
    written += 1;
  }
  return { exchanges: written };
}
