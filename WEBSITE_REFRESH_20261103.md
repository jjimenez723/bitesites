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

## Round 1

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
  FAQ. Shows from the first screen and hides while the form is on screen, or
  while the menu, a portfolio project or Bit's chat is open. On phones it shares
  the bottom row with Chat with Bit at the same height, and the launcher's
  "Need help scoping a project?" prompt is hidden (changed 2026-11-13).

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
gate and closed prospects and eligibility audits to reps, but the test user
those "operator" checks use was still stored as an `outbound_rep`. The rules
were right to deny it. That user is now `stale_claim_manager`, a bitesites-scoped
`outbound_manager` with the same stale admin claim; `firestore.rules` is
unchanged. A first fix (a training pass on the rep) cleared one of the four
failures and was replaced.

With rules passing (171 of 171 in CI), CI reached `test:callbacks`, which had the
same kind of gap: its reps had no campaign assignment or training exemption, so
the server rightly refused them. `test:staff-workflows` had the same gap and no
campaign record at all. Both now seed what their sibling suites seed. The server
code is unchanged.

The Firestore emulator needs Java, which this machine does not have, so these
fixture changes and the emulator suites are verified by CI only. The 18 later
suites that need no emulator passed locally.

## Round 4: scroll performance

The owner reported slow, sluggish scrolling on the live site. Fixes:

- `src/lib/pause-offscreen.js` marks off-screen homepage sections; `refresh.css`
  pauses their looping animations. Several run on the main thread (SVG mascots,
  animated shadows), so they were competing with scrolling from anywhere on the page.
- The Byte waveform canvas stops drawing while off screen.
- Removed the `blur(10px)` on the moving color field behind the form. It came
  from Round 1, and the gradients are already soft.
- Removed backdrop blur from the scrolled header (94% white, so barely visible)
  and from the portfolio arrows and project numbers, which sit over playing video.
- Portfolio videos now start once the section is on screen. They started a quarter
  screen early, which became a problem when Round 3 moved the portfolio up.

Measured on the old and new builds side by side: Chrome, 1440×900 at 2x, CPU
throttled 4x, one full wheel scroll, median of three runs.

| | Before | After |
|---|---|---|
| Main-thread work | 11.5s | 7.6s |
| Layout passes | 1,113 | 293 |
| Paint passes | 3,614 | 1,326 |
| Animations running at page end | 32 | 1 |
| Frames per second | 57.9 | 58.6 |

Frame rate barely moved because this test machine was already near 60 in headless
Chrome, so the result is less work per scroll, not a measured frame-rate gain. The
first scroll of a fresh browser was much slower in both early runs (about 26 fps
once, and 30 fps in the hero) and was not compared before and after. It has not
been confirmed on the owner's screen. A full scroll still downloads 14.5 MB of
video; the change delays it, it does not shrink it.

Health check of the live site (Nov 4, before this change): ten routes at 1440, 375
and 320px had no console errors, failed same-origin requests, broken images or
sideways scrolling, and 16 internal links returned 200. External services were
blocked during the check, so forms, booking and Bit were not exercised.

Known and left alone: unknown URLs return the homepage with a 200, not a 404. The
canonical tag points to the homepage, which limits the SEO cost.

All four marketing suites and the build check pass on this code.

Merged as `ce5abb3` (PR #8) and published to Firebase Hosting on November 4, 2026
(evening, Eastern), on the owner's approval and without a second reviewer. Hosting
only. CI passed on the PR. Verified on `https://bitesites.org`: both domains serve
the new bundle, `test-marketing-built.mjs` passed, and in a browser sections pause
off screen and resume on screen, portfolio videos play on screen, with no page
errors. The ten-route check at 1440, 375 and 320px was repeated with no new
findings. The owner has not yet confirmed the scroll feel.

## Round 5: simpler homepage, new `/services` page

Owner request: keep the homepage to the sections they like and move the rest off it.

- **Homepage order:** hero, form, portfolio, consultation, nobody answers,
  reactivation, Byte & Bit, pricing, about, team, final CTA. Team was not in the
  owner's list and stayed by default; that is theirs to confirm.
- **New `/services` page:** "One system. Six places", "Fix the gap" and "Built for
  businesses" moved here. Service cards lost their bullets, which repeat on each
  service page. The page is in the sitemap, `llms.txt` and the prerender.
- **Service detail modal removed.** "Discuss your project" now links to
  `/?service=<key>#start`, which pre-selects the form as the modal did.
- **Links:** the homepage footer now lists all six service pages, so they stay one
  click from the homepage. "The System" left the top menu. Old `#system`,
  `#services` and `#industries` links redirect to `/services`, which also covers
  Bit's `/#services` link in `functions/bit-persona.js` without a Functions deploy.

- **Custom icons:** 33 hand-drawn SVGs in `src/components/CustomIcons.jsx`: 18 on
  `/services` (steps, services, industries) and 15 on the homepage (form, recovery
  path, reactivation, About), with no repeats. `RevenueIcon` and the form's
  `ServiceIcon` were removed. Controls (arrows, checkmarks, mic) and the Byte and
  Bit mascots were left alone. Drawn in code, not Canva, so they
  stay sharp and take their colors from each card. The six-step tiles no longer
  float a large number behind the text: icon and a small numbered pill share a top row.

- **Hover test:** the card hover check failed about 1 run in 8 on `/services`. In the
  one failure captured, the still test pointer had lost `:hover` while the card sat
  at the expected spot. The exact trigger was not proven. The test now waits out the
  reveal and re-hovers once, as a moving mouse would; it then passed 10 of 10.

Homepage visible text fell from about 1,990 words to about 1,390 and its height
from 15,478px to 11,797px at 1440px wide. That content moved rather than
disappeared, but the homepage now says less about individual services. Rankings
cannot be verified from here.

Merged as `8b6a05d` (PR #9) and published to Firebase Hosting on November 4, 2026
(late evening, Eastern), on the owner's approval and without a second reviewer.
Hosting only. CI passed on the PR. Verified on `https://bitesites.org`: both domains
serve the new bundle, `test-marketing-built.mjs` passed, the page check at 1440, 375
and 320px found no new problems, 25 internal links returned 200, `/services` is in
the sitemap and `llms.txt`, OAI-SearchBot, GPTBot, Googlebot and bingbot get 200,
old anchors redirect, and form pre-selection works. `/services` still needs
submitting in Search Console and Bing Webmaster Tools.

## Status

Merged to `main` as `20fde8f` (PR #7) and published to Firebase Hosting on
November 4, 2026, on the owner's approval, without a second person reviewing
the PR. Hosting only: no Functions, Firestore rules or dialer changes were
deployed. CI passed on the merged code.

Verified on `https://bitesites.org` after release: `test-marketing-built.mjs`
passed against the live domain, and the sticky CTA, section order, four social
links and no sideways scrolling were checked in a browser at one desktop width.
No up-right arrows remain. Plain right arrows (→) remain on text links and
were left in place. Phone widths were rechecked on the live domain in Round 4.

## Open: Bit is down until OpenAI credits are added

Since at least November 4, 16:06 UTC, every Bit reply in the logs has failed with
OpenAI `429 You have no credits remaining`. `OPENAI_API_KEY` is set and enabled
(version 1), so this is a billing problem, not a missing key. Visitors see Bit's
generic fallback. `byte-web-session`, the AI SIP dispatch, the dialer API and
the sideband use the same secret, so they are likely affected too; that was not
tested. Not fixed: it needs the OpenAI account owner to add credits.

## Round 6 — team feedback, November 5, 2026

- **Crisis support:** Bit had no crisis response, and a visitor who wrote "i want to die" got the outage message. The chat window now answers crisis statements itself with 988 call, text and chat links, before any network call, so it works while the AI is down. Those words are not sent to the model or saved to the conversation log. The server repeats the check, and Bit and Byte carry the rule in their personas; those two parts need a Functions deploy. The check is a fixed word list, so it can miss unusual phrasing.
- **Mobile exit:** the Close button was visible and worked in an emulated iPhone, so the reported trap was not reproduced. The likely cause is that iPhones zoom into text boxes under 16px, and Bit's was 15px. The box is now 16px and the window follows the visible screen. Not confirmed on a real iPhone.
- **Legal pages:** the Privacy and Terms pages showed `[Street address]` and `[ZIP]` placeholders. The line is now hidden until a real address is set in `src/pages/legal-details.js`. The registered entity name also still needs confirming.
- **Not fixed here:** Clifton Ave Animal Hospital's own site has no privacy or terms links, and its code is not in this repo.

## Round 7: Bit and Byte moved to ElevenLabs (built 2026-11-06, not deployed)

Bit failed because the OpenAI account had no credits. Each failed message also retried three times before showing the outage reply, and Byte runs on the same account. Every Bit and Byte function scaled to zero, so the first visitor after a quiet spell waited several seconds for a cold start.

- **Bit:** `functions/bit-agent-turn.js` runs each turn through a text-only ElevenLabs agent from the server. History stays in Firestore, tools still run in `bit-chat.js`, and the browser still receives finished text. Each turn is a new ElevenLabs conversation that carries the stored history.
- **Byte:** `src/lib/byte-voice.js` uses the ElevenLabs browser client with a single-use link from `/api/byte-session`. Tools still relay through `/api/byte-tools`. ElevenLabs now handles silence: Byte re-engages after 12 seconds and hangs up after 45. This replaces the old nudge and farewell scripts.
- **Agents:** `scripts/setup-web-agents.mjs` creates both agents, with ids in `functions/web-agent-ids.js`. Rerun it after any persona or tool change, because prompts now live on the agents. Both need a server-issued link, allow no overrides, save no audio, and retain nothing at ElevenLabs. The account also holds another client's agents, so the script only updates ids it recorded.
- **Models:** both agents use `claude-haiku-5-5` through ElevenLabs. `BIT_CHAT_MODEL` and the Byte voice setting in the persona files no longer choose the live model or voice. Byte's voice changed to the ElevenLabs voice Bella.
- **Speed:** the four public functions keep one warm instance (`minInstances: 1`), which adds a small monthly charge.
- **Privacy:** the Privacy page now names ElevenLabs for Bit and Byte instead of GoHighLevel.
- **Tested on the real service:** a five-turn Bit chat took 1.6 to 3.6 seconds per reply, with pricing, knowledge and availability tools and a hold, and refused to print its prompt. Tool results were stubbed for that test, so no booking was made. Byte connected in a real browser in 1.6 seconds and spoke its greeting using a fake microphone.
- **Not tested:** nobody has spoken to Byte with a real microphone, the warm-instance speedup is unmeasured, and `test:bit-chat` and `test:byte-web` were updated but need Java, so only CI can run them.
