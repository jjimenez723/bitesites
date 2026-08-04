// A lead source that invents nothing and calls nobody.
//
// Every automated test in the discovery pipeline runs against this, and it is
// the default for a new job so an operator can see the whole
// discover → normalise → dedupe → review flow before a single provider key
// exists. Its records are deterministic from the criteria, so a test can assert
// exact counts and a re-run produces the same ids (which is also how the
// idempotency tests get their duplicates).

import { LeadSourceAdapter } from './adapter.js';

const TOWNS = [
  { city: 'Ridgewood', region: 'NJ', postalCode: '07450', areaCode: '201' },
  { city: 'Montclair', region: 'NJ', postalCode: '07042', areaCode: '973' },
  { city: 'Hoboken', region: 'NJ', postalCode: '07030', areaCode: '201' },
  { city: 'Yonkers', region: 'NY', postalCode: '10701', areaCode: '914' },
  { city: 'Stamford', region: 'CT', postalCode: '06901', areaCode: '203' }
];

const SUFFIXES = ['& Sons', 'Group', 'Services', 'Co.', 'LLC', 'Associates'];

const PAGE_SIZE = 25;

export class MockLeadSource extends LeadSourceAdapter {
  static id = 'mock';
  static label = 'Mock source (no network)';
  static executionMode = 'cloud_function';
  static requiredSecrets = [];
  static supportsRadius = true;

  async validateConfig() { return { valid: true, errors: [] }; }

  supports() { return true; }

  /**
   * One deterministic page. `cursor` is the offset; `done` is the honest end of
   * the corpus rather than a page that happens to come back short, because the
   * job runner uses it to decide between "resume" and "completed".
   */
  async discover(criteria = {}, cursor = null) {
    const offset = Number(cursor?.offset || 0);
    const total = Math.min(Number(criteria.maximumResults) || 40, 400);
    const keyword = (Array.isArray(criteria.keywords) ? criteria.keywords[0] : criteria.keywords)
      || criteria.category || 'business';
    const records = [];

    for (let index = offset; index < Math.min(offset + PAGE_SIZE, total); index += 1) {
      const town = TOWNS[index % TOWNS.length];
      const suffix = SUFFIXES[index % SUFFIXES.length];
      const slug = String(keyword).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business';
      // Every fifth record is a deliberate near-duplicate of the one before it
      // (same business, different source id and formatting) so the dedupe stage
      // has something real to catch in a demo and in the tests.
      const twinOf = index % 5 === 4 ? index - 1 : null;
      const seed = twinOf ?? index;
      const seedTown = TOWNS[seed % TOWNS.length];

      records.push({
        placeId: `mock-${slug}-${index}`,
        name: `${slug.replace(/-/g, ' ')} ${seed + 1} ${suffix}`,
        phone: twinOf === null
          ? `(${town.areaCode}) 555-${String(1000 + index).slice(-4)}`
          : `+1${seedTown.areaCode}555${String(1000 + seed).slice(-4)}`,
        email: index % 3 === 0 ? `info@${slug}${seed + 1}.example.com` : '',
        website: index % 4 === 1 ? '' : `https://www.${slug}${seed + 1}.example.com/`,
        address: {
          line1: `${100 + seed} Main St`,
          city: seedTown.city,
          region: seedTown.region,
          postalCode: seedTown.postalCode,
          country: 'US'
        },
        category: criteria.category || slug,
        rating: 3 + ((index % 20) / 10),
        reviewCount: 5 + (index % 90),
        lat: 40.9 + index * 0.001,
        lng: -74.1 - index * 0.001,
        _twinOf: twinOf
      });
    }

    return {
      records,
      cursor: { offset: offset + records.length },
      done: offset + records.length >= total
    };
  }

  sourceIdentity(raw) {
    return { provider: MockLeadSource.id, providerRecordId: raw.placeId || '' };
  }

  normalize(raw) {
    return {
      name: raw.name,
      companyName: raw.name,
      phone: raw.phone,
      email: raw.email,
      website: raw.website,
      address: raw.address,
      category: raw.category,
      rating: raw.rating,
      reviewCount: raw.reviewCount,
      lat: raw.lat,
      lng: raw.lng,
      externalId: raw.placeId,
      sourceUrl: `https://example.com/mock/${raw.placeId}`
    };
  }

  async healthCheck() { return { ok: true, detail: 'Mock source is always available.' }; }
}
