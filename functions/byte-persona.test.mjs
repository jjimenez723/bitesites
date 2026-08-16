// Pins the Byte homepage persona:  npm run test:byte-persona
//
// The persona is code, so drift is a code review problem — but three
// properties are load-bearing enough to enforce mechanically: the knowledge
// corpus must fit the compiler's budget (a doc that silently falls out of the
// prompt index is a hard question Byte stops being able to answer), the tool
// grant list and the wire schemas must never disagree (an ungranted schema is
// a tool the model calls and the server refuses), and the compiled prompt must
// be deterministic (per-visitor bytes would break OpenAI prompt caching).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BYTE_CORE_KNOWLEDGE, BYTE_WEB_IDENTITY, BYTE_WEB_PROFILE,
  HARD_QUESTION_POLICY, WEB_SESSION_CONTEXT,
  WEB_TOOL_NAMES, WEB_TOOL_SCHEMAS, buildByteWebRuntime
} from './byte-persona.js';
import { normalizeKnowledgeChunks } from './agent-runtime.js';

test('core knowledge fits the compiler budget so every title is advertised', () => {
  assert.ok(BYTE_CORE_KNOWLEDGE.length <= 8, 'at most 8 documents');
  const total = BYTE_CORE_KNOWLEDGE.reduce((sum, doc) => sum + doc.text.length, 0);
  assert.ok(total <= 12000, `corpus is ${total} chars; the compiler truncates beyond 12000`);
  for (const doc of BYTE_CORE_KNOWLEDGE) {
    assert.ok(doc.text.length <= 4000, `${doc.sourceId} exceeds the 4000-char chunk cap`);
    assert.ok(doc.title && doc.sourceId, 'every doc carries a title and sourceId');
  }
  const surviving = normalizeKnowledgeChunks(BYTE_CORE_KNOWLEDGE);
  assert.equal(surviving.length, BYTE_CORE_KNOWLEDGE.length, 'no document is dropped by normalization');
});

test('the corpus invents no prices and names no clients', () => {
  for (const doc of BYTE_CORE_KNOWLEDGE) {
    assert.ok(!/[$£€]\s?\d/.test(doc.text), `${doc.sourceId} contains a currency amount`);
    assert.ok(!/\b\d+\s?%/.test(doc.text), `${doc.sourceId} contains a percentage claim`);
  }
});

test('tool grants and wire schemas cannot drift apart', () => {
  const schemaNames = Object.keys(WEB_TOOL_SCHEMAS).sort();
  assert.deepEqual([...WEB_TOOL_NAMES].sort(), schemaNames);
  for (const name of WEB_TOOL_NAMES) {
    assert.equal(WEB_TOOL_SCHEMAS[name].name, name);
    assert.equal(WEB_TOOL_SCHEMAS[name].type, 'function');
  }
  // Phone-campaign tools must never leak into the public web surface.
  for (const forbidden of ['mark_do_not_call', 'request_human_handoff', 'send_approved_followup', 'flag_wrong_number']) {
    assert.ok(!WEB_TOOL_NAMES.includes(forbidden), `${forbidden} granted to the web session`);
  }
});

test('compiled runtime carries the persona, the policies, and the whole corpus index', () => {
  const runtime = buildByteWebRuntime();
  const prompt = runtime.session.instructions;

  for (const block of [BYTE_WEB_IDENTITY, WEB_SESSION_CONTEXT, HARD_QUESTION_POLICY]) {
    for (const line of block.instructions) {
      assert.ok(prompt.includes(line), `missing instruction: ${line.slice(0, 60)}…`);
    }
  }
  for (const doc of BYTE_CORE_KNOWLEDGE) {
    assert.ok(prompt.includes(doc.title), `knowledge index is missing “${doc.title}”`);
  }
  assert.ok(prompt.includes('BOOKING A MEETING'), 'booking protocol included for a booking-permitted profile');
  assert.ok(prompt.includes('OFFER TRACKS'), 'offer catalogue rendered');
  assert.match(prompt, /Quote pricing: yes/);
  assert.match(prompt, /Book meetings: yes/);
  assert.match(prompt, /Collect payment: no/);
});

test('session config is realtime, reasoning-enabled, and interruptible', () => {
  const { session, tools } = buildByteWebRuntime();
  assert.equal(session.type, 'realtime');
  assert.equal(session.model, 'gpt-realtime-2.1');
  assert.equal(session.tools.length, WEB_TOOL_NAMES.length);
  assert.deepEqual(tools, [...WEB_TOOL_NAMES]);
  assert.equal(session.reasoning?.effort, BYTE_WEB_PROFILE.responseSettings.reasoningEffort);
  assert.equal(session.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(session.audio.output.voice, 'marin');
});

test('the compiled prompt is byte-identical across builds (prompt-cache friendly)', () => {
  assert.equal(buildByteWebRuntime().session.instructions, buildByteWebRuntime().session.instructions);
});
