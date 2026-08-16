// Trusted BiteSites offer catalogue for live sales agents.
//
// An offer track is server-owned data, never operator free text. One agent
// persona carries the whole catalogue: the campaign selects which tracks get
// full detail, every other track stays a one-line pointer so the agent knows
// the service exists without freelancing details it cannot support.
//
// Nothing in this file may promise an outcome. Tracks describe capability,
// discovery questions, and the honest next step. Pricing, timelines, and
// guarantees always belong to a human specialist.

const track = definition => Object.freeze({
  ...definition,
  discovery: Object.freeze(definition.discovery),
  talkingPoints: Object.freeze(definition.talkingPoints),
  objections: Object.freeze(definition.objections)
});

export const OFFER_TRACKS = Object.freeze({
  voice_agents: track({
    key: 'voice_agents',
    name: 'AI Voice Agents',
    oneLiner: 'AI phone agents that answer, qualify, and follow up on calls around the clock.',
    buyer: 'Any owner who misses calls, or whose team spends its day on the phone repeating itself.',
    openingAngle: 'You are the demonstration. The prospect is hearing the product work on them right now — use that, do not hide it.',
    discovery: [
      'When a call comes in and nobody picks up, what happens to it right now?',
      'Roughly how many calls a week reach voicemail or go unanswered after hours?',
      'Who handles the phone today, and what else are they supposed to be doing?'
    ],
    talkingPoints: [
      'This call is the product. You are speaking to a BiteSites voice agent right now, and it can be built to answer your line the same way.',
      'It answers every call on the first ring, at any hour, in the voice and personality you choose, and it never gets tired of the same five questions.',
      'It qualifies the caller, writes the notes into your CRM, books the appointment, and hands off to a human the moment someone asks for one.'
    ],
    objections: [
      ['It sounds like a robot / my customers will hate it', 'Ask them honestly how far into this call they were before they were sure. That answer is the demo. And a human always stays one sentence away.'],
      ['I would rather a real person answer', 'Agree with them. Position this as covering the calls a person is not currently answering at all: after hours, second callers, overflow.']
    ],
    nextStep: 'Book a 20-minute call where a specialist scopes the agent for their actual phone line and call volume.'
  }),

  websites: track({
    key: 'websites',
    name: 'Custom Websites',
    oneLiner: 'Custom-built websites designed around one clear path to a consultation, quote, or sale.',
    buyer: 'Owners with an old, template, or purely decorative site.',
    openingAngle: 'A website is a salesperson, not a brochure. Ask what it is supposed to make happen.',
    discovery: [
      'When someone lands on your site, what is the one thing you want them to do?',
      'How do enquiries from the site reach you, and how fast does someone reply?',
      'When was the site last rebuilt, and who maintains it now?'
    ],
    talkingPoints: [
      'Custom build, not a template, designed around the specific action you need a visitor to take.',
      'The site is wired into follow-up from day one, so an enquiry becomes a routed, tracked lead instead of an email nobody opens.',
      'Built to be fast and to hold up on a phone, because that is where most of your traffic already is.'
    ],
    objections: [
      ['I already have a website', 'Do not argue. Ask whether it consistently produces qualified enquiries and what happens to one when it arrives.'],
      ['My nephew / a friend built it', 'Respect it. Shift to whether anyone is responsible for it now when something breaks or needs to change.']
    ],
    nextStep: 'Book a 20-minute strategy call to walk through their current site and where enquiries are leaking.'
  }),

  leads: track({
    key: 'leads',
    name: 'Lead Generation & Follow-Up',
    oneLiner: 'Finding qualified prospects and making sure not one of them goes unanswered.',
    buyer: 'Owners who say they need "more customers" but are already losing the ones they get.',
    openingAngle: 'Most businesses do not have a lead problem, they have a follow-up problem. Find out which one this is before pitching.',
    discovery: [
      'Where do most of your new customers come from right now?',
      'When a lead comes in on a Saturday, when does it actually get a reply?',
      'Do you know how many enquiries you got last month?'
    ],
    talkingPoints: [
      'We find and qualify prospects that match the customers you already do well with.',
      'Every lead gets routed and followed up automatically, so speed to first response stops depending on who happens to be free.',
      'You get visibility into what is coming in, what converts, and what is being dropped.'
    ],
    objections: [
      ['I get plenty of leads', 'Good — pivot to response time and conversion rather than volume.'],
      ['I tried a lead company and they were junk', 'Agree that bought lists are usually junk. Distinguish qualified, matched prospecting from list buying.']
    ],
    nextStep: 'Book a 20-minute call to map where their leads come from and where they are being lost.'
  }),

  seo: track({
    key: 'seo',
    name: 'SEO & Local Search',
    oneLiner: 'Search and local-map foundations so the business is findable where customers actually look.',
    buyer: 'Local and service businesses invisible in map results.',
    openingAngle: 'Local search, not abstract rankings. Ask if they show up on the map for their own service.',
    discovery: [
      'If someone searches your service plus your town, does your business come up?',
      'Is your Google Business Profile claimed and current?',
      'Do you know what people are typing when they find you?'
    ],
    talkingPoints: [
      'Technical foundations, local profile, and content built around what customers actually search for.',
      'Focus on the searches that mean someone is ready to call, not vanity keyword counts.',
      'Reporting shows what changed and what it produced.'
    ],
    objections: [
      ['SEO is a scam / I got burned', 'Validate it. A lot of it is. Separate reportable technical and local work from vague monthly retainers.'],
      ['How long does it take', 'Do not invent a timeline. Say honestly that it depends on their market and a specialist will give a real answer.']
    ],
    nextStep: 'Book a 20-minute call to review their current local search visibility.'
  }),

  automation: track({
    key: 'automation',
    name: 'AI Automation',
    oneLiner: 'Automating the repetitive internal work that eats a team\'s week.',
    buyer: 'Operations owners and office managers drowning in manual steps.',
    openingAngle: 'Ask what task they personally hate doing every week. That is the pitch.',
    discovery: [
      'What is the most repetitive thing your team does every week?',
      'How much of your day goes into copying information between systems?',
      'Where do things fall through the cracks most often?'
    ],
    talkingPoints: [
      'We automate the handoffs: intake, routing, scheduling, reminders, data entry between the tools you already pay for.',
      'The goal is removing steps, not adding another dashboard nobody opens.',
      'Built around your actual process, then handed over with training.'
    ],
    objections: [
      ['My process is too specific', 'That is exactly why it is custom rather than off-the-shelf software.'],
      ['My team is not technical', 'Point out that the goal is fewer steps for them, not new software to learn.']
    ],
    nextStep: 'Book a 20-minute call to map one workflow end to end and find the removable steps.'
  }),

  custom_os: track({
    key: 'custom_os',
    name: 'Custom Operating Systems',
    oneLiner: 'A purpose-built internal system when off-the-shelf software does not fit the business.',
    buyer: 'Established businesses running on spreadsheets, or paying for software they half use.',
    openingAngle: 'The tell is a business running on spreadsheets plus four subscriptions that do not talk.',
    discovery: [
      'What systems does the business actually run on day to day?',
      'How much of it lives in spreadsheets or someone\'s head?',
      'What would you build if the software matched how you actually work?'
    ],
    talkingPoints: [
      'A single custom system built around your operation instead of bending your operation around generic software.',
      'Replaces the stack of disconnected subscriptions and the spreadsheets holding them together.',
      'Yours: you own it, and it grows with the business.'
    ],
    objections: [
      ['That sounds expensive', 'Do not quote. Acknowledge it is a real investment and that scope and cost need a specialist conversation.'],
      ['We already pay for software', 'Ask how much of it the team genuinely uses, and what still gets done manually anyway.']
    ],
    nextStep: 'Book a 20-minute scoping call with a specialist. Do not attempt to scope or price this yourself.'
  }),

  ai_optimization: track({
    key: 'ai_optimization',
    name: 'AI Optimization',
    oneLiner: 'Tuning an existing AI setup that is technically running but not producing results.',
    buyer: 'Businesses that already bought AI tooling and are underwhelmed.',
    openingAngle: 'They already believe in AI. Skip convincing and go straight to what is underperforming.',
    discovery: [
      'What AI tools have you already put in?',
      'Where are they falling short of what you expected?',
      'Is anyone reviewing what they actually produce?'
    ],
    talkingPoints: [
      'We audit what you have running, find where it is failing, and tune it.',
      'Often the model is fine and the setup around it is the problem: prompts, data, routing, handoffs.',
      'You keep your existing tools where they work.'
    ],
    objections: [
      ['We will figure it out internally', 'Respect it. Offer the audit as the low-commitment version and leave the door open.'],
      ['AI has not worked for us', 'Agree that most deployments underperform, and that this is usually a configuration problem rather than the technology.']
    ],
    nextStep: 'Book a 20-minute call to review what they have deployed and where it is underperforming.'
  }),

  nfc: track({
    key: 'nfc',
    name: 'NFC Tag Integration',
    oneLiner: 'Tap-to-act NFC tags and cards linking the physical location to reviews, menus, payments, or booking.',
    buyer: 'Restaurants, retail, salons, trades, events, anyone with a physical touchpoint.',
    openingAngle: 'Very demonstrable and cheap to try. Great foot-in-the-door and pairs with anything.',
    discovery: [
      'How do you currently ask customers for a review?',
      'Do people ever ask for your details and you are digging for a card?',
      'Is there a moment where a customer is happy and standing right in front of you?'
    ],
    talkingPoints: [
      'A customer taps their phone on a tag, card, or stand and lands exactly where you want them: review page, menu, booking, payment, contact.',
      'No app, no QR code to scan, no typing. It works on the phone already in their hand.',
      'Most useful right at the counter, in the vehicle, or on the table, at the moment a customer is happiest.'
    ],
    objections: [
      ['We use QR codes', 'Fine — position NFC as removing the camera-and-focus step, and note the tags can carry both.'],
      ['Will it work on my customers\' phones', 'Say plainly that modern phones support tap, and a specialist will confirm for their setup.']
    ],
    nextStep: 'Book a short call to work out where the tags go and what they should trigger.'
  }),

  social: track({
    key: 'social',
    name: 'Social Media Management',
    oneLiner: 'Running the accounts: consistent posting, content, and replies that sound like the business.',
    buyer: 'Owners whose accounts have gone quiet or who post sporadically themselves.',
    openingAngle: 'Do not shame them for a dead account. Ask who owns it and what happened.',
    discovery: [
      'Who handles your social accounts right now?',
      'When did you last post, roughly?',
      'Do customers message you there, and does anyone see it?'
    ],
    talkingPoints: [
      'Consistent posting handled for you, in the business\'s own voice.',
      'Content produced rather than recycled stock, and messages actually answered.',
      'Coordinated with the website and the rest of what you have running.'
    ],
    objections: [
      ['Social does not work for my industry', 'Do not argue. Ask whether customers check them before buying, which is usually the real value.'],
      ['I can post myself', 'Agree they could. The question is whether it happens consistently when the business gets busy.']
    ],
    nextStep: 'Book a 20-minute call to review their accounts and agree a realistic posting rhythm.'
  }),

  photography: track({
    key: 'photography',
    name: 'Photography',
    oneLiner: 'Professional photography of the space, product, team, and work.',
    buyer: 'Anyone whose website or listings use stock images or phone snapshots.',
    openingAngle: 'Pairs naturally with a website or social conversation. Rarely the opener.',
    discovery: [
      'Are the photos on your site actually of your business?',
      'When did you last have proper photography done?',
      'Do you have images of your team or completed work?'
    ],
    talkingPoints: [
      'Real photography of your space, product, team, and finished work.',
      'Shot for how the images will actually be used: web, listings, and social, not just prints.',
      'You keep and own the library.'
    ],
    objections: [
      ['We have photos', 'Ask whether they are current and whether they are the business\'s own.'],
      ['My phone takes good pictures', 'Agree phones are good now, and shift to lighting, consistency, and the space being staged properly.']
    ],
    nextStep: 'Book a short call to work out what needs shooting.'
  }),

  drone: track({
    key: 'drone',
    name: 'Drone Photography',
    oneLiner: 'Licensed aerial photo and video of property, sites, venues, and projects.',
    buyer: 'Real estate, construction, venues, landscaping, agriculture, events.',
    openingAngle: 'High impact for anyone selling a place, a plot, or a project at scale.',
    discovery: [
      'Do you ever need to show the whole property or site in one shot?',
      'How do you currently show scale to a customer?',
      'Do you document project progress for clients?'
    ],
    talkingPoints: [
      'Aerial photo and video that shows scale and context the ground cannot.',
      'Useful for listings, progress documentation, venue marketing, and site surveys.',
      'Flown and delivered to spec.'
    ],
    objections: [
      ['Is that legal / allowed here', 'Confirm operations are conducted lawfully and that a specialist will confirm site-specific airspace rules. Do not improvise regulatory detail.'],
      ['Seems like a nice-to-have', 'Tie it to the specific thing they sell: the property, the venue, the finished project.']
    ],
    nextStep: 'Book a short call to confirm the site and what needs capturing.'
  }),

  models: track({
    key: 'models',
    name: 'Models & Talent',
    oneLiner: 'Casting and coordinating people for campaign, product, and brand shoots.',
    buyer: 'Retail, fashion, hospitality, and product businesses running campaigns.',
    openingAngle: 'Almost always attaches to a photography or campaign conversation rather than standing alone.',
    discovery: [
      'When you shoot a campaign, who is in the photos today?',
      'Do you need people in the shots to show the product being used?',
      'Have you cast talent before?'
    ],
    talkingPoints: [
      'Casting and coordination handled, matched to the brand and the audience.',
      'Works as one package with the photography rather than something you organise separately.',
      'Usage and releases handled properly up front.'
    ],
    objections: [
      ['We use staff', 'That often works well. Offer talent as the option when staff are not comfortable or not the right fit for the campaign.'],
      ['Sounds expensive', 'Do not quote. Say scope drives it and a specialist will lay out options.']
    ],
    nextStep: 'Book a short call to discuss the campaign and casting needs.'
  }),

  fonts: track({
    key: 'fonts',
    name: 'Custom Fonts & Type',
    oneLiner: 'A bespoke typeface or wordmark so the brand is recognisable before a word is read.',
    buyer: 'Established brands and businesses investing in a real identity.',
    openingAngle: 'Premium, differentiating, and almost nobody offers it. Use it as a signal of range, not a cold opener.',
    discovery: [
      'Does your brand have its own typeface, or are you using a standard one?',
      'Is your look consistent across signage, vehicles, packaging, and the site?',
      'Who owns your brand assets right now?'
    ],
    talkingPoints: [
      'A typeface drawn specifically for the brand, so it is recognisable before anyone reads a word.',
      'Applies consistently across signage, packaging, vehicles, and digital.',
      'You own it outright, and it is not licensable by a competitor.'
    ],
    objections: [
      ['Nobody notices fonts', 'Agree consciously — nobody notices, everybody recognises. That is the point.'],
      ['That is a luxury for us', 'Accept it. Note it as the last piece once the higher-return work is in place, and move on.']
    ],
    nextStep: 'Book a call with a specialist to discuss brand identity scope.'
  })
});

export const OFFER_TRACK_KEYS = Object.freeze(Object.keys(OFFER_TRACKS));

/** The flagship. The agent is the product, so this track is always available. */
export const FLAGSHIP_TRACK_KEY = 'voice_agents';

const MAX_DETAILED_TRACKS = 4;

export function normalizeOfferTrackKeys(keys = []) {
  const requested = (Array.isArray(keys) ? keys : [])
    .map(key => String(key || '').trim())
    .filter(key => OFFER_TRACK_KEYS.includes(key));
  return [...new Set(requested)].slice(0, MAX_DETAILED_TRACKS);
}

/**
 * Render the catalogue for one runtime. Selected tracks get full detail in the
 * order given (first is primary); every remaining service stays a one-line
 * pointer so the agent can acknowledge it without inventing specifics.
 */
export function renderOfferTracks(selectedKeys = []) {
  const selected = normalizeOfferTrackKeys(selectedKeys);
  if (!selected.length) return '';

  const detailed = selected.map(key => OFFER_TRACKS[key]);
  const rest = OFFER_TRACK_KEYS.filter(key => !selected.includes(key)).map(key => OFFER_TRACKS[key]);
  const lines = [
    'OFFER TRACKS',
    `Lead with ${detailed[0].name}. Pivot to another track only when the prospect's own answers point there — never run through the catalogue.`,
    ''
  ];

  for (const [index, entry] of detailed.entries()) {
    lines.push(
      `${index === 0 ? 'PRIMARY TRACK' : 'SECONDARY TRACK'} — ${entry.name}`,
      `Who this is for: ${entry.buyer}`,
      `Angle: ${entry.openingAngle}`,
      `Ask (one at a time, never as a list):\n- ${entry.discovery.join('\n- ')}`,
      `What you can say:\n- ${entry.talkingPoints.join('\n- ')}`,
      `Objections:\n${entry.objections.map(([objection, response]) => `- "${objection}" → ${response}`).join('\n')}`,
      `Next step: ${entry.nextStep}`,
      ''
    );
  }

  if (rest.length) {
    lines.push(
      'ALSO OFFERED (you may confirm BiteSites does these and capture interest, but do not pitch specifics — a specialist covers the detail):',
      ...rest.map(entry => `- ${entry.name}: ${entry.oneLiner}`),
      ''
    );
  }

  lines.push('When the prospect\'s real need is another track you carry in full, say so plainly, record it with record_interest_signal, and continue in that direction.');
  return lines.join('\n');
}

/**
 * What to do when the prospect does not want the thing being sold but may want
 * a different BiteSites service. The agent asks rather than assuming, and the
 * server only re-queues the lead on an explicit yes — a declined offer is a
 * closed conversation, not a softer retry.
 */
export const SERVICE_MISMATCH_INSTRUCTIONS = Object.freeze([
  'WRONG-SERVICE HANDLING',
  'Sometimes the prospect does not want what you called about, but does want something else BiteSites does. That is not a rejection — it is the wrong pitch, and it is worth catching.',
  'Only go down this road when they have said something concrete that points at another service. A flat “not interested” with no signal is a no: accept it, close warmly, and do not go fishing through the catalogue for something that might stick.',
  'When you do have a real signal, say plainly that it is not what you called about, then offer them the choice in one turn: someone can call them back about it, or you can put them through to the right person now. Ask once. Do not talk them into it.',
  'Then record what they chose with offer_alternative_service — callback_agreed, transfer_requested, or declined. Record declined too; it is how the system learns not to call them about it again.',
  'Only offer a transfer for a service you cannot cover in detail yourself. If it is a track you already carry in full, just keep talking.',
  'Never promise a specific person, day, or time for the follow-up unless a tool confirms it. “Someone will give you a call about it” is the promise you are allowed to make.'
]);
