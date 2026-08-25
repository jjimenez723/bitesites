#!/usr/bin/env node
// The conversational evaluation, in three modes.
//
//   (default)     Deterministic fixture report. No credentials, no network, no
//                 write path. Safe in CI, and the default for a reason.
//   --preflight   What a live run would ask for: model, request count, token
//                 estimates, sellers, output path, and the three authorizations
//                 it would need. Contacts nothing.
//   --live        A model-in-the-loop run. Refused unless the flag, a
//                 credential, and a recorded owner authorization are ALL
//                 present — see OUTBOUND_LAUNCH_AUTHORIZATION.md.
//
// A fixture report and a live report are graded by the same evaluator, so they
// are directly comparable. They are not equivalent evidence: the fixture
// generator writes the compliant reply itself, and `qualityGate.meaningful`
// says so in the payload rather than leaving somebody to remember it.

import { writeFile } from 'node:fs/promises';

import {
  evaluateAdversarialConversations, runAdversarialConversationEvaluation,
  compileEvaluationRuntime, formatAdversarialConversationEvaluation
} from '../functions/conversation-evals.js';
import { fullAdversarialCorpus } from '../functions/conversation-eval-generator.js';
import { SALES_READINESS_PROFILES } from '../functions/sales-readiness-eval.js';
import {
  createOpenAIConversationAdapter, describeLiveEvaluationPreflight,
  resolveLiveEvaluationAdmission, LIVE_ADMISSION_LABELS, DEFAULT_EVALUATION_MODEL
} from './conversation-eval-model-adapter.mjs';

// Allow normal Unix consumers such as `head` to close the pipe without
// turning a successful evaluation into an unhandled EPIPE exception.
process.stdout.on('error', error => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

const flag = name => process.argv.includes(`--${name}`);
const option = (name, fallback = '') => {
  const prefix = `--${name}=`;
  const found = process.argv.find(entry => entry.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const scenarios = fullAdversarialCorpus();
const limit = Math.max(0, Number(option('limit', '0')) || 0);
const model = option('model', DEFAULT_EVALUATION_MODEL);
const outputPath = option('out', '');

const emit = async payload => {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, body, 'utf8');
    process.stderr.write(`Wrote ${outputPath}\n`);
    return;
  }
  process.stdout.write(body);
};

const instructionsBySeller = Object.fromEntries(
  SALES_READINESS_PROFILES.map(profile => [
    profile.accountId, compileEvaluationRuntime(profile).instructions
  ])
);

const inputRate = Number(option('input-rate', ''));
const outputRate = Number(option('output-rate', ''));
const pricing = Number.isFinite(inputRate) && Number.isFinite(outputRate) && inputRate > 0
  ? { inputPer1M: inputRate, outputPer1M: outputRate }
  : null;

const preflight = describeLiveEvaluationPreflight({
  scenarios, profiles: SALES_READINESS_PROFILES, model, instructionsBySeller, pricing, outputPath, limit
});

if (flag('preflight')) {
  await emit({ kind: 'live_conversation_evaluation_preflight', ...preflight });
  process.exit(0);
}

if (!flag('live')) {
  // The corpus plus the hand-written scenarios — the count the readiness plan
  // asks for. Still fixtures: see conversation-eval-generator.js on what a
  // green report here does and does not prove.
  const report = evaluateAdversarialConversations({ scenarios });
  await emit(report);
  process.exit(0);
}

// ---------------------------------------------------------------- live run

const admission = resolveLiveEvaluationAdmission({
  enableLiveModel: true,
  apiKey: process.env.OPENAI_API_KEY,
  authorization: process.env.CONVERSATION_EVAL_LIVE_RUN
});

if (!admission.allowed) {
  process.stderr.write('Refusing to start a paid model evaluation.\n\n');
  for (const reason of admission.reasons) {
    process.stderr.write(`  - ${reason}: ${LIVE_ADMISSION_LABELS[reason] || ''}\n`);
  }
  process.stderr.write('\nWhat this run would have asked for:\n');
  process.stderr.write(`${JSON.stringify(preflight, null, 2)}\n`);
  process.exit(2);
}

process.stderr.write(`${JSON.stringify({ kind: 'live_conversation_evaluation_preflight', ...preflight }, null, 2)}\n`);

const adapter = createOpenAIConversationAdapter({ apiKey: process.env.OPENAI_API_KEY, model });
const report = await runAdversarialConversationEvaluation({
  scenarios: limit > 0 ? scenarios.slice(0, limit) : scenarios,
  adapter,
  enableLiveModel: true
});

await emit({
  ...report,
  live: {
    model,
    usage: adapter.usage,
    preflight,
    fidelityCaveat: preflight.fidelityCaveat
  }
});

process.stderr.write(`${formatAdversarialConversationEvaluation(report)}\n`);
// A run that did not meet the thresholds exits non-zero, so a pipeline cannot
// treat "the evaluation completed" as "the evaluation passed".
process.exit(report.qualityGate?.meetsThresholds ? 0 : 1);
