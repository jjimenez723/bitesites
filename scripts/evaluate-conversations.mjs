#!/usr/bin/env node
// Prints a machine-readable, deterministic synthetic conversation report.
// It intentionally has no credentials, provider clients, or write path.
import { evaluateAdversarialConversations } from '../functions/conversation-evals.js';
import { fullAdversarialCorpus } from '../functions/conversation-eval-generator.js';

// Allow normal Unix consumers such as `head` to close the pipe without
// turning a successful evaluation into an unhandled EPIPE exception.
process.stdout.on('error', error => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

// The hand-written scenarios plus the generated corpus — the count the
// readiness plan asks for. Still fixtures: see conversation-eval-generator.js
// on what a green report here does and does not prove.
const report = evaluateAdversarialConversations({ scenarios: fullAdversarialCorpus() });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
