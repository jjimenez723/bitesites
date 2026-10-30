// UI contract checks with a mocked lead transport. Never creates live leads,
// sends email, calls agents, or writes production analytics.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { homeMeta } from '../src/content/seo.js';
import { revenueServices } from '../src/content/revenue.js';
import { faqItems } from '../src/content/faq.js';

const base = process.env.MARKETING_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== new URL(base).origin || url.pathname.startsWith('/api/') || route.request().resourceType() === 'media') return route.abort();
  if (/^\/src\/lib\/leads(?:\.js)?$/.test(url.pathname) && !url.searchParams.has('normalization_check')) return route.fulfill({ contentType: 'application/javascript', body: `
    window.testLeadRequests=[];
    export async function submitLead(payload,source){
      window.testLeadRequests.push({payload,source});
      if(window.failNextLead){window.failNextLead=false;throw new Error('Connection lost. Please try again.');}
      return new Promise(resolve=>window.finishLead=()=>resolve('test-lead'));
    }
  ` });
  return route.continue();
});

const next = () => page.locator('.project-next').click();
const choice = name => page.getByRole('radio', { name }).check();
const fits = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page fits the viewport');
// Body overflow clipping can hide a broken internal layout from scrollWidth.
// Check the actual heading and copy, including the intermediate desktop widths.
const intakeCopyFits = async () => {
  const layout = await page.locator('.project-intro').evaluate(intro => {
    const title = intro.querySelector('h2');
    const heading = title.getBoundingClientRect();
    const copy = intro.querySelector(':scope > p').getBoundingClientRect();
    return {
      width: innerWidth,
      lines: heading.height / parseFloat(getComputedStyle(title).lineHeight),
      inside: [heading, copy].every(rect => rect.left >= 12 && rect.right <= innerWidth - 12),
      separated: heading.right + 14 <= copy.left || heading.bottom + 14 <= copy.top
    };
  });
  assert.ok(layout.lines <= 3.1, `Form heading has comfortable wrapping at ${layout.width}px`);
  assert.ok(layout.inside, `Form introduction stays inside the viewport at ${layout.width}px`);
  assert.ok(layout.separated, `Heading and supporting copy have space at ${layout.width}px`);
};

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#start').waitFor();
  assert.equal(await page.locator('.project-service').count(), 4);
  await page.locator('#start').screenshot({ path: '/tmp/bitesites-intake-desktop.png' });
  await fits();
  assert.equal(await page.getByRole('button', { name: 'Step 5: Let’s connect' }).isEnabled(), false);
  await next();
  await page.getByRole('alert').filter({ hasText: 'Choose at least one service' }).waitFor();
  await page.getByRole('checkbox', { name: /Web development/ }).check();
  await page.getByRole('checkbox', { name: /AI & automation/ }).check();
  await next();
  await next();
  await page.getByRole('alert').filter({ hasText: 'business size' }).waitFor();
  await choice(/Small team/);
  await page.getByLabel('Business / company').fill('Test Studio');
  await page.getByLabel('Your role').fill('Owner');
  await next();
  await next();
  await page.getByRole('alert').filter({ hasText: 'Choose a timeline' }).waitFor();
  await choice(/2–4 weeks/);
  await next();
  await page.getByLabel('Your project', { exact: false }).fill('A new website with booking and an AI receptionist.');
  await next();
  await page.getByRole('button', { name: 'Edit services' }).click();
  assert.equal(await page.getByRole('checkbox', { name: /Web development/ }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: /AI & automation/ }).isChecked(), true);
  await next(); await next(); await next(); await next();
  await next();
  await page.getByRole('alert').filter({ hasText: 'enter your name' }).waitFor();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Test Client');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('invalid');
  await next();
  await page.getByRole('alert').filter({ hasText: 'valid email' }).waitFor();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('client@example.test');
  await choice('Phone');
  await next();
  await page.getByRole('alert').filter({ hasText: 'phone number' }).waitFor();
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('2015550100');
  await page.locator('#start').screenshot({ path: '/tmp/bitesites-intake-review-desktop.png' });
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await fits();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#start').screenshot({ path: '/tmp/bitesites-intake-review-mobile.png' });
  await page.evaluate(() => { window.failNextLead = true; });
  await next();
  await page.getByRole('alert').filter({ hasText: 'Connection lost' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Email', exact: true }).inputValue(), 'client@example.test', 'Failure preserves the visitor’s answers');
  await page.locator('.project-wizard').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await page.waitForFunction(() => typeof window.finishLead === 'function');
  assert.equal(await page.locator('.project-next').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '← Back', exact: true }).isDisabled(), true);
  const requests = await page.evaluate(() => window.testLeadRequests);
  assert.equal(requests.length, 2, 'Only the failed request and one retry were submitted');
  assert.deepEqual(requests[1], { source: 'intake_form', payload: {
    businessSize: 'small', urgencyTag: '2_4_weeks', businessName: 'Test Studio', roleInCompany: 'Owner',
    projectDetails: 'A new website with booking and an AI receptionist.', name: 'Test Client',
    email: 'client@example.test', phone: '2015550100', preferredContactMethod: 'phone',
    services: ['web_development', 'ai_automation']
  } });
  await page.evaluate(() => window.finishLead());
  await page.waitForURL('**/thank-you?source=form');
  await page.waitForFunction(() => document.querySelector('meta[name="robots"]').content === 'noindex,follow');
  assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex,follow');

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#start').screenshot({ path: '/tmp/bitesites-intake-mobile.png' });
  // Existing service modal still seeds the new form.
  await page.getByRole('button', { name: 'Discuss Websites & local visibility', exact: true }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Start Your Project' }).click();
  assert.equal(await page.getByRole('checkbox', { name: /Web development/ }).isChecked(), true);
  await next(); await choice(/Just me/); await next(); await choice(/Just exploring/); await next();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Email Client');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('email@example.test');
  await next();
  await page.waitForFunction(() => typeof window.finishLead === 'function');
  assert.equal(await page.evaluate(() => window.testLeadRequests[0].payload.phone), '', 'Phone remains optional for email contact');
  await page.evaluate(() => window.finishLead());
  await page.waitForURL('**/thank-you?source=form');

  // Custom projects work on their own and keep a readable category all the way
  // through the real lead normalizer, without requiring a backend schema change.
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  for (const width of [1440, 1024, 768, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await fits(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('checkbox', { name: /Custom AI project/ }).check();
  await next(); await choice(/Just me/); await next(); await choice(/Just exploring/); await next();
  await page.getByRole('heading', { name: 'What’s your custom AI idea?' }).waitFor();
  await page.getByRole('textbox', { name: /Your custom AI idea/ }).fill('An AI tool to help our team search product documents.');
  await next();
  assert.equal(await page.locator('.project-summary dd').first().innerText(), 'Custom AI project');
  await page.getByRole('button', { name: 'Edit services' }).click();
  assert.equal(await page.getByRole('checkbox', { name: /Custom AI project/ }).isChecked(), true);
  await next(); await next(); await next(); await next();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Custom Client');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('custom@example.test');
  await next();
  await page.waitForFunction(() => typeof window.finishLead === 'function');
  const normalized = await page.evaluate(async () => {
    const { buildLead, validateLead } = await import('/src/lib/leads.js?normalization_check');
    const request = window.testLeadRequests[0];
    const single = buildLead(request.payload, request.source);
    const mixed = buildLead({ ...request.payload, services: ['web_development', 'ai_automation', 'social_media_management', 'Custom AI project'] }, request.source);
    return { single, mixed, validation: validateLead(single) };
  });
  assert.equal(normalized.validation, null);
  assert.deepEqual(normalized.single.services, ['other']);
  assert.equal(normalized.single.customAnswers.services, 'Custom AI project');
  assert.equal(normalized.single.projectDetails, 'An AI tool to help our team search product documents.');
  assert.deepEqual(normalized.mixed.services, ['web_development', 'ai_automation', 'social_media_management', 'other']);
  assert.equal(normalized.mixed.customAnswers.services, 'Custom AI project');
  await page.evaluate(() => window.finishLead());
  await page.waitForURL('**/thank-you?source=form');

  await page.goto(`${base}/faq`, { waitUntil: 'domcontentloaded' });
  await page.locator('.faq-page').waitFor();
  assert.equal(await page.locator('.faq-item').count(), faqItems.length);
  await page.locator('.faq-item summary').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.faq-item').first().evaluate(element => element.open), true, 'FAQ works with a keyboard');
  const schema = JSON.parse(await page.locator('#site-structured-data').textContent())['@graph'].find(node => node['@type'] === 'FAQPage');
  assert.deepEqual(schema.mainEntity.map(item => item.acceptedAnswer.text), await page.locator('.faq-answer > p').allTextContents(), 'Visible answers match the structured data');
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://bitesites.org/faq');
  for (const width of [1440, 768, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await fits(); }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: '/tmp/bitesites-faq-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bitesites-faq-mobile.png', fullPage: true });
  // Navigate in the SPA from the homepage footer, not just through full loads.
  await page.goto(base);
  await page.locator('.footer-links').getByRole('link', { name: 'FAQ', exact: true }).click();
  await page.waitForURL('**/faq');
  await page.waitForFunction(() => document.title.includes('Frequently Asked Questions'));
  await page.waitForFunction(() => window.scrollY < 2);
  assert.match(await page.title(), /Frequently Asked Questions/);
  await page.goBack();
  await page.locator('#start').waitFor();
  await page.waitForFunction(title => document.title === title, homeMeta.title);
  assert.equal(await page.title(), homeMeta.title);
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://bitesites.org/');
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(await page.locator('.revenue-steps li').count(), 6);
  assert.equal(await page.locator('.revenue-services .service-card').count(), 5);
  await page.locator('.hero a[href="#system"]').click();
  assert.match(page.url(), /#system$/);
  for (const width of [320, 390, 768, 900, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(base);
    await page.locator('.project-intro').waitFor();
    await fits();
    await intakeCopyFits();
    for (const service of revenueServices) {
      await page.goto(`${base}/services/${service.slug}`);
      await page.getByRole('heading', { name: service.heading, exact: true }).waitFor();
      assert.equal(await page.locator('h1').count(), 1);
      await fits();
    }
    await page.goto(base + '/pricing');
    await page.getByRole('heading', { name: 'Invest where your business is losing opportunities.' }).waitFor();
    await fits();
  }
  await page.getByRole('button', { name: /Create free account/ }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Close account dialog' }).click();
  await page.goto(base + '/#start');
  assert.equal(await page.locator('.project-service').count(), 4);
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS: five-step intake, validation, editing, optional fields, preserved payload, retry, duplicate protection, service preselection, FAQ, metadata, keyboard access, and 320–1440px layouts.');
} finally {
  await browser.close();
}
