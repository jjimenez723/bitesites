import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseStagingConfig,
  buildStagingParams,
  parseParams,
  serializeParams,
  assertStagingParams,
  assertStagingFrontendConfig
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
