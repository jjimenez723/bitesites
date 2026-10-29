import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceTokenCache } from './voice-token.js';

test('preparation and subsequent joins reuse a valid token without another request', async () => {
  let requests = 0;
  const cache = createVoiceTokenCache({ fetchToken: async () => ({ token: `token-${++requests}`, expiresIn: 900 }) });
  const prepared = await cache.get();
  assert.equal((await cache.get()).token, prepared.token);
  assert.equal((await cache.get()).token, prepared.token);
  assert.equal(requests, 1);
});

test('refreshes before expiry and after a suspended tab misses the SDK event', async () => {
  let now = 0, requests = 0;
  const cache = createVoiceTokenCache({ now: () => now, fetchToken: async () => ({ token: `token-${++requests}`, expiresIn: 900 }) });
  assert.equal((await cache.get()).token, 'token-1');
  now = 839_999;
  assert.equal((await cache.get()).token, 'token-1');
  now = 840_000;
  assert.equal((await cache.get()).token, 'token-2');
  now += 1_800_000;
  assert.equal((await cache.get()).token, 'token-3');
});

test('SDK expiry and concurrent join requests share one refresh', async () => {
  let requests = 0;
  const cache = createVoiceTokenCache({ fetchToken: async () => ({ token: `token-${++requests}`, expiresIn: 900 }) });
  await cache.get();
  const expiring = cache.get({ force: true });
  const joining = cache.get();
  assert.equal(expiring, joining);
  assert.equal((await joining).token, 'token-2');
  assert.equal(requests, 2);
});

test('a failed refresh can be retried and never returns an expired token', async () => {
  let now = 0, requests = 0;
  const cache = createVoiceTokenCache({ now: () => now, fetchToken: async () => {
    if (++requests === 2) throw new Error('offline');
    return { token: `token-${requests}`, expiresIn: 900 };
  } });
  await cache.get();
  now = 900_000;
  await assert.rejects(cache.get(), /offline/);
  assert.equal((await cache.get()).token, 'token-3');
});

test('slow token responses do not extend the token lifetime', async () => {
  let now = 0, requests = 0;
  const cache = createVoiceTokenCache({ now: () => now, fetchToken: async () => {
    now += 30_000;
    return { token: `token-${++requests}`, expiresIn: 900 };
  } });
  await cache.get();
  now = 840_000;
  assert.equal((await cache.get()).token, 'token-2');
});

test('clearing the cache cannot be undone by a late response from the previous device', async () => {
  const responses = [];
  const cache = createVoiceTokenCache({ fetchToken: () => new Promise(resolve => responses.push(resolve)) });
  const old = cache.get();
  await Promise.resolve();
  cache.clear();
  const current = cache.get();
  await Promise.resolve();
  responses[0]({ token: 'old', expiresIn: 900 });
  await old;
  assert.equal(cache.get(), current, 'A stale completion must not clear the current pending request');
  responses[1]({ token: 'new', expiresIn: 900 });
  await current;
  assert.equal((await cache.get()).token, 'new');
});

test('missing expiry metadata is never reused and malformed responses are retryable', async () => {
  let requests = 0;
  const cache = createVoiceTokenCache({ fetchToken: async () => ++requests === 1 ? {} : { token: `token-${requests}` } });
  await assert.rejects(cache.get(), /voice access token/);
  assert.equal((await cache.get()).token, 'token-2');
  assert.equal((await cache.get()).token, 'token-3');
});
