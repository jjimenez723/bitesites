export const positioning = {
  eyebrow: 'Revenue systems for local businesses',
  headline: 'Stop losing leads. Turn more inquiries into customers.',
  description: 'BiteSites builds the digital systems local businesses use to get found, answer faster, follow up automatically, book more work, and track what actually drives revenue.',
  trust: 'Websites. Local visibility. AI receptionists. Follow-up automation. Tracking. One connected system.',
  about: 'Based in New Jersey, BiteSites helps local businesses nationwide find where they lose customers, then builds the websites, visibility, response, follow-up, and tracking systems to close those gaps.'
};

export const revenueSteps = [
  ['Get found', 'Show up when customers need you.', 'Websites, local SEO, useful service content, and a credible online presence.'],
  ['Capture', 'Make the next step obvious.', 'Clear calls to action, quote forms, booking paths, and lead routing.'],
  ['Respond', 'Be there when interest is highest.', 'Missed-call recovery, AI receptionists, qualification, and team alerts.'],
  ['Follow up', 'Keep a good inquiry moving.', 'Estimate reminders, CRM workflows, and timely follow-up.'],
  ['Book & close', 'Turn a conversation into a next step.', 'Calendar connections, reminders, and handoffs to the right person.'],
  ['Track', 'See what leads to real business.', 'Lead sources, appointments, customer outcomes, and revenue where data connects.']
];

export const revenueServices = [
  {
    key: 'recovery', slug: 'lead-recovery', label: 'Lead recovery', title: 'Recover the leads you already earned.',
    heading: 'Missed-call and lead recovery for local businesses',
    description: 'Connect missed calls, website inquiries, and open estimates to a clear response and follow-up process.',
    problem: 'A contractor is on a job when the phone rings. A customer submits a quote request after hours. An estimate sits in an inbox. Buying more traffic will not fix those gaps in the handoff.',
    approach: 'We map how inquiries arrive, who owns the next step, and what happens when nobody responds. Then we connect the agreed response channels to qualification, team alerts, booking, and your CRM. Start with the gap that costs your team the most attention.',
    bullets: ['Missed-call recovery and response routing', 'Lead qualification and team notifications', 'Estimate follow-up and booking handoffs'],
    example: 'For a stone fabricator, a quote form can collect material preferences, project size, and timeline before the team arranges a measurement. Stone Bellisimo’s existing five-step estimate experience shows this intake approach in practice.',
    related: ['websites-local-seo', 'follow-up-automation'],
    scope: 'Channels, response windows, consent requirements, and human handoffs are agreed before launch. Recovery depends on reaching the lead and your team completing the next step.'
  },
  {
    key: 'web', slug: 'websites-local-seo', label: 'Websites & local visibility', title: 'Help customers find and choose you.',
    heading: 'Websites and local SEO built around your next customer',
    description: 'Make your services easier to discover, your work easier to trust, and your business easier to contact.',
    problem: 'Someone looking for a contractor needs to know what you do, where you work, and why they should trust you. A slow mobile page, vague service description, or buried quote form can stop that visit before it becomes an inquiry.',
    approach: 'We build responsive websites around the action that matters: requesting an estimate, making an appointment, or contacting your team. Search work starts with useful service information, accurate business details, technical SEO, and relevant local content. Google Business Profile and reputation workflows can be scoped alongside the site.',
    bullets: ['Custom websites and clear quote or booking paths', 'Local search content and technical SEO', 'Search and AI visibility built on useful, crawlable information'],
    example: 'Clifton Ave Animal Hospital’s site connects service information to IDEXX Vello booking. Stone Bellisimo pairs its project gallery with a guided estimate request. Both give visitors a concrete next step.',
    related: ['lead-recovery', 'revenue-tracking'],
    scope: 'Local targeting uses your actual service area. Rankings and inclusion in AI answers are not guaranteed; we agree on the content, technical work, and measurement for your scope.'
  },
  {
    key: 'ai', slug: 'ai-receptionists', label: 'AI receptionists', title: 'Answer around your business.',
    heading: 'Custom voice AI receptionists and AI phone agents',
    description: 'Answer inbound calls and website chats, qualify inquiries, connect calendars, and hand off to your team.',
    problem: 'Your team cannot always answer while helping a customer or working on site. Common questions and booking requests still need a useful response outside business hours.',
    approach: 'BiteSites configures AI receptionists around your services, approved answers, qualification questions, calendars, and escalation rules. Voice AI agents handle phone conversations; chat agents help website visitors. Try Byte and Bit on our homepage to experience the voice and chat channels.',
    bullets: ['Inbound phone and website chat assistance', 'Calendar and CRM integrations', 'Approved business answers and human handoff rules'],
    example: 'Byte and Bit are BiteSites’ own agents. They demonstrate service questions, lead capture, and booking tools. A client build is scoped around that business’s systems and rules, rather than assuming every business needs the same agent.',
    related: ['lead-recovery', 'follow-up-automation'],
    scope: 'Tool access, escalation, availability, and call handling are tested during setup. The agent identifies itself as AI and uses a human handoff when the request needs a person.'
  },
  {
    key: 'followup', slug: 'follow-up-automation', label: 'Follow-up & automation', title: 'Follow up without the busywork.',
    heading: 'Follow-up automation and CRM workflows for local businesses',
    description: 'Keep estimates, appointments, and customer conversations moving without relying on someone to remember every task.',
    problem: 'A good estimate can go quiet because the team is busy. Leads sit across forms, email, and spreadsheets, with nobody sure who should follow up next.',
    approach: 'We map your process and connect the tools your team uses. A form can create a CRM record, alert the right person, and schedule a follow-up task. Approved workflows can support estimate reminders, appointment reminders, and reactivation of eligible past inquiries.',
    bullets: ['CRM connections and automatic task routing', 'Estimate and appointment follow-up', 'Reactivation workflows for eligible existing contacts'],
    example: 'An open estimate can trigger a reminder for its owner, followed by an approved message when appropriate. Replies and opt-outs stop or change the sequence, and requests outside the workflow return to a person.',
    related: ['lead-recovery', 'revenue-tracking'],
    scope: 'Outreach requires the appropriate permission or legal basis. Consent, opt-outs, channel rules, timing, and industry requirements are reviewed before any workflow goes live.'
  },
  {
    key: 'tracking', slug: 'revenue-tracking', label: 'Tracking & attribution', title: 'Know what is actually working.',
    heading: 'Lead tracking and revenue attribution for local businesses',
    description: 'Connect your marketing activity to inquiries, appointments, customer outcomes, and revenue where the data is available.',
    problem: 'Traffic alone does not tell you whether a website is helping the business. If calls, forms, bookings, and closed jobs live in separate systems, the owner cannot see where opportunities are lost.',
    approach: 'We define the outcomes you need to measure and connect the relevant website events, lead records, and CRM stages. A practical report can show where an inquiry came from, whether it received a response, and what happened next.',
    bullets: ['Form, call, and booking conversion measurement', 'Lead source and CRM pipeline reporting', 'Revenue attribution when sales data can be connected'],
    example: 'A quote request can be linked to its marketing source and tracked through a scheduled consultation and a recorded sale. If sales data is unavailable, reporting should stop at the last verified stage rather than call an inquiry revenue.',
    related: ['websites-local-seo', 'follow-up-automation'],
    scope: 'Attribution depends on connected systems, data quality, privacy choices, and your team recording outcomes. We agree on what can be measured before promising a dashboard.'
  }
];

export const industries = ['Contractors & remodelers', 'Stone & countertop companies', 'HVAC, plumbing & electrical', 'Roofing & landscaping', 'Property services', 'Appointment-based businesses'];
