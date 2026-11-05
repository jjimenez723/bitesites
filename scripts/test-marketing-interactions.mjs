// Hover, keyboard, touch and reduced-motion checks. No API traffic or writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.MARKETING_TEST_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch();
const errors = [];
const sections = ['system', 'services', 'industries'];
async function safePage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, ...options });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || request.resourceType() === 'media' || url.pathname.startsWith('/api/')) return route.abort();
    if (url.origin !== new URL(base).origin && !['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  await page.goto(`${base}/services`, { waitUntil: 'domcontentloaded' });
  await page.locator('.system-card').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

try {
  const page = await safePage();
  assert.equal(await page.locator('main, body').first().evaluate(el => el.innerText.includes('\u2197')), false, 'No up-right arrow glyphs on /services');
  for (const section of sections) {
    const card = page.locator(`#${section} .holo-card`).first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800); // Let the .7s reveal finish: a card sliding in can leave a still pointer behind.
    const before = await card.evaluate(el => getComputedStyle(el).transform);
    await card.hover({ position: { x: 40, y: 40 } });
    await page.waitForFunction(selector => document.querySelector(selector)?.dataset.tracking === 'true', `#${section} .holo-card`);
    await page.waitForTimeout(400);
    assert.notEqual(await card.evaluate(el => getComputedStyle(el).transform), before, `${section} tilts on pointer movement`);
    const foil = () => page.waitForFunction(selector => Number(getComputedStyle(document.querySelector(selector), '::before').opacity) > .15, `#${section} .holo-card`, { timeout: 2000 });
    // A still test pointer can lose :hover if the page shifts; a real mouse moves and regains it.
    await foil().catch(async () => { await card.hover({ position: { x: 44, y: 44 } }); await foil(); });
    await page.mouse.move(1, 1);
    assert.equal(await card.getAttribute('data-tracking'), null, `${section} resets after leaving`);
  }

  const systemLink = page.locator('.system-card').first();
  await systemLink.focus();
  assert.equal(await systemLink.evaluate(el => el.matches(':focus-visible')), true);
  assert.equal(await systemLink.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/services/websites-local-seo');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.recovery-path li').first().waitFor();
  assert.equal(await page.locator('.recovery-path li').count(), 4, 'Recovery section shows a four-step path');
  assert.equal(await page.locator('.holo-card-link, .recovery-step-arrow').count(), 0, 'Cards carry no corner arrows');
  assert.equal(await page.locator('main, body').first().evaluate(el => el.innerText.includes('\u2197')), false, 'No up-right arrow glyphs on the homepage');
  for (const value of await page.locator('.revenue-values details').all()) {
    await value.locator('summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await value.evaluate(el => el.open), true);
    assert.equal(await value.locator('.value-detail').isVisible(), true);
    await page.keyboard.press('Space');
    assert.equal(await value.evaluate(el => el.open), false);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}/services`, { waitUntil: 'domcontentloaded' });
  await systemLink.hover();
  assert.equal(await systemLink.getAttribute('data-tracking'), null);
  assert.equal(await systemLink.evaluate(el => getComputedStyle(el).transform), 'none');

  for (const width of [320, 390, 560, 768, 900, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    const outside = await page.locator('.holo-card').evaluateAll(cards => cards.filter(card => {
      const box = card.getBoundingClientRect();
      return box.left < 10 || box.right > innerWidth - 10 || card.scrollWidth > card.clientWidth + 2;
    }).map(card => card.className));
    assert.deepEqual(outside, [], `Cards and their content fit at ${width}px`);
  }
  // Presentation-only screenshot cleanup, after checks. Does not alter cards.
  await page.addStyleTag({ content: '.site-header,.chat-launcher{visibility:hidden!important}.reveal{opacity:1!important;transform:none!important}' });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const section of sections) {
      await page.locator(`#${section}`).screenshot({ path: `/tmp/bitesites-holo-${width}-${section}.png` });
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('.system-card').first().hover({ position: { x: 70, y: 65 } });
  await page.waitForTimeout(450);
  await page.locator('#system').screenshot({ path: '/tmp/bitesites-holo-desktop-hover.png', animations: 'allow' });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.recovery-path li').first().waitFor();
  // Sticky audit CTA: hidden on the first screen, shown further down, steps aside for the form.
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.sticky-audit-cta.is-shown').count(), 0, 'Sticky CTA waits until the visitor scrolls');
  await page.locator('#pricing').scrollIntoViewIfNeeded();
  await page.locator('.sticky-audit-cta.is-shown').waitFor();
  await page.locator('#start').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !document.querySelector('.sticky-audit-cta').classList.contains('is-shown'));
  for (const path of ['/faq', '/pricing', '/services', '/services/lead-recovery']) {
    await page.goto(`${base}${path}`);
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight / 2));
    const cta = page.locator('.sticky-audit-cta.is-shown');
    await cta.waitFor();
    assert.equal(await cta.getAttribute('href'), '/#start', `Sticky CTA on ${path} goes to the audit form`);
  }
  await page.close();

  const touch = await safePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await touch.goto(base, { waitUntil: 'domcontentloaded' });
  await touch.locator('.revenue-values summary').first().tap();
  assert.equal(await touch.locator('.revenue-values details').first().evaluate(el => el.open), true);
  assert.equal(await touch.locator('.holo-card[data-tracking]').count(), 0, 'Touch does not trigger sticky tilt');
  await touch.goto(`${base}/services`, { waitUntil: 'domcontentloaded' });
  await touch.locator('.industry-card').first().tap();
  await touch.waitForURL('**/#start');
  assert.equal(await touch.getByRole('checkbox', { name: /Custom AI project/ }).count(), 1);
  await touch.close();
  assert.deepEqual(errors, []);
  console.log('PASS: All three /services card sections have pointer effects; recovery path renders, no corner arrows, About works by keyboard/touch; links work; reduced motion, 7 responsive widths and console checks passed. Screenshots saved in /tmp/bitesites-holo-*.png.');
} finally {
  await browser.close();
}
