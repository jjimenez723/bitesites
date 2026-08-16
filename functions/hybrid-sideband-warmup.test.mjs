// Sideband warm-up:  npm run test:sideband-warmup
//
// This replaces a permanently-pinned Cloud Run instance, so the tests are
// written around the two ways that swap could hurt someone rather than around
// the happy path.
//
// The first is silence on a live call. The sideband attaches only after a
// prospect has already answered, so if the warm-up fails to fire for a session
// that can hand a call to the AI, a real person hears dead air. Every AI-capable
// shape must warm, and anything ambiguous must warm too.
//
// The second is a warm-up that breaks the thing carrying it. It rides the
// session heartbeat, which is what keeps a session from being reaped as
// abandoned — so no sideband failure, timeout, or misconfiguration may ever
// propagate out of these functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  warmSideband, warmSidebandForSession, sessionNeedsSideband, sidebandHealthUrl
} = await import('./hybrid-sideband-warmup.js');

const okFetch = () => {
  const calls = [];
  const impl = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200 }; };
  impl.calls = calls;
  return impl;
};

// ------------------------------------------------------------------- the URL

test('the health endpoint is derived from the configured origin', () => {
  assert.equal(sidebandHealthUrl('https://sideband.example.run.app'),
    'https://sideband.example.run.app/health');
});

test('a trailing slash does not produce a double slash', () => {
  assert.equal(sidebandHealthUrl('https://sideband.example.run.app/'),
    'https://sideband.example.run.app/health');
});

test('there is a default so an unset env var does not silently disable warming', () => {
  const url = sidebandHealthUrl(undefined);
  assert.match(url, /^https:\/\/.+\/health$/);
});

test('a non-https origin is refused rather than fetched', () => {
  for (const bad of ['http://insecure.example', 'not a url', 'ftp://x', '   ']) {
    assert.equal(sidebandHealthUrl(bad), '', `${bad} should not produce a URL`);
  }
});

// ------------------------------------------------- who needs a warm sideband

test('AI-capable sessions need the sideband', () => {
  assert.equal(sessionNeedsSideband({ operatingMode: 'ai' }), true);
  assert.equal(sessionNeedsSideband({ operatingMode: 'hybrid' }), true);
});

test('a human-only session does not pay to warm a service it never calls', () => {
  assert.equal(sessionNeedsSideband({ operatingMode: 'human' }), false);
});

// The autonomous runner dials under a synthetic `ai_<campaignId>` session that
// carries `mode: 'ai'` and no operatingMode. It has no browser and no
// heartbeat, so if this shape did not warm, every autonomous AI call would
// cold-start into a prospect who has already said hello.
test('the autonomous AI runner session needs the sideband', () => {
  assert.equal(sessionNeedsSideband({ mode: 'ai' }), true);
  assert.equal(sessionNeedsSideband({ mode: 'ai', userUid: 'system:ai' }), true);
});

test('a legacy human dialer session asserting neither mode does not warm', () => {
  // Warming here would hold a container alive for a session that never attaches
  // the AI — exactly the standing cost this change exists to remove.
  assert.equal(sessionNeedsSideband({}), false);
  assert.equal(sessionNeedsSideband({ operatingMode: '' }), false);
  assert.equal(sessionNeedsSideband({ mode: 'power' }), false);
  assert.equal(sessionNeedsSideband({ mode: 'parallel' }), false);
});

test('operatingMode wins over mode when both are present', () => {
  assert.equal(sessionNeedsSideband({ operatingMode: 'human', mode: 'parallel' }), false);
  assert.equal(sessionNeedsSideband({ operatingMode: 'hybrid', mode: 'parallel' }), true);
});

test('a finished session stops warming', () => {
  assert.equal(sessionNeedsSideband({ operatingMode: 'ai', status: 'ended' }), false);
  assert.equal(sessionNeedsSideband({ operatingMode: 'ai', status: 'stopped' }), false);
});

test('nothing at all is not a session', () => {
  assert.equal(sessionNeedsSideband(null), false);
  assert.equal(sessionNeedsSideband(undefined), false);
});

// ----------------------------------------------------------------- the ping

test('warming issues one GET to the health endpoint', async () => {
  const fetchImpl = okFetch();
  const result = await warmSideband({ fetchImpl, url: 'https://sb.example/health' });
  assert.equal(result.warmed, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://sb.example/health');
  assert.equal(fetchImpl.calls[0].options.method, 'GET');
});

test('the ping is bounded, so a hung sideband cannot stall the heartbeat', async () => {
  const fetchImpl = okFetch();
  await warmSideband({ fetchImpl, url: 'https://sb.example/health' });
  const { signal } = fetchImpl.calls[0].options;
  assert.ok(signal, 'the request must carry an abort signal');
  assert.equal(typeof signal.aborted, 'boolean');
});

test('an AI session warms through the session helper', async () => {
  const fetchImpl = okFetch();
  const result = await warmSidebandForSession({ operatingMode: 'ai' },
    { fetchImpl, url: 'https://sb.example/health' });
  assert.equal(result.warmed, true);
  assert.equal(fetchImpl.calls.length, 1);
});

test('a human-only session issues no request at all', async () => {
  const fetchImpl = okFetch();
  const result = await warmSidebandForSession({ operatingMode: 'human' },
    { fetchImpl, url: 'https://sb.example/health' });
  assert.equal(result.warmed, false);
  assert.equal(result.reason, 'not_ai_capable');
  assert.equal(fetchImpl.calls.length, 0);
});

// --------------------------------------------------- failure is never fatal

test('a rejected request resolves instead of throwing', async () => {
  const result = await warmSideband({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    url: 'https://sb.example/health'
  });
  assert.equal(result.warmed, false);
  assert.equal(result.reason, 'unreachable');
});

test('a timeout resolves instead of throwing', async () => {
  const result = await warmSideband({
    fetchImpl: async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    },
    url: 'https://sb.example/health'
  });
  assert.equal(result.warmed, false);
  assert.equal(result.reason, 'timeout');
});

test('a non-200 response is reported, not thrown', async () => {
  const result = await warmSideband({
    fetchImpl: async () => ({ ok: false, status: 503 }),
    url: 'https://sb.example/health'
  });
  assert.equal(result.warmed, false);
  assert.equal(result.reason, 'status_503');
});

test('an unconfigured URL is a no-op rather than a crash', async () => {
  const fetchImpl = okFetch();
  const result = await warmSideband({ fetchImpl, url: '' });
  assert.equal(result.warmed, false);
  assert.equal(result.reason, 'not_configured');
  assert.equal(fetchImpl.calls.length, 0);
});

// The dial paths that warm the sideband are exercised by the emulator suite. If
// the guard below regressed, `npm run test:outbound` would silently spin up the
// production media service on every run.
test('a run against the Firestore emulator never touches the deployed sideband', async () => {
  const previous = process.env.FIRESTORE_EMULATOR_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  try {
    const fetchImpl = okFetch();
    const result = await warmSideband({ fetchImpl, url: 'https://sb.example/health' });
    assert.equal(result.warmed, false);
    assert.equal(result.reason, 'emulated');
    assert.equal(fetchImpl.calls.length, 0, 'no request may leave an emulated run');
  } finally {
    if (previous === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
    else process.env.FIRESTORE_EMULATOR_HOST = previous;
  }
});

test('every failure mode still resolves through the session helper', async () => {
  const failures = [
    async () => { throw new Error('boom'); },
    async () => ({ ok: false, status: 500 }),
    async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; }
  ];
  for (const fetchImpl of failures) {
    const result = await warmSidebandForSession({ operatingMode: 'ai' },
      { fetchImpl, url: 'https://sb.example/health' });
    assert.equal(result.warmed, false, 'a failed warm-up must resolve, never reject');
  }
});
