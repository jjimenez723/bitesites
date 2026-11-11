import React, { useState } from 'react';
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
 * panel runs parallel to it with an even gap. Visitors can switch which
 * project fills the screenshot. Below 980px the panels stack as rounded cards.
 */
const BOARD = { width: 1000, height: 620, radius: 26 };
const SHAPES = {
  intro: [[0, 0], [470, 0], [470, 230], [400, 330], [0, 330]],
  // One screenshot panel that wraps around the title card and the product card.
  shot: [[484, 0], [1000, 0], [1000, 318], [804, 416], [730, 620], [0, 620], [0, 344], [408, 344], [484, 236]],
  product: [[815, 427], [1000, 334], [1000, 620], [745, 620]]
};
const clip = Object.fromEntries(Object.entries(SHAPES).map(([key, points]) => [key, roundedPolygon(points, BOARD)]));

export const HERO_PROJECTS = Object.freeze([
  { id: 'nexus', name: 'Nexus Verium', image: nexusPoster, alt: 'Nexus Verium website: floating wetlands on a city river' },
  { id: 'stone', name: 'Stone Bellisimo', image: stonePoster, alt: 'Stone Bellisimo website: a modern kitchen with stone countertops', focus: 'right top' },
  { id: 'stockroom', name: 'The Stock Room', image: stockroomPoster, alt: 'The Stock Room website: a collector inspecting a sneaker in the shop' },
  { id: 'clifton', name: 'Clifton Ave', image: cliftonPoster, alt: 'Clifton Ave Animal Hospital website' },
  { id: 'bodega', name: 'Bodega Project', image: bodegaPoster, alt: 'Rutgers Newark Bodega Project website' }
]);

export default function HeroBento({ positioning, Button, Eyebrow }) {
  const [active, setActive] = useState(HERO_PROJECTS[0].id);
  // Only screenshots someone has asked for are loaded; the first loads with the page.
  const [loaded, setLoaded] = useState(() => new Set([HERO_PROJECTS[0].id]));
  const show = id => {
    setActive(id);
    setLoaded(previous => (previous.has(id) ? previous : new Set(previous).add(id)));
  };

  return <section className="hero revenue-hero hero-bento" aria-labelledby="hero-title">
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

      <div className="bento-panel bento-shot" style={{ '--clip': clip.shot }}>
        {HERO_PROJECTS.filter(project => loaded.has(project.id)).map(project => <img
          key={project.id}
          src={project.image}
          alt={project.id === active ? project.alt : ''}
          aria-hidden={project.id === active ? undefined : 'true'}
          className={project.id === active ? 'is-active' : ''}
          style={project.focus ? { objectPosition: project.focus } : undefined}
          decoding="async"
        />)}
        <div className="bento-switch" role="group" aria-label="Preview a website we built">
          <span className="bento-switch-label">Our work</span>
          {HERO_PROJECTS.map(project => <button
            key={project.id}
            type="button"
            aria-pressed={project.id === active}
            onClick={() => show(project.id)}
          >{project.name}</button>)}
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
