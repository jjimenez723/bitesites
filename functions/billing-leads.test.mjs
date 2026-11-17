import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fetchWordPressLeadCount, LEAD_SECRET_HEADER, resolveLeadCount } from './billing-leads.js';
import { periodForMonth } from './billing-math.js';
import { CAAH_BILLING_CLIENT } from '../scripts/billing-fixtures.mjs';

// Generated per run; never a committed literal.
const secret = randomBytes(24).toString('hex');
const november = periodForMonth('2026-11');
const respond = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });

test('asks the WordPress endpoint for an end-exclusive range with the shared secret', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ count: 7, excluded_test: 2, duplicates: 1, timezone: 'America/New_York' }) }; };
  const result = await resolveLeadCount(CAAH_BILLING_CLIENT, november, { secret, fetchImpl });
  assert.equal(result.leadCount, 7);
  assert.equal(result.leadPull.status, 'pulled');
  assert.equal(result.leadPull.excludedTest, 2);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://cliftonaveanimalhospital.com/wp-json/bitesites/v1/lead-count');
  assert.equal(url.searchParams.get('start'), '2026-11-01');
  assert.equal(url.searchParams.get('end'), '2026-12-01');
  assert.equal(calls[0].init.headers[LEAD_SECRET_HEADER], secret);
  assert.equal(calls[0].init.redirect, 'error', 'the secret must never follow a redirect to another host');
});

test('every failure falls back to an empty count with a reason, never a guess', async () => {
  const cases = [
    [respond(401, { code: 'bitesites_secret_mismatch' }), /WP_LEADS_SECRET doesn't match BITESITES_LEADS_SECRET/],
    [respond(401, { code: 'bitesites_secret_missing' }), /no X-BiteSites-Secret header/],
    [respond(503, { code: 'bitesites_not_configured' }), /BITESITES_LEADS_SECRET isn't set/],
    [respond(404, { code: 'rest_no_route' }), /isn't active on cliftonaveanimalhospital\.com/],
    [respond(404, {}), /HTTP 404/],
    [respond(403, { code: 'other' }), /firewall or security plugin/],
    [respond(500, { code: 'bitesites_query_failed' }), /couldn't read its lead table/],
    [respond(502, {}), /server error \(HTTP 502\)/],
    [respond(200, null), /not with JSON/],
    [respond(200, { count: 5, timezone: '+00:00' }), /counts months in "\+00:00" time/],
    [respond(200, { count: 'twelve', timezone: 'America/New_York' }), /without a valid lead count/],
    [async () => { const error = new TypeError('fetch failed'); error.cause = { code: 'ENOTFOUND' }; throw error; }, /Couldn't reach cliftonaveanimalhospital\.com \(ENOTFOUND\)/],
    [async () => { throw new TypeError('unexpected redirect'); }, /redirected the request/],
    [async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }, /didn't answer within 10s/]
  ];
  for (const [fetchImpl, reason] of cases) {
    const result = await resolveLeadCount(CAAH_BILLING_CLIENT, november, { secret, fetchImpl });
    assert.equal(result.leadCount, null);
    assert.equal(result.leadPull.status, 'failed');
    assert.match(result.leadPull.error, reason);
  }
  const missingSecret = await resolveLeadCount(CAAH_BILLING_CLIENT, november, { secret: '', fetchImpl: respond(200, { count: 3 }) });
  assert.equal(missingSecret.leadCount, null);
  assert.match(missingSecret.leadPull.error, /no WP_LEADS_SECRET set/);
  const shortSecret = await resolveLeadCount(CAAH_BILLING_CLIENT, november, { secret: 'short', fetchImpl: respond(200, { count: 3 }) });
  assert.match(shortSecret.leadPull.error, /shorter than 24 characters/);
});

test('manual lead sources wait for the admin and make no request', async () => {
  let called = false;
  const result = await resolveLeadCount({ ...CAAH_BILLING_CLIENT, leadSource: { type: 'manual' } }, november, {
    secret, fetchImpl: async () => { called = true; }
  });
  assert.equal(called, false);
  assert.equal(result.leadCount, null);
  assert.equal(result.leadPull.status, 'awaiting_entry');
});

test('refuses non-https endpoints and bad ranges before sending the secret', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(fetchWordPressLeadCount({ endpoint: 'http://example.com/x', secret, start: '2026-11-01', endExclusive: '2026-12-01', fetchImpl }), /https/);
  await assert.rejects(fetchWordPressLeadCount({ endpoint: 'https://example.com/x', secret, start: '2026-12-01', endExclusive: '2026-11-01', fetchImpl }), /range/);
  assert.equal(called, false);
});

test('consecutive months request back-to-back, non-overlapping New York ranges', async () => {
  const seen = [];
  const fetchImpl = async url => { const u = new URL(url); seen.push([u.searchParams.get('start'), u.searchParams.get('end')]); return { ok: true, status: 200, json: async () => ({ count: 1, timezone: 'America/New_York' }) }; };
  for (const key of ['2026-11', '2026-12', '2027-01', '2027-02', '2028-02']) {
    await resolveLeadCount(CAAH_BILLING_CLIENT, periodForMonth(key), { secret, fetchImpl });
  }
  assert.deepEqual(seen, [
    ['2026-11-01', '2026-12-01'], ['2026-12-01', '2027-01-01'], ['2027-01-01', '2027-02-01'],
    ['2027-02-01', '2027-03-01'], ['2028-02-01', '2028-03-01']
  ]);
  for (let i = 1; i < 3; i += 1) assert.equal(seen[i][0], seen[i - 1][1], 'each month starts exactly where the last ended');
});
