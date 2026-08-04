// What the rep looks at while a call is up.
//
// The connected leg is unmistakable — a pulsing dot, a green surface, and the
// contact's brief filling the pane — because in a five-line parallel session
// the one thing a rep must never be unsure about is which person is on the
// line. Losing legs are visibly demoted the moment they are cancelled.

import React from 'react';
import { useLiveDoc } from './data';
import { StatusPill, formatPhone, formatDuration, localTime } from './SourceBadge';
import LeadResearchPanel from './LeadResearchPanel';

function Leg({ callId, connectedCallId }) {
  const { data: call } = useLiveDoc(`calls/${callId}`);
  if (!call) return null;

  const connected = call.id === connectedCallId || call.status === 'connected';
  const cancelled = call.status === 'cancelled';

  return (
    <div className={`outbound-leg ${connected ? 'is-connected' : ''} ${cancelled ? 'is-cancelled' : ''}`}>
      {connected && <span className="outbound-live-dot" aria-hidden="true" />}
      <div style={{ minWidth: 0 }}>
        <div className="outbound-leg-name">
          {call.prospectId || call.leadId || call.targetId}
        </div>
        <div className="outbound-leg-meta">
          attempt {call.attemptNumber || 1}
          {call.durationSec ? ` · ${formatDuration(call.durationSec)}` : ''}
          {cancelled && call.cancellationReason ? ` · ${call.cancellationReason.replace(/_/g, ' ')}` : ''}
        </div>
      </div>
      <StatusPill status={connected ? 'connected' : call.status} />
    </div>
  );
}

export default function ActiveCallPanel({ session, target, contact }) {
  if (!session) return null;

  const legs = session.activeCallIds || [];
  const connectedCallId = session.connectedCallId || '';
  const contactType = target?.contactType || 'prospect';
  const contactId = target?.prospectId || target?.leadId || '';

  return (
    <div className="outbound-live">
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>
              {connectedCallId ? 'On a call' : legs.length ? 'Dialing…' : 'Idle'}
              {connectedCallId && <span className="outbound-live-dot" style={{ marginLeft: 9 }} aria-hidden="true" />}
            </h3>
            <p>
              {session.mode === 'parallel'
                ? `${legs.length} line(s) up. The first verified human answer connects; the rest are cancelled automatically.`
                : 'One line at a time. The next target is only locked once this one is resolved.'}
            </p>
          </div>
        </div>

        {!legs.length ? (
          <p className="admin-note">No live legs. Use “Dial next” to start.</p>
        ) : (
          <div className="outbound-legs">
            {legs.map(callId => <Leg key={callId} callId={callId} connectedCallId={connectedCallId} />)}
          </div>
        )}

        {contact && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
            <div className="outbound-metric-row">
              <div className="outbound-metric">
                <strong style={{ fontSize: 15 }}>{contact.companyName || contact.name || '—'}</strong>
                <span>Business</span>
              </div>
              <div className="outbound-metric">
                <strong style={{ fontSize: 15 }}>{formatPhone(target?.phoneE164)}</strong>
                <span>Number being dialled</span>
              </div>
              <div className="outbound-metric">
                <strong style={{ fontSize: 15 }}>{target?.timezone ? localTime(target.timezone) : 'unknown'}</strong>
                <span>Their local time</span>
              </div>
              <div className="outbound-metric">
                <strong style={{ fontSize: 15 }}>{target?.attemptCount || 0}/{target?.maxAttempts || 3}</strong>
                <span>Attempts</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Brief</h3>
            <p>Say the sourced facts. Anything marked unverified is a question, not a statement.</p>
          </div>
        </div>
        {contactId
          ? <LeadResearchPanel contactType={contactType} contactId={contactId} compact />
          : <p className="admin-note">A brief appears once a target is connected.</p>}
      </div>
    </div>
  );
}
