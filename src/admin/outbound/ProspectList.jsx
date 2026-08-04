// The prospect corpus.
//
// Selection exists so an operator can move a filtered set into a campaign in
// one action — the alternative, adding 200 prospects one at a time, is the
// reason lead lists get pasted into spreadsheets instead. The server still
// refuses anything that is not `ready`, so a careless "select all" cannot put
// an unreviewed record into a dialing queue.

import React, { useMemo, useState } from 'react';
import { useProspects, outbound, useAction, PROSPECT_CAP } from './data';
import { SourceBadge, StatusPill, formatWhen, formatPhone, Empty, QueryState } from './SourceBadge';

const STATUS_FILTERS = [
  ['all', 'All'], ['ready', 'Ready'], ['needs_review', 'Needs review'],
  ['queued', 'In a campaign'], ['connected', 'Connected'], ['converted', 'Converted'],
  ['not_interested', 'Not interested'], ['do_not_contact', 'Do not contact'],
  ['invalid', 'Invalid'], ['archived', 'Archived']
];

const SYSTEM_FILTERS = [
  ['all', 'All sources'], ['scraper', 'Discovery'], ['csv', 'CSV'],
  ['watcher_leads', 'Watcher'], ['bitesites_leads', 'BiteSites-Leads'], ['manual', 'Manual']
];

export default function ProspectList({ campaigns = [], onOpen }) {
  const [status, setStatus] = useState('ready');
  const [system, setSystem] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [campaignId, setCampaignId] = useState('');
  const action = useAction();

  const { rows, loading, error, capped, refresh } = useProspects({ status, system });

  // Client-side search over an already-capped page. A Firestore prefix query
  // would need an index per searchable field and still would not match on a
  // phone number typed with punctuation.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(row => [
      row.name, row.companyName, row.email, row.phoneE164, row.phone,
      row.address?.city, row.website
    ].some(value => String(value || '').toLowerCase().includes(needle)));
  }, [rows, search]);

  const toggle = id => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const selectableIds = filtered.filter(row => row.lifecycle?.status === 'ready').map(row => row.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));

  const addToCampaign = async () => {
    if (!campaignId || !selected.size) return;
    const result = await action.run(
      () => outbound.addTargets(campaignId, { prospectIds: [...selected], priority: 50 }),
      ''
    );
    if (result) {
      setSelected(new Set());
      refresh();
    }
  };

  return (
    <>
      <div className="admin-filters" style={{ marginBottom: 14 }}>
        <select className="admin-select" value={status} onChange={event => { setStatus(event.target.value); setSelected(new Set()); }}>
          {STATUS_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select
          className="admin-select"
          value={system}
          disabled={status !== 'all'}
          title={status !== 'all' ? 'Set status to All to filter by source' : ''}
          onChange={event => setSystem(event.target.value)}
        >
          {SYSTEM_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input
          className="admin-search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search name, company, phone, city…"
          aria-label="Search prospects"
        />
        <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
      </div>

      {selected.size > 0 && (
        <div className="outbound-select-bar">
          <strong>{selected.size} selected</strong>
          <select className="admin-select" value={campaignId} onChange={event => setCampaignId(event.target.value)}>
            <option value="">Choose a campaign…</option>
            {campaigns.map(campaign => (
              <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
            ))}
          </select>
          <button className="btn-admin primary" type="button" disabled={!campaignId || action.busy} onClick={addToCampaign}>
            {action.busy ? 'Adding…' : 'Add to campaign'}
          </button>
          <button className="btn-admin" type="button" onClick={() => setSelected(new Set())}>Clear</button>
          {action.error && <span className="admin-error" style={{ padding: '4px 9px' }}>{action.error}</span>}
        </div>
      )}

      <div className="admin-card">
        <QueryState loading={loading} error={error} capped={capped} cap={PROSPECT_CAP} />

        {!loading && !filtered.length ? (
          <Empty title="No prospects here">
            Run a discovery job, upload a CSV, or migrate the Watcher corpus.
          </Empty>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      aria-label="Select every ready prospect on this page"
                      onChange={() => setSelected(allSelected ? new Set() : new Set(selectableIds))}
                    />
                  </th>
                  <th>Business</th><th>Phone</th><th>Location</th>
                  <th>Status</th><th>Duplicate</th><th>Source</th><th>Added</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => {
                  const selectable = row.lifecycle?.status === 'ready';
                  return (
                    <tr key={row.id} className="clickable" onClick={() => onOpen?.(row.id)}>
                      <td onClick={event => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          disabled={!selectable}
                          title={selectable ? '' : 'Only prospects in the Ready state can join a campaign'}
                          aria-label={`Select ${row.name || row.id}`}
                          onChange={() => toggle(row.id)}
                        />
                      </td>
                      <td className="cell-strong cell-wrap">
                        {row.companyName || row.name || '(no name)'}
                        {row.website && <div className="cell-dim" style={{ fontSize: 11 }}>{row.website.replace(/^https:\/\//, '')}</div>}
                      </td>
                      <td className="cell-dim">{formatPhone(row.phoneE164)}</td>
                      <td className="cell-dim">
                        {[row.address?.city, row.address?.region].filter(Boolean).join(', ') || '—'}
                      </td>
                      <td><StatusPill status={row.lifecycle?.status} /></td>
                      <td>
                        {row.duplicate?.status && row.duplicate.status !== 'unique'
                          ? <StatusPill status={row.duplicate.status} />
                          : <span className="cell-dim">—</span>}
                      </td>
                      <td><SourceBadge source={row.source} /></td>
                      <td className="cell-dim">{formatWhen(row.createdAt)}</td>
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
