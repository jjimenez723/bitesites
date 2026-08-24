#!/usr/bin/env node

// Safe staging environment helper.
//
// It deliberately does not know credentials and it cannot target production.
// Staging writes Firebase deployment parameters that make external dialing
// impossible in the runtime, even if someone later supplies carrier secrets.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_PROJECT = 'bitesites-org';
const DEFAULT_CONFIG = join(ROOT, 'config', 'environments', 'staging.json');
const STAGING_VITE_ENV = join(ROOT, '.env.staging');
const REQUIRED_PARAM_VALUES = Object.freeze({
  BITESITES_DEPLOYMENT_ENVIRONMENT: 'staging',
  OUTBOUND_EXTERNAL_DIALING: 'disabled'
});

const clean = value => String(value || '').trim();

function argumentValue(name) {
  const prefix = `${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || '';
}

export function parseStagingConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Staging config must be a JSON object.');
  const config = {
    schemaVersion: Number(raw.schemaVersion),
    environment: clean(raw.environment).toLowerCase(),
    firebaseProjectId: clean(raw.firebaseProjectId),
    publicAppUrl: clean(raw.publicAppUrl),
    region: clean(raw.region),
    sidebandService: clean(raw.sidebandService),
    externalDialing: clean(raw.externalDialing).toLowerCase()
  };
  return validateStagingConfig(config);
}

export function validateStagingConfig(config) {
  if (config.schemaVersion !== 1) throw new Error('Staging config schemaVersion must be 1.');
  if (config.environment !== 'staging') throw new Error('Staging config environment must be exactly "staging".');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.firebaseProjectId)) {
    throw new Error('firebaseProjectId must be a valid Google Cloud project id.');
  }
  if (config.firebaseProjectId === PRODUCTION_PROJECT) {
    throw new Error(`Refusing production project ${PRODUCTION_PROJECT}; staging requires a separate project.`);
  }
  let url;
  try { url = new URL(config.publicAppUrl); } catch { throw new Error('publicAppUrl must be a valid absolute HTTPS URL.'); }
  if (url.protocol !== 'https:' || !url.hostname || ['bitesites.org', 'www.bitesites.org'].includes(url.hostname)) {
    throw new Error('publicAppUrl must be a non-production HTTPS staging origin.');
  }
  if (config.region !== 'us-central1') throw new Error('Staging region must currently be us-central1.');
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(config.sidebandService) || !config.sidebandService.includes('staging')) {
    throw new Error('sidebandService must be a valid, explicitly staging-named service.');
  }
  if (config.externalDialing !== 'disabled') {
    throw new Error('Staging externalDialing must be exactly "disabled".');
  }
  return Object.freeze({ ...config, publicAppUrl: url.origin });
}

export function stagingParamFile(config) {
  return join(ROOT, 'functions', `.env.${config.firebaseProjectId}`);
}

export function buildStagingParams(config) {
  return {
    '# Public Firebase deployment parameters for the non-dialing staging environment.': '',
    'PUBLIC_APP_URL': config.publicAppUrl,
    ...REQUIRED_PARAM_VALUES
  };
}

export function serializeParams(params) {
  return `${Object.entries(params)
    .map(([key, value]) => key.startsWith('#') ? key : `${key}=${value}`)
    .join('\n')}\n`;
}

export function parseParams(text) {
  return Object.fromEntries(String(text || '').split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
}

export function assertStagingParams(config, params) {
  if (params.PUBLIC_APP_URL !== config.publicAppUrl) {
    throw new Error('Staging PUBLIC_APP_URL does not match the reviewed staging config.');
  }
  for (const [name, value] of Object.entries(REQUIRED_PARAM_VALUES)) {
    if (params[name] !== value) throw new Error(`Staging parameter ${name} must be ${value}.`);
  }
}

export function assertStagingFrontendConfig(config, params) {
  const required = [
    'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID'
  ];
  for (const name of required) {
    if (!clean(params[name])) throw new Error(`Staging frontend variable ${name} is required.`);
  }
  if (params.VITE_FIREBASE_PROJECT_ID !== config.firebaseProjectId) {
    throw new Error('Staging frontend Firebase project does not match the reviewed staging config.');
  }
  if (params.VITE_FIREBASE_AUTH_DOMAIN === 'bitesites.org'
      || params.VITE_FIREBASE_AUTH_DOMAIN === 'bitesites-org.firebaseapp.com') {
    throw new Error('Staging frontend cannot use a production Firebase auth domain.');
  }
  if (params.VITE_APPCHECK_ENABLED !== 'false') {
    throw new Error('Staging App Check must remain disabled until a staging-only site key is configured.');
  }
}

function readConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`Staging config is missing: ${path}. Copy config/environments/staging.example.json to staging.json and fill only non-secret values.`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Staging config is not valid JSON: ${path}`); }
  return parseStagingConfig(raw);
}

function command(name, args) {
  execFileSync(name, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DEBUG: '' } });
}

function requireFirebaseCli() {
  try { execFileSync('firebase', ['--version'], { cwd: ROOT, stdio: 'ignore' }); }
  catch { throw new Error('Firebase CLI is required for this command.'); }
}

function loadLocalParams(config) {
  const path = stagingParamFile(config);
  if (!existsSync(path)) throw new Error(`Staging parameter file is missing: ${path}. Run configure:staging first.`);
  const params = parseParams(readFileSync(path, 'utf8'));
  assertStagingParams(config, params);
  return path;
}

function configure(config) {
  if (process.argv.includes('--write') !== true) {
    throw new Error('Refusing to write local deployment parameters without --write.');
  }
  const path = stagingParamFile(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeParams(buildStagingParams(config)), { mode: 0o600 });
  console.log(`Wrote non-secret staging parameters to ${path}`);
}

function preflight(config) {
  const paramPath = loadLocalParams(config);
  if (!existsSync(STAGING_VITE_ENV)) {
    throw new Error(`Staging frontend environment is missing: ${STAGING_VITE_ENV}.`);
  }
  assertStagingFrontendConfig(config, parseParams(readFileSync(STAGING_VITE_ENV, 'utf8')));
  console.log(`✓ staging project: ${config.firebaseProjectId}`);
  console.log(`✓ staging origin: ${config.publicAppUrl}`);
  console.log(`✓ staging parameters: ${paramPath}`);
  console.log(`✓ staging frontend: ${STAGING_VITE_ENV}`);
  console.log('✓ external dialing is hard-disabled for staging');
}

function dryRun(config) {
  preflight(config);
  requireFirebaseCli();
  command('firebase', [
    'deploy', '--only', 'firestore:rules,firestore:indexes,functions,hosting',
    '--dry-run', '--project', config.firebaseProjectId
  ]);
}

function deploy(config) {
  const confirmation = argumentValue('--confirm-staging-deploy');
  if (confirmation !== config.firebaseProjectId) {
    throw new Error(`Refusing deployment. Re-run with --confirm-staging-deploy=${config.firebaseProjectId}.`);
  }
  preflight(config);
  requireFirebaseCli();
  command('npm', ['run', 'build', '--', '--mode', 'staging']);
  command('npm', ['run', 'check', '--prefix', 'functions']);
  command('npm', ['run', 'check', '--prefix', 'services/realtime-sideband']);
  command('firebase', [
    'deploy', '--only', 'firestore:rules,firestore:indexes,functions,hosting',
    '--project', config.firebaseProjectId
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || 'preflight';
  try {
    const configPath = resolve(argumentValue('--config') || process.env.BITESITES_STAGING_CONFIG || DEFAULT_CONFIG);
    const config = readConfig(configPath);
    if (action === 'configure') configure(config);
    else if (action === 'preflight') preflight(config);
    else if (action === 'dry-run') dryRun(config);
    else if (action === 'deploy') deploy(config);
    else throw new Error(`Unknown staging action: ${action}`);
  } catch (error) {
    console.error(`✗ ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}
