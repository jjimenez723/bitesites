// Emit public marketing content as HTML for readers and crawlers without JS.
// Reuse the React view and the metadata used by client-side navigation.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { revenueServices } from '../src/content/revenue.js';
import { homeMeta, metadataForPath, serializeSchema } from '../src/content/seo.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');
const escape = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function withMetadata(html, meta) {
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escape(meta.title)}</title>`);
  const tags = [
    ['name', 'description', meta.description],
    ['name', 'robots', meta.noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large'],
    ['property', 'og:title', meta.socialTitle || meta.title],
    ['property', 'og:description', meta.socialDescription || meta.description],
    ['property', 'og:url', meta.canonical],
    ['name', 'twitter:title', meta.socialTitle || meta.title],
    ['name', 'twitter:description', meta.socialDescription || meta.description]
  ];
  for (const [attribute, key, value] of tags) {
    html = html.replace(new RegExp(`<meta ${attribute}="${key}" content="[^"]*"\\s*/?>`), () => `<meta ${attribute}="${key}" content="${escape(value)}" />`);
  }
  html = html.replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, () => `<link rel="canonical" href="${meta.canonical}" />`);
  html = html.replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, '');
  if (meta.schema) html = html.replace('</head>', () => `<script id="site-structured-data" type="application/ld+json">${serializeSchema(meta.schema)}</script>\n</head>`);
  return html;
}

const template = await readFile(path.join(dist, 'index.html'), 'utf8');
const home = withMetadata(template, homeMeta);

// Use Vite's JSX loader without an HTTP server or browser mount. App Check is
// browser-only; disabling it here affects this build-time renderer, not the bundle.
// Router conditions select its ESM exports consistently across supported Node versions.
const vite = await createServer({ root, define: { 'import.meta.env.VITE_APPCHECK_ENABLED': '"false"' }, ssr: { noExternal: ['react-router-dom', 'react-router'], resolve: { conditions: ['module-sync', 'node'] } }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { HomepageSnapshot } = await vite.ssrLoadModule('/src/main.jsx');
  const homeBody = renderToStaticMarkup(React.createElement(HomepageSnapshot));
  // Asset imports from Vite's SSR loader refer to source paths. Map them to
  // the exact hashed files in the client build, including imported media.
  const manifest = JSON.parse(await readFile(path.join(dist, '.vite/manifest.json'), 'utf8'));
  const assets = Object.entries(manifest).filter(([source]) => source.startsWith('src/')).map(([source, value]) => ['/' + source, '/' + value.file]);
  const builtBody = assets.reduce((html, [source, target]) => html.replaceAll(source, target), homeBody);
  await writeFile(path.join(dist, 'index.html'), home.replace('<div id="root"></div>', () => `<div id="root">${builtBody}</div>`));
  const { default: ServicePage } = await vite.ssrLoadModule('/src/pages/ServicePage.jsx');
  await mkdir(path.join(dist, 'services'), { recursive: true });
  for (const service of revenueServices) {
    const html = withMetadata(template, metadataForPath(`/services/${service.slug}`)).replace('<div id="root"></div>', () => `<div id="root">${renderToStaticMarkup(React.createElement(ServicePage, { service }))}</div>`);
    await writeFile(path.join(dist, 'services', `${service.slug}.html`), html);
  }
  const { default: Pricing } = await vite.ssrLoadModule('/src/pages/Pricing.jsx');
  await writeFile(path.join(dist, 'pricing.html'), withMetadata(template, metadataForPath('/pricing')).replace('<div id="root"></div>', () => `<div id="root">${renderToStaticMarkup(React.createElement(Pricing))}</div>`));
  const { default: Faq } = await vite.ssrLoadModule('/src/pages/Faq.jsx');
  const faq = withMetadata(template, metadataForPath('/faq')).replace('<div id="root"></div>', () => `<div id="root">${renderToStaticMarkup(React.createElement(Faq))}</div>`);
  if (!faq.includes('Good questions.') || !faq.includes('application/ld+json')) throw new Error('FAQ pre-render did not produce content and structured data.');
  await writeFile(path.join(dist, 'faq.html'), faq);
  // These routes also need accurate initial metadata on direct requests.
  for (const route of ['/terms', '/privacy', '/book', '/feedback', '/thank-you', '/questionnaire', '/email-preferences']) {
    await writeFile(path.join(dist, `${route.slice(1)}.html`), withMetadata(template, metadataForPath(route)));
  }
  console.log('Pre-rendered homepage, 5 service pages, pricing, FAQ, and utility route metadata.');
} finally {
  await vite.close();
}
