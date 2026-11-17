import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOutboundDeploymentPolicy,
  externalDialingAdmission,
  externalDialingBlockReason,
  callableAppCheckEnforced
} from './deployment-environment.js';

test('staging remains non-dialing even if a flag is accidentally enabled', () => {
  const result = externalDialingAdmission('twilio', {
    environment: 'staging', externalDialing: 'enabled'
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'non_production_environment');
});

test('production defaults to no external dialing', () => {
  const result = resolveOutboundDeploymentPolicy({ environment: 'production' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'external_dialing_not_explicitly_enabled');
});

test('only explicit production enablement admits a carrier provider', () => {
  assert.equal(externalDialingAdmission('twilio', {
    environment: 'production', externalDialing: 'enabled'
  }).allowed, true);
  assert.match(externalDialingBlockReason('gohighlevel', {
    environment: 'staging', externalDialing: 'disabled'
  }), /External dialing is disabled/);
});

test('mock provider remains available to emulators and tests', () => {
  assert.equal(externalDialingAdmission('mock', {
    environment: 'staging', externalDialing: 'enabled'
  }).allowed, true);
});

test('callable App Check is relaxed only for an explicit staging deployment', () => {
  assert.equal(callableAppCheckEnforced({}), true, 'unset resolves to production');
  assert.equal(callableAppCheckEnforced({ BITESITES_DEPLOYMENT_ENVIRONMENT: 'production' }), true);
  assert.equal(callableAppCheckEnforced({ BITESITES_DEPLOYMENT_ENVIRONMENT: 'stagin' }), true, 'a typo stays enforced');
  assert.equal(callableAppCheckEnforced({ BITESITES_DEPLOYMENT_ENVIRONMENT: ' Staging ' }), false);
});
