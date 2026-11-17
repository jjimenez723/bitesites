import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseStagingConfig,
  buildStagingParams,
  parseParams,
  serializeParams,
  assertStagingParams,
  assertStagingFrontendConfig,
  firebaseAccountArgs,
  STAGING_DEPLOY_TARGETS
} from './staging.mjs';

const valid = () => ({
  schemaVersion: 1,
  environment: 'staging',
  firebaseProjectId: 'bitesites-staging-123',
  publicAppUrl: 'https://staging.bitesites.example',
  region: 'us-central1',
  sidebandService: 'bitesites-realtime-sideband-staging',
  externalDialing: 'disabled'
});

test('staging config requires a separate project and non-dialing flag', () => {
  assert.throws(() => parseStagingConfig({ ...valid(), firebaseProjectId: 'bitesites-org' }), /Refusing production project/);
  assert.throws(() => parseStagingConfig({ ...valid(), externalDialing: 'enabled' }), /must be exactly "disabled"/);
  assert.throws(() => parseStagingConfig({ ...valid(), publicAppUrl: 'https://bitesites.org' }), /non-production/);
});

test('staging parameter file hard-disables external dialing', () => {
  const config = parseStagingConfig(valid());
  const params = buildStagingParams(config);
  const reloaded = parseParams(serializeParams(params));
  assertStagingParams(config, reloaded);
  assert.equal(reloaded.BITESITES_DEPLOYMENT_ENVIRONMENT, 'staging');
  assert.equal(reloaded.OUTBOUND_EXTERNAL_DIALING, 'disabled');
  assert.equal(reloaded.PAID_PHONE_SCREENING, 'disabled');
  assert.equal(reloaded.BILLING_SITE_ORIGIN, config.publicAppUrl);
  assert.equal(reloaded.STRIPE_LIVE_MODE_AUTHORIZED, 'false');
  assert.throws(() => assertStagingParams(config, { ...reloaded, BILLING_SITE_ORIGIN: 'https://bitesites.org' }), /BILLING_SITE_ORIGIN/);
  assert.throws(() => assertStagingParams(config, { ...reloaded, STRIPE_LIVE_MODE_AUTHORIZED: 'true' }), /STRIPE_LIVE_MODE_AUTHORIZED/);
});

test('the staging deploy account is optional, explicit, and an email', () => {
  assert.deepEqual(firebaseAccountArgs([], {}), []);
  assert.deepEqual(firebaseAccountArgs(['--firebase-account=ops@example.com'], {}), ['--account', 'ops@example.com']);
  assert.deepEqual(firebaseAccountArgs([], { BITESITES_STAGING_FIREBASE_ACCOUNT: 'ops@example.com' }), ['--account', 'ops@example.com']);
  assert.throws(() => firebaseAccountArgs(['--firebase-account=--project'], {}), /email/);
  assert.match(STAGING_DEPLOY_TARGETS, /\bstorage\b/);
});

test('staging frontend must point at the reviewed staging Firebase project', () => {
  const config = parseStagingConfig(valid());
  const frontend = {
    VITE_FIREBASE_API_KEY: 'public-key',
    VITE_FIREBASE_AUTH_DOMAIN: 'bitesites-staging-123.firebaseapp.com',
    VITE_FIREBASE_PROJECT_ID: 'bitesites-staging-123',
    VITE_FIREBASE_STORAGE_BUCKET: 'bitesites-staging-123.firebasestorage.app',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '123',
    VITE_FIREBASE_APP_ID: '1:123:web:abc',
    VITE_APPCHECK_ENABLED: 'false'
  };
  assert.doesNotThrow(() => assertStagingFrontendConfig(config, frontend));
  assert.throws(() => assertStagingFrontendConfig(config, {
    ...frontend, VITE_FIREBASE_PROJECT_ID: 'bitesites-org'
  }), /does not match/);
  assert.throws(() => assertStagingFrontendConfig(config, {
    ...frontend, VITE_FIREBASE_AUTH_DOMAIN: 'bitesites.org'
  }), /production Firebase auth domain/);
  assert.throws(() => assertStagingFrontendConfig(config, {
    ...frontend, VITE_APPCHECK_ENABLED: 'true'
  }), /must remain disabled/);
});
