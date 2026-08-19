// Pins the Bit chat persona:  npm run test:bit-persona
//
// Same reasoning as byte-persona.test.mjs — the persona is code and drift is a
// code review problem — plus the two properties that are Bit's alone.
//
// The corpus is larger than the compiler's default budget, deliberately, so
// the raised budget is pinned here: if BIT_CORE_KNOWLEDGE grows past it, a
// document falls silently out of the prompt index and Bit quietly stops being
// able to answer whatever fell off the end.
//
// And the link whitelist is pinned as a whole. `send_page_link` exists because
// a language model that can emit an arbitrary href is a phishing surface on
// BiteSites' own homepage; the enum the model sees and the table the server
// resolves against must be the same set, and every destination must stay
// internal to this site.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BIT_CHAT_IDENTITY, BIT_CHAT_MODEL, BIT_CHAT_PROFILE, BIT_CORE_KNOWLEDGE, BIT_GREETING,
  BIT_KNOWLEDGE_BUDGET, BIT_PAGE_LINKS, BIT_PAGE_LINK_KEYS, BIT_TOOL_NAMES, BIT_TOOL_SCHEMAS,
  CHAT_BOOKING_PLAYBOOK, CHAT_SESSION_CONTEXT, buildBitChatRuntime
} from './bit-persona.js';
import { BYTE_CORE_KNOWLEDGE, HARD_QUESTION_POLICY, BYTE_WEB_PROFILE } from './byte-persona.js';
import { normalizeKnowledgeChunks } from './agent-runtime.js';
import { WEB_AGENT_IDENTITY } from './web-agent-tools.js';

test('core knowledge fits Bit’s raised budget so every title is advertised', () => {
  assert.deepEqual({ ...BIT_KNOWLEDGE_BUDGET }, { maxChunks: 12, maxChars: 14000 });
  assert.ok(BIT_CORE_KNOWLEDGE.length <= BIT_KNOWLEDGE_BUDGET.maxChunks,
    `${BIT_CORE_KNOWLEDGE.length} documents; the compiler truncates beyond ${BIT_KNOWLEDGE_BUDGET.maxChunks}`);
  const total = BIT_CORE_KNOWLEDGE.reduce((sum, doc) => sum + doc.text.length, 0);
  assert.ok(total <= BIT_KNOWLEDGE_BUDGET.maxChars,
    `corpus is ${total} chars; the compiler truncates beyond ${BIT_KNOWLEDGE_BUDGET.maxChars}`);
  for (const doc of BIT_CORE_KNOWLEDGE) {
    assert.ok(doc.text.length <= 4000, `${doc.sourceId} exceeds the 4000-char chunk cap`);
    assert.ok(doc.title && doc.sourceId, 'every doc carries a title and sourceId');
  }
  const surviving = normalizeKnowledgeChunks(BIT_CORE_KNOWLEDGE, BIT_KNOWLEDGE_BUDGET);
  assert.equal(surviving.length, BIT_CORE_KNOWLEDGE.length, 'no document is dropped by normalization');
});

// Two agents that answer the same question two different ways is worse than
// either answer, so Byte's documents are reused by reference, not copied.
test('Bit carries Byte’s whole corpus plus the chat-only documents', () => {
  const ids = BIT_CORE_KNOWLEDGE.map(doc => doc.sourceId);
  for (const doc of BYTE_CORE_KNOWLEDGE) {
    assert.ok(ids.includes(doc.sourceId), `Bit is missing Byte's ${doc.sourceId}`);
    assert.equal(BIT_CORE_KNOWLEDGE.find(entry => entry.sourceId === doc.sourceId).text, doc.text,
      `${doc.sourceId} was copied instead of shared, and has drifted`);
  }
  for (const own of ['bit-core-about-bit', 'bit-core-fit', 'bit-core-difference']) {
    assert.ok(ids.includes(own), `missing ${own}`);
  }
});

test('the corpus invents no prices and names no clients', () => {
  for (const doc of BIT_CORE_KNOWLEDGE) {
    assert.ok(!/[$£€]\s?\d/.test(doc.text), `${doc.sourceId} contains a currency amount`);
    assert.ok(!/\b\d+\s?%/.test(doc.text), `${doc.sourceId} contains a percentage claim`);
  }
});

// The house stance: prove it, never claim it. The head-on answer has to exist
// as retrievable text, and it has to concede something real — a case with no
// concession in it is a superlative wearing more words.
test('the “why are you the best” answer is retrievable, and concedes', () => {
  const doc = BIT_CORE_KNOWLEDGE.find(entry => entry.sourceId === 'bit-core-difference');
  assert.match(doc.text, /why are you the best/i, 'the doc is findable by the question as asked');
  assert.match(doc.text, /concession/i, 'the honest concessions are part of the approved answer');
  assert.match(doc.text, /template builder is genuinely fine/i);
  assert.match(doc.text, /Never claim awards, named clients, rankings, or specific results/);
  // Bit is never allowed to say it, in the persona or in the corpus.
  for (const entry of BIT_CORE_KNOWLEDGE) {
    assert.ok(!/BiteSites is the best/i.test(entry.text), `${entry.sourceId} calls BiteSites the best`);
  }
  assert.ok(BIT_CHAT_IDENTITY.instructions.some(line => /Never call BiteSites “the best”/.test(line)));
});

test('the fit document says plainly when an agent is the wrong answer', () => {
  const doc = BIT_CORE_KNOWLEDGE.find(entry => entry.sourceId === 'bit-core-fit');
  assert.match(doc.text, /Weaker fit, and say so plainly/);
  assert.match(doc.text, /Do not promise a specific number/);
});

test('tool grants and wire schemas cannot drift apart', () => {
  const schemaNames = Object.keys(BIT_TOOL_SCHEMAS).sort();
  assert.deepEqual([...BIT_TOOL_NAMES].sort(), schemaNames);
  for (const name of BIT_TOOL_NAMES) {
    assert.equal(BIT_TOOL_SCHEMAS[name].name, name);
    assert.equal(BIT_TOOL_SCHEMAS[name].type, 'function');
    assert.equal(BIT_TOOL_SCHEMAS[name].parameters.additionalProperties, false);
  }
  // Phone-campaign tools must never leak into the public web surface, and the
  // voice agent's hangup is not a thing a chat window can do.
  for (const forbidden of ['mark_do_not_call', 'request_human_handoff', 'send_approved_followup', 'flag_wrong_number', 'end_call']) {
    assert.ok(!BIT_TOOL_NAMES.includes(forbidden), `${forbidden} granted to the chat session`);
  }
  assert.ok(BIT_TOOL_NAMES.includes('end_chat'));
  assert.ok(BIT_TOOL_NAMES.includes('send_page_link'));
});

test('the link whitelist is closed, internal, and matches the enum the model sees', () => {
  assert.deepEqual([...BIT_PAGE_LINK_KEYS].sort(),
    ['booking', 'contact', 'portfolio', 'pricing', 'privacy', 'services', 'voice_agent']);
  assert.deepEqual([...BIT_TOOL_SCHEMAS.send_page_link.parameters.properties.destination.enum].sort(),
    [...BIT_PAGE_LINK_KEYS].sort(), 'the enum and the resolver disagree — the model can ask for a card the server refuses');

  assert.equal(BIT_PAGE_LINKS.booking.href, '/book');
  for (const key of BIT_PAGE_LINK_KEYS) {
    const link = BIT_PAGE_LINKS[key];
    assert.ok(link.label && link.detail, `${key} has no label or detail to render`);
    assert.ok(link.href.startsWith('/'), `${key} leaves this site: ${link.href}`);
    assert.ok(!/^\/\//.test(link.href), `${key} is protocol-relative and leaves this site`);
  }
});

test('compiled runtime carries the persona, the policies, and the whole corpus index', () => {
  const runtime = buildBitChatRuntime();
  const prompt = runtime.instructions;

  for (const block of [BIT_CHAT_IDENTITY, CHAT_SESSION_CONTEXT, CHAT_BOOKING_PLAYBOOK, HARD_QUESTION_POLICY]) {
    for (const line of block.instructions) {
      assert.ok(prompt.includes(line), `missing instruction: ${line.slice(0, 60)}…`);
    }
  }
  for (const doc of BIT_CORE_KNOWLEDGE) {
    assert.ok(prompt.includes(doc.title), `knowledge index is missing “${doc.title}”`);
  }
  assert.ok(prompt.includes('BOOKING A MEETING'), 'booking protocol included for a booking-permitted profile');
  assert.ok(prompt.includes('OFFER TRACKS'), 'offer catalogue rendered');
  assert.match(prompt, /Quote pricing: yes/);
  assert.match(prompt, /Book meetings: yes/);
  assert.match(prompt, /Collect payment: no/);
  // The compiler's universal layer is written for a phone call; the channel
  // block is what makes it true for a text window. Without it Bit inherits
  // rules about interruptions and reading email addresses out slowly.
  assert.match(prompt, /you are typing, not talking/);
  assert.match(prompt, /Plain text only/);
});

test('the chat session config is a text model with a modest output budget', () => {
  const runtime = buildBitChatRuntime();
  assert.equal(BIT_CHAT_MODEL, 'gpt-5.6-terra');
  assert.equal(runtime.model, BIT_CHAT_MODEL);
  assert.equal(runtime.toolSchemas.length, BIT_TOOL_NAMES.length);
  assert.deepEqual(runtime.tools, [...BIT_TOOL_NAMES]);
  assert.equal(runtime.maxOutputTokens, 600);
  assert.equal(runtime.reasoningEffort, 'low');
  // Nothing realtime leaks in: no voice, no turn detection, no audio config.
  assert.equal(runtime.session, undefined);
  assert.ok(!/semantic_vad/.test(runtime.instructions));
});

test('the profile is versioned and forbids inventing links or facts', () => {
  assert.equal(BIT_CHAT_PROFILE.id, 'bit-chat');
  assert.ok(BIT_CHAT_PROFILE.version >= 1);
  assert.equal(BIT_CHAT_PROFILE.permissions.mayCollectPayment, false);
  assert.equal(BIT_CHAT_PROFILE.permissions.maySendEmail, false);
  assert.ok(BIT_CHAT_PROFILE.rules.prohibitedClaims.some(rule => /Links come only from send_page_link/.test(rule)));
  assert.ok(BIT_GREETING.length > 40 && BIT_GREETING.length < 400);
});

// The shared tool bench carries each agent's identity as data. If a descriptor
// stops matching its profile, leads land under an agent name nobody deployed.
test('the shared tool bench agrees with both personas', () => {
  assert.equal(WEB_AGENT_IDENTITY.bitChat.agentId, BIT_CHAT_PROFILE.id);
  assert.equal(WEB_AGENT_IDENTITY.bitChat.source, 'bit_chat');
  assert.equal(WEB_AGENT_IDENTITY.byteVoice.agentId, BYTE_WEB_PROFILE.id);
  assert.equal(WEB_AGENT_IDENTITY.byteVoice.source, 'byte_voice');
  assert.notEqual(WEB_AGENT_IDENTITY.bitChat.conversationCollection, WEB_AGENT_IDENTITY.byteVoice.conversationCollection);
});

test('the compiled prompt is byte-identical across builds (prompt-cache friendly)', () => {
  assert.equal(buildBitChatRuntime().instructions, buildBitChatRuntime().instructions);
});
