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
 * Admission for a screening provider, on two independent questions.
 *
 * **Does it cost money?** Separate from `externalDialingAdmission` because the
 * two authorizations are genuinely separate: OUTBOUND_LAUNCH_AUTHORIZATION.md
 * §3 (paid Twilio Lookup and DNC scrubbing) has not been granted even though §1
 * and §2 have. A build that treated "we may deploy" as "we may spend" would
 * bill the owner for a decision they never made.
 *
 * **Are its answers real?** Free providers used to be admitted anywhere, on the
 * reasoning that the mock cannot clear a number for a real call because carrier
 * dialing has its own gate. That reasoning was wrong, and on 2026-08-25 it was
 * a live hole. The gates are not layered — they are independent conditions that
 * are all required, so "another gate is also closed" is not a reason to leave
 * this one open. `ingestPreDialScreening` writes `status: 'cleared'` documents,
 * `evaluatePreDialScreening` reads the verdicts inside them and never the
 * provider that produced them, and the mock derives its verdicts from the last
 * two digits of the phone number. So in a production project — which is what an
 * unset `BITESITES_DEPLOYMENT_ENVIRONMENT` resolves to — an admin picking
 * "mock" in a dropdown could mint screening evidence that satisfies the dial
 * gate completely, for a number nobody checked. Once external dialing is
 * enabled for the rehearsal cohort, that is the whole distance between a
 * dropdown and a stranger's phone.
 *
 * A provider that does not ask an outside authority is therefore refused in
 * production regardless of price, and `verifies` defaults to false so a caller
 * that forgets to pass it fails closed.
 */
export function screeningAdmission(providerId, { paid = true, verifies = false, values = null } = {}) {
  const provider = text(providerId) || 'mock';
  const environmentPolicy = resolveOutboundDeploymentPolicy(values);

  if (verifies !== true && environmentPolicy.environment === 'production') {
    return {
      allowed: false, provider, environment: environmentPolicy.environment,
      reason: 'non_verifying_provider_in_production', paidScreening: 'not_applicable'
    };
  }

  if (paid !== true) {
    return {
      allowed: true, provider, environment: environmentPolicy.environment,
      reason: 'unpaid_provider', paidScreening: 'not_applicable'
    };
  }

  const paidScreening = text(values?.paidScreening
    ?? parameterValue(PAID_PHONE_SCREENING, process.env.PAID_PHONE_SCREENING || 'disabled'));
  const policy = environmentPolicy;

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
  // Two refusals with different remedies. Reporting a simulated provider as a
  // spend problem would send an operator to authorise a budget that would not
  // have helped.
  const headline = admission.reason === 'non_verifying_provider_in_production'
    ? 'This screening provider does not verify anything and cannot write production evidence'
    : 'Paid phone screening is disabled';
  return `${headline} (${admission.reason}; environment=${admission.environment}; provider=${admission.provider}).`;
}
