import React, { useEffect, useRef, useState } from 'react';
import { pickVoice, speechSupported } from './lesson-audio';

const SPEEDS = [
  { rate: 0.85, label: 'Slower' },
  { rate: 1, label: 'Normal' },
  { rate: 1.2, label: 'Faster' }
];

/**
 * Listen button for a lesson. Speaks `lines` one at a time with the device's
 * voice and reports the line being read, so the lesson can highlight it.
 * Stops on its own when the lesson changes or the screen closes.
 */
export default function LessonAudio({ lines, onLine = () => {} }) {
  const supported = speechSupported();
  const [status, setStatus] = useState('idle'); // idle | playing | paused
  const [speed, setSpeed] = useState(1);
  const indexRef = useRef(0);
  const runRef = useRef(0);
  const voiceRef = useRef(null);
  const linesKey = lines.map(line => line.id).join('|');

  useEffect(() => {
    if (!supported) return undefined;
    const load = () => { voiceRef.current = pickVoice(window.speechSynthesis.getVoices()); };
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, [supported]);

  const halt = () => {
    runRef.current += 1;
    if (supported) window.speechSynthesis.cancel();
  };

  // A new lesson (or leaving the page) stops the reading and starts over.
  useEffect(() => {
    indexRef.current = 0;
    setStatus('idle');
    onLine('');
    return halt;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  const speakFrom = (start, rate = speed) => {
    halt();
    const run = runRef.current;
    const next = index => {
      if (run !== runRef.current) return;
      if (index >= lines.length) {
        indexRef.current = 0;
        setStatus('idle');
        onLine('');
        return;
      }
      indexRef.current = index;
      onLine(lines[index].id);
      const utterance = new window.SpeechSynthesisUtterance(lines[index].spoken);
      if (voiceRef.current) utterance.voice = voiceRef.current;
      utterance.lang = voiceRef.current?.lang || 'en-US';
      utterance.rate = rate;
      utterance.onend = () => next(index + 1);
      utterance.onerror = event => {
        if (run !== runRef.current || event.error === 'interrupted' || event.error === 'canceled') return;
        setStatus('idle');
        onLine('');
      };
      window.speechSynthesis.speak(utterance);
    };
    setStatus('playing');
    next(start);
  };

  const pause = () => { halt(); setStatus('paused'); };
  const stop = () => { halt(); indexRef.current = 0; setStatus('idle'); onLine(''); };
  const changeSpeed = rate => {
    setSpeed(rate);
    if (status === 'playing') speakFrom(indexRef.current, rate);
  };

  if (!supported) {
    return <div className="lesson-audio is-unsupported" role="note">Audio isn’t available in this browser.</div>;
  }

  return <div className="lesson-audio" role="group" aria-label="Listen to this lesson">
    {status === 'playing'
      ? <button className="btn-admin lesson-audio-main" type="button" onClick={pause} aria-label="Pause the lesson audio">
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor" /></svg>
        Pause
      </button>
      : <button className="btn-admin primary lesson-audio-main" type="button"
          onClick={() => speakFrom(status === 'paused' ? indexRef.current : 0)}
          aria-label={status === 'paused' ? 'Resume the lesson audio' : 'Listen to this lesson'}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /></svg>
        {status === 'paused' ? 'Resume' : 'Listen'}
      </button>}
    {status !== 'idle' && <button className="btn-admin lesson-audio-stop" type="button" onClick={stop} aria-label="Stop the lesson audio">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" /></svg>
    </button>}
    <select className="lesson-audio-speed" value={speed} aria-label="Reading speed" onChange={event => changeSpeed(Number(event.target.value))}>
      {SPEEDS.map(option => <option key={option.rate} value={option.rate}>{option.label}</option>)}
    </select>
    <span className="sr-only" aria-live="polite">{status === 'playing' ? 'Reading the lesson aloud.' : status === 'paused' ? 'Paused.' : ''}</span>
  </div>;
}
