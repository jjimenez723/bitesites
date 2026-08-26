// The screening provider registry.
//
// Same shape as the calling and lead-source registries: a map of id to class,
// a factory that throws on an unknown id rather than falling back to something
// that might dial, and a describe() that returns capability metadata and never
// a credential.

import { MockScreeningProvider } from './mock-screening.js';
import { TwilioLookupScreeningProvider } from './twilio-lookup.js';

const REGISTRY = new Map([
  [MockScreeningProvider.id, MockScreeningProvider],
  [TwilioLookupScreeningProvider.id, TwilioLookupScreeningProvider]
]);

export const SCREENING_PROVIDER_IDS = Object.freeze([...REGISTRY.keys()]);

/** Mock, because a provider chosen by accident must not be one that bills. */
export const DEFAULT_SCREENING_PROVIDER_ID = MockScreeningProvider.id;

export function getScreeningProvider(providerId, config = {}) {
  const id = String(providerId || DEFAULT_SCREENING_PROVIDER_ID).trim().toLowerCase();
  const Provider = REGISTRY.get(id);
  if (!Provider) throw new Error(`Unknown screening provider: ${id}`);
  return new Provider(config);
}

/** Capability metadata for the settings screen. Secret NAMES only. */
export function describeScreeningProviders() {
  return [...REGISTRY.values()].map(Provider => ({
    id: Provider.id,
    label: Provider.label,
    requiredSecrets: [...(Provider.requiredSecrets || [])],
    capabilities: { ...Provider.capabilities }
  }));
}

/** Does this provider bill per lookup? Read by the admission gate. */
export function screeningProviderIsPaid(providerId) {
  const Provider = REGISTRY.get(String(providerId || '').trim().toLowerCase());
  return Provider ? Provider.capabilities?.paidLookup === true : true;
}

/**
 * Does this provider get its answers from an outside authority?
 *
 * The second half of the admission decision, and the one that keeps simulated
 * evidence out of the production ledger. Unknown providers read as false for
 * the same reason unknown providers read as paid: the unsafe answer is the one
 * that must require a positive declaration.
 */
export function screeningProviderVerifies(providerId) {
  const Provider = REGISTRY.get(String(providerId || '').trim().toLowerCase());
  return Provider ? Provider.capabilities?.verifiesExternally === true : false;
}
