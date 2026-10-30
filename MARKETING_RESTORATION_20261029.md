# Public website restoration — October 29, 2026

## Cause confirmed from Firebase release history

- October 27, 11:54 AM Eastern: Hosting version `59fca21ddd654ae3` had
  81 files, including the dedicated FAQ, pricing, five service pages,
  robots.txt and sitemap.xml.
- October 27, 10:13 PM Eastern: version `1768dc49437ba068` replaced it
  with 53 files. All those SEO pages and files were absent. This was a new
  deployment, not a Firebase rollback operation.
- The subsequent October 28–29 releases retained that older public site.
  The pre-restoration live version was `968206504e978604`.
- The redesign and SEO source was preserved as uncommitted/untracked files
  in the original workspace, based on September 23 commit `bd3544c`.
  Shared main did not contain it, so rebuilding shared code removed it.
  Release records identify the sequence; they do not establish intent.

## Recovery

Recovered the existing marketing implementation into a separate checkout based
on `8dd48c7`, the latest deployed rep/dialer code. The original working directory
and its unrelated changes are preserved. Admin, Functions, Firestore rules and
indexes match that live baseline. This release publishes Hosting only.

Restored revenue-systems copy, the five-step intake, five service pages, pricing,
18-question FAQ, holographic cards, molten backgrounds, initial HTML rendering,
route-specific metadata/canonical URLs, structured data, sitemap, robots and
the newer social image. This is the recovered design, with no new redesign.

The source and pinned OGL dependency are now included in Git. `npm run build`
runs prerendering and a content check. A Hosting predeploy check rejects a build
missing the restored public content even if someone runs Vite directly.
Other older uncommitted admin features are outside this public-site recovery.

## Validation before publishing

- Production build and prerendering passed.
- Marketing browser suite passed: five-step intake, validation, field retention,
  retry/duplicate handling, service preselection, FAQ, metadata and mobile layouts.
- Interactive-section suite passed: hover, keyboard/touch, recovery steps,
  About disclosures, reduced motion and seven viewport widths.
- Molten-background suite passed: rendering, frame/pixel limits, pointer input,
  offscreen/hidden-tab behavior, mobile CTAs and WebGL/reduced-motion fallbacks.
- Built-site suite passed through Firebase Hosting emulator: all 15 routes,
  no-JavaScript content, 18 FAQ answers/schema, assets, sitemap, robots,
  custom-project form advancement and pricing dialog.
- Existing dialer browser suite and all 43 focused dialer tests passed.
- Deployment guard accepts the restored build and rejects the previous
  production build with its old homepage title.
- Desktop and mobile screenshots reviewed. Browser tests block live submissions,
  calls and external API writes. No real lead, call or account was created.

Production release details will be recorded after publishing and live checks.
