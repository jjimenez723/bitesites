// Inbound compliance against the Firestore emulator:  npm run test:inbound
//
// NO TELEPHONE CALL IS PLACED and no provider is contacted.
//
// The claim this file exists to defend is one sentence: once a person asks us
// to stop, nothing we subsequently do puts them back in a dialable state. That
// is stronger than "markDoNotCall sets a flag", because the flag lives on a
// document and the person outlives the document. The tests that would catch it
// being false are the ones about a caller we have never heard of, and about the
// same number arriving again in a later import under a brand new id.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const {
  suppressNumber, isSuppressed, loadSuppressedNumbers, suppressionId,
  inboundDisclosures, detectOptOutRequest, matchInboundCaller,
  SUPPRESSION_COLLECTION
} = await import('./inbound-compliance.js');
const { importProspects } = await import('./prospect-import.js');
const { evaluateCompliance } = await import('./outbound-compliance.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const wipe = async name => {
  const snapshot = await db.collection(name).limit(500).get();
  for (const entry of snapshot.docs) await entry.ref.delete();
};
for (const name of [SUPPRESSION_COLLECTION, 'prospects', 'calls', 'outboundTargets']) await wipe(name);

const NOW = new Date('2026-03-10T15:00:00Z');

// ---------------------------------------------------------------------------
console.log('\ndisclosure is unconditional inbound');

const lines = inboundDisclosures();
check('the AI identity disclosure is present', lines.some(line => /AI assistant/i.test(line)));
check('and forbids claiming to be human', lines.some(line => /never claim or imply that you are a human/i.test(line)));
check('the recording disclosure is present', lines.some(line => /recorded and transcribed/i.test(line)));
check('an objection stops the call rather than being argued with',
  lines.some(line => /do not continue over an objection/i.test(line)));
check('the opt-out line forbids overcoming the objection',
  lines.some(line => /do not attempt to overcome the objection/i.test(line)));
check('the agent may not imply a relationship that does not exist',
  lines.some(line => /do not imply an existing relationship/i.test(line)));

// Outbound gates the AI notice on campaign.mode === 'ai'. Inbound there is no
// campaign to read, so the notice cannot be conditional on one.
const unrecorded = inboundDisclosures({ recorded: false });
check('dropping recording keeps the AI disclosure', unrecorded.some(line => /AI assistant/i.test(line)));
check('and drops only the recording line', !unrecorded.some(line => /recorded and transcribed/i.test(line)));

// ---------------------------------------------------------------------------
console.log('\nan opt-out is recognised from plain speech');

for (const phrase of [
  'please do not call me again',
  "don't call me",
  'stop calling this number',
  'take me off your list',
  'remove me from the database',
  'remove me from your list',
  'take me off all lists',
  'delete me from your system',
  'never contact me again',
  'put me on your do not call list',
  'I want to opt out',
  'unsubscribe me'
]) check(`"${phrase}"`, detectOptOutRequest(phrase) === true);

// Narrow on purpose: a false positive costs one lead, a false negative ignores
// a person's request — but a matcher that fires on any sentence containing
// "call" would opt out half of a normal conversation.
for (const phrase of [
  'can you call me back tomorrow at ten',
  'I will call you once I have spoken to my partner',
  'what does a website like that usually call for',
  'my list of questions is short',
  ''
]) check(`not an opt-out: "${phrase}"`, detectOptOutRequest(phrase) === false);

// ---------------------------------------------------------------------------
console.log('\nsuppression outlives every record it touches');

const STRANGER = '+12015550142';

// The case the old shape could not represent at all: someone rings the main
// line who has no target, no prospect and no history.
const first = await suppressNumber(db, STRANGER, {
  actor: 'byte', reason: 'inbound_request', source: 'inbound', callId: 'call-x', now: NOW, FieldValue
});
check('a caller with no record of any kind can still opt out', first.ok === true, JSON.stringify(first));
check('and was not already suppressed', first.alreadySuppressed === false);
check('the number is suppressed', await isSuppressed(db, STRANGER) === true);

const stored = await db.doc(`${SUPPRESSION_COLLECTION}/${suppressionId(STRANGER)}`).get();
check('the document id is a hash, not the number',
  stored.id !== STRANGER && stored.id.length === 64, stored.id);
check('the record keeps why and from where', stored.get('reason') === 'inbound_request' && stored.get('source') === 'inbound');

// Formatting must not decide whether an opt-out is honoured.
check('a differently formatted version of the same number is suppressed',
  await isSuppressed(db, '(201) 555-0142') === true);
check('and so is the national format', await isSuppressed(db, '2015550142') === true);
check('an unrelated number is not', await isSuppressed(db, '+12015550999') === false);
check('an unusable number is refused rather than stored',
  (await suppressNumber(db, 'not a phone', { FieldValue })).ok === false);

const repeat = await suppressNumber(db, STRANGER, { actor: 'byte', now: NOW, FieldValue });
const afterRepeat = await db.doc(`${SUPPRESSION_COLLECTION}/${suppressionId(STRANGER)}`).get();
check('asking twice is idempotent', repeat.ok === true && repeat.alreadySuppressed === true);
check('and counts the requests', Number(afterRepeat.get('requestCount')) === 2, String(afterRepeat.get('requestCount')));
check('the date they FIRST asked is never overwritten',
  String(afterRepeat.get('firstRequestedAt')) === String(stored.get('firstRequestedAt')));

const batch = await loadSuppressedNumbers(db, [STRANGER, '+12015550999', '', 'garbage', '(201) 555-0142']);
check('a batch lookup finds the suppressed number', batch.has(STRANGER));
check('and does not invent entries for the rest', batch.size === 1, [...batch].join(','));
check('an empty batch is not an error', (await loadSuppressedNumbers(db, [])).size === 0);

// ---------------------------------------------------------------------------
console.log('\nthe dialer refuses a suppressed number');

const verdict = evaluateCompliance({
  target: { phoneE164: STRANGER, state: 'ready' },
  contact: { phoneE164: STRANGER, location: { timezone: 'America/New_York' } },
  campaign: { callerId: '+12012989723', localStartTime: '00:00', localEndTime: '23:59', allowedDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
  now: NOW,
  suppressed: true
});
check('a suppressed number is not eligible', verdict.eligible === false);
check('and says why', verdict.reasons.includes('suppressed'), verdict.reasons.join(','));

// ---------------------------------------------------------------------------
console.log('\na later import cannot launder an opt-out away');

const imported = await importProspects(db, [
  { name: 'Opted Out Plumbing', phone: '2015550142', address: 'Ridgewood, NJ' },
  { name: 'Fresh Plumbing', phone: '2015550777', address: 'Ridgewood, NJ' }
], { source: { system: 'csv', provider: 'csv' }, now: NOW });

check('both records import', imported.counts.mapped === 2, JSON.stringify(imported.counts));
check('the suppressed one is counted', imported.counts.suppressed === 1, JSON.stringify(imported.counts));

const docs = await db.collection('prospects').get();
const optedOut = docs.docs.find(entry => entry.get('phoneE164') === STRANGER);
const fresh = docs.docs.find(entry => entry.get('phoneE164') === '+12015550777');

check('the opted-out prospect exists but is do_not_contact',
  optedOut?.get('lifecycle.status') === 'do_not_contact', String(optedOut?.get('lifecycle.status')));
check('and carries doNotCall', optedOut?.get('contactability.doNotCall') === true);
check('and is NOT ready, so no campaign can recruit it',
  optedOut?.get('lifecycle.status') !== 'ready');
check('an unrelated number in the same import is unaffected',
  fresh?.get('lifecycle.status') === 'ready', String(fresh?.get('lifecycle.status')));

// Re-importing again must not quietly promote them on the second pass.
const reimported = await importProspects(db, [
  { name: 'Opted Out Plumbing', phone: '2015550142', address: 'Ridgewood, NJ' }
], { source: { system: 'csv', provider: 'csv' }, now: NOW });
const afterReimport = await db.doc(`prospects/${optedOut.id}`).get();
check('a second import still refuses to make them dialable',
  afterReimport.get('lifecycle.status') === 'do_not_contact',
  `${String(afterReimport.get('lifecycle.status'))} / ${JSON.stringify(reimported.counts)}`);

// ---------------------------------------------------------------------------
console.log('\nan inbound caller is matched to the call we placed them');

await db.doc('calls/prior-call-1').set({
  direction: 'outbound', phoneE164: STRANGER, targetId: 'tgt-9', campaignId: 'camp-9',
  sessionId: 'sess-9', startedAt: new Date('2026-03-09T18:00:00Z')
});
await db.doc('calls/prior-call-2').set({
  direction: 'outbound', phoneE164: STRANGER, targetId: 'tgt-10', campaignId: 'camp-9',
  sessionId: 'sess-9', startedAt: new Date('2026-03-10T12:00:00Z')
});

const matched = await matchInboundCaller(db, '(201) 555-0142');
check('a callback is matched to a prior outbound call', Boolean(matched), JSON.stringify(matched));
check('and to the MOST RECENT one, so the opt-out lands on the right target',
  matched?.targetId === 'tgt-10', JSON.stringify(matched));
check('an unknown caller is null rather than an error',
  await matchInboundCaller(db, '+12125550001') === null);
check('an unusable caller id is null too', await matchInboundCaller(db, 'withheld') === null);

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const entry of failed) console.error(`  ✗ ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  process.exit(1);
}
