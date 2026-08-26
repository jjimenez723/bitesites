// Fine Line Group CRM — the HighLevel pipelines, read-only.
//
// Everything on this page comes from one admin-only callable that proxies
// HighLevel server-side; the browser never holds a HighLevel credential and
// nothing here can write back. Triage still happens in HighLevel itself —
// this is the commission client's book of business at a glance: where every
// deal sits, what is stalling, and what commission is owed to BiteSites.

import React, { useEffect, useMemo, useState } from 'react';
import { fetchFineLineCrm } from './crm-api';
import { StatTile } from './charts';
import { Panel, DetailRows, Pill } from './Panel';
import {
  agingBuckets, commissionRows, filterOpportunities, forPipeline,
  money, pipelineSummary, sortOpportunities, stageBreakdown
} from './crm-calculations';
import { activateRow } from './row-activate';

const STATUS_FILTERS = [
  ['all', 'All statuses'],
  ['open', 'Open'],
  ['won', 'Won'],
  ['lost', 'Lost'],
  ['commission_due', 'Commission due']
];

const when = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—'
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const days = value => Number.isFinite(value) ? `${value}d` : '—';

function StageFunnel({ pipeline, opportunities }) {
  const rows = stageBreakdown(pipeline, opportunities);
  const max = Math.max(...rows.map(row => row.count), 1);
  return (
    <div className="crm-funnel">
      {rows.map(row => (
        <div key={row.id} className="crm-funnel-row">
          <span className="crm-funnel-name">{row.name}</span>
          <span className="crm-funnel-track">
            <span className="crm-funnel-bar" style={{ width: `${(row.count / max) * 100}%` }} />
          </span>
          <span className="crm-funnel-count">{row.count}{row.value ? ` · ${money(row.value)}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function OpportunityTable({ rows, kind, openId, onOpen }) {
  if (!rows.length) {
    return (
      <div className="admin-empty">
        <strong>Nothing matches that filter</strong>
        Try a different status or stage, or clear the search.
      </div>
    );
  }
  return (
    <div className="admin-table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Opportunity</th>
            <th>Stage</th>
            <th>Status</th>
            {kind === 'referral'
              ? <><th>Business</th><th>Referrals</th></>
              : <><th>Services</th><th>Value</th></>}
            <th>Commission</th>
            <th>In stage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} className={`clickable ${openId === row.id ? 'selected' : ''}`} {...activateRow(() => onOpen(row.id))}>
              <td>
                <div className="cell-strong">{row.contactName || row.name}</div>
                <div className="cell-dim">{row.name}</div>
              </td>
              <td className="cell-dim cell-wrap">{row.stageName || '—'}</td>
              <td><Pill kind={row.status}>{row.status}</Pill></td>
              {kind === 'referral' ? (
                <>
                  <td className="cell-dim cell-wrap">{row.referralPartnerBusiness || '—'}</td>
                  <td className="cell-dim">{row.referralCount || '—'}</td>
                </>
              ) : (
                <>
                  <td className="cell-dim cell-wrap">{(row.services || []).join(', ') || '—'}</td>
                  <td className="cell-dim">{row.contractAmount || row.estimateAmount || row.value
                    ? money(row.contractAmount || row.estimateAmount || row.value) : '—'}</td>
                </>
              )}
              <td className="cell-dim">
                {row.commissionOutstanding > 0
                  ? <span className="chip warning">{money(row.commissionOutstanding)} due</span>
                  : row.commissionDueTag ? <span className="chip warning">due</span>
                  : row.commissionPaid > 0 ? 'Paid' : '—'}
              </td>
              <td className="cell-dim">{days(row.daysInStage)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpportunityPanel({ opportunity, onClose }) {
  return (
    <Panel
      title={opportunity.contactName || opportunity.name}
      subtitle={`${opportunity.stageName || 'No stage'} · ${when(opportunity.createdAt)}`}
      onClose={onClose}
    >
      <div>
        <div className="panel-section-label">Deal</div>
        <DetailRows
          rows={[
            ['Opportunity', opportunity.name],
            ['Status', opportunity.status],
            ['Stage', opportunity.stageName],
            ['Services', (opportunity.services || []).join(', ')],
            ['Estimate', opportunity.estimateAmount ? money(opportunity.estimateAmount) : ''],
            ['Contract', opportunity.contractAmount ? money(opportunity.contractAmount) : ''],
            ['Collected', opportunity.collectedRevenue ? money(opportunity.collectedRevenue) : ''],
            ['Created', when(opportunity.createdAt)],
            ['Last stage move', when(opportunity.lastStageChangeAt)],
            ['Age', days(opportunity.ageDays)],
            ['Time in stage', days(opportunity.daysInStage)],
            ['Loss reason', opportunity.lossReason]
          ]}
        />
      </div>

      {(opportunity.commissionExpected > 0 || opportunity.commissionDueTag) && (
        <div>
          <div className="panel-section-label">BiteSites commission</div>
          <DetailRows
            rows={[
              ['Rate', opportunity.commissionRate ? `${opportunity.commissionRate}%` : ''],
              ['Expected', opportunity.commissionExpected ? money(opportunity.commissionExpected) : ''],
              ['Paid', opportunity.commissionPaid ? money(opportunity.commissionPaid) : ''],
              ['Outstanding', opportunity.commissionOutstanding ? money(opportunity.commissionOutstanding) : '$0']
            ]}
          />
        </div>
      )}

      {(opportunity.referralPartnerBusiness || opportunity.referralCount > 0) && (
        <div>
          <div className="panel-section-label">Referral partner</div>
          <DetailRows
            rows={[
              ['Business', opportunity.referralPartnerBusiness],
              ['Contact', opportunity.referralPartnerContact],
              ['Type', opportunity.referralPartnerType],
              ['Referrals', opportunity.referralCount ? String(opportunity.referralCount) : ''],
              ['First referral', opportunity.firstReferralDate ? when(opportunity.firstReferralDate) : ''],
              ['Last referral', opportunity.lastReferralDate ? when(opportunity.lastReferralDate) : '']
            ]}
          />
        </div>
      )}

      {opportunity.tags.length > 0 && (
        <div>
          <div className="panel-section-label">Workflow tags</div>
          <div className="chip-row" style={{ marginTop: 10 }}>
            {opportunity.tags.map(tag => <span className="chip" key={tag}>{tag}</span>)}
          </div>
        </div>
      )}

      <p className="admin-note">
        Read-only. Stage moves, notes and contact details live in HighLevel — this view
        cannot change them.
      </p>
    </Panel>
  );
}

export default function Crm() {
  const [state, setState] = useState({ snapshot: null, loading: true, error: '' });
  const [tab, setTab] = useState('client');
  const [status, setStatus] = useState('all');
  const [stageId, setStageId] = useState('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = async ({ refresh = false } = {}) => {
    setState(current => ({ ...current, loading: true, error: '' }));
    try {
      const { snapshot } = await fetchFineLineCrm({ refresh });
      setState({ snapshot, loading: false, error: '' });
    } catch (error) {
      setState(current => ({
        ...current,
        loading: false,
        error: error?.message || 'The CRM snapshot could not be loaded.'
      }));
    }
  };

  useEffect(() => { load(); }, []);

  const snapshot = state.snapshot;
  const pipeline = useMemo(
    () => snapshot?.pipelines.find(entry => entry.kind === tab) || null,
    [snapshot, tab]
  );
  const pipelineOpps = useMemo(
    () => pipeline ? forPipeline(snapshot.opportunities, pipeline.id) : [],
    [snapshot, pipeline]
  );
  const summary = useMemo(() => pipelineSummary(pipelineOpps), [pipelineOpps]);
  const aging = useMemo(() => agingBuckets(pipelineOpps), [pipelineOpps]);
  const commissions = useMemo(
    () => commissionRows(snapshot?.opportunities || []),
    [snapshot]
  );
  const visible = useMemo(
    () => sortOpportunities(filterOpportunities(pipelineOpps, { status, stageId, search })),
    [pipelineOpps, status, stageId, search]
  );
  const open = snapshot?.opportunities.find(entry => entry.id === openId) || null;

  const switchTab = next => {
    setTab(next);
    setStageId('all');
    setOpenId(null);
  };

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Fine Line CRM</h1>
          <p className="admin-topbar-sub">
            {snapshot
              ? `HighLevel pipelines · fetched ${when(snapshot.fetchedAt)}`
              : 'HighLevel pipelines, read-only'}
          </p>
        </div>
        <div className="admin-topbar-spacer" />
        <div className="admin-filters">
          <div className="admin-segment" role="group" aria-label="Pipeline">
            <button type="button" className={tab === 'client' ? 'active' : ''} onClick={() => switchTab('client')}>
              Client acquisition
            </button>
            <button type="button" className={tab === 'referral' ? 'active' : ''} onClick={() => switchTab('referral')}>
              Referral partners
            </button>
          </div>
          <input
            className="admin-search"
            type="search"
            placeholder="Search name, company, service…"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <select className="admin-select" value={status} onChange={event => setStatus(event.target.value)} aria-label="Status">
            {STATUS_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className="admin-select" value={stageId} onChange={event => setStageId(event.target.value)} aria-label="Stage">
            <option value="all">All stages</option>
            {(pipeline?.stages || []).map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
          </select>
          <button className="btn-admin" type="button" onClick={() => load({ refresh: true })} disabled={state.loading}>
            Refresh
          </button>
        </div>
      </header>

      <div className={`admin-body ${state.loading ? 'is-refreshing' : ''}`}>
        {state.error && <p className="admin-error">{state.error}</p>}

        {state.loading && !snapshot ? (
          <div className="admin-card"><div className="admin-empty"><strong>Loading the CRM…</strong>Reading the HighLevel pipelines.</div></div>
        ) : !snapshot ? (
          !state.error && <div className="admin-card"><div className="admin-empty"><strong>No CRM data</strong>The snapshot came back empty.</div></div>
        ) : (
          <>
            <div className="admin-grid cols-4">
              <StatTile
                label={tab === 'referral' ? 'Partners in pipeline' : 'Open opportunities'}
                value={summary.open}
                foot={`${summary.total} total · ${summary.won} won · ${summary.lost} lost`}
              />
              <StatTile
                label={tab === 'referral' ? 'Referrals received' : 'Open pipeline value'}
                value={tab === 'referral' ? summary.referralCount : money(summary.openValue)}
                foot={tab === 'referral' ? 'across all partners' : 'contract or estimate amounts'}
              />
              <StatTile
                label="Collected revenue"
                value={money(summary.collectedRevenue)}
                foot={`${money(summary.wonValue)} won value`}
              />
              <StatTile
                label="Commission due"
                value={money(summary.commissionOutstanding)}
                foot={`${summary.commissionDueCount} ${summary.commissionDueCount === 1 ? 'deal' : 'deals'} · ${money(summary.commissionPaid)} paid`}
              />
            </div>

            <div className="admin-grid cols-2">
              <div className="admin-card">
                <div className="card-head">
                  <div>
                    <h3>{pipeline?.name || 'Pipeline'}</h3>
                    <p>Open and won deals by stage.</p>
                  </div>
                </div>
                <StageFunnel pipeline={pipeline} opportunities={pipelineOpps} />
              </div>

              <div className="admin-card">
                <div className="card-head">
                  <div>
                    <h3>Stage aging</h3>
                    <p>How long open deals have sat in their current stage.</p>
                  </div>
                </div>
                <div className="chip-row" style={{ marginTop: 4 }}>
                  {aging.map(bucket => (
                    <span key={bucket.key} className={`chip ${bucket.key === 'cold' && bucket.count ? 'warning' : ''}`}>
                      <b>{bucket.label}</b> {bucket.count}
                    </span>
                  ))}
                </div>
                {commissions.length > 0 && (
                  <>
                    <div className="panel-section-label" style={{ marginTop: 18 }}>Commission due to BiteSites</div>
                    <div className="lead-activity" style={{ marginTop: 8 }}>
                      {commissions.map(row => (
                        <div key={row.id}>
                          <span>{row.contactName || row.name}</span>
                          <time>{row.commissionOutstanding > 0 ? money(row.commissionOutstanding) : 'tagged due'}</time>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="admin-card">
              <OpportunityTable rows={visible} kind={tab} openId={openId} onOpen={setOpenId} />
            </div>
          </>
        )}
      </div>

      {open && <OpportunityPanel opportunity={open} onClose={() => setOpenId(null)} />}
    </>
  );
}
