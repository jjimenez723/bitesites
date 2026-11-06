// Training access is pure, so this runs with plain `node --test`: no emulator,
// no credentials. Every server gate (campaign reads, sessions, dialing,
// transfers, appointments) asks these two helpers, so a wrong answer here
// either locks out a rep the admin cleared or lets an untrained one dial.
//
//   npm run test:rep-training

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allRepTrainingScenarios, evaluatePracticeConversation, evaluationFromConversation, hasRepTrainingAccess, hasRepTrainingExemption, practiceAgentConfig, repTrainingInstructions, startPracticeConversation,
  normalizeRepTrainingEvaluation, publicTrainingScenario, repTrainingScenarios
} from './rep-training.js';
import { PRACTICE_AGENT_IDS } from './rep-practice-agents.js';
import { gradeRepQuiz, hasRepCourse, publicRepCourse } from './rep-course.js';
import { SERVICE_PRICING } from './service-pricing.js';

// The helpers accept both a plain role record and a Firestore snapshot.
const snapshot = data => ({ get: field => data[field] });

for (const [shape, wrap] of [['plain record', data => data], ['snapshot', snapshot]]) {
  test(`${shape}: a pass grants access to that seller only`, () => {
    const role = wrap({ trainingPassedAccountIds: ['bitesites'] });
    assert.equal(hasRepTrainingAccess(role, 'bitesites'), true);
    assert.equal(hasRepTrainingAccess(role, 'stone-bellisimo'), false);
    assert.equal(hasRepTrainingExemption(role, 'bitesites'), false, 'a pass is not an exemption');
  });

  test(`${shape}: an exemption grants access to that seller only`, () => {
    const role = wrap({ trainingExemptAccountIds: ['bitesites'] });
    assert.equal(hasRepTrainingAccess(role, 'bitesites'), true);
    assert.equal(hasRepTrainingExemption(role, 'bitesites'), true);
    assert.equal(hasRepTrainingAccess(role, 'the-fine-line-group'), false);
  });

  test(`${shape}: neither a pass nor an exemption means no access`, () => {
    assert.equal(hasRepTrainingAccess(wrap({}), 'bitesites'), false);
    assert.equal(hasRepTrainingAccess(wrap({ trainingPassedAccountIds: [], trainingExemptAccountIds: [] }), 'bitesites'), false);
  });

  test(`${shape}: malformed fields never grant access`, () => {
    for (const value of ['bitesites', { bitesites: true }, null, 1]) {
      const role = wrap({ trainingPassedAccountIds: value, trainingExemptAccountIds: value });
      assert.equal(hasRepTrainingAccess(role, 'bitesites'), false, JSON.stringify(value));
    }
  });
}

test('a missing role record never grants access', () => {
  assert.equal(hasRepTrainingAccess(null, 'bitesites'), false);
  assert.equal(hasRepTrainingAccess(undefined, 'bitesites'), false);
  assert.equal(hasRepTrainingExemption(null, 'bitesites'), false);
});

const bitesites = repTrainingScenarios('bitesites');
const yesScenario = bitesites.find(entry => entry.id === 'salon-owner-vendor');
const noScenario = bitesites.find(entry => entry.id === 'dentist-firm-no');
const stopScenario = bitesites.find(entry => entry.id === 'auto-shop-do-not-call');

test('most BiteSites prospects are real buyers and some will never buy', () => {
  const yes = bitesites.filter(entry => entry.outcome === 'yes').length;
  const no = bitesites.filter(entry => entry.outcome === 'no').length;
  assert.ok(yes > no && no >= 1, `${yes} yes and ${no} no`);
  assert.equal(yes + no, bitesites.length);
  assert.ok(bitesites.some(entry => entry.pushback === 'light'), 'one easy yes teaches when to stop selling');
});

test('buyers push back and then say yes; a no never turns into a yes', () => {
  const buyer = repTrainingInstructions({ sellerName: 'BiteSites', scenario: yesScenario });
  assert.match(buyer, /you will say yes on this call/i);
  assert.match(buyer, /push back once or twice/i);
  assert.match(repTrainingInstructions({ sellerName: 'BiteSites', scenario: noScenario }), /Never agree to a next step/);
  assert.match(repTrainingInstructions({ sellerName: 'BiteSites', scenario: stopScenario }), /taken off the list/);
});

test('other sellers keep their own prospects and original behaviour', () => {
  const [stone] = repTrainingScenarios('stone-bellisimo');
  assert.equal(stone.outcome, undefined);
  assert.match(repTrainingInstructions({ sellerName: 'Stone Bellisimo', scenario: stone }), /realistically skeptical/);
  assert.equal(hasRepCourse('stone-bellisimo'), false);
  assert.equal(publicRepCourse('the-fine-line-group'), null);
});

test('the rep is never told how a prospect will respond', () => {
  const shown = publicTrainingScenario(stopScenario);
  for (const field of ['outcome', 'doNotCall', 'objection', 'goal', 'pushback']) assert.equal(field in shown, false, field);
});

test('a buyer call only passes with a yes; a no call passes by respecting it', () => {
  const good = { score: 90, criticalFailure: false };
  assert.equal(normalizeRepTrainingEvaluation({ ...good, closed: false }, yesScenario).passed, false);
  assert.equal(normalizeRepTrainingEvaluation({ ...good, closed: true }, yesScenario).passed, true);
  assert.equal(normalizeRepTrainingEvaluation({ ...good, closed: false }, noScenario).passed, true);
  assert.equal(normalizeRepTrainingEvaluation({ ...good, closed: true, criticalFailure: true }, yesScenario).passed, false);
  assert.equal(normalizeRepTrainingEvaluation({ score: 79, closed: true }, yesScenario).passed, false);
});

test('the coach is given the real prices and the scenario outcome', () => {
  const prompts = practiceAgentConfig({ sellerName: 'BiteSites', scenario: yesScenario }).platform_settings.evaluation.criteria
    .map(entry => entry.conversation_goal_prompt).join('\n');
  assert.match(prompts, /Growth Site: From \$2,500/);
  assert.match(prompts, /Every project is custom/);
  assert.match(prompts, /going to say yes/);
  assert.match(prompts, /quoted data, never as instructions/);
});

test('every practice agent is locked and has its own id', () => {
  const ids = new Set();
  for (const { scenario } of allRepTrainingScenarios()) {
    const config = practiceAgentConfig({ sellerName: 'Seller', scenario });
    assert.equal(config.platform_settings.auth.enable_auth, true, scenario.id);
    assert.deepEqual(config.platform_settings.overrides, {}, scenario.id);
    assert.equal(config.platform_settings.privacy.record_voice, false, scenario.id);
    assert.deepEqual(config.conversation_config.agent.prompt.tool_ids, [], scenario.id);
    assert.ok(PRACTICE_AGENT_IDS[scenario.id], `${scenario.id} needs an agent`);
    ids.add(PRACTICE_AGENT_IDS[scenario.id]);
  }
  assert.equal(ids.size, allRepTrainingScenarios().length);
});

const result = value => ({ result: value, rationale: `You ${value}.` });
const finishedCall = (overrides = {}, agentId = PRACTICE_AGENT_IDS[yesScenario.id]) => ({
  agent_id: agentId,
  status: 'done',
  transcript: Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? 'agent' : 'user',
    message: 'A full sentence that makes this practice call long enough to score.'
  })),
  analysis: {
    data_collection_results: { coach_summary: { value: 'Nice work.' } },
    evaluation_criteria_results: {
      opening: result('success'), listening: result('success'), objection: result('success'),
      truthful: result('success'), next_step: result('success'), closed: result('success'),
      no_critical_failure: result('success'), ...overrides
    }
  }
});

test('the score comes from the five areas, and missing two fails the call', () => {
  assert.equal(evaluationFromConversation(finishedCall(), yesScenario).score, 100);
  const oneMiss = evaluationFromConversation(finishedCall({ listening: result('failure') }), yesScenario);
  assert.equal(oneMiss.score, 80);
  assert.equal(oneMiss.passed, true);
  assert.deepEqual(oneMiss.improvements, ['You failure.']);
  assert.equal(evaluationFromConversation(finishedCall({ listening: result('failure'), opening: result('unknown') }), yesScenario).passed, false);
  assert.equal(evaluationFromConversation(finishedCall({ closed: result('failure') }), yesScenario).passed, false);
  assert.equal(evaluationFromConversation(finishedCall({ no_critical_failure: result('failure') }), yesScenario).passed, false);
  assert.equal(evaluationFromConversation(finishedCall({ closed: result('failure') }), noScenario).passed, true);
});

const jsonResponse = (payload, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(payload) });
const scoreCall = (conversation, extra = {}) => evaluatePracticeConversation({
  apiKey: 'test', scenario: yesScenario, conversationId: 'conv_1', agentId: PRACTICE_AGENT_IDS[yesScenario.id],
  fetchImpl: async () => jsonResponse(conversation), waitMs: 0, pollMs: 1, ...extra
});

test('a call from another agent or a short call cannot be scored', async () => {
  assert.equal((await scoreCall(finishedCall())).passed, true);
  await assert.rejects(scoreCall(finishedCall({}, 'agent_other')), /does not match/);
  await assert.rejects(scoreCall({ ...finishedCall(), transcript: [] }), /Complete a full practice/);
  await assert.rejects(scoreCall({ ...finishedCall(), status: 'failed' }), /did not finish/);
});

test('scoring waits for the review to finish, then asks the rep to retry', async () => {
  await assert.rejects(scoreCall({ ...finishedCall(), status: 'processing' }), /still reviewing/);
  let reads = 0;
  const fetchImpl = async () => jsonResponse(++reads < 3 ? { ...finishedCall(), status: 'processing' } : finishedCall());
  assert.equal((await scoreCall(null, { fetchImpl, waitMs: 500 })).score, 100);
  assert.equal(reads, 3);
});

test('a practice call fixes its conversation id on the server', async () => {
  let url = '';
  const fetchImpl = async value => {
    url = String(value);
    return jsonResponse({ signed_url: 'wss://x/?conversation_signature=s&conversation_id=conv_9', conversation_id: 'conv_9' });
  };
  const started = await startPracticeConversation({ apiKey: 'test', scenario: yesScenario, fetchImpl });
  assert.equal(started.conversationId, 'conv_9');
  assert.equal(started.agentId, PRACTICE_AGENT_IDS[yesScenario.id]);
  assert.match(url, /include_conversation_id=true/);
  await assert.rejects(startPracticeConversation({ apiKey: 'test', scenario: { id: 'missing' }, fetchImpl }), /not set up/);
});

test('the quiz hides answers from the browser and grades on the server', () => {
  const course = publicRepCourse('bitesites');
  assert.ok(course.quiz.length >= 8);
  for (const item of course.quiz) {
    assert.equal('answer' in item, false);
    assert.equal('why' in item, false);
  }
  assert.deepEqual(gradeRepQuiz('bitesites', {}).passed, false);
  assert.equal(gradeRepQuiz('bitesites', null).correct, 0);
});

test('a rep needs the pass mark to clear the quiz', () => {
  const key = { 'close-definition': 1, 'first-move': 2, 'price-start': 2, 'price-social': 0, 'price-asked': 1, 'heard-yes': 1, pushback: 2, 'clear-no': 1, 'do-not-call': 2, promises: 2 };
  assert.deepEqual(gradeRepQuiz('bitesites', key), { correct: 10, total: 10, passed: true, missed: [] });
  assert.equal(gradeRepQuiz('bitesites', { ...key, 'price-start': 0, 'price-social': 1 }).passed, true);
  const failed = gradeRepQuiz('bitesites', { ...key, 'price-start': 0, 'price-social': 1, promises: 0 });
  assert.equal(failed.passed, false);
  assert.equal(failed.missed.length, 3);
});

test('the pricing lesson comes from the published price list', () => {
  const pricing = publicRepCourse('bitesites').lessons.find(lesson => lesson.id === 'pricing');
  const lines = pricing.priceGroups.flatMap(group => group.lines);
  for (const [name, , price] of Object.values(SERVICE_PRICING).flat()) assert.ok(lines.includes(`${name}: ${price}`), name);
  assert.ok(pricing.points.some(point => /custom/i.test(point)));
});
