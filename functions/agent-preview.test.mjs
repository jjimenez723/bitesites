import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_PREVIEW_SAMPLE_TEXT,
  auditionScript,
  buildAgentPreviewRuntime,
  mintPreviewConversationUrl,
  synthesizePreviewSample
} from './agent-preview.js';
import { LIVE_CALL_VOICES } from './live-call-elevenlabs.js';

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
  const preview = buildAgentPreviewRuntime({ profile, mode: 'sample' });
  assert.equal(preview.voiceId, LIVE_CALL_VOICES.cedar.id);
  assert.equal(preview.sampleText, AGENT_PREVIEW_SAMPLE_TEXT);
  assert.equal(preview.firstMessage, '');
  assert.match(preview.prompt, /PREVIEW SANDBOX/i);
  assert.equal('tools' in preview, false);
});

test('conversation preview is explicitly non-operational and opens with the AI disclosure', () => {
  const preview = buildAgentPreviewRuntime({ profile, mode: 'conversation' });
  assert.match(preview.prompt, /not a real sales call/i);
  assert.match(preview.prompt, /No external tools or business actions are available/i);
  assert.match(preview.prompt, /role-play as the prospect/i);
  assert.match(preview.firstMessage, /AI assistant/i);
});

test('a persona auditions with its own opener rather than the shared placeholder', () => {
  const preview = buildAgentPreviewRuntime({
    profile: { ...profile, auditionScript: 'Hi, is this the owner? I am calling about your website.' }, mode: 'sample'
  });
  assert.match(preview.sampleText, /is this the owner/i);
  assert.equal(auditionScript({}), AGENT_PREVIEW_SAMPLE_TEXT);
});

test('the voice sample is spoken on the server and returned as audio', async () => {
  let url = '';
  let sentKey = '';
  const result = await synthesizePreviewSample({
    apiKey: 'test-key', text: 'Hello there', voiceId: 'AbCdEfGhIj0123456789',
    fetchImpl: async (target, init) => {
      url = target; sentKey = init.headers['xi-api-key'];
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
  });
  assert.match(url, /text-to-speech\/AbCdEfGhIj0123456789/);
  assert.equal(sentKey, 'test-key');
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(Buffer.from(result.audioBase64, 'base64').length, 3);
});

test('a preview link needs the preview agent and a real link back', async () => {
  await assert.rejects(mintPreviewConversationUrl({ apiKey: 'k', agentId: '' }), /not set up/);
  const link = await mintPreviewConversationUrl({
    apiKey: 'k', agentId: 'agent_preview',
    fetchImpl: async url => ({ ok: true, json: async () => ({ signed_url: `wss://example/${new URL(url).searchParams.get('agent_id')}` }) })
  });
  assert.equal(link, 'wss://example/agent_preview');
  await assert.rejects(mintPreviewConversationUrl({
    apiKey: 'k', agentId: 'agent_preview', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' })
  }), /HTTP 401/);
});
