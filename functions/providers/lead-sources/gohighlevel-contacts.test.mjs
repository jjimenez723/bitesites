// The read-only GoHighLevel contact source.
//
// Two kinds of assertion here, and the second kind is the point. The first
// checks that reading works: pagination, bounds, retries, normalisation. The
// second checks that *only* reading is possible — that no request other than
// the contact search is ever issued, that the write endpoints are refused
// before a request is built, and that a CRM field claiming consent does not
// become consent.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GoHighLevelContactsSource, GoHighLevelContactsError, GoHighLevelReadOnlyViolation,
  FORBIDDEN_WRITE_PATHS, MAX_PAGE_SIZE, MAX_RECORDS,
  assertReadOnlyRequest, normalizeGoHighLevelContact, toProspectFields,
  readGoHighLevelContacts, dndChannels
} from './gohighlevel-contacts.js';
import { buildProspect } from '../../prospect-normalization.js';
import { GoHighLevelDialer } from '../calling/gohighlevel.js';

const LOCATION = 'LDL5wuJlnVnqk9vn6taD';

const contact = (index, overrides = {}) => ({
  id: `ghl_${index}`,
  locationId: LOCATION,
  contactName: `Contact ${index}`,
  companyName: `Company ${index}`,
  phone: `+1201555${String(1000 + index).slice(-4)}`,
  email: `contact${index}@example.test`,
  timezone: 'America/New_York',
  state: 'NJ',
  city: 'Ridgewood',
  tags: ['client:bitesites'],
  source: 'website form',
  dateAdded: '2026-01-05T12:00:00.000Z',
  dateUpdated: '2026-02-05T12:00:00.000Z',
  searchAfter: [1704456000000, `ghl_${index}`],
  ...overrides
});

/**
 * A fetch that records every call and replays a scripted queue of responses.
 * `calls` is what the read-only assertions are made against.
 */
function recordingFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({ url: String(url), method: options?.method, headers: options?.headers,
      body: options?.body ? JSON.parse(options.body) : null });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    if (typeof next === 'function') return next();
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => JSON.stringify(next.body ?? {}),
      json: async () => next.body ?? {}
    };
  };
  impl.calls = calls;
  return impl;
}

const source = (fetchImpl, overrides = {}) => new GoHighLevelContactsSource({
  token: 'read-only-test-token',
  locationId: LOCATION,
  accountId: 'bitesites',
  fetchImpl,
  sleepImpl: async () => {},
  ...overrides
});

// ---------------------------------------------------------------- read-only

test('the endpoint allow-list refuses every documented write path', () => {
  assert.equal(assertReadOnlyRequest('POST', '/contacts/search'), 'POST /contacts/search');

  for (const path of FORBIDDEN_WRITE_PATHS) {
    assert.throws(() => assertReadOnlyRequest('POST', path), GoHighLevelReadOnlyViolation, path);
    assert.throws(() => assertReadOnlyRequest('PUT', path), GoHighLevelReadOnlyViolation, path);
    assert.throws(() => assertReadOnlyRequest('DELETE', path), GoHighLevelReadOnlyViolation, path);
  }

  // The concrete enrolment path the calling adapter uses, spelled out, because
  // "no writes" is only meaningful against the write that actually exists.
  assert.throws(
    () => assertReadOnlyRequest('POST', '/contacts/abc123/workflow/wf_9'),
    GoHighLevelReadOnlyViolation
  );
  assert.throws(() => assertReadOnlyRequest('POST', '/contacts/upsert'), GoHighLevelReadOnlyViolation);
  // Even the search path with the wrong verb is refused.
  assert.throws(() => assertReadOnlyRequest('GET', '/contacts/search'), GoHighLevelReadOnlyViolation);
});

test('a full read contacts the search endpoint and nothing else', async () => {
  const fetchImpl = recordingFetch([
    { status: 200, body: { contacts: [contact(1), contact(2)], total: 2 } }
  ]);
  const result = await source(fetchImpl, { pageSize: 5 }).readAll();

  assert.equal(result.records.length, 2);
  assert.equal(fetchImpl.calls.length, 1);
  for (const call of fetchImpl.calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://services.leadconnectorhq.com/contacts/search');
  }
  // No request anywhere in the log touched an upsert, a tag, a workflow, an
  // opportunity, a conversation or the Voice AI surface.
  const everything = JSON.stringify(fetchImpl.calls);
  for (const fragment of ['upsert', 'workflow', 'opportunit', 'conversations', 'voice-ai', '/tags']) {
    assert.equal(everything.includes(fragment), false, `request log must not mention ${fragment}`);
  }
  assert.deepEqual(result.requests, ['POST /contacts/search']);
});

test('the request is scoped to the configured location and carries the read token', async () => {
  const fetchImpl = recordingFetch([{ status: 200, body: { contacts: [contact(1)] } }]);
  await source(fetchImpl, { pageSize: 10 }).readAll();

  const [call] = fetchImpl.calls;
  assert.equal(call.body.locationId, LOCATION);
  assert.equal(call.headers.Authorization, 'Bearer read-only-test-token');
  assert.equal(call.headers.Version, '2021-07-28');
});

test('a contact from another location aborts the read rather than being normalised', async () => {
  const fetchImpl = recordingFetch([
    { status: 200, body: { contacts: [contact(1), contact(2, { locationId: 'someone-elses-location' })] } }
  ]);
  await assert.rejects(
    () => source(fetchImpl).readAll(),
    error => error instanceof GoHighLevelContactsError && /different location/i.test(error.message)
  );
});

// -------------------------------------------------------------- pagination

test('pagination threads the cursor and stops on a short page', async () => {
  const fetchImpl = recordingFetch([
    { status: 200, body: { contacts: [contact(1), contact(2)], total: 3 } },
    { status: 200, body: { contacts: [contact(3)], total: 3 } }
  ]);
  const result = await source(fetchImpl, { pageSize: 2 }).readAll();

  assert.equal(result.records.length, 3);
  assert.equal(result.pages, 2);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, false);
  assert.equal(fetchImpl.calls[0].body.searchAfter, undefined);
  assert.deepEqual(fetchImpl.calls[1].body.searchAfter, [1704456000000, 'ghl_2']);
});

test('a page with no cursor ends the read even when it is full', async () => {
  const noCursor = { ...contact(1), searchAfter: undefined };
  const fetchImpl = recordingFetch([{ status: 200, body: { contacts: [noCursor] } }]);
  const result = await source(fetchImpl, { pageSize: 1 }).readAll();
  assert.equal(result.pages, 1);
  assert.equal(result.records.length, 1);
});

test('page size and record count are bounded, and truncation is reported', async () => {
  const oversized = source(recordingFetch([]), { pageSize: 5000, maxRecords: 10 ** 9 });
  assert.equal(oversized.pageSize, MAX_PAGE_SIZE);
  assert.equal(oversized.maxRecords, MAX_RECORDS);

  const fetchImpl = recordingFetch([
    { status: 200, body: { contacts: [contact(1), contact(2)] } },
    { status: 200, body: { contacts: [contact(3), contact(4)] } }
  ]);
  const result = await source(fetchImpl, { pageSize: 2, maxRecords: 3 }).readAll();
  assert.equal(result.records.length, 3);
  assert.equal(result.truncated, true, 'a capped read must announce that it stopped early');
});

// --------------------------------------------------------- errors and retry

test('429 and 5xx are retried with backoff; the sleep is real work, not a no-op', async () => {
  const slept = [];
  const fetchImpl = recordingFetch([
    { status: 429, body: {} },
    { status: 503, body: {} },
    { status: 200, body: { contacts: [contact(1)] } }
  ]);
  const reader = source(fetchImpl, { pageSize: 5, sleepImpl: async ms => { slept.push(ms); } });
  const result = await reader.readAll();

  assert.equal(result.records.length, 1);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(slept.length, 2);
  assert.ok(slept[1] > slept[0], 'backoff must grow between attempts');
});

test('retries are exhausted rather than infinite', async () => {
  const fetchImpl = recordingFetch(Array.from({ length: 4 }, () => ({ status: 500, body: {} })));
  await assert.rejects(
    () => source(fetchImpl, { retries: 3 }).readAll(),
    error => error instanceof GoHighLevelContactsError && error.status === 500
  );
  assert.equal(fetchImpl.calls.length, 4, 'one attempt plus three retries');
});

test('a 4xx that is not rate limiting fails immediately', async () => {
  const fetchImpl = recordingFetch([{ status: 403, body: { message: 'insufficient scope' } }]);
  await assert.rejects(
    () => source(fetchImpl, { retries: 3 }).readAll(),
    error => error instanceof GoHighLevelContactsError && /insufficient scope/.test(error.message)
  );
  assert.equal(fetchImpl.calls.length, 1, 'a scope error must not be retried');
});

test('a request timeout is reported as a timeout', async () => {
  const abort = () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
  const fetchImpl = recordingFetch([abort, abort]);
  await assert.rejects(
    () => source(fetchImpl, { retries: 1 }).readAll(),
    error => /timed out/i.test(error.message)
  );
});

test('a missing read token or an unknown account refuses before any request', async () => {
  const fetchImpl = recordingFetch([]);
  await assert.rejects(
    () => readGoHighLevelContacts({ token: '', locationId: LOCATION, accountId: 'bitesites', fetchImpl }),
    /GHL_CONTACTS_READ_TOKEN/
  );
  await assert.rejects(
    () => readGoHighLevelContacts({ token: 't', locationId: LOCATION, accountId: 'not-a-seller', fetchImpl }),
    /not a known account/
  );
  await assert.rejects(
    () => readGoHighLevelContacts({ token: 't', locationId: '', accountId: 'bitesites', fetchImpl }),
    /location id/
  );
  assert.equal(fetchImpl.calls.length, 0, 'nothing may be requested before the config validates');
});

test('the adapter names a read-only credential, not the dialer token', () => {
  assert.deepEqual(GoHighLevelContactsSource.requiredSecrets, ['GHL_CONTACTS_READ_TOKEN']);
  assert.equal(GoHighLevelContactsSource.requiredSecrets.includes('GHL_API_TOKEN'), false);
});

test('autonomous GoHighLevel AI calling stays disabled', () => {
  // One flag stands between this repository and a provider that would place
  // calls from a workflow BiteSites cannot inspect, using a prompt BiteSites
  // did not sign. Asserted here rather than only through the audit, because
  // the audit could be deleted and this boundary would still have to hold.
  assert.equal(GoHighLevelDialer.capabilities.aiAgentCall, false);
  assert.equal(GoHighLevelDialer.capabilities.parallelDial, false);
  assert.equal(GoHighLevelDialer.capabilities.cancelCallLeg, false);
});

// ------------------------------------------------------------ normalisation

test('a contact reduces to the fields matching and eligibility need', () => {
  const normalized = normalizeGoHighLevelContact(contact(7, {
    tags: ['client:bitesites', 'webinar-2026'],
    source: 'paid search'
  }));

  assert.equal(normalized.providerContactId, 'ghl_7');
  assert.equal(normalized.companyName, 'Company 7');
  assert.equal(normalized.phoneE164, '+12015551007');
  assert.equal(normalized.timezone, 'America/New_York');
  assert.equal(normalized.region, 'NJ');
  assert.equal(normalized.source, 'paid search');
  assert.equal(normalized.crmAccountId, 'bitesites');
  assert.equal(normalized.doNotCall, false);
  assert.equal(normalized.createdAt.toISOString(), '2026-01-05T12:00:00.000Z');
  assert.equal(normalized.updatedAt.toISOString(), '2026-02-05T12:00:00.000Z');
});

test('DND is read from the same rule the dialer enforces', () => {
  const global = contact(1, { dnd: true });
  const callChannel = contact(2, { dndSettings: { Call: { status: 'active' } } });
  const smsOnly = contact(3, { dndSettings: { SMS: { status: 'active' } } });
  const clear = contact(4, { dndSettings: { Email: { status: 'inactive' } } });

  for (const raw of [global, callChannel, smsOnly, clear]) {
    assert.equal(
      normalizeGoHighLevelContact(raw).doNotCall,
      GoHighLevelDialer.contactIsDnd(raw),
      `the audit and the dialer must agree about ${raw.id}`
    );
  }
  assert.equal(normalizeGoHighLevelContact(global).doNotCall, true);
  assert.equal(normalizeGoHighLevelContact(callChannel).doNotCall, true);
  assert.equal(normalizeGoHighLevelContact(clear).doNotCall, false);
  assert.deepEqual(dndChannels(global), ['all']);
  assert.deepEqual(dndChannels(callChannel), ['Call']);
});

test('a contact with no account tag, or two, resolves to no account and says why', () => {
  assert.deepEqual(
    (({ crmAccountId, crmAccountReason }) => ({ crmAccountId, crmAccountReason }))(
      normalizeGoHighLevelContact(contact(1, { tags: ['newsletter'] }))),
    { crmAccountId: '', crmAccountReason: 'no_account_tag' }
  );

  const ambiguous = normalizeGoHighLevelContact(
    contact(2, { tags: ['client:bitesites', 'client:fineline'] })
  );
  assert.equal(ambiguous.crmAccountId, '');
  assert.match(ambiguous.crmAccountReason, /^ambiguous_account_tags:/);
});

// ----------------------------------------------------------------- consent

test('a CRM field claiming written consent does not become a consent grant', () => {
  const claiming = contact(1, {
    customFields: [
      { key: 'consent_basis', value: 'written_opt_in' },
      { key: 'consent_grant_id', value: 'grant_from_the_crm_not_the_ledger' },
      { key: 'consent_granted_at', value: '2026-01-01T00:00:00.000Z' },
      { key: 'consent_seller_account_id', value: 'bitesites' },
      { key: 'consent_phone_e164', value: '+12015551001' },
      { key: 'consent_source_url', value: 'https://example.test/signed-form' },
      { key: 'consent_form_version', value: 'v3' },
      { key: 'consent_evidence_id', value: 'artifact-991' }
    ]
  });

  const fields = toProspectFields(claiming);
  // The references survive, so a reviewer can go and read the paperwork.
  assert.equal(fields.consentSourceUrl, 'https://example.test/signed-form');
  assert.equal(fields.consentFormVersion, 'v3');
  assert.equal(fields.consentEvidenceId, 'artifact-991');
  // The permission does not.
  for (const forbidden of ['consentBasis', 'consentGrantId', 'consentGrantedAt',
    'consentSellerAccountId', 'consentPhoneE164', 'consent']) {
    assert.equal(forbidden in fields, false, `${forbidden} must not travel out of the CRM`);
  }

  const prospect = buildProspect(fields, {
    source: { system: 'gohighlevel', provider: 'gohighlevel_contacts', providerRecordId: 'ghl_1' }
  });
  assert.equal(prospect.consent.basis, 'not_recorded');
  assert.equal(prospect.consent.grantId, '');
  assert.equal(prospect.consent.sellerAccountId, '');
  assert.equal(prospect.consent.phoneE164, '');
  assert.equal(prospect.consent.grantedAt, null);
  // …while the evidence pointer is kept.
  assert.equal(prospect.consent.sourceUrl, 'https://example.test/signed-form');
  assert.equal(prospect.consent.evidenceId, 'artifact-991');
});

test('provider identity and provenance survive into the prospect document', () => {
  const raw = contact(4, { dnd: true });
  const prospect = buildProspect(toProspectFields(raw), {
    source: {
      system: 'gohighlevel',
      provider: GoHighLevelContactsSource.id,
      providerRecordId: 'ghl_4',
      importedAt: new Date('2026-08-25T00:00:00.000Z')
    }
  });

  assert.equal(prospect.source.system, 'gohighlevel');
  assert.equal(prospect.source.provider, 'gohighlevel_contacts');
  assert.equal(prospect.source.providerRecordId, 'ghl_4');
  assert.equal(prospect.providerContactId, 'ghl_4');
  assert.equal(prospect.location.timezone, 'America/New_York');
  assert.equal(prospect.address.region, 'NJ');
  // The CRM's own opt-out reaches the field the queue reads.
  assert.equal(prospect.contactability.doNotCall, true);
  assert.equal(prospect.contactability.complianceStatus, 'blocked');
  // Nothing arrives dialable.
  assert.equal(prospect.lifecycle.status, 'new');
});

test('readGoHighLevelContacts returns normalised contacts and the request log', async () => {
  const fetchImpl = recordingFetch([
    { status: 200, body: { contacts: [contact(1), contact(2)], total: 2 } }
  ]);
  const result = await readGoHighLevelContacts(
    { token: 't', locationId: LOCATION, accountId: 'bitesites', fetchImpl, sleepImpl: async () => {}, pageSize: 5 },
    {}
  );
  assert.equal(result.contacts.length, 2);
  assert.equal(result.accountId, 'bitesites');
  assert.equal(result.locationId, LOCATION);
  assert.deepEqual(result.requests, ['POST /contacts/search']);
  assert.equal(result.contacts[0].providerContactId, 'ghl_1');
});
