import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

// Names this repository actually keeps in Secret Manager. They appear in source
// constantly as identifiers — `defineSecret('GHL_API_TOKEN')` — so a name alone
// proves nothing. What DOES prove something is a name assigned a literal value
// on a dotenv-shaped line, which is the shape a leaked `.env` copied into a
// tracked file takes. See DOTENV_SECRET below.
const SECRET_ENV_NAMES = Object.freeze([
  'AI_MEDIA_WEBHOOK_SECRET',
  'DISCOVERY_WORKER_SECRET',
  'GHL_API_TOKEN',
  'GHL_CONTACTS_READ_TOKEN',
  'GHL_CRM_DASHBOARD_TOKEN',
  'GHL_OUTBOUND_WORKFLOW_ID',
  'GHL_WEBHOOK_URL',
  'KIXIE_API_KEY',
  'KIXIE_BUSINESS_ID',
  'KIXIE_POWERLIST_ID',
  'KIXIE_WEBHOOK_SECRET',
  'LEAD_SOURCE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_WEBHOOK_SECRET',
  'OUTBOUND_WEBHOOK_SECRET',
  'POSTMARK_SERVER_TOKEN',
  'POSTMARK_WEBHOOK_SECRET',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_TWIML_APP_SID',
  'VOICE_WEBHOOK_SECRET'
]);

// Anchored to a whole line so that `--set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest`
// and `const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN')` — both of
// which are correct code and both of which mention a secret name next to an
// `=` — do not read as leaks. The value may not contain a quote, a comma,
// another `=`, a bracket or a `$`, so an expression is never mistaken for a
// literal.
const DOTENV_SECRET = new RegExp(
  String.raw`^[ \t]*(?:export[ \t]+)?(?:${SECRET_ENV_NAMES.join('|')})[ \t]*=[ \t]*(?<value>[^\s"'\x60,;=$(){}<>#]{16,})[ \t]*$`,
  'm'
);

// Values that say "fill this in". A template is meant to be committed, and a
// template with a long instructional value — `replace-me-before-deploying` —
// is still a template. Matching a marker anywhere in the value rather than
// requiring the whole value to be one is what makes that work; a real
// credential is base64/hex/opaque and does not contain English.
const PLACEHOLDER_MARKER =
  /(?:changeme|change[-_]me|replace|placeholder|redacted|removed|goes[-_]here|fill[-_]in|your[-_]|not[-_]?a[-_]?real|todo|tbd|example|sample|dummy|fake|unset)/i;

const PLACEHOLDER_EXACT =
  /^(?:none|null|undefined|secret|test|x+|\.+|-+)$/i;

const PLACEHOLDER_VALUE = value =>
  PLACEHOLDER_MARKER.test(String(value || '')) || PLACEHOLDER_EXACT.test(String(value || ''));

/**
 * How many distinct characters the token uses.
 *
 * Fixed-shape credentials (a Twilio SID is `AC` plus 32 hex characters) are
 * indistinguishable from the synthetic stand-ins tests and docs are full of —
 * `ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` matches the real shape exactly. Real
 * credential material is high-entropy; a repeated or sequential filler is not.
 * This is the cheapest test that separates them, and it errs toward reporting.
 */
const distinctCharacters = value => new Set(String(value || '')).size;

const MIN_DISTINCT_CHARACTERS = 10;

const looksSynthetic = value =>
  distinctCharacters(value) < MIN_DISTINCT_CHARACTERS || PLACEHOLDER_VALUE(value);

/**
 * `[label, pattern, options]`.
 *
 * `highEntropy` applies the synthetic-filler test above to the match.
 * `skipPaths` suppresses the rule for paths where the shape is legitimately
 * public — there is exactly one such case and it is documented at its use.
 */
const SECRET_PATTERNS = Object.freeze([
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Stripe live secret', /\bsk_live_[A-Za-z0-9]{20,}\b/],

  // Google API key — LEAD_SOURCE_API_KEY (Places) and anything else keyed the
  // same way. `src/` is exempt because the Firebase web SDK config and the
  // reCAPTCHA Enterprise site key are public by design and ship in the browser
  // bundle on purpose (src/lib/firebase.js says so at length). Nothing under
  // `src/` can hold a server key without also shipping it to every visitor,
  // which is a different and louder problem than this scanner solving.
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/, { skipPaths: /^src\// }],

  // A Google OAuth refresh token: `firebase login:ci`, gcloud ADC files, and
  // anything that pastes one into a workflow file.
  ['Google OAuth refresh token', /\b1\/\/[0-9A-Za-z_-]{30,}\b/],

  // GoHighLevel hands out both shapes: a JWT for the legacy API token and a
  // `pit-` UUID for a Private Integration token.
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['HighLevel private integration token',
    /\bpit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/],

  // Twilio: the account SID identifies the account and the API key SID always
  // travels with a secret. Both are fixed-shape, so both are entropy-filtered.
  ['Twilio account SID', /\bAC[0-9a-f]{32}\b/, { highEntropy: true }],
  ['Twilio API key SID', /\bSK[0-9a-f]{32}\b/, { highEntropy: true }],

  // A leaked dotenv line for any secret this repository owns.
  ['assigned server secret', DOTENV_SECRET, { highEntropy: true, capture: 'value' }]
]);

const normalizePath = file => String(file || '').trim().replaceAll('\\', '/');

export function isBlockedSecretPath(file) {
  const normalized = normalizePath(file).toLowerCase();
  if (!normalized) return false;
  const base = normalized.split('/').pop();
  if (/^\.env(?:$|\.)/.test(base)
      && !/\.(?:example|sample|template)$/.test(base)) return true;
  if (/^\.dev\.vars(?:$|\.)/.test(base)
      && !/\.(?:example|sample|template)$/.test(base)) return true;
  if (/^(?:service[-_.]?account|firebase[-_.]?adminsdk|google[-_.]?credentials).+\.json$/.test(base)) return true;
  if (/^config\/environments\/.+\.json$/.test(normalized)
      && !normalized.endsWith('.example.json')) return true;
  return false;
}

/**
 * Labels for the credential families found in `text`.
 *
 * `file` is optional and only affects rules that declare `skipPaths`; callers
 * scanning a string with no path get every rule. Values are never returned or
 * logged — a scanner that prints what it found is a scanner that copies the
 * secret into CI output, where it is at least as exposed as it was in the file.
 */
export function secretMatches(text, { file = '' } = {}) {
  const value = String(text || '');
  const path = normalizePath(file);
  const found = [];
  for (const [label, pattern, options = {}] of SECRET_PATTERNS) {
    if (options.skipPaths && path && options.skipPaths.test(path)) continue;
    const match = pattern.exec(value);
    if (!match) continue;
    const token = options.capture ? match.groups?.[options.capture] : match[0];
    if (options.highEntropy && looksSynthetic(token)) continue;
    found.push(label);
  }
  return found;
}

function gitFiles({ all = false } = {}) {
  const args = all
    ? ['ls-files', '--']
    : ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--'];
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map(normalizePath)
    .filter(Boolean);
}

function readableText(file) {
  try {
    if (statSync(file).size > MAX_TEXT_FILE_BYTES) return '';
    const buffer = readFileSync(file);
    if (buffer.includes(0)) return '';
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

export function scanFiles(files) {
  const findings = [];
  for (const file of files) {
    if (isBlockedSecretPath(file)) findings.push({ file, kind: 'blocked credential filename' });
    for (const kind of secretMatches(readableText(file), { file })) findings.push({ file, kind });
  }
  return findings;
}

export function runSecretCheck({ all = process.argv.includes('--all') } = {}) {
  const files = gitFiles({ all });
  const findings = scanFiles(files);
  if (findings.length) {
    console.error('Refusing to continue because tracked/staged credential material was detected:');
    for (const finding of findings) console.error(`- ${finding.file}: ${finding.kind}`);
    console.error('Remove the credential material, rotate any exposed value, and run the check again.');
    return 1;
  }
  console.log(`Secret check passed (${files.length} ${all ? 'tracked' : 'staged'} file${files.length === 1 ? '' : 's'} scanned).`);
  return 0;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) process.exitCode = runSecretCheck();
