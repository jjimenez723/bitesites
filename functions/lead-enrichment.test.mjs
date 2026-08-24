// Research and the call brief:  npm run test:enrichment
//
// Everything about this module comes down to one rule: never state an
// unverified thing as a fact. So the assertions below are mostly about
// provenance — every entry in `verifiedFacts` resolves to a source, an
// unapproved brief hands the agent nothing, and an approver can reword the
// prose but cannot manufacture a sourced claim.
//
// No network. The site fetch is injected, so the "their website says X" path is
// exercised against a fixture rather than somebody's real homepage.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const {
  detectTech, researchContact, saveResearch, loadResearch, approveResearch,
  buildCallBrief, contactKey, validateResearchEvidence, RESEARCH_TTL_DAYS
} = await import('./lead-enrichment.js');
const { requiredDisclosures, evaluateCompliance } = await import('./outbound-compliance.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const html = (body = '') => `<!doctype html><html><head><title>Joes Plumbing — Bergen County</title>
<meta name="description" content="Emergency plumbing in Bergen County since 1994."></head><body>${body}</body></html>`;

const fetchFixture = body => async () => ({
  ok: true,
  status: 200,
  url: 'https://joesplumbing.example.com/',
  headers: { get: () => 'text/html; charset=utf-8' },
  text: async () => html(body)
});

// ---------------------------------------------------------------------------
console.log('\nwebsite fingerprinting');

const wix = detectTech(html('<script src="https://static.parastorage.com/x.js"></script>'));
check('a Wix site is detected', wix.builder === 'Wix');
check('and flagged as DIY — nobody is being paid to run it', wix.diyBuilder === true);
check('no analytics is a definite finding', wix.noAnalytics === true);
check('no pixel is a definite finding when GTM is absent', wix.noPixel === true);

const gtm = detectTech(html('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD123"></script>'));
check('GTM is detected as analytics', gtm.analytics.includes('Google Tag Manager'));
// The caveat that matters: GTM can inject a pixel at runtime, so "no pixel"
// becomes undetermined rather than a claim we cannot support.
check('a missing pixel behind GTM is undetermined, not asserted', gtm.noPixel === null);
check('and the reason is recorded', /could not be verified/.test(gtm.note));

const wordpress = detectTech(html('<link href="/wp-content/themes/x/style.css"><script>fbq("init")</script>'));
check('WordPress is detected', wordpress.builder === 'WordPress');
check('it is not treated as DIY', wordpress.diyBuilder === false);
check('a Meta pixel is found', wordpress.pixels.includes('Meta Pixel'));

const schema = detectTech(html('<script type="application/ld+json">{"@type":"Plumber"}</script>'));
check('LocalBusiness schema is detected through a subtype', schema.schemaLocalBusiness === true);
check('and its absence is a definite finding', detectTech(html('')).schemaLocalBusiness === false);

const empty = detectTech('');
check('an empty page yields no conclusions at all',
  empty.noPixel === null && empty.noAnalytics === null && empty.diyBuilder === null);
check('and says so', /unverified/.test(empty.note));

// ---------------------------------------------------------------------------
console.log('\nresearch keys are deterministic and validated');

check('a prospect key', contactKey({ contactType: 'prospect', prospectId: 'p1' }) === 'prospect_p1');
check('a lead key', contactKey({ contactType: 'lead', leadId: 'l1' }) === 'lead_l1');
check('a lead and a prospect can never collide',
  contactKey({ contactType: 'lead', leadId: 'x' }) !== contactKey({ contactType: 'prospect', prospectId: 'x' }));

let refusedKey = false;
try { contactKey({ contactType: 'prospect' }); } catch { refusedKey = true; }
check('a key with no id is refused', refusedKey);

// ---------------------------------------------------------------------------
console.log('\nbuilding a brief');

const contact = {
  id: 'p-joes',
  companyName: 'Joes Plumbing',
  name: 'Joes Plumbing',
  phoneE164: '+12015550142',
  website: 'https://joesplumbing.example.com',
  address: { city: 'Ridgewood', region: 'NJ' },
  business: { category: 'plumbing', rating: 4.4, reviewCount: 61 },
  location: { timezone: 'America/New_York' },
  providerContactId: 'internal-crm-123'
};

const research = await researchContact(db, {
  contactType: 'prospect',
  contact,
  campaign: { id: 'camp-1', objective: 'Book a website review' },
  fetchImpl: fetchFixture('<script src="https://static.parastorage.com/x.js"></script>')
});

check('the brief is ready', research.status === 'ready', research.status);
check('it found sourced facts', research.verifiedFacts.length > 0, String(research.verifiedFacts.length));
check('every fact names a source that exists',
  research.verifiedFacts.every(fact =>
    research.sources.some(source => source.id === fact.sourceId)));
check('every fact carries evidence type, observation time, confidence, and spoken-use policy',
  research.verifiedFacts.every(fact =>
    fact.evidenceType && fact.observedAt && Number.isFinite(fact.confidence) && typeof fact.speakable === 'boolean'));
check('the generated evidence bundle passes the approval policy',
  validateResearchEvidence(research).length === 0,
  JSON.stringify(validateResearchEvidence(research)));
check('the website was read and quoted',
  research.verifiedFacts.some(fact => /homepage title/.test(fact.text)));
check('a verifiable marketing gap became a talking point',
  research.talkingPoints.some(point => /DIY|analytics|pixel/i.test(point)),
  JSON.stringify(research.talkingPoints));
check('it starts unapproved', research.approved === false);
check('it expires', Boolean(research.expiresAt));
check('confidence reflects how much was actually sourced',
  research.confidence > 0 && research.confidence <= 1, String(research.confidence));
check('the source list carries fetchable URLs',
  research.sources.some(source => source.url.startsWith('https://')));

// ---------------------------------------------------------------------------
console.log('\na site that will not load produces an observation, not an invention');

const dead = await researchContact(db, {
  contactType: 'prospect',
  contact: { ...contact, id: 'p-dead' },
  campaign: {},
  fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => '' }, text: async () => '' })
});
check('the failure is recorded as an observed fact',
  dead.verifiedFacts.some(fact => /HTTP 503/.test(fact.text)),
  JSON.stringify(dead.verifiedFacts.map(f => f.text)));
check('nothing about their marketing is claimed',
  !dead.verifiedFacts.some(fact => /pixel|analytics|builder/i.test(fact.text)));

// ---------------------------------------------------------------------------
console.log('\na business with no website');

const noSite = await researchContact(db, {
  contactType: 'prospect',
  contact: { ...contact, id: 'p-nosite', website: '' },
  campaign: {},
  fetchImpl: async () => { throw new Error('should not be called'); }
});
check('having no website is a hypothesis, not a fact',
  noSite.hypotheses.some(item => /No website/i.test(item)));
check('and it becomes the strongest talking point',
  noSite.talkingPoints.some(point => /business website/i.test(point)));

const stoneResearch = await researchContact(db, {
  contactType: 'prospect',
  contact: { ...contact, id: 'p-stone', website: '' },
  campaign: { accountId: 'stone-bellisimo', id: 'stone-campaign' },
  fetchImpl: async () => { throw new Error('partner research must not run the BiteSites website-gap adapter'); }
});
check('partner research uses the seller’s own discovery motion',
  stoneResearch.talkingPoints.some(point => /preferred stone or material/i.test(point)));
check('partner research never injects BiteSites website sales language',
  !/BiteSites|new website/i.test(JSON.stringify(stoneResearch)));

// ---------------------------------------------------------------------------
console.log('\ncaching and approval');

const key = contactKey({ contactType: 'prospect', prospectId: 'p-joes' });
await saveResearch(db, key, research);
const cached = await loadResearch(db, key);
check('a saved brief loads back', cached?.summary === research.summary);

const expired = await loadResearch(db, key, {
  now: new Date(Date.now() + (RESEARCH_TTL_DAYS + 1) * 86400000)
});
check('an expired brief is not served from cache', expired === null);

const beforeFacts = cached.verifiedFacts.length;
await approveResearch(db, key, {
  approvedBy: 'admin@bitesites.org',
  edits: {
    summary: 'Reworded by a human.',
    suggestedOpening: 'Hi — quick question about your website.',
    // An approver may not manufacture a sourced claim, so these are ignored.
    verifiedFacts: [{ id: 'fake', text: 'They spend $40k a year on ads.', sourceId: 'nope' }],
    sources: [{ id: 'nope', title: 'Invented', url: 'https://evil.example.com' }]
  }
});

const approved = await loadResearch(db, key);
check('the brief is approved', approved.approved === true);
check('and records who approved it', approved.approvedBy === 'admin@bitesites.org');
check('the reworded prose was accepted', approved.summary === 'Reworded by a human.');
check('a fabricated "verified fact" was ignored', approved.verifiedFacts.length === beforeFacts);
check('and no invented source was added',
  !approved.sources.some(source => source.url === 'https://evil.example.com'));

let refusedMissing = false;
try { await approveResearch(db, 'prospect_does-not-exist', { approvedBy: 'x' }); } catch { refusedMissing = true; }
check('approving a brief that does not exist is refused', refusedMissing);

// ---------------------------------------------------------------------------
console.log('\nwhat the AI agent is actually given');

const compliance = evaluateCompliance({
  target: { phoneE164: '+12015550142', timezone: 'America/New_York' },
  contact,
  campaign: { accountId: 'bitesites', mode: 'ai', callerId: '+15551234567', localStartTime: '00:00', localEndTime: '23:59', allowedDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
  now: new Date('2026-01-05T15:00:00Z')
});
const disclosures = requiredDisclosures(compliance);

const brief = buildCallBrief({
  research: approved,
  campaign: { accountId: 'bitesites', objective: 'Book a website review', script: 'Be brief.', id: 'camp-1' },
  compliance: { ...compliance, disclosures },
  contact
});

check('the brief carries the objective', brief.objective === 'Book a website review');
check('it carries the sourced facts', brief.verifiedFacts.length > 0);
check('operational CRM identifiers never enter the spoken brief',
  !JSON.stringify(brief).includes('internal-crm-123'));
check('negative homepage-marker observations stay discovery-only',
  !brief.verifiedFacts.some(fact => /analytics|pixel|schema/i.test(fact.text)));
check('every fact it carries still names its source',
  brief.verifiedFacts.every(fact => Boolean(fact.sourceId)));
check('hypotheses are labelled separately', Array.isArray(brief.unverifiedObservations));
check('the AI disclosure is present', disclosures.some(line => /AI assistant/i.test(line)));
check('an unrecorded call never claims audio is being recorded', !disclosures.some(line => /recorded/i.test(line)));
check('the AI identifies the correct legal seller', disclosures.some(line => /BiteSites L\.L\.C\./i.test(line)));
check('the opt-out instruction is present', disclosures.some(line => /not to be called again/i.test(line)));
check('the agent is told not to invent facts',
  brief.instructions.some(line => /Never invent/i.test(line)));
check('the agent is told never to claim to be human',
  brief.instructions.some(line => /Never claim to be a human/i.test(line)));
check('the agent is told to phrase unverified material as a question',
  brief.instructions.some(line => /must be phrased as a question/i.test(line)));

const unapprovedBrief = buildCallBrief({
  research: { ...approved, approved: false },
  campaign: { objective: 'x' },
  compliance: { ...compliance, disclosures },
  contact
});
check('an UNAPPROVED brief hands the agent no facts at all',
  unapprovedBrief.verifiedFacts.length === 0 && unapprovedBrief.summary === '');
check('but the disclosures are still mandatory', unapprovedBrief.disclosures.length === disclosures.length);

check('legacy facts without complete provenance cannot be approved',
  validateResearchEvidence({
    ...research,
    evidencePolicyVersion: 0,
    verifiedFacts: [{ text: 'Unsupported legacy claim', sourceId: research.sources[0].id }]
  }).length > 0);

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('\nFailed:');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
  process.exit(1);
}
