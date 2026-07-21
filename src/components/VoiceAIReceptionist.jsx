import { useEffect, useRef, useState } from 'react';

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

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function VoiceWaveform({ stream, active = false, compact = false }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const context = canvas.getContext('2d');
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    let audioContext;
    let analyser;
    let source;
    let frequencyData;
    let frame = 0;
    let phase = 0;

    if (stream && AudioContext) {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = .82;
      source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      frequencyData = new Uint8Array(analyser.frequencyBinCount);
    }

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
      context.strokeStyle = active ? 'rgba(255,255,255,.76)' : 'rgba(255,255,255,.24)';
      context.lineWidth = compact ? 1 : 1.25;
      context.lineCap = 'round';

      if (analyser && frequencyData) analyser.getByteFrequencyData(frequencyData);
      const bars = compact ? 34 : 52;
      const gap = width / bars;
      phase += .035;
      for (let index = 0; index < bars; index += 1) {
        const mirrored = Math.abs(index - (bars - 1) / 2) / (bars / 2);
        const sampleIndex = Math.min(frequencyData?.length - 1 || 0, Math.floor((index / bars) * (frequencyData?.length || 1)));
        const input = frequencyData ? frequencyData[sampleIndex] / 255 : 0;
        const idle = (Math.sin(index * .74 + phase) + 1) * .05 + .035;
        const energy = active ? Math.max(input * .92, idle) : idle;
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
    return () => {
      window.cancelAnimationFrame(frame);
      try { source?.disconnect(); } catch { /* already disconnected */ }
      audioContext?.close();
    };
  }, [active, compact, stream]);

  return <canvas className="voice-waveform" ref={canvasRef} aria-hidden="true" />;
}

export function VoiceReceptionistPreview({ onOpen }) {
  return <button className="voice-preview" type="button" onClick={onOpen} aria-label="Open Olivia, BiteSites' Voice AI sales agent">
    <span className="voice-preview-tools" aria-hidden="true"><ExpandIcon /><SettingsIcon /><RestartIcon /></span>
    <span className="voice-preview-center">
      <span className="voice-preview-mic"><MicIcon /></span>
      <span className="voice-preview-time">00:00</span>
      <VoiceWaveform compact />
      <span className="voice-preview-prompt">Click to speak with Olivia</span>
    </span>
    <span className="voice-preview-badge"><i /> Voice AI agent demo</span>
  </button>;
}

export function VoiceAIReceptionist({ open, onClose }) {
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState('');
  const shellRef = useRef(null);

  const stopSession = (nextStatus = 'idle') => {
    stream?.getTracks().forEach(track => track.stop());
    if (stream) window.dispatchEvent(new CustomEvent('bitesites:voice-agent-stop'));
    setStream(null);
    setElapsed(0);
    setError('');
    setStatus(nextStatus);
  };

  const startSession = async () => {
    if (status === 'requesting') return;
    if (status === 'listening') {
      stopSession();
      return;
    }

    setError('');
    setStatus('requesting');
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      setStream(nextStream);
      setStatus('listening');
      // GoHighLevel can be attached without changing the UI by listening for
      // this event and passing detail.stream to the voice-agent connection.
      window.dispatchEvent(new CustomEvent('bitesites:voice-agent-start', { detail: { stream: nextStream, agent: 'olivia' } }));
    } catch (requestError) {
      setStatus('error');
      setError(requestError?.name === 'NotAllowedError'
        ? 'Microphone access is blocked. Allow it in your browser, then try again.'
        : 'We could not start your microphone. Check your input and try again.');
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
    if (status !== 'listening') return undefined;
    const timer = window.setInterval(() => setElapsed(seconds => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => () => stream?.getTracks().forEach(track => track.stop()), [stream]);

  if (!open) return null;
  const listening = status === 'listening';
  const statusText = status === 'requesting' ? 'Connecting…' : listening ? 'Listening…' : status === 'error' ? 'Microphone unavailable' : 'Click to speak';

  return <aside className="voice-agent-shell" ref={shellRef} role="dialog" aria-modal="true" aria-labelledby="voice-agent-title" tabIndex="-1">
    <h2 id="voice-agent-title" className="sr-only">Talk with Olivia, BiteSites' Voice AI sales agent</h2>
    <div className="voice-agent-grain" aria-hidden="true" />
    <div className="voice-agent-tools">
      <button type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'} title={isFullscreen ? 'Exit full screen' : 'Full screen'}><ExpandIcon collapse={isFullscreen} /></button>
      <button type="button" className={settingsOpen ? 'active' : ''} onClick={() => setSettingsOpen(value => !value)} aria-expanded={settingsOpen} aria-controls="voice-agent-settings" aria-label="Voice settings" title="Voice settings"><SettingsIcon /></button>
      <button type="button" onClick={() => stopSession()} aria-label="Restart conversation" title="Restart conversation"><RestartIcon /></button>
    </div>
    <button className="voice-agent-close" type="button" onClick={() => { stopSession(); onClose(); }} aria-label="Close voice agent"><CloseIcon /></button>

    {settingsOpen && <div className="voice-agent-settings" id="voice-agent-settings">
      <p>Conversation settings</p>
      <dl><div><dt>Agent</dt><dd>Olivia</dd></div><div><dt>Specialty</dt><dd>Voice AI solutions</dd></div><div><dt>Connection</dt><dd>GoHighLevel ready</dd></div></dl>
      <small>The live GHL connection can attach to the existing start event.</small>
    </div>}

    <div className={`voice-agent-center ${listening ? 'is-listening' : ''}`}>
      <button className="voice-agent-core" type="button" onClick={startSession} aria-label={listening ? 'Stop listening' : 'Start talking to Olivia'} aria-pressed={listening}>
        <span className="voice-agent-halo" />
        {listening ? <span className="voice-agent-cube" /> : <span className="voice-agent-mic"><MicIcon muted={status === 'error'} /></span>}
      </button>
      <time className="voice-agent-time" dateTime={`PT${elapsed}S`}>{formatTime(elapsed)}</time>
      <VoiceWaveform stream={stream} active={listening} />
      <p className="voice-agent-status" aria-live="polite">{statusText}</p>
      {error && <p className="voice-agent-error">{error}</p>}
    </div>

    <div className="voice-agent-signoff"><span><i /> Olivia by BiteSites</span><small>Your browser will ask before the microphone turns on.</small></div>
  </aside>;
}
