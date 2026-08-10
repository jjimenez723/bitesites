// Hybrid Dialer V2 session controls.
//
// The operator starts one three-line batch. The server routes exactly one live
// answer to the free rep and assigns additional human answers to isolated AI
// sessions. The browser never decides ownership.

import React, { useEffect, useMemo, useState } from 'react';
import { outbound, useAction, useLiveDoc, useSessionHeartbeat } from './data';
import { Empty } from './SourceBadge';
import ActiveCallPanel from './ActiveCallPanel';
import { leaveHybridVoice } from './voice-client';

export default function DialerControls({ campaignId, campaigns = [], onSelectCampaign }) {
  const [sessionId, setSessionId] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [agentProfileId, setAgentProfileId] = useState('');
  const [autoTakeover, setAutoTakeover] = useState(false);
  const [sessionOverride, setSessionOverride] = useState('');
  const action = useAction();

  const campaign = campaigns.find(entry => entry.id === campaignId) || null;
  const { data: session } = useLiveDoc(sessionId ? `dialerSessions/${sessionId}` : '');
  useSessionHeartbeat(session?.status === 'active' ? sessionId : '');

  useEffect(() => {
    let cancelled = false;
    setProfilesLoading(true);
    outbound.listAgentProfiles()
      .then(result => {
        if (cancelled) return;
        const active = (result?.profiles || []).filter(profile => profile.status !== 'archived');
        setProfiles(active);
        setAgentProfileId(current => current || campaign?.agentProfileId || active[0]?.id || '');
      })
      .catch(() => { if (!cancelled) setProfiles([]); })
      .finally(() => { if (!cancelled) setProfilesLoading(false); });
    return () => { cancelled = true; };
  }, [campaign?.agentProfileId]);

  useEffect(() => {
    if (session && session.status !== 'active') {
      leaveHybridVoice();
      setSessionId('');
    }
  }, [session?.status]);

  useEffect(() => () => leaveHybridVoice(), []);

  const activeNonTerminal = useMemo(() => Boolean(sessionId && (session?.activeCallIds || []).length), [sessionId, session?.activeCallIds]);

  const start = async () => {
    let override = {};
    if (sessionOverride.trim()) override = { instructions: sessionOverride.trim() };
    const result = await action.run(
      () => outbound.startHybridSession(campaignId, { agentProfileId, sessionOverride: override, autoTakeover }),
      'Hybrid session started.'
    );
    if (result?.sessionId) setSessionId(result.sessionId);
  };

  const stop = async () => {
    leaveHybridVoice();
    await action.run(() => outbound.stopHybridSession(sessionId, 'ended'), 'Session ended.');
    setSessionId('');
  };

  const dial = () => action.run(() => outbound.dialHybrid(sessionId), '3-call batch launched.');

  const toggleAuto = async event => {
    const enabled = event.target.checked;
    setAutoTakeover(enabled);
    if (sessionId) {
      const result = await action.run(() => outbound.setAutoTakeover(sessionId, enabled), enabled ? 'Auto Takeover enabled.' : 'Auto Takeover disabled.');
      if (!result) setAutoTakeover(!enabled);
    }
  };

  const disposition = async (call, value) => {
    await action.run(
      () => outbound.hybridDisposition({ callId: call.id, disposition: value, notes: '' }),
      'Disposition recorded.'
    );
  };

  if (!campaignId) {
    return (
      <div className="admin-card">
        <Empty title="Choose a campaign to dial">
          <select className="admin-select" style={{ marginTop: 12 }} value=""
            onChange={event => onSelectCampaign?.(event.target.value)}>
            <option value="">Select a campaign…</option>
            {campaigns.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </Empty>
      </div>
    );
  }

  const providerReady = campaign?.provider === 'twilio';

  return (
    <div className="admin-grid hybrid-dialer-layout" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Hybrid Dialer — {campaign?.name || campaignId}</h3>
            <p>
              Three calls per batch. Your first available human answer routes to you; additional human answers stay live with AI.
            </p>
          </div>
          <div className="card-head-actions">
            <select className="admin-select" value={campaignId} disabled={Boolean(sessionId)} onChange={event => onSelectCampaign?.(event.target.value)}>
              {campaigns.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </div>
        </div>

        {!providerReady && (
          <p className="admin-error" style={{ marginBottom: 12 }}>
            Hybrid Dialer V2 requires a Twilio campaign because live AI overflow, browser audio, listen mode, and same-call takeover need per-leg conference control.
          </p>
        )}

        {!sessionId ? (
          <div className="hybrid-session-setup">
            <div className="outbound-form-grid">
              <label>
                <span>AI agent profile</span>
                <select className="admin-select" value={agentProfileId} disabled={profilesLoading}
                  onChange={event => setAgentProfileId(event.target.value)}>
                  <option value="">{profilesLoading ? 'Loading profiles…' : 'Select an agent…'}</option>
                  {profiles.map(profile => (
                    <option key={profile.id} value={profile.id}>{profile.name} · v{profile.version || 1}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Session/day override <small>(optional)</small></span>
                <input value={sessionOverride} maxLength={3000}
                  onChange={event => setSessionOverride(event.target.value)}
                  placeholder="Example: Emphasize the August website audit offer today." />
              </label>
            </div>

            <div className="hybrid-session-options">
              <label className="hybrid-toggle">
                <input type="checkbox" checked={autoTakeover} onChange={toggleAuto} />
                <span>
                  <strong>Auto Takeover</strong>
                  <small>When you become free, automatically hand you the highest-priority call that already requested/authorized a human handoff.</small>
                </span>
              </label>
              <div className="hybrid-concurrency-lock">
                <strong>3 lines</strong>
                <span>Current session concurrency</span>
              </div>
            </div>

            {!profilesLoading && !profiles.length && (
              <p className="admin-note">Create an AI agent profile in Settings before starting the Hybrid Dialer.</p>
            )}

            <div className="admin-filters" style={{ marginTop: 14 }}>
              <button className="btn-admin primary" type="button"
                disabled={action.busy || !providerReady || !agentProfileId || campaign?.status === 'paused' || campaign?.status === 'cancelled'}
                onClick={start}>
                {action.busy ? 'Starting…' : 'Start Hybrid Session'}
              </button>
            </div>
          </div>
        ) : (
          <div className="hybrid-session-running">
            <div className="admin-filters">
              <span className="pill running"><i />Hybrid session</span>
              <span className="pill">3 lines</span>
              <label className="hybrid-inline-toggle">
                <input type="checkbox" checked={session?.takeover?.autoEnabled ?? autoTakeover} onChange={toggleAuto} />
                Auto Takeover
              </label>
              <button className="btn-admin primary" type="button" disabled={action.busy || activeNonTerminal} onClick={dial}>
                {action.busy ? 'Launching…' : 'Launch 3 Calls'}
              </button>
              <button className="btn-admin danger" type="button" disabled={action.busy} onClick={stop}>End Session</button>
            </div>
            <p className="admin-note" style={{ marginTop: 10 }}>
              A new 3-call batch is available after the current batch has fully ended. Active call cards never show a generic Call button.
            </p>
          </div>
        )}

        {action.error && <p className="admin-error" style={{ marginTop: 12 }}>{action.error}</p>}
        {action.message && <p className="admin-note" style={{ marginTop: 12 }}>{action.message}</p>}
      </div>

      {sessionId && <ActiveCallPanel session={session} onDisposition={disposition} />}
    </div>
  );
}
