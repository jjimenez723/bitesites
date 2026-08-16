// The /admin/crm derivations:  npm run test:crm
//
// Pure functions over the sanitized snapshot — no Firebase, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agingBuckets, commissionRows, filterOpportunities, forPipeline,
  money, pipelineSummary, sortOpportunities, stageBreakdown
} from './crm-calculations.js';

const opp = (overrides = {}) => ({
  id: overrides.id || Math.random().toString(36).slice(2),
  name: 'Test Lead — General Inquiry',
  pipelineId: 'pipeA',
  stageId: 's1',
  stageName: 'New Lead',
  status: 'open',
  value: 0,
  contactName: 'Test Lead',
  companyName: '',
  tags: [],
  commissionDueTag: false,
  services: [],
  estimateAmount: 0,
  contractAmount: 0,
  collectedRevenue: 0,
  commissionRate: 0,
  commissionExpected: 0,
  commissionPaid: 0,
  commissionOutstanding: 0,
  referralCount: 0,
  referralPartnerBusiness: '',
  referralPartnerContact: '',
  daysInStage: 0,
  ageDays: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastStageChangeAt: '2026-08-01T00:00:00.000Z',
  ...overrides
});

test('pipelineSummary counts statuses and prefers contract over estimate over value', () => {
  const summary = pipelineSummary([
    opp({ status: 'open', contractAmount: 5000, estimateAmount: 4000, value: 1 }),
    opp({ status: 'open', estimateAmount: 2000 }),
    opp({ status: 'won', contractAmount: 8000, collectedRevenue: 8000 }),
    opp({ status: 'lost' })
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.open, 2);
  assert.equal(summary.won, 1);
  assert.equal(summary.lost, 1);
  assert.equal(summary.openValue, 7000);
  assert.equal(summary.wonValue, 8000);
  assert.equal(summary.collectedRevenue, 8000);
});

test('pipelineSummary totals commission and counts deals owing', () => {
  const summary = pipelineSummary([
    opp({ commissionExpected: 100, commissionOutstanding: 100, commissionDueTag: true }),
    opp({ commissionExpected: 250, commissionPaid: 250, commissionOutstanding: 0 }),
    opp({})
  ]);
  assert.equal(summary.commissionExpected, 350);
  assert.equal(summary.commissionPaid, 250);
  assert.equal(summary.commissionOutstanding, 100);
  assert.equal(summary.commissionDueCount, 1);
});

test('stageBreakdown returns every stage in order, zeros included, lost excluded', () => {
  const pipeline = {
    stages: [
      { id: 's1', name: 'New Lead', position: 1 },
      { id: 's2', name: 'Qualified', position: 2 },
      { id: 's3', name: 'Fully Paid', position: 3 }
    ]
  };
  const rows = stageBreakdown(pipeline, [
    opp({ stageId: 's1', estimateAmount: 1000 }),
    opp({ stageId: 's1' }),
    opp({ stageId: 's3', status: 'won', contractAmount: 9000 }),
    opp({ stageId: 's2', status: 'lost', contractAmount: 500 })
  ]);
  assert.deepEqual(rows.map(row => [row.name, row.count, row.value]), [
    ['New Lead', 2, 1000],
    ['Qualified', 0, 0],
    ['Fully Paid', 1, 9000]
  ]);
});

test('filterOpportunities combines status, stage and search', () => {
  const rows = [
    opp({ id: 'a', stageId: 's1', contactName: 'Aaron Roofer', services: ['Water Damage'] }),
    opp({ id: 'b', stageId: 's2', status: 'won', contactName: 'Bella Painter' }),
    opp({ id: 'c', stageId: 's1', status: 'lost', referralPartnerBusiness: 'QA Plumbing' })
  ];
  assert.deepEqual(filterOpportunities(rows, { status: 'won' }).map(row => row.id), ['b']);
  assert.deepEqual(filterOpportunities(rows, { stageId: 's1' }).map(row => row.id), ['a', 'c']);
  assert.deepEqual(filterOpportunities(rows, { search: 'water' }).map(row => row.id), ['a']);
  assert.deepEqual(filterOpportunities(rows, { search: 'plumbing' }).map(row => row.id), ['c']);
  assert.deepEqual(filterOpportunities(rows, { status: 'lost', stageId: 's1' }).map(row => row.id), ['c']);
});

test('the commission_due pseudo-status matches the tag or an outstanding amount', () => {
  const rows = [
    opp({ id: 'tagged', commissionDueTag: true }),
    opp({ id: 'owing', commissionOutstanding: 50 }),
    opp({ id: 'paid', commissionPaid: 100 })
  ];
  assert.deepEqual(
    filterOpportunities(rows, { status: 'commission_due' }).map(row => row.id),
    ['tagged', 'owing']
  );
});

test('agingBuckets only counts open deals and splits on stage dwell time', () => {
  const buckets = agingBuckets([
    opp({ daysInStage: 0 }),
    opp({ daysInStage: 7 }),
    opp({ daysInStage: 8 }),
    opp({ daysInStage: 30 }),
    opp({ daysInStage: 31 }),
    opp({ daysInStage: 90, status: 'won' })
  ]);
  assert.deepEqual(buckets.map(bucket => [bucket.key, bucket.count]), [
    ['fresh', 2], ['watch', 1], ['stale', 1], ['cold', 1]
  ]);
});

test('commissionRows sorts by outstanding amount, tagged-but-zero last', () => {
  const rows = commissionRows([
    opp({ id: 'small', commissionOutstanding: 10 }),
    opp({ id: 'none' }),
    opp({ id: 'big', commissionOutstanding: 500 }),
    opp({ id: 'tagged', commissionDueTag: true })
  ]);
  assert.deepEqual(rows.map(row => row.id), ['big', 'small', 'tagged']);
});

test('sortOpportunities puts open work first, then most recent stage moves', () => {
  const rows = sortOpportunities([
    opp({ id: 'wonOld', status: 'won', lastStageChangeAt: '2026-08-10T00:00:00Z' }),
    opp({ id: 'openOld', lastStageChangeAt: '2026-08-01T00:00:00Z' }),
    opp({ id: 'openNew', lastStageChangeAt: '2026-08-14T00:00:00Z' }),
    opp({ id: 'lost', status: 'lost', lastStageChangeAt: '2026-08-15T00:00:00Z' })
  ]);
  assert.deepEqual(rows.map(row => row.id), ['openNew', 'openOld', 'wonOld', 'lost']);
});

test('forPipeline and money behave', () => {
  assert.equal(forPipeline([opp({ pipelineId: 'x' }), opp()], 'x').length, 1);
  assert.equal(money(1234.5), '$1,235');
  assert.equal(money('nope'), '—');
});
