// Editable starter values from the initial BiteSites finance brief. Kept in a
// dependency-free module so the calculation tests can run without Firebase.

export const FINANCE_OWNER_EMAILS = ['jensyjimenez723@gmail.com', 'jensy@bitesites.org'];

export const STARTER_TEAM = [
  { id: 'jensy-jimenez', name: 'Jensy Jimenez', role: 'Account manager', sharesExpenses: true, status: 'active' },
  { id: 'nussein-iounakov', name: 'Nussein Iounakov', role: 'Account manager', sharesExpenses: true, status: 'active' },
  { id: 'eidan-jimenez', name: 'Eidan Jimenez', role: 'Developer', sharesExpenses: true, status: 'active' },
  { id: 'jonathan-arroyo', name: 'Jonathan Arroyo', role: 'Account manager', sharesExpenses: true, status: 'active' }
];

export const STARTER_ACCOUNTS = [
  {
    id: 'stone-bellisimo',
    name: 'Stone Bellisimo LLC',
    status: 'active',
    monthlyRetainer: 400,
    initialPayment: 0,
    initialPaymentDate: '',
    startMonth: '',
    endMonth: '',
    commissionRate: 10,
    allocations: [
      { memberId: 'jensy-jimenez', method: 'percent', value: 50 },
      { memberId: 'jonathan-arroyo', method: 'percent', value: 50 }
    ],
    commissionAllocations: [
      { memberId: 'jensy-jimenez', method: 'percent', value: 50 },
      { memberId: 'jonathan-arroyo', method: 'percent', value: 50 }
    ],
    commissionSource: 'manual',
    notes: '10% commission on closed sales; prepared for a future Stone Bellisimo Firebase sync.'
  },
  {
    id: 'stockroom-nj',
    name: 'StockRoom NJ',
    status: 'active',
    monthlyRetainer: 1200,
    initialPayment: 0,
    initialPaymentDate: '',
    startMonth: '',
    endMonth: '',
    commissionRate: 0,
    allocations: [
      { memberId: 'eidan-jimenez', method: 'fixed', value: 300 },
      { memberId: 'nussein-iounakov', method: 'fixed', value: 360 },
      { memberId: 'jensy-jimenez', method: 'fixed', value: 540 }
    ],
    commissionAllocations: [],
    commissionSource: 'manual',
    notes: 'The balance after Eidan and Nussein goes to Jensy.'
  },
  {
    id: 'clifton-animal-hospital',
    name: 'Clifton Ave Animal Hospital',
    status: 'active',
    monthlyRetainer: 1500,
    initialPayment: 0,
    initialPaymentDate: '',
    startMonth: '',
    endMonth: '',
    commissionRate: 0,
    allocations: [
      { memberId: 'jensy-jimenez', method: 'percent', value: 100 }
    ],
    commissionAllocations: [],
    commissionSource: 'manual',
    notes: 'Full retainer allocated to Jensy.'
  }
];

export const STARTER_EXPENSES = [
  {
    id: 'gohighlevel',
    name: 'GoHighLevel', category: 'Software', cadence: 'monthly',
    unitAmount: 97, quantity: 1, scope: 'universal', accountId: '',
    startMonth: '2026-04', endMonth: '', effectiveDate: '',
    expenseAllocations: [
      { memberId: 'jensy-jimenez', method: 'percent', value: 40 },
      { memberId: 'jonathan-arroyo', method: 'percent', value: 40 },
      { memberId: 'nussein-iounakov', method: 'percent', value: 10 },
      { memberId: 'eidan-jimenez', method: 'percent', value: 10 }
    ],
    notes: 'Five successful $97 invoices from April through August 2026; failed retries and card-verification holds excluded.'
  },
  {
    id: 'gohighlevel-wallet-2026-08',
    name: 'GoHighLevel wallet auto-recharge', category: 'Software', cadence: 'one_time',
    unitAmount: 10, quantity: 1, scope: 'universal', accountId: '',
    startMonth: '', endMonth: '', effectiveDate: '2026-08-02',
    expenseAllocations: [
      { memberId: 'jensy-jimenez', method: 'percent', value: 40 },
      { memberId: 'jonathan-arroyo', method: 'percent', value: 40 },
      { memberId: 'nussein-iounakov', method: 'percent', value: 10 },
      { memberId: 'eidan-jimenez', method: 'percent', value: 10 }
    ],
    notes: 'Successful wallet recharge shown in GoHighLevel billing.'
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace', category: 'Software', cadence: 'monthly',
    unitAmount: 16.5, quantity: 1, scope: 'universal', accountId: '',
    startMonth: '2026-08', endMonth: '', effectiveDate: '', expenseAllocations: [],
    notes: '$16.50 per user; the first charge was August 14, 2026. One paid seat is active for now.'
  },
  {
    id: 'codex',
    name: 'Codex', category: 'Software', cadence: 'monthly',
    unitAmount: 20, quantity: 1, scope: 'universal', accountId: '',
    startMonth: '2025-08', endMonth: '', effectiveDate: '', expenseAllocations: [],
    notes: '13 monthly charges through August 2026; cloud-code access through the Archive Studios partnership.'
  },
  {
    id: 'stockroom-lightbox',
    name: 'StockRoom NJ light box', category: 'Equipment', cadence: 'one_time',
    unitAmount: 101.07, quantity: 1, scope: 'client', accountId: 'stockroom-nj',
    startMonth: '', endMonth: '', effectiveDate: '2026-08-01', expenseAllocations: [],
    notes: 'One-time client-specific purchase.'
  }
];

export const STARTER_INCOME = [
  {
    id: 'stone-commission-2026-08',
    accountId: 'stone-bellisimo',
    kind: 'commission',
    date: '2026-08-01',
    grossSales: 6000,
    rate: 10,
    amount: 600,
    source: 'manual',
    notes: 'Commission received to date, based on $6,000 of closed sales.'
  }
];

export const STARTER_LEDGER = {
  team: STARTER_TEAM,
  accounts: STARTER_ACCOUNTS,
  expenses: STARTER_EXPENSES,
  income: STARTER_INCOME
};
