// Browser preview of an agent draft, on ElevenLabs.
//
// The server compiles the draft and returns either the voice sample as audio,
// or a single-use link to the tool-free preview agent with the compiled prompt
// and voice. The ElevenLabs key never reaches this bundle, and a preview can
// never book, send or change anything.

import { outbound } from './data';

const SAMPLE_LIMIT_MS = 45_000;
const CONVERSATION_LIMIT_MS = 5 * 60 * 1000;

let activePreview = null;

export async function stopAgentPreview() {
  const preview = activePreview;
  if (!preview) return;
  activePreview = null;
  await preview.stop();
}

function playSample({ token, audioElement, controller, onState, onError, onComplete }) {
  const bytes = Uint8Array.from(atob(token.audioBase64), char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: token.mimeType || 'audio/mpeg' }));
  controller.cleanUp = () => {
    audioElement.pause();
    audioElement.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  audioElement.srcObject = null;
  audioElement.src = url;
  audioElement.onended = () => {
    onComplete();
    if (activePreview === controller) { activePreview = null; controller.stop(); }
  };
  onState('live');
  return audioElement.play().catch(error => {
    onError(`Your browser blocked preview audio: ${error?.message || 'playback failed'}`);
  });
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
  if (!['sample', 'conversation'].includes(mode)) throw new Error('Preview mode is not supported.');
  if (!audioElement) throw new Error('The preview audio player is unavailable.');

  await stopAgentPreview();
  onState('connecting');

  let stopped = false;
  let timer = null;
  const controller = {
    mode,
    cleanUp: () => {},
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      try { await controller.cleanUp(); } catch { /* already closed */ }
      onState('idle');
    }
  };
  activePreview = controller;

  try {
    if (mode === 'conversation') {
      if (!navigator?.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone.');
      // Ask for the mic before creating a session, so a blocked mic costs nothing.
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphone.getTracks().forEach(track => track.stop());
    }

    const token = await outbound.createAgentPreviewSession(profile, mode);
    if (stopped) throw new Error('The preview was stopped.');

    if (mode === 'sample') {
      if (!token?.audioBase64) throw new Error('The server did not return a voice sample.');
      await playSample({ token, audioElement, controller, onState, onError, onComplete });
    } else {
      if (!token?.signedUrl) throw new Error('The server did not return a preview link.');
      const { Conversation } = await import('@elevenlabs/client');
      const conversation = await Conversation.startSession({
        signedUrl: token.signedUrl,
        connectionType: 'websocket',
        overrides: {
          agent: { prompt: { prompt: token.prompt }, firstMessage: token.firstMessage || undefined },
          tts: { voiceId: token.voiceId }
        },
        onConnect: () => onState('live'),
        onDisconnect: () => {
          if (activePreview === controller) { activePreview = null; controller.stop(); }
        },
        onError: message => onError(String(message || 'The preview hit a problem.')),
        onMessage: ({ role, message }) => {
          onEvent({ role, message });
          const text = String(message || '').trim();
          if (text) onTranscript({ role: role === 'user' ? 'you' : 'agent', text });
        }
      });
      controller.cleanUp = () => conversation.endSession();
      if (stopped) await conversation.endSession();
    }

    timer = setTimeout(() => {
      if (activePreview !== controller) return;
      onError(mode === 'sample'
        ? 'The voice sample reached its 45-second preview limit.'
        : 'The test conversation ended after the five-minute preview limit.');
      activePreview = null;
      controller.stop();
    }, mode === 'sample' ? SAMPLE_LIMIT_MS : CONVERSATION_LIMIT_MS);
    return controller;
  } catch (error) {
    if (activePreview === controller) activePreview = null;
    await controller.stop();
    throw error;
  }
}
