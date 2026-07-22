#!/usr/bin/env node
/**
 * Portfolio clip capture.
 *
 * Renders each client site in Playwright's WebKit, drives it — scrolling, and for
 * some projects clicking through to other pages — at a fixed pixels-per-frame,
 * screenshots every frame as lossless PNG, and hands the sequence to ffmpeg.
 * Nothing is screen-recorded and nothing is rescaled, so there is exactly one
 * lossy generation: PNG -> H.264.
 *
 * Why this exists: the landscape masters are 1880x1080 (1.74:1) and the portfolio
 * stage on a phone is roughly 0.46:1, so `object-fit: cover` was throwing away
 * ~73% of every frame. See PORTFOLIO_PLAN.md.
 *
 * WebKit rather than Chromium because these clips ship as evidence that the sites
 * work on a phone, and the phone in question is overwhelmingly an iPhone. Chrome
 * device emulation is desktop Blink with a resized viewport; it will happily
 * render a layout that is broken in Safari.
 *
 *   node scripts/capture-portfolio.mjs                    # every project
 *   node scripts/capture-portfolio.mjs stockroomnj        # one
 *   node scripts/capture-portfolio.mjs --orientation landscape
 *   node scripts/capture-portfolio.mjs bodegaproject --probe   # run the tour, shoot nothing
 *   node scripts/capture-portfolio.mjs --frames 60        # short validation pass
 *   node scripts/capture-portfolio.mjs --keep-frames      # leave PNGs on disk
 */

import { webkit, devices } from 'playwright';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src/assets/portfolio');

/* ── Geometry ───────────────────────────────────────────────────────────────
 * Both output dimensions of both tiers must stay even for yuv420p.
 *
 * portrait: 405x877 CSS at dpr 2 gives 810x1754. 810/1754 = 0.4618; the expanded
 *   stage on a 390x844 phone is 0.4621. Matching them is the whole point — a
 *   mismatch here comes straight back as crop. 405 CSS px also sits inside the
 *   range real phones report (iPhone 16 Pro is 402), so the sites' own
 *   breakpoints resolve exactly as they would on device.
 * landscape: 940x540 at dpr 2 gives 1880x1080, which is the exact size of the
 *   owner-supplied masters the other projects ship. A capture and a recut are
 *   therefore interchangeable in the same `object-fit`, and the 720 tier is the
 *   same `scale=1280:-2` either way.
 *
 * A project may override either tier's viewport and dpr (see `geometry` below).
 * The product of the two must still land on the tier's pixel size, because the
 * encode and the CSS both assume it; `geometryFor` enforces that rather than
 * letting a typo ship a clip of the wrong shape.                              */
const DPR = 2;
const ORIENTATIONS = {
  landscape: {
    viewport: { width: 940, height: 540 }, device: null, suffix: '', rate: '6M',
    pixels: { width: 1880, height: 1080 },
    // The bytes tier, for viewports wide enough for the landscape frame but not
    // worth 1880px of it. Encoded from the same PNGs rather than from the 1080p
    // mp4, so it is a first generation too.
    tier720: { suffix: '-720', scale: 'scale=1280:-2', rate: '3M' }
  },
  portrait: {
    viewport: { width: 405, height: 877 }, device: 'iPhone 13', suffix: '-portrait', rate: '3M',
    pixels: { width: 810, height: 1754 }
  }
};

/* Resolve a project's geometry for one tier, and prove it still encodes to the
 * tier's pixel size. Both products must be even for yuv420p, which the tier
 * sizes already are — the check is that an override did not drift off them. */
const geometryFor = (project, orientation) => {
  const base = ORIENTATIONS[orientation];
  const geometry = { ...base, ...(project.geometry?.[orientation] ?? {}) };
  const dpr = geometry.dpr ?? DPR;
  for (const axis of ['width', 'height']) {
    const px = geometry.viewport[axis] * dpr;
    if (px !== base.pixels[axis]) {
      console.error(`${project.slug} ${orientation}: ${geometry.viewport.width}x${geometry.viewport.height} `
        + `@ dpr ${dpr} gives ${axis} ${px}, but the ${orientation} tier is ${base.pixels[axis]}`);
      process.exit(1);
    }
  }
  return { ...geometry, dpr };
};

/* ── Pacing ─────────────────────────────────────────────────────────────────
 * 9 px/frame at 30fps = 270 CSS px/s, so one screenful takes 3.2s. This is the
 * single dial behind goal #1 ("doesn't feel rushed"), and it is deliberately
 * global: every clip sharing one velocity is what makes the rail read as one
 * system. Duration is whatever the page height makes it, capped below.        */
const FPS = 30;
const PX_PER_FRAME = 9;
const HOLD_FRAMES = 15; // 0.5s parked at each end, so the loop cut lands on a
                        // still frame at both sides rather than mid-motion.
const AIM_FRAMES = 10;  // beat between a control arriving on screen and the click
                        // landing on it. Without it a button is pressed in the
                        // same frame it appears, which reads as a jump cut.
const TYPE_FRAMES = 4;  // frames held per character, so 7.5 char/s — a person
                        // typing, not a paste. A `type` step exists to show a
                        // search field *being searched*; at one frame per
                        // character the query would appear fully formed.
const MAX_SECONDS = 26;

/* Per-project escapes, all optional:
 *   dismiss      – selector(s) to click before capture (cookie banners, modals)
 *   waitFor      – selector(s) that must be visible before capture starts, on top
 *                  of `networkidle`. For anything rendered from a client-side data
 *                  fetch: the socket goes quiet the moment the SDK finishes
 *                  handshaking, which is well before the first document arrives,
 *                  so `networkidle` alone films the skeleton.
 *   styleTag     – CSS injected on arrival and after every navigation. Its one
 *                  sanctioned use is opaquing a translucent sticky header: three
 *                  of these sites run `rgba(…,.8) + backdrop-filter`, which is
 *                  correct on a real device — you scroll, so the blur reads as
 *                  depth — and garbage in a clip, where a still frame shows body
 *                  copy ghosted through the bar with no motion to explain it.
 *   geometry     – { landscape | portrait: { viewport, dpr } } to film a tier at
 *                  something other than the house geometry. Needed when a site's
 *                  own breakpoints put its real layout outside the default: see
 *                  bodegaprojectapp.
 *   travelPx     – override scroll distance instead of using full page height
 *   timeScale    – multiply CSS animation/transition durations. Frames are captured
 *                  slower than 1/30s of wall clock, so on-page animations otherwise
 *                  play back 2-4x too fast. Only matters when `prewarm` is off.
 *   prewarm      – default true: scroll the page once to force lazy images and
 *                  one-shot scroll reveals, then return to top. Costs the reveal
 *                  choreography, buys frames that are never half-loaded.
 *   orientations – which tiers to capture. Defaults to portrait only, because the
 *                  landscape tier of the older projects is an owner recut, not a
 *                  capture, and re-running this script must not overwrite it.
 *   tour         – an array of steps, or { portrait, landscape } when the two
 *                  layouts need different ones. See `runTour` for the grammar.
 *                  Without it the clip is a plain top-to-bottom scroll. */

/* Both Bodega entries are toured rather than scrolled, because on neither site
 * does the landing page carry the work. The research site's substance is behind
 * two tools and three sub-pages; the MVP's is behind a tab bar, and a scroll of
 * its feed would show a list and imply the rest of the app does not exist.
 * Selectors are matched on text, not href: the two navs emit relative links, so
 * `a[href="kpi-builder/"]` matches on the home page and misses on every other. */
const BODEGA_TOOLS_TOUR = {
  landscape: [
    { scroll: 700 },                                         // hero -> project highlights
    { open: 'a.tool-funnel-card--map', hold: 44 },           // -> Fast vs. Fresh Food Map
    { scroll: 120 },                                         // the whole control panel in frame
    { click: '#fastfoodToggle', hold: 26 },                  // drop the fast-food layer
    { click: '#layerModeBtn', hold: 38 },                    // heatmap -> clusters
    { click: '.main-nav .menu-toggle', hold: 18 },           // open the Tools submenu
    { open: '.main-nav .submenu a:text-is("KPI Builder")', hold: 38 },
    { click: '#roleDistributor', hold: 28 },                 // remodel the margins per role
    { click: '#roleBodega', hold: 28 },
    { open: '.main-nav .menu a:text-is("Story")', hold: 34 },
    { scroll: 560 }
  ],
  // The phone reaches the tools through the off-canvas drawer rather than the
  // funnel cards on the home page: those sit 2552px down a 11306px document, and
  // nine seconds of scrolling to reach a link is most of the clip's budget.
  portrait: [
    { scroll: 700 },
    { click: '#navToggle', hold: 22 },
    { open: '#mobileNav a:text-is("Fast vs. Fresh Food Map")', hold: 44 },
    { click: '#fastfoodToggle', hold: 26 },
    { click: '#layerModeBtn', hold: 38 },
    { click: '#navToggle', hold: 22 },
    { open: '#mobileNav a:text-is("KPI Builder")', hold: 38 },
    { click: '#roleDistributor', hold: 28 },
    { click: '#roleBodega', hold: 28 },
    { click: '#navToggle', hold: 22 },
    { open: '#mobileNav a:text-is("Story")', hold: 34 },
    { scroll: 520 }
  ]
};

/* The MVP is one document — every step here is in-page state, so the camera keeps
 * rolling straight through each transition rather than cutting on a navigation.
 *
 * `jump` before each tab change is load-bearing. Switching tabs swaps the content
 * but leaves `scrollY` where the last tab left it, so arriving on Local Map from
 * a scrolled feed opens 680px down — past the map, which is the whole tab. It is
 * a jump and not a `scroll` because two and a half seconds of scrolling backwards
 * is dead footage; cutting on the tab change reads as the page change it is. */
const BODEGA_APP_TOUR = [
  // 300, not the 380 the phone build wanted: the desktop layout this tour now
  // also films puts the crop filters higher in the frame, and the two tiers
  // share one step list. It is the only step where the difference showed.
  { scroll: 300 },
  { click: 'button:text-is("Greens")', hold: 32 },           // crop filter narrows the feed
  { click: 'button:text-is("Tomatoes")', hold: 32 },
  { click: 'button:text-is("All crops")', hold: 24 },
  { scroll: 300 },
  { click: 'button:text-is("Purchase")', hold: 58 },         // harvest detail sheet
  { click: 'button[aria-label="Close"]', hold: 20 },
  { jump: 0 },
  // The longest hold in either tour, and it buys less than it looks: the first
  // second of it is the map's own "Loading Newark map…" placeholder.
  { click: 'button:text-is("Local Map")', hold: 76 },        // tab 2 — the Newark food-node map
  { scroll: 400 },
  { jump: 0 },
  { click: 'button:text-is("My Harvest")', hold: 52 },       // tab 3 — the resident's own listings
  { scroll: 240 },
  { click: 'button:text-is("Add another harvest")', hold: 40 },
  { click: 'button:text-is("Tomatoes")', hold: 28 },         // inside the add-harvest sheet
  { click: 'button:text-is("Set a price")', hold: 34 }
];

/* The other four used to be plain scrolls, which filmed each site's *layout* and
 * none of its behaviour — while the dossier beside the clip promised a booking
 * flow, an estimate wizard, a live inventory and a search index. A visitor read
 * "five-step estimate wizard" next to twenty-six seconds of a page moving past.
 *
 * Each tour below is built around the one thing that project's copy claims and a
 * scroll cannot show. Everything else stays a scroll, because these are still
 * meant to read as sites, not as feature demos. */

/* Ends on the Cherry calculator rather than closing it: the sheet is a third
 * party's markup, its dismiss control is the only part not addressable by a
 * stable selector, and an open financing sheet is a better last frame than a
 * page. The nav is worth its 1.5s — "Pharmacy", "Patient Portal" and "Cherry
 * Payment" are three of the dossier's bullets, listed. */
const CLIFTON_TOUR = [
  { scroll: 640 },
  { click: '#mobileMenuToggle', hold: 36 },
  // Not the toggle again: once the overlay has finished animating in, its own
  // close button sits over the toggle and swallows the click. `--probe` does
  // not catch this — with nothing being screenshot a `hold` costs no wall
  // clock, so the overlay is still mid-transition and the toggle still exposed.
  { click: '#mobileMenuCloseBtn', hold: 12 },
  { scroll: 1150 },                                        // what we treat
  { scroll: 1150 },
  { scroll: 1150 },                                        // the clinic, reviews
  { click: 'button[aria-label="Open payment calculator"]', hold: 72 }
];

/* Answers step 1 of the wizard and advances it, then leaves it — step 2 is a
 * different question, not a different screen, and watching someone fill a form
 * is not the point. The point is that the form is live.
 *
 * Bella last. It is the only beat in the whole rail where a site says out loud
 * what it is ("Stone Bellisimo's 24/7 AI Voice Agent"), so it gets the longest
 * hold and the final frame. */
const STONE_TOUR = [
  { scroll: 760 },
  { click: '#wz1 .wz-opt:has-text("Kitchen")', hold: 26 },
  { click: '#wz1next', hold: 42 },
  { scroll: 1500 },                                        // our work
  { scroll: 1500 },                                        // materials
  { click: '#chat-bubble', hold: 78 }
];

/* The search field sits in the header of literally every frame of the old clip
 * and was never touched. Typing into it is the cheapest strong beat available on
 * this site: two keystrokes in, the panel is already sorting the org's own
 * taxonomy into SERVICES and RESEARCH, which is the claim the dossier makes. */
const NEXUS_TOUR = [
  { scroll: 900 },                                         // hero -> prototypes
  { scroll: 1100 },                                        // living systems
  { scroll: 1100 },                                        // River Veins
  { type: '#site-search', text: 'wetland', hold: 46 },
  { open: 'a:has-text("Floating Wetland Expansion")', hold: 50 },
  // The research page is short and this bottoms out on it. Deliberate — the
  // budget is spent on the 11,000px home page above, where there is something
  // to see, rather than padding the destination with a hold.
  { scroll: 1200 }
];

/* `waitFor` before anything moves. The old clip has "Loading current shop
 * highlights…" on screen at 0:04 — `prewarm` scrolled past the section before
 * Firestore had answered, and `networkidle` had long since fired.
 *
 * The detail modal is the whole reason this tour exists: it is the only place
 * the "multi-photo galleries, cart checkout" bullet is visible, and it is two
 * clicks from the top of the page. */
const STOCKROOM_TOUR = [
  { scroll: 900 },
  { scroll: 900 },                                         // search inventory
  { scroll: 700 },                                         // shop highlights
  { click: '.home-featured-product-view', hold: 54 },
  { click: '.product-detail-thumbnails button >> nth=2', hold: 34 },
  { click: 'button:text-is("Close")', hold: 18 },
  { click: '.home-featured-add-cart', hold: 30 },
  { click: '.cart-toggle', hold: 48 }
];

/* Three of these sites run a sticky header at rgba(…, ~0.8) with a backdrop
 * blur. On a phone that is good design; in a clip it is body copy ghosted
 * through the bar in most frames, because a still frame has no motion to
 * explain the translucency. Opaquing it is the smallest change that fixes it
 * and it alters nothing else about how the site renders. */
const OPAQUE = (selector, colour = '#fff') =>
  `${selector} { background: ${colour} !important; backdrop-filter: none !important; }`;

const PROJECTS = [
  {
    slug: 'cliftonaveanimalhospital',
    url: 'https://cliftonaveanimalhospital.com',
    // Without this the poster — the card thumbnail *and* the still behind the
    // video — is somebody else's microchip coupon over the hero.
    dismiss: '.site-promo-dismiss',
    styleTag: OPAQUE('.site-header'),
    tour: CLIFTON_TOUR
  },
  {
    slug: 'stonebellisimo',
    url: 'https://stonebellisimollc.com',
    styleTag: OPAQUE('#nav', '#121110'),   // this one's bar is dark, not white
    tour: STONE_TOUR
  },
  {
    slug: 'nexusverium',
    url: 'https://nexusverium.tech',
    styleTag: OPAQUE('header.glass-surface'),
    tour: NEXUS_TOUR
  },
  {
    slug: 'bodegaproject',
    url: 'https://jjimenez723.github.io/Bodega-Project-2/',
    orientations: ['landscape', 'portrait'],
    tour: BODEGA_TOOLS_TOUR
  },
  {
    slug: 'bodegaprojectapp',
    url: 'https://jjimenez723.github.io/the-bodega-project-demo/',
    orientations: ['landscape', 'portrait'],
    /* The zoom complaint, and it was never the CSS. The MVP is laid out to
     * max-width 1152px with a desktop breakpoint at 1024 — a sidebar, a two
     * column grid — and the house 940px landscape viewport sits below it, so
     * the clip was of the *phone* build: a 65px header and a 64px tab bar
     * eating 24% of a 540px-tall frame, 60px headline type, 940 CSS px of
     * layout. Play that full-bleed on a 1440px screen and every pixel is
     * magnified 1.53x; on a 2560px one, 2.7x.
     *
     * 1175 is chosen, not rounded to: it clears the 1152px content column by
     * 11px a side, so the desktop layout resolves with no dead gutter. 1504
     * @1.25 also encodes to 1880x1080 and leaves 350px of empty grey.
     * 675 CSS px of height also stops the add-harvest sheet being sliced by
     * the bottom of the frame, which 540 did at 0:24. */
    geometry: { landscape: { viewport: { width: 1175, height: 675 }, dpr: 1.6 } },
    // Same translucent-bar defect as the three sites above: both tab headings
    // scroll under it and ghost. `#fafafa`, not white — this app's chrome is
    // off-white and a pure white bar would read as a seam against the page.
    styleTag: OPAQUE('header', '#fafafa'),
    tour: BODEGA_APP_TOUR
  },
  {
    slug: 'stockroomnj',
    url: 'https://stockroomnj.com',
    styleTag: OPAQUE('.site-header'),
    waitFor: '.home-featured-product-view',
    tour: STOCKROOM_TOUR
  }
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = name => args.includes(`--${name}`);
const frameOverride = flag('frames') ? Number(flag('frames')) : null;
// Nothing is written to disk in probe mode: it exists to prove a tour's selectors
// still resolve after a site changes, which is the failure that costs a full
// capture run to discover otherwise.
const probe = has('probe');
const orientationOverride = flag('orientation');
if (orientationOverride && !ORIENTATIONS[orientationOverride]) {
  console.error(`Unknown --orientation. Known: ${Object.keys(ORIENTATIONS).join(', ')}`);
  process.exit(1);
}
const flagValues = new Set(['frames', 'orientation'].map(flag).filter(Boolean));
const selected = args.filter(a => !a.startsWith('--') && !flagValues.has(a));
const targets = selected.length
  ? PROJECTS.filter(p => selected.includes(p.slug))
  : PROJECTS;

if (!targets.length) {
  console.error(`No project matched. Known slugs:\n  ${PROJECTS.map(p => p.slug).join('\n  ')}`);
  process.exit(1);
}

const orientationsFor = project =>
  orientationOverride ? [orientationOverride] : (project.orientations || ['portrait']);

const tourFor = (project, orientation) => {
  const tour = project.tour;
  if (!tour) return null;
  return Array.isArray(tour) ? tour : tour[orientation];
};

const pad = n => String(n).padStart(5, '0');

/* Everything that has to be true of a document before it is filmed. Called once
 * on arrival and again after every navigation a tour makes — a tour lands on
 * pages this script never called `goto` on, and each of them needs the same
 * treatment as the first. */
async function settle(page, project) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    console.log('  · networkidle not reached, continuing');
  });

  // `scroll-behavior: smooth` would make every scrollTo animate, desyncing the
  // playhead from the frame counter and producing visible judder. This is the
  // one injection that is not optional.
  await page.addStyleTag({
    content: `html, body { scroll-behavior: auto !important; }
              ::-webkit-scrollbar { display: none !important; }
              ${project.styleTag || ''}
              ${project.timeScale ? `*, *::before, *::after {
                animation-duration: calc(var(--cap-t, 1s) * ${project.timeScale}) !important;
                transition-duration: calc(var(--cap-t, 1s) * ${project.timeScale}) !important; }` : ''}`
  }).catch(() => {});

  for (const selector of [].concat(project.dismiss || [])) {
    await page.click(selector, { timeout: 4_000 })
      .then(() => console.log(`  · dismissed ${selector}`))
      .catch(() => console.log(`  · ${selector} not present, skipping`));
  }

  // Soft, unlike a tour step: a `waitFor` that never resolves is the one failure
  // that is better filmed than fatal — a `goto` this tour made can legitimately
  // land on a page the gate does not apply to, and a warning in the log beats
  // losing an otherwise good capture at minute eight.
  for (const selector of [].concat(project.waitFor || [])) {
    await page.locator(selector).filter({ visible: true }).first()
      .waitFor({ state: 'visible', timeout: 25_000 })
      .then(() => console.log(`  · ${selector} settled`))
      .catch(() => console.log(`  ⚠ ${selector} never appeared — frames may show a loading state`));
  }

  await page.evaluate(() => document.fonts?.ready).catch(() => {});

  if (project.prewarm !== false) {
    // One full pass to trigger lazy loading and IntersectionObserver reveals,
    // then back to the top. Without it the capture records placeholder boxes
    // resolving into images — which reads as a slow site, the opposite of the
    // point.
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.8;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 120));
      }
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 600));
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(900);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

async function capture(browser, project, orientation) {
  const geometry = geometryFor(project, orientation);
  const framesDir = path.join(os.tmpdir(), `portfolio-frames-${project.slug}-${orientation}`);
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const context = await browser.newContext({
    ...(geometry.device ? devices[geometry.device] : {}),
    viewport: geometry.viewport,
    deviceScaleFactor: geometry.dpr,
    // Never capture the reduced-motion variant of a site — these clips exist to
    // show the motion design.
    reducedMotion: 'no-preference'
  });
  const page = await context.newPage();

  console.log(`\n▸ ${project.slug} · ${orientation}  ${geometry.viewport.width}x${geometry.viewport.height}`
    + `@${geometry.dpr}  ${project.url}`);
  await page.goto(project.url, { waitUntil: 'load', timeout: 60_000 });
  await settle(page, project);

  let n = 0;
  const started = Date.now();
  const scrollY = () => page.evaluate(() => window.scrollY);
  const maxScroll = () => page.evaluate(() =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight));

  const shoot = async () => {
    if (probe) { n++; return; }
    await page.screenshot({
      path: path.join(framesDir, `${pad(n++)}.png`),
      type: 'png',
      scale: 'device',
      caret: 'hide'
    });
  };
  const still = async frames => { for (let i = 0; i < frames; i++) await shoot(); };

  /* `within` is a selector for a scrollable element rather than the document.
   * Everything a tour scrolls goes through here, so one velocity governs the
   * page, a sidebar with its own overflow, and anything else that scrolls. */
  const glideTo = async (target, within = null) => {
    const [from, max] = await page.evaluate(sel => {
      const box = sel && document.querySelector(sel);
      return box
        ? [box.scrollTop, Math.max(0, box.scrollHeight - box.clientHeight)]
        : [window.scrollY, Math.max(0, document.documentElement.scrollHeight - window.innerHeight)];
    }, within);
    const to = Math.min(Math.max(0, target), max);
    const frames = Math.ceil(Math.abs(to - from) / PX_PER_FRAME);
    for (let i = 1; i <= frames; i++) {
      await page.evaluate(([sel, top]) => {
        const box = sel && document.querySelector(sel);
        if (box) box.scrollTop = top; else window.scrollTo({ top, behavior: 'instant' });
      }, [within, Math.round(from + (to - from) * (i / frames))]);
      await shoot();
    }
  };

  /* Bring a control on screen under the tour's own velocity and hand back the
   * locator. Playwright's click scrolls it into view itself, but instantly — a
   * jump cut mid-clip, and one that lands on whichever scroller happens to own
   * the element. So resolve that scroller here and travel it at PX_PER_FRAME.
   *
   * Two elements need no travel at all and must not get any: one riding a fixed
   * or sticky ancestor (the MVP's tab bar, this site's header) is on screen
   * wherever the document is, and its document position is meaningless. */
  const CAPTURE_SCROLLER = '[data-capture-scroller]';
  const aim = async selector => {
    const locator = page.locator(selector).filter({ visible: true }).first();
    await locator.waitFor({ state: 'visible', timeout: 20_000 });
    const plan = await locator.evaluate(el => {
      for (let node = el; node && node !== document.documentElement; node = node.parentElement)
        if (/^(fixed|sticky)$/.test(getComputedStyle(node).position)) return null;

      const rect = el.getBoundingClientRect();
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue;
        if (node.scrollHeight <= node.clientHeight + 4) continue;
        const frame = node.getBoundingClientRect();
        node.setAttribute('data-capture-scroller', '');
        return {
          within: true,
          to: rect.top - frame.top + node.scrollTop - (node.clientHeight - rect.height) * 0.4
        };
      }
      return { within: false, to: rect.top + window.scrollY - (window.innerHeight - rect.height) * 0.4 };
    });
    if (plan) {
      await glideTo(plan.to, plan.within ? CAPTURE_SCROLLER : null);
      if (plan.within) await page.evaluate(sel =>
        document.querySelectorAll(sel).forEach(n => n.removeAttribute('data-capture-scroller')), CAPTURE_SCROLLER);
    }
    return locator;
  };

  const runTour = async steps => {
    for (const [i, step] of steps.entries()) {
      const label = step.click || step.open || (step.type && `type "${step.text}" into ${step.type}`)
        || step.waitFor || (step.jump !== undefined
          ? `jump to ${step.jump}px` : `scroll ${step.scroll ?? 0}px`);
      try {
        // Mid-tour gate, and unlike the one in `settle` this one is fatal: a step
        // asked for it by name, so the thing it names is part of the tour.
        if (step.waitFor) {
          await page.locator(step.waitFor).filter({ visible: true }).first()
            .waitFor({ state: 'visible', timeout: 25_000 });
        }
        if (step.scroll) await glideTo(await scrollY() + step.scroll);
        // Repositions without filming: a cut, where `scroll` is a move.
        if (step.jump !== undefined) {
          await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), step.jump);
        }
        if (step.click) {
          const locator = await aim(step.click);
          await still(AIM_FRAMES);
          await locator.click({ timeout: 15_000 });
          await still(step.hold ?? 28);
        } else if (step.type) {
          const locator = await aim(step.type);
          await still(AIM_FRAMES);
          await locator.click({ timeout: 15_000 });
          // Per character rather than `fill`, and filmed between keystrokes: a
          // type-ahead panel is the thing being demonstrated, and it only reads
          // as one if the visitor watches it narrow.
          for (const character of step.text) {
            await locator.press(character === ' ' ? 'Space' : character, { timeout: 5_000 });
            await still(TYPE_FRAMES);
          }
          await still(step.hold ?? 40);
        } else if (step.open) {
          const locator = await aim(step.open);
          await still(AIM_FRAMES);
          const from = page.url();
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }).catch(() => null),
            locator.click({ timeout: 15_000 })
          ]);
          if (page.url() === from) throw new Error('click did not navigate');
          await settle(page, project);
          await still(step.hold ?? 36);
        } else if (step.hold) {
          await still(step.hold);
        }
      } catch (error) {
        // A tour step that silently no-ops ships a clip of a site sitting still.
        // Fail the capture instead: the encode below would happily produce it.
        throw new Error(`tour step ${i + 1} (${label}) failed on ${page.url()}: ${error.message}`);
      }
    }
  };

  const steps = tourFor(project, orientation);
  await still(HOLD_FRAMES);
  if (steps) {
    await runTour(steps);
    await still(HOLD_FRAMES);
    console.log(`  · ${steps.length} tour steps → ${n} frames (${(n / FPS).toFixed(1)}s)`);
    if (n / FPS > MAX_SECONDS) {
      console.log(`  ⚠ ${(n / FPS).toFixed(1)}s is over the ${MAX_SECONDS}s house limit; `
        + 'trim a step rather than speeding the tour up');
    }
  } else {
    const travel = project.travelPx ?? await maxScroll();
    const capFrames = MAX_SECONDS * FPS - HOLD_FRAMES * 2;
    let travelFrames = Math.ceil(travel / PX_PER_FRAME);
    if (travelFrames > capFrames) {
      console.log(`  · page is ${travel}px; capping travel at ${capFrames * PX_PER_FRAME}px `
        + `to stay under ${MAX_SECONDS}s (pacing held constant)`);
      travelFrames = capFrames;
    }
    if (frameOverride) travelFrames = frameOverride;
    await glideTo(travelFrames * PX_PER_FRAME);
    await still(HOLD_FRAMES);
    console.log(`  · ${travel}px scrollable → ${n} frames (${(n / FPS).toFixed(1)}s)`);
  }

  const cadence = (Date.now() - started) / n;
  console.log(`  · captured ${n} frames at ${cadence.toFixed(0)}ms/frame wall clock`);
  if (!probe && cadence > 60 && project.prewarm === false && !project.timeScale) {
    console.log(`  ⚠ on-page animations will play back ~${(cadence / (1000 / FPS)).toFixed(1)}x fast; `
      + 'set timeScale on this project to compensate');
  }

  await context.close();
  return framesDir;
}

async function encode(project, orientation, framesDir) {
  const geometry = ORIENTATIONS[orientation];
  const poster = path.join(OUT_DIR, `${project.slug}${geometry.suffix}-poster.webp`);

  // Flags mirror PORTFOLIO_PLAN.md §6.1, with two changes the PNG source forces:
  //   -pix_fmt yuv420p : x264 defaults to yuv444p from RGB input, which Safari
  //                      refuses to decode. Omitting this ships a black video.
  //   no scale filter  : frames are already at the target size, except for the
  //                      720 tier, which is the one place §6.1's scale applies.
  // `-maxrate` is per tier and it binds: screen capture at crf 20 wants more
  // than 3 Mbps at 1880px, so sharing one cap made the 720 tier and the master
  // the same size, which is the whole reason the 720 tier exists gone.
  const files = [];
  for (const tier of [geometry, geometry.tier720].filter(Boolean)) {
    const mp4 = path.join(OUT_DIR, `${project.slug}${tier.suffix}.mp4`);
    await run('ffmpeg', [
      '-y', '-framerate', String(FPS), '-i', path.join(framesDir, '%05d.png'),
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      ...(tier.scale ? ['-vf', tier.scale] : []),
      '-crf', '20', '-maxrate', tier.rate, '-bufsize', `${Number.parseInt(tier.rate, 10) * 2}M`,
      '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
      '-an', '-movflags', '+faststart', mp4
    ]);
    files.push(mp4);
  }

  // ffmpeg here has no libwebp encoder; cwebp takes the first frame directly,
  // which is also a cleaner source than a re-decoded video frame.
  await run('cwebp', ['-q', '82', path.join(framesDir, `${pad(0)}.png`), '-o', poster]);

  return { files, poster };
}

async function verify(mp4) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt,r_frame_rate',
    '-show_entries', 'format=duration,size', '-of', 'json', mp4]);
  const { streams: [v], format } = JSON.parse(stdout);

  const { stdout: keys } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v',
    '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', mp4]);
  // ffmpeg 8 emits a trailing separator on the first csv row, so strip commas
  // before parsing or frame 0 reads as NaN and poisons the interval.
  const times = keys.trim().split('\n').map(l => Number(l.replace(/,/g, ''))).filter(t => !Number.isNaN(t));
  const gop = times.length > 1 ? times[1] - times[0] : Infinity;

  const { stdout: atoms } = await run('sh', ['-c',
    `ffprobe -v trace -i "${mp4}" 2>&1 | grep -m4 "type:'\\(moov\\|mdat\\)'" || true`]);
  const faststart = atoms.indexOf("moov") !== -1
    && (atoms.indexOf("mdat") === -1 || atoms.indexOf("moov") < atoms.indexOf("mdat"));

  return {
    size: (Number(format.size) / 1e6).toFixed(1) + ' MB',
    duration: Number(format.duration).toFixed(2) + 's',
    dims: `${v.width}x${v.height}`,
    pix: v.pix_fmt,
    gop: gop.toFixed(2) + 's',
    ok: v.pix_fmt === 'yuv420p' && gop <= 0.55 && faststart && v.width % 2 === 0 && v.height % 2 === 0
  };
}

const browser = await webkit.launch();
const report = [];
try {
  for (const project of targets) {
    for (const orientation of orientationsFor(project)) {
      const framesDir = await capture(browser, project, orientation);
      if (probe) {
        console.log('  · probe run, nothing encoded');
        continue;
      }
      const { files, poster } = await encode(project, orientation, framesDir);
      for (const file of files) {
        const stats = await verify(file);
        report.push({ slug: `${project.slug} ${orientation}`, file, ...stats });
        console.log(`  · ${path.relative(ROOT, file)}  ${stats.dims} ${stats.duration} ${stats.size} `
          + `gop=${stats.gop} ${stats.ok ? '✓' : '✗ FAILED CHECKS'}`);
      }
      console.log(`  · ${path.relative(ROOT, poster)}`);
      if (!has('keep-frames')) await rm(framesDir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}

if (report.length) {
  console.log('\n' + report.map(r =>
    `${r.ok ? '✓' : '✗'} ${path.basename(r.file).padEnd(34)} ${r.dims}  ${r.duration.padStart(7)}  `
    + `${r.size.padStart(8)}  gop ${r.gop}`
  ).join('\n'));
}

if (report.some(r => !r.ok)) {
  console.error('\nOne or more clips failed verification — do not commit these.');
  process.exit(1);
}
