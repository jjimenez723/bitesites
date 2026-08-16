// Drives the Byte homepage session endpoints against the Firestore emulator:
//   npm run test:byte-web
//
// The mint endpoint spends real OpenAI minutes in production, so the guarded
// behaviours are the point of this suite: quotas hold, the concurrency
// ceiling holds, a forged token buys nothing, tools stay inside their grant,
// and the lead a session produces has the same shape the GoHighLevel webhook
// writes — one lead per session no matter how many times the model retries.
//
// OpenAI is stubbed at globalThis.fetch; nothing here leaves the machine.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
initializeApp();
const { byteWebSession, byteWebTools } = await import('./byte-web-session.js');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const db = getFirestore();

// ---------------------------------------------------------------- harness

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).includes('api.openai.com/v1/realtime/client_secrets')) {
    const session = JSON.parse(options.body).session;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        value: `cs_test_${session.model}`,
        expires_at: Math.floor(Date.now() / 1000) + 600
      })
    };
  }
  return realFetch(url, options);
};

function fakeRes() {
  const out = { code: 200, body: null, headers: {} };
  const res = {
    set(k, v) { out.headers[k] = v; return res; },
    status(code) { out.code = code; return res; },
    json(body) { out.body = body; return res; },
    send(body) { out.body = body; return res; }
  };
  return { res, out };
}

async function call(handler, body, { ip = '203.0.113.1', method = 'POST' } = {}) {
  const { res, out } = fakeRes();
  await handler({ method, body, headers: { 'x-forwarded-for': ip }, ip }, res);
  return out;
}

const mint = (body = {}, opts) => call(byteWebSession, body, opts);
const tool = (session, name, args = {}, opts) => call(byteWebTools, {
  sessionId: session.sessionId, sessionToken: session.sessionToken,
  action: 'tool', tool: name, args
}, opts);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
console.log('\nminting');

check('rejects GET', (await mint({}, { method: 'GET' })).code === 405);

delete process.env.OPENAI_API_KEY;
check('refuses to mint without an OpenAI key', (await mint()).code === 503);
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';

// The concurrency ceiling is the wallet guard: 12 live sessions refuse a 13th.
const fakeLive = [];
for (let index = 0; index < 12; index += 1) {
  const ref = db.collection('webVoiceSessions').doc();
  await ref.set({ status: 'live', token: 'x'.repeat(64), ipHash: 'capacity-test', liveUntilMs: Date.now() + 600000, startedAt: Timestamp.now() });
  fakeLive.push(ref);
}
const atCapacity = await mint({}, { ip: '203.0.113.90' });
check('refuses a 13th concurrent session', atCapacity.code === 429 && atCapacity.body?.error === 'at-capacity');
await Promise.all(fakeLive.map(ref => ref.delete()));

const bookingCall = await db.collection('calls').add({
  agent: 'byte', channel: 'voice', status: 'open', provider: 'openai',
  sid: 'sid-test', path: '/', startedAt: Timestamp.now()
});

const first = await mint({ callId: bookingCall.id, sid: 'sid-test', path: '/' });
check('mints a session', first.code === 200 && Boolean(first.body?.clientSecret));
check('client secret comes from the stubbed OpenAI call', String(first.body?.clientSecret).startsWith('cs_test_'));
const s1 = first.body;
const s1Doc = await db.doc(`webVoiceSessions/${s1.sessionId}`).get();
check('session doc is live with the tool grant list',
  s1Doc.get('status') === 'live' && (s1Doc.get('tools') || []).includes('book_meeting'));
check('the browser token is not the doc id', s1.sessionToken.length === 64 && s1.sessionToken !== s1.sessionId);

for (let index = 0; index < 4; index += 1) await mint();
const sixth = await mint();
check('hourly per-IP quota holds at five', sixth.code === 429 && sixth.body?.error === 'rate-limited');
const otherIp = await mint({}, { ip: '198.51.100.7' });
check('a different IP is unaffected by the quota', otherIp.code === 200);

// ---------------------------------------------------------------------------
console.log('\nauthorization');

const forged = await call(byteWebTools, {
  sessionId: s1.sessionId, sessionToken: 'f'.repeat(64), action: 'tool', tool: 'lookup_knowledge', args: { query: 'x' }
});
check('a forged token is refused', forged.code === 401);
check('an unknown session is refused', (await call(byteWebTools, {
  sessionId: 'does-not-exist', sessionToken: s1.sessionToken, action: 'tool', tool: 'end_call'
})).code === 401);
check('an unknown action is refused', (await call(byteWebTools, {
  sessionId: s1.sessionId, sessionToken: s1.sessionToken, action: 'reboot'
})).code === 400);
const notGranted = await tool(s1, 'mark_do_not_call', { reason: 'x' });
check('phone-campaign tools are not permitted on web', notGranted.body?.error === 'tool_not_permitted');

// ---------------------------------------------------------------------------
console.log('\nknowledge and pricing');

const knowledge = await tool(s1, 'lookup_knowledge', { query: 'who owns the website if we leave' });
check('hard-question corpus answers ownership',
  knowledge.body?.found === true
  && knowledge.body.passages.some(p => p.title === 'Who owns what you pay for'));

const unpriced = await tool(s1, 'lookup_approved_pricing', { offerTrack: 'websites' });
check('unapproved pricing returns the honest fallback',
  unpriced.body?.ok === true && unpriced.body.approved === false && /cost drivers/.test(unpriced.body.note));

await db.doc('pricingBook/default').set({
  tracks: { websites: { summary: 'Custom builds scoped to the business.', startingAt: 'a published starting band', range: 'depends on scope', caveat: 'Specialist confirms.' } }
});
const priced = await tool(s1, 'lookup_approved_pricing', { offerTrack: 'websites' });
check('approved pricing is returned once published', priced.body?.approved === true && Boolean(priced.body.startingAt));

// ---------------------------------------------------------------------------
console.log('\ncontact capture → lead');

const unreachable = await tool(s1, 'save_contact_details', { name: 'Dana', interest: 'a site that books jobs' });
check('a name alone creates no lead', unreachable.body?.reachable === false);
check('followup without contact details is refused',
  (await tool(s1, 'request_human_followup', { note: 'call me' })).body?.error === 'no_contact_details');

const badEmail = await tool(s1, 'save_contact_details', { email: 'not-an-email' });
check('a malformed email is bounced back for a re-read', badEmail.body?.error === 'invalid_email');

const reachable = await tool(s1, 'save_contact_details', { email: 'dana@example.com', company: 'Dana Plumbing' });
check('an email creates the lead', reachable.body?.reachable === true && Boolean(reachable.body.leadId));
const leadId = reachable.body.leadId;
let lead = await db.doc(`leads/${leadId}`).get();
check('lead carries the byte_voice shape', lead.get('source') === 'byte_voice'
  && lead.get('email') === 'dana@example.com'
  && lead.get('voice')?.provider === 'openai_realtime'
  && lead.get('voice')?.providerCallId === `web_${s1.sessionId}`
  && lead.get('voice')?.callId === bookingCall.id);
check('earlier details merged in', lead.get('name') === 'Dana' && lead.get('projectDetails') === 'a site that books jobs');
check('native leads carry no GHL origin marker, so the CRM sync will forward them', lead.get('crm') === undefined);

await tool(s1, 'save_contact_details', { phone: '+1 555 0100' });
const leads = await db.collection('leads').where('voice.providerCallId', '==', `web_${s1.sessionId}`).get();
check('retried captures never duplicate the lead', leads.size === 1);
check('followup lands on the lead once reachable',
  (await tool(s1, 'request_human_followup', { note: 'wants a human tomorrow' })).body?.ok === true
  && (await db.doc(`leads/${leadId}`).get()).get('followupRequested')?.note === 'wants a human tomorrow');

// ---------------------------------------------------------------------------
console.log('\nbooking');

await db.doc('calendarSettings/default').set({
  timezone: 'UTC', slotMinutes: 20, bufferMinutes: 0, leadTimeMinutes: 0, capacity: 1,
  horizonDays: 14, googleSyncEnabled: false,
  // Firestore cannot hold nested arrays, so the seed uses the normalizer's
  // object window form rather than the [open, close] pairs it also accepts.
  workingHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [String(day), [{ open: '00:00', close: '23:59' }]]))
});

const availability = await tool(s1, 'check_availability', { requestedWindow: '' });
check('availability returns real slots', availability.body?.found === true && availability.body.slots.length > 0);
const slotId = availability.body?.slots?.[0]?.slotId;

const held = await tool(s1, 'hold_slot', { slotId, offerTrack: 'websites' });
check('the slot holds', held.body?.ok === true && Boolean(held.body.holdId));

const booked = await tool(s1, 'book_meeting', {
  holdId: held.body.holdId, name: 'Dana Example', email: 'dana@example.com',
  company: 'Dana Plumbing', notes: 'wants booking flow'
});
check('the meeting books with a confirmation reference', booked.body?.ok === true && Boolean(booked.body.confirmationRef));
const appointment = await db.doc(`appointments/${booked.body.appointmentId}`).get();
check('the appointment is committed', appointment.get('status') === 'booked'
  && appointment.get('attendee')?.email === 'dana@example.com');
lead = await db.doc(`leads/${leadId}`).get();
check('the booking lands on the same lead', lead.get('voice')?.appointment?.confirmationRef === booked.body.confirmationRef);
check('the call record shows the outcome',
  (await db.doc(`calls/${bookingCall.id}`).get()).get('outcome')?.booked === true);

// ---------------------------------------------------------------------------
console.log('\nsession limits and teardown');

await db.doc(`webVoiceSessions/${s1.sessionId}`).set({ toolCalls: 48 }, { merge: true });
check('the tool budget exhausts', (await tool(s1, 'lookup_knowledge', { query: 'process' })).body?.error === 'tool_budget_exhausted');
await db.doc(`webVoiceSessions/${s1.sessionId}`).set({ toolCalls: 0, expiresAtMs: 1 }, { merge: true });
const overtime = await tool(s1, 'lookup_knowledge', { query: 'process' });
check('an expired session winds the call down', overtime.body?.error === 'session_over' && overtime.body.endsCall === true);

const s2 = (await mint({}, { ip: '198.51.100.8' })).body;
const ended = await tool(s2, 'end_call', { reason: 'no_fit' });
check('end_call ends and finalizes', ended.body?.ending === true && ended.body.endsCall === true
  && (await db.doc(`webVoiceSessions/${s2.sessionId}`).get()).get('status') === 'completed');

const finalize = await call(byteWebTools, {
  sessionId: s1.sessionId, sessionToken: s1.sessionToken, action: 'finalize', reason: 'client_ended', durationSec: 93
});
const s1Final = await db.doc(`webVoiceSessions/${s1.sessionId}`).get();
check('finalize closes the record and links the transcript to the lead',
  finalize.body?.ok === true
  && s1Final.get('liveUntilMs') === 0
  && s1Final.get('durationSec') === 93
  && (await db.doc(`calls/${bookingCall.id}`).get()).get('leadId') === leadId);

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED:', failed.map(entry => entry.name).join(' | '));
  process.exitCode = 1;
}
