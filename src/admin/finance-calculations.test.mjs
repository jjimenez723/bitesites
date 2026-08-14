import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFinanceSnapshot } from './finance-calculations.js';
import { STARTER_LEDGER } from './finance-seed.js';

test('starter August ledger reconciles revenue, costs, and payouts', () => {
  const result = calculateFinanceSnapshot(STARTER_LEDGER, '2026-08');

  assert.equal(result.recurringRevenue, 3100);
  assert.equal(result.totalRevenue, 3700);
  assert.equal(result.recurringExpenses, 133.5);
  assert.equal(result.totalExpenses, 244.57);
  assert.equal(result.netRevenue, 3455.43);
  assert.equal(result.unallocatedRevenue, 0);

  const payouts = Object.fromEntries(result.team.map(member => [member.name, member]));
  assert.equal(payouts['Jensy Jimenez'].grossPayout, 2540);
  assert.equal(payouts['Nussein Iounakov'].grossPayout, 360);
  assert.equal(payouts['Jonathan Arroyo'].grossPayout, 500);
  assert.equal(payouts['Eidan Jimenez'].grossPayout, 300);
  assert.equal(payouts['Jensy Jimenez'].expenseShare, 77.2);
  assert.equal(payouts['Nussein Iounakov'].expenseShare, 45.1);
  assert.equal(payouts['Jonathan Arroyo'].expenseShare, 77.18);
  assert.equal(payouts['Eidan Jimenez'].expenseShare, 45.09);
});

test('one-time expense and commission leave later months', () => {
  const result = calculateFinanceSnapshot(STARTER_LEDGER, '2026-09');
  assert.equal(result.totalRevenue, 3100);
  assert.equal(result.totalExpenses, 133.5);
  assert.equal(result.netRevenue, 2966.5);
});

test('universal expenses are spread evenly across earning accounts', () => {
  const result = calculateFinanceSnapshot(STARTER_LEDGER, '2026-08');
  assert.deepEqual(result.accounts.map(account => account.universalExpenses), [47.84, 47.83, 47.83]);
  assert.equal(result.accounts.find(account => account.id === 'stockroom-nj').directExpenses, 101.07);
});
