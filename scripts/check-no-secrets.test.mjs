import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBlockedSecretPath, scanFiles, secretMatches } from './check-no-secrets.mjs';

// Every fixture below is assembled at runtime from fragments rather than
// written out as a literal. Two reasons, and both matter:
//
//   * this file is itself tracked, so `npm run secrets:check -- --all` scans
//     it — a realistic literal here would make the scanner fail on its own
//     test suite;
//   * a fixture that reads as a credential gets copied into bug reports, chat
//     messages and CI logs by people who assume it is real.
//
// The generators produce high-entropy filler because the fixed-shape rules
// (Twilio SIDs, dotenv assignments) deliberately ignore repeated or sequential
// stand-ins — see the entropy note in check-no-secrets.mjs. Their strides are
// coprime to the alphabet length, so a fixture walks the whole alphabet rather
// than settling into a short repeating cycle.
const hex = (length, seed = 0) => Array.from({ length }, (_, index) =>
  '0123456789abcdef'[(index * 7 + seed) % 16]).join('');

const alnum = (length, seed = 0) => Array.from({ length }, (_, index) =>
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(index * 11 + seed) % 62]).join('');

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

// --------------------------------------------------------------------------
// The families this repository actually holds. Each one exists because a real
// secret of that shape is configured somewhere in OUTBOUND_CALLING_SETUP.md,
// LEAD_DISCOVERY_SETUP.md or the sideband service.
// --------------------------------------------------------------------------

test('a Google API key outside the browser bundle is a finding', () => {
  const key = ['AIza', alnum(35)].join('');
  assert.deepEqual(secretMatches(key, { file: 'functions/lead-discovery.js' }), ['Google API key']);
  assert.deepEqual(secretMatches(key, { file: 'scripts/seed-outbound.mjs' }), ['Google API key']);
  // No path at all still reports: a caller with nothing to exempt gets every rule.
  assert.deepEqual(secretMatches(key), ['Google API key']);
});

test('the public Firebase web config is exempt, and only under src/', () => {
  const key = ['AIza', alnum(35)].join('');
  // src/lib/firebase.js ships the project's public web config on purpose.
  assert.deepEqual(secretMatches(key, { file: 'src/lib/firebase.js' }), []);
  assert.deepEqual(secretMatches(key, { file: 'src/admin/outbound/data.js' }), []);
  // The exemption is anchored to the top of the path, not matched loosely.
  assert.deepEqual(secretMatches(key, { file: 'functions/src/config.js' }), ['Google API key']);
});

test('a Google OAuth refresh token is a finding wherever it appears', () => {
  const token = ['1//', alnum(40)].join('');
  assert.deepEqual(secretMatches(token, { file: '.github/workflows/deploy.yml' }),
    ['Google OAuth refresh token']);
});

test('both GoHighLevel token shapes are detected', () => {
  const header = ['eyJ', alnum(20, 13)].join('');
  const payload = ['eyJ', alnum(24, 17)].join('');
  const signature = alnum(32, 19);
  assert.deepEqual(secretMatches([header, payload, signature].join('.')), ['JSON Web Token']);

  const pit = ['pit-', hex(8), '-', hex(4, 5), '-', hex(4, 9), '-', hex(4, 3), '-', hex(12, 13)].join('');
  assert.deepEqual(secretMatches(pit), ['HighLevel private integration token']);
});

test('Twilio SIDs are detected, and their synthetic stand-ins are not', () => {
  const accountSid = ['AC', hex(32)].join('');
  const apiKeySid = ['SK', hex(32, 11)].join('');
  assert.deepEqual(secretMatches(accountSid), ['Twilio account SID']);
  assert.deepEqual(secretMatches(apiKeySid), ['Twilio API key SID']);

  // functions/twilio-compliance.test.mjs signs its fixtures with this shape.
  // Blocking it would mean deleting a real signature test to satisfy the
  // scanner, which is the wrong trade in both directions.
  assert.deepEqual(secretMatches(['AC', 'a'.repeat(32)].join('')), []);
  assert.deepEqual(secretMatches(['SK', '0'.repeat(32)].join('')), []);
});

test('a leaked dotenv line is a finding, whichever secret it carries', () => {
  for (const name of ['TWILIO_AUTH_TOKEN', 'OUTBOUND_WEBHOOK_SECRET', 'GHL_API_TOKEN',
    'GHL_CONTACTS_READ_TOKEN', 'OPENAI_WEBHOOK_SECRET', 'DISCOVERY_WORKER_SECRET']) {
    const line = `${name}=${hex(32, 13)}`;
    assert.deepEqual(secretMatches(line), ['assigned server secret'], `${name} should be reported`);
  }
  assert.deepEqual(secretMatches(`export OUTBOUND_WEBHOOK_SECRET=${alnum(40, 23)}`),
    ['assigned server secret']);
});

test('source that names a secret without holding one stays clean', () => {
  // Every line here is real code or real documentation from this repository.
  const sources = [
    "export const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');",
    '          TWILIO_AUTH_TOKEN: secretValue(TWILIO_AUTH_TOKEN)',
    "    '--set-secrets', 'OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_WEBHOOK_SECRET=OPENAI_WEBHOOK_SECRET:latest',",
    '  --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest,AI_MEDIA_WEBHOOK_SECRET=AI_MEDIA_WEBHOOK_SECRET:latest',
    'firebase functions:secrets:set GHL_CRM_DASHBOARD_TOKEN',
    "        token: process.env.GHL_API_TOKEN || '',",
    'OPENAI_API_KEY=',
    '# OUTBOUND_WEBHOOK_URL=https://bitesites.org/api/outbound-events',
    'OUTBOUND_WEBHOOK_SECRET     shared secret for the provider webhook endpoint'
  ];
  for (const line of sources) {
    assert.deepEqual(secretMatches(line), [], `should not report: ${line}`);
  }
});

test('a placeholder value is a template, not a leak', () => {
  for (const value of ['replace-me-before-deploying', 'your-token-goes-here', 'xxxxxxxxxxxxxxxxxxxx',
    'placeholder', 'CHANGEME_CHANGEME_CHANGEME']) {
    assert.deepEqual(secretMatches(`TWILIO_AUTH_TOKEN=${value}`), [],
      `should not report the placeholder ${value}`);
  }
});

test('one file can report more than one family', () => {
  const text = [
    ['ghp_', 'abcdefghijklmnopqrstuvwxyz123456'].join(''),
    `GHL_API_TOKEN=${hex(40, 13)}`
  ].join('\n');
  assert.deepEqual(secretMatches(text, { file: 'notes.md' }).sort(),
    ['GitHub token', 'assigned server secret']);
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

test('scanFiles passes the path through, so the browser-config exemption applies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-check-src-'));
  const bundled = join(dir, 'firebase.js');
  writeFileSync(bundled, `const apiKey = '${['AIza', alnum(35)].join('')}';\n`);

  // Scanned under its real repository path the rule is exempt; scanned under
  // any other path it is not. Same bytes, different verdict, on purpose.
  assert.deepEqual(scanFiles([bundled]).map(finding => finding.kind), ['Google API key']);
  assert.deepEqual(secretMatches(`const apiKey = '${['AIza', alnum(35)].join('')}';`,
    { file: 'src/lib/firebase.js' }), []);
});

test('a finding never carries the value that produced it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-check-quiet-'));
  const leaky = join(dir, 'leak.env.txt');
  const value = hex(40, 13);
  writeFileSync(leaky, `GHL_API_TOKEN=${value}\n`);

  const findings = scanFiles([leaky]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'assigned server secret');
  assert.equal(JSON.stringify(findings).includes(value), false,
    'the finding must not carry the matched value into logs');
});
