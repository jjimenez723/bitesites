import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFinanceSnapshot, calculateSettlementLedger, expenseAmount, monthRange
} from './finance-calculations.js';
import { STARTER_LEDGER } from './finance-seed.js';

const meteredLedger = amounts => ({
  team: [
    { id: 'owner', name: 'Owner', sharesExpenses: true, status: 'active', isOwner: true },
    { id: 'pat', name: 'Pat', sharesExpenses: true, status: 'active' }
  ],
  accounts: [],
  income: [],
  expenses: [{
    id: 'openai', name: 'OpenAI API', cadence: 'usage', provider: 'openai',
    scope: 'universal', monthlyAmounts: amounts, expenseAllocations: []
  }],
  settlements: []
});

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

test('metered API spend only lands in the months it was billed', () => {
  const ledger = meteredLedger({ '2026-07': 18.4, '2026-08': 62.15 });

  const july = calculateFinanceSnapshot(ledger, '2026-07');
  assert.equal(july.totalExpenses, 18.4);
  assert.equal(july.usageExpenses, 18.4);
  assert.equal(july.recurringExpenses, 0);

  const august = calculateFinanceSnapshot(ledger, '2026-08');
  assert.equal(august.usageExpenses, 62.15);
  // $62.15 splits two ways with the odd cent going to the first participant.
  assert.equal(august.team.find(member => member.id === 'owner').expenseShare, 31.08);
  assert.equal(august.team.find(member => member.id === 'pat').expenseShare, 31.07);

  // A month with no recorded bill charges nothing rather than repeating the last one.
  assert.equal(calculateFinanceSnapshot(ledger, '2026-09').totalExpenses, 0);
  assert.equal(expenseAmount(ledger.expenses[0], '2026-09'), 0);
});

test('monthRange walks inclusive months across a year boundary', () => {
  assert.deepEqual(monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthRange('2026-03', '2026-03'), ['2026-03']);
  assert.deepEqual(monthRange('2026-04', '2026-03'), []);
});

test('running tab treats everything as unpaid except logged settlements', () => {
  const tab = calculateSettlementLedger(STARTER_LEDGER, '2026-08');
  const owed = Object.fromEntries(tab.members.map(member => [member.name, member]));

  // Codex has run since 2025-08, so the tab opens there and closes on the
  // reporting month.
  assert.equal(tab.months[0].month, '2025-08');
  assert.equal(tab.months[tab.months.length - 1].month, '2026-08');

  // Jonathan's $45 is the only cash on record; everyone else has paid nothing.
  assert.equal(tab.totalPaid, 45);
  assert.equal(owed['Jonathan Arroyo'].paid, 45);
  assert.equal(owed['Nussein Iounakov'].paid, 0);
  assert.equal(owed['Eidan Jimenez'].paid, 0);

  // Balance is everything accrued less what was handed over.
  for (const member of tab.members) {
    assert.equal(member.balance, Math.round((member.accrued - member.paid) * 100) / 100);
  }

  // The owner is the counterparty, so their share is absorbed, not owed.
  assert.equal(tab.owner.name, 'Jensy Jimenez');
  assert.ok(!tab.members.some(member => member.isOwner));
  assert.equal(
    tab.totalOutstanding,
    Math.round(tab.members.reduce((sum, member) => sum + member.balance, 0) * 100) / 100
  );
});

test('running tab carries balances forward and records payments in their month', () => {
  const ledger = meteredLedger({ '2026-06': 100, '2026-07': 50 });
  ledger.settlements = [{ id: 'p1', memberId: 'pat', date: '2026-07-10', amount: 20 }];

  const tab = calculateSettlementLedger(ledger, '2026-08');
  const pat = tab.members.find(member => member.id === 'pat');

  assert.deepEqual(tab.months.map(row => row.month), ['2026-06', '2026-07', '2026-08']);
  assert.deepEqual(pat.monthly, [
    { month: '2026-06', accrued: 50, paid: 0, balance: 50 },
    { month: '2026-07', accrued: 25, paid: 20, balance: 55 }
  ]);
  assert.equal(pat.balance, 55);
  assert.equal(tab.totalOutstanding, 55);
});
