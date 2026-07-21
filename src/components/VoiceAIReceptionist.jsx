import { useEffect, useRef, useState } from 'react';
import { endVoiceCall, isLiveState, loadVoiceAgent, observeVoiceState, startVoiceCall } from '../lib/ghl-voice';

function MicIcon({ muted = false }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75V6.75a3.75 3.75 0 0 0-7.5 0v4.75A3.75 3.75 0 0 0 12 15.25Z" />
    <path d="M5.75 11.25a6.25 6.25 0 0 0 12.5 0M12 17.5v3M9.25 20.5h5.5" />
    {muted && <path d="m4 4 16 16" />}
  </svg>;
}

function ExpandIcon({ collapse = false }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {collapse
      ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
      : <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />}
  </svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.91 2.91-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.38 1.06V21h-4.12v-.08A1.65 1.65 0 0 0 8.4 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06-2.91-2.91.06-.06A1.65 1.65 0 0 0 4 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.06-.38H2.2V9.5h.08A1.65 1.65 0 0 0 4 8.4a1.65 1.65 0 0 0-.33-1.82l-.06-.06 2.91-2.91.06.06A1.65 1.65 0 0 0 8.4 4a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .38-1.06V2.2h4.12v.08A1.65 1.65 0 0 0 15 4a1.65 1.65 0 0 0 1.82-.33l.06-.06 2.91 2.91-.06.06A1.65 1.65 0 0 0 19.4 8.4c.16.4.36.73.6 1 .28.3.64.43 1.06.38h.08v4.12h-.08A1.65 1.65 0 0 0 19.4 15Z" /></svg>;
}

function RestartIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 9A8 8 0 1 1 4 14" /><path d="M4.5 4.5V9H9" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

// Byte's face is drawn rather than illustrated so it can blink, bob, and pulse
// its little headset waves next to Bit without shipping another asset.
export function ByteAvatar({ className = '', decorative = true, label = 'Byte, the BiteSites voice receptionist' }) {
  return <span
    className={`byte-avatar ${className}`.trim()}
    role={decorative ? undefined : 'img'}
    aria-hidden={decorative ? 'true' : undefined}
    aria-label={decorative ? undefined : label}
  >
    <svg viewBox="0 0 64 64">
      <g className="byte-waves">
        <path d="M53 26a12 12 0 0 1 0 12" />
        <path d="M57.5 22a17.5 17.5 0 0 1 0 20" />
      </g>
      <path className="byte-band" d="M14 34a18 18 0 0 1 36 0" />
      <rect className="byte-cup" x="7" y="30" width="10" height="16" rx="5" />
      <rect className="byte-cup" x="47" y="30" width="10" height="16" rx="5" />
      <path className="byte-boom" d="M12 45c0 6.5 4.6 10 9.5 10.4" />
      <circle className="byte-mic" cx="23" cy="55" r="3.1" />
      <rect className="byte-face" x="15" y="18" width="34" height="33" rx="14" />
      <g className="byte-eyes"><ellipse cx="26" cy="33" rx="3" ry="3.7" /><ellipse cx="38" cy="33" rx="3" ry="3.7" /></g>
      <g className="byte-blush"><ellipse cx="20.5" cy="39.5" rx="3.2" ry="2" /><ellipse cx="43.5" cy="39.5" rx="3.2" ry="2" /></g>
      <path className="byte-smile" d="M28.4 40.4c1.7 2.3 5.5 2.3 7.2 0" />
      <circle className="byte-spark" cx="49.5" cy="16.5" r="2.2" />
    </svg>
  </span>;
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// The GoHighLevel agent holds the microphone for the duration of a call, so the
// waveform is driven by the reported call state rather than a second capture.
function VoiceWaveform({ intensity = 0, compact = false }) {
  const canvasRef = useRef(null);
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const context = canvas.getContext('2d');
    let frame = 0;
    let phase = 0;
    let level = 0;

    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      level += (intensityRef.current - level) * .07;
      context.strokeStyle = `rgba(255,255,255,${(.24 + level * .52).toFixed(3)})`;
      context.lineWidth = compact ? 1 : 1.25;
      context.lineCap = 'round';

      const bars = compact ? 34 : 52;
      const gap = width / bars;
      phase += .035;
      for (let index = 0; index < bars; index += 1) {
        const mirrored = Math.abs(index - (bars - 1) / 2) / (bars / 2);
        const idle = (Math.sin(index * .74 + phase) + 1) * .05 + .035;
        const voice = (Math.sin(index * 2.31 - phase * 1.7) + Math.sin(index * .53 + phase * 2.4)) * .18 + .42;
        const energy = idle + level * Math.max(0, voice);
        const barHeight = Math.max(2, energy * height * (1 - mirrored * .28));
        const x = gap * index + gap / 2;
        context.beginPath();
        context.moveTo(x, height / 2 - barHeight / 2);
        context.lineTo(x, height / 2 + barHeight / 2);
        context.stroke();
      }

      frame = window.requestAnimationFrame(draw);
    };

    draw();
    return () => window.cancelAnimationFrame(frame);
  }, [compact]);

  return <canvas className="voice-waveform" ref={canvasRef} aria-hidden="true" />;
}

export function VoiceReceptionistPreview({ onOpen }) {
  // Warm the voice agent up on intent so the call starts as soon as it opens.
  const warm = () => { loadVoiceAgent().catch(() => { /* surfaced when opened */ }); };

  return <button className="voice-preview" type="button" onClick={onOpen} onPointerEnter={warm} onFocus={warm} aria-label="Open Byte, BiteSites' Voice AI sales agent">
    <span className="voice-preview-tools" aria-hidden="true"><ExpandIcon /><SettingsIcon /><RestartIcon /></span>
    <span className="voice-preview-center">
      <span className="voice-preview-mic"><MicIcon /></span>
      <span className="voice-preview-time">00:00</span>
      <VoiceWaveform compact />
      <span className="voice-preview-prompt">Click to speak with Byte</span>
    </span>
    <span className="voice-preview-badge"><i /> Voice AI agent demo</span>
  </button>;
}

const STATUS_TEXT = {
  loading: 'Waking Byte…',
  idle: 'Click to speak',
  connecting: 'Connecting…',
  listening: 'Listening…',
  speaking: 'Byte is speaking…',
  ended: 'Call ended — click to talk again',
  unavailable: 'Voice agent unavailable',
};

export function VoiceAIReceptionist({ open, onClose }) {
  const [callState, setCallState] = useState('loading');
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState('');
  const shellRef = useRef(null);
  const sawConnectingRef = useRef(false);

  const live = isLiveState(callState);
  const connected = callState === 'listening' || callState === 'speaking';

  const stopSession = () => {
    setStarting(false);
    setElapsed(0);
    setError('');
    endVoiceCall();
  };

  const startSession = async () => {
    if (starting || callState === 'connecting') return;
    if (live) {
      stopSession();
      return;
    }

    setError('');
    setStarting(true);
    setElapsed(0);
    sawConnectingRef.current = false;
    try {
      await startVoiceCall();
    } catch {
      setStarting(false);
      setError('We could not reach the voice agent. Please refresh and try again.');
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shellRef.current?.requestFullscreen();
    } catch { /* fullscreen can be unavailable inside embedded browsers */ }
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => { if (event.key === 'Escape' && !document.fullscreenElement) onClose(); };
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.body.classList.add('voice-agent-open');
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.requestAnimationFrame(() => shellRef.current?.focus({ preventScroll: true }));
    return () => {
      document.body.classList.remove('voice-agent-open');
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return undefined;
    return observeVoiceState(setCallState);
  }, [open]);

  // The widget drops back to idle when it cannot connect — a denied microphone
  // being by far the most common reason — so report that back in our own UI.
  useEffect(() => {
    if (callState === 'connecting') sawConnectingRef.current = true;
    if (connected) {
      setStarting(false);
      return;
    }
    if (callState === 'unavailable') {
      setStarting(false);
      setError('The voice agent is unavailable right now. Please try again in a moment.');
      return;
    }
    if (starting && callState === 'idle' && sawConnectingRef.current) {
      setStarting(false);
      sawConnectingRef.current = false;
      setError('The call could not start. Check that your browser allows microphone access, then try again.');
    }
  }, [callState, connected, starting]);

  useEffect(() => {
    if (!connected) return undefined;
    const timer = window.setInterval(() => setElapsed(seconds => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [connected]);

  // Never leave a call running behind a closed panel.
  useEffect(() => {
    if (!open) return undefined;
    return () => { endVoiceCall(); };
  }, [open]);

  if (!open) return null;
  const busy = starting || live;
  const statusText = error ? 'Call not connected' : STATUS_TEXT[starting && callState === 'idle' ? 'connecting' : callState] ?? STATUS_TEXT.idle;
  const intensity = callState === 'speaking' ? 1 : callState === 'listening' ? .45 : callState === 'connecting' || starting ? .2 : 0;

  return <aside className="voice-agent-shell" ref={shellRef} role="dialog" aria-modal="true" aria-labelledby="voice-agent-title" tabIndex="-1">
    <h2 id="voice-agent-title" className="sr-only">Talk with Byte, BiteSites' Voice AI sales agent</h2>
    <div className="voice-agent-grain" aria-hidden="true" />
    <div className="voice-agent-tools">
      <button type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'} title={isFullscreen ? 'Exit full screen' : 'Full screen'}><ExpandIcon collapse={isFullscreen} /></button>
      <button type="button" className={settingsOpen ? 'active' : ''} onClick={() => setSettingsOpen(value => !value)} aria-expanded={settingsOpen} aria-controls="voice-agent-settings" aria-label="Voice settings" title="Voice settings"><SettingsIcon /></button>
      <button type="button" onClick={() => stopSession()} aria-label="Restart conversation" title="Restart conversation"><RestartIcon /></button>
    </div>
    <button className="voice-agent-close" type="button" onClick={() => { stopSession(); onClose(); }} aria-label="Close voice agent"><CloseIcon /></button>

    {settingsOpen && <div className="voice-agent-settings" id="voice-agent-settings">
      <p>Conversation settings</p>
      <dl><div><dt>Agent</dt><dd>Byte</dd></div><div><dt>Specialty</dt><dd>Voice AI solutions</dd></div><div><dt>Connection</dt><dd>{callState === 'unavailable' ? 'Offline' : callState === 'loading' ? 'Connecting' : 'GoHighLevel live'}</dd></div></dl>
      <small>Calls run on the BiteSites GoHighLevel voice agent.</small>
    </div>}

    <div className={`voice-agent-center ${connected ? 'is-listening' : ''}`}>
      <button className="voice-agent-core" type="button" onClick={startSession} aria-label={live ? 'End the call' : 'Start talking to Byte'} aria-pressed={live}>
        <span className="voice-agent-halo" />
        {busy ? <span className="voice-agent-cube" /> : <span className="voice-agent-mic"><MicIcon muted={Boolean(error)} /></span>}
      </button>
      <time className="voice-agent-time" dateTime={`PT${elapsed}S`}>{formatTime(elapsed)}</time>
      <VoiceWaveform intensity={intensity} />
      <p className="voice-agent-status" aria-live="polite">{statusText}</p>
      {error && <p className="voice-agent-error">{error}</p>}
    </div>

    <div className="voice-agent-signoff"><span><i /> Byte by BiteSites</span><small>Your browser will ask before the microphone turns on.</small></div>
  </aside>;
}
