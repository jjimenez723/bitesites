// Twilio Trust Hub compliance-profile status callback.
//
// Twilio signs every webhook with the account Auth Token. We verify that
// signature before persisting the profile's latest review state and an
// idempotent event record for audit/debugging.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const CALLBACK_URLS = [
  'https://us-central1-bitesites-org.cloudfunctions.net/recordTwilioComplianceStatus',
  'https://bitesites.org/api/twilio-compliance-status'
];
const PROFILE_STATUSES = new Set([
  'draft', 'pending-review', 'in-review', 'twilio-rejected', 'twilio-approved'
]);

const text = (value, maxLength = 500) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().slice(0, maxLength)
    : '';

const field = (body, ...names) => {
  for (const name of names) {
    if (body?.[name] !== undefined && body[name] !== null) return body[name];
  }
  return '';
};

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

// Twilio's form webhook signature is HMAC-SHA1(URL + alphabetically sorted
// POST parameter names/values). Array values are sorted, matching Twilio's
// RequestValidator behavior for repeated form fields.
export function twilioSignature(url, body, authToken) {
  let value = url;
  for (const key of Object.keys(body || {}).sort()) {
    const values = Array.isArray(body[key]) ? [...body[key]].map(String).sort() : [String(body[key])];
    for (const item of values) value += `${key}${item}`;
  }
  return createHmac('sha1', authToken).update(value).digest('base64');
}

export function validTwilioRequest({ signature, body, authToken, url }) {
  if (!signature || !authToken) return false;
  const urls = url ? [url] : CALLBACK_URLS;
  return urls.some(candidate => safeEqual(signature, twilioSignature(candidate, body, authToken)));
}

const normalizedErrors = value => {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [value]
      : text(value, 2000)
        ? [{ message: value }]
        : [];
  return items.slice(0, 25).map(error => ({
    code: text(error?.code ?? error?.error_code ?? error?.ErrorCode, 80),
    message: text(
      error?.message ?? error?.failure_reason ?? error?.description ?? error?.Message,
      2000
    )
  })).filter(error => error.code || error.message);
};

export const recordTwilioComplianceStatus = onRequest(
  { secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN], maxInstances: 5 },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
      return;
    }

    const authToken = text(TWILIO_AUTH_TOKEN.value(), 500);
    const signature = text(req.get('x-twilio-signature'), 500);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!validTwilioRequest({ signature, body, authToken })) {
      res.status(401).json({ error: 'invalid-signature' });
      return;
    }

    const accountSid = text(field(body, 'AccountSid', 'AccountSID', 'account_sid', 'accountSid'), 34);
    const expectedAccountSid = text(TWILIO_ACCOUNT_SID.value(), 34);
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid) || accountSid !== expectedAccountSid) {
      res.status(403).json({ error: 'wrong-account' });
      return;
    }

    const profileSid = text(field(
      body,
      'CustomerProfileSid', 'CustomerProfileSID', 'customer_profile_sid', 'customerProfileSid',
      'BundleSid', 'BundleSID', 'bundle_sid', 'bundleSid', 'Sid', 'SID', 'sid'
    ), 34);
    const status = text(field(body, 'Status', 'status'), 40).toLowerCase().replaceAll('_', '-');
    if (!/^BU[0-9a-fA-F]{32}$/.test(profileSid) || !PROFILE_STATUSES.has(status)) {
      res.status(400).json({ error: 'invalid-profile-event' });
      return;
    }

    const errors = normalizedErrors(field(body, 'Errors', 'errors', 'FailureReason', 'failure_reason'));
    const eventId = createHash('sha256').update(JSON.stringify({ profileSid, status, errors })).digest('hex');
    const db = getFirestore();
    const profileRef = db.doc(`twilioComplianceProfiles/${profileSid}`);
    const eventRef = profileRef.collection('events').doc(eventId);
    const batch = db.batch();
    batch.set(profileRef, {
      accountSid, profileSid, status, errors,
      updatedAt: FieldValue.serverTimestamp(),
      source: 'twilio-trust-hub'
    }, { merge: true });
    batch.set(eventRef, {
      accountSid, profileSid, status, errors,
      receivedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await batch.commit();

    console.log(`[twilio-compliance] ${profileSid} is ${status}`);
    res.status(200).json({ ok: true });
  }
);
