// Bit and Byte's ElevenLabs agents must stay locked and match the code that serves them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { BIT_TOOL_NAMES } from './bit-persona.js';
import { WEB_TOOL_NAMES } from './byte-persona.js';
import { WEB_AGENT_IDS } from './web-agent-ids.js';
import { bitAgentConfig, bitToolConfigs, byteAgentConfig, byteToolConfigs } from './web-agents.js';
import { BIT_HISTORY_VARIABLE, runAgentTurn } from './bit-agent-turn.js';

test('both agents need a server link, allow no overrides and keep no audio or transcript', () => {
  for (const config of [bitAgentConfig(), byteAgentConfig()]) {
    assert.equal(config.platform_settings.auth.enable_auth, true);
    assert.deepEqual(config.platform_settings.overrides, {});
    assert.equal(config.platform_settings.privacy.record_voice, false);
    assert.equal(config.platform_settings.privacy.retention_days, 0);
  }
});

test('Bit is text only and reads the stored history; Byte keeps the crisis rule', () => {
  const bit = bitAgentConfig().conversation_config;
  assert.equal(bit.conversation.text_only, true);
  assert.match(bit.agent.prompt.prompt, new RegExp(`\\{\\{${BIT_HISTORY_VARIABLE}\\}\\}`));
  assert.match(byteAgentConfig().conversation_config.agent.prompt.prompt, /988/);
});

test('agent tools match the tools each server grants, and every one is recorded', () => {
  assert.deepEqual(bitToolConfigs().map(entry => entry.tool_config.name), [...BIT_TOOL_NAMES]);
  assert.deepEqual(byteToolConfigs().map(entry => entry.tool_config.name), [...WEB_TOOL_NAMES]);
  assert.deepEqual(Object.keys(WEB_AGENT_IDS.bitTools), [...BIT_TOOL_NAMES]);
  assert.deepEqual(Object.keys(WEB_AGENT_IDS.byteTools), [...WEB_TOOL_NAMES]);
  for (const entry of [...bitToolConfigs(), ...byteToolConfigs()]) {
    assert.equal(entry.tool_config.type, 'client');
    assert.equal(entry.tool_config.expects_response, true);
  }
});

test('the browser relays exactly the tools Byte is granted', () => {
  const source = readFileSync(new URL('../src/lib/byte-voice.js', import.meta.url), 'utf8');
  const list = source.match(/const TOOL_NAMES = \[([\s\S]*?)\];/)[1].match(/'[a-z_]+'/g).map(name => name.slice(1, -1));
  assert.deepEqual(list, [...WEB_TOOL_NAMES]);
});

class FakeSocket {
  static script = [];
  constructor() { this.sent = []; setTimeout(() => this.onopen(), 0); }
  send(raw) {
    const data = JSON.parse(raw);
    this.sent.push(data);
    if (data.type === 'user_message' || data.type === 'client_tool_result') {
      const next = FakeSocket.script.shift();
      if (next) setTimeout(() => this.onmessage({ data: JSON.stringify(next) }), 0);
    }
  }
  close() {}
}
const linkFetch = async () => ({ ok: true, json: async () => ({ signed_url: 'wss://stub.test' }) });
const toolCall = name => ({ type: 'client_tool_call', client_tool_call: { tool_name: name, tool_call_id: 't1', parameters: { a: 1 } } });
const reply = text => ({ type: 'agent_response', agent_response_event: { agent_response: text } });
const turn = onTool => runAgentTurn({ apiKey: 'k', agentId: 'a', message: 'hi', onTool, fetchImpl: linkFetch, WebSocketImpl: FakeSocket, timeoutMs: 200 });

test('a turn runs its tools on the server and returns the last reply', async () => {
  FakeSocket.script = [toolCall('lookup_knowledge'), reply('Done.')];
  const seen = [];
  assert.equal(await turn(async (name, args) => { seen.push([name, args]); return { ok: true }; }), 'Done.');
  assert.deepEqual(seen, [['lookup_knowledge', { a: 1 }]]);
});

test('a failed tool still answers the agent, and silence is an error', async () => {
  FakeSocket.script = [toolCall('book_meeting'), reply('That did not go through.')];
  assert.match(await turn(async () => { throw new Error('boom'); }), /did not go through/);
  FakeSocket.script = [];
  await assert.rejects(turn(async () => ({})), /timed out/);
});
