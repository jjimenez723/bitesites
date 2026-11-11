import React from 'react';
import { roundedPolygon } from '../lib/rounded-polygon';
import projectWide from '../assets/portfolio/cliftonaveanimalhospital-poster.webp';
import projectThumb from '../assets/portfolio/bodegaprojectapp-portrait-poster.webp';

/*
 * Bento hero: a title card in the top-left corner, one project screenshot
 * seen through two panels that wrap around it, and an AI receptionist card
 * cut into the bottom-right corner. Both image panels place the same picture
 * on the whole board, so on desktop it reads as one image. The four panels share one
 * 1000 x 620 board, and every edge that faces another panel runs parallel to it
 * with an even gap. Below 1180px the panels stack as plain rounded cards.
 */
const BOARD = { width: 1000, height: 620, radius: 26 };
const SHAPES = {
  intro: [[0, 0], [470, 0], [470, 230], [400, 330], [0, 330]],
  main: [[484, 0], [1000, 0], [1000, 318], [812, 412], [498, 412], [420, 327], [484, 236]],
  wide: [[0, 344], [416, 344], [488, 426], [800, 426], [730, 620], [0, 620]],
  product: [[815, 427], [1000, 334], [1000, 620], [745, 620]]
};
const clip = Object.fromEntries(Object.entries(SHAPES).map(([key, points]) => [key, roundedPolygon(points, BOARD)]));

export default function HeroBento({ positioning, Button, Eyebrow }) {
  return <section className="hero revenue-hero hero-bento" aria-labelledby="hero-title">
    <div className="bento-board">
      <a className="bento-panel bento-main bento-shot" style={{ '--clip': clip.main }} href="#portfolio" tabIndex={-1} aria-hidden="true">
        <img src={projectWide} alt="" />
      </a>

      <div className="bento-panel bento-intro" style={{ '--clip': clip.intro }}>
        <div className="bento-intro-body">
          <Eyebrow gradient>{positioning.eyebrow}</Eyebrow>
          <h1 id="hero-title">Stop losing leads.<br /><span className="gradient-text">Turn more inquiries into customers.</span></h1>
          <div className="bento-intro-row">
            <img className="bento-thumb" src={projectThumb} alt="" width="120" height="150" />
            <p className="lead">{positioning.description}</p>
          </div>
          <div className="hero-actions">
            <Button href="#start" variant="ai">Find My Revenue Leaks</Button>
            <Button href="/services" variant="ghost">See How the System Works</Button>
          </div>
        </div>
      </div>

      <a className="bento-panel bento-wide bento-shot" style={{ '--clip': clip.wide }} href="#portfolio">
        <img src={projectWide} alt="Clifton Ave Animal Hospital website, built by BiteSites" />
        <span className="bento-tag">Selected project · Clifton Ave Animal Hospital <span aria-hidden="true">→</span></span>
      </a>

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
