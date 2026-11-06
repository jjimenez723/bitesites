//   npm run test:crisis
import test from 'node:test';
import assert from 'node:assert/strict';
import { BIT_CHAT_IDENTITY } from './bit-persona.js';
import { CRISIS_CARD, CRISIS_INSTRUCTION, CRISIS_MESSAGES, isCrisisMessage } from './crisis-support.js';
import { WEB_SESSION_CONTEXT } from './byte-persona.js';

test('crisis statements are caught however they are typed', () => {
  for (const text of [
    'i want to die', 'I WANT TO DIE', 'i wanna die', 'I want to kill myself', 'im going to kill myself',
    'I’m thinking about suicide', 'feeling suicidal', 'i want to end my life', 'thinking of ending it all',
    'i dont want to be alive', 'I don’t want to live anymore', 'i keep hurting myself', 'self harm', 'kms',
    'everyone would be better off without me', 'no reason to live', 'quiero morir', 'me quiero morir', 'voy a suicidarme'
  ]) assert.equal(isCrisisMessage(text), true, text);
});

test('ordinary business messages are left alone', () => {
  for (const text of [
    'what does a website cost', 'my old site is dying', 'this deal is killing it', 'I would die for good SEO results?',
    'our die cutting shop needs a website', 'we want to kill the old landing page', 'I am dying to see the portfolio',
    'can you end my subscription', 'how do I cut costs', '', null
  ]) assert.equal(isCrisisMessage(text), false, String(text));
});

test('the response points to real help and never sells', () => {
  const words = CRISIS_MESSAGES.join(' ');
  assert.match(words, /988/);
  assert.match(words, /911/);
  assert.doesNotMatch(words, /book|consult|free audit|✦/i);
  assert.deepEqual(CRISIS_CARD.actions.map(action => action.href), ['tel:988', 'sms:988', 'https://988lifeline.org/chat/']);
});

test('both agents carry the safety rule', () => {
  assert.ok(BIT_CHAT_IDENTITY.instructions.includes(CRISIS_INSTRUCTION));
  assert.ok(WEB_SESSION_CONTEXT.instructions.includes(CRISIS_INSTRUCTION));
});
