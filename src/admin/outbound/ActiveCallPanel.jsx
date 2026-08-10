// Hybrid Dialer V2 live workspace.
//
// V1 rendered one "winner" and demoted/cancelled every sibling. V2 renders all
// live calls because additional human answers remain connected under isolated
// AI controllers while the rep handles one conversation.

import React, { useMemo } from 'react';
import { useLiveCalls, useTargets } from './data';
import HybridCallCard from './HybridCallCard';

const terminal = call => ['completed', 'cancelled', 'failed'].includes(call?.status);

function priority(call) {
  if (call?.handoff?.requestedBy === 'prospect' && ['requested', 'queued'].includes(call?.handoff?.state)) return 500;
  if (call?.control?.controller === 'human') return 400;
  if (call?.handoff?.requestedBy === 'rep' && ['requested', 'queued'].includes(call?.handoff?.state)) return 350;
  if (call?.control?.controller === 'ai') return 300;
  if (call?.status === 'ringing') return 200;
  return 100;
}

export default function ActiveCallPanel({ session, onDisposition }) {
  const callIds = session?.activeCallIds || [];
  const calls = useLiveCalls(callIds);
  const targets = useTargets(session?.campaignId || '', {
    states: ['dialing', 'connected', 'call_later', 'voicemail', 'no_answer']
  });

  const targetById = useMemo(() => new Map(targets.rows.map(target => [target.id, target])), [targets.rows]);
  const active = useMemo(() => calls.rows
    .filter(call => !terminal(call))
    .sort((a, b) => priority(b) - priority(a)), [calls.rows]);
  const humanRequests = active.filter(call => call?.handoff?.requestedBy === 'prospect' && ['requested', 'queued'].includes(call?.handoff?.state)).length;
  const aiCount = active.filter(call => call?.control?.controller === 'ai').length;
  const humanCount = active.filter(call => call?.control?.controller === 'human' || call?.control?.controller === 'transitioning').length;

  if (!session) return null;

  return (
    <div className="outbound-live hybrid-live-workspace">
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Live calls</h3>
            <p>
              One rep can speak on one call. Other human answers stay alive with independent AI agents until they finish or you take over.
            </p>
          </div>
          <div className="hybrid-live-summary">
            <span className="pill">{active.length} active</span>
            <span className="pill">{aiCount} AI</span>
            <span className="pill">{humanCount} human</span>
            {humanRequests > 0 && <span className="pill danger">{humanRequests} requested you</span>}
          </div>
        </div>

        <div className="hybrid-rep-state">
          <span className={`hybrid-rep-dot state-${session?.rep?.state || 'available'}`} />
          <strong>Rep: {(session?.rep?.state || 'available').replace(/_/g, ' ')}</strong>
          <span className="admin-note">
            Auto Takeover {session?.takeover?.autoEnabled ? 'on' : 'off'}
          </span>
        </div>

        {calls.loading && !active.length && <p className="admin-note">Loading live calls…</p>}
        {calls.error && <p className="admin-error">{calls.error}</p>}
        {!calls.loading && !active.length && (
          <p className="admin-note">No active calls. Launch the next 3-call batch when you are ready.</p>
        )}

        {active.length > 0 && (
          <div className="hybrid-call-grid">
            {active.map(call => (
              <HybridCallCard
                key={call.id}
                call={call}
                session={session}
                target={targetById.get(call.targetId)}
                onDisposition={onDisposition}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
