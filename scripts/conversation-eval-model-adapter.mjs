// The live-model side of the conversational evaluation.
//
// `functions/conversation-evals.js` has always had the seam —
// `runAdversarialConversationEvaluation({ enableLiveModel: true, adapter })` —
// and has always said, correctly, that it contains no OpenAI client. Nothing
// filled the seam, so the readiness plan's conversational gate could not be
// closed even in principle: the corpus proves the gates accept correct
// behavior, not that a model produces it.
//
// This is the adapter. It lives in `scripts/` rather than in `functions/` for
// two reasons, and both are load-bearing:
//
//   * `functions/` is deployed. Putting a model client there would put an
//     OpenAI credential path inside the same bundle as the dialer, which is
//     what conversation-evals.js's header exists to prevent.
//   * an evaluation is an operator tool, run deliberately, with a cost. It
//     belongs next to the other scripts an operator runs on purpose.
//
// ---------------------------------------------------------------------------
// What a live run does and does not prove
// ---------------------------------------------------------------------------
//
// It replays the corpus's adversarial *prospect* turns at a real model and
// grades what the model says back, using the compiled seller runtime as its
// instructions and the real tool schemas the sideband advertises. That is a
// genuine model-in-the-loop rehearsal and it is the evidence the gate wants.
//
// It is **text**, and production is **realtime audio** (`gpt-realtime-2.1`
// over the sideband). A text rehearsal cannot show what interruption, latency,
// accent, or a dropped media leg do to the same model. Say so in any report
// that comes out of here; a green text run is necessary and not sufficient.
//
// Nothing here runs by itself. Three independent things must be true —
// an explicit flag, a credential, and a recorded owner authorization — and the
// admission function below refuses on any one of them, in the same shape the
// paid-screening gate uses.

import { TOOL_SCHEMAS } from '../services/realtime-sideband/tool-schemas.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * Text sibling of the model the sideband actually accepts a call with
 * (`gpt-realtime-2.1`, see services/realtime-sideband/server.js). Overridable,
 * because the point of a rehearsal is to be able to rehearse a candidate.
 */
export const DEFAULT_EVALUATION_MODEL = 'gpt-4.1';

export const MODEL_ATTEMPTS = 3;
export const MODEL_TIMEOUT_MS = 60_000;
/** How many tool round-trips one prospect turn may take before we stop. */
export const MAX_TOOL_HOPS = 4;

const text = (value, max = 4000) => String(value ?? '').slice(0, max);

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export const LIVE_RUN_AUTHORIZATION_ENV = 'CONVERSATION_EVAL_LIVE_RUN';

/**
 * May this process spend money on a model evaluation?
 *
 * Three independent conditions, deliberately. The flag alone is a typo away
 * from a five-figure run; a credential alone is a CI environment that happens
 * to have one exported; an authorization alone is a decision with no run
 * attached. `OUTBOUND_LAUNCH_AUTHORIZATION.md` records the decision, and this
 * refuses until the environment says it was made.
 */
export function resolveLiveEvaluationAdmission({
  enableLiveModel = false,
  apiKey = '',
  authorization = '',
  env = process.env
} = {}) {
  const reasons = [];
  if (enableLiveModel !== true) reasons.push('live_model_flag_not_set');
  if (!String(apiKey || env?.OPENAI_API_KEY || '').trim()) reasons.push('openai_api_key_missing');
  // Positive match only. Anything unset, empty or misspelled is a refusal.
  const granted = String(authorization || env?.[LIVE_RUN_AUTHORIZATION_ENV] || '').trim().toLowerCase();
  if (granted !== 'authorized') reasons.push('owner_authorization_not_granted');
  return { allowed: reasons.length === 0, reasons };
}

export const LIVE_ADMISSION_LABELS = Object.freeze({
  live_model_flag_not_set: 'Pass --live to request a model-in-the-loop run.',
  openai_api_key_missing: 'OPENAI_API_KEY is not set in this environment.',
  owner_authorization_not_granted:
    `Set ${LIVE_RUN_AUTHORIZATION_ENV}=authorized. This is the recorded owner decision to spend on `
    + 'a model evaluation; see OUTBOUND_LAUNCH_AUTHORIZATION.md.'
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

// Four characters per token. A heuristic, named as one: it is close enough to
// size a run and nowhere near precise enough to bill from, which is why the
// preflight reports token *estimates* and a cost only when someone hands in
// the rates they are actually being charged.
const estimateTokens = value => Math.ceil(String(value || '').length / 4);

/**
 * What a live run would cost, before it costs it.
 *
 * Deliberately refuses to invent a dollar figure. Model prices change, this
 * repository has no authoritative copy of them, and a confidently wrong number
 * on a spend approval is worse than no number. Supply `pricing` and it does the
 * arithmetic; omit it and it reports the inputs and says why the total is
 * missing.
 */
export function describeLiveEvaluationPreflight({
  scenarios = [],
  profiles = [],
  model = DEFAULT_EVALUATION_MODEL,
  instructionsBySeller = {},
  pricing = null,
  outputPath = '',
  limit = 0
} = {}) {
  const selected = limit > 0 ? scenarios.slice(0, limit) : scenarios;
  const sellers = [...new Set(selected.map(entry => entry.sellerOnly).filter(Boolean))].sort();

  let requests = 0;
  let promptTokens = 0;
  let outputTokens = 0;

  for (const scenario of selected) {
    const prospectTurns = scenario.events.filter(entry => entry.speaker === 'prospect').length;
    const toolTurns = scenario.events.filter(entry => entry.speaker === 'tool').length;
    // One request per prospect turn, plus one more for each tool round-trip
    // the transcript suggests the model will take.
    const scenarioRequests = Math.max(1, prospectTurns) + toolTurns;
    requests += scenarioRequests;

    const instructions = instructionsBySeller[scenario.sellerOnly] || '';
    const transcript = scenario.events.map(entry => entry.content || '').join(' ');
    // The conversation is re-sent on every turn, so the prompt cost grows
    // roughly with the square of the turn count. Approximated as
    // requests × (instructions + full transcript), which over-estimates early
    // turns and under-estimates none.
    promptTokens += scenarioRequests * (estimateTokens(instructions) + estimateTokens(transcript));
    outputTokens += scenarioRequests * 220;
  }

  const cost = pricing && Number.isFinite(Number(pricing.inputPer1M)) && Number.isFinite(Number(pricing.outputPer1M))
    ? (promptTokens / 1e6) * Number(pricing.inputPer1M) + (outputTokens / 1e6) * Number(pricing.outputPer1M)
    : null;

  return {
    model,
    sellers,
    profiles: profiles.map(entry => entry.accountId).filter(Boolean).sort(),
    scenarios: selected.length,
    scenariosAvailable: scenarios.length,
    estimatedRequests: requests,
    estimatedPromptTokens: promptTokens,
    estimatedOutputTokens: outputTokens,
    pricing: pricing || null,
    estimatedCostUsd: cost === null ? null : Math.round(cost * 100) / 100,
    costUnavailableReason: cost === null
      ? 'No per-million token rates were supplied. This repository holds no authoritative price list, '
        + 'and a wrong number on a spend approval is worse than no number.'
      : '',
    outputPath: outputPath || '',
    authorizationRequired: [
      '--live',
      'OPENAI_API_KEY',
      `${LIVE_RUN_AUTHORIZATION_ENV}=authorized`
    ],
    fidelityCaveat:
      'This is a text rehearsal. Production speech runs on the realtime audio path, so a green run '
      + 'here does not cover interruption, latency, accent, noise, or a dropped media leg.'
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/** Function tools for exactly the names the compiled runtime granted. */
export function toolDefinitionsFor(toolNames = []) {
  return toolNames
    .map(name => TOOL_SCHEMAS[name])
    .filter(Boolean);
}

/** The two things we care about out of a Responses payload. */
export function readModelOutput(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const calls = [];
  const parts = [];
  for (const item of output) {
    if (item?.type === 'function_call') {
      calls.push({
        callId: text(item.call_id, 120),
        name: text(item.name, 80),
        args: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
      });
    } else if (item?.type === 'message') {
      for (const chunk of (Array.isArray(item.content) ? item.content : [])) {
        if (chunk?.type === 'output_text' && chunk.text) parts.push(String(chunk.text));
      }
    }
  }
  return { text: parts.join(' ').trim(), calls };
}

/**
 * One call to the model, with the repository's existing retry posture: a 5xx
 * or a dropped socket is weather, a 4xx is a bug in what we sent.
 */
async function callModel({ apiKey, body, fetchImpl, sleepImpl, timeoutMs, attempts }) {
  let lastError = 'model_unavailable';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const raw = await response.text();
      let payload = {};
      try { payload = JSON.parse(raw); } catch { /* handled below */ }
      if (response.ok) return { ok: true, payload };
      lastError = text(payload?.error?.message || raw, 300) || `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) return { ok: false, error: lastError };
    } catch (error) {
      lastError = text(error?.message, 300) || 'network';
    }
    if (attempt < attempts - 1) await sleepImpl(400 * (attempt + 1));
  }
  return { ok: false, error: lastError };
}

/**
 * An adapter `runAdversarialConversationEvaluation` can drive.
 *
 * The contract it fulfils: given a scenario, return `{ events }` in the same
 * shape the fixtures use, so the *same* evaluator grades both. The adversarial
 * prospect turns are replayed verbatim from the corpus — that is what makes two
 * runs comparable — and everything the agent says, and every tool it calls, is
 * the model's own.
 *
 * Tool results are the fixture's own results for that tool name, so a booking
 * that fails in the fixture fails here too and the truthfulness checks still
 * mean something. A tool the fixture never exercised returns `{ ok: true }`.
 */
export function createOpenAIConversationAdapter({
  apiKey,
  model = DEFAULT_EVALUATION_MODEL,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  timeoutMs = MODEL_TIMEOUT_MS,
  attempts = MODEL_ATTEMPTS,
  maxToolHops = MAX_TOOL_HOPS,
  maxOutputTokens = 700
} = {}) {
  if (!String(apiKey || '').trim()) throw new Error('An OpenAI API key is required for a live evaluation.');
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable.');

  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, failures: 0 };

  return {
    kind: 'openai_responses',
    model,
    usage,

    async generateScenario({ seller, scenario, runtime }) {
      // The canned bank: whatever the fixture said each tool returned.
      const cannedResults = new Map();
      for (const entry of scenario.events) {
        if (entry.speaker === 'tool' && entry.name && !cannedResults.has(entry.name)) {
          cannedResults.set(entry.name, entry.result ?? { ok: true });
        }
      }

      const tools = toolDefinitionsFor(runtime.tools);
      // Verbatim. Not "you are being evaluated" — a model told it is in a
      // rehearsal is not the model that will be on the call, and the whole
      // point of this run is evidence about the latter.
      const instructions = text(runtime.instructions, 60_000);

      const input = [];
      const produced = [];

      for (const fixtureEvent of scenario.events) {
        if (fixtureEvent.speaker !== 'prospect') continue;

        produced.push({ speaker: 'prospect', content: fixtureEvent.content });
        input.push({ role: 'user', content: text(fixtureEvent.content, 4000) });

        for (let hop = 0; hop <= maxToolHops; hop += 1) {
          usage.requests += 1;
          const result = await callModel({
            apiKey,
            fetchImpl,
            sleepImpl,
            timeoutMs,
            attempts,
            body: {
              model,
              instructions,
              input,
              ...(tools.length ? { tools } : {}),
              max_output_tokens: maxOutputTokens
            }
          });

          if (!result.ok) {
            usage.failures += 1;
            // Surfaced to the evaluator as an adapter failure rather than as a
            // quietly short transcript, which would grade as a missing tool.
            throw new Error(`Model call failed for ${seller.id}/${scenario.id}: ${result.error}`);
          }

          usage.inputTokens += Number(result.payload?.usage?.input_tokens) || 0;
          usage.outputTokens += Number(result.payload?.usage?.output_tokens) || 0;

          const { text: reply, calls } = readModelOutput(result.payload);
          if (reply) {
            produced.push({ speaker: 'agent', content: reply });
            input.push({ role: 'assistant', content: reply });
          }
          if (!calls.length) break;

          for (const call of calls) {
            const toolResult = cannedResults.has(call.name) ? cannedResults.get(call.name) : { ok: true };
            produced.push({ speaker: 'tool', content: '', name: call.name, result: toolResult });
            input.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.args });
            input.push({
              type: 'function_call_output',
              call_id: call.callId,
              output: JSON.stringify(toolResult)
            });
          }
        }
      }

      return { events: produced };
    }
  };
}
