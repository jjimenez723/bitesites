import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createQuestionnaireSessionCore, getQuestionnaireSessionCore, submitQuestionnaireCore, validateQuestionnaireAnswers } from './questionnaire.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run this test through the Firestore emulator.');
if (!getApps().length) initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();
const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGH12345678';
const nowMs = Date.UTC(2026, 8, 8, 12);
const validAnswers = () => ({
  helpWith: ['website', 'automation'], businessName: 'Acme Studio', businessSummary: 'A local design and fabrication studio.',
  website: 'https://acme.example/', location: 'North Jersey', obstacles: ['slow_followup'], obstacleDetails: '',
  wins: ['booked_appointments'], winDetails: '', timing: 'within_month', budget: '',
  links: [{ label: 'Reference', url: 'https://example.com/reference' }], anythingElse: 'Weekday calls are best.'
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('leads'));
  await db.recursiveDelete(db.collection('questionnaireSessions'));
  await db.recursiveDelete(db.collection('questionnaireResponses'));
});
after(async () => db.terminate());

test('creates an opaque lead association and exposes only safe prefill data', async () => {
  await db.doc('leads/lead-1').set({ name: 'Alex Morgan', email: 'private@example.com', businessName: 'Acme', website: 'https://acme.example', privateNotes: 'do not expose', createdAt: Timestamp.fromMillis(nowMs) });
  const created = await createQuestionnaireSessionCore(db, { leadId: 'lead-1', uid: 'admin-1', token, nowMs });
  assert.match(created.url, /token=abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(created.url, /lead-1/);
  const loaded = await getQuestionnaireSessionCore(db, { token, nowMs });
  assert.deepEqual(loaded.prefill, { firstName: 'Alex', businessName: 'Acme', website: 'https://acme.example/', location: '' });
  assert.equal('email' in loaded.prefill, false);
  assert.equal('privateNotes' in loaded.prefill, false);
});

test('valid submission updates the lead once and is idempotent', async () => {
  await db.doc('leads/lead-1').set({ name: 'Alex', email: 'alex@example.com', createdAt: Timestamp.fromMillis(nowMs) });
  await createQuestionnaireSessionCore(db, { leadId: 'lead-1', uid: 'admin-1', token, nowMs });
  const first = await submitQuestionnaireCore(db, { token, answers: validAnswers(), nowMs: nowMs + 1000 });
  const repeat = await submitQuestionnaireCore(db, { token, answers: validAnswers(), nowMs: nowMs + 2000 });
  assert.equal(first.alreadyCompleted, false);
  assert.equal(repeat.alreadyCompleted, true);
  const lead = (await db.doc('leads/lead-1').get()).data();
  assert.equal(lead.questionnaire.status, 'completed');
  assert.equal(lead.questionnaire.answers.businessName, 'Acme Studio');
  assert.equal((await db.collection('questionnaireResponses').get()).size, 1);
  assert.equal((await db.collection('leads/lead-1/activities').get()).size, 1);
});

test('rejects required, unknown, oversized, and invalid URL fields', () => {
  assert.throws(() => validateQuestionnaireAnswers({ ...validAnswers(), businessName: '' }), /Business name/);
  assert.throws(() => validateQuestionnaireAnswers({ ...validAnswers(), secret: 'value' }), /Unknown/);
  assert.throws(() => validateQuestionnaireAnswers({ ...validAnswers(), anythingElse: 'x'.repeat(1201) }), /too long/);
  assert.throws(() => validateQuestionnaireAnswers({ ...validAnswers(), website: 'javascript:alert(1)' }), /https/);
});

test('rejects invalid and expired tokens', async () => {
  await db.doc('leads/lead-1').set({ name: 'Alex', email: 'alex@example.com', createdAt: Timestamp.fromMillis(nowMs) });
  await createQuestionnaireSessionCore(db, { leadId: 'lead-1', uid: 'admin-1', token, nowMs });
  await assert.rejects(() => getQuestionnaireSessionCore(db, { token: 'not-a-token', nowMs }), /invalid or expired/);
  await assert.rejects(() => getQuestionnaireSessionCore(db, { token, nowMs: nowMs + 31 * 24 * 60 * 60 * 1000 }), /expired/);
});
