// The queue: who is next, and why they are or are not callable.
//
// "Local time" is the column that earns its width. Every other field says what
// a record is; that one says whether calling it right now is allowed, and it is
// the single most common reason a target that looks ready will not dial.

import React, { useMemo, useState } from 'react';
import { useTargets, TARGET_CAP, outbound, useAction } from './data';
import { StatusPill, formatWhen, formatPhone, localTime, Empty, QueryState } from './SourceBadge';

const STATE_GROUPS = {
  all: null,
  workable: ['ready', 'call_later', 'no_answer', 'voicemail', 'busy'],
  pending: ['pending', 'researching', 'awaiting_approval'],
  live: ['dialing', 'connected'],
  done: ['completed', 'do_not_call', 'invalid_number', 'failed', 'cancelled']
};

export default function LeadQueue({
  campaignId,
  campaigns = [],
  onSelectCampaign,
  onOpenProspect,
  canManage = true,
  initialGroup = 'workable'
}) {
  const [group, setGroup] = useState(STATE_GROUPS[initialGroup] ? initialGroup : 'workable');
  const [contactType, setContactType] = useState('all');
  const [search, setSearch] = useState('');
  const [bulk, setBulk] = useState({ action: '', processed: 0, message: '', error: '' });
  const action = useAction();

  const campaign = campaigns.find(entry => entry.id === campaignId) || null;
  const { rows, loading, error, capped, refresh } = useTargets(campaignId, {
    states: STATE_GROUPS[group], accountId: campaign?.accountId || ''
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter(row => {
      if (contactType !== 'all' && row.contactType !== contactType) return false;
      if (!needle) return true;
      return [row.phoneE164, row.id, row.leadId, row.prospectId, row.lastDisposition]
        .some(value => String(value || '').toLowerCase().includes(needle));
    });
  }, [rows, contactType, search]);

  const act = (fn, message) => action.run(fn, message).then(result => { if (result) refresh(); return result; });

  const prepareAll = async () => {
    setGroup('pending');
    setBulk({ action: 'prepare', processed: 0, message: '', error: '' });
    let processed = 0;
    let prepared = 0;
    let awaitingApproval = 0;
    let failed = 0;
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const result = await outbound.prepareCampaignResearch(campaignId);
        processed += Number(result?.processed) || 0;
        prepared += Number(result?.prepared) || 0;
        awaitingApproval += Number(result?.awaitingApproval) || 0;
        failed += Number(result?.failed) || 0;
        setBulk({
          action: 'prepare', processed,
          message: `Preparing research… ${processed} processed`, error: ''
        });
        if (!result?.hasMore) break;
      }
      setBulk({
        action: '', processed,
        message: `Research complete: ${prepared} prepared${awaitingApproval ? `, ${awaitingApproval} awaiting approval` : ''}${failed ? `, ${failed} failed` : ''}.`,
        error: ''
      });
    } catch (error) {
      setBulk({ action: '', processed, message: '', error: error?.message || 'Bulk research generation failed.' });
    }
  };

  const approveAll = async () => {
    const confirmed = window.confirm(
      `Approve every generated research brief in ${campaign?.name || 'this campaign'} without reviewing each one individually?`
    );
    if (!confirmed) return;
    setGroup('pending');
    setBulk({ action: 'approve', processed: 0, message: '', error: '' });
    let processed = 0;
    let approved = 0;
    let missingResearch = 0;
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const result = await outbound.approveCampaignResearch(campaignId);
        processed += Number(result?.processed) || 0;
        approved += Number(result?.approved) || 0;
        missingResearch += Number(result?.missingResearch) || 0;
        setBulk({
          action: 'approve', processed,
          message: `Approving research… ${approved} approved`, error: ''
        });
        if (!result?.hasMore) break;
      }
      setBulk({
        action: '', processed,
        message: `${approved} research brief${approved === 1 ? '' : 's'} approved and moved to Ready${missingResearch ? `. ${missingResearch} missing brief${missingResearch === 1 ? ' was' : 's were'} returned for generation` : ''}.`,
        error: ''
      });
    } catch (error) {
      setBulk({ action: '', processed, message: '', error: error?.message || 'Bulk research approval failed.' });
    }
  };

  if (!campaignId) {
    return (
      <div className="admin-card">
        <Empty title="Choose a campaign">
          <select
            className="admin-select"
            style={{ marginTop: 12 }}
            value=""
            onChange={event => onSelectCampaign?.(event.target.value)}
          >
            <option value="">Select a campaign…</option>
            {campaigns.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
        </Empty>
      </div>
    );
  }

  return (
    <>
      <div className="admin-filters" style={{ marginBottom: 14 }}>
        <select className="admin-select" value={campaignId} onChange={event => onSelectCampaign?.(event.target.value)}>
          {campaigns.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
        </select>
        <div className="admin-segment" role="group" aria-label="Queue filter">
          {Object.keys(STATE_GROUPS).map(key => (
            <button key={key} type="button" aria-pressed={group === key} onClick={() => setGroup(key)}>
              {key === 'all' ? 'All' : key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
        </div>
        <select className="admin-select" value={contactType} onChange={event => setContactType(event.target.value)}>
          <option value="all">Leads and prospects</option>
          <option value="prospect">Prospects only</option>
          <option value="lead">Leads only</option>
        </select>
        <input
          className="admin-search" value={search} onChange={event => setSearch(event.target.value)}
          placeholder="Search phone or id…" aria-label="Search the queue"
        />
        <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
      </div>

      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Campaign queue</h3>
            <p>Generate and approve call research for the entire campaign, including targets beyond the 500-row table limit.</p>
          </div>
          {canManage && <div className="card-head-actions">
            <button className="btn-admin" type="button" disabled={Boolean(bulk.action) || action.busy}
              onClick={prepareAll}>
              {bulk.action === 'prepare' ? `Generating… ${bulk.processed}` : 'Generate all research'}
            </button>
            <button className="btn-admin primary" type="button"
              disabled={Boolean(bulk.action) || action.busy || !campaign?.requireResearchApproval}
              title={!campaign?.requireResearchApproval ? 'This campaign does not require research approval' : ''}
              onClick={approveAll}>
              {bulk.action === 'approve' ? `Approving… ${bulk.processed}` : 'Approve all generated'}
            </button>
          </div>}
        </div>
        {bulk.error && <p className="admin-error" role="alert">{bulk.error}</p>}
        {bulk.message && <p className="admin-note" role="status" aria-live="polite">{bulk.message}</p>}
        <QueryState loading={loading} error={error} capped={capped} cap={TARGET_CAP} />
        {action.error && <p className="admin-error">{action.error}</p>}
        {action.message && <p className="admin-note">{action.message}</p>}
        {group === 'pending' && (
          <p className="admin-note" style={{ marginBottom: 12 }}>
            Prepare generates the call brief. If this campaign requires human approval, review and approve that brief before the target becomes ready to dial.
          </p>
        )}

        {!loading && !filtered.length ? (
          <Empty title="Nothing in this view">Add prospects from the Prospects tab, or widen the filter.</Empty>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Contact</th><th>Type</th><th>Phone</th><th>Local time</th>
                  <th>State</th><th>Research</th><th>Compliance</th>
                  <th className="num">Attempts</th><th>Last outcome</th><th>Next attempt</th>
                  <th>Lock</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => {
                  const locked = row.lockedBySessionId
                    && row.lockedAt?.toDate
                    && Date.now() - row.lockedAt.toDate().getTime() < 5 * 60 * 1000;
                  return (
                    <tr key={row.id}>
                      <td className="cell-strong cell-wrap">
                        {row.prospectId ? (
                          <button
                            className="admin-auth-link"
                            type="button"
                            style={{ padding: 0, textAlign: 'left' }}
                            onClick={() => onOpenProspect?.(row.prospectId)}
                          >
                            {row.prospectId.slice(0, 26)}
                          </button>
                        ) : (row.leadId || '').slice(0, 26)}
                      </td>
                      <td className="cell-dim">{row.contactType}</td>
                      <td className="cell-dim">{formatPhone(row.phoneE164)}</td>
                      <td className="cell-dim">
                        {row.timezone ? localTime(row.timezone) : <span className="outbound-stale">unknown</span>}
                      </td>
                      <td><StatusPill status={row.state} /></td>
                      <td className="cell-dim">{row.researchApproved ? 'approved' : row.researchStatus || 'none'}</td>
                      <td className="cell-dim cell-wrap">
                        {row.complianceStatus === 'blocked'
                          ? (row.complianceReasons || []).join(', ')
                          : row.complianceStatus || 'pending'}
                      </td>
                      <td className="num">{row.attemptCount || 0}/{row.maxAttempts || 3}</td>
                      <td className="cell-dim">{row.lastDisposition || '—'}</td>
                      <td className="cell-dim">{formatWhen(row.nextAttemptAt)}</td>
                      <td className="cell-dim">{locked ? 'held' : '—'}</td>
                      <td>
                        <div className="admin-filters">
                          {canManage && ['pending', 'researching'].includes(row.state) && (
                            <button className="btn-admin primary" type="button" disabled={action.busy}
                              onClick={() => act(() => outbound.prepareTarget(row.id), 'Research prepared. Review and approve the brief if required.')}>
                              Prepare
                            </button>
                          )}
                          {canManage && row.state === 'awaiting_approval' && row.prospectId && (
                            <button className="btn-admin primary" type="button" disabled={action.busy}
                              onClick={() => onOpenProspect?.(row.prospectId)}>
                              Review brief
                            </button>
                          )}
                          {!['pending', 'researching', 'awaiting_approval'].includes(row.state) && (
                            <button className="btn-admin" type="button" disabled={action.busy}
                              onClick={() => act(() => outbound.callLater(row.id, 1440, 'manual'), 'Rescheduled.')}>
                              Later
                            </button>
                          )}
                          <button className="btn-admin danger" type="button" disabled={action.busy}
                            onClick={() => act(() => outbound.doNotCall(row.id), 'Marked do not call.')}>
                            DNC
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
