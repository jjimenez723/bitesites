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

export default function LeadQueue({ campaignId, campaigns = [], onSelectCampaign, onOpenProspect }) {
  const [group, setGroup] = useState('workable');
  const [contactType, setContactType] = useState('all');
  const [search, setSearch] = useState('');
  const action = useAction();

  const { rows, loading, error, capped, refresh } = useTargets(campaignId, { states: STATE_GROUPS[group] });

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
        <QueryState loading={loading} error={error} capped={capped} cap={TARGET_CAP} />
        {action.error && <p className="admin-error">{action.error}</p>}

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
                          <button className="btn-admin" type="button" disabled={action.busy}
                            onClick={() => act(() => outbound.callLater(row.id, 1440, 'manual'), 'Rescheduled.')}>
                            Later
                          </button>
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
