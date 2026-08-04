// Starting a session, dialing, and recording what happened.
//
// The disposition row is required rather than optional: a call whose outcome
// nobody recorded is a call that will be made again tomorrow, and the retry
// scheduler has nothing to schedule from. So the "Dial next" button is disabled
// while a leg is live and unresolved.
//
// Every control here is a callable. The browser never places a call, never
// holds a provider credential, and never decides which of five ringing lines
// won — all three are server-side, in a transaction.

import React, { useEffect, useState } from 'react';
import { outbound, useAction, useLiveDoc, useSessionHeartbeat, useTargets, loadProspect } from './data';
import { Empty } from './SourceBadge';
import ActiveCallPanel from './ActiveCallPanel';

const DISPOSITIONS = [
  ['connected', 'Connected', 'primary'],
  ['booked_meeting', 'Booked a meeting', 'primary'],
  ['not_interested', 'Not interested', ''],
  ['call_later', 'Call later', ''],
  ['voicemail', 'Voicemail', ''],
  ['no_answer', 'No answer', ''],
  ['wrong_number', 'Wrong number', ''],
  ['do_not_call', 'Do not call', 'danger']
];

export default function DialerControls({ campaignId, campaigns = [], onSelectCampaign }) {
  const [sessionId, setSessionId] = useState('');
  const [mode, setMode] = useState('power');
  const [concurrency, setConcurrency] = useState(3);
  const [notes, setNotes] = useState('');
  const [contact, setContact] = useState(null);
  const action = useAction();

  const campaign = campaigns.find(entry => entry.id === campaignId) || null;
  const { data: session } = useLiveDoc(sessionId ? `dialerSessions/${sessionId}` : '');
  const { data: connectedCall } = useLiveDoc(session?.connectedCallId ? `calls/${session.connectedCallId}` : '');
  const { rows: liveTargets } = useTargets(campaignId, { states: ['dialing', 'connected'] });

  useSessionHeartbeat(session?.status === 'active' ? sessionId : '');

  const connectedTarget = liveTargets.find(target => target.id === session?.connectedTargetId)
    || liveTargets.find(target => target.id === connectedCall?.targetId)
    || null;

  // Load the connected contact so the panel can name who is on the line.
  useEffect(() => {
    let cancelled = false;
    const prospectId = connectedTarget?.prospectId;
    if (!prospectId) { setContact(null); return undefined; }
    loadProspect(prospectId).then(record => { if (!cancelled) setContact(record); }).catch(() => {});
    return () => { cancelled = true; };
  }, [connectedTarget?.prospectId]);

  // A session the server ended (abandoned, superseded, campaign cancelled)
  // should stop looking active here too.
  useEffect(() => {
    if (session && session.status !== 'active') setSessionId('');
  }, [session?.status]);

  const start = async () => {
    const result = await action.run(
      () => (mode === 'parallel'
        ? outbound.startParallelSession(campaignId, concurrency)
        : outbound.startPowerSession(campaignId)),
      'Session started.'
    );
    if (result?.sessionId) setSessionId(result.sessionId);
  };

  const stop = async () => {
    await action.run(() => outbound.stopSession(sessionId, 'ended'), 'Session ended.');
    setSessionId('');
  };

  const dial = () => action.run(() => outbound.dialNext(sessionId), '');

  const disposition = async value => {
    if (!connectedTarget) return;
    await action.run(
      () => outbound.disposition({
        targetId: connectedTarget.id,
        callId: session?.connectedCallId || connectedTarget.lastCallId || '',
        disposition: value,
        notes
      }),
      'Recorded.'
    );
    setNotes('');
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

  const live = (session?.activeCallIds || []).length > 0;
  const connected = Boolean(session?.connectedCallId);

  return (
    <div className="admin-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Live dialer — {campaign?.name || campaignId}</h3>
            <p>
              {campaign?.status === 'paused'
                ? 'This campaign is paused. Resume it before dialing.'
                : 'Your session holds a lock on each target it dials, so nobody else can call the same person.'}
            </p>
          </div>
          <div className="card-head-actions">
            <select className="admin-select" value={campaignId} onChange={event => onSelectCampaign?.(event.target.value)}>
              {campaigns.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </div>
        </div>

        {!sessionId ? (
          <div className="admin-filters">
            <div className="admin-segment" role="group" aria-label="Dialer mode">
              <button type="button" aria-pressed={mode === 'power'} onClick={() => setMode('power')}>Power</button>
              <button type="button" aria-pressed={mode === 'parallel'} onClick={() => setMode('parallel')}>Parallel</button>
            </div>
            {mode === 'parallel' && (
              <select className="admin-select" value={concurrency} onChange={event => setConcurrency(Number(event.target.value))}>
                {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} line{value > 1 ? 's' : ''}</option>)}
              </select>
            )}
            <button className="btn-admin primary" type="button"
              disabled={action.busy || campaign?.status === 'paused' || campaign?.status === 'cancelled'}
              onClick={start}>
              {action.busy ? 'Starting…' : 'Start session'}
            </button>
          </div>
        ) : (
          <div className="admin-filters">
            <span className="pill running"><i />{session?.mode || mode} session</span>
            <button className="btn-admin primary" type="button" disabled={action.busy || connected} onClick={dial}>
              {action.busy ? 'Dialing…' : live && !connected ? 'Dial more' : 'Dial next'}
            </button>
            <button className="btn-admin danger" type="button" disabled={action.busy} onClick={stop}>End session</button>
          </div>
        )}

        {action.error && <p className="admin-error" style={{ marginTop: 12 }}>{action.error}</p>}
        {action.message && <p className="admin-note" style={{ marginTop: 12 }}>{action.message}</p>}

        {connected && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
            <div className="panel-section-label">How did it go?</div>
            <div className="outbound-form-grid" style={{ marginTop: 10 }}>
              <label className="full">
                <span>Notes</span>
                <textarea rows={2} value={notes} onChange={event => setNotes(event.target.value)}
                  placeholder="What they said, what happens next…" />
              </label>
            </div>
            <div className="outbound-dispositions" style={{ marginTop: 10 }}>
              {DISPOSITIONS.map(([value, label, kind]) => (
                <button key={value} className={`btn-admin ${kind}`} type="button"
                  disabled={action.busy} onClick={() => disposition(value)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="admin-note" style={{ marginTop: 10 }}>
              A disposition is required before the next target is handed out.
            </p>
          </div>
        )}
      </div>

      {sessionId && <ActiveCallPanel session={session} target={connectedTarget} contact={contact} />}
    </div>
  );
}
