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
