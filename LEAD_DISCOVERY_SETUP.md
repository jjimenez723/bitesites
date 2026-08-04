# Lead discovery — sources, jobs, and the local worker

Finding businesses, turning them into prospects, and getting them to the point
where a campaign can call them.

## The pipeline, and why every stage exists

```
discovered → normalised → deduplicated → reviewed → compliance-checked → in a campaign → callable
```

Nothing skips a stage. A prospect that arrives from a scraper is `new`; it
becomes `ready` only when normalisation succeeded, dedupe found nothing
confirmed, and the record is actually contactable. A fuzzy duplicate or a
missing phone number sends it to `needs_review` instead, and even a `ready`
prospect is not called until a campaign explicitly selects it.

**React never scrapes.** The dashboard creates a `scrapeJobs/{jobId}` document
through a callable; the server runs it.

## Sources

| Source | Runs in | Radius | Keywords | Secrets | State |
|---|---|:--:|:--:|---|---|
| `mock` | Cloud Function | ✅ | ✅ | none | Fully working — the default |
| `csv` | Cloud Function | ❌ | ❌ | none | Fully working |
| `google_places` | Cloud Function | ✅ | ✅ | `LEAD_SOURCE_API_KEY` | Implemented, **unverified** |
| `watcher_workflow` | Migration script | — | — | none | Field mapping only |
| `bitesites_leads` | Migration script | — | — | none | Field mapping only |

### Mock

Deterministic and offline. Every automated test runs against it, and a new job
defaults to it, so the whole discover → normalise → dedupe → review flow can be
demonstrated before a provider key exists. Every fifth record is a deliberate
near-duplicate of the one before it, so the dedupe stage has something real to
catch.

### Google Places (New)

**Unverified against a live account.** The request shape follows the
`places:searchText` contract, but nothing here has been run with a real key.
Before enabling it:

- Confirm the current field mask and its pricing tier — Places bills per field,
  and an unfocused mask is a recurring cost for data nobody reads. The mask here
  is deliberately narrow.
- **Read the Terms of Service on caching and redistribution.** They are stricter
  than most APIs and they constrain how long a Places result may be stored,
  which is a live question for a `prospects` collection.
- Note the ceiling: 20 results per page, 3 pages (60 results) per text search.
  A job's `maximumResults` sits on top of that and cannot raise it.

```bash
firebase functions:secrets:set LEAD_SOURCE_API_KEY
```

### CSV

An RFC-4180 reader, not a `split(',')` — a pasted export routinely contains
quoted commas, embedded newlines and a BOM, and a naive parser turns one of
those rows into three malformed prospects that then get dialled.

Recognised columns (aliases in brackets): `name`, `firstName` [first name,
given name], `lastName` [surname], `company` [business, organization, account],
`email` [e-mail, work email], `phone` [telephone, mobile, primary phone],
`website` [url, domain], `timezone`, `notes`, `priority`, `title` [role,
position], `category` [industry, vertical], `address` [street], `city`, `state`
[region], `zip` [postal code], `country`.

Unrecognised columns are ignored and **reported back**, so a mistyped header is
visible rather than silently dropped. Preview is mandatory: the upload button
sends `dryRun: true`, and the import button only appears after a preview
returns. The file is never uploaded to Storage — it travels as the body of an
authenticated callable.

### The migrated sources

`watcher_workflow` and `bitesites_leads` cannot start a job — `supports()`
returns `false` and `discover()` throws. Records arrive only through
`scripts/migrate-watcher-leads.mjs`. A discovery job that could pull from the
source project would be a second, unaudited migration path. See
WATCHER_MIGRATION.md.

## Adding a source

Implement `LeadSourceAdapter` (`functions/providers/lead-sources/adapter.js`):

```js
export class MySource extends LeadSourceAdapter {
  static id = 'my_source';
  static label = 'My source';
  static executionMode = 'cloud_function';   // or 'local_runner'
  static requiredSecrets = ['MY_SOURCE_API_KEY'];
  static supportsRadius = true;

  async validateConfig(criteria) { return { valid: true, errors: [] }; }
  async discover(criteria, cursor) { return { records, cursor, done }; }
  normalize(raw) { return { name, phone, email, website, address, category, externalId }; }
  sourceIdentity(raw) { return { provider: MySource.id, providerRecordId: raw.id }; }
}
```

Register it in `providers/lead-sources/index.js`. Two rules:

- `normalize()` returns a **flat field bag**, never a prospect document. The
  taxonomy lives in `prospect-normalization.js`; an adapter that builds its own
  document is one that will drift from it.
- `discover()` returns **one page** with a cursor. A provider that returns
  everything at once cannot be resumed after a timeout, and a Cloud Function
  will time out.

## Job execution

`runDiscoverySlice` is time-boxed rather than run-to-completion. Each invocation
does as much as it safely can, persists its cursor, and leaves the job `running`
for the next call. A function killed mid-page resumes from the page it finished,
not from the beginning.

Statuses: `draft`, `queued`, `running`, `paused`, `awaiting_local_worker`,
`processing`, `completed`, `failed`, `cancelled`.

Progress is reported as five separate numbers — discovered, valid, duplicates,
rejected, imported — because collapsing them into a percentage hides the case
that matters: a job that found 400 and imported nine because the rest were
already in the corpus.

## Raw results and retention

Raw provider payloads are stored under `scrapeJobs/{jobId}/results/{resultId}`,
admin-only, so a reviewer can see where a fact came from and a normalisation bug
has something to re-run against.

They expire after **7 days** and are deleted by `outboundNightlyMaintenance`.
Raw payloads are the only place personal data sits un-normalised, and Firestore
charges to keep them forever.

## The local worker

For anything needing a real browser. A headless Chromium wants ~1GB and minutes
of runtime, will meet CAPTCHAs and anti-bot interstitials, and depends on cookie
state — none of which belongs in a callable with a 9-minute ceiling.

**The worker never gets Firestore credentials.** It holds a shared secret and
talks to one endpoint; everything it submits is re-normalised and
re-deduplicated by the Admin SDK on the server side. The worker's job is to
fetch, not to decide what is stored.

```bash
firebase functions:secrets:set DISCOVERY_WORKER_SECRET
```

Add a Hosting rewrite for a stable URL:

```json
{ "source": "/api/discovery-worker",
  "function": { "functionId": "discoveryWorker", "region": "us-central1" } }
```

### Protocol

```js
const call = (action, body = {}) =>
  fetch('https://bitesites.org/api/discovery-worker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': process.env.DISCOVERY_WORKER_SECRET },
    body: JSON.stringify({ action, workerId: 'laptop-1', ...body })
  }).then(response => response.json());

const { job } = await call('claim');
if (!job) return;                                    // nothing waiting

for await (const batch of scrape(job.criteria, job.cursor)) {
  await call('submit', { jobId: job.id, records: batch });          // ≤500 per call
  await call('heartbeat', { jobId: job.id, cursor: batch.cursor }); // at least every 3 min
}

await call('finish', { jobId: job.id, status: 'completed' });
```

Claims are transactional — two workers polling the same queue cannot both take a
job. A worker that stops heartbeating for **3 minutes** loses its claim:
`recoverStaleJobs` (part of `reconcileOutbound`, every 5 minutes) returns the job
to `awaiting_local_worker` so another worker can pick it up. A dead worker
cannot park a job forever.

Submitted records use the same flat shape `normalize()` returns.

### Cloud Run

The same protocol works from a Cloud Run job or service — nothing about it
assumes a laptop. Use Cloud Run when the scrape needs to run on a schedule
without someone's machine being on. The worker's only requirement is outbound
HTTPS and the shared secret.

## Enrichment

The brief is built by `functions/lead-enrichment.js`, in the order §27 specifies:
existing Firestore data → prior activity and call history → the stored
GoHighLevel contact → the company's own website → an approved external provider.

**No external enrichment provider is integrated.** §27 forbids integrating one
without verifying its current API and terms, and none was verified here. Apollo,
People Data Labs, Clay, Exa and Tavily are all candidates; each needs its terms
read before it is wired in.

What the website pass does verify, ported from the Watcher pipeline's
`_fingerprint.py`: the site builder (and whether it is a DIY one, meaning no
agency is being paid), analytics and tag managers, advertising pixels, chat
widgets, and schema.org LocalBusiness markup. Those are facts about a business's
marketing that BiteSites can read from the page source, and they are the actual
reason to call.

The GTM caveat from the original is preserved and matters: a large site injects
pixels at runtime through Google Tag Manager, so "no pixel in the HTML" is only
a conclusion when GTM is absent. When it is present, the finding stays
**undetermined** rather than becoming a claim about their marketing that we
cannot support.

The research bot identifies itself honestly
(`BiteSitesResearchBot/1.0 (+https://bitesites.org/; contact@bitesites.org)`).
It fetches one page, follows redirects, times out at 8 seconds and reads at most
600KB. Do not point it at sites whose terms prohibit it.

Briefs cache for **14 days** in `leadResearch/{contactKey}`, keyed
deterministically so a lead and a prospect can never collide.

## Approval

`requireResearchApproval` (default on) stops a target being dialled until a human
has read its brief. An approver may reword the summary and the suggested
opening. They may **not** add a "verified fact" or a source — those are ignored
by `approveLeadResearch`, because the whole sourcing rule depends on
`verifiedFacts` being unforgeable.

An unapproved brief hands the calling agent nothing: no summary, no facts, no
talking points. Only the disclosures survive, and those are mandatory.

## Cost controls

- `maximumResults` is a hard per-job ceiling (1–1000), validated server-side.
- The Places field mask is narrow — Places bills per field.
- Raw payloads expire after 7 days.
- Research caches for 14 days rather than re-fetching per call.
- Dedupe runs before any enrichment, so a duplicate is never enriched.
- Every list query in the console is capped and says so when it hits the cap.

## Disabling lead discovery

Remove the `getOutboundConfig`, `createLeadDiscoveryJob`, `runLeadDiscoveryJob`
and `discoveryWorker` exports from `functions/index.js` and redeploy, or delete
`DISCOVERY_WORKER_SECRET` and `LEAD_SOURCE_API_KEY` — every source that needs a
secret fails closed without it, and the endpoint returns `503 not-configured`.

## Tests

```bash
npm run test:prospects     # normalisation
npm run test:dedupe        # dedupe, compliance, Airbnb boundary, CSV parsing
npm run test:discovery     # jobs, import, idempotency, resume, the worker protocol
npm run test:enrichment    # fingerprinting, briefs, approval
```

No test contacts a provider or scrapes a live site.
