import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { submitLead } from '../lib/leads';
import { trackEvent } from '../lib/analytics';
import '../project-intake.css';
import { CustomIcon } from './CustomIcons';

// Custom service labels use the existing `other` + customAnswers.services lead
// contract, keeping the exact request readable in the lead and CRM notes.
const CUSTOM_PROJECT_SERVICE = 'Custom AI project';
const services = [
  ['web_development', 'Web development', 'A website that works as hard as you do.', 'web'],
  ['ai_automation', 'AI & automation', 'Smarter calls, faster follow-up, less busywork.', 'ai'],
  ['social_media_management', 'Social media', 'Show up consistently. Give people a reason to stay.', 'social'],
  [CUSTOM_PROJECT_SERVICE, 'Custom AI project', 'Something different? Let’s build around your idea.', 'custom']
];
const sizes = [
  ['solo', 'Just me', 'Solo / freelancer'],
  ['small', 'Small team', '2–10 people'],
  ['growing', 'Growing business', '11–50 people'],
  ['established', 'Established team', '51–200 people'],
  ['enterprise', 'Enterprise', '200+ people']
];
const timelines = [
  ['asap', 'As soon as possible', 'Ready to get moving'],
  ['2_4_weeks', '2–4 weeks', 'Let’s make a plan'],
  ['1_2_months', '1–2 months', 'Planning ahead'],
  ['flexible', 'Just exploring', 'Let’s talk possibilities']
];
const steps = [
  ['Services', 'What can we build for you?', 'Choose one or mix a few. We’ll connect the dots.'],
  ['Your business', 'Big ideas. Any size.', 'Tell us a little about the team we’ll be building for.'],
  ['Timeline', 'When should we get started?', 'A rough idea is all we need. We’ll confirm timing together.'],
  ['Your idea', 'What would a win look like?', 'More leads? Fewer missed calls? A fresh start? Tell us what matters.'],
  ['Let’s connect', 'Your next chapter starts here.', 'Check your project summary, then tell us how to reach you.']
];

const serviceIcons = { web: 'webdev', ai: 'automate', social: 'social', custom: 'chip' };

export default function ProjectIntake({ selectedServices, setSelectedServices }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [values, setValues] = useState({ businessSize: '', urgencyTag: '', businessName: '', roleInCompany: '', projectDetails: '', name: '', email: '', phone: '', preferredContactMethod: 'email' });
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const formRef = useRef(null);
  const headingRef = useRef(null);
  const interactedRef = useRef(false);
  const id = 'project-intake';
  const isCustomProject = selectedServices.includes(CUSTOM_PROJECT_SERVICE);

  useEffect(() => {
    if (interactedRef.current) headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      document.body.classList.toggle('project-intake-visible', entry.isIntersecting);
    });
    observer.observe(formRef.current);
    return () => { observer.disconnect(); document.body.classList.remove('project-intake-visible'); };
  }, []);

  function update(name, value) {
    setValues(current => ({ ...current, [name]: value }));
    setError('');
  }
  function moveTo(next) {
    if (sendingRef.current) return;
    interactedRef.current = true;
    setError('');
    setStep(next);
  }
  function fail(message, fieldName) {
    setError(message);
    formRef.current?.querySelector(`[name="${fieldName}"]`)?.focus();
    trackEvent('form_error', { label: 'Start your project', step: steps[step][0], reason: 'validation' });
  }
  async function advance(event) {
    event.preventDefault();
    if (sendingRef.current) return;
    if (step === 0 && !selectedServices.length) return fail('Choose at least one service to continue.', 'services');
    if (step === 1 && !values.businessSize) return fail('Choose your business size to continue.', 'businessSize');
    if (step === 2 && !values.urgencyTag) return fail('Choose a timeline, or select “Just exploring”.', 'urgencyTag');
    if (step < steps.length - 1) return moveTo(step + 1);
    if (!values.name.trim()) return fail('Please enter your name.', 'name');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email.trim())) return fail('Please enter a valid email address.', 'email');
    if (values.preferredContactMethod === 'phone' && !values.phone.trim()) return fail('Please include a phone number so we can call you.', 'phone');
    // A ref guards the request immediately, including rapid clicks before React renders.
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      const leadId = await submitLead({ ...values, services: selectedServices }, 'intake_form');
      trackEvent('lead_created', { label: 'Start your project', leadId, source: 'intake_form' });
      trackEvent('form_submit', { label: 'Start your project', leadId, source: 'intake_form' });
      navigate('/thank-you?source=form', { replace: true });
    } catch (problem) {
      trackEvent('form_error', { label: 'Start your project', step: 'submit', reason: 'submission_failed' });
      setError(problem.message || 'We couldn’t send your request. Your answers are saved here. Please try again.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function field(name, label, { type = 'text', required = false, autoComplete, maxLength = 160, placeholder } = {}) {
    return <label className="project-field" htmlFor={`${id}-${name}`}>
      <span>{label}{!required && <small>Optional</small>}</span>
      <input id={`${id}-${name}`} name={name} type={type} required={required} autoComplete={autoComplete} maxLength={maxLength} placeholder={placeholder} value={values[name]} onChange={event => update(name, event.target.value)} />
    </label>;
  }
  function choices(options, name) {
    return <div className={`project-options project-options--${name}`}>
      {options.map(([value, label, description], index) => <label className="project-choice" key={value}>
        <input type="radio" name={name} value={value} checked={values[name] === value} onChange={() => update(name, value)} />
        <span className="project-choice-body"><span className="project-choice-number" aria-hidden="true">0{index + 1}</span><strong>{label}</strong><span className="project-choice-description">{description}</span><span className="project-check" aria-hidden="true">✓</span></span>
      </label>)}
    </div>;
  }
  const summary = [
    ['Services', services.filter(([value]) => selectedServices.includes(value)).map(([, label]) => label).join(', '), 0],
    ['Business', [values.businessName, sizes.find(([value]) => value === values.businessSize)?.[1]].filter(Boolean).join(' · '), 1],
    ['Timeline', timelines.find(([value]) => value === values.urgencyTag)?.[1], 2],
    ['Your idea', values.projectDetails || 'Let’s work it out together.', 3]
  ];

  return <section className="project-intake" id="start" aria-labelledby={`${id}-title`}>
    <div className="wrap">
      <div className="project-intro">
        <div><p className="eyebrow gradient">Your free revenue leak audit</p><h2 id={`${id}-title`}>Find what’s missing. <span>Build what’s next.</span></h2></div>
        <p>A few quick questions.<br /> A clearer path to more customers.</p>
      </div>
      <noscript><p>To request your free audit or discuss a project, email <a href="mailto:jensy@bitesites.org">jensy@bitesites.org</a>. Enable JavaScript to use the guided form.</p></noscript>
      <form className="project-wizard" ref={formRef} onSubmit={advance} noValidate aria-busy={sending}>
        <nav className="project-progress" aria-label="Project steps">
          <ol>{steps.map(([label], index) => <li key={label} className={index < step ? 'is-complete' : index === step ? 'is-current' : ''}>
            <button type="button" onClick={() => moveTo(index)} disabled={index > step || sending} aria-current={index === step ? 'step' : undefined} aria-label={`Step ${index + 1}: ${label}${index < step ? ', edit answer' : ''}`}><span className="project-progress-dot" aria-hidden="true">{index < step ? '✓' : index + 1}</span><span>{label}</span></button>
          </li>)}</ol>
        </nav>
        <fieldset className="project-stage" disabled={sending} aria-labelledby={`${id}-question`} aria-describedby={error ? `${id}-error` : undefined}>
          <div className="project-step-heading">
            <p className="project-step-count" aria-live="polite">Step {step + 1} of {steps.length} · {steps[step][0]}</p>
            <h3 id={`${id}-question`} ref={headingRef} tabIndex={-1}>{step === 3 && isCustomProject ? 'What’s your custom AI idea?' : steps[step][1]}</h3>
            <p>{step === 3 && isCustomProject ? 'A custom tool, an AI product, or something entirely new. Tell us what you have in mind.' : steps[step][2]}</p>
          </div>
          {step === 0 && <div className="project-options project-options--services">
            {services.map(([value, label, description, icon]) => <label className={`project-choice project-service project-service--${icon}`} key={value}>
              <input type="checkbox" name="services" value={value} checked={selectedServices.includes(value)} onChange={() => { setSelectedServices(current => current.includes(value) ? current.filter(service => service !== value) : [...current, value]); setError(''); }} />
              <span className="project-choice-body"><span className="project-service-icon"><CustomIcon name={serviceIcons[icon]} /></span><strong>{label}</strong><span className="project-choice-description">{description}</span><span className="project-check" aria-hidden="true">✓</span></span>
            </label>)}
          </div>}
          {step === 1 && <>{choices(sizes, 'businessSize')}<div className="project-fields project-business-fields">{field('businessName', 'Business / company', { autoComplete: 'organization', placeholder: 'Your business name' })}{field('roleInCompany', 'Your role', { autoComplete: 'organization-title', placeholder: 'Founder, manager, big-idea person…' })}</div></>}
          {step === 2 && choices(timelines, 'urgencyTag')}
          {step === 3 && <label className="project-field project-idea" htmlFor={`${id}-idea`}><span>{isCustomProject ? 'Your custom AI idea' : 'Your project'} <small>Optional</small></span><textarea id={`${id}-idea`} name="projectDetails" rows={4} maxLength={5000} placeholder={isCustomProject ? 'What would you like to build? What problem should it solve, and what should it connect to?' : 'We’re looking to…'} value={values.projectDetails} onChange={event => update('projectDetails', event.target.value)} /><span className="project-field-hint">{isCustomProject ? 'An early idea is enough. We’ll help you shape the scope.' : 'Still figuring it out? That’s a perfectly good place to start.'}</span></label>}
          {step === 4 && <div className="project-final-grid">
            <aside className="project-summary" aria-label="Your project summary"><h4>Your project, at a glance.</h4><dl>{summary.map(([label, value, index]) => <div key={label}><dt>{label}<button type="button" onClick={() => moveTo(index)} aria-label={`Edit ${label.toLowerCase()}`}>Edit</button></dt><dd>{value}</dd></div>)}</dl></aside>
            <div><div className="project-fields">{field('name', 'Name', { required: true, autoComplete: 'name', maxLength: 120 })}{field('email', 'Email', { type: 'email', required: true, autoComplete: 'email', maxLength: 200 })}</div>{field('phone', 'Phone', { type: 'tel', required: values.preferredContactMethod === 'phone', autoComplete: 'tel', maxLength: 40 })}<fieldset className="project-contact"><legend>How should we reach you?</legend><label><input type="radio" name="preferredContactMethod" value="email" checked={values.preferredContactMethod === 'email'} onChange={() => update('preferredContactMethod', 'email')} /> Email</label><label><input type="radio" name="preferredContactMethod" value="phone" checked={values.preferredContactMethod === 'phone'} onChange={() => update('preferredContactMethod', 'phone')} /> Phone</label></fieldset><p className="project-privacy">We’ll use these details to follow up on your project. <a href="/privacy" target="_blank" rel="noreferrer">Privacy policy<span className="project-sr-only"> (opens in a new tab)</span></a>.</p></div>
          </div>}
        </fieldset>
        {error && <p className="project-error" id={`${id}-error`} role="alert">{error}</p>}
        <div className="project-actions">
          {step > 0 ? <button className="project-back" type="button" onClick={() => moveTo(step - 1)} disabled={sending}>← Back</button> : <span className="project-multiple-note">Select all that apply</span>}
          <button className="btn ai project-next" type="submit" disabled={sending}>{sending ? 'Sending your request…' : step === 4 ? 'Send my project' : step === 3 && !values.projectDetails.trim() ? 'Skip for now' : 'Continue'}</button>
        </div>
        <div className="project-form-footnote"><span>Built around your business.</span><a href="/faq">A few questions first? Read our FAQ</a></div>
      </form>
    </div>
  </section>;
}
