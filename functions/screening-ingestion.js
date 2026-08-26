// How screening evidence actually gets into the ledger.
//
// The dialer has required a fresh, seller-and-number-bound screening result
// since the gate was written, and it fails closed without one. What did not
// exist was any way to produce one: `preDialScreenings` was written by tests
// and by nothing else, so every carrier-backed AI call was blocked by evidence
// that no code path could ever supply.
//
// This module is that path. It is deliberately thin — the vendor query, the
// document shape and the eligibility rules all already existed in
// pre-dial-screening.js — and it adds the three things that were missing:
//
//   1. a provider seam, so the vendor is a choice rather than a hard-coded call
//   2. an admission gate, so a paid lookup cannot happen until someone
//      authorises the spend
//   3. the DNC inputs, which no vendor here supplies and which therefore have
//      to be handed in and recorded rather than assumed
//
// It writes `status: 'cleared'` documents only. There is no "screen everything
// and see what comes back" entry point, because a bulk sweep over a lead list
// is exactly the shape of an accidental five-figure vendor bill.

import { Timestamp } from 'firebase-admin/firestore';
import { clean, normalizePhone } from './prospect-normalization.js';
import { requireAccountId } from './accounts.js';
import { screeningAdmission } from './deployment-environment.js';
import { isSuppressed } from './inbound-compliance.js';
import { composePreDialScreening, preDialScreeningId } from './pre-dial-screening.js';
import {
  DEFAULT_SCREENING_PROVIDER_ID, getScreeningProvider, screeningProviderIsPaid,
  screeningProviderVerifies
} from './providers/screening/index.js';

const text = (value, max = 200) => clean(value, max);

const asDate = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    try { return asDate(value.toDate()); } catch { return null; }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

/**
 * National DNC is a subscription service nobody has procured yet, and there is
 * no snapshot collection in this repo to read one from. The evaluator requires
 * a non-empty `snapshotId`, so the caller must hand in a dated result from
 * whatever service is eventually enrolled. Refusing here rather than defaulting
 * is the difference between "not screened" and "screened against nothing".
 */
function requireNationalDnc(input) {
  const source = input && typeof input === 'object' ? input : {};
  const status = text(source.status, 20).toLowerCase();
  const snapshotId = text(source.snapshotId, 200);
  const checkedAt = asDate(source.checkedAt);
  if (status !== 'clear') throw new Error('A national DNC result of "clear" is required');
  if (!snapshotId) throw new Error('A national DNC snapshot id is required');
  if (!checkedAt) throw new Error('A national DNC checkedAt date is required');
  return {
    status, snapshotId, checkedAt,
    provider: text(source.provider, 120) || 'unspecified_dnc_service',
    ...(asDate(source.expiresAt) ? { expiresAt: asDate(source.expiresAt) } : {})
  };
}

/**
 * Entity-level suppression is ours, so it is read rather than handed in: the
 * server's own do-not-call ledger is the authority on whether this seller has
 * been asked to stop.
 */
export async function resolveEntitySuppression(db, { phoneE164, now = new Date() } = {}) {
  const phone = normalizePhone(phoneE164);
  if (!phone) throw new Error('A valid phone number is required');
  const suppressed = await isSuppressed(db, phone);
  return {
    status: suppressed ? 'suppressed' : 'clear',
    provider: 'bitesites_suppression_ledger',
    checkedAt: now
  };
}

/**
 * Screen one number and, if every check is clear, write the evidence.
 *
 * Returns a descriptor either way. A number that screens dirty is not an error
 * — it is a correct answer that must not become a ledger entry, because the
 * ledger only ever holds cleared results.
 */
export async function ingestPreDialScreening(db, {
  sellerAccountId, phoneE164, consentGrantedAt,
  providerId = DEFAULT_SCREENING_PROVIDER_ID,
  nationalDnc = null, providerConfig = {}, admissionValues = null,
  fetchImpl = null, now = new Date()
} = {}) {
  const accountId = requireAccountId(sellerAccountId, { field: 'screening.sellerAccountId' });
  const phone = normalizePhone(phoneE164);
  if (!phone) throw new Error('A valid E.164 phone number is required');
  const grantedAt = asDate(consentGrantedAt);
  // The reassignment answer is only meaningful relative to the consent date,
  // and the evaluator compares them. Without it the write would be guaranteed
  // to produce evidence that can never pass its own gate.
  if (!grantedAt) throw new Error('The consent grant date is required to screen a number');

  const paid = screeningProviderIsPaid(providerId);
  // Both halves of the admission question, and neither is inferable from the
  // other: the mock is free and fabricated, Twilio Lookup is billable and real.
  const verifies = screeningProviderVerifies(providerId);
  const admission = screeningAdmission(providerId, { paid, verifies, values: admissionValues });
  if (!admission.allowed) {
    return { ok: false, written: false, reason: admission.reason, admission, providerId };
  }

  const provider = getScreeningProvider(providerId, providerConfig);
  const lookup = await provider.screen({
    phoneE164: phone,
    consentGrantedAt: grantedAt,
    ...(fetchImpl ? { fetchImpl } : {})
  });

  const entityDnc = await resolveEntitySuppression(db, { phoneE164: phone, now });
  if (entityDnc.status !== 'clear') {
    return { ok: true, written: false, reason: 'entity_dnc_suppressed', providerId, entityDnc };
  }

  const dnc = requireNationalDnc(nationalDnc);
  const document = composePreDialScreening({
    sellerAccountId: accountId,
    phoneE164: phone,
    consentGrantedAt: grantedAt,
    nationalDnc: dnc,
    entityDnc,
    lookup,
    now
  });

  const id = preDialScreeningId(accountId, phone);
  await db.doc(`preDialScreenings/${id}`).set({
    ...document,
    checkedAt: Timestamp.fromDate(document.checkedAt),
    expiresAt: Timestamp.fromDate(document.expiresAt),
    ingestedBy: text(providerId, 60),
    ingestedAt: Timestamp.fromDate(now)
  });

  return {
    ok: true, written: true, id, providerId,
    checkedAt: document.checkedAt, expiresAt: document.expiresAt,
    lineType: document.lineType?.type || '',
    admission
  };
}
