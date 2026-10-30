// Stop Hosting releases that omit the public redesign or crawlable SEO pages.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { revenueServices } from '../src/content/revenue.js';
import { faqItems } from '../src/content/faq.js';
import { metadataForPath } from '../src/content/seo.js';

const dist = resolve(process.argv[2] || fileURLToPath(new URL('../dist', import.meta.url)));
const read = file => readFile(resolve(dist, file), 'utf8');
const routes = ['/', '/pricing', '/faq', ...revenueServices.map(service => `/services/${service.slug}`)];
for (const route of routes) {
  const html = await read(route === '/' ? 'index.html' : `${route.slice(1)}.html`);
  const meta = metadataForPath(route);
  const title = meta.title.replaceAll('&', '&amp;');
  assert.ok(html.includes(`<title>${title}</title>`), `${route}: current search title is missing`);
  assert.ok(html.includes(`<link rel="canonical" href="${meta.canonical}"`), `${route}: canonical URL is missing`);
  assert.match(html, /<h1[\s>]/, `${route}: content must be available without JavaScript`);
  assert.doesNotMatch(html, /(?:src|poster)="\/src\//, `${route}: unpublished source assets found`);
  const schema = JSON.parse(html.match(/<script id="site-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] || 'null');
  assert.ok(schema?.['@graph']?.length, `${route}: structured data is missing`);
  if (route === '/') {
    assert.match(html, /Stop losing leads/, 'The restored homepage is missing');
    assert.equal(schema['@graph'].filter(item => item['@type'] === 'Service').length, 5);
  }
  if (route === '/faq') {
    assert.equal(schema['@graph'].find(item => item['@type'] === 'FAQPage')?.mainEntity.length, faqItems.length);
  }
}
assert.match(await read('robots.txt'), /Sitemap: https:\/\/bitesites.org\/sitemap.xml/);
const sitemap = await read('sitemap.xml');
for (const route of routes) assert.ok(sitemap.includes(`<loc>https://bitesites.org${route}</loc>`), `${route}: missing from sitemap`);
assert.ok((await readFile(resolve(dist, 'og-cover-v2.jpg'))).length > 0, 'The current share image is missing');
console.log('PASS: Hosting includes the redesigned homepage, service/pricing/FAQ pages, rendered content, structured data, sitemap, robots and share image.');
