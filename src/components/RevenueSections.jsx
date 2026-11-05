import React from 'react';
import { revenueSteps, industries } from '../content/revenue';
import HoloCard from './HoloCard';
import { CustomIcon } from './CustomIcons';

// Short service tags keep the key search terms visible without a paragraph per tile.
const stepTags = [
  ['Websites', 'Local SEO'], ['Quote forms', 'Booking paths'], ['Missed-call recovery', 'AI receptionists'],
  ['Estimate reminders', 'CRM workflows'], ['Calendars', 'Team handoffs'], ['Lead sources', 'Revenue attribution'],
];

const stepLooks = [
  ['blue', 'found', 'websites-local-seo'], ['violet', 'capture', 'websites-local-seo'],
  ['teal', 'respond', 'lead-recovery'], ['rose', 'followup', 'follow-up-automation'],
  ['blue', 'book', 'ai-receptionists'], ['violet', 'track', 'revenue-tracking'],
];

// Four plain steps instead of an eight-step explainer: the service pages carry the detail.
const recoveryFlow = [
  ['incoming', 'A call or form comes in'],
  ['fast', 'Answered, or followed up fast'],
  ['qualified', 'Qualified and sent to your team'],
  ['booked', 'Booked and tracked'],
];

export function RevenueSystem() {
  return <section className="pad revenue-system" id="system" aria-labelledby="system-heading"><div className="wrap">
    <div className="section-head refresh-head"><div className="eyebrow gradient">From first search to the next job</div><h2 id="system-heading">One system. Six places revenue can be won or lost.</h2><p>Connect every step between being found and getting the job.</p></div>
    <ol className="revenue-steps">{revenueSteps.map(([title, promise, text], i) => <li key={title}>
      <HoloCard as="a" className="system-card" tone={stepLooks[i][0]} href={`/services/${stepLooks[i][2]}`} aria-label={`${title}: ${promise} ${text}`}>
        <span className="system-card-top"><span className="system-card-icon"><CustomIcon name={stepLooks[i][1]} /></span><span className="system-card-number" aria-hidden="true">0{i + 1}</span></span>
        <h3>{title}</h3><strong>{promise}</strong>
        <span className="system-card-tags">{stepTags[i].map(tag => <span key={tag}>{tag}</span>)}</span>
      </HoloCard>
    </li>)}</ol>
    <a className="btn btn-ai" href="/#start">Audit my current system</a>
  </div></section>;
}

export function LeadRecovery() {
  return <section className="pad recovery-section" id="lead-recovery" aria-labelledby="recovery-heading"><div className="wrap recovery-layout">
    <div><div className="eyebrow">The lead you already paid for</div><h2 id="recovery-heading">What happens when nobody answers?</h2><p>Missed calls and quiet forms are lost jobs. We catch them.</p><a className="btn btn-ai" href="#start">Show me my lead leaks</a></div>
    <ol className="recovery-path" aria-label="How a missed lead gets recovered">{recoveryFlow.map(([icon, label], i) =>
      <li key={label} data-tone={['blue', 'violet', 'teal', 'rose'][i]}>
        <span className="recovery-path-icon" aria-hidden="true"><CustomIcon name={icon} /></span>
        <span className="recovery-path-number" aria-hidden="true">0{i + 1}</span>
        <span className="recovery-path-label">{label}</span>
      </li>)}</ol>
  </div></section>;
}

export function ExistingOpportunities() {
  const sources = [['estimate', 'Old estimates'], ['mailbox', 'Unanswered inquiries'], ['returning', 'Past customers']];
  return <section className="pad reactivation-section" id="ai" aria-labelledby="reactivation-heading"><div className="wrap reactivation-layout">
    <div><div className="eyebrow">Follow-up & reactivation</div><h2 id="reactivation-heading">There may be revenue sitting in your existing database.</h2><p>We help your team see who needs attention and reconnect the right way.</p><a className="btn btn-light" href="/services/follow-up-automation">Explore follow-up automation</a></div>
    <div><ul className="reactivation-sources">{sources.map(([icon, label]) => <li key={label}><span aria-hidden="true"><CustomIcon name={icon} /></span>{label}</li>)}</ul>
      <p className="revenue-note">Outreach follows consent, opt-out, and phone, SMS, and email rules.</p></div>
  </div></section>;
}

export function WhoWeHelp() {
  const looks = [['blue', 'contractors'], ['violet', 'stone'], ['teal', 'trades'], ['rose', 'roofing'], ['blue', 'property'], ['violet', 'appointments']];
  return <section className="pad alt" id="industries"><div className="wrap"><div className="section-head refresh-head"><div className="eyebrow gradient">Who we help</div><h2>Built for businesses where one lead can be worth thousands.</h2><p>Home services and local businesses where every missed call costs real money.</p></div><ul className="industry-list">{industries.map((name, i) => <li key={name}>
    <HoloCard as="a" href="/#start" className="industry-card" tone={looks[i][0]}>
      <span className="holo-icon"><CustomIcon name={looks[i][1]} /></span><h3>{name}</h3>
    </HoloCard>
  </li>)}</ul></div></section>;
}

export function AboutValues() {
  const values = [
    ['blue', 'diagnose', 'Start with the problem', 'Find the missed opportunity before choosing the tool.', 'We look at how customers find you, reach you, and hear back from your team to identify the gap worth fixing first.'],
    ['violet', 'team', 'Build around your team', 'Connect the systems and workflows you actually use.', 'We shape the handoffs around your people, availability, and existing tools, with a clear place for human judgment.'],
    ['teal', 'clear', 'Keep it clear', 'Agree on scope, ownership, costs, and next steps.', 'You should know what is being built, what it depends on, and what your team will manage before the work begins.'],
    ['rose', 'gauge', 'Measure what matters', 'Track real outcomes with the data available.', 'We connect inquiries and next steps where your tools allow it, and make the limits of that picture clear.'],
  ];
  return <div className="values-grid revenue-values">{values.map(([tone, icon, title, text, detail], i) =>
    <HoloCard as="details" className="value-item" tone={tone} key={title} tiltMax={3} hoverScale={1.015}>
      <summary><div className="holo-card-top"><span className="revenue-number">0{i + 1}</span><span className="holo-icon"><CustomIcon name={icon} /></span></div><h3>{title}</h3><p>{text}</p><span className="value-toggle">Our approach <span aria-hidden="true">+</span></span></summary>
      <p className="value-detail">{detail}</p>
    </HoloCard>)}</div>;
}

export function MoreThanAWebsite() {
  return <div className="revenue-pricing-note"><div><h3>Need more than a website?</h3><p>Lead recovery, local visibility, AI receptionists, CRM workflows, and ongoing optimization are scoped around your business. Start with the most urgent gap, then build from there.</p></div><a className="btn btn-ai" href="/#start">Build my revenue system</a></div>;
}
