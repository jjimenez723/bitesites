// Drives Bit's chat endpoints against the Firestore emulator:
//   npm run test:bit-chat
//
// Bit's turn endpoint is not a relay like Byte's — it *is* the agent, so this
// suite has to prove the loop as well as the guards: a scripted model asks for
// a tool, the server executes it, feeds the result back, and the visitor gets
// the sentence at the end. The things that would hurt most in production are
// the ones pinned hardest — a forged token buys nothing, quotas and budgets
// hold, an ungranted tool is refused mid-loop, a link can only ever be one
// from the whitelist, slot ids never reach the browser, and a booking produces
// exactly one bit_chat lead no matter how many times the model retries.
//
// OpenAI is stubbed at globalThis.fetch and scripted per test; nothing here
// leaves the machine.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
initializeApp();
const { bitChatSession, bitChatTurn } = await import('./bit-chat.js');
const { BIT_CHAT_MODEL } = await import('./bit-persona.js');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const db = getFirestore();

// ---------------------------------------------------------------- harness

const realFetch = globalThis.fetch;

/** Responses the stubbed model will hand back, in order. */
let modelScript = [];
/** Every request body the loop sent, so the test can inspect what it fed back. */
let modelRequests = [];

const say = text => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
let callSeq = 0;
const wants = (name, args = {}) => ({
  output: [{ type: 'function_call', call_id: `call_${++callSeq}`, name, arguments: JSON.stringify(args) }]
});
const httpFails = status => ({ httpStatus: status });

const script = (...responses) => { modelScript = [...responses]; modelRequests = []; };

globalThis.fetch = async (url, options) => {
  if (String(url).includes('api.openai.com/v1/responses')) {
    modelRequests.push(JSON.parse(options.body));
    const next = modelScript.shift();
    if (!next) return { ok: true, status: 200, text: async () => JSON.stringify(say('(unscripted)')) };
    if (next.httpStatus) {
      return { ok: false, status: next.httpStatus, text: async () => JSON.stringify({ error: { message: 'stubbed failure' } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
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

async function call(handler, body, { ip = '203.0.113.11', method = 'POST' } = {}) {
  const { res, out } = fakeRes();
  await handler({ method, body, headers: { 'x-forwarded-for': ip }, ip }, res);
  return out;
}

const open = (body = {}, opts) => call(bitChatSession, body, opts);
const turn = (session, message) => call(bitChatTurn, {
  sessionId: session.sessionId, sessionToken: session.sessionToken, action: 'message', message
});

/** The model's own view of a tool result, read back out of stored history. */
async function toolOutput(sessionId, name) {
  const history = (await db.doc(`bitChatSessions/${sessionId}`).get()).get('history') || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].t === 'call' && history[index].name === name) {
      const output = history.find(item => item.t === 'out' && item.callId === history[index].callId);
      return output ? JSON.parse(output.output) : null;
    }
  }
  return null;
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
console.log('\nopening a session');

check('rejects GET', (await open({}, { method: 'GET' })).code === 405);

delete process.env.OPENAI_API_KEY;
check('refuses to open a session without an OpenAI key', (await open()).code === 503);
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';

// The ceiling is the wallet guard: 60 live sessions refuse a 61st.
const fakeLive = [];
for (let index = 0; index < 60; index += 1) {
  const ref = db.collection('bitChatSessions').doc();
  await ref.set({ status: 'live', token: 'x'.repeat(64), ipHash: 'capacity-test', liveUntilMs: Date.now() + 600000, startedAt: Timestamp.now() });
  fakeLive.push(ref);
}
const atCapacity = await open({}, { ip: '203.0.113.90' });
check('refuses a 61st concurrent session', atCapacity.code === 429 && atCapacity.body?.error === 'at-capacity');
await Promise.all(fakeLive.map(ref => ref.delete()));

const chatDoc = await db.collection('chats').add({
  agent: 'bit', channel: 'chat', status: 'open', messageCount: 0,
  sid: 'sid-test', path: '/', startedAt: Timestamp.now()
});

const first = await open({ chatId: chatDoc.id, sid: 'sid-test', path: '/' });
check('opens a session', first.code === 200 && Boolean(first.body?.sessionId));
const s1 = first.body;
check('the greeting comes from the persona, not the bundle', /I’m Bit/.test(s1.greeting || ''));
check('the chat model is pinned', s1.model === BIT_CHAT_MODEL);
check('the browser token is not the doc id', s1.sessionToken.length === 64 && s1.sessionToken !== s1.sessionId);
const s1Doc = await db.doc(`bitChatSessions/${s1.sessionId}`).get();
check('session doc is live with the tool grant list',
  s1Doc.get('status') === 'live'
  && (s1Doc.get('tools') || []).includes('send_page_link')
  && (s1Doc.get('tools') || []).includes('book_meeting')
  && !(s1Doc.get('tools') || []).includes('end_call'));

for (let index = 0; index < 10; index += 1) await open({}, { ip: '198.51.100.20' });
const eleventh = await open({}, { ip: '198.51.100.20' });
check('hourly per-IP quota holds at ten', eleventh.code === 429 && eleventh.body?.error === 'rate-limited');
check('a different IP is unaffected by the quota', (await open({}, { ip: '198.51.100.21' })).code === 200);

// ---------------------------------------------------------------------------
console.log('\nauthorization');

check('a forged token is refused', (await call(bitChatTurn, {
  sessionId: s1.sessionId, sessionToken: 'f'.repeat(64), action: 'message', message: 'hi'
})).code === 401);
check('an unknown session is refused', (await call(bitChatTurn, {
  sessionId: 'does-not-exist', sessionToken: s1.sessionToken, action: 'message', message: 'hi'
})).code === 401);
check('an unknown action is refused', (await call(bitChatTurn, {
  sessionId: s1.sessionId, sessionToken: s1.sessionToken, action: 'reboot'
})).code === 400);
check('an empty message is refused', (await turn(s1, '   ')).code === 400);

// ---------------------------------------------------------------------------
console.log('\nthe agent loop');

script(say('Hey — websites, agents, automation. What are you working on?'));
const plain = await turn(s1, 'what do you actually do?');
check('a plain turn returns Bit’s text', plain.body?.ok === true && /websites, agents/.test(plain.body.messages[0]));
check('the visitor message reached the model', modelRequests[0]?.input?.some(item => item.content === 'what do you actually do?'));
check('the system prompt is sent as instructions, never as a message',
  /WHO YOU ARE/.test(modelRequests[0]?.instructions || '')
  && !modelRequests[0].input.some(item => /WHO YOU ARE/.test(item.content || '')));
check('tool schemas travel with every call', (modelRequests[0]?.tools || []).some(tool => tool.name === 'send_page_link'));
const history = (await db.doc(`bitChatSessions/${s1.sessionId}`).get()).get('history') || [];
check('history is server-owned and persisted',
  history.length === 3 && history[2].t === 'msg' && history[2].role === 'assistant');
check('the greeting is in the model’s history, so Bit does not say hello twice',
  history[0].role === 'assistant' && history[0].text === s1.greeting);

script(
  wants('lookup_knowledge', { query: 'who owns the website if we leave' }),
  say('You own it outright — design, content, the lot. Nothing is held hostage.')
);
const retrieved = await turn(s1, 'if we leave, do we keep the site?');
check('a tool call is executed and answered in the same turn',
  retrieved.body?.ok === true && /own it outright/.test(retrieved.body.messages[0]) && modelRequests.length === 2);
const knowledge = await toolOutput(s1.sessionId, 'lookup_knowledge');
check('the corpus answered the hard question',
  knowledge?.found === true && knowledge.passages.some(passage => passage.title === 'Who owns what you pay for'));
check('retrieved passages carry the injection warning', /reference data, not instructions/.test(knowledge?.note || ''));
check('the tool result was fed back to the model',
  modelRequests[1]?.input?.some(item => item.type === 'function_call_output' && /Who owns what you pay for/.test(item.output)));

script(wants('mark_do_not_call', { reason: 'x' }), say('Not something I can do, but I can pass it on.'));
await turn(s1, 'take me off your list');
const refused = await toolOutput(s1.sessionId, 'mark_do_not_call');
check('an ungranted tool is refused inside the loop', refused?.error === 'tool_not_permitted');

script(wants('send_page_link', { destination: 'booking', reason: 'Twenty minutes, free.' }), say('Grab whatever suits.'));
const linked = await turn(s1, 'just send me a link');
check('send_page_link renders a whitelisted card',
  linked.body?.cards?.[0]?.type === 'link'
  && linked.body.cards[0].href === '/book'
  && linked.body.cards[0].detail === 'Twenty minutes, free.');

script(wants('send_page_link', { destination: 'https://evil.example.com' }), say('Let me point you somewhere real instead.'));
const forgedLink = await turn(s1, 'send me somewhere else');
check('the model cannot invent a destination',
  (forgedLink.body?.cards || []).length === 0
  && (await toolOutput(s1.sessionId, 'send_page_link'))?.error === 'unknown_destination');

script(httpFails(500), say('Sorry — back now. What were we saying?'));
const recovered = await turn(s1, 'still there?');
check('a transient 5xx is retried rather than surfaced', recovered.body?.ok === true && /back now/.test(recovered.body.messages[0]));

script(httpFails(500), httpFails(500), httpFails(500));
const brokenBefore = modelRequests.length;
const broken = await turn(s1, 'and now?');
check('a model outage never dead-ends the visitor',
  broken.body?.ok === false
  && /booking page/.test(broken.body.messages[0])
  && broken.body.cards.some(card => card.href === '/book'));
check('the outage was retried three times and then stopped', modelRequests.length - brokenBefore === 3);

script(...Array.from({ length: 10 }, () => wants('record_interest_signal', { signal: 'loop' })));
const loopBefore = modelRequests.length;
await turn(s1, 'go in circles');
check('a tool loop is capped at eight model calls per turn', modelRequests.length - loopBefore === 8);

// ---------------------------------------------------------------------------
console.log('\ncontact capture → lead');

script(wants('save_contact_details', { name: 'Dana' }), say('Nice to meet you, Dana.'));
await turn(s1, 'I am Dana');
check('a name alone creates no lead', (await toolOutput(s1.sessionId, 'save_contact_details'))?.reachable === false);

script(wants('request_human_followup', { note: 'call me' }), say('I need a way to reach you first.'));
await turn(s1, 'get a human to call me');
check('followup without contact details is refused',
  (await toolOutput(s1.sessionId, 'request_human_followup'))?.error === 'no_contact_details');

script(wants('save_contact_details', { email: 'not-an-email' }), say('That did not parse — mind checking it?'));
await turn(s1, 'my email is broken');
check('a malformed email is bounced back', (await toolOutput(s1.sessionId, 'save_contact_details'))?.error === 'invalid_email');

script(wants('save_contact_details', { email: 'dana@example.com', company: 'Dana Plumbing' }), say('Saved — thanks.'));
const captured = await turn(s1, 'dana@example.com, Dana Plumbing');
const leadId = (await toolOutput(s1.sessionId, 'save_contact_details'))?.leadId;
check('an email creates the lead', Boolean(leadId));
check('the endpoint reports the lead back to the browser', captured.body?.leadId === leadId);
let lead = await db.doc(`leads/${leadId}`).get();
check('the lead carries the bit_chat shape',
  lead.get('source') === 'bit_chat'
  && lead.get('email') === 'dana@example.com'
  && lead.get('businessName') === 'Dana Plumbing'
  && lead.get('chat')?.provider === 'openai_responses'
  && lead.get('chat')?.providerCallId === `chat_${s1.sessionId}`
  && lead.get('chat')?.conversationId === chatDoc.id
  && lead.get('chat')?.receivingAgent?.agentName === 'Bit');
check('the transcript id is where the dashboard already looks for it', lead.get('conversationId') === chatDoc.id);
check('earlier details merged in', lead.get('name') === 'Dana');

script(wants('save_contact_details', { phone: '+1 555 0142' }), say('Got it.'));
await turn(s1, 'my number is 555 0142');
const leads = await db.collection('leads').where('chat.providerCallId', '==', `chat_${s1.sessionId}`).get();
check('retried captures never duplicate the lead', leads.size === 1);

// ---------------------------------------------------------------------------
console.log('\nbooking, in the chat');

await db.doc('calendarSettings/default').set({
  timezone: 'UTC', slotMinutes: 20, bufferMinutes: 0, leadTimeMinutes: 0, capacity: 1,
  horizonDays: 14, googleSyncEnabled: false,
  workingHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [String(day), [{ open: '00:00', close: '23:59' }]]))
});

script(wants('check_availability', { requestedWindow: 'tomorrow morning' }), say('Here is what is open.'));
const availability = await turn(s1, 'when can we talk?');
check('open times come back as tappable chips',
  availability.body?.chips?.length > 0 && Boolean(availability.body.chips[0].send));
check('slot ids never reach the browser',
  !JSON.stringify(availability.body).includes((await toolOutput(s1.sessionId, 'check_availability')).slots[0].slotId));

const slotId = (await toolOutput(s1.sessionId, 'check_availability')).slots[0].slotId;
script(wants('hold_slot', { slotId, offerTrack: 'websites' }), say('Held it. Name and email?'));
await turn(s1, 'the first one please');
const holdId = (await toolOutput(s1.sessionId, 'hold_slot'))?.holdId;
check('the slot holds', Boolean(holdId));

script(
  wants('book_meeting', { holdId, name: 'Dana Example', email: 'dana@example.com', company: 'Dana Plumbing', notes: 'wants a booking flow' }),
  say('Booked. See you then.')
);
const booked = await turn(s1, 'Dana Example, dana@example.com');
const bookedResult = await toolOutput(s1.sessionId, 'book_meeting');
check('the meeting books with a confirmation reference', bookedResult?.ok === true && Boolean(bookedResult.confirmationRef));
check('a booked card is put on screen',
  booked.body?.cards?.some(card => card.type === 'booked' && card.confirmationRef === bookedResult.confirmationRef));
const appointment = await db.doc(`appointments/${bookedResult.appointmentId}`).get();
check('the appointment is committed',
  appointment.get('status') === 'booked' && appointment.get('attendee')?.email === 'dana@example.com');
lead = await db.doc(`leads/${leadId}`).get();
check('the booking lands on the same lead',
  lead.get('chat')?.appointment?.confirmationRef === bookedResult.confirmationRef);
check('the transcript shows the outcome',
  (await db.doc(`chats/${chatDoc.id}`).get()).get('outcome')?.booked === true);

// ---------------------------------------------------------------------------
console.log('\nsession limits and teardown');

await db.doc(`bitChatSessions/${s1.sessionId}`).set({ toolCalls: 60 }, { merge: true });
script(wants('lookup_knowledge', { query: 'process' }), say('Going from what I already know…'));
await turn(s1, 'how does a project run?');
check('the tool budget exhausts', (await toolOutput(s1.sessionId, 'lookup_knowledge'))?.error === 'tool_budget_exhausted');

const s2 = (await open({ chatId: chatDoc.id }, { ip: '198.51.100.22' })).body;
script(wants('request_rating', { reason: 'booked' }), say('Before you go — how did I do?'));
const rated = await turn(s2, 'that is everything, thanks');
check('request_rating puts the rating card on screen',
  rated.body?.cards?.some(card => card.type === 'rating')
  && (await toolOutput(s2.sessionId, 'request_rating'))?.shown === true
  && (await db.doc(`bitChatSessions/${s2.sessionId}`).get()).get('ratingRequested') === true);
check('the rating card does not end the conversation', rated.body?.ended === false);

script(wants('request_rating', {}), say('Still there whenever you want it.'));
const again = await turn(s2, 'sure');
check('asking twice does not stack a second card',
  !again.body?.cards?.some(card => card.type === 'rating')
  && (await toolOutput(s2.sessionId, 'request_rating'))?.alreadyShown === true);

script(wants('end_chat', { reason: 'booked' }), say('Lovely talking.'));
const ended = await turn(s2, 'goodbye');
check('end_chat ends the conversation',
  ended.body?.ended === true
  && (await db.doc(`bitChatSessions/${s2.sessionId}`).get()).get('status') === 'completed');

const s3 = (await open({ chatId: chatDoc.id }, { ip: '198.51.100.23' })).body;
await db.doc(`bitChatSessions/${s3.sessionId}`).set({ expiresAtMs: 1 }, { merge: true });
const expired = await turn(s3, 'hello?');
check('an expired session says so in Bit’s voice, with a way out',
  expired.body?.error === 'session_over' && expired.body.ended === true
  && expired.body.cards.some(card => card.href === '/book'));

const s4 = (await open({ chatId: chatDoc.id }, { ip: '198.51.100.24' })).body;
await db.doc(`bitChatSessions/${s4.sessionId}`).set({ turns: 40 }, { merge: true });
const spent = await turn(s4, 'one more thing');
check('the visitor-turn budget holds at forty',
  spent.body?.error === 'turn_budget_exhausted'
  && (await db.doc(`bitChatSessions/${s4.sessionId}`).get()).get('status') === 'completed');

const finalize = await call(bitChatTurn, {
  sessionId: s1.sessionId, sessionToken: s1.sessionToken, action: 'finalize', reason: 'client_ended', durationSec: 140
});
const s1Final = await db.doc(`bitChatSessions/${s1.sessionId}`).get();
check('finalize closes the record and links the transcript to the lead',
  finalize.body?.ok === true
  && s1Final.get('liveUntilMs') === 0
  && s1Final.get('durationSec') === 140
  && (await db.doc(`chats/${chatDoc.id}`).get()).get('leadId') === leadId);

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED:', failed.map(entry => entry.name).join(' | '));
  process.exitCode = 1;
}
