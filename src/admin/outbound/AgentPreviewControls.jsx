import React, { useEffect, useRef, useState } from 'react';

import { startAgentPreview, stopAgentPreview } from './agent-preview-client';

const STATUS_COPY = {
  connecting: 'Connecting secure browser audio…',
  live: 'Live preview',
  idle: 'Ready to preview'
};

export default function AgentPreviewControls({ profile, disabled = false }) {
  const audioRef = useRef(null);
  const mountedRef = useRef(true);
  const [mode, setMode] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopAgentPreview().catch(() => {});
    };
  }, []);

  const updateState = next => {
    if (!mountedRef.current) return;
    setStatus(next);
    if (next === 'idle') setMode('');
  };

  const stop = async () => {
    await stopAgentPreview();
    if (!mountedRef.current) return;
    setMode('');
    setStatus('idle');
  };

  const start = async nextMode => {
    setError('');
    setTranscript([]);
    setMode(nextMode);
    setStatus('connecting');
    try {
      await startAgentPreview({
        profile,
        mode: nextMode,
        audioElement: audioRef.current,
        onState: updateState,
        onError: message => { if (mountedRef.current) setError(message); },
        onTranscript: entry => {
          if (!mountedRef.current) return;
          setTranscript(current => [...current, entry].slice(-8));
        }
      });
    } catch (previewError) {
      if (!mountedRef.current) return;
      setMode('');
      setStatus('idle');
      setError(previewError?.message || 'Could not start the agent preview.');
    }
  };

  const busy = status === 'connecting';
  const live = status === 'live';

  return (
    <section className={`hybrid-agent-preview state-${status}`} aria-label="Agent audio preview">
      <audio ref={audioRef} autoPlay playsInline />
      <div className="hybrid-agent-preview-head">
        <div>
          <div className="hybrid-agent-preview-title">
            <span className={`hybrid-preview-indicator ${live ? 'is-live' : ''}`} aria-hidden="true">
              <i /><i /><i />
            </span>
            <strong>Hear this draft</strong>
          </div>
          <p>Uses the unsaved settings above. No Twilio call, campaign target, or production action is created.</p>
        </div>
        <span className={`pill ${live ? 'running' : ''}`}><i />{STATUS_COPY[status] || STATUS_COPY.idle}</span>
      </div>

      <div className="hybrid-agent-preview-actions">
        <button className="btn-admin" type="button" disabled={disabled || busy}
          onClick={() => mode === 'sample' ? stop() : start('sample')}>
          {mode === 'sample' ? 'Stop sample' : 'Play voice sample'}
        </button>
        <button className="btn-admin primary" type="button" disabled={disabled || busy}
          onClick={() => mode === 'conversation' ? stop() : start('conversation')}>
          {mode === 'conversation' ? 'End test conversation' : 'Test conversation'}
        </button>
        <span className="hybrid-preview-privacy">
          {mode === 'conversation' ? 'Microphone on · browser preview only' : 'A microphone is requested only for Test conversation.'}
        </span>
      </div>

      {error && <p className="admin-error hybrid-preview-error">{error}</p>}

      {transcript.length > 0 && (
        <div className="hybrid-preview-transcript" aria-live="polite">
          {transcript.map((entry, index) => (
            <div key={`${entry.role}-${index}`} className={`role-${entry.role}`}>
              <strong>{entry.role === 'agent' ? 'Agent' : 'You'}</strong>
              <span>{entry.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
