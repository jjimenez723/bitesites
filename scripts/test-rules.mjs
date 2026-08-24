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
  deleteDoc,
  collection,
  query,
  where,
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
  await setDoc(doc(db, 'roles', 'outbound_rep'), { role: 'outbound_rep' });
  await setDoc(doc(db, 'roles', 'outbound_manager'), { role: 'outbound_manager' });
  await setDoc(doc(db, 'roles', 'stale_claim_rep'), { role: 'outbound_rep', accountIds: ['bitesites'] });
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
  await setDoc(doc(db, 'financeAccounts', 'seeded_account'), {
    name: 'Seeded account', monthlyRetainer: 400
  });
});

const anon = testEnv.unauthenticatedContext().firestore();
const visitor = testEnv.authenticatedContext('visitor', { email: 'visitor@example.com' }).firestore();
const adminByDoc = testEnv.authenticatedContext('admin_doc', { email: 'admin@bitesites.org' }).firestore();
const adminByClaim = testEnv.authenticatedContext('admin_claim', { email: 'a2@bitesites.org', role: 'admin' }).firestore();
const financeOwner = testEnv.authenticatedContext('finance_owner', { email: 'jensy@bitesites.org', role: 'admin' }).firestore();
const financeOwnerGmail = testEnv.authenticatedContext('finance_owner_gmail', { email: 'jensyjimenez723@gmail.com', role: 'admin' }).firestore();
const clientOk = testEnv.authenticatedContext('client_ok', { email: 'c1@example.com' }).firestore();
const clientOther = testEnv.authenticatedContext('client_other', { email: 'c2@example.com' }).firestore();
const outboundRep = testEnv.authenticatedContext('outbound_rep', { email: 'rep@bitesites.org' }).firestore();
const outboundManager = testEnv.authenticatedContext('outbound_manager', { email: 'manager@bitesites.org' }).firestore();
const staleClaimRep = testEnv.authenticatedContext('stale_claim_rep', {
  email: 'stale@bitesites.org', role: 'admin', accountIds: ['stone-bellisimo']
}).firestore();

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
    userAgent: 'Mozilla/5.0',
    conversationId: 'chat_abc123'
  })));

await it('accepts privacy-limited acquisition attribution on a lead', () =>
  assertSucceeds(addDoc(collection(anon, 'leads'), {
    ...validLead(), sid: 'session-123', vid: 'visitor-123', siteVersion: 'abc123',
    attribution: {
      first: { source: 'google', medium: 'organic', campaign: 'voice-ai', landingPage: '/', capturedAt: '2026-07-28T10:00:00.000Z' },
      last: { source: 'newsletter', medium: 'email', landingPage: '/', capturedAt: '2026-07-28T11:00:00.000Z' },
      conversion: { path: '/', cta: 'Grow My Business', plan: 'Automation Builder', service: 'ai' }
    }
  })));

await it('rejects arbitrary fields hidden inside attribution', () =>
  assertFails(addDoc(collection(anon, 'leads'), {
    ...validLead(),
    attribution: {
      first: { source: 'google', medium: 'organic', landingPage: '/', capturedAt: '2026-07-28T10:00:00.000Z', email: 'stolen@example.com' },
      last: { source: 'google', medium: 'organic', landingPage: '/', capturedAt: '2026-07-28T10:00:00.000Z' },
      conversion: { path: '/' }
    }
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

await it('rejects an oversized conversation id', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), conversationId: 'x'.repeat(61) })));

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

await it('admin can append an immutable lead activity', () =>
  assertSucceeds(addDoc(collection(adminByDoc, 'leads', 'seeded_lead', 'activities'), {
    type: 'stage_change', fromStatus: 'new', toStatus: 'contacted', at: serverTimestamp()
  })));

await it('visitor cannot append or read lead activity', async () => {
  await assertFails(addDoc(collection(visitor, 'leads', 'seeded_lead', 'activities'), { type: 'tamper' }));
  await assertFails(getDocs(collection(visitor, 'leads', 'seeded_lead', 'activities')));
});

await it('admin cannot rewrite a lead email (audit integrity)', () =>
  assertFails(updateDoc(doc(adminByDoc, 'leads', 'seeded_lead'), { email: 'changed@example.com' })));

// Which book of business a lead belongs to decides which campaigns may call the
// person and, for a commission client, whose revenue it eventually claims. A
// browser that could set it could move a house lead into a client's book.
await it('admin cannot assign a lead to an account from the browser', () =>
  assertFails(updateDoc(doc(adminByDoc, 'leads', 'seeded_lead'), { accountId: 'fine-line-group' })));

await it('admin cannot move a lead between accounts', async () => {
  await assertFails(updateDoc(doc(adminByDoc, 'leads', 'seeded_lead'), { accountId: 'bitesites' }));
  // ...and an ordinary triage edit still works alongside the new check.
  await assertSucceeds(updateDoc(doc(adminByDoc, 'leads', 'seeded_lead'), { status: 'qualified' }));
});

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

// Not even an admin, and that is the point. A browser can write the role
// document but cannot mint the matching auth claim, and the rules read the
// claim first — so a half-applied revoke leaves a revoked admin still admin.
// Role changes go through the setUserRole callable or `npm run role`, both of
// which hold the Admin SDK and set both halves.
await it('admin cannot assign a role directly from the browser', () =>
  assertFails(setDoc(doc(adminByDoc, 'roles', 'visitor'), { role: 'client' })));

await it('admin cannot delete a role document directly either', () =>
  assertFails(deleteDoc(doc(adminByDoc, 'roles', 'client_ok'))));

await it('admin can still read roles to render the Users tab', () =>
  assertSucceeds(getDoc(doc(adminByDoc, 'roles', 'client_ok'))));

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

describe('client outcomes — commercial results stay admin-only');
await it('admin can record a client outcome', () =>
  assertSucceeds(setDoc(doc(adminByDoc, 'clientOutcomes', 'july'), {
    clientName: 'Acme', periodStart: new Date(), websiteLeads: 8, revenue: 12000
  })));
await it('public and clients cannot read or write client outcomes', async () => {
  await assertFails(getDocs(collection(anon, 'clientOutcomes')));
  await assertFails(setDoc(doc(clientOk, 'clientOutcomes', 'forged'), { revenue: 1 }));
});

describe('finance — admins audit, only the finance owner writes');
await it('finance owner can initialize every ledger collection', () =>
  assertSucceeds(Promise.all([
    setDoc(doc(financeOwner, 'financeSettings', 'ledger'), { version: 1 }),
    setDoc(doc(financeOwner, 'financeAccounts', 'owner_account'), { name: 'Account' }),
    setDoc(doc(financeOwner, 'financeTeam', 'owner_member'), { name: 'Member' }),
    setDoc(doc(financeOwner, 'financeExpenses', 'owner_expense'), { name: 'Expense' }),
    setDoc(doc(financeOwner, 'financeIncome', 'owner_income'), { amount: 600 }),
    setDoc(doc(financeOwner, 'financeSettlements', 'owner_payment'), { memberId: 'x', amount: 45 })
  ])));
await it('another admin can read the finance ledger', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'financeAccounts'))));
await it('the documented Gmail owner login can also edit the ledger', () =>
  assertSucceeds(updateDoc(doc(financeOwnerGmail, 'financeAccounts', 'seeded_account'), { monthlyRetainer: 450 })));
await it('another admin cannot change the finance ledger', () =>
  assertFails(updateDoc(doc(adminByDoc, 'financeAccounts', 'seeded_account'), { monthlyRetainer: 999 })));
await it('another admin can audit but not forge a team payment', async () => {
  await assertSucceeds(getDocs(collection(adminByDoc, 'financeSettlements')));
  await assertFails(setDoc(doc(adminByDoc, 'financeSettlements', 'forged'), { memberId: 'x', amount: 500 }));
});
await it('clients and the public cannot read finance data', async () => {
  await assertFails(getDocs(collection(clientOk, 'financeAccounts')));
  await assertFails(getDocs(collection(anon, 'financeExpenses')));
  await assertFails(getDocs(collection(anon, 'financeSettlements')));
});

describe('search metrics — server-written, admin-readable');
await testEnv.withSecurityRulesDisabled(async context => {
  await setDoc(doc(context.firestore(), 'searchMetrics', 'row1'), {
    day: '2026-07-28', query: 'ai receptionist', clicks: 3, impressions: 40, position: 6.2
  });
});
await it('admin can read search performance', () => assertSucceeds(getDocs(collection(adminByDoc, 'searchMetrics'))));
await it('public cannot read or forge search performance', async () => {
  await assertFails(getDocs(collection(anon, 'searchMetrics')));
  await assertFails(setDoc(doc(adminByDoc, 'searchMetrics', 'forged'), { clicks: 999 }));
});

describe('daily analytics — function-written, admin-readable');
await testEnv.withSecurityRulesDisabled(async context => {
  await setDoc(doc(context.firestore(), 'analyticsDaily', '2026-07-28'), {
    day: '2026-07-28', sessions: 12, visitors: 10, sessionCounts: { lead_created: 2 }
  });
});
await it('admin can read durable funnel totals', () => assertSucceeds(getDocs(collection(adminByDoc, 'analyticsDaily'))));
await it('public cannot read or forge durable totals', async () => {
  await assertFails(getDocs(collection(anon, 'analyticsDaily')));
  await assertFails(setDoc(doc(adminByDoc, 'analyticsDaily', 'forged'), { sessions: 999 }));
});

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

await it('accepts joined conversion and detailed funnel events', async () => {
  await assertSucceeds(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'lead_created', leadId: 'lead-123', source: 'intake_form', version: 'abc123'
  }));
  await assertSucceeds(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'form_error', label: 'Start your project', step: 'services', reason: 'missing_service'
  }));
  await assertSucceeds(addDoc(collection(anon, 'events'), {
    ...validEvent(), type: 'plan_select', plan: 'Automation Builder', service: 'ai', cta: 'Grow My Business'
  }));
});

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

// ---------------------------------------------------------------------------
// Outbound calling.
//
// These collections hold cold contacts — people who never asked to be in a
// database. The negative assertions are the load-bearing ones: an anonymous
// visitor who could create a prospect could inject a phone number straight into
// a dialing queue, and one who could read prospects would have a scraped-contact
// dump behind a public API.
//
// Note that an ADMIN cannot create a prospect from the browser either. Every
// prospect goes through the import service, which normalises, deduplicates and
// compliance-checks it; a browser-created prospect would skip all three.
// ---------------------------------------------------------------------------

await testEnv.withSecurityRulesDisabled(async context => {
  const db = context.firestore();
  await setDoc(doc(db, 'prospects', 'p1'), {
    type: 'outbound_prospect',
    name: 'Joes Plumbing',
    companyName: 'Joes Plumbing',
    phoneE164: '+12015550142',
    source: { system: 'scraper', provider: 'mock', sourceDocumentId: 'src-1' },
    lifecycle: { status: 'ready', convertedLeadId: '' },
    contactability: { doNotCall: false },
    dedupe: { canonicalKey: 'phone:+12015550142' },
    duplicate: { status: 'unique' },
    importRunId: 'run-1', accountId: 'bitesites',
    createdAt: new Date()
  });
  await setDoc(doc(db, 'prospects', 'p_stone'), {
    accountId: 'stone-bellisimo', name: 'Stone Contact', lifecycle: { status: 'ready' }
  });
  await setDoc(doc(db, 'prospects', 'p1', 'activities', 'a1'), { type: 'discovered', at: new Date() });
  await setDoc(doc(db, 'outboundCampaigns', 'camp1'), { accountId: 'bitesites', name: 'Test', status: 'draft', mode: 'power' });
  await setDoc(doc(db, 'outboundTargets', 'tgt1'), { accountId: 'bitesites', campaignId: 'camp1', state: 'ready' });
  await setDoc(doc(db, 'dialerSessions', 'sess1'), { accountId: 'bitesites', campaignId: 'camp1', userUid: 'admin_doc', status: 'active' });
  await setDoc(doc(db, 'leadResearch', 'prospect_p1'), { accountId: 'bitesites', approved: false, verifiedFacts: [] });
  await setDoc(doc(db, 'consentEvidenceCandidates', 'candidate_1'), { status: 'pending_review', phoneE164: '+12015550142' });
  await setDoc(doc(db, 'consentGrants', 'grant_1'), { status: 'active', phoneE164: '+12015550142' });
  await setDoc(doc(db, 'consentGrantEvents', 'grant_1', 'events', 'issued'), { type: 'issued', at: new Date() });
  await setDoc(doc(db, 'preDialScreenings', 'screen_1'), {
    sellerAccountId: 'bitesites', phoneHash: 'hash', status: 'cleared', checkedAt: new Date()
  });
  await setDoc(doc(db, 'scrapeJobs', 'job1'), { provider: 'mock', status: 'queued' });
  await setDoc(doc(db, 'scrapeJobs', 'job1', 'results', 'r1'), { raw: { name: 'x' } });
  await setDoc(doc(db, 'importRuns', 'run1'), { sourceSystem: 'watcher_leads', status: 'completed' });
  await setDoc(doc(db, 'importRuns', 'run1', 'errors', 'e1'), { reason: 'invalid_record' });
  await setDoc(doc(db, 'outboundCallEvents', 'evt1'), { type: 'completed' });
  await setDoc(doc(db, 'calls', 'outbound_call'), {
    accountId: 'bitesites', direction: 'outbound', status: 'connected', sessionId: 'sess1', startedAt: new Date()
  });
  await setDoc(doc(db, 'calls', 'outbound_call', 'turns', 't1'), {
    role: 'contact', text: 'Hello', at: new Date(), sequence: 1
  });
});

describe('prospects — cold contacts are admin-read, server-write');

await it('anonymous visitor cannot read prospects', () =>
  assertFails(getDocs(collection(anon, 'prospects'))));

await it('a signed-in non-admin cannot read prospects', () =>
  assertFails(getDocs(collection(visitor, 'prospects'))));

await it('a client cannot read prospects', () =>
  assertFails(getDocs(collection(clientOk, 'prospects'))));

await it('admin can read prospects', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'prospects'))));

await it('unscoped outbound roles cannot read another seller’s prospect corpus', async () => {
  await assertFails(getDocs(collection(outboundRep, 'prospects')));
  await assertFails(getDocs(collection(outboundManager, 'prospects')));
});

await it('a stored outbound scope defeats a stale elevated claim', async () => {
  await assertSucceeds(getDoc(doc(staleClaimRep, 'prospects', 'p1')));
  await assertFails(getDoc(doc(staleClaimRep, 'prospects', 'p_stone')));
  await assertFails(getDocs(query(
    collection(staleClaimRep, 'prospects'), where('accountId', '==', 'stone-bellisimo')
  )));
});

await it('anonymous visitor cannot create a prospect', () =>
  assertFails(setDoc(doc(anon, 'prospects', 'injected'), {
    name: 'Injected', phoneE164: '+15550000000', lifecycle: { status: 'ready' }
  })));

await it('an anonymous visitor cannot mark themselves an outbound lead', () =>
  assertFails(addDoc(collection(anon, 'leads'), { ...validLead(), source: 'outbound' })));

await it('even an admin cannot create a prospect from the browser', () =>
  assertFails(setDoc(doc(adminByDoc, 'prospects', 'p2'), { name: 'Hand made' })));

await it('even an admin cannot delete a prospect from the browser', () =>
  assertFails(deleteDoc(doc(adminByDoc, 'prospects', 'p1'))));

await it('admin can triage a prospect’s lifecycle', () =>
  assertSucceeds(updateDoc(doc(adminByDoc, 'prospects', 'p1'), {
    lifecycle: { status: 'archived', convertedLeadId: '' },
    updatedAt: serverTimestamp()
  })));

await it('admin cannot rewrite a prospect’s source attribution', () =>
  assertFails(updateDoc(doc(adminByDoc, 'prospects', 'p1'), {
    source: { system: 'manual', provider: 'typed-by-hand' }
  })));

await it('admin cannot rewrite a prospect’s dedupe keys', () =>
  assertFails(updateDoc(doc(adminByDoc, 'prospects', 'p1'), {
    dedupe: { canonicalKey: 'phone:+19990000000' }
  })));

await it('admin cannot rewrite which import run produced a prospect', () =>
  assertFails(updateDoc(doc(adminByDoc, 'prospects', 'p1'), { importRunId: 'forged' })));

describe('prospect activities — append-only audit trail');

await it('anonymous visitor cannot read prospect activities', () =>
  assertFails(getDocs(collection(anon, 'prospects', 'p1', 'activities'))));

await it('admin can append an activity', () =>
  assertSucceeds(addDoc(collection(adminByDoc, 'prospects', 'p1', 'activities'), {
    type: 'note', at: serverTimestamp()
  })));

await it('nobody can rewrite an activity', () =>
  assertFails(updateDoc(doc(adminByDoc, 'prospects', 'p1', 'activities', 'a1'), { type: 'rewritten' })));

await it('nobody can delete an activity', () =>
  assertFails(deleteDoc(doc(adminByDoc, 'prospects', 'p1', 'activities', 'a1'))));

describe('campaigns, targets and sessions — read-only in the browser');

await it('anonymous visitor cannot read campaigns', () =>
  assertFails(getDocs(collection(anon, 'outboundCampaigns'))));

await it('admin can read campaigns', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'outboundCampaigns'))));

await it('unscoped outbound roles cannot read multi-seller dialing data', async () => {
  await assertFails(getDocs(collection(outboundRep, 'outboundCampaigns')));
  await assertFails(getDocs(collection(outboundRep, 'outboundTargets')));
  await assertFails(getDoc(doc(outboundRep, 'dialerSessions', 'sess1')));
  await assertFails(getDoc(doc(outboundRep, 'leadResearch', 'prospect_p1')));
});

await it('unscoped outbound roles cannot read calls or transcripts from any seller', async () => {
  await assertFails(getDoc(doc(outboundRep, 'calls', 'outbound_call')));
  await assertFails(getDocs(collection(outboundRep, 'calls', 'outbound_call', 'turns')));
  await assertFails(getDocs(query(
    collection(outboundManager, 'calls'),
    where('direction', '==', 'outbound'),
    where('status', '==', 'connected')
  )));
  await assertFails(getDoc(doc(outboundRep, 'calls', 'call_open')));
});

await it('outbound reps cannot rewrite server-owned dialing state', async () => {
  await assertFails(updateDoc(doc(outboundRep, 'outboundTargets', 'tgt1'), { state: 'connected' }));
  await assertFails(updateDoc(doc(outboundRep, 'dialerSessions', 'sess1'), { connectedCallId: 'forged' }));
  await assertFails(updateDoc(doc(outboundManager, 'leadResearch', 'prospect_p1'), { approved: true }));
});

// A browser that could set `status: running` would start dialing without the
// provider-capability check createOutboundCampaign performs.
await it('admin cannot start a campaign by writing the document', () =>
  assertFails(updateDoc(doc(adminByDoc, 'outboundCampaigns', 'camp1'), { status: 'running' })));

await it('admin cannot create a campaign from the browser', () =>
  assertFails(setDoc(doc(adminByDoc, 'outboundCampaigns', 'camp2'), { name: 'Hand made' })));

await it('anonymous visitor cannot read outbound targets', () =>
  assertFails(getDocs(collection(anon, 'outboundTargets'))));

await it('admin can read outbound targets', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'outboundTargets'))));

// The lock is a transactional invariant. A browser write could hand the same
// person to two representatives.
await it('admin cannot write a target’s lock from the browser', () =>
  assertFails(updateDoc(doc(adminByDoc, 'outboundTargets', 'tgt1'), { lockedBySessionId: 'mine' })));

await it('anonymous visitor cannot read dialer sessions', () =>
  assertFails(getDocs(collection(anon, 'dialerSessions'))));

await it('admin can watch a dialer session', () =>
  assertSucceeds(getDoc(doc(adminByDoc, 'dialerSessions', 'sess1'))));

await it('admin cannot claim a session winner from the browser', () =>
  assertFails(updateDoc(doc(adminByDoc, 'dialerSessions', 'sess1'), { connectedCallId: 'forged' })));

describe('research, scrape jobs and import runs');

await it('anonymous visitor cannot read lead research', () =>
  assertFails(getDocs(collection(anon, 'leadResearch'))));

await it('admin can read lead research', () =>
  assertSucceeds(getDoc(doc(adminByDoc, 'leadResearch', 'prospect_p1'))));

// Approval goes through approveLeadResearch, which is what keeps verifiedFacts
// and sources unforgeable — an admin may reword a summary, not invent a fact.
await it('admin cannot approve research by writing the document', () =>
  assertFails(updateDoc(doc(adminByDoc, 'leadResearch', 'prospect_p1'), { approved: true })));

describe('AI voice consent ledger — admin-read, server-write');

await it('only an admin can read consent evidence and grants', async () => {
  await assertSucceeds(getDoc(doc(adminByDoc, 'consentEvidenceCandidates', 'candidate_1')));
  await assertSucceeds(getDoc(doc(adminByDoc, 'consentGrants', 'grant_1')));
  await assertFails(getDoc(doc(outboundRep, 'consentGrants', 'grant_1')));
  await assertFails(getDoc(doc(anon, 'consentEvidenceCandidates', 'candidate_1')));
});

await it('no browser can forge, approve, revoke, or rewrite a consent grant', async () => {
  await assertFails(setDoc(doc(adminByDoc, 'consentEvidenceCandidates', 'candidate_forged'), { status: 'pending_review' }));
  await assertFails(updateDoc(doc(adminByDoc, 'consentGrants', 'grant_1'), { status: 'revoked' }));
  await assertFails(setDoc(doc(adminByDoc, 'consentGrantEvents', 'grant_1', 'events', 'revoked'), { type: 'revoked' }));
});

describe('pre-dial screening ledger — admin-read, server-write');

await it('only an admin can inspect a pre-dial screening result', async () => {
  await assertSucceeds(getDoc(doc(adminByDoc, 'preDialScreenings', 'screen_1')));
  await assertFails(getDoc(doc(outboundRep, 'preDialScreenings', 'screen_1')));
  await assertFails(getDoc(doc(anon, 'preDialScreenings', 'screen_1')));
});

await it('no browser can forge or extend a pre-dial clearance', async () => {
  await assertFails(setDoc(doc(adminByDoc, 'preDialScreenings', 'screen_forged'), { status: 'cleared' }));
  await assertFails(updateDoc(doc(adminByDoc, 'preDialScreenings', 'screen_1'), { expiresAt: new Date('2099-01-01') }));
});

await it('anonymous visitor cannot read scrape jobs', () =>
  assertFails(getDocs(collection(anon, 'scrapeJobs'))));

await it('admin can read scrape jobs', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'scrapeJobs'))));

await it('anonymous visitor cannot read raw scrape results', () =>
  assertFails(getDocs(collection(anon, 'scrapeJobs', 'job1', 'results'))));

await it('admin can read raw scrape results', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'scrapeJobs', 'job1', 'results'))));

await it('nobody can write a raw scrape result from the browser', () =>
  assertFails(setDoc(doc(adminByDoc, 'scrapeJobs', 'job1', 'results', 'r2'), { raw: {} })));

await it('anonymous visitor cannot read import runs', () =>
  assertFails(getDocs(collection(anon, 'importRuns'))));

await it('admin can read import runs and their errors', () =>
  assertSucceeds(getDocs(collection(adminByDoc, 'importRuns', 'run1', 'errors'))));

await it('nobody can forge an import run', () =>
  assertFails(setDoc(doc(adminByDoc, 'importRuns', 'run2'), { sourceSystem: 'forged' })));

// The idempotency ledger. Readable from the browser it would be useless; writable
// it would let a redelivered webhook be replayed.
await it('nobody can read the call-event ledger', () =>
  assertFails(getDoc(doc(adminByDoc, 'outboundCallEvents', 'evt1'))));

await it('nobody can write the call-event ledger', () =>
  assertFails(setDoc(doc(adminByDoc, 'outboundCallEvents', 'evt2'), { type: 'forged' })));

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
