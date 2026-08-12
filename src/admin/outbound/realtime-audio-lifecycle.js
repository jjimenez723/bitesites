export const MAX_RESPONSE_CONTINUATIONS = 2;

export const CONTINUE_TRUNCATED_RESPONSE_INSTRUCTION = [
  'Continue immediately from the exact point where the previous response stopped.',
  'Finish the current sentence without repeating words that were already spoken, then complete the reply concisely.'
].join(' ');

export function realtimeResponseOutcome(event) {
  if (event?.type !== 'response.done' || !event.response) return null;
  const response = event.response;
  const status = String(response.status || '');
  const reason = String(response.status_details?.reason || response.status_details?.error?.code || '');
  return {
    responseId: String(response.id || ''),
    status,
    reason,
    truncatedByTokenLimit: status === 'incomplete' && reason === 'max_output_tokens'
  };
}

export function isOutputAudioDrained(event, responseId) {
  return event?.type === 'output_audio_buffer.stopped'
    && Boolean(responseId)
    && event.response_id === responseId;
}
