#!/usr/bin/env node
// Prints a machine-readable, deterministic synthetic conversation report.
// It intentionally has no credentials, provider clients, or write path.
import { evaluateAdversarialConversations } from '../functions/conversation-evals.js';

// Allow normal Unix consumers such as `head` to close the pipe without
// turning a successful evaluation into an unhandled EPIPE exception.
process.stdout.on('error', error => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

process.stdout.write(`${JSON.stringify(evaluateAdversarialConversations(), null, 2)}\n`);
