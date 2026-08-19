// Browser transport for Bit, the homepage chat agent.
//
// The counterpart to src/lib/byte-voice.js, and deliberately much thinner.
// Byte has to run the model in the browser because that is where the
// microphone is, so her transport carries a WebRTC session and relays tool
// calls. Bit's whole agent — prompt, history, tools, model — lives in
// functions/bit-chat.js. This module posts a sentence and reads a reply.
//
// Nothing here decides anything. No persona text, no tool authority, no OpenAI
// key, and no conversation memory exist in this bundle; the session token is
// the only thing the browser holds, and it buys exactly one conversation.

const post = async (url, body, { keepalive = false } = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* status carries the failure */ }
  return { ok: response.ok, status: response.status, payload: payload && typeof payload === 'object' ? payload : {} };
};

/**
 * One flaky fetch must not read as "Bit is broken" mid-conversation, so turns
 * retry transient failures — a thrown fetch, a 5xx, or an empty body — with a
 * short backoff before the visitor is told anything went wrong. A 4xx is a
 * real answer (rate limited, session gone) and is returned immediately.
 */
async function postWithRetry(url, body, attempts = 3) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await post(url, body);
      if (Object.keys(response.payload).length && (response.ok || response.status < 500)) return response;
      last = response;
    } catch { last = null; }
    if (attempt < attempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return last;
}

/**
 * Open a session. Resolves to null when Bit is unavailable — rate limited, at
 * capacity, or not deployed — so the caller can show a friendly dead-endless
 * message rather than a spinner that never stops.
 */
export async function openBitSession({ chatId = '', sid = '', path = '/' } = {}) {
  const response = await postWithRetry('/api/bit-session', { chatId, sid, path });
  if (!response?.ok || !response.payload?.sessionId) {
    console.warn('[bit-chat] session unavailable', response?.status || 'network');
    return null;
  }
  return response.payload;
}

/** Send one visitor message. Resolves to null only when every retry failed. */
export async function sendBitMessage(session, message) {
  if (!session?.sessionId) return null;
  const response = await postWithRetry('/api/bit-chat', {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    action: 'message',
    message
  });
  return response?.payload?.messages ? response.payload : null;
}

/**
 * Close the session out. Fired from an unmount, so it is keepalive and never
 * awaited — the page may be gone before the response arrives.
 */
export function finalizeBitSession(session, reason = 'client_ended') {
  if (!session?.sessionId) return;
  post('/api/bit-chat', {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    action: 'finalize',
    reason
  }, { keepalive: true }).catch(() => {});
}
