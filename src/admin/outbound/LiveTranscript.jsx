import React, { useEffect, useRef } from 'react';
import { useCallTurns } from './data';

const LABELS = {
  prospect: 'Prospect',
  ai: 'AI',
  human: 'You',
  system: 'System'
};

export default function LiveTranscript({ callId, compact = false, demoTurns = null, humanLabel = 'You' }) {
  const live = useCallTurns(callId);
  const rows = demoTurns || live.rows;
  const loading = demoTurns ? false : live.loading;
  const error = demoTurns ? null : live.error;
  const endRef = useRef(null);

  useEffect(() => {
    if (!compact) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [rows.length, compact]);

  if (!callId) return null;
  if (loading && !rows.length) return <p className="admin-note">Connecting transcript…</p>;
  if (error) return <p className="admin-error">{error}</p>;
  if (!rows.length) return <p className="admin-note">Transcript will appear as the AI conversation begins.</p>;

  const visible = compact ? rows.slice(-4) : rows;
  return (
    <div className={`hybrid-transcript ${compact ? 'is-compact' : ''}`} aria-live="polite">
      {visible.map(turn => (
        <div key={turn.id} className={`hybrid-turn speaker-${turn.speaker || 'system'}`}>
          <span className="hybrid-turn-speaker">{turn.speaker === 'human' ? humanLabel : LABELS[turn.speaker] || turn.speaker || 'System'}</span>
          <span className="hybrid-turn-text">{turn.text}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
