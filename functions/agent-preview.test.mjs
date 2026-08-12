import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_PREVIEW_SAMPLE_TEXT,
  buildAgentPreviewRuntime,
  mintAgentPreviewClientSecret,
  previewSafetyIdentifier
} from './agent-preview.js';

const profile = {
  id: 'preview-agent',
  name: 'Preview Agent',
  version: 4,
  model: 'gpt-realtime-2.1',
  voiceSettings: { source: 'built_in', builtInVoice: 'cedar', playbackSpeed: 1.1 },
  personality: {
    preset: 'friendly_consultant', tone: 'Warm and concise.', pacing: 'natural',
    formality: 'professional', energy: 'balanced', emotion: 'warm', pauseStyle: 'natural',
    fillerWords: 'minimal', responseLength: 'concise'
  },
  turnTaking: { mode: 'semantic_vad', eagerness: 'medium', allowInterruptions: true, noiseReduction: 'near_field' },
  responseSettings: { maxOutputTokens: 256, reasoningEffort: 'low' },
  objective: { mode: 'sell', primaryGoal: 'Book a website consultation.' },
  permissions: { mayBookMeeting: true },
  rules: { requiredDisclosures: [], prohibitedClaims: [] },
  knowledgeBaseIds: ['kb-services']
};

test('sample preview uses the live compiler but exposes no production tools', () => {
  const preview = buildAgentPreviewRuntime({
    profile,
    mode: 'sample',
    knowledgeChunks: [{ sourceId: 'kb-services/offer', title: 'Offer', text: 'BiteSites builds conversion-focused websites.', version: 2 }]
  });
  assert.equal(preview.session.type, 'realtime');
  assert.equal(preview.session.model, 'gpt-realtime-2.1');
  assert.equal(preview.session.audio.output.voice, 'cedar');
  assert.equal(preview.session.audio.output.speed, 1.1);
  assert.equal(Object.prototype.hasOwnProperty.call(preview.session, 'tools'), false);
  assert.match(preview.session.instructions, /PREVIEW SANDBOX/i);
  assert.match(preview.session.instructions, new RegExp(AGENT_PREVIEW_SAMPLE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(preview.session.instructions, /BiteSites builds conversion-focused websites/i);
  assert.equal(preview.compiled.effectiveConfigHash.length, 64);
});

test('conversation preview is explicitly non-operational', () => {
  const preview = buildAgentPreviewRuntime({ profile, mode: 'conversation' });
  assert.match(preview.session.instructions, /not a real sales call/i);
  assert.match(preview.session.instructions, /No external tools or business actions are available/i);
  assert.match(preview.session.instructions, /role-play as a prospect/i);
});

test('preview safety identifier is stable and does not reveal the uid', () => {
  const first = previewSafetyIdentifier('user-private-123');
  const second = previewSafetyIdentifier('user-private-123');
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.equal(first.includes('user-private-123'), false);
});

test('client secret is minted server-side with a privacy-preserving safety identifier', async () => {
  let request;
  const result = await mintAgentPreviewClientSecret({
    apiKey: 'sk-server-only',
    uid: 'user-private-123',
    session: { type: 'realtime', model: 'gpt-realtime-2.1' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ value: 'ek_preview_123', expires_at: 123456 }) };
    }
  });

  assert.equal(request.url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(request.options.headers.Authorization, 'Bearer sk-server-only');
  assert.equal(request.options.headers['OpenAI-Safety-Identifier'], previewSafetyIdentifier('user-private-123'));
  assert.deepEqual(JSON.parse(request.options.body), { session: { type: 'realtime', model: 'gpt-realtime-2.1' } });
  assert.deepEqual(result, { value: 'ek_preview_123', expiresAt: 123456 });
});

test('OpenAI errors do not accidentally return a missing credential as success', async () => {
  await assert.rejects(
    mintAgentPreviewClientSecret({
      apiKey: 'sk-server-only', uid: 'user-1', session: { type: 'realtime' },
      fetchImpl: async () => ({
        ok: false, status: 400,
        text: async () => JSON.stringify({ error: { message: 'Unsupported preview configuration.' } })
      })
    }),
    /Unsupported preview configuration/i
  );
});
