// Single source of truth for the details that appear in the Terms of Service and
// Privacy Policy.
//
// TODO(bitesites): confirm these before publishing — they are the only values in
// the legal pages that were not derived from the codebase. An incorrect legal
// entity name or notice address can make the documents unenforceable.

export const LEGAL = {
  // Full registered entity name, e.g. "BiteSites LLC".
  entity: 'BiteSites',

  // Trading name shown in body copy.
  brand: 'BiteSites',

  site: 'bitesites.org',
  siteUrl: 'https://bitesites.org',

  // Address used for legal notices. Required for a valid notice clause.
  mailingAddress: '[Street address], New Jersey [ZIP], United States',

  contactEmail: 'jensy@bitesites.org',
  privacyEmail: 'privacy@bitesites.org',

  governingState: 'New Jersey',
  courtsVenue: 'the state and federal courts located in New Jersey',

  effectiveDate: 'July 21, 2026',
  lastUpdated: 'July 21, 2026'
};
