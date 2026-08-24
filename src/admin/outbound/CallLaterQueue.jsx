// Everyone waiting for another attempt, and why.
//
// `requeueReason` matters more than it looks. "another_call_connected" means a
// parallel leg was cancelled through no fault of the prospect — their phone
// rang and nobody spoke to them — and those targets have their attempt rolled
// back. Showing the reason is what makes that behaviour visible rather than a
// mysterious attempt count that sometimes goes down.

import React from 'react';
import { useTargets, outbound, useAction, TARGET_CAP } from './data';
import { StatusPill, formatWhen, formatPhone, localTime, Empty, QueryState } from './SourceBadge';

const REASON_LABELS = {
  another_call_connected: 'A parallel leg won — this one was cancelled',
  call_later: 'Asked to be called back',
  no_answer: 'No answer',
  voicemail: 'Reached voicemail',
  busy: 'Line was busy',
  cancelled: 'Cancelled',
  manual: 'Rescheduled by hand',
  requested: 'Rescheduled by hand'
};

export default function CallLaterQueue({ campaignId, campaigns = [], onSelectCampaign }) {
  const campaign = campaigns.find(entry => entry.id === campaignId) || null;
  const { rows, loading, error, capped, refresh } = useTargets(campaignId, {
    states: ['call_later', 'no_answer', 'voicemail', 'busy'], accountId: campaign?.accountId || ''
  });
  const action = useAction();

  const act = (fn, message) => action.run(fn, message).then(result => { if (result) refresh(); return result; });

  if (!campaignId) {
    return (
      <div className="admin-card">
        <Empty title="Choose a campaign">
          <select className="admin-select" style={{ marginTop: 12 }} value=""
            onChange={event => onSelectCampaign?.(event.target.value)}>
            <option value="">Select a campaign…</option>
            {campaigns.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </Empty>
      </div>
    );
  }

  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>Call later</h3>
          <p>These come back automatically when their retry time arrives and their local calling window is open.</p>
        </div>
        <div className="card-head-actions">
          <select className="admin-select" value={campaignId} onChange={event => onSelectCampaign?.(event.target.value)}>
            {campaigns.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <QueryState loading={loading} error={error} capped={capped} cap={TARGET_CAP} />
      {action.error && <p className="admin-error">{action.error}</p>}

      {!loading && !rows.length ? (
        <Empty title="Nobody is waiting">Targets land here after a no-answer, a voicemail, or a cancelled parallel leg.</Empty>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Contact</th><th>Phone</th><th>Local time</th><th>Why</th>
                <th>Last attempt</th><th>Next attempt</th><th className="num">Attempts</th>
                <th>Last outcome</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td className="cell-strong cell-wrap">{(row.prospectId || row.leadId || '').slice(0, 26)}</td>
                  <td className="cell-dim">{formatPhone(row.phoneE164)}</td>
                  <td className="cell-dim">
                    {row.timezone ? localTime(row.timezone) : <span className="outbound-stale">unknown</span>}
                  </td>
                  <td className="cell-dim cell-wrap">
                    {REASON_LABELS[row.requeueReason] || row.requeueReason || '—'}
                  </td>
                  <td className="cell-dim">{formatWhen(row.lastAttemptAt)}</td>
                  <td className="cell-dim">{formatWhen(row.nextAttemptAt)}</td>
                  <td className="num">{row.attemptCount || 0}/{row.maxAttempts || 3}</td>
                  <td><StatusPill status={row.lastDisposition || row.state} /></td>
                  <td>
                    <div className="admin-filters">
                      <button className="btn-admin" type="button" disabled={action.busy}
                        onClick={() => act(() => outbound.callLater(row.id, 15, 'call_now'), 'Moved to the front.')}>
                        Call now
                      </button>
                      <button className="btn-admin" type="button" disabled={action.busy}
                        onClick={() => act(() => outbound.callLater(row.id, 10080, 'manual'), 'Pushed a week.')}>
                        +1 week
                      </button>
                      <button className="btn-admin danger" type="button" disabled={action.busy}
                        onClick={() => act(() => outbound.doNotCall(row.id), 'Marked do not call.')}>
                        Do not call
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="admin-note" style={{ marginTop: 12 }}>
        “Call now” schedules the earliest attempt the campaign’s calling window allows — it never overrides local calling hours.
      </p>
    </div>
  );
}
