// Outbound call history.
//
// Reads the same `calls` collection the inbound voice AI calls live in — there is
// deliberately no second call-history system. Transcripts stay in
// `calls/{id}/turns`, so the existing Transcript component renders them without
// modification.

import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useOutboundCalls, useLiveDoc, LIST_CAP } from './data';
import { Panel, DetailRows } from '../Panel';
import Transcript from '../Transcript';
import { StatusPill, formatWhen, formatDuration, providerLabel, Empty, QueryState } from './SourceBadge';
import { receivingAgent, receivingAgentLabel } from '../voice-attribution';
import { ACCOUNTS } from '../../../functions/accounts.js';

const MODE_LABELS = {
  human: 'Human only', hybrid: 'Hybrid', ai: 'AI only',
  parallel: 'Parallel dial', power: 'Power dial'
};

/**
 * Who actually spoke on this call.
 *
 * `operator` is stamped when the leg is placed, before anybody answers, so it
 * cannot be trusted on its own — every Hybrid V2 leg used to be written as
 * "human" regardless of who took it. `control.controller` is the routed owner
 * and the sticky `humanHandled`/`aiHandled` flags survive a takeover, so a call
 * an AI opened and a rep finished reads as both.
 */
function operatorLabel(call) {
  if (!call) return '—';
  const controller = call.control?.controller;
  const human = call.humanHandled === true || controller === 'human' || controller === 'transitioning';
  const ai = call.aiHandled === true || controller === 'ai' || Boolean(call.aiStartedAt);
  if (human && ai) return 'AI → human takeover';
  if (human) return 'Human rep';
  if (ai) return 'AI agent';
  if (controller === 'none') return 'Ended unattended';
  if (controller === 'unassigned' || !controller) {
    // Legacy rows: pre-Hybrid V2 legs really were rep-driven.
    if (call.hybridV2 !== true && call.operator === 'human') return 'Human rep';
    if (call.operator === 'ai') return 'AI agent';
    if (call.answeredBy === 'machine') return 'Voicemail';
    // A verified human answer with no controller means routing never landed —
    // worth showing as its own state rather than hiding it in "never connected".
    return call.answeredBy === 'human' ? 'Answered, unrouted' : 'Never connected';
  }
  return call.operator || '—';
}

export default function CallHistory({ campaignId, campaigns = [], onSelectCampaign }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [openId, setOpenId] = useState(() => searchParams.get('call'));
  const { rows, loading, error, capped, refresh } = useOutboundCalls(campaignId || 'all');
  const directCall = useLiveDoc(openId ? `calls/${openId}` : '');
  const open = rows.find(row => row.id === openId) || directCall.data || null;
  const openCall = id => {
    setOpenId(id);
    const updated = new URLSearchParams(searchParams);
    updated.set('call', id);
    setSearchParams(updated, { replace: true });
  };
  const closeCall = () => {
    setOpenId(null);
    const updated = new URLSearchParams(searchParams);
    updated.delete('call');
    setSearchParams(updated, { replace: true });
  };

  return (
    <>
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Outbound call history</h3>
            <p>Stored in the same collection as inbound voice AI calls, with a direction of “outbound”.</p>
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
                  <th>Started</th><th>Contact</th><th>Agent</th><th>Operator</th><th>Mode</th>
                  <th>Provider</th><th>Status</th><th>Disposition</th>
                  <th className="num">Duration</th><th className="num">Attempt</th><th>Recording</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className={`clickable ${openId === row.id ? 'selected' : ''}`} onClick={() => openCall(row.id)}>
                    <td className="cell-strong">{formatWhen(row.startedAt)}</td>
                    <td className="cell-dim cell-wrap">{(row.prospectId || row.leadId || row.targetId || '').slice(0, 24)}</td>
                    <td className="cell-dim cell-wrap">{receivingAgentLabel(row)}</td>
                    <td className="cell-dim">{operatorLabel(row)}</td>
                    <td className="cell-dim">{MODE_LABELS[row.dialerMode] || row.dialerMode || '—'}</td>
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
          onClose={closeCall}
        >
          <DetailRows
            rows={[
              ['Status', <StatusPill status={open.status} />],
              ['Disposition', open.disposition],
              ['Agent', receivingAgent(open).agentName],
              ['Client', receivingAgent(open).clientName],
              ['Operator', operatorLabel(open)],
              ['Session mode', MODE_LABELS[open.dialerMode] || open.dialerMode],
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
              ['Partner conversations', (open.partnerOutcomes || [])
                .map(row => `${ACCOUNTS[row.accountId]?.label || row.accountId}: ${(row.outcome || '').replace(/_/g, ' ')}${row.notes ? ` — ${row.notes}` : ''}`)
                .join('\n')],
              ['Recording', open.recordingUrl
                ? <a href={open.recordingUrl} target="_blank" rel="noreferrer noopener">Open recording</a>
                : '']
            ]}
          />

          {open.transcriptRecorded && (
            <div style={{ marginTop: 16 }}>
              <div className="panel-section-label">Transcript</div>
              <div style={{ marginTop: 12 }}>
                <Transcript collection="calls" sub="turns" agent={receivingAgent(open).agentName} id={open.id} />
              </div>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
