// Verify initial HTML and built-client mounting. All interactive checks block
// API requests and external services; no live lead submission is performed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { revenueServices } from '../src/content/revenue.js';
import { faqItems } from '../src/content/faq.js';
import { metadataForPath } from '../src/content/seo.js';

const base = process.env.MARKETING_BUILT_URL || 'http://127.0.0.1:5000';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  for (const route of ['/', '/pricing', ...revenueServices.map(service => `/services/${service.slug}`), '/faq', '/book', '/terms', '/privacy', '/thank-you', '/questionnaire', '/feedback', '/email-preferences']) {
    const response = await page.goto(base + route);
    assert.equal(response.status(), 200, `${route} serves directly`);
    const meta = metadataForPath(route);
    assert.equal(await page.title(), meta.title);
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), meta.canonical);
    assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), meta.canonical);
    if (meta.noindex) assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex,follow');
  }
  await page.goto(base + '/');
  assert.match(await page.locator('h1').textContent(), /Stop losing leads/);
  assert.equal(await page.locator('.revenue-steps li').count(), 6);
  assert.equal(await page.locator('.revenue-services .service-card').count(), 5);
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(await page.locator('[src^="/src/"]').count(), 0, 'SSR uses built assets');
  const homeGraph = JSON.parse(await page.locator('#site-structured-data').textContent())['@graph'];
  assert.equal(homeGraph.filter(node => node['@type'] === 'Service').length, 5);
  assert.match(await page.locator('meta[property="og:image"]').getAttribute('content'), /og-cover-v2.jpg/);
  for (const service of revenueServices) {
    await page.goto(`${base}/services/${service.slug}`);
    assert.equal(await page.locator('h1').textContent(), service.heading);
    assert.equal(await page.getByRole('link', { name: 'Find my revenue leaks' }).getAttribute('href'), '/#start');
    const graph = JSON.parse(await page.locator('#site-structured-data').textContent())['@graph'];
    assert.ok(graph.some(node => node['@type'] === 'Service' && node.description === service.description));
    assert.ok(graph.some(node => node['@type'] === 'BreadcrumbList'));
  }
  await page.goto(base + '/faq');
  assert.equal(await page.locator('.faq-item').count(), faqItems.length);
  const schema = JSON.parse(await page.locator('#site-structured-data').textContent())['@graph'].find(node => node['@type'] === 'FAQPage');
  assert.deepEqual(schema.mainEntity.map(item => item.acceptedAnswer.text), await page.locator('.faq-answer > p').allTextContents());
  await page.locator('.faq-item summary').first().click();
  assert.equal(await page.locator('.faq-answer').first().isVisible(), true);
  const robots = await page.request.get(base + '/robots.txt');
  assert.equal(robots.status(), 200);
  assert.match(await robots.text(), /Sitemap: https:\/\/bitesites.org\/sitemap.xml/);
  const sitemap = await page.request.get(base + '/sitemap.xml');
  assert.equal(sitemap.status(), 200);
  assert.match(await sitemap.text(), /<loc>https:\/\/bitesites.org\/faq<\/loc>/);
  assert.doesNotMatch(await sitemap.text(), /thank-you|questionnaire|admin|email-preferences/);
  for (const service of revenueServices) assert.ok((await sitemap.text()).includes(`/services/${service.slug}</loc>`));
  const interactive = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const errors = [];
  interactive.on('pageerror', error => errors.push(error.message));
  await interactive.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin || url.pathname.startsWith('/api/') || route.request().method() !== 'GET' || route.request().resourceType() === 'media') return route.abort();
    return route.continue();
  });
  await interactive.goto(base + '/#start');
  await interactive.getByRole('checkbox', { name: /Custom AI project/ }).check();
  await interactive.locator('.project-next').click();
  await interactive.getByRole('radio', { name: /Just me/ }).waitFor();
  await interactive.goto(base + '/pricing');
  await interactive.getByRole('button', { name: /Create free account/ }).click();
  await interactive.getByRole('dialog').waitFor();
  await interactive.getByRole('button', { name: 'Close account dialog' }).click();
  assert.deepEqual(errors, [], 'Built client mounts and runs without uncaught errors');
  console.log(`PASS: Home, pricing, 5 service pages, FAQ and utility URLs have correct metadata; marketing content and ${faqItems.length} FAQ answers work without JavaScript; structured data, asset paths, robots and sitemap verified; built form and pricing dialog work.`);
} finally {
  await browser.close();
}
