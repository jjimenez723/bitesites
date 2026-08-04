// The calling-provider registry.
//
// One import site for every dialer, and one place that answers "can this
// provider actually do what this campaign is asking for?" — `assertSupports`
// below is what turns an unverified capability into a refusal at campaign save
// time rather than a surprise halfway through a parallel session.

import { CallingProviderAdapter, CALL_DISPOSITIONS, CALL_EVENT_TYPES, callEvent, eventId } from './adapter.js';
import { MockDialer } from './mock-dialer.js';
import { KixieDialer } from './kixie.js';
import { GoHighLevelDialer } from './gohighlevel.js';
import { TwilioDialer } from './twilio.js';

export { CallingProviderAdapter, CALL_DISPOSITIONS, CALL_EVENT_TYPES, callEvent, eventId };

const REGISTRY = new Map([
  [MockDialer.id, MockDialer],
  [KixieDialer.id, KixieDialer],
  [GoHighLevelDialer.id, GoHighLevelDialer],
  [TwilioDialer.id, TwilioDialer]
]);

export const CALLING_PROVIDER_IDS = [...REGISTRY.keys()];

export function getCallingProvider(id, config = {}) {
  const Provider = REGISTRY.get(String(id || ''));
  if (!Provider) throw new Error(`Unknown calling provider: ${id}`);
  return new Provider(config);
}

/** Capability matrix for the Settings screen. Never includes a credential. */
export const describeCallingProviders = () =>
  [...REGISTRY.values()].map(Provider => ({
    id: Provider.id,
    label: Provider.label,
    requiredSecrets: Provider.requiredSecrets,
    capabilities: Provider.capabilities,
    limitations: Provider.limitations || []
  }));

/** What a campaign mode needs from its provider. */
const MODE_REQUIREMENTS = {
  ai: ['aiAgentCall'],
  power: ['powerDial'],
  parallel: ['parallelDial', 'perLegCallIds', 'humanAnswerDetection', 'cancelCallLeg']
};

/**
 * Refuse a campaign whose provider cannot do what its mode requires.
 *
 * Parallel is the one that matters. Its whole safety argument is "detect the
 * first human answer, then cancel the rest" — a provider missing either half
 * would leave BiteSites ringing five people with nobody able to hang up the
 * four who lose. So the check is structural, not advisory.
 */
export function assertSupports(providerId, mode, concurrency = 1) {
  const Provider = REGISTRY.get(String(providerId || ''));
  if (!Provider) return { ok: false, missing: ['unknown_provider'] };

  const required = MODE_REQUIREMENTS[mode] || [];
  const missing = required.filter(capability => Provider.capabilities[capability] !== true);

  const limit = Number(Provider.capabilities.maxConcurrency || 1);
  if (Number(concurrency) > limit) missing.push(`max_concurrency_${limit}`);

  return {
    ok: missing.length === 0,
    missing,
    limitations: Provider.limitations || []
  };
}
