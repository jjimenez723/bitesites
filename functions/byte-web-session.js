// Public session control for Byte, the homepage voice agent.
//
// Two endpoints behind Firebase Hosting rewrites:
//
//   POST /api/byte-session — mint one short-lived OpenAI Realtime client
//     secret for a browser WebRTC session running the compiled Byte persona.
//     The standard API key never leaves the server.
//
//   POST /api/byte-tools — execute one tool call for a live session, or
//     finalize it. The browser is a dumb relay: the model asks for a tool over
//     the WebRTC data channel, the page forwards it here with the session's
//     bearer token, and every effect happens server-side against the same
//     booking, pricing and lead machinery the dialer uses.
//
// This surface is reachable by anyone on the internet, and a minted secret
// spends real OpenAI minutes — so minting is the guarded step: per-IP hourly
// and daily quotas, a global concurrency ceiling, and a hard per-session
// expiry that the tools endpoint enforces even if the browser's timer is
// stripped. Worst case is bounded by mint quotas, not by client honesty.
//
// The tool handlers themselves live in web-agent-tools.js, shared with Bit's
// chat endpoint: one visitor, one lead shape, whichever agent they met.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { mintAgentPreviewClientSecret } from './agent-preview.js';
import { buildByteWebRuntime, BYTE_CORE_KNOWLEDGE, BYTE_WEB_PROFILE } from './byte-persona.js';
import {
  WEB_AGENT_IDENTITY, bookMeeting, checkAvailability, finalizeSession, holdSessionSlot,
  lookupApprovedPricing, lookupCoreKnowledge, recordInterestSignal, requestHumanFollowup,
  requestRating, saveContactDetails, text, webCalendarClient
} from './web-agent-tools.js';

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const GOOGLE_CALENDAR_CREDENTIALS = defineSecret('GOOGLE_CALENDAR_CREDENTIALS');

const SESSION_TTL_MS = 12 * 60_000;
const MAX_SESSIONS_PER_HOUR = 5;
const MAX_SESSIONS_PER_DAY = 12;
const MAX_CONCURRENT_SESSIONS = 12;
const MAX_TOOL_CALLS = 48;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Byte's row in the shared tool bench: byte_voice leads, calls/ transcripts. */
const AGENT = WEB_AGENT_IDENTITY.byteVoice;

const secretValue = secret => {
  try { return (secret.value() || '').trim(); } catch { return ''; }
};

function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.ip || '');
}

const ipHashOf = ip => createHash('sha256')
  .update(`bitesites-web-voice:${ip}`)
  .digest('hex')
  .slice(0, 32);

/** Static per deploy, so compile once per instance. */
let cachedRuntime = null;
const webRuntime = () => (cachedRuntime ||= buildByteWebRuntime());

/**
 * Per-IP mint quota, transactionally bumped. Rolling hour and day windows on
 * one small doc per IP hash — no scheduled cleanup required, stale docs are
 * just stale.
 */
async function consumeQuota(db, ipHash, nowMs) {
  const ref = db.doc(`webVoiceQuota/${ipHash}`);
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

/**
 * Global ceiling on concurrently-live sessions. `liveUntilMs` is a plain
 * number so one auto-indexed range query answers "how many are live right
 * now" — finalize zeroes it, and abandoned sessions age out on their own.
 */
async function concurrentSessions(db, nowMs) {
  const snapshot = await db.collection('webVoiceSessions')
    .where('liveUntilMs', '>', nowMs)
    .count().get();
  return snapshot.data().count || 0;
}

export const byteWebSession = onRequest(
  { secrets: [OPENAI_API_KEY], maxInstances: 5 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
      return;
    }
    const apiKey = secretValue(OPENAI_API_KEY);
    if (!apiKey) {
      console.error('[byte-web] OPENAI_API_KEY is not set — refusing to mint');
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

    const runtime = webRuntime();
    const token = randomBytes(32).toString('hex');
    const ref = db.collection('webVoiceSessions').doc();
    await ref.set({
      status: 'live',
      token,
      ipHash,
      callId: text(req.body?.callId, 200),
      sid: text(req.body?.sid, 40),
      path: text(req.body?.path, 300) || '/',
      profileId: BYTE_WEB_PROFILE.id,
      profileVersion: BYTE_WEB_PROFILE.version,
      tools: runtime.tools,
      toolCalls: 0,
      leadId: '',
      captured: {},
      startedAt: FieldValue.serverTimestamp(),
      expiresAtMs: nowMs + SESSION_TTL_MS,
      liveUntilMs: nowMs + SESSION_TTL_MS
    });

    let secret;
    try {
      secret = await mintAgentPreviewClientSecret({
        apiKey,
        uid: `web:${ipHash}`,
        session: runtime.session
      });
    } catch (error) {
      console.error('[byte-web] mint failed:', error?.message);
      await ref.set({ status: 'failed', liveUntilMs: 0 }, { merge: true }).catch(() => {});
      res.status(502).json({ error: 'mint-failed' });
      return;
    }

    res.json({
      sessionId: ref.id,
      sessionToken: token,
      clientSecret: secret.value,
      expiresAt: secret.expiresAt,
      maxSessionMs: SESSION_TTL_MS,
      model: runtime.session.model,
      voice: runtime.compiled.voice
    });
  }
);

// ------------------------------------------------------------------- tools

/** Google mirror for booking. Byte books fine without it; the sweep re-pushes. */
const calendarClient = db => webCalendarClient(db, secretValue(GOOGLE_CALENDAR_CREDENTIALS));

const tokenMatches = (expected, provided) => {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(provided || ''));
  return a.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
};

export const byteWebTools = onRequest(
  { secrets: [GOOGLE_CALENDAR_CREDENTIALS], maxInstances: 10 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
      return;
    }

    const db = getFirestore();
    const sessionId = text(req.body?.sessionId, 60);
    if (!sessionId) { res.status(400).json({ error: 'session-required' }); return; }
    const sessionRef = db.doc(`webVoiceSessions/${sessionId}`);
    const snapshot = await sessionRef.get();
    if (!snapshot.exists || !tokenMatches(snapshot.get('token'), req.body?.sessionToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const session = { id: snapshot.id, ...snapshot.data() };

    const action = text(req.body?.action, 20) || 'tool';
    if (action === 'finalize') {
      await finalizeSession(db, sessionRef, session, {
        durationSec: req.body?.durationSec,
        reason: text(req.body?.reason, 40) || 'client_ended',
        agent: AGENT
      });
      res.json({ ok: true });
      return;
    }
    if (action !== 'tool') { res.status(400).json({ error: 'unknown-action' }); return; }

    // Model-visible failures return 200 with ok:false — the browser forwards
    // them as tool output so Byte can react in speech instead of stalling.
    if (session.status !== 'live' || Date.now() > (session.expiresAtMs || 0)) {
      res.json({ ok: false, error: 'session_over', endsCall: true, note: 'This session has reached its limit. Say a warm goodbye and end.' });
      return;
    }
    if ((session.toolCalls || 0) >= MAX_TOOL_CALLS) {
      res.json({ ok: false, error: 'tool_budget_exhausted', endsCall: false, note: 'No more tool calls are available this session. Wrap up with what you already know.' });
      return;
    }
    await sessionRef.set({ toolCalls: FieldValue.increment(1) }, { merge: true });

    const tool = text(req.body?.tool, 80);
    const granted = Array.isArray(session.tools) ? session.tools : [];
    if (!granted.includes(tool)) {
      res.json({ ok: false, error: 'tool_not_permitted', endsCall: false });
      return;
    }

    const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
    let result;
    try {
      switch (tool) {
        case 'lookup_knowledge':
          result = lookupCoreKnowledge(args, BYTE_CORE_KNOWLEDGE);
          break;
        case 'lookup_approved_pricing':
          result = await lookupApprovedPricing(db, args);
          break;
        case 'check_availability':
          result = await checkAvailability(db, { args, google: await calendarClient(db).catch(() => null) });
          break;
        case 'hold_slot':
          result = await holdSessionSlot(db, { session, args, agent: AGENT });
          break;
        case 'book_meeting':
          result = await bookMeeting(db, {
            sessionRef, session, args, agent: AGENT,
            google: await calendarClient(db).catch(() => null)
          });
          break;
        case 'save_contact_details':
          result = await saveContactDetails(db, { sessionRef, session, args, agent: AGENT });
          break;
        case 'request_human_followup':
          result = await requestHumanFollowup(db, { sessionRef, session, args, agent: AGENT });
          break;
        case 'record_interest_signal':
          result = await recordInterestSignal(db, { sessionRef, session, args });
          break;
        case 'request_rating':
          result = await requestRating(db, { sessionRef, session, args, agent: AGENT });
          break;
        case 'end_call': {
          const reason = ['completed', 'booked', 'no_fit', 'visitor_left'].includes(text(args.reason, 40))
            ? text(args.reason, 40) : 'completed';
          await finalizeSession(db, sessionRef, session, { reason, agent: AGENT });
          result = { ok: true, ending: true, note: 'Say a short warm goodbye and stop speaking. If you have not called request_rating yet, call it in this same turn so the card is actually queued — otherwise say nothing about a rating.' };
          break;
        }
        default:
          result = { ok: false, error: 'unknown_tool' };
      }
    } catch (error) {
      console.error('[byte-web] tool execution failed', tool, error);
      result = { ok: false, error: 'server_action_failed' };
    }

    res.json({ ...result, endsCall: result?.ending === true, showsRating: result?.shown === true });
  }
);
