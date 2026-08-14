import { createHmac, timingSafeEqual } from 'node:crypto';

// Hybrid calls created before query canonicalisation shipped used this exact
// metadata order. Firebase Hosting sorts the same query by key when it rewrites
// the request to Cloud Functions, so the receiver must try the original order
// for callbacks from those already-created calls.
const LEGACY_METADATA_ORDER = ['campaignId', 'targetId', 'sessionId', 'legIndex'];

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

export function twilioFormSignature(url, body, authToken) {
  let payload = url;
  for (const key of Object.keys(body || {}).sort()) {
    const values = Array.isArray(body[key])
      ? [...body[key]].map(String).sort()
      : [String(body[key])];
    for (const value of values) payload += `${key}${value}`;
  }
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');
}

export function hybridWebhookUrlCandidates(originalUrl, publicOrigin) {
  let forwarded;
  try {
    forwarded = String(originalUrl || '').startsWith('http')
      ? new URL(String(originalUrl))
      : new URL(String(originalUrl || ''), publicOrigin);
  } catch {
    return [];
  }

  // The public host is part of Twilio's signature even though the Firebase
  // function itself sees an internal Cloud Run host behind Hosting/Cloudflare.
  let canonical;
  try {
    const origin = new URL(publicOrigin).origin;
    canonical = new URL(`${forwarded.pathname}${forwarded.search}`, origin);
  } catch {
    return [];
  }

  const candidates = [canonical.toString()];
  if (LEGACY_METADATA_ORDER.every(key => canonical.searchParams.has(key))) {
    const legacy = new URL(canonical.pathname, canonical.origin);
    for (const key of LEGACY_METADATA_ORDER) {
      for (const value of canonical.searchParams.getAll(key)) legacy.searchParams.append(key, value);
    }
    for (const [key, value] of canonical.searchParams.entries()) {
      if (!LEGACY_METADATA_ORDER.includes(key)) legacy.searchParams.append(key, value);
    }
    candidates.push(legacy.toString());
  }

  return [...new Set(candidates)];
}

export function validHybridTwilioRequest({
  signature,
  body,
  authToken,
  originalUrl,
  publicOrigin
}) {
  if (!signature || !authToken || !publicOrigin) return false;
  return hybridWebhookUrlCandidates(originalUrl, publicOrigin)
    .some(url => safeEqual(signature, twilioFormSignature(url, body, authToken)));
}
