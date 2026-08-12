import test from 'node:test';
import assert from 'node:assert/strict';

import { isOutputAudioDrained, realtimeResponseOutcome } from './realtime-audio-lifecycle.js';

test('a completed response is not mistaken for an audio playback completion', () => {
  const outcome = realtimeResponseOutcome({
    type: 'response.done',
    response: { id: 'resp_1', status: 'completed' }
  });

  assert.deepEqual(outcome, {
    responseId: 'resp_1', status: 'completed', reason: '', truncatedByTokenLimit: false
  });
  assert.equal(isOutputAudioDrained({ type: 'response.done', response: { id: 'resp_1' } }, 'resp_1'), false);
});

test('audio is complete only when the matching WebRTC output buffer drains', () => {
  assert.equal(isOutputAudioDrained({ type: 'output_audio_buffer.stopped', response_id: 'resp_other' }, 'resp_1'), false);
  assert.equal(isOutputAudioDrained({ type: 'output_audio_buffer.stopped', response_id: 'resp_1' }, 'resp_1'), true);
});

test('only max-output-token truncation is eligible for continuation', () => {
  const limited = realtimeResponseOutcome({
    type: 'response.done',
    response: { id: 'resp_2', status: 'incomplete', status_details: { reason: 'max_output_tokens' } }
  });
  const interrupted = realtimeResponseOutcome({
    type: 'response.done',
    response: { id: 'resp_3', status: 'cancelled', status_details: { reason: 'turn_detected' } }
  });

  assert.equal(limited.truncatedByTokenLimit, true);
  assert.equal(interrupted.truncatedByTokenLimit, false);
});
