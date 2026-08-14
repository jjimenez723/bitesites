// Pure finance calculations for the admin ledger.
//
// Keeping these out of the React view makes the money path testable without a
// browser. All stored values are dollars; every externally visible result is
// rounded to cents at the boundary where it is allocated.

export const numberValue = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const moneyRound = value =>
  Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;

export const monthOf = value => {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 7);
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 7);
};

export const activeInMonth = (entry, month) => {
  if (!entry || entry.status === 'inactive') return false;
  if (entry.startMonth && entry.startMonth > month) return false;
  if (entry.endMonth && entry.endMonth < month) return false;
  return true;
};

export const expenseAmount = expense => moneyRound(
  numberValue(expense.unitAmount ?? expense.amount) * Math.max(1, numberValue(expense.quantity) || 1)
);

const allocationValue = (revenue, allocation) => {
  const value = numberValue(allocation.value);
  return moneyRound(allocation.method === 'fixed' ? value : revenue * value / 100);
};

const splitEvenly = (amount, ids) => {
  const split = new Map();
  if (!ids.length) return split;
  const totalCents = Math.round(moneyRound(amount) * 100);
  const baseCents = Math.floor(totalCents / ids.length);
  const remainder = totalCents - baseCents * ids.length;
  ids.forEach((id, index) => {
    split.set(id, (baseCents + (index < remainder ? 1 : 0)) / 100);
  });
  return split;
};

const allocateRevenue = (revenue, allocations, accountId, kind, payoutMap) => {
  if (!revenue) return 0;
  let allocated = 0;
  for (const allocation of allocations || []) {
    if (!allocation.memberId) continue;
    const amount = allocationValue(revenue, allocation);
    allocated = moneyRound(allocated + amount);
    const payout = payoutMap.get(allocation.memberId) || { gross: 0, sources: [] };
    payout.gross = moneyRound(payout.gross + amount);
    payout.sources.push({ accountId, kind, amount });
    payoutMap.set(allocation.memberId, payout);
  }
  return allocated;
};

/**
 * Builds one selected-month snapshot.
 *
 * Revenue rules:
 *   - Retainers recur while an account is active.
 *   - Initial payments land only in the month of their date.
 *   - Income records are dated; commissions use the account's commission split.
 * Expense rules:
 *   - Monthly costs recur while active; one-time costs land in their dated month.
 *   - Client tags drive account profitability. Costs use an explicit override
 *     split when present, otherwise they are shared evenly by team members
 *     explicitly marked as expense participants.
 */
export function calculateFinanceSnapshot({ accounts = [], team = [], expenses = [], income = [] }, month) {
  const activeExpenses = expenses
    .filter(expense => expense.cadence === 'monthly'
      ? activeInMonth(expense, month)
      : monthOf(expense.effectiveDate || expense.effectiveMonth) === month)
    .map(expense => ({ ...expense, total: expenseAmount(expense) }));

  const universalExpenses = moneyRound(activeExpenses
    .filter(expense => expense.scope !== 'client')
    .reduce((sum, expense) => sum + expense.total, 0));
  const payoutMap = new Map();

  const accountRows = accounts
    .filter(account => account.status !== 'inactive')
    .map(account => {
      const recurring = activeInMonth(account, month) ? moneyRound(account.monthlyRetainer) : 0;
      const initial = monthOf(account.initialPaymentDate) === month
        ? moneyRound(account.initialPayment)
        : 0;
      const entries = income.filter(entry => entry.accountId === account.id && monthOf(entry.date) === month);
      const commission = moneyRound(entries
        .filter(entry => entry.kind === 'commission')
        .reduce((sum, entry) => sum + numberValue(entry.amount), 0));
      const otherIncome = moneyRound(entries
        .filter(entry => entry.kind !== 'commission')
        .reduce((sum, entry) => sum + numberValue(entry.amount), 0));
      const regularRevenue = moneyRound(recurring + initial + otherIncome);
      const grossRevenue = moneyRound(regularRevenue + commission);
      const directExpenses = moneyRound(activeExpenses
        .filter(expense => expense.scope === 'client' && expense.accountId === account.id)
        .reduce((sum, expense) => sum + expense.total, 0));

      const regularAllocated = allocateRevenue(
        regularRevenue, account.allocations, account.id, 'regular', payoutMap
      );
      const commissionAllocated = allocateRevenue(
        commission,
        account.commissionAllocations?.length ? account.commissionAllocations : account.allocations,
        account.id,
        'commission',
        payoutMap
      );

      return {
        ...account,
        recurring,
        initial,
        commission,
        otherIncome,
        grossRevenue,
        directExpenses,
        allocatedRevenue: moneyRound(regularAllocated + commissionAllocated),
        unallocatedRevenue: moneyRound(grossRevenue - regularAllocated - commissionAllocated)
      };
    })
    .filter(account => account.grossRevenue || account.directExpenses || activeInMonth(account, month));

  const earningAccounts = accountRows.filter(account => account.grossRevenue > 0);
  const universalByAccount = splitEvenly(universalExpenses, earningAccounts.map(account => account.id));
  for (const account of accountRows) {
    account.universalExpenses = universalByAccount.get(account.id) || 0;
    account.totalExpenses = moneyRound(account.directExpenses + account.universalExpenses);
    account.netRevenue = moneyRound(account.grossRevenue - account.totalExpenses);
  }

  const totalRevenue = moneyRound(accountRows.reduce((sum, account) => sum + account.grossRevenue, 0));
  const totalExpenses = moneyRound(activeExpenses.reduce((sum, expense) => sum + expense.total, 0));
  const recurringRevenue = moneyRound(accountRows.reduce((sum, account) => sum + account.recurring, 0));
  const recurringExpenses = moneyRound(activeExpenses
    .filter(expense => expense.cadence === 'monthly')
    .reduce((sum, expense) => sum + expense.total, 0));
  const expenseParticipants = team.filter(member => member.status !== 'inactive' && member.sharesExpenses);
  const expensesByMember = new Map();
  let allocatedExpenses = 0;
  for (const expense of activeExpenses) {
    const explicit = expense.expenseAllocations || [];
    const split = explicit.length
      ? new Map(explicit.map(allocation => [allocation.memberId, allocationValue(expense.total, allocation)]))
      : splitEvenly(expense.total, expenseParticipants.map(member => member.id));
    for (const [memberId, amount] of split) {
      expensesByMember.set(memberId, moneyRound((expensesByMember.get(memberId) || 0) + amount));
      allocatedExpenses = moneyRound(allocatedExpenses + amount);
    }
  }

  const teamRows = team
    .filter(member => member.status !== 'inactive')
    .map(member => {
      const payout = payoutMap.get(member.id) || { gross: 0, sources: [] };
      const expenseShare = expensesByMember.get(member.id) || 0;
      return {
        ...member,
        grossPayout: payout.gross,
        expenseShare,
        netPayout: moneyRound(payout.gross - expenseShare),
        sources: payout.sources
      };
    })
    .sort((a, b) => b.netPayout - a.netPayout);

  const allocatedRevenue = moneyRound(teamRows.reduce((sum, member) => sum + member.grossPayout, 0));
  const unallocatedRevenue = moneyRound(totalRevenue - allocatedRevenue);

  return {
    month,
    accounts: accountRows,
    team: teamRows,
    expenses: activeExpenses,
    recurringRevenue,
    recurringExpenses,
    totalRevenue,
    totalExpenses,
    netRevenue: moneyRound(totalRevenue - totalExpenses),
    margin: totalRevenue ? (totalRevenue - totalExpenses) / totalRevenue : 0,
    allocatedRevenue,
    unallocatedRevenue,
    allocatedExpenses,
    unallocatedExpenses: moneyRound(totalExpenses - allocatedExpenses),
    universalExpenses
  };
}
