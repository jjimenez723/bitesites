// Pushes every new lead into GoHighLevel so web enquiries land in the same
// pipeline as the calls the voice agent books.
//
// It posts to a GoHighLevel Inbound Webhook — the trigger URL you get from a
// GHL workflow. The workflow decides what to do with the payload (create the
// contact, tag it, start a follow-up sequence, notify the team). That keeps the
// mapping editable in GHL rather than hard-coded here.
//
// Set the URL once, then deploy:
//   firebase functions:secrets:set GHL_WEBHOOK_URL
//   npm run deploy:functions
//
// The outcome is written back onto the lead document under `crm`, so a failed
// sync is visible in the console rather than silently lost.

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const GHL_WEBHOOK_URL = defineSecret('GHL_WEBHOOK_URL');
const VOICE_WEBHOOK_SECRET = defineSecret('VOICE_WEBHOOK_SECRET');
const GHL_API_TOKEN = defineSecret('GHL_API_TOKEN');

// The sub-account the Voice AI agent lives in. Not a secret — it is visible in
// the GoHighLevel URL bar — so a plain constant rather than a stored secret. A
// defineString param would be tidier, but its default does not resolve outside a
// deployed context, which silently breaks tests and local runs.
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'LDL5wuJlnVnqk9vn6taD';

const SERVICE_LABELS = {
  web_development: 'Web Development',
  ai_automation: 'AI Automation',
  social_media_management: 'Social Media Management',
  other: 'Other'
};

const URGENCY_LABELS = {
  asap: 'ASAP',
  '2_4_weeks': '2-4 weeks',
  '1_2_months': '1-2 months',
  flexible: 'Flexible',
  other: 'Other'
};

const SIZE_LABELS = {
  solo: 'Solo / Freelancer',
  small: '2-10 employees',
  growing: '11-50 employees',
  established: '51-200 employees',
  enterprise: '200+ employees',
  other: 'Other'
};

// GHL wants first/last separately; most people type a single string.
function splitName(full = '') {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// A human-readable summary, so whoever picks the lead up has the context the
// structured fields lose.
function buildNotes(lead) {
  const lines = [
    `Source: ${lead.source === 'bit_chat' ? 'Bit chat assistant' : 'Website intake form'}`,
    `Services: ${(lead.services || []).map(s => SERVICE_LABELS[s] || s).join(', ')}`,
    `Business size: ${SIZE_LABELS[lead.businessSize] || lead.businessSize || '—'}`
  ];
  if (lead.urgencyTag) lines.push(`Timeline: ${URGENCY_LABELS[lead.urgencyTag] || lead.urgencyTag}`);
  if (lead.roleInCompany) lines.push(`Role: ${lead.roleInCompany}`);
  if (lead.preferredContactMethod) lines.push(`Prefers: ${lead.preferredContactMethod}`);
  if (lead.projectDetails) lines.push('', 'Project details:', lead.projectDetails);

  // Free-text answers typed into the chat instead of picking an option.
  if (lead.customAnswers && Object.keys(lead.customAnswers).length) {
    lines.push('', 'In their own words:');
    for (const [key, value] of Object.entries(lead.customAnswers)) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  if (lead.pagePath) lines.push('', `Submitted from: ${lead.pagePath}`);
  if (lead.referrer) lines.push(`Referrer: ${lead.referrer}`);
  return lines.join('\n');
}

function buildPayload(lead, leadId) {
  const { firstName, lastName } = splitName(lead.name);
  return {
    firstName,
    lastName,
    name: lead.name,
    email: lead.email,
    phone: lead.phone || undefined,
    companyName: lead.businessName || undefined,
    source: lead.source === 'bit_chat' ? 'Website - Bit chat' : 'Website - intake form',
    tags: [
      'website-lead',
      ...(lead.services || []).map(s => `service:${s}`),
      ...(lead.urgencyTag ? [`timeline:${lead.urgencyTag}`] : [])
    ],
    notes: buildNotes(lead),
    leadId,
    // Raw values too, so a workflow can map whatever it needs.
    raw: {
      businessSize: lead.businessSize,
      services: lead.services,
      urgencyTag: lead.urgencyTag || null,
      preferredContactMethod: lead.preferredContactMethod,
      projectDetails: lead.projectDetails || null,
      roleInCompany: lead.roleInCompany || null
    }
  };
}

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export const syncLeadToGoHighLevel = onDocumentCreated(
  {
    document: 'leads/{leadId}',
    secrets: [GHL_WEBHOOK_URL]
  },
  async event => {
    const snapshot = event.data;
    if (!snapshot) return;

    const lead = snapshot.data();
    const { leadId } = event.params;

    // A Byte lead was created *by* GoHighLevel (see recordVoiceCall below), so
    // it is already a contact over there. Pushing it back would duplicate it —
    // and, since that workflow posts to us, could bounce between the two.
    if (lead.source === 'byte_voice') {
      console.log(`[lead ${leadId}] originated in GoHighLevel (Byte call) — not syncing back`);
      return;
    }

    const payload = buildPayload(lead, leadId);

    const webhookUrl = GHL_WEBHOOK_URL.value();

    // The secret has to exist for the function to deploy at all, so it starts
    // life as a placeholder. Anything that is not an http(s) URL means "not
    // configured yet" and is skipped quietly rather than logged as a failure.
    if (!/^https?:\/\//i.test(webhookUrl || '')) {
      console.warn(`[lead ${leadId}] GHL_WEBHOOK_URL not configured — skipping sync`);
      await snapshot.ref.set(
        { crm: { synced: false, reason: 'not-configured', at: FieldValue.serverTimestamp() } },
        { merge: true }
      );
      return;
    }

    try {
      await postJson(webhookUrl, payload);
      console.log(`[lead ${leadId}] synced to GoHighLevel`);
      await snapshot.ref.set(
        { crm: { synced: true, at: FieldValue.serverTimestamp() } },
        { merge: true }
      );
    } catch (error) {
      // Never rethrow: a CRM outage must not lose the lead, which is already
      // safely stored in Firestore. Record why and move on.
      console.error(`[lead ${leadId}] GoHighLevel sync failed:`, error.message);
      await snapshot.ref.set(
        {
          crm: {
            synced: false,
            error: String(error.message).slice(0, 500),
            at: FieldValue.serverTimestamp()
          }
        },
        { merge: true }
      );
    }
  }
);

// ============================================================== Byte (voice) ==
//
// Byte's half of the funnel used to stop at GoHighLevel. GHL owns the call — the
// audio, the transcript, and the contact it captures — and none of that reaches
// Firestore on its own. The browser only records the *shape* of the session (see
// src/lib/conversations.js), so `leads` never received anything from a voice
// call and the dashboard had no Byte leads to show.
//
// This endpoint is the missing return path. Point a **Custom Webhook** action at
// it from the GHL workflow that runs when a call ends, and it will:
//
//   * attach the transcript, summary and recording to the matching `calls/{id}`
//     document — creating one when the call never came through the site widget,
//     so calls placed to the real number show up too;
//   * create `leads/{id}` with source `byte_voice` whenever the call captured a
//     way to reach the person, putting Byte's leads in the same list as the
//     intake form's and Bit's;
//   * link the two together in both directions.
//
// It is authenticated by a shared secret and refuses everything until that
// secret is set — this endpoint writes leads, so an open one is a spam funnel:
//
//   firebase functions:secrets:set VOICE_WEBHOOK_SECRET
//   npm run deploy:functions

// How far back to look for the browser-side call record to attach to. Long
// enough to cover a long call plus GHL's post-processing, short enough that a
// fallback match cannot reach back into a previous visitor's session.
const CALL_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_TURNS = 400;

// GoHighLevel workflows are user-assembled, so the same value arrives under
// whatever key the person wiring it up picked. Accept the common spellings
// rather than making the setup depend on an exact payload shape.
const ALIASES = {
  name: ['name', 'full_name', 'fullName', 'contact_name', 'contactName'],
  firstName: ['first_name', 'firstName'],
  lastName: ['last_name', 'lastName'],
  email: ['email', 'contact_email', 'contactEmail', 'emailAddress'],
  phone: ['phone', 'phone_number', 'phoneNumber', 'contact_phone', 'caller', 'from'],
  businessName: ['companyName', 'company_name', 'company', 'businessName', 'business_name'],
  roleInCompany: ['role', 'jobTitle', 'job_title', 'title'],
  projectDetails: ['projectDetails', 'details', 'message', 'question', 'intent', 'notes'],
  // Deliberately no bare `id`: in a GHL payload that is usually the *contact*
  // id, which is stable across calls — using it would make a repeat caller's
  // second call look like a redelivery of their first and silently drop it.
  providerCallId: ['callId', 'call_id', 'callSid', 'call_sid', 'conversationId', 'conversation_id', 'messageId', 'message_id'],
  summary: ['summary', 'call_summary', 'callSummary', 'ai_summary', 'aiSummary'],
  transcript: ['transcript', 'messages', 'call_transcript', 'callTranscript', 'conversation'],
  recordingUrl: ['recordingUrl', 'recording_url', 'recording', 'audioUrl', 'audio_url'],
  duration: ['durationSec', 'duration', 'call_duration', 'callDuration', 'duration_seconds'],
  sid: ['sid', 'sessionId', 'session_id', 'siteSessionId'],
  siteCallId: ['siteCallId', 'site_call_id', 'callDocId'],
  startedAt: ['startedAt', 'started_at', 'startTime', 'start_time', 'dateAdded'],
  outcome: ['outcome', 'call_status', 'callStatus', 'disposition']
};

const SERVICE_TAGS = {
  web_development: ['service:web_development', 'web', 'website', 'web-design'],
  ai_automation: ['service:ai_automation', 'ai', 'automation', 'voice', 'voice-ai'],
  social_media_management: ['service:social_media_management', 'social', 'social-media']
};

const str = (value, maxLen) => {
  if (typeof value === 'string') return value.trim().slice(0, maxLen);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, maxLen);
  return '';
};

const pick = (source, keys, maxLen) => {
  for (const key of keys) {
    const found = str(source[key], maxLen);
    if (found) return found;
  }
  return '';
};

/** Like `pick`, but keeps the original type — numbers stay numbers. */
const pickRaw = (source, keys) => {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

/** Flattens the nesting GHL adds, so `contact.email` and `email` both resolve. */
function flatten(body) {
  const nested = ['contact', 'customData', 'custom_data', 'data', 'call', 'payload'];
  const flat = { ...body };
  for (const key of nested) {
    const value = body?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(flat, value);
  }
  return flat;
}

/** Accepts 222, "222", or "3:42". */
function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const raw = str(value, 20);
  if (!raw) return 0;
  if (raw.includes(':')) {
    return raw.split(':').reduce((total, part) => total * 60 + (parseInt(part, 10) || 0), 0);
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const AGENT_HINTS = ['agent', 'assistant', 'ai', 'bot', 'byte', 'system'];
const isAgent = speaker => AGENT_HINTS.some(hint => speaker.includes(hint));

/**
 * Normalises whatever GHL calls a transcript into our turn shape.
 * Handles an array of message objects, an array of strings, and the single
 * "Agent: …\nUser: …" blob Retell hands back.
 */
function parseTranscript(raw) {
  const fromLine = line => {
    const trimmed = str(line, 2100);
    if (!trimmed) return null;
    const labelled = /^([A-Za-z][A-Za-z ._-]{0,24}):\s*(.+)$/.exec(trimmed);
    // An unlabelled line is agent narration in every payload seen so far; the
    // visitor's speech is what GHL bothers to attribute.
    if (!labelled) return { role: 'byte', text: trimmed.slice(0, 2000) };
    return { role: isAgent(labelled[1].toLowerCase()) ? 'byte' : 'visitor', text: labelled[2].slice(0, 2000) };
  };

  if (Array.isArray(raw)) {
    return raw.map(entry => {
      if (typeof entry === 'string') return fromLine(entry);
      if (!entry || typeof entry !== 'object') return null;
      const text = str(entry.text ?? entry.message ?? entry.content ?? entry.transcript, 2000);
      if (!text) return null;
      const speaker = String(entry.role ?? entry.speaker ?? entry.from ?? entry.type ?? '').toLowerCase();
      return { role: speaker && !isAgent(speaker) ? 'visitor' : 'byte', text };
    }).filter(Boolean).slice(0, MAX_TURNS);
  }

  if (typeof raw === 'string') {
    return raw.split(/\r?\n/).map(fromLine).filter(Boolean).slice(0, MAX_TURNS);
  }
  return [];
}

/** Reads services off GHL tags; never invents one the call did not mention. */
function parseServices(flat) {
  const tags = []
    .concat(Array.isArray(flat.tags) ? flat.tags : str(flat.tags, 500).split(','))
    .map(tag => String(tag).trim().toLowerCase())
    .filter(Boolean);

  const services = [];
  for (const [service, matches] of Object.entries(SERVICE_TAGS)) {
    if (tags.some(tag => matches.includes(tag))) services.push(service);
  }
  return services.slice(0, 4);
}

/**
 * Finds the `calls` document this webhook belongs to.
 *
 * GoHighLevel never learns the id the browser generated, so there is no shared
 * key to join on unless the workflow is configured to pass one back. The
 * fallbacks narrow by session, then by "the most recent call nobody has claimed
 * yet" — which is exact for the one-call-at-a-time reality of a marketing site
 * and is why an unclaimed match is logged rather than assumed correct.
 */
async function findCallDoc(db, { siteCallId, providerCallId, sid, startedAt }) {
  const calls = db.collection('calls');

  if (siteCallId) {
    const direct = await calls.doc(siteCallId).get();
    if (direct.exists) return direct;
  }

  // A retried webhook has to land on the document the first delivery created.
  if (providerCallId) {
    const seen = await calls.where('providerCallId', '==', providerCallId).limit(1).get();
    if (!seen.empty) return seen.docs[0];
  }

  if (sid) {
    const bySession = await calls.where('sid', '==', sid).orderBy('startedAt', 'desc').limit(1).get();
    if (!bySession.empty) return bySession.docs[0];
  }

  const since = Timestamp.fromMillis((startedAt?.getTime() ?? Date.now()) - CALL_MATCH_WINDOW_MS);
  const recent = await calls.where('startedAt', '>=', since).orderBy('startedAt', 'desc').limit(10).get();
  const unclaimed = recent.docs.find(entry => !entry.get('providerCallId') && !entry.get('leadId'));
  if (unclaimed) console.log(`[voice] matched call ${unclaimed.id} by recency — no id was passed back`);
  return unclaimed || null;
}

// A deterministic id makes a redelivered webhook a no-op instead of a duplicate
// lead. GHL retries on any non-2xx, so this is a matter of when, not if.
const leadIdFor = providerCallId =>
  providerCallId ? `voice_${providerCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200)}` : '';

const ALREADY_EXISTS = error => error?.code === 6 || error?.code === 'already-exists';

export const recordVoiceCall = onRequest(
  { secrets: [VOICE_WEBHOOK_SECRET], maxInstances: 5 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
      return;
    }

    const expected = VOICE_WEBHOOK_SECRET.value() || '';
    // Fail closed. The placeholder every secret starts life as must never be a
    // working credential on an endpoint that creates leads.
    if (expected.length < 16 || expected === 'unset') {
      console.error('[voice] VOICE_WEBHOOK_SECRET is not set — refusing the request');
      res.status(503).json({ error: 'not-configured' });
      return;
    }

    const provided = str(req.get('x-webhook-secret'), 200)
      || str(req.query?.key, 200)
      || str(req.body?.secret, 200);
    if (provided !== expected) {
      console.warn('[voice] rejected a request with a bad or missing secret');
      res.status(401).json({ error: 'unauthorised' });
      return;
    }

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const flat = flatten(body);

    const providerCallId = pick(flat, ALIASES.providerCallId, 200);
    const sid = pick(flat, ALIASES.sid, 40);
    const siteCallId = pick(flat, ALIASES.siteCallId, 60);
    const startedAt = parseDate(pickRaw(flat, ALIASES.startedAt));
    const durationSec = parseDuration(pickRaw(flat, ALIASES.duration));
    const summary = pick(flat, ALIASES.summary, 5000);
    const recordingUrl = pick(flat, ALIASES.recordingUrl, 500);
    const turns = parseTranscript(pickRaw(flat, ALIASES.transcript));

    const first = pick(flat, ALIASES.firstName, 60);
    const last = pick(flat, ALIASES.lastName, 60);
    const name = pick(flat, ALIASES.name, 120) || [first, last].filter(Boolean).join(' ');
    const email = pick(flat, ALIASES.email, 200).toLowerCase();
    const phone = pick(flat, ALIASES.phone, 40);

    const db = getFirestore();

    try {
      // ---- 1. The call record ------------------------------------------------
      let callDoc = await findCallDoc(db, { siteCallId, providerCallId, sid, startedAt });
      let callId = callDoc?.id || '';

      const callUpdate = {
        agent: 'byte',
        channel: 'voice',
        provider: 'gohighlevel',
        status: 'completed',
        endedAt: FieldValue.serverTimestamp()
      };
      if (providerCallId) callUpdate.providerCallId = providerCallId;
      if (durationSec) callUpdate.durationSec = durationSec;
      if (summary) callUpdate.summary = summary;
      if (recordingUrl) callUpdate.recordingUrl = recordingUrl;

      if (callDoc) {
        await callDoc.ref.set(callUpdate, { merge: true });
      } else {
        // No browser-side record: the call did not start from the site widget.
        // Still worth a document — a call is a call, and Conversations should
        // show it next to the rest.
        const created = await db.collection('calls').add({
          ...callUpdate,
          sid: sid || 'server',
          path: '/',
          startedAt: startedAt ? Timestamp.fromDate(startedAt) : FieldValue.serverTimestamp()
        });
        callId = created.id;
        callDoc = await created.get();
      }

      // ---- 2. The transcript -------------------------------------------------
      // Replayed webhooks would otherwise append the same lines a second time.
      if (turns.length && !callDoc.get('transcriptRecorded')) {
        const batch = db.batch();
        const base = startedAt?.getTime() ?? Date.now();
        turns.forEach((turn, index) => {
          batch.set(db.collection('calls').doc(callId).collection('turns').doc(), {
            kind: 'transcript',
            role: turn.role,
            text: turn.text,
            // Ordered by `at` in the dashboard, so give the lines distinct,
            // increasing stamps instead of one identical server timestamp.
            at: Timestamp.fromMillis(base + index)
          });
        });
        batch.set(db.collection('calls').doc(callId), { transcriptRecorded: true }, { merge: true });
        await batch.commit();
      }

      // ---- 3. The lead -------------------------------------------------------
      // No way to reach them is not a lead, it is just a call. Record it and stop.
      if (!email && !phone) {
        console.log(`[voice] call ${callId} captured no contact details — no lead created`);
        res.status(200).json({ ok: true, callId, leadId: null, reason: 'no-contact-details' });
        return;
      }

      const lead = {
        name: name || 'Byte caller',
        // Always present, even when empty: firestore.rules holds `email`
        // immutable on update by comparing it against the stored value, and a
        // missing key there fails the whole rule, making the lead un-triageable.
        email,
        phone,
        businessSize: '',
        services: parseServices(flat),
        preferredContactMethod: phone && !email ? 'phone' : 'email',
        source: 'byte_voice',
        status: 'new',
        createdAt: FieldValue.serverTimestamp(),
        pagePath: callDoc.get('path') || '/',
        voice: {
          callId,
          providerCallId,
          durationSec,
          summary,
          recordingUrl
        },
        // It came from GoHighLevel, so it is already in the CRM. Saying so keeps
        // the dashboard's CRM column honest and matches the sync trigger's skip.
        crm: { synced: true, reason: 'origin-gohighlevel', at: FieldValue.serverTimestamp() }
      };

      const businessName = pick(flat, ALIASES.businessName, 160);
      const roleInCompany = pick(flat, ALIASES.roleInCompany, 160);
      // Not falling back to `summary`: it already has a home under `voice`, and
      // repeating it here would print it twice in the dashboard panel.
      const projectDetails = pick(flat, ALIASES.projectDetails, 5000);
      if (businessName) lead.businessName = businessName;
      if (roleInCompany) lead.roleInCompany = roleInCompany;
      if (projectDetails) lead.projectDetails = projectDetails;

      const deterministicId = leadIdFor(providerCallId);
      const leadRef = deterministicId
        ? db.collection('leads').doc(deterministicId)
        : db.collection('leads').doc();

      try {
        await leadRef.create(lead);
      } catch (error) {
        if (!ALREADY_EXISTS(error)) throw error;
        console.log(`[voice] lead ${leadRef.id} already recorded — redelivery ignored`);
        res.status(200).json({ ok: true, callId, leadId: leadRef.id, duplicate: true });
        return;
      }

      await db.collection('calls').doc(callId).set({ leadId: leadRef.id }, { merge: true });

      console.log(`[voice] call ${callId} → lead ${leadRef.id}`);
      res.status(200).json({ ok: true, callId, leadId: leadRef.id });
    } catch (error) {
      // 500 so GoHighLevel retries — a dropped call summary is a lost lead.
      console.error('[voice] recordVoiceCall failed:', error);
      res.status(500).json({ error: 'internal' });
    }
  }
);

// ====================================================== Byte (voice) — pull ===
//
// The webhook above is the real-time path, but it needs a Custom Webhook action
// wired up by hand in the GoHighLevel workflow builder — and workflows are
// read-only over the API, so that step cannot be automated.
//
// This is the path that needs no GHL configuration at all: the Voice AI call-log
// API, polled on a schedule. GoHighLevel keeps every Byte call with a summary,
// a transcript and the fields the agent extracted during the conversation, so
// everything a lead needs is already sitting there to be read.
//
// Contract, verified against the live API (July 2026):
//
//   GET services.leadconnectorhq.com/voice-ai/dashboard/call-logs
//       Authorization: Bearer <private integration token>   Version: 2021-07-28
//       ?locationId= &page=(1-based) &pageSize=(max 50) &startDate= &endDate=
//   → { callLogs[], total, page, pageSize }
//
//   A call log carries: id, contactId, createdAt, duration (seconds), summary,
//   transcript ("bot:"/"human:" lines), trialCall, fromNumber (real calls only),
//   and extractedData { name, email, otherDetails, address }.
//
// Three things the API does NOT do, all worked around below:
//   * `startDate` / `endDate` are accepted and then silently ignored — asking
//     for March alone returns July calls — so the date window is applied here;
//   * `total` is not filter-aware either, so a short page is the only reliable
//     end of pagination;
//   * there is no sort parameter — results come back newest first, which is the
//     one helpful accident, because it makes an early exit possible.

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_PAGE_SIZE = 50;          // the documented maximum; 422 above it
const GHL_MAX_PAGES = 40;          // a backstop, not an expected depth
const POLL_WINDOW_DAYS = 2;        // re-scanned every run; the ids make that safe
const MIN_CALL_SECONDS = 10;       // shorter than this and nobody said anything

const isoDay = date => date.toISOString().slice(0, 10);

/**
 * Pages through the call log and returns everything inside [since, until].
 *
 * The filtering is done here rather than by the API because the API's own date
 * parameters do nothing. Results arrive newest first, so the moment a page runs
 * past `since` there is nothing older left worth asking for — which is what
 * keeps a poll to a page or two however many calls accumulate. Without that
 * early exit this would re-download the entire history every five minutes.
 */
async function fetchCallLogs({ token, locationId, since, until }) {
  const sinceMs = since ? since.getTime() : -Infinity;
  const untilMs = until ? until.getTime() : Infinity;
  const logs = [];

  for (let page = 1; page <= GHL_MAX_PAGES; page += 1) {
    const url = `${GHL_API}/voice-ai/dashboard/call-logs`
      + `?locationId=${encodeURIComponent(locationId)}`
      + `&page=${page}&pageSize=${GHL_PAGE_SIZE}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(`call-logs ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const body = await response.json();
    const batch = Array.isArray(body?.callLogs) ? body.callLogs : [];
    if (!batch.length) break;

    let ranPastWindow = false;
    for (const log of batch) {
      const at = Date.parse(log?.createdAt);
      if (!Number.isFinite(at)) continue;
      if (at < sinceMs) { ranPastWindow = true; continue; }
      if (at > untilMs) continue;
      logs.push(log);
    }

    if (ranPastWindow || batch.length < GHL_PAGE_SIZE) break;
  }
  return logs;
}

/**
 * One lead per *person*, not per call. A prospect who rings four times is one
 * lead with four calls against it, not four rows to work through — so the
 * document is keyed on GoHighLevel's own contact id, which is what resolves a
 * repeat caller to the same person in the first place.
 */
const leadKeyFor = log => {
  const contactId = str(log.contactId, 100);
  if (contactId) return `voice_${contactId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const fallback = (str(log.extractedData?.email, 200) || str(log.fromNumber, 40)).toLowerCase();
  return fallback ? `voice_${fallback.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200)}` : '';
};

/** Everything the dashboard needs, pulled out of one call log. */
function readCallLog(log) {
  const extracted = log.extractedData && typeof log.extractedData === 'object' ? log.extractedData : {};
  const at = parseDate(log.createdAt);
  return {
    providerCallId: str(log.id, 200),
    contactId: str(log.contactId, 100),
    at: at || new Date(),
    durationSec: Math.max(0, Math.round(Number(log.duration) || 0)),
    summary: str(log.summary, 5000),
    transcript: parseTranscript(log.transcript),
    name: str(extracted.name, 120),
    email: str(extracted.email, 200).toLowerCase(),
    // Only a real inbound call has a number; a website demo has no caller id.
    phone: str(log.fromNumber, 40),
    details: str(extracted.otherDetails, 5000),
    address: str(extracted.address, 300),
    demo: Boolean(log.trialCall)
  };
}

/**
 * Writes the call and its transcript, keyed so re-polling is a no-op.
 *
 * Returns whether this call has already been counted against a lead. The poller
 * re-scans a two-day window every five minutes, so without this every call would
 * be folded into its lead hundreds of times over and `callCount` would climb
 * forever. The call document is the record of what has already been counted.
 */
async function storeCall(db, call) {
  const callRef = db.collection('calls').doc(`ghl_${call.providerCallId.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  const existing = await callRef.get();
  const alreadyLinked = Boolean(existing.get('leadId'));

  await callRef.set({
    agent: 'byte',
    channel: 'voice',
    provider: 'gohighlevel',
    status: 'completed',
    sid: `ghl:${call.contactId || 'unknown'}`,
    path: '/',
    startedAt: Timestamp.fromDate(call.at),
    endedAt: Timestamp.fromMillis(call.at.getTime() + call.durationSec * 1000),
    durationSec: call.durationSec,
    providerCallId: call.providerCallId,
    summary: call.summary,
    demo: call.demo
  }, { merge: true });

  if (call.transcript.length && !existing.get('transcriptRecorded')) {
    const batch = db.batch();
    call.transcript.forEach((turn, index) => {
      batch.set(callRef.collection('turns').doc(), {
        kind: 'transcript',
        role: turn.role,
        text: turn.text,
        at: Timestamp.fromMillis(call.at.getTime() + index)
      });
    });
    batch.set(callRef, { transcriptRecorded: true }, { merge: true });
    await batch.commit();
  }

  return { id: callRef.id, ref: callRef, alreadyLinked };
}

/**
 * Creates the lead, or folds a repeat call into the one that already exists.
 *
 * Triage is never touched: `status` and `createdAt` belong to whoever has been
 * working the lead, and a later call must not quietly reset either. `createdAt`
 * tracks the *first* call, so the dashboard orders by when the person actually
 * turned up rather than when this function happened to run.
 */
async function upsertVoiceLead(db, { call, callDocId }) {
  const leadId = leadKeyFor({ contactId: call.contactId, extractedData: { email: call.email }, fromNumber: call.phone });
  if (!leadId) return null;

  const ref = db.collection('leads').doc(leadId);

  const created = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const previous = snapshot.exists ? snapshot.data() : null;

    const voice = {
      callId: callDocId,
      providerCallId: call.providerCallId,
      contactId: call.contactId,
      durationSec: call.durationSec,
      summary: call.summary,
      demo: call.demo,
      lastCallAt: Timestamp.fromDate(call.at),
      callCount: (previous?.voice?.callCount || 0) + 1
    };

    if (!previous) {
      tx.set(ref, {
        name: call.name || 'Byte caller',
        email: call.email,
        phone: call.phone,
        businessSize: '',
        services: [],
        preferredContactMethod: call.phone && !call.email ? 'phone' : 'email',
        source: 'byte_voice',
        status: 'new',
        // The call's own time, not now — otherwise an imported history all
        // lands on today and the list sorts into nonsense.
        createdAt: Timestamp.fromDate(call.at),
        pagePath: '/',
        ...(call.details ? { projectDetails: call.details } : {}),
        ...(call.address ? { businessName: call.address } : {}),
        voice,
        crm: { synced: true, reason: 'origin-gohighlevel', at: FieldValue.serverTimestamp() }
      });
      return true;
    }

    // A later call may be the one that finally got their email out of them.
    const update = { voice };
    if (!previous.name || previous.name === 'Byte caller') update.name = call.name || previous.name;
    if (!previous.email && call.email) update.email = call.email;
    if (!previous.phone && call.phone) update.phone = call.phone;
    if (!previous.projectDetails && call.details) update.projectDetails = call.details;
    // Keep the earliest call as the arrival time.
    if (previous.createdAt?.toMillis?.() > call.at.getTime()) {
      update.createdAt = Timestamp.fromDate(call.at);
    }
    // A repeat caller is worth another look even if someone had parked them.
    if (previous.status === 'lost') update.status = 'new';

    tx.set(ref, update, { merge: true });
    return false;
  });

  return { leadId, created };
}

/** Shared by the schedule and the one-off import endpoint. */
async function importVoiceCalls({ token, locationId, since, until, includeDemo }) {
  const db = getFirestore();
  const logs = await fetchCallLogs({ token, locationId, since, until });

  const stats = { scanned: logs.length, skipped: 0, alreadyImported: 0, leadsCreated: 0, leadsUpdated: 0, calls: 0 };

  // Oldest first, so `createdAt` settles on the earliest call and a later one
  // only ever fills gaps in what the earlier calls already told us.
  const ordered = [...logs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  for (const log of ordered) {
    const call = readCallLog(log);

    if (!call.providerCallId) { stats.skipped += 1; continue; }
    if (call.demo && !includeDemo) { stats.skipped += 1; continue; }
    if (call.durationSec < MIN_CALL_SECONDS) { stats.skipped += 1; continue; }
    // No email and no caller id is a conversation, not a lead.
    if (!call.email && !call.phone) { stats.skipped += 1; continue; }

    const stored = await storeCall(db, call);
    stats.calls += 1;

    // Already counted against its lead on an earlier pass — the transcript and
    // summary above are still refreshed, but it must not be counted twice.
    if (stored.alreadyLinked) { stats.alreadyImported += 1; continue; }

    const result = await upsertVoiceLead(db, { call, callDocId: stored.id });
    if (!result) { stats.skipped += 1; continue; }

    await stored.ref.set({ leadId: result.leadId }, { merge: true });
    if (result.created) stats.leadsCreated += 1;
    else stats.leadsUpdated += 1;
  }

  return stats;
}

export const pollVoiceCalls = onSchedule(
  {
    schedule: 'every 5 minutes',
    secrets: [GHL_API_TOKEN],
    timeoutSeconds: 300,
    maxInstances: 1        // overlapping runs would just fight over the same docs
  },
  async () => {
    try {
      const stats = await importVoiceCalls({
        token: GHL_API_TOKEN.value(),
        locationId: GHL_LOCATION_ID,
        since: new Date(Date.now() - POLL_WINDOW_DAYS * 86400000),
        // A website demo caller who leaves a real email is a real lead; the
        // `voice.demo` flag keeps them separable in the dashboard.
        includeDemo: true
      });
      // Logged on every run, including quiet ones. A scheduled job that only
      // speaks up when it finds something is indistinguishable from one that
      // has silently stopped working — which is exactly the state this function
      // was in when its date window was broken and nothing looked wrong.
      console.log('[voice-poll]', JSON.stringify(stats));
    } catch (error) {
      console.error('[voice-poll] failed:', error.message);
      throw error;   // let the schedule retry
    }
  }
);

/**
 * One-off import over an explicit date range — used to bring history in.
 * Same secret as the webhook, since it writes leads just as freely.
 *
 *   curl -X POST "<url>?startDate=2026-01-01&endDate=2026-07-21&includeDemo=false" \
 *        -H "x-webhook-secret: …"
 */
export const importVoiceHistory = onRequest(
  { secrets: [VOICE_WEBHOOK_SECRET, GHL_API_TOKEN], timeoutSeconds: 540, maxInstances: 1 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
      return;
    }

    const expected = VOICE_WEBHOOK_SECRET.value() || '';
    if (expected.length < 16) {
      res.status(503).json({ error: 'not-configured' });
      return;
    }
    if (str(req.get('x-webhook-secret'), 200) !== expected) {
      res.status(401).json({ error: 'unauthorised' });
      return;
    }

    const startDate = str(req.query?.startDate, 10);
    const endDate = str(req.query?.endDate, 10) || isoDay(new Date());
    const includeDemo = String(req.query?.includeDemo ?? 'false') === 'true';
    const dryRun = String(req.query?.dryRun ?? 'false') === 'true';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      res.status(400).json({ error: 'startDate=YYYY-MM-DD is required' });
      return;
    }

    // Whole days, inclusive of both ends. The API ignores its own date params,
    // so this window is what actually does the filtering.
    const since = new Date(`${startDate}T00:00:00.000Z`);
    const until = new Date(`${endDate}T23:59:59.999Z`);

    try {
      if (dryRun) {
        // Count what would happen without writing anything — worth having
        // before an import that cannot be un-run in one command.
        const logs = await fetchCallLogs({
          token: GHL_API_TOKEN.value(),
          locationId: GHL_LOCATION_ID,
          since,
          until
        });
        const eligible = logs.map(readCallLog).filter(call =>
          call.providerCallId
          && (includeDemo || !call.demo)
          && call.durationSec >= MIN_CALL_SECONDS
          && (call.email || call.phone));
        res.status(200).json({
          ok: true,
          dryRun: true,
          scanned: logs.length,
          eligible: eligible.length,
          distinctContacts: new Set(eligible.map(c => c.contactId)).size
        });
        return;
      }

      const stats = await importVoiceCalls({
        token: GHL_API_TOKEN.value(),
        locationId: GHL_LOCATION_ID,
        since,
        until,
        includeDemo
      });
      console.log('[voice-import]', JSON.stringify({ startDate, endDate, includeDemo, ...stats }));
      res.status(200).json({ ok: true, startDate, endDate, includeDemo, ...stats });
    } catch (error) {
      console.error('[voice-import] failed:', error);
      res.status(500).json({ error: String(error.message).slice(0, 300) });
    }
  }
);
