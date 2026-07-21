import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BitMascot } from './components/BitMascot';
import { InteractiveNebulaShader } from './components/InteractiveNebulaShader';
import { TeamSection } from './components/TeamSection';
import { VoiceAIReceptionist, VoiceReceptionistPreview } from './components/VoiceAIReceptionist';
import logoFull from './assets/bitesites-logo-full.webp';
import logoWordmark from './assets/bitesites-logo-wordmark.webp';
import logoMark from './assets/bitesites-logo-mark.webp';
import './styles.css';
import './service-colors.css';
import './bit.css';
import './typography.css';
import './portfolio.css';
import './pricing-badge.css';
import './team.css';
import './voice-receptionist.css';

const aiSolutions = [
  ['✦', 'AI Receptionists', 'A voice or chat agent that answers every call and message, books appointments, and routes real leads to your team — even after hours.'],
  ['ϟ', 'Custom AI Automation', 'Workflow builds connecting your CRM, forms, and inbox — so leads move automatically and nothing falls through the cracks.'],
  ['◉', 'Custom AI Projects', 'Purpose-built AI tools scoped to your business — from internal ops assistants to full custom systems, built end to end.']
];

const navigationItems = [['AI Receptionist','#ai-receptionist'],['Services','#services'],['Portfolio','#portfolio'],['Pricing','#pricing'],['About','#about'],['Team','#team'],['Consultation','#consultation']];

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
  social: [['Visibility Starter', 'Stay active, polished, and top of mind with content that makes your brand worth following.', 'From $600/mo', ['8 on-brand posts each month', 'Strategic content calendar', 'Captions written to drive action', 'Scheduling and performance insights']], ['Growth Engine', 'Turn social attention into trust, engagement, and a steady path toward your next customer.', 'From $1,200/mo', ['16 posts across 2 channels', 'Campaign-led content strategy', 'Audience and community engagement', 'Monthly growth recommendations'], true], ['Market Leader', 'Build an always-on multi-channel presence designed for bigger campaigns, teams, and ambitions.', 'Let’s talk', ['Custom high-volume cadence', 'Launch and campaign support', 'Executive-ready reporting', 'Creative direction and approvals']]],
  ai: [['Automation Opportunity Audit', 'Find the repetitive work costing your team time—and the fastest opportunities to eliminate it.', 'From $750', ['End-to-end process mapping', 'High-impact opportunity scorecard', 'ROI-focused automation roadmap', 'Clear implementation plan']], ['Lead Flow Automation', 'Capture, qualify, and route every opportunity faster so your team can focus on closing.', 'From $2,000', ['Custom workflow architecture', 'CRM, form, and inbox integrations', 'AI-assisted lead handling', 'Testing, training, and handoff'], true], ['AI Growth System', 'Build a custom AI-powered operating system around the way your business wins and grows.', 'Let’s talk', ['Purpose-built AI workflows', 'Reliable human review points', 'Team documentation and training', 'Ongoing performance optimization']]]
};

const detailCopy = {
  web: ['Web Development', 'We design and build websites that turn your online presence into a working sales asset.', ['Custom site architecture, design direction, and page planning', 'Responsive development for desktop, tablet, and mobile', 'Lead forms, CRM hooks, analytics, and conversion tracking', 'Performance, accessibility, and technical SEO foundations', 'CMS or editable sections for your team', 'Launch support, QA, and optimization recommendations']],
  social: ['Social Media Management', 'We manage the planning, production, and publishing rhythm behind your social channels so your brand stays visible and credible.', ['Monthly content planning tied to your priorities', 'Platform-specific post copy, creative direction, and scheduling', 'Brand voice guidance for consistency', 'Community management support', 'Performance reporting and recommendations', 'Coordination with website and campaign activity']],
  ai: ['AI Automation', 'We identify repetitive work across sales, marketing, and operations, then build AI-assisted workflows that reduce manual effort and move information faster.', ['Workflow mapping to identify high-friction tasks', 'Automation design for intake, lead routing, and alerts', 'AI-assisted summarization, categorization, and response support', 'Integrations across forms, email, CRM, and project systems', 'Fallback logic, QA, and human-review checkpoints', 'Documentation so your team can maintain the system']]
};

const smoothStep = (start, end, value) => {
  const progress = Math.min(1, Math.max(0, (value - start) / (end - start)));
  return progress * progress * (3 - 2 * progress);
};

const PORTFOLIO_SCRUB_DISTANCE = 2200;
const PORTFOLIO_VIDEO_START = .12;
const PORTFOLIO_VIDEO_END = .86;
const PORTFOLIO_DESCRIPTION_LEAD = 3.5;
const PORTFOLIO_EXIT_GESTURE_PAUSE = 650;

function Button({ children, variant = 'primary', href, ...props }) { return href ? <a className={`btn btn-${variant}`} href={href} {...props}>{children}</a> : <button className={`btn btn-${variant}`} {...props}>{children}</button>; }
function Eyebrow({ children, gradient = false }) { return <div className={`eyebrow ${gradient ? 'gradient' : ''}`}>{children}</div>; }
function SectionHead({ label, title, children, gradient = false }) { return <div className="section-head reveal"><Eyebrow gradient={gradient}>{label}</Eyebrow><h2>{title}</h2>{children && <p>{children}</p>}</div>; }

function MorphingLogo({ location = 'header', onClick }) {
  const logoRef = useRef(null);

  useEffect(() => {
    let frame = 0;
    const updateLogo = () => {
      frame = 0;
      const node = logoRef.current;
      if (!node) return;

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let rawProgress;
      if (location === 'header') {
        rawProgress = Math.min(1, Math.max(0, window.scrollY / Math.max(260, window.innerHeight * .34)));
      } else {
        const footer = node.closest('.site-footer');
        const footerTop = footer?.getBoundingClientRect().top ?? window.innerHeight;
        const travel = Math.min(300, Math.max(210, (footer?.offsetHeight ?? 280) * .8));
        rawProgress = Math.min(1, Math.max(0, (window.innerHeight - footerTop) / travel));
      }

      if (reducedMotion) rawProgress = location === 'header' ? (window.scrollY > 12 ? 1 : 0) : 1;
      const progress = smoothStep(0, 1, rawProgress);
      const compact = window.innerWidth <= 700;
      const startSize = location === 'footer' ? (compact ? 138 : 180) : (compact ? 124 : 158);
      const endSize = compact ? 54 : 62;
      const size = startSize + (endSize - startSize) * progress;
      const parent = node.parentElement;
      const parentStyle = parent ? window.getComputedStyle(parent) : null;
      const availableWidth = parent
        ? parent.clientWidth - parseFloat(parentStyle.paddingLeft || 0) - parseFloat(parentStyle.paddingRight || 0)
        : window.innerWidth;
      const shift = location === 'header' ? 0 : Math.max(0, (availableWidth - size) / 2) * (1 - progress);
      const firstMorph = smoothStep(.04, .5, progress);
      const secondMorph = smoothStep(.5, .96, progress);
      const container = node.closest(location === 'header' ? '.site-header' : '.site-footer');

      node.style.setProperty('--logo-size', `${size}px`);
      node.style.setProperty('--logo-shift', `${shift}px`);
      node.style.setProperty('--logo-full-opacity', String(1 - firstMorph));
      node.style.setProperty('--logo-wordmark-opacity', String(firstMorph * (1 - secondMorph)));
      node.style.setProperty('--logo-mark-opacity', String(secondMorph));
      node.style.setProperty('--logo-full-scale', String(1 - .04 * firstMorph));
      node.style.setProperty('--logo-wordmark-scale', String(.96 + .04 * firstMorph - .04 * secondMorph));
      node.style.setProperty('--logo-mark-scale', String(.96 + .04 * secondMorph));
      container?.style.setProperty('--logo-content-opacity', String(smoothStep(.2, .56, progress)));
      if (location === 'header') container?.style.setProperty('--nav-height', `${64 + (startSize + 18 - 64) * (1 - progress)}px`);
      container?.classList.toggle('logo-expanded', progress < .18);
    };
    const queueUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateLogo);
    };

    updateLogo();
    window.addEventListener('scroll', queueUpdate, { passive: true });
    window.addEventListener('resize', queueUpdate);
    return () => {
      window.removeEventListener('scroll', queueUpdate);
      window.removeEventListener('resize', queueUpdate);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [location]);

  return <a href="#top" className={`brand morph-logo morph-logo-${location}`} onClick={onClick} ref={logoRef} aria-label="BiteSites — back to top">
    <span className="morph-logo-stage" aria-hidden="true">
      <img className="morph-logo-full" src={logoFull} alt="" width="500" height="500" />
      <img className="morph-logo-wordmark" src={logoWordmark} alt="" width="500" height="500" />
      <img className="morph-logo-mark" src={logoMark} alt="" width="500" height="500" />
    </span>
  </a>;
}

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

function AiReceptionist({ onClose, origin, initialAnswer }) {
  const [step, setStep] = useState(initialAnswer ? 1 : -1);
  const [answers, setAnswers] = useState(() => initialAnswer ? { services: initialAnswer.value } : {});
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [messages, setMessages] = useState(() => initialAnswer ? [{ role: 'user', text: initialAnswer.label }] : []);
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
  const [voiceAgentOpen, setVoiceAgentOpen] = useState(false);
  const [voiceSectionVisible, setVoiceSectionVisible] = useState(false);
  const [receptionistNudge, setReceptionistNudge] = useState(false);
  const [chatOrigin, setChatOrigin] = useState(null);
  const [receptionistInitialAnswer, setReceptionistInitialAnswer] = useState(null);
  const [portfolioProgress, setPortfolioProgress] = useState(0);
  const [portfolioVideoDuration, setPortfolioVideoDuration] = useState(0);
  const [portfolioVideoTime, setPortfolioVideoTime] = useState(0);
  const portfolioTrack = useRef(null);
  const portfolioSection = useRef(null);
  const portfolioVideo = useRef(null);
  const portfolioProgressRef = useRef(0);
  const portfolioVideoDurationRef = useRef(0);
  const portfolioTargetTimeRef = useRef(0);
  const portfolioScrubFrameRef = useRef(0);
  const portfolioLastTimeUpdateRef = useRef(0);
  const portfolioExitReadyRef = useRef(false);
  const portfolioExitTimerRef = useRef(0);

  useEffect(() => {
    const header = document.querySelector('.site-header');
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

  useEffect(() => {
    const section = document.getElementById('ai-receptionist');
    if (!section) return undefined;
    const observer = new IntersectionObserver(([entry]) => setVoiceSectionVisible(entry.isIntersecting), { threshold: .12 });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (portfolioScrubFrameRef.current) window.cancelAnimationFrame(portfolioScrubFrameRef.current);
    if (portfolioExitTimerRef.current) window.clearTimeout(portfolioExitTimerRef.current);
  }, []);

  useEffect(() => {
    portfolioProgressRef.current = 0;
    portfolioTargetTimeRef.current = 0;
    portfolioVideoDurationRef.current = 0;
    portfolioLastTimeUpdateRef.current = 0;
    portfolioExitReadyRef.current = false;
    setPortfolioProgress(0);
    setPortfolioVideoDuration(0);
    setPortfolioVideoTime(0);
    if (portfolioScrubFrameRef.current) {
      window.cancelAnimationFrame(portfolioScrubFrameRef.current);
      portfolioScrubFrameRef.current = 0;
    }
    if (portfolioExitTimerRef.current) {
      window.clearTimeout(portfolioExitTimerRef.current);
      portfolioExitTimerRef.current = 0;
    }
  }, [activeProject]);

  const closeMenu = () => setMenuOpen(false);
  const openReceptionist = (event, initialAnswer = null) => {
    const button = event?.currentTarget;
    const rect = button?.getBoundingClientRect();
    setChatOrigin(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
    setReceptionistInitialAnswer(initialAnswer);
    setReceptionistNudge(false);
    setReceptionistOpen(true);
  };
  const closeReceptionist = () => {
    setReceptionistOpen(false);
    setReceptionistInitialAnswer(null);
  };
  const showProject = index => {
    const track = portfolioTrack.current;
    const card = track?.children[index];
    if (!track || !card) return;
    track.scrollTo({ left: card.offsetLeft + card.offsetWidth / 2 - track.clientWidth / 2, behavior: 'smooth' });
  };
  const handlePortfolioScroll = event => {
    const track = event.currentTarget;
    const cards = [...track.children];
    const center = track.scrollLeft + track.clientWidth / 2;
    const closest = cards.reduce((best, card, index) => Math.abs(card.offsetLeft + card.offsetWidth / 2 - center) < Math.abs(cards[best].offsetLeft + cards[best].offsetWidth / 2 - center) ? index : best, 0);
    setActiveProject(closest);
  };
  const scrubPortfolioVideoTo = targetTime => {
    portfolioTargetTimeRef.current = targetTime;
    if (portfolioScrubFrameRef.current) return;

    const tick = timestamp => {
      const video = portfolioVideo.current;
      if (!video) {
        portfolioScrubFrameRef.current = 0;
        return;
      }

      video.pause();
      const distance = portfolioTargetTimeRef.current - video.currentTime;
      if (Math.abs(distance) < .025) {
        video.currentTime = portfolioTargetTimeRef.current;
        setPortfolioVideoTime(video.currentTime);
        portfolioScrubFrameRef.current = 0;
        return;
      }

      video.currentTime += distance * .24;
      if (timestamp - portfolioLastTimeUpdateRef.current >= 50) {
        portfolioLastTimeUpdateRef.current = timestamp;
        setPortfolioVideoTime(video.currentTime);
      }
      portfolioScrubFrameRef.current = window.requestAnimationFrame(tick);
    };

    portfolioScrubFrameRef.current = window.requestAnimationFrame(tick);
  };
  const updatePortfolioScrubTarget = progress => {
    const duration = portfolioVideoDurationRef.current;
    if (!duration) return;
    const videoProgress = Math.min(1, Math.max(0, (progress - PORTFOLIO_VIDEO_START) / (PORTFOLIO_VIDEO_END - PORTFOLIO_VIDEO_START)));
    const targetTime = videoProgress * Math.max(0, duration - .04);
    scrubPortfolioVideoTo(targetTime);
  };
  const handlePortfolioMetadata = event => {
    const video = event.currentTarget;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    video.pause();
    video.currentTime = 0;
    portfolioVideoDurationRef.current = duration;
    portfolioTargetTimeRef.current = 0;
    setPortfolioVideoDuration(duration);
    setPortfolioVideoTime(0);
    updatePortfolioScrubTarget(portfolioProgressRef.current);
  };
  const waitForFreshPortfolioGesture = () => {
    portfolioExitReadyRef.current = false;
    if (portfolioExitTimerRef.current) window.clearTimeout(portfolioExitTimerRef.current);
    portfolioExitTimerRef.current = window.setTimeout(() => {
      portfolioExitReadyRef.current = true;
      portfolioExitTimerRef.current = 0;
    }, PORTFOLIO_EXIT_GESTURE_PAUSE);
  };
  const resetPortfolioDemo = (returnFocus = false) => {
    if (portfolioScrubFrameRef.current) {
      window.cancelAnimationFrame(portfolioScrubFrameRef.current);
      portfolioScrubFrameRef.current = 0;
    }
    const video = portfolioVideo.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    portfolioProgressRef.current = 0;
    portfolioTargetTimeRef.current = 0;
    portfolioLastTimeUpdateRef.current = 0;
    portfolioExitReadyRef.current = false;
    if (portfolioExitTimerRef.current) {
      window.clearTimeout(portfolioExitTimerRef.current);
      portfolioExitTimerRef.current = 0;
    }
    setPortfolioProgress(0);
    setPortfolioVideoTime(0);
    if (returnFocus) window.requestAnimationFrame(() => portfolioTrack.current?.focus({ preventScroll: true }));
  };
  const handlePortfolioInteractionWheel = event => {
    const horizontalIntent = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey;
    if (horizontalIntent) {
      const completedDemo = portfolioProgressRef.current >= PORTFOLIO_VIDEO_END && event.target.closest?.('.portfolio-demo');
      if (completedDemo) {
        event.preventDefault();
        const horizontalDelta = event.shiftKey ? event.deltaY : event.deltaX;
        resetPortfolioDemo();
        window.requestAnimationFrame(() => {
          if (portfolioTrack.current) portfolioTrack.current.scrollLeft += horizontalDelta;
        });
      }
      return;
    }

    const overActiveVideo = event.target.closest?.('.portfolio-project.active, .portfolio-demo');
    if (event.deltaY <= 0 || !overActiveVideo) {
      if (event.deltaY < 0 && portfolioScrubFrameRef.current) {
        window.cancelAnimationFrame(portfolioScrubFrameRef.current);
        portfolioScrubFrameRef.current = 0;
        const currentTime = portfolioVideo.current?.currentTime ?? 0;
        portfolioTargetTimeRef.current = currentTime;
        setPortfolioVideoTime(currentTime);
      }
      return;
    }
    if (portfolioProgressRef.current >= PORTFOLIO_VIDEO_END) {
      if (portfolioExitReadyRef.current) return;
      event.preventDefault();
      waitForFreshPortfolioGesture();
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    event.preventDefault();
    const deltaScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const nextProgress = Math.min(PORTFOLIO_VIDEO_END, portfolioProgressRef.current + (event.deltaY * deltaScale) / PORTFOLIO_SCRUB_DISTANCE);
    portfolioProgressRef.current = nextProgress;
    setPortfolioProgress(nextProgress);
    updatePortfolioScrubTarget(nextProgress);
    if (nextProgress >= PORTFOLIO_VIDEO_END) waitForFreshPortfolioGesture();
  };
  useEffect(() => {
    const section = portfolioSection.current;
    if (!section) return undefined;
    section.addEventListener('wheel', handlePortfolioInteractionWheel, { passive: false });
    return () => section.removeEventListener('wheel', handlePortfolioInteractionWheel);
  }, [activeProject]);
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

  const portfolioExpand = smoothStep(.01, .15, portfolioProgress);
  const portfolioCarousel = 1 - smoothStep(.025, .13, portfolioProgress);
  const portfolioStoryStart = Math.max(0, portfolioVideoDuration - PORTFOLIO_DESCRIPTION_LEAD);
  const portfolioStory = portfolioVideoDuration ? smoothStep(portfolioStoryStart, Math.min(portfolioVideoDuration, portfolioStoryStart + .7), portfolioVideoTime) : 0;
  const portfolioComplete = portfolioProgress >= PORTFOLIO_VIDEO_END;
  const portfolioExit = 0;

  return <>
    <header className="site-header"><nav><div className="nav-wing nav-wing-left">{navigationItems.slice(0, 4).map(([label, href]) => <a key={label} href={href}>{label}</a>)}</div><MorphingLogo onClick={closeMenu} /><div className="nav-wing nav-wing-right">{navigationItems.slice(4).map(([label, href]) => <a key={label} href={href}>{label}</a>)}<Button href="#start" variant="ai">Start Your Project</Button></div><button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">{menuOpen ? '×' : '☰'}</button><div className={`navlinks navlinks-mobile ${menuOpen ? 'open' : ''}`}>{navigationItems.map(([label, href]) => <a key={label} href={href} onClick={closeMenu}>{label}</a>)}<Button href="#start" variant="ai" onClick={closeMenu}>Start Your Project</Button></div></nav></header>
    <main id="top">
      <section className="hero"><div className="hero-bg"><InteractiveNebulaShader /><div className="hero-overlay" /></div><div className="wrap hero-content"><Eyebrow gradient>AI-powered digital solutions</Eyebrow><h1>Intelligence built<br />into your <span className="gradient-text">business.</span></h1><p className="lead">BiteSites builds Voice AI receptionists, websites, and automations that answer faster, capture more leads, and take repetitive work off your team.</p><div className="hero-actions"><Button href="#start" variant="ai">Start Your Project</Button><Button href="#ai-receptionist" variant="ghost">Try Our Voice AI</Button></div><div className="hero-meta"><div><span>Voice AI</span> receptionists</div><div><span>Web</span> development</div><div><span>AI</span> automation</div></div></div></section>
      <div className="strip"><div className="wrap"><span>Voice AI Receptionists</span><span>Web Development</span><span>AI Automation</span></div></div>
      <section className="voice-receptionist-section" id="ai-receptionist" aria-labelledby="voice-receptionist-heading">
        <div className="wrap">
          <div className="voice-receptionist-grid">
            <div className="voice-receptionist-copy reveal">
              <Eyebrow>Try our Voice AI receptionist</Eyebrow>
              <h2 id="voice-receptionist-heading">Meet Olivia. She knows Voice AI inside and out.</h2>
              <p>Talk with BiteSites’ AI receptionist about adding a Voice AI agent to your business. Olivia can explain how an AI phone agent answers calls, qualifies leads, books appointments, and follows up around the clock.</p>
              <ul>
                <li>Get answers tailored to your call volume, team, and goals</li>
                <li>Explore lead qualification, appointment booking, and CRM follow-up</li>
                <li>Hear the kind of natural voice experience your customers can receive</li>
              </ul>
              <div className="voice-receptionist-actions">
                <Button variant="ghost" onClick={() => setVoiceAgentOpen(true)}>Talk to Olivia <span aria-hidden="true">&nbsp;→</span></Button>
                <small>Interactive frontend preview. Your browser asks before using the microphone.</small>
              </div>
            </div>
            <div className="reveal"><VoiceReceptionistPreview onOpen={() => setVoiceAgentOpen(true)} /></div>
          </div>
          <div className="voice-seo-points reveal" aria-label="Voice AI receptionist questions and answers">
            <article><h3>What can a Voice AI receptionist do?</h3><p>A Voice AI receptionist can answer inbound calls, respond to common questions, qualify leads, book appointments, route callers, and update connected CRM workflows.</p></article>
            <article><h3>Can an AI phone agent work with my calendar and CRM?</h3><p>Yes. BiteSites can connect a custom AI phone agent with business calendars, qualification rules, and CRM follow-up workflows.</p></article>
            <article><h3>Is the Voice AI agent trained for my business?</h3><p>Yes. Each agent can be trained on your services, common questions, lead qualification criteria, appointment process, and human escalation rules.</p></article>
          </div>
        </div>
      </section>
      <section className="pad" id="ai"><div className="wrap"><SectionHead label="Our focus" title="AI that actually runs your business." gradient>This is where we spend most of our time now — designing AI systems that answer the phone, qualify leads, and handle repetitive work, so your team doesn’t have to.</SectionHead><div className="ai-grid">{aiSolutions.map(([icon, title, text]) => <article className="ai-card reveal" key={title}><div className="ai-icon">{icon}</div><h3>{title}</h3><p>{text}</p></article>)}</div></div></section>
      <section className="pad alt" id="services"><div className="wrap"><SectionHead label="What we do" title="Digital services built around growth, not filler.">Three connected service lines that help businesses build a stronger presence, reach the right people, and reduce the manual work holding growth back.</SectionHead><div className="services-grid">{services.map((service, index) => <article className={`service-card reveal ${service.key} ${index === 0 ? 'featured' : ''}`} key={service.key}>{service.badge && <span className="service-badge">{service.badge}</span>}<div className="service-icon">{['✦','□','↻'][index]}</div><h3>{service.title}</h3><p className="desc">{service.text}</p><ul>{service.bullets.map(item => <li key={item}>{item}</li>)}</ul><button className="text-link" onClick={() => setModal(service.key)}>Explore {service.title} →</button></article>)}</div><div className="segments reveal">{[['Small business','Build a credible online presence, stay visible, and reduce repetitive admin work without adding complexity.'],['Medium business','Connect campaigns, service lines, and internal workflows as growing volume creates more moving parts.'],['Large business','Coordinate more stakeholders and more complex processes without sacrificing speed.']].map(([title, text]) => <div className="segment" key={title}><div className="tag">{title}</div><p>{text}</p></div>)}</div></div></section>
      <section
        className={`portfolio-section ${portfolioProgress > .08 ? 'portfolio-demo-active' : ''} ${portfolioStory > .02 ? 'portfolio-story-visible' : ''}`}
        id="portfolio"
        ref={portfolioSection}
        style={{
          '--portfolio-expand': portfolioExpand,
          '--portfolio-carousel': portfolioCarousel,
          '--portfolio-story': portfolioStory,
          '--portfolio-exit': portfolioExit,
          '--portfolio-clip-y': `${27 * (1 - portfolioExpand)}%`,
          '--portfolio-clip-x': `${18 * (1 - portfolioExpand)}%`,
          '--portfolio-radius': `${28 * (1 - portfolioExpand)}px`,
          '--portfolio-stage-opacity': 1 - portfolioExit,
          '--portfolio-stage-scale': 1 - .08 * portfolioExit,
          '--portfolio-stage-radius': `${30 * portfolioExit}px`,
          '--portfolio-demo-opacity': smoothStep(.035, .16, portfolioProgress) * (1 - portfolioExit),
          '--portfolio-story-opacity': portfolioStory * (1 - portfolioExit),
          '--portfolio-story-y': `${42 * (1 - portfolioStory)}px`,
          '--portfolio-playback-opacity': Math.max(0, portfolioExpand - portfolioStory) * (1 - portfolioExit),
          '--portfolio-intro-y': `${-18 * (1 - portfolioCarousel)}px`,
          '--portfolio-rail-y': `${-24 * (1 - portfolioCarousel)}px`
        }}
      >
        <div className="portfolio-stage">
          <div className="portfolio-intro wrap" aria-hidden={portfolioProgress > .25}>
            <Eyebrow>Featured work</Eyebrow>
            <h2>Work worth stepping into.</h2>
            <p>Scroll sideways to choose a project. Scroll down over the selected demo to scrub through it.</p>
          </div>

          <div className="portfolio-rail" aria-hidden={portfolioProgress > .25}>
            <div
              className="portfolio-track"
              ref={portfolioTrack}
              onScroll={handlePortfolioScroll}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') showProject(Math.max(0, activeProject - 1));
                if (event.key === 'ArrowRight') showProject(Math.min(projects.length - 1, activeProject + 1));
              }}
              tabIndex="0"
              aria-label="Featured projects. Scroll left or right to browse; scroll down over the selected project to scrub its demo."
            >
              {projects.map((project, index) => <article className={`portfolio-project ${activeProject === index ? 'active' : ''}`} key={project.title}>
                <video autoPlay muted loop playsInline preload="metadata" aria-hidden="true"><source src={project.video} type="video/mp4" /></video>
                <div className="portfolio-project-shade" />
                <span className="project-number">0{index + 1}</span>
                <div className="portfolio-project-title"><span>Selected project</span><h3>{project.title}</h3></div>
              </article>)}
            </div>
          </div>

          <div className="portfolio-demo">
            <video key={projects[activeProject].video} ref={portfolioVideo} muted playsInline preload="auto" onLoadedMetadata={handlePortfolioMetadata} aria-label={`${projects[activeProject].title} project demo`} src={projects[activeProject].video} />
            <div className="portfolio-demo-vignette" />
            <div className="portfolio-playback" aria-hidden="true"><span /> Scroll to scrub</div>
            <button className={`portfolio-back ${portfolioComplete ? 'visible' : ''}`} type="button" onClick={() => resetPortfolioDemo(true)} tabIndex={portfolioComplete ? 0 : -1} aria-hidden={!portfolioComplete}>
              <span aria-hidden="true">←</span>
              <span>All projects<small>or scroll sideways</small></span>
            </button>
            <article className="portfolio-story" aria-hidden={portfolioStory < .02}>
              <div className="portfolio-story-heading">
                <span>0{activeProject + 1} / 0{projects.length}</span>
                <h3>{projects[activeProject].title}</h3>
              </div>
              <div className="portfolio-story-copy">
                <p>{projects[activeProject].text}</p>
                <ul>{projects[activeProject].bullets.map(item => <li key={item}>{item}</li>)}</ul>
                <div className="stack-pills">{projects[activeProject].stack.map(item => <span className="pill" key={item}>{item}</span>)}</div>
                <a href={projects[activeProject].url} target="_blank" rel="noreferrer" tabIndex={portfolioStory > .5 ? 0 : -1}>Visit the live project <span aria-hidden="true">↗</span></a>
              </div>
            </article>
          </div>

          <div className="portfolio-footer wrap" aria-hidden={portfolioProgress > .25}>
            <div className="portfolio-count"><span>0{activeProject + 1}</span><i /><span>0{projects.length}</span></div>
            <div className="portfolio-dots" role="tablist" aria-label="Choose project">{projects.map((project, index) => <button type="button" key={project.title} className={activeProject === index ? 'active' : ''} onClick={() => showProject(index)} aria-label={`View ${project.title}`} aria-selected={activeProject === index} role="tab" />)}</div>
            <p><span className="gesture-sideways">↔ Browse</span><span>↓ Scrub demo</span></p>
          </div>
        </div>
      </section>
      <section className="pad alt" id="pricing"><div className="wrap"><SectionHead label="Pricing" title="Choose your next growth move.">Clear starting points for stronger visibility, faster lead response, and less manual work. Choose a direction below and we’ll tailor it to your goals.</SectionHead><div className="tabbar reveal" role="tablist" aria-label="Pricing services">{[['web','Web Development'],['social','Social Media'],['ai','AI Automation']].map(([key, label]) => <button className={`tabbtn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} key={key} type="button" role="tab" aria-selected={tab === key} aria-controls="pricing-options">{label}</button>)}</div><div className="price-grid" id="pricing-options" role="tabpanel" aria-live="polite" aria-label={`${tab === 'web' ? 'Web Development' : tab === 'social' ? 'Social Media' : 'AI Automation'} packages`}>{prices[tab].map(([title, desc, price, items, popular], index) => <article className={`price-card pricing-card-enter ${popular ? 'popular' : ''}`} style={{ animationDelay: `${index * 70}ms` }} key={title}>{popular && <span className="badge">Most Popular</span>}<h4>{title}</h4><p className="plandesc">{desc}</p><div className="price">{price}</div><div className="pricenote">{tab === 'social' ? 'monthly engagement' : 'project scope'}</div><ul>{items.map(item => <li key={item}>{item}</li>)}</ul><Button href="#start" variant={popular ? 'ai' : 'ghost'}>Grow My Business</Button></article>)}</div><p className="pricing-note">Every package is a starting point. We’ll shape the scope around your goals, timeline, and current tools.</p></div></section>
      <section className="pad" id="about"><div className="wrap"><SectionHead label="About BiteSites" title="Small team. Serious digital work.">We combine thoughtful design, practical engineering, and emerging AI tools to help businesses move forward.</SectionHead><div className="mission reveal"><p>We believe technology should make your business feel lighter — clearer systems, better experiences, and less work lost in the cracks.</p></div><div className="values-grid">{[['Passion for Excellence','Exceptional websites and systems that make a lasting impact.'],['Timely Delivery','We respect your time and deliver projects on schedule.'],['Open Communication','Transparent updates that keep you informed every step of the way.'],['Innovation','We explore new technologies and design trends to stay ahead.']].map(([title, text]) => <div className="value-item reveal" key={title}><h4>{title}</h4><p>{text}</p></div>)}</div></div></section>
      <TeamSection />
      <section className="pad alt" id="consultation"><div className="wrap"><SectionHead label="Consultation" title="Let’s talk through what your business needs.">Tell us what you are trying to solve. We’ll recommend the right service direction and follow up to confirm a conversation.</SectionHead><div className="segments reveal" style={{ marginTop: 0 }}>{[['01 · Tell us what you need','Share your business, goals, preferred services, and the best way to contact you.'],['02 · We review the scope','We identify the right service mix and prepare practical next steps.'],['03 · We follow up','If the fit is right, we confirm the consultation details with you directly.']].map(([title, text]) => <div className="segment" key={title}><div className="tag">{title}</div><p>{text}</p></div>)}</div><div className="hero-actions reveal"><Button href="https://calendar.app.google/bKKKvGWBSgvV8rodA" variant="ai" target="_blank" rel="noreferrer">Schedule a free consultation</Button><Button href="#pricing" variant="ghost">See pricing</Button></div></div></section>
      <section className="intake" id="start"><div className="wrap intake-grid"><div className="section-head reveal"><Eyebrow gradient>Start your project</Eyebrow><h2>Tell us what you need.</h2><p>Use one form for web development, social media management, or AI automation. We only ask for the details needed to route your project and follow up.</p></div><form className="intake-form reveal" onSubmit={submit}><div className="form-row"><Field label="Name" name="name" required /><Field label="Email" name="email" type="email" required /></div><div className="form-row"><Field label="Phone (optional)" name="phone" type="tel" /><Field label="Business / Company (optional)" name="businessName" /></div><div className="form-row"><Field label="Role in company (optional)" name="roleInCompany" /><label className="field"><span>Business size</span><select name="businessSize" required defaultValue=""><option value="" disabled>Select size</option><option value="solo">Solo / Freelancer</option><option value="small">2-10 employees</option><option value="growing">11-50 employees</option><option value="established">51-200 employees</option><option value="enterprise">200+ employees</option></select></label></div><label className="field"><span>Timeline (optional)</span><select name="urgencyTag" defaultValue=""><option value="">No urgency selected</option><option value="asap">ASAP</option><option value="2_4_weeks">2-4 weeks</option><option value="1_2_months">1-2 months</option><option value="flexible">Flexible</option></select></label><fieldset className="field"><legend>Services <small>(select all that apply)</small></legend><div className="choices">{[['web_development','Web Development'],['social_media_management','Social Media Management'],['ai_automation','AI Automation']].map(([value, label]) => <label className="choice" key={value}><input type="checkbox" name="services" value={value} />{label}</label>)}</div></fieldset><fieldset className="field"><legend>Preferred contact method</legend><div className="choices"><label className="choice"><input type="radio" name="preferredContactMethod" value="email" defaultChecked />Email</label><label className="choice"><input type="radio" name="preferredContactMethod" value="phone" />Phone</label></div></fieldset><label className="field"><span>Project details</span><textarea name="projectDetails" placeholder="What are you looking to accomplish?" /></label><Button variant="ai" type="submit">Start Your Project</Button><p className={`form-status ${status.kind}`}>{status.text}</p></form></div></section>
      <section className="pad"><div className="wrap"><div className="cta-final reveal"><Eyebrow>Get started</Eyebrow><h2>Ready to build what is next?</h2><p>Tell us what you need, choose services, and let us know how you want to be contacted.</p><div className="hero-actions"><Button href="#start" variant="ai">Start Your Project</Button><Button href="#pricing" variant="ghost">View Pricing</Button></div></div></div></section>
    </main>
    <footer className="site-footer"><div className="wrap footer-inner"><MorphingLogo location="footer" /><div className="footer-links"><a href="#services">Services</a><a href="#about">About</a><a href="#team">Team</a><a href="#pricing">Pricing</a><a href="#start">Start a Project</a></div><div className="footer-copy">© 2026 BiteSites. All rights reserved.</div></div></footer>
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><div className="detail-panel" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}><button className="close" onClick={() => setModal(null)} aria-label="Close">×</button><div className="detail-hero"><Eyebrow gradient={modal === 'ai'}>Services</Eyebrow><h2>{detailCopy[modal][0]}</h2><p>{detailCopy[modal][1]}</p></div><div className="detail-content"><h3>What’s included</h3><ul className="detail-list">{detailCopy[modal][2].map(item => <li key={item}>{item}</li>)}</ul><div className="hero-actions"><Button href="#start" variant="ai" onClick={() => setModal(null)}>Start Your Project</Button><Button href="#pricing" variant="ghost" onClick={() => setModal(null)}>See pricing</Button></div></div></div></div>}
    <VoiceAIReceptionist open={voiceAgentOpen} onClose={() => setVoiceAgentOpen(false)} />
    {receptionistOpen && <AiReceptionist origin={chatOrigin} initialAnswer={receptionistInitialAnswer} onClose={closeReceptionist} />}
    {!receptionistOpen && !voiceAgentOpen && !voiceSectionVisible && <div className={`chat-launcher ${receptionistNudge ? 'nudged' : ''}`}><p>Need help scoping a project?</p><button type="button" onClick={openReceptionist} aria-label="Open Bit, the AI receptionist"><BitMascot className="bit-launcher-avatar" /><em>Chat with Bit</em></button></div>}
  </>;
}

function Field({ label, name, type = 'text', required = false }) { return <label className="field"><span>{label}</span><input name={name} type={type} required={required} /></label>; }

createRoot(document.getElementById('root')).render(<App />);
