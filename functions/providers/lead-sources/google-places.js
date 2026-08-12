// Google Places (New) Text Search as a lead source.
//
// The credential, endpoint and field mask were verified against the live
// Places API on 2026-08-12. Before broad production use, confirm the current
// pricing tier and Terms of Service (in particular the caching and
// redistribution limits, which are stricter than most APIs) as
// LEAD_DISCOVERY_SETUP.md sets out.
//
// The adapter is written anyway because the seam is the deliverable: the job
// runner, dedupe and Import Review are exercised end to end by the mock source,
// and swapping this in is a key and a config flip rather than a rewrite.

import { LeadSourceAdapter } from './adapter.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

// Only the fields a prospect actually needs. Places bills by field mask, so an
// unfocused mask is a direct, recurring cost for data nobody reads.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.primaryType',
  'places.types',
  'places.rating',
  'places.userRatingCount',
  'places.location',
  'places.googleMapsUri',
  'nextPageToken'
].join(',');

const MILES_TO_METRES = 1609.34;

const componentOf = (components, type) =>
  (components || []).find(entry => (entry.types || []).includes(type)) || null;

export class GooglePlacesLeadSource extends LeadSourceAdapter {
  static id = 'google_places';
  static label = 'Google Places (New)';
  static executionMode = 'cloud_function';
  static requiredSecrets = ['LEAD_SOURCE_API_KEY'];
  static supportsRadius = true;

  constructor(options = {}) {
    super(options);
    this.apiKey = options.apiKey || '';
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  async validateConfig(criteria = {}) {
    const errors = [];
    if (!this.apiKey) errors.push('LEAD_SOURCE_API_KEY is not configured.');
    if (!criteria.location) errors.push('Google Places needs a location.');
    return { valid: errors.length === 0, errors };
  }

  supports(criteria) { return Boolean(criteria?.location); }

  async discover(criteria = {}, cursor = null) {
    if (!this.apiKey) throw new Error('LEAD_SOURCE_API_KEY is not configured');

    const keywords = Array.isArray(criteria.keywords) ? criteria.keywords : [criteria.keywords].filter(Boolean);
    const query = [keywords.join(' '), criteria.category, 'in', criteria.location]
      .filter(Boolean).join(' ').trim();

    const body = {
      textQuery: query,
      // Places caps a page at 20 and the token walk at 3 pages (60 results).
      // The job runner's own `maximumResults` sits on top of that; it cannot
      // raise this ceiling, and pretending otherwise would silently truncate.
      pageSize: 20,
      languageCode: 'en'
    };
    if (cursor?.pageToken) body.pageToken = cursor.pageToken;
    if (criteria.radiusMiles && criteria.lat && criteria.lng) {
      body.locationBias = {
        circle: {
          center: { latitude: Number(criteria.lat), longitude: Number(criteria.lng) },
          radius: Math.min(50000, Number(criteria.radiusMiles) * MILES_TO_METRES)
        }
      };
    }

    const response = await this.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': FIELD_MASK
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      // Never reflect the response body: a Places error can echo the request,
      // and the request carries the key in a header we would rather not see in
      // a Firestore error document.
      throw new Error(`Google Places returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const records = Array.isArray(payload.places) ? payload.places : [];
    const pageToken = payload.nextPageToken || '';
    return { records, cursor: pageToken ? { pageToken } : null, done: !pageToken };
  }

  sourceIdentity(raw) {
    return { provider: GooglePlacesLeadSource.id, providerRecordId: raw?.id || '' };
  }

  normalize(raw = {}) {
    const components = raw.addressComponents;
    return {
      name: raw.displayName?.text || '',
      companyName: raw.displayName?.text || '',
      phone: raw.internationalPhoneNumber || raw.nationalPhoneNumber || '',
      website: raw.websiteUri || '',
      address: components ? {
        line1: [componentOf(components, 'street_number')?.shortText, componentOf(components, 'route')?.shortText]
          .filter(Boolean).join(' '),
        city: componentOf(components, 'locality')?.longText
          || componentOf(components, 'postal_town')?.longText || '',
        region: componentOf(components, 'administrative_area_level_1')?.shortText || '',
        postalCode: componentOf(components, 'postal_code')?.shortText || '',
        country: componentOf(components, 'country')?.shortText || 'US'
      } : raw.formattedAddress || '',
      category: raw.primaryType || '',
      categories: raw.types || [],
      rating: raw.rating,
      reviewCount: raw.userRatingCount,
      lat: raw.location?.latitude,
      lng: raw.location?.longitude,
      externalId: raw.id,
      sourceUrl: raw.googleMapsUri || ''
    };
  }

  async healthCheck() {
    return this.apiKey
      ? { ok: true, detail: 'Key present; endpoint and field mask live-verified 2026-08-12.' }
      : { ok: false, detail: 'LEAD_SOURCE_API_KEY is not configured.' };
  }
}
