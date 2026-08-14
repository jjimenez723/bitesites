import React, { useMemo, useState } from 'react';
import { Panel, Pill } from './Panel';
import { calculateFinanceSnapshot, expenseAmount, monthOf, moneyRound, numberValue } from './finance-calculations';
import {
  deleteFinanceAccount, deleteFinanceExpense, deleteFinanceIncome, deleteFinanceTeamMember,
  saveFinanceAccount, saveFinanceExpense, saveFinanceIncome, saveFinanceTeamMember,
  useFinanceLedger
} from './finance-data';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = value => dollars.format(numberValue(value));

const currentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = month => new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, {
  month: 'long', year: 'numeric'
});

const monthsInclusive = (start, end) => {
  if (!start || start > end) return 0;
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  return (endYear - startYear) * 12 + endMonth - startMonth + 1;
};

const memberName = (team, id) => team.find(member => member.id === id)?.name || 'Unassigned';
const accountName = (accounts, id) => accounts.find(account => account.id === id)?.name || 'Unknown account';

function FinanceStat({ label, value, foot, tone = '' }) {
  return (
    <div className={`admin-card finance-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{foot}</small>
    </div>
  );
}

function AllocationEditor({ label, value, onChange, team, percentagesOnly = false }) {
  const allocations = value || [];
  const update = (index, key, next) => onChange(allocations.map((row, rowIndex) =>
    rowIndex === index ? { ...row, [key]: key === 'value' ? numberValue(next) : next } : row
  ));
  const add = () => onChange([
    ...allocations,
    { memberId: team.find(member => !allocations.some(row => row.memberId === member.id))?.id || '', method: 'percent', value: 0 }
  ]);

  return (
    <div className="finance-form-section">
      <div className="finance-form-section-head">
        <div>
          <strong>{label}</strong>
          <small>{percentagesOnly ? 'Used for commissions.' : 'Used for retainers, initial payments, and other income.'}</small>
        </div>
        <button className="btn-admin" type="button" onClick={add}>+ Add person</button>
      </div>
      <div className="finance-allocation-editor">
        {allocations.map((allocation, index) => (
          <div className="finance-allocation-row" key={`${allocation.memberId}-${index}`}>
            <label>
              <span>Team member</span>
              <select value={allocation.memberId} onChange={event => update(index, 'memberId', event.target.value)} required>
                <option value="">Choose a person</option>
                {team.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}
              </select>
            </label>
            {!percentagesOnly && (
              <label>
                <span>Method</span>
                <select value={allocation.method || 'percent'} onChange={event => update(index, 'method', event.target.value)}>
                  <option value="percent">Percent</option>
                  <option value="fixed">Fixed dollars</option>
                </select>
              </label>
            )}
            <label>
              <span>{percentagesOnly || allocation.method !== 'fixed' ? 'Percent' : 'Amount'}</span>
              <div className="finance-input-affix">
                {allocation.method === 'fixed' && !percentagesOnly && <i>$</i>}
                <input type="number" min="0" step="0.01" value={allocation.value}
                       onChange={event => update(index, 'value', event.target.value)} required />
                {(percentagesOnly || allocation.method !== 'fixed') && <i>%</i>}
              </div>
            </label>
            <button className="finance-remove-row" type="button" aria-label="Remove allocation"
                    onClick={() => onChange(allocations.filter((_, rowIndex) => rowIndex !== index))}>×</button>
          </div>
        ))}
        {!allocations.length && <p className="finance-inline-empty">No payout split yet.</p>}
      </div>
    </div>
  );
}

function AccountForm({ account, team, onSave, onDelete, busy }) {
  const [form, setForm] = useState(() => ({
    id: account?.id,
    name: account?.name || '',
    status: account?.status || 'active',
    monthlyRetainer: account?.monthlyRetainer || 0,
    initialPayment: account?.initialPayment || 0,
    initialPaymentDate: account?.initialPaymentDate || '',
    startMonth: account?.startMonth || '',
    endMonth: account?.endMonth || '',
    commissionRate: account?.commissionRate || 0,
    allocations: (account?.allocations || []).map(row => ({ ...row })),
    commissionAllocations: (account?.commissionAllocations || []).map(row => ({ ...row })),
    commissionSource: account?.commissionSource || 'manual',
    notes: account?.notes || ''
  }));
  const [error, setError] = useState('');
  const field = (key, value) => setForm(current => ({ ...current, [key]: value }));

  const submit = event => {
    event.preventDefault();
    setError('');
    const regularAllocated = form.allocations.reduce((sum, row) => sum + (
      row.method === 'fixed'
        ? numberValue(row.value)
        : numberValue(form.monthlyRetainer) * numberValue(row.value) / 100
    ), 0);
    if (numberValue(form.monthlyRetainer) > 0 && Math.abs(regularAllocated - numberValue(form.monthlyRetainer)) > .011) {
      setError(`The monthly payout split is ${money(regularAllocated)}; it needs to equal the ${money(form.monthlyRetainer)} retainer.`);
      return;
    }
    const commissionPercent = form.commissionAllocations.reduce((sum, row) => sum + numberValue(row.value), 0);
    if (numberValue(form.commissionRate) > 0 && Math.abs(commissionPercent - 100) > .001) {
      setError(`Commission shares total ${commissionPercent}%; they need to equal 100%.`);
      return;
    }
    onSave({
      ...form,
      monthlyRetainer: moneyRound(form.monthlyRetainer),
      initialPayment: moneyRound(form.initialPayment),
      commissionRate: numberValue(form.commissionRate),
      allocations: form.allocations.map(row => ({ ...row, value: numberValue(row.value) })),
      commissionAllocations: form.commissionAllocations.map(row => ({ ...row, method: 'percent', value: numberValue(row.value) }))
    });
  };

  return (
    <form className="finance-form" onSubmit={submit}>
      {error && <p className="admin-error">{error}</p>}
      <div className="finance-form-grid">
        <label className="wide"><span>Account name</span><input value={form.name} onChange={event => field('name', event.target.value)} required /></label>
        <label><span>Status</span><select value={form.status} onChange={event => field('status', event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <label><span>Monthly retainer</span><div className="finance-input-affix"><i>$</i><input type="number" min="0" step="0.01" value={form.monthlyRetainer} onChange={event => field('monthlyRetainer', event.target.value)} /></div></label>
        <label><span>Initial payment</span><div className="finance-input-affix"><i>$</i><input type="number" min="0" step="0.01" value={form.initialPayment} onChange={event => field('initialPayment', event.target.value)} /></div></label>
        <label><span>Initial payment date</span><input type="date" value={form.initialPaymentDate} onChange={event => field('initialPaymentDate', event.target.value)} /></label>
        <label><span>Retainer starts</span><input type="month" value={form.startMonth} onChange={event => field('startMonth', event.target.value)} /></label>
        <label><span>Retainer ends</span><input type="month" value={form.endMonth} onChange={event => field('endMonth', event.target.value)} /></label>
        <label><span>Commission rate</span><div className="finance-input-affix"><input type="number" min="0" step="0.01" value={form.commissionRate} onChange={event => field('commissionRate', event.target.value)} /><i>%</i></div></label>
        <label className="wide"><span>Notes</span><textarea rows="3" value={form.notes} onChange={event => field('notes', event.target.value)} /></label>
      </div>
      <AllocationEditor label="Regular revenue split" value={form.allocations} onChange={value => field('allocations', value)} team={team} />
      {numberValue(form.commissionRate) > 0 && (
        <AllocationEditor label="Commission split" value={form.commissionAllocations}
                          onChange={value => field('commissionAllocations', value)} team={team} percentagesOnly />
      )}
      <div className="finance-form-actions">
        <button className="btn-admin primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save account'}</button>
        {account?.id && <button className="btn-admin danger" type="button" disabled={busy} onClick={onDelete}>Delete account</button>}
      </div>
    </form>
  );
}

function ExpenseForm({ expense, accounts, team, month, onSave, onDelete, busy }) {
  const [form, setForm] = useState(() => ({
    id: expense?.id,
    name: expense?.name || '',
    category: expense?.category || 'Software',
    cadence: expense?.cadence || 'monthly',
    unitAmount: expense?.unitAmount ?? expense?.amount ?? 0,
    quantity: expense?.quantity || 1,
    scope: expense?.scope || 'universal',
    accountId: expense?.accountId || '',
    startMonth: expense?.startMonth || '',
    endMonth: expense?.endMonth || '',
    effectiveDate: expense?.effectiveDate || `${month}-01`,
    expenseAllocations: (expense?.expenseAllocations || []).map(row => ({ ...row })),
    notes: expense?.notes || ''
  }));
  const field = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const submit = event => {
    event.preventDefault();
    const customPercent = form.expenseAllocations.reduce((sum, row) => sum + numberValue(row.value), 0);
    if (form.expenseAllocations.length && Math.abs(customPercent - 100) > .001) return;
    onSave({
      ...form,
      unitAmount: moneyRound(form.unitAmount),
      quantity: Math.max(1, numberValue(form.quantity)),
      accountId: form.scope === 'client' ? form.accountId : '',
      effectiveDate: form.cadence === 'one_time' ? form.effectiveDate : '',
      expenseAllocations: form.expenseAllocations.map(row => ({
        memberId: row.memberId, method: 'percent', value: numberValue(row.value)
      }))
    });
  };

  const toggleCustom = checked => field('expenseAllocations', checked
    ? team.filter(member => member.status !== 'inactive' && member.sharesExpenses).map((member, index, eligible) => ({
      memberId: member.id,
      method: 'percent',
      value: index === eligible.length - 1
        ? moneyRound(100 - moneyRound(100 / eligible.length) * (eligible.length - 1))
        : moneyRound(100 / eligible.length)
    }))
    : []);
  const customPercent = form.expenseAllocations.reduce((sum, row) => sum + numberValue(row.value), 0);

  return (
    <form className="finance-form" onSubmit={submit}>
      <div className="finance-form-grid">
        <label className="wide"><span>Expense name</span><input value={form.name} onChange={event => field('name', event.target.value)} required /></label>
        <label><span>Category</span><select value={form.category} onChange={event => field('category', event.target.value)}><option>Software</option><option>Equipment</option><option>Marketing</option><option>Contractor</option><option>Operations</option><option>Other</option></select></label>
        <label><span>Cadence</span><select value={form.cadence} onChange={event => field('cadence', event.target.value)}><option value="monthly">Monthly</option><option value="one_time">One time</option></select></label>
        <label><span>Unit cost</span><div className="finance-input-affix"><i>$</i><input type="number" min="0" step="0.01" value={form.unitAmount} onChange={event => field('unitAmount', event.target.value)} required /></div></label>
        <label><span>Quantity / users</span><input type="number" min="1" step="1" value={form.quantity} onChange={event => field('quantity', event.target.value)} required /></label>
        <label><span>Tag</span><select value={form.scope} onChange={event => field('scope', event.target.value)}><option value="universal">Universal</option><option value="client">Client-specific</option></select></label>
        {form.scope === 'client' && <label><span>Client</span><select value={form.accountId} onChange={event => field('accountId', event.target.value)} required><option value="">Choose an account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
        {form.cadence === 'monthly' ? (
          <>
            <label><span>Starts (blank = always)</span><input type="month" value={form.startMonth} onChange={event => field('startMonth', event.target.value)} /></label>
            <label><span>Ends (optional)</span><input type="month" value={form.endMonth} onChange={event => field('endMonth', event.target.value)} /></label>
          </>
        ) : <label><span>Purchase date</span><input type="date" value={form.effectiveDate} onChange={event => field('effectiveDate', event.target.value)} required /></label>}
        <label className="wide"><span>Notes</span><textarea rows="3" value={form.notes} onChange={event => field('notes', event.target.value)} /></label>
      </div>
      <label className="finance-check"><input type="checkbox" checked={form.expenseAllocations.length > 0} onChange={event => toggleCustom(event.target.checked)} /><span>Use a custom paycheck split for this expense</span></label>
      {form.expenseAllocations.length > 0 && (
        <>
          <AllocationEditor label="Expense split" value={form.expenseAllocations}
                            onChange={value => field('expenseAllocations', value)} team={team} percentagesOnly />
          {Math.abs(customPercent - 100) > .001 && <p className="finance-warning">Expense shares total {customPercent}%; they need to equal 100% before this can be saved.</p>}
        </>
      )}
      <div className="finance-form-preview"><span>Total</span><strong>{money(expenseAmount(form))}</strong><small>{form.cadence === 'monthly' ? 'per month' : 'one time'}</small></div>
      <div className="finance-form-actions">
        <button className="btn-admin primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save expense'}</button>
        {expense?.id && <button className="btn-admin danger" type="button" disabled={busy} onClick={onDelete}>Delete expense</button>}
      </div>
    </form>
  );
}

function IncomeForm({ entry, accounts, month, onSave, onDelete, busy }) {
  const firstAccount = entry?.accountId || accounts[0]?.id || '';
  const selectedAccount = accounts.find(account => account.id === firstAccount);
  const [form, setForm] = useState(() => ({
    id: entry?.id,
    accountId: firstAccount,
    kind: entry?.kind || 'commission',
    date: entry?.date || `${month}-01`,
    grossSales: entry?.grossSales || 0,
    rate: entry?.rate ?? selectedAccount?.commissionRate ?? 0,
    amount: entry?.amount || 0,
    source: entry?.source || 'manual',
    notes: entry?.notes || ''
  }));
  const field = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const updateAccount = id => {
    const account = accounts.find(row => row.id === id);
    setForm(current => ({ ...current, accountId: id, rate: account?.commissionRate || 0 }));
  };
  const computedCommission = moneyRound(numberValue(form.grossSales) * numberValue(form.rate) / 100);
  const submit = event => {
    event.preventDefault();
    onSave({
      ...form,
      grossSales: form.kind === 'commission' ? moneyRound(form.grossSales) : 0,
      rate: form.kind === 'commission' ? numberValue(form.rate) : 0,
      amount: form.kind === 'commission' ? computedCommission : moneyRound(form.amount)
    });
  };

  return (
    <form className="finance-form" onSubmit={submit}>
      <div className="finance-form-grid">
        <label className="wide"><span>Client</span><select value={form.accountId} onChange={event => updateAccount(event.target.value)} required><option value="">Choose an account</option>{accounts.map(account => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
        <label><span>Income type</span><select value={form.kind} onChange={event => field('kind', event.target.value)}><option value="commission">Closed-sale commission</option><option value="other">Other one-time income</option></select></label>
        <label><span>Date received</span><input type="date" value={form.date} onChange={event => field('date', event.target.value)} required /></label>
        {form.kind === 'commission' ? (
          <>
            <label><span>Closed sales</span><div className="finance-input-affix"><i>$</i><input type="number" min="0" step="0.01" value={form.grossSales} onChange={event => field('grossSales', event.target.value)} required /></div></label>
            <label><span>Commission rate</span><div className="finance-input-affix"><input type="number" min="0" step="0.01" value={form.rate} onChange={event => field('rate', event.target.value)} required /><i>%</i></div></label>
          </>
        ) : <label><span>Amount received</span><div className="finance-input-affix"><i>$</i><input type="number" min="0" step="0.01" value={form.amount} onChange={event => field('amount', event.target.value)} required /></div></label>}
        <label className="wide"><span>Notes</span><textarea rows="3" value={form.notes} onChange={event => field('notes', event.target.value)} /></label>
      </div>
      {form.kind === 'commission' && <div className="finance-form-preview"><span>BiteSites commission</span><strong>{money(computedCommission)}</strong><small>{money(form.grossSales)} × {numberValue(form.rate)}%</small></div>}
      <div className="finance-form-actions">
        <button className="btn-admin primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save income'}</button>
        {entry?.id && <button className="btn-admin danger" type="button" disabled={busy} onClick={onDelete}>Delete income</button>}
      </div>
    </form>
  );
}

function TeamForm({ member, onSave, onDelete, busy }) {
  const [form, setForm] = useState(() => ({
    id: member?.id,
    name: member?.name || '',
    role: member?.role || 'Account manager',
    sharesExpenses: member?.sharesExpenses ?? true,
    status: member?.status || 'active'
  }));
  const field = (key, value) => setForm(current => ({ ...current, [key]: value }));
  return (
    <form className="finance-form" onSubmit={event => { event.preventDefault(); onSave(form); }}>
      <div className="finance-form-grid">
        <label className="wide"><span>Name</span><input value={form.name} onChange={event => field('name', event.target.value)} required /></label>
        <label><span>Role</span><input value={form.role} onChange={event => field('role', event.target.value)} required /></label>
        <label><span>Status</span><select value={form.status} onChange={event => field('status', event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <label className="wide finance-check"><input type="checkbox" checked={form.sharesExpenses} onChange={event => field('sharesExpenses', event.target.checked)} /><span>Include this person in the equal expense-sharing pool</span></label>
      </div>
      <div className="finance-form-actions">
        <button className="btn-admin primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save team member'}</button>
        {member?.id && <button className="btn-admin danger" type="button" disabled={busy} onClick={onDelete}>Delete team member</button>}
      </div>
    </form>
  );
}

export default function Finance({ canWrite }) {
  const ledger = useFinanceLedger(canWrite);
  const [month, setMonth] = useState(currentMonth);
  const [panel, setPanel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const snapshot = useMemo(() => calculateFinanceSnapshot(ledger, month), [ledger, month]);
  const maxAccountRevenue = Math.max(1, ...snapshot.accounts.map(account => account.grossRevenue));

  const persist = async (save, value) => {
    setBusy(true);
    setNotice('');
    try {
      await save(value);
      await ledger.refresh();
      setPanel(null);
    } catch (error) {
      setNotice(error?.code === 'permission-denied'
        ? 'This account has read-only finance access.'
        : error?.message || 'Could not save this finance record.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (removeFn, id, label) => {
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    setBusy(true);
    setNotice('');
    try {
      await removeFn(id);
      await ledger.refresh();
      setPanel(null);
    } catch (error) {
      setNotice(error?.message || 'Could not delete this finance record.');
    } finally {
      setBusy(false);
    }
  };

  const open = (type, row = null) => canWrite && setPanel({ type, row });
  const monthIncome = ledger.income.filter(entry => monthOf(entry.date) === month);

  return (
    <>
      <header className="admin-topbar finance-topbar">
        <div>
          <h1>Finance</h1>
          <p className="admin-topbar-sub">Costs, client revenue, and team payouts in one reconciled ledger.</p>
        </div>
        <div className="admin-topbar-spacer" />
        <span className={`finance-access ${canWrite ? 'owner' : ''}`}>
          <i />{canWrite ? 'Owner · edit access' : 'Admin · read only'}
        </span>
        <label className="finance-month"><span className="sr-only">Reporting month</span><input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label>
        <button className="btn-admin" type="button" onClick={ledger.refresh}>Refresh</button>
      </header>

      <div className={`admin-body finance-page ${ledger.loading ? 'is-refreshing' : ''}`}>
        {ledger.error && <p className="admin-error">{ledger.error}</p>}
        {notice && <p className="admin-error">{notice}</p>}
        {ledger.usingStarterData && (
          <p className="finance-banner">Starter values are shown as a read-only preview. They are written to the protected ledger when the finance owner first opens this tab.</p>
        )}

        <div className="finance-title-row">
          <div><span>Reporting period</span><strong>{monthLabel(month)}</strong></div>
          {canWrite && <div className="finance-actions"><button className="btn-admin" type="button" onClick={() => open('team')}>+ Team member</button><button className="btn-admin" type="button" onClick={() => open('income')}>+ Record income</button><button className="btn-admin" type="button" onClick={() => open('expense')}>+ Expense</button><button className="btn-admin primary" type="button" onClick={() => open('account')}>+ Account</button></div>}
        </div>

        <div className="admin-grid cols-4">
          <FinanceStat label="Total revenue" value={money(snapshot.totalRevenue)} foot={`${money(snapshot.recurringRevenue)} monthly recurring`} tone="revenue" />
          <FinanceStat label="Total expenses" value={money(snapshot.totalExpenses)} foot={`${money(snapshot.recurringExpenses)} recurring · ${money(snapshot.totalExpenses - snapshot.recurringExpenses)} one time`} tone="expense" />
          <FinanceStat label="Net after costs" value={money(snapshot.netRevenue)} foot="Revenue less all active expenses" tone="net" />
          <FinanceStat label="Net margin" value={`${Math.round(snapshot.margin * 1000) / 10}%`} foot={`${money(snapshot.universalExpenses)} in universal costs`} />
        </div>

        {Math.abs(snapshot.unallocatedRevenue) > .01 && (
          <p className="finance-warning">Payout rules are off by {money(snapshot.unallocatedRevenue)}. Edit the affected client split so allocated revenue equals revenue received.</p>
        )}
        {Math.abs(snapshot.unallocatedExpenses) > .01 && (
          <p className="finance-warning">Expense paycheck rules are off by {money(snapshot.unallocatedExpenses)}. Edit the custom expense split so it equals 100%.</p>
        )}

        <section className="admin-card finance-accounts-card">
          <div className="card-head">
            <div><h3>Account profitability</h3><p>Universal costs are distributed evenly across revenue-producing accounts; client-tagged costs stay with their client.</p></div>
          </div>
          <div className="admin-table-scroll">
            <table className="admin-table finance-table">
              <thead><tr><th>Account</th><th>Revenue mix</th><th className="num">Gross</th><th className="num">Expenses</th><th className="num">Net</th><th>Payout split</th>{canWrite && <th />}</tr></thead>
              <tbody>
                {snapshot.accounts.map(account => (
                  <tr key={account.id}>
                    <td><div className="cell-strong">{account.name}</div><div className="finance-account-bar"><i style={{ width: `${Math.max(2, account.grossRevenue / maxAccountRevenue * 100)}%` }} /></div></td>
                    <td><div className="finance-revenue-mix"><span>{money(account.recurring)} retainer</span>{account.initial > 0 && <span>{money(account.initial)} initial</span>}{account.commission > 0 && <span>{money(account.commission)} commission</span>}{account.otherIncome > 0 && <span>{money(account.otherIncome)} other</span>}</div></td>
                    <td className="num cell-strong">{money(account.grossRevenue)}</td>
                    <td className="num finance-negative">−{money(account.totalExpenses)}</td>
                    <td className="num finance-positive">{money(account.netRevenue)}</td>
                    <td><div className="finance-splits">{account.allocations.map((allocation, index) => <span key={`${allocation.memberId}-${index}`}>{memberName(ledger.team, allocation.memberId)} <b>{allocation.method === 'fixed' ? money(allocation.value) : `${allocation.value}%`}</b></span>)}</div></td>
                    {canWrite && <td className="num"><button className="view-toggle" type="button" onClick={() => open('account', account)}>Edit</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="admin-grid split finance-middle">
          <section className="admin-card">
            <div className="card-head"><div><h3>Team payout</h3><p>Gross client allocation less each participating manager’s equal share of expenses.</p></div></div>
            <div className="finance-payout-list">
              {snapshot.team.map(member => (
                <button type="button" className="finance-payout-row" key={member.id} onClick={() => open('team', member)} disabled={!canWrite}>
                  <span className="finance-person-mark">{member.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('')}</span>
                  <span className="finance-person"><strong>{member.name}</strong><small>{member.role}{!member.sharesExpenses ? ' · outside expense pool' : ''}</small></span>
                  <span><small>Gross</small><b>{money(member.grossPayout)}</b></span>
                  <span className="finance-negative"><small>Costs</small><b>−{money(member.expenseShare)}</b></span>
                  <span className="finance-positive"><small>Net payout</small><b>{money(member.netPayout)}</b></span>
                </button>
              ))}
            </div>
            <p className="finance-method-note">Costs default to an equal split across all {ledger.team.filter(member => member.sharesExpenses && member.status !== 'inactive').length} active payout participants, including Eidan. GoHighLevel overrides that default at 40% Jensy, 40% Jonathan, 10% Nussein, and 10% Eidan. Client tags affect account profitability.</p>
          </section>

          <section className="admin-card finance-cost-card">
            <div className="card-head"><div><h3>Cost mix</h3><p>{monthLabel(month)}</p></div></div>
            <div className="finance-cost-total"><span>Total costs</span><strong>{money(snapshot.totalExpenses)}</strong></div>
            <div className="finance-cost-list">
              {snapshot.expenses.map(expense => (
                <button key={expense.id} type="button" onClick={() => open('expense', expense)} disabled={!canWrite}>
                  <span><i className={expense.scope} />{expense.name}<small>{expense.category} · {expense.cadence === 'monthly' ? 'monthly' : 'one time'}</small></span>
                  <b>{money(expense.total)}</b>
                </button>
              ))}
              {!snapshot.expenses.length && <div className="finance-inline-empty">No costs in this month.</div>}
            </div>
          </section>
        </div>

        <section className="admin-card">
          <div className="card-head"><div><h3>Expense ledger</h3><p>Monthly subscriptions and one-time purchases, tagged to the company or a client.</p></div></div>
          <div className="admin-table-scroll">
            <table className="admin-table finance-table">
              <thead><tr><th>Expense</th><th>Tag</th><th>Cadence</th><th>Paycheck split</th><th className="num">Rate</th><th className="num">Qty</th><th className="num">Total</th>{canWrite && <th />}</tr></thead>
              <tbody>{ledger.expenses.map(expense => <tr key={expense.id}><td><div className="cell-strong">{expense.name}</div><div className="cell-dim">{expense.notes}</div></td><td><Pill kind={expense.scope === 'client' ? 'finance-client' : 'finance-universal'}>{expense.scope === 'client' ? accountName(ledger.accounts, expense.accountId) : 'Universal'}</Pill></td><td><div>{expense.cadence === 'monthly' ? 'Monthly' : 'One time'}</div><div className="cell-dim">{expense.cadence === 'monthly' && expense.startMonth ? `${monthsInclusive(expense.startMonth, month)} charge${monthsInclusive(expense.startMonth, month) === 1 ? '' : 's'} through period` : expense.effectiveDate || 'No start date'}</div></td><td><div className="finance-splits">{expense.expenseAllocations?.length ? expense.expenseAllocations.map((allocation, index) => <span key={`${allocation.memberId}-${index}`}>{memberName(ledger.team, allocation.memberId)} <b>{allocation.value}%</b></span>) : <span>Account managers <b>equal</b></span>}</div></td><td className="num">{money(expense.unitAmount ?? expense.amount)}</td><td className="num">{expense.quantity || 1}</td><td className="num cell-strong">{money(expenseAmount(expense))}</td>{canWrite && <td className="num"><button className="view-toggle" type="button" onClick={() => open('expense', expense)}>Edit</button></td>}</tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="admin-card">
          <div className="card-head"><div><h3>Commission & one-time income</h3><p>Closed sales use each account’s commission rate and commission payout split.</p></div>{canWrite && <div className="card-head-actions"><button className="btn-admin" type="button" onClick={() => open('income')}>Record income</button></div>}</div>
          {monthIncome.length ? <div className="admin-table-scroll"><table className="admin-table finance-table"><thead><tr><th>Client</th><th>Type</th><th>Date</th><th className="num">Closed sales</th><th className="num">Rate</th><th className="num">BiteSites revenue</th><th>Source</th>{canWrite && <th />}</tr></thead><tbody>{monthIncome.map(entry => <tr key={entry.id}><td className="cell-strong">{accountName(ledger.accounts, entry.accountId)}</td><td>{entry.kind === 'commission' ? 'Commission' : 'Other income'}</td><td className="cell-dim">{entry.date}</td><td className="num">{entry.kind === 'commission' ? money(entry.grossSales) : '—'}</td><td className="num">{entry.kind === 'commission' ? `${entry.rate}%` : '—'}</td><td className="num finance-positive">{money(entry.amount)}</td><td><Pill kind={entry.source === 'firebase' ? 'finance-sync' : ''}>{entry.source === 'firebase' ? 'Firebase' : 'Manual'}</Pill></td>{canWrite && <td className="num"><button className="view-toggle" type="button" onClick={() => open('income', entry)}>Edit</button></td>}</tr>)}</tbody></table></div> : <div className="admin-empty"><strong>No variable income this month</strong>Monthly retainers still appear above.</div>}
          <div className="finance-sync-note"><i>↻</i><div><strong>Stone Bellisimo Firebase sync point</strong><span>The 10% rule and manual $600 commission are live. Automated closed-sale imports can replace the manual source once that Firebase project’s service credentials and sales collection are provided.</span></div></div>
        </section>
      </div>

      {panel?.type === 'account' && <Panel title={panel.row ? 'Edit account' : 'Add account'} subtitle="Retainer, initial payment, and payout rules" onClose={() => setPanel(null)}><AccountForm account={panel.row} team={ledger.team} busy={busy} onSave={value => persist(saveFinanceAccount, value)} onDelete={() => remove(deleteFinanceAccount, panel.row.id, panel.row.name)} /></Panel>}
      {panel?.type === 'expense' && <Panel title={panel.row ? 'Edit expense' : 'Add expense'} subtitle="Recurring or one-time, universal or client-specific" onClose={() => setPanel(null)}><ExpenseForm expense={panel.row} accounts={ledger.accounts} team={ledger.team} month={month} busy={busy} onSave={value => persist(saveFinanceExpense, value)} onDelete={() => remove(deleteFinanceExpense, panel.row.id, panel.row.name)} /></Panel>}
      {panel?.type === 'income' && <Panel title={panel.row ? 'Edit income' : 'Record income'} subtitle="Closed-sale commissions and one-time revenue" onClose={() => setPanel(null)}><IncomeForm entry={panel.row} accounts={ledger.accounts} month={month} busy={busy} onSave={value => persist(saveFinanceIncome, value)} onDelete={() => remove(deleteFinanceIncome, panel.row.id, 'this income record')} /></Panel>}
      {panel?.type === 'team' && <Panel title={panel.row ? 'Edit team member' : 'Add team member'} subtitle="Control payout labels and equal expense sharing" onClose={() => setPanel(null)}><TeamForm member={panel.row} busy={busy} onSave={value => persist(saveFinanceTeamMember, value)} onDelete={() => remove(deleteFinanceTeamMember, panel.row.id, panel.row.name)} /></Panel>}
    </>
  );
}
