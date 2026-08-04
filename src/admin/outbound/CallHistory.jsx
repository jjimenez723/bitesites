// Outbound call history.
//
// Reads the same `calls` collection the inbound Byte calls live in — there is
// deliberately no second call-history system. Transcripts stay in
// `calls/{id}/turns`, so the existing Transcript component renders them without
// modification.

import React, { useState } from 'react';
import { useOutboundCalls, LIST_CAP } from './data';
import { Panel, DetailRows } from '../Panel';
import Transcript from '../Transcript';
import { StatusPill, formatWhen, formatDuration, providerLabel, Empty, QueryState } from './SourceBadge';

export default function CallHistory({ campaignId, campaigns = [], onSelectCampaign }) {
  const [openId, setOpenId] = useState(null);
  const { rows, loading, error, capped, refresh } = useOutboundCalls(campaignId || 'all');
  const open = rows.find(row => row.id === openId) || null;

  return (
    <>
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Outbound call history</h3>
            <p>Stored in the same collection as inbound Byte calls, with a direction of “outbound”.</p>
          </div>
          <div className="card-head-actions">
            <select className="admin-select" value={campaignId || 'all'} onChange={event => onSelectCampaign?.(event.target.value === 'all' ? '' : event.target.value)}>
              <option value="all">Every campaign</option>
              {campaigns.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
            <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
          </div>
        </div>

        <QueryState loading={loading} error={error} capped={capped} cap={LIST_CAP} />

        {!loading && !rows.length ? (
          <Empty title="No outbound calls yet">They appear here as soon as a session or an AI campaign dials.</Empty>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Started</th><th>Contact</th><th>Operator</th><th>Mode</th>
                  <th>Provider</th><th>Status</th><th>Disposition</th>
                  <th className="num">Duration</th><th className="num">Attempt</th><th>Recording</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className={`clickable ${openId === row.id ? 'selected' : ''}`} onClick={() => setOpenId(row.id)}>
                    <td className="cell-strong">{formatWhen(row.startedAt)}</td>
                    <td className="cell-dim cell-wrap">{(row.prospectId || row.leadId || row.targetId || '').slice(0, 24)}</td>
                    <td className="cell-dim">{row.operator || '—'}</td>
                    <td className="cell-dim">{row.dialerMode || '—'}</td>
                    <td className="cell-dim">{providerLabel(row.provider)}</td>
                    <td><StatusPill status={row.status} /></td>
                    <td className="cell-dim">{row.disposition || '—'}</td>
                    <td className="num">{formatDuration(row.durationSec)}</td>
                    <td className="num">{row.attemptNumber || 1}</td>
                    <td className="cell-dim" onClick={event => event.stopPropagation()}>
                      {row.recordingUrl
                        ? <a href={row.recordingUrl} target="_blank" rel="noreferrer noopener">Listen</a>
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <Panel
          title={`Outbound call · ${formatWhen(open.startedAt)}`}
          subtitle={open.prospectId || open.leadId || open.targetId || ''}
          onClose={() => setOpenId(null)}
        >
          <DetailRows
            rows={[
              ['Status', <StatusPill status={open.status} />],
              ['Disposition', open.disposition],
              ['Operator', open.operator],
              ['Dialer mode', open.dialerMode],
              ['Provider', providerLabel(open.provider)],
              ['Provider call id', open.providerCallId],
              ['Campaign', open.campaignId],
              ['Target', open.targetId],
              ['Prospect', open.prospectId],
              ['Lead', open.leadId],
              ['Session', open.sessionId],
              ['Attempt', open.attemptNumber],
              ['Ringing at', open.ringingAt ? formatWhen(open.ringingAt) : ''],
              ['Answered at', open.answeredAt ? formatWhen(open.answeredAt) : ''],
              ['Connected at', open.connectedAt ? formatWhen(open.connectedAt) : ''],
              ['Ended at', open.endedAt ? formatWhen(open.endedAt) : ''],
              ['Duration', formatDuration(open.durationSec)],
              ['Cancelled because', open.cancellationReason?.replace(/_/g, ' ')],
              ['Notes', open.summary],
              ['Recording', open.recordingUrl
                ? <a href={open.recordingUrl} target="_blank" rel="noreferrer noopener">Open recording</a>
                : '']
            ]}
          />

          {open.transcriptRecorded && (
            <div style={{ marginTop: 16 }}>
              <div className="panel-section-label">Transcript</div>
              <div style={{ marginTop: 12 }}>
                <Transcript collection="calls" sub="turns" agent="Byte" id={open.id} />
              </div>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
