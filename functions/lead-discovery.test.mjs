// Discovery and import, against the Firestore emulator:  npm run test:discovery
//
// It lives beside the modules rather than in scripts/ so `firebase-admin`
// resolves to the same copy the functions use — two instances would not share
// the initialised app. `*.test.mjs` is excluded from the deploy in firebase.json.
//
// Nothing here touches a network, a provider or a real project. The mock source
// is deterministic, so a re-run produces the same ids, which is exactly what
// the idempotency assertions need.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const { getLeadSource, validateCriteria, describeLeadSources } = await import('./providers/lead-sources/index.js');
const {
  createDiscoveryJob, runDiscoverySlice, claimJobForWorker, heartbeatJob,
  submitDiscoveryResults, finishJob, recoverStaleJobs, sanitizeCriteria,
  WORKER_HEARTBEAT_TTL_MS
} = await import('./lead-discovery.js');
const { importProspects, prospectDocumentId, resolveDuplicate } = await import('./prospect-import.js');
const { buildProspect } = await import('./prospect-normalization.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const wipe = async name => {
  const snapshot = await db.collection(name).limit(500).get();
  for (const entry of snapshot.docs) {
    const subs = await entry.ref.listCollections();
    for (const sub of subs) {
      const kids = await sub.limit(500).get();
      for (const kid of kids.docs) await kid.ref.delete();
    }
    await entry.ref.delete();
  }
};

await wipe('prospects');
await wipe('scrapeJobs');
await wipe('leads');
await wipe('importRuns');

// ---------------------------------------------------------------------------
console.log('\ncriteria validation');

check('rejects a job with no keywords and no category',
  validateCriteria({ location: 'NJ', maximumResults: 10 }).valid === false);
check('rejects a job with no location',
  validateCriteria({ keywords: ['plumber'], maximumResults: 10 }).valid === false);
check('rejects an unbounded result count',
  validateCriteria({ keywords: ['plumber'], location: 'NJ', maximumResults: 99999 }).valid === false);
check('accepts a well-formed job',
  validateCriteria({ keywords: ['plumber'], location: 'NJ', maximumResults: 50 }).valid === true);
check('sanitizes and caps criteria',
  sanitizeCriteria({ keywords: Array(30).fill('x'), location: 'NJ', maximumResults: 99999, radiusMiles: 500 }).maximumResults === 1000);

// ---------------------------------------------------------------------------
console.log('\nlead-source registry');

const described = describeLeadSources();
check('every source reports an execution mode', described.every(entry => entry.executionMode));
check('no source description leaks a credential value',
  JSON.stringify(described).match(/[A-Za-z0-9]{32,}/) === null);
check('the migrated sources cannot start a job',
  getLeadSource('watcher_workflow').supports({}) === false
  && getLeadSource('bitesites_leads').supports({}) === false);

let missingPlacesKeyRejected = false;
try {
  await createDiscoveryJob(db, {
    provider: 'google_places',
    criteria: { keywords: ['plumber'], location: 'Ridgewood, NJ', maximumResults: 1 },
    createdBy: 'test@bitesites.org'
  });
} catch { missingPlacesKeyRejected = true; }
check('Google Places jobs fail before queueing when the secret is absent', missingPlacesKeyRejected);

const configuredPlacesJob = await createDiscoveryJob(db, {
  provider: 'google_places',
  criteria: { keywords: ['plumber'], location: 'Ridgewood, NJ', maximumResults: 1 },
  createdBy: 'test@bitesites.org',
  sourceOptions: { apiKey: 'test-key-is-never-used' }
});
check('Google Places validation receives its server-side secret',
  (await db.doc(`scrapeJobs/${configuredPlacesJob}`).get()).get('status') === 'queued');
await db.doc(`scrapeJobs/${configuredPlacesJob}`).delete();

let refusedAirbnb = false;
try {
  getLeadSource('watcher_workflow').normalize({ name: 'A Listing', source: 'airbnb', host_name: 'Dana' });
} catch { refusedAirbnb = true; }
check('the Watcher adapter refuses to normalise an Airbnb record', refusedAirbnb);

// ---------------------------------------------------------------------------
console.log('\na mock discovery job end to end');

const jobId = await createDiscoveryJob(db, {
  provider: 'mock',
  criteria: { keywords: ['plumber'], location: 'Bergen County, NJ', maximumResults: 20 },
  createdBy: 'test@bitesites.org'
});
const created = await db.doc(`scrapeJobs/${jobId}`).get();
check('a new job starts queued, not running', created.get('status') === 'queued');
check('a new job has zeroed progress', created.get('progress').discovered === 0);

const run = await runDiscoverySlice(db, jobId);
check('the job completes', run.status === 'completed', run.status);
check('it discovered the requested number', run.progress.discovered === 20, String(run.progress.discovered));
check('it imported something', run.progress.imported > 0, String(run.progress.imported));
check('it caught the deliberate in-batch duplicates', run.progress.duplicates > 0, String(run.progress.duplicates));

const prospects = await db.collection('prospects').get();
check('prospects were written', prospects.size > 0, String(prospects.size));
check('every prospect carries its discovery job',
  prospects.docs.every(entry => entry.get('source').searchJobId === jobId));
check('no prospect arrives callable-by-default',
  prospects.docs.every(entry => ['ready', 'needs_review'].includes(entry.get('lifecycle').status)));
check('prospects have a normalised E.164 phone',
  prospects.docs.every(entry => /^\+1\d{10}$/.test(entry.get('phoneE164'))));

const rawResults = await db.collection(`scrapeJobs/${jobId}/results`).get();
check('raw provider payloads are stored for audit', rawResults.size === 20, String(rawResults.size));
check('raw payloads carry an expiry', rawResults.docs.every(entry => entry.get('expiresAt')));

// ---------------------------------------------------------------------------
console.log('\nre-running the same job is idempotent');

const before = (await db.collection('prospects').get()).size;
const secondJob = await createDiscoveryJob(db, {
  provider: 'mock',
  criteria: { keywords: ['plumber'], location: 'Bergen County, NJ', maximumResults: 20 },
  createdBy: 'test@bitesites.org'
});
const secondRun = await runDiscoverySlice(db, secondJob);
const after = (await db.collection('prospects').get()).size;
check('a repeat run creates no new prospects', after === before, `${before} → ${after}`);
check('a repeat run reports them as updates or duplicates',
  secondRun.progress.imported + secondRun.progress.duplicates > 0);

// ---------------------------------------------------------------------------
console.log('\nresume after interruption');

const resumeJob = await createDiscoveryJob(db, {
  provider: 'mock',
  criteria: { keywords: ['roofer'], location: 'Bergen County, NJ', maximumResults: 60 },
  createdBy: 'test@bitesites.org'
});
// A budget of 0ms stops after the first page, which is exactly the shape of a
// function that timed out mid-job.
const partial = await runDiscoverySlice(db, resumeJob, { budgetMs: 0 });
check('an interrupted job stays running', partial.status === 'running', partial.status);
const cursor = (await db.doc(`scrapeJobs/${resumeJob}`).get()).get('execution').cursor;
check('an interrupted job persisted its cursor', Boolean(cursor?.offset), JSON.stringify(cursor));

const resumed = await runDiscoverySlice(db, resumeJob);
check('it resumes and completes', resumed.status === 'completed', resumed.status);
check('it did not re-walk the first page', resumed.progress.discovered === 60, String(resumed.progress.discovered));

// ---------------------------------------------------------------------------
console.log('\ndeduplication against existing leads');

await db.doc('leads/existing-lead-1').set({
  name: 'Existing Customer', email: 'known@business.example.com',
  phoneE164: '+12015559999', source: 'intake_form', status: 'new'
});

const againstLead = await importProspects(db, [
  { name: 'Known Business', phone: '2015559999', email: 'known@business.example.com' }
], { source: { system: 'csv', provider: 'csv' } });
check('a prospect matching an inbound lead is not created',
  againstLead.counts.duplicates === 1 && againstLead.counts.created === 0,
  JSON.stringify(againstLead.counts));

// ---------------------------------------------------------------------------
console.log('\nfuzzy matches go to review, they never merge');

await importProspects(db, [
  { name: 'Bergen Bagels', phone: '2015551111', address: 'Ridgewood, NJ' }
], { source: { system: 'csv', provider: 'csv' } });

const fuzzy = await importProspects(db, [
  { name: 'BERGEN BAGELS INC', phone: '2015552222', address: 'Ridgewood, NJ' }
], { source: { system: 'csv', provider: 'csv' } });
check('a same-name/same-town record is still created', fuzzy.counts.created === 1, JSON.stringify(fuzzy.counts));

const flagged = await db.collection('prospects').where('duplicate.status', '==', 'possible').get();
check('and it lands in Import Review', flagged.size >= 1, String(flagged.size));
check('a possible duplicate is not callable',
  flagged.docs.every(entry => entry.get('lifecycle').status === 'needs_review'));

const reviewId = flagged.docs[0].id;
await resolveDuplicate(db, reviewId, { action: 'keep', reviewedBy: 'admin@bitesites.org' });
const resolved = await db.doc(`prospects/${reviewId}`).get();
check('keeping it makes it callable', resolved.get('lifecycle').status === 'ready');
check('and records who decided', resolved.get('duplicate').reviewedBy === 'admin@bitesites.org');

// ---------------------------------------------------------------------------
console.log('\ninvalid and Airbnb records');

const mixed = await importProspects(db, [
  { name: 'No Contact Details Co' },                                  // not contactable
  { name: 'Airbnb Host', phone: '2015553333', source: 'airbnb' },     // excluded
  { name: 'Real Business', phone: '2015554444' }
], {
  source: { system: 'watcher_leads', provider: 'watcher_workflow' },
  classify: record => (record.source === 'airbnb' ? 'airbnb_record' : 'cold_prospect')
});
check('an uncontactable record is counted invalid', mixed.counts.invalid === 1, JSON.stringify(mixed.counts));
check('an Airbnb record is excluded and counted', mixed.counts.airbnbExcluded === 1);
check('the real business is imported', mixed.counts.created === 1);

const airbnbLeaked = await db.collection('prospects').where('name', '==', 'Airbnb Host').get();
check('no Airbnb record reached the prospects collection', airbnbLeaked.empty);

// ---------------------------------------------------------------------------
console.log('\ndry run writes nothing');

const countBeforeDry = (await db.collection('prospects').get()).size;
const dry = await importProspects(db, [
  { name: 'Dry Run Only', phone: '2015558888' }
], { source: { system: 'csv', provider: 'csv' }, dryRun: true });
const countAfterDry = (await db.collection('prospects').get()).size;
check('a dry run reports what it would create', dry.counts.created === 1);
check('a dry run writes nothing', countBeforeDry === countAfterDry, `${countBeforeDry} → ${countAfterDry}`);

// ---------------------------------------------------------------------------
console.log('\nthe local-worker protocol');

const workerJob = await createDiscoveryJob(db, {
  provider: 'watcher_workflow',
  criteria: { keywords: ['x'], location: 'NJ', maximumResults: 5 },
  createdBy: 'test',
  executionMode: 'local_runner'
});
check('a local-runner job waits for a worker',
  (await db.doc(`scrapeJobs/${workerJob}`).get()).get('status') === 'awaiting_local_worker');

const claim = await claimJobForWorker(db, 'worker-a');
check('a worker can claim it', claim?.id === workerJob, JSON.stringify(claim));

const second = await claimJobForWorker(db, 'worker-b');
check('a second worker cannot steal a live claim', second === null);

await heartbeatJob(db, workerJob, 'worker-a', { progress: { discovered: 2 } });
check('a heartbeat updates progress',
  (await db.doc(`scrapeJobs/${workerJob}`).get()).get('progress').discovered === 2);

let rejectedWrongWorker = false;
try { await submitDiscoveryResults(db, workerJob, 'worker-b', [{ name: 'X', phone: '2015550000' }]); }
catch { rejectedWrongWorker = true; }
check('a worker cannot submit to a job it does not hold', rejectedWrongWorker);

const submitted = await submitDiscoveryResults(db, workerJob, 'worker-a', [
  { name: 'Worker Found Co', phone: '2015557777', website: 'workerfound.example.com' }
]);
check('a worker submission is normalised and imported',
  submitted.counts.created === 1, JSON.stringify(submitted.counts));

const workerProspect = await db.collection('prospects').where('name', '==', 'Worker Found Co').get();
check('the worker record was normalised server-side, not trusted as-is',
  workerProspect.docs[0]?.get('phoneE164') === '+12015557777');

// Backdate the heartbeat past its TTL — the shape of a worker that died.
await db.doc(`scrapeJobs/${workerJob}`).set({
  execution: {
    ...(await db.doc(`scrapeJobs/${workerJob}`).get()).get('execution'),
    lastHeartbeatAt: new Date(Date.now() - WORKER_HEARTBEAT_TTL_MS - 60_000)
  },
  status: 'processing'
}, { merge: true });

const recovered = await recoverStaleJobs(db);
check('a dead worker’s job returns to the queue', recovered === 1, String(recovered));
check('and it is claimable again',
  (await db.doc(`scrapeJobs/${workerJob}`).get()).get('status') === 'awaiting_local_worker');

await finishJob(db, workerJob, '', { status: 'completed' });
check('a job can be closed out', (await db.doc(`scrapeJobs/${workerJob}`).get()).get('status') === 'completed');

// ---------------------------------------------------------------------------
console.log('\ndeterministic destination ids');

const a = prospectDocumentId(buildProspect({ name: 'A', phone: '2015550142' }, {
  source: { sourceCollection: 'smb_leads', sourceDocumentId: 'doc-1' }
}));
const b = prospectDocumentId(buildProspect({ name: 'A changed', phone: '2015559999' }, {
  source: { sourceCollection: 'smb_leads', sourceDocumentId: 'doc-1' }
}));
check('the same source document always maps to the same id', a === b && a === 'watcher_smb_leads_doc-1', a);

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('\nFailed:');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
  process.exit(1);
}
