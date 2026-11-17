// Lead counts for the "Lead Generation" invoice line.
//
// A client whose leadSource.type is 'wordpress' exposes the BiteSites lead-count
// plugin (integrations/wordpress/bitesites-lead-count/) on its site. BiteSites
// asks it for the number of operational leads in the billing month, sending the
// shared secret WP_LEADS_SECRET in a header. The endpoint returns counts only —
// never names, emails or phone numbers.
//
// Any failure leaves the count empty rather than guessing: the invoice stays a
// draft, the admin sees why, and can retry the pull or type the number in.

import { addDays, isIsoDate } from './billing-math.js';

export const LEAD_SECRET_HEADER = 'X-BiteSites-Secret';
const TIMEOUT_MS = 10_000;

/**
 * GET {endpoint}?start=YYYY-MM-DD&end=YYYY-MM-DD (end exclusive).
 * Resolves to { count, excludedTest, duplicates } or throws with a short reason.
 */
export async function fetchWordPressLeadCount({ endpoint, secret, start, endExclusive, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  if (!secret || String(secret).length < 24 || secret === 'unset') throw new Error('WP_LEADS_SECRET is not configured.');
  if (!isIsoDate(start) || !isIsoDate(endExclusive) || start >= endExclusive) throw new Error('Invalid lead-count date range.');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('The WordPress lead endpoint is not a valid URL.'); }
  if (url.protocol !== 'https:') throw new Error('The WordPress lead endpoint must use https.');
  url.searchParams.set('start', start);
  url.searchParams.set('end', endExclusive);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', [LEAD_SECRET_HEADER]: String(secret) },
      signal: controller.signal,
      redirect: 'error'
    });
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'The WordPress site did not answer in time.' : `Could not reach the WordPress site (${error?.message || 'network error'}).`);
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) throw new Error('The WordPress site rejected the lead-count secret.');
  if (response.status === 404) throw new Error('The lead-count plugin is not installed or active on the WordPress site.');
  if (!response.ok) throw new Error(`The WordPress lead endpoint returned ${response.status}.`);
  const count = Number(body?.count);
  if (!Number.isInteger(count) || count < 0) throw new Error('The WordPress lead endpoint returned no usable count.');
  return {
    count,
    excludedTest: Number.isInteger(body?.excluded_test) ? body.excluded_test : null,
    duplicates: Number.isInteger(body?.duplicates) ? body.duplicates : null
  };
}

/**
 * The lead count for a client and billing period, or a documented reason why
 * there is none. Never throws: a failed pull must not stop invoice creation.
 */
export async function resolveLeadCount(client, period, { secret, fetchImpl = fetch, now = new Date() } = {}) {
  const at = now.toISOString();
  if (client?.leadSource?.type !== 'wordpress' || !client.leadSource.endpoint) {
    return { leadCount: null, leadPull: { source: 'manual', status: 'awaiting_entry', at } };
  }
  try {
    const result = await fetchWordPressLeadCount({
      endpoint: client.leadSource.endpoint,
      secret,
      start: period.periodStart,
      endExclusive: addDays(period.periodEnd, 1),
      fetchImpl
    });
    return {
      leadCount: result.count,
      leadPull: { source: 'wordpress', status: 'pulled', at, excludedTest: result.excludedTest, duplicates: result.duplicates }
    };
  } catch (error) {
    return { leadCount: null, leadPull: { source: 'wordpress', status: 'failed', at, error: String(error?.message || error).slice(0, 300) } };
  }
}
