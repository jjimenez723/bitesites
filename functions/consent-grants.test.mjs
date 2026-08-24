// Immutable AI voice consent-grant lifecycle against the Firestore emulator.
// No function endpoint, provider, or live contact is used here.

process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();

const {
  createConsentEvidenceCandidate, issueConsentGrant, revokeConsentGrant,
  expireDueConsentGrants, consentCandidateIdFor, consentGrantIdFor
} = await import('./consent-grants.js');
const { resolveAIVoiceConsent } = await import('./outbound-compliance.js');
const { loadContactForTarget } = await import('./outbound-contacts.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
};

const wipe = async collectionName => {
  const snapshot = await db.collection(collectionName).limit(500).get();
  for (const entry of snapshot.docs) {
    for (const nested of await entry.ref.listCollections()) {
      const children = await nested.limit(500).get();
      for (const child of children.docs) await child.ref.delete();
    }
    await entry.ref.delete();
  }
};

for (const name of ['prospects', 'leads', 'consentEvidenceCandidates', 'consentGrants', 'consentGrantEvents']) await wipe(name);

const NOW = new Date('2026-08-24T15:00:00.000Z');
const input = {
  idempotencyKey: 'consent-application-20260824-000001',
  sellerAccountId: 'bitesites',
  contactType: 'prospect',
  contactId: 'prospect_consent_1',
  phoneE164: '+1 (201) 555-0123',
  subjectName: 'Alex Example',
  basis: 'written_opt_in',
  evidenceType: 'signed_web_form',
  evidenceArtifactId: 'form_2026_08_24_01',
  disclosureVersion: 'ai-voice-consent-v1',
  sourceUrl: 'https://crm.example.test/consent/form_2026_08_24_01',
  grantedAt: '2026-08-24T14:00:00.000Z',
  attestation: 'I reviewed the retained signed form. It names BiteSites, this phone number, and the AI voice disclosure.'
};

await db.doc('prospects/prospect_consent_1').set({
  accountId: 'bitesites', name: 'Alex Example', phoneE164: '+12015550123', phone: '+12015550123',
  lifecycle: { status: 'new' }, contactability: { validPhone: true }
});

console.log('\nconsent evidence candidates are strict and idempotent');
const created = await createConsentEvidenceCandidate(db, input, {
  actorUid: 'owner-1', actorEmail: 'owner@bitesites.org', now: NOW
});
const expectedCandidateId = consentCandidateIdFor(input.idempotencyKey);
check('a complete written-evidence candidate gets a deterministic id',
  created.created === true && created.candidateId === expectedCandidateId);

const same = await createConsentEvidenceCandidate(db, input, {
  actorUid: 'owner-1', actorEmail: 'owner@bitesites.org', now: NOW
});
check('retrying the identical evidence candidate is idempotent', same.created === false && same.candidateId === expectedCandidateId);

let changedRetryRejected = false;
try {
  await createConsentEvidenceCandidate(db, { ...input, attestation: 'I reviewed a different retained signed form naming BiteSites, this phone number, and the AI voice disclosure.' }, {
    actorUid: 'owner-1', actorEmail: 'owner@bitesites.org', now: NOW
  });
} catch (error) { changedRetryRejected = /different consent evidence/.test(String(error?.message)); }
check('an idempotency key cannot be replayed for different evidence', changedRetryRejected);

let importedNoteRejected = false;
try {
  await createConsentEvidenceCandidate(db, {
    ...input, idempotencyKey: 'consent-application-20260824-000002', evidenceArtifactId: '', attestation: 'yes'
  }, { actorUid: 'owner-1', now: NOW });
} catch { importedNoteRejected = true; }
check('a vague imported note cannot become an evidence candidate', importedNoteRejected);

let crossSellerRejected = false;
try {
  await createConsentEvidenceCandidate(db, {
    ...input, idempotencyKey: 'consent-application-20260824-000004', sellerAccountId: 'fine-line-group'
  }, { actorUid: 'owner-1', now: NOW });
} catch (error) { crossSellerRejected = /different seller/.test(String(error?.message)); }
check('a consent candidate cannot bind a contact to another seller', crossSellerRejected);

console.log('\nissuance stamps a linked contact and creates append-only evidence');
const issued = await issueConsentGrant(db, created.candidateId, {
  reviewerUid: 'owner-1', reviewerEmail: 'owner@bitesites.org', now: NOW
});
const expectedGrantId = consentGrantIdFor(created.candidateId);
const grant = await db.doc(`consentGrants/${expectedGrantId}`).get();
const prospect = await db.doc('prospects/prospect_consent_1').get();
const issuedEvent = await db.doc(`consentGrantEvents/${expectedGrantId}/events/issued`).get();
check('approval issues a deterministic, server-reviewed active grant',
  issued.issued === true && issued.grantId === expectedGrantId && grant.get('status') === 'active'
  && grant.get('reviewedBy') === 'owner@bitesites.org' && Boolean(grant.get('bodyHash')));
check('the linked contact receives the exact verified grant snapshot',
  prospect.get('consent')?.grantId === expectedGrantId
  && prospect.get('consent')?.phoneE164 === '+12015550123'
  && prospect.get('consent')?.verificationState === 'verified');
check('issuance leaves an immutable event record', issuedEvent.exists && issuedEvent.get('type') === 'issued');

const issuedRetry = await issueConsentGrant(db, created.candidateId, {
  reviewerUid: 'owner-1', reviewerEmail: 'owner@bitesites.org', now: new Date('2026-08-25T15:00:00.000Z')
});
check('approval retry returns the same grant without rewriting it', issuedRetry.issued === false && issuedRetry.grantId === expectedGrantId);

const resolved = await resolveAIVoiceConsent(db, {
  target: { consent: prospect.get('consent') }, campaign: { accountId: 'bitesites' }, phoneE164: '+12015550123', now: NOW
});
check('the dialer resolver accepts only the issued ledger grant', resolved.grantId === expectedGrantId && resolved.status === 'active');

console.log('\nrevocation and expiry fail closed without rewriting evidence');
const revocation = await revokeConsentGrant(db, expectedGrantId, {
  reason: 'The customer withdrew permission through support.', actorUid: 'owner-1', actorEmail: 'owner@bitesites.org', now: NOW
});
const revokedGrant = await db.doc(`consentGrants/${expectedGrantId}`).get();
const revokedProspect = await db.doc('prospects/prospect_consent_1').get();
const revokedEvent = await db.doc(`consentGrantEvents/${expectedGrantId}/events/revoked`).get();
check('revocation changes only status metadata and appends an event',
  revocation.revoked === true && revokedGrant.get('status') === 'revoked'
  && revokedGrant.get('bodyHash') === grant.get('bodyHash') && revokedEvent.exists);
check('revocation immediately makes the linked contact snapshot non-active',
  revokedProspect.get('consent')?.status === 'revoked' && Boolean(revokedProspect.get('consent')?.revokedAt));
const resolvedRevoked = await resolveAIVoiceConsent(db, {
  target: { consent: revokedProspect.get('consent') }, campaign: { accountId: 'bitesites' }, phoneE164: '+12015550123', now: NOW
});
check('the resolver obtains revoked status from the ledger, not the import', resolvedRevoked.status === 'revoked');

await db.doc('leads/lead_consent_1').set({
  accountId: 'bitesites', name: 'Lead Example', phoneE164: '+12015550125', phone: '+12015550125'
});
const leadCandidate = await createConsentEvidenceCandidate(db, {
  ...input, idempotencyKey: 'consent-application-20260824-000005', contactType: 'lead', contactId: 'lead_consent_1',
  phoneE164: '+12015550125', evidenceArtifactId: 'form_2026_08_24_03'
}, { actorUid: 'owner-1', actorEmail: 'owner@bitesites.org', now: NOW });
const leadGrant = await issueConsentGrant(db, leadCandidate.candidateId, {
  reviewerUid: 'owner-1', reviewerEmail: 'owner@bitesites.org', now: NOW
});
const grantedLead = await loadContactForTarget(db, { contactType: 'lead', leadId: 'lead_consent_1' });
check('a lead grant is visible to target admission as well as a prospect grant',
  grantedLead?.consent?.grantId === leadGrant.grantId && grantedLead?.consent?.verificationState === 'verified');

await db.doc('prospects/prospect_consent_2').set({
  accountId: 'bitesites', name: 'Expiry Example', phoneE164: '+12015550124', phone: '+12015550124'
});
const expiringCandidate = await createConsentEvidenceCandidate(db, {
  ...input, idempotencyKey: 'consent-application-20260824-000003', contactId: 'prospect_consent_2',
  phoneE164: '+12015550124', evidenceArtifactId: 'form_2026_08_24_02',
  expiresAt: '2026-08-24T16:00:00.000Z'
}, { actorUid: 'owner-1', actorEmail: 'owner@bitesites.org', now: NOW });
const expiring = await issueConsentGrant(db, expiringCandidate.candidateId, {
  reviewerUid: 'owner-1', reviewerEmail: 'owner@bitesites.org', now: NOW
});
const expiryRun = await expireDueConsentGrants(db, { now: new Date('2026-08-24T17:00:00.000Z') });
const expiredEvent = await db.doc(`consentGrantEvents/${expiring.grantId}/events/expired`).get();
check('due grants become expired through an append-only reconciliation event',
  expiryRun.expired >= 1 && (await db.doc(`consentGrants/${expiring.grantId}`).get()).get('status') === 'expired' && expiredEvent.exists);

const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
