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
import { getAccount } from './accounts.js';

export const RESEARCH_TTL_DAYS = 14;
export const RESEARCH_EVIDENCE_POLICY_VERSION = 1;
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 600_000;
const SPEAKABLE_EVIDENCE_TYPES = new Set(['observed', 'provider_asserted', 'prospect_stated']);
const SOURCE_KINDS = new Set(['first_party_record', 'internal_history', 'crm_record', 'official_website']);

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
export async function researchContact(db, { contactType, contact, campaign = {}, fetchImpl, now = new Date() } = {}) {
  const accountId = clean(campaign.accountId || contact?.accountId || 'bitesites', 120);
  const seller = getAccount(accountId);
  if (!seller) throw new Error('Research requires a known seller account');
  const isBiteSites = seller?.id === 'bitesites';
  const sources = [];
  const verifiedFacts = [];
  const hypotheses = [];

  const addSource = (title, url, kind) => {
    if (!SOURCE_KINDS.has(kind)) throw new Error('Research source kind is not approved');
    const id = factId(url || title, 'source');
    sources.push({
      id,
      title: clean(title, 160),
      url: clean(url, 500),
      kind,
      fetchedAt: now,
      factIds: []
    });
    return id;
  };
  const addFact = (text, sourceId, field = '', {
    evidenceType = 'provider_asserted', confidence = 0.75, speakable = false
  } = {}) => {
    if (!SPEAKABLE_EVIDENCE_TYPES.has(evidenceType)) throw new Error('Research evidence type is not approved');
    const id = factId(text, sourceId);
    verifiedFacts.push({
      id,
      text: clean(text, 300),
      sourceId,
      field,
      evidenceType,
      observedAt: now.toISOString(),
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      speakable: speakable === true
    });
    const source = sources.find(entry => entry.id === sourceId);
    if (source) source.factIds.push(id);
    return id;
  };

  // 1. What the selected seller already holds.
  const ownSource = addSource(`${seller?.label || 'Seller'} prospect record`, '', 'first_party_record');
  if (contact.companyName) addFact(`Business name on file: ${contact.companyName}.`, ownSource, 'companyName', { speakable: true });
  if (contact.address?.city) {
    addFact(`Location on file: ${[contact.address.city, contact.address.region].filter(Boolean).join(', ')}.`, ownSource, 'address', { speakable: true });
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
      const historySource = addSource(`${seller.label} activity history`, '', 'internal_history');
      priorAttempts = activities.docs.filter(entry => entry.get('type') === 'call_attempted').length;
      if (priorAttempts) addFact(`${priorAttempts} previous outbound call attempt(s) recorded.`, historySource, 'history', { evidenceType: 'observed', confidence: 1 });
      const connected = activities.docs.find(entry => entry.get('type') === 'call_connected');
      if (connected) addFact('A previous outbound call connected with someone at this business.', historySource, 'history', { evidenceType: 'observed', confidence: 1 });
    }
  }

  // 3. GoHighLevel contact, when the record already knows about one. Read from
  //    our own stored copy rather than calling the API here: this function runs
  //    per target during a campaign, and an API round-trip per target is a rate
  //    limit waiting to happen.
  if (contact.providerContactId) {
    const crmSource = addSource('GoHighLevel contact', '', 'crm_record');
    // Operational identifiers help deduplicate and route records, but must
    // never become prospect-facing dialogue.
    addFact('A matching CRM contact record exists.', crmSource, 'crm', { confidence: 1 });
  }

  // 4. The company's own website.
  let tech = null;
  const domain = normalizeDomain(contact.website);
  if (domain && isBiteSites) {
    const url = `https://${domain}/`;
    const page = await fetchSite(url, { fetchImpl });
    if (page.ok) {
      const siteSource = addSource(`${domain} (their website)`, url, 'official_website');
      const title = clean(TITLE.exec(page.html)?.[1]?.replace(/<[^>]+>/g, ''), 200);
      const description = clean(META_DESCRIPTION.exec(page.html)?.[1], 300);
      if (title) addFact(`Their homepage title is "${title}".`, siteSource, 'website', { evidenceType: 'observed', confidence: 1, speakable: true });
      if (description) addFact(`Their site describes them as: "${description}".`, siteSource, 'website', { evidenceType: 'observed', confidence: 1, speakable: true });

      tech = detectTech(page.html);
      if (tech.builder) addFact(`Their site is built on ${tech.builder}.`, siteSource, 'tech', { evidenceType: 'observed', confidence: 0.95, speakable: true });
      if (tech.diyBuilder === true) {
        hypotheses.push(`Their ${tech.builder} site may be self-managed; ask who owns updates before drawing a conclusion.`);
      }
      if (tech.noAnalytics) addFact('No analytics or tag-manager marker was visible in the homepage HTML inspected.', siteSource, 'tech', { evidenceType: 'observed', confidence: 0.9 });
      if (tech.noPixel === true) addFact('No advertising-pixel marker was visible in the homepage HTML inspected.', siteSource, 'tech', { evidenceType: 'observed', confidence: 0.9 });
      if (tech.noPixel === null && tech.note) hypotheses.push(tech.note);
      if (tech.schemaLocalBusiness === false) {
        addFact('No schema.org LocalBusiness markup was visible in the homepage HTML inspected.', siteSource, 'seo', { evidenceType: 'observed', confidence: 0.9 });
      }
      if (tech.chat.length === 0) hypotheses.push('No chat or lead-capture widget was visible on the homepage.');
    } else {
      // A site that would not load is itself worth knowing, and it is a fact we
      // observed rather than one we inferred.
      const siteSource = addSource(`${domain} (their website)`, url, 'official_website');
      addFact(page.status
        ? `Their website returned HTTP ${page.status} when we checked it.`
        : 'Their website did not respond when we checked it.', siteSource, 'website', { evidenceType: 'observed', confidence: 0.9 });
    }
  } else if (contact.website && isBiteSites) {
    hypotheses.push('The website on file is a social or directory profile rather than their own domain.');
  } else if (isBiteSites) {
    hypotheses.push('No website is on file for this business.');
  }

  // 5. External enrichment providers — deliberately not integrated. See the
  //    module header and LEAD_DISCOVERY_SETUP.md.

  const talkingPoints = isBiteSites ? [] : (seller?.sales?.researchPriorities || [])
    .slice(0, 6).map(priority => `Ask about ${priority}; do not assume there is a problem.`);
  if (isBiteSites && tech?.diyBuilder === true) talkingPoints.push(`Ask who manages the ${tech.builder} site and how updates are handled.`);
  if (isBiteSites && tech?.noAnalytics) talkingPoints.push('Ask how website traffic and enquiries are measured; the homepage scan alone cannot prove their full analytics setup.');
  if (isBiteSites && tech?.noPixel === true) talkingPoints.push('Ask whether paid campaigns use another tracking route; the homepage scan alone cannot prove acquisition is unmeasured.');
  if (isBiteSites && tech?.schemaLocalBusiness === false) talkingPoints.push('Ask who owns local-search implementation before treating missing homepage markup as a business gap.');
  if (isBiteSites && !domain) talkingPoints.push('Ask whether they currently have a business website; none is present in the approved record.');

  const likelyNeeds = isBiteSites
    ? (talkingPoints.length
      ? ['A measurable conversion path', 'Local search visibility', 'A reliable way to capture enquiries']
      : ['Unknown — nothing verifiable was found about their current setup'])
    : (seller?.sales?.researchPriorities || []).slice(0, 6);

  const summary = clean([
    contact.companyName || contact.name,
    contact.business?.category ? `(${contact.business.category.replace(/_/g, ' ')})` : '',
    contact.address?.city ? `in ${contact.address.city}` : '',
    isBiteSites ? (tech?.builder ? `runs a ${tech.builder} site` : domain ? 'has a website' : 'has no website on file') : '',
    verifiedFacts.length ? `— ${verifiedFacts.length} source-backed observation(s)` : '— no source-backed observations found'
  ].filter(Boolean).join(' '), 500);

  // Confidence is the share of the brief that is sourced, not a model's
  // self-report. A brief built from one fact should not read as certain.
  const confidence = Math.min(1, Number((verifiedFacts.length / 8).toFixed(2)));

  return {
    accountId: seller.id,
    evidencePolicyVersion: RESEARCH_EVIDENCE_POLICY_VERSION,
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
    suggestedOpening: clean(isBiteSites
      ? `After the mandatory AI/seller disclosure, verify you reached ${contact.companyName || contact.name || 'the business'} and ask one neutral question about their current website or lead-response process.`
      : `After the mandatory AI/seller disclosure, verify you reached ${contact.companyName || contact.name || 'the intended contact'} and ask one neutral question about ${seller?.sales?.researchPriorities?.[0] || 'their current need'}.`, 500),
    likelyObjections: isBiteSites
      ? ['We already have someone who handles that.', 'We are not interested in a new website right now.', 'How did you get this number?']
      : ['We are not interested.', 'We already have someone who handles that.', 'How did you get this number?'],
    recentSignals: [],
    sources: sources.map(source => ({ ...source, fetchedAt: Timestamp.fromDate(source.fetchedAt) })),
    confidence,
    approved: false,
    approvedBy: '',
    approvedAt: null,
    generatedAt: Timestamp.fromDate(now),
    expiresAt: Timestamp.fromMillis(now.getTime() + RESEARCH_TTL_DAYS * 86400000),
    model: 'deterministic-research-v3',
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

const timestampDate = value => {
  if (value?.toDate) return value.toDate();
  const parsed = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

/**
 * Validate the evidence bundle before a human approval can make it callable.
 *
 * Imported prose, stale legacy rows, and operational CRM metadata may still be
 * useful to a reviewer, but they cannot become spoken facts unless the source
 * and the observation carry this policy's complete provenance fields.
 */
export function validateResearchEvidence(research = {}, { now = new Date() } = {}) {
  const failures = [];
  if (research.evidencePolicyVersion !== RESEARCH_EVIDENCE_POLICY_VERSION) {
    failures.push('evidence_policy_version');
  }
  const sources = new Map((Array.isArray(research.sources) ? research.sources : [])
    .map(source => [clean(source?.id, 80), source]));
  for (const fact of Array.isArray(research.verifiedFacts) ? research.verifiedFacts : []) {
    const source = sources.get(clean(fact?.sourceId, 80));
    if (!source) failures.push('missing_source');
    else if (!SOURCE_KINDS.has(clean(source.kind, 60))) failures.push('unapproved_source_kind');

    if (!SPEAKABLE_EVIDENCE_TYPES.has(clean(fact?.evidenceType, 40))) {
      failures.push('unapproved_evidence_type');
    }
    const observedAt = timestampDate(fact?.observedAt);
    if (!observedAt) failures.push('missing_observed_at');
    else if (observedAt.getTime() > now.getTime() + 5 * 60_000) failures.push('future_observed_at');
    const confidence = Number(fact?.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) failures.push('invalid_confidence');
  }
  return [...new Set(failures)];
}

export async function approveResearch(db, key, { approvedBy, edits = null, now = new Date() }) {
  const ref = db.doc(`leadResearch/${key}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('No research to approve');
  const failures = validateResearchEvidence(snapshot.data(), { now });
  if (failures.length) throw new Error(`Research evidence is not approvable: ${failures.join(', ')}`);

  const update = {
    approved: true,
    approvedBy: clean(approvedBy, 128),
    approvedAt: Timestamp.fromDate(now),
    evidencePolicyVersion: RESEARCH_EVIDENCE_POLICY_VERSION,
    version: FieldValue.increment(1)
  };
  if (edits) {
    // An admin may correct the prose. They may not fabricate a sourced fact, so
    // `verifiedFacts` and `sources` are not editable from here.
    if (typeof edits.summary === 'string') update.summary = clean(edits.summary, 1500);
    if (typeof edits.suggestedOpening === 'string') update.suggestedOpening = clean(edits.suggestedOpening, 800);
    if (Array.isArray(edits.talkingPoints)) update.talkingPoints = edits.talkingPoints.slice(0, 8).map(point => clean(point, 300));
  }
  await ref.set(update, { merge: true });
  return { ok: true, accountId: clean(snapshot.get('accountId'), 120) };
}

/**
 * The structured brief an AI agent is allowed to see.
 *
 * Only approved, sourced material crosses this boundary. Hypotheses are
 * included but explicitly labelled, and the disclosures the compliance layer
 * requires are prepended so a campaign script cannot drop them.
 */
export function buildCallBrief({ research, campaign, compliance, contact }) {
  const seller = getAccount(campaign?.accountId);
  const legalName = seller?.legalName || 'the seller identified by the campaign';
  const brand = seller?.label || legalName;
  const conversion = seller?.sales?.conversionLabel || 'Book the approved next step';
  return {
    identity: {
      agent: `an AI assistant for ${legalName}`,
      company: brand,
      // Repeated in the instructions below as well; an agent that only sees it
      // in a structured field has been observed to skip it in speech.
      disclosureRequired: Boolean(compliance?.aiDisclosureRequired)
    },
    reasonForCall: clean(campaign?.objective, 500) || seller?.sales?.primaryObjective || 'To ask whether the seller’s services fit the prospect’s stated need.',
    objective: clean(campaign?.objective, 500),
    contact: {
      name: clean(contact?.firstName || '', 80),
      company: clean(contact?.companyName || contact?.name, 160),
      city: clean(contact?.address?.city, 80)
    },
    summary: research?.approved ? clean(research.summary, 1500) : '',
    verifiedFacts: research?.approved
      ? (research.verifiedFacts || [])
        .filter(fact => fact?.speakable === true && SPEAKABLE_EVIDENCE_TYPES.has(clean(fact?.evidenceType, 40)))
        .map(fact => ({
          text: fact.text,
          sourceId: fact.sourceId,
          evidenceType: fact.evidenceType,
          observedAt: fact.observedAt,
          confidence: fact.confidence
        }))
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
      clean(campaign?.bookingRules, 500) || `If they are interested, use the approved booking tool to: ${conversion}.`,
      clean(campaign?.escalationRules, 500) || 'Escalate to a human if the person is upset, asks about billing, or mentions a legal or compliance concern.'
    ].filter(Boolean)
  };
}
