// Drives importVoiceHistory against the Firestore emulator:  npm run test:import
//
// This one talks to the REAL GoHighLevel API — read-only — and writes into the
// emulator, so it verifies the whole pipeline against live data shapes without
// touching production. It needs ~/.ghl-token; it skips itself if that is absent.
//
// The properties worth pinning are the ones that only show up against real data:
// a repeat caller collapses to one lead, `createdAt` is the call's own date, and
// a second run changes nothing.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let token = '';
try {
  token = readFileSync(join(homedir(), '.ghl-token'), 'utf8').trim();
} catch {
  console.log('~/.ghl-token not found — skipping (this test needs a read-only GHL token)');
  process.exit(0);
}

process.env.GHL_API_TOKEN = token;
process.env.VOICE_WEBHOOK_SECRET = 'a-long-enough-test-secret-value';
process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { importVoiceHistory } = await import('./index.js');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const db = getFirestore();

function fakeRes() {
  const out = { code: 0, body: null };
  const res = {
    set: () => res,
    status(code) { out.code = code; return res; },
    json(body) { out.body = body; return res; },
    send(body) { out.body = body; return res; }
  };
  return { res, out };
}

async function run(query, { secret = 'a-long-enough-test-secret-value' } = {}) {
  const { res, out } = fakeRes();
  await importVoiceHistory({
    method: 'POST',
    query,
    body: {},
    get: name => (name.toLowerCase() === 'x-webhook-secret' ? secret : undefined)
  }, res);
  return out;
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const RANGE = { startDate: '2026-01-01', endDate: '2026-12-31' };

console.log('\nguards');
check('rejects a bad secret', (await run(RANGE, { secret: 'wrong' })).code === 401);
check('requires startDate', (await run({})).code === 400);

// The API accepts startDate/endDate and then ignores them, so the window is
// applied client-side. If that ever regresses, the poller silently goes back to
// re-scanning the entire history every five minutes.
console.log('\ndate window is actually applied');
const wide = await run({ ...RANGE, includeDemo: 'true', dryRun: 'true' });
const narrow = await run({ startDate: '2026-03-01', endDate: '2026-03-31', includeDemo: 'true', dryRun: 'true' });
const future = await run({ startDate: '2030-01-01', endDate: '2030-12-31', includeDemo: 'true', dryRun: 'true' });
check('a narrow window scans fewer calls than a wide one',
  narrow.body?.scanned < wide.body?.scanned,
  `March=${narrow.body?.scanned} vs all=${wide.body?.scanned}`);
check('a window with no calls in it scans none',
  future.body?.scanned === 0, `${future.body?.scanned} scanned`);

console.log('\ndry run (writes nothing)');
const dry = await run({ ...RANGE, includeDemo: 'false', dryRun: 'true' });
check('returns 200', dry.code === 200, JSON.stringify(dry.body));
check('scanned the history', dry.body?.scanned > 0, `${dry.body?.scanned} calls`);
check('found eligible calls', dry.body?.eligible > 0, `${dry.body?.eligible} eligible`);
check('collapses to fewer contacts than calls', dry.body?.distinctContacts < dry.body?.eligible,
  `${dry.body?.distinctContacts} contacts from ${dry.body?.eligible} calls`);
check('wrote nothing', (await db.collection('leads').get()).size === 0);

// This is the first-party record for the real July 21, 11:40 p.m. website
// session. GHL logged it 2.084 seconds later with a full transcript but no
// email/phone. The importer must enrich this document, not drop it and not make
// a second conversation row.
const browserCallRef = db.collection('calls').doc('browser_july_21_2340');
await browserCallRef.set({
  agent: 'byte',
  channel: 'voice',
  provider: 'gohighlevel',
  status: 'completed',
  sid: 'browser-test-session',
  path: '/voice-test',
  startedAt: Timestamp.fromDate(new Date('2026-07-22T03:40:35.354Z')),
  durationSec: 76
});
await browserCallRef.collection('turns').add({
  kind: 'state', state: 'listening', at: Timestamp.fromDate(new Date('2026-07-22T03:40:36Z'))
});

console.log('\nimport, excluding website demos');
const first = await run({ ...RANGE, includeDemo: 'false' });
check('returns 200', first.code === 200, JSON.stringify(first.body));

const enrichedBrowserCall = await browserCallRef.get();
const enrichedBrowserTurns = await browserCallRef.collection('turns').get();
const deterministicCopy = enrichedBrowserCall.get('providerCallId')
  ? await db.collection('calls').doc(`ghl_${enrichedBrowserCall.get('providerCallId').replace(/[^A-Za-z0-9_-]/g, '_')}`).get()
  : null;
check('anonymous website call was enriched with its GHL id', Boolean(enrichedBrowserCall.get('providerCallId')));
check('anonymous website transcript was stored',
  enrichedBrowserCall.get('transcriptRecorded') === true
  && enrichedBrowserTurns.docs.some(d => d.get('kind') === 'transcript'),
  `${enrichedBrowserTurns.size} total turns`);
check('browser session metadata was preserved',
  enrichedBrowserCall.get('sid') === 'browser-test-session'
  && enrichedBrowserCall.get('path') === '/voice-test');
check('missing browser end event was repaired', Boolean(enrichedBrowserCall.get('endedAt')));
check('enrichment did not create a duplicate GHL call row', deterministicCopy && !deterministicCopy.exists);
check('anonymous conversation did not become a lead', !enrichedBrowserCall.get('leadId'));

const leads = await db.collection('leads').get();
check('created leads', leads.size > 0, `${leads.size} leads`);
check('one lead per contact', leads.size === dry.body.distinctContacts,
  `${leads.size} leads vs ${dry.body.distinctContacts} contacts`);
check('every lead is byte_voice', leads.docs.every(d => d.get('source') === 'byte_voice'));
check('every lead identifies its receiving agent and client', leads.docs.every(d =>
  d.get('voice.receivingAgent.agentId')
  && d.get('voice.receivingAgent.agentName')
  && d.get('voice.receivingAgent.clientName')));
check('every lead is reachable', leads.docs.every(d => d.get('email') || d.get('phone')));
check('no demo leads imported', leads.docs.every(d => d.get('voice.demo') === false));
check('email key always present', leads.docs.every(d => 'email' in d.data()));
check('all start as new', leads.docs.every(d => d.get('status') === 'new'));

// createdAt must be the call's own date. If it were serverTimestamp() the whole
// backfill would land on today and the list would sort into nonsense.
const now = Date.now();
const stamps = leads.docs.map(d => d.get('createdAt').toMillis());
check('createdAt is the call date, not import time',
  stamps.some(t => now - t > 7 * 86400000),
  `oldest is ${Math.round((now - Math.min(...stamps)) / 86400000)} days old`);

// The repeat caller is the real test of contact-level dedupe.
const repeat = leads.docs.map(d => d.get('voice.callCount')).sort((a, b) => b - a)[0];
check('a repeat caller folded into one lead', repeat > 1, `busiest lead has ${repeat} calls`);

const withTranscript = [];
for (const lead of leads.docs) {
  const callId = lead.get('voice.callId');
  if (!callId) continue;
  const turns = await db.collection('calls').doc(callId).collection('turns').get();
  if (turns.size) withTranscript.push(turns.size);
}
check('transcripts stored against the calls', withTranscript.length > 0,
  `${withTranscript.length} leads have a transcript`);

const turnsSnap = await db.collectionGroup('turns').get();
const allCalls = await db.collection('calls').get();
const importedCalls = allCalls.docs.filter(d => d.get('providerCallId'));
check('every imported call identifies its receiving agent and client', importedCalls.every(d =>
  d.get('receivingAgent.agentId')
  && d.get('receivingAgent.agentName')
  && d.get('receivingAgent.clientName')));
const transcriptRoles = new Set(
  turnsSnap.docs.filter(d => d.get('kind') === 'transcript').map(d => d.get('role'))
);
check('transcript roles attributed to both sides',
  transcriptRoles.size === 2,
  [...transcriptRoles].join(','));

console.log('\nre-running must change nothing (the poller rescans constantly)');
const before = {
  leads: leads.size,
  turns: turnsSnap.size,
  counts: Object.fromEntries(leads.docs.map(d => [d.id, d.get('voice.callCount')]))
};
const second = await run({ ...RANGE, includeDemo: 'false' });
check('returns 200', second.code === 200);
check('created no new leads', second.body?.leadsCreated === 0, `${second.body?.leadsCreated} created`);
check('updated no leads', second.body?.leadsUpdated === 0, `${second.body?.leadsUpdated} updated`);
check('recognised them as already imported', second.body?.alreadyImported > 0,
  `${second.body?.alreadyImported} already imported`);

const after = await db.collection('leads').get();
check('lead count unchanged', after.size === before.leads, `${after.size} vs ${before.leads}`);
check('callCount did not inflate',
  after.docs.every(d => d.get('voice.callCount') === before.counts[d.id]),
  JSON.stringify(after.docs.map(d => d.get('voice.callCount'))));
check('transcripts not duplicated', (await db.collectionGroup('turns').get()).size === before.turns);

// Triage must survive a re-poll, or working the list would be pointless.
await after.docs[0].ref.set({ status: 'contacted' }, { merge: true });
await run({ ...RANGE, includeDemo: 'false' });
check('admin triage survives a re-poll',
  (await after.docs[0].ref.get()).get('status') === 'contacted');

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
