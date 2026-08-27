// Phone intelligence tests.
//
// No emulator and no network: the Firestore surface this module touches is
// small enough to fake precisely, and every lookup takes an injected `fetch`.
// The point of the fake is not speed, it is the assertion in
// "never writes compliance evidence" — a real emulator test would have to go
// looking for documents that should not exist, while the fake records every
// write path and can prove the negative.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exchangeKeyFor,
  parseExchangeXml,
  blocksFromRecords,
  resolveBlock,
  buildPhoneIntel,
  unresolvablePhoneIntel,
  lookupExchange,
  resolvePhoneIntel,
  backfillPhoneIntel,
  ingestExchangeRecords,
  PHONE_INTEL_EVIDENCE_GRADE,
  PHONE_INTEL_VERSION,
  LINE_TYPE_BY_COMPANY_TYPE
} from './phone-intelligence.js';

// The real 201-552 response, trimmed to the fields the parser reads. Captured
// from localcallingguide.com on 2026-08-26. It is kept verbatim rather than
// invented because the thousands-block split is the whole reason this module
// keys the way it does, and a hand-written fixture would be a fixture of my
// assumptions rather than of the source.
const XML_201_552 = `<?xml version="1.0" encoding="UTF-8"?>
<root>
<prefixdata><npa>201</npa><nxx>552</nxx><x>A</x><rc>Union City</rc><region>NJ</region>
<ocn>612K</ocn><company-name>CSC VOICE, LLC</company-name><company-type>C</company-type><lata>224</lata></prefixdata>
<prefixdata><npa>201</npa><nxx>552</nxx><x>0</x><rc>Union City</rc><region>NJ</region>
<ocn>6623</ocn><company-name>OMNIPOINT COMMUNICATIONS, INC. - NJ</company-name><company-type>W</company-type><lata>224</lata></prefixdata>
<prefixdata><npa>201</npa><nxx>552</nxx><x>2</x><rc>Union City</rc><region>NJ</region>
<ocn>318J</ocn><company-name>COMCAST IP PHONE, LLC</company-name><company-type>C</company-type><lata>224</lata></prefixdata>
<prefixdata><npa>201</npa><nxx>552</nxx><x>4</x><rc>Union City</rc><region>NJ</region>
<ocn>637C</ocn><company-name>ONVOY, LLC - NJ</company-name><company-type>C</company-type><lata>224</lata></prefixdata>
<prefixdata><npa>201</npa><nxx>552</nxx><x>8</x><rc>Union City</rc><region>NJ</region>
<ocn>6623</ocn><company-name>OMNIPOINT COMMUNICATIONS, INC. - NJ</company-name><company-type>W</company-type><lata>224</lata></prefixdata>
</root>`;

const XML_LANDLINE = `<root><prefixdata><npa>609</npa><nxx>555</nxx><x>A</x><rc>Trenton</rc>
<region>NJ</region><ocn>9104</ocn><company-name>VERIZON NEW JERSEY, INC.</company-name>
<company-type>I</company-type><lata>222</lata></prefixdata></root>`;

// ------------------------------------------------------------------ fake db

// `beforeSet` lets a test make a specific write fail the way a stale gRPC
// channel does. Every ref this fake hands out — including the ones inside a
// collection page — goes through `makeRef`, so the hook cannot be bypassed.
function fakeDb(seed = {}, { beforeSet = null } = {}) {
  const docs = new Map(Object.entries(seed));
  const writes = [];
  const makeRef = path => ({
    path,
    async get() {
      const data = docs.get(path);
      return {
        exists: data !== undefined,
        id: path.split('/').pop(),
        data: () => data,
        get: field => field.split('.').reduce((value, part) => value?.[part], data)
      };
    },
    async set(value, options = {}) {
      if (beforeSet) await beforeSet(path);
      writes.push({ path, value });
      docs.set(path, options.merge ? { ...(docs.get(path) || {}), ...value } : value);
    }
  });

  return {
    writes,
    docs,
    doc: path => makeRef(path),
    collection(name) {
      const build = (afterId = '', max = Infinity) => ({
        orderBy: () => build(afterId, max),
        limit: n => build(afterId, n),
        startAfter: id => build(id, max),
        async get() {
          const ids = [...docs.keys()]
            .filter(path => path.startsWith(`${name}/`))
            .map(path => path.slice(name.length + 1))
            .filter(id => !id.includes('/'))
            .sort()
            .filter(id => !afterId || id > afterId)
            .slice(0, max === Infinity ? undefined : max);
          const pageDocs = ids.map(id => ({
            id,
            ref: makeRef(`${name}/${id}`),
            get: field => field.split('.').reduce((value, part) => value?.[part], docs.get(`${name}/${id}`))
          }));
          return { empty: pageDocs.length === 0, size: pageDocs.length, docs: pageDocs };
        }
      });
      return build();
    }
  };
}

const okFetch = body => async () => ({ ok: true, status: 200, text: async () => body });

// ------------------------------------------------------------------- keying

test('exchangeKeyFor splits a NANP number into npa, nxx and thousands block', () => {
  assert.deepEqual(exchangeKeyFor('+12015524949'), {
    npa: '201', nxx: '552', block: '4', exchangeId: '201-552'
  });
});

test('exchangeKeyFor refuses numbers with no geographic exchange', () => {
  assert.equal(exchangeKeyFor('+18005551212'), null, 'toll-free has no rate centre');
  assert.equal(exchangeKeyFor('+18885551212'), null);
  assert.equal(exchangeKeyFor('+442071838750'), null, 'non-NANP');
  assert.equal(exchangeKeyFor('+1201552'), null, 'too short');
  assert.equal(exchangeKeyFor(''), null);
  assert.equal(exchangeKeyFor('+11015524949'), null, 'NPA may not start with 1');
});

// ------------------------------------------------------------------ parsing

test('parseExchangeXml reads every thousands-block record', () => {
  const records = parseExchangeXml(XML_201_552);
  assert.equal(records.length, 5);
  const byBlock = Object.fromEntries(records.map(r => [r.block, r]));
  assert.equal(byBlock['0'].lineType, 'wireless');
  assert.equal(byBlock['0'].carrier, 'OMNIPOINT COMMUNICATIONS, INC. - NJ');
  assert.equal(byBlock['2'].lineType, 'voip_or_clec');
  assert.equal(byBlock['4'].lineType, 'voip_or_clec');
  assert.equal(byBlock.A.companyType, 'C');
  assert.equal(byBlock['0'].rateCenter, 'Union City');
  assert.equal(byBlock['0'].region, 'NJ');
});

test('parseExchangeXml maps only the company types it actually knows', () => {
  assert.deepEqual(LINE_TYPE_BY_COMPANY_TYPE, { W: 'wireless', I: 'landline', C: 'voip_or_clec' });
  const odd = parseExchangeXml(
    '<root><prefixdata><npa>201</npa><nxx>552</nxx><x>1</x><company-type>Z</company-type></prefixdata></root>'
  );
  assert.equal(odd[0].companyType, 'Z');
  assert.equal(odd[0].lineType, '', 'an unknown code must not be guessed into a bucket');
});

test('parseExchangeXml degrades to an empty list rather than throwing', () => {
  assert.deepEqual(parseExchangeXml(''), []);
  assert.deepEqual(parseExchangeXml('<root><prefixdata>truncated'), []);
  assert.deepEqual(parseExchangeXml(null), []);
  assert.deepEqual(
    parseExchangeXml('<root><prefixdata><npa>20</npa><nxx>552</nxx><x>1</x></prefixdata></root>'),
    [], 'a malformed npa is dropped, not stored'
  );
});

// --------------------------------------------------------------- resolution

test('resolveBlock prefers the specific block over the whole-code record', () => {
  const blocks = blocksFromRecords(parseExchangeXml(XML_201_552));
  assert.equal(resolveBlock(blocks, '0').lineType, 'wireless');
  assert.equal(resolveBlock(blocks, '4').lineType, 'voip_or_clec');
});

test('resolveBlock falls back to the whole-code record for an unpooled block', () => {
  const blocks = blocksFromRecords(parseExchangeXml(XML_201_552));
  // Block 7 has no record of its own; `A` covers it.
  assert.equal(resolveBlock(blocks, '7').ocn, '612K');
  assert.equal(resolveBlock({}, '7'), null);
});

test('the whole point: 201-552-4949 is not classified from the first record', async () => {
  const db = fakeDb();
  const { intel } = await resolvePhoneIntel(db, '+12015524949', { fetchImpl: okFetch(XML_201_552) });
  assert.equal(intel.block, '4');
  assert.equal(intel.lineType, 'voip_or_clec');
  assert.notEqual(intel.lineType, 'wireless',
    'block 0 is wireless; keying on NPA-NXX alone would have misclassified this number');
});

// ---------------------------------------------------------------- the shape

test('phoneIntel is always triage grade and never claims a portability check', () => {
  const intel = buildPhoneIntel({
    key: { exchangeId: '201-552', block: '4' },
    record: { lineType: 'wireless', companyType: 'W', carrier: 'X' }
  });
  assert.equal(intel.evidenceGrade, PHONE_INTEL_EVIDENCE_GRADE);
  assert.equal(intel.evidenceGrade, 'triage');
  assert.equal(intel.portabilityChecked, false);
  assert.equal(intel.version, PHONE_INTEL_VERSION);
  assert.equal(intel.status, 'resolved');
});

test('block 0 survives being stored — the string "0" is not empty', async () => {
  // The second sighting of the same root cause. `clean('0')` returns '', so
  // storing the thousands-block through it emptied the field on every block-0
  // number: 194 production rows, all of them block 0, none of them any other
  // digit. `lineType` was right the whole time because resolution uses the raw
  // key, but the record could not be audited back to the block that answered.
  const intel = buildPhoneIntel({
    key: { exchangeId: '201-552', block: '0' },
    record: { lineType: 'wireless', companyType: 'W', carrier: 'OMNIPOINT', ocn: '6623' }
  });
  assert.equal(intel.block, '0');
  assert.equal(intel.exchangeId, '201-552');

  const db = fakeDb({ 'prospects/a': { phoneE164: '+12015520045' } });
  await backfillPhoneIntel(db, { fetchImpl: okFetch(XML_201_552), throttleMs: 0 });
  const stored = db.docs.get('prospects/a').phoneIntel;
  assert.equal(stored.block, '0', 'the stored block must round-trip');
  assert.equal(stored.lineType, 'wireless', 'and still resolve to block 0, not the whole-code record');
});

test('an unresolvable number is marked, not silently left blank', () => {
  const intel = unresolvablePhoneIntel({});
  assert.equal(intel.status, 'not_applicable');
  assert.equal(intel.lineType, '');
  assert.equal(intel.evidenceGrade, 'triage');
});

// -------------------------------------------------------------- the caching

test('an exchange is fetched once and served from cache thereafter', async () => {
  const db = fakeDb();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => XML_201_552 }; };

  const first = await resolvePhoneIntel(db, '+12015524949', { fetchImpl });
  const second = await resolvePhoneIntel(db, '+12015520001', { fetchImpl });

  assert.equal(calls, 1, 'the second number is in the same exchange');
  assert.equal(first.fetched, true);
  assert.equal(second.cached, true);
  assert.equal(second.intel.lineType, 'wireless', 'block 0, a different answer from the same cached document');
});

test('an upstream failure does not poison the cache with an empty answer', async () => {
  const db = fakeDb();
  const failing = async () => { throw new Error('ECONNRESET'); };
  const result = await resolvePhoneIntel(db, '+12015524949', { fetchImpl: failing });

  assert.equal(result.intel.status, 'unknown');
  assert.equal(db.writes.filter(w => w.path.startsWith('numberingExchanges/')).length, 0,
    'nothing may be cached for six months on the strength of a network error');
});

test('a non-ok response is treated as a failure, not as an empty exchange', async () => {
  const db = fakeDb();
  const result = await resolvePhoneIntel(db, '+12015524949', {
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' })
  });
  assert.equal(result.intel.status, 'unknown');
  assert.equal(db.docs.has('numberingExchanges/201-552'), false);
});

test('an expired cache entry is refetched', async () => {
  const now = new Date('2026-08-26T12:00:00Z');
  const db = fakeDb({
    'numberingExchanges/201-552': {
      blocks: { A: { lineType: 'landline' } },
      expiresAt: { toDate: () => new Date('2026-01-01T00:00:00Z') }
    }
  });
  let calls = 0;
  await lookupExchange(db, exchangeKeyFor('+12015524949'), {
    now,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => XML_201_552 }; }
  });
  assert.equal(calls, 1);
});

// -------------------------------------------------------------- the backfill

test('backfill enriches, buckets by line type and honours its limit', async () => {
  const db = fakeDb({
    'prospects/a': { phoneE164: '+12015524949' },
    'prospects/b': { phoneE164: '+12015520001' },
    'prospects/c': { phoneE164: '+16095551234' },
    'prospects/d': { phoneE164: '+18005551212' }
  });
  const fetchImpl = async url => ({
    ok: true, status: 200,
    text: async () => (String(url).includes('nxx=552') ? XML_201_552 : XML_LANDLINE)
  });

  const stats = await backfillPhoneIntel(db, { fetchImpl, throttleMs: 0, limit: 10 });

  assert.equal(stats.updated, 4);
  assert.equal(stats.byLineType.voip_or_clec, 1, 'a: block 4');
  assert.equal(stats.byLineType.wireless, 1, 'b: block 0');
  assert.equal(stats.byLineType.landline, 1, 'c');
  assert.equal(stats.byLineType.not_applicable, 1, 'd: toll-free, never looked up');
  assert.equal(db.docs.get('prospects/a').phoneIntel.lineType, 'voip_or_clec');
  assert.equal(db.docs.get('prospects/d').phoneIntel.status, 'not_applicable');
});

test('backfill skips documents already enriched at this version, and refresh overrides', async () => {
  const seed = {
    'prospects/a': {
      phoneE164: '+12015524949',
      phoneIntel: { version: PHONE_INTEL_VERSION, status: 'resolved', lineType: 'wireless' }
    }
  };
  const db = fakeDb(seed);
  const stats = await backfillPhoneIntel(db, { fetchImpl: okFetch(XML_201_552), throttleMs: 0 });
  assert.equal(stats.skipped, 1);
  assert.equal(stats.updated, 0);

  const again = await backfillPhoneIntel(fakeDb(seed), {
    fetchImpl: okFetch(XML_201_552), throttleMs: 0, refresh: true
  });
  assert.equal(again.updated, 1);
});

test('backfill pauses only for live requests, never for cache hits', async () => {
  const db = fakeDb({
    'prospects/a': { phoneE164: '+12015524949' },
    'prospects/b': { phoneE164: '+12015520001' },
    'prospects/c': { phoneE164: '+12015527777' }
  });
  const sleeps = [];
  await backfillPhoneIntel(db, {
    fetchImpl: okFetch(XML_201_552),
    throttleMs: 1500,
    sleepImpl: async ms => { sleeps.push(ms); }
  });
  assert.equal(sleeps.length, 1, 'three prospects, one exchange, one request, one pause');
  assert.deepEqual(sleeps, [1500]);
});

test('a dry run writes no contact document but does keep the exchange cache', async () => {
  const db = fakeDb({
    'prospects/a': { phoneE164: '+12015524949' },
    'prospects/b': { phoneE164: '+18005551212' }
  });
  const stats = await backfillPhoneIntel(db, {
    fetchImpl: okFetch(XML_201_552), throttleMs: 0, dryRun: true
  });

  assert.equal(stats.updated, 2, 'a rehearsal still reports the numbers the real run will produce');
  assert.equal(stats.byLineType.voip_or_clec, 1);
  assert.equal(db.writes.some(write => write.path.startsWith('prospects/')), false,
    'no contact document may be touched by a rehearsal');
  assert.equal(db.docs.has('numberingExchanges/201-552'), true,
    'the cache is kept on purpose, so the real run does not refetch from a volunteer server');
});

test('backfill resumes from its cursor rather than restarting', async () => {
  const db = fakeDb({
    'prospects/a': { phoneE164: '+12015524949' },
    'prospects/b': { phoneE164: '+12015520001' }
  });
  const first = await backfillPhoneIntel(db, { fetchImpl: okFetch(XML_201_552), throttleMs: 0, limit: 1 });
  assert.equal(first.updated, 1);
  assert.equal(first.cursor, 'a');

  const second = await backfillPhoneIntel(db, {
    fetchImpl: okFetch(XML_201_552), throttleMs: 0, cursor: first.cursor
  });
  assert.equal(second.updated, 1);
  assert.equal(db.docs.get('prospects/b').phoneIntel.status, 'resolved');
});

// ------------------------------------------------------------ the safety net

test('nothing in this module writes compliance evidence', async () => {
  const db = fakeDb({
    'prospects/a': { phoneE164: '+12015524949' },
    'prospects/b': { phoneE164: '+18005551212' }
  });
  await backfillPhoneIntel(db, { fetchImpl: okFetch(XML_201_552), throttleMs: 0 });
  await resolvePhoneIntel(db, '+16095551234', { fetchImpl: okFetch(XML_LANDLINE) });

  const forbidden = ['preDialScreenings', 'consentGrants', 'consentEvidenceCandidates', 'suppressedNumbers', 'outboundTargets'];
  for (const collection of forbidden) {
    assert.equal(
      db.writes.some(write => write.path.startsWith(`${collection}/`)), false,
      `phone intelligence must never write ${collection} — it verifies nothing an outside authority verified`
    );
  }
  const touched = [...new Set(db.writes.map(write => write.path.split('/')[0]))].sort();
  assert.deepEqual(touched, ['numberingExchanges', 'prospects']);
});

test('every stored phoneIntel carries the triage grade, whatever path wrote it', async () => {
  const db = fakeDb({
    'prospects/a': { phoneE164: '+12015524949' },
    'prospects/b': { phoneE164: '+18005551212' }
  });
  await backfillPhoneIntel(db, { fetchImpl: okFetch(XML_201_552), throttleMs: 0 });
  for (const id of ['a', 'b']) {
    assert.equal(db.docs.get(`prospects/${id}`).phoneIntel.evidenceGrade, 'triage');
    assert.equal(db.docs.get(`prospects/${id}`).phoneIntel.portabilityChecked, false);
  }
});

// ------------------------------------------------- the two-copies-of-the-SDK bug

test('every written time is a plain Date, not an SDK Timestamp', async () => {
  // The backfill script resolves firebase-admin from the repository root while
  // the Functions runtime resolves it from functions/node_modules. A Timestamp
  // minted by one copy fails the other's instanceof check and Firestore rejects
  // the whole write. Plain Dates cross that boundary; this test is what stops a
  // well-meaning "use serverTimestamp like everything else" edit from silently
  // breaking the script again.
  const db = fakeDb({ 'prospects/a': { phoneE164: '+12015524949' } });
  await backfillPhoneIntel(db, { fetchImpl: okFetch(XML_201_552), throttleMs: 0 });

  const times = [];
  const walk = value => {
    if (value instanceof Date) { times.push(value); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const write of db.writes) walk(write.value);

  assert.ok(times.length >= 3, 'expected fetchedAt, expiresAt, updatedAt and checkedAt');
  for (const write of db.writes) {
    const serialised = JSON.stringify(write.value);
    assert.equal(serialised.includes('_seconds'), false, 'a Timestamp leaked into a write');
    assert.equal(serialised.includes('serverTimestamp'), false, 'a FieldValue sentinel leaked into a write');
  }
  assert.ok(db.docs.get('prospects/a').phoneIntel.checkedAt instanceof Date);
  assert.ok(db.docs.get('numberingExchanges/201-552').expiresAt instanceof Date);
});

test('a cached expiry reads the same whether stored as a Date or a Timestamp', async () => {
  const now = new Date('2026-08-26T12:00:00Z');
  const fresh = new Date('2027-01-01T00:00:00Z');
  const shapes = {
    date: fresh,
    timestamp: { toDate: () => fresh },
    iso: fresh.toISOString()
  };
  for (const [label, expiresAt] of Object.entries(shapes)) {
    const db = fakeDb({
      'numberingExchanges/201-552': { blocks: { A: { lineType: 'landline' } }, expiresAt }
    });
    let calls = 0;
    const result = await lookupExchange(db, exchangeKeyFor('+12015524949'), {
      now,
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => XML_201_552 }; }
    });
    assert.equal(calls, 0, `${label}: an unexpired cache entry must not refetch`);
    assert.equal(result.cached, true, `${label}: served from cache`);
  }
});

// --------------------------------------------------------- transient failures

test('a transient Firestore failure is retried, not fatal', async () => {
  const { withFirestoreRetry } = await import('./phone-intelligence.js');
  let calls = 0;
  const result = await withFirestoreRetry(async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error('Deadline exceeded after 514.425s');
      error.code = 4;
      throw error;
    }
    return 'written';
  }, { sleepImpl: async () => {} });

  assert.equal(result, 'written');
  assert.equal(calls, 3);
});

test('a non-transient Firestore failure surfaces immediately', async () => {
  const { withFirestoreRetry } = await import('./phone-intelligence.js');
  let calls = 0;
  await assert.rejects(
    () => withFirestoreRetry(async () => {
      calls += 1;
      const error = new Error('invalid document reference');
      error.code = 3; // INVALID_ARGUMENT — retrying cannot help
      throw error;
    }, { sleepImpl: async () => {} }),
    /invalid document reference/
  );
  assert.equal(calls, 1, 'a caller bug must not be retried four times');
});

test('a backfill survives a transient write failure mid-run', async () => {
  // Exactly the production failure: 200 documents in, one `set` times out.
  // Before the retry existed this killed the process and the run had to be
  // resumed by hand.
  let failures = 0;
  const db = fakeDb(
    {
      'prospects/a': { phoneE164: '+12015524949' },
      'prospects/b': { phoneE164: '+12015520001' }
    },
    {
      beforeSet: async path => {
        if (path === 'prospects/a' && failures === 0) {
          failures += 1;
          const error = new Error('Deadline exceeded after 514.425s');
          error.code = 4;
          throw error;
        }
      }
    }
  );

  const stats = await backfillPhoneIntel(db, {
    fetchImpl: okFetch(XML_201_552), throttleMs: 0, sleepImpl: async () => {}
  });

  assert.equal(failures, 1, 'the injected failure must actually have fired');
  assert.equal(stats.updated, 2, 'both documents land despite the transient failure');
  assert.equal(db.docs.get('prospects/a').phoneIntel.status, 'resolved');
  assert.equal(db.docs.get('prospects/b').phoneIntel.status, 'resolved');
});

test('a backfill survives a transient failure on the page read', async () => {
  // The second production failure, and a different code path from the write
  // retry above: the run died on `query.get()` after 1,200 records, because a
  // throttled loop leaves the channel idle long enough for the next page query
  // to time out. Writes were already retried; reads were not.
  const db = fakeDb({
    'prospects/a': { phoneE164: '+12015524949' },
    'prospects/b': { phoneE164: '+12015520001' }
  });
  let reads = 0;
  const originalCollection = db.collection.bind(db);
  db.collection = name => {
    const chain = originalCollection(name);
    const wrap = node => ({
      orderBy: (...args) => wrap(node.orderBy(...args)),
      limit: (...args) => wrap(node.limit(...args)),
      startAfter: (...args) => wrap(node.startAfter(...args)),
      async get() {
        reads += 1;
        if (reads === 1) {
          const error = new Error('Deadline exceeded after 60.005s');
          error.code = 4;
          throw error;
        }
        return node.get();
      }
    });
    return wrap(chain);
  };

  const stats = await backfillPhoneIntel(db, {
    fetchImpl: okFetch(XML_201_552), throttleMs: 0, sleepImpl: async () => {}
  });

  assert.ok(reads > 1, 'the injected read failure must actually have fired');
  assert.equal(stats.updated, 2, 'the run continues past a timed-out page query');
});

// ----------------------------------------------------------------- bulk path

test('bulk ingest writes the same block shape and records its own source', async () => {
  const db = fakeDb();
  const result = await ingestExchangeRecords(db, [
    { npa: '201', nxx: '552', block: '0', companyType: 'W', carrier: 'OMNIPOINT', ocn: '6623', rateCenter: 'Union City', region: 'NJ' },
    { npa: '201', nxx: '552', block: '4', companyType: 'C', carrier: 'ONVOY', ocn: '637C' },
    { npa: 'xx', nxx: '552', block: '4', companyType: 'C' }
  ]);
  assert.equal(result.exchanges, 1);
  const stored = db.docs.get('numberingExchanges/201-552');
  assert.equal(stored.source, 'nanpa_bulk');
  assert.equal(stored.blocks['0'].lineType, 'wireless');
  assert.equal(stored.blocks['4'].lineType, 'voip_or_clec');
  assert.equal(stored.blockCount, 2, 'the malformed row is dropped');
});
