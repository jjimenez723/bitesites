// One Bit turn through a text-only ElevenLabs agent.
//
// The server opens the connection, so the browser only ever sees finished text.
// Tools are client tools answered here, which keeps every booking and lead write
// in our own code. Each turn is a fresh conversation that carries the history
// we store, so a visitor cannot rewrite Bit's memory.

const API = 'https://api.elevenlabs.io';
const SETTLE_MS = 250;

export const BIT_HISTORY_VARIABLE = 'conversation_so_far';

async function signedUrl(apiKey, agentId, fetchImpl) {
  const response = await fetchImpl(`${API}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, {
    headers: { 'xi-api-key': apiKey },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload?.signed_url) throw new Error('ElevenLabs did not return a chat link.');
  return payload.signed_url;
}

/**
 * Resolves with the agent's last reply. `onTool(name, args)` runs each tool and
 * returns what the agent is told. Rejects if the turn fails or times out.
 */
export async function runAgentTurn({
  apiKey, agentId, variables = {}, message, onTool, timeoutMs = 45000,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket
}) {
  const url = await signedUrl(apiKey, agentId, fetchImpl);
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    let reply = '';
    let pendingTools = 0;
    let settleTimer = null;
    let finished = false;

    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(settleTimer);
      clearTimeout(deadline);
      try { socket.close(); } catch { /* already closed */ }
      if (error) reject(error); else resolve(value);
    };
    const deadline = setTimeout(() => finish(reply ? null : new Error('The agent timed out.'), reply), timeoutMs);
    const send = payload => socket.send(JSON.stringify(payload));

    // A tool call can follow a reply, so wait a moment before calling it done.
    const settle = () => {
      clearTimeout(settleTimer);
      if (reply && !pendingTools) settleTimer = setTimeout(() => finish(null, reply), SETTLE_MS);
    };

    const runTool = async ({ tool_name: name, tool_call_id: id, parameters }) => {
      pendingTools += 1;
      clearTimeout(settleTimer);
      let result;
      try { result = await onTool(name, parameters && typeof parameters === 'object' ? parameters : {}); }
      catch { result = { ok: false, error: 'server_action_failed' }; }
      pendingTools -= 1;
      if (!finished) send({ type: 'client_tool_result', tool_call_id: id, result: JSON.stringify(result), is_error: false });
    };

    socket.onopen = () => {
      send({ type: 'conversation_initiation_client_data', dynamic_variables: variables });
      send({ type: 'user_message', text: message });
    };
    socket.onmessage = event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'ping') send({ type: 'pong', event_id: data.ping_event?.event_id });
      if (data.type === 'client_tool_call' && data.client_tool_call) runTool(data.client_tool_call);
      if (data.type === 'agent_response') {
        reply = String(data.agent_response_event?.agent_response || '').trim() || reply;
        settle();
      }
    };
    socket.onerror = () => finish(reply ? null : new Error('The agent connection failed.'), reply);
    socket.onclose = () => finish(reply ? null : new Error('The agent connection closed early.'), reply);
  });
}
