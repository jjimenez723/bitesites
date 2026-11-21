import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  callIdFromInitiation, initiationResponse, liveCallAgentConfig, livePreviewAgentConfig, liveCallSipUri,
  liveCallToolConfigs, liveCallVoiceId, LIVE_CALL_VOICES, parseToolRequest, toolReply, toolRequestId,
  transcriptTurns, verifyElevenLabsSignature, CALL_ID_VARIABLE, HANG_UP_TOOL
} from './live-call-elevenlabs.js';
import { TOOL_SCHEMAS } from './live-call-tool-schemas.js';
import { ALL_TOOL_NAMES } from './agent-runtime.js';

test('every tool the compiler can grant becomes a webhook that carries our secret and call id', () => {
  const tools = liveCallToolConfigs({ url: 'https://bitesites.org/api/hybrid-ai-tools', secretId: 'sec_1' });
  const names = tools.map(tool => tool.tool_config.api_schema.request_body_schema.properties.tool.constant_value);
  for (const granted of ALL_TOOL_NAMES) assert.ok(names.includes(granted), granted);
  // ElevenLabs reserves end_call for its own hang-up, so ours is renamed for the agent only.
  const outcome = tools.find(tool => tool.tool_config.name === 'record_call_outcome');
  assert.equal(outcome.tool_config.api_schema.request_body_schema.properties.tool.constant_value, 'end_call');
  assert.equal(tools.some(tool => tool.tool_config.name === 'end_call'), false);
  for (const { tool_config: config } of tools) {
    const serverName = config.api_schema.request_body_schema.properties.tool.constant_value;
    assert.equal(config.type, 'webhook');
    assert.equal(config.api_schema.request_headers['x-ai-media-secret'].secret_id, 'sec_1');
    const body = config.api_schema.request_body_schema;
    assert.equal(body.properties.call_id.dynamic_variable, CALL_ID_VARIABLE);
    assert.equal(body.properties.conversation_id.dynamic_variable, 'system__conversation_id');
    for (const required of TOOL_SCHEMAS[serverName].parameters.required) assert.ok(body.required.includes(required));
    assert.equal('description' in body.properties.call_id, false);
  }
});

test('the phone agent records no audio, takes its settings only from our webhook, and can hang up', () => {
  const config = liveCallAgentConfig({ toolIds: ['t1'] });
  assert.equal(config.platform_settings.privacy.record_voice, false);
  assert.equal(config.platform_settings.auth.enable_auth, true);
  assert.equal(config.platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook, true);
  assert.equal(config.conversation_config.agent.prompt.built_in_tools.end_call.name, HANG_UP_TOOL);
  assert.deepEqual(config.conversation_config.agent.prompt.tool_ids, ['t1']);
  const preview = livePreviewAgentConfig();
  assert.deepEqual(preview.conversation_config.agent.prompt.tool_ids, []);
  assert.equal(preview.platform_settings.privacy.record_voice, false);
});

test('old OpenAI voice names keep working and ElevenLabs ids pass through', () => {
  assert.equal(liveCallVoiceId('cedar'), LIVE_CALL_VOICES.cedar.id);
  assert.equal(liveCallVoiceId('AbCdEfGhIj0123456789'), 'AbCdEfGhIj0123456789');
  assert.equal(liveCallVoiceId('unknown'), LIVE_CALL_VOICES.marin.id);
});

test('the SIP address carries the call id and refuses to build without setup', () => {
  assert.equal(liveCallSipUri({ sipUser: 'bitesites-live', callId: 'call_1' }),
    'sip:bitesites-live@sip.rtc.elevenlabs.io:5061;transport=tls?X-BiteSites-Call-ID=call_1');
  assert.throws(() => liveCallSipUri({ sipUser: '', callId: 'call_1' }), /not configured/);
});

test('the call id is found in any header shape ElevenLabs sends, and junk is refused', () => {
  assert.equal(callIdFromInitiation({ sip_headers: [{ name: 'X-BiteSites-Call-ID', value: 'abc_1' }] }), 'abc_1');
  assert.equal(callIdFromInitiation({ sip_headers: { 'x-bitesites-call-id': 'abc_2' } }), 'abc_2');
  assert.equal(callIdFromInitiation({ dynamic_variables: { sip_bitesites_call_id: 'abc_3' } }), 'abc_3');
  assert.equal(callIdFromInitiation({ sip_headers: { 'X-BiteSites-Call-ID': '../calls/other' } }), '');
  assert.equal(callIdFromInitiation({}), '');
});

test('each call gets its compiled prompt, a disclosed opening line and its voice', () => {
  const reply = initiationResponse({
    callId: 'call_1',
    runtime: { instructions: 'Compiled policy and persona.', openingLine: 'Hi, this is an AI assistant calling on behalf of BiteSites LLC.', voice: 'cedar' }
  });
  assert.equal(reply.type, 'conversation_initiation_client_data');
  assert.equal(reply.dynamic_variables[CALL_ID_VARIABLE], 'call_1');
  assert.equal(reply.conversation_config_override.agent.prompt.prompt, 'Compiled policy and persona.');
  assert.match(reply.conversation_config_override.agent.first_message, /AI assistant/);
  assert.equal(reply.conversation_config_override.tts.voice_id, LIVE_CALL_VOICES.cedar.id);
  assert.match(initiationResponse({ callId: 'c', runtime: { instructions: 'x' } }).conversation_config_override.agent.first_message, /AI assistant/);
  assert.throws(() => initiationResponse({ callId: 'call_1', runtime: {} }), /no compiled instructions/);
});

test('tool requests separate our identifiers from the model arguments', () => {
  const parsed = parseToolRequest({ call_id: 'call_1', conversation_id: 'conv_1', tool: 'hold_slot', slotId: 's1' });
  assert.deepEqual(parsed, { callId: 'call_1', conversationId: 'conv_1', tool: 'hold_slot', args: { slotId: 's1' } });
  assert.equal(parseToolRequest({ call_id: 'bad/id' }).callId, '');
});

test('a retried tool call gets the same request id, a different call does not', () => {
  const first = toolRequestId({ conversationId: 'conv_1', tool: 'book_meeting', args: { holdId: 'h1', name: 'Dana' } });
  assert.equal(first, toolRequestId({ conversationId: 'conv_1', tool: 'book_meeting', args: { name: 'Dana', holdId: 'h1' } }));
  assert.notEqual(first, toolRequestId({ conversationId: 'conv_2', tool: 'book_meeting', args: { holdId: 'h1', name: 'Dana' } }));
  assert.match(first, /^el_[a-f0-9]{48}$/);
});

test('a call-ending tool tells the agent to say goodbye and hang up', () => {
  assert.match(toolReply({ ok: true, note: 'Recorded.' }, { endsCall: true }).note, /goodbye, then use end_call/);
  assert.deepEqual(toolReply({ ok: true }), { ok: true });
});

test('post-call webhooks need a fresh, valid ElevenLabs signature', () => {
  const body = JSON.stringify({ type: 'post_call_transcription' });
  const now = 1_800_000_000_000;
  const t = String(now / 1000);
  const sign = secret => `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  assert.equal(verifyElevenLabsSignature(Buffer.from(body), sign('whsec'), 'whsec', { nowMs: now }), true);
  assert.equal(verifyElevenLabsSignature(Buffer.from(body), sign('other'), 'whsec', { nowMs: now }), false);
  assert.equal(verifyElevenLabsSignature(Buffer.from(body), sign('whsec'), 'whsec', { nowMs: now + 3_600_000 }), false);
  assert.equal(verifyElevenLabsSignature(Buffer.from(body), '', 'whsec', { nowMs: now }), false);
  assert.equal(verifyElevenLabsSignature(Buffer.from(body), sign('whsec'), '', { nowMs: now }), false);
});

test('the transcript becomes our turns in order, with speakers mapped', () => {
  const turns = transcriptTurns({
    metadata: { start_time_unix_secs: 1_800_000_000 },
    transcript: [
      { role: 'agent', message: 'Hi, this is an AI assistant.', time_in_call_secs: 0 },
      { role: 'user', message: 'Who is this?', time_in_call_secs: 3 },
      { role: 'user', message: '   ' }
    ]
  });
  assert.deepEqual(turns.map(turn => [turn.sequence, turn.speaker]), [[1, 'ai'], [2, 'prospect']]);
  assert.equal(turns[1].startedAt.getTime(), 1_800_000_003_000);
});
