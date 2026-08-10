import express from 'express';
import OpenAI from 'openai';
import WebSocket from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET || '';
const AI_MEDIA_WEBHOOK_SECRET = process.env.AI_MEDIA_WEBHOOK_SECRET || '';
const FIREBASE_CONTROL_URL = process.env.FIREBASE_CONTROL_URL
  || 'https://bitesites.org/api/hybrid-sideband-control';
const OPENAI_BASE = 'https://api.openai.com/v1';

if (!OPENAI_API_KEY) console.warn('[sideband] OPENAI_API_KEY is not configured');
if (!OPENAI_WEBHOOK_SECRET) console.warn('[sideband] OPENAI_WEBHOOK_SECRET is not configured');
if (!AI_MEDIA_WEBHOOK_SECRET) console.warn('[sideband] AI_MEDIA_WEBHOOK_SECRET is not configured');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY, webhookSecret: OPENAI_WEBHOOK_SECRET });
const app = express();
const sessions = new Map();

const clean = (value, max = 1000) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').slice(0, max)
  : '';

async function control(callId, action, extra = {}) {
  const response = await fetch(FIREBASE_CONTROL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ai-media-secret': AI_MEDIA_WEBHOOK_SECRET
    },
    body: JSON.stringify({ callId, action, ...extra })
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { detail: clean(text, 500) }; }
  if (!response.ok) {
    const error = new Error(body?.error || body?.reason || `Firebase control returned ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function headerValue(headers = [], wanted) {
  const normalized = wanted.toLowerCase();
  const row = (Array.isArray(headers) ? headers : []).find(entry =>
    String(entry?.name || '').toLowerCase() === normalized);
  return clean(row?.value, 300);
}

const TOOL_SCHEMAS = {
  request_human_handoff: {
    type: 'function',
    name: 'request_human_handoff',
    description: 'Use only when the prospect explicitly asks to speak with a human representative.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  mark_do_not_call: {
    type: 'function',
    name: 'mark_do_not_call',
    description: 'Immediately suppress future calls when the prospect clearly asks not to be called again.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Brief paraphrase of the opt-out request.' } },
      additionalProperties: false
    }
  },
  record_qualification: {
    type: 'function',
    name: 'record_qualification',
    description: 'Record a qualification fact learned from the prospect. This does not perform any external action.',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string' },
        value: { type: 'string' }
      },
      required: ['field', 'value'],
      additionalProperties: false
    }
  },
  record_interest_signal: {
    type: 'function',
    name: 'record_interest_signal',
    description: 'Record a sales-interest signal for analytics. This never causes a human transfer by itself.',
    parameters: {
      type: 'object',
      properties: {
        signal: { type: 'string' },
        detail: { type: 'string' }
      },
      required: ['signal'],
      additionalProperties: false
    }
  }
};

function usableTools(names = []) {
  return names.map(name => TOOL_SCHEMAS[name]).filter(Boolean);
}

async function acceptRealtimeCall(realtimeCallId, runtime) {
  const response = await fetch(`${OPENAI_BASE}/realtime/calls/${encodeURIComponent(realtimeCallId)}/accept`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'realtime',
      model: clean(runtime.model, 120) || 'gpt-realtime',
      instructions: String(runtime.instructions || '').slice(0, 30000),
      tools: usableTools(runtime.tools),
      tool_choice: 'auto',
      audio: {
        input: {
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: {
            type: 'semantic_vad', eagerness: 'medium',
            create_response: true, interrupt_response: true
          }
        },
        output: { voice: clean(runtime.voice, 120) || 'marin' }
      }
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI accept failed (${response.status}): ${clean(text, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function hangupRealtimeCall(realtimeCallId) {
  if (!realtimeCallId) return;
  await fetch(`${OPENAI_BASE}/realtime/calls/${encodeURIComponent(realtimeCallId)}/hangup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  }).catch(() => {});
}

function send(ws, value) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

async function writeTranscript(session, speaker, text, event = {}) {
  const normalized = clean(text, 4000);
  if (!normalized) return;
  session.sequence += 1;
  await control(session.callId, 'transcript', {
    speaker,
    text: normalized,
    sequence: session.sequence,
    modelEventId: clean(event.event_id || event.item_id || event.response_id, 200),
    final: true
  }).catch(error => console.warn('[sideband] transcript write failed', error.message));
}

async function executeTool(session, event) {
  const name = clean(event.name || session.toolNames.get(event.item_id), 80);
  let args = {};
  try { args = event.arguments ? JSON.parse(event.arguments) : {}; } catch { args = {}; }
  let output;

  if (name === 'request_human_handoff') {
    output = await control(session.callId, 'prospect_requested_human', {
      realtimeCallId: session.realtimeCallId
    });
  } else if (name === 'mark_do_not_call') {
    output = await control(session.callId, 'do_not_call', {
      realtimeCallId: session.realtimeCallId,
      reason: clean(args.reason, 300)
    });
    session.endAfterTool = true;
  } else if (name === 'record_qualification') {
    output = await control(session.callId, 'agent_signal', {
      realtimeCallId: session.realtimeCallId,
      signalType: `qualification:${clean(args.field, 60)}`,
      value: clean(args.value, 500)
    });
  } else if (name === 'record_interest_signal') {
    output = await control(session.callId, 'agent_signal', {
      realtimeCallId: session.realtimeCallId,
      signalType: `interest:${clean(args.signal, 60)}`,
      value: clean(args.detail, 500)
    });
  } else {
    output = { ok: false, error: 'tool_not_configured' };
  }

  send(session.ws, {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: event.call_id,
      output: JSON.stringify(output)
    }
  });

  if (session.endAfterTool) {
    send(session.ws, {
      type: 'response.create',
      response: {
        instructions: 'Briefly confirm the opt-out politely. Do not continue selling.',
        metadata: { response_purpose: 'dnc_confirmation' }
      }
    });
  } else {
    send(session.ws, { type: 'response.create' });
  }
}

async function pollControl(session) {
  if (session.closed || session.polling) return;
  session.polling = true;
  try {
    const state = await control(session.callId, 'poll_control');
    const controller = state.controller;
    const handoffState = state?.handoff?.state;

    if (controller === 'human' || controller === 'none') {
      await hangupRealtimeCall(session.realtimeCallId);
      try { session.ws.close(1000, 'human takeover'); } catch { /* closing */ }
      return;
    }

    if (controller === 'transitioning' && handoffState === 'announcing' && !session.handoffResponseId && !session.handoffRequested) {
      session.handoffRequested = true;
      // Smooth handoff has priority over whatever the AI was saying. Cut the
      // current audio first so the prospect hears one clean transition sentence.
      send(session.ws, { type: 'response.cancel' });
      send(session.ws, { type: 'output_audio_buffer.clear' });
      send(session.ws, {
        type: 'response.create',
        response: {
          instructions: `Say exactly this sentence and nothing else: ${String(state?.handoff?.phrase || session.runtime.handoffPhrase).slice(0, 500)}`,
          metadata: { response_purpose: 'bitesites_handoff' }
        }
      });
    }
  } catch (error) {
    if (error.status !== 404) console.warn('[sideband] control poll failed', error.message);
  } finally {
    session.polling = false;
  }
}

function startSidebandSocket({ callId, realtimeCallId, runtime }) {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(realtimeCallId)}`, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });
  const session = {
    callId, realtimeCallId, runtime, ws, sequence: Date.now(),
    toolNames: new Map(), handoffRequested: false, handoffResponseId: '',
    closed: false, polling: false, endAfterTool: false, pollTimer: null
  };
  sessions.set(callId, session);

  ws.on('open', async () => {
    await control(callId, 'attached', {
      realtimeCallId,
      model: runtime.model,
      voice: runtime.voice
    }).catch(error => console.warn('[sideband] attach acknowledgement failed', error.message));

    // Overflow calls should not sit in silence waiting for the prospect to talk.
    send(ws, {
      type: 'response.create',
      response: {
        instructions: 'Begin the configured call now. Use the required disclosures and the configured personality/objective. Be concise and natural.',
        metadata: { response_purpose: 'opening' }
      }
    });
    session.pollTimer = setInterval(() => pollControl(session), 500);
  });

  ws.on('message', raw => {
    let event;
    try { event = JSON.parse(String(raw)); } catch { return; }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      void writeTranscript(session, 'prospect', event.transcript, event);
    } else if (event.type === 'response.output_audio_transcript.done') {
      void writeTranscript(session, 'ai', event.transcript, event);
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      session.toolNames.set(event.item.id, clean(event.item.name, 80));
    } else if (event.type === 'response.function_call_arguments.done') {
      void executeTool(session, event).catch(error => {
        console.error('[sideband] tool execution failed', error);
        send(ws, {
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify({ ok: false, error: 'server_action_failed' }) }
        });
        send(ws, { type: 'response.create' });
      });
    } else if (event.type === 'response.created' && event.response?.metadata?.response_purpose === 'bitesites_handoff') {
      session.handoffResponseId = clean(event.response.id, 200);
    } else if (event.type === 'output_audio_buffer.stopped' && session.handoffResponseId && event.response_id === session.handoffResponseId) {
      void control(callId, 'handoff_phrase_spoken', { realtimeCallId })
        .catch(error => console.warn('[sideband] handoff completion signal failed', error.message));
      session.handoffResponseId = '';
    } else if (event.type === 'output_audio_buffer.stopped' && session.endAfterTool) {
      void hangupRealtimeCall(realtimeCallId);
      session.endAfterTool = false;
    } else if (event.type === 'error') {
      console.warn('[sideband] OpenAI realtime error', event.error?.code || '', event.error?.message || '');
    }
  });

  const close = () => {
    if (session.closed) return;
    session.closed = true;
    if (session.pollTimer) clearInterval(session.pollTimer);
    sessions.delete(callId);
  };
  ws.on('close', close);
  ws.on('error', error => {
    console.error('[sideband] websocket error', error.message);
    close();
  });
}

async function handleIncoming(event) {
  if (event?.type !== 'realtime.call.incoming') return;
  const realtimeCallId = clean(event?.data?.call_id, 240);
  const callId = headerValue(event?.data?.sip_headers, 'x-bitesites-call-id');
  if (!callId || !realtimeCallId) {
    console.warn('[sideband] incoming SIP call missing BiteSites correlation header');
    return;
  }
  if (sessions.has(callId)) return;

  let prepared;
  try {
    prepared = await control(callId, 'prepare');
    await acceptRealtimeCall(realtimeCallId, prepared.runtime);
    startSidebandSocket({ callId, realtimeCallId, runtime: prepared.runtime });
  } catch (error) {
    console.error('[sideband] could not accept realtime call', callId, error.message);
    // Reject/terminate the OpenAI leg rather than leaving a SIP call ringing.
    await fetch(`${OPENAI_BASE}/realtime/calls/${encodeURIComponent(realtimeCallId)}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_code: 503 })
    }).catch(() => {});
  }
}

// Raw body is required for OpenAI webhook signature verification.
app.post('/openai/webhook', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  let event;
  try {
    event = openai.webhooks.unwrap(req.body, req.headers);
  } catch (error) {
    console.warn('[sideband] invalid OpenAI webhook signature', error.message);
    res.status(400).json({ error: 'invalid-signature' });
    return;
  }
  res.status(200).json({ ok: true });
  void handleIncoming(event);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, activeSessions: sessions.size });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[sideband] listening on ${PORT}`);
});
