// Server-owned pre-dial screening for carrier-backed AI/artificial-voice calls.
//
// Consent answers "may this seller use an artificial voice for this person and
// number?"  It does not answer whether the number is currently valid, still
// belongs to that person, or appears on a do-not-call source.  Those are
// separate, time-bounded facts.  This module keeps them separate and requires
// all of them to be fresh immediately before an AI call can leave the system.

import { createHash } from 'node:crypto';
import { normalizePhone } from './prospect-normalization.js';

export const PRE_DIAL_SCREENING_POLICY_VERSION = 'ai-pre-dial-screening/2026-08-24';
export const MAX_SCREENING_AGE_MS = 31 * 24 * 60 * 60 * 1000;

// These line types can receive a voice call.  Pager, voicemail-only, premium,
// shared-cost and unknown classifications fail closed until reviewed.
export const CALLABLE_LINE_TYPES = new Set([
  'mobile', 'landline', 'fixedvoip', 'nonfixedvoip', 'tollfree', 'uan'
]);

const asDate = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    try { return asDate(value.toDate()); } catch { return null; }
  }
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
};

const dateKey = value => {
  const date = asDate(value);
  if (!date) return '';
  return date.toISOString().slice(0, 10).replaceAll('-', '');
};

const normalizedType = value => String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '');

export function screeningPhoneHash(sellerAccountId, phoneE164) {
  const seller = String(sellerAccountId || '').trim().toLowerCase();
  const phone = normalizePhone(phoneE164);
  if (!seller || !phone) return '';
  return createHash('sha256').update(`${seller}\n${phone}`).digest('hex');
}

export function preDialScreeningId(sellerAccountId, phoneE164) {
  const fingerprint = screeningPhoneHash(sellerAccountId, phoneE164);
  return fingerprint ? `screen_${fingerprint}` : '';
}

export function requiresExternalPreDialScreening({ campaign = {}, automatedVoice = false } = {}) {
  const provider = String(campaign.provider || '').trim().toLowerCase();
  return automatedVoice === true && provider !== 'mock';
}

const sourceFresh = (source, now) => {
  const checkedAt = asDate(source?.checkedAt);
  const expiresAt = asDate(source?.expiresAt);
  if (!checkedAt || checkedAt.getTime() > now.getTime()) return false;
  if (now.getTime() - checkedAt.getTime() > MAX_SCREENING_AGE_MS) return false;
  return Boolean(expiresAt && expiresAt.getTime() > now.getTime());
};

/**
 * Pure admission verdict.  No single provider response authorises a call: the
 * seller/phone binding, DNC snapshots, number reassignment result, validation,
 * line type, consent-date query, policy version and freshness must all agree.
 */
export function evaluatePreDialScreening({
  screening = null,
  campaign = {},
  phoneE164 = '',
  consent = {},
  now = new Date()
} = {}) {
  const reasons = [];
  const sellerAccountId = String(campaign.accountId || '').trim().toLowerCase();
  const expectedHash = screeningPhoneHash(sellerAccountId, phoneE164);
  const checkedAt = asDate(screening?.checkedAt);
  const expiresAt = asDate(screening?.expiresAt);

  if (!screening || typeof screening !== 'object') {
    return { eligible: false, reasons: ['external_screening_missing'], checkedAt: null, expiresAt: null };
  }
  if (screening.policyVersion !== PRE_DIAL_SCREENING_POLICY_VERSION) {
    reasons.push('external_screening_policy_mismatch');
  }
  if (!sellerAccountId || String(screening.sellerAccountId || '').trim().toLowerCase() !== sellerAccountId) {
    reasons.push('external_screening_seller_mismatch');
  }
  if (!expectedHash || screening.phoneHash !== expectedHash) {
    reasons.push('external_screening_phone_mismatch');
  }
  if (screening.status !== 'cleared') reasons.push('external_screening_not_cleared');
  if (!checkedAt || checkedAt.getTime() > now.getTime()
      || now.getTime() - checkedAt.getTime() > MAX_SCREENING_AGE_MS
      || !expiresAt || expiresAt.getTime() <= now.getTime()) {
    reasons.push('external_screening_stale');
  }

  if (screening?.nationalDnc?.status !== 'clear'
      || !String(screening?.nationalDnc?.snapshotId || '').trim()
      || !sourceFresh(screening?.nationalDnc, now)) {
    reasons.push('national_dnc_not_cleared');
  }
  if (screening?.entityDnc?.status !== 'clear' || !sourceFresh(screening?.entityDnc, now)) {
    reasons.push('entity_dnc_not_cleared');
  }

  const reassigned = String(screening?.reassignedNumber?.status || '').trim().toLowerCase();
  if (reassigned !== 'no' || !sourceFresh(screening?.reassignedNumber, now)) {
    reasons.push(reassigned === 'yes' ? 'number_reassigned' : 'reassigned_number_not_cleared');
  }
  const consentDateKey = dateKey(consent?.grantedAt);
  if (!consentDateKey || String(screening?.reassignedNumber?.lastVerifiedDate || '') !== consentDateKey) {
    reasons.push('reassigned_number_consent_date_mismatch');
  }

  if (screening?.phoneValidation?.valid !== true || !sourceFresh(screening?.phoneValidation, now)) {
    reasons.push('phone_validation_not_cleared');
  }
  const lineType = normalizedType(screening?.lineType?.type);
  if (!CALLABLE_LINE_TYPES.has(lineType) || !sourceFresh(screening?.lineType, now)) {
    reasons.push('line_type_not_callable');
  }

  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], checkedAt, expiresAt, lineType };
}

export async function resolvePreDialScreening(db, {
  campaign = {}, phoneE164 = '', consent = {}, now = new Date()
} = {}) {
  const id = preDialScreeningId(campaign.accountId, phoneE164);
  if (!id) return evaluatePreDialScreening({ screening: null, campaign, phoneE164, consent, now });
  const snapshot = await db.doc(`preDialScreenings/${id}`).get();
  const screening = snapshot.exists ? snapshot.data() : null;
  return {
    id,
    screening,
    ...evaluatePreDialScreening({ screening, campaign, phoneE164, consent, now })
  };
}

const responseField = (object, snake, camel) => object?.[snake] ?? object?.[camel] ?? null;

/**
 * Query Twilio Lookup without writing or authorising anything.  Paid packages
 * are used only when the caller explicitly invokes this function with active
 * credentials; staging and tests inject fetch and never incur a lookup charge.
 */
export async function queryTwilioLookupScreening({
  phoneE164,
  consentGrantedAt,
  accountSid,
  authToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000
} = {}) {
  const phone = normalizePhone(phoneE164);
  const lastVerifiedDate = dateKey(consentGrantedAt);
  if (!phone || !lastVerifiedDate) throw new Error('A valid phone and consent date are required for reassigned-number screening');
  if (!/^AC[0-9a-f]{32}$/i.test(String(accountSid || '')) || !String(authToken || '').trim()) {
    throw new Error('Twilio Lookup credentials are not configured');
  }
  const url = new URL(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}`);
  url.searchParams.set('Fields', 'line_type_intelligence,reassigned_number');
  url.searchParams.set('LastVerifiedDate', lastVerifiedDate);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(15000, Number(timeoutMs) || 5000)));
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'Twilio Lookup timed out' : 'Twilio Lookup is unavailable');
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(`Twilio Lookup failed with HTTP ${response.status}`);
  if (normalizePhone(responseField(body, 'phone_number', 'phoneNumber')) !== phone) {
    throw new Error('Twilio Lookup returned a different phone number');
  }
  const line = responseField(body, 'line_type_intelligence', 'lineTypeIntelligence') || {};
  const reassigned = responseField(body, 'reassigned_number', 'reassignedNumber') || {};
  return {
    provider: 'twilio_lookup_v2',
    phoneValid: body.valid === true,
    lineType: responseField(line, 'type', 'type') || '',
    lineTypeErrorCode: responseField(line, 'error_code', 'errorCode'),
    reassignedStatus: responseField(reassigned, 'is_number_reassigned', 'isNumberReassigned') || '',
    reassignedErrorCode: responseField(reassigned, 'error_code', 'errorCode'),
    lastVerifiedDate
  };
}

/** Compose a bounded ledger record after independent DNC and Lookup checks. */
export function composePreDialScreening({
  sellerAccountId,
  phoneE164,
  consentGrantedAt,
  nationalDnc,
  entityDnc,
  lookup,
  now = new Date()
} = {}) {
  const phoneHash = screeningPhoneHash(sellerAccountId, phoneE164);
  const checkedAt = asDate(now);
  const expiresAt = new Date(checkedAt.getTime() + MAX_SCREENING_AGE_MS);
  const source = value => ({
    ...value,
    checkedAt: asDate(value?.checkedAt) || checkedAt,
    expiresAt: asDate(value?.expiresAt) || expiresAt
  });
  return {
    policyVersion: PRE_DIAL_SCREENING_POLICY_VERSION,
    sellerAccountId: String(sellerAccountId || '').trim().toLowerCase(),
    phoneHash,
    status: 'cleared',
    checkedAt,
    expiresAt,
    nationalDnc: source({
      status: String(nationalDnc?.status || '').trim().toLowerCase(),
      snapshotId: String(nationalDnc?.snapshotId || '').trim(),
      provider: String(nationalDnc?.provider || '').trim()
    }),
    entityDnc: source({
      status: String(entityDnc?.status || '').trim().toLowerCase(),
      provider: 'bitesites_suppression_ledger'
    }),
    reassignedNumber: source({
      status: String(lookup?.reassignedStatus || '').trim().toLowerCase(),
      lastVerifiedDate: String(lookup?.lastVerifiedDate || dateKey(consentGrantedAt)),
      errorCode: lookup?.reassignedErrorCode ?? null,
      provider: String(lookup?.provider || '').trim()
    }),
    phoneValidation: source({ valid: lookup?.phoneValid === true, provider: String(lookup?.provider || '').trim() }),
    lineType: source({
      type: String(lookup?.lineType || '').trim(),
      errorCode: lookup?.lineTypeErrorCode ?? null,
      provider: String(lookup?.provider || '').trim()
    })
  };
}
