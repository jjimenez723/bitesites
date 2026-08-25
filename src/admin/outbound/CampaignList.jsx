// Campaigns: the list, the lifecycle buttons, and the emergency stop.
//
// Pause is styled as a first-class action rather than hidden behind a menu.
// It is the kill switch: the server re-reads campaign status on every dial, so
// pausing stops new calls within one poll, and it is the control an operator
// will want to find in a hurry.

import React, { useState } from 'react';
import { outbound, useAction, useOutboundCalls } from './data';
import { StatusPill, formatWhen, providerLabel, Empty, QueryState } from './SourceBadge';
import CampaignBuilder from './CampaignBuilder';
import CampaignIncidents from './CampaignIncidents';
import CampaignMetrics from './CampaignMetrics';

const MODE_LABELS = { ai: 'AI', power: 'Power', parallel: 'Parallel' };

export default function CampaignList({ campaigns, loading, error, refresh, providers, selectedId, onSelect }) {
  const [editing, setEditing] = useState(null);   // null | 'new' | campaign object
  const action = useAction();
  const selected = campaigns.find(campaign => campaign.id === selectedId) || null;
  const { rows: calls } = useOutboundCalls(selectedId || 'all', selected?.accountId || '');

  const act = (fn, message) => action.run(fn, message).then(result => { if (result) refresh(); return result; });

  if (editing) {
    return (
      <CampaignBuilder
        providers={providers}
        campaign={editing === 'new' ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={id => { setEditing(null); refresh(); if (id) onSelect?.(id); }}
      />
    );
  }

  return (
    <div className="admin-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Campaigns</h3>
            <p>Select one to see its queue, live dialer, and outcomes. Arming a campaign never places a call; the dialer still requires an approved plan and a separate preflight.</p>
          </div>
          <div className="card-head-actions">
            <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
            <button className="btn-admin primary" type="button" onClick={() => setEditing('new')}>New campaign</button>
          </div>
        </div>

        <QueryState loading={loading} error={error} />
        {action.error && <p className="admin-error">{action.error}</p>}

        {!loading && !campaigns.length ? (
          <Empty title="No campaigns yet">
            Create one, add prospects to it, then rehearse the whole flow on the mock provider before touching a real one.
          </Empty>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th><th>Mode</th><th>Provider</th><th>Status</th>
                  <th className="num">Targets</th><th className="num">Ready</th><th className="num">Done</th>
                  <th>Created</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(campaign => (
                  <tr
                    key={campaign.id}
                    className={`clickable ${selectedId === campaign.id ? 'selected' : ''}`}
                    onClick={() => onSelect?.(campaign.id)}
                  >
                    <td className="cell-strong cell-wrap">{campaign.name}</td>
                    <td className="cell-dim">
                      {MODE_LABELS[campaign.mode] || campaign.mode}
                      {campaign.mode === 'parallel' ? ` ×${campaign.concurrency}` : ''}
                    </td>
                    <td className="cell-dim">{providerLabel(campaign.provider)}</td>
                    <td><StatusPill status={campaign.status} /></td>
                    <td className="num">{campaign.counts?.total ?? 0}</td>
                    <td className="num">{campaign.counts?.ready ?? 0}</td>
                    <td className="num">{campaign.counts?.completed ?? 0}</td>
                    <td className="cell-dim">{formatWhen(campaign.createdAt)}</td>
                    <td onClick={event => event.stopPropagation()}>
                      <div className="admin-filters">
{/* The server refuses a resume while the breaker holds an incident, so the
                            button says why instead of offering an action that will fail. */}
                        {['draft', 'ready', 'paused'].includes(campaign.status) && (
                          campaign.safetyLock?.engaged ? (
                            <button className="btn-admin" type="button" disabled
                              title="Resolve the open safety incident first — select the campaign to see it.">
                              Halted
                            </button>
                          ) : (
                            <button className="btn-admin" type="button" disabled={action.busy}
                              onClick={() => act(() => campaign.status === 'paused'
                                ? outbound.resumeCampaign(campaign.id)
                                : outbound.startCampaign(campaign.id), 'Campaign armed.')}>
                              {campaign.status === 'paused' ? 'Resume' : 'Arm campaign'}
                            </button>
                          )
                        )}
                        {campaign.status === 'running' && (
                          <button className="btn-admin danger" type="button" disabled={action.busy}
                            onClick={() => act(() => outbound.pauseCampaign(campaign.id), 'Paused.')}>
                            Pause
                          </button>
                        )}
                        <button className="btn-admin" type="button" onClick={() => setEditing(campaign)}>Edit</button>
                        <button className="btn-admin" type="button" disabled={action.busy}
                          onClick={() => setEditing({ ...campaign, id: undefined, name: `${campaign.name} (copy)` })}>
                          Duplicate
                        </button>
                        {!['cancelled', 'completed'].includes(campaign.status) && (
                          <button className="btn-admin danger" type="button" disabled={action.busy}
                            onClick={() => act(() => outbound.cancelCampaign(campaign.id), 'Cancelled.')}>
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Above the metrics on purpose: a halted campaign is the first thing an
          operator needs to see, not something below a fold of numbers. */}
      {selected && (
        <CampaignIncidents campaignId={selected.id} campaign={selected} onResolved={refresh} />
      )}

      {selected && <CampaignMetrics campaign={selected} calls={calls} />}
    </div>
  );
}
