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

import { resolveTimezone } from './prospect-normalization.js';

export const DEFAULT_CALLING_WINDOW = {
  // Federal telemarketing practice in the US is 8am–9pm local. The default here
  // is deliberately tighter than the legal maximum: an operator who wants the
  // full window has to choose it, and a misconfigured campaign fails closed.
  localStartTime: '09:00',
  localEndTime: '18:00',
  allowedDays: ['mon', 'tue', 'wed', 'thu', 'fri']
};

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

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
  internalDoNotCall = false
} = {}) {
  const reasons = [];

  const phoneE164 = target.phoneE164 || contact.phoneE164 || '';
  if (!phoneE164) reasons.push('no_valid_phone');

  if (internalDoNotCall || contact.contactability?.doNotCall === true) reasons.push('do_not_call');
  if (suppressed) reasons.push('suppressed');
  if (contact.lifecycle?.status === 'do_not_contact') reasons.push('do_not_contact');
  if (target.state === 'invalid_number') reasons.push('invalid_number');

  const maxAttempts = Number(target.maxAttempts ?? campaign.maxAttempts ?? 3);
  if (Number.isFinite(maxAttempts) && Number(target.attemptCount || 0) >= maxAttempts) {
    reasons.push('max_attempts_reached');
  }

  const retryDelayMinutes = Number(campaign.retryDelayMinutes ?? 60);
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

  return {
    eligible: reasons.length === 0,
    reasons,
    checkedAt: now,
    consentBasis: String(campaign.consentBasis || 'not_recorded'),
    doNotCall: reasons.includes('do_not_call') || reasons.includes('do_not_contact'),
    localTimeAllowed: window.allowed,
    timezone,
    // Disclosure requirements are campaign settings, surfaced here so the call
    // brief and the UI read them from one place. Defaulting both to true means
    // an unconfigured campaign discloses more, not less.
    recordingDisclosureRequired: campaign.recordingDisclosureRequired !== false,
    aiDisclosureRequired: campaign.mode === 'ai' ? campaign.aiDisclosureRequired !== false : false
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
  invalid_caller_id: 'Campaign caller ID is missing or not E.164'
};

/**
 * The disclosure lines an AI agent must say. Returned as data rather than baked
 * into a prompt so the campaign script cannot omit them by accident and a test
 * can assert their presence.
 */
export function requiredDisclosures(compliance) {
  const lines = [];
  if (compliance.aiDisclosureRequired) {
    lines.push('State clearly, in the first sentence, that you are an AI assistant calling on behalf of BiteSites. Never claim or imply that you are a human.');
  }
  if (compliance.recordingDisclosureRequired) {
    lines.push('State that the call is recorded and transcribed before discussing anything else, and stop the call immediately if the person objects.');
  }
  lines.push('If the person asks not to be called again, confirm it, end the call politely, and do not attempt to overcome the objection.');
  return lines;
}
