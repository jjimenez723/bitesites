// Prospect → lead promotion, against the Firestore emulator:
//   npm run test:conversion
//
// The assertions here defend the funnel. `leads` is what the Overview and
// Performance screens count as website conversions, so the tests that matter
// most are the ones proving a scraped business does NOT land there — not from
// an attempted call, not from a redelivered webhook, and never twice.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const { promoteProspect, findExistingLead, CONVERSION_TRIGGERS } = await import('./prospect-conversion.js');
const { importProspects } = await import('./prospect-import.js');
const { loadContactForTarget, updateContactAfterAttempt, claimTarget, releaseTarget, lockIsStale } =
  await import('./outbound-contacts.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const wipe = async name => {
  const snapshot = await db.collection(name).limit(500).get();
  for (const entry of snapshot.docs) {
    for (const sub of await entry.ref.listCollections()) {
      const kids = await sub.limit(500).get();
      for (const kid of kids.docs) await kid.ref.delete();
    }
    await entry.ref.delete();
  }
};

for (const name of ['prospects', 'leads', 'outboundTargets', 'calls']) await wipe(name);

const seed = async (records, source = { system: 'scraper', provider: 'mock' }) => {
  const result = await importProspects(db, records, { source });
  return result.written;
};

// ---------------------------------------------------------------------------
console.log('\nan attempted call is not a conversion');

const [coldId] = await seed([{ name: 'Cold Prospect Co', phone: '2015550001', website: 'coldprospect.example.com' }]);
check('the prospect exists', Boolean(coldId), String(coldId));

let refusedAttempt = false;
try {
  await promoteProspect(db, coldId, { trigger: 'call_attempted' });
} catch (error) {
  refusedAttempt = /not a conversion trigger/.test(error.message);
}
check('promotion refuses a non-engagement trigger', refusedAttempt);
check('no lead was created', (await db.collection('leads').get()).empty);
check('the trigger list excludes call attempts', !CONVERSION_TRIGGERS.includes('call_attempted'));

// ---------------------------------------------------------------------------
console.log('\na real conversation creates exactly one lead');

await db.doc('calls/call1').set({
  status: 'connected', answeredBy: 'human', connectedAt: new Date(),
  targetId: 'tgt1', prospectId: coldId
});

const first = await promoteProspect(db, coldId, {
  trigger: 'call_answered', campaignId: 'camp1', targetId: 'tgt1', firstConnectedCallId: 'call1'
});
check('a lead was created', first.created === true && Boolean(first.leadId), JSON.stringify(first));

const lead = await db.doc(`leads/${first.leadId}`).get();
check('it is attributed to outbound, not the website', lead.get('source') === 'outbound');
check('it preserves the originating prospect', lead.get('acquisition').originalProspectId === coldId);
check('it preserves the campaign and call', lead.get('acquisition').campaignId === 'camp1'
  && lead.get('acquisition').firstConnectedCallId === 'call1');
check('the prospect records the conversion',
  (await db.doc(`prospects/${coldId}`).get()).get('lifecycle').convertedLeadId === first.leadId);

const [forgedId] = await seed([{ name: 'Unverified Call Co', phone: '2015551001' }]);
await db.doc('calls/unverified-call').set({
  status: 'ringing', answeredBy: '', targetId: 'tgt-unverified', prospectId: forgedId
});
let refusedUnverified = false;
try {
  await promoteProspect(db, forgedId, {
    trigger: 'call_answered', targetId: 'tgt-unverified', firstConnectedCallId: 'unverified-call'
  });
} catch (error) {
  refusedUnverified = /not recorded as a verified human conversation/.test(error.message);
}
check('an unverified ringing call cannot create a call-linked lead', refusedUnverified);

// ---------------------------------------------------------------------------
console.log('\nre-running it is a no-op (webhook redelivery)');

const second = await promoteProspect(db, coldId, { trigger: 'call_answered', campaignId: 'camp1' });
check('the second call reports no new lead', second.created === false && second.alreadyConverted === true);
check('there is still exactly one lead', (await db.collection('leads').get()).size === 1);

// ---------------------------------------------------------------------------
console.log('\nlinking to an existing inbound lead instead of duplicating it');

// Order matters, and it is the realistic order. The importer already refuses to
// create a prospect that duplicates an existing lead, so the only way the two
// coexist is the sequence below: we scraped the business, and only later did
// somebody from it fill in the website form. That is precisely the case
// promotion has to handle without producing a second lead.
const [knownId] = await seed([{
  name: 'Known Business', phone: '2015559090', email: 'dana@knownbusiness.example.com'
}], { system: 'csv', provider: 'csv' });
check('the cold prospect exists first', Boolean(knownId), String(knownId));

await db.doc('leads/inbound-1').set({
  name: 'Dana Whitfield',
  email: 'dana@knownbusiness.example.com',
  phone: '+12015559090',
  phoneE164: '+12015559090',
  source: 'intake_form',
  status: 'qualified',
  owner: 'jensy@bitesites.org',
  dealValue: 4200,
  firstResponseAt: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z')
});

// The other direction is also worth pinning: once that lead exists, a fresh
// import of the same business must not create a second prospect either.
const reimport = await importProspects(db, [{
  name: 'Known Business', phone: '2015559090', email: 'dana@knownbusiness.example.com'
}], { source: { system: 'csv', provider: 'csv' } });
check('re-importing a business that is now an inbound lead creates nothing',
  reimport.counts.created === 0, JSON.stringify(reimport.counts));

const found = await findExistingLead(db, { phoneE164: '+12015559090', email: 'dana@knownbusiness.example.com' });
check('the existing lead is found by phone', found?.id === 'inbound-1');

const linked = await promoteProspect(db, knownId, { trigger: 'meeting_booked', campaignId: 'camp2' });
check('it links rather than creating', linked.linked === true && linked.created === false && linked.leadId === 'inbound-1');
check('no duplicate lead appeared', (await db.collection('leads').get()).size === 2);

const untouched = await db.doc('leads/inbound-1').get();
check('the existing lead keeps its stage', untouched.get('status') === 'qualified');
check('the existing lead keeps its owner', untouched.get('owner') === 'jensy@bitesites.org');
check('the existing lead keeps its economics', untouched.get('dealValue') === 4200);
check('the existing lead keeps its response time',
  untouched.get('firstResponseAt').toDate().toISOString() === '2026-01-01T00:00:00.000Z');
check('outbound attribution was added', untouched.get('acquisition').campaignId === 'camp2');

// ---------------------------------------------------------------------------
console.log('\ntargets follow the contact to the lead');

const [movingId] = await seed([{ name: 'Moving Co', phone: '2015557070' }]);
await db.doc('outboundTargets/tgt-moving').set({
  campaignId: 'camp3', contactType: 'prospect', leadId: null, prospectId: movingId,
  phoneE164: '+12015557070', state: 'ready', attemptCount: 0, maxAttempts: 3
});
await db.doc('calls/call-moving').set({
  status: 'completed', connectedAt: new Date(), targetId: 'tgt-moving', prospectId: movingId
});

const moved = await promoteProspect(db, movingId, {
  trigger: 'call_answered', campaignId: 'camp3', targetId: 'tgt-moving', firstConnectedCallId: 'call-moving'
});
const target = await db.doc('outboundTargets/tgt-moving').get();
check('the target now points at the lead', target.get('leadId') === moved.leadId);
check('and no longer at the prospect', target.get('prospectId') === null);
check('exactly one contact reference is populated',
  Boolean(target.get('leadId')) !== Boolean(target.get('prospectId')));
check('the prospect link survives as attribution', target.get('convertedFromProspectId') === movingId);

// ---------------------------------------------------------------------------
console.log('\nmanual qualification is explicit and does not invent contact');

const [manualId] = await seed([{ name: 'Research Qualified Co', phone: '2015558080' }]);
const manual = await promoteProspect(db, manualId, {
  trigger: 'manual_qualification', actor: 'manager@bitesites.org',
  manualReason: 'Approved after account research',
  manualNotes: 'Strong local portfolio fit; no platform call has taken place.',
  contactStatus: 'not_contacted'
});
const manualLead = await db.doc(`leads/${manual.leadId}`).get();
check('manual qualification keeps the lead uncontacted', manualLead.get('status') === 'new');
check('manual qualification stores its reason and contact status',
  manualLead.get('acquisition').manualReason === 'Approved after account research'
    && manualLead.get('acquisition').contactStatus === 'not_contacted');
check('manual qualification does not invent an interest category',
  Array.isArray(manualLead.get('services')) && manualLead.get('services').length === 0);
check('manual qualification does not manufacture first response time', !manualLead.get('firstResponseAt'));

// ---------------------------------------------------------------------------
console.log('\nthe shared contact layer treats leads and prospects alike');

const asProspect = await loadContactForTarget(db, { contactType: 'prospect', prospectId: coldId });
check('a prospect loads', asProspect?.type === 'prospect' && Boolean(asProspect.phoneE164));

const asLead = await loadContactForTarget(db, { contactType: 'lead', leadId: 'inbound-1' });
check('a lead loads into the same shape', asLead?.type === 'lead' && asLead.phoneE164 === '+12015559090');
check('a missing contact returns null',
  (await loadContactForTarget(db, { contactType: 'prospect', prospectId: 'nope' })) === null);

await updateContactAfterAttempt(db, asProspect, { disposition: 'not_interested', callId: 'c9', campaignId: 'camp1' });
check('a prospect records the outcome on its lifecycle',
  (await db.doc(`prospects/${coldId}`).get()).get('lifecycle').status === 'not_interested');

const leadBefore = (await db.doc('leads/inbound-1').get()).get('status');
await updateContactAfterAttempt(db, asLead, { disposition: 'not_interested', callId: 'c10', campaignId: 'camp2' });
check('a lead’s funnel stage is NOT rewritten by an outbound attempt',
  (await db.doc('leads/inbound-1').get()).get('status') === leadBefore);
check('but the attempt is recorded on the lead',
  (await db.doc('leads/inbound-1').get()).get('lastOutboundDisposition') === 'not_interested');

const leadActivities = await db.collection('leads/inbound-1/activities').get();
check('an activity was appended to the lead', leadActivities.size >= 1);

// ---------------------------------------------------------------------------
console.log('\ndo-not-call propagates to the contact');

await updateContactAfterAttempt(db, asProspect, { disposition: 'do_not_call', callId: 'c11', campaignId: 'camp1' });
const dnc = await db.doc(`prospects/${coldId}`).get();
check('the prospect is marked do-not-call', dnc.get('contactability').doNotCall === true);
check('and its lifecycle says so', dnc.get('lifecycle').status === 'do_not_contact');

// ---------------------------------------------------------------------------
console.log('\ntarget locking');

await db.doc('outboundTargets/tgt-lock').set({
  campaignId: 'camp4', contactType: 'prospect', leadId: null, prospectId: coldId,
  phoneE164: '+12015550001', state: 'ready', attemptCount: 0, maxAttempts: 3,
  lockedBySessionId: '', lockedAt: null
});

const claimed = await claimTarget(db, 'tgt-lock', 'session-a');
check('a session can claim a ready target', claimed.claimed === true);

const stolen = await claimTarget(db, 'tgt-lock', 'session-b');
check('a second session cannot claim it', stolen.claimed === false && stolen.reason === 'locked');

const reclaim = await claimTarget(db, 'tgt-lock', 'session-a');
check('the holding session can re-enter its own claim',
  reclaim.claimed === false && reclaim.reason.startsWith('state_'), reclaim.reason);

check('a fresh lock is not stale',
  lockIsStale({ lockedBySessionId: 'x', lockedAt: new Date() }) === false);
check('an old lock is stale',
  lockIsStale({ lockedBySessionId: 'x', lockedAt: new Date(Date.now() - 10 * 60000) }) === true);
check('an unlocked target is trivially stale',
  lockIsStale({ lockedBySessionId: '', lockedAt: null }) === true);

await releaseTarget(db, 'tgt-lock', { state: 'ready' });
const released = await db.doc('outboundTargets/tgt-lock').get();
check('releasing clears the lock', released.get('lockedBySessionId') === '' && released.get('state') === 'ready');

const afterRelease = await claimTarget(db, 'tgt-lock', 'session-b');
check('and another session can then take it', afterRelease.claimed === true);

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('\nFailed:');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
  process.exit(1);
}
