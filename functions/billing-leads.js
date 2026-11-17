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
export const LEAD_COUNT_TIME_ZONE = 'America/New_York';

/** Turn a WordPress error response into one sentence an admin can act on. */
export function describeLeadCountError(status, body, host) {
  const code = String(body?.code || '');
  const detail = body?.message ? ` (${String(body.message).slice(0, 160)})` : '';
  switch (code) {
    case 'bitesites_secret_mismatch':
      return `${host} rejected the key: BiteSites' WP_LEADS_SECRET doesn't match BITESITES_LEADS_SECRET on the site. Re-set one to match the other.`;
    case 'bitesites_secret_missing':
      return `${host} says the request had no X-BiteSites-Secret header. A proxy or security plugin may be stripping custom headers.`;
    case 'bitesites_not_configured':
      return `The lead-count plugin is active on ${host}, but its BITESITES_LEADS_SECRET isn't set. Reinstall the plugin zip that includes the key.`;
    case 'bitesites_https_required':
      return `${host} only answers lead-count requests over HTTPS. Use an https:// endpoint.`;
    case 'bitesites_bad_range':
      return `${host} refused the date range${detail}.`;
    case 'bitesites_no_lead_table':
      return `${host} has the plugin but no lead table, so there is nothing to count. Check the site's lead capture.`;
    case 'bitesites_query_failed':
      return `${host} couldn't read its lead table (database error). Try again, then check the site's error log.`;
    case 'rest_no_route':
      return `The lead-count plugin isn't active on ${host} (no /bitesites/v1/lead-count route). Activate it under Plugins.`;
    default:
      break;
  }
  if (status === 401 || status === 403) return `${host} refused the request (HTTP ${status})${detail}. A firewall or security plugin may be blocking it.`;
  if (status === 404) return `Nothing at that URL on ${host} (HTTP 404). Check the endpoint in the client's lead source.`;
  if (status === 429) return `${host} is rate-limiting requests (HTTP 429). Try again in a few minutes.`;
  if (status >= 500) return `${host} had a server error (HTTP ${status})${detail}. Try again shortly.`;
  return `${host} returned HTTP ${status}${detail}.`;
}

/**
 * GET {endpoint}?start=YYYY-MM-DD&end=YYYY-MM-DD (end exclusive, New York midnights).
 * Resolves to { count, excludedTest, duplicates } or throws with an actionable reason.
 */
export async function fetchWordPressLeadCount({ endpoint, secret, start, endExclusive, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  if (!secret || secret === 'unset') throw new Error('BiteSites has no WP_LEADS_SECRET set. Run: firebase functions:secrets:set WP_LEADS_SECRET');
  if (String(secret).length < 24) throw new Error('BiteSites\' WP_LEADS_SECRET is shorter than 24 characters; the site will refuse it. Set the full key.');
  if (!isIsoDate(start) || !isIsoDate(endExclusive) || start >= endExclusive) throw new Error(`Invalid lead-count date range ${start} → ${endExclusive}.`);
  let url;
  try { url = new URL(endpoint); } catch { throw new Error(`The client's lead endpoint "${String(endpoint).slice(0, 120)}" isn't a valid URL.`); }
  if (url.protocol !== 'https:') throw new Error('The client\'s lead endpoint must start with https://.');
  const host = url.hostname;
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
    if (error?.name === 'AbortError') throw new Error(`${host} didn't answer within ${Math.round(timeoutMs / 1000)}s. The site may be down or slow; try again.`);
    const reason = String(error?.cause?.code || error?.message || 'network error');
    if (/redirect/i.test(reason)) throw new Error(`${host} redirected the request. Use the final URL (check www vs. non-www) in the client's lead source.`);
    throw new Error(`Couldn't reach ${host} (${reason}). Check the domain and that the site is up.`);
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(describeLeadCountError(response.status, body, host));
  if (!body || typeof body !== 'object') throw new Error(`${host} answered, but not with JSON. A cache or maintenance page may be in front of the endpoint.`);
  if (body.timezone !== LEAD_COUNT_TIME_ZONE) {
    throw new Error(`The lead-count plugin on ${host} counts months in "${body.timezone || 'unknown'}" time, not ${LEAD_COUNT_TIME_ZONE}. Update it to v1.1+ so months split at New York midnight.`);
  }
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 0) throw new Error(`${host} answered without a valid lead count.`);
  return {
    count,
    excludedTest: Number.isInteger(body.excluded_test) ? body.excluded_test : null,
    duplicates: Number.isInteger(body.duplicates) ? body.duplicates : null
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
