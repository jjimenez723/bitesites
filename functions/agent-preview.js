// Safe, browser-only previews for AI agent drafts.
//
// The standard OpenAI key never leaves the server. This module creates the
// short-lived client secret that a browser may use for one WebRTC connection,
// and deliberately omits production tools from the preview session.

import { createHash } from 'node:crypto';

import { compileAgentRuntime, sanitizeRealtimeSessionConfig } from './agent-runtime.js';
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

export function previewSafetyIdentifier(uid) {
  return createHash('sha256')
    .update(`bitesites-agent-preview:${clean(uid, 160)}`)
    .digest('hex');
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
    session: {
      type: 'realtime',
      model: clean(compiled.model, 120) || 'gpt-realtime-2.1',
      instructions: clean(previewInstructions, 30000),
      ...sanitizeRealtimeSessionConfig(compiled.sessionConfig, clean(compiled.voice, 120) || 'marin')
    }
  };
}

export async function mintAgentPreviewClientSecret({
  apiKey,
  uid,
  session,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!apiKey) throw new Error('OpenAI is not configured.');
  if (!uid) throw new Error('A signed-in user is required.');
  if (!session || typeof session !== 'object') throw new Error('A preview session is required.');
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable.');

  const response = await fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': previewSafetyIdentifier(uid)
    },
    body: JSON.stringify({ session })
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { /* handled below */ }

  if (!response.ok) {
    const message = clean(payload?.error?.message || text, 400) || `OpenAI returned HTTP ${response.status}`;
    throw new Error(`Could not create the agent preview: ${message}`);
  }

  const value = clean(payload?.value || payload?.client_secret?.value, 2000);
  if (!value) throw new Error('OpenAI did not return a preview client secret.');
  return {
    value,
    expiresAt: Number(payload?.expires_at || payload?.client_secret?.expires_at) || 0
  };
}
