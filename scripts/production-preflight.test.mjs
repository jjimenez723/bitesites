// The production deploy preflight.
//
// Every assertion here is against the pure policy function rather than against
// whatever happens to be in this developer's `functions/.env.bitesites-org`.
// That file is untracked and differs between machines, which is precisely the
// problem the preflight exists to solve — a test that read it would pass or
// fail for reasons unrelated to the code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  evaluateProductionDeployPolicy, readProductionParams, REQUIRED_PARAMS,
  FINDING_LABELS, PRODUCTION_PROJECT,
  EXTERNAL_DIALING_AUTHORIZATION_ENV, PAID_SCREENING_AUTHORIZATION_ENV
} from './production-preflight.mjs';

const safeParams = {
  BITESITES_DEPLOYMENT_ENVIRONMENT: 'production',
  OUTBOUND_EXTERNAL_DIALING: 'disabled',
  PAID_PHONE_SCREENING: 'disabled',
  PUBLIC_APP_URL: 'https://bitesites.org'
};

const codes = verdict => verdict.findings.map(finding => finding.code);

test('a closed production parameter file is safe', () => {
  const verdict = evaluateProductionDeployPolicy({ params: safeParams, env: {} });
  assert.equal(verdict.safe, true);
  assert.deepEqual(verdict.findings, []);
  assert.deepEqual(verdict.parameters, {
    BITESITES_DEPLOYMENT_ENVIRONMENT: 'production',
    OUTBOUND_EXTERNAL_DIALING: 'disabled',
    PAID_PHONE_SCREENING: 'disabled'
  });
});

test('external dialing enabled without the canary authorization is refused', () => {
  const verdict = evaluateProductionDeployPolicy({
    params: { ...safeParams, OUTBOUND_EXTERNAL_DIALING: 'enabled' }, env: {}
  });
  assert.equal(verdict.safe, false);
  assert.deepEqual(codes(verdict), ['external_dialing_enabled_without_authorization']);
  assert.match(FINDING_LABELS.external_dialing_enabled_without_authorization, /canary/i);
});

test('the authorization is what makes it safe, and nothing else is', () => {
  const params = { ...safeParams, OUTBOUND_EXTERNAL_DIALING: 'enabled' };
  assert.equal(evaluateProductionDeployPolicy({
    params, env: { [EXTERNAL_DIALING_AUTHORIZATION_ENV]: 'authorized' }
  }).safe, true);

  // Near-misses are refusals, exactly as the runtime's own gates treat them.
  for (const value of ['', 'yes', 'true', 'enabled', 'authorised', 'authorize']) {
    assert.equal(
      evaluateProductionDeployPolicy({ params, env: { [EXTERNAL_DIALING_AUTHORIZATION_ENV]: value } }).safe,
      false,
      `${JSON.stringify(value)} must not authorize external dialing`
    );
  }
});

test('paid screening carries its own, separate authorization', () => {
  const params = { ...safeParams, PAID_PHONE_SCREENING: 'enabled' };
  assert.deepEqual(codes(evaluateProductionDeployPolicy({ params, env: {} })),
    ['paid_screening_enabled_without_authorization']);

  // Authorising the canary does not authorise the spend, and vice versa. They
  // are two decisions in OUTBOUND_LAUNCH_AUTHORIZATION.md and stay two here.
  assert.equal(evaluateProductionDeployPolicy({
    params, env: { [EXTERNAL_DIALING_AUTHORIZATION_ENV]: 'authorized' }
  }).safe, false);
  assert.equal(evaluateProductionDeployPolicy({
    params, env: { [PAID_SCREENING_AUTHORIZATION_ENV]: 'authorized' }
  }).safe, true);
});

test('both open at once produces both findings', () => {
  const verdict = evaluateProductionDeployPolicy({
    params: { ...safeParams, OUTBOUND_EXTERNAL_DIALING: 'enabled', PAID_PHONE_SCREENING: 'enabled' },
    env: {}
  });
  assert.deepEqual(codes(verdict).sort(), [
    'external_dialing_enabled_without_authorization',
    'paid_screening_enabled_without_authorization'
  ]);
});

test('a missing parameter is reported, because a deploy would fail on it', () => {
  // STAGING_ENVIRONMENT.md's trap: Firebase demands a value for every
  // defineString in a non-interactive deploy, including ones with defaults.
  for (const name of REQUIRED_PARAMS) {
    const params = { ...safeParams };
    delete params[name];
    const verdict = evaluateProductionDeployPolicy({ params, env: {} });
    assert.equal(verdict.safe, false, `${name} missing must be a finding`);
    assert.ok(verdict.findings.some(f => f.code === 'missing_parameter' && f.parameter === name));
  }
});

test('a production file that does not say production is a finding', () => {
  const verdict = evaluateProductionDeployPolicy({
    params: { ...safeParams, BITESITES_DEPLOYMENT_ENVIRONMENT: 'staging' }, env: {}
  });
  assert.deepEqual(codes(verdict), ['environment_not_production']);
});

test('an absent parameter file is a finding rather than a crash', () => {
  const verdict = evaluateProductionDeployPolicy({ exists: false, env: {} });
  assert.equal(verdict.safe, false);
  assert.deepEqual(codes(verdict), ['param_file_missing']);
  assert.deepEqual(verdict.parameters, {});
});

test('the verdict reports the policy parameters and nothing else from the file', () => {
  const verdict = evaluateProductionDeployPolicy({
    params: { ...safeParams, OPENAI_PROJECT_ID: 'proj_should_not_be_echoed' }, env: {}
  });
  assert.equal(JSON.stringify(verdict).includes('proj_should_not_be_echoed'), false,
    'a preflight that prints the whole environment eventually prints a secret');
});

test('reading a real file parses the parameters and skips comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'production-preflight-'));
  const path = join(dir, `.env.${PRODUCTION_PROJECT}`);
  writeFileSync(path, [
    '# deployment policy',
    'BITESITES_DEPLOYMENT_ENVIRONMENT=production',
    'OUTBOUND_EXTERNAL_DIALING=disabled',
    '',
    'PAID_PHONE_SCREENING=disabled',
    'PUBLIC_APP_URL=https://bitesites.org'
  ].join('\n'));

  const { exists, params } = readProductionParams(path);
  assert.equal(exists, true);
  assert.equal(params.OUTBOUND_EXTERNAL_DIALING, 'disabled');
  assert.equal(evaluateProductionDeployPolicy({ exists, params, env: {} }).safe, true);

  assert.deepEqual(readProductionParams(join(dir, 'nope')), { exists: false, params: {} });
});
