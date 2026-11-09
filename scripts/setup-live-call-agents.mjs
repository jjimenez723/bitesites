// One-time (and re-runnable) ElevenLabs setup for AI phone calls.
//
// Creates or updates, in this order:
//   1. a workspace secret holding AI_MEDIA_WEBHOOK_SECRET, sent as a header on
//      every tool call and on the initiation webhook
//   2. one webhook tool per grantable tool, pointing at /api/hybrid-ai-tools
//   3. the live-call agent and the tool-free preview agent
//   4. a SIP trunk "number" that Twilio dials, protected by a username/password
//   5. a post-call webhook (HMAC signed) used by the live-call agent only; its
//      signing secret goes straight into Secret Manager, never to the screen
//   6. the workspace's initiation webhook URL, but only if it is empty or
//      already ours: this account also holds another client's agents
// and writes the ids to functions/live-call-agent-ids.js.
//
// It changes account-wide ElevenLabs settings, so run it only with the owner's
// go-ahead. It never touches an agent, tool or number it did not create.
//
//   ELEVENLABS_API_KEY="$(firebase functions:secrets:access ELEVENLABS_API_KEY --project bitesites-org)" \
//   AI_MEDIA_WEBHOOK_SECRET="$(firebase functions:secrets:access AI_MEDIA_WEBHOOK_SECRET --project bitesites-org)" \
//   ELEVENLABS_SIP_PASSWORD="$(firebase functions:secrets:access ELEVENLABS_SIP_PASSWORD --project bitesites-org)" \
//   node scripts/setup-live-call-agents.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { LIVE_CALL_AGENT_IDS } from '../functions/live-call-agent-ids.js';
import { liveCallAgentConfig, livePreviewAgentConfig, liveCallToolConfigs } from '../functions/live-call-elevenlabs.js';

const BASE = 'https://bitesites.org';
const SIP_USER = 'bitesites-live-calls';
const required = name => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const key = required('ELEVENLABS_API_KEY');
const mediaSecret = required('AI_MEDIA_WEBHOOK_SECRET');
const sipPassword = required('ELEVENLABS_SIP_PASSWORD');

const api = async (path, options = {}) => {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    ...options, headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path.split('?')[0]} -> ${response.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
};
const ids = { ...LIVE_CALL_AGENT_IDS, tools: { ...LIVE_CALL_AGENT_IDS.tools } };
const save = () => writeFileSync(new URL('../functions/live-call-agent-ids.js', import.meta.url),
  `// Written by scripts/setup-live-call-agents.mjs. Do not edit by hand.\nexport const LIVE_CALL_AGENT_IDS = Object.freeze(${JSON.stringify(ids, null, 2)});\n`);

// 1. The header secret.
if (!ids.secretId) {
  ids.secretId = (await api('/v1/convai/secrets', {
    method: 'POST', body: JSON.stringify({ type: 'new', name: 'bitesites_ai_media_secret', value: mediaSecret })
  })).secret_id;
  save();
}
console.log('secret ready');

// 2. Tools.
for (const config of liveCallToolConfigs({ url: `${BASE}/api/hybrid-ai-tools`, secretId: ids.secretId })) {
  // Keyed by the server tool name, which never changes even if the agent-facing name does.
  const name = config.tool_config.api_schema.request_body_schema.properties.tool.constant_value;
  if (ids.tools[name]) await api(`/v1/convai/tools/${ids.tools[name]}`, { method: 'PATCH', body: JSON.stringify(config) });
  else ids.tools[name] = (await api('/v1/convai/tools', { method: 'POST', body: JSON.stringify(config) })).id;
}
save();
console.log(`${Object.keys(ids.tools).length} tools ready`);

// 3. Agents.
const syncAgent = async (config, known) => {
  if (known) { await api(`/v1/convai/agents/${known}`, { method: 'PATCH', body: JSON.stringify(config) }); return known; }
  return (await api('/v1/convai/agents/create', { method: 'POST', body: JSON.stringify(config) })).agent_id;
};
ids.agent = await syncAgent(liveCallAgentConfig({ toolIds: Object.values(ids.tools) }), ids.agent);
ids.previewAgent = await syncAgent(livePreviewAgentConfig(), ids.previewAgent);
save();
console.log('agents ready');

// 4. The SIP trunk number Twilio dials.
if (!ids.sipUser) {
  await api('/v1/convai/phone-numbers', {
    method: 'POST',
    body: JSON.stringify({
      phone_number: SIP_USER, label: 'BiteSites Live Calls (Twilio SIP)', provider: 'sip_trunk', agent_id: ids.agent,
      inbound_trunk_config: { credentials: { username: SIP_USER, password: sipPassword }, media_encryption: 'allowed' }
    })
  });
  ids.sipUser = SIP_USER;
  save();
}
console.log('SIP number ready');

// 5. Post-call webhook, for this agent only. Creating a workspace webhook
// needs the webhooks_write permission on the API key; without it, this step is
// skipped and must be done in the ElevenLabs dashboard (see the docs).
if (!ids.postCallWebhookId) {
  let created = null;
  try {
    created = await api('/v1/workspace/webhooks', {
      method: 'POST',
      body: JSON.stringify({ settings: { auth_type: 'hmac', name: 'BiteSites live call transcripts', webhook_url: `${BASE}/api/hybrid-ai-post-call` } })
    });
  } catch (error) {
    if (!/webhooks_write|missing_permissions/.test(error.message)) throw error;
    console.log('post-call webhook SKIPPED: the API key lacks webhooks_write. Create it in the dashboard.');
  }
  if (created) {
    const signingSecret = created.webhook_secret;
    if (!created.webhook_id || !signingSecret) throw new Error('ElevenLabs did not return the webhook id and signing secret.');
    const stored = spawnSync('node_modules/.bin/firebase', ['functions:secrets:set', 'ELEVENLABS_WEBHOOK_SECRET', '--data-file', '-', '--project', 'bitesites-org'], { input: signingSecret, stdio: ['pipe', 'ignore', 'inherit'] });
    if (stored.status !== 0) throw new Error('Could not store ELEVENLABS_WEBHOOK_SECRET in Secret Manager.');
    ids.postCallWebhookId = created.webhook_id;
    save();
  }
}
if (ids.postCallWebhookId) {
  await api(`/v1/convai/agents/${ids.agent}`, {
    method: 'PATCH',
    body: JSON.stringify({ platform_settings: { workspace_overrides: { webhooks: { post_call_webhook_id: ids.postCallWebhookId, events: ['transcript'] } } } })
  });
  console.log('post-call webhook ready');
}

// 6. The initiation webhook is one URL for the whole account.
const settings = await api('/v1/convai/settings');
const current = settings.conversation_initiation_client_data_webhook?.url || '';
const ours = `${BASE}/api/hybrid-ai-call-init`;
if (current && current !== ours) {
  throw new Error(`The account already uses another initiation webhook (${current}). Not replacing it.`);
}
await api('/v1/convai/settings', {
  method: 'PATCH',
  body: JSON.stringify({ conversation_initiation_client_data_webhook: { url: ours, request_headers: { 'x-ai-media-secret': { secret_id: ids.secretId } } } })
});
console.log('initiation webhook ready');
save();
console.log(`Live calls: agent ${ids.agent}, preview ${ids.previewAgent}, SIP user ${ids.sipUser}`);
