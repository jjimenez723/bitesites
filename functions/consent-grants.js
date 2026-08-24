// Server-owned evidence review and immutable AI-voice consent ledger.
//
// Imported CRM fields are *candidates*, never permission to call.  This module
// is the only code allowed to turn complete, human-reviewed written evidence
// into a grant that the outbound dialer may resolve.  Browser rules deny every
// write to these collections; callers reach these functions through narrow
// admin callables in outbound-api.js.

import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { clean, normalizePhone } from './prospect-normalization.js';
import { requireAccountId } from './accounts.js';

const CANDIDATE_PREFIX = 'consent_candidate_';
const GRANT_PREFIX = 'consent_grant_';
const VALID_CONTACT_TYPES = new Set(['prospect', 'lead']);
const VALID_EVIDENCE_TYPES = new Set([
  'signed_web_form',
  'signed_agreement',
  'digital_signature',
  'other_documented_written_opt_in'
]);

const text = (value, max = 200) => clean(value, max);
const id = (value, label) => {
  const valueText = text(value, 200);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(valueText)) throw new Error(`A valid ${label} is required`);
  return valueText;
};

const requiredText = (value, label, max = 200, minimum = 1) => {
  const valueText = text(value, max);
  if (valueText.length < minimum) throw new Error(`${label} is required`);
  return valueText;
};

const asDate = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    try { return asDate(value.toDate()); } catch { return null; }
  }
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
};

const iso = value => {
  const date = asDate(value);
  return date ? date.toISOString() : '';
};

const stableValue = value => {
  if (value instanceof Date || typeof value?.toDate === 'function') return iso(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
};

export const consentFingerprint = value => createHash('sha256')
  .update(JSON.stringify(stableValue(value)))
  .digest('hex');

export const consentCandidateIdFor = idempotencyKey =>
  `${CANDIDATE_PREFIX}${consentFingerprint(String(idempotencyKey || '')).slice(0, 48)}`;

export const consentGrantIdFor = candidateId =>
  `${GRANT_PREFIX}${consentFingerprint(String(candidateId || '')).slice(0, 48)}`;

const contactPath = ({ contactType, contactId }) => `${contactType === 'lead' ? 'leads' : 'prospects'}/${contactId}`;

const contactAccountId = contact => text(contact?.accountId, 100);
const contactPhone = contact => normalizePhone(contact?.phoneE164 || contact?.phone || '');

function assertCandidateContact(contact, candidate) {
  if (!contact) throw new Error('The linked contact no longer exists');
  if (contactAccountId(contact) !== candidate.sellerAccountId) {
    throw new Error('The linked contact belongs to a different seller');
  }
  if (contactPhone(contact) !== candidate.phoneE164) {
    throw new Error('The linked contact phone no longer matches the consent evidence');
  }
}

/**
 * Strictly normalize an evidence submission.  The returned body is the
 * immutable candidate payload; no free-form imported consent object is ever
 * copied into it.
 */
export function normalizeConsentEvidenceCandidate(input = {}, { now = new Date(), allowExpired = false } = {}) {
  const sellerAccountId = requireAccountId(input.sellerAccountId, { field: 'sellerAccountId' });
  const phoneE164 = normalizePhone(input.phoneE164 || input.phone);
  if (!phoneE164) throw new Error('A valid consent phone number is required');

  const contactType = text(input.contactType, 20);
  if (!VALID_CONTACT_TYPES.has(contactType)) throw new Error('contactType must be prospect or lead');
  const contactId = id(input.contactId, 'contact id');

  const basis = text(input.basis || 'written_opt_in', 60).toLowerCase();
  if (basis !== 'written_opt_in') throw new Error('Only written_opt_in can authorize AI voice');

  const evidenceType = text(input.evidenceType, 80).toLowerCase();
  if (!VALID_EVIDENCE_TYPES.has(evidenceType)) throw new Error('Choose a supported written evidence type');

  const evidenceArtifactId = requiredText(input.evidenceArtifactId, 'evidenceArtifactId', 200, 3);
  if (!/^[A-Za-z0-9._:-]+$/.test(evidenceArtifactId)) {
    throw new Error('evidenceArtifactId contains unsupported characters');
  }
  const disclosureVersion = requiredText(input.disclosureVersion, 'disclosureVersion', 120, 1);
  const attestation = requiredText(input.attestation, 'A reviewer attestation', 2000, 20);
  const grantedAt = asDate(input.grantedAt);
  const checkedNow = asDate(now) || new Date();
  if (!grantedAt || grantedAt.getTime() > checkedNow.getTime()) {
    throw new Error('grantedAt must be a real time that is not in the future');
  }

  const expiresAt = input.expiresAt ? asDate(input.expiresAt) : null;
  if (input.expiresAt && !expiresAt) throw new Error('expiresAt must be a valid time');
  if (!allowExpired && expiresAt && expiresAt.getTime() <= checkedNow.getTime()) {
    throw new Error('expiresAt must be in the future before a grant can be issued');
  }
  if (expiresAt && expiresAt.getTime() <= grantedAt.getTime()) {
    throw new Error('expiresAt must be after grantedAt');
  }

  const sourceUrl = text(input.sourceUrl, 1000);
  if (sourceUrl && !/^https:\/\/[^\s]+$/i.test(sourceUrl)) {
    throw new Error('sourceUrl must be an HTTPS URL when supplied');
  }

  return {
    schemaVersion: 1,
    sellerAccountId,
    phoneE164,
    contactType,
    contactId,
    basis,
    evidenceType,
    evidenceArtifactId,
    disclosureVersion,
    subjectName: text(input.subjectName, 160),
    sourceUrl,
    attestation,
    grantedAt: Timestamp.fromDate(grantedAt),
    expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null
  };
}

const candidateComparable = candidate => ({
  schemaVersion: Number(candidate.schemaVersion || 0),
  sellerAccountId: text(candidate.sellerAccountId, 100),
  phoneE164: normalizePhone(candidate.phoneE164),
  contactType: text(candidate.contactType, 20),
  contactId: text(candidate.contactId, 200),
  basis: text(candidate.basis, 60),
  evidenceType: text(candidate.evidenceType, 80),
  evidenceArtifactId: text(candidate.evidenceArtifactId, 200),
  disclosureVersion: text(candidate.disclosureVersion, 120),
  subjectName: text(candidate.subjectName, 160),
  sourceUrl: text(candidate.sourceUrl, 1000),
  attestation: text(candidate.attestation, 2000),
  grantedAt: iso(candidate.grantedAt),
  expiresAt: iso(candidate.expiresAt)
});

const candidateStored = body => ({
  ...body,
  bodyHash: consentFingerprint(candidateComparable(body))
});

/** Save one immutable evidence candidate, safely retryable by idempotency key. */
export async function createConsentEvidenceCandidate(db, input, {
  actorUid = '', actorEmail = '', now = new Date()
} = {}) {
  const idempotencyKey = requiredText(input?.idempotencyKey, 'idempotencyKey', 200, 16);
  if (!/^[A-Za-z0-9_-]+$/.test(idempotencyKey)) throw new Error('idempotencyKey contains unsupported characters');
  const body = normalizeConsentEvidenceCandidate(input, { now });
  const candidateId = consentCandidateIdFor(idempotencyKey);
  const ref = db.doc(`consentEvidenceCandidates/${candidateId}`);
  const contactSnapshot = await db.doc(contactPath(body)).get();
  if (!contactSnapshot.exists) throw new Error('The linked contact no longer exists');
  assertCandidateContact(contactSnapshot.data(), body);

  const stored = candidateStored(body);
  const result = await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      const data = existing.data() || {};
      if (data.bodyHash !== stored.bodyHash) {
        throw new Error('This idempotencyKey was already used for different consent evidence');
      }
      return { candidateId, created: false, status: text(data.status, 30), grantId: text(data.issuedGrantId, 200) };
    }
    tx.create(ref, {
      ...stored,
      status: 'pending_review',
      idempotencyKeyHash: consentFingerprint(idempotencyKey),
      createdAt: Timestamp.fromDate(asDate(now) || new Date()),
      createdBy: text(actorEmail || actorUid, 200),
      createdByUid: text(actorUid, 200),
      reviewedAt: null,
      reviewedBy: '',
      reviewedByUid: '',
      issuedGrantId: ''
    });
    return { candidateId, created: true, status: 'pending_review', grantId: '' };
  });
  return result;
}

const grantComparable = grant => ({
  schemaVersion: 1,
  candidateId: text(grant.candidateId, 200),
  sellerAccountId: text(grant.sellerAccountId, 100),
  phoneE164: normalizePhone(grant.phoneE164),
  basis: text(grant.basis, 60),
  evidenceType: text(grant.evidenceType, 80),
  evidenceArtifactId: text(grant.evidenceArtifactId, 200),
  disclosureVersion: text(grant.disclosureVersion, 120),
  subjectName: text(grant.subjectName, 160),
  sourceUrl: text(grant.sourceUrl, 1000),
  attestation: text(grant.attestation, 2000),
  grantedAt: iso(grant.grantedAt),
  expiresAt: iso(grant.expiresAt),
  reviewedAt: iso(grant.reviewedAt),
  reviewedBy: text(grant.reviewedBy, 200),
  reviewedByUid: text(grant.reviewedByUid, 200)
});

const consentSnapshotForContact = grant => ({
  grantId: grant.id,
  basis: grant.basis,
  sellerAccountId: grant.sellerAccountId,
  phoneE164: grant.phoneE164,
  evidenceArtifactId: grant.evidenceArtifactId,
  disclosureVersion: grant.disclosureVersion,
  grantedAt: grant.grantedAt,
  reviewedAt: grant.reviewedAt,
  reviewedBy: grant.reviewedBy,
  expiresAt: grant.expiresAt,
  revokedAt: null,
  status: 'active',
  verificationState: 'verified'
});

/**
 * Approve one pending candidate and issue its deterministic immutable grant.
 * A retry returns the existing grant; a different candidate can never reuse
 * the same grant id.
 */
export async function issueConsentGrant(db, candidateIdInput, {
  reviewerUid = '', reviewerEmail = '', now = new Date()
} = {}) {
  const candidateId = id(candidateIdInput, 'candidate id');
  const candidateRef = db.doc(`consentEvidenceCandidates/${candidateId}`);
  const grantId = consentGrantIdFor(candidateId);
  const grantRef = db.doc(`consentGrants/${grantId}`);
  const eventRef = db.doc(`consentGrantEvents/${grantId}/events/issued`);
  const reviewedAt = Timestamp.fromDate(asDate(now) || new Date());
  const reviewer = requiredText(reviewerEmail || reviewerUid, 'reviewer identity', 200);

  return db.runTransaction(async tx => {
    const candidateSnapshot = await tx.get(candidateRef);
    if (!candidateSnapshot.exists) throw new Error('Consent evidence candidate not found');
    const candidate = candidateSnapshot.data() || {};
    // An approval retry must keep returning its original immutable grant even
    // after that grant naturally expires.  Expiry is checked only before a
    // *new* grant is created below.
    const body = normalizeConsentEvidenceCandidate(candidate, { now, allowExpired: true });
    const expectedHash = consentFingerprint(candidateComparable(body));
    if (candidate.bodyHash !== expectedHash) throw new Error('Consent evidence candidate integrity check failed');

    const contactRef = db.doc(contactPath(body));
    const [existingGrantSnapshot, contactSnapshot] = await Promise.all([tx.get(grantRef), tx.get(contactRef)]);
    if (existingGrantSnapshot.exists) {
      const existing = existingGrantSnapshot.data() || {};
      if (text(existing.candidateId, 200) !== candidateId || existing.bodyHash !== consentFingerprint(grantComparable(existing))) {
        throw new Error('Consent grant integrity check failed');
      }
      if (text(candidate.issuedGrantId, 200) !== grantId) {
        tx.update(candidateRef, { status: 'issued', issuedGrantId: grantId });
      }
      return { grantId, issued: false, status: text(existing.status, 30) };
    }

    if (candidate.status !== 'pending_review') throw new Error('This consent evidence candidate is not pending review');
    if (body.expiresAt && body.expiresAt.toDate().getTime() <= reviewedAt.toDate().getTime()) {
      throw new Error('This consent evidence has expired and cannot be issued');
    }
    assertCandidateContact(contactSnapshot.exists ? contactSnapshot.data() : null, body);

    const grant = {
      id: grantId,
      schemaVersion: 1,
      candidateId,
      sellerAccountId: body.sellerAccountId,
      phoneE164: body.phoneE164,
      basis: body.basis,
      evidenceType: body.evidenceType,
      evidenceArtifactId: body.evidenceArtifactId,
      disclosureVersion: body.disclosureVersion,
      subjectName: body.subjectName,
      sourceUrl: body.sourceUrl,
      attestation: body.attestation,
      grantedAt: body.grantedAt,
      expiresAt: body.expiresAt,
      reviewedAt,
      reviewedBy: reviewer,
      reviewedByUid: text(reviewerUid, 200),
      issuedAt: reviewedAt,
      status: 'active',
      verificationState: 'verified',
      revokedAt: null,
      revocation: null
    };
    grant.bodyHash = consentFingerprint(grantComparable(grant));
    tx.create(grantRef, grant);
    tx.create(eventRef, {
      schemaVersion: 1,
      type: 'issued',
      at: reviewedAt,
      actor: reviewer,
      actorUid: text(reviewerUid, 200),
      candidateId,
      grantBodyHash: grant.bodyHash
    });
    tx.update(candidateRef, {
      status: 'issued', issuedGrantId: grantId,
      reviewedAt, reviewedBy: reviewer, reviewedByUid: text(reviewerUid, 200)
    });
    // Replace (not merge) the entire consent map. A previous revoked or
    // imported artifact must not survive alongside this verified snapshot.
    tx.update(contactRef, { consent: consentSnapshotForContact(grant), updatedAt: reviewedAt });
    return { grantId, issued: true, status: 'active' };
  });
}

/** Revoke a grant permanently. The grant evidence body is never rewritten. */
export async function revokeConsentGrant(db, grantIdInput, {
  reason, actorUid = '', actorEmail = '', now = new Date()
} = {}) {
  const grantId = id(grantIdInput, 'grant id');
  const revocationReason = requiredText(reason, 'revocation reason', 1000, 5);
  const actor = requiredText(actorEmail || actorUid, 'revoker identity', 200);
  const grantRef = db.doc(`consentGrants/${grantId}`);
  const eventRef = db.doc(`consentGrantEvents/${grantId}/events/revoked`);
  const revokedAt = Timestamp.fromDate(asDate(now) || new Date());

  return db.runTransaction(async tx => {
    const grantSnapshot = await tx.get(grantRef);
    if (!grantSnapshot.exists) throw new Error('Consent grant not found');
    const grant = { id: grantId, ...(grantSnapshot.data() || {}) };
    if (grant.bodyHash !== consentFingerprint(grantComparable(grant))) {
      throw new Error('Consent grant integrity check failed');
    }
    if (grant.status === 'revoked') return { grantId, revoked: false, status: 'revoked' };

    const candidateSnapshot = await tx.get(db.doc(`consentEvidenceCandidates/${grant.candidateId}`));
    const contactType = text(candidateSnapshot.get('contactType'), 20);
    const contactId = text(candidateSnapshot.get('contactId'), 200);
    // Candidate deletion is not expected (rules deny it), but an audit grant
    // must still be revocable if a legacy migration omitted the candidate.
    const contactRef = VALID_CONTACT_TYPES.has(contactType) && contactId ? db.doc(contactPath({ contactType, contactId })) : null;
    const contactSnapshot = contactRef ? await tx.get(contactRef) : null;
    const revocation = {
      reason: revocationReason,
      revokedAt,
      revokedBy: actor,
      revokedByUid: text(actorUid, 200)
    };
    tx.update(grantRef, { status: 'revoked', revokedAt, revocation });
    tx.create(eventRef, {
      schemaVersion: 1,
      type: 'revoked',
      at: revokedAt,
      actor,
      actorUid: text(actorUid, 200),
      reason: revocationReason,
      grantBodyHash: grant.bodyHash
    });
    if (contactSnapshot?.exists && contactSnapshot.get('consent')?.grantId === grantId) {
      tx.update(contactRef, {
        consent: { ...contactSnapshot.get('consent'), status: 'revoked', revokedAt },
        updatedAt: revokedAt
      });
    }
    return { grantId, revoked: true, status: 'revoked' };
  });
}

/** Mark due active grants expired without modifying their immutable bodies. */
export async function expireDueConsentGrants(db, { now = new Date(), limit = 100 } = {}) {
  const cutoff = Timestamp.fromDate(asDate(now) || new Date());
  // This query has a declared composite index.  Scanning only the first active
  // grants would starve later expiring grants behind an unbounded population
  // of non-expiring ones. The resolver independently fails closed at expiresAt
  // too, so this reconciliation is an audit/status repair, never permission.
  const snapshot = await db.collection('consentGrants')
    .where('status', '==', 'active')
    .where('expiresAt', '<=', cutoff)
    .orderBy('expiresAt', 'asc')
    .limit(Math.max(1, Math.min(500, Number(limit) || 100))).get();
  let expired = 0;
  for (const entry of snapshot.docs) {
    const eventRef = db.doc(`consentGrantEvents/${entry.id}/events/expired`);
    const changed = await db.runTransaction(async tx => {
      const current = await tx.get(entry.ref);
      if (!current.exists || current.get('status') !== 'active') return false;
      const currentExpiry = asDate(current.get('expiresAt'));
      if (!currentExpiry || currentExpiry.getTime() > cutoff.toDate().getTime()) return false;
      tx.update(entry.ref, { status: 'expired', expiredAt: cutoff });
      tx.create(eventRef, { schemaVersion: 1, type: 'expired', at: cutoff, actor: 'system', actorUid: '' });
      return true;
    });
    if (changed) expired += 1;
  }
  return { expired };
}

export const CONSENT_GRANT_STATUS = Object.freeze(['pending_review', 'issued', 'active', 'revoked', 'expired']);
