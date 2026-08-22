// Public session control for Bit, the homepage chat agent.
//
// Two endpoints behind Firebase Hosting rewrites:
//
//   POST /api/bit-session — open one short-lived chat session for a browser
//     and hand back a bearer token. Nothing about the persona, the tools, or
//     the OpenAI key crosses to the client.
//
//   POST /api/bit-chat — take one visitor message and return Bit's reply.
//
// The second endpoint is where this differs from Byte's. Byte runs the model
// in the browser over WebRTC and relays tool calls back to the server, because
// realtime audio has to live where the microphone is. A text agent has no such
// excuse, so the whole loop runs here: the conversation history is server-
// owned, the model is called from this process, tools execute in-process, and
// the browser receives finished text. A client cannot rewrite Bit's memory,
// forge a tool result, replay a booking, or read the system prompt — because
// it never holds any of them.
//
// The guarded resources are model tokens and calendar slots, so the limits sit
// where the spending happens: a per-IP mint quota (text is cheap, so it is
// several times more generous than the voice one), a per-session visitor-turn
// budget, a per-session tool budget, a hard TTL, and a cap on model calls
// within a single turn so a tool-loop cannot spin. Worst case is bounded by
// those numbers, not by client honesty.
//
// Tool handlers are the shared bench in web-agent-tools.js — the same code
// Byte's endpoint calls — so a visitor who books with Bit and a visitor who
// books with Byte produce the same lead, the same appointment, and the same
// row on the dashboard.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import {
  BIT_CHAT_PROFILE, BIT_CORE_KNOWLEDGE, BIT_GREETING, BIT_PAGE_LINKS, buildBitChatRuntime
} from './bit-persona.js';
import {
  WEB_AGENT_IDENTITY, bookMeeting, checkAvailability, finalizeSession, holdSessionSlot,
  lookupApprovedPricing, lookupCoreKnowledge, recordInterestSignal, requestHumanFollowup,
  requestRating, saveContactDetails, text, webCalendarClient
} from './web-agent-tools.js';

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const GOOGLE_CALENDAR_CREDENTIALS = defineSecret('GOOGLE_CALENDAR_CREDENTIALS');

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS_PER_HOUR = 10;
const MAX_SESSIONS_PER_DAY = 30;
const MAX_CONCURRENT_SESSIONS = 60;
const MAX_VISITOR_TURNS = 40;
const MAX_TOOL_CALLS = 60;
const MAX_MESSAGE_CHARS = 2000;

/** Guards against a tool loop: eight model calls is a generous real turn. */
const MAX_MODEL_CALLS_PER_TURN = 8;
/** Whole-turn deadline, well inside the function timeout. */
const TURN_DEADLINE_MS = 50_000;
/** One model call's own ceiling, so a hung socket cannot eat the deadline. */
const MODEL_TIMEOUT_MS = 30_000;
const MODEL_ATTEMPTS = 3;

/**
 * How much conversation travels to the model. Trimmed by item count and by
 * characters, because either one alone has a pathological case — forty tiny
 * turns, or one visitor pasting their whole website.
 */
const MAX_HISTORY_ITEMS = 60;
const MAX_HISTORY_CHARS = 24_000;

/** Bit's row in the shared tool bench: bit_chat leads, chats/ transcripts. */
const AGENT = WEB_AGENT_IDENTITY.bitChat;

const secretValue = secret => {
  try { return (secret.value() || '').trim(); } catch { return ''; }
};

function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.ip || '');
}

const ipHashOf = ip => createHash('sha256')
  .update(`bitesites-web-chat:${ip}`)
  .digest('hex')
  .slice(0, 32);

/** Static per deploy, so compile once per instance and reuse the prompt cache. */
let cachedRuntime = null;
const chatRuntime = () => (cachedRuntime ||= buildBitChatRuntime());

/**
 * Per-IP mint quota, transactionally bumped. Rolling hour and day windows on
 * one small doc per IP hash — no scheduled cleanup required, stale docs are
 * just stale. Same shape as the voice quota, different numbers: a chat costs
 * a few cents where a voice minute costs real money.
 */
async function consumeQuota(db, ipHash, nowMs) {
  const ref = db.doc(`bitChatQuota/${ipHash}`);
  try {
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const quota = snapshot.exists ? snapshot.data() : {};
      const hourStartMs = quota.hourStartMs && nowMs - quota.hourStartMs < HOUR_MS ? quota.hourStartMs : nowMs;
      const hourCount = hourStartMs === quota.hourStartMs ? (quota.hourCount || 0) : 0;
      const dayStartMs = quota.dayStartMs && nowMs - quota.dayStartMs < DAY_MS ? quota.dayStartMs : nowMs;
      const dayCount = dayStartMs === quota.dayStartMs ? (quota.dayCount || 0) : 0;
      if (hourCount >= MAX_SESSIONS_PER_HOUR || dayCount >= MAX_SESSIONS_PER_DAY) {
        const error = new Error('quota');
        error.rateLimited = true;
        throw error;
      }
      tx.set(ref, {
        hourStartMs, hourCount: hourCount + 1,
        dayStartMs, dayCount: dayCount + 1,
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    return { ok: true };
  } catch (error) {
    if (error?.rateLimited) return { ok: false };
    throw error;
  }
}

/** Global ceiling on live sessions, answered by one auto-indexed range query. */
async function concurrentSessions(db, nowMs) {
  const snapshot = await db.collection('bitChatSessions')
    .where('liveUntilMs', '>', nowMs)
    .count().get();
  return snapshot.data().count || 0;
}

export const bitChatSession = onRequest(
  { secrets: [OPENAI_API_KEY], maxInstances: 10 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
      return;
    }
    if (!secretValue(OPENAI_API_KEY)) {
      console.error('[bit-chat] OPENAI_API_KEY is not set — refusing to open a session');
      res.status(503).json({ error: 'not-configured' });
      return;
    }

    const db = getFirestore();
    const nowMs = Date.now();
    const ipHash = ipHashOf(clientIp(req));

    const quota = await consumeQuota(db, ipHash, nowMs);
    if (!quota.ok) {
      res.status(429).json({ error: 'rate-limited' });
      return;
    }
    if (await concurrentSessions(db, nowMs) >= MAX_CONCURRENT_SESSIONS) {
      res.status(429).json({ error: 'at-capacity' });
      return;
    }

    const runtime = chatRuntime();
    const token = randomBytes(32).toString('hex');
    const ref = db.collection('bitChatSessions').doc();
    await ref.set({
      status: 'live',
      token,
      ipHash,
      // The browser's own transcript document in `chats`, so the dashboard can
      // open the visitor-visible conversation from the lead and vice versa.
      chatId: text(req.body?.chatId, 200),
      sid: text(req.body?.sid, 40),
      path: text(req.body?.path, 300) || '/',
      profileId: BIT_CHAT_PROFILE.id,
      profileVersion: BIT_CHAT_PROFILE.version,
      model: runtime.model,
      tools: runtime.tools,
      toolCalls: 0,
      turns: 0,
      leadId: '',
      captured: {},
      // Seeded with the greeting the browser is about to render, so the model's
      // first turn knows it has already said hello. Without this Bit greets a
      // visitor twice — once on screen, once in his own reply.
      history: [historyMessage('assistant', BIT_GREETING)],
      startedAt: FieldValue.serverTimestamp(),
      expiresAtMs: nowMs + SESSION_TTL_MS,
      liveUntilMs: nowMs + SESSION_TTL_MS
    });

    res.json({
      sessionId: ref.id,
      sessionToken: token,
      greeting: BIT_GREETING,
      model: runtime.model,
      maxSessionMs: SESSION_TTL_MS,
      maxTurns: MAX_VISITOR_TURNS,
      maxToolCalls: MAX_TOOL_CALLS,
      maxMessageChars: MAX_MESSAGE_CHARS
    });
  }
);

// -------------------------------------------------------------- the loop

/**
 * History is stored in a deliberately small, explicit shape rather than as raw
 * model output. Three item kinds round-trip everything the model needs to
 * continue a conversation — including the tool calls, because a holdId issued
 * on one turn is what the booking on the next turn commits.
 */
const historyMessage = (role, body) => ({ t: 'msg', role, text: text(body, 4000) });
const historyCall = (callId, name, args) => ({ t: 'call', callId, name, args: text(args, 4000) });
const historyOutput = (callId, output) => ({ t: 'out', callId, output: text(output, 4000) });

/** Rehydrate stored history into Responses API input items. */
function toModelInput(history) {
  const input = [];
  for (const item of history) {
    if (item.t === 'msg') input.push({ role: item.role, content: item.text });
    else if (item.t === 'call') input.push({ type: 'function_call', call_id: item.callId, name: item.name, arguments: item.args || '{}' });
    else if (item.t === 'out') input.push({ type: 'function_call_output', call_id: item.callId, output: item.output || '{}' });
  }
  return input;
}

/**
 * Trim from the front, then discard any orphaned tool items at the new start.
 * A function_call_output whose call was trimmed away is a 400 from the API, so
 * the window always begins on a plain message.
 */
function trimHistory(history) {
  let window = history.slice(-MAX_HISTORY_ITEMS);
  let chars = window.reduce((sum, item) => sum + (item.text || item.args || item.output || '').length, 0);
  while (window.length > 2 && chars > MAX_HISTORY_CHARS) {
    const dropped = window.shift();
    chars -= (dropped.text || dropped.args || dropped.output || '').length;
  }
  while (window.length && window[0].t !== 'msg') window.shift();
  return window;
}

/**
 * One call to OpenAI, with a short backoff on the failures that are worth
 * retrying. A 5xx or a dropped socket is weather; a 400 is a bug in what we
 * sent and retrying it just spends the visitor's patience.
 */
async function callModel(apiKey, body, safetyId, fetchImpl = globalThis.fetch) {
  let lastError = 'model_unavailable';
  for (let attempt = 0; attempt < MODEL_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': safetyId
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS)
      });
      const raw = await response.text();
      let payload = {};
      try { payload = JSON.parse(raw); } catch { /* handled below */ }
      if (response.ok) return { ok: true, payload };
      lastError = text(payload?.error?.message || raw, 300) || `HTTP ${response.status}`;
      console.error('[bit-chat] model call failed', response.status, lastError);
      if (response.status < 500 && response.status !== 429) return { ok: false, error: lastError };
    } catch (error) {
      lastError = text(error?.message, 300) || 'network';
      console.warn('[bit-chat] model call threw', lastError);
    }
    if (attempt < MODEL_ATTEMPTS - 1) {
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return { ok: false, error: lastError };
}

/** Pull the two things we care about out of a Responses payload. */
function readModelOutput(payload) {
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
  const reply = parts.join('\n').trim() || text(payload?.output_text, 4000);
  return { calls, reply: text(reply, 4000) };
}

/**
 * Execute one tool the model asked for.
 *
 * Returns `{ result, card, chips, ended }`: `result` is what the model is told,
 * and the rest is what the visitor sees. Keeping those separate is what lets a
 * booking be a sentence *and* a confirmation card without the model having to
 * describe the card it cannot see.
 */
async function runTool(db, { tool, args, sessionRef, session, google }) {
  switch (tool) {
    case 'lookup_knowledge':
      return { result: lookupCoreKnowledge(args, BIT_CORE_KNOWLEDGE) };
    case 'lookup_approved_pricing':
      return { result: await lookupApprovedPricing(db, args) };
    case 'check_availability': {
      const result = await checkAvailability(db, { args, google: await google() });
      // The visitor taps a time; the tap comes back as their next message in
      // their own words, which is exactly what check_availability parses.
      const chips = result.found
        ? result.slots.slice(0, 3).map(slot => ({ label: slot.spoken, send: slot.spoken }))
        : [];
      return { result, chips };
    }
    case 'hold_slot':
      return { result: await holdSessionSlot(db, { session, args, agent: AGENT }) };
    case 'book_meeting': {
      const result = await bookMeeting(db, {
        sessionRef, session, args, agent: AGENT, google: await google()
      });
      return {
        result,
        card: result.ok
          ? { type: 'booked', spoken: result.spoken, confirmationRef: result.confirmationRef }
          : null
      };
    }
    case 'save_contact_details':
      return { result: await saveContactDetails(db, { sessionRef, session, args, agent: AGENT }) };
    case 'request_human_followup':
      return { result: await requestHumanFollowup(db, { sessionRef, session, args, agent: AGENT }) };
    case 'record_interest_signal':
      return { result: await recordInterestSignal(db, { sessionRef, session, args }) };
    case 'send_page_link': {
      const destination = text(args?.destination, 40);
      const link = BIT_PAGE_LINKS[destination];
      if (!link) {
        return {
          result: {
            ok: false, error: 'unknown_destination',
            note: `That destination does not exist. Choose one of: ${Object.keys(BIT_PAGE_LINKS).join(', ')}.`
          }
        };
      }
      return {
        result: {
          ok: true, shown: true, destination, label: link.label,
          note: 'The card is on their screen with a button. Do not repeat the link or describe where to click — write one short line about why it helps and stop.'
        },
        card: {
          type: 'link',
          destination,
          href: link.href,
          label: link.label,
          detail: text(args?.reason, 160) || link.detail
        }
      };
    }
    case 'request_rating': {
      const result = await requestRating(db, { sessionRef, session, args, agent: AGENT });
      // The card rides the same channel as a booking confirmation or a link,
      // so the rating lands in the transcript where Bit asked for it rather
      // than being bolted onto whatever turns out to be the last message.
      return { result, card: result.shown ? { type: 'rating' } : null };
    }
    case 'end_chat': {
      const reason = ['completed', 'booked', 'no_fit', 'visitor_left'].includes(text(args?.reason, 40))
        ? text(args.reason, 40) : 'completed';
      await finalizeSession(db, sessionRef, session, { reason, agent: AGENT });
      return {
        result: {
          ok: true, ending: true,
          note: 'Write a short warm goodbye now and stop. If you have not called request_rating yet, call it in this same turn so the card is actually there — otherwise say nothing about a rating.'
        },
        ended: true
      };
    }
    default:
      return { result: { ok: false, error: 'unknown_tool' } };
  }
}

/** Bit-voiced fallbacks. A broken turn must still leave the visitor somewhere. */
const FALLBACK_REPLY = 'Something on my end just fell over — that is on me, not you. ✦ The booking page is still right here if you would rather grab a time directly, or send it again in a moment and I will pick it back up.';
const BOOKING_CARD = Object.freeze({
  type: 'link',
  destination: 'booking',
  href: BIT_PAGE_LINKS.booking.href,
  label: BIT_PAGE_LINKS.booking.label,
  detail: BIT_PAGE_LINKS.booking.detail
});

const tokenMatches = (expected, provided) => {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(provided || ''));
  return a.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
};

export const bitChatTurn = onRequest(
  { secrets: [OPENAI_API_KEY, GOOGLE_CALENDAR_CREDENTIALS], maxInstances: 20, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
      return;
    }

    const db = getFirestore();
    const sessionId = text(req.body?.sessionId, 60);
    if (!sessionId) { res.status(400).json({ error: 'session-required' }); return; }
    const sessionRef = db.doc(`bitChatSessions/${sessionId}`);
    const snapshot = await sessionRef.get();
    if (!snapshot.exists || !tokenMatches(snapshot.get('token'), req.body?.sessionToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    let session = { id: snapshot.id, ...snapshot.data() };
    let history = Array.isArray(session.history) ? session.history : [];

    const action = text(req.body?.action, 20) || 'message';
    if (action === 'finalize') {
      await finalizeSession(db, sessionRef, session, {
        durationSec: req.body?.durationSec,
        reason: text(req.body?.reason, 40) || 'client_ended',
        agent: AGENT
      });
      res.json({ ok: true });
      return;
    }
    if (action !== 'message') { res.status(400).json({ error: 'unknown-action' }); return; }

    // Session limits are visitor-visible here, not model-visible: this endpoint
    // *is* the agent, so a refusal has to be something Bit could have said.
    if (session.status !== 'live' || Date.now() > (session.expiresAtMs || 0)) {
      res.json({
        ok: false, error: 'session_over', ended: true, cards: [BOOKING_CARD], chips: [],
        messages: ['That is where I have to leave this one — the session timed out. ✦ Start a fresh chat any time, or grab a slot straight from the booking page.']
      });
      return;
    }
    if ((session.turns || 0) >= MAX_VISITOR_TURNS) {
      await finalizeSession(db, sessionRef, session, { reason: 'completed', agent: AGENT });
      res.json({
        ok: false, error: 'turn_budget_exhausted', ended: true, cards: [BOOKING_CARD], chips: [],
        messages: ['We have properly talked this one out — I am at the end of what I can cover in a single chat. ✦ Grab a time with the team and pick it up there.']
      });
      return;
    }

    const message = text(req.body?.message, MAX_MESSAGE_CHARS);
    if (!message) { res.status(400).json({ error: 'message-required' }); return; }

    const apiKey = secretValue(OPENAI_API_KEY);
    if (!apiKey) {
      console.error('[bit-chat] OPENAI_API_KEY is not set — cannot answer');
      res.json({ ok: false, error: 'not_configured', ended: false, cards: [BOOKING_CARD], chips: [], messages: [FALLBACK_REPLY] });
      return;
    }

    const runtime = chatRuntime();
    const safetyId = createHash('sha256').update(`bitesites-bit-chat:${text(session.ipHash, 64)}`).digest('hex');
    // Resolved lazily and at most once per turn: most turns never book, and a
    // Google client costs a token exchange.
    let googleClient;
    const google = async () => {
      if (googleClient === undefined) {
        googleClient = await webCalendarClient(db, secretValue(GOOGLE_CALENDAR_CREDENTIALS)).catch(() => null);
      }
      return googleClient;
    };

    history = [...history, historyMessage('user', message)];
    await sessionRef.set({
      turns: FieldValue.increment(1),
      lastTurnAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const cards = [];
    let chips = [];
    let ended = false;
    let reply = '';
    let toolCalls = Number(session.toolCalls) || 0;
    const deadline = Date.now() + TURN_DEADLINE_MS;

    for (let round = 0; round < MAX_MODEL_CALLS_PER_TURN; round += 1) {
      if (Date.now() > deadline) {
        console.warn('[bit-chat] turn deadline reached', sessionId);
        break;
      }

      const call = await callModel(apiKey, {
        model: runtime.model,
        instructions: runtime.instructions,
        input: toModelInput(trimHistory(history)),
        tools: runtime.toolSchemas,
        tool_choice: 'auto',
        // Serial tool calls keep the loop, the budget, and the transcript in a
        // single readable order. Nothing Bit does benefits from fan-out.
        parallel_tool_calls: false,
        max_output_tokens: runtime.maxOutputTokens,
        reasoning: { effort: runtime.reasoningEffort },
        store: false
      }, safetyId);

      if (!call.ok) break;
      const { calls, reply: spoken } = readModelOutput(call.payload);
      if (spoken) reply = spoken;

      if (!calls.length) break;

      for (const requested of calls) {
        history = [...history, historyCall(requested.callId, requested.name, requested.args)];

        let output;
        if (!runtime.tools.includes(requested.name)) {
          output = { ok: false, error: 'tool_not_permitted', note: 'You do not have that tool. Use one you were granted, or answer without it.' };
        } else if (toolCalls >= MAX_TOOL_CALLS) {
          output = { ok: false, error: 'tool_budget_exhausted', note: 'No more tool calls are available this session. Answer with what you already know and wrap up.' };
        } else {
          toolCalls += 1;
          let args = {};
          try { args = JSON.parse(requested.args || '{}') || {}; } catch { args = {}; }
          try {
            const executed = await runTool(db, {
              tool: requested.name, args, sessionRef, session, google
            });
            output = executed.result;
            if (executed.card) cards.push(executed.card);
            if (executed.chips?.length) chips = executed.chips;
            if (executed.ended) ended = true;
          } catch (error) {
            console.error('[bit-chat] tool execution failed', requested.name, error);
            output = { ok: false, error: 'server_action_failed', note: 'That action did not go through. Say so plainly and do not claim it worked.' };
          }
          // Tools mutate the session (captured details, the lead id, a hold),
          // and the next tool in this same turn has to see that. History stays
          // local — it is not written until the turn closes.
          const refreshed = await sessionRef.get();
          if (refreshed.exists) {
            const { history: _stored, ...fields } = refreshed.data();
            session = { id: refreshed.id, ...fields };
          }
        }

        history = [...history, historyOutput(requested.callId, JSON.stringify(output))];
      }

      if (ended) break;
    }

    if (reply) history = [...history, historyMessage('assistant', reply)];

    const trimmed = trimHistory(history);
    await sessionRef.set({
      history: trimmed,
      toolCalls,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true }).catch(error => console.warn('[bit-chat] history write failed', error?.message));

    const leadSnapshot = await sessionRef.get().catch(() => null);
    const leadId = text(leadSnapshot?.get('leadId'), 60);

    res.json({
      ok: Boolean(reply),
      messages: reply ? [reply] : [FALLBACK_REPLY],
      cards: reply ? cards : [...cards, BOOKING_CARD],
      chips,
      ended,
      leadId
    });
  }
);
