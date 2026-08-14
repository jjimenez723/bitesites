import React, { useEffect, useMemo, useRef, useState } from 'react';
import { outbound, toDate, useAction } from './data';
import { formatPhone, formatDuration } from './SourceBadge';
import LiveTranscript from './LiveTranscript';
import { hybridVoiceState, joinHybridCall, leaveHybridVoice } from './voice-client';

const CONTROLLER_LABELS = {
  human: 'YOU',
  ai: 'AI',
  transitioning: 'HANDOFF',
  unassigned: 'ROUTING',
  none: 'ENDED'
};

function liveSeconds(call, now) {
  if (Number(call.durationSec) > 0 && ['completed', 'cancelled', 'failed'].includes(call.status)) return Number(call.durationSec);
  const start = toDate(call.connectedAt || call.answeredAt || call.startedAt);
  return start ? Math.max(0, Math.floor((now - start.getTime()) / 1000)) : 0;
}

export default function HybridCallCard({ call, session, target, onDisposition, onEnter }) {
  const action = useAction();
  const [now, setNow] = useState(Date.now());
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const joiningRef = useRef(false);
  const controller = call?.control?.controller || 'unassigned';
  const terminal = ['completed', 'cancelled', 'failed'].includes(call?.status);
  const humanRequested = call?.handoff?.requestedBy === 'prospect'
    && ['requested', 'queued', 'announcing', 'joining_human'].includes(call?.handoff?.state);

  useEffect(() => {
    if (terminal) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);

  useEffect(() => () => {
    if (listening) {
      leaveHybridVoice();
      outbound.stopListen(call.id).catch(() => {});
    }
  }, [call.id, listening]);

  /**
   * The server owns call assignment. Once a call is assigned to this rep, join
   * that exact conference. For smooth handoff we wait for `joining_human`, which
   * is written only after OpenAI reports that the handoff sentence's SIP audio
   * buffer has fully drained.
   */
  useEffect(() => {
    const repOwnsCall = session?.rep?.activeCallId === call.id;
    const shouldJoinInitialHuman = controller === 'human' && repOwnsCall;
    const shouldJoinHandoff = controller === 'transitioning'
      && call?.handoff?.state === 'joining_human' && repOwnsCall;
    if ((!shouldJoinInitialHuman && !shouldJoinHandoff) || terminal || joiningRef.current) return;

    const voice = hybridVoiceState();
    if (voice.connected && voice.callId === call.id && voice.mode === 'human') return;

    joiningRef.current = true;
    setVoiceError('');
    joinHybridCall(call.id, 'human')
      .catch(error => {
        console.error('[hybrid-voice] automatic human join failed', error);
        setVoiceError(error?.message || 'Could not connect your browser audio to this call.');
      })
      .finally(() => { joiningRef.current = false; });
  }, [call.id, call?.handoff?.state, controller, session?.rep?.activeCallId, terminal]);

  useEffect(() => {
    if (!terminal) return;
    const voice = hybridVoiceState();
    if (voice.callId === call.id) leaveHybridVoice();
  }, [call.id, terminal]);

  const displayName = useMemo(() =>
    call.displayName || call.companyName || call.prospectName || call.leadName
      || (call.prospectId ? `Prospect ${call.prospectId.slice(0, 8)}` : call.leadId ? `Lead ${call.leadId.slice(0, 8)}` : 'Outbound call'),
  [call]);

  const phone = call.phoneE164 || target?.phoneE164 || '';
  const duration = formatDuration(liveSeconds(call, now));

  const listen = async () => {
    onEnter?.(call);
    if (listening) {
      leaveHybridVoice();
      await action.run(() => outbound.stopListen(call.id), 'Listen mode ended.');
      setListening(false);
      return;
    }
    const reserved = await action.run(() => outbound.beginListen(call.id), '');
    if (!reserved) return;
    try {
      await joinHybridCall(call.id, 'listen');
      setListening(true);
    } catch (error) {
      await outbound.stopListen(call.id).catch(() => {});
      setVoiceError(error?.message || 'Could not enter listen mode.');
    }
  };

  const takeover = async () => {
    onEnter?.(call);
    if (listening) {
      leaveHybridVoice();
      await outbound.stopListen(call.id).catch(() => {});
      setListening(false);
    }
    // Do not join yet. The state-driven effect above waits until the AI has
    // actually finished the configured handoff sentence.
    await action.run(() => outbound.requestTakeover(call.id), 'Takeover requested.');
  };

  const endCall = async () => {
    leaveHybridVoice();
    setListening(false);
    await action.run(() => outbound.endHybridCall(call.id), 'Call ended.');
  };

  const dnc = async () => {
    leaveHybridVoice();
    setListening(false);
    await action.run(() => outbound.dncHybridCall(call.id), 'Added to Do Not Call.');
  };

  return (
    <article className={`hybrid-call-card controller-${controller} ${humanRequested ? 'human-requested' : ''}`}>
      <div className="hybrid-call-head">
        <div>
          <div className="hybrid-call-title-row">
            <strong>{displayName}</strong>
            {humanRequested && <span className="pill danger">Human requested</span>}
          </div>
          <div className="outbound-leg-meta">
            {phone ? formatPhone(phone) : 'Phone unavailable'} · {duration}
          </div>
        </div>
        <span className={`hybrid-controller controller-${controller}`}>
          {CONTROLLER_LABELS[controller] || String(controller).toUpperCase()}
        </span>
      </div>

      {controller === 'ai' && <LiveTranscript callId={call.id} compact />}
      {controller === 'human' && (
        <p className="admin-note hybrid-you-note">You are speaking with this prospect.</p>
      )}
      {controller === 'transitioning' && (
        <p className="admin-note">
          {call?.handoff?.state === 'joining_human'
            ? 'The AI introduction is complete. Connecting your microphone now…'
            : 'AI is introducing you. Your microphone stays out of the call until the introduction finishes…'}
        </p>
      )}
      {controller === 'unassigned' && !terminal && (
        <p className="admin-note">{call.status === 'ringing' ? 'Ringing…' : 'Waiting for answer classification…'}</p>
      )}

      {voiceError && <p className="admin-error hybrid-action-message">{voiceError}</p>}
      {action.error && <p className="admin-error hybrid-action-message">{action.error}</p>}
      {action.message && <p className="admin-note hybrid-action-message">{action.message}</p>}

      {!terminal && (
        <div className="hybrid-call-actions">
          {controller === 'ai' && (
            <>
              <button className={`btn-admin ${listening ? 'primary' : ''}`} type="button" disabled={action.busy} onClick={listen}>
                {listening ? 'Stop Listening' : 'Listen'}
              </button>
              <button className="btn-admin primary" type="button"
                disabled={action.busy || Boolean(session?.rep?.activeCallId && session.rep.activeCallId !== call.id)}
                onClick={takeover}>
                Take Over
              </button>
            </>
          )}
          {controller !== 'ai' && (
            <button className="btn-admin primary" type="button" onClick={() => onEnter?.(call)}>Open live workspace</button>
          )}
          <button className="btn-admin" type="button" disabled={action.busy} onClick={endCall}>End Call</button>
          <button className="btn-admin danger" type="button" disabled={action.busy} onClick={dnc}>Add to Do Not Call</button>
        </div>
      )}

      {controller === 'human' && !terminal && onDisposition && (
        <div className="hybrid-quick-dispositions">
          <button className="btn-admin" type="button" onClick={() => onDisposition(call, 'not_interested')}>Not interested</button>
          <button className="btn-admin" type="button" onClick={() => onDisposition(call, 'call_later')}>Call later</button>
          <button className="btn-admin primary" type="button" onClick={() => onDisposition(call, 'booked_meeting')}>Booked meeting</button>
        </div>
      )}
    </article>
  );
}
