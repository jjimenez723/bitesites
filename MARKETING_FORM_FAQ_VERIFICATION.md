# Marketing form and FAQ — October 8, 2026

This report records the initial form and FAQ release. The subsequent
[revenue systems update](REVENUE_SYSTEMS_VERIFICATION.md) expands the FAQ to 18
answers and broadens the homepage positioning and public service routes.

## Before the change

- The form immediately below the homepage hero was a long, two-column intake:
  short copy on the left and the full form stacked on the right.
- The live `/faq` URL rendered the homepage, confirmed in a browser. There was
  no dedicated FAQ route or navigation link. Four AI answers were visible near
  the agent demos; three related answers also appeared in global FAQ metadata.
- The same homepage canonical URL and structured data were served on every
  application route. The repository had no sitemap or robots file.

## Implemented

- Stone Bellisimo's reference flow informed the numbered progress rail,
  selectable cards, one question at a time, back navigation, and final summary.
  The design uses BiteSites' colors, typography, and services.
- Five steps: services, business size, timeline, optional project details, then
  contact information. Existing service-modal preselection remains functional.
  Phone is required only for phone contact. Answers survive back navigation and
  failed requests. Pending requests disable editing and repeat submission.
- Lead transport, field names, service values, `intake_form` attribution,
  Firestore rules, CRM integration, and the thank-you destination are preserved.
- The floating chat launcher hides while the form is visible on small screens
  so it cannot cover form controls.
- `/faq` contains 13 answers, keyboard-operable native disclosures, navigation
  links, and project/booking calls to action. The React view is pre-rendered at
  build time. Visible answers and FAQ structured data use the same source.
- Route-specific canonical URLs, descriptions, share metadata, and structured
  data are applied to direct loads and client-side navigation. Utility pages
  such as the questionnaire and thank-you page carry `noindex` in built HTML.
- Added a public sitemap and robots file. No special AI ranking file or ranking
  promise was added. Google states that existing SEO fundamentals remain relevant
  to AI search: https://developers.google.com/search/docs/appearance/ai-features.
- Bit's approved page-link tool now supports `/faq`; its project-form card
  describes the five-step flow. Pricing and factual-answer policies are retained.

## Verification

- Production build and FAQ pre-render.
- `node scripts/test-marketing-browser.mjs` with the local Vite server: all five
  steps, required fields, optional phone/details, service preselection, editing,
  complete payload, failure recovery, duplicate-request protection, thank-you
  navigation, FAQ disclosures, keyboard interaction, structured-data parity,
  metadata restoration, and layouts from 320 to 1440 pixels. Lead transport is
  mocked and outbound network/API requests are blocked.
- `node --test functions/bit-persona.test.mjs functions/byte-persona.test.mjs`:
  18 passing tests, including the approved link enum and knowledge policies.
- `scripts/test-marketing-built.mjs` passed against the Firebase Hosting emulator
  on an isolated release. It verifies clean URLs, initial metadata,
  robots/sitemap delivery, and all 13 FAQ answers without JavaScript against a
  built preview or Firebase Hosting emulator.

## Release status and limits

Production publication was explicitly approved by the owner in this conversation.
Firebase Hosting deployed successfully on October 8, 2026. The live site at
https://bitesites.org and the FAQ at https://bitesites.org/faq passed browser and
static-HTML checks. Bit's `bitChatSession` and `bitChatTurn` functions also
deployed successfully and report `ACTIVE`; their existing production settings
were verified unchanged. Both live endpoints pass a read-only method check.

The isolated release checkout at `/tmp/bitesites-marketing-release-20261008`
contains only the 21 task files, based on commit `bd3544c`. The production build,
browser flow checks, hosting checks, and persona tests all passed there. Hosting
was published from its verified `dist/`. Unrelated workspace changes were not
included. The function deployment preserves the six existing production user
settings retrieved from the live chat functions.

No live lead, confirmation email, agent conversation, or phone call was created
as part of verification. Production CRM delivery and search indexing/traffic
were not measured. The website was published before the targeted Bit functions
so the FAQ destination was available when the agent update went live.

The homepage still relies on JavaScript for its full marketing content. The new
FAQ has complete static HTML; the other generated routes receive correct initial
metadata and render their interactive content through React.


## Custom AI project follow-up

Published the requested fourth service card, **Custom AI project**, to Firebase
Hosting on October 8, 2026. Visitors can choose it alone or alongside the existing
services. The idea step uses a custom AI prompt, and the final summary retains
the selection and description. The layout uses four columns on desktop, two on
tablets, and one on phones.

The existing lead normalizer stores this choice as `services: ['other']` with
`customAnswers.services: 'Custom AI project'`; the existing CRM notes include
that label and the project details. No Firestore rule or function changes were
needed. Browser tests cover custom-only and mixed-service normalization, retained
answers, and the submission payload with mocked transport. The production build,
live custom-project flow, 320–1440px layouts, and live FAQ/metadata checks passed.
No live lead was submitted during verification.
