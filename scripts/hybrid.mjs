#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'bitesites-org';
const REGION = 'us-central1';
const SIDEBAND_SERVICE = 'bitesites-realtime-sideband';
const SIDEBAND_SERVICE_ACCOUNT = `bitesites-sideband@${PROJECT}.iam.gserviceaccount.com`;
const NODE_22 = '/opt/homebrew/opt/node@22/bin/node';
const PARAM_FILE = join(ROOT, 'functions', `.env.${PROJECT}`);
const FUNCTIONS_PACKAGE = join(ROOT, 'functions', 'package.json');
const REQUIRED_SECRETS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_TWIML_APP_SID',
  'AI_MEDIA_WEBHOOK_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_WEBHOOK_SECRET',
  // Google Calendar sync. Firebase resolves every defineSecret at deploy time,
  // so this has to exist before the calendar functions will deploy — but the
  // booking engine does not need it. Left as a placeholder, Firestore stays the
  // book of record and the Google mirror simply stays off until a real service
  // account key is supplied.
  'GOOGLE_CALENDAR_CREDENTIALS',
];

/** Secrets that deploy fine as a placeholder rather than blocking setup. */
const PLACEHOLDER_SECRETS = { GOOGLE_CALENDAR_CREDENTIALS: '{}' };
const HYBRID_FUNCTIONS = [
  // Outbound control plane used by every dashboard tab. Keeping these in the
  // Hybrid release prevents a partial deployment from leaving UI buttons
  // pointed at 404s (notably resumeOutboundCampaign).
  'getOutboundConfig',
  'createLeadDiscoveryJob',
  'runLeadDiscoveryJob',
  'pauseLeadDiscoveryJob',
  'cancelLeadDiscoveryJob',
  'importProspectCsv',
  'resolveProspectDuplicate',
  'promoteProspectToLead',
  'createOutboundCampaign',
  'updateOutboundCampaign',
  'startOutboundCampaign',
  'pauseOutboundCampaign',
  'resumeOutboundCampaign',
  'cancelOutboundCampaign',
  'importOutboundTargets',
  'researchOutboundContact',
  'approveLeadResearch',
  'prepareTargetForDialing',
  'prepareCampaignResearch',
  'approveCampaignResearch',
  'createConsentEvidenceCandidateCall',
  'issueConsentGrantCall',
  'revokeConsentGrantCall',
  'startPowerDialerSession',
  'startParallelDialerSession',
  'dialNextTargets',
  'heartbeatDialerSession',
  'stopDialerSessionCall',
  'submitCallDisposition',
  'moveTargetToCallLater',
  'markTargetDoNotCall',
  'setHybridAutoTakeover',
  'requestHybridTakeover',
  'beginHybridListen',
  'stopHybridListen',
  'getHybridVoiceAccessToken',
  'listHybridTransferAgents',
  'requestHybridStaffTransfer',
  'acceptHybridStaffTransfer',
  'declineHybridStaffTransfer',
  'completeHybridStaffTransfer',
  'beginHybridCoachMonitor',
  'sendHybridCoachCue',
  'endHybridCoachMonitor',
  'listAIAgentProfiles',
  'createAIAgentProfile',
  'updateAIAgentProfile',
  'archiveAIAgentProfile',
  'previewAIAgentRuntime',
  'createAIAgentPreviewSession',
  'listAIKnowledgeBases',
  'createAIKnowledgeBase',
  'upsertAIKnowledgeDocument',
  'twilioHybridProspectTwiML',
  'twilioHybridBrowserTwiML',
  'twilioHybridConferenceEvent',
  'recordHybridCallEvent',
  'hybridAIMediaControl',
  'openAIRealtimeIncomingCall',
  'getActiveHybridDialerSession',
  'startHybridDialerSession',
  'heartbeatHybridDialerSession',
  'setHybridOperatingMode',
  'setHybridConcurrency',
  'dialHybridTargets',
  'stopHybridDialerSession',
  'endHybridCall',
  'markHybridCallDoNotCall',
  'submitHybridDisposition',
  'dispatchHybridAIToSip',
  'reconcileHybridAIMediaAttachments',
  'twilioHybridAIParticipantTwiML',
  'twilioHybridAISipEvent',
  'hybridSidebandControl',
  'hybridAICarrierControl',
  'handleHybridMachineAnswer',
  'twilioHybridVoicemailTwiML',
  'getCalendarAvailability',
  'getCalendarSettings',
  'updateCalendarSettings',
  'bookAppointment',
  'rescheduleAppointmentCall',
  'cancelAppointmentCall',
  'setAppointmentOutcome',
  'calendarMaintenance',
  'outboundNightlyMaintenance',
];
const FIREBASE_TARGETS = [
  ...HYBRID_FUNCTIONS.map(name => `functions:${name}`),
  'hosting',
  'firestore',
].join(',');

const colors = process.stdout.isTTY;
const { DEBUG: _ignoredDebug, ...CLEAN_ENV } = process.env;
const paint = (code, value) => colors ? `\u001b[${code}m${value}\u001b[0m` : value;
const ok = value => console.log(paint('32', `✓ ${value}`));
const warn = value => console.log(paint('33', `! ${value}`));
const fail = value => console.error(paint('31', `✗ ${value}`));
const heading = value => console.log(`\n${paint('1', value)}`);

function command(name, args, options = {}) {
  const result = spawnSync(name, args, {
    cwd: options.cwd || ROOT,
    env: options.env || CLEAN_ENV,
    encoding: 'utf8',
    input: options.input,
    stdio: options.capture
      ? ['pipe', 'pipe', 'pipe']
      : [options.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  if (options.capture) return result;
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${name} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function capture(name, args, options = {}) {
  const result = command(name, args, { ...options, capture: true });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function hasCommand(name) {
  return capture('sh', ['-c', `command -v ${name}`]).status === 0;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ensureNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major === 22) return;
  if (existsSync(NODE_22) && process.env.BITESITES_NODE22_REEXEC !== '1') {
    const bin = dirname(NODE_22);
    const result = spawnSync(NODE_22, process.argv.slice(1), {
      cwd: process.cwd(),
      env: {
        ...CLEAN_ENV,
        BITESITES_NODE22_REEXEC: '1',
        PATH: `${bin}:${process.env.PATH || ''}`,
      },
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }
  fail(`Node 22 is required; found ${process.version}. Install it with \`brew install node@22\` or your version manager.`);
  process.exit(1);
}

function npm(args, cwd = ROOT, options = {}) {
  return command('npm', args, { cwd, ...options });
}

function installWorkspace(label, cwd) {
  heading(`Installing ${label}`);
  const lockfile = join(cwd, 'package-lock.json');
  npm(existsSync(lockfile) ? ['ci'] : ['install'], cwd);
}

function validate() {
  ensureNode22();
  heading('Validating Hybrid Dialer V2');
  npm(['run', 'secrets:check', '--', '--all']);
  npm(['run', 'build']);
  npm(['run', 'test:hybrid-dialer']);
  npm(['run', 'test:agent-runtime']);
  npm(['run', 'check'], join(ROOT, 'functions'));
  npm(['run', 'check'], join(ROOT, 'services', 'realtime-sideband'));
  ok('Build, Hybrid V2 tests, and syntax checks passed');
}

function setup() {
  ensureNode22();
  heading(`BiteSites setup (${process.version})`);
  installWorkspace('web app', ROOT);
  installWorkspace('Firebase Functions', join(ROOT, 'functions'));
  installWorkspace('Realtime sideband', join(ROOT, 'services', 'realtime-sideband'));
  validate();
  preflight({ strict: false });
}

function readParams() {
  if (!existsSync(PARAM_FILE)) return {};
  return Object.fromEntries(readFileSync(PARAM_FILE, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
}

function cloudState({ requireSideband = true, requiredSecrets = REQUIRED_SECRETS } = {}) {
  const issues = [];
  const state = { issues, secretNames: [], sidebandUrl: '' };

  if (!hasCommand('firebase')) issues.push('Firebase CLI is not installed');
  else {
    const auth = capture('firebase', ['login:list']);
    if (auth.status !== 0 || !auth.stdout.includes('Logged in as')) issues.push('Firebase CLI is not authenticated');
    else ok('Firebase CLI is authenticated');
  }

  if (!hasCommand('gcloud')) {
    issues.push('Google Cloud CLI is not installed');
    return state;
  }

  const auth = capture('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  if (auth.status !== 0 || !auth.stdout) issues.push('Google Cloud CLI is not authenticated');
  else ok('Google Cloud CLI is authenticated');

  const activeProject = capture('gcloud', ['config', 'get-value', 'project']);
  if (activeProject.stdout !== PROJECT) issues.push(`Active gcloud project is ${activeProject.stdout || 'unset'} (expected ${PROJECT})`);
  else ok(`Active gcloud project is ${PROJECT}`);

  const secrets = capture('gcloud', ['secrets', 'list', `--project=${PROJECT}`, '--format=value(name)']);
  if (secrets.status !== 0) issues.push('Could not list Secret Manager secrets');
  else {
    state.secretNames = secrets.stdout.split(/\r?\n/).filter(Boolean);
    const missing = requiredSecrets.filter(name => !state.secretNames.includes(name));
    if (missing.length) issues.push(`Missing secrets: ${missing.join(', ')}`);
    else ok('All Hybrid V2 secret names exist');
  }

  const service = capture('gcloud', [
    'run', 'services', 'describe', SIDEBAND_SERVICE,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=value(status.url)',
  ]);
  if (service.status !== 0 || !service.stdout) {
    if (requireSideband) issues.push(`Cloud Run service ${SIDEBAND_SERVICE} is not deployed`);
    else warn(`Cloud Run service ${SIDEBAND_SERVICE} will be created by this deployment`);
  }
  else {
    state.sidebandUrl = service.stdout;
    ok(`Sideband service exists at ${service.stdout}`);
  }
  return state;
}

function preflight({
  strict = true,
  requireSideband = true,
  requiredSecrets = REQUIRED_SECRETS,
} = {}) {
  ensureNode22();
  heading('Local preflight');
  ok(`Node ${process.version}`);
  for (const relative of ['package-lock.json', 'functions/package-lock.json', 'services/realtime-sideband/package-lock.json']) {
    if (existsSync(join(ROOT, relative))) ok(`${relative} exists`);
    else fail(`${relative} is missing`);
  }

  const params = readParams();
  const issues = [];
  if (params.PUBLIC_APP_URL === 'https://bitesites.org') ok('PUBLIC_APP_URL is configured');
  else issues.push(`PUBLIC_APP_URL is missing from ${PARAM_FILE}`);
  if (/^proj_[A-Za-z0-9_-]+$/.test(params.OPENAI_PROJECT_ID || '')) ok('OPENAI_PROJECT_ID format is valid');
  else issues.push(`OPENAI_PROJECT_ID is missing or invalid in ${PARAM_FILE}`);

  heading('Cloud preflight');
  const cloud = cloudState({ requireSideband, requiredSecrets });
  issues.push(...cloud.issues);

  if (issues.length) {
    heading('Actions still required');
    for (const issue of issues) warn(issue);
    console.log('\nRun `npm run configure:hybrid` after exporting the required credential values.');
    if (strict) process.exitCode = 2;
  } else {
    ok('Hybrid V2 configuration preflight passed');
  }
  return { issues, cloud };
}

function secretInput(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) return '';
  // A service-account key is a JSON document, so it is the one credential that
  // legitimately arrives pretty-printed. Compact it rather than rejecting it —
  // the alternative is asking whoever runs setup to pipe it through jq.
  if (name === 'GOOGLE_CALENDAR_CREDENTIALS' && /\r|\n/.test(value)) {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      throw new Error(`${name} must be the service-account JSON key file's contents`);
    }
  }
  if (/\r|\n/.test(value)) throw new Error(`${name} must be a single-line value`);
  return value;
}

function setSecret(name, value) {
  console.log(`Setting ${name} (value hidden)`);
  command('firebase', [
    'functions:secrets:set', name,
    '--data-file', '-', '--project', PROJECT,
  ], { input: value });
}

async function twilioRequest(path, { accountSid, authToken, method = 'GET', body } = {}) {
  const response = await fetch(path.startsWith('http')
    ? path
    : `https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) {
    throw new Error(`Twilio provisioning failed (${response.status}): ${payload.message || 'unknown response'}`);
  }
  return payload;
}

async function provisionTwilio({ accountSid, authToken, existingNames, provided }) {
  if (!accountSid && !authToken) return {};
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    throw new Error('TWILIO_ACCOUNT_SID must be a valid AC-prefixed SID');
  }
  if (!authToken) throw new Error('TWILIO_AUTH_TOKEN is required with TWILIO_ACCOUNT_SID');

  heading('Validating and provisioning Twilio');
  await twilioRequest(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
    accountSid, authToken,
  });
  ok('Twilio account credentials are valid');

  const generated = {};
  const needsApp = !provided.TWILIO_TWIML_APP_SID && !existingNames.includes('TWILIO_TWIML_APP_SID');
  if (needsApp) {
    const friendlyName = 'BiteSites Hybrid Voice';
    const voiceUrl = 'https://bitesites.org/api/twilio-browser-twiml';
    const query = new URLSearchParams({ FriendlyName: friendlyName, PageSize: '20' });
    const listed = await twilioRequest(`/Applications.json?${query}`, { accountSid, authToken });
    let application = Array.isArray(listed.applications) ? listed.applications[0] : null;
    if (application?.sid) {
      application = await twilioRequest(`/Applications/${application.sid}.json`, {
        accountSid, authToken, method: 'POST',
        body: { FriendlyName: friendlyName, VoiceUrl: voiceUrl, VoiceMethod: 'POST' },
      });
      ok('Reused and updated the BiteSites TwiML App');
    } else {
      application = await twilioRequest('/Applications.json', {
        accountSid, authToken, method: 'POST',
        body: { FriendlyName: friendlyName, VoiceUrl: voiceUrl, VoiceMethod: 'POST' },
      });
      ok('Created the BiteSites TwiML App');
    }
    generated.TWILIO_TWIML_APP_SID = application.sid;
  }

  const hasKeyPair = provided.TWILIO_API_KEY_SID && provided.TWILIO_API_KEY_SECRET;
  const storedKeyPair = existingNames.includes('TWILIO_API_KEY_SID')
    && existingNames.includes('TWILIO_API_KEY_SECRET');
  if (!hasKeyPair && !storedKeyPair) {
    const created = await twilioRequest('https://iam.twilio.com/v1/Keys', {
      accountSid, authToken, method: 'POST',
      body: { AccountSid: accountSid, FriendlyName: 'BiteSites Hybrid Browser Voice' },
    });
    if (!created.sid || !created.secret) throw new Error('Twilio did not return the new API key secret');
    generated.TWILIO_API_KEY_SID = created.sid;
    generated.TWILIO_API_KEY_SECRET = created.secret;
    ok('Created a Twilio browser Voice API key (secret retained only in Secret Manager)');
  }
  return generated;
}

async function configure() {
  ensureNode22();
  if (!hasCommand('firebase') || !hasCommand('gcloud')) {
    throw new Error('Firebase CLI and Google Cloud CLI are required');
  }
  command('gcloud', ['config', 'set', 'project', PROJECT]);

  const currentParams = readParams();
  const projectId = String(process.env.OPENAI_PROJECT_ID || currentParams.OPENAI_PROJECT_ID || '').trim();
  if (projectId && !/^proj_[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error('OPENAI_PROJECT_ID must begin with proj_');
  }
  writeFileSync(PARAM_FILE, [
    '# Public Firebase deployment parameters for Hybrid Dialer V2.',
    'PUBLIC_APP_URL=https://bitesites.org',
    `OPENAI_PROJECT_ID=${projectId}`,
    '',
  ].join('\n'), { mode: 0o600 });
  ok(`Wrote public deployment parameters to ${PARAM_FILE}`);

  const existing = capture('gcloud', ['secrets', 'list', `--project=${PROJECT}`, '--format=value(name)']);
  const names = existing.stdout.split(/\r?\n/).filter(Boolean);
  const provided = Object.fromEntries(REQUIRED_SECRETS
    .map(name => [name, secretInput(name)]));
  const provisioned = await provisionTwilio({
    accountSid: provided.TWILIO_ACCOUNT_SID,
    authToken: provided.TWILIO_AUTH_TOKEN,
    existingNames: names,
    provided,
  });
  for (const name of REQUIRED_SECRETS) {
    let value = provided[name] || provisioned[name] || '';
    const rotateMediaSecret = process.env.ROTATE_AI_MEDIA_SECRET === 'true';
    if (!value && name === 'AI_MEDIA_WEBHOOK_SECRET'
        && (!names.includes(name) || rotateMediaSecret)) {
      value = randomBytes(48).toString('base64url');
    }
    // Create the placeholder only when nothing exists yet, so re-running
    // configure never overwrites a real key with an empty one.
    if (!value && PLACEHOLDER_SECRETS[name] && !names.includes(name)) {
      value = PLACEHOLDER_SECRETS[name];
      warn(`${name} not supplied — writing a placeholder. Google Calendar sync stays off until you set a real service-account key.`);
    }
    if (value) setSecret(name, value);
  }
  preflight({ strict: true });
}

function deploy() {
  ensureNode22();
  const result = preflight({ strict: true, requireSideband: false });
  if (result.issues.length) throw new Error('Deployment blocked by preflight');
  validate();
  firebaseDryRun();
  withHybridEntrypoint(() => command('firebase', [
    'deploy', '--only', FIREBASE_TARGETS, '--project', PROJECT,
  ]));
  ensureSidebandServiceAccount([
    'OPENAI_API_KEY', 'OPENAI_WEBHOOK_SECRET', 'AI_MEDIA_WEBHOOK_SECRET',
  ]);
  command('gcloud', [
    'run', 'deploy', SIDEBAND_SERVICE,
    '--source', join(ROOT, 'services', 'realtime-sideband'),
    `--project=${PROJECT}`, `--region=${REGION}`,
    `--service-account=${SIDEBAND_SERVICE_ACCOUNT}`,
    '--allow-unauthenticated', '--no-cpu-throttling', '--min=1', '--quiet',
    '--remove-env-vars', 'OPENAI_WEBHOOK_SECRET',
    '--update-env-vars', 'FIREBASE_CONTROL_URL=https://bitesites.org/api/hybrid-sideband-control,FIREBASE_CARRIER_URL=https://bitesites.org/api/hybrid-ai-carrier-control',
    '--set-secrets', 'OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_WEBHOOK_SECRET=OPENAI_WEBHOOK_SECRET:latest,AI_MEDIA_WEBHOOK_SECRET=AI_MEDIA_WEBHOOK_SECRET:latest',
  ]);
  preflight({ strict: true });
}

function ensureSidebandServiceAccount(secrets) {
  heading('Preparing least-privilege sideband identity');
  const existing = capture('gcloud', [
    'iam', 'service-accounts', 'describe', SIDEBAND_SERVICE_ACCOUNT,
    `--project=${PROJECT}`,
  ]);
  if (existing.status !== 0) {
    command('gcloud', [
      'iam', 'service-accounts', 'create', 'bitesites-sideband',
      '--display-name=BiteSites Realtime Sideband', `--project=${PROJECT}`,
    ]);
  }
  for (const secret of secrets) {
    const args = [
      'secrets', 'add-iam-policy-binding', secret,
      `--project=${PROJECT}`,
      `--member=serviceAccount:${SIDEBAND_SERVICE_ACCOUNT}`,
      '--role=roles/secretmanager.secretAccessor',
      '--quiet',
    ];
    let lastResult;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      lastResult = capture('gcloud', args);
      if (lastResult.status === 0) break;
      const propagationDelay = /service account .* does not exist/i.test(lastResult.stderr);
      if (!propagationDelay || attempt === 6) {
        throw new Error(`gcloud ${args.join(' ')} failed: ${lastResult.stderr || 'unknown error'}`);
      }
      const delaySeconds = Math.min(attempt * 2, 10);
      warn(`Service account is still propagating; retrying ${secret} access in ${delaySeconds}s`);
      sleep(delaySeconds * 1000);
    }
    ok(`Granted ${secret} access to the sideband identity`);
  }
  ok(`Sideband runtime identity is ${SIDEBAND_SERVICE_ACCOUNT}`);
}

async function bootstrapSideband() {
  ensureNode22();
  const bootstrapSecrets = REQUIRED_SECRETS.filter(name => name !== 'OPENAI_WEBHOOK_SECRET');
  const result = preflight({
    strict: true,
    requireSideband: false,
    requiredSecrets: bootstrapSecrets,
  });
  if (result.issues.length) throw new Error('Sideband bootstrap blocked by preflight');
  validate();
  ensureSidebandServiceAccount(['OPENAI_API_KEY', 'AI_MEDIA_WEBHOOK_SECRET']);
  command('gcloud', [
    'run', 'deploy', SIDEBAND_SERVICE,
    '--source', join(ROOT, 'services', 'realtime-sideband'),
    `--project=${PROJECT}`, `--region=${REGION}`,
    `--service-account=${SIDEBAND_SERVICE_ACCOUNT}`,
    '--allow-unauthenticated', '--no-cpu-throttling', '--min=0', '--quiet',
    '--set-env-vars', 'OPENAI_WEBHOOK_SECRET=bootstrap-pending,FIREBASE_CONTROL_URL=https://bitesites.org/api/hybrid-sideband-control,FIREBASE_CARRIER_URL=https://bitesites.org/api/hybrid-ai-carrier-control',
    '--set-secrets', 'OPENAI_API_KEY=OPENAI_API_KEY:latest,AI_MEDIA_WEBHOOK_SECRET=AI_MEDIA_WEBHOOK_SECRET:latest',
  ]);
  const service = capture('gcloud', [
    'run', 'services', 'describe', SIDEBAND_SERVICE,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=value(status.url)',
  ]);
  if (service.status !== 0 || !service.stdout) throw new Error('Cloud Run did not return a sideband URL');
  const health = await fetch(`${service.stdout}/health`);
  if (!health.ok) throw new Error(`Sideband health check returned ${health.status}`);
  ok(`Sideband bootstrap is healthy at ${service.stdout}`);
  console.log(`\nCreate the OpenAI realtime.call.incoming webhook at:\n${service.stdout}/openai/webhook`);
}

function firebaseDryRun() {
  ensureNode22();
  heading('Firebase Hybrid V2 deployment dry-run');
  withHybridEntrypoint(() => command('firebase', [
    'deploy', '--only', FIREBASE_TARGETS,
    '--dry-run', '--project', PROJECT,
  ]));
  ok('Firebase Hybrid V2 dry-run passed');
}

function withHybridEntrypoint(callback) {
  const original = readFileSync(FUNCTIONS_PACKAGE, 'utf8');
  const manifest = JSON.parse(original);
  manifest.main = 'hybrid-index.js';
  try {
    writeFileSync(FUNCTIONS_PACKAGE, `${JSON.stringify(manifest, null, 2)}\n`);
    return callback();
  } finally {
    writeFileSync(FUNCTIONS_PACKAGE, original);
  }
}

function testAll() {
  ensureNode22();
  heading('Running complete BiteSites test suite');
  npm(['run', 'test:all:raw']);
  ok('Complete test suite passed');
}

const action = process.argv[2] || 'setup';
try {
  if (action === 'setup') setup();
  else if (action === 'validate') validate();
  else if (action === 'preflight') preflight({ strict: true });
  else if (action === 'configure') await configure();
  else if (action === 'dry-run') firebaseDryRun();
  else if (action === 'bootstrap-sideband') await bootstrapSideband();
  else if (action === 'deploy') deploy();
  else if (action === 'test-all') testAll();
  else throw new Error(`Unknown action: ${action}`);
} catch (error) {
  fail(error?.message || String(error));
  process.exitCode = 1;
}
