// The call brief: what we know about this business, and where each fact came
// from.
//
// The hard rule is §27's: never invent a fact. Everything in `verifiedFacts`
// carries a source id that resolves to an entry in `sources`; anything the
// system merely suspects goes in `hypotheses`, which the brief renders
// differently and the AI prompt is told not to assert. A calling agent that
// states an unsourced "fact" about someone's business is the failure mode this
// whole file exists to prevent.
//
// Sources are tried cheapest-and-most-trustworthy first (§27):
//   1. what BiteSites already stores about the contact,
//   2. its own activity and call history,
//   3. the GoHighLevel contact record, if one exists,
//   4. the company's own website,
//   5. an approved external provider.
//
// Only (1)–(3) are implemented as live lookups. (4) fetches the site's own
// pages and reads what they say; the marketing-signal detection ported from the
// Watcher pipeline's `_fingerprint.py` lives here because "this business has no
// analytics and a DIY site builder" is a fact about their marketing that BiteSites
// can verify from the page source and is the actual reason to call them. (5) is
// deliberately a stub — no external enrichment provider has been evaluated
// against its current API and terms, and §27 forbids integrating one blind.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { clean, normalizeDomain } from './prospect-normalization.js';

export const RESEARCH_TTL_DAYS = 14;
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 600_000;

/** Deterministic, validated key so a lead and a prospect can never collide. */
export function contactKey({ contactType, leadId = '', prospectId = '' }) {
  if (contactType === 'lead' && leadId) return `lead_${String(leadId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180)}`;
  if (contactType === 'prospect' && prospectId) return `prospect_${String(prospectId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180)}`;
  throw new Error('A research key needs a contactType and the matching id');
}

const factId = (text, source) => createHash('sha256').update(`${source}|${text}`).digest('hex').slice(0, 16);

// ---------------------------------------------------- website fingerprinting
//
// Ported from Watcher-Workflows executions/_fingerprint.py. Markers are strings
// that appear in real page source. The caveat from the original still holds and
// still matters: large sites inject pixels at runtime through Google Tag
// Manager, so "no pixel in the HTML" is only a conclusion when GTM is absent.
// A missing pixel we cannot verify stays `null`, never `true` — claiming a gap
// that is not there is exactly the unsourced assertion this module forbids.

const BUILDERS = [
  ['Wix', ['static.parastorage.com', 'wixstatic.com', 'content="wix.com', 'wixbisession']],
  ['Squarespace', ['<!-- this is squarespace.', 'static1.squarespace.com', 'squarespace_rollups']],
  ['Shopify', ['cdn.shopify.com', 'window.shopify', 'myshopify.com']],
  ['GoDaddy Website Builder', ['go daddy website builder', 'img1.wsimg.com']],
  ['Duda', ['irp.cdn-website.com', 'static.cdn-website.com', 'multiscreensite.com']],
  ['Webflow', ['data-wf-page', 'data-wf-site', 'content="webflow"']],
  ['WordPress', ['/wp-content/', '/wp-includes/', 'content="wordpress', 'wp-json']]
];

const DIY_BUILDERS = new Set(['Wix', 'GoDaddy Website Builder', 'Squarespace', 'Duda']);

const ANALYTICS = {
  'Google Analytics 4': ['googletagmanager.com/gtag/js?id=g-', 'gtag('],
  'Google Tag Manager': ['googletagmanager.com/gtm.js']
};

const PIXELS = {
  'Meta Pixel': ['connect.facebook.net/en_us/fbevents.js', 'fbq(', 'facebook.com/tr?'],
  'Google Ads': ['googleadservices.com/pagead/conversion'],
  'TikTok Pixel': ['analytics.tiktok.com', 'ttq.load'],
  'LinkedIn Insight': ['snap.licdn.com/li.lms-analytics', '_linkedin_partner_id']
};

const CHAT_WIDGETS = {
  'Tawk.to': ['embed.tawk.to'], Crisp: ['client.crisp.chat'], Intercom: ['widget.intercom.io'],
  HubSpot: ['js.hs-scripts.com'], Tidio: ['code.tidio.co'], LiveChat: ['cdn.livechatinc.com'],
  Zendesk: ['static.zdassets.com'], Podium: ['connect.podium.com'], Drift: ['js.driftt.com']
};

const SCHEMA_TYPES = new Set([
  'localbusiness', 'plumber', 'dentist', 'restaurant', 'electrician',
  'homeandconstructionbusiness', 'professionalservice', 'generalcontractor',
  'hairsalon', 'autorepair', 'foodestablishment', 'medicalbusiness', 'veterinarycare'
]);

const GA4_ID = /\bG-[A-Z0-9]{8,12}\b/;
const GTM_ID = /\bGTM-[A-Z0-9]{4,9}\b/;
const GOOGLE_ADS_ID = /\bAW-[0-9]{9,11}\b/;
const JSONLD_TYPE = /"@type"\s*:\s*"([^"]+)"/gi;
const MICRODATA_TYPE = /itemtype\s*=\s*["']https?:\/\/schema\.org\/([^"']+)/gi;

/** What a page's own source says about how its owner markets the business. */
export function detectTech(html = '') {
  if (!html.trim()) {
    return {
      builder: '', analytics: [], pixels: [], chat: [], schemaLocalBusiness: null,
      noPixel: null, noAnalytics: null, diyBuilder: null,
      note: 'no page captured (unverified)'
    };
  }
  const blob = html.toLowerCase();

  const builder = BUILDERS.find(([, markers]) => markers.some(marker => blob.includes(marker)))?.[0] || '';
  const analytics = Object.entries(ANALYTICS)
    .filter(([, markers]) => markers.some(marker => blob.includes(marker)))
    .map(([name]) => name);
  if (!analytics.includes('Google Analytics 4') && GA4_ID.test(html)) analytics.push('Google Analytics 4');
  if (!analytics.includes('Google Tag Manager') && GTM_ID.test(html)) analytics.push('Google Tag Manager');

  const pixels = Object.entries(PIXELS)
    .filter(([, markers]) => markers.some(marker => blob.includes(marker)))
    .map(([name]) => name);
  if (!pixels.includes('Google Ads') && GOOGLE_ADS_ID.test(html)) pixels.push('Google Ads');

  const chat = Object.entries(CHAT_WIDGETS)
    .filter(([, markers]) => markers.some(marker => blob.includes(marker)))
    .map(([name]) => name);

  const types = [...html.matchAll(JSONLD_TYPE), ...html.matchAll(MICRODATA_TYPE)].map(match => match[1].trim().toLowerCase());
  const schemaLocalBusiness = types.some(type => SCHEMA_TYPES.has(type));

  // The GTM caveat, preserved from the original.
  const pixelReadable = pixels.length > 0 || !analytics.includes('Google Tag Manager');

  return {
    builder,
    analytics,
    pixels,
    chat,
    schemaLocalBusiness,
    noPixel: pixelReadable ? pixels.length === 0 : null,
    noAnalytics: analytics.length === 0,
    diyBuilder: builder ? DIY_BUILDERS.has(builder) : null,
    note: pixelReadable ? '' : 'Google Tag Manager present — pixel absence could not be verified'
  };
}

async function fetchSite(url, { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Identify honestly. A scraper that pretends to be a browser is a
        // scraper whose operator cannot answer for what it did.
        'User-Agent': 'BiteSitesResearchBot/1.0 (+https://bitesites.org/; contact@bitesites.org)',
        Accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) return { ok: false, status: response.status, html: '' };
    const type = response.headers.get('content-type') || '';
    if (!type.includes('html')) return { ok: false, status: response.status, html: '' };
    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    return { ok: true, status: response.status, html, finalUrl: response.url || url };
  } catch (error) {
    return { ok: false, status: 0, html: '', error: clean(error?.message, 200) };
  } finally {
    clearTimeout(timer);
  }
}

const TITLE = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i;
const META_DESCRIPTION = /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]{0,400}?)["']/i;

/**
 * Build the brief.
 *
 * Every entry in `verifiedFacts` names the source it came from. Everything the
 * system inferred rather than read lands in `hypotheses` and is labelled as
 * such in the UI and in the AI prompt.
 */
export async function researchContact(db, { contactType, contact, campaign = {}, fetchImpl } = {}) {
  const sources = [];
  const verifiedFacts = [];
  const hypotheses = [];
  const now = new Date();

  const addSource = (title, url) => {
    const id = factId(url || title, 'source');
    sources.push({ id, title: clean(title, 160), url: clean(url, 500), fetchedAt: now, factIds: [] });
    return id;
  };
  const addFact = (text, sourceId, field = '') => {
    const id = factId(text, sourceId);
    verifiedFacts.push({ id, text: clean(text, 300), sourceId, field });
    const source = sources.find(entry => entry.id === sourceId);
    if (source) source.factIds.push(id);
    return id;
  };

  // 1. What BiteSites already holds.
  const ownSource = addSource('BiteSites record', '');
  if (contact.companyName) addFact(`Business name on file: ${contact.companyName}.`, ownSource, 'companyName');
  if (contact.address?.city) {
    addFact(`Located in ${[contact.address.city, contact.address.region].filter(Boolean).join(', ')}.`, ownSource, 'address');
  }
  if (contact.business?.category) addFact(`Categorised as ${contact.business.category.replace(/_/g, ' ')}.`, ownSource, 'category');
  if (Number.isFinite(contact.business?.rating) && contact.business?.reviewCount) {
    addFact(`Rated ${contact.business.rating} from ${contact.business.reviewCount} public reviews.`, ownSource, 'rating');
  }

  // 2. Prior activity — what has already been tried, so a call does not repeat it.
  let priorAttempts = 0;
  if (contact.id) {
    const parent = contactType === 'lead' ? 'leads' : 'prospects';
    const activities = await db.collection(`${parent}/${contact.id}/activities`)
      .orderBy('at', 'desc').limit(20).get().catch(() => null);
    if (activities && !activities.empty) {
      const historySource = addSource('BiteSites activity history', '');
      priorAttempts = activities.docs.filter(entry => entry.get('type') === 'call_attempted').length;
      if (priorAttempts) addFact(`${priorAttempts} previous outbound call attempt(s) recorded.`, historySource, 'history');
      const connected = activities.docs.find(entry => entry.get('type') === 'call_connected');
      if (connected) addFact('A previous outbound call connected with someone at this business.', historySource, 'history');
    }
  }

  // 3. GoHighLevel contact, when the record already knows about one. Read from
  //    our own stored copy rather than calling the API here: this function runs
  //    per target during a campaign, and an API round-trip per target is a rate
  //    limit waiting to happen.
  if (contact.providerContactId) {
    const crmSource = addSource('GoHighLevel contact', '');
    addFact(`Already exists as GoHighLevel contact ${contact.providerContactId}.`, crmSource, 'crm');
  }

  // 4. The company's own website.
  let tech = null;
  const domain = normalizeDomain(contact.website);
  if (domain) {
    const url = `https://${domain}/`;
    const page = await fetchSite(url, { fetchImpl });
    if (page.ok) {
      const siteSource = addSource(`${domain} (their website)`, url);
      const title = clean(TITLE.exec(page.html)?.[1]?.replace(/<[^>]+>/g, ''), 200);
      const description = clean(META_DESCRIPTION.exec(page.html)?.[1], 300);
      if (title) addFact(`Their homepage title is "${title}".`, siteSource, 'website');
      if (description) addFact(`Their site describes them as: "${description}".`, siteSource, 'website');

      tech = detectTech(page.html);
      if (tech.builder) addFact(`Their site is built on ${tech.builder}.`, siteSource, 'tech');
      if (tech.diyBuilder === true) {
        addFact(`${tech.builder} is a DIY site builder — no agency is likely to be managing this site.`, siteSource, 'tech');
      }
      if (tech.noAnalytics) addFact('No analytics or tag manager was found on their homepage.', siteSource, 'tech');
      if (tech.noPixel === true) addFact('No advertising pixel was found on their homepage.', siteSource, 'tech');
      if (tech.noPixel === null && tech.note) hypotheses.push(tech.note);
      if (tech.schemaLocalBusiness === false) {
        addFact('Their homepage has no schema.org LocalBusiness markup, which hurts local search visibility.', siteSource, 'seo');
      }
      if (tech.chat.length === 0) hypotheses.push('No chat or lead-capture widget was visible on the homepage.');
    } else {
      // A site that would not load is itself worth knowing, and it is a fact we
      // observed rather than one we inferred.
      const siteSource = addSource(`${domain} (their website)`, url);
      addFact(page.status
        ? `Their website returned HTTP ${page.status} when we checked it.`
        : 'Their website did not respond when we checked it.', siteSource, 'website');
    }
  } else if (contact.website) {
    hypotheses.push('The website on file is a social or directory profile rather than their own domain.');
  } else {
    hypotheses.push('No website is on file for this business.');
  }

  // 5. External enrichment providers — deliberately not integrated. See the
  //    module header and LEAD_DISCOVERY_SETUP.md.

  const talkingPoints = [];
  if (tech?.diyBuilder === true) talkingPoints.push(`Their ${tech.builder} site suggests nobody is being paid to run it — an opening for a rebuild conversation.`);
  if (tech?.noAnalytics) talkingPoints.push('They cannot currently see their own website traffic.');
  if (tech?.noPixel === true) talkingPoints.push('They have no advertising pixel installed, so paid acquisition is unmeasurable for them.');
  if (tech?.schemaLocalBusiness === false) talkingPoints.push('Missing local-business structured data is a concrete, fixable local-SEO gap.');
  if (!domain) talkingPoints.push('They appear to have no website of their own — the most direct version of what BiteSites sells.');

  const likelyNeeds = talkingPoints.length
    ? ['A website that they can measure', 'Local search visibility', 'A way to capture enquiries from the site']
    : ['Unknown — nothing verifiable was found about their current setup'];

  const summary = clean([
    contact.companyName || contact.name,
    contact.business?.category ? `(${contact.business.category.replace(/_/g, ' ')})` : '',
    contact.address?.city ? `in ${contact.address.city}` : '',
    tech?.builder ? `runs a ${tech.builder} site` : domain ? 'has a website' : 'has no website on file',
    talkingPoints.length ? `— ${talkingPoints.length} verified marketing gap(s) found` : '— no verified gaps found'
  ].filter(Boolean).join(' '), 500);

  // Confidence is the share of the brief that is sourced, not a model's
  // self-report. A brief built from one fact should not read as certain.
  const confidence = Math.min(1, Number((verifiedFacts.length / 8).toFixed(2)));

  return {
    contactType,
    leadId: contactType === 'lead' ? contact.id : '',
    prospectId: contactType === 'prospect' ? contact.id : '',
    status: verifiedFacts.length ? 'ready' : 'insufficient_data',
    companyName: clean(contact.companyName || contact.name, 160),
    companyWebsite: domain ? `https://${domain}` : '',
    summary,
    verifiedFacts,
    hypotheses: hypotheses.slice(0, 8),
    likelyNeeds,
    talkingPoints: talkingPoints.slice(0, 6),
    suggestedOpening: clean(
      `Hi, this is BiteSites — am I through to ${contact.companyName || contact.name || 'the owner'}? `
      + (talkingPoints[0] ? `I was looking at your site and noticed ${talkingPoints[0].charAt(0).toLowerCase()}${talkingPoints[0].slice(1)}` : 'I had a quick question about your website.'),
      500
    ),
    likelyObjections: [
      'We already have someone who handles that.',
      'We are not interested in a new website right now.',
      'How did you get this number?'
    ],
    recentSignals: [],
    sources: sources.map(source => ({ ...source, fetchedAt: Timestamp.fromDate(source.fetchedAt) })),
    confidence,
    approved: false,
    approvedBy: '',
    approvedAt: null,
    generatedAt: Timestamp.fromDate(now),
    expiresAt: Timestamp.fromMillis(now.getTime() + RESEARCH_TTL_DAYS * 86400000),
    model: 'bitesites-deterministic-v1',
    campaignId: clean(campaign.id, 160),
    error: ''
  };
}

/** Cached brief, if one exists and has not expired. */
export async function loadResearch(db, key, { now = new Date() } = {}) {
  const snapshot = await db.doc(`leadResearch/${key}`).get();
  if (!snapshot.exists) return null;
  const research = snapshot.data();
  const expiresAt = research.expiresAt?.toDate?.();
  if (expiresAt && expiresAt.getTime() < now.getTime()) return null;
  return { id: snapshot.id, ...research };
}

export async function saveResearch(db, key, research) {
  await db.doc(`leadResearch/${key}`).set(research);
  return key;
}

export async function approveResearch(db, key, { approvedBy, edits = null, now = new Date() }) {
  const ref = db.doc(`leadResearch/${key}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('No research to approve');

  const update = {
    approved: true,
    approvedBy: clean(approvedBy, 128),
    approvedAt: Timestamp.fromDate(now)
  };
  if (edits) {
    // An admin may correct the prose. They may not fabricate a sourced fact, so
    // `verifiedFacts` and `sources` are not editable from here.
    if (typeof edits.summary === 'string') update.summary = clean(edits.summary, 1500);
    if (typeof edits.suggestedOpening === 'string') update.suggestedOpening = clean(edits.suggestedOpening, 800);
    if (Array.isArray(edits.talkingPoints)) update.talkingPoints = edits.talkingPoints.slice(0, 8).map(point => clean(point, 300));
  }
  await ref.set(update, { merge: true });
  return { ok: true };
}

/**
 * The structured brief an AI agent is allowed to see.
 *
 * Only approved, sourced material crosses this boundary. Hypotheses are
 * included but explicitly labelled, and the disclosures the compliance layer
 * requires are prepended so a campaign script cannot drop them.
 */
export function buildCallBrief({ research, campaign, compliance, contact }) {
  return {
    identity: {
      agent: 'the BiteSites AI assistant',
      company: 'BiteSites',
      // Repeated in the instructions below as well; an agent that only sees it
      // in a structured field has been observed to skip it in speech.
      disclosureRequired: Boolean(compliance?.aiDisclosureRequired)
    },
    reasonForCall: clean(campaign?.objective, 500) || 'To ask whether their current website is working for them.',
    objective: clean(campaign?.objective, 500),
    contact: {
      name: clean(contact?.firstName || '', 80),
      company: clean(contact?.companyName || contact?.name, 160),
      city: clean(contact?.address?.city, 80)
    },
    summary: research?.approved ? clean(research.summary, 1500) : '',
    verifiedFacts: research?.approved
      ? (research.verifiedFacts || []).map(fact => ({ text: fact.text, sourceId: fact.sourceId }))
      : [],
    unverifiedObservations: research?.approved ? (research.hypotheses || []) : [],
    talkingPoints: research?.approved ? (research.talkingPoints || []) : [],
    suggestedOpening: research?.approved ? clean(research.suggestedOpening, 800) : '',
    likelyObjections: research?.approved ? (research.likelyObjections || []) : [],
    script: clean(campaign?.script, 4000),
    disclosures: compliance?.disclosures || [],
    instructions: [
      'Only state something as a fact if it appears in verifiedFacts. Everything in unverifiedObservations is a guess and must be phrased as a question.',
      'Never invent details about their business, their competitors, their revenue or their staff.',
      'Never claim to be a human. If asked, say plainly that you are an AI assistant.',
      'If the person asks to be removed from the list, confirm it, end the call, and do not argue.',
      'If the person asks a question you cannot answer from this brief, offer to have a person follow up.',
      clean(campaign?.bookingRules, 500) || 'If they are interested, offer to book a short call with the BiteSites team.',
      clean(campaign?.escalationRules, 500) || 'Escalate to a human if the person is upset, asks about billing, or mentions a legal or compliance concern.'
    ].filter(Boolean)
  };
}
