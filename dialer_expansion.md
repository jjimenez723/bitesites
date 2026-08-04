# BiteSites Unified Lead Discovery, Prospect Management, Outbound Calling, and Dialer Implementation

You are a senior full-stack engineer working across the BiteSites repositories, local workflow files, and Firebase projects.

Your assignment is to extend the existing BiteSites admin dashboard with a complete lead-discovery and outbound-sales system that includes:

* Lead scraping and discovery.
* Migration of existing prospect data.
* Prospect normalization and deduplication.
* Lead research and enrichment.
* AI-operated outbound calls.
* Human-operated power dialing.
* Human-operated parallel dialing with one to five simultaneous calls.
* Call tracking, transcripts, recordings, dispositions, and campaign analytics.
* Integration with the existing BiteSites lead, GoHighLevel, Firebase, and admin-dashboard architecture.

Do not begin by writing code.

First inspect the existing systems, produce a capability inventory and implementation plan, and then implement the feature incrementally.

Do not execute a production data migration or place a live telephone call unless the repository owner explicitly instructs you to do so in a separate request.

---

# 1. Systems and sources to inspect

## Primary BiteSites application

```text
https://github.com/jjimenez723/bitesites
```

## Existing lead-generation repository

```text
https://github.com/jjimenez723/BiteSites-Leads
```

The GitHub connector may not have access to this repository. Inspect the local checkout directly when necessary.

## Local workflow folder

```text
watcherworkflows
```

Locate this folder without assuming an absolute path.

Search the current repository’s parent directory, common project folders, and the user’s home directory for names including:

```text
watcherworkflows
watcher workflows
watcher dash workflows
watcher-dash-workflows
Watcher Dash Workflows
```

Use the actual folder found on the local machine.

## Existing source Firebase project

```text
watcher-leads-89349
```

Firebase console:

```text
https://console.firebase.google.com/u/0/project/watcher-leads-89349/overview
```

## Destination Firebase project

```text
bitesites-org
```

The final integrated application must use `bitesites-org` as its primary Firebase project.

Do not configure the BiteSites browser application to connect directly to both Firebase projects.

---

# 2. Primary objective

Add a new admin-dashboard area called:

```text
Outbound Calls
```

Primary route:

```text
/admin/outbound
```

This area must combine:

1. Lead discovery.
2. Prospect management.
3. Import and migration review.
4. Lead research.
5. Outbound campaign creation.
6. AI outbound calling.
7. Power dialing.
8. Parallel dialing.
9. Call Later management.
10. Call history.
11. Provider and campaign settings.
12. Campaign analytics.

Recommended internal navigation:

```text
Campaigns
Lead Discovery
Prospects
Import Review
Queue
Live Dialer
Call Later
History
Settings
```

The final experience must look and behave like part of the existing BiteSites admin dashboard.

Do not embed another application or create a second dashboard shell.

---

# 3. Existing BiteSites architecture to preserve

The current application uses:

* React 19.
* Vite.
* React Router.
* Firebase Authentication.
* Cloud Firestore.
* Firebase Cloud Functions v2.
* Firebase Hosting.
* Firebase App Check.
* GoHighLevel/LeadConnector.
* Postmark.

Important existing files include:

```text
src/main.jsx
src/admin/AdminApp.jsx
src/admin/data.js
src/admin/admin.css
src/admin/Panel.jsx
src/admin/Overview.jsx
src/admin/Performance.jsx
src/admin/Leads.jsx
src/admin/Conversations.jsx
src/admin/Transcript.jsx
src/admin/Users.jsx
src/admin/EmailStudio.jsx

src/lib/firebase.js
src/lib/auth.js
src/lib/leads.js
src/lib/conversations.js
src/lib/ghl-voice.js

functions/index.js
functions/package.json
functions/voice-webhook.test.mjs
functions/voice-import.test.mjs
functions/lifecycle-webhook.test.mjs

firestore.rules
firestore.indexes.json
firebase.json
package.json
FIREBASE_SETUP.md
scripts/test-rules.mjs
```

Architectural requirements:

1. `src/admin/AdminApp.jsx` owns the admin navigation and routes.
2. Each major admin screen should remain a separate React component.
3. The admin application must remain lazily loaded from the public marketing application.
4. Do not import telephony SDKs, Firebase Auth, or admin-only functionality into the public marketing bundle.
5. Firestore rules—not React route guards—are the actual security boundary.
6. External provider credentials must exist only in Firebase Secret Manager or another server-side secret system.
7. The browser must never directly call GoHighLevel, Kixie, enrichment services, scraping providers, or telephony APIs with secret credentials.
8. Existing inbound forms, Bit conversations, Byte calls, email workflows, lead management, analytics, and admin access must continue working.
9. All new admin styles must remain scoped beneath `.bs-admin`.
10. Reuse existing admin components, patterns, and classes wherever practical.

Existing reusable styles include:

```text
admin-topbar
admin-body
admin-card
admin-table
admin-filters
admin-segment
admin-search
admin-select
btn-admin
Panel
Pill
DetailRows
```

Do not introduce global CSS that affects the public marketing site.

---

# 4. Mandatory inspection stage

Before copying or modifying code, inspect:

1. The current `bitesites` repository.
2. The local `BiteSites-Leads` checkout.
3. The local `watcherworkflows` folder.
4. Firebase setup files associated with `watcher-leads-89349`.
5. Existing Firestore collections in `watcher-leads-89349`.
6. Existing Firestore collections in `bitesites-org`.
7. Existing GoHighLevel voice and lead-sync functionality.
8. Existing migration, scraper, cron, browser automation, and workflow files.

Do not modify the source lead repository or workflow folder during the inspection stage.

Produce a capability inventory before implementation.

For every potentially reusable capability, report:

```text
Capability
Source repository or folder
Source files
Dependencies
Trigger
Data inputs
Data outputs
External services
Required credentials
Retry behavior
Idempotency behavior
Reusable as-is?
Needs refactoring?
Proposed BiteSites destination
Airbnb dependency?
Security concerns
```

The capability inventory must identify:

* Lead-source providers.
* Scraping entry points.
* Search-query generation.
* Geographic targeting.
* Category targeting.
* Radius targeting.
* Pagination.
* Rate limiting.
* Retry logic.
* Browser automation.
* API integrations.
* Firebase reads and writes.
* Lead normalization.
* Phone normalization.
* Website extraction.
* Email extraction.
* Duplicate detection.
* Lead scoring.
* Enrichment.
* CSV import.
* Background jobs.
* Scheduled jobs.
* n8n or other workflow definitions.
* Notifications.
* Existing dashboards.
* Authentication assumptions.
* Environment variables.
* Secrets accidentally committed.
* Airbnb-specific code.

Do not begin copying code until this inventory is complete.

---

# 5. Reuse behavior, not the old application shell

The final product must remain one BiteSites admin dashboard.

Do not:

* Embed the old dashboard in an iframe.
* Add a second sidebar.
* Add a second authentication system.
* Copy the old project’s branding.
* copy an entire Firebase web configuration.
* Import old CSS globally.
* Make administrators switch applications.
* Expose a second public web application.
* Copy source files blindly without understanding their dependencies.

Reuse useful algorithms and workflows from `BiteSites-Leads` and `watcherworkflows`, but rebuild the presentation and authorization around the current BiteSites architecture.

Any copied logic should be refactored into clear, tested, provider-neutral modules.

---

# 6. Explicitly exclude Airbnb functionality

Airbnb functionality must remain in its current application.

Do not migrate, copy, import, expose, schedule, or deploy:

* Airbnb listing scraping.
* Airbnb URLs.
* Airbnb provider adapters.
* Airbnb search filters.
* Airbnb Firestore collections.
* Airbnb scheduled jobs.
* Airbnb browser automation.
* Airbnb data models.
* Airbnb UI components.
* Airbnb environment variables.
* Airbnb analytics.
* Airbnb tests.
* Airbnb deployment configuration.

Search source systems for case-insensitive references including:

```text
airbnb
air bnb
nightly rate
occupancy
reservation
host
rental
property listing
```

Do not automatically discard a generic utility merely because Airbnb code uses it.

When a useful generic utility is entangled with Airbnb code:

1. Extract the generic behavior.
2. Remove Airbnb-specific field names.
3. Remove Airbnb-specific assumptions.
4. Define a provider-neutral interface.
5. Add independent tests.
6. Leave the Airbnb adapter in its original repository.

The deployed BiteSites client and Cloud Functions must not contain dormant Airbnb functionality.

---

# 7. Separate cold prospects from inbound leads

The existing BiteSites `leads` collection represents people who have already engaged with BiteSites through sources such as:

* Website intake forms.
* Bit chat.
* Byte voice calls.
* Other direct customer interactions.

Scraped businesses are not inbound leads.

They are cold prospects.

Do not import every scraped business into the existing `leads` collection.

Create:

```text
prospects/{prospectId}
```

Use `prospects` for:

* Scraped businesses.
* Imported cold-contact lists.
* Businesses discovered through search jobs.
* Records migrated from `watcher-leads-89349`.
* Businesses that have not yet meaningfully engaged with BiteSites.

A prospect can later be promoted or linked to a lead after meaningful engagement.

Meaningful engagement may include:

* A person answers an outbound call.
* A person replies to an email.
* A meeting is booked.
* An administrator manually qualifies the prospect.
* The prospect submits a BiteSites form.
* The prospect starts a Bit or Byte conversation.

An attempted call alone must not automatically create an inbound lead.

This separation must protect existing inbound funnel analytics, response-time metrics, and lead-conversion reporting.

---

# 8. Prospect data model

Create:

```text
prospects/{prospectId}
```

Suggested shape:

```js
{
  type: "outbound_prospect",

  name,
  firstName,
  lastName,
  companyName,
  jobTitle,

  phone,
  phoneE164,
  email,
  website,

  address: {
    line1,
    city,
    region,
    postalCode,
    country
  },

  location: {
    lat,
    lng,
    timezone
  },

  business: {
    category,
    categories: [],
    description,
    employeeRange,
    estimatedRevenue,
    rating,
    reviewCount
  },

  source: {
    system: "watcher_leads" | "bitesites_leads" | "manual" | "csv" | "scraper",
    provider,
    providerRecordId,
    sourceProjectId,
    sourceCollection,
    sourceDocumentId,
    sourceUrl,
    searchJobId,
    importedAt
  },

  lifecycle: {
    status,
    owner,
    priority,
    score,
    nextActionAt,
    convertedLeadId
  },

  contactability: {
    validPhone,
    validEmail,
    doNotCall,
    doNotEmail,
    complianceStatus,
    complianceReasons: []
  },

  enrichment: {
    status,
    lastEnrichedAt,
    confidence
  },

  dedupe: {
    normalizedCompany,
    normalizedWebsite,
    phoneHash,
    emailHash,
    canonicalKey
  },

  duplicate: {
    status,
    duplicateOfType,
    duplicateOfId,
    matchReasons: [],
    matchConfidence,
    reviewedBy,
    reviewedAt
  },

  notes,
  tags: [],

  importRunId,
  createdAt,
  updatedAt
}
```

Prospect lifecycle statuses:

```text
new
needs_review
ready
queued
researching
approved
contacting
connected
qualified
converted
not_interested
call_later
invalid
do_not_contact
archived
```

---

# 9. Prospect activities

Create:

```text
prospects/{prospectId}/activities/{activityId}
```

Activity types may include:

```text
discovered
imported
normalized
duplicate_flagged
duplicate_resolved
research_started
research_completed
research_approved
added_to_campaign
call_attempted
call_connected
call_later
do_not_contact
converted_to_lead
archived
```

Activities should be append-only from the browser.

Provider-originated, migration-originated, and sensitive activities should be written through Cloud Functions or the Admin SDK.

When a prospect becomes a lead, preserve the connection to the prospect activity history instead of copying and rewriting every event.

---

# 10. Prospect-to-lead conversion

Create an idempotent server-side operation:

```text
promoteProspectToLead
```

It must:

1. Require authenticated admin access.
2. Load the prospect.
3. Search existing leads by normalized phone and email.
4. Link to an existing lead when a strong match exists.
5. Otherwise create exactly one new lead.
6. Preserve source attribution.
7. Preserve research and engagement history.
8. Set `prospect.lifecycle.convertedLeadId`.
9. Add an activity record.
10. Update related outbound targets and calls.
11. Avoid resetting an existing lead’s stage, owner, economics, qualification, or history.
12. Be safe to execute more than once.

Suggested lead attribution:

```js
{
  source: "outbound",
  acquisition: {
    originalSystem: "watcher_leads",
    originalProspectId,
    originalSourceDocumentId,
    campaignId,
    firstConnectedCallId
  }
}
```

Update source labels in `Leads.jsx` and related components so outbound-generated leads are displayed correctly.

Do not count a scraped prospect as a website conversion.

---

# 11. Lead Discovery interface

Create a Lead Discovery interface inside `/admin/outbound`.

The administrator must be able to:

* Select a lead-source provider.
* Enter business categories.
* Enter search keywords.
* Choose a location.
* Set a radius where supported.
* Set a maximum-result limit.
* Start a discovery job.
* Pause or cancel a supported job.
* Monitor job progress.
* Review raw and normalized results.
* View the source of each fact.
* Resolve possible duplicates.
* Approve or reject prospects.
* Archive irrelevant records.
* Add approved prospects to a campaign.

Required progression:

```text
discovered
→ normalized
→ deduplicated
→ reviewed or approved by explicit rules
→ compliance checked
→ added to campaign
→ callable
```

Do not call prospects directly from raw scraper results.

Recommended frontend components:

```text
src/admin/OutboundCalls.jsx

src/admin/outbound/CampaignBuilder.jsx
src/admin/outbound/CampaignList.jsx
src/admin/outbound/CampaignMetrics.jsx

src/admin/outbound/LeadDiscovery.jsx
src/admin/outbound/ScrapeJobBuilder.jsx
src/admin/outbound/ScrapeJobList.jsx
src/admin/outbound/ProspectList.jsx
src/admin/outbound/ProspectDetail.jsx
src/admin/outbound/ImportReview.jsx
src/admin/outbound/SourceBadge.jsx

src/admin/outbound/LeadQueue.jsx
src/admin/outbound/LeadResearchPanel.jsx
src/admin/outbound/DialerControls.jsx
src/admin/outbound/ActiveCallPanel.jsx
src/admin/outbound/CallLaterQueue.jsx
src/admin/outbound/CallHistory.jsx
src/admin/outbound/ProviderStatus.jsx

src/admin/outbound/data.js
src/admin/outbound/outbound.css
```

Small components may be combined when appropriate, but do not create one giant unmaintainable page component.

---

# 12. Scraping architecture

Do not execute lead scraping directly from React.

Move reusable scraping logic behind server-controlled jobs.

Recommended structure:

```text
functions/
  lead-discovery.js
  prospect-normalization.js
  prospect-deduplication.js
  prospect-import.js

  providers/
    lead-sources/
      index.js
      mock-source.js
      google-places.js
      existing-watcher-source.js
      existing-bitesites-leads-source.js
```

Define a provider-neutral source interface:

```js
export class LeadSourceAdapter {
  async validateConfig() {}
  async discover(criteria, cursor) {}
  normalize(rawRecord) {}
  sourceIdentity(rawRecord) {}
  supports(criteria) {}
  canResume(job) {}
  async healthCheck() {}
}
```

Stable provider IDs may include:

```text
bitesites_leads
watcher_workflow
google_places
csv
mock
```

The BiteSites application must not depend on the original repository’s raw response shapes.

---

# 13. Browser automation and long-running scraping

When source functionality uses browser automation, inspect:

* Chromium or Playwright requirements.
* Memory requirements.
* Runtime length.
* Authentication requirements.
* CAPTCHA behavior.
* Anti-bot behavior.
* Rate limits.
* Provider terms.
* Cookie or profile dependencies.
* Retry behavior.
* Resume behavior.

Do not assume a full browser will run reliably inside a normal Firebase callable function.

Use one of the following when appropriate:

* Cloud Run.
* Cloud Run Jobs.
* Cloud Tasks.
* Firebase scheduled functions.
* A documented local worker.
* A manual CSV import.

If a scraper must remain local, create a safe local-worker protocol.

Example:

```text
The dashboard creates a scrape job.
The local worker claims it.
The worker sends heartbeats.
The worker submits normalized result batches through an authenticated endpoint.
The worker marks the job completed or failed.
```

Do not give a local worker unrestricted public Firestore write access.

Use service credentials or a narrowly scoped authenticated ingestion endpoint.

Stale claims must expire safely.

---

# 14. Scrape-job data model

Create:

```text
scrapeJobs/{jobId}
```

Suggested shape:

```js
{
  provider,
  status,

  criteria: {
    keywords: [],
    category,
    location,
    radiusMiles,
    maximumResults
  },

  progress: {
    discovered,
    processed,
    valid,
    duplicates,
    rejected,
    imported
  },

  execution: {
    mode: "cloud_function" | "cloud_run" | "local_runner" | "mock",
    workerId,
    cursor,
    attempt,
    lastHeartbeatAt
  },

  createdBy,
  createdAt,
  startedAt,
  completedAt,
  failedAt,
  error
}
```

Statuses:

```text
draft
queued
running
paused
awaiting_local_worker
processing
completed
failed
cancelled
```

Store temporary raw results under:

```text
scrapeJobs/{jobId}/results/{resultId}
```

Raw results must be admin-only and have a retention policy.

Do not leave unlimited raw provider payloads in Firestore permanently.

---

# 15. Integrating `watcherworkflows`

Inspect the local `watcherworkflows` folder for:

* n8n workflow exports.
* JSON workflows.
* Firebase scripts.
* Node scripts.
* Python scripts.
* Browser automation.
* Cron definitions.
* Webhook payloads.
* Environment-variable references.
* Lead scoring.
* Deduplication.
* Notifications.
* Enrichment.
* CSV processing.
* Manual review.
* Airbnb functionality.

Classify each workflow as:

```text
Reuse directly
Port to Cloud Function
Port to Cloud Run
Keep as local runner
Replace with Firebase scheduler
Do not migrate
Airbnb — exclude
Obsolete
```

Do not import workflow JSON blindly.

For every workflow selected for migration, document:

1. Trigger.
2. External services.
3. Credentials.
4. Input schema.
5. Output schema.
6. Side effects.
7. Retry behavior.
8. Duplicate-execution risks.
9. Idempotency strategy.
10. Operational monitoring.
11. Test or mock path.

If a workflow currently writes directly to `watcher-leads-89349`, replace that write with the new BiteSites prospect-import service.

Do not scatter source-project writes throughout the new codebase.

---

# 16. Source Firebase project inspection

The Firebase console URL identifies the source project but does not establish its collection schemas.

Inspect:

* `.firebaserc`.
* `firebase.json`.
* Firestore initialization files.
* Firestore rules.
* Firestore indexes.
* Cloud Functions.
* scripts.
* exports.
* environment-variable examples.
* collection names referenced in code.

Generate a source-data report:

```text
Collection
Approximate document count
Sample field names
Timestamp fields
Personally identifiable fields
Likely duplicate keys
Airbnb-related?
Proposed destination
Transformation required
Safe to migrate?
```

Use small representative samples.

Do not print entire sensitive datasets.

---

# 17. Firebase migration tool

Build:

```text
scripts/migrate-watcher-leads.mjs
```

Source project:

```text
watcher-leads-89349
```

Destination project:

```text
bitesites-org
```

Initialize two named Firebase Admin applications:

```js
initializeApp(sourceConfig, "source");
initializeApp(destinationConfig, "destination");
```

Prefer Application Default Credentials with explicit project IDs.

Do not commit service-account JSON files.

When separate credentials are required, accept local credential paths through environment variables and document them.

The migration tool must support:

```bash
node scripts/migrate-watcher-leads.mjs --inspect
node scripts/migrate-watcher-leads.mjs --dry-run
node scripts/migrate-watcher-leads.mjs --limit 100
node scripts/migrate-watcher-leads.mjs --collection <name>
node scripts/migrate-watcher-leads.mjs --execute
node scripts/migrate-watcher-leads.mjs --resume <runId>
```

The default must be dry-run.

Running the script without an explicit `--execute` flag must not write production data.

Do not run `--execute` as part of this assignment unless separately instructed.

---

# 18. Migration mapping

Use explicit collection mappings after inspecting the source schema.

Example only:

```js
const COLLECTION_MAP = {
  businesses: "prospects",
  leads: "prospects",
  scrapedLeads: "prospects",
  searchJobs: "scrapeJobs"
};
```

Do not assume those are the actual source collection names.

Every migrated prospect must preserve source attribution:

```js
{
  source: {
    system: "watcher_leads",
    sourceProjectId: "watcher-leads-89349",
    sourceCollection,
    sourceDocumentId,
    importedAt
  }
}
```

Use deterministic destination IDs where practical:

```text
watcher_<sourceCollection>_<sourceDocumentId>
```

When the resulting ID is too long or unsafe, use a hash and preserve the original source fields in the document.

The migration must be idempotent.

Re-running it must update or skip the same record rather than creating another record.

---

# 19. Migration run tracking

Create:

```text
importRuns/{runId}
```

Suggested shape:

```js
{
  sourceSystem,
  sourceProjectId,
  mode,
  status,

  collections: [],
  startedBy,
  startedAt,
  completedAt,

  counts: {
    scanned,
    mapped,
    created,
    updated,
    skipped,
    duplicates,
    invalid,
    failed
  },

  cursor,
  version
}
```

Store detailed errors under:

```text
importRuns/{runId}/errors/{errorId}
```

Do not store thousands of errors inside one Firestore document.

Each imported prospect should contain its `importRunId`.

---

# 20. Source-record classification

Classify source records as:

```text
Cold prospect
Previously contacted prospect
Qualified opportunity
Existing customer
Internal test
Invalid record
Airbnb record
```

Migration behavior:

* Cold prospect → `prospects`.
* Previously contacted prospect → `prospects` plus imported activity.
* Qualified opportunity → `prospects`, with reviewed conversion available.
* Existing customer → review before importing into sales workflows.
* Internal test → skip unless explicitly requested.
* Invalid record → report and skip.
* Airbnb record → always skip.

Do not automatically add migrated records to active campaigns.

Migrated prospects must remain non-callable until:

* Normalization is complete.
* Deduplication is complete.
* Compliance status is checked.
* Required review is complete.
* A campaign explicitly selects them.

---

# 21. Normalization

Normalize before deduplication.

At minimum normalize:

* Company names.
* URLs.
* Domains.
* Emails.
* Phone numbers.
* US phone numbers to E.164.
* Address spacing.
* State abbreviations.
* ZIP or postal codes.
* Business categories.
* Empty strings.
* Placeholder values.
* timestamps.
* arrays.
* source URLs.

Do not destroy original values without retaining enough source context for auditing.

Put generic normalization in shared tested utilities.

Do not perform core normalization only inside React components.

---

# 22. Deduplication

Deduplicate against:

1. Other results in the same scrape job.
2. Existing `prospects`.
3. Existing `leads`.
4. Existing outbound targets.
5. Existing source mappings.
6. Previous imports.

Use strong identifiers first:

1. Exact normalized phone.
2. Exact normalized email.
3. Exact normalized domain.
4. Source-system ID.
5. Provider place or business ID.

Use fuzzy company-name and address matching only as a review signal.

Do not silently merge records based only on similar names.

Suggested duplicate fields:

```js
{
  duplicateStatus: "unique" | "possible" | "confirmed",
  duplicateOfType: "lead" | "prospect",
  duplicateOfId,
  matchReasons: [],
  matchConfidence,
  reviewedBy,
  reviewedAt
}
```

Possible duplicates must appear in Import Review.

---

# 23. Outbound campaign data model

Create:

```text
outboundCampaigns/{campaignId}
```

Suggested shape:

```js
{
  name,
  mode: "ai" | "power" | "parallel",
  provider: "gohighlevel" | "kixie" | "twilio" | "mock",
  status,
  concurrency,
  callerId,
  agentId,
  script,
  objective,
  timezonePolicy,
  allowedDays: [],
  localStartTime,
  localEndTime,
  maxAttempts,
  retryDelayMinutes,
  voicemailPolicy,
  requireResearchApproval,
  createdBy,
  createdAt,
  updatedAt,
  startedAt,
  pausedAt,
  completedAt,

  counts: {
    total,
    pending,
    ready,
    dialing,
    connected,
    completed,
    callLater,
    failed,
    doNotCall
  }
}
```

Campaign statuses:

```text
draft
researching
ready
running
paused
completed
cancelled
failed
```

---

# 24. Outbound target data model

Create:

```text
outboundTargets/{targetId}
```

A target may reference either an existing inbound lead or a cold prospect.

Suggested shape:

```js
{
  campaignId,

  contactType: "lead" | "prospect",
  leadId: null,
  prospectId: null,

  phoneE164,
  timezone,
  priority,
  state,

  researchStatus,
  researchApproved,

  complianceStatus,
  complianceReasons: [],

  attemptCount,
  maxAttempts,
  nextAttemptAt,
  lastAttemptAt,
  lastCallId,
  lastDisposition,

  providerContactId,

  lockedBySessionId,
  lockedAt,

  createdAt,
  updatedAt
}
```

Exactly one of `leadId` and `prospectId` must be populated.

Target states:

```text
pending
researching
awaiting_approval
ready
dialing
connected
completed
call_later
no_answer
voicemail
busy
failed
invalid_number
do_not_call
cancelled
```

Create shared server-side functions such as:

```js
loadContactForTarget()
updateContactAfterAttempt()
recordContactActivity()
promoteProspectToLead()
```

The calling implementation should not need separate duplicated logic for leads and prospects.

---

# 25. Dialer session data model

Create:

```text
dialerSessions/{sessionId}
```

Suggested shape:

```js
{
  campaignId,
  userUid,
  provider,
  mode: "power" | "parallel",
  concurrency,
  status,

  activeCallIds: [],
  connectedCallId,
  connectedTargetId,

  startedAt,
  connectedAt,
  endedAt,
  lastHeartbeatAt
}
```

Use session heartbeats and stale-lock cleanup.

A target locked by an abandoned session must eventually become eligible again.

---

# 26. Lead research data model

Create:

```text
leadResearch/{contactKey}
```

The contact key may refer to a lead or prospect but must be deterministic and validated.

Suggested shape:

```js
{
  contactType,
  leadId,
  prospectId,

  status,

  companyName,
  companyWebsite,

  summary,
  verifiedFacts: [],
  likelyNeeds: [],
  talkingPoints: [],
  suggestedOpening,
  likelyObjections: [],
  recentSignals: [],

  sources: [
    {
      title,
      url,
      fetchedAt,
      factIds: []
    }
  ],

  confidence,
  approved,
  approvedBy,
  approvedAt,

  generatedAt,
  expiresAt,
  model,
  error
}
```

Keep large research payloads out of the main lead or prospect document.

---

# 27. Lead enrichment pipeline

Research sources should be attempted in this order:

1. Existing Firestore lead or prospect data.
2. Previous activities and call history.
3. Existing GoHighLevel contact and opportunity information.
4. The company’s supplied website.
5. Approved search or business-data providers.

Potential providers may include:

* Google Places.
* Apollo.
* People Data Labs.
* Clay.
* Exa.
* Tavily.
* Another approved API.

Do not integrate an external provider without verifying its current API and terms.

Requirements:

* Never invent facts.
* Every externally discovered fact must include a source.
* Separate verified facts from AI hypotheses.
* Cache results.
* Set an expiration time.
* Allow admin editing and approval.
* Give the calling agent only an approved structured brief.
* Avoid irrelevant personal information.
* Do not collect sensitive protected data.
* Do not scrape sites that prohibit the behavior.
* Fail gracefully.
* Allow calling without research when campaign settings permit it.

---

# 28. Provider-neutral calling architecture

Do not place vendor-specific logic throughout the application.

Recommended server structure:

```text
functions/
  outbound-calls.js
  lead-enrichment.js

  providers/
    calling/
      index.js
      gohighlevel.js
      kixie.js
      twilio.js
      mock-dialer.js
```

Expose provider-neutral operations such as:

```js
startAICall()
startPowerDialSession()
startParallelDialSession()
cancelCallLeg()
endCall()
getCallStatus()
normalizeWebhookEvent()
```

The rest of the application must not depend on raw Kixie, GoHighLevel, or Twilio response shapes.

Always implement a mock dialer for development and tests.

---

# 29. Provider evaluation

Kixie is a candidate for human power and parallel dialing.

Before implementing the production Kixie adapter, verify from current official documentation that the selected Kixie account and API support:

* Programmatically initiating calls.
* Starting calls from a custom dashboard.
* Parallel call sessions.
* Configurable concurrency from one through five.
* Individual call-leg IDs.
* Dialing, ringing, answered, voicemail, busy, failed, and canceled events.
* Identifying the first human answer.
* Canceling remaining active calls.
* Browser or softphone audio bridging.
* Authenticated or signed webhooks.
* Call recordings and dispositions.
* GoHighLevel synchronization.

Do not fake unsupported capabilities.

If Kixie does not expose enough control:

1. Complete the provider-neutral architecture.
2. Implement the mock provider.
3. Document the missing Kixie capabilities.
4. Recommend the closest viable alternative.
5. Consider Twilio Programmable Voice or Flex for a fully custom embedded dialer.
6. Consider Orum or Nooks when a hosted parallel-dialer product is acceptable.
7. Consider PhoneBurner or JustCall when power dialing is more important than custom parallel dialing.

Do not claim Kixie supports a capability until it has been verified.

---

# 30. Existing GoHighLevel integration

The existing BiteSites code already has:

* GoHighLevel lead synchronization.
* A GoHighLevel Voice AI widget bridge.
* Completed-call webhooks.
* Scheduled call-log imports.
* Transcript storage.
* Call-to-lead linking.
* Provider call ID deduplication.

Do not rewrite or break this infrastructure.

The existing browser voice widget is primarily an inbound or visitor-initiated voice experience.

Keep it separate from the new outbound campaign implementation.

Verify whether the current GoHighLevel account supports outbound Voice AI through:

* An official API.
* A workflow action.
* A campaign trigger.
* Another documented mechanism.

Do not assume the existing call-log endpoint can initiate calls.

If outbound calls must be triggered through a GoHighLevel workflow:

1. Create or update the GHL contact.
2. Pass the approved lead brief.
3. Pass campaign ID.
4. Pass target ID.
5. Pass lead or prospect ID.
6. Pass script and objective metadata.
7. Trigger the supported workflow mechanism.
8. Require completion events to return campaign and target metadata.

---

# 31. AI outbound call flow

The AI outbound call flow must be controlled server-side.

Expected sequence:

1. Lock one eligible target.
2. Verify compliance.
3. Verify local calling time.
4. Load or generate lead research.
5. Require approval when configured.
6. Create or update the provider contact.
7. Send the approved research, campaign script, objective, and metadata.
8. Start the outbound call.
9. Store the provider call ID.
10. Set the target to `dialing`.
11. Receive authenticated provider events.
12. Store transcript, recording, summary, and disposition.
13. Update the existing lead or prospect.
14. Add an activity record.
15. Schedule retry, Call Later, completion, qualification, or Do Not Call status.
16. Promote a prospect to a lead only under the defined conversion rules.

The AI calling prompt must include:

* AI identity.
* BiteSites identity.
* Reason for the call.
* Approved lead research.
* Campaign objective.
* Script boundaries.
* Required AI disclosure.
* Required recording or transcription disclosure.
* Instructions to honor opt-outs immediately.
* Instructions not to invent facts.
* Instructions not to pretend to be human.
* Booking rules.
* Follow-up rules.
* Escalation rules.

---

# 32. Human power dialer

Power-dialer behavior:

1. Lock the next eligible target.
2. Display the target’s approved research.
3. Start exactly one call.
4. Show live call status.
5. Wait until the call ends.
6. Require or capture a disposition.
7. Update the target and contact history.
8. Move to the next target only after the current one is resolved.
9. Prevent two users from calling the same target simultaneously.
10. Recover abandoned locks safely.

The Live Dialer must show:

* Contact name.
* Company.
* Contact details.
* Research summary.
* Suggested opening.
* Talking points.
* Likely objections.
* Existing history.
* Call status.
* Duration.
* Notes.
* Mute where supported.
* Hang up.
* Skip.
* Disposition controls.
* Call Later.
* Do Not Call.

---

# 33. Human parallel dialer

Parallel dialing must support concurrency from one through five.

Use a server-authoritative state machine.

Expected behavior:

1. Lock up to the selected number of eligible targets.
2. Create a separate call record for each target.
3. Start a separate provider call leg for each target.
4. Add all call IDs to the dialer session.
5. Process each provider event independently.
6. Detect the first verified human answer.
7. Atomically assign the winning call through a Firestore transaction.
8. Bridge the representative to the winning call.
9. Cancel all other dialing or ringing calls.
10. Mark non-winning calls as canceled because another call connected.
11. Return eligible non-winning targets to Call Later.
12. Set a safe `nextAttemptAt`.
13. Do not requeue invalid, opted-out, or attempt-exhausted targets.
14. Handle simultaneous answers.
15. Handle webhook redelivery idempotently.
16. Never connect two prospects to one representative.

The first-answer transaction should atomically set:

```js
{
  connectedCallId,
  connectedTargetId,
  connectedAt
}
```

Only a transaction that finds no existing `connectedCallId` may win.

Non-winning call records should receive:

```js
{
  status: "cancelled",
  cancellationReason: "another_call_connected"
}
```

Do not implement parallel dialing with:

* Multiple `tel:` links.
* Browser loops.
* Several uncontrolled client-side calls.
* Client-side-only winner selection.

---

# 34. Existing call-history integration

Do not create a separate unrelated call-history system.

Extend the existing:

```text
calls/{callId}
calls/{callId}/turns/{turnId}
```

Add optional fields:

```js
{
  direction: "inbound" | "outbound",
  operator: "ai" | "human",
  dialerMode: "ai" | "power" | "parallel",

  campaignId,
  targetId,
  leadId,
  prospectId,
  sessionId,

  provider,
  providerCallId,
  providerContactId,

  status,
  disposition,
  attemptNumber,

  startedAt,
  ringingAt,
  answeredAt,
  connectedAt,
  endedAt,
  durationSec,

  summary,
  recordingUrl,
  transcriptRecorded,
  cancellationReason
}
```

Continue storing transcripts under:

```text
calls/{callId}/turns/{turnId}
```

Update `Conversations.jsx` so administrators can filter voice calls by:

```text
Inbound
Outbound
All
```

Do not break the existing Bit and Byte conversation views.

Older calls without a `direction` field must continue rendering correctly.

---

# 35. Existing GoHighLevel webhook and importer changes

Extend the existing completed-call webhook and scheduled importer carefully.

Requirements:

* Preserve inbound behavior.
* Preserve existing idempotency.
* Preserve transcript import.
* Preserve provider-call matching.
* Add `direction: "inbound"` to newly imported inbound calls where known.
* Link outbound calls to existing campaign and target records.
* Link outbound calls to the existing lead or prospect.
* Do not create a new `byte_voice` lead when an outbound target already identifies the contact.
* Match outbound calls through deterministic metadata whenever possible.
* Use provider call ID, campaign ID, target ID, contact ID, or explicit custom metadata.
* Do not rely only on timestamp proximity for outbound campaigns.
* Continue supporting older call records.

---

# 36. Campaign interface requirements

Administrators must be able to configure:

* Campaign name.
* Calling mode.
* Calling provider.
* Caller ID.
* Lead or prospect list.
* AI agent.
* Script.
* Objective.
* Concurrency from one through five.
* Maximum attempts.
* Retry delay.
* Calling days.
* Calling time window.
* Timezone behavior.
* Voicemail behavior.
* Booking objective.
* Research-approval requirement.
* Compliance configuration.
* Emergency pause.

Campaign screens must support:

* Create.
* Edit.
* Duplicate.
* Start.
* Pause.
* Resume.
* Cancel.
* View metrics.
* View queue.
* View failure state.
* View provider status.

---

# 37. Queue interface

Display:

* Contact.
* Contact type.
* Company.
* Phone.
* Local time.
* Research status.
* Compliance status.
* Attempt count.
* Last outcome.
* Next attempt.
* Priority.
* Campaign.
* Lock status.
* Actions.

Provide filters for:

* Campaign.
* Status.
* Provider.
* Lead versus prospect.
* Research status.
* Compliance status.
* Priority.
* Call Later.

---

# 38. Call Later interface

Display:

* Contact.
* Company.
* Requeue reason.
* Original attempt time.
* Next attempt time.
* Number of attempts.
* Last disposition.
* Campaign.
* Manual Call Now.
* Reschedule.
* Remove from campaign.
* Mark Do Not Call.

---

# 39. CSV import

Support fields such as:

```text
name
firstName
lastName
email
phone
company
website
timezone
notes
priority
```

Requirements:

* Preview before import.
* Normalize phone numbers.
* Convert supported phone numbers to E.164.
* Validate required fields.
* Flag invalid phone numbers.
* Deduplicate within the file.
* Deduplicate against existing prospects.
* Deduplicate against existing leads.
* Deduplicate against campaign targets.
* Match existing contacts by phone or email.
* Create prospects when no contact exists.
* Report imported, matched, skipped, invalid, and duplicate counts.
* Do not upload raw CSV files to a public location.
* Preserve source attribution.

---

# 40. Compliance and safety controls

Implement technical guardrails.

Each target must have a compliance result:

```js
{
  eligible,
  reasons: [],
  checkedAt,
  consentBasis,
  doNotCall,
  localTimeAllowed,
  recordingDisclosureRequired,
  aiDisclosureRequired
}
```

At minimum support:

* Internal Do Not Call.
* Campaign suppression lists.
* Invalid-number suppression.
* Lead timezone.
* Local calling hours.
* Maximum attempts.
* Minimum retry delay.
* Immediate opt-out.
* Caller-ID validation.
* Recording disclosure settings.
* Transcription disclosure settings.
* AI disclosure settings.
* Audit trail.
* Emergency pause or kill switch.

Do not claim that these controls guarantee legal compliance.

Document that legal counsel must approve:

* Consent basis.
* Jurisdictions.
* Calling hours.
* Recording rules.
* AI disclosure.
* Scripts.
* Opt-out behavior.
* Automated dialing behavior.
* Telemarketing requirements.

---

# 41. Callable functions and webhooks

Implement appropriately named server functions such as:

```text
createOutboundCampaign
updateOutboundCampaign
importOutboundTargets
createLeadDiscoveryJob
pauseLeadDiscoveryJob
cancelLeadDiscoveryJob
researchOutboundContact
approveLeadResearch
startOutboundCampaign
pauseOutboundCampaign
resumeOutboundCampaign
cancelOutboundCampaign
startPowerDialerSession
startParallelDialerSession
stopDialerSession
submitCallDisposition
moveTargetToCallLater
markTargetDoNotCall
promoteProspectToLead
recordOutboundCallEvent
```

Use:

* Callable functions for authenticated admin actions.
* HTTP functions for provider webhooks.
* Scheduled functions for retries, reconciliation, and stale-lock cleanup.
* Cloud Run or local workers for long-running scraping when necessary.

Callable requirements:

* Require authentication.
* Require effective admin role.
* Validate all input.
* Enforce App Check where compatible.
* Return small normalized objects.
* Never return secrets.

Webhook requirements:

* Validate a provider signature or secret.
* Reject unsupported methods.
* Fail closed when secrets are missing.
* Use deterministic event IDs.
* Make redelivery idempotent.
* Avoid logging full sensitive payloads.
* Return retryable errors only when retries are useful.

Add Firebase Hosting rewrites only when stable BiteSites webhook URLs are required.

---

# 42. Firestore security rules

Update:

```text
firestore.rules
scripts/test-rules.mjs
```

Rules must ensure:

* Only admins can read or manage prospects.
* Only admins can read or manage campaigns.
* Only admins can read outbound targets.
* Only admins can manage dialer sessions.
* Only admins can access lead research.
* Only admins can access scrape jobs.
* Only admins can access raw scrape results.
* Only admins can access import runs and errors.
* Anonymous visitors cannot create prospects.
* Anonymous visitors cannot mark themselves as outbound leads.
* Prospect activities are append-only through permitted paths.
* Audit events cannot be rewritten by the browser.
* Sensitive provider writes occur through the Admin SDK.
* Existing public lead-form behavior remains unchanged.
* Existing Bit behavior remains unchanged.
* Existing client-portal behavior remains unchanged.
* Existing role behavior remains unchanged.

Do not weaken public `leads` validation to accommodate imported prospects.

Server-side imports should use the Admin SDK.

---

# 43. Firestore indexes

Update:

```text
firestore.indexes.json
```

Add only indexes required by actual queries.

Likely indexes include:

```text
prospects:
  lifecycle.status + createdAt
  source.system + createdAt
  dedupe.phoneHash + createdAt
  dedupe.emailHash + createdAt
  dedupe.normalizedWebsite + createdAt
  lifecycle.nextActionAt + lifecycle.status
  contactability.complianceStatus + lifecycle.status

scrapeJobs:
  status + createdAt
  provider + status + createdAt

outboundCampaigns:
  status + createdAt

outboundTargets:
  campaignId + state + priority + nextAttemptAt
  campaignId + nextAttemptAt
  campaignId + contactType + state + priority + nextAttemptAt

dialerSessions:
  userUid + status + startedAt

calls:
  campaignId + startedAt
  direction + startedAt

importRuns:
  sourceProjectId + startedAt
  status + startedAt
```

Review query code before finalizing indexes.

---

# 44. Secrets and configuration

Reuse existing server-side GoHighLevel configuration where appropriate.

Potential new secrets may include:

```text
GHL_OUTBOUND_WORKFLOW_URL
GHL_OUTBOUND_AGENT_ID

KIXIE_API_KEY
KIXIE_WEBHOOK_SECRET
KIXIE_TEAM_ID

TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_API_KEY
TWILIO_API_SECRET
TWILIO_TWIML_APP_SID

OUTBOUND_WEBHOOK_SECRET
ENRICHMENT_API_KEY
LEAD_SOURCE_API_KEY
```

Exact names should follow confirmed provider requirements.

Use server-side secret management.

Do not create:

```text
VITE_KIXIE_API_KEY
VITE_GHL_API_TOKEN
VITE_TWILIO_AUTH_TOKEN
VITE_ENRICHMENT_API_KEY
```

Never store secrets in:

* Firestore.
* client JavaScript.
* committed `.env` files.
* committed service-account files.
* source workflow exports.

Create a sanitized `.env.example` containing variable names only.

If a committed secret is discovered:

1. Do not copy it.
2. Do not print it.
3. Flag it.
4. Recommend rotation.
5. Remove its use from the migrated implementation.

---

# 45. Testing

Create tests for:

## Lead discovery and migration

* Source normalization.
* Phone normalization.
* URL normalization.
* Deterministic source IDs.
* Same-job duplicates.
* Existing-prospect duplicates.
* Existing-lead duplicates.
* Fuzzy duplicate review.
* Dry-run migration.
* Idempotent re-import.
* Resume after interruption.
* Invalid records.
* Missing fields.
* Timestamp conversion.
* Airbnb record exclusion.
* Airbnb workflow exclusion.
* Secret removal.
* Mock lead-source execution.
* Stale worker recovery.

## Prospect management

* Admin-only access.
* Public denial.
* Prospect creation through server paths.
* Prospect activities.
* Prospect-to-lead conversion.
* Existing-lead linking.
* Duplicate-lead prevention.
* Preservation of source attribution.

## Outbound calling

* Campaign creation.
* Campaign validation.
* Target import.
* Lead and prospect target support.
* Target locking.
* Stale-lock recovery.
* Research caching.
* Research approval.
* Compliance rejection.
* Local-time rejection.
* Maximum-attempt rejection.
* Power-dial progression.
* Parallel dialing with one through five targets.
* First-answer-wins transaction.
* Simultaneous answers.
* Canceling non-winning legs.
* Returning eligible targets to Call Later.
* Do Not Call.
* Provider failure.
* Missing credentials.
* Webhook signature rejection.
* Webhook redelivery.
* Outbound call linking.
* No duplicate `byte_voice` lead.
* Existing inbound calls continuing to work.

Suggested files:

```text
functions/prospect-normalization.test.mjs
functions/prospect-deduplication.test.mjs
functions/lead-discovery.test.mjs
functions/prospect-conversion.test.mjs

functions/outbound-calls.test.mjs
functions/outbound-webhook.test.mjs
functions/lead-enrichment.test.mjs

scripts/migrate-watcher-leads.test.mjs
```

Use mocks in automated tests.

No automated test may:

* Place a real telephone call.
* Scrape a live provider unnecessarily.
* Modify source production data.
* Modify destination production data.
* Execute Airbnb functionality.

Add useful package scripts such as:

```json
{
  "test:discovery": "...",
  "test:prospects": "...",
  "test:migration": "...",
  "test:outbound": "...",
  "test:outbound-webhook": "...",
  "test:enrichment": "..."
}
```

Run at minimum:

```bash
npm run build
npm run test:rules
npm run test:voice
npm run test:import
npm run test:lifecycle
npm run test:discovery
npm run test:prospects
npm run test:migration
npm run test:outbound
```

---

# 46. Frontend routing changes

Modify:

```text
src/admin/AdminApp.jsx
```

Add:

* An `Outbound Calls` sidebar item.
* An import for the new page.
* A route for `/admin/outbound`.

Create:

```text
src/admin/OutboundCalls.jsx
src/admin/outbound/*
```

Import `outbound.css` only through the outbound admin feature.

Scope selectors under:

```css
.bs-admin .outbound-...
```

Ensure:

* Responsive behavior.
* Accessible controls.
* Keyboard navigation.
* Loading states.
* Empty states.
* Provider error states.
* Permission-denied states.
* Stale-data warnings.
* Clear live-call indicators.

---

# 47. Documentation

Update `FIREBASE_SETUP.md` and add appropriate documents such as:

```text
LEAD_DISCOVERY_SETUP.md
WATCHER_MIGRATION.md
OUTBOUND_CALLING_SETUP.md
```

Document:

* Existing architecture.
* Reused source functionality.
* Rewritten functionality.
* Excluded functionality.
* Airbnb boundary.
* Source Firebase project.
* Destination Firebase project.
* IAM requirements.
* Migration commands.
* Dry-run behavior.
* Deduplication.
* Prospect-to-lead conversion.
* Local worker setup.
* Cloud Run setup.
* Provider setup.
* GoHighLevel workflow setup.
* Webhook setup.
* Secret setup.
* Test commands.
* Deployment order.
* Emergency pause.
* Disabling lead discovery.
* Disabling outbound calling.
* Removing or archiving an import batch.
* Verifying migration counts.
* Compliance-review checklist.

---

# 48. Migration safety

Before any production migration, support:

1. Source schema inspection.
2. Destination collision report.
3. Dry-run counts.
4. Transformed sample preview.
5. Airbnb exclusion count.
6. Invalid-record count.
7. Duplicate count.
8. Source backup or export strategy.
9. Migration run ID.
10. Resume support.
11. Rollback or batch-archive strategy.

Do not execute production migration automatically.

Creating and testing the migration tool is part of the assignment.

Production execution requires separate explicit approval.

---

# 49. Deployment order

Recommended order:

```text
1. Inspect all source systems.
2. Produce the capability inventory.
3. Implement and test provider-neutral modules.
4. Deploy Cloud Functions or Cloud Run workers.
5. Deploy Firestore indexes.
6. Deploy Firestore rules.
7. Configure provider webhooks.
8. Test with mock providers.
9. Run migration dry-run.
10. Review migration results.
11. Run one explicitly approved live test call.
12. Deploy hosting.
13. Execute production migration only after separate approval.
```

Do not deploy Firestore rules that depend on undeployed functions when doing so would break existing admin functionality.

---

# 50. Acceptance criteria

The combined feature is complete only when:

1. The local `BiteSites-Leads` checkout was inspected.
2. The local `watcherworkflows` folder was inspected.
3. The source Firebase schema was inspected.
4. A capability inventory was produced.
5. No Airbnb functionality was migrated.
6. Lead Discovery appears in the BiteSites admin dashboard.
7. Prospect management appears in the BiteSites admin dashboard.
8. The UI uses BiteSites branding.
9. Scraped businesses are stored as prospects.
10. Existing inbound leads remain separate.
11. Existing source data has a documented migration mapping.
12. Migration defaults to dry-run.
13. Migration is idempotent.
14. Migration supports resume.
15. Source attribution is preserved.
16. Prospects are normalized.
17. Prospects are deduplicated.
18. Fuzzy matches require review.
19. Prospects can be added to campaigns.
20. Targets support both leads and prospects.
21. Prospects can be promoted without duplicate leads.
22. Existing inbound analytics remain accurate.
23. Administrators can create and manage campaigns.
24. AI calls receive approved sourced research.
25. Power dialing works through the provider-neutral architecture.
26. Parallel sessions support one through five calls.
27. The first human answer wins atomically.
28. Remaining legs are canceled.
29. Eligible non-winning targets return to Call Later.
30. Calls use the existing `calls` collection.
31. Transcripts use `calls/{id}/turns`.
32. Existing inbound Byte calls continue working.
33. Existing Bit conversations continue working.
34. Existing forms continue working.
35. Existing email features continue working.
36. Provider credentials never enter the browser.
37. Firestore rules deny public access to outbound data.
38. Webhooks reject invalid authentication.
39. Webhook redelivery is idempotent.
40. Mock-provider tests pass.
41. Migration tests pass.
42. Existing tests continue to pass.
43. No automated test placed a live call.
44. No production data migration occurred without approval.
45. The final report clearly identifies anything not verified.

---

# 51. Final implementation report

After implementation, report:

1. Local source paths inspected.
2. Branch or commit inspected for each repository.
3. Capability inventory.
4. Source Firebase collections discovered.
5. Approximate source counts.
6. Files reused conceptually.
7. Files copied or adapted.
8. Files deliberately excluded.
9. Airbnb files and workflows excluded.
10. New BiteSites files.
11. Modified BiteSites files.
12. New Firestore collections.
13. New Firestore indexes.
14. New Firestore rules.
15. New Cloud Functions.
16. New Cloud Run or local-worker components.
17. Provider capabilities confirmed.
18. Provider limitations discovered.
19. Migration field mappings.
20. Migration dry-run results.
21. Duplicate statistics.
22. Invalid-record statistics.
23. Airbnb exclusion statistics.
24. Required secrets.
25. Required IAM configuration.
26. Manual GoHighLevel setup.
27. Manual dialer-provider setup.
28. Compliance items requiring legal review.
29. Tests executed.
30. Test results.
31. Whether any live call occurred.
32. Whether any production write occurred.
33. Anything incomplete or unverifiable.

Do not claim production readiness when any of the following remain incomplete:

* Provider credentials.
* Live provider webhooks.
* GoHighLevel workflow setup.
* Legal and compliance approval.
* A controlled live test call.
* Production migration approval.
* Source-system inspection.
