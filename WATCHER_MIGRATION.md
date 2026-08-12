# Migrating the Watcher / BiteSites-Leads corpus into BiteSites prospects

Source: `watcher-leads-89349` (read-only) → Destination: `bitesites-org`

> **Production migration completed 2026-08-12.** Import run
> `v5fDnObrQFYOLgWHTIgt` completed with zero failures. Its source backup is
> `gs://watcher-leads-89349-firestore-backups/pre-bitesites-migration-20260812T165228Z`.
> Re-runs remain idempotent and still default to dry-run.

## What is being migrated, and what a prospect is

Scraped businesses are **cold prospects**, not leads. The existing `leads`
collection means "someone who engaged with BiteSites" — a form submission, a Bit
chat, a Byte call — and it is what the Overview and Performance screens count as
website conversions. Dropping 40,000 scraped businesses into it would destroy
those numbers.

So everything lands in `prospects/{prospectId}`, and a prospect only becomes a
lead after **meaningful engagement**: someone answered a call, a meeting was
booked, an email was replied to, or an administrator qualified it by hand. An
attempted call is explicitly not enough — `promoteProspect` refuses the trigger.

## Prerequisites

```bash
gcloud auth application-default login
```

The account needs `roles/datastore.viewer` on `watcher-leads-89349` and
`roles/datastore.user` on `bitesites-org`.

If the two projects need different credentials, point at separate key files
**by path**:

```bash
export SOURCE_GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/source-key.json
export DEST_GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/dest-key.json
```

Never commit a service-account file. `.gitignore` already covers `*.json` keys,
but Application Default Credentials avoids the question entirely — which is why
it is the default here.

## Commands

```bash
# 1. What is actually in the source project? Reads only, prints small samples.
node scripts/migrate-watcher-leads.mjs --inspect

# 2. Transform and deduplicate everything, write nothing. THIS IS THE DEFAULT.
node scripts/migrate-watcher-leads.mjs --dry-run

# 3. Narrow it down while you are still reading the output.
node scripts/migrate-watcher-leads.mjs --dry-run --limit 100
node scripts/migrate-watcher-leads.mjs --dry-run --collection smb_leads

# 4. Actually write. Prompts for confirmation unless --yes.
node scripts/migrate-watcher-leads.mjs --execute

# 5. Continue an interrupted run from its stored cursor.
node scripts/migrate-watcher-leads.mjs --resume <runId>
```

Running the script with no flags is a dry run. There is no way to write without
typing `--execute`, and it then asks you to type `migrate` unless `--yes` is
passed.

## Collection mapping

| Source collection | Destination | Notes |
|---|---|---|
| `smb_leads` | `prospects` | The main company-grained corpus |
| `companies` | dedupe verification only | Phase-4 projection of `smb_leads`/`airbnb_leads`; every live id overlaps an authoritative lead row, so it is scanned to prove the duplicate or Airbnb verdict but never creates a second prospect |
| `smb_contacts` | `prospects.contacts[]` | Phase-4 person projection; joined to the canonical prospect by `company_id`, preserving primary and additional people without creating company-less prospect duplicates |

Everything else is excluded, with the reason recorded in `EXCLUDED_COLLECTIONS`:

| Excluded | Why |
|---|---|
| `leads` | Legacy pre-split duplicate; all 1,248 live ids already exist in `smb_leads` or `airbnb_leads` |
| `airbnb_leads`, `airbnb_contacts` | **Airbnb ICP — stays in its own application** |
| `content`, `videos` | Outreach copy and video assets, not contact records |
| `lead_generation_log`, `smartlead_*`, `campaign_health_snapshot`, `inbox_health_snapshot`, `subject_variant_performance` | Email-channel telemetry and configuration |
| `access`, `access_requests` | Access control for the other dashboard |
| `spend`, `run_requests`, `video_requests` | The other pipeline's job queues and cost accounting |
| `outreach_requests`, `kixie_sessions` | The other dashboard's request and session logs |
| `mcp_oauth` | OAuth clients and tokens for the other application |

Live inspection on 2026-08-12 found 34,838 `smb_leads`, 6,835
`airbnb_leads`, 17,349 `companies`, and 1,485 `smb_contacts`. Every company
projection overlaps an authoritative lead id (16,117 SMB, 1,232 Airbnb), and
all 1,485 contact rows join to a company. That is why the projections are
reconciled into the canonical prospect rather than independently inserted.

> The map was derived from the source project's own schema definitions
> (`executions/_firebase.py`), not guessed — but **`--inspect` re-derives it from
> the live project**, and that is the output to trust. If `--inspect` reports a
> collection that is not in either table above, stop and decide where it belongs
> before running anything else.

## Field mapping

| Source field | Prospect field | Transformation |
|---|---|---|
| `name` | `companyName`, `name` | title-cased if SHOUTING; known initialisms preserved |
| `phone` | `phoneE164` (+ `phone` kept raw) | E.164, NANP-first; extensions **rejected** |
| `email` | `email` | lowercased, validated |
| `website` | `website`, `dedupe.normalizedWebsite` | canonical https, `www.` dropped; social/directory hosts excluded from identity |
| `location` (free text) | `address.{line1,city,region,postalCode}` | parsed; state names → 2-letter codes |
| — | `location.timezone` | derived from state, then area code; **left empty rather than guessed** |
| `field` / `industry` | `business.category`, `business.categories[]` | snake_case controlled vocabulary |
| `google_rating`, `google_review_count` | `business.rating`, `business.reviewCount` | numeric coercion |
| `score` | `lifecycle.score` | preserved |
| `reason` / `notes` | `notes` | preserved |
| `sources[]` | `tags[]` | deduplicated |
| `contact_first_name` | `firstName` | role-inbox names rejected (`info`, `admin`, …) |
| `smb_contacts` person fields | `contacts[]` | joined by `company_id`; email/name/role/verification provenance and source contact id preserved |
| `link` | `source.sourceUrl` | preserved |
| doc id | `source.sourceDocumentId`, `source.providerRecordId` | preserved |
| `ghl_contact_id` (fork only) | `providerContactId` | so the CRM contact is reused rather than duplicated |
| `consent_basis`, `consent_record` (fork only) | preserved | audit trail |
| `dnc` | `contactability.doNotCall` | honoured |

Every migrated prospect carries:

```js
source: {
  system: 'watcher_leads',
  sourceProjectId: 'watcher-leads-89349',
  sourceCollection: '…',
  sourceDocumentId: '…',
  importedAt: …
}
```

## Idempotency

Destination ids are deterministic: `watcher_<sourceCollection>_<sourceDocumentId>`,
or `watcher_h<hash>` when that would be an unsafe Firestore id.

A hashed id is **not** a rewritten one. `a/b` and `a_b` hash to different
documents rather than collapsing into one — collapsing them would be a silent
merge of two source records.

Re-running updates the same documents. A re-run also preserves anything a human
has since decided: `createdAt`, team lifecycle edits, a reviewed duplicate
verdict and any conversion link all survive; only the source-derived facts
refresh.

## Resume

`--execute` persists the run's cursor to `importRuns/{runId}` after every batch,
per collection. `--resume <runId>` continues from there.

**A dry run is not resumable, by design.** It writes nothing at all, including
its own bookkeeping — otherwise "the default writes no production data" would be
false, just in a collection nobody looks at.

## Classification, and what each bucket does

| Classification | Behaviour |
|---|---|
| Cold prospect | → `prospects`, status `ready` |
| Previously contacted | → `prospects` **plus an `imported_prior_contact` activity**, so the history is not lost |
| Qualified opportunity | → `prospects`, status `needs_review` |
| Existing customer | → `prospects`, status `needs_review` — never straight into a sales workflow |
| Internal test | **skipped** |
| Invalid record | **counted and skipped** |
| Airbnb record | **always skipped**, counted in `counts.airbnbExcluded` |

No migrated record is added to a campaign. A migrated prospect stays
non-callable until normalisation and dedupe are complete, compliance is checked,
any required review is done, and a campaign explicitly selects it.

## Deduplication during migration

Order: same-batch → existing prospects → existing leads.

- **Strong identifiers merge**: exact normalised phone, exact business email,
  exact registrable domain, source-system id, provider record id.
- **Fuzzy signals only flag**: a matching company name (with or without the same
  town) lands in Import Review as `duplicate.status: "possible"` with the reason
  and a confidence score. Nothing merges on a name.
- The strongest signal wins; signals do not sum. Three weak coincidences stay
  weak, so two same-named shops in neighbouring towns are not fused.

## The Airbnb boundary

`airbnb_leads` and `airbnb_contacts` are not in the collection map, and **every
record from every collection still passes through `isAirbnbRecord()`** — because
a listing that ended up in an SMB collection is exactly the row a
collection-level filter would miss.

The check tests the source project's own routing rule (`source == 'airbnb'`,
`'airbnb' in sources`, `is_airbnb`), then scans every field name for listing
markers (`host_name`, `room_type`, `is_superhost`, `photo_quality`, `occupancy`,
`nightly`, …) and every URL/industry value for Airbnb strings.

A match is excluded and counted. The Watcher adapter **throws** rather than
silently dropping the fields. `npm run test:migration` asserts all of it,
including a row that carries `is_superhost` but nothing else Airbnb-ish.

## Migration safety checklist

Before `--execute`:

- [ ] `--inspect` run and the source schema reviewed against the map above
- [ ] Destination collision count understood (on a re-run it should equal what
      was migrated last time)
- [ ] `--dry-run` counts reviewed: scanned, mapped, created, updated, skipped,
      duplicates, invalid, failed, **airbnbExcluded**
- [ ] The transformed sample (first 25) eyeballed — names, phones, statuses
- [ ] Airbnb exclusion count is non-zero if the source has an Airbnb ICP
      (a zero there is suspicious, not reassuring)
- [ ] Invalid-record count understood — a high number usually means a field
      mapping is wrong, not that the data is bad
- [ ] A source export or backup exists (`gcloud firestore export`)
- [ ] Run ID recorded
- [ ] **Explicit approval from the repository owner**

## Verifying and rolling back

```bash
# Counts by import run
node scripts/migrate-watcher-leads.mjs --inspect
```

In the console, **Outbound Calls → Import Review → Import runs** shows every
run's counts, including Airbnb exclusions, and links its errors.

Every migrated prospect carries `importRunId`. To archive a batch, query
`prospects` by that field and set `lifecycle.status: 'archived'` — a soft
archive rather than a delete, so the source attribution survives for audit.
There is no automatic rollback; a batch archive is the strategy.

## Production run record — 2026-08-12

| Count | Value |
|---|---:|
| scanned | 52,187 |
| mapped | 17,013 |
| created | 12,695 |
| updated | 0 |
| skipped | 1,234 |
| duplicates | 20,435 |
| invalid | 17,823 |
| failed | 0 |
| airbnbExcluded | 1,232 |

The live run matched the full dry run exactly. Post-write verification found
12,695 documents carrying the run id, 20/20 source-to-destination spot checks
matched for normalized phone, email, and source attribution, and each sampled
prospect had an import activity. `leads` remained 15 documents and campaigns /
targets remained 2 / 1, proving the migration did not create inbound conversions
or enroll prospects in campaigns.

Of 1,485 `smb_contacts` rows, 1,243 source rows from 771 valid companies were
attached to canonical prospects. Duplicate email addresses were unioned with
all source contact ids retained, producing 1,161 unique embedded contact entries.
That includes 59 company duplicates whose people were redirected to the
surviving prospect. The remaining 242 contact rows belong to 242 source
companies with no usable company name and no confirmed canonical match; they
were deliberately not attached to an unrelated company.

## Tests

```bash
npm run test:migration    # the tool's pure halves — no project is contacted
npm run test:discovery    # import, dedupe and idempotency against the emulator
```

Neither reads from nor writes to `watcher-leads-89349` or `bitesites-org`.
