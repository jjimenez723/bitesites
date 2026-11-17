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
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ count: 7, excluded_test: 2, duplicates: 1 }) }; };
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
    [respond(401, { code: 'forbidden' }), /rejected the lead-count secret/],
    [respond(404, {}), /not installed/],
    [respond(500, {}), /returned 500/],
    [respond(200, { count: 'twelve' }), /no usable count/],
    [async () => { throw new TypeError('getaddrinfo ENOTFOUND'); }, /Could not reach/],
    [async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }, /did not answer in time/]
  ];
  for (const [fetchImpl, reason] of cases) {
    const result = await resolveLeadCount(CAAH_BILLING_CLIENT, november, { secret, fetchImpl });
    assert.equal(result.leadCount, null);
    assert.equal(result.leadPull.status, 'failed');
    assert.match(result.leadPull.error, reason);
  }
  const missingSecret = await resolveLeadCount(CAAH_BILLING_CLIENT, november, { secret: '', fetchImpl: respond(200, { count: 3 }) });
  assert.equal(missingSecret.leadCount, null);
  assert.match(missingSecret.leadPull.error, /WP_LEADS_SECRET/);
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
