// Campaign numbers.
//
// Counts, not charts. Nine states across a handful of campaigns is a table's
// job — a stacked bar here would be decoration over eight readable numbers, and
// the two derived rates below are the only figures that need computing.

import React from 'react';

const FIELDS = [
  ['total', 'Total'],
  ['ready', 'Ready'],
  ['pending', 'Pending'],
  ['dialing', 'Dialing'],
  ['connected', 'Connected'],
  ['completed', 'Completed'],
  ['callLater', 'Call later'],
  ['failed', 'Failed'],
  ['doNotCall', 'Do not call']
];

export default function CampaignMetrics({ campaign, calls = [] }) {
  const counts = campaign?.counts || {};
  const attempted = calls.length;
  const connected = calls.filter(call => ['connected', 'booked_meeting', 'qualified'].includes(call.disposition)).length;
  const cancelled = calls.filter(call => call.status === 'cancelled').length;

  const totalSeconds = calls.reduce((sum, call) => sum + (Number(call.durationSec) || 0), 0);
  const talkMinutes = Math.round(totalSeconds / 60);

  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>Campaign metrics</h3>
          <p>
            Target states are live counts. Call figures cover the most recent {calls.length} outbound calls in this campaign.
          </p>
        </div>
      </div>

      <div className="outbound-metric-row">
        {FIELDS.map(([key, label]) => (
          <div className="outbound-metric" key={key}>
            <strong>{counts[key] ?? 0}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className="outbound-metric-row" style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
        <div className="outbound-metric"><strong>{attempted}</strong><span>Calls placed</span></div>
        <div className="outbound-metric"><strong>{connected}</strong><span>Conversations</span></div>
        <div className="outbound-metric">
          <strong>{attempted ? `${Math.round((connected / attempted) * 100)}%` : '—'}</strong>
          <span>Connect rate</span>
        </div>
        <div className="outbound-metric">
          {/* Cancelled legs are shown separately rather than folded into
              "calls placed": in a parallel session most legs are cancelled by
              design, and counting them as failures would make a working
              campaign look broken. */}
          <strong>{cancelled}</strong>
          <span>Legs cancelled (parallel)</span>
        </div>
        <div className="outbound-metric"><strong>{talkMinutes}</strong><span>Minutes of audio</span></div>
      </div>
    </div>
  );
}
