import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBlockedSecretPath, scanFiles, secretMatches } from './check-no-secrets.mjs';

test('real environment and credential selections are blocked anywhere in the tree', () => {
  assert.equal(isBlockedSecretPath('.env.staging'), true);
  assert.equal(isBlockedSecretPath('functions/.env.production'), true);
  assert.equal(isBlockedSecretPath('services/worker/.dev.vars'), true);
  assert.equal(isBlockedSecretPath('config/environments/staging.json'), true);
  assert.equal(isBlockedSecretPath('secrets/firebase-adminsdk-prod.json'), true);
});

test('reviewable examples and ordinary source files remain allowed', () => {
  assert.equal(isBlockedSecretPath('.env.example'), false);
  assert.equal(isBlockedSecretPath('functions/.env.staging.example'), false);
  assert.equal(isBlockedSecretPath('config/environments/staging.example.json'), false);
  assert.equal(isBlockedSecretPath('functions/agent-runtime.js'), false);
});

test('high-confidence credential material is detected without printing its value', () => {
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const openAi = ['sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const github = ['ghp_', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  assert.deepEqual(secretMatches(privateKey), ['private key']);
  assert.deepEqual(secretMatches(openAi), ['OpenAI API key']);
  assert.deepEqual(secretMatches(github), ['GitHub token']);
  assert.deepEqual(secretMatches('TWILIO_AUTH_TOKEN=replace-me'), []);
});

test('scanning real files reports both leaked contents and blocked filenames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-check-'));
  const leaky = join(dir, 'notes.txt');
  const clean = join(dir, 'clean.txt');
  writeFileSync(leaky, `token=${['ghp_', 'abcdefghijklmnopqrstuvwxyz123456'].join('')}\n`);
  writeFileSync(clean, 'TWILIO_AUTH_TOKEN=replace-me\n');

  assert.deepEqual(scanFiles([leaky]).map(finding => finding.kind), ['GitHub token']);
  assert.deepEqual(scanFiles([clean]), []);
  assert.deepEqual(scanFiles(['.env.production']).map(finding => finding.kind),
    ['blocked credential filename']);
});
