// Refresh before expiry, including after an idle/suspended tab, without adding
// an authenticated network round trip to every browser conference join.
export function createVoiceTokenCache({ fetchToken, now = Date.now, refreshBufferMs = 60_000 }) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  let generation = 0;

  return {
    get({ force = false } = {}) {
      if (pending) return pending;
      if (!force && cached && expiresAt - now() > refreshBufferMs) return Promise.resolve(cached);
      const requestedAt = now();
      const currentGeneration = generation;
      const request = Promise.resolve().then(fetchToken).then(result => {
        if (!result?.token) throw new Error('Could not get a voice access token.');
        if (generation === currentGeneration) {
          cached = result;
          // Start the lifetime before the request so a slow response cannot
          // extend it. Missing expiry information never permits cached reuse.
          expiresAt = requestedAt + Math.max(0, Number(result.expiresIn) || 0) * 1000;
        }
        return result;
      }).finally(() => {
        if (pending === request) pending = null;
      });
      pending = request;
      return request;
    },
    clear() {
      generation += 1;
      cached = null;
      expiresAt = 0;
      pending = null;
    }
  };
}
