// Deployment environment admission for outbound telephony.
//
// This is intentionally a fail-closed gate. A Firebase project is not a safe
// staging environment merely because its data is separate: if it can reach the
// same carrier credentials, it can still call a real person. Only production
// with an explicit, deploy-time opt-in may originate an external call.

import { defineString } from 'firebase-functions/params';

export const BITESITES_DEPLOYMENT_ENVIRONMENT = defineString(
  'BITESITES_DEPLOYMENT_ENVIRONMENT',
  { default: 'production' }
);

export const OUTBOUND_EXTERNAL_DIALING = defineString(
  'OUTBOUND_EXTERNAL_DIALING',
  { default: 'disabled' }
);

const text = value => String(value || '').trim().toLowerCase();

function parameterValue(parameter, fallback = '') {
  try { return parameter.value() || fallback; }
  catch { return fallback; }
}

/**
 * Resolve the deploy-time policy without treating a missing value as approval.
 * `values` exists for deterministic unit tests; runtime callers should omit it.
 */
export function resolveOutboundDeploymentPolicy(values = null) {
  const environment = text(values?.environment
    ?? parameterValue(BITESITES_DEPLOYMENT_ENVIRONMENT, process.env.BITESITES_DEPLOYMENT_ENVIRONMENT || 'production'));
  const externalDialing = text(values?.externalDialing
    ?? parameterValue(OUTBOUND_EXTERNAL_DIALING, process.env.OUTBOUND_EXTERNAL_DIALING || 'disabled'));
  const resolvedEnvironment = environment || 'production';

  if (resolvedEnvironment !== 'production') {
    return {
      allowed: false,
      environment: resolvedEnvironment,
      reason: 'non_production_environment',
      externalDialing
    };
  }
  if (externalDialing !== 'enabled') {
    return {
      allowed: false,
      environment: resolvedEnvironment,
      reason: 'external_dialing_not_explicitly_enabled',
      externalDialing
    };
  }
  return { allowed: true, environment: resolvedEnvironment, reason: '', externalDialing };
}

/**
 * Mock calls never leave the process. Every carrier-backed provider is
 * considered external, including workflow enrolment that causes a provider to
 * dial later.
 */
export function externalDialingAdmission(providerId, values = null) {
  const provider = text(providerId) || 'mock';
  if (provider === 'mock') {
    return { allowed: true, provider, environment: 'test', reason: 'mock_provider' };
  }
  return { provider, ...resolveOutboundDeploymentPolicy(values) };
}

export function externalDialingBlockReason(providerId, values = null) {
  const admission = externalDialingAdmission(providerId, values);
  if (admission.allowed) return '';
  return `External dialing is disabled (${admission.reason}; environment=${admission.environment}; provider=${admission.provider}).`;
}

export const PAID_PHONE_SCREENING = defineString(
  'PAID_PHONE_SCREENING',
  { default: 'disabled' }
);

/**
 * Admission for a screening provider that bills per lookup.
 *
 * Separate from `externalDialingAdmission` because the two authorizations are
 * genuinely separate: OUTBOUND_LAUNCH_AUTHORIZATION.md §3 (paid Twilio Lookup
 * and DNC scrubbing) has not been granted even though §1 and §2 have. A build
 * that treated "we may deploy" as "we may spend" would bill the owner for a
 * decision they never made.
 *
 * Free providers are admitted anywhere. The mock cannot clear a number for a
 * real call regardless, because carrier dialing has its own gate.
 */
export function screeningAdmission(providerId, { paid = true, values = null } = {}) {
  const provider = text(providerId) || 'mock';
  if (paid !== true) {
    return { allowed: true, provider, environment: 'any', reason: 'unpaid_provider', paidScreening: 'not_applicable' };
  }

  const paidScreening = text(values?.paidScreening
    ?? parameterValue(PAID_PHONE_SCREENING, process.env.PAID_PHONE_SCREENING || 'disabled'));
  const policy = resolveOutboundDeploymentPolicy(values);

  if (policy.environment !== 'production') {
    return {
      allowed: false, provider, environment: policy.environment,
      reason: 'non_production_environment', paidScreening
    };
  }
  // Positive match only. Anything unset, empty or misspelled is a refusal.
  if (paidScreening !== 'enabled') {
    return {
      allowed: false, provider, environment: policy.environment,
      reason: 'paid_screening_not_explicitly_enabled', paidScreening
    };
  }
  return { allowed: true, provider, environment: policy.environment, reason: '', paidScreening };
}

export function screeningBlockReason(providerId, options = {}) {
  const admission = screeningAdmission(providerId, options);
  if (admission.allowed) return '';
  return `Paid phone screening is disabled (${admission.reason}; environment=${admission.environment}; provider=${admission.provider}).`;
}
