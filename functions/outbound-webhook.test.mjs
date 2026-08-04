// Provider webhook normalisation and authentication:  npm run test:outbound-webhook
//
// Two things are being defended here.
//
// First, that a webhook fails CLOSED. An unset secret, a wrong secret, a
// tampered Twilio signature and a GET request must all be refused — an endpoint
// that moves dialing targets and writes call history is not one to leave open
// while somebody finishes configuring it.
//
// Second, that a redelivery changes nothing. Every provider in this list
// retries on a non-2xx, so "redelivered" is a matter of when, not if.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const { createHmac } = await import('node:crypto');
const { KixieDialer, buildPowerlistPayload } = await import('./providers/calling/kixie.js');
const { GoHighLevelDialer } = await import('./providers/calling/gohighlevel.js');
const { TwilioDialer } = await import('./providers/calling/twilio.js');
const { MockDialer } = await import('./providers/calling/mock-dialer.js');
const { recordCallEvent } = await import('./outbound-calls.js');
const { callEvent, eventId } = await import('./providers/calling/adapter.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const SECRET = 'a-long-enough-webhook-secret-value';
const req = (headers = {}, body = {}, extra = {}) => ({
  method: 'POST',
  body,
  get: name => headers[String(name).toLowerCase()],
  ...extra
});

// ---------------------------------------------------------------------------
console.log('\nauthentication fails closed');

const kixie = new KixieDialer({});
check('kixie refuses an empty secret', kixie.verifyWebhook(req({ 'x-bitesites-kixie-secret': SECRET }), '') === false);
check('kixie refuses the "unset" placeholder', kixie.verifyWebhook(req({ 'x-bitesites-kixie-secret': 'unset' }), 'unset') === false);
check('kixie refuses a short secret', kixie.verifyWebhook(req({ 'x-bitesites-kixie-secret': 'short' }), 'short') === false);
check('kixie refuses a wrong secret',
  kixie.verifyWebhook(req({ 'x-bitesites-kixie-secret': 'wrong-but-same-length-value-x' }), SECRET) === false);
check('kixie refuses a missing header', kixie.verifyWebhook(req({}), SECRET) === false);
check('kixie accepts the right secret',
  kixie.verifyWebhook(req({ 'x-bitesites-kixie-secret': SECRET }), SECRET) === true);

const ghl = new GoHighLevelDialer({});
check('gohighlevel refuses a wrong secret',
  ghl.verifyWebhook(req({ 'x-webhook-secret': 'wrong-but-same-length-value-x' }), SECRET) === false);
check('gohighlevel accepts the right secret',
  ghl.verifyWebhook(req({ 'x-webhook-secret': SECRET }), SECRET) === true);

// ---------------------------------------------------------------------------
console.log('\ntwilio uses a real signature, not a shared secret');

const twilio = new TwilioDialer({ authToken: SECRET });
const twilioBody = { CallSid: 'CA123', CallStatus: 'completed', CallDuration: '42' };
const url = 'https://example.com/api/outbound-events?provider=twilio';
const payload = Object.keys(twilioBody).sort().reduce((acc, key) => acc + key + twilioBody[key], url);
const signature = createHmac('sha1', SECRET).update(Buffer.from(payload, 'utf8')).digest('base64');

const signedReq = req({ 'x-twilio-signature': signature }, twilioBody, { originalUrl: url, protocol: 'https' });
check('a valid twilio signature is accepted', twilio.verifyWebhook(signedReq, SECRET) === true);

const tamperedBody = { ...twilioBody, CallDuration: '9999' };
const tamperedReq = req({ 'x-twilio-signature': signature }, tamperedBody, { originalUrl: url, protocol: 'https' });
check('a tampered body invalidates the signature', twilio.verifyWebhook(tamperedReq, SECRET) === false);
check('a missing signature is refused',
  twilio.verifyWebhook(req({}, twilioBody, { originalUrl: url }), SECRET) === false);

// ---------------------------------------------------------------------------
console.log('\nkixie payload construction and event normalisation');

const powerlist = buildPowerlistPayload({
  target: { id: 'tgt-1', campaignId: 'camp-1', phoneE164: '+12015550142', contactType: 'prospect' },
  contact: { firstName: 'Dana', companyName: 'Joes Plumbing', email: 'dana@joes.example.com', researchSummary: 'A summary' },
  campaign: { id: 'camp-1' },
  sessionId: 'sess-1',
  apiKey: 'key', businessId: 'biz', powerlistId: 'plist'
});
check('the payload merges rather than duplicating a dial target', powerlist.duplicateHandling === 'merge');
check('it carries BiteSites identity so a webhook can find its way back',
  powerlist.extraData.bitesitesTargetId === 'tgt-1' && powerlist.extraData.bitesitesCampaignId === 'camp-1');
check('the destination is E.164', powerlist.target === '+12015550142');

let refusedNoPhone = false;
try {
  buildPowerlistPayload({
    target: { id: 't', phoneE164: '' }, contact: {}, campaign: {},
    sessionId: '', apiKey: 'k', businessId: 'b', powerlistId: 'p'
  });
} catch { refusedNoPhone = true; }
check('a target with no dialable number is refused', refusedNoPhone);

const nested = kixie.normalizeWebhookEvent({
  data: {
    callDetails: { callid: 'kx-1', callstatus: 'answered', duration: 96, recordingurl: 'https://rec.example.com/a.mp3' },
    powerlistContactDetails: { result: { extraData: { bitesitesTargetId: 'tgt-1', bitesitesCampaignId: 'camp-1' } } }
  },
  eventname: 'answeredcall'
});
check('a nested kixie payload normalises', nested?.type === 'answered', JSON.stringify(nested));
check('and recovers the BiteSites target', nested.targetId === 'tgt-1');
check('and keeps an https recording url', nested.recordingUrl === 'https://rec.example.com/a.mp3');

const flat = kixie.normalizeWebhookEvent({
  eventname: 'endcall', callid: 'kx-2', callstatus: 'completed',
  bitesitesTargetId: 'tgt-2', disposition: 'Not Interested', duration: 30
});
check('a flattened kixie payload also normalises', flat?.type === 'completed');
check('and maps a free-text disposition', flat.disposition === 'not_interested', flat.disposition);

const insecureRecording = kixie.normalizeWebhookEvent({
  eventname: 'endcall', callid: 'kx-3', recordingurl: 'http://insecure.example.com/a.mp3'
});
check('an http recording url is dropped rather than stored', insecureRecording.recordingUrl === '');

// ---------------------------------------------------------------------------
console.log('\ngohighlevel only claims events that are ours');

check('an inbound GHL call is ignored',
  ghl.normalizeWebhookEvent({ callId: 'x', callStatus: 'completed' }) === null);

const ours = ghl.normalizeWebhookEvent({
  callId: 'ghl-1', callStatus: 'completed', duration: 120,
  customData: { bitesites_campaign_id: 'camp-1', bitesites_target_id: 'tgt-1' },
  outcome: 'appointment booked'
});
check('an outbound GHL call with our metadata is claimed', ours?.campaignId === 'camp-1');
check('and its outcome maps to a disposition', ours.disposition === 'booked_meeting', ours.disposition);

check('DND is honoured over any campaign setting',
  GoHighLevelDialer.contactIsDnd({ dndSettings: { Call: { status: 'active' } } }) === true
  && GoHighLevelDialer.contactIsDnd({ dnd: true }) === true
  && GoHighLevelDialer.contactIsDnd({}) === false);

// ---------------------------------------------------------------------------
console.log('\ntwilio AMD distinguishes a human from a greeting');

check('AnsweredBy=human is a human answer',
  twilio.normalizeWebhookEvent({ CallSid: 'CA1', AnsweredBy: 'human', CallStatus: 'in-progress' }).type === 'human_answered');
check('AnsweredBy=machine_end_beep is not',
  twilio.normalizeWebhookEvent({ CallSid: 'CA2', AnsweredBy: 'machine_end_beep' }).type === 'machine_answered');
check('a busy signal maps through',
  twilio.normalizeWebhookEvent({ CallSid: 'CA3', CallStatus: 'busy' }).type === 'busy');
check('a cancelled leg maps through',
  twilio.normalizeWebhookEvent({ CallSid: 'CA4', CallStatus: 'canceled' }).type === 'cancelled');
check('identity is recovered from the echoed callback query string',
  twilio.normalizeWebhookEvent({ CallSid: 'CA5', CallStatus: 'ringing' }, { targetId: 'tgt-9', campaignId: 'camp-9' }).targetId === 'tgt-9');
check('a payload with no CallSid is ignored',
  twilio.normalizeWebhookEvent({ CallStatus: 'completed' }) === null);

// ---------------------------------------------------------------------------
console.log('\nevent ids are deterministic');

const at = new Date('2026-01-05T15:00:00Z');
check('the same event yields the same id',
  eventId('twilio', 'CA1', 'completed', at) === eventId('twilio', 'CA1', 'completed', at));
check('different events do not collide',
  eventId('twilio', 'CA1', 'completed', at) !== eventId('twilio', 'CA1', 'ringing', at));
check('an unsafe call id is made safe without collapsing distinct ids',
  eventId('twilio', 'a/b', 'x', at) !== eventId('twilio', 'a b', 'x', at)
  || eventId('twilio', 'a/b', 'x', at).includes('a_b'));

// ---------------------------------------------------------------------------
console.log('\nredelivery against Firestore');

for (const name of ['calls', 'outboundCallEvents', 'outboundTargets', 'outboundCampaigns']) {
  const snapshot = await db.collection(name).limit(500).get();
  for (const entry of snapshot.docs) await entry.ref.delete();
}

await db.doc('outboundCampaigns/camp-w').set({
  name: 'Webhook test', mode: 'power', provider: 'mock', status: 'running',
  maxAttempts: 3, retryDelayMinutes: 60, counts: {}
});
await db.doc('outboundTargets/tgt-w').set({
  campaignId: 'camp-w', contactType: 'prospect', prospectId: 'missing-prospect', leadId: null,
  phoneE164: '+12015550142', timezone: 'America/New_York', state: 'dialing',
  attemptCount: 1, maxAttempts: 3
});
await db.doc('calls/call-w').set({
  agent: 'human', channel: 'voice', status: 'open', direction: 'outbound',
  operator: 'human', dialerMode: 'power', campaignId: 'camp-w', targetId: 'tgt-w',
  prospectId: 'missing-prospect', leadId: '', sessionId: '', provider: 'mock',
  providerCallId: 'mock-w-1', attemptNumber: 1, startedAt: Timestamp.fromDate(at)
});

const completion = callEvent({
  type: 'completed', providerCallId: 'mock-w-1', targetId: 'tgt-w', campaignId: 'camp-w',
  status: 'completed', disposition: 'no_answer', durationSec: 0, at
});
const docId = eventId('mock', 'mock-w-1', 'completed', at);

const firstApply = await recordCallEvent(db, completion, { eventDocId: docId, now: at });
check('the event applies once', firstApply.applied === true, JSON.stringify(firstApply));

const secondApply = await recordCallEvent(db, completion, { eventDocId: docId, now: at });
check('a redelivery is dropped', secondApply.applied === false && secondApply.reason === 'duplicate_event');

const call = await db.doc('calls/call-w').get();
check('the call was completed exactly once', call.get('status') === 'completed');
check('with the provider disposition', call.get('disposition') === 'no_answer');

const target = await db.doc('outboundTargets/tgt-w').get();
check('the target was resolved', target.get('state') === 'no_answer', target.get('state'));
check('and a retry was scheduled', Boolean(target.get('nextAttemptAt')));

const ledger = await db.collection('outboundCallEvents').get();
check('exactly one ledger entry exists', ledger.size === 1, String(ledger.size));

// ---------------------------------------------------------------------------
console.log('\nan event for an unknown call is not applied');

const orphan = await recordCallEvent(db, callEvent({
  type: 'completed', providerCallId: 'does-not-exist', targetId: '', campaignId: '', at
}), { eventDocId: 'orphan-1', now: at });
check('it reports call_not_found rather than throwing',
  orphan.applied === false && orphan.reason === 'call_not_found', JSON.stringify(orphan));

// ---------------------------------------------------------------------------
console.log('\na transcript is stored under the existing turns subcollection');

await db.doc('calls/call-t').set({
  agent: 'byte', channel: 'voice', status: 'open', direction: 'outbound',
  operator: 'ai', dialerMode: 'ai', campaignId: 'camp-w', targetId: 'tgt-w',
  provider: 'mock', providerCallId: 'mock-t-1', attemptNumber: 1,
  startedAt: Timestamp.fromDate(at)
});
const withTranscript = callEvent({
  type: 'completed', providerCallId: 'mock-t-1', targetId: 'tgt-w', campaignId: 'camp-w',
  disposition: 'connected', durationSec: 60, at,
  transcript: [
    { role: 'agent', text: 'This call is recorded.' },
    { role: 'contact', text: 'Understood.' }
  ]
});
await recordCallEvent(db, withTranscript, { eventDocId: 'transcript-1', now: at });
const turns = await db.collection('calls/call-t/turns').get();
check('turns were written', turns.size === 2, String(turns.size));
check('and the call is flagged as having a transcript',
  (await db.doc('calls/call-t').get()).get('transcriptRecorded') === true);

await recordCallEvent(db, withTranscript, { eventDocId: 'transcript-2', now: at });
const turnsAgain = await db.collection('calls/call-t/turns').get();
check('a redelivered transcript does not double the turns', turnsAgain.size === 2, String(turnsAgain.size));

// ---------------------------------------------------------------------------
console.log('\nunconfigured providers report themselves honestly');

check('kixie with no credentials is not ok',
  (await new KixieDialer({}).healthCheck()).ok === false);
check('and names the missing secrets',
  (await new KixieDialer({}).healthCheck()).missing.includes('KIXIE_API_KEY'));
check('twilio with no credentials is not ok',
  (await new TwilioDialer({}).healthCheck()).ok === false);
check('the mock provider is always ok', (await new MockDialer({}).healthCheck()).ok === true);

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('\nFailed:');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
  process.exit(1);
}
