// Hybrid Dialer V2 session controls.
//
// The operator starts one three-line batch. The server routes exactly one live
// answer to the free rep and assigns additional human answers to isolated AI
// sessions. The browser never decides ownership.

import React, { useEffect, useState } from 'react';
import { outbound, useAction, useLiveDoc, useSessionHeartbeat } from './data';
import { Empty } from './SourceBadge';
import ActiveCallPanel from './ActiveCallPanel';
import { leaveHybridVoice, prepareHybridVoice } from './voice-client';

const ELIGIBILITY_LABELS = {
  awaiting_approval: 'waiting for research approval',
  contact_missing: 'missing contact records',
  do_not_call: 'on the Do Not Call list',
  do_not_contact: 'marked do-not-contact',
  invalid_caller_id: 'blocked by an invalid campaign caller ID',
  invalid_number: 'invalid phone numbers',
  max_attempts_reached: 'at the maximum attempt count',
  no_valid_phone: 'without a valid phone number',
  outside_allowed_days: 'outside the campaign’s allowed days',
  outside_calling_hours: 'outside local calling hours',
  retry_delay_not_elapsed: 'still inside the retry delay',
  suppressed: 'suppressed',
  unknown_timezone: 'missing a verifiable timezone'
};

const noEligibleMessage = result => {
  const availability = result?.availability || {};
  const counts = availability.counts || {};
  const pending = Number(counts.pending) || 0;
  const ready = Number(counts.ready) || 0;
  const later = Number(counts.callLater) || 0;
  const scanned = Number(availability.scanned) || 0;
  const reasons = Object.entries(availability.rejectedByReason || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${count} ${ELIGIBILITY_LABELS[reason] || reason.replace(/_/g, ' ')}`);

  if (pending > 0 && ready + later === 0) {
    return `${pending} target${pending === 1 ? ' is' : 's are'} waiting for research or approval, and none are ready to dial. Open Queue → Pending to prepare and approve them, or turn off required research approval in the campaign settings.`;
  }
  if (reasons.length) {
    return `No eligible calls were found in the next ${scanned} due target${scanned === 1 ? '' : 's'}: ${reasons.join('; ')}.`;
  }
  if (later > 0) return `${later} target${later === 1 ? ' is' : 's are'} scheduled for later, but none are due right now.`;
  return 'There are no ready, due targets in this campaign. Open Queue to review target state, research approval, calling hours, and compliance.';
};

export default function DialerControls({ campaignId, campaigns = [], onSelectCampaign, onOpenQueue }) {
  const [sessionId, setSessionId] = useState('');
  const [sessionRecovery, setSessionRecovery] = useState({ loading: true, error: '', restored: false });
  const [profiles, setProfiles] = useState([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [agentProfileId, setAgentProfileId] = useState('');
  const [autoTakeover, setAutoTakeover] = useState(false);
  const [sessionOverride, setSessionOverride] = useState('');
  const [dialIssue, setDialIssue] = useState(null);
  const action = useAction();

  const campaign = campaigns.find(entry => entry.id === campaignId) || null;
  const { data: session } = useLiveDoc(sessionId ? `dialerSessions/${sessionId}` : '');
  useSessionHeartbeat(session?.status === 'active' ? sessionId : '');

  useEffect(() => {
    let cancelled = false;
    setSessionRecovery({ loading: true, error: '', restored: false });
    outbound.getActiveHybridSession()
      .then(result => {
        if (cancelled) return;
        const active = result?.session;
        if (active?.sessionId) {
          setSessionId(active.sessionId);
          setAutoTakeover(active.autoTakeover === true);
          if (active.campaignId && active.campaignId !== campaignId) onSelectCampaign?.(active.campaignId);
          setSessionRecovery({ loading: false, error: '', restored: true });
        } else {
          setSessionRecovery({ loading: false, error: '', restored: false });
        }
      })
      .catch(error => {
        if (!cancelled) setSessionRecovery({ loading: false, error: error?.message || 'Could not check for an active session.', restored: false });
      });
    return () => { cancelled = true; };
    // The active session is user-scoped and only needs to be recovered when
    // this tab mounts. Campaign changes must not replace the running session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setSessionRecovery(current => ({ ...current, restored: false }));
    }
  }, [session?.status]);

  useEffect(() => () => leaveHybridVoice(), []);

  const start = async () => {
    setDialIssue(null);
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
    setSessionRecovery({ loading: false, error: '', restored: false });
  };

  const dial = () => action.run(async () => {
    setDialIssue(null);
    // This click is the browser user gesture that safely obtains microphone
    // permission. Once permission is granted, the server can asynchronously
    // assign the first answering prospect and the softphone can join it.
    await prepareHybridVoice();
    const result = await outbound.dialHybrid(sessionId);
    if (result?.reason === 'batch_in_progress') {
      throw new Error('The current 3-call batch is still active. End or finish those calls before launching the next batch.');
    }
    if (result?.reason === 'no_eligible_targets') {
      const message = noEligibleMessage(result);
      setDialIssue({ message, openQueue: true });
      throw new Error(message);
    }
    return result;
  }, '3-call batch launched.');

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

  const sessionCampaign = campaigns.find(entry => entry.id === session?.campaignId) || campaign;
  const providerReady = sessionCampaign?.provider === 'twilio';
  const counts = sessionCampaign?.counts || {};

  return (
    <div className="admin-grid hybrid-dialer-layout" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Hybrid Dialer — {sessionCampaign?.name || campaignId}</h3>
            <p>
              Three calls per batch. Your first available human answer routes to you; additional human answers stay live with AI.
            </p>
          </div>
          <div className="card-head-actions">
            <select className="admin-select" value={session?.campaignId || campaignId} disabled={Boolean(sessionId)} onChange={event => onSelectCampaign?.(event.target.value)}>
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
              <p className="admin-note">Create an AI agent profile in AI Agents before starting the Hybrid Dialer.</p>
            )}

            <div className="admin-filters" style={{ marginTop: 14 }}>
              <button className="btn-admin primary" type="button"
                disabled={sessionRecovery.loading || action.busy || !providerReady || !agentProfileId || campaign?.status === 'paused' || campaign?.status === 'cancelled'}
                onClick={start}>
                {sessionRecovery.loading ? 'Checking for active session…' : action.busy ? 'Starting…' : 'Start Hybrid Session'}
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
              <button className="btn-admin primary" type="button" disabled={action.busy} onClick={dial}>
                {action.busy ? 'Launching…' : 'Launch 3 Calls'}
              </button>
              <button className="btn-admin danger" type="button" disabled={action.busy} onClick={stop}>End Session</button>
            </div>
            <p className="admin-note" style={{ marginTop: 10 }}>
              The server refuses a new batch while any current call is still live. Once all three legs are terminal, this same session can launch the next batch.
            </p>
          </div>
        )}

        {(Number(counts.total) > 0) && (
          <p className="admin-note" style={{ marginTop: 12 }}>
            Live queue: {Number(counts.ready) || 0} ready · {Number(counts.pending) || 0} pending research/approval · {Number(counts.callLater) || 0} scheduled later
          </p>
        )}
        {sessionRecovery.restored && (
          <p className="admin-note" style={{ marginTop: 12 }}>Restored your existing active session.</p>
        )}
        {sessionRecovery.error && <p className="admin-error" style={{ marginTop: 12 }}>{sessionRecovery.error}</p>}
        {action.error && (
          <div className="admin-error" style={{ marginTop: 12 }}>
            {action.error}
            {dialIssue?.openQueue && (
              <button className="btn-admin" type="button" style={{ marginLeft: 10 }} onClick={onOpenQueue}>Open Queue</button>
            )}
          </div>
        )}
        {action.message && <p className="admin-note" style={{ marginTop: 12 }}>{action.message}</p>}
      </div>

      {sessionId && <ActiveCallPanel session={session} onDisposition={disposition} />}
    </div>
  );
}
