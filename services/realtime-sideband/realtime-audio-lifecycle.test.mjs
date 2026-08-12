import test from 'node:test';
import assert from 'node:assert/strict';

import { isOutputAudioDrained, realtimeResponseOutcome } from './realtime-audio-lifecycle.js';

test('live responses continue only after an explicit token-limit truncation', () => {
  const limited = realtimeResponseOutcome({
    type: 'response.done',
    response: { id: 'resp_live', status: 'incomplete', status_details: { reason: 'max_output_tokens' } }
  });
  const callerBargeIn = realtimeResponseOutcome({
    type: 'response.done',
    response: { id: 'resp_barge_in', status: 'cancelled', status_details: { reason: 'turn_detected' } }
  });

  assert.equal(limited.truncatedByTokenLimit, true);
  assert.equal(callerBargeIn.truncatedByTokenLimit, false);
  assert.equal(isOutputAudioDrained({ type: 'output_audio_buffer.stopped', response_id: 'resp_live' }, limited.responseId), true);
});
