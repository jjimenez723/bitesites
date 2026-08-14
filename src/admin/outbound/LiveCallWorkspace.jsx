import React, { useEffect, useMemo, useRef, useState } from 'react';
import { outbound, toDate, useAction } from './data';
import { formatDuration, formatPhone } from './SourceBadge';
import LiveTranscript from './LiveTranscript';
import {
  hybridVoiceState, joinHybridCall, leaveHybridVoice, setHybridVoiceMuted
} from './voice-client';

const OUTCOMES = [
  ['connected', 'Conversation completed', 'A real conversation took place.'],
  ['qualified', 'Qualified opportunity', 'There is a credible need and fit.'],
  ['booked_meeting', 'Meeting booked', 'A specific follow-up meeting was agreed.'],
  ['call_later', 'Call back later', 'They asked to continue at another time.'],
  ['not_interested', 'Not interested', 'They declined the offer.'],
  ['voicemail', 'Voicemail', 'The call reached voicemail.'],
  ['no_answer', 'No answer', 'Nobody answered the call.'],
  ['wrong_number', 'Wrong number', 'The number does not reach this prospect.'],
  ['do_not_call', 'Do not call', 'Suppress future phone outreach.']
];

const Icon = ({ children }) => <span className="live-control-icon" aria-hidden="true">{children}</span>;

function secondsSince(value, now, fallback = 0) {
  const start = toDate(value);
  return start ? Math.max(0, Math.floor((now - start.getTime()) / 1000)) : Math.max(0, Number(fallback) || 0);
}

function localTime(timezone) {
  if (!timezone) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date());
  } catch { return timezone; }
}

export default function LiveCallWorkspace({
  call, session, target, onClose, onDisposition,
  participationMode = 'owner', demo = false, demoTurns = null
}) {
  const action = useAction();
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState('guide');
  const [muted, setMuted] = useState(() => hybridVoiceState().muted);
  const [listening, setListening] = useState(() => hybridVoiceState().callId === call.id && hybridVoiceState().mode === 'listen');
  const [outcome, setOutcome] = useState(call.disposition || '');
  const storageKey = `bitesites-call-notes:${call.id}`;
  const [notes, setNotes] = useState(() => localStorage.getItem(storageKey) || call.summary || '');
  const [followUpAt, setFollowUpAt] = useState('');
  const [showWrapUp, setShowWrapUp] = useState(Boolean(call.disposition));
  const [voiceError, setVoiceError] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferAgents, setTransferAgents] = useState([]);
  const [transferToUid, setTransferToUid] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [coachCue, setCoachCue] = useState('');
  const autoJoin = useRef(false);
  const transferDialogRef = useRef(null);
  const wrapDialogRef = useRef(null);

  const controller = call?.control?.controller || 'unassigned';
  const terminal = ['completed', 'cancelled', 'failed'].includes(call?.status);
  const assisting = participationMode === 'assist';
  const coaching = participationMode === 'coach';
  const staffTransfer = call.staffTransfer || {};
  const transferAudioReady = Boolean(call.media?.assistParticipantSid);
  const repOwnsCall = session?.rep?.activeCallId === call.id;
  const humanAudible = assisting
    ? ['accepted', 'completed'].includes(staffTransfer.state)
    : controller === 'human' && repOwnsCall;
  const plan = call.callPlan || {};
  const timezone = call.contactLocation?.timezone || target?.timezone || '';
  const displayName = call.displayName || call.companyName || call.contactName || 'Outbound call';
  const phone = call.phoneE164 || target?.phoneE164 || '';
  const duration = formatDuration(secondsSince(call.connectedAt || call.answeredAt || call.startedAt, now, call.durationSec));

  useEffect(() => {
    if (terminal) { setShowWrapUp(true); return undefined; }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);

  useEffect(() => {
    localStorage.setItem(storageKey, notes);
  }, [notes, storageKey]);

  useEffect(() => {
    const warn = event => {
      if (!terminal && humanAudible) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [humanAudible, terminal]);

  useEffect(() => {
    const key = event => {
      if (event.key !== 'Escape') return;
      if (showTransfer) setShowTransfer(false);
      else if (showWrapUp) { if (!terminal) setShowWrapUp(false); }
      else onClose?.();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, showTransfer, showWrapUp, terminal]);

  useEffect(() => {
    const dialog = showTransfer ? transferDialogRef.current : showWrapUp ? wrapDialogRef.current : null;
    if (!dialog) return undefined;
    const previous = document.activeElement;
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    const first = focusable()[0];
    (first || dialog).focus();
    const trap = event => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus(); }
    };
    dialog.addEventListener('keydown', trap);
    return () => {
      dialog.removeEventListener('keydown', trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [showTransfer, showWrapUp]);

  useEffect(() => {
    if (demo || assisting || coaching || !humanAudible || terminal || autoJoin.current) return;
    const current = hybridVoiceState();
    if (current.connected && current.callId === call.id && current.mode === 'human') return;
    autoJoin.current = true;
    joinHybridCall(call.id, 'human')
      .then(() => { setMuted(false); setListening(false); })
      .catch(error => setVoiceError(error?.message || 'Could not connect your microphone.'))
      .finally(() => { autoJoin.current = false; });
  }, [assisting, call.id, coaching, demo, humanAudible, terminal]);

  useEffect(() => {
    if (!assisting && !coaching && staffTransfer.state === 'completed') {
      leaveHybridVoice();
      onClose?.();
    }
  }, [assisting, coaching, onClose, staffTransfer.state]);

  useEffect(() => {
    if (terminal && hybridVoiceState().callId === call.id) leaveHybridVoice();
  }, [call.id, terminal]);

  const progress = useMemo(() => {
    if (terminal) return ['Call ended', 'Wrap-up required'];
    if (coaching) return ['Private supervisor monitor', 'The prospect and representative cannot hear you'];
    if (assisting && staffTransfer.state === 'accepted') return ['Warm handoff', `You and ${staffTransfer.fromName || 'the current rep'} are both audible`];
    if (assisting && staffTransfer.state === 'completed') return ['Handoff complete', 'You are now the call owner'];
    if (controller === 'transitioning') return ['Handoff in progress', 'The prospect hears the AI introduction'];
    if (controller === 'human') return ['Human-led conversation', muted ? 'Your microphone is muted' : 'The prospect can hear you'];
    if (controller === 'ai') return ['AI-led conversation', listening ? 'You can hear the call; the prospect cannot hear you' : 'Open monitor mode before taking over'];
    return [call.status === 'ringing' ? 'Ringing' : 'Connecting', 'No conversation is verified yet'];
  }, [assisting, call.status, coaching, controller, listening, muted, staffTransfer.fromName, staffTransfer.state, terminal]);

  const toggleMute = () => {
    try {
      const next = setHybridVoiceMuted(!muted);
      setMuted(next);
    } catch (error) { setVoiceError(error?.message || 'Could not change microphone state.'); }
  };

  const listen = async () => {
    setVoiceError('');
    if (listening) {
      leaveHybridVoice();
      const result = await action.run(() => outbound.stopListen(call.id), 'Monitor mode ended.');
      if (result) setListening(false);
      return;
    }
    const reserved = await action.run(() => outbound.beginListen(call.id), 'Monitor mode started. The prospect cannot hear you.');
    if (!reserved) return;
    try {
      await joinHybridCall(call.id, 'listen');
      setListening(true);
    } catch (error) {
      await outbound.stopListen(call.id).catch(() => {});
      setVoiceError(error?.message || 'Could not enter monitor mode.');
    }
  };

  const takeover = async () => {
    if (listening) {
      leaveHybridVoice();
      await outbound.stopListen(call.id).catch(() => {});
      setListening(false);
    }
    await action.run(() => outbound.requestTakeover(call.id), 'Takeover requested. AI will introduce you before your microphone joins.');
  };

  const end = async () => {
    const result = await action.run(() => outbound.endHybridCall(call.id), 'Hang-up requested. Complete wrap-up before closing.');
    if (result) setShowWrapUp(true);
  };

  const openTransfer = async () => {
    setShowTransfer(true);
    if (demo) {
      setTransferAgents([
        { uid: 'manager-demo', name: 'Maya Chen', role: 'outbound_manager', availability: 'available' },
        { uid: 'rep-demo', name: 'Alex Rivera', role: 'outbound_rep', availability: 'on_call' }
      ]);
      return;
    }
    const result = await action.run(() => outbound.listTransferAgents());
    if (result?.agents) setTransferAgents(result.agents);
  };

  const requestTransfer = async () => {
    if (!transferToUid) return;
    const result = demo ? { ok: true } : await action.run(
      () => outbound.requestStaffTransfer(call.id, transferToUid, transferNote, notes),
      'Warm handoff requested. Stay on the call until your teammate joins.'
    );
    if (result) setShowTransfer(false);
  };

  const cancelTransfer = async () => {
    const result = await action.run(
      () => outbound.declineStaffTransfer(call.id, 'sender_cancelled'),
      'Warm handoff cancelled.'
    );
    if (result) setShowTransfer(false);
  };

  const completeTransfer = async () => {
    const result = await action.run(
      () => outbound.completeStaffTransfer(call.id),
      `Call ownership transferred to ${staffTransfer.toName || 'your teammate'}.`
    );
    if (result) {
      leaveHybridVoice();
      onClose?.();
    }
  };

  const sendCoachCue = async event => {
    event.preventDefault();
    const message = coachCue.trim();
    if (!message) return;
    if (demo) {
      setCoachCue('');
      return;
    }
    const result = await action.run(
      () => outbound.sendCoachCue(call.id, message),
      'Private coaching cue sent to the representative.'
    );
    if (result) setCoachCue('');
  };

  const saveOutcome = async () => {
    if (!outcome) return;
    let result;
    if (outcome === 'do_not_call') {
      result = await action.run(() => outbound.dncHybridCall(call.id), 'Do Not Call recorded.');
    } else {
      if (!terminal && !demo) {
        const ended = await action.run(
          () => outbound.endHybridCall(call.id),
          'Hang-up requested. Saving the outcome…'
        );
        if (!ended) return;
      }
      result = await onDisposition?.(call, outcome, { notes, followUpAt });
    }
    if (result) {
      localStorage.removeItem(storageKey);
      setShowWrapUp(false);
      onClose?.();
    }
  };

  const needsFollowUp = ['booked_meeting', 'call_later'].includes(outcome);

  return (
    <div className="live-call-workspace" role="dialog" aria-modal="true" aria-labelledby="live-call-title">
      <header className="live-call-topbar">
        <div className="live-call-identity">
          <span className={`live-status-orb controller-${controller}`} />
          <div>
            <span className="outbound-eyebrow">Live call workspace</span>
            <h2 id="live-call-title">{displayName}</h2>
          </div>
        </div>
        <div className="live-call-status" role="status" aria-live="polite">
          <div><strong>{progress[0]}</strong><span>{progress[1]}</span></div>
          <time>{duration}</time>
        </div>
        <button className="live-minimize" type="button" onClick={onClose} aria-label="Minimize live call workspace">
          <span aria-hidden="true">—</span> Minimize
        </button>
      </header>

      <main className="live-call-canvas">
        <aside className="live-context-panel" aria-label="Prospect context">
          <div className="live-contact-card">
            <div className="live-contact-monogram">{displayName.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'BS'}</div>
            <div>
              <strong>{displayName}</strong>
              <span>{call.businessCategory?.replace(/_/g, ' ') || 'Business prospect'}</span>
            </div>
          </div>
          <dl className="live-context-list">
            <div><dt>Phone</dt><dd>{phone ? formatPhone(phone) : 'Unavailable'}</dd></div>
            <div><dt>Location</dt><dd>{[call.contactLocation?.city, call.contactLocation?.region].filter(Boolean).join(', ') || 'Not captured'}</dd></div>
            <div><dt>Local time</dt><dd>{localTime(timezone) || 'Timezone unavailable'}</dd></div>
            <div><dt>Attempt</dt><dd>#{call.attemptNumber || 1}</dd></div>
            <div><dt>Operator</dt><dd>{coaching ? 'Human representative' : assisting ? 'You · receiving rep' : controller === 'human' ? 'You' : controller === 'ai' ? call.agent?.profileName || 'AI agent' : 'Routing'}</dd></div>
          </dl>
          {call.website && <a className="live-website-link" href={call.website} target="_blank" rel="noreferrer noopener">Open company website ↗</a>}

          <div className="live-source-safety">
            <Icon>✓</Icon>
            <div><strong>Source-safe guidance</strong><span>Only items marked Verified are safe to state as fact.</span></div>
          </div>

          <label className="live-notes">
            <span>Private notes <small>autosaved</small></span>
            <textarea rows={8} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Capture the prospect’s exact words, commitments, and next steps…" />
          </label>
        </aside>

        <section className="live-conversation-panel" aria-label="Conversation">
          <div className="live-panel-heading">
            <div><span className="outbound-eyebrow">Conversation</span><h3>Live transcript</h3></div>
            <div className="live-participant-stack" aria-label="Call participants">
              <span title="Prospect">P</span>
              {controller === 'ai' && <span className="is-ai" title="AI agent">AI</span>}
              {(controller === 'human' || controller === 'transitioning' || listening) && <span className="is-human" title={coaching ? 'Representative' : 'You'}>{coaching ? 'Rep' : 'You'}</span>}
              {coaching && <span className="is-coach" title="Private supervisor monitor">Coach</span>}
            </div>
          </div>
          {!coaching && call.coaching?.state === 'monitoring' && call.coaching?.latestCue?.message && (
            <div className="live-coach-cue" role="status">
              <span>Private coach cue</span>
              <strong>{call.coaching.latestCue.message}</strong>
              <small>{call.coaching.latestCue.supervisorName || 'Supervisor'}</small>
            </div>
          )}
          <LiveTranscript callId={call.id} demoTurns={demoTurns} humanLabel={coaching ? 'Rep' : assisting ? 'BiteSites' : 'You'} />
        </section>

        <aside className="live-guidance-panel" aria-label="Call guidance">
          <div className="live-guide-tabs" role="tablist" aria-label="Guidance sections">
            {[['guide', 'Call guide'], ['facts', 'Facts'], ['objections', 'Objections']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>

          {tab === 'guide' && (
            <div className="live-guide-content">
              <section className="live-opening">
                <span>Suggested opening</span>
                <p>{plan.suggestedOpening || 'Confirm you reached the right business, introduce BiteSites, and ask permission to continue.'}</p>
              </section>
              <section><h4>Conversation objective</h4><p>{plan.summary || 'Understand the current website and lead-response process before recommending a next step.'}</p></section>
              <section><h4>Discovery prompts</h4><ul>{(plan.likelyNeeds?.length ? plan.likelyNeeds : ['How do new customers find you today?', 'What happens after someone reaches out?', 'What would make this conversation worthwhile?']).map(item => <li key={item}>{item}</li>)}</ul></section>
              <section><h4>Talking points</h4><ul>{(plan.talkingPoints || []).map(item => <li key={item}>{item}</li>)}</ul></section>
            </div>
          )}

          {tab === 'facts' && (
            <div className="live-guide-content">
              <section><h4>Verified facts</h4>{(plan.verifiedFacts || []).length ? (plan.verifiedFacts || []).map(fact => <div className="live-fact" key={fact.id || fact.text}><span>Verified</span><p>{fact.text}</p></div>) : <p>No verified facts were captured.</p>}</section>
              {(plan.hypotheses || []).length > 0 && <section><h4>Unverified — do not state as fact</h4>{plan.hypotheses.map(item => <div className="live-hypothesis" key={item}>{item}</div>)}</section>}
            </div>
          )}

          {tab === 'objections' && (
            <div className="live-guide-content"><section><h4>Likely objections</h4><ul>{(plan.likelyObjections?.length ? plan.likelyObjections : ['We already have someone for that.', 'We are not interested right now.', 'How did you get this number?']).map(item => <li key={item}>{item}</li>)}</ul></section><section className="live-coach-note"><h4>Coach cue</h4><p>Acknowledge first, ask one clarifying question, and only explain a capability that matches what the prospect actually said.</p></section></div>
          )}
        </aside>
      </main>

      {(voiceError || action.error || action.message) && (
        <div className={`live-call-toast ${voiceError || action.error ? 'is-error' : ''}`} role="status">
          {voiceError || action.error || action.message}
        </div>
      )}

      <footer className="live-control-dock">
        <div className="live-audibility">
          <span className={humanAudible && !muted ? 'is-live' : coaching ? 'is-private' : ''} />
          <div><strong>{coaching ? 'Private supervisor monitor' : humanAudible ? (muted ? 'You are muted' : 'Prospect can hear you') : listening ? 'Private monitor mode' : 'You are not audible'}</strong><span>{coaching ? 'Nobody on the call can hear you' : controller === 'ai' ? 'AI currently leads this call' : 'Human participation is logged'}</span></div>
        </div>
        <div className="live-primary-controls">
          {coaching ? (
            <>
              <form className="coach-cue-composer" onSubmit={sendCoachCue}><label htmlFor={`coach-cue-${call.id}`}>Private cue</label><input id={`coach-cue-${call.id}`} value={coachCue} maxLength={500} onChange={event => setCoachCue(event.target.value)} placeholder="Keep it brief and actionable…" /><button type="submit" className="control-primary" disabled={!coachCue.trim() || action.busy}>Send cue</button></form>
              <button type="button" onClick={onClose}><Icon>—</Icon><span>Leave monitor</span></button>
            </>
          ) : (
            <>
              {humanAudible && <button type="button" className={muted ? 'is-active' : ''} onClick={toggleMute}><Icon>{muted ? '×' : '⌁'}</Icon><span>{muted ? 'Unmute' : 'Mute'}</span></button>}
              {controller === 'ai' && <button type="button" className={listening ? 'is-active' : ''} disabled={action.busy} onClick={listen}><Icon>◉</Icon><span>{listening ? 'Stop monitor' : 'Monitor'}</span></button>}
              {controller === 'ai' && <button type="button" className="control-primary" disabled={action.busy || Boolean(session?.rep?.activeCallId && session.rep.activeCallId !== call.id)} onClick={takeover}><Icon>↗</Icon><span>Take over</span></button>}
              {!assisting && humanAudible && !['requested', 'accepted'].includes(staffTransfer.state) && <button type="button" onClick={openTransfer}><Icon>↗</Icon><span>Ask teammate</span></button>}
              {!assisting && staffTransfer.state === 'requested' && <button type="button" className="is-active" onClick={() => setShowTransfer(true)}><Icon>…</Icon><span>Waiting for {staffTransfer.toName || 'teammate'}</span></button>}
              {!assisting && staffTransfer.state === 'accepted' && <button type="button" className="control-primary" disabled={action.busy || !transferAudioReady} onClick={completeTransfer}><Icon>{transferAudioReady ? '↗' : '…'}</Icon><span>{transferAudioReady ? 'Complete handoff' : 'Teammate connecting…'}</span></button>}
              {(!assisting || staffTransfer.state === 'completed') && <button type="button" onClick={() => setShowWrapUp(true)}><Icon>✓</Icon><span>Wrap up</span></button>}
              {!terminal && (!assisting || staffTransfer.state === 'completed') && <button type="button" className="control-danger" disabled={action.busy} onClick={end}><Icon>×</Icon><span>End call</span></button>}
            </>
          )}
        </div>
        <div className="live-shortcut-hint"><kbd>Esc</kbd><span>minimize</span></div>
      </footer>

      {showTransfer && (
        <div className="transfer-sheet" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
          <button className="wrap-up-backdrop" type="button" tabIndex={-1} aria-label="Close staff handoff" onClick={() => setShowTransfer(false)} />
          <div className="transfer-card" ref={transferDialogRef} tabIndex={-1}>
            <div className="wrap-up-head">
              <div><span className="outbound-eyebrow">Warm handoff</span><h3 id="transfer-title">Bring in a teammate</h3><p>The prospect stays on this call. Introduce your teammate, share context verbally, then complete the transfer.</p></div>
              <button type="button" onClick={() => setShowTransfer(false)}>×</button>
            </div>
            {staffTransfer.state === 'requested' ? (
              <div className="transfer-waiting">
                <span className="transfer-pulse" />
                <div><strong>Waiting for {staffTransfer.toName || 'your teammate'}</strong><p>Keep leading the conversation. Nothing changes until they accept and join.</p></div>
                <button className="btn-admin" type="button" disabled={action.busy} onClick={cancelTransfer}>Cancel request</button>
              </div>
            ) : (
              <>
                <div className="transfer-agent-list" role="radiogroup" aria-label="Available teammates">
                  {transferAgents.map(agent => (
                    <button key={agent.uid} type="button" role="radio" aria-checked={transferToUid === agent.uid}
                      className={transferToUid === agent.uid ? 'is-selected' : ''} onClick={() => setTransferToUid(agent.uid)}>
                      <span className={`transfer-availability is-${agent.availability}`} />
                      <span><strong>{agent.name}</strong><small>{agent.role.replace(/_/g, ' ')} · {agent.availability === 'on_call' ? 'on another call' : 'available'}</small></span>
                      <i>{transferToUid === agent.uid ? '✓' : ''}</i>
                    </button>
                  ))}
                  {!action.busy && !transferAgents.length && <p className="admin-note">No other outbound staff are available.</p>}
                </div>
                <label className="wrap-up-field"><span>Private request note <small>(optional)</small></span><textarea rows={3} value={transferNote} onChange={event => setTransferNote(event.target.value)} placeholder="Example: Please help with pricing and implementation timing." /></label>
                <div className="transfer-safety"><strong>Safe handoff sequence</strong><span>1. Teammate accepts → 2. Both reps are audible → 3. Make a verbal introduction → 4. Complete handoff.</span></div>
                <div className="wrap-up-actions"><button className="btn-admin primary" type="button" disabled={!transferToUid || action.busy} onClick={requestTransfer}>{action.busy ? 'Sending…' : 'Request warm handoff'}</button><button className="btn-admin" type="button" onClick={() => setShowTransfer(false)}>Cancel</button></div>
              </>
            )}
          </div>
        </div>
      )}

      {showWrapUp && (
        <div className="wrap-up-sheet" role="dialog" aria-modal="true" aria-labelledby="wrap-up-title">
          <button className="wrap-up-backdrop" type="button" tabIndex={-1} aria-label="Close wrap-up" onClick={() => !terminal && setShowWrapUp(false)} />
          <div className="wrap-up-card" ref={wrapDialogRef} tabIndex={-1}>
            <div className="wrap-up-head"><div><span className="outbound-eyebrow">After-call work</span><h3 id="wrap-up-title">What happened on this call?</h3><p>The selected outcome controls lead creation, follow-up, reporting, and email wording.</p></div>{!terminal && <button type="button" onClick={() => setShowWrapUp(false)}>×</button>}</div>
            <div className="outcome-grid">
              {OUTCOMES.map(([value, label, help]) => <button key={value} type="button" className={outcome === value ? 'is-selected' : ''} onClick={() => setOutcome(value)}><strong>{label}</strong><span>{help}</span></button>)}
            </div>
            {needsFollowUp && <label className="wrap-up-field"><span>{outcome === 'booked_meeting' ? 'Meeting time' : 'Callback time'}</span><input type="datetime-local" value={followUpAt} onChange={event => setFollowUpAt(event.target.value)} /></label>}
            <label className="wrap-up-field"><span>Handoff summary</span><textarea rows={4} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Summarize needs, objections, commitments, and the next action…" /></label>
            <div className="wrap-up-impact">
              <strong>What happens next</strong>
              <span>{['connected', 'qualified', 'booked_meeting'].includes(outcome) ? 'A call-linked lead can be created and the notification will identify this as a verified conversation.' : outcome === 'do_not_call' ? 'Future calls will be suppressed and the call will end.' : 'The attempt will be recorded without sending a misleading new-lead email.'}</span>
            </div>
            <div className="wrap-up-actions"><button className="btn-admin primary" type="button" disabled={!outcome || action.busy || (needsFollowUp && !followUpAt)} onClick={saveOutcome}>{action.busy ? 'Saving…' : terminal ? 'Save outcome & finish' : 'Save outcome & end call'}</button>{!terminal && <button className="btn-admin" type="button" onClick={() => setShowWrapUp(false)}>Return to call</button>}</div>
          </div>
        </div>
      )}
    </div>
  );
}
