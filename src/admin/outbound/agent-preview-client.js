// Browser-only OpenAI Realtime preview transport.
//
// The server returns a short-lived client secret scoped to the already-compiled
// draft. The standard OpenAI API key never exists in this bundle.

import { outbound } from './data';

const SAMPLE_INSTRUCTION = 'Deliver the configured voice sample now. Follow the preview sandbox instructions exactly.';
const CONVERSATION_INSTRUCTION = 'Begin the configured test conversation now with a brief greeting. The operator will role-play as the prospect.';

let activePreview = null;

const errorMessage = value => {
  if (typeof value === 'string') return value;
  return value?.message || value?.error?.message || 'The realtime preview reported an error.';
};

function waitForDataChannel(channel, peer, timeoutMs = 15000) {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('The agent preview took too long to connect.')), timeoutMs);
    const finish = error => {
      clearTimeout(timer);
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      peer.removeEventListener('connectionstatechange', onConnection);
      if (error) reject(error); else resolve();
    };
    const onOpen = () => finish();
    const onClose = () => finish(new Error('The agent preview closed before it connected.'));
    const onConnection = () => {
      if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
        finish(new Error('The agent preview could not establish an audio connection.'));
      }
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    peer.addEventListener('connectionstatechange', onConnection);
  });
}

export function previewTranscriptEvent(event) {
  if (event?.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
    return { role: 'you', text: String(event.transcript).trim() };
  }
  if (event?.type === 'response.output_audio_transcript.done' && event.transcript) {
    return { role: 'agent', text: String(event.transcript).trim() };
  }
  return null;
}

export async function stopAgentPreview() {
  const preview = activePreview;
  if (!preview) return;
  activePreview = null;
  await preview.stop();
}

export async function startAgentPreview({
  profile,
  mode,
  audioElement,
  onState = () => {},
  onEvent = () => {},
  onTranscript = () => {},
  onError = () => {},
  onComplete = () => {}
}) {
  if (!['sample', 'conversation'].includes(mode)) throw new Error('Preview mode must be sample or conversation.');
  if (!audioElement) throw new Error('The preview audio player is unavailable.');
  if (typeof RTCPeerConnection === 'undefined') throw new Error('This browser does not support WebRTC audio previews.');

  await stopAgentPreview();
  onState('connecting');

  const abortController = new AbortController();
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel('oai-events');
  let microphone = null;
  let completeTimer = null;
  let sessionTimer = null;
  let stopped = false;

  const controller = {
    mode,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (completeTimer) clearTimeout(completeTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      abortController.abort();
      try { channel.close(); } catch { /* already closed */ }
      try { peer.close(); } catch { /* already closed */ }
      microphone?.getTracks().forEach(track => track.stop());
      if (audioElement.srcObject) audioElement.srcObject = null;
      onState('idle');
    }
  };
  activePreview = controller;

  peer.addEventListener('track', event => {
    audioElement.srcObject = event.streams[0];
    audioElement.play().catch(error => onError(`Your browser blocked preview audio: ${errorMessage(error)}`));
  });
  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'connected') onState('live');
    if (peer.connectionState === 'failed') {
      onError('The realtime audio connection failed.');
      if (activePreview === controller) {
        activePreview = null;
        controller.stop();
      }
    }
  });
  channel.addEventListener('close', () => {
    if (!stopped && activePreview === controller) {
      activePreview = null;
      controller.stop();
    }
  });
  channel.addEventListener('message', message => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    onEvent(event);
    const transcript = previewTranscriptEvent(event);
    if (transcript?.text) onTranscript(transcript);
    if (event.type === 'error') onError(errorMessage(event.error));
    if (mode === 'sample' && event.type === 'response.done') {
      onComplete();
      completeTimer = setTimeout(() => {
        if (activePreview === controller) {
          activePreview = null;
          controller.stop();
        }
      }, 1200);
    }
  });

  try {
    if (mode === 'conversation') {
      if (!navigator?.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone.');
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      microphone.getAudioTracks().forEach(track => peer.addTrack(track, microphone));
    } else {
      peer.addTransceiver('audio', { direction: 'recvonly' });
    }

    const token = await outbound.createAgentPreviewSession(profile, mode);
    if (!token?.clientSecret) throw new Error('The server did not return a preview credential.');

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.clientSecret}`,
        'Content-Type': 'application/sdp'
      },
      body: offer.sdp,
      signal: abortController.signal
    });
    const answerSdp = await response.text();
    if (!response.ok) throw new Error(`OpenAI could not connect the preview (HTTP ${response.status}).`);
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await waitForDataChannel(channel, peer);
    if (stopped) throw new Error('The preview was stopped.');

    channel.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: mode === 'sample' ? SAMPLE_INSTRUCTION : CONVERSATION_INSTRUCTION,
        metadata: { response_purpose: mode === 'sample' ? 'voice_sample' : 'preview_greeting' }
      }
    }));
    sessionTimer = setTimeout(() => {
      if (activePreview !== controller) return;
      onError(mode === 'sample'
        ? 'The voice sample reached its 45-second preview limit.'
        : 'The test conversation ended after the five-minute preview limit.');
      activePreview = null;
      controller.stop();
    }, mode === 'sample' ? 45000 : 5 * 60 * 1000);
    onState('live');
    return controller;
  } catch (error) {
    if (activePreview === controller) activePreview = null;
    await controller.stop();
    if (error?.name === 'AbortError') throw new Error('The preview was stopped.');
    throw error;
  }
}
