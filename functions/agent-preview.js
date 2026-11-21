// Safe, browser-only previews for AI agent drafts, on ElevenLabs.
//
// The ElevenLabs key never leaves the server. A voice sample is spoken by the
// server and returned as audio. A test conversation gets a single-use link to
// the preview agent, which has no tools, plus the prompt and voice the server
// compiled for this draft. Only admins who can manage agents reach this.

import { compileAgentRuntime } from './agent-runtime.js';
import { liveCallVoiceId, LIVE_CALL_TTS_MODEL } from './live-call-elevenlabs.js';
import { clean } from './prospect-normalization.js';

export const AGENT_PREVIEW_MODES = Object.freeze(['sample', 'conversation']);
export const AGENT_PREVIEW_SAMPLE_TEXT = 'Hi, this is the BiteSites assistant. I am calling to learn about your business and see whether we can help you turn more website visitors into customers.';

/**
 * The audition line a persona performs in sample mode. A profile may carry its
 * own opener so operators hear the character rather than a shared placeholder;
 * anything unset falls back to the generic sample.
 */
export function auditionScript(compiled = {}) {
  return clean(compiled?.auditionScript, 1200) || AGENT_PREVIEW_SAMPLE_TEXT;
}

export function buildAgentPreviewRuntime({ profile, knowledgeChunks = [], mode = 'conversation' } = {}) {
  if (!AGENT_PREVIEW_MODES.includes(mode)) throw new Error('Preview mode must be sample or conversation.');

  const compiled = compileAgentRuntime({
    profile,
    campaign: {
      name: 'Agent preview sandbox',
      objective: 'Demonstrate the configured voice, personality, pacing, and sales approach for the BiteSites operator.'
    },
    contact: {
      companyName: 'Sample Local Business',
      researchSummary: 'This is a simulated preview contact. Do not treat it as a real prospect or claim that any action has occurred.'
    },
    knowledgeChunks,
    // The preview session ships without tools on purpose, so there is nothing
    // here to retrieve with. Knowledge has to come inline or not at all.
    inlineKnowledge: true
  });

  const previewInstructions = [
    compiled.instructions,
    '',
    'PREVIEW SANDBOX:',
    '- You are speaking only with a BiteSites operator who is evaluating this agent draft.',
    '- This is not a real sales call and there is no real prospect.',
    '- No external tools or business actions are available. Never claim that you booked, sent, charged, updated, or transferred anything.',
    '- Demonstrate the configured voice, language, tone, pacing, and conversational behavior naturally.',
    mode === 'sample'
      ? `- When asked for the voice sample, say exactly this text and nothing else: ${auditionScript(compiled)}`
      : [
          '- This is an audition. Open exactly as you would on a real call, then let the operator role-play as the prospect.',
          '- Stay in character through objections. Do not narrate what you are doing or step outside the persona to explain yourself.',
          '- Keep the audition to a few minutes and let the operator drive.'
        ].join('\n')
  ].join('\n');

  return {
    compiled,
    prompt: clean(previewInstructions, 30000),
    firstMessage: mode === 'sample' ? '' : clean(compiled.openingLine, 500),
    sampleText: auditionScript(compiled),
    voiceId: liveCallVoiceId(compiled.voice)
  };
}

const ELEVENLABS = 'https://api.elevenlabs.io';

async function elevenLabs(fetchImpl, apiKey, path, init = {}) {
  if (!apiKey) throw new Error('ElevenLabs is not configured.');
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable.');
  const response = await fetchImpl(`${ELEVENLABS}${path}`, {
    ...init, headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  if (!response.ok) {
    const detail = clean(await response.text().catch(() => ''), 300);
    throw new Error(`Could not create the agent preview: ElevenLabs returned HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
  }
  return response;
}

/** The voice sample, spoken on the server. Returns base64 MP3. */
export async function synthesizePreviewSample({ apiKey, text, voiceId, fetchImpl = globalThis.fetch } = {}) {
  const line = clean(text, 1200);
  if (!line) throw new Error('There is no sample line to speak.');
  const response = await elevenLabs(fetchImpl, apiKey,
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`, {
      method: 'POST', body: JSON.stringify({ text: line, model_id: LIVE_CALL_TTS_MODEL })
    });
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error('ElevenLabs returned no audio.');
  return { audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' };
}

/** A single-use link to the tool-free preview agent. */
export async function mintPreviewConversationUrl({ apiKey, agentId, fetchImpl = globalThis.fetch } = {}) {
  if (!agentId) throw new Error('The preview agent is not set up yet.');
  const response = await elevenLabs(fetchImpl, apiKey,
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
  const signedUrl = clean((await response.json())?.signed_url, 2000);
  if (!signedUrl) throw new Error('ElevenLabs did not return a preview link.');
  return signedUrl;
}
