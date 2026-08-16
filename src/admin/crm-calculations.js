// Pure calculations behind /admin/crm — everything the Fine Line CRM page
// derives from the sanitized HighLevel snapshot. No Firebase, no fetch, no
// DOM: `npm run test:crm` exercises this file directly under node:test.

export const money = value => Number.isFinite(Number(value))
  ? Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  : '—';

export const forPipeline = (opportunities, pipelineId) =>
  (opportunities || []).filter(opportunity => opportunity.pipelineId === pipelineId);

/** Everything the summary cards need for one pipeline. */
export function pipelineSummary(opportunities) {
  const summary = {
    total: 0, open: 0, won: 0, lost: 0, abandoned: 0,
    openValue: 0,          // best available amount on still-open work
    wonValue: 0,           // best available amount on won work
    collectedRevenue: 0,
    commissionExpected: 0,
    commissionPaid: 0,
    commissionOutstanding: 0,
    commissionDueCount: 0,
    referralCount: 0
  };
  for (const opportunity of opportunities || []) {
    summary.total += 1;
    summary[opportunity.status] = (summary[opportunity.status] || 0) + 1;
    // The naming/stage workflows leave monetaryValue at 0 and record amounts
    // in the FLG custom fields, so prefer those, in confidence order.
    const amount = opportunity.contractAmount || opportunity.estimateAmount || opportunity.value || 0;
    if (opportunity.status === 'open') summary.openValue += amount;
    if (opportunity.status === 'won') summary.wonValue += amount;
    summary.collectedRevenue += opportunity.collectedRevenue || 0;
    summary.commissionExpected += opportunity.commissionExpected || 0;
    summary.commissionPaid += opportunity.commissionPaid || 0;
    summary.commissionOutstanding += opportunity.commissionOutstanding || 0;
    if (opportunity.commissionDueTag || (opportunity.commissionOutstanding || 0) > 0) summary.commissionDueCount += 1;
    summary.referralCount += opportunity.referralCount || 0;
  }
  const round = value => Math.round(value * 100) / 100;
  for (const key of ['openValue', 'wonValue', 'collectedRevenue', 'commissionExpected', 'commissionPaid', 'commissionOutstanding']) {
    summary[key] = round(summary[key]);
  }
  return summary;
}

/** Ordered per-stage rows for the funnel table. Lost/abandoned excluded. */
export function stageBreakdown(pipeline, opportunities) {
  const byStage = new Map();
  for (const opportunity of opportunities || []) {
    if (opportunity.status === 'lost' || opportunity.status === 'abandoned') continue;
    const row = byStage.get(opportunity.stageId) || { count: 0, value: 0 };
    row.count += 1;
    row.value += opportunity.contractAmount || opportunity.estimateAmount || opportunity.value || 0;
    byStage.set(opportunity.stageId, row);
  }
  return (pipeline?.stages || []).map(stage => ({
    id: stage.id,
    name: stage.name,
    position: stage.position,
    count: byStage.get(stage.id)?.count || 0,
    value: Math.round((byStage.get(stage.id)?.value || 0) * 100) / 100
  }));
}

/** Status, stage and free-text filters, mirroring the Leads screen. */
export function filterOpportunities(opportunities, { status = 'all', stageId = 'all', search = '' } = {}) {
  const term = search.trim().toLowerCase();
  return (opportunities || []).filter(opportunity => {
    if (status === 'commission_due') {
      if (!opportunity.commissionDueTag && !(opportunity.commissionOutstanding > 0)) return false;
    } else if (status !== 'all' && opportunity.status !== status) return false;
    if (stageId !== 'all' && opportunity.stageId !== stageId) return false;
    if (!term) return true;
    return [
      opportunity.name, opportunity.contactName, opportunity.companyName,
      opportunity.referralPartnerBusiness, opportunity.referralPartnerContact,
      opportunity.stageName, ...(opportunity.services || []), ...(opportunity.tags || [])
    ].filter(Boolean).some(value => String(value).toLowerCase().includes(term));
  });
}

// Buckets chosen for a home-services sales cycle: within a week is healthy,
// two weeks needs a nudge, a month is stalling, beyond that it is going cold.
export const AGING_BUCKETS = [
  { key: 'fresh', label: '≤ 7 days', max: 7 },
  { key: 'watch', label: '8–14 days', max: 14 },
  { key: 'stale', label: '15–30 days', max: 30 },
  { key: 'cold', label: '31+ days', max: Infinity }
];

/** Open opportunities grouped by how long they have sat in their stage. */
export function agingBuckets(opportunities) {
  const buckets = AGING_BUCKETS.map(bucket => ({ ...bucket, count: 0 }));
  for (const opportunity of opportunities || []) {
    if (opportunity.status !== 'open') continue;
    const days = Number.isFinite(opportunity.daysInStage) ? opportunity.daysInStage : 0;
    buckets.find(bucket => days <= bucket.max).count += 1;
  }
  return buckets;
}

/** The rows for the commission-due panel, most money outstanding first. */
export function commissionRows(opportunities) {
  return (opportunities || [])
    .filter(opportunity => opportunity.commissionDueTag || opportunity.commissionOutstanding > 0)
    .sort((a, b) => (b.commissionOutstanding || 0) - (a.commissionOutstanding || 0));
}

/** Default sort for the tables: still-open first, then most recently moved. */
export function sortOpportunities(opportunities) {
  const rank = { open: 0, won: 1, lost: 2, abandoned: 3 };
  return [...(opportunities || [])].sort((a, b) => {
    const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (byStatus) return byStatus;
    return Date.parse(b.lastStageChangeAt || b.createdAt || 0) - Date.parse(a.lastStageChangeAt || a.createdAt || 0);
  });
}
