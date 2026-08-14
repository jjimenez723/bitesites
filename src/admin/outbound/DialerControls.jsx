// Hybrid Dialer V2 session controls.
//
// The operator starts one three-line batch. The server routes exactly one live
// answer to the free rep and assigns additional human answers to isolated AI
// sessions. The browser never decides ownership.

import React, { useEffect, useState } from 'react';
import { outbound, useAction, useLiveDoc, useSessionHeartbeat } from './data';
import { Empty } from './SourceBadge';
import ActiveCallPanel from './ActiveCallPanel';
import CallPlanFlow from './CallPlanFlow';
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

export default function DialerControls({ campaignId, campaigns = [], onSelectCampaign, onOpenQueue, role = 'admin' }) {
  const [sessionId, setSessionId] = useState('');
  const [sessionRecovery, setSessionRecovery] = useState({ loading: true, error: '', restored: false });
  const [profiles, setProfiles] = useState([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [agentProfileId, setAgentProfileId] = useState('');
  const [operatingMode, setOperatingMode] = useState('hybrid');
  const [concurrency, setConcurrency] = useState(3);
  const [autoTakeover, setAutoTakeover] = useState(false);
  const [sessionOverride, setSessionOverride] = useState('');
  const [dialIssue, setDialIssue] = useState(null);
  const action = useAction();
  const guidedMode = role === 'outbound_rep';

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
          setOperatingMode(active.operatingMode || 'hybrid');
          setConcurrency(Math.max(1, Math.min(5, Number(active.concurrency) || 3)));
          setAgentProfileId(active.agentProfileId || '');
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
        setAgentProfileId(current => current || (operatingMode === 'human'
          ? ''
          : campaign?.agentProfileId || active[0]?.id || ''));
      })
      .catch(() => { if (!cancelled) setProfiles([]); })
      .finally(() => { if (!cancelled) setProfilesLoading(false); });
    return () => { cancelled = true; };
  }, [campaign?.agentProfileId, operatingMode]);

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
    if (!guidedMode && sessionOverride.trim()) override = { instructions: sessionOverride.trim() };
    const result = await action.run(
      () => outbound.startHybridSession(campaignId, {
        agentProfileId,
        sessionOverride: override,
        autoTakeover: guidedMode ? false : autoTakeover,
        operatingMode,
        concurrency
      }),
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
    if ((session?.operatingMode || operatingMode) !== 'ai') await prepareHybridVoice();
    const result = await outbound.dialHybrid(sessionId);
    if (result?.reason === 'batch_in_progress') {
      throw new Error('Auto dialing is already active for this session.');
    }
    if (result?.reason === 'no_eligible_targets') {
      const message = noEligibleMessage(result);
      setDialIssue({ message, openQueue: true });
      throw new Error(message);
    }
    if (!(result?.started || []).length) {
      throw new Error('No call was placed. Review the verified preflight result before trying again.');
    }
    return result;
  }, 'Call placement accepted by Twilio. Waiting for ringing events.');

  const toggleAuto = async event => {
    const enabled = event.target.checked;
    setAutoTakeover(enabled);
    if (sessionId) {
      const result = await action.run(() => outbound.setAutoTakeover(sessionId, enabled), enabled ? 'Auto Takeover enabled.' : 'Auto Takeover disabled.');
      if (!result) setAutoTakeover(!enabled);
    }
  };

  const changeOperatingMode = async event => {
    const nextMode = event.target.value;
    if (!sessionId) {
      setOperatingMode(nextMode);
      return;
    }
    const previous = session?.operatingMode || operatingMode;
    setOperatingMode(nextMode);
    const result = await action.run(
      () => outbound.setHybridOperatingMode(sessionId, nextMode, agentProfileId),
      nextMode === 'ai'
        ? 'AI-only calling enabled. Calls continue if this browser disconnects.'
        : `${nextMode === 'human' ? 'Human-only' : 'Hybrid'} calling enabled.`
    );
    if (!result) setOperatingMode(previous);
  };

  const changeSessionAgent = async event => {
    const nextProfileId = event.target.value;
    const previousProfileId = session?.agentProfileId || agentProfileId;
    const previousMode = session?.operatingMode || operatingMode;
    const nextMode = previousMode === 'human' && nextProfileId ? 'hybrid' : previousMode;
    setAgentProfileId(nextProfileId);
    if (!sessionId) {
      setOperatingMode(nextMode);
      return;
    }
    const result = await action.run(
      () => outbound.setHybridOperatingMode(sessionId, nextMode, nextProfileId),
      previousMode === 'human' && nextProfileId
        ? 'AI agent added. The session is now Hybrid and expanding to three lines.'
        : 'Session AI agent updated.'
    );
    if (!result) {
      setAgentProfileId(previousProfileId);
      setOperatingMode(previousMode);
    } else {
      setOperatingMode(nextMode);
    }
  };

  const changeConcurrency = async event => {
    const nextConcurrency = Number(event.target.value);
    const previous = Math.max(1, Number(session?.concurrency || concurrency) || 1);
    setConcurrency(nextConcurrency);
    if (!sessionId) return;
    const result = await action.run(
      () => outbound.setHybridConcurrency(sessionId, nextConcurrency),
      nextConcurrency > previous
        ? `Expanded to ${nextConcurrency} concurrent lines. Filling the new slots now.`
        : `Concurrency set to ${nextConcurrency}. Existing calls will finish normally.`
    );
    if (!result) setConcurrency(previous);
  };

  const disposition = async (call, value, context = {}) => {
    const result = await action.run(
      () => outbound.hybridDisposition({
        callId: call.id, disposition: value,
        notes: context.notes || '', followUpAt: context.followUpAt || ''
      }),
      'Disposition recorded.'
    );
    return Boolean(result);
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
  const preflightBlocker = sessionRecovery.loading ? 'Wait while your active session is checked.'
    : !providerReady ? 'Select a Twilio campaign; Hybrid calling needs conference control.'
      : operatingMode !== 'human' && !agentProfileId ? 'Choose an AI agent profile in Session configuration below.'
        : ['paused', 'cancelled'].includes(sessionCampaign?.status) ? `This campaign is ${sessionCampaign.status}.`
          : Number(counts.ready) === 0 ? 'Prepare and approve at least one call plan.' : '';

  return (
    <div className="admin-grid hybrid-dialer-layout" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <CallPlanFlow
        campaign={sessionCampaign}
        session={session}
        operatingMode={session?.operatingMode || operatingMode}
        canManage={!guidedMode}
        onOpenQueue={onOpenQueue}
        onStartSession={start}
        onStartCalls={dial}
        startDisabled={sessionRecovery.loading || action.busy || !providerReady || (operatingMode !== 'human' && !agentProfileId) || sessionCampaign?.status === 'paused' || sessionCampaign?.status === 'cancelled' || session?.autoDial?.enabled === true}
        startBlocker={preflightBlocker}
      />
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Session configuration — {sessionCampaign?.name || campaignId}</h3>
            <p>
              Choose Human, Hybrid, or AI ownership and maintain between one and five concurrent lines automatically.
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

        {guidedMode && (
          <div className="guided-rep-banner">
            <span aria-hidden="true">✓</span>
            <div><strong>Guided rep mode</strong><p>Plans and AI instructions are manager-approved. You control preflight, live conversation, warm handoff, and wrap-up.</p></div>
          </div>
        )}

        {!sessionId ? (
          <div className="hybrid-session-setup">
            <div className="outbound-form-grid">
              <label>
                <span>Calling mode</span>
                <select className="admin-select" value={operatingMode} onChange={changeOperatingMode}>
                  <option value="human">Human — rep handles calls</option>
                  <option value="hybrid">Hybrid — rep + AI overflow</option>
                  <option value="ai">AI — fully autonomous</option>
                </select>
                <small>{operatingMode === 'human'
                  ? `${concurrency} predictive line${concurrency === 1 ? '' : 's'} while the rep is free; sibling legs end when one person answers.`
                  : operatingMode === 'ai'
                    ? `${concurrency} AI line${concurrency === 1 ? '' : 's'} continue server-side after the rep disconnects.`
                    : `${concurrency} line${concurrency === 1 ? '' : 's'} stay active; the first answer goes to the rep and overflow goes to AI.`}</small>
              </label>
              <label>
                <span>Concurrent lines</span>
                <select className="admin-select" value={concurrency} onChange={changeConcurrency}>
                  {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}
                </select>
                <small>The session keeps this many eligible calls active whenever capacity is available.</small>
              </label>
              <label>
                <span>AI agent profile {operatingMode === 'human' && <small>(optional)</small>}</span>
                <select className="admin-select" value={agentProfileId} disabled={profilesLoading}
                  onChange={changeSessionAgent}>
                  <option value="">{profilesLoading ? 'Loading profiles…' : 'Select an agent…'}</option>
                  {profiles.map(profile => (
                    <option key={profile.id} value={profile.id}>{profile.name} · v{profile.version || 1}</option>
                  ))}
                </select>
              </label>
              {!guidedMode && <label>
                <span>Session/day override <small>(optional)</small></span>
                <input value={sessionOverride} maxLength={3000}
                  onChange={event => setSessionOverride(event.target.value)}
                  placeholder="Example: Emphasize the August website audit offer today." />
              </label>}
            </div>

            <div className="hybrid-session-options">
              {!guidedMode && operatingMode === 'hybrid' && <label className="hybrid-toggle">
                <input type="checkbox" checked={autoTakeover} onChange={toggleAuto} />
                <span>
                  <strong>Auto Takeover</strong>
                  <small>When you become free, automatically hand you the highest-priority call that already requested/authorized a human handoff.</small>
                </span>
              </label>}
              {guidedMode && <div className="hybrid-toggle is-locked"><span><strong>Manual takeover</strong><small>Review the live context before joining an AI-led call. Auto Takeover is locked off in guided mode.</small></span></div>}
              <div className="hybrid-concurrency-lock">
                <strong>{concurrency} line{concurrency === 1 ? '' : 's'}</strong>
                <span>Current session concurrency</span>
              </div>
            </div>

            {!profilesLoading && !profiles.length && (
              <p className="admin-note">Create an AI agent profile in AI Agents before starting the Hybrid Dialer.</p>
            )}
            <p className="admin-note" style={{ marginTop: 14 }}>When this configuration is ready, use <strong>Run preflight</strong> in the guided workflow above.</p>
          </div>
        ) : (
          <div className="hybrid-session-running">
            <div className="admin-filters">
              <span className="pill running"><i />Dialer session</span>
              <label className="hybrid-inline-toggle">
                <span>Lines</span>
                <select className="admin-select" value={session?.concurrency || concurrency} disabled={action.busy} onChange={changeConcurrency}>
                  {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <select className="admin-select" value={session?.operatingMode || operatingMode} disabled={action.busy} onChange={changeOperatingMode}>
                <option value="human">Human only</option>
                <option value="hybrid">Hybrid</option>
                <option value="ai">AI only</option>
              </select>
              <label className="hybrid-inline-toggle">
                <span>{(session?.operatingMode || operatingMode) === 'human' ? 'Add AI agent' : 'AI agent'}</span>
                <select className="admin-select" value={session?.agentProfileId || agentProfileId} disabled={profilesLoading || action.busy} onChange={changeSessionAgent}>
                  {(session?.operatingMode || operatingMode) === 'human' && <option value="">No AI agent</option>}
                  {profiles.map(profile => (
                    <option key={profile.id} value={profile.id}>{profile.name} · v{profile.version || 1}</option>
                  ))}
                </select>
              </label>
              {!guidedMode && (session?.operatingMode || operatingMode) === 'hybrid' && <label className="hybrid-inline-toggle">
                <input type="checkbox" checked={session?.takeover?.autoEnabled ?? autoTakeover} onChange={toggleAuto} />
                Auto Takeover
              </label>}
              {guidedMode && <span className="pill">Manual takeover</span>}
              <button className="btn-admin danger" type="button" disabled={action.busy} onClick={stop}>End Session</button>
            </div>
            <p className="admin-note" style={{ marginTop: 10 }}>
              {session?.autoDial?.enabled
                ? (session?.operatingMode === 'ai'
                  ? 'AI calling is server-owned and will keep replacing completed calls even if this browser disconnects.'
                  : 'Auto dialing is active. Each completed call is replaced automatically to maintain the selected capacity.')
                : 'Start calling once; the server will automatically replace completed calls.'}
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
