// Pure invoice arithmetic, dates and validation for monthly client billing.
//
// Everything money-shaped is an integer number of cents. Dates are ISO calendar
// dates ('YYYY-MM-DD') interpreted in America/New_York, which is where BiteSites
// bills from; they carry no time and no offset, so a date can never drift a day
// when it crosses a server in another zone. See BILLING_INVOICING.md.

export const BILLING_TIME_ZONE = 'America/New_York';
export const DEFAULT_LEAD_RATE_CENTS = 7500;
export const DEFAULT_DUE_DAYS = 30;
export const DEFAULT_TERMS = 'Payment is due within 15-30 days of the invoice dates';
export const INVOICE_STATUSES = Object.freeze(['draft', 'finalized', 'sent', 'paid', 'payment_failed', 'void']);
export const PAYMENT_METHODS = Object.freeze(['stripe', 'zelle', 'check', 'other']);
export const LINE_KINDS = Object.freeze(['retainer', 'leads', 'custom']);

// The issuer block printed on every invoice. Public business contact details,
// exactly as they appear on the foundation invoice (CAAH #011).
export const BILLING_ISSUER = Object.freeze({
  name: 'JENSY JIMENEZ',
  title: 'Social Media & Web Development Consulting',
  location: 'Bergen County, NJ',
  email: 'jensy@bitesites.org',
  phone: '(347)277-4506',
  zelle: '3472774506',
  checksPayableTo: 'Jensy Jimenez',
  thankYou: 'Thank you for your continued partnership!'
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_KEY = /^(\d{4})-(\d{2})$/;

export const isIsoDate = value => {
  const match = ISO_DATE.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
};

const pad = (value, length = 2) => String(value).padStart(length, '0');
const isoFromUtc = date => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const utcFromIso = iso => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

/** The calendar date in New York for an instant. */
export function billingToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: BILLING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(iso, days) {
  if (!isIsoDate(iso)) throw new Error(`Invalid date: ${iso}`);
  const date = utcFromIso(iso);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return isoFromUtc(date);
}

/** Period boundaries for a 'YYYY-MM' key: first day, last day (inclusive), label. */
export function periodForMonth(periodKey) {
  const match = PERIOD_KEY.exec(String(periodKey || ''));
  if (!match || +match[2] < 1 || +match[2] > 12) throw new Error(`Invalid billing month: ${periodKey}`);
  const year = +match[1];
  const month = +match[2];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodKey: `${year}-${pad(month)}`,
    periodStart: `${year}-${pad(month)}-01`,
    periodEnd: `${year}-${pad(month)}-${pad(last)}`,
    periodLabel: `${MONTHS[month - 1]} ${year}`
  };
}

/** The month before `now` (New York time) — what the 1st-of-month run bills. */
export function priorMonthPeriod(now = new Date()) {
  const [year, month] = billingToday(now).split('-').map(Number);
  const priorYear = month === 1 ? year - 1 : year;
  const priorMonth = month === 1 ? 12 : month - 1;
  return periodForMonth(`${priorYear}-${pad(priorMonth)}`);
}

/** A Firestore Timestamp, Date or ISO string as 'YYYY-MM-DD' (UTC for instants). */
export const isoDay = value => {
  if (!value) return '';
  if (typeof value?.toDate === 'function') return value.toDate().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

export const formatInvoiceNumber = value => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error('Invoice numbers start at 1.');
  return pad(number, 3);
};

/** 12/1/2026 — the foundation invoice's DATE format. */
export const formatUsDate = iso => {
  if (!isIsoDate(iso)) return '';
  const [year, month, day] = iso.split('-').map(Number);
  return `${month}/${day}/${year}`;
};

/** December 1, 2026 */
export const formatLongDate = iso => {
  if (!isIsoDate(iso)) return '';
  const [year, month, day] = iso.split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
};

/**
 * $600 for whole dollars (as the foundation invoice prints it), $600.50 when
 * there are cents, and a thousands separator once a total reaches four digits.
 * `{ cents: true }` forces two decimals ($75.00).
 */
export function formatMoney(amountCents, { cents = false } = {}) {
  const value = Math.round(Number(amountCents) || 0);
  const negative = value < 0;
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const dollars = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = cents || remainder ? `${dollars}.${pad(remainder)}` : dollars;
  return `${negative ? '-' : ''}$${text}`;
}

export const leadLineDescription = (leadCount, leadRateCents = DEFAULT_LEAD_RATE_CENTS) => {
  if (leadCount === null || leadCount === undefined) return 'Lead Generation';
  const count = Number(leadCount);
  return `Lead Generation — ${count} lead${count === 1 ? '' : 's'} × ${formatMoney(leadRateCents, { cents: true })}`;
};

const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const nonNegativeInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a whole number of cents, zero or more.`);
  if (number > 100_000_000) throw new Error(`${label} is too large.`);
  return number;
};

export const normalizeLeadCount = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100_000) throw new Error('The lead count must be a whole number, zero or more.');
  return number;
};

/** A billing client's recurring lines, validated. */
export function normalizeRetainerLines(input) {
  if (!Array.isArray(input)) throw new Error('Line items must be a list.');
  if (input.length > 25) throw new Error('Add no more than 25 recurring line items.');
  return input.map((line, index) => {
    const description = cleanText(line?.description, 200);
    if (!description) throw new Error(`Line ${index + 1} needs a description.`);
    return { description, amountCents: nonNegativeInteger(line?.amountCents, `Line ${index + 1} amount`) };
  });
}

/** One invoice line, with its amount derived from quantity × unit — never trusted from input. */
export function normalizeInvoiceLine(line, { periodLabel = '' } = {}) {
  const kind = LINE_KINDS.includes(line?.kind) ? line.kind : 'custom';
  const quantity = Number(line?.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100_000) throw new Error('Quantities must be whole numbers, zero or more.');
  const unitCents = nonNegativeInteger(line?.unitCents ?? line?.amountCents ?? 0, 'Unit price');
  const description = cleanText(line?.description, 200);
  if (!description) throw new Error('Every line needs a description.');
  return {
    kind,
    description,
    periodLabel: cleanText(line?.periodLabel ?? periodLabel, 60),
    quantity,
    unitCents,
    amountCents: quantity * unitCents
  };
}

/** The lead line for a count; a missing count is shown blank and blocks finalizing. */
export const buildLeadLine = ({ leadCount, leadRateCents = DEFAULT_LEAD_RATE_CENTS, periodLabel }) => ({
  kind: 'leads',
  description: leadLineDescription(leadCount, leadRateCents),
  periodLabel,
  quantity: leadCount ?? 0,
  unitCents: leadRateCents,
  amountCents: (leadCount ?? 0) * leadRateCents
});

/** Initial invoice lines from a billing client's template. */
export function buildInvoiceLines(client, { periodLabel, leadCount = null }) {
  const lines = normalizeRetainerLines(client?.lineItems || []).map(line => ({
    kind: 'retainer',
    description: line.description,
    periodLabel,
    quantity: 1,
    unitCents: line.amountCents,
    amountCents: line.amountCents
  }));
  if (clientBillsLeads(client)) {
    lines.push(buildLeadLine({ leadCount, leadRateCents: leadRate(client), periodLabel }));
  }
  return lines;
}

export const leadRate = client => {
  const rate = Number(client?.leadRateCents);
  return Number.isInteger(rate) && rate >= 0 ? rate : DEFAULT_LEAD_RATE_CENTS;
};

export const clientBillsLeads = client => Number(client?.leadRateCents) > 0 || client?.leadSource?.type === 'wordpress';

export const totalCents = lines => lines.reduce((sum, line) => sum + (Number(line.amountCents) || 0), 0);

/**
 * Re-derives every amount and the total from an edited draft. The lead line is
 * always rebuilt from the lead count so the description and the money agree.
 */
export function recomputeInvoice({ lineItems, leadCount, leadRateCents = DEFAULT_LEAD_RATE_CENTS, periodLabel }) {
  if (!Array.isArray(lineItems)) throw new Error('Line items must be a list.');
  if (lineItems.length > 30) throw new Error('An invoice can have at most 30 lines.');
  const count = normalizeLeadCount(leadCount);
  const lines = lineItems.map(line => (line?.kind === 'leads'
    ? buildLeadLine({ leadCount: count, leadRateCents: nonNegativeInteger(line.unitCents ?? leadRateCents, 'Lead rate'), periodLabel: cleanText(line.periodLabel ?? periodLabel, 60) })
    : normalizeInvoiceLine(line, { periodLabel })));
  return { lineItems: lines, leadCount: count, totalCents: totalCents(lines) };
}

/** Why a draft cannot be finalized yet, or '' when it can. */
export function finalizeBlocker(invoice, client) {
  if (!invoice || invoice.status !== 'draft') return 'Only a draft can be finalized.';
  if (!Array.isArray(invoice.lineItems) || !invoice.lineItems.length) return 'Add at least one line item.';
  if (invoice.lineItems.some(line => line.kind === 'leads') && (invoice.leadCount === null || invoice.leadCount === undefined)) {
    return 'Enter or pull the lead count before finalizing.';
  }
  if (!isIsoDate(invoice.issueDate) || !isIsoDate(invoice.dueDate)) return 'The invoice needs valid issue and due dates.';
  if (!client) return 'The billing client for this invoice no longer exists.';
  return '';
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const slugify = value => cleanText(value, 80).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Validates an admin's edit to `billingClients/{id}`. `autopay` is owned by the
 * Stripe integration and is never accepted from here.
 */
export function normalizeBillingClient(input) {
  const name = cleanText(input?.name, 160);
  if (!name) throw new Error('The client needs a name.');
  const billingEmails = Array.from(new Set((Array.isArray(input?.billingEmails) ? input.billingEmails : String(input?.billingEmails || '').split(/[\s,;]+/))
    .map(value => String(value || '').trim().toLowerCase()).filter(Boolean)));
  if (billingEmails.length > 10) throw new Error('Use no more than 10 billing emails.');
  const invalid = billingEmails.find(value => !EMAIL.test(value));
  if (invalid) throw new Error(`${invalid} is not a valid email address.`);
  const leadType = input?.leadSource?.type === 'wordpress' ? 'wordpress' : 'manual';
  const endpoint = cleanText(input?.leadSource?.endpoint, 500);
  if (leadType === 'wordpress') {
    let parsed;
    try { parsed = new URL(endpoint); } catch { /* reported below */ }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error('The WordPress lead endpoint must be an https:// URL.');
    }
  }
  const invoiceNumberNext = Number(input?.invoiceNumberNext ?? 1);
  if (!Number.isInteger(invoiceNumberNext) || invoiceNumberNext < 1 || invoiceNumberNext > 99_999) {
    throw new Error('The next invoice number must be a whole number of 1 or more.');
  }
  return {
    name,
    contactName: cleanText(input?.contactName, 120),
    billingEmails,
    address: cleanText(input?.address, 300),
    lineItems: normalizeRetainerLines(input?.lineItems || []),
    leadRateCents: nonNegativeInteger(input?.leadRateCents ?? DEFAULT_LEAD_RATE_CENTS, 'Lead rate'),
    leadSource: leadType === 'wordpress' ? { type: 'wordpress', endpoint } : { type: 'manual' },
    approvalMode: input?.approvalMode === 'auto' ? 'auto' : 'manual',
    invoiceNumberNext,
    terms: cleanText(input?.terms, 300) || DEFAULT_TERMS,
    active: input?.active !== false
  };
}
