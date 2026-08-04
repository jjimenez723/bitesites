// Deciding whether a candidate is somebody we already have.
//
// Split in two on purpose:
//   * `classifyMatch` / `dedupeWithinBatch` are pure — the whole ranking is
//     testable without an emulator, and the migration script reuses them.
//   * `findDuplicates` does the Firestore lookups, keyed only off the indexed
//     dedupe fields so a 40k-prospect corpus never turns into a collection scan.
//
// The rule that shapes everything below: a strong identifier merges, a weak one
// only flags. Silently fusing two businesses because their names are similar
// loses a real prospect and, worse, can point a call at the wrong number — so a
// fuzzy hit becomes `possible` and lands in Import Review for a human.

import {
  normalizeCompanyKey, normalizeDomain, normalizeEmail, normalizePhone,
  emailDomain, isFreeEmailDomain, isDirectoryHost, hashKey
} from './prospect-normalization.js';

/** Strong signals merge on their own; weak ones only ever suggest a review. */
export const MATCH_WEIGHTS = {
  source_document: 1,
  provider_record_id: 1,
  phone: 0.95,
  business_email: 0.9,
  website_domain: 0.85,
  // Below the 0.8 confirm threshold by construction — see classifyMatch.
  company_and_city: 0.55,
  company_name: 0.35,
  free_email: 0.3
};

const CONFIRM_AT = 0.8;
const REVIEW_AT = 0.3;

/**
 * Why (and how strongly) two records look like the same business.
 * Returns `{ status, confidence, reasons }` where status is
 * 'unique' | 'possible' | 'confirmed'.
 */
export function classifyMatch(candidate, existing) {
  const reasons = [];

  const candidateSource = candidate.source || {};
  const existingSource = existing.source || {};

  if (candidateSource.sourceDocumentId
      && candidateSource.sourceDocumentId === existingSource.sourceDocumentId
      && candidateSource.sourceCollection === existingSource.sourceCollection
      && candidateSource.sourceProjectId === existingSource.sourceProjectId) {
    reasons.push('source_document');
  }

  if (candidateSource.providerRecordId
      && candidateSource.provider
      && candidateSource.providerRecordId === existingSource.providerRecordId
      && candidateSource.provider === existingSource.provider) {
    reasons.push('provider_record_id');
  }

  const candidatePhone = candidate.phoneE164 || normalizePhone(candidate.phone);
  const existingPhone = existing.phoneE164 || normalizePhone(existing.phone);
  if (candidatePhone && candidatePhone === existingPhone) reasons.push('phone');

  const candidateEmail = normalizeEmail(candidate.email);
  const existingEmail = normalizeEmail(existing.email);
  if (candidateEmail && candidateEmail === existingEmail) {
    // A shared gmail address is still the same mailbox and worth flagging, but
    // it is not the identity a business is known by — a couple who run two
    // businesses from one inbox is a real pattern in this corpus.
    reasons.push(isFreeEmailDomain(emailDomain(candidateEmail)) ? 'free_email' : 'business_email');
  }

  const candidateDomain = normalizeDomain(candidate.website || candidate.dedupe?.normalizedWebsite);
  const existingDomain = normalizeDomain(existing.website || existing.dedupe?.normalizedWebsite);
  if (candidateDomain && candidateDomain === existingDomain && !isDirectoryHost(candidateDomain)) {
    reasons.push('website_domain');
  }

  const candidateCompany = candidate.dedupe?.normalizedCompany || normalizeCompanyKey(candidate.companyName || candidate.name);
  const existingCompany = existing.dedupe?.normalizedCompany || normalizeCompanyKey(existing.companyName || existing.name);
  if (candidateCompany && candidateCompany === existingCompany) {
    const candidateCity = normalizeCompanyKey(candidate.address?.city || '');
    const existingCity = normalizeCompanyKey(existing.address?.city || '');
    reasons.push(candidateCity && candidateCity === existingCity ? 'company_and_city' : 'company_name');
  }

  if (!reasons.length) return { status: 'unique', confidence: 0, reasons: [] };

  // Take the strongest signal rather than summing. Three weak coincidences are
  // still three weak coincidences — summing them would cross the confirm
  // threshold and merge two same-named shops in neighbouring towns.
  const confidence = Math.max(...reasons.map(reason => MATCH_WEIGHTS[reason] ?? 0));
  const status = confidence >= CONFIRM_AT ? 'confirmed' : confidence >= REVIEW_AT ? 'possible' : 'unique';
  return { status, confidence: Number(confidence.toFixed(2)), reasons };
}

/**
 * Collapse duplicates inside one batch (a scrape job's results, a CSV file).
 *
 * Returns `{ unique, duplicates }`. Only a `confirmed` match folds a row into an
 * earlier one; a `possible` match is carried through so the reviewer still sees
 * both records, with the softer verdict attached.
 */
export function dedupeWithinBatch(prospects) {
  const unique = [];
  const duplicates = [];
  // Exact-key index first so the common case is O(1); the fuzzy pass only runs
  // over records that share a normalised company name.
  const byKey = new Map();
  const byCompany = new Map();

  for (const prospect of prospects) {
    const key = prospect.dedupe?.canonicalKey || '';
    let match = key ? byKey.get(key) : null;
    let verdict = match ? { status: 'confirmed', confidence: 1, reasons: ['canonical_key'] } : null;

    if (!match) {
      const company = prospect.dedupe?.normalizedCompany;
      for (const candidate of (company ? byCompany.get(company) || [] : [])) {
        const result = classifyMatch(prospect, candidate);
        if (result.status !== 'unique') { match = candidate; verdict = result; }
        if (result.status === 'confirmed') break;
      }
    }

    if (match && verdict?.status === 'confirmed') {
      duplicates.push({ prospect, duplicateOf: match, ...verdict });
      continue;
    }

    if (match && verdict?.status === 'possible') {
      prospect.duplicate = {
        ...prospect.duplicate,
        status: 'possible',
        duplicateOfType: 'prospect',
        duplicateOfId: match.__batchId || '',
        matchReasons: verdict.reasons,
        matchConfidence: verdict.confidence
      };
    }

    unique.push(prospect);
    if (key) byKey.set(key, prospect);
    const company = prospect.dedupe?.normalizedCompany;
    if (company) byCompany.set(company, [...(byCompany.get(company) || []), prospect]);
  }

  return { unique, duplicates };
}

// ------------------------------------------------------------- Firestore side

const MATCH_LIMIT = 5;

async function firstMatch(query) {
  const snapshot = await query.limit(MATCH_LIMIT).get();
  return snapshot.docs;
}

/**
 * Look for this prospect in `prospects`, `leads` and `outboundTargets`.
 *
 * Every query below hits an indexed equality field. There is deliberately no
 * fuzzy Firestore query: a company-name prefix scan over the whole collection
 * is the query that quietly becomes the most expensive thing the dashboard
 * does. Fuzzy matching happens in-batch (above) or in Import Review.
 */
export async function findDuplicates(db, prospect, { excludeId = '' } = {}) {
  const results = [];
  const seen = new Set([excludeId]);

  const record = (type, id, data) => {
    if (!id || seen.has(`${type}:${id}`)) return;
    const verdict = classifyMatch(prospect, data);
    if (verdict.status === 'unique') return;
    seen.add(`${type}:${id}`);
    results.push({ type, id, ...verdict });
  };

  const prospects = db.collection('prospects');

  if (prospect.dedupe?.canonicalKey) {
    for (const entry of await firstMatch(prospects.where('dedupe.canonicalKey', '==', prospect.dedupe.canonicalKey))) {
      if (entry.id !== excludeId) {
        // A canonical-key hit is the identity match by construction; it does
        // not need classifyMatch to agree about the individual fields.
        seen.add(`prospect:${entry.id}`);
        results.push({ type: 'prospect', id: entry.id, status: 'confirmed', confidence: 1, reasons: ['canonical_key'] });
      }
    }
  }

  if (prospect.dedupe?.phoneHash) {
    for (const entry of await firstMatch(prospects.where('dedupe.phoneHash', '==', prospect.dedupe.phoneHash))) {
      record('prospect', entry.id, entry.data());
    }
  }
  if (prospect.dedupe?.emailHash) {
    for (const entry of await firstMatch(prospects.where('dedupe.emailHash', '==', prospect.dedupe.emailHash))) {
      record('prospect', entry.id, entry.data());
    }
  }
  if (prospect.dedupe?.normalizedWebsite) {
    for (const entry of await firstMatch(prospects.where('dedupe.normalizedWebsite', '==', prospect.dedupe.normalizedWebsite))) {
      record('prospect', entry.id, entry.data());
    }
  }

  // The fuzzy pass, done as an EXACT equality query on the already-normalised
  // company key. That is the compromise §22 asks for: a real cross-batch check
  // (two imports a week apart still see each other) without the prefix scan
  // that would make this the most expensive query in the product. The result is
  // still only ever a review signal — classifyMatch scores a name-only hit
  // below the confirm threshold, so nothing merges on it.
  if (prospect.dedupe?.normalizedCompany) {
    for (const entry of await firstMatch(prospects.where('dedupe.normalizedCompany', '==', prospect.dedupe.normalizedCompany))) {
      record('prospect', entry.id, entry.data());
    }
  }

  // Inbound leads. Matching here is what stops the outbound engine cold-calling
  // somebody who already filled in the contact form last week. `leads` stores
  // the raw phone/email the visitor typed, so we compare normalised values.
  const leads = db.collection('leads');
  if (prospect.email) {
    for (const entry of await firstMatch(leads.where('email', '==', prospect.email))) {
      record('lead', entry.id, entry.data());
    }
  }
  if (prospect.phoneE164) {
    // Leads carry `phoneE164` only if a server path wrote it; fall back to the
    // raw field so pre-existing inbound leads still match.
    for (const entry of await firstMatch(leads.where('phoneE164', '==', prospect.phoneE164))) {
      record('lead', entry.id, entry.data());
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

/** The `duplicate` sub-document for a prospect, given what findDuplicates said. */
export function duplicateVerdict(matches) {
  const best = matches[0];
  if (!best) {
    return {
      status: 'unique', duplicateOfType: '', duplicateOfId: '',
      matchReasons: [], matchConfidence: 0, reviewedBy: '', reviewedAt: null
    };
  }
  return {
    status: best.status,
    duplicateOfType: best.type,
    duplicateOfId: best.id,
    matchReasons: best.reasons.slice(0, 8),
    matchConfidence: best.confidence,
    reviewedBy: '',
    reviewedAt: null
  };
}

/** Convenience for callers that only hold a raw phone/email pair. */
export const identityHashes = ({ phone, email }) => ({
  phoneHash: hashKey(normalizePhone(phone)),
  emailHash: hashKey(normalizeEmail(email))
});
