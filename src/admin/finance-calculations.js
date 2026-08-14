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

// Metered API spend. Unlike a subscription there is no fixed unit price, so the
// billed dollars are stored per month and read back by reporting month. The
// provider ids match the vendors that publish a usage/cost API, so a month can
// be filled in by hand today and synced later without changing the shape.
export const USAGE_PROVIDERS = Object.freeze([
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'fal', label: 'fal.ai' },
  { id: 'other', label: 'Other metered API' }
]);

export const usageAmount = (expense, month) =>
  moneyRound(numberValue(expense?.monthlyAmounts?.[month]));

export const expenseAmount = (expense, month) => expense?.cadence === 'usage'
  ? usageAmount(expense, month)
  : moneyRound(
    numberValue(expense.unitAmount ?? expense.amount) * Math.max(1, numberValue(expense.quantity) || 1)
  );

/** True when an expense lands in the given reporting month. */
export const expenseInMonth = (expense, month) => {
  if (!expense) return false;
  if (expense.cadence === 'usage') return usageAmount(expense, month) > 0;
  if (expense.cadence === 'monthly') return activeInMonth(expense, month);
  return monthOf(expense.effectiveDate || expense.effectiveMonth) === month;
};

/** Every month an expense is known to have charged something. */
export const expenseMonths = expense => {
  if (!expense) return [];
  if (expense.cadence === 'usage') {
    return Object.keys(expense.monthlyAmounts || {}).filter(month => usageAmount(expense, month) > 0);
  }
  if (expense.cadence === 'monthly') return expense.startMonth ? [expense.startMonth] : [];
  return [monthOf(expense.effectiveDate || expense.effectiveMonth)].filter(Boolean);
};

/** Inclusive list of `YYYY-MM` strings from start to end. */
export const monthRange = (start, end) => {
  if (!start || !end || start > end) return [];
  const months = [];
  let [year, month] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
};

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

/**
 * Who pays for one already-priced expense: an explicit override split when the
 * expense carries one, otherwise an even split across the participants passed
 * in. Shared by the monthly snapshot and the running team tab so the two can
 * never disagree about who owes what.
 */
export const splitExpense = (expense, participantIds) => {
  const explicit = (expense.expenseAllocations || []).filter(allocation => allocation.memberId);
  return explicit.length
    ? new Map(explicit.map(allocation => [allocation.memberId, allocationValue(expense.total, allocation)]))
    : splitEvenly(expense.total, participantIds);
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
 *   - Metered API spend lands in whichever months have a recorded amount.
 *   - Client tags drive account profitability. Costs use an explicit override
 *     split when present, otherwise they are shared evenly by team members
 *     explicitly marked as expense participants.
 */
export function calculateFinanceSnapshot({ accounts = [], team = [], expenses = [], income = [] }, month) {
  const activeExpenses = expenses
    .filter(expense => expenseInMonth(expense, month))
    .map(expense => ({ ...expense, total: expenseAmount(expense, month) }));

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
  const usageExpenses = moneyRound(activeExpenses
    .filter(expense => expense.cadence === 'usage')
    .reduce((sum, expense) => sum + expense.total, 0));
  const expenseParticipants = team.filter(member => member.status !== 'inactive' && member.sharesExpenses);
  const expensesByMember = new Map();
  let allocatedExpenses = 0;
  for (const expense of activeExpenses) {
    const split = splitExpense(expense, expenseParticipants.map(member => member.id));
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
    usageExpenses,
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

/**
 * The running tab: what each person owes the finance owner, month by month.
 *
 * Costs accrue to a person in the month they were charged, using the same split
 * rules as the monthly snapshot. Settlements are cash that person has actually
 * handed over, dated to the month it was received. The balance is everything
 * accrued minus everything settled, carried forward — so an untouched ledger
 * reads as "nothing has been paid yet" without anyone having to say so.
 *
 * The window starts at the first month any cost or payment is on record and
 * runs through the reporting month. Only costs and settlements are in scope:
 * revenue splits are what the business owes the team, tracked separately in the
 * monthly payout panel, and netting the two would need firm retainer start
 * dates the account records do not all carry.
 *
 * The owner is the counterparty, so their own share is reported separately as
 * absorbed cost rather than as a debt to themselves.
 */
export function calculateSettlementLedger(
  { team = [], expenses = [], settlements = [] }, throughMonth
) {
  // Historical months are split using today's participant list; nobody has left
  // the pool yet, and a per-month roster would need join and leave dates.
  const participants = team.filter(member => member.status !== 'inactive' && member.sharesExpenses);
  const participantIds = participants.map(member => member.id);
  const owner = team.find(member => member.isOwner);

  const dated = [
    ...expenses.flatMap(expenseMonths),
    ...settlements.map(settlement => monthOf(settlement.date))
  ].filter(month => month && month <= throughMonth).sort();
  const months = monthRange(dated[0], throughMonth);

  const byMember = new Map(team
    .filter(member => member.status !== 'inactive')
    .map(member => [member.id, {
      id: member.id,
      name: member.name,
      role: member.role,
      isOwner: Boolean(member.isOwner),
      accrued: 0,
      paid: 0,
      balance: 0,
      monthly: []
    }]));
  const rowFor = memberId => byMember.get(memberId);

  const monthRows = months.map(month => {
    const monthExpenses = expenses
      .filter(expense => expenseInMonth(expense, month))
      .map(expense => ({ ...expense, total: expenseAmount(expense, month) }));

    const accruedBy = new Map();
    for (const expense of monthExpenses) {
      for (const [memberId, amount] of splitExpense(expense, participantIds)) {
        accruedBy.set(memberId, moneyRound((accruedBy.get(memberId) || 0) + amount));
      }
    }

    const paidBy = new Map();
    for (const settlement of settlements.filter(entry => monthOf(entry.date) === month)) {
      if (!settlement.memberId) continue;
      paidBy.set(settlement.memberId, moneyRound(
        (paidBy.get(settlement.memberId) || 0) + numberValue(settlement.amount)
      ));
    }

    for (const memberId of new Set([...accruedBy.keys(), ...paidBy.keys()])) {
      const row = rowFor(memberId);
      if (!row) continue;
      const accrued = accruedBy.get(memberId) || 0;
      const paid = paidBy.get(memberId) || 0;
      row.accrued = moneyRound(row.accrued + accrued);
      row.paid = moneyRound(row.paid + paid);
      row.balance = moneyRound(row.accrued - row.paid);
      row.monthly.push({ month, accrued, paid, balance: row.balance });
    }

    const totalAccrued = moneyRound([...accruedBy.values()].reduce((sum, value) => sum + value, 0));
    const totalPaid = moneyRound([...paidBy.values()].reduce((sum, value) => sum + value, 0));
    return {
      month,
      totalAccrued,
      totalPaid,
      accrued: accruedBy,
      paid: paidBy,
      costs: monthExpenses
    };
  });

  const members = [...byMember.values()].filter(row => !row.isOwner);
  const ownerRow = [...byMember.values()].find(row => row.isOwner) || null;

  return {
    months: monthRows,
    members,
    owner: ownerRow,
    ownerAbsorbed: ownerRow ? ownerRow.balance : 0,
    totalAccrued: moneyRound(members.reduce((sum, row) => sum + row.accrued, 0)),
    totalPaid: moneyRound(members.reduce((sum, row) => sum + row.paid, 0)),
    totalOutstanding: moneyRound(members.reduce((sum, row) => sum + row.balance, 0))
  };
}

/** Balance for one member at the end of a month, for a month-by-month table. */
export const balanceAt = (memberRow, month) => {
  const entries = memberRow.monthly.filter(entry => entry.month <= month);
  return entries.length ? entries[entries.length - 1].balance : 0;
};
