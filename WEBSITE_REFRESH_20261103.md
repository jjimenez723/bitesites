# Website refresh — November 3, 2026

Branch `redesign/homepage-nov-2026`, cut from `85860c5` (the live Oct 29 release).
Work happens in `bitesites-marketing-restoration`, not the older original checkout.

## Owner requests

1. Keep the hero and the intake form; add more color to their backgrounds.
2. Rework "One system. Six places revenue can be won or lost."
3. Remove the small up-right arrows from cards, on every page.
4. Cut copy on "What happens when nobody answers?" and "Built for businesses
   where one lead can be worth thousands." Fewer words, more visual.
5. A "Get a free audit" call to action that follows the visitor on every page.
6. Take visual cues from Nike's site: bold, short headlines, big color tiles,
   plain pill buttons. Cues only; no Nike branding, imagery or copy.

## Implemented locally (uncommitted, not deployed)

- `src/refresh.css`, loaded last: tokens, heavier/tighter section headlines,
  colored hero overlay, slow brand-color field behind the intake (static under
  reduced motion).
- Six places: full-color tiles with one big number, icon, title and one line.
  The third descriptive line moved into the link's accessible name only.
- Nobody answers: one sentence plus a four-step path. The eight-step clickable
  explainer and its detail panel were removed.
- Who we help: icon and name only; descriptions removed.
- Up-right arrows removed from cards and buttons on the homepage, service
  pages, pricing, FAQ, team card and intake. Portfolio bullets are now dots.
  Admin screens were not touched.
- `StickyAuditCta`: "Get a free audit" pill on home, service pages, pricing and
  FAQ. Appears after the first screen, hides while the form is on screen, and
  sits above the chat launcher on phones (≤480px).

## Verified

- `npm run build`, prerender and the Hosting content check passed.
- `test-marketing-interactions.mjs` (updated for the new sections, plus new
  checks: no arrow glyphs, sticky CTA show/hide and its link on /faq, /pricing,
  a service page), `test-marketing-browser.mjs` and `test-molten-background.mjs`
  passed against the local Vite server on port 5174.
- Viewed at 1440, 375 and 320px; no horizontal overflow; CTA and chat launcher
  do not overlap at 320px.

- `test-marketing-built.mjs` passed against the Hosting emulator (port 5055;
  5000 is taken by macOS AirPlay): all routes, metadata, no-JavaScript content,
  18 FAQ answers, structured data, robots and sitemap.

## SEO and AI-search check against the live site

Built pages were compared with `https://bitesites-org.web.app` on November 3.
Titles, descriptions, canonical URLs, robots meta, Open Graph and Twitter tags,
heading counts and JSON-LD (Organization, WebSite, Service, BreadcrumbList,
FAQPage) are identical on all nine indexable routes. `robots.txt` and
`sitemap.xml` are byte-identical; all crawlers, AI crawlers included, remain
allowed. Content is still pre-rendered, so it is readable without JavaScript.

Homepage visible text dropped from about 2,280 to 2,000 words. "Local SEO" and
"websites, local SEO" had disappeared with the cut tile copy; short service tags
on the six tiles restored "Local SEO", "Missed-call recovery", "CRM workflows"
and "Revenue attribution". "Team alert" (2 mentions) is no longer on the
homepage; the lead-recovery service page still covers team notifications.
Other pages changed by one word or less (removed arrow glyphs).
This checks what crawlers receive, not rankings or AI-answer inclusion.

## Round 2: socials, AI consulting, AI-search readiness

- **Socials.** The site had no social links. Footer icons for Instagram,
  Facebook, LinkedIn and TikTok now appear on home, service, pricing and FAQ
  pages. Profiles live in `src/content/social.js`; an empty `url` sends the
  link to `/coming-soon?from=<network>` ("Our Instagram is almost ready").
  That page is `noindex`, not in the sitemap, and the links are `nofollow`.
  Only profiles with a real URL are added to Organization `sameAs`; none are yet.
- **AI consulting** (owner confirmed it is a service BiteSites sells): new
  `/services/ai-consulting` page, sixth homepage service card, FAQ answer
  (19 total, also in FAQPage schema), sitemap entry, Service schema, ticker.
  Organization schema now carries `knowsAbout`, `areaServed: US` and a NJ
  postal region. Copy makes no result or ranking claims.
- **`llms.txt`** is generated at build time from the same service and FAQ
  content, so it cannot drift. It is a convenience for AI tools, not a
  documented ranking factor.
- **Crawler access on the live domain** (checked Nov 3, read-only):
  OAI-SearchBot, GPTBot, ChatGPT-User, Bingbot, PerplexityBot, ClaudeBot and
  Googlebot all receive HTTP 200 with full pre-rendered content. Cloudflare is
  not blocking AI crawlers.
- Sticky CTA: footers get bottom padding so the pill never covers links.
- Tests: hard-coded "5 services" counts now follow `revenueServices.length`.
  `test-marketing-browser.mjs` defaults to port 5173, which on this machine is
  the older original checkout's server; run it with
  `MARKETING_TEST_URL=http://127.0.0.1:5174`. Its earlier round-1 pass was
  against the wrong server; it has since passed against this branch.

All four suites and the build check pass on the final code (built suite via
the Hosting emulator on port 5055).

Not done, outside this change:
- Bit (chat agent) knowledge and its approved page links live in
  `functions/bit-persona.js`; Bit does not yet know about AI consulting or link
  to the new page. That needs a separate Functions deploy.
- Search Console / Bing Webmaster submission of the new URL. ChatGPT search
  relies heavily on Bing's index. No ranking, in ChatGPT or Google, can be
  guaranteed or verified from here.

## Round 3: order, dark sections, finishing pass

- **Portfolio** moved directly under the intake form (third section).
- **Page base color.** `html` and `body` never set a background, so
  transparent sections (reactivation, final CTA, footer) showed the browser's
  default canvas: near-black in the app's preview pane and in forced-dark
  browsers, with dark text on it. `refresh.css` now sets a white base and
  `color-scheme: light`; the black footer logo confirms white is the design.
- **Reactivation** ("There may be revenue sitting in your existing database"):
  now a violet-to-rose panel, one sentence, three source tiles, a white button.
  The consent note stays, shortened.
- **Services grid**: six cards as two even rows of three (desktop) and three
  rows of two (tablet); the old rules sized cards for five.
- **About**: dropped the two story paragraphs that repeated the intro and
  mission line.
- **Headlines**: Byte & Bit, Team and the final CTA now use the same bold
  headline style as every other section.

Homepage visible text is about 1,990 words (live: 2,285). Every tracked search
term is still present; "AI consulting" went from 0 to 4 mentions. All four
suites and the build check pass on this code.

## CI on the pull request

`Outbound AI CI` was already failing on `main` (same four rules tests, since at
least Oct 29), so `npm run test:all:raw` stopped at `test:rules` and every suite
after it had not been running in CI. Cause: `f6bd355` added the rep training
gate to `firestore.rules`, but the `stale_claim_rep` test fixture was never
given a training pass. The rules were right to deny it. The fix is in the
fixture only; `firestore.rules` is unchanged.

The Firestore emulator needs Java, which this machine does not have, so the
fixture fix and the emulator suites are verified by CI only. The 18 later suites
that need no emulator passed locally.

## Status

Committed on branch `redesign/homepage-nov-2026` after owner review of the
local preview. Not merged to `main` and not deployed. Production publication
needs the owner's explicit approval.
