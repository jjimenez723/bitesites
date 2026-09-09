import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { loadQuestionnaire, questionnaireErrorMessage, submitQuestionnaire } from '../lib/questionnaire';
import '../questionnaire.css';

const HELP = [
  ['website', 'Website / redesign', '⌁'], ['voice_ai', 'Voice AI / receptionist', '◌'],
  ['automation', 'Business automation', '↗'], ['lead_generation', 'Lead generation', '◎'],
  ['crm_followup', 'CRM / follow-up', '↻'], ['custom', 'Something custom', '✦'],
  ['not_sure', 'Not sure yet', '?']
];
const OBSTACLES = [
  ['not_enough_leads', 'Not enough leads'], ['low_conversion', "Leads aren't converting"],
  ['missed_calls', 'Missed calls'], ['slow_followup', 'Slow follow-up'],
  ['weak_website', "Website doesn't represent us"], ['manual_work', 'Too much manual work'],
  ['credibility', 'Need better online credibility'], ['disconnected_systems', "Systems don't talk"],
  ['other', 'Something else']
];
const WINS = [
  ['booked_appointments', 'More booked appointments'], ['qualified_leads', 'More qualified leads'],
  ['fewer_missed_calls', 'Fewer missed calls'], ['professional_website', 'A professional website'],
  ['automate_work', 'Automate repetitive work'], ['better_conversion', 'Improve conversion'],
  ['scale_team', 'Scale without adding staff'], ['other', 'Another outcome']
];
const TIMING = [
  ['asap', 'ASAP', 'Ready to move'], ['within_month', 'Within a month', 'Soon, with a little planning'],
  ['one_to_three_months', '1–3 months', 'Building toward it'], ['exploring', 'Just exploring', 'Learning what makes sense']
];
const empty = {
  helpWith: [], businessName: '', businessSummary: '', website: '', location: '',
  obstacles: [], obstacleDetails: '', wins: [], winDetails: '', timing: '', budget: '',
  links: [], anythingElse: ''
};
const ensureHttps = value => {
  const trimmed = String(value || '').trim();
  return trimmed && !/^https?:\/\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
};

function ChoiceGrid({ values, options, onChange, icons = false }) {
  const toggle = value => onChange(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  return <div className="q-choice-grid">{options.map(([value, label, icon]) => (
    <button key={value} type="button" className={values.includes(value) ? 'selected' : ''} onClick={() => toggle(value)} aria-pressed={values.includes(value)}>
      {icons && <span aria-hidden="true">{icon}</span>}<strong>{label}</strong><em aria-hidden="true">{values.includes(value) ? '✓' : '+'}</em>
    </button>
  ))}</div>;
}

export default function Questionnaire() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [state, setState] = useState('loading');
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const steps = 5;

  useEffect(() => {
    let active = true;
    loadQuestionnaire(token).then(data => {
      if (!active) return;
      if (data.status === 'completed') { setState('complete'); return; }
      setForm(current => ({ ...current, ...data.prefill }));
      setState('ready');
    }).catch(reason => {
      if (!active) return;
      setError(questionnaireErrorMessage(reason, 'This questionnaire link is invalid or expired.'));
      setState('error');
    });
    return () => { active = false; };
  }, [token]);

  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const progress = useMemo(() => `${Math.round(((step + 1) / steps) * 100)}%`, [step]);
  const validateStep = () => {
    if (step === 0 && !form.helpWith.length) return 'Choose at least one area.';
    if (step === 1 && (!form.businessName.trim() || !form.businessSummary.trim())) return 'Add your business name and the 60-second version.';
    if (step === 2 && !form.obstacles.length) return 'Choose at least one thing getting in the way.';
    if (step === 3 && (!form.wins.length || !form.timing)) return 'Choose a win and a rough timeline.';
    return '';
  };
  const next = () => {
    const problem = validateStep();
    if (problem) { setError(problem); return; }
    setError(''); setStep(value => Math.min(steps - 1, value + 1));
  };
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await submitQuestionnaire(token, {
        ...form,
        website: ensureHttps(form.website),
        links: form.links.filter(link => link.url.trim()).map(link => ({ ...link, url: ensureHttps(link.url) }))
      });
      setState('complete');
    } catch (reason) {
      setError(questionnaireErrorMessage(reason, 'We could not save this just yet. Please try again.'));
    } finally { setBusy(false); }
  };
  const addLink = () => update('links', [...form.links, { label: '', url: '' }]);
  const updateLink = (index, key, value) => update('links', form.links.map((link, item) => item === index ? { ...link, [key]: value } : link));

  if (state === 'loading') return <main className="q-page"><div className="q-shell q-status"><img src="/apple-touch-icon.png" alt="BiteSites" /><p>Getting your questions ready…</p></div></main>;
  if (state === 'error') return <main className="q-page"><div className="q-shell q-status"><img src="/apple-touch-icon.png" alt="BiteSites" /><span className="q-kicker">BiteSites discovery</span><h1>That link needs a refresh.</h1><p>{error}</p><a href="mailto:jensy@bitesites.org">Contact BiteSites</a></div></main>;
  if (state === 'complete') return <main className="q-page"><div className="q-shell q-complete"><div className="q-success">✓</div><span className="q-kicker">All done</span><h1>Perfect — now we can come prepared.</h1><p>Thanks for the context. We’ll use it to make the next conversation focused and useful.</p><div className="q-finish-actions"><Link className="primary" to="/book">Schedule a call</Link><Link to="/">Visit BiteSites</Link></div></div></main>;

  return <main className="q-page">
    <div className="q-shell">
      <header className="q-head"><Link to="/" aria-label="BiteSites home"><img src="/apple-touch-icon.png" alt="" /></Link><div><span className="q-kicker">Quick discovery</span><small>About 2–3 minutes</small></div></header>
      <div className="q-progress" aria-label={`Step ${step + 1} of ${steps}`}><span style={{ width: progress }} /></div>
      <div className="q-step-count">0{step + 1} <span>/ 0{steps}</span></div>

      {step === 0 && <section className="q-section"><h1>What are we helping you with?</h1><p>Pick everything that feels relevant. It’s fine if the answer is still fuzzy.</p><ChoiceGrid values={form.helpWith} options={HELP} icons onChange={value => update('helpWith', value)} /></section>}
      {step === 1 && <section className="q-section"><h1>Give us the 60-second version.</h1><p>Just enough context to keep us from asking you things we should already know.</p><div className="q-fields"><label><span>Business name</span><input autoFocus value={form.businessName} onChange={event => update('businessName', event.target.value)} placeholder="Acme Studio" maxLength="160" /></label><label><span>What does the business do?</span><textarea value={form.businessSummary} onChange={event => update('businessSummary', event.target.value)} placeholder="We help…" maxLength="700" rows="4" /></label><div className="q-field-row"><label><span>Website <em>optional</em></span><input type="text" inputMode="url" value={form.website} onChange={event => update('website', event.target.value)} placeholder="yourbusiness.com" /></label><label><span>Location / service area <em>optional</em></span><input value={form.location} onChange={event => update('location', event.target.value)} placeholder="North Jersey" maxLength="180" /></label></div></div></section>}
      {step === 2 && <section className="q-section"><h1>What’s getting in the way right now?</h1><p>Choose the friction you feel most. No need for a perfect diagnosis.</p><ChoiceGrid values={form.obstacles} options={OBSTACLES} onChange={value => update('obstacles', value)} /><label className="q-optional"><span>Anything worth adding? <em>optional</em></span><textarea value={form.obstacleDetails} onChange={event => update('obstacleDetails', event.target.value)} maxLength="700" rows="3" placeholder="A quick example or bit of context…" /></label></section>}
      {step === 3 && <section className="q-section"><h1>What would make this a win?</h1><p>Pick the outcomes that would actually matter to the business.</p><ChoiceGrid values={form.wins} options={WINS} onChange={value => update('wins', value)} /><h2>When would you like to make progress?</h2><div className="q-timing">{TIMING.map(([value, label, description]) => <button key={value} type="button" className={form.timing === value ? 'selected' : ''} onClick={() => update('timing', value)}><strong>{label}</strong><small>{description}</small></button>)}</div><label className="q-optional compact"><span>Budget range <em>optional</em></span><select value={form.budget} onChange={event => update('budget', event.target.value)}><option value="">Not sure yet</option><option value="under_2k">Under $2k</option><option value="2k_5k">$2k–$5k</option><option value="5k_10k">$5k–$10k</option><option value="10k_plus">$10k+</option></select></label></section>}
      {step === 4 && <section className="q-section"><h1>Anything we should see?</h1><p>Share references, competitors, social profiles, or anything else that would help us understand the picture.</p><div className="q-links">{form.links.map((link, index) => <div className="q-link-row" key={index}><input aria-label={`Link ${index + 1} label`} value={link.label} onChange={event => updateLink(index, 'label', event.target.value)} placeholder="Competitor, Instagram, reference…" maxLength="80" /><input aria-label={`Link ${index + 1} URL`} value={link.url} onChange={event => updateLink(index, 'url', event.target.value)} placeholder="https://…" inputMode="url" /><button type="button" onClick={() => update('links', form.links.filter((_, item) => item !== index))} aria-label={`Remove link ${index + 1}`}>×</button></div>)}</div>{form.links.length < 6 && <button className="q-add-link" type="button" onClick={addLink}>+ Add a link</button>}<label className="q-optional"><span>Anything else? <em>optional</em></span><textarea value={form.anythingElse} onChange={event => update('anythingElse', event.target.value)} maxLength="1200" rows="4" placeholder="Constraints, ideas, a wild thought — all useful." /></label></section>}

      {error && <p className="q-error" role="alert">{error}</p>}
      <footer className="q-nav">{step > 0 ? <button type="button" className="back" onClick={() => { setError(''); setStep(value => value - 1); }}>← Back</button> : <span />}{step < steps - 1 ? <button type="button" className="next" onClick={next}>Continue <span>→</span></button> : <button type="button" className="next" disabled={busy} onClick={submit}>{busy ? 'Sending…' : 'Send to BiteSites'} <span>→</span></button>}</footer>
    </div>
  </main>;
}
