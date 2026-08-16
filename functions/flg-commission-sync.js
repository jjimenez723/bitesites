// Fine Line commission → Finance ledger bridge.
//
// The FLG workflows record collected revenue, the commission rate, and what
// Fine Line has actually paid on each opportunity. This module rolls that into
// `financeIncome` rows the Finance board already knows how to read, joined to
// the `fine-line-group` account (the same id functions/accounts.js declares,
// with the §4 policy: 10% of revenue actually collected).
//
// Two rules keep the ledger honest:
//
//   * `amount` is money actually received — flg__bitesites_commission_paid —
//     because the board counts income rows as revenue. Commission that is due
//     but unpaid is carried on the row (`expected` / `outstanding`) and in the
//     notes, never in `amount`, so the month's totals cannot be inflated by a
//     tag someone forgot to clear.
//
//   * Rows are machine-owned and idempotent: one deterministic id per
//     opportunity, re-merged on every run. GHL is the source of truth for
//     these rows; hand edits belong on separate manual rows.
//
// GoHighLevel remains read-only — this writes Firestore only.

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { GHL_CRM_DASHBOARD_TOKEN, fetchCrmSnapshot } from './flg-crm.js';

export const FINE_LINE_ACCOUNT_ID = 'fine-line-group';

// The workflow QA records still live in the pipelines (see
// FINAL-WORKFLOW-REPORT.md). They carry commission tags and test revenue, and
// must never become ledger rows. Matched on the QA naming convention those
// records were created with.
const QA_NAME = /\bworkflow qa\b|\bflg qa\b/i;

const round = value => Math.round((Number(value) || 0) * 100) / 100;

const monthDate = iso => {
  const at = Date.parse(iso || '');
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : '';
};

/**
 * One ledger row per opportunity that has commission activity. Pure, so the
 * test suite can pin every rule without Firestore or HighLevel.
 */
export function buildCommissionLedgerRows(snapshot, { now = Date.now() } = {}) {
  const rows = [];
  for (const opportunity of snapshot?.opportunities || []) {
    if (QA_NAME.test(opportunity.name) || QA_NAME.test(opportunity.contactName || '')) continue;

    const expected = round(opportunity.commissionExpected);
    const paid = round(opportunity.commissionPaid);
    const outstanding = round(opportunity.commissionOutstanding);
    if (expected <= 0 && paid <= 0 && !opportunity.commissionDueTag) continue;

    // The month this income belongs to: when the customer last paid Fine Line,
    // falling back to the deal's last movement.
    const date = monthDate(opportunity.lastCustomerPaymentDate)
      || monthDate(opportunity.lastStageChangeAt)
      || monthDate(opportunity.createdAt)
      || new Date(now).toISOString().slice(0, 10);

    rows.push({
      id: `flg-commission-${opportunity.id}`,
      accountId: FINE_LINE_ACCOUNT_ID,
      kind: 'commission',
      date,
      grossSales: round(opportunity.collectedRevenue),
      rate: round(opportunity.commissionRate),
      amount: paid,
      expected,
      outstanding,
      source: 'flg-crm-sync',
      opportunityId: opportunity.id,
      opportunityName: opportunity.contactName || opportunity.name,
      notes: outstanding > 0
        ? `Synced from HighLevel. ${money(outstanding)} still due on ${money(round(opportunity.collectedRevenue))} collected by Fine Line.`
        : `Synced from HighLevel. Commission settled on ${money(round(opportunity.collectedRevenue))} collected by Fine Line.`
    });
  }
  return rows;
}

const money = value => `$${round(value).toLocaleString('en-US')}`;

/**
 * The account row the income joins to. Created once if absent; never
 * overwritten — retainer, allocations and status stay whatever the finance
 * owner sets in the board.
 */
export async function ensureFineLineFinanceAccount(db) {
  const ref = db.doc(`financeAccounts/${FINE_LINE_ACCOUNT_ID}`);
  const existing = await ref.get();
  if (existing.exists) return false;
  await ref.set({
    name: 'The Fine Line Group',
    status: 'active',
    monthlyRetainer: 0,
    initialPayment: 0,
    initialPaymentDate: '',
    startMonth: '',
    endMonth: '',
    commissionRate: 10,
    allocations: [],
    commissionAllocations: [],
    commissionSource: 'flg-crm-sync',
    notes: '10% of revenue Fine Line actually collects (§4). Commission rows sync daily from HighLevel; set allocations here.',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
  return true;
}

export async function runCommissionSync(db, { token, fetchImpl, sleep, now = Date.now() } = {}) {
  const snapshot = await fetchCrmSnapshot({ token, fetchImpl, sleep, now });
  const rows = buildCommissionLedgerRows(snapshot, { now });
  await ensureFineLineFinanceAccount(db);

  const batch = db.batch();
  for (const { id, ...row } of rows) {
    batch.set(db.doc(`financeIncome/${id}`), {
      ...row,
      updatedAt: FieldValue.serverTimestamp(),
      syncedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  batch.set(db.doc('systemHealth/flg-commission-sync'), {
    lastRunAt: FieldValue.serverTimestamp(),
    status: 'ok',
    rows: rows.length,
    opportunities: snapshot.opportunities.length
  }, { merge: true });
  await batch.commit();
  return { rows: rows.length };
}

export const syncFineLineCommissions = onSchedule(
  { schedule: 'every day 06:30', secrets: [GHL_CRM_DASHBOARD_TOKEN], timeoutSeconds: 120, maxInstances: 1 },
  async () => {
    const db = getFirestore();
    try {
      const { rows } = await runCommissionSync(db, { token: GHL_CRM_DASHBOARD_TOKEN.value().trim() });
      console.log(`[flg-commission] synced ${rows} ledger row${rows === 1 ? '' : 's'}`);
    } catch (error) {
      await db.doc('systemHealth/flg-commission-sync').set({
        lastRunAt: FieldValue.serverTimestamp(),
        status: 'failed',
        error: String(error.message).slice(0, 500)
      }, { merge: true });
      throw error;
    }
  }
);
