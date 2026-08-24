import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

const SECRET_PATTERNS = Object.freeze([
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Stripe live secret', /\bsk_live_[A-Za-z0-9]{20,}\b/]
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

export function secretMatches(text) {
  const value = String(text || '');
  return SECRET_PATTERNS
    .filter(([, pattern]) => pattern.test(value))
    .map(([label]) => label);
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
    for (const kind of secretMatches(readableText(file))) findings.push({ file, kind });
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
