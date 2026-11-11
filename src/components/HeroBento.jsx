import React, { useEffect, useRef, useState } from 'react';
import MoltenBackdrop from './MoltenBackdrop';
import { roundedPolygon } from '../lib/rounded-polygon';
import stonePoster from '../assets/portfolio/stonebellisimo-poster.webp';
import nexusPoster from '../assets/portfolio/nexusverium-poster.webp';
import stockroomPoster from '../assets/portfolio/stockroomnj-poster.webp';
import cliftonPoster from '../assets/portfolio/cliftonaveanimalhospital-poster.webp';
import bodegaPoster from '../assets/portfolio/bodegaproject-poster.webp';

/*
 * Bento hero: a title card in the top-left corner, one project screenshot
 * that wraps around it, and an AI receptionist card cut into the
 * bottom-right corner, all floating on the original molten background. The
 * three panels share one 1000 x 620 board, and every edge that faces another
 * panel runs parallel to it with an even gap. The screenshot is a carousel of
 * our sites: it cross-fades to the next one every four seconds, and visitors can
 * pick one or pause it. It holds while the pointer is on the project pill, on
 * keyboard focus, off screen and in a hidden tab. Reduced motion keeps the
 * rotation but drops the zoom, and the pause button is always there. Below 980px the panels
 * stack as rounded cards.
 */
const BOARD = { width: 1000, height: 620, radius: 26 };
const SHAPES = {
  intro: [[0, 0], [470, 0], [470, 230], [400, 330], [0, 330]],
  // One screenshot panel that wraps around the title card and the product card.
  shot: [[484, 0], [1000, 0], [1000, 318], [804, 416], [730, 620], [0, 620], [0, 344], [408, 344], [484, 236]],
  product: [[815, 427], [1000, 334], [1000, 620], [745, 620]]
};
const clip = Object.fromEntries(Object.entries(SHAPES).map(([key, points]) => [key, roundedPolygon(points, BOARD)]));

const SLIDE_MS = 4000;

export const HERO_PROJECTS = Object.freeze([
  { id: 'nexus', name: 'Nexus Verium', image: nexusPoster, alt: 'Nexus Verium website: floating wetlands on a city river' },
  { id: 'stone', name: 'Stone Bellisimo', image: stonePoster, alt: 'Stone Bellisimo website: a modern kitchen with stone countertops', focus: 'right top' },
  { id: 'stockroom', name: 'The Stock Room', image: stockroomPoster, alt: 'The Stock Room website: a collector inspecting a sneaker in the shop' },
  { id: 'clifton', name: 'Clifton Ave', image: cliftonPoster, alt: 'Clifton Ave Animal Hospital website' },
  { id: 'bodega', name: 'Bodega Project', image: bodegaPoster, alt: 'Rutgers Newark Bodega Project website' }
]);

export default function HeroBento({ positioning, Button, Eyebrow }) {
  const [active, setActive] = useState(HERO_PROJECTS[0].id);
  // The first screenshot loads with the page; each next one loads a slide ahead.
  const [loaded, setLoaded] = useState(() => new Set(HERO_PROJECTS.slice(0, 2).map(project => project.id)));
  const [stopped, setStopped] = useState(false);
  const [holds, setHolds] = useState({ hover: false, focus: false, hidden: false, offscreen: false });
  const sectionRef = useRef(null);
  const activeRef = useRef(active);
  const remaining = useRef(SLIDE_MS);
  activeRef.current = active;

  const hold = (reason, value) => setHolds(previous => (previous[reason] === value ? previous : { ...previous, [reason]: value }));
  const autoplay = !stopped;
  const paused = !autoplay || Object.values(holds).some(Boolean);
  const nextOf = id => HERO_PROJECTS[(HERO_PROJECTS.findIndex(project => project.id === id) + 1) % HERO_PROJECTS.length].id;
  const show = id => {
    if (id === activeRef.current) return;
    remaining.current = SLIDE_MS;
    setActive(id);
  };

  useEffect(() => {
    const next = nextOf(active);
    setLoaded(previous => (previous.has(active) && previous.has(next) ? previous : new Set(previous).add(active).add(next)));
  }, [active]);

  useEffect(() => {
    const onVisibility = () => hold('hidden', document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    const section = sectionRef.current;
    const observer = section && 'IntersectionObserver' in window
      ? new IntersectionObserver(([entry]) => hold('offscreen', !entry.isIntersecting), { threshold: .15 })
      : null;
    if (observer) observer.observe(section);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
    };
  }, []);

  // One timer per slide. Pausing keeps the time left, so the progress bar and
  // the switch stay in step when it resumes.
  useEffect(() => {
    if (paused) return undefined;
    const slide = active;
    const startedAt = performance.now();
    const timer = setTimeout(() => {
      remaining.current = SLIDE_MS;
      setActive(nextOf(slide));
    }, remaining.current);
    return () => {
      clearTimeout(timer);
      if (activeRef.current === slide) remaining.current = Math.max(0, remaining.current - (performance.now() - startedAt));
    };
  }, [active, paused]);

  return <section className="hero revenue-hero hero-bento" aria-labelledby="hero-title" ref={sectionRef}>
    <div className="hero-bg"><MoltenBackdrop /><div className="hero-overlay" /></div>
    <div className="bento-board">
      <div className="bento-panel bento-intro" style={{ '--clip': clip.intro }}>
        <div className="bento-intro-body">
          <Eyebrow gradient>{positioning.eyebrow}</Eyebrow>
          <h1 id="hero-title">Stop losing leads.<br /><span className="gradient-text">Turn more inquiries into customers.</span></h1>
          <p className="lead">{positioning.description}</p>
          <div className="hero-actions">
            <Button href="#start" variant="ai">Find My Revenue Leaks</Button>
            <Button href="/services" variant="ghost">See How the System Works</Button>
          </div>
        </div>
      </div>

      <div
        className="bento-panel bento-shot"
        style={{ '--clip': clip.shot, '--slide-ms': `${SLIDE_MS}ms` }}
        aria-roledescription="carousel"
        aria-label="Websites we built"
        // Keyboard focus holds the slide; a mouse click on a name does not.
        onFocus={event => { if (event.target.matches?.(':focus-visible')) hold('focus', true); }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) hold('focus', false); }}
      >
        {HERO_PROJECTS.filter(project => loaded.has(project.id)).map(project => <img
          key={project.id}
          src={project.image}
          alt={project.id === active ? project.alt : ''}
          aria-hidden={project.id === active ? undefined : 'true'}
          className={project.id === active ? 'is-active' : ''}
          style={project.focus ? { objectPosition: project.focus } : undefined}
          decoding="async"
        />)}
        <div
          className="bento-switch"
          role="group"
          aria-label="Preview a website we built"
          data-autoplay={autoplay || undefined}
          data-paused={paused || undefined}
          onMouseEnter={() => hold('hover', true)}
          onMouseLeave={() => hold('hover', false)}
        >
          <span className="bento-switch-label">Our work</span>
          {HERO_PROJECTS.map(project => <button
            key={project.id}
            type="button"
            aria-pressed={project.id === active}
            onClick={() => show(project.id)}
          >{project.name}</button>)}
          <button
            type="button"
            className="bento-switch-toggle"
            aria-label={stopped ? 'Play the slideshow' : 'Pause the slideshow'}
            onClick={() => setStopped(value => !value)}
          ><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
            {stopped ? <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /> : <path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor" />}
          </svg></button>
          <a className="bento-switch-link" href="#portfolio" aria-label="See all projects">
            <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>

      <a className="bento-panel bento-product" style={{ '--clip': clip.product }} href="#ai-receptionist">
        <span className="bento-product-body">
          <span className="bento-kicker">Meet Byte</span>
          <strong>Our AI receptionist answers every call, day or night.</strong>
          <span className="bento-link">Talk to Byte <span aria-hidden="true">→</span></span>
        </span>
      </a>
    </div>
  </section>;
}
