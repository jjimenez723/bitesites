#!/usr/bin/env node
// Prove the deployed staging stack is what we think it is.
//
// A green deploy says the functions uploaded. It does not say the callables are
// reachable, that they refuse an anonymous caller, that an admin can read what
// they should, or — the one that matters — that this environment still cannot
// place a carrier call. Those are four different claims and this checks each.
//
// Refuses to run against anything but the configured staging project. The whole
// value of a smoke test is that it exercises the real deployed thing, which is
// also exactly how it could touch production by accident.
//
//   node scripts/staging-smoke.mjs                # anonymous probes only
//   node scripts/staging-smoke.mjs --with-admin   # also provisions a temp admin
//
// `--with-admin` creates a disposable user in the STAGING project, gives it an
// admin role document, makes one authenticated call, and deletes both again.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WITH_ADMIN = process.argv.includes('--with-admin');
const REGION = 'us-central1';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
};

function stagingConfig() {
  const path = join(ROOT, 'config/environments/staging.json');
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error(`No staging config at ${path}. Run: npm run configure:staging -- --write`); }
  const config = JSON.parse(raw);
  const projectId = String(config.firebaseProjectId || '').trim();
  if (!projectId) throw new Error('staging.json has no firebaseProjectId');
  // The guard that makes this script safe to run at all.
  if (/bitesites-org|^bitesites$/i.test(projectId) || !/staging/i.test(projectId)) {
    throw new Error(`Refusing to smoke-test "${projectId}": this script only runs against a staging project.`);
  }
  return { ...config, projectId };
}

/** Pull the staging web API key out of the gitignored .env.staging. */
function readStagingWebApiKey() {
  try {
    const raw = readFileSync(join(ROOT, ".env.staging"), "utf8");
    return /^VITE_FIREBASE_API_KEY=(.+)$/m.exec(raw)?.[1]?.trim() || "";
  } catch { return ""; }
}

const callableUrl = (projectId, name) =>
  `https://${REGION}-${projectId}.cloudfunctions.net/${name}`;

async function callCallable(projectId, name, data = {}, idToken = '') {
  const response = await fetch(callableUrl(projectId, name), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idToken ? { authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({ data })
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

const config = stagingConfig();
const { projectId } = config;
console.log(`\nStaging smoke test — ${projectId}\n`);

// ---------------------------------------------------------------- deployment
//
// An anonymous POST to a callable that requires auth must come back as a clean
// `unauthenticated`, not a 404. A 404 means it never deployed; a 200 would mean
// the guard is missing.

const GUARDED_CALLABLES = [
  'listCampaignIncidentsCall',
  'resolveCampaignIncidentCall',
  'ingestPreDialScreeningCall',
  'listScreeningProviders',
  'startOutboundCampaign',
  'pauseOutboundCampaign'
];

for (const name of GUARDED_CALLABLES) {
  const { status, body } = await callCallable(projectId, name);
  const code = body?.error?.status || '';
  check(`${name} is deployed and refuses an anonymous caller`,
    status !== 404 && (code === 'UNAUTHENTICATED' || status === 401),
    `status=${status} code=${code || '(none)'}`);
}

// ------------------------------------------------------------- dialing gate
//
// The claim the whole staging environment rests on. Read off the deployed
// function's own configuration rather than the local file that produced it.

{
  const { execFileSync } = await import('node:child_process');
  let env = '';
  try {
    env = execFileSync('gcloud', [
      'functions', 'describe', 'dialNextTargets',
      `--project=${projectId}`, `--region=${REGION}`,
      '--format=value(serviceConfig.environmentVariables)'
    ], { encoding: 'utf8' });
  } catch (error) {
    env = `(could not read: ${error?.message || error})`;
  }
  const environment = /BITESITES_DEPLOYMENT_ENVIRONMENT=([^;\s]+)/.exec(env)?.[1] || '';
  const dialing = /OUTBOUND_EXTERNAL_DIALING=([^;\s]+)/.exec(env)?.[1] || '';
  check('the deployed runtime is marked as a non-production environment',
    environment !== '' && environment !== 'production', `environment=${environment || '(unset)'}`);
  check('the deployed runtime has external dialing disabled',
    dialing !== 'enabled', `externalDialing=${dialing || '(unset)'}`);
  check('paid phone screening is not enabled in staging',
    !/PAID_PHONE_SCREENING=enabled/.test(env));
}

// ------------------------------------------------------------ authenticated
//
// Optional because it writes: a disposable auth user and a role document, both
// removed at the end even if the call in between fails.

if (WITH_ADMIN) {
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore } = await import('firebase-admin/firestore');

  const app = initializeApp({ credential: applicationDefault(), projectId }, 'smoke');
  const auth = getAuth(app);
  const db = getFirestore(app);
  // The web API key is the browser's own identifier, and .env.staging is where
  // the staging build already keeps it. Read it rather than asking for it twice.
  const apiKey = String(
    config.webApiKey || process.env.STAGING_WEB_API_KEY || readStagingWebApiKey() || ''
  ).trim();

  const email = `smoke-${Date.now()}@staging.invalid`;
  let uid = '';
  // Kept so we can sign in as this user below. A custom token would need a
  // service-account signer, which local ADC cannot provide.
  const password = `S${Math.random().toString(36).slice(2)}!aA9`;
  try {
    const user = await auth.createUser({ email, password });
    uid = user.uid;
    await db.doc(`roles/${uid}`).set({ role: 'admin', createdBy: 'staging-smoke' });
    check('a disposable admin can be provisioned in staging', Boolean(uid));

    if (!apiKey) {
      check('an authenticated callable answers (skipped: no web API key configured)', true);
    } else {
      const exchange = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true })
        }
      );
      const signIn = await exchange.json();
      const idToken = signIn?.idToken || '';
      check('the disposable admin can sign in and get an ID token',
        Boolean(idToken), signIn?.error?.message || '');

      if (idToken) {
        const providers = await callCallable(projectId, 'listScreeningProviders', {}, idToken);
        const list = providers.body?.result?.providers || [];
        check('listScreeningProviders answers an authenticated admin',
          providers.status === 200 && Array.isArray(list) && list.length >= 2,
          `status=${providers.status}`);
        check('the paid screening provider is present but marked paid',
          list.some(entry => entry.id === 'twilio_lookup' && entry.capabilities?.paidLookup === true));
        check('provider metadata carries secret names, never values',
          list.every(entry => (entry.requiredSecrets || []).every(name => /^[A-Z0-9_]+$/.test(name))));

        const incidents = await callCallable(
          projectId, 'listCampaignIncidentsCall', { campaignId: 'smoke-nonexistent' }, idToken);
        // Not-found is the right answer for a campaign that does not exist —
        // what matters is that the guard let an admin through to find out.
        check('listCampaignIncidentsCall admits an admin and scopes the campaign',
          incidents.status !== 401 && incidents.body?.error?.status !== 'UNAUTHENTICATED',
          `status=${incidents.status} code=${incidents.body?.error?.status || ''}`);
      }
    }
  } catch (error) {
    // An unconfigured Auth service is a setup gap, not a crash. Say which.
    const message = String(error?.message || error);
    const unconfigured = /CONFIGURATION_NOT_FOUND|configuration-not-found/i.test(message);
    check(unconfigured
      ? "Firebase Auth is initialised in staging (run: identityPlatform:initializeAuth)"
      : "the authenticated smoke path completed",
    false, message.slice(0, 200));
  } finally {
    if (uid) {
      await db.doc(`roles/${uid}`).delete().catch(() => {});
      await auth.deleteUser(uid).catch(() => {});
      console.log('  · disposable admin removed');
    }
  }
}

const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
if (failed.length) process.exitCode = 1;
