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

import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { createHash, randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import {
  addBroadcastUnsubscribe,
  DEFAULT_EMAIL_TEMPLATES,
  buildLeadOutreachTemplate,
  buildMessage,
  getEmailTemplate,
  seedEmailTemplates,
  sendPostmark
} from './email.js';
import { aggregateFunnelData } from './aggregate-funnel.js';
import { describeSlotForSpeech, loadCalendarSettings } from './booking-calendar.js';
import { normalizeAccountScope } from './account-access.js';

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const GHL_WEBHOOK_URL = defineSecret('GHL_WEBHOOK_URL');
const VOICE_WEBHOOK_SECRET = defineSecret('VOICE_WEBHOOK_SECRET');
const GHL_API_TOKEN = defineSecret('GHL_API_TOKEN');
const POSTMARK_SERVER_TOKEN = defineSecret('POSTMARK_SERVER_TOKEN');
const POSTMARK_WEBHOOK_SECRET = defineSecret('POSTMARK_WEBHOOK_SECRET');
const LEAD_LIFECYCLE_WEBHOOK_SECRET = defineSecret('LEAD_LIFECYCLE_WEBHOOK_SECRET');
const SEARCH_CONSOLE_SITE_URL = defineString('SEARCH_CONSOLE_SITE_URL', { default: 'sc-domain:bitesites.org' });

// The sub-account the Voice AI agent lives in. Not a secret — it is visible in
// the GoHighLevel URL bar — so a plain constant rather than a stored secret. A
// defineString param would be tidier, but its default does not resolve outside a
// deployed context, which silently breaks tests and local runs.
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'LDL5wuJlnVnqk9vn6taD';

// ---------------------------------------------------------------- visit location

// Coarse IP geolocation for the first-party analytics dashboard. The IP is
// used only for the lookup and is never written to Firestore. Latitude and
// longitude are rounded to a tenth of a degree (roughly city-scale), which is
// plenty for the globe while avoiding a misleading sense of precision.
const GEO_CACHE_TTL_MS = 20 * 60 * 1000;
const geoCache = new Map();

const analyticsText = (value, maxLen) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLen) : '';

function requestIp(req) {
  const forwarded = analyticsText(req.get('x-forwarded-for'), 500)
    .split(',')
    .map(value => value.trim())
    .find(Boolean);
  return (forwarded || req.ip || '').replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
}

function isPublicIp(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1') return false;
  if (/^(10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return false;
  const match = ip.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return false;
  if (/^(fc|fd|fe80):/i.test(ip)) return false;
  return true;
}

async function lookupLocation(ip) {
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const fields = 'success,country,country_code,region,city,latitude,longitude,timezone.id';
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=${fields}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`geolocation provider returned ${response.status}`);
    const body = await response.json();
    if (!body?.success || !Number.isFinite(body.latitude) || !Number.isFinite(body.longitude)) {
      throw new Error('geolocation provider returned no usable location');
    }

    const value = {
      country: analyticsText(body.country, 80),
      countryCode: analyticsText(body.country_code, 2).toUpperCase(),
      region: analyticsText(body.region, 80),
      city: analyticsText(body.city, 80),
      lat: Math.round(body.latitude * 10) / 10,
      lon: Math.round(body.longitude * 10) / 10,
      timezone: analyticsText(body.timezone?.id, 80)
    };
    geoCache.set(ip, { at: Date.now(), value });
    if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

export const recordVisitLocation = onRequest(
  { maxInstances: 3, timeoutSeconds: 10 },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sid = analyticsText(body.sid, 40);
    const vid = analyticsText(body.vid, 40);
    const path = analyticsText(body.path, 300) || '/';
    const device = ['mobile', 'tablet', 'desktop'].includes(body.device) ? body.device : 'desktop';
    if (!/^[A-Za-z0-9._-]{8,40}$/.test(sid) || !/^[A-Za-z0-9._-]{8,40}$/.test(vid)) {
      res.status(400).json({ error: 'invalid-session' });
      return;
    }

    const ip = requestIp(req);
    if (!isPublicIp(ip)) {
      // Local emulator traffic has no meaningful location. This is a normal
      // no-op rather than an error so local development stays quiet.
      res.status(204).end();
      return;
    }

    try {
      const location = await lookupLocation(ip);
      const day = new Date().toISOString().slice(0, 10);
      const id = `location_${day}_${createHash('sha256').update(sid).digest('hex').slice(0, 24)}`;
      await getFirestore().collection('events').doc(id).create({
        type: 'location', sid, vid, path, day, device,
        ...location,
        ts: FieldValue.serverTimestamp()
      });
      res.status(202).json({ recorded: true });
    } catch (error) {
      if (ALREADY_EXISTS(error)) {
        res.status(200).json({ recorded: true, duplicate: true });
        return;
      }
      console.warn('[analytics] visit location could not be recorded', error?.message || error);
      res.status(503).json({ error: 'location-unavailable' });
    }
  }
);

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
const LEAD_SOURCE_NOTES = {
  bit_chat: 'Bit chat assistant',
  booking_page: 'Consultation booking page',
  intake_form: 'Website intake form'
};

const LEAD_SOURCE_CRM = {
  bit_chat: 'Website - Bit chat',
  booking_page: 'Website - booking page',
  intake_form: 'Website - intake form'
};

function buildNotes(lead) {
  const lines = [
    `Source: ${LEAD_SOURCE_NOTES[lead.source] || LEAD_SOURCE_NOTES.intake_form}`,
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
    source: LEAD_SOURCE_CRM[lead.source] || LEAD_SOURCE_CRM.intake_form,
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
      roleInCompany: lead.roleInCompany || null,
      sessionId: lead.sid || null,
      visitorId: lead.vid || null,
      siteVersion: lead.siteVersion || null,
      attribution: lead.attribution || null
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
    secrets: [GHL_WEBHOOK_URL, POSTMARK_SERVER_TOKEN]
  },
  async event => {
    const snapshot = event.data;
    if (!snapshot) return;

    const lead = snapshot.data();
    const { leadId } = event.params;

    // A Byte lead created *by* GoHighLevel (see recordVoiceCall below) is
    // already a contact over there. Pushing it back would duplicate it — and,
    // since that workflow posts to us, could bounce between the two. Leads
    // from the native homepage engine (byte-web-session.js) carry no such
    // origin marker and sync forward like any other lead.
    if (lead.source === 'byte_voice' && lead.crm?.reason === 'origin-gohighlevel') {
      console.log(`[lead ${leadId}] originated in GoHighLevel (Voice AI call) — not syncing back`);
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
      await createOperationalAlert(getFirestore(), {
        key: `crm-sync:${leadId}`, title: 'Lead failed to sync to GoHighLevel',
        message: error.message, component: 'GoHighLevel lead sync', reference: leadId
      });
    }
  }
);

// ============================================================== Byte (voice) ==
//
// Byte's half of the funnel used to stop at GoHighLevel. GHL owns the call — the
// audio, the transcript, and the contact it captures — and none of that reaches
// Firestore on its own. The browser only records the *shape* of the session (see
// src/lib/conversations.js), so `leads` never received anything from a voice
// call and the dashboard had no voice leads to show.
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
  outcome: ['outcome', 'call_status', 'callStatus', 'disposition'],
  agentId: ['agentId', 'agent_id', 'voiceAgentId', 'voice_agent_id'],
  agentName: ['agentName', 'agent_name', 'voiceAgentName', 'voice_agent_name'],
  agentBusinessName: ['agentBusinessName', 'agent_business_name', 'voiceAgentBusinessName', 'voice_agent_business_name', 'clientName', 'client_name']
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

function canonicalClientName(agentName, businessName) {
  const agent = str(agentName, 120).toLowerCase();
  const business = str(businessName, 200);
  const comparable = business.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (agent === 'byte') return 'Bite Sites';
  if (agent === 'bella' || comparable.includes('stonebellis')) return 'Stone Bellisimo';
  if (comparable === 'bitesites') return 'Bite Sites';
  return business;
}

function normalizeReceivingAgent({ agentId = '', agentName = '', businessName = '' } = {}) {
  const id = str(agentId, 200);
  const name = str(agentName, 120);
  const clientName = canonicalClientName(name, businessName);
  if (!id && !name && !clientName) return null;
  return { agentId: id, agentName: name || 'Unidentified voice agent', clientName };
}

// ---------------------------------------------------------- lead lifecycle
// Return path for CRM/calendar outcomes. The original lead sync sends `leadId`
// to GoHighLevel; mapping it back here makes stage, appointment and revenue
// updates deterministic instead of relying on fuzzy contact matching.
const LIFECYCLE_STATUSES = new Set(['new', 'contacted', 'qualified', 'booked', 'proposal', 'won', 'lost']);
const APPOINTMENT_STATUSES = new Set(['none', 'booked', 'rescheduled', 'cancelled', 'attended', 'no_show']);
const LOST_REASONS = new Set(['', 'price', 'timing', 'no_response', 'competitor', 'poor_fit', 'internal_solution', 'other']);
const ECONOMIC_FIELDS = [
  'quotedValue', 'contractValue', 'cashCollected', 'recurringMonthlyRevenue',
  'estimatedHours', 'actualHours', 'loadedLaborCost', 'contractorCost',
  'softwareCost', 'refunds'
];

const nonNegative = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : 0;
};

export const recordLeadLifecycle = onRequest(
  { secrets: [LEAD_LIFECYCLE_WEBHOOK_SECRET], maxInstances: 10 },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return; }
    const expected = str(LEAD_LIFECYCLE_WEBHOOK_SECRET.value(), 200);
    const provided = str(req.get('x-webhook-secret'), 200);
    if (expected.length < 16 || expected === 'unset') { res.status(503).json({ error: 'not-configured' }); return; }
    if (provided !== expected) { res.status(401).json({ error: 'unauthorised' }); return; }

    const body = req.body && typeof req.body === 'object' ? flatten(req.body) : {};
    const db = getFirestore();
    const leadId = str(body.leadId || body.lead_id, 200);
    let leadRef = leadId ? db.collection('leads').doc(leadId) : null;
    let snapshot = leadRef ? await leadRef.get() : null;

    // Email/phone matching is a fallback for systems that cannot retain custom
    // fields. It is intentionally exact and limited to one result.
    if (!snapshot?.exists) {
      const email = str(body.email, 200).toLowerCase();
      const phone = str(body.phone, 40);
      const match = email
        ? await db.collection('leads').where('email', '==', email).orderBy('createdAt', 'desc').limit(1).get()
        : phone
          ? await db.collection('leads').where('phone', '==', phone).orderBy('createdAt', 'desc').limit(1).get()
          : null;
      if (match && !match.empty) {
        snapshot = match.docs[0];
        leadRef = snapshot.ref;
      }
    }
    if (!snapshot?.exists || !leadRef) { res.status(404).json({ error: 'lead-not-found' }); return; }

    const previous = snapshot.data();
    const update = { updatedAt: FieldValue.serverTimestamp() };
    const status = str(body.status || body.stage, 30).toLowerCase();
    if (status && !LIFECYCLE_STATUSES.has(status)) { res.status(400).json({ error: 'invalid-status' }); return; }
    if (status) {
      update.status = status;
      update.statusChangedAt = FieldValue.serverTimestamp();
      update[`stageTimestamps.${status}`] = FieldValue.serverTimestamp();
      if (status !== 'new' && !previous.firstResponseAt) update.firstResponseAt = FieldValue.serverTimestamp();
    }

    const appointmentStatus = str(body.appointmentStatus || body.appointment_status, 30).toLowerCase();
    if (appointmentStatus && !APPOINTMENT_STATUSES.has(appointmentStatus)) { res.status(400).json({ error: 'invalid-appointment-status' }); return; }
    if (appointmentStatus) update['appointment.status'] = appointmentStatus;
    const scheduledFor = parseDate(body.scheduledFor || body.scheduled_for || body.appointmentTime);
    if (scheduledFor) update['appointment.scheduledFor'] = Timestamp.fromDate(scheduledFor);
    const appointmentEventAt = parseDate(body.appointmentEventAt || body.appointment_event_at) || new Date();
    if (appointmentStatus === 'booked' || appointmentStatus === 'rescheduled') update['appointment.bookedAt'] = Timestamp.fromDate(appointmentEventAt);
    if (appointmentStatus === 'attended') update['appointment.attendedAt'] = Timestamp.fromDate(appointmentEventAt);

    const lostReason = str(body.lostReason || body.lost_reason, 40).toLowerCase();
    if (!LOST_REASONS.has(lostReason)) { res.status(400).json({ error: 'invalid-lost-reason' }); return; }
    if (lostReason) update['qualification.lostReason'] = lostReason;
    const owner = str(body.owner, 120);
    const competitor = str(body.competitor, 160);
    const primaryProblem = str(body.primaryProblem || body.primary_problem, 1000);
    if (owner) update.owner = owner;
    if (competitor) update['qualification.competitor'] = competitor;
    if (primaryProblem) update['qualification.primaryProblem'] = primaryProblem;

    const suppliedEconomics = body.economics && typeof body.economics === 'object' ? body.economics : body;
    const economics = { ...(previous.economics || {}) };
    let hasEconomics = false;
    for (const field of ECONOMIC_FIELDS) {
      if (suppliedEconomics[field] === undefined && suppliedEconomics[field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] === undefined) continue;
      const snake = field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      economics[field] = nonNegative(suppliedEconomics[field] ?? suppliedEconomics[snake]);
      hasEconomics = true;
    }
    if (hasEconomics) {
      const contract = nonNegative(economics.contractValue);
      const costs = nonNegative(economics.loadedLaborCost) + nonNegative(economics.contractorCost)
        + nonNegative(economics.softwareCost) + nonNegative(economics.refunds);
      economics.grossProfit = Math.round((contract - costs) * 100) / 100;
      economics.grossMargin = contract > 0 ? Math.round((economics.grossProfit / contract) * 10000) / 100 : 0;
      update.economics = economics;
    }

    const eventKey = str(body.eventId || body.event_id, 200)
      || createHash('sha256').update(JSON.stringify(req.body)).digest('hex').slice(0, 48);
    const activityRef = leadRef.collection('activities').doc(`webhook_${eventKey.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 500));
    const batch = db.batch();
    batch.update(leadRef, update);
    batch.set(activityRef, {
      type: 'lifecycle_webhook',
      fromStatus: previous.status || 'new',
      toStatus: status || previous.status || 'new',
      appointmentStatus: appointmentStatus || '',
      changed: Object.keys(update),
      at: FieldValue.serverTimestamp()
    }, { merge: true });
    await batch.commit();
    res.status(200).json({ ok: true, leadId: leadRef.id, status: status || previous.status || 'new' });
  }
);

// ---------------------------------------------------------- organic search
// Search Console is intentionally pulled server-side with Application Default
// Credentials. Grant the deployed function service account read access to the
// Search Console property; no OAuth token or API key is shipped to the browser.
export const syncSearchConsole = onSchedule(
  { schedule: 'every day 05:15', timeoutSeconds: 180, maxInstances: 1 },
  async () => {
    const siteUrl = str(SEARCH_CONSOLE_SITE_URL.value(), 500);
    if (!siteUrl) return;
    const end = new Date();
    // Search Console final data is delayed. Re-read a rolling seven-day window
    // and overwrite deterministic rows so late adjustments settle naturally.
    end.setUTCDate(end.getUTCDate() - 2);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    const dateKey = date => date.toISOString().slice(0, 10);
    try {
      const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
      const client = await auth.getClient();
      const response = await client.request({
        url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        method: 'POST',
        data: {
          startDate: dateKey(start), endDate: dateKey(end),
          dimensions: ['date', 'query', 'page', 'device'],
          type: 'web', dataState: 'final', rowLimit: 25000
        }
      });
      const rows = Array.isArray(response.data?.rows) ? response.data.rows : [];
      const db = getFirestore();
      for (let offset = 0; offset < rows.length; offset += 450) {
        const batch = db.batch();
        for (const row of rows.slice(offset, offset + 450)) {
          const [day, query, page, device] = row.keys || [];
          if (!day || !query || !page) continue;
          const id = createHash('sha256').update(`${day}\n${query}\n${page}\n${device || ''}`).digest('hex');
          batch.set(db.collection('searchMetrics').doc(id), {
            day: str(day, 10), query: str(query, 500), page: str(page, 1000),
            device: str(device, 20).toLowerCase(), clicks: nonNegative(row.clicks),
            impressions: nonNegative(row.impressions), ctr: nonNegative(row.ctr),
            position: nonNegative(row.position), syncedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
        await batch.commit();
      }
      await db.doc('systemHealth/search-console').set({
        lastRunAt: FieldValue.serverTimestamp(), status: 'ok', rows: rows.length,
        startDate: dateKey(start), endDate: dateKey(end), siteUrl
      }, { merge: true });
      console.log('[search-console]', JSON.stringify({ siteUrl, rows: rows.length, start: dateKey(start), end: dateKey(end) }));
    } catch (error) {
      const db = getFirestore();
      await db.doc('systemHealth/search-console').set({
        lastRunAt: FieldValue.serverTimestamp(), status: 'failed', error: str(error.message, 1000), siteUrl
      }, { merge: true });
      await createOperationalAlert(db, {
        key: 'search-console-sync', title: 'Search Console sync failed',
        message: error.message, component: 'Search Console', reference: siteUrl
      });
      throw error;
    }
  }
);

// ---------------------------------------------------- durable funnel totals
// Heat maps intentionally read a capped event sample. Commercial funnels should
// not become undercounts at the same threshold, so only the low-volume decision
// events are rolled into one daily document with per-session deduplication.
export const aggregateFunnelEvent = onDocumentCreated(
  { document: 'events/{eventId}', maxInstances: 10 },
  async event => aggregateFunnelData(event.data?.data())
);

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

    // Secret Manager values set from stdin can carry a trailing newline. Treat
    // surrounding whitespace as transport formatting, just as we do for the
    // incoming header, so a correctly configured secret does not fail auth.
    const expected = str(VOICE_WEBHOOK_SECRET.value(), 200);
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
    const receivingAgent = normalizeReceivingAgent({
      agentId: pick(flat, ALIASES.agentId, 200),
      agentName: pick(flat, ALIASES.agentName, 120),
      businessName: pick(flat, ALIASES.agentBusinessName, 200)
    });

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
      if (receivingAgent) callUpdate.receivingAgent = receivingAgent;

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
        name: name || 'Voice caller',
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
          recordingUrl,
          ...(receivingAgent ? { receivingAgent } : {})
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
// API, polled on a schedule. GoHighLevel keeps every Voice AI call with a summary,
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
// GHL creates its call-log entry within a few seconds of the browser opening
// our first-party call document. There is no shared id between those systems,
// so a narrow timestamp match is the reliable bridge for website calls.
const IMPORT_CALL_MATCH_WINDOW_MS = 2 * 60 * 1000;

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

/** Resolves call-log agent ids to the human-readable agent and client names. */
async function fetchVoiceAgents({ token, locationId }) {
  const agents = [];
  const pageSize = 20;
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(
      `${GHL_API}/voice-ai/agents?locationId=${encodeURIComponent(locationId)}&page=${page}&pageSize=${pageSize}`,
      {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: 'v3',
        Accept: 'application/json'
      }
      }
    );
    if (!response.ok) {
      throw new Error(`voice agents ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const body = await response.json();
    const batch = Array.isArray(body?.agents) ? body.agents : [];
    agents.push(...batch);
    if (!batch.length || agents.length >= Number(body?.total || 0) || batch.length < pageSize) break;
  }
  return new Map(agents.map(agent => {
    const receivingAgent = normalizeReceivingAgent({
      agentId: agent.id,
      agentName: agent.agentName,
      businessName: agent.businessName
    });
    return [receivingAgent?.agentId, receivingAgent];
  }).filter(([id]) => id));
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
function readCallLog(log, agentsById = new Map()) {
  const extracted = log.extractedData && typeof log.extractedData === 'object' ? log.extractedData : {};
  const at = parseDate(log.createdAt);
  const agentId = str(log.agentId, 200);
  const agentCatalog = agentsById instanceof Map ? agentsById : new Map();
  const receivingAgent = agentCatalog.get(agentId)
    || normalizeReceivingAgent({ agentId });
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
    demo: Boolean(log.trialCall),
    receivingAgent
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
async function findImportedCallDoc(db, call) {
  const calls = db.collection('calls');

  // Once a call has been enriched, this is the stable path every re-poll takes.
  const linked = await calls.where('providerCallId', '==', call.providerCallId).limit(1).get();
  if (!linked.empty) return linked.docs[0];

  // Older imports used the deterministic GHL id. Keep recognising those even
  // if they pre-date providerCallId being indexed or were only partly written.
  const deterministic = await calls.doc(`ghl_${call.providerCallId.replace(/[^A-Za-z0-9_-]/g, '_')}`).get();
  if (deterministic.exists) return deterministic;

  // Website calls are already present with their state timeline. Match the
  // nearest unclaimed browser record instead of creating a duplicate row.
  const since = Timestamp.fromMillis(call.at.getTime() - IMPORT_CALL_MATCH_WINDOW_MS);
  const until = Timestamp.fromMillis(call.at.getTime() + IMPORT_CALL_MATCH_WINDOW_MS);
  const nearby = await calls
    .where('startedAt', '>=', since)
    .where('startedAt', '<=', until)
    .orderBy('startedAt', 'asc')
    .get();
  const candidates = nearby.docs.filter(doc =>
    doc.get('provider') === 'gohighlevel'
    && !doc.get('providerCallId')
    && !String(doc.get('sid') || '').startsWith('ghl:')
  );
  if (!candidates.length) return null;

  const nearest = candidates.reduce((best, doc) => {
    const distance = Math.abs((doc.get('startedAt')?.toMillis?.() ?? Infinity) - call.at.getTime());
    return !best || distance < best.distance ? { doc, distance } : best;
  }, null);
  console.log(`[voice-poll] matched GHL call ${call.providerCallId} to browser call ${nearest.doc.id}`);
  return nearest.doc;
}

async function storeCall(db, call) {
  const matched = await findImportedCallDoc(db, call);
  const callRef = matched?.ref
    || db.collection('calls').doc(`ghl_${call.providerCallId.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  const existing = matched || await callRef.get();
  const alreadyLinked = Boolean(existing.get('leadId'));

  const update = {
    agent: 'byte',
    channel: 'voice',
    provider: 'gohighlevel',
    status: 'completed',
    durationSec: call.durationSec,
    providerCallId: call.providerCallId,
    summary: call.summary,
    demo: call.demo,
    ...(call.receivingAgent ? { receivingAgent: call.receivingAgent } : {})
  };
  // Preserve browser metadata and exact lifecycle timestamps when they exist,
  // but close out old records whose page disappeared before `finishCall` ran.
  // Server-only calls need the whole lifecycle synthesised.
  if (!existing.exists) Object.assign(update, {
    sid: `ghl:${call.contactId || 'unknown'}`,
    path: '/',
    startedAt: Timestamp.fromDate(call.at)
  });
  if (!existing.get('endedAt')) {
    update.endedAt = Timestamp.fromMillis(call.at.getTime() + call.durationSec * 1000);
  }
  await callRef.set(update, { merge: true });

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

  return { id: callRef.id, ref: callRef, alreadyLinked, leadId: str(existing.get('leadId'), 200) };
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
      callCount: (previous?.voice?.callCount || 0) + 1,
      ...(call.receivingAgent ? { receivingAgent: call.receivingAgent } : {})
    };

    if (!previous) {
      tx.set(ref, {
        name: call.name || 'Voice caller',
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
    if (!previous.name || ['Byte caller', 'Voice caller'].includes(previous.name)) update.name = call.name || previous.name;
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
  const [logs, agentsById] = await Promise.all([
    fetchCallLogs({ token, locationId, since, until }),
    fetchVoiceAgents({ token, locationId }).catch(error => {
      // Agent attribution should recover on the next poll, but a temporary
      // metadata failure must not hold up transcripts or reachable leads.
      console.warn('[voice-poll] could not resolve agent names:', error.message);
      return new Map();
    })
  ]);

  const stats = {
    scanned: logs.length,
    skipped: 0,
    conversationsOnly: 0,
    alreadyImported: 0,
    leadsCreated: 0,
    leadsUpdated: 0,
    calls: 0
  };

  // Oldest first, so `createdAt` settles on the earliest call and a later one
  // only ever fills gaps in what the earlier calls already told us.
  const ordered = [...logs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  for (const log of ordered) {
    const call = readCallLog(log, agentsById);

    if (!call.providerCallId) { stats.skipped += 1; continue; }
    if (call.demo && !includeDemo) { stats.skipped += 1; continue; }
    if (call.durationSec < MIN_CALL_SECONDS) { stats.skipped += 1; continue; }
    const stored = await storeCall(db, call);
    stats.calls += 1;

    // Contact details decide whether this becomes a lead, not whether its
    // transcript is worth retaining. Website calls usually have neither.
    if (!call.email && !call.phone) {
      stats.conversationsOnly += 1;
      continue;
    }

    // Already counted against its lead on an earlier pass — the transcript and
    // summary above are still refreshed, but it must not be counted twice.
    if (stored.alreadyLinked) {
      // Re-polls also repair agent attribution on calls/leads imported before
      // GHL's agentId was retained.
      if (stored.leadId && call.receivingAgent) {
        await db.doc(`leads/${stored.leadId}`).update({
          'voice.receivingAgent': call.receivingAgent
        }).catch(error => console.warn(`[voice-poll] could not backfill lead ${stored.leadId}:`, error.message));
      }
      stats.alreadyImported += 1;
      continue;
    }

    const result = await upsertVoiceLead(db, { call, callDocId: stored.id });
    if (!result) { stats.skipped += 1; continue; }

    await stored.ref.set({ leadId: result.leadId }, { merge: true });
    if (call.email) {
      await queueFeedbackEmail(db, {
        sourceId: stored.id, sourceType: 'call', leadId: result.leadId,
        email: call.email, name: call.name, agent: 'byte',
        agentName: call.receivingAgent?.agentName
      });
    }
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
      await getFirestore().doc('systemHealth/voice-poll').set({
        status: 'healthy', lastRunAt: FieldValue.serverTimestamp(), stats
      }, { merge: true });
    } catch (error) {
      console.error('[voice-poll] failed:', error.message);
      await getFirestore().doc('systemHealth/voice-poll').set({
        status: 'failed', lastRunAt: FieldValue.serverTimestamp(), error: str(error.message, 500)
      }, { merge: true });
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

    const expected = str(VOICE_WEBHOOK_SECRET.value(), 200);
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

// =================================================== Accounts, pricing, email

// Pricing is deliberately server-side. A signed-out visitor receives no prices
// in the HTML or JavaScript bundle; authenticated users fetch this object through
// getServicePricing after Firebase has verified their ID token.
const SERVICE_PRICING = {
  web: [
    ['Starter Site', 'A sharp single-page site for early-stage launches or service businesses that need credibility fast.', 'From $1,000', ['Single-page site', 'Responsive design', 'Basic SEO', 'One revision']],
    ['Growth Site', 'A stronger marketing site built around your offer, content, and lead flow.', 'From $2,500', ['Up to 7 pages', 'Conversion-focused UX', 'Analytics setup', 'Two revisions'], true],
    ['Custom Build', 'A flexible site for businesses with more complex content, integrations, or workflows.', 'Let’s talk', ['Custom architecture', 'Integrations', 'Advanced SEO', 'Ongoing support']]
  ],
  social: [
    ['Visibility Starter', 'Stay active, polished, and top of mind with content that makes your brand worth following.', 'From $600/mo', ['8 on-brand posts each month', 'Strategic content calendar', 'Captions written to drive action', 'Scheduling and performance insights']],
    ['Growth Engine', 'Turn social attention into trust, engagement, and a steady path toward your next customer.', 'From $1,200/mo', ['16 posts across 2 channels', 'Campaign-led content strategy', 'Audience and community engagement', 'Monthly growth recommendations'], true],
    ['Market Leader', 'Build an always-on multi-channel presence designed for bigger campaigns, teams, and ambitions.', 'Let’s talk', ['Custom high-volume cadence', 'Launch and campaign support', 'Executive-ready reporting', 'Creative direction and approvals']]
  ],
  ai: [
    ['Automation Opportunity Audit', 'Find the repetitive work costing your team time—and the fastest opportunities to eliminate it.', 'From $750', ['End-to-end process mapping', 'High-impact opportunity scorecard', 'ROI-focused automation roadmap', 'Clear implementation plan']],
    ['Lead Flow Automation', 'Capture, qualify, and route every opportunity faster so your team can focus on closing.', 'From $2,000', ['Custom workflow architecture', 'CRM, form, and inbox integrations', 'AI-assisted lead handling', 'Testing, training, and handoff'], true],
    ['AI Growth System', 'Build a custom AI-powered operating system around the way your business wins and grows.', 'Let’s talk', ['Purpose-built AI workflows', 'Reliable human review points', 'Team documentation and training', 'Ongoing performance optimization']]
  ]
};

const emailEnvironment = () => ({
  from: process.env.POSTMARK_FROM_EMAIL || 'BiteSites <jensy@bitesites.org>',
  admin: process.env.ADMIN_NOTIFICATION_EMAIL || 'jensy@bitesites.org',
  appUrl: (process.env.APP_URL || 'https://bitesites.org').replace(/\/$/, ''),
  transactionalStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
  broadcastStream: process.env.POSTMARK_BROADCAST_STREAM || 'broadcast'
});

const firstName = user => {
  const named = str(user?.displayName, 120).split(/\s+/)[0];
  return named || str(user?.email, 200).split('@')[0] || 'there';
};

const normalizedEmail = value => str(value, 200).toLowerCase();
const emailKey = email => createHash('sha256').update(normalizedEmail(email)).digest('hex');
const tokenKey = token => createHash('sha256').update(str(token, 200)).digest('hex');
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** How long a confirmation waits for Google to mint the Meet link before going without it. */
const MEET_WAIT_MS = 10 * 60 * 1000;
const FEEDBACK_DELAY_MS = 30 * 60 * 1000;
const FEEDBACK_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

const EMAIL_SOURCE_LABELS = {
  intake_form: 'the project intake form',
  bit_chat: 'Bit',
  booking_page: 'the booking page',
  byte_voice: 'a Voice AI call'
};

const emailServiceNames = (services, fallback = 'A BiteSites consultation') => {
  const labels = {
    web_development: 'Web Development',
    ai_automation: 'AI Automation',
    social_media_management: 'Social Media Management',
    other: 'Other'
  };
  return (Array.isArray(services) ? services : []).map(value => labels[value] || value).filter(Boolean).join(', ') || fallback;
};

const readableDisposition = value => str(value, 80).replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) || 'Conversation completed';
const readableDuration = seconds => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return 'Not captured';
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
};

async function emailPreference(db, email) {
  const address = normalizedEmail(email);
  if (!EMAIL_PATTERN.test(address)) return { broadcasts: false, feedback: false, transactionalBlocked: true };
  const snapshot = await db.doc(`emailPreferences/${emailKey(address)}`).get();
  return { broadcasts: true, feedback: true, transactionalBlocked: false, ...(snapshot.data() || {}) };
}

async function createPreferenceLinks(db, email, env = emailEnvironment()) {
  const address = normalizedEmail(email);
  const token = randomBytes(32).toString('base64url');
  await db.doc(`emailPreferenceTokens/${tokenKey(token)}`).set({
    email: address,
    emailKey: emailKey(address),
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000)
  });
  return {
    preferenceUrl: `${env.appUrl}/email-preferences?token=${encodeURIComponent(token)}`,
    oneClickUrl: `${env.appUrl}/api/email-preferences?token=${encodeURIComponent(token)}`
  };
}

async function sendLifecycleEmail({ db, templateId, to, variables, tag, kind = templateId }) {
  const address = normalizedEmail(to);
  if (!EMAIL_PATTERN.test(address)) return { status: 'skipped', reason: 'no-email' };
  const preference = await emailPreference(db, address);
  if (preference.transactionalBlocked) {
    await recordDelivery(db, { templateId, kind, recipientCount: 0, status: 'suppressed', reason: 'transactional-blocked' });
    return { status: 'suppressed' };
  }
  const env = emailEnvironment();
  const template = await getEmailTemplate(db, templateId);
  try {
    const result = await sendPostmark(POSTMARK_SERVER_TOKEN.value(), buildMessage({
      from: env.from, to: address, template, variables,
      stream: env.transactionalStream, tag
    }));
    await recordDelivery(db, {
      templateId, kind, recipientCount: 1, recipientKey: emailKey(address),
      status: 'sent', postmark: [result.MessageID].filter(Boolean)
    });
    return { status: 'sent', result };
  } catch (error) {
    await recordDelivery(db, {
      templateId, kind, recipientCount: 1, recipientKey: emailKey(address),
      status: 'failed', error: str(error.message, 500)
    });
    throw error;
  }
}

async function createOperationalAlert(db, { key, title, message, component, reference = '', notify = true }) {
  const id = createHash('sha256').update(str(key, 500)).digest('hex').slice(0, 40);
  const ref = db.doc(`operationalAlerts/${id}`);
  const now = Date.now();
  let shouldNotify = false;
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const previous = snapshot.data() || {};
    const last = previous.lastNotifiedAt?.toMillis?.() || 0;
    shouldNotify = notify && now - last >= 60 * 60 * 1000;
    tx.set(ref, {
      key: str(key, 500), title: str(title, 200), message: str(message, 2000),
      component: str(component, 100), reference: str(reference, 500),
      status: 'open', count: (previous.count || 0) + 1,
      firstSeenAt: previous.firstSeenAt || FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
      ...(shouldNotify ? { lastNotifiedAt: FieldValue.serverTimestamp() } : {})
    }, { merge: true });
  });
  if (!shouldNotify) return;
  const env = emailEnvironment();
  if ((await emailPreference(db, env.admin)).transactionalBlocked) return;
  const template = await getEmailTemplate(db, 'operational_alert');
  try {
    const result = await sendPostmark(POSTMARK_SERVER_TOKEN.value(), buildMessage({
      from: env.from, to: env.admin, template,
      variables: {
        alert_title: title, alert_message: message, component, reference: reference || '—',
        admin_url: `${env.appUrl}/admin`
      },
      stream: env.transactionalStream, tag: 'operational-alert'
    }));
    await recordDelivery(db, {
      templateId: 'operational_alert', kind: 'operational-alert', recipientCount: 1,
      status: 'sent', postmark: [result.MessageID].filter(Boolean)
    });
  } catch (error) {
    console.error('[email] operational alert could not be delivered:', error.message);
  }
}

async function queueFeedbackEmail(db, { sourceId, sourceType, leadId = '', email, name, agent, agentName = '' }) {
  const address = normalizedEmail(email);
  if (!sourceId || !EMAIL_PATTERN.test(address)) return false;
  const jobId = `${sourceType}_${sourceId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 400);
  const jobRef = db.doc(`feedbackEmailJobs/${jobId}`);
  const existing = await jobRef.get();
  if (existing.exists) return false;
  const token = randomBytes(32).toString('base64url');
  const requestId = tokenKey(token);
  const expiresAt = Timestamp.fromMillis(Date.now() + FEEDBACK_EXPIRY_MS);
  const batch = db.batch();
  batch.create(db.doc(`feedbackRequests/${requestId}`), {
    tokenHash: requestId, sourceId: str(sourceId, 200), sourceType: str(sourceType, 30),
    leadId: str(leadId, 200), email: address, agent: agent === 'byte' ? 'byte' : 'bit',
    status: 'open', createdAt: FieldValue.serverTimestamp(), expiresAt
  });
  batch.create(jobRef, {
    requestId, token, sourceId: str(sourceId, 200), sourceType: str(sourceType, 30),
    leadId: str(leadId, 200), recipient: address, firstName: str(name, 120).split(/\s+/)[0] || address.split('@')[0],
    agent: agent === 'byte' ? 'byte' : 'bit', agentName: str(agentName, 120), status: 'pending', attempts: 0,
    sendAt: Timestamp.fromMillis(Date.now() + FEEDBACK_DELAY_MS), createdAt: FieldValue.serverTimestamp()
  });
  try {
    await batch.commit();
    return true;
  } catch (error) {
    if (ALREADY_EXISTS(error)) return false;
    throw error;
  }
}

async function recordDelivery(db, data) {
  await db.collection('emailDeliveries').add({
    ...data,
    createdAt: FieldValue.serverTimestamp()
  }).catch(error => console.error('[email] could not write delivery log:', error.message));
}

async function loadStoredTemplate(db, id) {
  if (DEFAULT_EMAIL_TEMPLATES[id]) return getEmailTemplate(db, id);
  const snapshot = await db.doc(`emailTemplates/${id}`).get();
  return snapshot.exists ? { id, ...snapshot.data() } : null;
}

async function requireAdmin(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  if ((await callerRole(db, request.auth)) !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an admin can manage email.');
  }
  return db;
}

// One durable lead event owns both sides of the handoff: the visitor gets a
// receipt and the team gets a native alert even if the CRM workflow is missing.
export const sendLeadLifecycleEmails = onDocumentCreated(
  { document: 'leads/{leadId}', secrets: [POSTMARK_SERVER_TOKEN], maxInstances: 10 },
  async event => {
    const lead = event.data?.data();
    if (!lead) return;
    const db = getFirestore();
    const env = emailEnvironment();
    const leadId = event.params.leadId;
    const sourceLabel = lead.source === 'byte_voice'
      ? (lead.voice?.receivingAgent?.agentName || EMAIL_SOURCE_LABELS.byte_voice)
      : EMAIL_SOURCE_LABELS[lead.source] || lead.source || 'BiteSites';
    const services = emailServiceNames(lead.services, 'Interest not captured');
    const tasks = [];

    const acquisition = lead.acquisition && typeof lead.acquisition === 'object' ? lead.acquisition : {};
    const manual = lead.source === 'outbound' && acquisition.trigger === 'manual_qualification';
    const outboundConversation = lead.source === 'outbound'
      && ['call_answered', 'meeting_booked', 'conversation_started'].includes(acquisition.trigger)
      && Boolean(acquisition.firstConnectedCallId);
    let linkedCall = null;
    if (outboundConversation) {
      const callSnapshot = await db.doc(`calls/${acquisition.firstConnectedCallId}`).get();
      if (callSnapshot.exists) linkedCall = { id: callSnapshot.id, ...callSnapshot.data() };
    }

    // An outbound prospect did not submit an inquiry. Sending the visitor-facing
    // "we received your inquiry" receipt after an internal manual promotion is
    // confusing at best and unsolicited outreach at worst.
    //
    // A booking-page lead is excluded for the opposite reason: they already have
    // a meeting, and `sendMeetingBookedEmails` is sending them the day, time and
    // reference. A second mail inviting them to "schedule a consultation" reads
    // as though the booking did not take.
    if (lead.email && !['outbound', 'booking_page'].includes(lead.source)) {
      tasks.push(sendLifecycleEmail({
        db, templateId: 'lead_received', to: lead.email,
        variables: {
          first_name: str(lead.name, 120).split(/\s+/)[0] || 'there',
          source_label: sourceLabel,
          service_names: services,
          consultation_url: `${env.appUrl}/book`
        },
        tag: 'lead-received', kind: 'lead-received'
      }));
    }

    if (env.admin && manual) {
      const status = acquisition.contactStatus === 'external_contact'
        ? 'Contacted outside BiteSites — no BiteSites call is linked'
        : acquisition.contactStatus === 'not_contacted'
          ? 'No answered BiteSites call; prospect has not been contacted'
          : 'No answered BiteSites call is linked';
      tasks.push(sendLifecycleEmail({
        db, templateId: 'manual_lead_admin', to: env.admin,
        variables: {
          lead_name: lead.name || 'Unknown prospect',
          qualified_by: acquisition.manuallyQualifiedBy || 'a BiteSites team member',
          contact_status: status,
          contact: lead.email || lead.phone || 'No contact captured',
          manual_reason: acquisition.manualReason || 'Not provided',
          manual_notes: acquisition.manualNotes || 'No notes provided',
          service_names: services,
          lead_url: `${env.appUrl}/admin/leads?lead=${encodeURIComponent(leadId)}`
        },
        tag: 'manual-lead-admin', kind: 'manual-lead-admin'
      }));
    } else if (env.admin && outboundConversation) {
      tasks.push(sendLifecycleEmail({
        db, templateId: 'outbound_call_lead_admin', to: env.admin,
        variables: {
          lead_name: lead.name || 'Unknown prospect',
          contact: lead.email || lead.phone || 'No contact captured',
          disposition: readableDisposition(linkedCall?.disposition || acquisition.trigger),
          duration: readableDuration(linkedCall?.durationSec),
          operator: linkedCall?.control?.controller === 'human' || linkedCall?.operator === 'human' ? 'Human-assisted' : 'AI-assisted',
          call_summary: linkedCall?.summary || 'No summary captured yet',
          service_names: services,
          call_url: `${env.appUrl}/admin/outbound?tab=history&call=${encodeURIComponent(acquisition.firstConnectedCallId)}`,
          lead_url: `${env.appUrl}/admin/leads?lead=${encodeURIComponent(leadId)}`
        },
        tag: 'outbound-call-lead-admin', kind: 'outbound-call-lead-admin'
      }));
    } else if (env.admin) {
      tasks.push(sendLifecycleEmail({
        db, templateId: 'new_lead_admin', to: env.admin,
        variables: {
          lead_name: lead.name || 'Unknown visitor', source_label: sourceLabel,
          contact: lead.email || lead.phone || 'No contact captured',
          service_names: services, lead_url: `${env.appUrl}/admin/leads`
        },
        tag: 'new-lead-admin', kind: 'new-lead-admin'
      }));
    }

    const results = await Promise.allSettled(tasks);
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) {
      await createOperationalAlert(db, {
        key: `lead-email:${leadId}`, title: 'Lead email delivery failed',
        message: failed[0].reason?.message || 'One or more lead lifecycle emails failed.',
        component: 'Postmark', reference: leadId, notify: false
      });
    }

    if (lead.email && lead.source === 'bit_chat') {
      await queueFeedbackEmail(db, {
        sourceId: lead.conversationId || leadId,
        sourceType: lead.conversationId ? 'chat' : 'lead',
        leadId, email: lead.email, name: lead.name, agent: 'bit'
      });
    }
    if (lead.email && lead.source === 'byte_voice' && lead.voice?.callId) {
      await queueFeedbackEmail(db, {
        sourceId: lead.voice.callId, sourceType: 'call', leadId,
        email: lead.email, name: lead.name, agent: 'byte',
        agentName: lead.voice.receivingAgent?.agentName
      });
    }
  }
);

// The attendee's booking confirmation. Triggered by the appointment flipping
// to `booked` — the one moment a meeting truly exists — so voice-agent and rep
// bookings alike produce an email that states the real day, time, and
// reference instead of the generic "schedule a consultation" receipt.
export const sendMeetingBookedEmails = onDocumentWritten(
  { document: 'appointments/{appointmentId}', secrets: [POSTMARK_SERVER_TOKEN], maxInstances: 10 },
  async event => {
    const after = event.data?.after?.data();
    if (!after || after.status !== 'booked') return;
    const before = event.data?.before?.data() || {};
    if (before.status === 'booked') return;

    const email = normalizedEmail(after.attendee?.email);
    if (!EMAIL_PATTERN.test(email)) return;

    const db = getFirestore();
    const ref = event.data.after.ref;

    // Claim before sending: trigger retries and echo writes must never mean a
    // second confirmation in the attendee's inbox.
    //
    // The claim reads the document fresh rather than trusting `after`. The
    // write that flips a booking to 'booked' happens before Google is asked for
    // a Meet link, so `after` never carries one — and a video consultation
    // confirmed without a way to join it is not a confirmation.
    //
    // Waiting is bounded on both sides. The Google sync writes the link (or a
    // failure) moments later and re-fires this trigger; if neither ever lands,
    // `MEET_WAIT_MS` gives up and sends the phone-shaped confirmation rather
    // than leaving someone with no confirmation at all.
    const claim = await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (snapshot.get('confirmationEmailAt')) return null;

      const meetUrl = str(snapshot.get('googleMeetUrl'), 500);
      const bookedAtMs = snapshot.get('bookedAt')?.toMillis?.() || 0;
      const stillWaiting = snapshot.get('googleSyncState') === 'pending'
        && (!bookedAtMs || Date.now() - bookedAtMs < MEET_WAIT_MS);
      if (!meetUrl && stillWaiting) return null;

      tx.set(ref, { confirmationEmailAt: FieldValue.serverTimestamp() }, { merge: true });
      return { meetUrl };
    });
    if (!claim) return;

    const settings = await loadCalendarSettings(db, after.accountId).catch(() => null);
    const startMs = after.startAt?.toMillis?.() || 0;
    const meetingTime = startMs
      ? describeSlotForSpeech(startMs, after.timezone || settings?.timezone || 'America/New_York')
      : 'the time you agreed on the call';

    try {
      await sendLifecycleEmail({
        db, templateId: claim.meetUrl ? 'meeting_booked_video' : 'meeting_booked', to: email,
        variables: {
          first_name: str(after.attendee?.name, 120).split(/\s+/)[0] || 'there',
          meeting_title: settings?.meetingTitle || 'BiteSites strategy call',
          host_name: settings?.hostName || 'BiteSites specialist',
          meeting_time: meetingTime,
          meet_url: claim.meetUrl,
          confirmation_ref: str(after.confirmationRef, 40) || '—'
        },
        tag: 'meeting-booked', kind: 'meeting-booked'
      });
    } catch (error) {
      await createOperationalAlert(db, {
        key: `meeting-email:${event.params.appointmentId}`,
        title: 'Meeting confirmation email failed',
        message: error.message, component: 'Postmark',
        reference: event.params.appointmentId, notify: false
      });
    }
  }
);

export const getServicePricing = onCall(
  { enforceAppCheck: true, maxInstances: 20 },
  request => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Create an account or sign in to see pricing.');
    return { pricing: SERVICE_PRICING };
  }
);

// A profile is the durable account-created event for both password and Google
// sign-ups. Customer confirmation is sent through Firebase Auth at sign-up;
// this trigger is only for the internal new-account notification.
export const sendAccountCreatedEmails = onDocumentCreated(
  { document: 'users/{uid}', secrets: [POSTMARK_SERVER_TOKEN], maxInstances: 10 },
  async event => {
    const profile = event.data?.data();
    if (!profile?.email) return;

    const db = getFirestore();
    const env = emailEnvironment();
    if (!env.admin) return;
    try {
      await sendLifecycleEmail({
        db, templateId: 'new_account_admin', to: env.admin,
        variables: {
          first_name: profile.displayName || str(profile.email, 200).split('@')[0] || 'there',
          email: profile.email,
          company: profile.company || '—',
          admin_url: `${env.appUrl}/admin/users`
        },
        tag: 'new-account-admin', kind: 'new-account-admin'
      });
    } catch (error) {
      console.error('[email] account-created send failed:', error.message);
      await createOperationalAlert(db, {
        key: `new-account-email:${event.params.uid}`, title: 'New-account notice failed',
        message: error.message, component: 'Postmark', reference: event.params.uid, notify: false
      });
    }
  }
);

// Public by design, but response and timing do not reveal whether the email has
// an account. App Check plus the per-address cooldown prevents it becoming a
// free mail relay or an inbox flooding endpoint.
export const requestPasswordReset = onCall(
  { enforceAppCheck: true, secrets: [POSTMARK_SERVER_TOKEN], maxInstances: 10 },
  async request => {
    const email = str(request.data?.email, 200).toLowerCase();
    const generic = { ok: true, message: 'If that address has an account, a reset link is on its way.' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return generic;

    const db = getFirestore();
    const key = createHash('sha256').update(email).digest('hex');
    const rateRef = db.doc(`emailRateLimits/password-${key}`);
    const now = Date.now();
    const allowed = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(rateRef);
      const previous = snapshot.data()?.lastSentAt?.toMillis?.() || 0;
      if (now - previous < 10 * 60 * 1000) return false;
      transaction.set(rateRef, { lastSentAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!allowed) return generic;

    const auth = getAuth();
    const user = await auth.getUserByEmail(email).catch(() => null);
    if (!user || user.disabled) return generic;

    if ((await emailPreference(db, email)).transactionalBlocked) {
      await recordDelivery(db, {
        templateId: 'password_reset', kind: 'password-reset', recipientCount: 0,
        uid: user.uid, status: 'suppressed', reason: 'transactional-blocked'
      });
      return generic;
    }

    const env = emailEnvironment();
    const resetUrl = await auth.generatePasswordResetLink(email, { url: `${env.appUrl}/#pricing` });
    const template = await getEmailTemplate(db, 'password_reset');
    try {
      const result = await sendPostmark(POSTMARK_SERVER_TOKEN.value(), buildMessage({
        from: env.from,
        to: email,
        template,
        variables: { first_name: firstName(user), reset_url: resetUrl },
        stream: env.transactionalStream,
        tag: 'password-reset'
      }));
      await recordDelivery(db, {
        templateId: 'password_reset', kind: 'password-reset', recipientCount: 1,
        uid: user.uid, status: 'sent', postmark: [result.MessageID].filter(Boolean)
      });
    } catch (error) {
      console.error('[email] password reset send failed:', error.message);
      await recordDelivery(db, {
        templateId: 'password_reset', kind: 'password-reset', recipientCount: 1,
        uid: user.uid, status: 'failed', error: str(error.message, 500)
      });
      // Keep the public response generic even when delivery fails.
    }
    return generic;
  }
);

export const resendAccountConfirmation = onCall(
  { enforceAppCheck: true, secrets: [POSTMARK_SERVER_TOKEN], maxInstances: 10 },
  async request => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
    const db = getFirestore();
    const auth = getAuth();
    const user = await auth.getUser(request.auth.uid);
    if (!user.email) throw new HttpsError('failed-precondition', 'This account has no email address.');
    if (user.emailVerified) return { ok: true, alreadyVerified: true };
    if ((await emailPreference(db, user.email)).transactionalBlocked) {
      throw new HttpsError('failed-precondition', 'Email delivery to this address is blocked. Please contact BiteSites support.');
    }
    try {
      const env = emailEnvironment();
      const verifyUrl = await auth.generateEmailVerificationLink(user.email, { url: `${env.appUrl}/#pricing` });
      const template = await getEmailTemplate(db, 'welcome');
      const result = await sendPostmark(POSTMARK_SERVER_TOKEN.value(), buildMessage({
        from: env.from, to: user.email, template,
        variables: { first_name: firstName(user), verify_url: verifyUrl, pricing_url: `${env.appUrl}/#pricing` },
        stream: env.transactionalStream, tag: 'account-confirmation'
      }));
      await recordDelivery(db, {
        templateId: 'welcome', kind: 'account-confirmation', recipientCount: 1,
        uid: user.uid, status: 'sent', postmark: [result.MessageID].filter(Boolean)
      });
      return { ok: true, alreadyVerified: false };
    } catch (error) {
      const message = String(error?.message || '');
      console.error('[email] account confirmation resend failed:', message);
      await recordDelivery(db, {
        templateId: 'welcome', kind: 'account-confirmation', recipientCount: 1,
        uid: user.uid, status: 'failed', error: str(message, 500)
      });
      if (error?.code === 'auth/internal-error' && message.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
        throw new HttpsError('resource-exhausted', 'Please wait a few minutes before requesting another confirmation email.');
      }
      if (message.includes('pending approval')) {
        throw new HttpsError('failed-precondition', 'Confirmation email is temporarily unavailable. Please contact BiteSites support.');
      }
      throw new HttpsError('internal', 'We could not send your confirmation email just now. Please try again shortly.');
    }
  }
);

export const listEmailTemplates = onCall(
  { enforceAppCheck: true, maxInstances: 5 },
  async request => {
    const db = await requireAdmin(request);
    await seedEmailTemplates(db);
    const snapshot = await db.collection('emailTemplates').orderBy('name').limit(100).get();
    return { templates: snapshot.docs.map(doc => {
      const { createdAt, updatedAt, updatedBy, ...template } = doc.data();
      return { id: doc.id, ...template };
    }) };
  }
);

export const saveEmailTemplate = onCall(
  { enforceAppCheck: true, maxInstances: 5 },
  async request => {
    const db = await requireAdmin(request);
    const id = str(request.data?.id, 80).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const name = str(request.data?.name, 120);
    const description = str(request.data?.description, 300);
    const subject = str(request.data?.subject, 2000);
    const html = typeof request.data?.html === 'string' ? request.data.html.trim().slice(0, 200000) : '';
    const text = typeof request.data?.text === 'string' ? request.data.text.trim().slice(0, 50000) : '';
    const category = request.data?.category === 'broadcast' ? 'broadcast' : 'transactional';
    if (!id || !name || !subject || !html || !text) {
      throw new HttpsError('invalid-argument', 'Name, subject, HTML and plain text are required.');
    }
    await db.doc(`emailTemplates/${id}`).set({
      name, description, subject, html, text, category,
      system: Boolean(DEFAULT_EMAIL_TEMPLATES[id]),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: request.auth.uid
    }, { merge: true });
    return { ok: true, id };
  }
);

export const deleteEmailTemplate = onCall(
  { enforceAppCheck: true, maxInstances: 5 },
  async request => {
    const db = await requireAdmin(request);
    const id = str(request.data?.id, 80);
    if (DEFAULT_EMAIL_TEMPLATES[id]) throw new HttpsError('failed-precondition', 'System templates cannot be deleted.');
    await db.doc(`emailTemplates/${id}`).delete();
    return { ok: true };
  }
);

export const sendAdminEmail = onCall(
  { enforceAppCheck: true, secrets: [POSTMARK_SERVER_TOKEN], timeoutSeconds: 60, maxInstances: 5 },
  async request => {
    const db = await requireAdmin(request);
    const templateId = str(request.data?.templateId, 80);
    const recipients = Array.from(new Set((Array.isArray(request.data?.recipients) ? request.data.recipients : [])
      .map(value => str(value, 200).toLowerCase())
      .filter(value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))));
    if (!recipients.length || recipients.length > 50) {
      throw new HttpsError('invalid-argument', 'Choose between 1 and 50 valid recipients.');
    }
    const template = await loadStoredTemplate(db, templateId);
    if (!template) throw new HttpsError('not-found', 'That email template no longer exists.');
    const variables = request.data?.variables && typeof request.data.variables === 'object'
      ? Object.fromEntries(Object.entries(request.data.variables).slice(0, 30).map(([key, value]) => [str(key, 60), str(value, 5000)]))
      : {};
    const env = emailEnvironment();
    const stream = template.category === 'broadcast' ? env.broadcastStream : env.transactionalStream;
    const prepared = await Promise.all(recipients.map(async email => {
      const preference = await emailPreference(db, email);
      if (preference.transactionalBlocked || (template.category === 'broadcast' && !preference.broadcasts)) {
        return null;
      }
      const links = template.category === 'broadcast' ? await createPreferenceLinks(db, email, env) : null;
      let message = buildMessage({
        from: env.from, to: email, template,
        variables: {
          first_name: email.split('@')[0], email,
          ...(links ? { preference_url: links.preferenceUrl } : {}),
          ...variables
        },
        stream, tag: `admin-${templateId}`.slice(0, 1000)
      });
      if (links) message = addBroadcastUnsubscribe(message, links.preferenceUrl, links.oneClickUrl);
      return message;
    }));
    const messages = prepared.filter(Boolean);
    const skipped = recipients.length - messages.length;
    if (!messages.length) {
      return { ok: true, sent: 0, skipped, message: 'Every selected recipient is suppressed or opted out.' };
    }
    try {
      const result = await sendPostmark(POSTMARK_SERVER_TOKEN.value(), messages);
      await recordDelivery(db, {
        templateId, kind: 'admin-send', recipientCount: messages.length, skipped,
        sentBy: request.auth.uid, status: 'sent',
        postmark: (Array.isArray(result) ? result : [result]).map(item => item.MessageID || '').filter(Boolean)
      });
      return { ok: true, sent: messages.length, skipped };
    } catch (error) {
      await recordDelivery(db, {
        templateId, kind: 'admin-send', recipientCount: messages.length, skipped,
        sentBy: request.auth.uid, status: 'failed', error: str(error.message, 500)
      });
      throw new HttpsError('internal', str(error.message, 300));
    }
  }
);

export const sendLeadEmail = onCall(
  { enforceAppCheck: true, secrets: [POSTMARK_SERVER_TOKEN], timeoutSeconds: 30, maxInstances: 5 },
  async request => {
    const db = await requireAdmin(request);
    const email = str(request.data?.email, 200).toLowerCase();
    const firstNameValue = str(request.data?.firstName, 120) || 'there';
    const businessName = str(request.data?.businessName, 200);
    const subject = str(request.data?.subject, 200);
    const headline = str(request.data?.headline, 160) || subject;
    const message = typeof request.data?.message === 'string'
      ? request.data.message.trim().slice(0, 10000)
      : '';
    const actionType = ['none', 'confirmed', 'self_schedule'].includes(request.data?.actionType)
      ? request.data.actionType
      : 'none';
    const actionUrl = str(request.data?.actionUrl, 2000);
    const meetingTime = str(request.data?.meetingTime, 300);
    const meetingAt = str(request.data?.meetingAt, 100);
    const rawLeadId = str(request.data?.leadId, 200);
    const leadId = rawLeadId.includes('/') ? '' : rawLeadId;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpsError('invalid-argument', 'Enter a valid recipient email address.');
    }
    if (!subject || !message) {
      throw new HttpsError('invalid-argument', 'A subject and message are required.');
    }
    if (actionType !== 'none') {
      let parsed;
      try { parsed = new URL(actionUrl); } catch { /* handled below */ }
      if (!parsed || parsed.protocol !== 'https:') {
        throw new HttpsError('invalid-argument', 'The meeting or booking link must be a secure https:// URL.');
      }
    }
    if (actionType === 'confirmed' && !meetingTime) {
      throw new HttpsError('invalid-argument', 'Add the agreed meeting time before sending.');
    }
    const meetingDate = meetingAt ? new Date(meetingAt) : null;
    if (actionType === 'confirmed' && (!meetingDate || Number.isNaN(meetingDate.getTime()))) {
      throw new HttpsError('invalid-argument', 'The agreed meeting date is invalid.');
    }

    const preference = await emailPreference(db, email);
    if (preference.transactionalBlocked) {
      throw new HttpsError('failed-precondition', 'Email delivery to this address is suppressed.');
    }

    const actionLabel = actionType === 'confirmed' ? 'Join Google Meet'
      : actionType === 'self_schedule' ? 'Choose a meeting time'
        : '';
    const actionNote = actionType === 'confirmed'
      ? 'Keep this email handy—the button above is your meeting link.'
      : actionType === 'self_schedule'
        ? 'The booking page will show the currently available times.'
        : '';
    const template = buildLeadOutreachTemplate({
      withAction: actionType !== 'none',
      withMeetingTime: actionType === 'confirmed'
    });
    const env = emailEnvironment();
    try {
      const result = await sendPostmark(POSTMARK_SERVER_TOKEN.value(), buildMessage({
        from: env.from,
        to: email,
        template,
        variables: {
          first_name: firstNameValue,
          subject_line: subject,
          headline,
          preheader: message.replace(/\s+/g, ' ').slice(0, 140),
          message,
          action_url: actionUrl,
          action_label: actionLabel,
          action_note: actionNote,
          meeting_time: meetingTime
        },
        stream: env.transactionalStream,
        tag: 'admin-lead-follow-up'
      }));

      await recordDelivery(db, {
        templateId: 'lead-follow-up', kind: 'lead-follow-up', recipientCount: 1,
        recipientKey: emailKey(email), leadId: leadId || null, actionType,
        sentBy: request.auth.uid, status: 'sent', postmark: [result.MessageID].filter(Boolean)
      });

      {
        // Delivery has already succeeded at this point. A CRM logging problem
        // must not report the email as failed and tempt the admin to send a
        // duplicate, so this secondary update is deliberately best-effort.
        try {
          let leadRef = leadId ? db.doc(`leads/${leadId}`) : null;
          let leadSnapshot = leadRef ? await leadRef.get() : null;
          if (!leadSnapshot?.exists && !leadId) {
            const matching = await db.collection('leads').where('email', '==', email).limit(1).get();
            leadSnapshot = matching.docs[0] || null;
            leadRef = leadSnapshot?.ref || db.collection('leads').doc();
          }
          if (leadRef) {
            const lead = leadSnapshot?.exists ? leadSnapshot.data() : {};
            const isNewLead = !leadSnapshot?.exists;
            const update = { updatedAt: FieldValue.serverTimestamp() };
            if (!lead.firstResponseAt) update.firstResponseAt = FieldValue.serverTimestamp();
            const nextStatus = actionType === 'confirmed'
              ? 'booked'
              : (!lead.status || lead.status === 'new') ? 'contacted' : '';
            if (nextStatus && lead.status !== nextStatus) {
              update.status = nextStatus;
              update.statusChangedAt = FieldValue.serverTimestamp();
              update[`stageTimestamps.${nextStatus}`] = FieldValue.serverTimestamp();
            }
            if (actionType === 'confirmed') {
              update['appointment.status'] = 'booked';
              update['appointment.scheduledFor'] = Timestamp.fromDate(meetingDate);
            }
            const batch = db.batch();
            if (isNewLead) {
              const createdStatus = nextStatus || 'contacted';
              batch.set(leadRef, {
                name: firstNameValue, email, businessName, source: 'cold_call',
                services: [], preferredContactMethod: 'email', createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(), firstResponseAt: FieldValue.serverTimestamp(),
                status: createdStatus, statusChangedAt: FieldValue.serverTimestamp(),
                stageTimestamps: { [createdStatus]: FieldValue.serverTimestamp() },
                ...(actionType === 'confirmed' ? {
                  appointment: { status: 'booked', scheduledFor: Timestamp.fromDate(meetingDate) }
                } : {})
              });
            } else {
              batch.update(leadRef, update);
            }
            batch.create(leadRef.collection('activities').doc(), {
              type: 'email_sent', subject, actionType,
              ...(meetingDate ? { meetingAt: Timestamp.fromDate(meetingDate) } : {}),
              at: FieldValue.serverTimestamp(), sentBy: request.auth.uid
            });
            await batch.commit();
          }
        } catch (error) {
          console.error('[email] lead follow-up activity could not be recorded:', error.message);
        }
      }
      return { ok: true, sent: 1 };
    } catch (error) {
      await recordDelivery(db, {
        templateId: 'lead-follow-up', kind: 'lead-follow-up', recipientCount: 1,
        recipientKey: emailKey(email), leadId: leadId || null,
        sentBy: request.auth.uid, status: 'failed', error: str(error.message, 500)
      });
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', str(error.message, 300));
    }
  }
);

export const sendQueuedFeedbackEmails = onSchedule(
  { schedule: 'every 15 minutes', secrets: [POSTMARK_SERVER_TOKEN], timeoutSeconds: 120, maxInstances: 1 },
  async () => {
    const db = getFirestore();
    const now = Date.now();
    const snapshot = await db.collection('feedbackEmailJobs').where('status', '==', 'pending').limit(100).get();
    for (const jobDoc of snapshot.docs) {
      const job = jobDoc.data();
      if ((job.sendAt?.toMillis?.() || Infinity) > now) continue;
      const parent = feedbackParent(db, job.sourceType, job.sourceId);
      const parentSnapshot = parent ? await parent.get() : null;
      if (parentSnapshot?.get('feedback.rating')) {
        await jobDoc.ref.set({ status: 'already-rated', completedAt: FieldValue.serverTimestamp() }, { merge: true });
        await db.doc(`feedbackRequests/${job.requestId}`).set({
          status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), reason: 'inline-feedback-received'
        }, { merge: true });
        continue;
      }
      const preference = await emailPreference(db, job.recipient);
      if (!preference.feedback || preference.transactionalBlocked) {
        await jobDoc.ref.set({ status: 'suppressed', completedAt: FieldValue.serverTimestamp() }, { merge: true });
        continue;
      }
      const env = emailEnvironment();
      const links = await createPreferenceLinks(db, job.recipient, env);
      const feedbackUrl = `${env.appUrl}/feedback?token=${encodeURIComponent(job.token)}`;
      try {
        const template = await getEmailTemplate(db, 'conversation_feedback');
        const result = await sendPostmark(POSTMARK_SERVER_TOKEN.value(), buildMessage({
          from: env.from, to: job.recipient, template,
          variables: {
            first_name: job.firstName || 'there', agent_name: job.agentName || (job.agent === 'byte' ? 'Voice AI agent' : 'Bit'),
            feedback_url: feedbackUrl, preference_url: links.preferenceUrl,
            rating_1_url: `${feedbackUrl}&rating=1`, rating_2_url: `${feedbackUrl}&rating=2`,
            rating_3_url: `${feedbackUrl}&rating=3`, rating_4_url: `${feedbackUrl}&rating=4`,
            rating_5_url: `${feedbackUrl}&rating=5`
          },
          stream: env.transactionalStream, tag: 'conversation-feedback'
        }));
        await jobDoc.ref.set({
          status: 'sent', completedAt: FieldValue.serverTimestamp(),
          postmarkMessageId: result.MessageID || '', token: FieldValue.delete()
        }, { merge: true });
        await recordDelivery(db, {
          templateId: 'conversation_feedback', kind: 'conversation-feedback', recipientCount: 1,
          recipientKey: emailKey(job.recipient), status: 'sent',
          postmark: [result.MessageID].filter(Boolean), sourceId: job.sourceId
        });
      } catch (error) {
        const attempts = (job.attempts || 0) + 1;
        await jobDoc.ref.set({
          attempts, status: attempts >= 5 ? 'failed' : 'pending',
          sendAt: Timestamp.fromMillis(now + Math.min(24, 2 ** attempts) * 60 * 60 * 1000),
          error: str(error.message, 500), updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        await recordDelivery(db, {
          templateId: 'conversation_feedback', kind: 'conversation-feedback', recipientCount: 1,
          recipientKey: emailKey(job.recipient), status: 'failed', error: str(error.message, 500)
        });
        await createOperationalAlert(db, {
          key: `feedback-email:${jobDoc.id}`, title: 'Feedback email delivery failed',
          message: error.message, component: 'Postmark', reference: jobDoc.id, notify: false
        });
      }
    }
  }
);

const feedbackParent = (db, sourceType, sourceId) => {
  if (sourceType === 'chat') return db.doc(`chats/${sourceId}`);
  if (sourceType === 'call') return db.doc(`calls/${sourceId}`);
  if (sourceType === 'lead') return db.doc(`leads/${sourceId}`);
  return null;
};

export const getConversationFeedback = onCall(
  { enforceAppCheck: true, maxInstances: 10 },
  async request => {
    const token = str(request.data?.token, 200);
    if (!token) throw new HttpsError('invalid-argument', 'That feedback link is incomplete.');
    const snapshot = await getFirestore().doc(`feedbackRequests/${tokenKey(token)}`).get();
    if (!snapshot.exists) throw new HttpsError('not-found', 'That feedback link is invalid or has expired.');
    const data = snapshot.data();
    return {
      agent: data.agent === 'byte' ? 'Byte' : 'Bit',
      submitted: data.status === 'submitted',
      expired: (data.expiresAt?.toMillis?.() || 0) < Date.now()
    };
  }
);

export const submitConversationFeedback = onCall(
  { enforceAppCheck: true, secrets: [POSTMARK_SERVER_TOKEN], maxInstances: 10 },
  async request => {
    const rating = Number(request.data?.rating);
    const comment = str(request.data?.comment, 2000);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpsError('invalid-argument', 'Choose a rating from 1 to 5.');
    }
    const db = getFirestore();
    const token = str(request.data?.token, 200);
    let sourceType = str(request.data?.sourceType, 30);
    let sourceId = str(request.data?.sourceId, 200);
    let agent = request.data?.agent === 'byte' ? 'byte' : 'bit';
    let feedbackId = '';
    let requestRef = null;

    if (token) {
      feedbackId = tokenKey(token);
      requestRef = db.doc(`feedbackRequests/${feedbackId}`);
      const tokenSnapshot = await requestRef.get();
      if (!tokenSnapshot.exists) throw new HttpsError('not-found', 'That feedback link is invalid or has expired.');
      const tokenData = tokenSnapshot.data();
      if ((tokenData.expiresAt?.toMillis?.() || 0) < Date.now()) throw new HttpsError('deadline-exceeded', 'That feedback link has expired.');
      sourceType = tokenData.sourceType;
      sourceId = tokenData.sourceId;
      agent = tokenData.agent;
    } else {
      if (!sourceId || !['chat', 'call', 'lead'].includes(sourceType)) {
        throw new HttpsError('invalid-argument', 'The conversation reference is missing.');
      }
      const parent = feedbackParent(db, sourceType, sourceId);
      const parentSnapshot = await parent.get();
      if (!parentSnapshot.exists) throw new HttpsError('not-found', 'That conversation is no longer available.');
      agent = sourceType === 'call' || parentSnapshot.get('source') === 'byte_voice' ? 'byte' : 'bit';
      feedbackId = `inline_${sourceType}_${sourceId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 500);
    }

    const feedbackRef = db.doc(`conversationFeedback/${feedbackId}`);
    const parentRef = feedbackParent(db, sourceType, sourceId);
    let alreadySubmitted = false;
    await db.runTransaction(async tx => {
      const previous = await tx.get(feedbackRef);
      const parentSnapshot = parentRef ? await tx.get(parentRef) : null;
      if (previous.exists || parentSnapshot?.get('feedback.rating')) {
        alreadySubmitted = true;
        if (requestRef) tx.set(requestRef, { status: 'submitted', submittedAt: FieldValue.serverTimestamp() }, { merge: true });
        return;
      }
      tx.create(feedbackRef, {
        rating, comment, agent: agent === 'byte' ? 'byte' : 'bit', sourceType, sourceId,
        channel: token ? 'email' : 'inline', createdAt: FieldValue.serverTimestamp()
      });
      if (requestRef) tx.set(requestRef, { status: 'submitted', submittedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (parentRef) tx.set(parentRef, {
        feedback: { rating, comment, channel: token ? 'email' : 'inline', at: FieldValue.serverTimestamp() }
      }, { merge: true });
    });

    if (!alreadySubmitted && rating <= 2) {
      await createOperationalAlert(db, {
        key: `low-feedback:${feedbackId}`, title: `Low ${agent === 'byte' ? 'Byte' : 'Bit'} rating received`,
        message: comment || `A visitor rated the conversation ${rating} out of 5 without a comment.`,
        component: 'Conversation feedback', reference: `${sourceType}/${sourceId}`
      });
    }
    return { ok: true, alreadySubmitted };
  }
);

async function preferenceTokenData(db, token) {
  const snapshot = await db.doc(`emailPreferenceTokens/${tokenKey(token)}`).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if ((data.expiresAt?.toMillis?.() || 0) < Date.now()) return null;
  return data;
}

const maskedEmail = email => {
  const [local, domain] = normalizedEmail(email).split('@');
  return local && domain ? `${local.slice(0, 2)}${local.length > 2 ? '…' : ''}@${domain}` : '';
};

export const getEmailPreferences = onCall(
  { enforceAppCheck: true, maxInstances: 10 },
  async request => {
    const db = getFirestore();
    const token = str(request.data?.token, 200);
    const tokenData = await preferenceTokenData(db, token);
    if (!tokenData) throw new HttpsError('not-found', 'That preference link is invalid or has expired.');
    const preference = await emailPreference(db, tokenData.email);
    return { email: maskedEmail(tokenData.email), broadcasts: preference.broadcasts, feedback: preference.feedback };
  }
);

export const updateEmailPreferences = onCall(
  { enforceAppCheck: true, maxInstances: 10 },
  async request => {
    const db = getFirestore();
    const token = str(request.data?.token, 200);
    const tokenData = await preferenceTokenData(db, token);
    if (!tokenData) throw new HttpsError('not-found', 'That preference link is invalid or has expired.');
    const broadcasts = request.data?.broadcasts !== false;
    const feedback = request.data?.feedback !== false;
    await db.doc(`emailPreferences/${tokenData.emailKey}`).set({
      email: tokenData.email, broadcasts, feedback, updatedAt: FieldValue.serverTimestamp(), source: 'preference-page'
    }, { merge: true });
    return { ok: true, broadcasts, feedback };
  }
);

// RFC 8058 one-click unsubscribe endpoint used by mailbox providers. A GET is
// deliberately a no-op because security scanners commonly visit links.
export const unsubscribeEmail = onRequest(
  { maxInstances: 10 },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).send('POST required');
      return;
    }
    const db = getFirestore();
    const tokenData = await preferenceTokenData(db, str(req.query?.token, 200));
    if (!tokenData) { res.status(404).send('Invalid or expired token'); return; }
    await db.doc(`emailPreferences/${tokenData.emailKey}`).set({
      email: tokenData.email, broadcasts: false,
      updatedAt: FieldValue.serverTimestamp(), source: 'one-click-unsubscribe'
    }, { merge: true });
    res.status(200).send('Unsubscribed');
  }
);

export const recordPostmarkEvent = onRequest(
  { secrets: [POSTMARK_WEBHOOK_SECRET], maxInstances: 10 },
  async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method-not-allowed' }); return; }
    const expected = str(POSTMARK_WEBHOOK_SECRET.value(), 200);
    const authorization = str(req.get('authorization'), 500);
    let basicPassword = '';
    if (authorization.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        basicPassword = decoded.slice(decoded.indexOf(':') + 1);
      } catch { /* malformed credentials are rejected below */ }
    }
    const provided = str(req.get('x-webhook-secret'), 200) || str(basicPassword, 200);
    if (expected.length < 16 || expected === 'unset') { res.status(503).json({ error: 'not-configured' }); return; }
    if (provided !== expected) { res.status(401).json({ error: 'unauthorised' }); return; }
    const event = req.body && typeof req.body === 'object' ? req.body : {};
    const recordType = str(event.RecordType, 80).toLowerCase();
    const messageId = str(event.MessageID, 200);
    const recipient = normalizedEmail(event.Recipient || event.Email);
    const eventId = createHash('sha256').update(JSON.stringify({
      recordType, messageId, recipient, at: event.DeliveredAt || event.BouncedAt || event.ReceivedAt || event.Date || '',
      type: event.Type || event.TypeCode || ''
    })).digest('hex');
    const db = getFirestore();
    await db.doc(`emailDeliveryEvents/${eventId}`).set({
      recordType, messageId, recipientKey: recipient ? emailKey(recipient) : '',
      type: str(event.Type || event.TypeCode, 100), description: str(event.Description || event.Details, 1000),
      inactive: Boolean(event.Inactive), receivedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (messageId) {
      await db.doc(`emailMessageStatus/${messageId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300)}`).set({
        messageId, status: recordType, recipientKey: recipient ? emailKey(recipient) : '',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (recipient) {
      const preferenceUpdate = { email: recipient, updatedAt: FieldValue.serverTimestamp(), source: `postmark-${recordType}` };
      if (recordType === 'spamcomplaint') preferenceUpdate.broadcasts = false;
      if (recordType === 'subscriptionchange') {
        preferenceUpdate.broadcasts = typeof event.SuppressSending === 'boolean' ? !event.SuppressSending : false;
      }
      if (recordType === 'spamcomplaint' || (recordType === 'bounce' && event.Inactive)) preferenceUpdate.transactionalBlocked = true;
      if ('broadcasts' in preferenceUpdate || 'transactionalBlocked' in preferenceUpdate) {
        await db.doc(`emailPreferences/${emailKey(recipient)}`).set(preferenceUpdate, { merge: true });
      }
    }
    res.status(200).json({ ok: true });
  }
);

export const monitorOperations = onSchedule(
  { schedule: 'every 15 minutes', secrets: [POSTMARK_SERVER_TOKEN], timeoutSeconds: 60, maxInstances: 1 },
  async () => {
    const db = getFirestore();
    const health = await db.doc('systemHealth/voice-poll').get();
    const lastRun = health.get('lastRunAt')?.toMillis?.() || 0;
    if (!lastRun || Date.now() - lastRun > 20 * 60 * 1000) {
      await createOperationalAlert(db, {
        key: 'voice-poll-stale', title: 'Voice AI call import has stopped reporting',
        message: lastRun
          ? 'The voice-call poll heartbeat is more than 20 minutes old.'
          : 'No voice-call poll heartbeat has been recorded.',
        component: 'GoHighLevel voice import', reference: lastRun ? new Date(lastRun).toISOString() : 'missing heartbeat'
      });
    }
    const recent = await db.collection('emailDeliveries').orderBy('createdAt', 'desc').limit(100).get();
    const cutoff = Date.now() - 60 * 60 * 1000;
    const failures = recent.docs.filter(doc => doc.get('status') === 'failed' && (doc.get('createdAt')?.toMillis?.() || 0) >= cutoff);
    if (failures.length >= 3) {
      await createOperationalAlert(db, {
        key: 'postmark-repeated-failures', title: 'Repeated Postmark failures',
        message: `${failures.length} email sends failed during the last hour.`,
        component: 'Postmark', reference: failures[0].id
      });
    }
    for (const collectionName of ['feedbackRequests', 'emailPreferenceTokens']) {
      const expired = await db.collection(collectionName)
        .where('expiresAt', '<=', Timestamp.now()).limit(200).get();
      if (!expired.empty) {
        const batch = db.batch();
        expired.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
    }
  }
);

// ---------------------------------------------------------------------------

// Fine Line Group CRM dashboard — read-only HighLevel feed for /admin/crm.
export { getFineLineCrm } from './flg-crm.js';
// Daily roll-up of FLG commission fields into the financeIncome ledger.
export { syncFineLineCommissions } from './flg-commission-sync.js';

export {
  // Configuration and capability reporting.
  getOutboundConfig,

  // Lead discovery.
  createLeadDiscoveryJob,
  runLeadDiscoveryJob,
  pauseLeadDiscoveryJob,
  cancelLeadDiscoveryJob,
  discoveryWorker,

  // Prospects.
  importProspectCsv,
  resolveProspectDuplicate,
  promoteProspectToLead,

  // Campaigns.
  createOutboundCampaign,
  updateOutboundCampaign,
  startOutboundCampaign,
  pauseOutboundCampaign,
  resumeOutboundCampaign,
  cancelOutboundCampaign,
  importOutboundTargets,

  // Research.
  researchOutboundContact,
  approveLeadResearch,
  prepareTargetForDialing,

  // Server-owned AI-voice consent evidence and grant ledger.
  createConsentEvidenceCandidateCall,
  issueConsentGrantCall,
  revokeConsentGrantCall,

  // Campaign safety circuit breaker.
  listCampaignIncidentsCall,
  resolveCampaignIncidentCall,

  // Dialing.
  startPowerDialerSession,
  startParallelDialerSession,
  dialNextTargets,
  heartbeatDialerSession,
  stopDialerSessionCall,
  submitCallDisposition,
  moveTargetToCallLater,
  markTargetDoNotCall,

  // Provider webhooks and scheduled maintenance.
  recordOutboundCallEvent,
  reconcileOutbound,
  runAICampaigns,
  outboundNightlyMaintenance
} from './outbound-api.js';
// Role management — the only place a role may change from the browser
// ---------------------------------------------------------------------------
//
// A role is mirrored in two places:
//
//   * `roles/{uid}` — the authoritative document.
//   * a `role` custom claim — bootstrap/cache for claim-aware services.
//
// Revocation keeps a role-document tombstone. Deleting the document would make
// an already-issued stale claim the fallback until its token expires.
//
// So the browser no longer writes `roles/{uid}` at all (rules deny it outright);
// it calls this instead, and this is the only client-reachable path that can
// change a role. The authoritative document is written first so a partial
// failure always leaves the narrower server-side decision in force.

const ASSIGNABLE_ROLES = ['admin', 'client', 'outbound_rep', 'outbound_manager'];

// The caller's own role, resolved the same way firestore.rules resolves it.
// An existing server-owned role document is authoritative so a stale elevated
// token cannot keep administering users after a downgrade or revoke.
async function callerRole(db, auth) {
  if (!auth?.uid) return '';
  const snapshot = await db.doc(`roles/${auth.uid}`).get();
  if (snapshot.exists) return snapshot.get('role') || '';
  return auth?.token?.role || '';
}

export const setUserRole = onCall(
  { enforceAppCheck: true, secrets: [POSTMARK_SERVER_TOKEN], maxInstances: 5 },
  async request => {
    const db = getFirestore();
    const auth = getAuth();

    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in first.');
    }
    if ((await callerRole(db, request.auth)) !== 'admin') {
      throw new HttpsError('permission-denied', 'Only an admin can change a role.');
    }

    const uid = str(request.data?.uid, 128);
    const role = str(request.data?.role, 20);
    if (!uid) throw new HttpsError('invalid-argument', 'A uid is required.');
    if (role !== 'none' && !ASSIGNABLE_ROLES.includes(role)) {
      throw new HttpsError('invalid-argument', `Role must be one of ${ASSIGNABLE_ROLES.join(', ')} or none.`);
    }
    const accountIds = normalizeAccountScope(request.data?.accountIds);
    if (['outbound_rep', 'outbound_manager'].includes(role) && !accountIds.length) {
      throw new HttpsError('invalid-argument', 'Assign at least one seller account to an outbound role.');
    }

    // Guard rail, not a security control: an admin revoking themselves is
    // almost always a misclick, and the last one to do it locks everybody out
    // of the console. `npm run role` remains the deliberate way out.
    if (uid === request.auth.uid && role !== 'admin') {
      throw new HttpsError(
        'failed-precondition',
        'You cannot change your own admin access here. Use `npm run role` if you mean it.'
      );
    }

    // Confirms the account exists before writing a role document about it.
    const target = await auth.getUser(uid).catch(() => null);
    if (!target) throw new HttpsError('not-found', 'No account with that uid.');

    if (role === 'none') {
      const preservedClaims = { ...(target.customClaims || {}) };
      delete preservedClaims.role;
      delete preservedClaims.accountIds;
      // Keep an authoritative tombstone before touching Auth. Deleting this
      // document would make the already-issued token's stale role claim the
      // fallback again until that token expires.
      await db.doc(`roles/${uid}`).set({
        role: 'revoked', accountIds: [], email: target.email || '',
        revokedAt: FieldValue.serverTimestamp(), revokedBy: request.auth.uid
      });
      await auth.setCustomUserClaims(uid, Object.keys(preservedClaims).length ? preservedClaims : null);
      // The stored tombstone is the immediate boundary; token revocation is a
      // second layer for services that inspect claims outside Firestore.
      await auth.revokeRefreshTokens(uid);
      await db.doc(`users/${uid}`).set(
        { status: 'pending', updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      if (target.email) {
        await sendLifecycleEmail({
          db, templateId: 'access_revoked', to: target.email,
          variables: { first_name: firstName(target), support_email: emailEnvironment().admin },
          tag: 'access-revoked', kind: 'access-revoked'
        }).catch(error => createOperationalAlert(db, {
          key: `access-revoked-email:${uid}`, title: 'Access removal email failed',
          message: error.message, component: 'Postmark', reference: uid, notify: false
        }));
      }
      console.log(`[roles] ${request.auth.token?.email || request.auth.uid} revoked ${target.email}`);
      return { uid, role: '', email: target.email || '' };
    }

    const nextClaims = { ...(target.customClaims || {}), role };
    delete nextClaims.accountIds;
    if (['outbound_rep', 'outbound_manager'].includes(role)) nextClaims.accountIds = accountIds;
    // Write the authoritative document first. Promotions remain blocked by the
    // old document until this succeeds; downgrades take effect before a stale
    // elevated claim can be observed.
    await db.doc(`roles/${uid}`).set({
      role,
      accountIds: ['outbound_rep', 'outbound_manager'].includes(role) ? accountIds : [],
      email: target.email || '',
      grantedAt: FieldValue.serverTimestamp(),
      grantedBy: request.auth.uid
    });
    await auth.setCustomUserClaims(uid, nextClaims);
    // A promotion has to reach the token too. Without this, a client promoted
    // to admin keeps a stale claim saying "client" until their token expires.
    await auth.revokeRefreshTokens(uid);
    await db.doc(`users/${uid}`).set(
      { status: 'approved', updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    if (target.email) {
      await sendLifecycleEmail({
        db, templateId: 'access_granted', to: target.email,
        variables: {
          first_name: firstName(target),
          role_label: role === 'admin' ? 'administrator'
            : role === 'outbound_manager' ? 'outbound manager'
              : role === 'outbound_rep' ? 'outbound representative' : 'client',
          sign_in_url: role === 'admin' ? `${emailEnvironment().appUrl}/admin`
            : ['outbound_manager', 'outbound_rep'].includes(role)
              ? `${emailEnvironment().appUrl}/admin/outbound`
              : `${emailEnvironment().appUrl}/#pricing`
        },
        tag: 'access-granted', kind: 'access-granted'
      }).catch(error => createOperationalAlert(db, {
        key: `access-granted-email:${uid}`, title: 'Access approval email failed',
        message: error.message, component: 'Postmark', reference: uid, notify: false
      }));
    }
    console.log(`[roles] ${request.auth.token?.email || request.auth.uid} granted ${role} to ${target.email}`);
    return {
      uid, role, accountIds: ['outbound_rep', 'outbound_manager'].includes(role) ? accountIds : [],
      email: target.email || ''
    };
  }
);

// ---------------------------------------------------------------------------
// Outbound calls — lead discovery, prospects, campaigns, dialers, webhooks.
//
// Re-exported rather than defined here. `index.js` is already the largest file
// in the codebase and the outbound feature is ~10 modules on its own; keeping
// its callables in outbound-api.js means a change to the dialer cannot break
// the lead sync sitting above it. Firebase only deploys what this file exports,
// so the re-export is what makes them real functions.
// ---------------------------------------------------------------------------
