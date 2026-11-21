// ElevenLabs runtime for AI phone calls (Hybrid Dialer V2).
//
// How a call reaches the AI:
//   1. A prospect answers and the dialer routes the call to AI. A media job is
//      written with the compiled runtime (prompt, voice, granted tools).
//   2. hybrid-ai-sip-dispatch.js has Twilio dial the ElevenLabs SIP endpoint
//      with an X-BiteSites-Call-ID header, and joins that leg to the call's
//      conference.
//   3. ElevenLabs asks our initiation webhook for this call's settings. We
//      attach the AI as the call's controller and return the compiled prompt,
//      opening line and voice. Nothing about a call is stored on the agent.
//   4. Every tool call is a webhook to our server, which re-checks the grant.
//   5. When the call ends, the post-call webhook stores the transcript.
//
// One agent serves every seller. Seller identity, permissions and knowledge
// only ever arrive through the per-call prompt the server compiled, so the
// three sellers still never share anything.
//
// This file holds the pure parts so they can be tested without a network.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { clean } from './prospect-normalization.js';
import { TOOL_SCHEMAS } from './live-call-tool-schemas.js';

export const LIVE_CALL_SIP_HOST = 'sip.rtc.elevenlabs.io';
export const LIVE_CALL_LLM = 'claude-haiku-5-5';
// Flash is ElevenLabs' low-latency model, which matters on a phone line.
// English agents must use flash v2 (or turbo); v2.5 is refused.
export const LIVE_CALL_TTS_MODEL = 'eleven_flash_v2';
export const LIVE_CALL_MAX_SECONDS = 900;
export const CALL_ID_HEADER = 'X-BiteSites-Call-ID';
export const CALL_ID_VARIABLE = 'bitesites_call_id';
// ElevenLabs' built-in hang-up tool must be called end_call, so our own end_call
// (which records the outcome) is shown to the agent under another name. The
// request still names the server tool, end_call.
export const HANG_UP_TOOL = 'end_call';
const AGENT_TOOL_NAMES = Object.freeze({ end_call: 'record_call_outcome' });
// Tool request fields that our server fills in, never the model.
const RESERVED_TOOL_FIELDS = new Set(['call_id', 'conversation_id', 'tool']);

/**
 * Agent profiles were written with OpenAI voice names. Each keeps working by
 * mapping to an ElevenLabs default voice of a similar character; a profile can
 * also name any ElevenLabs voice id directly.
 */
export const LIVE_CALL_VOICES = Object.freeze({
  marin: { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica' },
  cedar: { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian' },
  alloy: { id: 'SAz9YHcvj6GT2YYXdXww', label: 'River' },
  ash: { id: 'cjVigY5qzO86Huf0OWal', label: 'Eric' },
  ballad: { id: 'CwhRBWXzGAHq8TQ4Fs17', label: 'Roger' },
  coral: { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda' },
  echo: { id: 'iP95p4xoKVk53GoZ742B', label: 'Chris' },
  sage: { id: 'pqHfZKP75CvOlQylNhV4', label: 'Bill' },
  shimmer: { id: 'hpp4J3VqNfWAUOO0d1Us', label: 'Bella' },
  verse: { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel' }
});
const ELEVENLABS_VOICE_ID = /^[A-Za-z0-9]{20}$/;

export function liveCallVoiceId(voice) {
  const value = clean(voice, 120);
  if (ELEVENLABS_VOICE_ID.test(value)) return value;
  return (LIVE_CALL_VOICES[value.toLowerCase()] || LIVE_CALL_VOICES.marin).id;
}

/** Our JSON-schema tool description as an ElevenLabs webhook tool. */
export function webhookTool(schema, { url, secretId }) {
  const { properties = {}, required = [] } = schema.parameters || {};
  const args = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    const { additionalProperties: _unused, ...rest } = value;
    return [key, { ...rest, description: rest.description || key }];
  }));
  const agentName = AGENT_TOOL_NAMES[schema.name] || schema.name;
  return {
    tool_config: {
      type: 'webhook',
      name: agentName,
      description: agentName === schema.name ? schema.description
        : `Record why the call is ending. Afterwards say goodbye and use ${HANG_UP_TOOL} to hang up.`,
      response_timeout_secs: 20,
      api_schema: {
        url,
        method: 'POST',
        request_headers: { 'x-ai-media-secret': { secret_id: secretId } },
        request_body_schema: {
          type: 'object',
          description: `Arguments for ${schema.name}.`,
          properties: {
            // Filled in by ElevenLabs, never the model. ElevenLabs refuses a
            // description on these, so they carry none.
            call_id: { type: 'string', dynamic_variable: CALL_ID_VARIABLE },
            conversation_id: { type: 'string', dynamic_variable: 'system__conversation_id' },
            tool: { type: 'string', constant_value: schema.name },
            ...args
          },
          required: ['call_id', 'conversation_id', 'tool', ...required]
        }
      }
    }
  };
}

/** Every tool the compiler can grant. The server still refuses ungranted ones. */
export const liveCallToolConfigs = ({ url, secretId }) =>
  Object.values(TOOL_SCHEMAS).map(schema => webhookTool(schema, { url, secretId }));

const BASE_PROMPT = 'You are a phone agent for a BiteSites seller. Your full instructions arrive with each call. '
  + `If they are missing, say you cannot continue the call and use ${HANG_UP_TOOL}.`;

export function liveCallAgentConfig({ toolIds = [] } = {}) {
  return {
    name: 'BiteSites Live Calls',
    tags: ['bitesites-live-calls'],
    conversation_config: {
      agent: {
        first_message: '',
        language: 'en',
        dynamic_variables: { dynamic_variable_placeholders: { [CALL_ID_VARIABLE]: '' } },
        prompt: {
          prompt: BASE_PROMPT,
          llm: LIVE_CALL_LLM,
          temperature: 0.5,
          tool_ids: toolIds,
          built_in_tools: {
            end_call: {
              name: HANG_UP_TOOL,
              description: 'Hang up after you have said goodbye.',
              params: { system_tool_type: 'end_call' }
            }
          }
        }
      },
      tts: { voice_id: LIVE_CALL_VOICES.marin.id, model_id: LIVE_CALL_TTS_MODEL },
      turn: { turn_timeout: 8, silence_end_call_timeout: 30 },
      conversation: { max_duration_seconds: LIVE_CALL_MAX_SECONDS }
    },
    platform_settings: {
      // Phone calls only arrive over our SIP trunk; no browser can start one.
      auth: { enable_auth: true, allowlist: [] },
      overrides: {
        // The settings for each call come from our webhook, never a client.
        enable_conversation_initiation_client_data_from_webhook: true,
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: false },
          tts: { voice_id: true }
        }
      },
      // Recording stays off. Our database keeps the transcript; ElevenLabs keeps
      // it for a week so a missed webhook can be recovered.
      privacy: { record_voice: false, retention_days: 7 }
    }
  };
}

/**
 * The admin preview agent. It has no tools, and the admin's browser supplies
 * the prompt and voice the server compiled for the draft profile.
 */
export function livePreviewAgentConfig() {
  return {
    name: 'BiteSites Live Calls - Preview',
    tags: ['bitesites-live-calls'],
    conversation_config: {
      agent: {
        first_message: '',
        language: 'en',
        prompt: { prompt: BASE_PROMPT, llm: LIVE_CALL_LLM, temperature: 0.5, tool_ids: [] }
      },
      tts: { voice_id: LIVE_CALL_VOICES.marin.id, model_id: LIVE_CALL_TTS_MODEL },
      conversation: { max_duration_seconds: 300 }
    },
    platform_settings: {
      auth: { enable_auth: true, allowlist: [] },
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: false },
          tts: { voice_id: true }
        }
      },
      privacy: { record_voice: false, retention_days: 0 }
    }
  };
}

/** The SIP address Twilio dials. The call id rides in a custom header. */
export function liveCallSipUri({ sipUser, callId }) {
  const user = clean(sipUser, 80);
  if (!user) throw new Error('The ElevenLabs SIP number is not configured.');
  return `sip:${user}@${LIVE_CALL_SIP_HOST}:5061;transport=tls?${CALL_ID_HEADER}=${encodeURIComponent(callId)}`;
}

const validCallId = value => {
  const result = clean(value, 200);
  return /^[A-Za-z0-9_-]+$/.test(result) ? result : '';
};

/**
 * Find our call id in the initiation webhook. ElevenLabs documents that SIP
 * calls carry their headers, without fixing the shape, so this accepts a list
 * of {name, value}, a plain object, or the already-mapped sip_ variable.
 */
export function callIdFromInitiation(body = {}) {
  const wanted = CALL_ID_HEADER.toLowerCase();
  const headers = body?.sip_headers;
  let value = '';
  if (Array.isArray(headers)) {
    value = headers.find(row => String(row?.name || row?.key || '').toLowerCase() === wanted)?.value || '';
  } else if (headers && typeof headers === 'object') {
    const key = Object.keys(headers).find(name => name.toLowerCase() === wanted);
    value = key ? headers[key] : '';
  }
  value = value || body?.dynamic_variables?.sip_bitesites_call_id || '';
  try { value = decodeURIComponent(String(value)); } catch { value = String(value); }
  return validCallId(value);
}

/** What ElevenLabs needs to run this call: our compiled prompt, opening line and voice. */
export function initiationResponse({ callId, runtime = {} }) {
  const prompt = clean(runtime.instructions, 30000);
  if (!prompt) throw new Error('The call has no compiled instructions.');
  return {
    type: 'conversation_initiation_client_data',
    dynamic_variables: { [CALL_ID_VARIABLE]: callId },
    conversation_config_override: {
      agent: {
        prompt: { prompt },
        first_message: clean(runtime.openingLine, 500)
          || 'Hi, this is an AI assistant calling about your business. Do you have a quick minute?'
      },
      tts: { voice_id: liveCallVoiceId(runtime.elevenLabsVoiceId || runtime.voice) }
    }
  };
}

/** Split a tool webhook body into our identifiers and the model's arguments. */
export function parseToolRequest(body = {}) {
  const args = Object.fromEntries(Object.entries(body && typeof body === 'object' ? body : {})
    .filter(([key]) => !RESERVED_TOOL_FIELDS.has(key)));
  return {
    callId: validCallId(body?.call_id),
    conversationId: clean(body?.conversation_id, 240),
    tool: clean(body?.tool, 80),
    args
  };
}

/**
 * ElevenLabs does not send a per-invocation id, so a retry is recognized by its
 * content: the same conversation, tool and arguments return the stored result
 * instead of acting twice. A booking retried after a timeout is therefore
 * booked once.
 */
export function toolRequestId({ conversationId, tool, args }) {
  const digest = createHash('sha256')
    .update(JSON.stringify([conversationId, tool, sortKeys(args)]))
    .digest('hex');
  return `el_${digest.slice(0, 48)}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}

/** What the model hears back from a tool. Terminal tools end with a hang-up. */
export function toolReply(result = {}, { endsCall = false } = {}) {
  if (!endsCall) return result;
  return {
    ...result,
    note: [clean(result.note, 300), `Say a short warm goodbye, then use ${HANG_UP_TOOL}.`].filter(Boolean).join(' ')
  };
}

/**
 * Verify the `elevenlabs-signature` header: `t=<unix seconds>,v0=<hex>`, where
 * v0 is HMAC-SHA256 of `<t>.<raw body>` with the webhook secret. Old
 * signatures are refused so a captured request cannot be replayed.
 */
export function verifyElevenLabsSignature(rawBody, header, secret, { nowMs = Date.now(), toleranceSeconds = 30 * 60 } = {}) {
  if (!secret || !header || rawBody == null) return false;
  const parts = Object.fromEntries(String(header).split(',').map(part => {
    const index = part.indexOf('=');
    return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : ['', ''];
  }));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v0) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`).digest('hex');
  if (expected.length !== parts.v0.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v0));
}

/** Post-call transcript as our turn records. */
export function transcriptTurns(data = {}) {
  const startMs = Number(data?.metadata?.start_time_unix_secs) * 1000;
  return (Array.isArray(data?.transcript) ? data.transcript : [])
    .map((turn, index) => {
      const text = clean(turn?.message, 4000);
      if (!text) return null;
      const offsetMs = Math.max(0, Number(turn?.time_in_call_secs) || 0) * 1000;
      return {
        sequence: index + 1,
        speaker: turn?.role === 'agent' ? 'ai' : turn?.role === 'user' ? 'prospect' : 'system',
        text,
        startedAt: Number.isFinite(startMs) && startMs > 0 ? new Date(startMs + offsetMs) : null
      };
    })
    .filter(Boolean)
    .slice(0, 400);
}
