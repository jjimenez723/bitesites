// Commission → Finance ledger bridge:  npm run test:crm
//
// Pure rules only. The load-bearing ones: `amount` is cash actually received
// (never due-but-unpaid), QA records never reach the ledger, ids are
// deterministic so re-syncs merge instead of duplicate, and rows land in the
// month the customer paid.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FINE_LINE_ACCOUNT_ID, buildCommissionLedgerRows } from './flg-commission-sync.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');

const opp = (overrides = {}) => ({
  id: overrides.id || 'oppX',
  name: 'Jane Homeowner — Water Damage',
  contactName: 'Jane Homeowner',
  status: 'won',
  commissionDueTag: false,
  collectedRevenue: 0,
  commissionRate: 10,
  commissionExpected: 0,
  commissionPaid: 0,
  commissionOutstanding: 0,
  lastCustomerPaymentDate: '',
  lastStageChangeAt: '2026-08-10T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...overrides
});

const build = opportunities => buildCommissionLedgerRows({ opportunities }, { now: NOW });

test('amount is commission actually paid; due-but-unpaid stays out of amount', () => {
  const [row] = build([opp({
    collectedRevenue: 1000, commissionExpected: 100,
    commissionOutstanding: 100, commissionDueTag: true
  })]);
  assert.equal(row.amount, 0);
  assert.equal(row.expected, 100);
  assert.equal(row.outstanding, 100);
  assert.match(row.notes, /\$100 still due/);
});

test('a settled commission carries the paid amount', () => {
  const [row] = build([opp({
    collectedRevenue: 2000, commissionExpected: 200,
    commissionPaid: 200, commissionOutstanding: 0
  })]);
  assert.equal(row.amount, 200);
  assert.equal(row.grossSales, 2000);
  assert.equal(row.rate, 10);
  assert.match(row.notes, /settled/);
});

test('rows join the fine-line-group account with deterministic ids', () => {
  const [row] = build([opp({ id: 'abc123', commissionExpected: 50 })]);
  assert.equal(row.id, 'flg-commission-abc123');
  assert.equal(row.accountId, FINE_LINE_ACCOUNT_ID);
  assert.equal(row.kind, 'commission');
  assert.equal(row.source, 'flg-crm-sync');
});

test('opportunities with no commission activity produce no rows', () => {
  assert.equal(build([opp(), opp({ id: 'b', status: 'open' })]).length, 0);
});

test('the commission-due tag alone still surfaces a row, at zero amount', () => {
  const [row] = build([opp({ commissionDueTag: true })]);
  assert.ok(row);
  assert.equal(row.amount, 0);
});

test('workflow QA records never reach the ledger', () => {
  const rows = build([
    opp({ id: 'qa1', name: 'FLG Workflow QA Commission 20260815 — General Inquiry', contactName: 'FLG Workflow QA Commission 20260815', commissionExpected: 100, commissionDueTag: true }),
    opp({ id: 'qa2', name: 'FLG QA — Commission 20260814201237', commissionExpected: 100 }),
    opp({ id: 'real', commissionExpected: 100 })
  ]);
  assert.deepEqual(rows.map(row => row.id), ['flg-commission-real']);
});

test('the row lands in the month the customer paid, with sensible fallbacks', () => {
  const [paidDate] = build([opp({ commissionExpected: 10, lastCustomerPaymentDate: '2026-07-03T00:00:00.000Z' })]);
  assert.equal(paidDate.date, '2026-07-03');
  const [stageDate] = build([opp({ commissionExpected: 10 })]);
  assert.equal(stageDate.date, '2026-08-10');
  const [nowDate] = build([opp({ commissionExpected: 10, lastStageChangeAt: '', createdAt: '' })]);
  assert.equal(nowDate.date, '2026-08-15');
});

test('amounts are rounded to cents', () => {
  const [row] = build([opp({ collectedRevenue: 333.333, commissionExpected: 33.3333, commissionPaid: 11.111 })]);
  assert.equal(row.grossSales, 333.33);
  assert.equal(row.expected, 33.33);
  assert.equal(row.amount, 11.11);
});
