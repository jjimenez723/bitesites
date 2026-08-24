// Technical guardrails on who may be dialled, and when.
//
// Pure and synchronous so the queue view, the dialer and the AI campaign runner
// all reach the same verdict from the same inputs — a compliance rule that only
// exists on the server is one the operator cannot see coming, and a rule that
// only exists in the UI is one the server does not enforce.
//
// IMPORTANT: none of this is legal advice and none of it makes a campaign
// lawful. It enforces the settings an administrator configured. Consent basis,
// jurisdictions, calling hours, recording rules, AI disclosure, scripts,
// opt-out handling and automated-dialing rules all require review by counsel
// before a campaign runs — see OUTBOUND_CALLING_SETUP.md.

import { normalizePhone, resolveTimezone } from './prospect-normalization.js';
import { getAccount } from './accounts.js';
import { requiresExternalPreDialScreening } from './pre-dial-screening.js';

export const DEFAULT_CALLING_WINDOW = {
  // Federal telemarketing practice in the US is 8am–9pm local. The default here
  // is deliberately tighter than the legal maximum: an operator who wants the
  // full window has to choose it, and a misconfigured campaign fails closed.
  localStartTime: '09:00',
  localEndTime: '18:00',
  allowedDays: ['mon', 'tue', 'wed', 'thu', 'fri']
};

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// These are server-side launch limits, not UI defaults. Legacy production
// campaign documents can still contain the old 3-leg/3-attempt values, so every
// admission path must derive the effective values again immediately before it
// dials. The mock provider keeps broader limits for deterministic state-machine
// tests; any carrier-backed provider starts with one live leg and one attempt.
export function resolveCampaignOperatingLimits(campaignInput = {}) {
  const campaign = campaignInput || {};
  const isMock = String(campaign.provider || '').trim().toLowerCase() === 'mock';
  const configuredConcurrency = Math.max(1, Math.min(5, Number(campaign.concurrency) || 1));
  const configuredMaxAttempts = Math.max(1, Math.min(10, Number(campaign.maxAttempts) || 1));
  const configuredRetryDelayMinutes = Math.max(
    15,
    Math.min(10080, Number(campaign.retryDelayMinutes) || 1440)
  );

  return {
    concurrency: isMock ? configuredConcurrency : 1,
    maxAttempts: isMock ? configuredMaxAttempts : 1,
    retryDelayMinutes: isMock ? configuredRetryDelayMinutes : Math.max(1440, configuredRetryDelayMinutes)
  };
}

const parseTimeOfDay = value => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

/**
 * Wall-clock day/minute in an IANA zone, without pulling in a date library.
 * `Intl` already ships the tz database; formatToParts is the supported way to
 * read a local time, and it handles DST transitions correctly — which naive
 * offset arithmetic does not, twice a year, in the direction that authorises an
 * out-of-hours call.
 */
export function localClock(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const read = type => parts.find(part => part.type === type)?.value || '';
  const weekday = read('weekday').toLowerCase().slice(0, 3);
  // 'hour: 2-digit' with hour12:false renders midnight as '24' in some ICU
  // versions — normalise it before it becomes a 1440-minute "tomorrow".
  const hour = Number(read('hour')) % 24;
  const minute = Number(read('minute'));
  return { weekday, minutes: hour * 60 + minute, hour, minute };
}

/**
 * Is `date` inside the campaign's local calling window for this timezone?
 *
 * `campaign` is normalised rather than defaulted: callers legitimately pass an
 * explicit `null` (a session being torn down has no campaign in hand), and a
 * default parameter does not cover null — which threw here rather than falling
 * back to the safe default window.
 */
export function withinCallingWindow(date, timezone, campaignInput) {
  if (!timezone) return { allowed: false, reason: 'unknown_timezone' };
  const campaign = campaignInput || {};

  const start = parseTimeOfDay(campaign.localStartTime) ?? parseTimeOfDay(DEFAULT_CALLING_WINDOW.localStartTime);
  const end = parseTimeOfDay(campaign.localEndTime) ?? parseTimeOfDay(DEFAULT_CALLING_WINDOW.localEndTime);
  if (start === null || end === null || end <= start) return { allowed: false, reason: 'invalid_calling_window' };

  const days = Array.isArray(campaign.allowedDays) && campaign.allowedDays.length
    ? campaign.allowedDays.map(day => String(day).toLowerCase().slice(0, 3))
    : DEFAULT_CALLING_WINDOW.allowedDays;

  let clock;
  try {
    clock = localClock(date, timezone);
  } catch {
    return { allowed: false, reason: 'unknown_timezone' };
  }

  if (!days.includes(clock.weekday)) return { allowed: false, reason: 'outside_allowed_days', clock };
  if (clock.minutes < start || clock.minutes >= end) return { allowed: false, reason: 'outside_calling_hours', clock };
  return { allowed: true, reason: '', clock };
}

/** When this timezone next enters the window — what the retry scheduler uses. */
export function nextWindowOpening(date, timezone, campaign) {
  if (!timezone) return null;
  const step = 15 * 60 * 1000;
  // A week of quarter-hours is 672 probes: cheap, and it terminates even for a
  // campaign whose allowed days never include today.
  for (let attempt = 1; attempt <= 672; attempt += 1) {
    const candidate = new Date(date.getTime() + attempt * step);
    if (withinCallingWindow(candidate, timezone, campaign).allowed) return candidate;
  }
  return null;
}

const consentDate = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    try { return consentDate(value.toDate()); } catch { return null; }
  }
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
};

/**
 * The narrow permission check for an AI/artificial-voice interaction.
 *
 * This intentionally reads only the consent snapshot stamped onto the target.
 * A campaign-level basis, a generic source note, or a subsequently edited
 * contact must not retroactively authorise an already-queued number. A target
 * must be re-admitted after documented consent is added, which leaves an
 * auditable trail of exactly what was approved for the call.
 */
export function evaluateAIVoiceConsent({ target = {}, campaign = {}, phoneE164 = '' } = {}) {
  const consent = target?.consent && typeof target.consent === 'object' ? target.consent : {};
  const reasons = [];
  const expectedSeller = String(campaign.accountId || '').trim().toLowerCase();
  const consentSeller = String(consent.sellerAccountId || '').trim().toLowerCase();
  const expectedPhone = normalizePhone(phoneE164 || target.phoneE164);
  const consentPhone = normalizePhone(consent.phoneE164 || consent.phone);
  const basis = String(consent.basis || 'not_recorded').trim().toLowerCase();
  const grantId = String(consent.grantId || '').trim();
  const grantedAt = consentDate(consent.grantedAt);
  const reviewedAt = consentDate(consent.reviewedAt);
  const expiresAt = consentDate(consent.expiresAt);
  const now = consentDate(consent.checkedAt) || new Date();
  const verified = consent.verificationState === 'verified'
    && consent.status === 'active'
    && Boolean(grantId)
    && Boolean(String(consent.evidenceArtifactId || '').trim())
    && Boolean(String(consent.disclosureVersion || '').trim())
    && Boolean(String(consent.reviewedBy || '').trim())
    && Boolean(reviewedAt);

  // Initial production policy: only a written, seller-specific opt-in is an
  // AI voice authorisation. Inbound interest/EBR may support future, counsel-
  // approved workflows, but they are not silently upgraded here.
  if (basis !== 'written_opt_in' || !verified || !grantedAt
      || grantedAt.getTime() > now.getTime()
      || (expiresAt && expiresAt.getTime() <= now.getTime())
      || consent.revokedAt || consent.status === 'revoked') {
    reasons.push('ai_consent_not_documented');
  }
  if (!expectedSeller || !consentSeller || consentSeller !== expectedSeller) {
    reasons.push('ai_consent_seller_mismatch');
  }
  if (!expectedPhone || !consentPhone || consentPhone !== expectedPhone) {
    reasons.push('ai_consent_phone_mismatch');
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    basis,
    grantId,
    sellerAccountId: consentSeller,
    phoneE164: consentPhone,
    grantedAt
  };
}

/**
 * Resolve the opaque grant id against the server-owned immutable ledger.
 * Imported evidence is only a candidate; it never authorises an AI call by
 * itself. Missing, revoked, expired, or malformed ledger entries return an
 * unverified snapshot that the pure gate rejects.
 */
export async function resolveAIVoiceConsent(db, {
  target = {}, campaign = {}, phoneE164 = '', now = new Date()
} = {}) {
  const candidate = target?.consent && typeof target.consent === 'object' ? target.consent : {};
  const grantId = String(candidate.grantId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(grantId)) return { ...candidate, verificationState: 'unverified', checkedAt: now };
  const snapshot = await db.doc(`consentGrants/${grantId}`).get();
  if (!snapshot.exists) return { ...candidate, grantId, verificationState: 'unverified', checkedAt: now };
  const grant = snapshot.data() || {};
  return {
    grantId,
    basis: String(grant.basis || 'not_recorded'),
    sellerAccountId: String(grant.sellerAccountId || ''),
    phoneE164: normalizePhone(grant.phoneE164),
    evidenceArtifactId: String(grant.evidenceArtifactId || ''),
    disclosureVersion: String(grant.disclosureVersion || ''),
    grantedAt: grant.grantedAt || null,
    reviewedAt: grant.reviewedAt || null,
    reviewedBy: String(grant.reviewedBy || ''),
    expiresAt: grant.expiresAt || null,
    revokedAt: grant.revokedAt || null,
    status: String(grant.status || ''),
    verificationState: 'verified',
    checkedAt: now
  };
}

/**
 * The full eligibility verdict for one target (§40).
 *
 * `suppressed` is the campaign's suppression list plus the internal DNC list,
 * already resolved by the caller — this function does no I/O so that the queue
 * view can render the same verdict the dialer will enforce.
 */
export function evaluateCompliance({
  target = {},
  contact = {},
  campaign = {},
  now = new Date(),
  suppressed = false,
  internalDoNotCall = false,
  automatedVoice = false,
  externalScreening = null
} = {}) {
  const reasons = [];

  const phoneE164 = target.phoneE164 || contact.phoneE164 || '';
  if (!phoneE164) reasons.push('no_valid_phone');

  if (internalDoNotCall || contact.contactability?.doNotCall === true) reasons.push('do_not_call');
  if (suppressed) reasons.push('suppressed');
  if (contact.lifecycle?.status === 'do_not_contact') reasons.push('do_not_contact');
  if (target.state === 'invalid_number') reasons.push('invalid_number');

  const operatingLimits = resolveCampaignOperatingLimits(campaign);
  const targetMaxAttempts = Number(target.maxAttempts ?? operatingLimits.maxAttempts);
  const maxAttempts = Math.min(
    Number.isFinite(targetMaxAttempts) ? targetMaxAttempts : operatingLimits.maxAttempts,
    operatingLimits.maxAttempts
  );
  if (Number.isFinite(maxAttempts) && Number(target.attemptCount || 0) >= maxAttempts) {
    reasons.push('max_attempts_reached');
  }

  const retryDelayMinutes = operatingLimits.retryDelayMinutes;
  const lastAttemptAt = target.lastAttemptAt instanceof Date
    ? target.lastAttemptAt
    : target.lastAttemptAt?.toDate?.() || null;
  if (lastAttemptAt && retryDelayMinutes > 0
      && now.getTime() - lastAttemptAt.getTime() < retryDelayMinutes * 60 * 1000) {
    reasons.push('retry_delay_not_elapsed');
  }

  const timezone = target.timezone
    || contact.location?.timezone
    || resolveTimezone({ region: contact.address?.region, phoneE164 });

  const window = withinCallingWindow(now, timezone, campaign);
  if (!window.allowed) reasons.push(window.reason);

  const callerId = String(campaign.callerId || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(callerId)) reasons.push('invalid_caller_id');

  // `campaign.mode` covers autonomous AI campaigns. Hybrid sessions can
  // attach an AI controller under a parallel campaign, so their dial path
  // passes `automatedVoice` explicitly. Human-only paths remain unchanged.
  const aiVoiceRequired = campaign.mode === 'ai' || automatedVoice === true;
  const aiConsent = aiVoiceRequired
    ? evaluateAIVoiceConsent({ target, campaign, phoneE164 })
    : { eligible: true, reasons: [], basis: '' };
  reasons.push(...aiConsent.reasons);
  const externalScreeningRequired = requiresExternalPreDialScreening({
    campaign, automatedVoice: aiVoiceRequired
  });
  if (externalScreeningRequired && externalScreening?.eligible !== true) {
    reasons.push(...(Array.isArray(externalScreening?.reasons) && externalScreening.reasons.length
      ? externalScreening.reasons
      : ['external_screening_missing']));
  }
  const seller = getAccount(campaign.accountId);

  return {
    eligible: reasons.length === 0,
    reasons,
    checkedAt: now,
    // Report the target-level evidence basis, never a campaign-wide label.
    // The latter is campaign metadata, not consent for this individual number.
    consentBasis: aiVoiceRequired ? aiConsent.basis : String(campaign.consentBasis || 'not_recorded'),
    aiVoiceConsent: aiConsent,
    externalScreening: externalScreeningRequired
      ? {
          eligible: externalScreening?.eligible === true,
          id: String(externalScreening?.id || ''),
          checkedAt: externalScreening?.checkedAt || null,
          expiresAt: externalScreening?.expiresAt || null,
          lineType: String(externalScreening?.lineType || '')
        }
      : { eligible: true, id: '', checkedAt: null, expiresAt: null, lineType: '' },
    doNotCall: reasons.includes('do_not_call') || reasons.includes('do_not_contact'),
    localTimeAllowed: window.allowed,
    timezone,
    sellerName: seller?.legalName || '',
    // AI identity is not an operator preference. Every path that can attach an
    // artificial voice discloses it. Audio recording remains disabled until a
    // post-answer consent command and retention controls are implemented.
    recordingDisclosureRequired: false,
    aiDisclosureRequired: aiVoiceRequired
  };
}

/** Human copy for the queue and the Import Review screen. */
export const COMPLIANCE_REASON_LABELS = {
  no_valid_phone: 'No dialable phone number',
  do_not_call: 'On the internal Do Not Call list',
  do_not_contact: 'Marked do-not-contact',
  suppressed: 'On a campaign suppression list',
  invalid_number: 'Provider reported the number as invalid',
  max_attempts_reached: 'Maximum attempts reached',
  retry_delay_not_elapsed: 'Minimum retry delay has not elapsed',
  unknown_timezone: 'Timezone unknown — local calling hours cannot be verified',
  invalid_calling_window: 'Campaign calling window is misconfigured',
  outside_allowed_days: 'Outside the campaign’s allowed days',
  outside_calling_hours: 'Outside local calling hours',
  invalid_caller_id: 'Campaign caller ID is missing or not E.164',
  ai_consent_not_documented: 'AI calling requires documented written consent for this number',
  ai_consent_seller_mismatch: 'AI consent is not documented for this seller',
  ai_consent_phone_mismatch: 'AI consent does not match the dialled number',
  external_screening_missing: 'Current DNC, reassigned-number, and line screening is missing',
  external_screening_policy_mismatch: 'Pre-dial screening uses an obsolete policy',
  external_screening_seller_mismatch: 'Pre-dial screening belongs to another seller',
  external_screening_phone_mismatch: 'Pre-dial screening belongs to another number',
  external_screening_not_cleared: 'Pre-dial screening has not cleared this number',
  external_screening_stale: 'Pre-dial screening has expired',
  national_dnc_not_cleared: 'National Do Not Call screening is missing or matched',
  entity_dnc_not_cleared: 'Seller-specific Do Not Call screening is missing or matched',
  number_reassigned: 'The number was reassigned after consent was obtained',
  reassigned_number_not_cleared: 'Reassigned-number screening is unavailable or inconclusive',
  reassigned_number_consent_date_mismatch: 'Reassigned-number screening did not use the consent date',
  phone_validation_not_cleared: 'The carrier could not validate this phone number',
  line_type_not_callable: 'The carrier line type is unknown or not callable'
};

/**
 * The disclosure lines an AI agent must say. Returned as data rather than baked
 * into a prompt so the campaign script cannot omit them by accident and a test
 * can assert their presence.
 */
export function requiredDisclosures(compliance) {
  const lines = [];
  if (compliance.aiDisclosureRequired) {
    const sellerName = String(compliance.sellerName || '').trim() || 'the seller identified in the approved call brief';
    lines.push(`State clearly, in the first sentence, that you are an AI assistant calling on behalf of ${sellerName}. Never claim or imply that you are a human.`);
  }
  if (compliance.recordingDisclosureRequired) {
    lines.push('State that the call is recorded and transcribed before discussing anything else, and stop the call immediately if the person objects.');
  }
  lines.push('If the person asks not to be called again, confirm it, end the call politely, and do not attempt to overcome the objection.');
  return lines;
}
