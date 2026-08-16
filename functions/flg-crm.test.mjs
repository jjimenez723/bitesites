// Fine Line CRM client and sanitizer:  npm run test:crm
//
// Everything runs against a mocked fetch — no HighLevel request leaves this
// process, and no token exists outside the fixtures. The load-bearing
// properties: pagination completes, 429/5xx retry then surface, timeouts
// abort, the token never appears in an error, and no contact email/phone/
// address survives sanitization.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMISSION_DUE_TAG, FLG_PIPELINES, HighLevelError,
  buildCrmSnapshot, createHighLevelClient, readCustomFields, sanitizeOpportunity
} from './flg-crm.js';

const TOKEN = 'pit-testtoken-1234567890abcdef';
const NOW = Date.parse('2026-08-15T12:00:00Z');

const jsonResponse = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const noSleep = () => Promise.resolve();

const client = fetchImpl => createHighLevelClient({ token: TOKEN, fetchImpl, sleep: noSleep });

// ------------------------------------------------------------------ client

test('requests carry the bearer token, API version, and location', async () => {
  const seen = [];
  const c = client(async (url, options) => {
    seen.push({ url, options });
    return jsonResponse({ pipelines: [] });
  });
  await c.listPipelines();
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.startsWith('https://services.leadconnectorhq.com/opportunities/pipelines'));
  assert.ok(seen[0].url.includes('locationId=LDL5wuJlnVnqk9vn6taD'));
  assert.equal(seen[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].options.headers.Version, '2021-07-28');
});

test('a missing or placeholder token refuses to build a client at all', () => {
  for (const bad of [undefined, '', 'unset', 'short']) {
    assert.throws(() => createHighLevelClient({ token: bad }), HighLevelError);
  }
});

test('pagination follows the cursor until a short page', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: `opp_${i}` }));
  const pages = [
    { opportunities: full, meta: { startAfter: 111, startAfterId: 'opp_99' } },
    { opportunities: [{ id: 'opp_last' }], meta: {} }
  ];
  const urls = [];
  const c = client(async url => {
    urls.push(url);
    return jsonResponse(pages.shift());
  });
  const all = await c.listAllOpportunities(FLG_PIPELINES.clientAcquisition);
  assert.equal(all.length, 101);
  assert.equal(urls.length, 2);
  assert.ok(!urls[0].includes('startAfterId'));
  assert.ok(urls[1].includes('startAfter=111') && urls[1].includes('startAfterId=opp_99'));
});

test('429 is retried and then succeeds', async () => {
  let calls = 0;
  const c = client(async () => {
    calls += 1;
    return calls < 3
      ? jsonResponse({}, { status: 429, headers: { 'retry-after': '0' } })
      : jsonResponse({ pipelines: [{ id: 'p' }] });
  });
  const body = await c.listPipelines();
  assert.equal(calls, 3);
  assert.equal(body.pipelines.length, 1);
});

test('persistent 429 surfaces as a HighLevelError with the status', async () => {
  const c = client(async () => jsonResponse({}, { status: 429 }));
  await assert.rejects(c.listPipelines(), error => {
    assert.ok(error instanceof HighLevelError);
    assert.equal(error.status, 429);
    return true;
  });
});

test('5xx is retried; 4xx is not', async () => {
  let calls500 = 0;
  const c500 = client(async () => { calls500 += 1; return jsonResponse({}, { status: 502 }); });
  await assert.rejects(c500.listPipelines(), HighLevelError);
  assert.equal(calls500, 3);

  let calls404 = 0;
  const c404 = client(async () => { calls404 += 1; return jsonResponse({ message: 'nope' }, { status: 404 }); });
  await assert.rejects(c404.listPipelines(), HighLevelError);
  assert.equal(calls404, 1);
});

test('a timeout aborts and reports without the token', async () => {
  const c = createHighLevelClient({
    token: TOKEN,
    timeoutMs: 10,
    sleep: noSleep,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })
  });
  await assert.rejects(c.listPipelines(), error => {
    assert.match(error.message, /timed out/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test('an upstream body that echoes the token is scrubbed from the error', async () => {
  const c = client(async () => ({
    ok: false, status: 401,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => `bad credentials: ${TOKEN}`
  }));
  await assert.rejects(c.listPipelines(), error => {
    assert.ok(!error.message.includes(TOKEN), 'token leaked into the error message');
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

// -------------------------------------------------------------- sanitization

const RAW_OPPORTUNITY = {
  id: 'oppA', name: 'Jensy Jimenez — Water Damage',
  monetaryValue: 2500, pipelineId: FLG_PIPELINES.clientAcquisition,
  pipelineStageId: 'stage-2', status: 'won',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  lastStageChangeAt: '2026-08-08T00:00:00.000Z',
  lastStatusChangeAt: '2026-08-08T00:00:00.000Z',
  contactId: 'contact1',
  contact: {
    id: 'contact1', name: 'Jensy Jimenez', companyName: 'Fine Line QA',
    email: 'private@example.com', phone: '+15551234567',
    tags: ['FLG - Customer', COMMISSION_DUE_TAG]
  },
  relations: [{ email: 'private@example.com', phone: '+15551234567' }],
  customFields: [
    { id: 'xsnjtkMBsEFqla3oCGmm', fieldValueString: 'Jensy Jimenez', type: 'string' },
    { id: 'ph7sQvIhfkhlzojoDj2v', fieldValueArray: ['Water Damage'], type: 'array' },
    { id: 'M8Ue8wrwxF4v9VowSgz3', fieldValueNumber: 1000, type: 'number' },
    { id: 'yV48BztjTPAS2nx6sNmZ', fieldValueNumber: 10, type: 'number' },
    { id: 'ax9q6o7P6vcTrmCWWhTh', fieldValueString: '12 Private Street', type: 'string' },
    { id: 'qDf1sqnHVNdvvJaIlZvP', fieldValueString: 'sensitive lead notes', type: 'string' }
  ]
};

test('sanitization drops email, phone, address, and notes', () => {
  const clean = sanitizeOpportunity(RAW_OPPORTUNITY, { now: NOW });
  const flat = JSON.stringify(clean);
  assert.ok(!flat.includes('private@example.com'));
  assert.ok(!flat.includes('+15551234567'));
  assert.ok(!flat.includes('12 Private Street'));
  assert.ok(!flat.includes('sensitive lead notes'));
  assert.equal(clean.contactName, 'Jensy Jimenez');
  assert.equal(clean.companyName, 'Fine Line QA');
});

test('custom fields map to named values, arrays and numbers intact', () => {
  const fields = readCustomFields(RAW_OPPORTUNITY.customFields);
  assert.equal(fields.contactFullName, 'Jensy Jimenez');
  assert.deepEqual(fields.services, ['Water Damage']);
  assert.equal(fields.collectedRevenue, 1000);
  assert.equal(fields.commissionRate, 10);
  assert.equal(fields.propertyAddress, undefined, 'address must stay unmapped');
});

test('commission falls back to revenue × rate when no due amount is stored', () => {
  const clean = sanitizeOpportunity(RAW_OPPORTUNITY, { now: NOW });
  assert.equal(clean.commissionExpected, 100);   // $1,000 at 10%
  assert.equal(clean.commissionPaid, 0);
  assert.equal(clean.commissionOutstanding, 100);
  assert.equal(clean.commissionDueTag, true);
});

test('an explicit commission-due amount wins over the computed one', () => {
  const raw = {
    ...RAW_OPPORTUNITY,
    customFields: [
      ...RAW_OPPORTUNITY.customFields,
      { id: '7hgwGsHT9KATn2rrzuxs', fieldValueNumber: 250, type: 'number' },
      { id: 'PaZdwDYUpTdaL04rV1QD', fieldValueNumber: 100, type: 'number' }
    ]
  };
  const clean = sanitizeOpportunity(raw, { now: NOW });
  assert.equal(clean.commissionExpected, 250);
  assert.equal(clean.commissionOutstanding, 150);
});

test('aging is computed from createdAt and lastStageChangeAt', () => {
  const clean = sanitizeOpportunity(RAW_OPPORTUNITY, { now: NOW });
  assert.equal(clean.ageDays, 14);
  assert.equal(clean.daysInStage, 7);
});

test('tags are lowercased and the commission tag is detected case-insensitively', () => {
  const clean = sanitizeOpportunity(RAW_OPPORTUNITY, { now: NOW });
  assert.ok(clean.tags.includes('flg - customer'));
  assert.equal(clean.commissionDueTag, true);
});

// ------------------------------------------------------------------ snapshot

const PIPELINES = [
  { id: 'xItJe5znRjNZk1eDOfD0', name: 'Marketing Pipeline', stages: [{ id: 'm1', name: 'New Lead', position: 0 }] },
  {
    id: FLG_PIPELINES.clientAcquisition, name: 'Fine Line — Client Acquisition',
    stages: [
      { id: 'stage-2', name: 'Attempting Contact', position: 2 },
      { id: 'stage-1', name: 'New Lead', position: 1 }
    ]
  },
  {
    id: FLG_PIPELINES.referralPartners, name: 'Fine Line — Referral Partners',
    stages: [{ id: 'r1', name: 'Prospect Identified', position: 1 }]
  }
];

test('the snapshot keeps only Fine Line pipelines and resolves stage names', () => {
  const snapshot = buildCrmSnapshot({
    pipelines: PIPELINES,
    opportunitiesByPipeline: {
      [FLG_PIPELINES.clientAcquisition]: [{ ...RAW_OPPORTUNITY, status: 'open' }],
      [FLG_PIPELINES.referralPartners]: []
    },
    now: NOW
  });
  assert.deepEqual(snapshot.pipelines.map(p => p.id), [FLG_PIPELINES.clientAcquisition, FLG_PIPELINES.referralPartners]);
  assert.deepEqual(snapshot.pipelines.map(p => p.kind), ['client', 'referral']);
  assert.deepEqual(snapshot.pipelines[0].stages.map(s => s.name), ['New Lead', 'Attempting Contact'], 'stages sort by position');
  assert.equal(snapshot.opportunities.length, 1);
  assert.equal(snapshot.opportunities[0].stageName, 'Attempting Contact');
  assert.equal(snapshot.fetchedAt, new Date(NOW).toISOString());
});

test('the snapshot never contains contact PII anywhere', () => {
  const snapshot = buildCrmSnapshot({
    pipelines: PIPELINES,
    opportunitiesByPipeline: { [FLG_PIPELINES.clientAcquisition]: [RAW_OPPORTUNITY] },
    now: NOW
  });
  const flat = JSON.stringify(snapshot);
  assert.ok(!flat.includes('@example.com'));
  assert.ok(!flat.includes('+1555'));
  assert.ok(!flat.includes('Private Street'));
});
