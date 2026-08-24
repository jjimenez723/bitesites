// Turning a raw scraped/imported business into a `prospects` document.
//
// Pure — no Firestore, no network, no secrets — so the whole taxonomy is
// testable with `node --test` and reusable by the migration script, the CSV
// importer, every lead-source adapter and the discovery job runner. That is the
// point: normalisation done in four places drifts in four directions, and the
// dedupe keys computed here are what every later duplicate check compares.
//
// Two rules the callers depend on:
//   * A value we could not normalise becomes '' or undefined — never a guess.
//     `enrichment.confidence` and the duplicate reviewer both read absence as
//     "unknown", and a fabricated area code would read as a verified fact.
//   * The original survives. `source.raw*` fields and `normalizedFrom` keep
//     enough context to audit what we changed, because a lead whose phone we
//     silently rewrote is a lead nobody can debug.
//
// Ported in behaviour (not in code) from the Watcher pipeline's
// executions/_store.py `norm_name`/`website_host`/`merge_key` and
// executions/_contacts.py `normalize_company`. Those were Python, entangled
// with an Airbnb ICP and a company-grained schema; what survives here is the
// matching algorithm, rebuilt provider-neutral.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- primitives

/** Trim, collapse internal whitespace, cap length. The base of everything else. */
export function text(value, maxLen = 500) {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// Values a scraper writes when it means "nothing". Storing them is worse than
// storing nothing: `n/a` is truthy, so every downstream `if (prospect.email)`
// would treat it as a contactable address.
const PLACEHOLDERS = new Set([
  '', '-', '--', 'n/a', 'na', 'none', 'null', 'undefined', 'nil', 'unknown',
  'not available', 'no website', 'no phone', 'no email', 'tbd', 'test',
  '(none)', '(blank)', 'no data', '0', '#n/a', '#value!'
]);

/** '' for anything that is a placeholder rather than a value. */
export function clean(value, maxLen = 500) {
  const out = text(value, maxLen);
  return PLACEHOLDERS.has(out.toLowerCase()) ? '' : out;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Stable, non-reversible key for a phone/email so an index never stores PII twice. */
export const hashKey = value => (value ? sha256(String(value).toLowerCase()) : '');

// ------------------------------------------------------------------- phones

// Deliberately conservative and NANP-first, matching the corpus. An extension
// is rejected rather than truncated: a dial string with pauses is not a
// routable destination, and a dialer that dials the trunk number and drops the
// caller into a phone tree looks exactly like a working call in the logs.
const EXTENSION = /\b(?:ext\.?|extension|x)\s*\d+\b/i;

/**
 * E.164 for a US-first corpus, or '' when the input is not dialable.
 * Never invents a country code for a number that is too short to have one.
 */
export function normalizePhone(value, { defaultCountry = 'US' } = {}) {
  const raw = clean(value, 60);
  if (!raw || EXTENSION.test(raw)) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  // A NANP number never starts its area code with 0 or 1; the ones that appear
  // to are almost always a truncated international number or a fax placeholder.
  if (defaultCountry === 'US' && digits.length === 10) {
    return /^[2-9]/.test(digits) ? `+1${digits}` : '';
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return /^[2-9]/.test(digits.slice(1)) ? `+${digits}` : '';
  }
  // Only trust an explicit + for the rest of the world. Guessing a country code
  // from a bare 9-digit string is how you cold-call a stranger in another
  // jurisdiction.
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return '';
}

/** Human-readable form of an E.164 number, for the dialer UI only. */
export function formatPhone(e164) {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : (e164 || '');
}

/** The NANP area code, used only to guess a timezone when nothing better exists. */
export const areaCode = e164 => (/^\+1(\d{3})/.exec(e164 || '')?.[1] || '');

// ------------------------------------------------------------------- emails

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/** Lowercased address, or '' if it is not one. Local-part case is not preserved:
 *  every mail provider in this corpus is case-insensitive, and preserving it
 *  would make `Bob@x.com` and `bob@x.com` two prospects. */
export function normalizeEmail(value) {
  const raw = clean(value, 254).toLowerCase();
  if (!raw || !EMAIL.test(raw)) return '';
  // A trailing dot or a doubled @ survives the regex on some inputs.
  return raw.replace(/\.+$/, '');
}

// Mailbox providers whose domain says nothing about the business. Matching two
// prospects on `gmail.com` would fuse every sole trader in the corpus.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'me.com', 'mac.com', 'live.com', 'msn.com', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com',
  'yandex.com', 'zoho.com', 'ymail.com', 'rocketmail.com', 'optonline.net'
]);

export const isFreeEmailDomain = domain => FREE_EMAIL_DOMAINS.has(String(domain || '').toLowerCase());

export const emailDomain = email => (normalizeEmail(email).split('@')[1] || '');

// ------------------------------------------------------------- urls / domains

/**
 * Bare registrable host: 'https://WWW.Foo.com/x?y' -> 'foo.com'. '' if unusable.
 * Dropping `www.` matters — one business's Places record and its Yelp record
 * routinely disagree about it, and without this they are two prospects.
 */
export function normalizeDomain(value) {
  let raw = clean(value, 500).toLowerCase();
  if (!raw) return '';
  if (!raw.includes('//')) raw = `https://${raw}`;
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  // A host with no dot is not a domain; a bare IP is not a business website.
  if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return '';
  return host;
}

// Social profiles and directory listings are not the business's own site. A
// prospect whose only "website" is its Facebook page is a *stronger* lead for
// BiteSites, not a weaker one — but treating that host as an identity would
// merge every such prospect into one record.
const NON_BUSINESS_HOSTS = new Set([
  'facebook.com', 'm.facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'linkedin.com', 'yelp.com', 'tripadvisor.com', 'google.com', 'business.site',
  'sites.google.com', 'maps.google.com', 'youtube.com', 'tiktok.com',
  'nextdoor.com', 'yellowpages.com', 'bbb.org', 'foursquare.com', 'doordash.com',
  'grubhub.com', 'ubereats.com', 'opentable.com', 'wixsite.com', 'square.site',
  'godaddysites.com', 'weebly.com', 'blogspot.com', 'wordpress.com', 'squarespace.com'
]);

export const isDirectoryHost = domain => {
  const host = String(domain || '').toLowerCase();
  if (NON_BUSINESS_HOSTS.has(host)) return true;
  // `something.wixsite.com` is still a Wix subdomain, not a registrable identity.
  return [...NON_BUSINESS_HOSTS].some(known => host.endsWith(`.${known}`));
};

/** Canonical https URL for display/fetching, or '' when the host is unusable. */
export function normalizeWebsite(value) {
  const domain = normalizeDomain(value);
  if (!domain) return '';
  const raw = clean(value, 500);
  try {
    const url = new URL(raw.includes('//') ? raw : `https://${raw}`);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `https://${domain}${path}`;
  } catch {
    return `https://${domain}`;
  }
}

// ------------------------------------------------------------ company names

// Legal suffixes, stripped for MATCHING only. "Bogush, Inc." and "BOGUSH INC"
// are one business; given how many SMBs are named Joe's/Tony's, the apostrophe
// rule below decides whether a large share of real duplicates fuse at all.
const LEGAL_SUFFIX =
  /[\s,]+(?:inc|inc\.|incorporated|llc|l\.l\.c\.|llp|lp|ltd|ltd\.|limited|co|co\.|corp|corp\.|corporation|company|pllc|pc|p\.c\.|pa|dba|d\/b\/a|and sons|& sons)\.?$/gi;

const APOSTROPHES = /['‘’ʼ`]/g;

/** Matching key for a business name: lowercase, suffix-free, punctuation-free. */
export function normalizeCompanyKey(value) {
  let out = clean(value, 200).toLowerCase().replace(APOSTROPHES, '');
  let previous = null;
  // Loop: "Co., Inc." stacks two suffixes and one pass only removes the last.
  while (out && out !== previous) {
    previous = out;
    out = out.replace(LEGAL_SUFFIX, '').trim();
  }
  return out.replace(/[^a-z0-9]+/g, ' ').trim();
}

const LOWER_WORDS = new Set(['of', 'and', 'the', 'for', 'at', 'in', 'on', 'to', 'by', 'a', 'an']);

// Tokens that stay upper-case when a SHOUTING name is title-cased. An explicit
// list rather than a heuristic: "any short all-caps token is an initialism"
// keeps JOES as JOES, and every rule loose enough to catch HVAC is loose enough
// to catch that. Short and boring beats clever and wrong on the corpus.
//
// Built lazily because it folds in STATE_CODES, which is declared further down
// with the address helpers — a top-level spread would read it in its temporal
// dead zone and fail at import time.
const INITIALISMS = [
  'LLC', 'INC', 'LLP', 'LP', 'PC', 'PA', 'PLLC', 'CORP',
  'USA', 'US', 'HVAC', 'AC', 'TV', 'IT', 'SEO', 'CPA', 'DDS', 'DMD', 'MD',
  'DVM', 'BBQ', 'ATM', 'RV', 'UPS', 'NYC', 'LA', 'SF', 'AV', 'HD'
];
let keepUppercase = null;
const keepsUppercase = token => {
  if (!keepUppercase) keepUppercase = new Set([...INITIALISMS, ...STATE_CODES]);
  return keepUppercase.has(token);
};

/** Display-grade company name. Fixes SHOUTING and all-lowercase imports without
 *  flattening deliberate casing like "BiteSites" or "iFixit". */
export function normalizeCompanyName(value) {
  const raw = clean(value, 200);
  if (!raw) return '';
  const mixed = /[a-z]/.test(raw) && /[A-Z]/.test(raw);
  if (mixed) return raw;
  return raw
    .split(' ')
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && LOWER_WORDS.has(lower)) return lower;
      const stripped = word.replace(/[^A-Za-z]/g, '').toUpperCase();
      if (keepsUppercase(stripped)) return word.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

// ------------------------------------------------------------------ people

const NAME_JUNK = new Set([
  'info', 'contact', 'admin', 'owner', 'manager', 'sales', 'support', 'office',
  'team', 'hello', 'service', 'customer', 'billing', 'help', 'mail', 'noreply',
  'no-reply', 'webmaster', 'accounts', 'orders', 'inquiries', 'enquiries'
]);

/**
 * A real first name, or '' for a role inbox. This gate is why a call script
 * never opens with "Hi Unclejoespizzawallington" — a concatenated local-part is
 * alphabetic and junk-free, so only its length gives it away.
 */
export function normalizeFirstName(value) {
  const first = clean(value, 60).split(' ')[0]?.replace(/[.,]/g, '') || '';
  if (first.length < 2 || first.length > 16) return '';
  if (!/^[A-Za-z][A-Za-z'’-]+$/.test(first)) return '';
  if (NAME_JUNK.has(first.toLowerCase())) return '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export function splitPersonName(value) {
  const full = clean(value, 120);
  if (!full) return { firstName: '', lastName: '' };
  const parts = full.split(' ').filter(Boolean);
  const firstName = normalizeFirstName(parts[0]);
  if (!firstName) return { firstName: '', lastName: '' };
  const lastRaw = parts.slice(1).join(' ');
  const lastName = /^[A-Za-z][A-Za-z'’ -]*$/.test(lastRaw) ? lastRaw : '';
  return { firstName, lastName };
}

// ---------------------------------------------------------------- addresses

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'puerto rico': 'PR'
};

const STATE_CODES = new Set(Object.values(STATES));

/** Two-letter US state code, or '' — never a truncation of an unknown region. */
export function normalizeRegion(value) {
  const raw = clean(value, 60);
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (upper.length === 2 && STATE_CODES.has(upper)) return upper;
  return STATES[raw.toLowerCase()] || '';
}

/** US ZIP as 5 digits (ZIP+4 is truncated to the 5 the timezone map needs). */
export function normalizePostalCode(value) {
  const raw = clean(value, 20);
  const match = /(\d{5})(?:-\d{4})?/.exec(raw);
  return match ? match[1] : '';
}

export function normalizeAddress(input = {}) {
  const address = {
    line1: clean(input.line1 ?? input.street ?? input.address ?? input.address1, 200),
    city: clean(input.city ?? input.town ?? input.locality, 100),
    region: normalizeRegion(input.region ?? input.state ?? input.province),
    postalCode: normalizePostalCode(input.postalCode ?? input.zip ?? input.postcode),
    country: clean(input.country, 60).toUpperCase().slice(0, 2) || (input.country ? '' : 'US')
  };
  // A country we could not shorten to an ISO-2 code is left blank rather than
  // stored as "UNITED STATES OF" — a truncated country is worse than none.
  if (address.country && !/^[A-Z]{2}$/.test(address.country)) address.country = '';
  return address;
}

/** 'Ridgewood, NJ 07450' from an address, or '' — used for display and search. */
export const formatAddress = address => {
  if (!address) return '';
  const tail = [address.region, address.postalCode].filter(Boolean).join(' ');
  return [address.line1, address.city, tail].filter(Boolean).join(', ');
};

/** Parse a free-text 'Ridgewood, NJ' / '12 Oak St, Ridgewood, NJ 07450' string. */
export function parseAddressLine(value) {
  const raw = clean(value, 300);
  if (!raw) return normalizeAddress({});
  const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
  const tail = parts[parts.length - 1] || '';
  const tailMatch = /^([A-Za-z .]+?)\s*(\d{5}(?:-\d{4})?)?$/.exec(tail);
  const region = normalizeRegion(tailMatch?.[1] || '');
  const postalCode = normalizePostalCode(tailMatch?.[2] || '');
  if (!region) return normalizeAddress({ city: parts.length > 1 ? parts[parts.length - 1] : '', line1: parts.length > 1 ? parts.slice(0, -1).join(', ') : raw });
  const rest = parts.slice(0, -1);
  return normalizeAddress({
    line1: rest.length > 1 ? rest.slice(0, -1).join(', ') : '',
    city: rest[rest.length - 1] || '',
    region,
    postalCode
  });
}

// ---------------------------------------------------------------- timezones

// State -> IANA zone, for the calling-hours check. States that straddle a zone
// boundary are deliberately absent: a wrong timezone silently authorises a call
// at 07:00 local, so "unknown" (and the campaign's fallback) is the safe answer.
// Callers should prefer a provider-supplied timezone over this table.
const REGION_TIMEZONES = {
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York',
  GA: 'America/New_York', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York',
  NY: 'America/New_York', NC: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago',
  IA: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', OK: 'America/Chicago',
  WI: 'America/Chicago',
  CO: 'America/Denver', MT: 'America/Denver', NM: 'America/Denver',
  UT: 'America/Denver', WY: 'America/Denver',
  AZ: 'America/Phoenix',
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles', OR: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu', PR: 'America/Puerto_Rico'
};

// Area codes only where the whole NPA sits in one zone. Same discipline: a
// partial list that is right is better than a complete one that guesses.
const AREA_CODE_TIMEZONES = {
  201: 'America/New_York', 551: 'America/New_York', 862: 'America/New_York',
  973: 'America/New_York', 908: 'America/New_York', 732: 'America/New_York',
  848: 'America/New_York', 609: 'America/New_York', 856: 'America/New_York',
  212: 'America/New_York', 646: 'America/New_York', 917: 'America/New_York',
  718: 'America/New_York', 347: 'America/New_York', 929: 'America/New_York',
  914: 'America/New_York', 845: 'America/New_York', 631: 'America/New_York',
  516: 'America/New_York', 203: 'America/New_York', 475: 'America/New_York',
  617: 'America/New_York', 857: 'America/New_York', 781: 'America/New_York',
  215: 'America/New_York', 267: 'America/New_York', 305: 'America/New_York',
  312: 'America/Chicago', 773: 'America/Chicago', 214: 'America/Chicago',
  469: 'America/Chicago', 512: 'America/Chicago', 713: 'America/Chicago',
  303: 'America/Denver', 720: 'America/Denver', 602: 'America/Phoenix',
  213: 'America/Los_Angeles', 310: 'America/Los_Angeles', 323: 'America/Los_Angeles',
  415: 'America/Los_Angeles', 408: 'America/Los_Angeles', 619: 'America/Los_Angeles',
  206: 'America/Los_Angeles', 503: 'America/Los_Angeles', 702: 'America/Los_Angeles'
};

const IANA_ZONE = /^[A-Za-z]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/;

/**
 * Best available IANA timezone, or '' when we genuinely do not know.
 * Order is provider-supplied, then state, then area code — most authoritative
 * first, and never a default like 'America/New_York' for an unknown prospect.
 */
export function resolveTimezone({ timezone, region, phoneE164 } = {}) {
  const supplied = clean(timezone, 60);
  if (supplied && IANA_ZONE.test(supplied)) {
    // Validate against the runtime rather than a hard-coded list — Intl already
    // ships the tz database and rejects a zone that no longer exists.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: supplied });
      return supplied;
    } catch { /* fall through to the derivations below */ }
  }
  const byRegion = REGION_TIMEZONES[normalizeRegion(region)];
  if (byRegion) return byRegion;
  return AREA_CODE_TIMEZONES[Number(areaCode(phoneE164))] || '';
}

// -------------------------------------------------------------- categories

/** Lowercase snake-case category id from free-text ('Sheet Metal Contractor'). */
export const normalizeCategory = value =>
  clean(value, 80).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function normalizeCategories(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;|]/);
  const seen = new Set();
  for (const entry of list) {
    const id = normalizeCategory(entry);
    if (id) seen.add(id);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

// -------------------------------------------------------------- timestamps

/**
 * Anything a source calls a date -> a JS Date, or null.
 * Firestore Timestamps, epoch seconds, epoch millis and ISO strings all turn up
 * in the same corpus; a bare number is ambiguous, so the 10-digit/13-digit split
 * is the disambiguator rather than a Date constructor coin flip.
 */
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === 'function') {
    try { return toDate(value.toDate()); } catch { return null; }
  }
  if (typeof value === 'object' && typeof value._seconds === 'number') {
    return new Date(value._seconds * 1000);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(value < 1e11 ? value * 1000 : value);
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const toIso = value => toDate(value)?.toISOString() || '';

// ------------------------------------------------------------ array hygiene

/** Deduplicated, trimmed, capped list of non-empty strings. */
export function normalizeList(value, { maxItems = 25, maxLen = 80 } = {}) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;|]/);
  const seen = new Set();
  for (const entry of list) {
    const item = clean(entry, maxLen);
    if (item) seen.add(item);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

// -------------------------------------------------------------- dedupe keys

/**
 * The identity fields every duplicate check keys off.
 *
 * `canonicalKey` mirrors the Watcher pipeline's `merge_key` precedence — the
 * source's own id is authoritative, a shared registrable domain is near
 * certain, and name+town is a fuzzy last resort. The one change: a directory or
 * social host never becomes an identity, because `facebook.com` as a canonical
 * key fuses every prospect that has no site of its own.
 */
export function dedupeKeys(prospect) {
  const normalizedCompany = normalizeCompanyKey(prospect.companyName || prospect.name);
  const domain = normalizeDomain(prospect.website);
  const normalizedWebsite = isDirectoryHost(domain) ? '' : domain;
  const email = normalizeEmail(prospect.email);
  const emailIsBusiness = email && !isFreeEmailDomain(emailDomain(email));
  const city = normalizeCompanyKey(prospect.address?.city || '');
  const providerId = clean(prospect.source?.providerRecordId, 200).toLowerCase();

  let canonicalKey = '';
  if (providerId) canonicalKey = `id:${clean(prospect.source?.provider, 40)}:${providerId}`;
  else if (normalizedWebsite) canonicalKey = `site:${normalizedWebsite}`;
  else if (prospect.phoneE164) canonicalKey = `phone:${prospect.phoneE164}`;
  else if (emailIsBusiness) canonicalKey = `email:${email}`;
  else if (normalizedCompany) canonicalKey = `name:${normalizedCompany}|${city}`;

  return {
    normalizedCompany,
    normalizedWebsite,
    phoneHash: hashKey(prospect.phoneE164),
    emailHash: hashKey(email),
    canonicalKey
  };
}

// -------------------------------------------------------- the prospect shape

export const PROSPECT_STATUSES = [
  'new', 'needs_review', 'ready', 'queued', 'researching', 'approved',
  'contacting', 'connected', 'qualified', 'converted', 'not_interested',
  'call_later', 'invalid', 'do_not_contact', 'archived'
];

export const SOURCE_SYSTEMS = ['watcher_leads', 'bitesites_leads', 'manual', 'csv', 'scraper'];

/** A prospect nobody can call is not "ready" — this is the gate the queue reads. */
export function contactabilityFor({ phoneE164, email, doNotCall = false, doNotEmail = false }) {
  const reasons = [];
  if (!phoneE164) reasons.push('no_valid_phone');
  if (doNotCall) reasons.push('do_not_call');
  return {
    validPhone: Boolean(phoneE164),
    validEmail: Boolean(email),
    doNotCall: Boolean(doNotCall),
    doNotEmail: Boolean(doNotEmail),
    // 'pending' rather than 'eligible': the per-campaign compliance check in
    // outbound-compliance.js owns eligibility. This field only records what the
    // record itself makes impossible.
    complianceStatus: reasons.length ? 'blocked' : 'pending',
    complianceReasons: reasons
  };
}

// ------------------------------------------------------------------ consent

// Consent is deliberately carried as a small, explicit object rather than a
// campaign-wide label. An AI/artificial-voice call is authorised (or not) by
// the evidence for this number and this seller; a campaign setting cannot turn
// a cold list into a consented audience.
const CONSENT_BASES = new Set(['written_opt_in', 'inbound_request', 'existing_business_relationship', 'not_recorded']);

/**
 * Normalise the consent evidence that travelled with an imported record.
 *
 * This preserves provenance without treating it as valid AI-call permission.
 * `outbound-compliance.js` performs the stricter, campaign-specific check at
 * dial/AI-attach time. In particular, legacy Watcher/Byte-Dialer rows without
 * seller, number, grant time, and evidence remain safely `not_recorded` for
 * AI calling even when a source happened to include a loose text note.
 */
export function normalizeConsent(raw = {}) {
  const nested = raw?.consent && typeof raw.consent === 'object' ? raw.consent : {};
  const value = key => nested[key] ?? raw?.[key];
  const basisInput = clean(value('basis') ?? raw?.consentBasis ?? raw?.consent_basis, 60).toLowerCase();
  const basis = CONSENT_BASES.has(basisInput) ? basisInput : 'not_recorded';
  const sellerAccountId = clean(
    value('sellerAccountId') ?? raw?.consentSellerAccountId ?? raw?.consent_seller_account_id ?? raw?.consentSeller ?? raw?.consent_seller,
    80
  ).toLowerCase();
  const phoneE164 = normalizePhone(
    value('phoneE164') ?? raw?.consentPhoneE164 ?? raw?.consent_phone_e164 ?? raw?.consentPhone ?? raw?.consent_phone
  );
  const grantedAt = toDate(
    value('grantedAt') ?? raw?.consentGrantedAt ?? raw?.consent_granted_at ?? raw?.consentTimestamp ?? raw?.consent_timestamp
  );

  return {
    grantId: clean(value('grantId') ?? raw?.consentGrantId ?? raw?.consent_grant_id, 200),
    basis,
    sellerAccountId,
    phoneE164,
    evidenceId: clean(value('evidenceId') ?? raw?.consentEvidenceId ?? raw?.consent_evidence_id, 200),
    record: clean(value('record') ?? raw?.consentRecord ?? raw?.consent_record, 1000),
    sourceUrl: clean(value('sourceUrl') ?? raw?.consentSourceUrl ?? raw?.consent_source_url, 1000),
    formVersion: clean(value('formVersion') ?? raw?.consentFormVersion ?? raw?.consent_form_version, 120),
    grantedAt
  };
}

/**
 * Raw provider record -> the `prospects/{id}` document shape (§8 of the spec).
 *
 * `raw` is whatever an adapter's `normalize()` produced: a flat bag of the
 * common field names. Unknown keys are dropped rather than spread in — a
 * prospect document with 60 provider-specific fields is a schema nobody can
 * query, and Firestore charges for every index on it.
 */
export function buildProspect(raw = {}, { source = {}, importRunId = '', now = new Date() } = {}) {
  const companyName = normalizeCompanyName(raw.companyName || raw.company || raw.businessName || raw.name);
  const person = raw.firstName || raw.lastName
    ? { firstName: normalizeFirstName(raw.firstName), lastName: clean(raw.lastName, 80) }
    : splitPersonName(raw.contactName || raw.personName || '');

  const phoneE164 = normalizePhone(raw.phone ?? raw.phoneE164);
  const email = normalizeEmail(raw.email);
  const website = normalizeWebsite(raw.website ?? raw.url ?? raw.site);
  const address = raw.address && typeof raw.address === 'object'
    ? normalizeAddress(raw.address)
    : parseAddressLine(raw.address ?? raw.location ?? '');

  const timezone = resolveTimezone({ timezone: raw.timezone, region: address.region, phoneE164 });
  const lat = Number(raw.lat ?? raw.latitude);
  const lng = Number(raw.lng ?? raw.longitude);

  const prospect = {
    type: 'outbound_prospect',

    name: companyName || clean(raw.name, 200),
    firstName: person.firstName,
    lastName: person.lastName,
    companyName,
    jobTitle: clean(raw.jobTitle ?? raw.title ?? raw.role, 120),

    // The pre-normalisation phone stays beside the E.164 one: an operator
    // looking at an `invalid` prospect needs to see what the source actually
    // said before deciding whether the number is fixable.
    phone: clean(raw.phone, 60),
    phoneE164,
    email,
    website,
    // Keep CRM identity and consent provenance through every import path. Both
    // were previously emitted by the BiteSites-Leads adapter and then dropped
    // here, leaving a later dialer unable to evaluate target-level permission.
    providerContactId: clean(raw.providerContactId ?? raw.provider_contact_id ?? raw.ghl_contact_id, 200),
    consent: normalizeConsent(raw),

    address,
    location: {
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      timezone
    },

    business: {
      category: normalizeCategory(raw.category ?? raw.industry ?? raw.field),
      categories: normalizeCategories(raw.categories ?? raw.category ?? raw.industry),
      description: clean(raw.description ?? raw.summary, 1000),
      employeeRange: clean(raw.employeeRange ?? raw.employees, 40),
      estimatedRevenue: clean(raw.estimatedRevenue ?? raw.revenue, 40),
      rating: Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null,
      reviewCount: Number.isFinite(Number(raw.reviewCount)) ? Math.trunc(Number(raw.reviewCount)) : null
    },

    source: {
      system: SOURCE_SYSTEMS.includes(source.system) ? source.system : 'scraper',
      provider: clean(source.provider, 60),
      providerRecordId: clean(source.providerRecordId ?? raw.externalId ?? raw.placeId ?? raw.id, 200),
      sourceProjectId: clean(source.sourceProjectId, 80),
      sourceCollection: clean(source.sourceCollection, 80),
      sourceDocumentId: clean(source.sourceDocumentId, 200),
      sourceUrl: normalizeWebsite(source.sourceUrl ?? raw.link ?? raw.sourceUrl) || clean(source.sourceUrl ?? raw.link, 500),
      searchJobId: clean(source.searchJobId, 80),
      importedAt: source.importedAt ?? now
    },

    lifecycle: {
      // Everything arrives as `new`. Promotion to `ready` happens only after
      // normalisation + dedupe + compliance, in prospect-import.js — a scraped
      // row must never be dialable the moment it lands.
      status: 'new',
      owner: '',
      priority: Number.isFinite(Number(raw.priority)) ? Math.max(0, Math.min(100, Math.trunc(Number(raw.priority)))) : 50,
      score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : null,
      nextActionAt: null,
      convertedLeadId: ''
    },

    contactability: contactabilityFor({
      phoneE164,
      email,
      doNotCall: raw.doNotCall === true || raw.dnc === true,
      doNotEmail: raw.doNotEmail === true
    }),

    enrichment: {
      status: 'none',
      lastEnrichedAt: null,
      confidence: null
    },

    dedupe: {},
    duplicate: {
      status: 'unique',
      duplicateOfType: '',
      duplicateOfId: '',
      matchReasons: [],
      matchConfidence: 0,
      reviewedBy: '',
      reviewedAt: null
    },

    notes: clean(raw.notes ?? raw.reason, 2000),
    tags: normalizeList(raw.tags, { maxItems: 20, maxLen: 40 }),

    importRunId: clean(importRunId, 80),
    createdAt: now,
    updatedAt: now
  };

  prospect.dedupe = dedupeKeys(prospect);
  return prospect;
}

/**
 * Is this prospect worth storing at all?
 * A record with no identity cannot be deduplicated, and a record with no phone
 * and no email cannot be worked — both are noise in a callable queue.
 */
export function validateProspect(prospect) {
  const reasons = [];
  if (!prospect.name && !prospect.companyName) reasons.push('missing_name');
  if (!prospect.dedupe?.canonicalKey) reasons.push('no_identity');
  if (!prospect.phoneE164 && !prospect.email) reasons.push('not_contactable');
  return { valid: reasons.length === 0, reasons };
}

/**
 * Deterministic destination id, so re-running an import updates rather than
 * duplicates. Long or unsafe ids collapse to a hash and the original source
 * fields stay on the document (§18).
 */
export function deterministicId(prefix, ...parts) {
  const safePrefix = String(prefix || 'prospect').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const tail = parts.map(part => String(part ?? '')).join('_');
  // Hash whenever the raw tail would have to be rewritten to be a legal id.
  // Rewriting instead would make `a/b` and `a_b` the same document, which is a
  // silent merge of two source records — exactly what an idempotent import
  // must not do.
  if (tail && tail.length <= 200 && /^[A-Za-z0-9_-]+$/.test(tail)) return `${safePrefix}_${tail}`;
  return `${safePrefix}_h${sha256(tail).slice(0, 40)}`;
}
