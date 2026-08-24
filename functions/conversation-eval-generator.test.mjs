import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAdversarialConversations } from './conversation-evals.js';
import {
  NEGATIVE_CONTROLS, VARIANTS_PER_TEMPLATE, fullAdversarialCorpus, generateAdversarialScenarios
} from './conversation-eval-generator.js';

test('the corpus clears the plan’s thousand-dialogue bar across all three sellers', () => {
  const corpus = fullAdversarialCorpus();
  assert.ok(corpus.length >= 1000, `corpus is ${corpus.length}, plan requires >= 1000`);

  for (const sellerId of ['bitesites', 'stone-bellisimo', 'fine-line-group']) {
    const forSeller = corpus.filter(entry => entry.sellerOnly === sellerId);
    assert.ok(forSeller.length >= 300, `${sellerId} has only ${forSeller.length} dialogues`);
  }

  // Breadth is the point: the plan names these dimensions specifically, and a
  // corpus that is a thousand copies of one of them proves nothing.
  const focuses = new Set(corpus.map(entry => entry.focus));
  for (const required of ['injection', 'authority', 'dnc', 'identity', 'wrong_party', 'grounding', 'booking', 'teardown']) {
    assert.ok(focuses.has(required), `no dialogue covers ${required}`);
  }
});

test('generated variants are distinct transcripts, not one transcript relabelled', () => {
  const generated = generateAdversarialScenarios();
  const forOneTemplate = generated
    .filter(entry => entry.sellerOnly === 'bitesites' && entry.id.startsWith('price_pressure_'));
  assert.equal(forOneTemplate.length, VARIANTS_PER_TEMPLATE);

  const transcripts = new Set(forOneTemplate.map(entry =>
    entry.events.map(item => `${item.speaker}:${item.content}:${item.name || ''}`).join('|')));
  assert.ok(transcripts.size >= 6,
    `only ${transcripts.size} distinct transcripts across ${VARIANTS_PER_TEMPLATE} variants`);
});

test('the whole corpus passes every critical gate', () => {
  const report = evaluateAdversarialConversations({ scenarios: fullAdversarialCorpus() });
  const failures = (report.results || []).filter(entry => entry.verdict !== 'passed');
  assert.deepEqual(
    failures.map(entry => ({ id: entry.id, seller: entry.sellerAccountId, failed: entry.criticalFailures })),
    [], 'every generated dialogue must clear the critical gates');
});

// The load-bearing test. Everything above would still pass if the gates were
// wired to always return true.
test('the evaluator actually catches a caller that misbehaves', () => {
  for (const control of NEGATIVE_CONTROLS) {
    const report = evaluateAdversarialConversations({ scenarios: [control] });
    const result = (report.results || [])[0];
    assert.ok(result, `${control.id} produced no result`);
    assert.equal(result.verdict, 'failed', `${control.id} was not caught by the evaluator`);
    assert.ok(result.criticalFailures.includes(control.expectFailure),
      `${control.id} failed, but not on ${control.expectFailure} (got ${result.criticalFailures.join(', ')})`);
  }
});

test('a negative control is not quietly excluded from the shipped corpus', () => {
  const shipped = new Set(fullAdversarialCorpus().map(entry => entry.id));
  for (const control of NEGATIVE_CONTROLS) {
    assert.equal(shipped.has(control.id), false,
      `${control.id} must stay out of the pass-required corpus — it is meant to fail`);
  }
});
