import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BitMascot } from './components/BitMascot';
import { InteractiveNebulaShader } from './components/InteractiveNebulaShader';
import './styles.css';
import './bit.css';

const logo = 'https://bitesites.org/_next/image?url=%2Fmainlogo2.png&w=3840&q=75';

const aiSolutions = [
  ['✦', 'AI Receptionists', 'A voice or chat agent that answers every call and message, books appointments, and routes real leads to your team — even after hours.'],
  ['ϟ', 'Custom AI Automation', 'Workflow builds connecting your CRM, forms, and inbox — so leads move automatically and nothing falls through the cracks.'],
  ['◉', 'Custom AI Projects', 'Purpose-built AI tools scoped to your business — from internal ops assistants to full custom systems, built end to end.']
];

const services = [
  { key: 'ai', badge: 'Lead service', title: 'AI Automation', text: 'We identify repetitive work across sales, marketing, and operations, then build AI-assisted workflows that move information faster.', bullets: ['Faster response times for new leads and requests', 'Less repetitive admin work across sales and ops', 'Cleaner handoffs between forms, inboxes, and systems'] },
  { key: 'web', title: 'Web Development', text: 'Websites that turn your online presence into a working sales asset, from strategy and UX to responsive development and launch support.', bullets: ['A stronger first impression that builds credibility', 'Clearer paths to consultations, quotes, or sales', 'Better speed, mobile experience, and search readiness'] },
  { key: 'social', title: 'Social Media Management', text: 'Content planning, publishing, and reporting that keeps your brand active and consistent.', bullets: ['A consistent publishing cadence that keeps you visible', 'Stronger alignment between social, web, and campaigns', 'Higher-quality engagement from the right audience'] }
];

const projects = [
  { title: 'Nexus Verium', video: 'https://bitesites.org/portfolio/nexusverium.mp4', text: 'Restoration systems & environmental engineering — integrating AI and environmental science to heal ecosystems through the River Veins initiative.', bullets: ['River Veins monitoring network — floating AI wetlands, sensors, drones', 'Digital twin models of the Meadowlands for planning', 'Continuous AI-driven water quality analysis'], stack: ['Next.js', 'Tailwind CSS', 'Turbopack'], url: 'https://nexusverium.tech' },
  { title: "These Freakin' Empanadas & More", video: 'https://bitesites.org/portfolio/freakinempanadas.mp4', text: "Bold, crispy, freakin' delicious — a Wood-Ridge empanada hub built to sell hand-held flavor bombs and sandwiches online and in-store.", bullets: ['Full menu with classics, cannoli, spinach artichoke, and General Tso’s chicken', 'Combos and family packs built into ordering', 'Takeout, delivery, and Uber Eats integration'], stack: ['React', 'Tailwind CSS', 'Vite', 'Uber Eats API'], url: 'https://freakinempanadas.com' },
  { title: 'Rutgers Newark Bodega Project', video: 'https://bitesites.org/portfolio/BodegaProject.mp4', text: 'Sustainable food supply chains — a data-informed, hyperlocal network linking local farms and school gardens to Newark’s bodegas.', bullets: ['“Fast vs. Fresh Food” interactive map and KPI builder', 'Data visualization tools for research and community outreach', 'Promotes indoor vertical farming for year-round production'], stack: ['Vite', 'Chart.js', 'Leaflet', 'Mapbox'], url: 'https://jjimenez723.github.io/Bodega-Project-2' }
];

const prices = {
  web: [['Starter Site', 'A sharp single-page site for early-stage launches or service businesses that need credibility fast.', 'From $1,000', ['Single-page site', 'Responsive design', 'Basic SEO', 'One revision']], ['Growth Site', 'A stronger marketing site built around your offer, content, and lead flow.', 'From $2,500', ['Up to 7 pages', 'Conversion-focused UX', 'Analytics setup', 'Two revisions'], true], ['Custom Build', 'A flexible site for businesses with more complex content, integrations, or workflows.', 'Let’s talk', ['Custom architecture', 'Integrations', 'Advanced SEO', 'Ongoing support']]],
  social: [['Essential', 'A consistent publishing rhythm for one channel and a clear brand voice.', 'From $600/mo', ['Content calendar', '8 posts per month', 'Captions and scheduling', 'Monthly report']], ['Growth', 'A complete content engine built around campaigns and measurable goals.', 'From $1,200/mo', ['2 social channels', '16 posts per month', 'Community support', 'Strategy review'], true], ['Custom', 'Multi-channel management for brands with more volume, locations, or approvals.', 'Let’s talk', ['Custom cadence', 'Campaign support', 'Reporting dashboard', 'Creative direction']]],
  ai: [['Workflow Audit', 'Find the manual bottlenecks worth solving first.', 'From $750', ['Process mapping', 'Opportunity scorecard', 'Automation roadmap', 'Implementation plan']], ['Automation Build', 'Build and launch the highest-impact workflow for your team.', 'From $2,000', ['Workflow architecture', 'Tool integrations', 'AI-assisted steps', 'Testing and handoff'], true], ['Custom System', 'Purpose-built AI products and systems for complex operating needs.', 'Let’s talk', ['Custom AI workflow', 'Human review points', 'Documentation', 'Ongoing optimization']]]
};

const detailCopy = {
  web: ['Web Development', 'We design and build websites that turn your online presence into a working sales asset.', ['Custom site architecture, design direction, and page planning', 'Responsive development for desktop, tablet, and mobile', 'Lead forms, CRM hooks, analytics, and conversion tracking', 'Performance, accessibility, and technical SEO foundations', 'CMS or editable sections for your team', 'Launch support, QA, and optimization recommendations']],
  social: ['Social Media Management', 'We manage the planning, production, and publishing rhythm behind your social channels so your brand stays visible and credible.', ['Monthly content planning tied to your priorities', 'Platform-specific post copy, creative direction, and scheduling', 'Brand voice guidance for consistency', 'Community management support', 'Performance reporting and recommendations', 'Coordination with website and campaign activity']],
  ai: ['AI Automation', 'We identify repetitive work across sales, marketing, and operations, then build AI-assisted workflows that reduce manual effort and move information faster.', ['Workflow mapping to identify high-friction tasks', 'Automation design for intake, lead routing, and alerts', 'AI-assisted summarization, categorization, and response support', 'Integrations across forms, email, CRM, and project systems', 'Fallback logic, QA, and human-review checkpoints', 'Documentation so your team can maintain the system']]
};

function Button({ children, variant = 'primary', href, ...props }) { return href ? <a className={`btn btn-${variant}`} href={href} {...props}>{children}</a> : <button className={`btn btn-${variant}`} {...props}>{children}</button>; }
function Eyebrow({ children, gradient = false }) { return <div className={`eyebrow ${gradient ? 'gradient' : ''}`}>{children}</div>; }
function SectionHead({ label, title, children, gradient = false }) { return <div className="section-head reveal"><Eyebrow gradient={gradient}>{label}</Eyebrow><h2>{title}</h2>{children && <p>{children}</p>}</div>; }

const receptionistQuestions = [
  { key: 'services', prompt: 'What would you most like to improve?', options: [['web_development', 'A website that brings in leads'], ['ai_automation', 'Lead response or team workflows'], ['social_media_management', 'Content and social visibility']] },
  { key: 'urgencyTag', prompt: 'When would you like to get started?', options: [['asap', 'As soon as possible'], ['2_4_weeks', 'Within 2–4 weeks'], ['1_2_months', 'In the next 1–2 months'], ['flexible', 'My timeline is flexible']] },
  { key: 'businessSize', prompt: 'How large is your team?', options: [['solo', 'Just me'], ['small', '2–10 people'], ['growing', '11–50 people'], ['established', '51–200 people'], ['enterprise', '200+ people']] }
];

const thinkingLines = [
  'Discombobulating the possibilities…',
  'Perplexing responsibly…',
  'Contemplating in several dimensions…',
  'Consulting the tiny committee in my circuits…',
  'Warming up the idea kiln…',
  'Doing a little digital chin-stroking…',
  'Connecting the delightfully odd dots…',
  'Rummaging through the good ideas drawer…',
  'Mulling it over with great enthusiasm…',
  'Cogitando con estilo…',
  'Réfléchissant à haute voix, mais en silence…',
  'Ein bisschen Gehirn-Yoga…',
  'Pondering the cosmic spreadsheet…',
  'Asking the pixels nicely…',
  'Brewing a fresh batch of useful thoughts…'
];

function AiReceptionist({ onClose, origin }) {
  const [step, setStep] = useState(-1);
  const [answers, setAnswers] = useState({});
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingLine, setThinkingLine] = useState(0);
  const bodyRef = useRef(null);
  const hasRenderedRef = useRef(false);
  const question = receptionistQuestions[step];

  useEffect(() => {
    const timer = window.setInterval(() => setThinkingLine(line => (line + 1) % thinkingLines.length), 1100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hasRenderedRef.current) {
      hasRenderedRef.current = true;
      bodyRef.current?.scrollTo({ top: 0 });
      return;
    }
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isThinking, step]);

  useLayoutEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') onClose(); };
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.setProperty('--bit-scrollbar-width', `${scrollbarWidth}px`);
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('bit-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('bit-open');
      document.body.style.removeProperty('--bit-scrollbar-width');
    };
  }, [onClose]);

  const advance = (value, label = value) => {
    const nextAnswers = { ...answers, [question.key]: value };
    setAnswers(nextAnswers);
    setMessages(current => [...current, { role: 'user', text: label }]);
    setStep(step + 1);
  };
  const choose = (value, label) => advance(value, label);
  const sendTypedAnswer = event => {
    event.preventDefault();
    const response = draft.trim();
    if (!response || !question || isThinking) return;
    setDraft('');
    setMessages(current => [...current, { role: 'user', text: response }]);
    setAnswers(current => ({ ...current, [question.key]: response }));
    setIsThinking(true);
    window.setTimeout(() => {
      setIsThinking(false);
      setStep(current => current + 1);
    }, 1800);
  };
  const submitReceptionistLead = async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = { ...answers, ...Object.fromEntries(data.entries()), services: [answers.services], preferredContactMethod: 'email' };
    setStatus({ text: 'Sending your project notes…', kind: '' });
    try {
      const response = await fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error);
      setStatus({ text: 'You’re all set. Our team will follow up shortly.', kind: 'success' });
    } catch (error) {
      setStatus({ text: error.message || 'Unable to send your request. Please try again.', kind: 'error' });
    }
  };
  const finishReveal = event => {
    if (event.target === event.currentTarget && event.animationName === 'bitReveal') event.currentTarget.classList.add('bit-ready');
  };

  return <aside className="bit-window" onAnimationEnd={finishReveal} style={{ '--bit-x': `${origin?.x ?? window.innerWidth - 58}px`, '--bit-y': `${origin?.y ?? window.innerHeight - 52}px` }} aria-labelledby="receptionist-title" role="dialog" aria-modal="true">
    <div className="bit-noise" aria-hidden="true" />
    <header className="bit-topbar"><a className="bit-wordmark" href="#top" onClick={onClose}>BiteSites<span>✦</span></a><div className="bit-agent"><span className="chat-presence" /> Bit is here</div><button type="button" className="bit-close" onClick={onClose} aria-label="Close Bit">Close <span>×</span></button></header>
    <div className="bit-stage" ref={bodyRef}>
      <div className="bit-intro">
        <div className="chat-avatar bit-avatar" aria-hidden="true"><BitMascot /></div>
        <p className="bit-kicker">Your BiteSites guide</p>
        <h2 id="receptionist-title">How can I help today?</h2>
        <p>Tell Bit what you’re building, or choose a quick starting point below.</p>
      </div>
      <div className="bit-conversation">
        {step === -1 && <div className="chat-bubble bit-bubble">Hi — I’m Bit, BiteSites’ mascot and AI receptionist. I’ll ask a few quick questions so our team can point you in the right direction.</div>}
        {messages.map((message, index) => <div className="bit-message user" key={`${message.text}-${index}`}>{message.text}</div>)}
        {question && <><div className="chat-bubble bit-bubble">{question.prompt}</div><div className="chat-options bit-options">{question.options.map(([value, label]) => <button type="button" key={value} disabled={isThinking} onClick={() => choose(value, label)}>{label}<span>→</span></button>)}</div><p className="chat-progress">Question {step + 1} of {receptionistQuestions.length}</p></>}
        {isThinking && <div className="bit-thinking" aria-live="polite"><span className="thinking-orb"><i /><i /><i /></span><span>{thinkingLines[thinkingLine]}</span></div>}
        {step === receptionistQuestions.length && <><div className="chat-bubble bit-bubble">Thanks — I have the essentials. Where should we send your tailored next step?</div><form className="chat-form bit-contact" onSubmit={submitReceptionistLead}><label>Name<input name="name" required autoComplete="name" /></label><label>Email<input name="email" type="email" required autoComplete="email" /></label><label>Phone <small>(optional)</small><input name="phone" type="tel" autoComplete="tel" /></label><label>Anything else we should know? <small>(optional)</small><textarea name="projectDetails" placeholder="A goal, challenge, or useful detail" /></label><button className="chat-submit" type="submit" disabled={status.kind === 'success'}>{status.kind === 'success' ? 'Request sent' : 'Send my project notes'}</button><p className={`form-status ${status.kind}`} aria-live="polite">{status.text}</p></form></>}
      </div>
    </div>
    {step === -1 ? <div className="bit-composer bit-start-row"><button className="chat-start bit-start" type="button" onClick={() => setStep(0)}>Start a quick project check-in <span>→</span></button><p className="chat-note">Takes about a minute. No pressure.</p></div> : question && <form className="bit-composer" onSubmit={sendTypedAnswer}><textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendTypedAnswer(event); } }} placeholder="Or type your own answer…" aria-label="Type your response to Bit" disabled={isThinking} rows="1" /><button className="bit-send" type="submit" disabled={!draft.trim() || isThinking} aria-label="Send message">↑</button><p>Press Enter to send <span>·</span> Shift + Enter for a new line</p></form>}
  </aside>;
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState('web');
  const [modal, setModal] = useState(null);
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [activeProject, setActiveProject] = useState(0);
  const [receptionistOpen, setReceptionistOpen] = useState(false);
  const [receptionistNudge, setReceptionistNudge] = useState(false);
  const [chatOrigin, setChatOrigin] = useState(null);
  const portfolioTrack = useRef(null);

  useEffect(() => {
    const header = document.querySelector('header');
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 12);
    window.addEventListener('scroll', onScroll, { passive: true });
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); } }), { threshold: .12 });
    document.querySelectorAll('.reveal').forEach(node => observer.observe(node));
    return () => { window.removeEventListener('scroll', onScroll); observer.disconnect(); };
  }, []);

  useEffect(() => {
    const nudgeTimer = window.setTimeout(() => setReceptionistNudge(true), 12000);
    return () => window.clearTimeout(nudgeTimer);
  }, []);

  const closeMenu = () => setMenuOpen(false);
  const openReceptionist = event => {
    const button = event?.currentTarget;
    const rect = button?.getBoundingClientRect();
    setChatOrigin(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
    setReceptionistNudge(false);
    setReceptionistOpen(true);
  };
  const showProject = index => {
    const track = portfolioTrack.current;
    const card = track?.children[index];
    if (!track || !card) return;
    track.scrollTo({ left: card.offsetLeft - track.offsetLeft, behavior: 'smooth' });
  };
  const handlePortfolioScroll = event => {
    const track = event.currentTarget;
    const cards = [...track.children];
    const center = track.scrollLeft + track.clientWidth / 2;
    const closest = cards.reduce((best, card, index) => Math.abs(card.offsetLeft + card.offsetWidth / 2 - center) < Math.abs(cards[best].offsetLeft + cards[best].offsetWidth / 2 - center) ? index : best, 0);
    setActiveProject(closest);
  };
  const submit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = Object.fromEntries(data.entries());
    payload.services = data.getAll('services');
    if (!payload.services.length) return setStatus({ text: 'Please select at least one service.', kind: 'error' });
    if (payload.preferredContactMethod === 'phone' && !payload.phone.trim()) return setStatus({ text: 'Please include a phone number if you prefer a phone call.', kind: 'error' });
    setStatus({ text: 'Sending…', kind: '' });
    try { const response = await fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error); form.reset(); setStatus({ text: 'Thanks — your project request has been received. We’ll be in touch soon.', kind: 'success' }); } catch (error) { setStatus({ text: error.message || 'Unable to submit the form. Please try again.', kind: 'error' }); }
  };

  return <>
    <header><nav><a href="#top" className="brand" onClick={closeMenu}><img src={logo} alt="BiteSites" /></a><div className={`navlinks ${menuOpen ? 'open' : ''}`}>{[['AI Receptionist','#ai-receptionist'],['Services','#services'],['Portfolio','#portfolio'],['Pricing','#pricing'],['About','#about'],['Consultation','#consultation']].map(([label, href]) => <a key={label} href={href} onClick={closeMenu}>{label}</a>)}</div><div className="navcta"><Button href="#start" variant="ai">Start Your Project</Button><button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">{menuOpen ? '×' : '☰'}</button></div></nav></header>
    <main id="top">
      <section className="hero"><div className="hero-bg"><InteractiveNebulaShader /><div className="hero-overlay" /></div><div className="wrap hero-content"><Eyebrow gradient>AI-powered digital solutions</Eyebrow><h1>Intelligence built<br />into your <span className="gradient-text">business.</span></h1><p className="lead">BiteSites helps businesses grow with websites, social media management, and AI automation that solves the work slowing your team down.</p><div className="hero-actions"><Button href="#start" variant="ai">Start Your Project</Button><Button href="#services" variant="ghost">Explore Services</Button></div><div className="hero-meta"><div><span>Web</span> development</div><div><span>Social</span> media management</div><div><span>AI</span> automation</div></div></div></section>
      <div className="strip"><div className="wrap"><span>Web Development</span><span>Social Media Management</span><span>AI Automation</span></div></div>
      <section className="pad" id="ai"><div className="wrap"><SectionHead label="Our focus" title="AI that actually runs your business." gradient>This is where we spend most of our time now — designing AI systems that answer the phone, qualify leads, and handle repetitive work, so your team doesn’t have to.</SectionHead><div className="ai-grid">{aiSolutions.map(([icon, title, text]) => <article className="ai-card reveal" key={title}><div className="ai-icon">{icon}</div><h3>{title}</h3><p>{text}</p></article>)}</div></div></section>
      <section className="receptionist-section" id="ai-receptionist"><div className="wrap receptionist-grid"><div className="receptionist-copy reveal"><Eyebrow gradient>Meet Bit</Eyebrow><h2>Start with a conversation, not a complicated form.</h2><p>Bit is the BiteSites mascot and AI receptionist for project inquiries. He asks the right questions about your goals, timeline, and team, then sends your project details to the right BiteSites specialist.</p><ul><li>Quick project qualification, any time</li><li>Clear service recommendations based on your needs</li><li>A human follow-up with the right context already included</li></ul><Button variant="ai" onClick={openReceptionist}>Talk to Bit <span aria-hidden="true">→</span></Button></div><div className="receptionist-preview bit-preview reveal" aria-label="Bit, the BiteSites mascot"><BitMascot className="bit-preview-mascot" /><div className="preview-head"><span className="chat-presence" /> Bit is online</div><div className="preview-bubble">Hi! What are you hoping to improve?</div><div className="preview-choice">A website that brings in leads <span>→</span></div><div className="preview-choice">Lead response or team workflows <span>→</span></div><div className="preview-foot">Usually replies instantly <span>•</span> No pressure</div></div></div></section>
      <section className="pad alt" id="services"><div className="wrap"><SectionHead label="What we do" title="Digital services built around growth, not filler.">Three connected service lines that help businesses build a stronger presence, reach the right people, and reduce the manual work holding growth back.</SectionHead><div className="services-grid">{services.map((service, index) => <article className={`service-card reveal ${index === 0 ? 'featured' : ''}`} key={service.key}>{service.badge && <span className="service-badge">{service.badge}</span>}<div className="service-icon">{['✦','□','↻'][index]}</div><h3>{service.title}</h3><p className="desc">{service.text}</p><ul>{service.bullets.map(item => <li key={item}>{item}</li>)}</ul><button className="text-link" onClick={() => setModal(service.key)}>Explore {service.title} →</button></article>)}</div><div className="segments reveal">{[['Small business','Build a credible online presence, stay visible, and reduce repetitive admin work without adding complexity.'],['Medium business','Connect campaigns, service lines, and internal workflows as growing volume creates more moving parts.'],['Large business','Coordinate more stakeholders and more complex processes without sacrificing speed.']].map(([title, text]) => <div className="segment" key={title}><div className="tag">{title}</div><p>{text}</p></div>)}</div></div></section>
      <section className="pad portfolio-section" id="portfolio"><div className="portfolio-wrap"><div className="portfolio-top wrap"><SectionHead label="Featured work" title="A curated look at what we’ve shipped.">Real projects for real businesses — crafted with precision, passion, and purpose. Scroll through the work, or use the controls to take a closer look.</SectionHead><div className="portfolio-controls reveal" aria-label="Portfolio controls"><button className="portfolio-arrow" type="button" onClick={() => showProject(Math.max(0, activeProject - 1))} disabled={activeProject === 0} aria-label="Previous project">←</button><button className="portfolio-arrow" type="button" onClick={() => showProject(Math.min(projects.length - 1, activeProject + 1))} disabled={activeProject === projects.length - 1} aria-label="Next project">→</button></div></div><div className="portfolio-viewport"><div className="portfolio-track" ref={portfolioTrack} onScroll={handlePortfolioScroll} tabIndex="0" aria-label="Featured projects. Scroll horizontally to browse.">{projects.map((project, index) => <article className={`project-card ${activeProject === index ? 'active' : ''}`} key={project.title}><div className="project-media"><span className="project-number">0{index + 1}</span><video autoPlay muted loop playsInline preload="metadata"><source src={project.video} type="video/mp4" /></video><div className="project-sheen" /></div><div className="project-body"><div className="project-kicker">Selected project</div><h3>{project.title}</h3><p className="desc">{project.text}</p><ul>{project.bullets.map(item => <li key={item}>{item}</li>)}</ul><div className="stack-pills">{project.stack.map(item => <span className="pill" key={item}>{item}</span>)}</div><a className="text-link blue" href={project.url} target="_blank" rel="noreferrer">Visit Website <span aria-hidden="true">↗</span></a></div></article>)}</div></div><div className="portfolio-footer wrap"><div className="portfolio-count"><span>0{activeProject + 1}</span><i /> <span>0{projects.length}</span></div><div className="portfolio-dots" role="tablist" aria-label="Choose project">{projects.map((project, index) => <button type="button" key={project.title} className={activeProject === index ? 'active' : ''} onClick={() => showProject(index)} aria-label={`View ${project.title}`} aria-selected={activeProject === index} role="tab" />)}</div><p>Drag or scroll to explore</p></div></div></section>
      <section className="pad alt" id="pricing"><div className="wrap"><SectionHead label="Pricing" title="Packages built to scale with you.">Compare scope quickly and move into the right engagement without guesswork. Custom quotes are available for hybrid or larger rollouts.</SectionHead><div className="tabbar reveal">{[['web','Web Development'],['social','Social Media'],['ai','AI Automation']].map(([key, label]) => <button className={`tabbtn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} key={key}>{label}</button>)}</div><div className="price-grid">{prices[tab].map(([title, desc, price, items, popular]) => <article className={`price-card reveal ${popular ? 'popular' : ''}`} key={title}>{popular && <span className="badge">Popular</span>}<h4>{title}</h4><p className="plandesc">{desc}</p><div className="price">{price}</div><div className="pricenote">{tab === 'social' ? 'monthly engagement' : 'project scope'}</div><ul>{items.map(item => <li key={item}>{item}</li>)}</ul><Button href="#start" variant="ghost">Start Project</Button></article>)}</div><p className="pricing-note">All packages are starting points. We’ll tailor scope to your goals, timeline, and existing tools.</p></div></section>
      <section className="pad" id="about"><div className="wrap"><SectionHead label="About BiteSites" title="Small team. Serious digital work.">We combine thoughtful design, practical engineering, and emerging AI tools to help businesses move forward.</SectionHead><div className="mission reveal"><p>We believe technology should make your business feel lighter — clearer systems, better experiences, and less work lost in the cracks.</p></div><div className="values-grid">{[['Passion for Excellence','Exceptional websites and systems that make a lasting impact.'],['Timely Delivery','We respect your time and deliver projects on schedule.'],['Open Communication','Transparent updates that keep you informed every step of the way.'],['Innovation','We explore new technologies and design trends to stay ahead.']].map(([title, text]) => <div className="value-item reveal" key={title}><h4>{title}</h4><p>{text}</p></div>)}</div></div></section>
      <section className="pad alt" id="consultation"><div className="wrap"><SectionHead label="Consultation" title="Let’s talk through what your business needs.">Tell us what you are trying to solve. We’ll recommend the right service direction and follow up to confirm a conversation.</SectionHead><div className="segments reveal" style={{ marginTop: 0 }}>{[['01 · Tell us what you need','Share your business, goals, preferred services, and the best way to contact you.'],['02 · We review the scope','We identify the right service mix and prepare practical next steps.'],['03 · We follow up','If the fit is right, we confirm the consultation details with you directly.']].map(([title, text]) => <div className="segment" key={title}><div className="tag">{title}</div><p>{text}</p></div>)}</div><div className="hero-actions reveal"><Button href="https://calendar.app.google/bKKKvGWBSgvV8rodA" variant="ai" target="_blank" rel="noreferrer">Schedule a free consultation</Button><Button href="#pricing" variant="ghost">See pricing</Button></div></div></section>
      <section className="intake" id="start"><div className="wrap intake-grid"><div className="section-head reveal"><Eyebrow gradient>Start your project</Eyebrow><h2>Tell us what you need.</h2><p>Use one form for web development, social media management, or AI automation. We only ask for the details needed to route your project and follow up.</p></div><form className="intake-form reveal" onSubmit={submit}><div className="form-row"><Field label="Name" name="name" required /><Field label="Email" name="email" type="email" required /></div><div className="form-row"><Field label="Phone (optional)" name="phone" type="tel" /><Field label="Business / Company (optional)" name="businessName" /></div><div className="form-row"><Field label="Role in company (optional)" name="roleInCompany" /><label className="field"><span>Business size</span><select name="businessSize" required defaultValue=""><option value="" disabled>Select size</option><option value="solo">Solo / Freelancer</option><option value="small">2-10 employees</option><option value="growing">11-50 employees</option><option value="established">51-200 employees</option><option value="enterprise">200+ employees</option></select></label></div><label className="field"><span>Timeline (optional)</span><select name="urgencyTag" defaultValue=""><option value="">No urgency selected</option><option value="asap">ASAP</option><option value="2_4_weeks">2-4 weeks</option><option value="1_2_months">1-2 months</option><option value="flexible">Flexible</option></select></label><fieldset className="field"><legend>Services <small>(select all that apply)</small></legend><div className="choices">{[['web_development','Web Development'],['social_media_management','Social Media Management'],['ai_automation','AI Automation']].map(([value, label]) => <label className="choice" key={value}><input type="checkbox" name="services" value={value} />{label}</label>)}</div></fieldset><fieldset className="field"><legend>Preferred contact method</legend><div className="choices"><label className="choice"><input type="radio" name="preferredContactMethod" value="email" defaultChecked />Email</label><label className="choice"><input type="radio" name="preferredContactMethod" value="phone" />Phone</label></div></fieldset><label className="field"><span>Project details</span><textarea name="projectDetails" placeholder="What are you looking to accomplish?" /></label><Button variant="ai" type="submit">Start Your Project</Button><p className={`form-status ${status.kind}`}>{status.text}</p></form></div></section>
      <section className="pad"><div className="wrap"><div className="cta-final reveal"><Eyebrow>Get started</Eyebrow><h2>Ready to build what is next?</h2><p>Tell us what you need, choose services, and let us know how you want to be contacted.</p><div className="hero-actions"><Button href="#start" variant="ai">Start Your Project</Button><Button href="#pricing" variant="ghost">View Pricing</Button></div></div></div></section>
    </main>
    <footer><div className="wrap footer-inner"><a href="#top" className="brand"><img src={logo} alt="BiteSites" /></a><div className="footer-links"><a href="#services">Services</a><a href="#about">About</a><a href="#pricing">Pricing</a><a href="#start">Start a Project</a></div><div className="footer-copy">© 2026 BiteSites. All rights reserved.</div></div></footer>
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><div className="detail-panel" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}><button className="close" onClick={() => setModal(null)} aria-label="Close">×</button><div className="detail-hero"><Eyebrow gradient={modal === 'ai'}>Services</Eyebrow><h2>{detailCopy[modal][0]}</h2><p>{detailCopy[modal][1]}</p></div><div className="detail-content"><h3>What’s included</h3><ul className="detail-list">{detailCopy[modal][2].map(item => <li key={item}>{item}</li>)}</ul><div className="hero-actions"><Button href="#start" variant="ai" onClick={() => setModal(null)}>Start Your Project</Button><Button href="#pricing" variant="ghost" onClick={() => setModal(null)}>See pricing</Button></div></div></div></div>}
    {receptionistOpen && <AiReceptionist origin={chatOrigin} onClose={() => setReceptionistOpen(false)} />}
    {!receptionistOpen && <div className={`chat-launcher ${receptionistNudge ? 'nudged' : ''}`}><p>Need help scoping a project?</p><button type="button" onClick={openReceptionist} aria-label="Open Bit, the AI receptionist"><BitMascot className="bit-launcher-avatar" /><em>Chat with Bit</em></button></div>}
  </>;
}

function Field({ label, name, type = 'text', required = false }) { return <label className="field"><span>{label}</span><input name={name} type={type} required={required} /></label>; }

createRoot(document.getElementById('root')).render(<App />);
