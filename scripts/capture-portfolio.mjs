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
 *   same `scale=1280:-2` either way.                                          */
const DPR = 2;
const ORIENTATIONS = {
  landscape: {
    viewport: { width: 940, height: 540 }, device: null, suffix: '', rate: '6M',
    // The bytes tier, for viewports wide enough for the landscape frame but not
    // worth 1880px of it. Encoded from the same PNGs rather than from the 1080p
    // mp4, so it is a first generation too.
    tier720: { suffix: '-720', scale: 'scale=1280:-2', rate: '3M' }
  },
  portrait: { viewport: { width: 405, height: 877 }, device: 'iPhone 13', suffix: '-portrait', rate: '3M' }
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
const MAX_SECONDS = 26;

/* Per-project escapes, all optional:
 *   dismiss      – selector(s) to click before capture (cookie banners, modals)
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
  { scroll: 380 },
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

const PROJECTS = [
  { slug: 'cliftonaveanimalhospital', url: 'https://cliftonaveanimalhospital.com' },
  { slug: 'stonebellisimo', url: 'https://stonebellisimollc.com' },
  { slug: 'nexusverium', url: 'https://nexusverium.tech' },
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
    tour: BODEGA_APP_TOUR
  },
  { slug: 'stockroomnj', url: 'https://stockroomnj.com' }
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
              ${project.timeScale ? `*, *::before, *::after {
                animation-duration: calc(var(--cap-t, 1s) * ${project.timeScale}) !important;
                transition-duration: calc(var(--cap-t, 1s) * ${project.timeScale}) !important; }` : ''}`
  }).catch(() => {});

  for (const selector of [].concat(project.dismiss || [])) {
    await page.click(selector, { timeout: 4_000 })
      .then(() => console.log(`  · dismissed ${selector}`))
      .catch(() => console.log(`  · ${selector} not present, skipping`));
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
  const geometry = ORIENTATIONS[orientation];
  const framesDir = path.join(os.tmpdir(), `portfolio-frames-${project.slug}-${orientation}`);
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const context = await browser.newContext({
    ...(geometry.device ? devices[geometry.device] : {}),
    viewport: geometry.viewport,
    deviceScaleFactor: DPR,
    // Never capture the reduced-motion variant of a site — these clips exist to
    // show the motion design.
    reducedMotion: 'no-preference'
  });
  const page = await context.newPage();

  console.log(`\n▸ ${project.slug} · ${orientation}  ${project.url}`);
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
      const label = step.click || step.open || (step.jump !== undefined
        ? `jump to ${step.jump}px` : `scroll ${step.scroll ?? 0}px`);
      try {
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
