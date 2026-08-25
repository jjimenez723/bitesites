// "How many of these can we actually call?" — with the reasons attached.
//
// Every other outbound screen answers a question about one record. This one
// answers the question the owner keeps asking about the whole list, and the
// answer is currently zero. That is the point: a screen that can only show a
// good number is a screen nobody believes when it shows a bad one, so the
// blockers are the primary content here and the headline count is derived
// from them.
//
// Two things are load-bearing and should survive any redesign:
//
//   * The disclaimer is not a footnote. "Eligible" means the technical gates
//     passed. Somebody will screenshot the eligible count into a meeting, and
//     that screenshot has to carry the caveat with it.
//   * Numbers arrive masked from the server and are never unmasked here. The
//     record id is what an admin investigates with.

import React, { useMemo, useState } from 'react';
import { Panel } from '../Panel';
import { outbound, useAction } from './data';
import { Empty, formatWhen } from './SourceBadge';
import './eligibility.css';

const SCOPES = [
  ['campaign_targets', 'Campaign targets', 'The records already queued for this campaign, with their real attempt counts.'],
  ['account_prospects', 'All prospects for this seller', 'Prospects that have never been added to a campaign, measured against this campaign’s policy.'],
  ['account_leads', 'All leads for this seller', 'Inbound and imported leads, measured the same way.']
];

const CLASS_ORDER = [
  ['eligible_now', 'Eligible now'],
  ['temporarily_blocked', 'Blocked for now'],
  ['evidence_missing', 'Missing evidence'],
  ['configuration_blocked', 'Blocked by configuration'],
  ['permanently_suppressed', 'Must not be called']
];

const BUCKET_LABELS = [
  ['invalid_or_missing_phone', 'Invalid or missing phone'],
  ['dnc_or_suppressed', 'CRM DND, internal DNC, or suppressed'],
  ['account_mismatch', 'Account mismatch'],
  ['ai_consent', 'Written AI consent missing, stale, revoked, or mismatched'],
  ['national_dnc', 'National DNC evidence'],
  ['entity_dnc', 'Seller DNC evidence'],
  ['reassigned_number', 'Reassigned-number check'],
  ['phone_validation_or_line_type', 'Phone validation or line type'],
  ['screening_record', 'Pre-dial screening record'],
  ['timezone_or_hours', 'Unknown timezone or outside hours'],
  ['research_or_call_plan', 'Research or call plan pending'],
  ['attempts_or_retry', 'Max attempts or retry delay'],
  ['campaign_provider_or_deployment', 'Campaign incident, provider, or deployment']
];

const download = (filename, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export default function EligibilityAudit({ campaigns = [], role = 'admin', accountIds = [] }) {
  const [campaignId, setCampaignId] = useState('');
  const [scopes, setScopes] = useState(['campaign_targets']);
  const [includeGoHighLevel, setIncludeGoHighLevel] = useState(false);
  const [limit, setLimit] = useState(500);
  const [report, setReport] = useState(null);
  const action = useAction();

  const campaign = campaigns.find(entry => entry.id === campaignId) || null;
  const canReadCrm = role === 'admin';

  const toggleScope = scope => setScopes(current => (current.includes(scope)
    ? current.filter(entry => entry !== scope)
    : [...current, scope]));

  const run = async event => {
    event.preventDefault();
    setReport(null);
    const result = await action.run(() => outbound.eligibilityAudit({
      accountId: campaign?.accountId || accountIds[0] || '',
      campaignId,
      scopes,
      includeGoHighLevel: includeGoHighLevel && canReadCrm,
      limit: Number(limit) || 500,
      includeCsv: true
    }), 'Audit complete. Nothing was dialled, imported, or approved.');
    if (result) setReport(result);
  };

  const rows = report?.rows || [];
  const blockedBuckets = useMemo(
    () => BUCKET_LABELS.filter(([id]) => Number(report?.buckets?.[id]) > 0),
    [report]
  );

  return (
    <section className="outbound-stack" aria-label="Outbound eligibility audit">
      <Panel
        title="Eligibility audit"
        subtitle="Measure a list against the gates the dialer applies, without dialling anything."
      >
        <div className="outbound-compliance-note">
          <strong>This audit places no calls.</strong> It reads records, applies the same
          consent, screening, suppression, timing and provider gates the dialer applies
          immediately before it dials, and reports the result. It never issues a consent
          grant, clears a screening, imports a target, or enrols a GoHighLevel contact.
        </div>

        <form className="outbound-form" onSubmit={run}>
          <div className="outbound-form-grid">
            <label>
              <span>Campaign policy</span>
              <select
                className="admin-select"
                required
                value={campaignId}
                onChange={event => setCampaignId(event.target.value)}
              >
                <option value="">Choose a campaign…</option>
                {campaigns.map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.accountId} · {entry.mode}
                  </option>
                ))}
              </select>
              <small>
                Every gate is campaign-relative — the calling window, the caller ID, the
                provider and the consenting seller all come from it.
              </small>
            </label>

            <label>
              <span>Records to scan</span>
              <input
                type="number"
                min={1}
                max={2000}
                value={limit}
                onChange={event => setLimit(event.target.value)}
              />
              <small>Capped at 2,000 per run. A truncated scan says so in its result.</small>
            </label>

            <fieldset className="full eligibility-scopes">
              <legend>Which records</legend>
              {SCOPES.map(([id, label, hint]) => (
                <label key={id} className="eligibility-check">
                  <input
                    type="checkbox"
                    checked={scopes.includes(id)}
                    onChange={() => toggleScope(id)}
                  />
                  <span><b>{label}</b><small>{hint}</small></span>
                </label>
              ))}
              <label className="eligibility-check">
                <input
                  type="checkbox"
                  checked={includeGoHighLevel}
                  disabled={!canReadCrm}
                  onChange={event => setIncludeGoHighLevel(event.target.checked)}
                />
                <span>
                  <b>GoHighLevel contacts (read-only)</b>
                  <small>
                    {canReadCrm
                      ? 'Reads the CRM contact book through a read-only token. It cannot create, tag, or enrol anything.'
                      : 'Reading the CRM contact book needs an owner or admin.'}
                  </small>
                </span>
              </label>
            </fieldset>
          </div>

          {action.error && <p className="admin-error">{action.error}</p>}
          {action.message && <p className="admin-note">{action.message}</p>}
          <button
            className="btn-admin primary"
            type="submit"
            disabled={action.busy || !campaignId || (!scopes.length && !includeGoHighLevel)}
          >
            {action.busy ? 'Auditing…' : 'Run audit'}
          </button>
        </form>
      </Panel>

      {report && (
        <>
          <Panel
            title="Result"
            subtitle={`${report.campaign.name} · ${report.accountId} · ${formatWhen(report.generatedAt)}`}
          >
            <p className="eligibility-disclaimer" role="note">{report.disclaimer}</p>

            <dl className="outbound-workspace-stats eligibility-totals">
              <div>
                <dt>Scanned</dt>
                <dd>{report.totals.scanned}</dd>
              </div>
              <div>
                <dt>Eligible now</dt>
                <dd className={report.totals.eligibleNow ? 'eligibility-ok' : 'eligibility-zero'}>
                  {report.totals.eligibleNow}
                </dd>
              </div>
              <div>
                <dt>Record-ready</dt>
                <dd>{report.totals.recordReady}</dd>
              </div>
            </dl>
            <p className="admin-note">
              <b>Record-ready</b> counts records whose own gates pass. When it exceeds
              <b> eligible now</b>, the difference is campaign configuration rather than
              anything about the people on the list.
              {report.totals.truncated && ' This scan hit its limit — the counts cover the first '}
              {report.totals.truncated && report.totals.scanLimit}
              {report.totals.truncated && ' records only.'}
            </p>

            <h4 className="eligibility-heading">Outcome</h4>
            <table className="admin-table">
              <thead>
                <tr><th scope="col">Outcome</th><th scope="col">Records</th></tr>
              </thead>
              <tbody>
                {CLASS_ORDER.map(([id, label]) => (
                  <tr key={id}>
                    <td>{label}</td>
                    <td>{Number(report.classes?.[id]) || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="admin-filters" style={{ marginTop: 12 }}>
              <button
                className="btn-admin"
                type="button"
                disabled={!report.csv}
                onClick={() => download(
                  `eligibility-${report.accountId}-${report.campaign.id}.csv`, report.csv
                )}
              >
                Export masked CSV
              </button>
            </div>
          </Panel>

          <Panel
            title="Campaign readiness"
            subtitle={report.campaignReadiness.ready
              ? 'Nothing about the campaign itself is blocking a call.'
              : 'These block every record in the campaign at once.'}
          >
            {report.campaignReadiness.ready
              ? <p className="admin-note">Provider, deployment, caller ID and safety lock all clear.</p>
              : (
                <ul className="eligibility-blockers">
                  {report.campaignReadiness.labels.map((label, index) => (
                    <li key={report.campaignReadiness.reasons[index]}>
                      <b>{label}</b>
                      <code>{report.campaignReadiness.reasons[index]}</code>
                    </li>
                  ))}
                </ul>
              )}
            <p className="admin-note">
              Deployment: {report.campaignReadiness.deployment.environment}
              {report.campaignReadiness.deployment.allowed
                ? ' · external dialing enabled'
                : ` · external dialing disabled (${report.campaignReadiness.deployment.reason})`}
            </p>
          </Panel>

          <Panel title="Why records are blocked" subtitle="One record can appear in more than one row.">
            {!blockedBuckets.length && <p className="admin-note">No blockers were recorded.</p>}
            {blockedBuckets.length > 0 && (
              <table className="admin-table">
                <thead>
                  <tr><th scope="col">Blocker</th><th scope="col">Records</th></tr>
                </thead>
                <tbody>
                  {blockedBuckets.map(([id, label]) => (
                    <tr key={id}>
                      <td>{label}</td>
                      <td>{report.buckets[id]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title={`Records (${rows.length}${report.rowsTruncated ? ' shown' : ''})`}
            subtitle="Numbers are masked. Use the record ID to investigate one."
          >
            {!rows.length && <Empty title="Nothing matched this scope."><p>Widen the scope or choose another campaign.</p></Empty>}
            {rows.length > 0 && (
              <div className="admin-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th scope="col">Record</th>
                      <th scope="col">Number</th>
                      <th scope="col">Local time</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Blockers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={`${row.recordType}:${row.id}:${row.targetId}`}>
                        <td>
                          <span className="cell-strong">{row.name || '—'}</span>
                          <span className="cell-dim"> {row.recordType} · {row.id}</span>
                        </td>
                        <td>{row.phoneMasked || '—'}</td>
                        <td>{row.localTime || '—'}</td>
                        <td><span className={`pill ${row.classification}`}>
                          {CLASS_ORDER.find(([id]) => id === row.classification)?.[1] || row.classification}
                        </span></td>
                        <td className="cell-wrap">
                          {row.labels.length ? row.labels.join('; ') : 'None'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </section>
  );
}
