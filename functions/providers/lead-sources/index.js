// The lead-source registry.
//
// The rest of BiteSites talks to `discover()` / `normalize()` and never to a
// provider's raw response shape. That seam is what lets the Watcher corpus, a
// CSV, Google Places and a local Playwright worker all feed one Import Review
// screen — and what lets the whole discovery pipeline be tested against the
// mock source with no network, no key and no provider terms to honour.

import { LeadSourceAdapter } from './adapter.js';
import { MockLeadSource } from './mock-source.js';
import { CsvLeadSource } from './csv-source.js';
import { GooglePlacesLeadSource } from './google-places.js';
import { WatcherWorkflowSource } from './existing-watcher-source.js';
import { BiteSitesLeadsSource } from './existing-bitesites-leads-source.js';
import { GoHighLevelContactsSource } from './gohighlevel-contacts.js';

export { LeadSourceAdapter };

const REGISTRY = new Map([
  [MockLeadSource.id, MockLeadSource],
  [CsvLeadSource.id, CsvLeadSource],
  [GooglePlacesLeadSource.id, GooglePlacesLeadSource],
  [WatcherWorkflowSource.id, WatcherWorkflowSource],
  [BiteSitesLeadsSource.id, BiteSitesLeadsSource],
  [GoHighLevelContactsSource.id, GoHighLevelContactsSource]
]);

export const LEAD_SOURCE_IDS = [...REGISTRY.keys()];

export function getLeadSource(id, options = {}) {
  const Source = REGISTRY.get(String(id || ''));
  if (!Source) throw new Error(`Unknown lead source: ${id}`);
  return new Source(options);
}

/** What the Lead Discovery picker renders — never includes a credential. */
export const describeLeadSources = () =>
  [...REGISTRY.values()].map(Source => ({
    id: Source.id,
    label: Source.label,
    executionMode: Source.executionMode,
    requiredSecrets: Source.requiredSecrets,
    supportsRadius: Source.supportsRadius === true,
    supportsKeywords: Source.supportsKeywords !== false
  }));

/**
 * Criteria validation shared by every source, so an obviously-bad job is
 * rejected at creation rather than after it has burned a provider quota.
 */
export function validateCriteria(criteria = {}) {
  const errors = [];
  const keywords = Array.isArray(criteria.keywords) ? criteria.keywords.filter(Boolean) : [];
  if (!keywords.length && !criteria.category) errors.push('Enter at least one keyword or a category.');
  if (keywords.length > 10) errors.push('Use at most 10 keywords per job.');
  if (!criteria.location) errors.push('A location is required.');
  const radius = Number(criteria.radiusMiles ?? 0);
  if (radius && (radius < 1 || radius > 100)) errors.push('Radius must be between 1 and 100 miles.');
  const max = Number(criteria.maximumResults ?? 0);
  if (!max || max < 1 || max > 1000) errors.push('Maximum results must be between 1 and 1000.');
  return { valid: errors.length === 0, errors };
}
