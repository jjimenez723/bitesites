#!/usr/bin/env node
/**
 * Open Graph card capture.
 *
 * Renders the share card as real HTML in Chromium and screenshots it at
 * 1200x630. It is built from the same tokens as the site — the `--gradient`
 * sweep, the `#050507` ink, the Tomorrow face, the hero's eyebrow/headline
 * rhythm — so the card cannot drift away from the brand the way a hand-exported
 * PNG does. Re-run it whenever the headline, the service list, or the logo
 * changes.
 *
 * Why this exists: the site shipped with no `og:image` at all, so iMessage fell
 * back to `favicon.svg` — a monochrome mark that renders black-on-white in a
 * message thread. A thread is already white, so the card is deliberately dark:
 * that contrast is what makes the link read as a brand rather than a bookmark.
 *
 *   node scripts/capture-og.mjs           # write public/og-cover-v1.jpg
 *   node scripts/capture-og.mjs --open    # ...and open it
 *   node scripts/capture-og.mjs --png     # lossless, for inspecting banding
 *
 * Bump OG_VERSION when the artwork changes. The version is in the *filename*,
 * not a query string, on purpose: Cloudflare, the Firebase CDN, Slack, and
 * especially iMessage all cache share images hard and some ignore query
 * strings entirely. A new filename is the only cache no one can serve stale.
 * Bumping it means editing the `og:image` URLs in index.html to match.
 */

import { chromium } from 'playwright';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OG_VERSION = 1;
const AS_PNG = process.argv.includes('--png');
const OUT = path.join(ROOT, 'public', `og-cover-v${OG_VERSION}.${AS_PNG ? 'png' : 'jpg'}`);

/* ── Canvas ─────────────────────────────────────────────────────────────────
 * 1200x630 is the size every consumer of this file expects; captured at dpr 2
 * so the text is not soft on a Retina panel, which is where most of these links
 * are actually opened.
 *
 * JPEG rather than PNG: the card is mostly a smooth blurred gradient, which is
 * the worst case for PNG's predictors — the lossless file runs ~1.2 MB, and
 * several scrapers skip images that large. The grain overlay below exists partly
 * to give the encoder something to hold onto, so q92 lands near 200 KB with no
 * visible banding. Use --png to check that claim after changing the artwork.  */
const WIDTH = 1200;
const HEIGHT = 630;
const DPR = 2;
const QUALITY = 92;

const SERVICES = ['Voice AI Receptionists', 'Web Development', 'AI Automation', 'Social Media', 'Custom AI'];

const GRADIENT = 'linear-gradient(115deg,#0071e3,#7c3aed 45%,#ff5e9c 75%,#34c9eb)';
const CONIC = 'conic-gradient(#0071e3,#7c3aed,#ff5e9c,#34c9eb,#0071e3)';

const browser = await chromium.launch();

/* ── Logo ───────────────────────────────────────────────────────────────────
 * The wordmark ships as black ink on a 500x500 transparent canvas, and it has to
 * be white here. `filter: invert(1)` is the obvious move and it is wrong: the
 * "bite" notch in the left chevron is painted as an *opaque white* circle rather
 * than punched out of the alpha, so inverting turns it into a black blob sitting
 * on the dark card.
 *
 * Instead, treat luminance as coverage — alpha *= (1 - luma), colour := white.
 * Black ink keeps its alpha and becomes solid white, the white circle drops to
 * alpha 0 and lets the card show through, and the antialiased edge greys land in
 * between rather than fringing. The result is then cropped to its own ink bounds,
 * which is what removes the ~34% dead padding above and below the lockup; the
 * caller gets back a tight image and never has to hardcode an inset.
 *
 * The full-lockup file is deliberately not used: it carries the "RAPID <>
 * CUSTOMIZABLE WEB DEVELOPMENT" tagline, which undersells a studio that also
 * ships voice agents and automation.                                          */
async function whiteWordmark() {
  const raw = await readFile(path.join(ROOT, 'src/assets/bitesites-logo-wordmark.webp'));
  const page = await browser.newPage();
  const out = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();

    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const px = ctx.getImageData(0, 0, c.width, c.height);
    const d = px.data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const luma = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        const a = Math.round(d[i + 3] * (1 - luma));
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = a;
        if (a > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    ctx.putImageData(px, 0, 0);

    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const crop = document.createElement('canvas');
    crop.width = w;
    crop.height = h;
    crop.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
    return { uri: crop.toDataURL('image/png'), w, h };
  }, `data:image/webp;base64,${raw.toString('base64')}`);
  await page.close();
  return out;
}

const logo = await whiteWordmark();

/* Film grain. Breaks up the banding a wide blurred gradient would otherwise show
   once JPEG quantises it, and reads as texture rather than noise at this
   opacity. Inline so the render has no network dependency beyond the webfont. */
const GRAIN = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/></filter><rect width="220" height="220" filter="url(%23n)"/></svg>`
)}")`;

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tomorrow:wght@400;500;600;700;800&display=block" rel="stylesheet">
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
    background: #050507;
    font-family: "Tomorrow", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card { position: relative; width: 100%; height: 100%; padding: 62px 72px 66px; display: flex; flex-direction: column; isolation: isolate; }

  /* The site's hero glow, re-lit for a dark ground. On #fff it runs at .15;
     against near-black it needs far more to register as colour rather than
     grey. Two orbs so the sweep travels — warm magenta high on the right,
     a cooler blue answering it low on the left. */
  .orb { position: absolute; border-radius: 50%; z-index: -3; }
  .orb-main   { width: 1080px; height: 1080px; top: -480px; right: -300px; background: ${CONIC}; filter: blur(140px); opacity: .95; }
  .orb-accent { width: 700px;  height: 700px;  bottom: -430px; left: -180px; background: ${CONIC}; filter: blur(140px); opacity: .5; }

  /* Keeps the left column — where every glyph lives — near black, and lets the
     colour survive on the right where nothing has to stay legible over it. */
  .veil { position: absolute; inset: 0; z-index: -2;
          background: linear-gradient(102deg, #050507 30%, rgba(5,5,7,.9) 52%, rgba(5,5,7,.42) 78%, rgba(5,5,7,.52) 100%); }
  .grain { position: absolute; inset: 0; z-index: -1; background-image: ${GRAIN}; opacity: .05; mix-blend-mode: overlay; }
  /* Reads as brand even at thumbnail size, where nothing but the headline does. */
  .edge { position: absolute; inset: 0 0 auto; height: 5px; background: ${GRADIENT}; }

  .wordmark { width: 268px; height: ${(268 * logo.h / logo.w).toFixed(2)}px; display: block; }

  /* Mirrors the site hero's own eyebrow -> headline rhythm. */
  .eyebrow { display: flex; align-items: center; gap: 11px; margin-top: auto; margin-bottom: 22px;
             font-size: 19px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
  .eyebrow .dot { width: 9px; height: 9px; border-radius: 50%; background: #7c3aed; flex: 0 0 auto; }
  .eyebrow span { background: ${GRADIENT}; -webkit-background-clip: text; background-clip: text; color: transparent; }

  h1 { font-size: 76px; font-weight: 400; line-height: 1.07; letter-spacing: -.005em; color: #fff; }
  h1 .g { background: ${GRADIENT}; -webkit-background-clip: text; background-clip: text; color: transparent; }

  .pills { display: flex; gap: 10px; margin-top: 40px; }
  .pill { padding: 11px 17px; border: 1px solid rgba(255,255,255,.19); border-radius: 100px;
          background: rgba(255,255,255,.06); backdrop-filter: blur(6px);
          color: rgba(255,255,255,.84); font-size: 21px; font-weight: 600; letter-spacing: .015em; white-space: nowrap; }
</style></head>
<body>
  <div class="card">
    <div class="orb orb-main"></div>
    <div class="orb orb-accent"></div>
    <div class="veil"></div>
    <div class="grain"></div>
    <div class="edge"></div>

    <img class="wordmark" src="${logo.uri}" alt="BiteSites">
    <div class="eyebrow"><i class="dot"></i><span>AI-Powered Digital Solutions</span></div>
    <h1>Intelligence built<br>into your <span class="g">business.</span></h1>
    <div class="pills">${SERVICES.map(s => `<span class="pill">${s}</span>`).join('')}</div>
  </div>
</body></html>`;

const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

/* A silent fallback to the generic sans is the one failure that still produces a
   plausible-looking file, so it has to be an error rather than a warning. */
if (!await page.evaluate(() => document.fonts.check('400 76px Tomorrow'))) {
  await browser.close();
  throw new Error('Tomorrow did not load — the card would render in a fallback face. Check network access to fonts.gstatic.com.');
}

/* The pills are the one row that can silently reflow if a label is renamed or the
   face falls back, and a wrapped row reads as a layout bug on the card. */
const rows = await page.evaluate(() =>
  new Set([...document.querySelectorAll('.pill')].map(p => Math.round(p.getBoundingClientRect().top))).size);
if (rows > 1) console.warn(`! service pills wrapped onto ${rows} rows — shorten a label or drop the pill font size`);

await page.screenshot(AS_PNG ? { path: OUT, type: 'png' } : { path: OUT, type: 'jpeg', quality: QUALITY });
await browser.close();

const { size } = await stat(OUT);
console.log(`${path.relative(ROOT, OUT)}  ${WIDTH}x${HEIGHT} @${DPR}x  ${(size / 1024).toFixed(0)} KB`);
if (size > 1024 * 1024) console.warn('! over 1 MB — some scrapers skip images this large');

if (process.argv.includes('--open')) execFile('open', [OUT]);
