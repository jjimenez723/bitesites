import React, { useState } from 'react';
import { joinHybridCall, prepareHybridVoice } from './voice-client';
import { useHybridVoice } from './use-hybrid-voice';

export default function CallAudioStatus({ callId, mode = 'human' }) {
  const voice = useHybridVoice();
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  if (voice.callId === callId && voice.mode === mode && voice.connected) return null;
  const connecting = preparing || (voice.callId === callId && voice.connecting);
  const reconnect = async () => {
    setError('');
    setPreparing(true);
    try { await prepareHybridVoice(); await joinHybridCall(callId, mode); }
    catch (failure) { setError(failure?.message || 'Could not connect audio.'); }
    finally { setPreparing(false); }
  };
  return <div className="admin-note" role="status">
    <p>{error || (voice.callId === callId && voice.error) || (connecting ? 'Connecting call audio…' : 'Your call audio is disconnected.')}</p>
    <button className="btn-admin primary" type="button" disabled={connecting} onClick={reconnect}>
      {connecting ? 'Connecting audio…' : 'Reconnect audio'}
    </button>
  </div>;
}
