import React, { useState } from 'react';
import { outbound, useAction, useLiveDoc, useTeamLiveCalls } from './data';
import { formatDuration, formatPhone, QueryState } from './SourceBadge';
import { joinHybridCall, leaveHybridVoice } from './voice-client';
import LiveCallWorkspace from './LiveCallWorkspace';

export default function TeamCallCoach({ accountIds = [], allAccounts = false }) {
  const calls = useTeamLiveCalls(accountIds, allAccounts);
  const action = useAction();
  const [workspaceCallId, setWorkspaceCallId] = useState('');
  const call = calls.rows.find(entry => entry.id === workspaceCallId) || null;
  const session = useLiveDoc(call?.sessionId ? `dialerSessions/${call.sessionId}` : '').data;

  const monitor = async entry => {
    const result = await action.run(async () => {
      await outbound.beginCoachMonitor(entry.id);
      try {
        await joinHybridCall(entry.id, 'coach');
      } catch (error) {
        await outbound.endCoachMonitor(entry.id).catch(() => {});
        throw error;
      }
      return true;
    }, 'Private supervisor monitor started. Nobody on the call can hear you.');
    if (result) setWorkspaceCallId(entry.id);
  };

  const close = async () => {
    const id = workspaceCallId;
    leaveHybridVoice();
    setWorkspaceCallId('');
    if (id) await outbound.endCoachMonitor(id).catch(() => {});
  };

  return (
    <>
      <div className="admin-card team-coach-card">
        <div className="card-head">
          <div>
            <h3>Team coaching</h3>
            <p>Privately monitor a live rep, follow the same call guide, and send short on-screen coaching cues. The prospect never hears the supervisor.</p>
          </div>
          <div className="card-head-actions"><span className="pill">{calls.rows.length} connected</span><button className="btn-admin" type="button" onClick={calls.refresh}>Refresh</button></div>
        </div>
        <div className="coach-privacy-note"><span aria-hidden="true">◉</span><div><strong>Private by default</strong><p>Monitor joins muted at the conference layer. Speaking, takeover, and transfer are separate deliberate actions.</p></div></div>
        <QueryState loading={calls.loading} error={calls.error} capped={calls.capped} cap={100} />
        {action.error && <p className="admin-error">{action.error}</p>}
        {!calls.loading && !calls.rows.length ? (
          <div className="admin-empty"><strong>No connected calls</strong>Live calls appear here after a verified human answer.</div>
        ) : (
          <div className="team-coach-grid">
            {calls.rows.map(entry => (
              <article key={entry.id}>
                <div className="coach-call-head"><span className={`live-status-orb controller-${entry.control?.controller || 'unassigned'}`} /><div><strong>{entry.displayName || entry.companyName || 'Outbound call'}</strong><span>{formatPhone(entry.phoneE164) || entry.targetId}</span></div></div>
                <dl><div><dt>Operator</dt><dd>{entry.control?.controller === 'human' ? 'Human rep' : entry.control?.controller === 'ai' ? 'AI agent' : 'Routing'}</dd></div><div><dt>Duration</dt><dd>{formatDuration(entry.durationSec || 0)}</dd></div><div><dt>Coach</dt><dd>{entry.coaching?.state === 'monitoring' ? entry.coaching?.supervisorName || 'Monitoring' : 'None'}</dd></div></dl>
                <button className="btn-admin primary" type="button" disabled={action.busy || entry.coaching?.state === 'monitoring'} onClick={() => monitor(entry)}>{entry.coaching?.state === 'monitoring' ? 'Supervisor monitoring' : 'Monitor privately'}</button>
              </article>
            ))}
          </div>
        )}
      </div>

      {call && (
        <LiveCallWorkspace
          call={call}
          session={session}
          participationMode="coach"
          onClose={close}
          onDisposition={() => false}
        />
      )}
    </>
  );
}
