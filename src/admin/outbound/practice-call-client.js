// Rep practice calls with a locked ElevenLabs prospect.
//
// The server hands back a single-use call link. The API key, prompt and scoring
// never reach this bundle, and the transcript shown here is display only: the
// server scores the copy ElevenLabs recorded.

import { outbound } from './data';

export async function startPracticeCall({
  accountId,
  onState = () => {},
  onTranscript = () => {},
  onError = () => {},
  onSession = () => {}
}) {
  if (!accountId) throw new Error('Choose a seller account for practice.');
  if (!navigator?.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone.');
  onState('connecting');
  try {
    // Ask for the mic first, so a blocked mic doesn't use up a daily attempt.
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    microphone.getTracks().forEach(track => track.stop());

    const session = await outbound.createRepTrainingSession(accountId);
    if (!session?.signedUrl) throw new Error('The server did not return a practice call.');
    onSession({ attemptId: session.attemptId, scenario: session.scenario });

    const { Conversation } = await import('@elevenlabs/client');
    const conversation = await Conversation.startSession({
      signedUrl: session.signedUrl,
      connectionType: 'websocket',
      onConnect: () => onState('live'),
      onDisconnect: () => onState('idle'),
      onError: message => onError(String(message || 'The practice call hit a problem.')),
      onMessage: ({ role, message }) => {
        const text = String(message || '').trim();
        if (text) onTranscript({ role: role === 'user' ? 'you' : 'agent', text });
      }
    });
    return { stop: () => conversation.endSession() };
  } catch (error) {
    onState('idle');
    throw error;
  }
}
