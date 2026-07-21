// Drives recordVoiceCall against the Firestore emulator:  npm run test:voice
//
// GoHighLevel workflows are assembled by hand, so the payload shape is the part
// of this integration most likely to drift. These cases pin the behaviour that
// matters — a lead gets created, a redelivery does not create a second one, and
// nothing is invented from a payload that did not say it.
//
// It lives beside the function rather than in scripts/ so that `firebase-admin`
// resolves to the same copy the function uses; two instances would not share the
// initialised app. `*.test.mjs` is excluded from the deploy in firebase.json.

process.env.VOICE_WEBHOOK_SECRET = 'a-long-enough-test-secret-value';
process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { recordVoiceCall } = await import('./index.js');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const db = getFirestore();

function fakeRes() {
  const out = { code: 0, body: null, headers: {} };
  const res = {
    set(k, v) { out.headers[k] = v; return res; },
    status(code) { out.code = code; return res; },
    json(body) { out.body = body; return res; },
    send(body) { out.body = body; return res; }
  };
  return { res, out };
}

async function post(body, { secret = 'a-long-enough-test-secret-value', method = 'POST' } = {}) {
  const { res, out } = fakeRes();
  const req = {
    method,
    body,
    query: {},
    get: name => (name.toLowerCase() === 'x-webhook-secret' ? secret : undefined)
  };
  await recordVoiceCall(req, res);
  return out;
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
console.log('\nauth');
check('rejects a bad secret', (await post({}, { secret: 'wrong' })).code === 401);
check('rejects GET', (await post({}, { method: 'GET' })).code === 405);

// ---------------------------------------------------------------------------
console.log('\na call that started on the website');
// The browser's call record, exactly as src/lib/conversations.js writes it.
const browserCall = await db.collection('calls').add({
  agent: 'byte', channel: 'voice', status: 'open', provider: 'gohighlevel',
  sid: 'sid-abc123', path: '/', startedAt: Timestamp.fromMillis(Date.now() - 60_000)
});

const payload = {
  callId: 'ghl-call-0001',
  sid: 'sid-abc123',
  duration: '3:42',
  contact: {
    first_name: 'Dana',
    last_name: 'Okafor',
    email: 'Dana@Example.com',
    phone: '+1 555 0142',
    company_name: 'Okafor Dental'
  },
  tags: ['service:ai_automation', 'website-lead'],
  summary: 'Wants an AI receptionist for after-hours calls. Books ~40 appointments/week.',
  recording_url: 'https://example.com/rec/1.mp3',
  transcript: [
    { role: 'agent', message: 'Hi, this is Byte. How can I help?' },
    { role: 'user', message: 'I need something to answer calls at night.' },
    { role: 'agent', message: 'I can help with that. What is the best email for you?' }
  ]
};

const first = await post(payload);
check('returns 200', first.code === 200, JSON.stringify(first.body));
check('attached to the browser call record', first.body?.callId === browserCall.id,
  `${first.body?.callId} vs ${browserCall.id}`);

const leadSnap = await db.collection('leads').doc(first.body.leadId).get();
const lead = leadSnap.data();
check('lead exists', leadSnap.exists);
check('source is byte_voice', lead?.source === 'byte_voice', lead?.source);
check('name joined from first/last', lead?.name === 'Dana Okafor', lead?.name);
check('email lowercased', lead?.email === 'dana@example.com', lead?.email);
check('phone kept', lead?.phone === '+1 555 0142', lead?.phone);
check('company mapped', lead?.businessName === 'Okafor Dental', lead?.businessName);
check('service read from tag', JSON.stringify(lead?.services) === '["ai_automation"]', JSON.stringify(lead?.services));
check('duration parsed from mm:ss', lead?.voice?.durationSec === 222, String(lead?.voice?.durationSec));
check('summary carried', Boolean(lead?.voice?.summary));
check('recording carried', lead?.voice?.recordingUrl === 'https://example.com/rec/1.mp3');
check('email key always present', 'email' in (lead || {}));
check('crm marked as origin', lead?.crm?.reason === 'origin-gohighlevel');
check('status is new', lead?.status === 'new', lead?.status);

const callAfter = await db.collection('calls').doc(first.body.callId).get();
check('call links back to the lead', callAfter.get('leadId') === first.body.leadId);
check('call closed as completed', callAfter.get('status') === 'completed', callAfter.get('status'));
check('call carries the provider id', callAfter.get('providerCallId') === 'ghl-call-0001');

const turns = await db.collection('calls').doc(first.body.callId).collection('turns').orderBy('at').get();
check('3 transcript turns written', turns.size === 3, String(turns.size));
check('roles attributed', turns.docs.map(d => d.get('role')).join(',') === 'byte,visitor,byte',
  turns.docs.map(d => d.get('role')).join(','));
check('turns ordered', turns.docs[0].get('text').startsWith('Hi, this is Byte'));

// ---------------------------------------------------------------------------
console.log('\nredelivery (GoHighLevel retries on any non-2xx)');
const second = await post(payload);
check('same lead id returned', second.body?.leadId === first.body.leadId);
check('flagged as duplicate', second.body?.duplicate === true);
const leadsNow = await db.collection('leads').get();
check('no second lead created', leadsNow.size === 1, `${leadsNow.size} leads`);
const turnsNow = await db.collection('calls').doc(first.body.callId).collection('turns').get();
check('transcript not duplicated', turnsNow.size === 3, `${turnsNow.size} turns`);

// ---------------------------------------------------------------------------
console.log('\na call that never touched the website (real phone call)');
const phoneOnly = await post({
  call_id: 'ghl-call-0002',
  phone: '+1 555 0199',
  full_name: 'Sam Reyes',
  call_duration: 95,
  transcript: 'Agent: BiteSites, this is Byte.\nUser: Do you build websites?\nAgent: We do.'
});
check('returns 200', phoneOnly.code === 200, JSON.stringify(phoneOnly.body));
const phoneLead = (await db.collection('leads').doc(phoneOnly.body.leadId).get()).data();
check('created a call record of its own', phoneOnly.body.callId !== browserCall.id);
check('lead has no email but the key exists', phoneLead?.email === '' && 'email' in phoneLead);
check('prefers phone contact', phoneLead?.preferredContactMethod === 'phone', phoneLead?.preferredContactMethod);
check('no service invented', JSON.stringify(phoneLead?.services) === '[]', JSON.stringify(phoneLead?.services));
const blobTurns = await db.collection('calls').doc(phoneOnly.body.callId).collection('turns').orderBy('at').get();
check('parsed the "Agent:/User:" blob', blobTurns.size === 3, String(blobTurns.size));
check('blob roles attributed', blobTurns.docs.map(d => d.get('role')).join(',') === 'byte,visitor,byte',
  blobTurns.docs.map(d => d.get('role')).join(','));
check('speaker prefix stripped', blobTurns.docs[1].get('text') === 'Do you build websites?',
  blobTurns.docs[1].get('text'));

// ---------------------------------------------------------------------------
console.log('\na call with nothing to follow up on');
const anonymous = await post({ call_id: 'ghl-call-0003', duration: 12, summary: 'Caller hung up.' });
check('returns 200 without a lead', anonymous.code === 200 && anonymous.body?.leadId === null,
  JSON.stringify(anonymous.body));
check('reason reported', anonymous.body?.reason === 'no-contact-details');
check('still recorded the call', Boolean(anonymous.body?.callId));
check('lead count unchanged', (await db.collection('leads').get()).size === 2,
  `${(await db.collection('leads').get()).size} leads`);

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
