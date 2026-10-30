# BiteSites revenue systems repositioning — October 8, 2026



## Brief and audit

The owner's attached rewrite brief guides the positioning. Claims about existing
routes, prices, results and capabilities are checked against the implementation.

- The home title and sole Service schema identify voice AI as the primary offer.
- The home response has metadata but no rendered body before JavaScript runs.
- `/faq` exists, works without JavaScript, and has 13 visible answers matching its schema.
- Search returned a cached legacy `/pricing` page. A fresh request serves the SPA
  homepage; current pricing is protected and loaded from the existing account API.
  Legacy prices and the brief's placeholder claim are not a current price source.
- Real portfolio projects exist; verified conversion/revenue metrics are not supplied.
- General brand search also surfaces a separate dental business at bitesites.com.
  Do not import that business's address, claims or identity into this site.

## Search guidance

Google's current guidance emphasizes helpful content, crawlability, accurate
business information and standard SEO. No special AI schema or llms.txt is
required: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide

## Scope


Broaden public positioning while retaining visual identity, demo tools, portfolio,
four-option intake and pricing/auth flows. No changes to outbound campaign behavior.
No invented rankings, clients, revenue figures or public price commitments.

## Implemented

- Homepage leads with revenue systems, a free introductory revenue leak audit,
  and six steps: find, capture, respond, follow up, book/close, track.
- Five service areas have individual crawlable pages under `/services/`:
  lead recovery, websites/local SEO, AI receptionists, follow-up automation,
  and revenue tracking. Existing agent demo and legacy hash anchors still work.
- Lead recovery, eligible contact reactivation, target industries, About copy,
  real portfolio proof, pricing context, and final audit CTA follow the brief.
  Custom AI and social services remain available.
- Four-option form retains its five-step workflow, payload, attribution,
  validation, optional fields, editable summary, and submission transport.
- `/pricing` is now a real page using the same protected pricing component.
  Actual current packages differ from the brief's legacy tiers, so package names
  and prices remain sourced from the existing API. The free introductory review
  is distinguished from a separately scoped, detailed paid automation audit.
- FAQ expanded from 13 to 17 answers. New answers explain the system, free audit,
  lead recovery, and limits of revenue attribution. Visible answers and schema
  continue to share the same content source.
- Broad home title/description, five Service schema nodes, per-service metadata,
  breadcrumbs, canonical URLs, updated sitemap, and versioned social artwork.
- Homepage, service pages, pricing introduction, and FAQ are rendered to initial
  HTML from their actual React components. The build manifest maps imported media
  to deployed asset URLs; small assets are emitted rather than omitted from the
  manifest. App Check is disabled only in the server-side renderer, not the client.
- Existing analytics handles CTA clicks, forms, sections, pricing, demos, and
  bookings. New service/pricing pages initialize the existing analytics lifecycle.
  No new event types, tracking scripts, or private-data capture were introduced.

## Verification and publication

- `npm run build`: passed in the isolated release checkout and working repo.
  Existing chunk-size and Firebase mixed-import warnings remain.
- `scripts/test-marketing-browser.mjs`: passed. Covers form validation, field
  retention, summary edits, failed-submit retry, duplicate protection, custom-only
  and mixed-service normalization, modal preselection, FAQ keyboard interaction,
  metadata transitions, service/pricing pages and layouts at 320, 390, 768, 1024,
  and 1440 pixels. Pricing account dialog opens/closes without creating an account.
- `scripts/test-marketing-built.mjs`: passed against Firebase Hosting emulator
  and **https://bitesites.org** after deployment. All 15 checked routes serve
  correct initial metadata. Marketing content and all 17 FAQ answers work without
  JavaScript. Schema matches content; imported asset paths, robots and sitemap
  resolve. With JavaScript enabled, the custom-project form advances and the
  pricing dialog opens/closes without uncaught browser errors.
- Desktop/mobile screenshots reviewed with the actual Tomorrow font. Fixed a
  mobile CTA overflow and a stylesheet ordering conflict affecting service cards.
- Browser checks block external services and API writes; lead transport is mocked
  for submission tests. No test lead, account, email, call, or chat was sent live.
- Published successfully with `firebase deploy --only hosting --project
  bitesites-org --non-interactive` from `/tmp/bitesites-marketing-release-20261008`
  on October 8, 2026 (America/New_York). No Functions, rules, indexes, outbound
  campaigns, or unrelated admin/booking/mailbox edits were deployed.
- Local preview and Hosting emulator were stopped. No commit or push was made.

## Owner inputs and limits


- Owner confirmed: based in New Jersey, serving nationwide, with most current
  clients in New Jersey and New York. Published this clarification in About, FAQ,
  search/social descriptions and Organization descriptions. Service area remains
  nationwide. FAQ now has 18 questions. Both builds and checks of generated HTML
  passed; Hosting-only deployment succeeded and live homepage/FAQ checks passed.
- Verified leads, booked jobs, revenue figures, and approved testimonials would
  support stronger case studies. None were invented or displayed as placeholders.
- No Search Console recrawl request or Business Profile edit was made. Deployment
  checks verify live content and technical behavior, not refreshed Google results
  or new search rankings. Geographic pages should use confirmed service areas.

## Typography and spacing correction

Owner requested the original visual rhythm with the revised wording and SEO.
The intake introduction had retained `flex-shrink: 0` on its now-long supporting
paragraph: on a 1440px screen it took 874px and squeezed the title to 198px/six
lines. At 1024px it also extended outside the content area. Body overflow clipping
meant the previous page-scrollWidth check did not identify this internal failure.

- Constrained both intro columns, restored compact supporting copy and natural
  heading wrapping. The title now uses two desktop lines and at most three at
  320px, verified with the actual Tomorrow font.
- Removed negative letter spacing introduced in the revenue rewrite. Restored
  original service-card heading size; balanced longer section headings and
  increased line spacing where the new text wraps.
- Separated follow-up paragraphs/links, gave the About story space below the
  mission panel, restored small eyebrow labels, and separated CTA arrows.
- Adjusted narrow layouts to give recovery/follow-up copy and system cards room
  to read. Kept service architecture, metadata, schema, geography, FAQ, agents,
  account pricing and four-option intake behavior.
- Existing marketing browser suite passed, extended with actual intro bounds,
  separation and line-count checks at 320, 390, 768, 900, 1024, 1280 and 1440px.
  Screenshot review covered hero, form, system, services, recovery, follow-up,
  About, final CTA and a service page on desktop and mobile.
- Working and isolated release builds passed. Published Hosting-only from the
  isolated release checkout; live checks with Tomorrow loaded passed at all
  seven widths, with no uncaught browser errors. No live submissions or API
  writes were performed. Development server stopped.

## Holographic cards and interactive sections — October 9, 2026

The owner requested more color, depth and hover feedback in the system, services,
lead recovery, industries and About sections, and supplied an image-based
HoloCard usage example. Implemented a local, content-capable `HoloCard` adaptation
with no new dependency or unrelated image asset.

- All 29 cards have blue, violet, teal or rose surfaces, branded line icons,
  borders and shadows. Fine-pointer hover adds cursor-following foil/glare,
  edge light, a small lift and bounded perspective tilt. Effects sit behind text
  and never intercept input. Pointer updates use animation frames; there is no
  continuous idle animation.
- Six system cards link to the relevant service pages. Five service cards keep
  their existing detail links, project dialogs and form preselection.
- Eight recovery steps are real toggle buttons with a persistent explanation
  panel, selected state and polite screen-reader updates. All steps work by
  click, keyboard and touch.
- Six industry cards include relevant descriptions and links to the intake.
- About has a blue/violet mission panel and four equally sized colored value
  cards. Native disclosures expand the approach behind each value and remain
  keyboard accessible.
- Reduced-motion preferences disable tilt and animation; touch does not enable
  sticky pointer tracking. Keyboard controls receive visible focus treatment.
- The SEO positioning, metadata, 18-question FAQ, geography, repaired form
  heading and four-service intake remain intact.

Verification:

- Working and isolated release builds passed, including initial-HTML rendering.
  Existing build chunk-size and mixed-import warnings remain.
- Existing marketing browser suite passed in full. An initial phone-validation
  wait timed out; the full rerun passed without any form-code change.
- `scripts/test-marketing-interactions.mjs` passed locally, against built files
  through the Hosting emulator, and against https://bitesites.org. Checks cover
  all five sections, hover/reset, keyboard navigation, all eight recovery steps,
  all four disclosures, touch, reduced motion, seven widths from 320 to 1440px,
  card/content bounds and uncaught browser errors.
- Existing built-site suite passed against the emulator and live site: initial
  metadata on 15 routes, service content, FAQ/schema consistency, asset paths,
  robots/sitemap, custom-project form advancement and pricing dialog.
- Desktop/mobile screenshots reviewed for all five sections, including actual
  hover and loaded fonts. Final adjustments align the About cards and retain
  strong contrast in the dark recovery cards.
- Published successfully with Hosting-only deployment from the isolated
  `/tmp/bitesites-marketing-release-20261008` checkout. No functions, rules,
  indexes, campaigns or unrelated shared-workspace edits were deployed.
- API traffic and external services were blocked during interactive verification;
  no live lead, account, message, call or chat was created. Emulator and owned
  preview server stopped. No commit or push was made.

## Electric logo removed — October 9, 2026

The owner asked to remove the electric-logo effect after viewing it. Restored
both homepage logos to the prior SVG/lettering and original scroll morph.
Removed the electric components, styles, dedicated test, vendor license asset,
and OGL dependency from both the working and isolated release checkouts.
The approved holographic cards and other marketing work remain in place.

- Isolated release build passed, including pre-rendered marketing HTML.
- Verified both original logo elements, all 29 holographic cards and no electric
  logo markup in the generated homepage. Original marketing CSS bundle restored.
- Published Hosting-only from `/tmp/bitesites-marketing-release-20261008`.
  Unrelated working-tree changes were not included.
- Working-repo build also passed. Live checks confirmed original header/footer
  rendering, scroll morph, back-to-top navigation, mobile layout, all 29 cards,
  four intake options and no uncaught browser errors. API writes and external
  services were blocked. No commit or push was made.

## Molten Metal backgrounds — October 9, 2026

Placed React Bits' MoltenMetal in the homepage hero and final revenue-audit CTA,
replacing the hero's previous nebula background and the CTA's blurred gradient.
The supplied purple/pink/white palette, speed, scale, detail, glow, grain and
pointer settings are retained. Dark overlays keep content readable; the original
logo, approved cards, intake and marketing wording are retained.

- Original shader from https://github.com/DavidHDev/react-bits/blob/main/src/content/Backgrounds/MoltenMetal/MoltenMetal.jsx
  with source attribution and the full license in `/licenses/react-bits.txt`.
  Uses the pinned `ogl@1.0.11` dependency.
- Renderer is lazy-loaded only for visible placements, capped at 30 FPS and
  bounded to about one million desktop pixels / 350,000 mobile pixels. Offscreen
  instances unmount; hidden tabs pause rendering. Missing WebGL and reduced-motion
  settings retain a static purple background. Pointer events belong to the section
  so the decorative canvas never obstructs links, text or touch scrolling.
- Reviewed desktop and mobile screenshots of both placements with actual fonts.
- Working and isolated release builds passed, including prerendered HTML.
- `scripts/test-molten-background.mjs` passed locally and against the Hosting
  emulator: actual GPU rendering, mouse uniform updates, frame/pixel budgets,
  offscreen and tab behavior, desktop/mobile CTA navigation, custom intake flow,
  reduced-motion and WebGL fallback, six responsive widths and no uncaught errors.
- Existing built-site suite passed against the emulator: all 15 route metadata
  checks, service content, 18 FAQ answers/schema, assets, form and pricing dialog.
- Published Hosting-only from the isolated release checkout. Both the molten
  background suite and existing built-site suite then passed against
  https://bitesites.org. Working implementation files match the deployed source.
- Verification blocked API writes and external services; no live lead, account,
  message, call or chat was created. Preview and emulator stopped. No commit or
  push was made, and unrelated application changes were excluded from release.
