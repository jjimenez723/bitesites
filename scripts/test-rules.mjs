// Security-rules test suite.
//
// Run with:  npm run test:rules
// (which wraps this in `firebase emulators:exec`, so no live project is touched)
//
// The point of these tests is the negative cases. `leads` accepts writes from
// anonymous visitors, so every assertion that a malformed or malicious write is
// REJECTED is load-bearing — if one of them starts passing, the collection has
// become writable in a way it should not be.

import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from '@firebase/rules-unit-testing';
import {
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  collection,
  serverTimestamp
} from 'firebase/firestore';

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-bitesites',
  firestore: {
    rules: readFileSync('firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8085
  }
});

// A submission the public form would actually produce.
const validLead = () => ({
  name: 'Dana Whitfield',
  email: 'dana@example.com',
  businessSize: 'small',
  services: ['web_development'],
  preferredContactMethod: 'email',
  source: 'intake_form',
  status: 'new',
  createdAt: serverTimestamp()
});

let passed = 0;
const failures = [];

async function it(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label}`);
    console.log(`      ${error.message?.split('\n')[0]}`);
  }
}

const describe = label => console.log(`\n${label}`);

// --- seed the role/project fixtures that the rules read -----------------------
await testEnv.withSecurityRulesDisabled(async context => {
  const db = context.firestore();
  await setDoc(doc(db, 'roles', 'admin_doc'), { role: 'admin' });
  await setDoc(doc(db, 'roles', 'client_ok'), { role: 'client' });
  await setDoc(doc(db, 'roles', 'client_other'), { role: 'client' });
  await setDoc(doc(db, 'users', 'someone_else'), {
    email: 'someone@example.com',
    status: 'pending'
  });
  await setDoc(doc(db, 'leads', 'seeded_lead'), {
    ...validLead(),
    createdAt: new Date()
  });
  // A Byte lead as recordVoiceCall writes it: server-side source, and often no
  // email at all, because a caller leaves a phone number.
  await setDoc(doc(db, 'leads', 'seeded_voice_lead'), {
    name: 'Sam Reyes',
    email: '',
    phone: '+15550199',
    businessSize: '',
    services: [],
    preferredContactMethod: 'phone',
    source: 'byte_voice',
    status: 'new',
    createdAt: new Date(),
    voice: { callId: 'call1', providerCallId: 'ghl-1', durationSec: 95 }
  });
  await setDoc(doc(db, 'projects', 'proj1'), {
    name: 'Site build',
    clientUids: ['client_ok']
  });
});

const anon = testEnv.unauthenticatedContext().firestore();
const visitor = testEnv.authenticatedContext('visitor', { email: 'visitor@example.com' }).firestore();
const adminByDoc = testEnv.authenticatedContext('admin_doc', { email: 'admin@bitesites.org' }).firestore();
const adminByClaim = testEnv.authenticatedContext('admin_claim', { email: 'a2@bitesites.org', role: 'admin' }).firestore();
const clientOk = testEnv.authenticatedContext('client_ok', { email: 'c1@example.com' }).firestore();
const clientOther = testEnv.authenticatedContext('client_other', { email: 'c2@example.com' }).firestore();

describe('leads — public submission');
await it('anonymous visitor can submit a valid lead', () =>
  assertSucceeds(addDoc(collection(anon, 'leads'), validLead())));

await it('signed-in visitor can submit a valid lead', () =>
  assertSucceeds(addDoc(collection(visitor, 'leads'), validLead())));

await it('accepts a full submission with every optional field', () =>
  assertSucceeds(addDoc(collection(anon, 'leads'), {
    ...validLead(),
    phone: '555-0100',
    businessName: 'Whitfield Co',
    roleInCompany: 'Owner',
    urgencyTag: 'asap',
    projectDetails: 'We need a new marketing site.',
    customAnswers: { businessSize: 'about a dozen of us' },
    pagePath: '/',
    referrer: 'https://google.com',
    userAgent: 'Mozilla/5.0'
  })));

describe('leads — rejected submissions');
await it('rejects an unknown field (no using the DB as free storage)', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), payload: 'x'.repeat(500) })));

await it('rejects a client-chosen status', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), status: 'converted' })));

await it('rejects a forged createdAt', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), createdAt: new Date(0) })));

await it('rejects a malformed email', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), email: 'not-an-email' })));

await it('rejects an out-of-vocabulary businessSize', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), businessSize: 'gigantic' })));

await it('rejects an out-of-vocabulary service', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), services: ['crypto_mining'] })));

await it('rejects an empty services list', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), services: [] })));

await it('rejects an oversized projectDetails', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), projectDetails: 'x'.repeat(5001) })));

await it('rejects an oversized name', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), name: 'x'.repeat(121) })));

await it('rejects a missing required field', () => {
  const { businessSize, ...withoutSize } = validLead();
  return assertFails(addDoc(collection(anon, 'leads'), withoutSize));
});

await it('rejects customAnswers with an unexpected key', () =>
  assertFails(addDoc(collection(anon, 'leads'), {
    ...validLead(),
    customAnswers: { smuggled: 'x'.repeat(400) }
  })));

await it('rejects an oversized customAnswers value', () =>
  assertFails(addDoc(collection(anon, 'leads'), {
    ...validLead(),
    customAnswers: { businessSize: 'x'.repeat(501) }
  })));

await it('rejects a non-string name (type confusion)', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), name: { $ne: null } })));

describe('leads — nobody reads them but an admin');
await it('anonymous visitor cannot read leads', () =>
  assertFails(getDocs(collection(anon, 'leads'))));

await it('signed-in non-admin cannot read leads', () =>
  assertFails(getDocs(collection(visitor, 'leads'))));

await it('client cannot read leads', () =>
  assertFails(getDocs(collection(clientOk, 'leads'))));

await it('anonymous visitor cannot delete a lead', () =>
  assertFails(setDoc(doc(anon, 'leads', 'seeded_lead'), validLead())));

await it('admin (via roles doc) can read leads', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'leads'))));

await it('admin (via custom claim) can read leads', () =>
  assertSucceeds(getDocs(collection(adminByClaim, 'leads'))));

await it('admin can triage a lead status', () =>
  assertSucceeds(updateDoc(doc(adminByDoc, 'leads', 'seeded_lead'), { status: 'contacted' })));

await it('admin cannot rewrite a lead email (audit integrity)', () =>
  assertFails(updateDoc(doc(adminByDoc, 'leads', 'seeded_lead'), { email: 'changed@example.com' })));

// The update rule compares `email` against the stored value, so a Byte lead has
// to carry the key even when the call captured only a phone number — a missing
// one would error the rule out and leave the lead permanently un-triageable.
await it('admin can triage a phone-only Byte lead', () =>
  assertSucceeds(updateDoc(doc(adminByDoc, 'leads', 'seeded_voice_lead'), { status: 'contacted' })));

await it('visitor cannot forge a lead that looks like a booked call', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), source: 'byte_voice' })));

describe('roles — privilege escalation is impossible');
await it('user cannot grant themselves a role', () =>
  assertFails(setDoc(doc(visitor, 'roles', 'visitor'), { role: 'admin' })));

await it('user cannot grant anyone else a role', () =>
  assertFails(setDoc(doc(visitor, 'roles', 'someone_else'), { role: 'admin' })));

await it('client cannot promote themselves to admin', () =>
  assertFails(setDoc(doc(clientOk, 'roles', 'client_ok'), { role: 'admin' })));

await it('user can read their own role', () =>
  assertSucceeds(getDoc(doc(clientOk, 'roles', 'client_ok'))));

await it('user cannot read someone else\'s role', () =>
  assertFails(getDoc(doc(visitor, 'roles', 'admin_doc'))));

await it('admin can assign a role', () =>
  assertSucceeds(setDoc(doc(adminByDoc, 'roles', 'visitor'), { role: 'client' })));

describe('users — self-registration starts pending');
await it('user can create their own pending profile', () =>
  assertSucceeds(setDoc(doc(visitor, 'users', 'visitor'), {
    email: 'visitor@example.com',
    displayName: 'Visitor',
    status: 'pending',
    createdAt: serverTimestamp()
  })));

await it('user cannot self-register as approved', () =>
  assertFails(setDoc(doc(clientOther, 'users', 'client_other'), {
    email: 'c2@example.com',
    status: 'approved',
    createdAt: serverTimestamp()
  })));

await it('user cannot create a profile under another uid', () =>
  assertFails(setDoc(doc(visitor, 'users', 'someone_else'), {
    email: 'visitor@example.com',
    status: 'pending',
    createdAt: serverTimestamp()
  })));

await it('user cannot register with an email that is not theirs', () =>
  assertFails(setDoc(doc(clientOther, 'users', 'client_other'), {
    email: 'ceo@bitesites.org',
    status: 'pending',
    createdAt: serverTimestamp()
  })));

await it('user cannot approve themselves after the fact', () =>
  assertFails(updateDoc(doc(visitor, 'users', 'visitor'), { status: 'approved' })));

await it('user can update their own contact details', () =>
  assertSucceeds(updateDoc(doc(visitor, 'users', 'visitor'), { company: 'Acme' })));

await it('user cannot read another user\'s profile', () =>
  assertFails(getDoc(doc(visitor, 'users', 'someone_else'))));

await it('admin can approve a pending user', () =>
  assertSucceeds(updateDoc(doc(adminByDoc, 'users', 'visitor'), { status: 'approved' })));

describe('projects — clients see only their own');
await it('assigned client can read their project', () =>
  assertSucceeds(getDoc(doc(clientOk, 'projects', 'proj1'))));

await it('unassigned client cannot read the project', () =>
  assertFails(getDoc(doc(clientOther, 'projects', 'proj1'))));

await it('anonymous visitor cannot read projects', () =>
  assertFails(getDoc(doc(anon, 'projects', 'proj1'))));

await it('client cannot write a project', () =>
  assertFails(updateDoc(doc(clientOk, 'projects', 'proj1'), { name: 'hijacked' })));

await it('admin can write a project', () =>
  assertSucceeds(updateDoc(doc(adminByDoc, 'projects', 'proj1'), { name: 'Site build v2' })));

// --------------------------------------------------------------- analytics
// `events` takes anonymous writes from every visitor, so it has the same threat
// model as `leads`: the negative cases below are what stop it becoming free,
// unbounded object storage.

const validEvent = () => ({
  type: 'page_view',
  sid: 'session-1',
  vid: 'visitor-1',
  path: '/',
  day: '2026-07-21',
  device: 'desktop',
  ts: serverTimestamp()
});

describe('events — anonymous analytics writes');
await it('anonymous visitor can record an event', () =>
  assertSucceeds(addDoc(collection(anon, 'events'), validEvent())));

await it('accepts a click with position and label', () =>
  assertSucceeds(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'click', label: 'Start Your Project',
    section: 'start', interactive: true, x: 0.5, y: 0.25, vw: 1440, vh: 900
  })));

// The portfolio section emits these three, and a type the client sends but the
// rules reject takes down the entire writeBatch it rides in — every unrelated
// event alongside it included. These assert the exact shapes src/main.jsx
// builds, so the two whitelists cannot drift apart unnoticed.
await it('accepts a portfolio project view with dwell', () =>
  assertSucceeds(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'portfolio_project_view',
    label: 'StockRoom NJ', section: 'portfolio', value: 8400
  })));

await it('accepts a portfolio progress milestone', () =>
  assertSucceeds(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'portfolio_progress',
    label: 'Rutgers Newark Bodega Project', section: 'portfolio', value: 75
  })));

await it('accepts a portfolio video health report', () =>
  assertSucceeds(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'portfolio_video_health',
    label: 'Nexus Verium', section: 'portfolio:stalled:2', value: 1250
  })));

await it('accepts an outbound click attributed to a project', () =>
  assertSucceeds(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'outbound', label: 'Visit the live project',
    href: 'https://stockroomnj.com', section: 'portfolio:StockRoom NJ'
  })));

// analyticsDuration() clamps to this ceiling before enqueueing. If that clamp is
// ever removed, a long dwell starts failing here rather than in production.
await it('rejects a dwell past the value ceiling', () =>
  assertFails(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'portfolio_project_view', label: 'StockRoom NJ', value: 100001
  })));

await it('rejects an unknown event type', () =>
  assertFails(addDoc(collection(anon, 'events'), { ...validEvent(), type: 'exfiltrate' })));

await it('rejects an unknown field', () =>
  assertFails(addDoc(collection(anon, 'events'), { ...validEvent(), payload: 'x'.repeat(400) })));

await it('rejects a forged timestamp', () =>
  assertFails(addDoc(collection(anon, 'events'), { ...validEvent(), ts: new Date(0) })));

await it('rejects a malformed day key', () =>
  assertFails(addDoc(collection(anon, 'events'), { ...validEvent(), day: 'yesterday' })));

await it('rejects an unknown device class', () =>
  assertFails(addDoc(collection(anon, 'events'), { ...validEvent(), device: 'fridge' })));

await it('rejects a click position outside 0..1', () =>
  assertFails(addDoc(collection(anon, 'events'), { ...validEvent(), type: 'click', x: 42 })));

await it('rejects an oversized label', () =>
  assertFails(addDoc(collection(anon, 'events'), { ...validEvent(), type: 'click', label: 'x'.repeat(81) })));

await it('anonymous visitor cannot read events back', () =>
  assertFails(getDocs(collection(anon, 'events'))));

await it('admin can read events', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'events'))));

// ------------------------------------------------------------ conversations

const openChat = () => ({
  agent: 'bit', channel: 'chat', status: 'open',
  startedAt: serverTimestamp(), sid: 'session-1', path: '/'
});

const openCall = () => ({
  agent: 'byte', channel: 'voice', status: 'open', provider: 'gohighlevel',
  startedAt: serverTimestamp(), sid: 'session-1', path: '/'
});

await testEnv.withSecurityRulesDisabled(async context => {
  const db = context.firestore();
  await setDoc(doc(db, 'chats', 'chat_open'), { ...openChat(), startedAt: new Date() });
  await setDoc(doc(db, 'chats', 'chat_done'), {
    ...openChat(), startedAt: new Date(), status: 'converted', endedAt: new Date()
  });
  await setDoc(doc(db, 'calls', 'call_open'), { ...openCall(), startedAt: new Date() });
});

describe('chats — a visitor may open and append, never read');
await it('anonymous visitor can open a chat', () =>
  assertSucceeds(addDoc(collection(anon, 'chats'), openChat())));

await it('rejects a chat claiming to be the voice agent', () =>
  assertFails(addDoc(collection(anon, 'chats'), { ...openChat(), agent: 'byte' })));

await it('rejects a chat that starts already closed', () =>
  assertFails(addDoc(collection(anon, 'chats'), { ...openChat(), status: 'converted' })));

await it('rejects a backdated chat', () =>
  assertFails(addDoc(collection(anon, 'chats'), { ...openChat(), startedAt: new Date(0) })));

await it('anonymous visitor can append a message', () =>
  assertSucceeds(addDoc(collection(anon, 'chats', 'chat_open', 'messages'), {
    role: 'visitor', kind: 'text', text: 'I need a website', at: serverTimestamp()
  })));

await it('rejects a message with an unknown kind', () =>
  assertFails(addDoc(collection(anon, 'chats', 'chat_open', 'messages'), {
    role: 'visitor', kind: 'exfiltrate', text: 'x', at: serverTimestamp()
  })));

await it('rejects an oversized message', () =>
  assertFails(addDoc(collection(anon, 'chats', 'chat_open', 'messages'), {
    role: 'visitor', kind: 'text', text: 'x'.repeat(2001), at: serverTimestamp()
  })));

await it('anonymous visitor cannot read a chat', () =>
  assertFails(getDoc(doc(anon, 'chats', 'chat_open'))));

await it('anonymous visitor cannot read its messages', () =>
  assertFails(getDocs(collection(anon, 'chats', 'chat_open', 'messages'))));

await it('admin can read chats', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'chats'))));

await it('visitor can close their own chat out', () =>
  assertSucceeds(updateDoc(doc(anon, 'chats', 'chat_open'), {
    status: 'converted', endedAt: serverTimestamp(), messageCount: 6
  })));

await it('close-out cannot reassign the session', () =>
  assertFails(updateDoc(doc(anon, 'chats', 'chat_done'), {
    status: 'abandoned', endedAt: serverTimestamp(), sid: 'someone-else'
  })));

await it('a closed chat cannot be reopened or re-closed', () =>
  assertFails(updateDoc(doc(anon, 'chats', 'chat_done'), {
    status: 'abandoned', endedAt: serverTimestamp()
  })));

await it('a message cannot be edited after the fact', () =>
  assertFails(updateDoc(doc(anon, 'chats', 'chat_open', 'messages', 'nope'), { text: 'rewritten' })));

describe('calls — same shape, voice agent');
await it('anonymous visitor can open a call', () =>
  assertSucceeds(addDoc(collection(anon, 'calls'), openCall())));

await it('rejects a call claiming to be the chat agent', () =>
  assertFails(addDoc(collection(anon, 'calls'), { ...openCall(), agent: 'bit' })));

await it('anonymous visitor can log a state turn', () =>
  assertSucceeds(addDoc(collection(anon, 'calls', 'call_open', 'turns'), {
    kind: 'state', state: 'listening', at: serverTimestamp()
  })));

await it('rejects an implausible call duration', () =>
  assertFails(updateDoc(doc(anon, 'calls', 'call_open'), {
    status: 'completed', endedAt: serverTimestamp(), durationSec: 999999
  })));

await it('anonymous visitor cannot read calls', () =>
  assertFails(getDocs(collection(anon, 'calls'))));

await it('admin can read calls', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'calls'))));

describe('catch-all — undeclared collections are closed');
await it('nobody can write to an arbitrary collection', () =>
  assertFails(setDoc(doc(anon, 'anything', 'x'), { a: 1 })));

await it('an admin cannot write to an arbitrary collection either', () =>
  assertFails(setDoc(doc(adminByDoc, 'anything', 'x'), { a: 1 })));

await testEnv.cleanup();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailed assertions:');
  for (const { label } of failures) console.log(`  - ${label}`);
  process.exit(1);
}
