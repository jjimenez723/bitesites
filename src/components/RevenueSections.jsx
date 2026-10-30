import React, { useState } from 'react';
import { revenueSteps, industries } from '../content/revenue';
import HoloCard, { RevenueIcon } from './HoloCard';

const stepLooks = [
  ['blue', 'search', 'websites-local-seo'], ['violet', 'capture', 'websites-local-seo'],
  ['teal', 'respond', 'lead-recovery'], ['rose', 'followup', 'follow-up-automation'],
  ['blue', 'booking', 'ai-receptionists'], ['violet', 'tracking', 'revenue-tracking'],
];

const recoverySteps = [
  ['Customer calls', 'It starts with a real person.', 'A customer reaches out while your team is busy, on another call, or away for the day.'],
  ['Answered or missed', 'Give every call a next step.', 'Route the call to your team or a configured receptionist, with a recovery path when nobody is available.'],
  ['Response', 'Keep the conversation moving.', 'Use an approved response channel to acknowledge the inquiry and help the customer take the next step.'],
  ['Qualification', 'Get the details that matter.', 'Collect the service needed, location, timing, and the questions your team needs answered.'],
  ['Team alert', 'Bring the right person in.', 'Send the inquiry and its context to the person responsible, so your team can pick up the conversation.'],
  ['Follow-up', 'Give good inquiries attention.', 'Set an appropriate next touch, with reminders, reply handling, and a clear handoff to your team.'],
  ['Booking', 'Turn interest into a next step.', 'Connect the customer with an appointment, estimate, or consultation based on your availability and process.'],
  ['Tracking', 'See where the journey leads.', 'Connect the inquiry, source, and outcome where your tools provide the data, so you can see what needs work.'],
];

export function RevenueSystem() {
  return <section className="pad revenue-system" id="system" aria-labelledby="system-heading"><div className="wrap">
    <div className="section-head"><div className="eyebrow gradient">From first search to the next job</div><h2 id="system-heading">One system. Six places revenue can be won or lost.</h2><p>A customer’s journey doesn’t end at your website. Connect every step between being discovered and getting the work.</p></div>
    <ol className="revenue-steps">{revenueSteps.map(([title, promise, text], i) => <li key={title}>
      <HoloCard as="a" className="system-card" tone={stepLooks[i][0]} href={`/services/${stepLooks[i][2]}`}>
        <div className="holo-card-top"><span className="revenue-number">0{i + 1}</span><span className="holo-icon"><RevenueIcon name={stepLooks[i][1]} /></span></div>
        <h3>{title}</h3><strong>{promise}</strong><p>{text}</p>
        <span className="holo-card-link">Explore this step <span aria-hidden="true">↗</span></span>
      </HoloCard>
    </li>)}</ol>
    <a className="btn btn-ai" href="#start">Audit my current system <span aria-hidden="true">↗</span></a>
  </div></section>;
}

export function LeadRecovery() {
  const [activeStep, setActiveStep] = useState(0);
  return <section className="pad recovery-section" id="lead-recovery" aria-labelledby="recovery-heading"><div className="wrap recovery-layout">
    <div><div className="eyebrow">The lead you already paid for matters most</div><h2 id="recovery-heading">What happens when nobody answers?</h2><p>A missed call. A form left waiting. An estimate with no next step. We build the response and follow-up layer that helps your team turn existing interest into a real conversation.</p><a className="btn btn-ai" href="#start">Show me my lead leaks <span aria-hidden="true">↗</span></a></div>
    <div className="recovery-flow"><div className="recovery-flow-heading"><span className="recovery-orbit" aria-hidden="true"><RevenueIcon name="respond" /></span><div><p className="recovery-flow-label">A connected response, step by step</p><p>Choose a step to see how it works.</p></div></div>
      <ol>{recoverySteps.map(([step], i) => <li key={step}>
        <HoloCard as="button" type="button" className="recovery-step" tone={['blue', 'violet', 'teal', 'rose'][i % 4]} tiltMax={4}
          aria-pressed={activeStep === i} aria-controls="recovery-detail" onClick={() => setActiveStep(i)}>
          <span className="recovery-step-number">0{i + 1}</span><span className="recovery-step-name">{step}</span><span className="recovery-step-arrow" aria-hidden="true">↗</span>
        </HoloCard>
      </li>)}</ol>
      <div className="recovery-detail" id="recovery-detail" aria-live="polite" aria-atomic="true"><span className="recovery-detail-step">0{activeStep + 1} / 08 · {recoverySteps[activeStep][0]}</span><h3>{recoverySteps[activeStep][1]}</h3><p>{recoverySteps[activeStep][2]}</p></div>
      <p>Configured around your channels, availability, and team.</p>
    </div>
  </div></section>;
}

export function ExistingOpportunities() {
  return <section className="pad" id="ai"><div className="wrap reactivation-layout"><div><div className="eyebrow gradient">Follow-up & reactivation</div><h2>There may be revenue sitting in your existing database.</h2></div><div><p>Old estimates. Unanswered inquiries. Past customers who are ready for the next project. Give your team a clear view of who needs attention and an appropriate way to reconnect.</p><p>We can connect your CRM, reminders, and approved follow-up channels, with replies and human handoffs built into the process.</p><a className="text-link" href="/services/follow-up-automation">Explore follow-up automation →</a><p className="revenue-note">Outreach is scoped around appropriate consent or legal basis, opt-outs, and applicable phone, SMS, email, and industry requirements.</p></div></div></section>;
}

export function WhoWeHelp() {
  const details = [
    ['blue', 'home', 'Keep the next project moving, from the first inquiry to the estimate.'],
    ['violet', 'stone', 'Connect showroom inquiries, quote requests, and project follow-up.'],
    ['teal', 'tools', 'Help the next customer reach you while your crew is on the job.'],
    ['rose', 'leaf', 'Turn seasonal interest and open estimates into clear next steps.'],
    ['blue', 'property', 'Route service requests to the right person with the right details.'],
    ['violet', 'booking', 'Make it easier to inquire, book, and stay connected before a visit.'],
  ];
  return <section className="pad alt" id="industries"><div className="wrap"><div className="section-head"><div className="eyebrow gradient">Who we help</div><h2>Built for businesses where one lead can be worth thousands.</h2><p>Home services are a natural fit: you’re busy doing the work while the next customer is trying to reach you. The same connected approach works for other local and appointment-based businesses.</p></div><ul className="industry-list">{industries.map((name, i) => <li key={name}>
    <HoloCard as="a" href="#start" className="industry-card" tone={details[i][0]}>
      <span className="holo-icon"><RevenueIcon name={details[i][1]} /></span><h3>{name}</h3><p>{details[i][2]}</p><span className="holo-card-link">Find my opportunities <span aria-hidden="true">↗</span></span>
    </HoloCard>
  </li>)}</ul></div></section>;
}

export function AboutValues() {
  const values = [
    ['blue', 'search', 'Start with the problem', 'Find the missed opportunity before choosing the tool.', 'We look at how customers find you, reach you, and hear back from your team to identify the gap worth fixing first.'],
    ['violet', 'team', 'Build around your team', 'Connect the systems and workflows you actually use.', 'We shape the handoffs around your people, availability, and existing tools, with a clear place for human judgment.'],
    ['teal', 'clarity', 'Keep it clear', 'Agree on scope, ownership, costs, and next steps.', 'You should know what is being built, what it depends on, and what your team will manage before the work begins.'],
    ['rose', 'tracking', 'Measure what matters', 'Track real outcomes with the data available.', 'We connect inquiries and next steps where your tools allow it, and make the limits of that picture clear.'],
  ];
  return <div className="values-grid revenue-values">{values.map(([tone, icon, title, text, detail], i) =>
    <HoloCard as="details" className="value-item" tone={tone} key={title} tiltMax={3} hoverScale={1.015}>
      <summary><div className="holo-card-top"><span className="revenue-number">0{i + 1}</span><span className="holo-icon"><RevenueIcon name={icon} /></span></div><h3>{title}</h3><p>{text}</p><span className="value-toggle">Our approach <span aria-hidden="true">+</span></span></summary>
      <p className="value-detail">{detail}</p>
    </HoloCard>)}</div>;
}

export function MoreThanAWebsite() {
  return <div className="revenue-pricing-note"><div><h3>Need more than a website?</h3><p>Lead recovery, local visibility, AI receptionists, CRM workflows, and ongoing optimization are scoped around your business. Start with the most urgent gap, then build from there.</p></div><a className="btn btn-ai" href="/#start">Build my revenue system <span aria-hidden="true">↗</span></a></div>;
}
