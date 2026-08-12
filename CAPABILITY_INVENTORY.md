# Capability inventory — source systems inspected before implementation

This is the §4 inspection stage output, produced before any code was copied or
written. It records what exists in the source systems, what was reused, what was
rewritten, and what was deliberately left behind.

## Local paths inspected

| System | Local path | Branch / commit at inspection |
|---|---|---|
| BiteSites application (destination) | `/Users/maxj/Documents/BiteSites/Bitesites 2` | `main` @ `c205643` "arrows to portfolio carousel" |
| BiteSites-Leads (the "Dialer" fork) | `/Users/maxj/Dialer` | `main` @ `5526c8f` "Kixie Implemented" |
| Watcher-Workflows (upstream of the fork) | `/Users/maxj/Documents/Watcher-Workflows` | `main` @ `11e989f` "Database improvements" |

The folder the brief called `watcherworkflows` is `Documents/Watcher-Workflows`
(GitHub remote `BrandonBalcacer/Watcher-Workflows`). The repository the brief
called `BiteSites-Leads` is checked out at `~/Dialer` (GitHub remote
`jjimenez723/BiteSites-Leads`) — it is a fork of Watcher-Workflows that is two
commits ahead, adding "Dialer v.0.1" (GoHighLevel) and "Kixie Implemented".

**Neither source repository was modified.** Both are Python projects (Firebase
Functions on `python312`, a static SPA dashboard); nothing was copied verbatim
into BiteSites, which is Node 22 / React 19.

## Firebase projects

| Role | Project | How it was inspected |
|---|---|---|
| Source | `watcher-leads-89349` | Live Firestore inspection completed 2026-08-12; production source remained read-only. |
| Destination | `bitesites-org` | `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `functions/index.js` |

Live inspection on 2026-08-12 verified the code-derived schema against Firestore.
It also found the legacy `leads` duplicate and proved the Phase-4 `companies` /
`smb_contacts` joins before production migration. The source was backed up and
remained read-only throughout the BiteSites transfer; see `WATCHER_MIGRATION.md`
for exact counts and the run record.

## Source Firestore collections (from code)

| Collection | Sample field names | Timestamp fields | Personal data | Likely duplicate keys | Airbnb? | Proposed destination | Transformation | Safe to migrate? |
|---|---|---|---|---|---|---|---|---|
| `smb_leads` | link, name, source, sources[], source_count, industry, field, location, review_count, score, reason, services, ingest_status, phone, website, email, email_domain_type, google_rating, google_review_count, contact_first_name, contact_last_name, additional_contacts[], enrichment_*, verification_*, descriptor, status, assigned_to, notes | verification_checked_at, created_at, updated_at | name, phone, email, contact names, address-in-`location` | `link` (doc id is its hash), `website`, `phone`, `email` | No | `prospects` | normalise + dedupe + source attribution | Yes, after review |
| `companies` | Phase-4 company grain: link, name, source, sources[], industry, field, descriptor, location, review_count, score, reason, services, phone, website, google_rating, google_review_count, enrichment_*, is_airbnb + Airbnb-only columns | created_at, updated_at | name, phone | `link` | Carries `is_airbnb` — rows with it set are excluded | dedupe verification | Projection of authoritative lead rows; scan and reconcile only | Yes, but never create a second prospect |
| `smb_contacts` | Phase-4 person grain: company_id, link, email, first_name, last_name, persona_role, email_domain_type, email_source, email_confidence, email_type, verification_status, descriptor, is_primary | verification_checked_at | email, person names | `email`, `company_id` | No | `prospects.contacts[]` | Join by `company_id`, union by normalized email | Yes, when the parent has a valid canonical prospect |
| `leads` | Legacy pre-split company grain | mixed | name, phone, email | doc id / link | Mixed | — | — | No — every live id duplicates `smb_leads` or `airbnb_leads` |
| `airbnb_leads` | Everything above plus signals{}, host_name, host_listings_count, is_superhost, room_type, price, rating, photo_count, max_photo_width, photos[], external_links[], needs_photo_review, photo_quality, photo_issues, photo_reason | — | host names | `link` | **Yes** | — | — | **No — Airbnb ICP** |
| `airbnb_contacts` | person grain for the Airbnb ICP (expected ~empty) | — | email | `email` | **Yes** | — | — | **No — Airbnb ICP** |
| `content` | lead_id, hook, point, example, format, post | — | — | `lead_id` | Shared | — | — | No — outreach copy, not a contact |
| `videos` | lead_id, link, status, url, clips, tour_url | — | — | `lead_id` | Mostly Airbnb | — | — | No |
| `lead_generation_log` | lead_id, link, email, first_name, company_name, skill_commit, model, validation_status, token counts, cost_usd | — | email, name | (lead_id, skill_commit) | No | — | — | No — email-copy generation log |
| `smartlead_events` / `smartlead_config` / `campaign_health_snapshot` / `inbox_health_snapshot` / `subject_variant_performance` | email-sequence telemetry and config | — | email | — | No | — | — | No — email channel, out of scope |
| `outreach_requests` | lead_id, action (sms/voice_ai), consent_basis, consent_record, status, result | — | — | — | No | — | — | No — the other dashboard's request log |
| `kixie_sessions` | lead ids, consent, per-lead results, status | — | — | — | No | — | — | No — the other dashboard's session log |
| `access` / `access_requests` | email, scopes[] | — | email | — | No | — | — | No — the other dashboard's access control |
| `spend` / `run_requests` / `video_requests` | operational job queues and cost accounting | — | — | — | Mixed | — | — | No |
| `mcp_oauth` | OAuth clients, authorization codes, tokens and redirect metadata | mixed | client names, contacts | client id | No | — | — | No — credentials for the other application |

The ICP routing rule in the source is `is_airbnb_lead(row)`: `source == 'airbnb'`
or `'airbnb' in sources`. BiteSites re-implements it in
`functions/providers/lead-sources/existing-watcher-source.js` **and goes
further** — see the Airbnb boundary section.

## Capability inventory

### 1. Lead-source providers and scraping entry points

| | |
|---|---|
| **Capability** | Multi-source business discovery: Google Places, Yelp, Overpass/OSM, NYC restaurant permits, NY business filings, NYC licences, Reddit |
| **Source** | Watcher-Workflows / BiteSites-Leads |
| **Source files** | `executions/discover_places.py`, `discover_overpass.py`, `discover_nyc_restaurants.py`, `discover_ny_filings.py`, `discover_nyc_licensed.py`, `discover_bergen_new.py`, `fetch_reddit.py`, `_sources.py`, `_socrata.py`, `_overpass.py` |
| **Dependencies** | Python 3.12, `requests`, provider API keys |
| **Trigger** | `run_pipeline.py` CLI, or a `run_requests/{id}` document processed by `process_run_requests.py` |
| **Data inputs** | keywords, category, location, radius |
| **Data outputs** | `runs/*.json` candidate files → `smb_leads` |
| **External services** | Google Places, Yelp, Overpass, Socrata, Reddit |
| **Credentials** | provider API keys via `.env` |
| **Retry** | per-source ad hoc |
| **Idempotency** | doc id = hash of `link`; upsert |
| **Reusable as-is?** | No — Python, and coupled to the `runs/` file protocol |
| **Needs refactoring?** | Yes — rebuilt as a provider-neutral adapter interface |
| **BiteSites destination** | `functions/providers/lead-sources/` (`adapter.js`, `google-places.js`, `mock-source.js`, `csv-source.js`); Google Places credential and both callables live-verified/deployed 2026-08-12 |
| **Airbnb dependency?** | No, but shares `_store.py` with `discover_airbnb.py` — the generic parts were extracted, the Airbnb adapter left behind |
| **Security** | Provider keys must be server-side only; Google Places' caching/redistribution terms are stricter than most and are **unverified** |

### 2. Search-query generation, geographic / category / radius targeting, pagination

| | |
|---|---|
| **Capability** | Query construction and paging per provider |
| **Source files** | `executions/discover_places.py`, `_sources.py` |
| **Reusable as-is?** | No |
| **BiteSites destination** | `LeadSourceAdapter.discover(criteria, cursor)` — a cursor-per-page contract so a job survives a function timeout, which the file-based original did not need |
| **Notes** | Google Places (New) caps a text search at 20 per page and 3 pages. BiteSites' `maximumResults` sits on top of that ceiling and cannot raise it. |

### 3. Rate limiting and retry logic

| | |
|---|---|
| **Source files** | `executions/_budget.py` (spend caps), `_observability.py`, `_progress.py` |
| **Reusable as-is?** | No — modelled on a long-running local process |
| **BiteSites destination** | Replaced by bounded slices (`runDiscoverySlice`, `budgetMs`) plus a scheduled retry, which is the shape a Cloud Function can actually honour |

### 4. Browser automation

| | |
|---|---|
| **Source files** | `executions/scrape_site.py`, `scrape_yelp.py`, `scrape_contacts.py`, `_firecrawl.py`, `_stringweb.py` |
| **Dependencies** | Firecrawl, HTTP scraping; the repo's `Dockerfile` targets Cloud Run |
| **Reusable as-is?** | No |
| **BiteSites destination** | **Not ported.** §13's local-worker protocol is implemented instead (`discoveryWorker` HTTPS function + `claimJobForWorker`/`heartbeatJob`/`submitDiscoveryResults`/`finishJob`), so a browser-driven scraper can run on a laptop or Cloud Run without Firestore credentials. |
| **Security** | A worker gets a shared secret, never Firestore write access. Everything it submits is re-normalised and re-deduplicated server-side. |

### 5. Lead normalisation, phone / website / email extraction

| | |
|---|---|
| **Capability** | Business-name normalisation, website host extraction, cross-source identity key |
| **Source files** | `executions/_store.py` (`norm_name`, `website_host`, `merge_key`), `_contacts.py` (`normalize_company`, `clean_first_name`, `email_domain_type`), `_enrich.py` (`domain_of`), `functions/highlevel.py` (`normalize_phone`) |
| **Reusable as-is?** | **Behaviour yes, code no** (Python) |
| **BiteSites destination** | `functions/prospect-normalization.js` — pure, tested, provider-neutral |
| **What was preserved** | The apostrophe rule (Tony's/TONYS), legal-suffix stripping in a loop (Co., Inc.), `www.` dropping, the first-name junk gate including the length cap that caught "Hi Unclejoespizzawallington", the E.164 rule that rejects extensions |
| **What was added** | Placeholder scrubbing, timezone resolution that refuses to guess, directory/social hosts excluded from identity, timestamp coercion across four shapes |

### 6. Duplicate detection

| | |
|---|---|
| **Source files** | `executions/merge_candidates.py`, `_store.py:merge_key` |
| **Behaviour** | `merge_key` precedence: source id → website host → name+town → link |
| **Reusable as-is?** | Behaviour yes |
| **BiteSites destination** | `functions/prospect-deduplication.js` |
| **What changed** | A directory host never becomes an identity; a name-only match scores below the confirm threshold and goes to Import Review instead of merging; the strongest signal wins rather than signals summing |

### 7. Lead scoring and enrichment

| | |
|---|---|
| **Source files** | `executions/score_and_rank.py`, `score_relevance.py`, `_fingerprint.py`, `check_signals.py`, `check_tech_stack.py`, `enrich_waterfall.py`, `enrich_email.py`, `enrich_places.py`, `verify_emails.py`, `_enrich.py` |
| **External services** | Findymail, Hunter, Snov, Apollo, Firecrawl |
| **Reusable as-is?** | The **HTML fingerprinting** is; the email waterfall is not (email channel, out of scope) |
| **BiteSites destination** | `functions/lead-enrichment.js` — `detectTech()` is a faithful port of `_fingerprint.py` including the GTM caveat (a missing pixel behind Google Tag Manager stays `null`, never `true`) |
| **Notes** | No external enrichment provider was integrated. §27 forbids integrating one without verifying its current API and terms, and none was verified here. |

### 8. CSV import

| | |
|---|---|
| **Source files** | `executions/import_csv.py`, `csv/` (per-vertical exports), `_fields.py` |
| **Reusable as-is?** | No |
| **BiteSites destination** | `functions/providers/lead-sources/csv-source.js` — an RFC-4180 reader (quoted commas, embedded newlines, doubled quotes, BOM) plus header aliasing, then the same normalise/dedupe path as everything else |

### 9. Firebase reads and writes

| | |
|---|---|
| **Source files** | `executions/_firebase.py`, `sync_to_firebase.py`, `migrate_collections.py`, `migrate_person_grained.py` |
| **Reusable as-is?** | No — writes to `watcher-leads-89349` |
| **BiteSites destination** | All cross-project reads live in `scripts/migrate-watcher-leads.mjs` only. §15: source-project writes are not scattered through the new codebase; there are none. |

### 10. Background and scheduled jobs

| | |
|---|---|
| **Source files** | `functions/main.py` (`process_run_requests`, `process_outreach_request`, `process_kixie_session`, `smartlead_webhook`, `kixie_webhook`), `.github/` workflows |
| **BiteSites destination** | `reconcileOutbound` (every 5 min), `runAICampaigns` (every 5 min), `outboundNightlyMaintenance` (03:00 America/New_York) |

### 11. n8n / workflow definitions

Searched: `~/.n8n` exists on the machine but the source repositories contain **no
n8n workflow exports** — no `*.n8n.json`, no `workflows/` directory. The
"workflow" layer in these projects is `directives/*.md` (24 markdown runbooks
driving Python CLIs). Classification per §15:

| Directive | Classification |
|---|---|
| `discover-places.md`, `discover-overpass.md`, `discover-new-businesses.md` | **Port to Cloud Function** — became the lead-source adapter interface |
| `import-csv.md` | **Port to Cloud Function** — `importProspectCsv` |
| `score-relevance.md`, `find-marketing-gaps.md`, `audit-marketing-gaps.md` | **Port to Cloud Function** — `detectTech` + the brief builder |
| `scrape-contacts.md` | **Keep as local runner** — needs a browser; the worker protocol exists for it |
| `enrich-contacts.md`, `enrich-waterfall.md`, `verify-emails.md` | **Do not migrate** — email channel, unverified providers |
| `store-in-firebase.md`, `migrate-person-grained.md` | **Replace** — with the BiteSites prospect-import service |
| `discover-airbnb.md`, `generate-airbnb-video.md`, `rate_listing_photos` | **Airbnb — exclude** |
| `smartlead-integration.md`, `write-posts.md`, `write-briefs.md` | **Do not migrate** — email/social outbound |
| `build-dashboard.md`, `manage-access.md` | **Obsolete** — BiteSites has its own console and role system |
| `classify-descriptors.md` | **Reuse conceptually** — became `business.category` normalisation |

### 12. Existing dashboards and authentication assumptions

| | |
|---|---|
| **Source** | `dashboard/index.html` — a single-file static SPA, Firebase Web SDK from a vendored bundle, `access/{email}` documents carrying scope strings (`view_smb`, `view_airbnb`, `use_dialer`, `edit_leads`) |
| **Reusable as-is?** | **No, deliberately.** §5 forbids embedding it, adding a second sidebar, or importing its CSS. |
| **BiteSites destination** | Rebuilt as `src/admin/OutboundCalls.jsx` + `src/admin/outbound/*` inside the existing console, using BiteSites' existing `roles/{uid}` + custom-claim model. The scope vocabulary was **not** migrated — BiteSites has one admin role and adding a parallel permission system would be a second authentication system. |

### 13. Kixie integration (the fork's addition)

| | |
|---|---|
| **Source files** | `~/Dialer/functions/kixie.py`, `docs/kixie-parallel-dialer.md`, `tests/test_kixie.py` |
| **Trigger** | `kixie_sessions/{id}` document → `process_kixie_session` |
| **What it actually does** | Adds contacts to a Kixie **PowerList** via `https://apig.kixie.com/app/event` with `eventname: updatepowerlist`. A human agent then dials that list from the PowerCall extension. |
| **Webhooks** | `answeredcall`, `endcall`, `disposition` → normalised in `parse_webhook` |
| **Credentials** | `KIXIE_API_KEY`, `KIXIE_BUSINESS_ID`, `KIXIE_POWERLIST_ID`, `KIXIE_WEBHOOK_SECRET` |
| **Idempotency** | `duplicateHandling: merge` makes a repeated API call a no-op by phone |
| **Reusable as-is?** | Behaviour yes, code no |
| **BiteSites destination** | `functions/providers/calling/kixie.js` — payload construction, webhook normalisation (both nested and flattened shapes), constant-time header check |
| **Security** | Kixie documents **no signed webhook envelope**. Authentication is a custom shared header, which is weaker than a signature and is recorded as such rather than described as "signed". |

### 14. GoHighLevel integration

| | |
|---|---|
| **Source files (fork)** | `~/Dialer/functions/highlevel.py`, `docs/gohighlevel-dialer.md` |
| **Source files (BiteSites, existing)** | `functions/index.js` — `syncLeadToGoHighLevel`, `recordVoiceCall`, `pollVoiceCalls`, `importVoiceHistory`; `src/lib/ghl-voice.js` |
| **Mechanism** | `POST /contacts/upsert` then `POST /contacts/{id}/workflow/{workflowId}`. If the workflow's first action is a Voice AI outbound call, enrolment starts the call. |
| **Reusable as-is?** | Behaviour yes |
| **BiteSites destination** | `functions/providers/calling/gohighlevel.js` |
| **Preserved** | DND handling (`dnd` / `dndSettings`) outranks any campaign setting |
| **Not broken** | The existing inbound path is untouched. `recordVoiceCall` still owns browser-widget calls; the outbound normaliser returns `null` for any payload without BiteSites campaign metadata, so the two cannot fight over an event. |

### 15. Secrets accidentally committed

**None found in either source repository.** `.env` and `*serviceAccount*.json`
are both git-ignored in Watcher-Workflows and BiteSites-Leads, and
`git ls-files` confirms neither is tracked. Untracked `.env` and
`serviceAccount.json` files **do exist on disk** in both checkouts. They were
not opened, not copied, and their values were not read — only the variable
*names* were listed (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`,
`GHL_LOCATION_ID`, `GHL_VOICE_AI_WORKFLOW_ID`, `GOHIGHLIGHT_API_KEY`).

> **Recommendation.** `~/Dialer/serviceAccount.json` and
> `~/Documents/Watcher-Workflows/serviceAccount.json` are long-lived
> service-account keys sitting in plain files on a laptop. They are correctly
> git-ignored, but a key on disk is a key that can leak. Rotate them and move to
> Application Default Credentials — which is what `scripts/migrate-watcher-leads.mjs`
> uses, so the migration needs no key file at all.

### 16. Environment variables

Source `.env.example` files list ~60 variables across both projects (provider
keys, Firebase config, Smartlead, Firecrawl, video generation). **None were
copied.** BiteSites' `.env.example` gained only the names it actually needs —
see `.env.example` and OUTBOUND_CALLING_SETUP.md. No `VITE_` variable was
created for any credential.

## Airbnb boundary

Case-insensitive searches were run across both source repositories for `airbnb`,
`air bnb`, `nightly rate`, `occupancy`, `reservation`, `host`, `rental`,
`property listing`.

**Excluded entirely** (not migrated, not imported, not scheduled, not deployed):

- Collections `airbnb_leads`, `airbnb_contacts`
- Fields `is_airbnb`, `host_name`, `host_listings_count`, `is_superhost`,
  `room_type`, `price`, `photo_count`, `max_photo_width`, `photos`,
  `external_links`, `needs_photo_review`, `photo_quality`, `photo_issues`,
  `photo_reason`, `signals`
- Files `executions/discover_airbnb.py`, `_airbnb.py`, `_airbnb_score.py`,
  `rate_listing_photos.py`, `_video.py`, `video_queue.py`, `drain_videos.sh`
- Directives `discover-airbnb.md`, `generate-airbnb-video.md`
- The `videos` collection and the video-generation queue
- The `short_term_rental` descriptor bucket

**Generic utilities extracted rather than discarded** (§6): `_store.py`'s
`norm_name`/`website_host`/`merge_key` and `_fingerprint.py` are used by Airbnb
code in the source, but are not Airbnb-specific. Their behaviour was rebuilt in
`prospect-normalization.js` / `prospect-deduplication.js` / `lead-enrichment.js`
with Airbnb field names and assumptions removed, a provider-neutral interface,
and independent tests.

**Enforcement, not just intent.** `isAirbnbRecord()` tests the source project's
own routing rule *and then goes further*: it scans every field name for listing
markers and every URL/industry value for Airbnb strings, because the source rule
only holds for rows that project's pipeline wrote. A hand-edited or
half-migrated document is exactly the one that would slip through. The Watcher
adapter **throws** rather than silently dropping Airbnb fields, the migration
script excludes and counts them (`counts.airbnbExcluded`), and four tests assert
it — `npm run test:dedupe`, `npm run test:migration`, `npm run test:discovery`.

## Deployed-artifact check

The requirement is that the deployed BiteSites client and Cloud Functions
contain no dormant Airbnb functionality.

Every occurrence of the string, case-insensitively, across the shipped code:

```
$ grep -ril "airbnb" src/ functions/ scripts/ | grep -v node_modules
src/admin/outbound/ImportReview.jsx
functions/prospect-import.js
functions/prospect-normalization.js
functions/providers/lead-sources/existing-watcher-source.js
functions/providers/lead-sources/existing-bitesites-leads-source.js
scripts/migrate-watcher-leads.mjs
scripts/migrate-watcher-leads.test.mjs
```

All seven are the **exclusion machinery**, not Airbnb functionality:

| File | What the string is |
|---|---|
| `existing-watcher-source.js` | `isAirbnbRecord()` and the field/value marker lists it matches against; `normalize()` throws on a match |
| `existing-bitesites-leads-source.js` | re-exports `isAirbnbRecord` so the fork's adapter uses the same test |
| `prospect-import.js` | the `airbnbExcluded` counter and the `'airbnb_record'` classification branch that skips the row |
| `prospect-normalization.js` | one comment noting the source project's second ICP |
| `migrate-watcher-leads.mjs` | the `EXCLUDED_COLLECTIONS` entries with their reasons, plus the per-row exclusion check |
| `migrate-watcher-leads.test.mjs` | the tests asserting the exclusion holds |
| `ImportReview.jsx` | the **"Airbnb excluded"** column in the import-run table — an operator has to be able to see the count |

Removing any of these would remove the guarantee rather than tighten it. No
Airbnb data model, provider adapter, scheduled job, browser automation, UI
feature, analytics or environment variable exists anywhere in `src/`,
`functions/`, `dist/` or the deployment configuration. The one match in `dist/`
is the compiled `ImportReview.jsx` column heading.
