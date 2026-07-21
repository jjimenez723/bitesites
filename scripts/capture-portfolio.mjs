#!/usr/bin/env node
/**
 * Portrait portfolio clip capture.
 *
 * Renders each client site in Playwright's WebKit at a phone viewport, scrolls it
 * at a fixed pixels-per-frame, screenshots every frame as lossless PNG, and hands
 * the sequence to ffmpeg. Nothing is screen-recorded and nothing is rescaled, so
 * there is exactly one lossy generation: PNG -> H.264.
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
 *   node scripts/capture-portfolio.mjs                 # all five
 *   node scripts/capture-portfolio.mjs stockroomnj     # one
 *   node scripts/capture-portfolio.mjs --frames 60     # short validation pass
 *   node scripts/capture-portfolio.mjs --keep-frames   # leave PNGs on disk
 */

import { webkit, devices } from 'playwright';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src/assets/portfolio');

/* ── Geometry ───────────────────────────────────────────────────────────────
 * 405x877 CSS at dpr 2 gives 810x1754 device pixels. 810/1754 = 0.4618; the
 * expanded stage on a 390x844 phone is 0.4621. Matching them is the whole point
 * — a mismatch here comes straight back as crop. 405 CSS px also sits inside the
 * range real phones report (iPhone 16 Pro is 402), so the sites' own breakpoints
 * resolve exactly as they would on device.
 * Both output dimensions must stay even for yuv420p.                         */
const VIEWPORT = { width: 405, height: 877 };
const DPR = 2;

/* ── Pacing ─────────────────────────────────────────────────────────────────
 * 9 px/frame at 30fps = 270 CSS px/s, so one screenful takes 3.2s. This is the
 * single dial behind goal #1 ("doesn't feel rushed"), and it is deliberately
 * global: five clips sharing one velocity is what makes the rail read as one
 * system. Duration is whatever the page height makes it, capped below.        */
const FPS = 30;
const PX_PER_FRAME = 9;
const HOLD_FRAMES = 15; // 0.5s parked at each end, so the loop cut lands on a
                        // still frame at both sides rather than mid-motion.
const MAX_SECONDS = 26;

const PROJECTS = [
  { slug: 'cliftonaveanimalhospital', url: 'https://cliftonaveanimalhospital.com' },
  { slug: 'stonebellisimo', url: 'https://stonebellisimollc.com' },
  { slug: 'nexusverium', url: 'https://nexusverium.tech' },
  { slug: 'bodegaproject', url: 'https://jjimenez723.github.io/the-bodega-project-demo/' },
  { slug: 'stockroomnj', url: 'https://stockroomnj.com' }
];

/* Per-project escapes, all optional:
 *   dismiss   – selector(s) to click before capture (cookie banners, modals)
 *   travelPx  – override scroll distance instead of using full page height
 *   timeScale – multiply CSS animation/transition durations. Frames are captured
 *               slower than 1/30s of wall clock, so on-page animations otherwise
 *               play back 2-4x too fast. Only matters when `prewarm` is off.
 *   prewarm   – default true: scroll the page once to force lazy images and
 *               one-shot scroll reveals, then return to top. Costs the reveal
 *               choreography, buys frames that are never half-loaded. */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = name => args.includes(`--${name}`);
const frameOverride = flag('frames') ? Number(flag('frames')) : null;
const selected = args.filter(a => !a.startsWith('--') && !/^\d+$/.test(a));
const targets = selected.length
  ? PROJECTS.filter(p => selected.includes(p.slug))
  : PROJECTS;

if (!targets.length) {
  console.error(`No project matched. Known slugs:\n  ${PROJECTS.map(p => p.slug).join('\n  ')}`);
  process.exit(1);
}

const pad = n => String(n).padStart(5, '0');

async function capture(browser, project) {
  const framesDir = path.join(os.tmpdir(), `portfolio-frames-${project.slug}`);
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const context = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    // Never capture the reduced-motion variant of a site — these clips exist to
    // show the motion design.
    reducedMotion: 'no-preference'
  });
  const page = await context.newPage();

  console.log(`\n▸ ${project.slug}  ${project.url}`);
  await page.goto(project.url, { waitUntil: 'load', timeout: 60_000 });
  // networkidle is advisory here: sites with polling or a live socket never
  // reach it, and waiting for images matters more than waiting for XHR.
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
  });

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

  const maxScroll = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight));

  const capFrames = MAX_SECONDS * FPS - HOLD_FRAMES * 2;
  let travelFrames = Math.ceil(maxScroll / PX_PER_FRAME);
  if (travelFrames > capFrames) {
    console.log(`  · page is ${maxScroll}px; capping travel at ${capFrames * PX_PER_FRAME}px `
      + `to stay under ${MAX_SECONDS}s (pacing held constant)`);
    travelFrames = capFrames;
  }
  if (frameOverride) travelFrames = frameOverride;

  const total = HOLD_FRAMES * 2 + travelFrames;
  console.log(`  · ${maxScroll}px scrollable → ${total} frames (${(total / FPS).toFixed(1)}s)`);

  const started = Date.now();
  let n = 0;
  const shoot = async y => {
    await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), y);
    await page.screenshot({
      path: path.join(framesDir, `${pad(n++)}.png`),
      type: 'png',
      scale: 'device',
      caret: 'hide'
    });
  };

  for (let i = 0; i < HOLD_FRAMES; i++) await shoot(0);
  for (let i = 1; i <= travelFrames; i++) await shoot(Math.min(i * PX_PER_FRAME, maxScroll));
  for (let i = 0; i < HOLD_FRAMES; i++) await shoot(maxScroll);

  const cadence = (Date.now() - started) / total;
  console.log(`  · captured ${total} frames at ${cadence.toFixed(0)}ms/frame wall clock`);
  if (cadence > 60 && project.prewarm === false && !project.timeScale) {
    console.log(`  ⚠ on-page animations will play back ~${(cadence / (1000 / FPS)).toFixed(1)}x fast; `
      + 'set timeScale on this project to compensate');
  }

  await context.close();
  return { framesDir, total };
}

async function encode(project, framesDir) {
  const mp4 = path.join(OUT_DIR, `${project.slug}-portrait.mp4`);
  const poster = path.join(OUT_DIR, `${project.slug}-portrait-poster.webp`);

  // Flags mirror PORTFOLIO_PLAN.md §6.1, with two changes the PNG source forces:
  //   -pix_fmt yuv420p : x264 defaults to yuv444p from RGB input, which Safari
  //                      refuses to decode. Omitting this ships a black video.
  //   no scale filter  : frames are already at the target size.
  await run('ffmpeg', [
    '-y', '-framerate', String(FPS), '-i', path.join(framesDir, '%05d.png'),
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', '20', '-maxrate', '3M', '-bufsize', '6M',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    '-an', '-movflags', '+faststart', mp4
  ]);

  // ffmpeg here has no libwebp encoder; cwebp takes the first frame directly,
  // which is also a cleaner source than a re-decoded video frame.
  await run('cwebp', ['-q', '82', path.join(framesDir, `${pad(0)}.png`), '-o', poster]);

  return { mp4, poster };
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
    const { framesDir } = await capture(browser, project);
    const { mp4, poster } = await encode(project, framesDir);
    const stats = await verify(mp4);
    report.push({ slug: project.slug, ...stats });
    console.log(`  · ${path.relative(ROOT, mp4)}  ${stats.dims} ${stats.duration} ${stats.size} `
      + `gop=${stats.gop} ${stats.ok ? '✓' : '✗ FAILED CHECKS'}`);
    console.log(`  · ${path.relative(ROOT, poster)}`);
    if (!has('keep-frames')) await rm(framesDir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}

console.log('\n' + report.map(r =>
  `${r.ok ? '✓' : '✗'} ${r.slug.padEnd(26)} ${r.dims}  ${r.duration.padStart(7)}  ${r.size.padStart(8)}  gop ${r.gop}`
).join('\n'));

if (report.some(r => !r.ok)) {
  console.error('\nOne or more clips failed verification — do not commit these.');
  process.exit(1);
}
