// Normalisation is pure, so this runs with plain `node --test` — no emulator,
// no credentials, no network. Every case below is one that produced a real bug
// in the source pipeline or would produce one here.
//
//   npm run test:prospects

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clean, normalizePhone, normalizeEmail, normalizeDomain, normalizeWebsite,
  normalizeCompanyKey, normalizeCompanyName, normalizeFirstName, splitPersonName,
  normalizeRegion, normalizePostalCode, parseAddressLine, resolveTimezone,
  normalizeCategories, normalizeList, toDate, dedupeKeys, buildProspect,
  validateProspect, deterministicId, isFreeEmailDomain, isDirectoryHost, hashKey
} from './prospect-normalization.js';

test('placeholder values become empty rather than truthy junk', () => {
  for (const value of ['N/A', 'none', 'NULL', '  -- ', 'no website', 'unknown', '#N/A']) {
    assert.equal(clean(value), '', `expected "${value}" to clean to ""`);
  }
  assert.equal(clean('  Real   Value  '), 'Real Value');
});

test('phone numbers normalise to E.164 and refuse what is not dialable', () => {
  assert.equal(normalizePhone('(201) 555-0142'), '+12015550142');
  assert.equal(normalizePhone('201.555.0142'), '+12015550142');
  assert.equal(normalizePhone('1-201-555-0142'), '+12015550142');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');

  // An extension is a dial string, not a destination — dialing the trunk and
  // landing in a phone tree looks like a working call in the logs.
  assert.equal(normalizePhone('201-555-0142 ext. 12'), '');
  assert.equal(normalizePhone('2015550142x9'), '');

  // A NANP area code never starts with 0 or 1.
  assert.equal(normalizePhone('(123) 555-0142'), '');
  assert.equal(normalizePhone('(023) 555-0142'), '');

  // Never guess a country code for something too short to have one.
  assert.equal(normalizePhone('5550142'), '');
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone('n/a'), '');
});

test('emails lowercase and reject non-addresses', () => {
  assert.equal(normalizeEmail('Info@Example.COM'), 'info@example.com');
  assert.equal(normalizeEmail('bad@@example.com'), '');
  assert.equal(normalizeEmail('no-at-sign'), '');
  assert.equal(normalizeEmail('a@b.c'), '');       // TLD too short
  assert.ok(isFreeEmailDomain('gmail.com'));
  assert.ok(!isFreeEmailDomain('bitesites.org'));
});

test('domains drop www and reject things that are not domains', () => {
  assert.equal(normalizeDomain('https://WWW.Foo.com/x?y=1'), 'foo.com');
  assert.equal(normalizeDomain('foo.com'), 'foo.com');
  assert.equal(normalizeDomain('http://192.168.1.1/'), '');
  assert.equal(normalizeDomain('localhost'), '');
  assert.equal(normalizeWebsite('www.foo.com/menu/'), 'https://foo.com/menu');
});

test('social and directory hosts are never a business identity', () => {
  assert.ok(isDirectoryHost('facebook.com'));
  assert.ok(isDirectoryHost('m.facebook.com'));
  assert.ok(isDirectoryHost('mysite.wixsite.com'));
  assert.ok(!isDirectoryHost('joespizza.com'));

  // Two different businesses whose only "website" is Facebook must not fuse.
  const a = dedupeKeys({ companyName: "Joe's Pizza", website: 'https://facebook.com/joes', phoneE164: '', email: '', address: { city: 'Ridgewood' }, source: {} });
  const b = dedupeKeys({ companyName: 'Mikes Deli', website: 'https://facebook.com/mikes', phoneE164: '', email: '', address: { city: 'Ridgewood' }, source: {} });
  assert.equal(a.normalizedWebsite, '');
  assert.notEqual(a.canonicalKey, b.canonicalKey);
});

test('company matching collapses legal suffixes and apostrophes', () => {
  assert.equal(normalizeCompanyKey('Bogush, Inc.'), 'bogush');
  assert.equal(normalizeCompanyKey('BOGUSH INC'), 'bogush');
  assert.equal(normalizeCompanyKey("Tony's Pizzeria"), 'tonys pizzeria');
  assert.equal(normalizeCompanyKey('TONYS PIZZERIA'), 'tonys pizzeria');
  // Stacked suffixes need the loop, not one pass.
  assert.equal(normalizeCompanyKey('Acme Co., Inc.'), 'acme');
});

test('display names fix shouting without flattening deliberate casing', () => {
  assert.equal(normalizeCompanyName('JOES PIZZA OF NJ'), 'Joes Pizza of NJ');
  assert.equal(normalizeCompanyName('BiteSites'), 'BiteSites');
  // Known initialisms survive; ordinary words do not pretend to be one.
  assert.equal(normalizeCompanyName('ACME HVAC LLC'), 'Acme HVAC LLC');
  assert.equal(normalizeCompanyName('acme hvac'), 'Acme HVAC');
});

test('role inboxes never become a first name', () => {
  assert.equal(normalizeFirstName('info'), '');
  assert.equal(normalizeFirstName('Contact'), '');
  // Length is the only tell for a concatenated local-part.
  assert.equal(normalizeFirstName('unclejoespizzawallington'), '');
  assert.equal(normalizeFirstName('dana'), 'Dana');
  assert.deepEqual(splitPersonName('Dana Okafor'), { firstName: 'Dana', lastName: 'Okafor' });
  assert.deepEqual(splitPersonName('info@x'), { firstName: '', lastName: '' });
});

test('regions and postcodes normalise, or stay empty', () => {
  assert.equal(normalizeRegion('New Jersey'), 'NJ');
  assert.equal(normalizeRegion('nj'), 'NJ');
  assert.equal(normalizeRegion('Ontario'), '');   // not a US state — no guess
  assert.equal(normalizePostalCode('07450-1234'), '07450');
  assert.equal(normalizePostalCode('abc'), '');
});

test('free-text addresses parse into parts', () => {
  const parsed = parseAddressLine('12 Oak St, Ridgewood, NJ 07450');
  assert.equal(parsed.line1, '12 Oak St');
  assert.equal(parsed.city, 'Ridgewood');
  assert.equal(parsed.region, 'NJ');
  assert.equal(parsed.postalCode, '07450');

  const loose = parseAddressLine('Ridgewood, NJ');
  assert.equal(loose.city, 'Ridgewood');
  assert.equal(loose.region, 'NJ');
});

test('timezone resolution prefers the most authoritative source and never guesses', () => {
  assert.equal(resolveTimezone({ timezone: 'America/Chicago', region: 'NJ' }), 'America/Chicago');
  assert.equal(resolveTimezone({ region: 'NJ' }), 'America/New_York');
  assert.equal(resolveTimezone({ phoneE164: '+12015550142' }), 'America/New_York');
  // Florida straddles two zones; an unknown answer is the safe one because a
  // wrong timezone silently authorises an out-of-hours call.
  assert.equal(resolveTimezone({ region: 'FL' }), '');
  assert.equal(resolveTimezone({}), '');
  assert.equal(resolveTimezone({ timezone: 'Not/AZone', region: 'ZZ' }), '');
});

test('lists and categories deduplicate and cap', () => {
  assert.deepEqual(normalizeCategories('HVAC, Heating & Air, hvac'), ['hvac', 'heating_and_air']);
  assert.deepEqual(normalizeList(['a', 'a', '', 'b']), ['a', 'b']);
});

test('timestamps survive every shape the corpus uses', () => {
  assert.equal(toDate('2026-01-02T03:04:05Z').toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(toDate(1767322845).toISOString(), new Date(1767322845000).toISOString());   // seconds
  assert.equal(toDate(1767322845000).toISOString(), new Date(1767322845000).toISOString()); // millis
  assert.equal(toDate({ _seconds: 1767322845 }).toISOString(), new Date(1767322845000).toISOString());
  assert.equal(toDate({ toDate: () => new Date(0) }).getTime(), 0);
  assert.equal(toDate('not a date'), null);
  assert.equal(toDate(null), null);
});

test('canonical keys follow the documented precedence', () => {
  const withProvider = dedupeKeys({
    companyName: 'A', website: 'https://a.com', phoneE164: '+12015550142',
    email: 'x@a.com', address: {}, source: { provider: 'google_places', providerRecordId: 'abc' }
  });
  assert.equal(withProvider.canonicalKey, 'id:google_places:abc');

  const withSite = dedupeKeys({ companyName: 'A', website: 'https://a.com', phoneE164: '+12015550142', address: {}, source: {} });
  assert.equal(withSite.canonicalKey, 'site:a.com');

  const withPhone = dedupeKeys({ companyName: 'A', website: '', phoneE164: '+12015550142', address: {}, source: {} });
  assert.equal(withPhone.canonicalKey, 'phone:+12015550142');

  const withName = dedupeKeys({ companyName: 'Joes Pizza', website: '', phoneE164: '', address: { city: 'Ridgewood' }, source: {} });
  assert.equal(withName.canonicalKey, 'name:joes pizza|ridgewood');

  // Hashes are stable and non-reversible.
  assert.equal(hashKey('+12015550142'), hashKey('+12015550142'));
  assert.notEqual(hashKey('+12015550142'), '+12015550142');
});

test('buildProspect produces the documented shape and never invents a value', () => {
  const prospect = buildProspect({
    name: 'JOES PLUMBING LLC',
    phone: '(201) 555-0142',
    email: 'Info@JoesPlumbing.com',
    website: 'www.joesplumbing.com',
    address: '12 Oak St, Ridgewood, NJ 07450',
    category: 'Plumbing Contractor',
    rating: 4.5,
    reviewCount: '31',
    externalId: 'place-1'
  }, { source: { system: 'scraper', provider: 'google_places' } });

  assert.equal(prospect.type, 'outbound_prospect');
  assert.equal(prospect.companyName, 'Joes Plumbing LLC');
  assert.equal(prospect.phoneE164, '+12015550142');
  assert.equal(prospect.phone, '(201) 555-0142');   // the original survives
  assert.equal(prospect.email, 'info@joesplumbing.com');
  assert.equal(prospect.website, 'https://joesplumbing.com');
  assert.equal(prospect.address.region, 'NJ');
  assert.equal(prospect.location.timezone, 'America/New_York');
  assert.equal(prospect.business.category, 'plumbing_contractor');
  assert.equal(prospect.business.reviewCount, 31);
  // Everything arrives as `new`; the import service decides what is ready.
  assert.equal(prospect.lifecycle.status, 'new');
  assert.equal(prospect.contactability.validPhone, true);
  assert.equal(prospect.dedupe.canonicalKey, 'id:google_places:place-1');
  assert.equal(prospect.duplicate.status, 'unique');
});

test('a prospect with no phone is flagged rather than silently stored as callable', () => {
  const prospect = buildProspect({ name: 'No Phone Co', email: 'a@b.com' }, { source: { system: 'csv' } });
  assert.equal(prospect.contactability.validPhone, false);
  assert.equal(prospect.contactability.complianceStatus, 'blocked');
  assert.ok(prospect.contactability.complianceReasons.includes('no_valid_phone'));
});

test('validation rejects records that cannot be deduplicated or worked', () => {
  assert.equal(validateProspect(buildProspect({ name: 'X', phone: '2015550142' }, { source: {} })).valid, true);

  const noIdentity = validateProspect(buildProspect({}, { source: {} }));
  assert.equal(noIdentity.valid, false);
  assert.ok(noIdentity.reasons.includes('no_identity'));

  const uncontactable = validateProspect(buildProspect({ name: 'Ghost Co' }, { source: {} }));
  assert.equal(uncontactable.valid, false);
  assert.ok(uncontactable.reasons.includes('not_contactable'));
});

test('deterministic ids are stable, and hash rather than rewrite unsafe input', () => {
  assert.equal(deterministicId('watcher', 'smb_leads', 'abc123'), 'watcher_smb_leads_abc123');
  assert.equal(deterministicId('watcher', 'smb_leads', 'abc123'), deterministicId('watcher', 'smb_leads', 'abc123'));

  // `a/b` and `a_b` must NOT collapse to the same document — that would be a
  // silent merge of two source records.
  const slash = deterministicId('p', 'a/b');
  const underscore = deterministicId('p', 'a_b');
  assert.notEqual(slash, underscore);
  assert.ok(slash.startsWith('p_h'));

  const long = deterministicId('p', 'x'.repeat(500));
  assert.ok(long.length < 60);
});
