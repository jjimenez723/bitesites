// CSV as a lead source.
//
// The parser is the interesting half. A pasted export from Places, Yelp or a
// list broker routinely contains quoted commas, embedded newlines and a BOM,
// and a naive `split(',')` turns one of those rows into three malformed
// prospects — which then get dialled. So this is a real RFC-4180 reader, and it
// is pure, so the whole thing is covered by `node --test` without an emulator.
//
// It is registered as a source (rather than living only in the importer) so the
// same discover → normalise → dedupe → review path handles a file and a
// scrape. Import Review does not need to know which one it is looking at.

import { LeadSourceAdapter } from './adapter.js';
import { clean } from '../../prospect-normalization.js';

/** RFC-4180 rows. Handles quoted fields, doubled quotes, CRLF and a leading BOM. */
export function parseCsv(input, { maxRows = 20000 } = {}) {
  const text = String(input || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        quoted = false; index += 1; continue;
      }
      field += char; index += 1; continue;
    }

    if (char === '"' && field === '') { quoted = true; index += 1; continue; }
    if (char === ',') { row.push(field); field = ''; index += 1; continue; }
    if (char === '\r') { index += 1; continue; }
    if (char === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      if (rows.length >= maxRows) return rows;
      index += 1; continue;
    }
    field += char; index += 1;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // A trailing newline leaves one empty row; dropping it here keeps every
  // caller from having to special-case "the last record is blank".
  return rows.filter(entry => entry.some(cell => cell.trim() !== ''));
}

// Header aliases. The same column arrives as `Phone`, `phone_number`,
// `Primary Phone` and `Telephone` depending on who exported it; mapping them
// here means the operator does not have to rename columns before uploading.
const HEADER_ALIASES = {
  name: ['name', 'full name', 'contact', 'contact name', 'person'],
  firstName: ['firstname', 'first name', 'first', 'given name'],
  lastName: ['lastname', 'last name', 'last', 'surname', 'family name'],
  companyName: ['company', 'companyname', 'company name', 'business', 'business name', 'organization', 'organisation', 'account'],
  email: ['email', 'e-mail', 'email address', 'primary email', 'work email'],
  phone: ['phone', 'phone number', 'phonenumber', 'telephone', 'tel', 'mobile', 'primary phone', 'business phone', 'cell'],
  website: ['website', 'web site', 'url', 'site', 'domain', 'homepage'],
  timezone: ['timezone', 'time zone', 'tz'],
  notes: ['notes', 'note', 'comment', 'comments', 'description'],
  priority: ['priority', 'rank'],
  jobTitle: ['title', 'job title', 'jobtitle', 'role', 'position'],
  category: ['category', 'industry', 'vertical', 'field', 'type'],
  address: ['address', 'street', 'address1', 'street address', 'full address'],
  city: ['city', 'town', 'locality'],
  region: ['state', 'region', 'province', 'st'],
  postalCode: ['zip', 'zipcode', 'zip code', 'postal', 'postal code', 'postcode'],
  country: ['country']
};

const HEADER_LOOKUP = new Map();
for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
  for (const alias of aliases) HEADER_LOOKUP.set(alias, field);
}

/** Header row -> `{ columnIndex: canonicalField }`, ignoring unknown columns. */
export function mapHeaders(headerRow = []) {
  const mapping = {};
  headerRow.forEach((raw, index) => {
    const key = String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const field = HEADER_LOOKUP.get(key);
    // First column wins. A file with both `Phone` and `Business Phone` should
    // use the one the exporter put first rather than whichever we saw last.
    if (field && !Object.values(mapping).includes(field)) mapping[index] = field;
  });
  return mapping;
}

/** CSV text -> the flat records `buildProspect` consumes. */
export function csvToRecords(text, { maxRows } = {}) {
  const rows = parseCsv(text, { maxRows });
  if (!rows.length) return { records: [], headers: [], unmapped: [] };

  const [headerRow, ...dataRows] = rows;
  const mapping = mapHeaders(headerRow);
  const mapped = new Set(Object.keys(mapping).map(Number));
  const unmapped = headerRow.filter((_, index) => !mapped.has(index)).map(value => clean(value, 80)).filter(Boolean);

  const records = dataRows.map((row, rowIndex) => {
    const record = { _row: rowIndex + 2 };
    for (const [index, field] of Object.entries(mapping)) {
      const value = clean(row[Number(index)], field === 'notes' ? 2000 : 300);
      if (value) record[field] = value;
    }
    if (record.city || record.region || record.postalCode || record.address) {
      record.address = {
        line1: typeof record.address === 'string' ? record.address : '',
        city: record.city || '',
        region: record.region || '',
        postalCode: record.postalCode || '',
        country: record.country || 'US'
      };
      delete record.city; delete record.region; delete record.postalCode; delete record.country;
    }
    return record;
  });

  return { records, headers: headerRow.map(value => clean(value, 80)), unmapped };
}

export class CsvLeadSource extends LeadSourceAdapter {
  static id = 'csv';
  static label = 'CSV upload';
  static executionMode = 'cloud_function';
  static requiredSecrets = [];
  static supportsKeywords = false;

  async validateConfig(criteria = {}) {
    return criteria.csvText
      ? { valid: true, errors: [] }
      : { valid: false, errors: ['No CSV content was supplied.'] };
  }

  supports(criteria) { return Boolean(criteria?.csvText); }

  async discover(criteria = {}, cursor = null) {
    const offset = Number(cursor?.offset || 0);
    const { records } = csvToRecords(criteria.csvText || '');
    const page = records.slice(offset, offset + 200);
    return { records: page, cursor: { offset: offset + page.length }, done: offset + page.length >= records.length };
  }

  sourceIdentity(raw) {
    // A CSV row has no provider id. Using the row number would make two uploads
    // of the same file collide on row 2 while genuinely different files share
    // ids — so identity is left to the normalised phone/email/domain instead.
    return { provider: CsvLeadSource.id, providerRecordId: '' };
  }

  normalize(raw) { return { ...raw }; }
}
