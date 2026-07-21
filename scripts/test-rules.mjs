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
