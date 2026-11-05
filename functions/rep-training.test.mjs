// Training access is pure, so this runs with plain `node --test`: no emulator,
// no credentials. Every server gate (campaign reads, sessions, dialing,
// transfers, appointments) asks these two helpers, so a wrong answer here
// either locks out a rep the admin cleared or lets an untrained one dial.
//
//   npm run test:rep-training

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepTrainingSession, evaluateRepTrainingTranscript, hasRepTrainingAccess, hasRepTrainingExemption,
  normalizeRepTrainingEvaluation, publicTrainingScenario, repTrainingScenarios
} from './rep-training.js';
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
  const buyer = buildRepTrainingSession({ sellerName: 'BiteSites', scenario: yesScenario }).instructions;
  assert.match(buyer, /you will say yes on this call/i);
  assert.match(buyer, /push back once or twice/i);
  assert.match(buildRepTrainingSession({ sellerName: 'BiteSites', scenario: noScenario }).instructions, /Never agree to a next step/);
  assert.match(buildRepTrainingSession({ sellerName: 'BiteSites', scenario: stopScenario }).instructions, /taken off the list/);
});

test('other sellers keep their own prospects and original behaviour', () => {
  const [stone] = repTrainingScenarios('stone-bellisimo');
  assert.equal(stone.outcome, undefined);
  assert.match(buildRepTrainingSession({ sellerName: 'Stone Bellisimo', scenario: stone }).instructions, /realistically skeptical/);
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

test('the coach is given the real prices and the scenario outcome', async () => {
  let sent = '';
  const fetchImpl = async (url, options) => {
    sent = JSON.parse(options.body).input[0].content;
    return { ok: true, text: async () => JSON.stringify({ output_text: JSON.stringify({ score: 92, closed: true, summary: 'Good.' }) }) };
  };
  const transcript = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'agent' : 'you', text: 'A full sentence that makes this practice call long enough to score.' }));
  const result = await evaluateRepTrainingTranscript({ apiKey: 'test', scenario: yesScenario, transcript, uid: 'rep', fetchImpl });
  assert.equal(result.passed, true);
  assert.match(sent, /Growth Site: From \$2,500/);
  assert.match(sent, /Every project is custom/);
  assert.match(sent, /going to say yes/);
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
