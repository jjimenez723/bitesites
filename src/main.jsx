import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { submitLead } from './lib/leads';
import { analyticsDuration, startAnalytics, trackEvent } from './lib/analytics';
import { finishChat, logChatMessage, startChat } from './lib/conversations';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import { BitMascot } from './components/BitMascot';
import { InteractiveNebulaShader } from './components/InteractiveNebulaShader';
import { MeshFieldBackdrop } from './components/MeshFieldBackdrop';
import { TeamSection } from './components/TeamSection';
import { ByteAvatar, VoiceAIReceptionist, VoiceReceptionistPreview } from './components/VoiceAIReceptionist';
import { BitChatPreview } from './components/BitChatPreview';
import logoFull from './assets/bitesites-logo-full.webp';
import logoWordmark from './assets/bitesites-logo-wordmark.webp';
import logoMark from './assets/bitesites-logo-mark.webp';
// Imported rather than referenced out of public/, so Vite emits them under
// /assets/ with a content hash in the name. That is what retired the manual
// ?v= cache-buster: a re-encoded clip gets a new filename, so no cache
// anywhere — Firebase, Cloudflare, or the browser — can serve the old bytes.
import cliftonClip from './assets/portfolio/cliftonaveanimalhospital.mp4';
import cliftonClip720 from './assets/portfolio/cliftonaveanimalhospital-720.mp4';
import cliftonPoster from './assets/portfolio/cliftonaveanimalhospital-poster.webp';
import stoneClip from './assets/portfolio/stonebellisimo.mp4';
import stoneClip720 from './assets/portfolio/stonebellisimo-720.mp4';
import stonePoster from './assets/portfolio/stonebellisimo-poster.webp';
import nexusClip from './assets/portfolio/nexusverium.mp4';
import nexusClip720 from './assets/portfolio/nexusverium-720.mp4';
import nexusPoster from './assets/portfolio/nexusverium-poster.webp';
import bodegaClip from './assets/portfolio/bodegaproject.mp4';
import bodegaClip720 from './assets/portfolio/bodegaproject-720.mp4';
import bodegaPoster from './assets/portfolio/bodegaproject-poster.webp';
import stockroomClip from './assets/portfolio/stockroomnj.mp4';
import stockroomClip720 from './assets/portfolio/stockroomnj-720.mp4';
import stockroomPoster from './assets/portfolio/stockroomnj-poster.webp';
import './styles.css';
import './service-colors.css';
import './bit.css';
import './typography.css';
import './portfolio.css';
import './pricing-badge.css';
import './team.css';
import './voice-receptionist.css';
import './agent-duo.css';
import './legal.css';

const aiSolutions = [
  ['✦', 'AI Receptionists', 'A voice or chat agent that answers every call and message, books appointments, and routes real leads to your team — even after hours.'],
  ['ϟ', 'Custom AI Automation', 'Workflow builds connecting your CRM, forms, and inbox — so leads move automatically and nothing falls through the cracks.'],
  ['◉', 'Custom AI Projects', 'Purpose-built AI tools scoped to your business — from internal ops assistants to full custom systems, built end to end.']
];

const tickerServices = [
  'Voice AI Receptionists',
  'Web Development',
  'AI Automation',
  'Social Media Management',
  'Custom AI Projects',
  'CRM Builds & Integrations',
  'Business Dashboards',
  'Corporate AI Training',
  'AI Chat Agents',
  'Lead Generation Systems',
  'SEO & Local Search',
  'Generative Engine Optimization (GEO)',
  'Brand & Identity Design',
  'E-Commerce Builds',
  'Analytics & Reporting',
  'Ongoing Support & Maintenance'
];

const navigationItems =[['Byte & Bit','#ai-receptionist'],['Services','#services'],['Portfolio','#portfolio'],['Pricing','#pricing'],['About','#about'],['Team','#team'],['Consultation','#consultation']];

const services = [
  { key: 'ai', badge: 'Lead service', title: 'AI Automation', text: 'We identify repetitive work across sales, marketing, and operations, then build AI-assisted workflows that move information faster.', bullets: ['Faster response times for new leads and requests', 'Less repetitive admin work across sales and ops', 'Cleaner handoffs between forms, inboxes, and systems'] },
  { key: 'web', title: 'Web Development', text: 'Websites that turn your online presence into a working sales asset, from strategy and UX to responsive development and launch support.', bullets: ['A stronger first impression that builds credibility', 'Clearer paths to consultations, quotes, or sales', 'Better speed, mobile experience, and search readiness'] },
  { key: 'social', title: 'Social Media Management', text: 'Content planning, publishing, and reporting that keeps your brand active and consistent.', bullets: ['A consistent publishing cadence that keeps you visible', 'Stronger alignment between social, web, and campaigns', 'Higher-quality engagement from the right audience'] }
];

// Every clip is encoded to a 0.5s GOP (`-g 15 -keyint_min 15 -sc_threshold 0`
// at 30fps) and muxed with `-movflags +faststart`. Both matter and neither is
// optional: a long GOP makes every seek decode from up to six seconds back,
// which is the scrub stutter, and without faststart the browser has to pull the
// whole file before metadata resolves, so onLoadedMetadata never fires and the
// panel stays blank. See PORTFOLIO_PLAN.md §6 for the recipe, and verify with
// ffprobe before adding a clip.
const projects = [
  { title: 'Clifton Ave Animal Hospital', video: cliftonClip, video720: cliftonClip720, poster: cliftonPoster, text: 'Full-service veterinary care in Clifton, NJ — a warm, modern practice site that turns “every stage of your pet’s life” into booked wellness, dental, and same-day urgent visits.', bullets: ['Online booking wired straight into the IDEXX Vello scheduling platform', 'Service paths for wellness, dental, imaging, cardiology, and laser surgery', 'Client portal, pharmacy refills, and Cherry financing in one flow'], stack: ['WordPress', 'Custom PHP Theme', 'Vanilla JS', 'IDEXX Vello'], url: 'https://cliftonaveanimalhospital.com' },
  { title: 'Stone Bellisimo', video: stoneClip, video720: stoneClip720, poster: stonePoster, text: 'Custom stone fabrication in Union City, NJ — a showroom-grade site that turns granite, quartz, and marble work into booked in-home measurements across the Northeast.', bullets: ['Five-step estimate wizard capturing material, size, and timeline', 'Project gallery built for kitchens, vanities, and custom surrounds', '“Bella” 24/7 AI voice agent booking quotes around the clock'], stack: ['React', 'Vite', 'Tailwind CSS', 'AI Voice Agent'], url: 'https://stonebellisimollc.com' },
  { title: 'Nexus Verium', video: nexusClip, video720: nexusClip720, poster: nexusPoster, text: 'Restoration systems & environmental engineering — integrating AI and environmental science to heal ecosystems through the River Veins initiative.', bullets: ['River Veins monitoring network — floating AI wetlands, sensors, drones', 'Digital twin models of the Meadowlands for planning', 'Continuous AI-driven water quality analysis'], stack: ['Next.js', 'Tailwind CSS', 'Turbopack'], url: 'https://nexusverium.tech' },
  { title: 'Rutgers Newark Bodega Project', video: bodegaClip, video720: bodegaClip720, poster: bodegaPoster, text: 'Sustainable food supply chains — a Newark pilot that links rooftop hydroponics, community gardens, and backyard plots to neighbours looking for fresh produce a few blocks away.', bullets: ['Harvest listings with walking distance, price, and how recently it was picked', 'Local map plus a “My Harvest” flow for residents listing their own produce', 'Community impact tracked as CO₂e saved across the neighbourhood each week'], stack: ['Next.js', 'React', 'Tailwind CSS'], url: 'https://jjimenez723.github.io/the-bodega-project-demo/' },
  { title: 'StockRoom NJ', video: stockroomClip, video720: stockroomClip720, poster: stockroomPoster, text: 'A hobby and collectibles shop in Wallington, NJ — cards, video games, consoles, and figures, with the counter’s real stock searchable online and every new drop live the moment it lands.', bullets: ['Live Firestore inventory, so new arrivals appear online as they hit the shelf', 'Search across product name, category, description, and price', 'Multi-photo product galleries, cart checkout, and an in-store events calendar'], stack: ['React', 'Vite', 'Firebase', 'Cloud Firestore'], url: 'https://stockroomnj.com' }
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

// Cached: this is read inside a non-passive wheel handler, and parsing the query
// string on every wheel event is latency the compositor waits on.
let reducedMotionQuery = null;
const prefersReducedMotion = () =>
  (reducedMotionQuery ||= window.matchMedia('(prefers-reduced-motion: reduce)')).matches;

// Phones were downloading the same 1880px master as desktops. Resolved once per
// page load and deliberately *not* reactive: changing a <video> src mid-session
// reloads the clip and drops the playhead, so a device that gets rotated keeps
// the variant it started on rather than restarting the demo under the visitor.
let compactViewportQuery = null;
const portfolioClip = project =>
  ((compactViewportQuery ||= window.matchMedia('(max-width: 760px)')).matches ? project.video720 : project.video);

// Every pacing number here is a *fraction of the clip*, never an absolute time.
// The previous build mapped whatever duration a clip happened to have onto a
// fixed 1628px of wheel travel, so one flick moved 20.6s of Stone Bellisimo but
// only 5.5s of Nexus Verium — 3.7x apart, and far too fast in both cases.
const PORTFOLIO_STORY_LEAD = 3.5;   // story panel opens this long before the end…
const PORTFOLIO_STORY_FLOOR = .6;   // …but never before 60% in, so short recuts still breathe
const PORTFOLIO_WHEEL_SPAN = 1400;  // px of wheel delta that covers a whole clip, any length
const PORTFOLIO_RESUME_DELAY = 400; // ms of stillness before 1x playback takes back over
const PORTFOLIO_PROGRESS_MARKS = [25, 50, 75, 100];
// Under a second on a card is someone scrolling past it, not viewing it. Without
// this floor a single sweep of the rail would spend five of the session's 300
// events reporting views nobody had.
const PORTFOLIO_MIN_DWELL = 1000;

function Button({ children, variant = 'primary', href, ...props }) { return href ? <a className={`btn btn-${variant}`} href={href} {...props}>{children}</a> : <button className={`btn btn-${variant}`} {...props}>{children}</button>; }
function Eyebrow({ children, gradient = false }) { return <div className={`eyebrow ${gradient ? 'gradient' : ''}`}>{children}</div>; }
function SectionHead({ label, title, children, gradient = false }) { return <div className="section-head reveal"><Eyebrow gradient={gradient}>{label}</Eyebrow><h2>{title}</h2>{children && <p>{children}</p>}</div>; }

function MorphingLogo({ location = 'header', onClick }) {
  const logoRef = useRef(null);

  useEffect(() => {
    const node = logoRef.current;
    if (!node) return undefined;

    const isHeader = location === 'header';
    // Stable for the life of the component — looking them up per scroll frame
    // was a DOM walk and a media-query evaluation for nothing.
    const container = node.closest(isHeader ? '.site-header' : '.site-footer');
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    let frame = 0;
    let lastProgress = -1;
    let lastCompact = null;
    // The footer morph needs the footer's own geometry, which costs two rect
    // reads. Skip them entirely while the footer is nowhere near the viewport.
    let inRange = isHeader;

    const updateLogo = () => {
      frame = 0;
      if (!inRange) return;

      const reducedMotion = motionQuery.matches;
      const scrollTravel = Math.max(260, window.innerHeight * .34);
      // Matches the CSS breakpoint where the wings collapse into the burger menu.
      const compact = window.innerWidth <= 900;
      const startSize = compact ? 124 : 158;
      const endSize = compact ? 54 : 62;
      let rawProgress;
      if (isHeader) {
        rawProgress = Math.min(1, Math.max(0, window.scrollY / scrollTravel));
      } else {
        const footerRect = container?.getBoundingClientRect();
        const footerTop = footerRect?.top ?? window.innerHeight;
        const footerHeight = footerRect?.height ?? scrollTravel;
        const logoRect = node.getBoundingClientRect();
        // The logo box is centred in a fixed-height row, so its centre stays put as it resizes.
        const logoCentre = logoRect.top - footerTop + logoRect.height / 2;
        // Run the morph across the logo's own entrance: it starts as the compact mark clears the
        // fold and ends once the expanded logo is fully on screen, with scroll left to spare.
        const enter = logoCentre - endSize / 2;
        const settled = Math.min(footerHeight - 16, logoCentre + startSize / 2 + 12);
        const travel = Math.max(90, settled - enter);
        // Mirror of the header: compact mark while the footer is away, morphing back out to the
        // full logo as it scrolls in — so the three-image sequence plays on screen, not below the fold.
        rawProgress = 1 - Math.min(1, Math.max(0, (window.innerHeight - footerTop - enter) / travel));
      }

      if (reducedMotion) rawProgress = isHeader ? (window.scrollY > 12 ? 1 : 0) : (rawProgress > .5 ? 1 : 0);
      const progress = smoothStep(0, 1, rawProgress);

      // --logo-size and --nav-height feed layout properties, so writing them
      // reflows everything below the header. Past the fold the morph is pinned
      // at 1 and nothing actually changes, so bail out instead of re-dirtying
      // layout on every remaining scroll frame.
      const quantised = Math.round(progress * 1e3) / 1e3;
      if (quantised === lastProgress && compact === lastCompact) return;
      lastProgress = quantised;
      lastCompact = compact;

      const size = startSize + (endSize - startSize) * progress;
      const firstMorph = smoothStep(.04, .5, progress);
      const secondMorph = smoothStep(.5, .96, progress);

      node.style.setProperty('--logo-size', `${size}px`);
      node.style.setProperty('--logo-full-opacity', String(1 - firstMorph));
      node.style.setProperty('--logo-wordmark-opacity', String(firstMorph * (1 - secondMorph)));
      node.style.setProperty('--logo-mark-opacity', String(secondMorph));
      node.style.setProperty('--logo-full-scale', String(1 - .04 * firstMorph));
      node.style.setProperty('--logo-wordmark-scale', String(.96 + .04 * firstMorph - .04 * secondMorph));
      node.style.setProperty('--logo-mark-scale', String(.96 + .04 * secondMorph));
      if (isHeader) {
        container?.style.setProperty('--logo-content-opacity', String(smoothStep(.2, .56, progress)));
        container?.style.setProperty('--nav-height', `${64 + (startSize + 18 - 64) * (1 - progress)}px`);
        container?.classList.toggle('logo-expanded', progress < .18);
      } else {
        // Footer links fade in as the logo opens up, and stay lit once the footer is settled.
        container?.style.setProperty('--logo-content-opacity', String(smoothStep(.1, .6, 1 - progress)));
      }
    };
    const queueUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateLogo);
    };

    // The footer logo only has work to do once the footer is within about a
    // viewport of the fold; before that its two rect reads are pure waste.
    let rangeObserver = null;
    if (!isHeader && container) {
      rangeObserver = new IntersectionObserver(([entry]) => {
        inRange = entry.isIntersecting;
        if (inRange) queueUpdate();
      }, { rootMargin: '100% 0px' });
      rangeObserver.observe(container);
    }

    updateLogo();
    window.addEventListener('scroll', queueUpdate, { passive: true });
    window.addEventListener('resize', queueUpdate);
    motionQuery.addEventListener('change', queueUpdate);
    return () => {
      rangeObserver?.disconnect();
      window.removeEventListener('scroll', queueUpdate);
      window.removeEventListener('resize', queueUpdate);
      motionQuery.removeEventListener('change', queueUpdate);
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

  // Transcript capture. The chat document is created asynchronously, so turns
  // that happen before it exists are buffered and replayed once it does —
  // otherwise a fast first tap would be missing from the transcript.
  const chatIdRef = useRef('');
  const bufferRef = useRef([]);
  const closedRef = useRef(false);
  const countRef = useRef(0);
  const outcomeRef = useRef('abandoned');
  const leadIdRef = useRef('');
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const record = (role, text, kind = 'text', questionKey = '') => {
    if (!text) return;
    countRef.current += 1;
    const turn = { role, text, kind, questionKey };
    if (chatIdRef.current) logChatMessage(chatIdRef.current, turn);
    else bufferRef.current.push(turn);
  };

  useEffect(() => {
    trackEvent('chat_open', { label: 'Bit chat receptionist' });

    // Bit can be opened straight from the card preview, where the visitor has
    // already answered question one. Replay that exchange into the transcript.
    if (initialAnswer) {
      record('bit', receptionistQuestions[0].prompt, 'prompt', 'services');
      record('visitor', initialAnswer.label, 'choice', 'services');
    }

    startChat().then(id => {
      if (!id) return;
      if (closedRef.current) {
        // Opened and closed before the document landed — close it out now so it
        // is not left hanging as an "open" conversation forever.
        finishChat(id, { outcome: outcomeRef.current, messageCount: countRef.current });
        return;
      }
      chatIdRef.current = id;
      for (const turn of bufferRef.current.splice(0)) logChatMessage(id, turn);
    });

    return () => {
      closedRef.current = true;
      finishChat(chatIdRef.current, {
        outcome: outcomeRef.current,
        leadId: leadIdRef.current,
        answers: answersRef.current,
        messageCount: countRef.current
      });
    };
  }, []);

  // Log Bit's side as it is shown, so the transcript reads in the order the
  // visitor actually saw it rather than as answers with no questions.
  useEffect(() => {
    if (step === -1) record('bit', 'Hi — I’m Bit, BiteSites’ mascot and AI receptionist. I’ll ask a few quick questions so our team can point you in the right direction.', 'system');
    else if (question) record('bit', question.prompt, 'prompt', question.key);
    else if (step === receptionistQuestions.length) record('bit', 'Thanks — I have the essentials. Where should we send your tailored next step?', 'prompt');
  }, [step]);

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
    record('visitor', label, 'choice', question.key);
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
    record('visitor', response, 'text', question.key);
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
    record('visitor', [payload.name, payload.email, payload.phone, payload.projectDetails].filter(Boolean).join(' · '), 'text', 'contact');
    try {
      leadIdRef.current = await submitLead(payload, 'bit_chat');
      outcomeRef.current = 'converted';
      trackEvent('form_submit', { label: 'Bit chat — project notes' });
      setStatus({ text: 'You’re all set. Our team will follow up shortly.', kind: 'success' });
    } catch (error) {
      outcomeRef.current = 'failed';
      setStatus({ text: error.message || 'Unable to send your request. Please try again.', kind: 'error' });
    }
  };
  const finishReveal = event => {
    if (event.target === event.currentTarget && event.animationName === 'bitReveal') event.currentTarget.classList.add('bit-ready');
  };

  return <aside className="bit-window" onAnimationEnd={finishReveal} style={{ '--bit-x': `${origin?.x ?? window.innerWidth - 58}px`, '--bit-y': `${origin?.y ?? window.innerHeight - 52}px` }} aria-labelledby="receptionist-title" role="dialog" aria-modal="true">
    <div className="bit-noise" aria-hidden="true" />
    <header className="bit-topbar"><a className="bit-wordmark" href="#top" onClick={onClose} aria-label="BiteSites — back to site"><img src={logoWordmark} alt="BiteSites" width="500" height="500" /></a><div className="bit-agent"><span className="chat-presence" /> Bit is here</div><button type="button" className="bit-close" onClick={onClose} aria-label="Close Bit">Close <span>×</span></button></header>
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
  // The scrub used to hold progress and playhead in state, so every wheel event
  // re-rendered this whole component — the entire marketing page — and did it up
  // to 20 times a second. The playhead now lives in refs and is written straight
  // onto the section as a CSS custom property; only the two thresholds that
  // genuinely change the markup stay in React state.
  const [portfolioPhase, setPortfolioPhase] = useState({ expanded: false, story: false });
  const portfolioTrack = useRef(null);
  const portfolioSection = useRef(null);
  const portfolioDemo = useRef(null);
  const portfolioVideo = useRef(null);
  const portfolioScrubber = useRef(null);
  const portfolioVideoDurationRef = useRef(0);
  const portfolioVideoTimeRef = useRef(0);
  const portfolioTargetTimeRef = useRef(0);
  const portfolioScrubFrameRef = useRef(0);
  // Mirrors of the two state flags. The wheel listener is registered once and
  // reads these, rather than being torn down and rebuilt on every phase change.
  const portfolioExpandedRef = useRef(false);
  const portfolioStoryRef = useRef(false);
  const portfolioScrubbingRef = useRef(false);
  const portfolioResumeTimerRef = useRef(0);
  const portfolioAnnouncedRef = useRef(-1);
  // Reduced-motion consent. A ref because playPortfolioDemo reads it from inside
  // rAF and event handlers; the paired state only drives the play button, and
  // only ever changes on a deliberate click — never on the playback hot path.
  const portfolioConsentedRef = useRef(false);
  const [portfolioNeedsPlay, setPortfolioNeedsPlay] = useState(false);
  // Analytics counters. Refs, not state — goal #6 is that nothing in this
  // section re-renders during playback, and a milestone that setState'd would
  // re-render the whole marketing page mid-clip.
  const portfolioViewStartRef = useRef(0);
  // The observer effect reports on the project that was on screen, but it must
  // not re-subscribe every time the rail snaps to a new card — so the active
  // index reaches it through a ref rather than through its dependency list.
  const portfolioActiveRef = useRef(0);
  const portfolioNearRef = useRef(false);
  const portfolioMarksRef = useRef(new Set());
  const portfolioHealthRef = useRef({ requestedAt: 0, firstFrameMs: -1, stalls: 0, sent: false });

  // Behavioural capture for the admin dashboard. Started once, for the life of
  // the marketing page — see src/lib/analytics.js for what it records.
  useEffect(() => startAnalytics(), []);

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
    if (portfolioResumeTimerRef.current) window.clearTimeout(portfolioResumeTimerRef.current);
  }, []);

  // A different clip means a different duration and playhead — and, per the latch
  // in writePortfolioProgress, a story panel that has to earn its way back on.
  useEffect(() => {
    endPortfolioScrub(false);
    portfolioVideoDurationRef.current = 0;
    portfolioVideoTimeRef.current = 0;
    portfolioTargetTimeRef.current = 0;
    portfolioAnnouncedRef.current = -1;
    portfolioStoryRef.current = false;
    // Consent was for the clip that just left, so a reduced-motion visitor gets
    // the play control back rather than the next project starting on its own.
    portfolioConsentedRef.current = false;
    setPortfolioNeedsPlay(portfolioExpandedRef.current && prefersReducedMotion());
    writePortfolioProgress(0);
    setPortfolioPhase(current => (current.story ? { ...current, story: false } : current));

    portfolioActiveRef.current = activeProject;
    // Zero unless the section is on screen right now: an off-screen card that
    // becomes active has not been viewed, and must not start accruing dwell.
    portfolioViewStartRef.current = portfolioNearRef.current ? performance.now() : 0;
    portfolioMarksRef.current.clear();
    portfolioHealthRef.current = { requestedAt: 0, firstFrameMs: -1, stalls: 0, sent: false };
    // Cleanup closes over the index that is on its way out, which is what makes
    // this the one place that knows both which project was watched and for how
    // long. It also runs on unmount, so a visitor who leaves mid-clip is counted.
    return () => reportPortfolioProject(activeProject);
  }, [activeProject]);

  const closeMenu = () => setMenuOpen(false);

  // The mobile menu is a full-height panel: hold the page still behind it, close it on Escape,
  // and drop it if the viewport grows back to the desktop nav.
  useEffect(() => {
    document.body.classList.toggle('menu-open', menuOpen);
    if (!menuOpen) return;
    const onKeyDown = event => { if (event.key === 'Escape') setMenuOpen(false); };
    const onResize = () => { if (window.innerWidth > 900) setMenuOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);
  useEffect(() => () => document.body.classList.remove('menu-open'), []);

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
    // showProject's smooth scroll keeps firing for a few hundred ms after a card
    // has been opened; letting it land would swap the demo's src mid-animation.
    if (portfolioExpandedRef.current) return;
    const track = event.currentTarget;
    const cards = [...track.children];
    const center = track.scrollLeft + track.clientWidth / 2;
    const closest = cards.reduce((best, card, index) => Math.abs(card.offsetLeft + card.offsetWidth / 2 - center) < Math.abs(cards[best].offsetLeft + cards[best].offsetWidth / 2 - center) ? index : best, 0);
    setActiveProject(closest);
  };
  // Reported when a project stops being the active one, so dwell is known and
  // the health picture is whole. Both events are capped at one per project per
  // selection by construction — there is exactly one cleanup per activeProject.
  const reportPortfolioProject = index => {
    const project = projects[index];
    const startedAt = portfolioViewStartRef.current;
    if (!project || !startedAt) return;
    const dwell = performance.now() - startedAt;
    if (dwell < PORTFOLIO_MIN_DWELL) return;
    trackEvent('portfolio_project_view', { label: project.title, section: 'portfolio', value: analyticsDuration(dwell) });

    // Only meaningful once the clip was actually asked to play — a card that was
    // merely selected in the rail has no load to report on.
    const health = portfolioHealthRef.current;
    if (health.sent || health.firstFrameMs < 0) return;
    health.sent = true;
    // `value` is time-to-first-frame; stalls ride in `section` because the field
    // whitelist in firestore.rules has one numeric slot and time-to-first-frame
    // is the more actionable half. Keeping `label` the bare project title is
    // what lets the dashboard group these by project.
    trackEvent('portfolio_video_health', {
      label: project.title,
      section: health.stalls ? `portfolio:stalled:${health.stalls}` : 'portfolio',
      value: analyticsDuration(health.firstFrameMs)
    });
  };
  // Rides the native timeupdate event (~4/s) rather than rAF, so it costs
  // nothing per frame. The Set makes each mark fire once per project however
  // many times the clip loops or the visitor scrubs back across it.
  const recordPortfolioMilestone = time => {
    const duration = portfolioVideoDurationRef.current;
    if (!duration) return;
    const percent = (time / duration) * 100;
    const marks = portfolioMarksRef.current;
    for (const mark of PORTFOLIO_PROGRESS_MARKS) {
      // The clip loops, so currentTime never actually reaches duration and a
      // literal 100 would never fire. 99% through is a watch-through.
      if (percent < (mark === 100 ? 99 : mark) || marks.has(mark)) continue;
      marks.add(mark);
      trackEvent('portfolio_progress', { label: projects[activeProject].title, section: 'portfolio', value: mark });
    }
  };
  // The only continuous value the section still has. It goes onto the DOM
  // directly — a custom property the scrub bar transforms by, and the slider's
  // aria value — so neither playback nor scrubbing costs a React render. The
  // story latch below is the sole exception, and it fires once per project.
  const writePortfolioProgress = time => {
    const duration = portfolioVideoDurationRef.current;
    const fraction = duration ? Math.min(1, Math.max(0, time / duration)) : 0;
    portfolioSection.current?.style.setProperty('--portfolio-scrub', String(fraction));

    const percent = Math.round(fraction * 100);
    if (percent !== portfolioAnnouncedRef.current) {
      portfolioAnnouncedRef.current = percent;
      portfolioScrubber.current?.setAttribute('aria-valuenow', String(percent));
    }

    // Latched on purpose. The clip loops, so currentTime drops back to 0 every
    // pass; an unlatched threshold would snap the story panel off and back on at
    // every wrap. Once a project has told its story it keeps telling it until the
    // visitor picks a different one — the latch resets in the [activeProject]
    // effect above and on close.
    if (!duration || portfolioStoryRef.current) return;
    const storyStart = Math.max(duration - PORTFOLIO_STORY_LEAD, duration * PORTFOLIO_STORY_FLOOR);
    if (time < storyStart) return;
    portfolioStoryRef.current = true;
    setPortfolioPhase(current => (current.story ? current : { ...current, story: true }));
  };
  const playPortfolioDemo = () => {
    const video = portfolioVideo.current;
    if (!video || !portfolioExpandedRef.current || portfolioScrubbingRef.current || document.hidden) return;
    // Reduced motion holds on the poster frame until the visitor presses play.
    // Every other resume path funnels through here — the scrub release, the
    // visibility handler, the metadata handler — so this one guard covers them
    // all, and none of them can start motion nobody asked for.
    if (prefersReducedMotion() && !portfolioConsentedRef.current) return;
    // Stamped on the first play request only: time-to-first-frame is measured
    // from when the clip was asked to start, not from every resume after a scrub.
    if (!portfolioHealthRef.current.requestedAt) portfolioHealthRef.current.requestedAt = performance.now();
    // Autoplay policy only permits play() on a muted element, and React assigns
    // `muted` as a property rather than an attribute — assert it rather than
    // trust that it survived the render, or iOS rejects the play().
    video.muted = true;
    video.play().catch(() => {});
  };
  // Explicit consent under reduced motion. Once given it holds for this project
  // only: selecting another clip puts the play control back.
  const startPortfolioDemo = () => {
    portfolioConsentedRef.current = true;
    setPortfolioNeedsPlay(false);
    playPortfolioDemo();
  };
  const clearPortfolioResume = () => {
    if (!portfolioResumeTimerRef.current) return;
    window.clearTimeout(portfolioResumeTimerRef.current);
    portfolioResumeTimerRef.current = 0;
  };
  const beginPortfolioScrub = () => {
    clearPortfolioResume();
    portfolioScrubbingRef.current = true;
    portfolioSection.current?.classList.add('portfolio-scrubbing');
  };
  const endPortfolioScrub = (resume = true) => {
    clearPortfolioResume();
    portfolioScrubbingRef.current = false;
    portfolioSection.current?.classList.remove('portfolio-scrubbing');
    if (!resume) {
      if (portfolioScrubFrameRef.current) window.cancelAnimationFrame(portfolioScrubFrameRef.current);
      portfolioScrubFrameRef.current = 0;
      return;
    }
    // If the eased seek is still chasing a target, killing it here would resume
    // playback short of where the visitor let go. The loop calls back instead.
    if (!portfolioScrubFrameRef.current) playPortfolioDemo();
  };
  // Wheel and arrow-key scrubs arrive as a stream of discrete events with no
  // "up" — the gesture is only over once the events stop coming.
  const schedulePortfolioResume = () => {
    clearPortfolioResume();
    portfolioResumeTimerRef.current = window.setTimeout(() => {
      portfolioResumeTimerRef.current = 0;
      endPortfolioScrub();
    }, PORTFOLIO_RESUME_DELAY);
  };
  // The single write path for every seek, from all four input routes.
  const scrubPortfolioVideoTo = targetTime => {
    const duration = portfolioVideoDurationRef.current;
    portfolioTargetTimeRef.current = Math.min(Math.max(0, targetTime), Math.max(0, duration - .04));
    if (portfolioScrubFrameRef.current) return;

    const tick = () => {
      const video = portfolioVideo.current;
      if (!video) {
        portfolioScrubFrameRef.current = 0;
        return;
      }

      // Overwriting currentTime while a seek is still in flight throws away the
      // decode the browser had already started and makes it restart from the
      // nearest keyframe. Waiting for the pending one to land is what turns this
      // from a stall into a scrub.
      if (video.seeking) {
        portfolioScrubFrameRef.current = window.requestAnimationFrame(tick);
        return;
      }

      if (!video.paused) video.pause();
      const distance = portfolioTargetTimeRef.current - video.currentTime;
      // Below roughly one frame there is no different picture to seek to, so
      // chasing the remainder is decode work nobody can see.
      if (Math.abs(distance) < .04) {
        portfolioVideoTimeRef.current = video.currentTime;
        writePortfolioProgress(video.currentTime);
        portfolioScrubFrameRef.current = 0;
        // The gesture ended while this was still settling — hand playback back.
        if (!portfolioScrubbingRef.current) playPortfolioDemo();
        return;
      }

      video.currentTime += distance * .24;
      portfolioVideoTimeRef.current = video.currentTime;
      writePortfolioProgress(video.currentTime);
      portfolioScrubFrameRef.current = window.requestAnimationFrame(tick);
    };

    portfolioScrubFrameRef.current = window.requestAnimationFrame(tick);
  };
  const handlePortfolioMetadata = event => {
    const video = event.currentTarget;
    portfolioVideoDurationRef.current = Number.isFinite(video.duration) ? video.duration : 0;
    portfolioVideoTimeRef.current = 0;
    portfolioTargetTimeRef.current = 0;
    portfolioAnnouncedRef.current = -1;
    writePortfolioProgress(0);
    playPortfolioDemo();
  };
  // ~4/s during playback, which is all the scrub bar needs — CSS interpolates
  // between the samples. Keeping the target in step matters too: the wheel
  // handler seeds its next seek from it.
  const handlePortfolioTimeUpdate = event => {
    if (portfolioScrubbingRef.current || portfolioScrubFrameRef.current) return;
    const time = event.currentTarget.currentTime;
    portfolioVideoTimeRef.current = time;
    portfolioTargetTimeRef.current = time;
    writePortfolioProgress(time);
    recordPortfolioMilestone(time);
  };
  // Video health. `waiting` is the rebuffer the visitor actually sees; the first
  // `playing` after the play() request is time-to-first-frame.
  const handlePortfolioWaiting = () => { portfolioHealthRef.current.stalls += 1; };
  const handlePortfolioPlaying = () => {
    const health = portfolioHealthRef.current;
    if (health.firstFrameMs < 0 && health.requestedAt) health.firstFrameMs = performance.now() - health.requestedAt;
  };
  // The demo grows out of the card that was tapped. That closed shape used to be
  // a hardcoded inset(27% 18%) matching where the rail happened to sit; the rail
  // is laid out in flow now, so the shape is measured instead. One write per
  // open, before the expand transition starts — never on the playback path.
  const writePortfolioClipOrigin = index => {
    const demo = portfolioDemo.current;
    const card = portfolioTrack.current?.children[index];
    if (!demo || !card) return;
    // Measure before showProject's smooth scroll moves anything: the card is
    // still under the finger that opened it, which is where the reveal starts.
    const stage = demo.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    if (!stage.width || !stage.height) return;
    const radius = getComputedStyle(card).borderTopLeftRadius;
    demo.style.setProperty('--portfolio-clip', `inset(${rect.top - stage.top}px ${stage.right - rect.right}px ${stage.bottom - rect.bottom}px ${rect.left - stage.left}px round ${radius})`);
  };
  const openPortfolioProject = index => {
    if (index !== activeProject) setActiveProject(index);
    writePortfolioClipOrigin(index);
    showProject(index);
    portfolioExpandedRef.current = true;
    // Reduced motion opens the stage like everyone else's — it just arrives
    // paused on the poster behind an explicit play control, rather than
    // refusing to open at all and leaving the visitor with a dead card.
    if (prefersReducedMotion()) {
      portfolioConsentedRef.current = false;
      setPortfolioNeedsPlay(true);
    }
    setPortfolioPhase(current => (current.expanded ? current : { ...current, expanded: true }));
  };
  const closePortfolioProject = (returnFocus = false) => {
    portfolioExpandedRef.current = false;
    portfolioStoryRef.current = false;
    endPortfolioScrub(false);
    const video = portfolioVideo.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    portfolioVideoTimeRef.current = 0;
    portfolioTargetTimeRef.current = 0;
    portfolioAnnouncedRef.current = -1;
    portfolioConsentedRef.current = false;
    setPortfolioNeedsPlay(false);
    writePortfolioProgress(0);
    setPortfolioPhase({ expanded: false, story: false });
    if (returnFocus) window.requestAnimationFrame(() => portfolioTrack.current?.focus({ preventScroll: true }));
  };
  const portfolioScrubTimeFromPointer = event => {
    const bar = portfolioScrubber.current;
    const duration = portfolioVideoDurationRef.current;
    if (!bar || !duration) return null;
    const rect = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration;
  };
  // Pointer events, not touch events: one path drives mouse, trackpad, pen and
  // finger, and setPointerCapture keeps the drag alive past the edge of the bar.
  // Writing a separate touch branch is how the previous build ended up with a
  // section that did nothing at all on a phone.
  const handlePortfolioScrubDown = event => {
    const time = portfolioScrubTimeFromPointer(event);
    if (time === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginPortfolioScrub();
    scrubPortfolioVideoTo(time);
  };
  const handlePortfolioScrubMove = event => {
    if (!portfolioScrubbingRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const time = portfolioScrubTimeFromPointer(event);
    if (time !== null) scrubPortfolioVideoTo(time);
  };
  const handlePortfolioScrubUp = event => {
    if (!portfolioScrubbingRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    endPortfolioScrub();
  };
  const handlePortfolioScrubKey = event => {
    const duration = portfolioVideoDurationRef.current;
    if (!duration) return;
    // A fraction of the clip, so arrow keys cross a 6s clip and an 84s one in
    // the same number of presses.
    const step = duration * .05;
    const from = portfolioTargetTimeRef.current;
    const target = event.key === 'ArrowLeft' ? from - step
      : event.key === 'ArrowRight' ? from + step
      : event.key === 'Home' ? 0
      : event.key === 'End' ? duration
      : null;
    if (target === null) return;
    event.preventDefault();
    beginPortfolioScrub();
    scrubPortfolioVideoTo(target);
    schedulePortfolioResume();
  };
  // Scoped to the expanded demo and non-passive, because it has to be able to
  // preventDefault. It only does so while the seek stays inside the clip: at
  // either end, once the story panel is up, or on a sideways gesture, the wheel
  // belongs to the page again. There is no state in which the visitor is held
  // inside the section — being held is what made the old build feel broken.
  const handlePortfolioDemoWheel = event => {
    if (!portfolioExpandedRef.current || prefersReducedMotion()) return;
    // The story panel means the visitor is reading, not scrubbing. Rewinding the
    // clip out from under them because they scrolled up a line would be absurd;
    // the drag bar is still there for anyone who wants the playhead back.
    if (portfolioStoryRef.current) return;
    if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const duration = portfolioVideoDurationRef.current;
    if (!duration) return;

    const from = portfolioTargetTimeRef.current;
    if (event.deltaY > 0 ? from >= duration - .05 : from <= .05) return;

    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    // A fraction of the clip per pixel, never a number of seconds per pixel —
    // this is the whole of what makes a 6s recut and an 84s one feel identical.
    const delta = ((event.deltaY * scale) / PORTFOLIO_WHEEL_SPAN) * duration;
    beginPortfolioScrub();
    scrubPortfolioVideoTo(from + delta);
    schedulePortfolioResume();
  };
  // Registered once: everything the handler reads is a ref, so it never goes
  // stale and never has to be torn down and rebuilt on a phase change.
  useEffect(() => {
    const demo = portfolioDemo.current;
    if (!demo) return undefined;
    demo.addEventListener('wheel', handlePortfolioDemoWheel, { passive: false });
    return () => demo.removeEventListener('wheel', handlePortfolioDemoWheel);
  }, []);

  useEffect(() => {
    if (!portfolioPhase.expanded) return undefined;
    playPortfolioDemo();
    const onKeyDown = event => { if (event.key === 'Escape') closePortfolioProject(true); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [portfolioPhase.expanded]);

  // The rail's clips used to carry `autoPlay`, so four decoders ran from page
  // load onwards — off screen, in a background tab, and straight through the
  // scrub, which is the one moment the decoder is needed elsewhere.
  useEffect(() => {
    const section = portfolioSection.current;
    const track = portfolioTrack.current;
    if (!section || !track) return undefined;

    let near = false;
    const sync = () => {
      const play = near && !portfolioPhase.expanded && !document.hidden && !prefersReducedMotion();
      for (const video of track.querySelectorAll('video')) {
        // Autoplay policy only permits play() on a muted element. React assigns
        // `muted` as a property rather than an attribute, so assert it here
        // rather than trust that it survived the render.
        video.muted = true;
        if (play) video.play().catch(() => {});
        else video.pause();
      }
      // The demo follows the same rules — including going quiet in a background
      // tab, where a decoder running behind nothing is pure battery.
      if (portfolioPhase.expanded) {
        if (document.hidden) portfolioVideo.current?.pause();
        else playPortfolioDemo();
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      near = entry.isIntersecting;
      portfolioNearRef.current = near;
      // Dwell is only counted while the section is actually on screen. Starting
      // the clock when a card becomes active instead would bill project 01 for
      // every second the visitor spent up in the hero before ever scrolling
      // here — and would report a view for a portfolio nobody reached.
      if (near) portfolioViewStartRef.current ||= performance.now();
      else {
        reportPortfolioProject(portfolioActiveRef.current);
        portfolioViewStartRef.current = 0;
      }
      // Only worth fetching the demo clip in full once the visitor is close
      // enough to plausibly open it.
      const demo = portfolioVideo.current;
      if (near && demo && demo.preload !== 'auto') demo.preload = 'auto';
      sync();
    }, { rootMargin: '25% 0px' });

    observer.observe(section);
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [portfolioPhase.expanded]);
  const submit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = Object.fromEntries(data.entries());
    payload.services = data.getAll('services');
    if (!payload.services.length) return setStatus({ text: 'Please select at least one service.', kind: 'error' });
    if (payload.preferredContactMethod === 'phone' && !payload.phone.trim()) return setStatus({ text: 'Please include a phone number if you prefer a phone call.', kind: 'error' });
    setStatus({ text: 'Sending…', kind: '' });
    try { await submitLead(payload, 'intake_form'); form.reset(); trackEvent('form_submit', { label: 'Start your project' }); setStatus({ text: 'Thanks — your project request has been received. We’ll be in touch soon.', kind: 'success' }); } catch (error) { setStatus({ text: error.message || 'Unable to submit the form. Please try again.', kind: 'error' }); }
  };

  return <>
    <header className="site-header"><nav><div className="nav-wing nav-wing-left">{navigationItems.slice(0, 4).map(([label, href]) => <a key={label} href={href}>{label}</a>)}</div><MorphingLogo onClick={closeMenu} /><div className="nav-wing nav-wing-right">{navigationItems.slice(4).map(([label, href]) => <a key={label} href={href}>{label}</a>)}<Button href="#start" variant="ai">Start Your Project</Button></div><button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} aria-controls="mobile-nav"><span className="menu-toggle-bars" aria-hidden="true"><i /><i /><i /></span></button></nav></header>
    {/* The drawer sits outside <header> on purpose: the header's backdrop-filter would otherwise
        become the containing block for these fixed panels and collapse them to nothing. */}
    <div className={`nav-drawer-backdrop ${menuOpen ? 'open' : ''}`} onClick={closeMenu} aria-hidden="true" />
    <aside id="mobile-nav" className={`nav-drawer ${menuOpen ? 'open' : ''}`} aria-label="Main menu" aria-hidden={!menuOpen}>
      <div className="nav-drawer-head">
        <span>Menu</span>
        <button className="nav-drawer-close" onClick={closeMenu} aria-label="Close menu" tabIndex={menuOpen ? undefined : -1}>×</button>
      </div>
      <nav className="nav-drawer-links">{navigationItems.map(([label, href]) => <a key={label} href={href} onClick={closeMenu} tabIndex={menuOpen ? undefined : -1}>{label}</a>)}</nav>
      <Button href="#start" variant="ai" onClick={closeMenu} tabIndex={menuOpen ? undefined : -1}>Start Your Project</Button>
    </aside>
    <main id="top">
      <section className="hero"><div className="hero-bg"><InteractiveNebulaShader /><div className="hero-overlay" /></div><div className="wrap hero-content"><Eyebrow gradient>AI-powered digital solutions</Eyebrow><h1>Intelligence built<br />into your <span className="gradient-text">business.</span></h1><p className="lead">BiteSites builds Voice AI receptionists, websites, and automations that answer faster, capture more leads, and take repetitive work off your team.</p><div className="hero-actions"><Button href="#start" variant="ai">Start Your Project</Button><Button href="#ai-receptionist" variant="ghost">Meet Byte &amp; Bit</Button></div></div></section>
      <section className="intake" id="start"><div className="wrap intake-grid"><div className="section-head reveal"><Eyebrow gradient>Start your project</Eyebrow><h2>Tell us what you need.</h2><p>Use one form for web development, social media management, or AI automation. We only ask for the details needed to route your project and follow up.</p></div><form className="intake-form reveal" onSubmit={submit}><div className="form-row"><Field label="Name" name="name" required /><Field label="Email" name="email" type="email" required /></div><div className="form-row"><Field label="Phone (optional)" name="phone" type="tel" /><Field label="Business / Company (optional)" name="businessName" /></div><div className="form-row"><Field label="Role in company (optional)" name="roleInCompany" /><label className="field"><span>Business size</span><select name="businessSize" required defaultValue=""><option value="" disabled>Select size</option><option value="solo">Solo / Freelancer</option><option value="small">2-10 employees</option><option value="growing">11-50 employees</option><option value="established">51-200 employees</option><option value="enterprise">200+ employees</option></select></label></div><label className="field"><span>Timeline (optional)</span><select name="urgencyTag" defaultValue=""><option value="">No urgency selected</option><option value="asap">ASAP</option><option value="2_4_weeks">2-4 weeks</option><option value="1_2_months">1-2 months</option><option value="flexible">Flexible</option></select></label><fieldset className="field"><legend>Services <small>(select all that apply)</small></legend><div className="choices">{[['web_development','Web Development'],['social_media_management','Social Media Management'],['ai_automation','AI Automation']].map(([value, label]) => <label className="choice" key={value}><input type="checkbox" name="services" value={value} />{label}</label>)}</div></fieldset><fieldset className="field"><legend>Preferred contact method</legend><div className="choices"><label className="choice"><input type="radio" name="preferredContactMethod" value="email" defaultChecked />Email</label><label className="choice"><input type="radio" name="preferredContactMethod" value="phone" />Phone</label></div></fieldset><label className="field"><span>Project details</span><textarea name="projectDetails" placeholder="What are you looking to accomplish?" /></label><Button variant="ai" type="submit">Start Your Project</Button><p className={`form-status ${status.kind}`}>{status.text}</p></form></div></section>
      <div className="strip" aria-label="What we do"><div className="ticker"><div className="ticker-track">{[0, 1].map(copy => <div className="ticker-group" key={copy} aria-hidden={copy === 1 ? 'true' : undefined}>{tickerServices.map(service => <span key={service}>{service}</span>)}</div>)}</div></div></div>
      <section className="voice-receptionist-section" id="ai-receptionist" aria-labelledby="voice-receptionist-heading">
        <div className="wrap">
          <div className="agent-duo-head reveal">
            <Eyebrow>Meet the BiteSites AI duo</Eyebrow>
            <h2 id="voice-receptionist-heading">Say hi to <span className="agent-name agent-name-byte">Byte</span> <span className="agent-amp" aria-hidden="true">&amp;</span> <span className="agent-name agent-name-bit">Bit</span>.</h2>
            <p>Byte picks up the phone. Bit picks up the chat. Between the two of them, every caller and every visitor gets a warm hello, a real answer, and a booked appointment — mornings, midnights, and weekends included.</p>
            <div className="agent-duo-stats">
              <span><strong>Under 2 rings</strong> to answer</span>
              <span><strong>24/7</strong> — holidays too</span>
              <span>Books into <strong>your calendar</strong></span>
            </div>
          </div>
          <div className="agent-duo-grid">
            <article className="agent-card agent-card-byte reveal">
              <div className="agent-card-head">
                <ByteAvatar />
                <span className="agent-id"><strong>Byte</strong><small>Voice AI receptionist</small></span>
                <span className="agent-chip"><i />Ready to talk</span>
              </div>
              <VoiceReceptionistPreview onOpen={() => setVoiceAgentOpen(true)} />
              <p className="agent-card-copy">Byte knows Voice AI inside and out. Ask how an AI phone agent answers calls, qualifies leads, books appointments, and follows up around the clock — then hear it happen live.</p>
              <ul className="agent-card-points">
                <li>Answers tailored to your call volume, team, and goals</li>
                <li>Lead qualification, appointment booking, CRM follow-up</li>
                <li>The same natural voice your customers would hear</li>
              </ul>
              <div className="agent-card-actions">
                <Button variant="ghost" onClick={() => setVoiceAgentOpen(true)}>Talk to Byte <span aria-hidden="true">&nbsp;→</span></Button>
                <small>Your browser asks before the microphone turns on.</small>
              </div>
            </article>
            <article className="agent-card agent-card-bit reveal">
              <div className="agent-card-head">
                <span className="agent-avatar-bit"><BitMascot /></span>
                <span className="agent-id"><strong>Bit</strong><small>AI chat receptionist</small></span>
                <span className="agent-chip"><i />Always up for a chat</span>
              </div>
              <BitChatPreview onOpen={openReceptionist} />
              <p className="agent-card-copy">Bit is our mascot with a job. He asks a few friendly questions, works out what you actually need, and hands our team a lead worth calling back. And yes — his eyes really do follow your cursor.</p>
              <ul className="agent-card-points">
                <li>A one-minute project check-in, no pressure at all</li>
                <li>Type your own answer or tap a quick reply</li>
                <li>Your notes land with our team, ready for follow-up</li>
              </ul>
              <div className="agent-card-actions">
                <Button variant="ghost" onClick={openReceptionist}>Chat with Bit <span aria-hidden="true">&nbsp;→</span></Button>
                <small>No microphone, no signup — just say hello.</small>
              </div>
            </article>
          </div>
          <div className="voice-seo-points reveal" aria-label="AI receptionist questions and answers">
            <article><h3>What can a Voice AI receptionist do?</h3><p>A Voice AI receptionist can answer inbound calls, respond to common questions, qualify leads, book appointments, route callers, and update connected CRM workflows.</p></article>
            <article><h3>What does an AI chat agent handle?</h3><p>An AI chat agent greets website visitors, answers service questions, captures contact details, and routes qualified leads straight to your team.</p></article>
            <article><h3>Can they work with my calendar and CRM?</h3><p>Yes. BiteSites can connect a custom AI phone or chat agent with business calendars, qualification rules, and CRM follow-up workflows.</p></article>
            <article><h3>Are the agents trained for my business?</h3><p>Yes. Each agent can be trained on your services, common questions, lead qualification criteria, appointment process, and human escalation rules.</p></article>
          </div>
        </div>
      </section>
      <section className="pad" id="ai"><div className="wrap"><SectionHead label="Our focus" title="AI that actually runs your business." gradient>This is where we spend most of our time now — designing AI systems that answer the phone, qualify leads, and handle repetitive work, so your team doesn’t have to.</SectionHead><div className="ai-grid">{aiSolutions.map(([icon, title, text]) => <article className="ai-card reveal" key={title}><div className="ai-icon">{icon}</div><h3>{title}</h3><p>{text}</p></article>)}</div></div></section>
      <section className="pad services-section" id="services"><MeshFieldBackdrop /><div className="wrap"><SectionHead label="What we do" title="Digital services built around growth, not filler.">Three connected service lines that help businesses build a stronger presence, reach the right people, and reduce the manual work holding growth back.</SectionHead><div className="services-grid">{services.map((service, index) => <article className={`service-card reveal ${service.key} ${index === 0 ? 'featured' : ''}`} key={service.key}>{service.badge && <span className="service-badge">{service.badge}</span>}<div className="service-icon">{['✦','□','↻'][index]}</div><h3>{service.title}</h3><p className="desc">{service.text}</p><ul>{service.bullets.map(item => <li key={item}>{item}</li>)}</ul><button className="text-link" onClick={() => setModal(service.key)}>Explore {service.title} →</button></article>)}</div><div className="segments reveal">{[['Small business','Build a credible online presence, stay visible, and reduce repetitive admin work without adding complexity.'],['Medium business','Connect campaigns, service lines, and internal workflows as growing volume creates more moving parts.'],['Large business','Coordinate more stakeholders and more complex processes without sacrificing speed.']].map(([title, text]) => <div className="segment" key={title}><div className="tag">{title}</div><p>{text}</p></div>)}</div></div></section>
      {/* No inline style object: --portfolio-scrub is written imperatively by
          writePortfolioProgress so that playback and scrubbing never re-render
          the page. Adding a style prop back here would fight it. */}
      <section
        className={`portfolio-section ${portfolioPhase.expanded ? 'portfolio-expanded' : ''} ${portfolioPhase.story ? 'portfolio-story-visible' : ''}`}
        id="portfolio"
        ref={portfolioSection}
      >
        <div className="portfolio-stage">
          <div className="portfolio-intro wrap" aria-hidden={portfolioPhase.expanded}>
            <Eyebrow>Featured work</Eyebrow>
            <h2>Work worth stepping into.</h2>
            <p>Browse sideways, then open a project to watch it play. Drag the bar to scrub — it picks playback back up wherever you stop.</p>
          </div>

          <div className="portfolio-rail" aria-hidden={portfolioPhase.expanded}>
            <div
              className="portfolio-track"
              ref={portfolioTrack}
              onScroll={handlePortfolioScroll}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') showProject(Math.max(0, activeProject - 1));
                if (event.key === 'ArrowRight') showProject(Math.min(projects.length - 1, activeProject + 1));
              }}
              tabIndex={portfolioPhase.expanded ? -1 : 0}
              aria-label="Featured projects. Scroll left or right to browse, then open a project to play its demo."
            >
              {projects.map((project, index) => <article className={`portfolio-project ${activeProject === index ? 'active' : ''}`} key={project.title}>
                {/* Autoplay is driven by the rail effect, not the attribute: four
                    looping decoders running behind the demo is what made it stutter. */}
                <video muted loop playsInline preload="metadata" poster={project.poster} aria-hidden="true"><source src={portfolioClip(project)} type="video/mp4" /></video>
                <div className="portfolio-project-shade" />
                <span className="project-number">0{index + 1}</span>
                <div className="portfolio-project-title"><span>Selected project</span><h3>{project.title}</h3></div>
                {/* The card is an <article>, so this overlay carries the click and
                    the keyboard focus without nesting a heading inside a button. */}
                <button
                  className="portfolio-project-open"
                  type="button"
                  onClick={() => openPortfolioProject(index)}
                  tabIndex={portfolioPhase.expanded ? -1 : 0}
                  aria-label={`Open the ${project.title} demo`}
                />
              </article>)}
            </div>
          </div>

          <div className="portfolio-demo" ref={portfolioDemo}>
            {/* preload starts at metadata — enough to know the duration — and the
                rail effect upgrades it to auto once the section nears the fold.
                At preload="auto" this pulled the full clip on every page load. */}
            {/* Looping is motion in its own right, so under reduced motion the
                clip plays once and hands the play control back on ended. */}
            <video key={projects[activeProject].video} ref={portfolioVideo} muted loop={!prefersReducedMotion()} playsInline preload="metadata" poster={projects[activeProject].poster} onLoadedMetadata={handlePortfolioMetadata} onTimeUpdate={handlePortfolioTimeUpdate} onWaiting={handlePortfolioWaiting} onPlaying={handlePortfolioPlaying} onEnded={() => { if (prefersReducedMotion()) { portfolioConsentedRef.current = false; setPortfolioNeedsPlay(true); } }} aria-label={`${projects[activeProject].title} project demo`} src={portfolioClip(projects[activeProject])} />
            <div className="portfolio-demo-vignette" />
            <div className="portfolio-playback" aria-hidden="true"><span /> Playing</div>
            {portfolioNeedsPlay && <button className="portfolio-demo-play" type="button" onClick={startPortfolioDemo}>
              <span aria-hidden="true">▶</span>
              <span>Play demo<small>{projects[activeProject].title}</small></span>
            </button>}
            <button className={`portfolio-back ${portfolioPhase.expanded ? 'visible' : ''}`} type="button" onClick={() => closePortfolioProject(true)} tabIndex={portfolioPhase.expanded ? 0 : -1} aria-hidden={!portfolioPhase.expanded}>
              <span aria-hidden="true">←</span>
              <span>All projects<small>or press Escape</small></span>
            </button>
            {/* data-section is what sectionOf() in analytics.js reads, so the
                outbound click on "Visit the live project" is attributed to the
                project that sent it rather than to a generic portfolio click. */}
            <article className="portfolio-story" data-section={`portfolio:${projects[activeProject].title}`} aria-hidden={!portfolioPhase.story}>
              <div className="portfolio-story-heading">
                <span>0{activeProject + 1} / 0{projects.length}</span>
                <h3>{projects[activeProject].title}</h3>
              </div>
              <div className="portfolio-story-copy">
                <p>{projects[activeProject].text}</p>
                <ul>{projects[activeProject].bullets.map(item => <li key={item}>{item}</li>)}</ul>
                <div className="stack-pills">{projects[activeProject].stack.map(item => <span className="pill" key={item}>{item}</span>)}</div>
                <a href={projects[activeProject].url} target="_blank" rel="noreferrer" tabIndex={portfolioPhase.story ? 0 : -1}>Visit the live project <span aria-hidden="true">↗</span></a>
              </div>
            </article>
            <div
              className="portfolio-scrubber"
              ref={portfolioScrubber}
              role="slider"
              aria-label={`Scrub the ${projects[activeProject].title} demo`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={0}
              tabIndex={portfolioPhase.expanded ? 0 : -1}
              onPointerDown={handlePortfolioScrubDown}
              onPointerMove={handlePortfolioScrubMove}
              onPointerUp={handlePortfolioScrubUp}
              onPointerCancel={handlePortfolioScrubUp}
              onKeyDown={handlePortfolioScrubKey}
            >
              <div className="portfolio-scrubber-track"><i /></div>
            </div>
          </div>

          <div className="portfolio-footer wrap" aria-hidden={portfolioPhase.expanded}>
            <div className="portfolio-count"><span>0{activeProject + 1}</span><i /><span>0{projects.length}</span></div>
            <div className="portfolio-dots" role="tablist" aria-label="Choose project">{projects.map((project, index) => <button type="button" key={project.title} className={activeProject === index ? 'active' : ''} onClick={() => showProject(index)} aria-label={`View ${project.title}`} aria-selected={activeProject === index} role="tab" tabIndex={portfolioPhase.expanded ? -1 : 0} />)}</div>
            <p><span className="gesture-sideways">↔ Browse</span><span>Open a project to play</span></p>
          </div>
        </div>
      </section>
      <section className="pad alt" id="pricing"><div className="wrap"><SectionHead label="Pricing" title="Choose your next growth move.">Clear starting points for stronger visibility, faster lead response, and less manual work. Choose a direction below and we’ll tailor it to your goals.</SectionHead><div className="tabbar reveal" role="tablist" aria-label="Pricing services">{[['web','Web Development'],['social','Social Media'],['ai','AI Automation']].map(([key, label]) => <button className={`tabbtn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} key={key} type="button" role="tab" aria-selected={tab === key} aria-controls="pricing-options">{label}</button>)}</div><div className="price-grid" id="pricing-options" role="tabpanel" aria-live="polite" aria-label={`${tab === 'web' ? 'Web Development' : tab === 'social' ? 'Social Media' : 'AI Automation'} packages`}>{prices[tab].map(([title, desc, price, items, popular], index) => <article className={`price-card pricing-card-enter ${popular ? 'popular' : ''}`} style={{ animationDelay: `${index * 70}ms` }} key={title}>{popular && <span className="badge">Most Popular</span>}<h4>{title}</h4><p className="plandesc">{desc}</p><div className="price">{price}</div><div className="pricenote">{tab === 'social' ? 'monthly engagement' : 'project scope'}</div><ul>{items.map(item => <li key={item}>{item}</li>)}</ul><Button href="#start" variant={popular ? 'ai' : 'ghost'}>Grow My Business</Button></article>)}</div><p className="pricing-note">Every package is a starting point. We’ll shape the scope around your goals, timeline, and current tools.</p></div></section>
      <section className="pad" id="about"><div className="wrap"><SectionHead label="About BiteSites" title="Small team. Serious digital work.">We combine thoughtful design, practical engineering, and emerging AI tools to help businesses move forward.</SectionHead><div className="mission reveal"><p>We believe technology should make your business feel lighter — clearer systems, better experiences, and less work lost in the cracks.</p></div><div className="values-grid">{[['Passion for Excellence','Exceptional websites and systems that make a lasting impact.'],['Timely Delivery','We respect your time and deliver projects on schedule.'],['Open Communication','Transparent updates that keep you informed every step of the way.'],['Innovation','We explore new technologies and design trends to stay ahead.']].map(([title, text]) => <div className="value-item reveal" key={title}><h4>{title}</h4><p>{text}</p></div>)}</div></div></section>
      <TeamSection />
      <section className="pad alt" id="consultation"><div className="wrap"><SectionHead label="Consultation" title="Let’s talk through what your business needs.">Tell us what you are trying to solve. We’ll recommend the right service direction and follow up to confirm a conversation.</SectionHead><div className="segments reveal" style={{ marginTop: 0 }}>{[['01 · Tell us what you need','Share your business, goals, preferred services, and the best way to contact you.'],['02 · We review the scope','We identify the right service mix and prepare practical next steps.'],['03 · We follow up','If the fit is right, we confirm the consultation details with you directly.']].map(([title, text]) => <div className="segment" key={title}><div className="tag">{title}</div><p>{text}</p></div>)}</div><div className="hero-actions reveal"><Button href="https://calendar.app.google/bKKKvGWBSgvV8rodA" variant="ai" target="_blank" rel="noreferrer">Schedule a free consultation</Button><Button href="#pricing" variant="ghost">See pricing</Button></div></div></section>
      <section className="pad"><div className="wrap"><div className="cta-final reveal"><Eyebrow>Get started</Eyebrow><h2>Ready to build what is next?</h2><p>Tell us what you need, choose services, and let us know how you want to be contacted.</p><div className="hero-actions"><Button href="#start" variant="ai">Start Your Project</Button><Button href="#pricing" variant="ghost">View Pricing</Button></div></div></div></section>
    </main>
    <footer className="site-footer"><div className="wrap footer-inner"><div className="footer-links footer-links-left"><a href="#services">Services</a><a href="#about">About</a><a href="#team">Team</a><a href="#pricing">Pricing</a></div><MorphingLogo location="footer" /><div className="footer-links footer-links-right"><a href="#start">Start a Project</a><Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link></div><div className="footer-copy">© 2026 BiteSites. All rights reserved.</div></div></footer>
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><div className="detail-panel" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}><button className="close" onClick={() => setModal(null)} aria-label="Close">×</button><div className="detail-hero"><Eyebrow gradient={modal === 'ai'}>Services</Eyebrow><h2>{detailCopy[modal][0]}</h2><p>{detailCopy[modal][1]}</p></div><div className="detail-content"><h3>What’s included</h3><ul className="detail-list">{detailCopy[modal][2].map(item => <li key={item}>{item}</li>)}</ul><div className="hero-actions"><Button href="#start" variant="ai" onClick={() => setModal(null)}>Start Your Project</Button><Button href="#pricing" variant="ghost" onClick={() => setModal(null)}>See pricing</Button></div></div></div></div>}
    <VoiceAIReceptionist open={voiceAgentOpen} onClose={() => setVoiceAgentOpen(false)} />
    {receptionistOpen && <AiReceptionist origin={chatOrigin} initialAnswer={receptionistInitialAnswer} onClose={closeReceptionist} />}
    {!receptionistOpen && !voiceAgentOpen && !voiceSectionVisible && <div className={`chat-launcher ${receptionistNudge ? 'nudged' : ''}`}><p>Need help scoping a project?</p><button type="button" onClick={openReceptionist} aria-label="Open Bit, the AI receptionist"><BitMascot className="bit-launcher-avatar" /><em>Chat with Bit</em></button></div>}
  </>;
}

function Field({ label, name, type = 'text', required = false }) { return <label className="field"><span>{label}</span><input name={name} type={type} required={required} /></label>; }

// The dashboard is a separate bundle: it pulls in Firebase Auth, the admin
// stylesheet and every chart, none of which a visitor to the marketing site
// should have to download. It only loads once someone navigates to /admin.
const AdminApp = lazy(() => import('./admin/AdminApp'));

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route
        path="/admin/*"
        element={<Suspense fallback={<div className="admin-boot">Loading dashboard…</div>}><AdminApp /></Suspense>}
      />
      {/* Everything else renders the marketing page, which navigates by hash anchor. */}
      <Route path="*" element={<App />} />
    </Routes>
  </BrowserRouter>
);
