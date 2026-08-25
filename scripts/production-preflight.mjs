#!/usr/bin/env node

// What a production Functions deploy would switch on, read before it does.
//
// This exists because of something found on 2026-08-25:
// `functions/.env.bitesites-org` — untracked, local, and read by every
// `firebase deploy --only functions` — contained
// `OUTBOUND_EXTERNAL_DIALING=enabled`. Nothing in the repository put it there
// and nothing in the repository would have noticed. Every readiness document
// said external dialing was disabled, `scripts/staging.mjs` writes `disabled`
// for staging and cannot touch production, and the deployed production
// functions predate the parameter entirely — so the claim was true about the
// deployed runtime and false about the file that would replace it.
//
// A deploy-time parameter is a *decision*, and a decision that only exists in
// an ignored file on one laptop is a decision nobody reviewed. This reads that
// file and refuses when it enables something the launch record has not
// authorised. It is the same shape as `screeningAdmission`: the flag alone is
// never enough, a matching authorization has to be present too.
//
// It changes nothing. It reads the dotenv, prints the three parameters that
// decide whether money can be spent or a stranger's phone can ring, and exits
// non-zero when one of them is open without the authorization beside it.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseParams } from './staging.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCTION_PROJECT = 'bitesites-org';
export const PRODUCTION_PARAM_FILE = join(ROOT, 'functions', `.env.${PRODUCTION_PROJECT}`);

/**
 * The recorded owner decisions, as environment variables.
 *
 * Deliberately not a file in the repository: a flag and its authorization
 * living in the same commit is one edit, and the whole point is that they are
 * two decisions made by two people at two times.
 */
export const EXTERNAL_DIALING_AUTHORIZATION_ENV = 'OUTBOUND_CANARY_AUTHORIZATION';
export const PAID_SCREENING_AUTHORIZATION_ENV = 'PAID_SCREENING_AUTHORIZATION';

/** Every `defineString` a production deploy must supply a value for. */
export const REQUIRED_PARAMS = Object.freeze([
  'BITESITES_DEPLOYMENT_ENVIRONMENT',
  'OUTBOUND_EXTERNAL_DIALING',
  'PAID_PHONE_SCREENING',
  'PUBLIC_APP_URL'
]);

const clean = value => String(value ?? '').trim();
const lower = value => clean(value).toLowerCase();
const authorized = value => lower(value) === 'authorized';

export const FINDING_LABELS = Object.freeze({
  param_file_missing:
    `functions/.env.${PRODUCTION_PROJECT} does not exist. A non-interactive Firebase deploy `
    + 'needs a value for every defineString parameter, including ones with defaults, so the '
    + 'deploy would fail before it started.',
  missing_parameter:
    'A required deploy parameter has no value. Firebase refuses a non-interactive deploy that '
    + 'is missing one, even when the parameter declares a default.',
  environment_not_production:
    'BITESITES_DEPLOYMENT_ENVIRONMENT is not "production" in the production parameter file. '
    + 'The runtime would treat the production project as a non-production environment.',
  external_dialing_enabled_without_authorization:
    `OUTBOUND_EXTERNAL_DIALING=enabled, and ${EXTERNAL_DIALING_AUTHORIZATION_ENV}=authorized is not `
    + 'set. Deploying this would admit carrier-backed dialing in production. §9 of '
    + 'OUTBOUND_LAUNCH_AUTHORIZATION.md — the 25/day external canary — has not been granted.',
  paid_screening_enabled_without_authorization:
    `PAID_PHONE_SCREENING=enabled, and ${PAID_SCREENING_AUTHORIZATION_ENV}=authorized is not set. `
    + 'Deploying this would let per-lookup vendor charges begin. §3 of '
    + 'OUTBOUND_LAUNCH_AUTHORIZATION.md has not been granted.'
});

/**
 * Read the production parameter file into a plain object.
 * A missing file is reported rather than thrown: "you have not written it yet"
 * and "you have written something dangerous" are both findings.
 */
export function readProductionParams(path = PRODUCTION_PARAM_FILE) {
  if (!existsSync(path)) return { exists: false, params: {} };
  return { exists: true, params: parseParams(readFileSync(path, 'utf8')) };
}

/**
 * Would deploying these parameters open something nobody authorised?
 *
 * Pure, so the decision can be tested without a dotenv on disk and without the
 * test needing to know what happens to be in this developer's copy.
 */
export function evaluateProductionDeployPolicy({ exists = true, params = {}, env = process.env } = {}) {
  const findings = [];

  if (!exists) {
    findings.push({ code: 'param_file_missing', parameter: '', value: '' });
    return { safe: false, findings, parameters: {} };
  }

  for (const name of REQUIRED_PARAMS) {
    if (!clean(params[name])) findings.push({ code: 'missing_parameter', parameter: name, value: '' });
  }

  if (clean(params.BITESITES_DEPLOYMENT_ENVIRONMENT) && lower(params.BITESITES_DEPLOYMENT_ENVIRONMENT) !== 'production') {
    findings.push({
      code: 'environment_not_production',
      parameter: 'BITESITES_DEPLOYMENT_ENVIRONMENT',
      value: clean(params.BITESITES_DEPLOYMENT_ENVIRONMENT)
    });
  }

  if (lower(params.OUTBOUND_EXTERNAL_DIALING) === 'enabled'
      && !authorized(env?.[EXTERNAL_DIALING_AUTHORIZATION_ENV])) {
    findings.push({
      code: 'external_dialing_enabled_without_authorization',
      parameter: 'OUTBOUND_EXTERNAL_DIALING',
      value: 'enabled'
    });
  }

  if (lower(params.PAID_PHONE_SCREENING) === 'enabled'
      && !authorized(env?.[PAID_SCREENING_AUTHORIZATION_ENV])) {
    findings.push({
      code: 'paid_screening_enabled_without_authorization',
      parameter: 'PAID_PHONE_SCREENING',
      value: 'enabled'
    });
  }

  return {
    safe: findings.length === 0,
    findings,
    // Only the policy parameters, never PUBLIC_APP_URL's siblings or anything
    // else that might be added to this file later. A preflight that prints the
    // whole environment is a preflight that eventually prints a secret.
    parameters: Object.fromEntries(
      ['BITESITES_DEPLOYMENT_ENVIRONMENT', 'OUTBOUND_EXTERNAL_DIALING', 'PAID_PHONE_SCREENING']
        .map(name => [name, clean(params[name]) || '(unset)'])
    )
  };
}

function main() {
  const { exists, params } = readProductionParams();
  const verdict = evaluateProductionDeployPolicy({ exists, params });

  process.stdout.write(`Production deploy preflight — ${PRODUCTION_PROJECT}\n\n`);
  for (const [name, value] of Object.entries(verdict.parameters)) {
    process.stdout.write(`  ${name}=${value}\n`);
  }
  process.stdout.write('\n');

  if (verdict.safe) {
    process.stdout.write('No parameter opens an unauthorised capability.\n');
    process.stdout.write(
      'This says nothing about whether a production deploy is otherwise appropriate — '
      + 'see OUTBOUND_LAUNCH_AUTHORIZATION.md.\n'
    );
    return 0;
  }

  process.stderr.write('Refusing to call this deploy safe:\n\n');
  for (const finding of verdict.findings) {
    const where = finding.parameter ? `${finding.parameter}: ` : '';
    process.stderr.write(`  - ${where}${FINDING_LABELS[finding.code] || finding.code}\n\n`);
  }
  return 1;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) process.exitCode = main();
