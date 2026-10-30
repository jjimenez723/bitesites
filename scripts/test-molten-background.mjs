// Decorative-background QA. Block production API requests and all writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.MARKETING_TEST_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch();
const errors = [];
async function setup(options = {}, disableWebGL = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...options });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== 'GET' || req.resourceType() === 'media' || url.pathname.startsWith('/api/')) return route.abort();
    if (url.origin !== new URL(base).origin && !['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  await page.addInitScript(disable => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (disable && /webgl/.test(type)) return null;
      const gl = getContext.call(this, type, ...args);
      if (gl && /webgl/.test(type) && !gl.__moltenTest) {
        gl.__moltenTest = true;
        const draw = gl.drawArrays.bind(gl);
        gl.drawArrays = (...values) => { this.dataset.draws = String(Number(this.dataset.draws || 0) + 1); return draw(...values); };
        const names = new Map();
        const location = gl.getUniformLocation.bind(gl);
        gl.getUniformLocation = (program, name) => { const result = location(program, name); names.set(result, name); return result; };
        const uniform = gl.uniform2fv.bind(gl);
        gl.uniform2fv = (where, values, ...args) => {
          if (names.get(where) === 'uMouse') this.dataset.mouse = JSON.stringify(Array.from(values));
          return uniform(where, values, ...args);
        };
      }
      return gl;
    };
  }, disableWebGL);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.revenue-hero').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

try {
  const page = await setup();
  const hero = page.locator('.revenue-hero');
  const canvas = hero.locator('canvas[data-rendered="true"]');
  await canvas.waitFor();
  assert.equal(await page.locator('.molten-backdrop').count(), 2);
  assert.equal(await page.locator('.molten-cta canvas').count(), 0, 'Offscreen CTA does not mount a renderer');
  assert.ok(await canvas.evaluate(el => el.width * el.height <= 1001000), 'Desktop pixel budget is bounded');
  const count = Number(await canvas.getAttribute('data-draws'));
  await page.waitForTimeout(500);
  const frames = Number(await canvas.getAttribute('data-draws')) - count;
  assert.ok(frames > 0 && frames <= 20, 'Visible background animates at a capped frame rate');
  await page.mouse.move(1250, 430);
  await page.waitForFunction(() => {
    const raw = document.querySelector('.revenue-hero canvas')?.dataset.mouse;
    return raw && JSON.parse(raw)[0] > .58;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const paused = Number(await canvas.getAttribute('data-draws'));
  await page.waitForTimeout(250);
  assert.equal(Number(await canvas.getAttribute('data-draws')), paused, 'Hidden tab pauses rendering');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(800);
  assert.ok(Number(await canvas.getAttribute('data-draws')) > paused);
  await page.screenshot({ path: '/tmp/bitesites-molten-desktop.png' });
  await page.locator('.molten-cta').scrollIntoViewIfNeeded();
  await page.locator('.molten-cta canvas[data-rendered="true"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('.revenue-hero canvas'));
  await page.waitForTimeout(800);
  await page.locator('.molten-cta').screenshot({ path: '/tmp/bitesites-molten-final-cta.png' });
  await page.getByRole('link', { name: 'Get a Free Revenue Leak Audit', exact: true }).click();
  await page.waitForURL('**/#start');
  await page.getByRole('checkbox', { name: /Custom AI project/ }).check();
  await page.locator('.project-next').click();
  await page.getByRole('radio', { name: /Just me/ }).waitFor();
  assert.equal(await page.locator('.holo-card').count(), 29);
  assert.equal(await page.locator('.electric-brand').count(), 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); });
  await page.waitForFunction(() => !document.querySelector('.molten-backdrop canvas'));
  assert.notEqual(await hero.locator('.molten-backdrop').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
  for (const width of [320, 390, 768, 900, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Fits ${width}px`);
    for (const selector of ['.revenue-hero h1', '.molten-cta h2']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `Heading fits ${width}px`);
    }
  }
  await page.close();

  const touch = await setup({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await touch.locator('.revenue-hero canvas[data-rendered="true"]').waitFor();
  assert.ok(await touch.locator('.revenue-hero canvas').evaluate(el => el.width * el.height <= 351000), 'Mobile has a smaller pixel budget');
  await touch.waitForTimeout(800);
  await touch.screenshot({ path: '/tmp/bitesites-molten-mobile.png' });
  await touch.getByRole('link', { name: 'Find My Revenue Leaks', exact: true }).tap();
  await touch.waitForURL('**/#start');
  await touch.locator('.molten-cta').scrollIntoViewIfNeeded();
  await touch.locator('.molten-cta canvas[data-rendered="true"]').waitFor();
  await touch.waitForTimeout(800);
  await touch.locator('.molten-cta').screenshot({ path: '/tmp/bitesites-molten-mobile-cta.png' });
  await touch.close();

  const fallback = await setup({}, true);
  await fallback.waitForTimeout(700);
  assert.equal(await fallback.locator('.molten-backdrop canvas').count(), 0);
  assert.equal(await fallback.locator('.revenue-hero h1').isVisible(), true);
  await fallback.getByRole('link', { name: 'Find My Revenue Leaks', exact: true }).click();
  await fallback.waitForURL('**/#start');
  await fallback.close();
  assert.deepEqual(errors, []);
  console.log('PASS: Two molten backgrounds, actual animation/pointer response, pixel/frame budgets, hidden-tab and offscreen behavior, desktop/mobile CTAs, custom form, reduced-motion/WebGL fallback and six widths.');
} finally { await browser.close(); }
