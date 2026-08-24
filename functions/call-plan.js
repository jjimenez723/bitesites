// Immutable, seller-bound research snapshot used by outbound voice runtimes.
//
// A call plan is not valid because a document says `approved: true`. It is
// valid only when its canonical content hash matches and its seller, target,
// and contact bindings match the call being attached.

import { createHash } from 'node:crypto';
import { clean } from './prospect-normalization.js';

const text = (value, max = 1000) => clean(value, max);
const list = (value, maxItems = 20, maxLen = 300) =>
  (Array.isArray(value) ? value : []).slice(0, maxItems).map(item => text(item, maxLen)).filter(Boolean);
const SPEAKABLE_EVIDENCE_TYPES = new Set(['observed', 'provider_asserted', 'prospect_stated']);

export function canonicalCallPlan(input = {}) {
  const facts = (Array.isArray(input.verifiedFacts) ? input.verifiedFacts : [])
    .slice(0, 12)
    .map(fact => ({
      id: text(fact?.id, 80),
      text: text(fact?.text, 500),
      sourceId: text(fact?.sourceId, 80),
      evidenceType: text(fact?.evidenceType, 40),
      observedAt: text(fact?.observedAt, 50),
      confidence: Math.max(0, Math.min(1, Number(fact?.confidence) || 0)),
      speakable: fact?.speakable === true
    }))
    .filter(fact => fact.text && fact.sourceId && fact.speakable
      && SPEAKABLE_EVIDENCE_TYPES.has(fact.evidenceType)
      && Number.isFinite(Date.parse(fact.observedAt)));

  return {
    key: text(input.key, 200),
    version: Math.max(0, Number(input.version) || 0),
    evidencePolicyVersion: Math.max(0, Number(input.evidencePolicyVersion) || 0),
    status: text(input.status, 40),
    approved: input.approved === true,
    approvedBy: text(input.approvedBy, 160),
    sellerAccountId: text(input.sellerAccountId, 120),
    targetId: text(input.targetId, 200),
    contactType: ['lead', 'prospect'].includes(input.contactType) ? input.contactType : '',
    contactId: text(input.contactId, 200),
    summary: text(input.summary, 1500),
    suggestedOpening: text(input.suggestedOpening, 800),
    verifiedFacts: facts,
    hypotheses: list(input.hypotheses, 8, 300),
    likelyNeeds: list(input.likelyNeeds, 8, 300),
    talkingPoints: list(input.talkingPoints, 8, 350),
    likelyObjections: list(input.likelyObjections, 8, 350)
  };
}

export function callPlanContentHash(input = {}) {
  return createHash('sha256').update(JSON.stringify(canonicalCallPlan(input))).digest('hex');
}

export function sealCallPlanSnapshot(input = {}) {
  const plan = canonicalCallPlan(input);
  return { ...plan, contentHash: callPlanContentHash(plan) };
}

export function normalizeApprovedCallPlan(input = {}, expected = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const plan = canonicalCallPlan(input);
  const suppliedHash = text(input.contentHash, 128);
  if (!plan.key || plan.version < 1 || plan.evidencePolicyVersion < 1
    || plan.approved !== true || plan.status !== 'approved') return null;
  if (!suppliedHash || suppliedHash !== callPlanContentHash(plan)) return null;

  const bindings = [
    ['sellerAccountId', expected.sellerAccountId],
    ['targetId', expected.targetId],
    ['contactId', expected.contactId]
  ];
  for (const [field, wanted] of bindings) {
    const value = text(wanted, 200);
    if (value && plan[field] !== value) return null;
  }
  return { ...plan, contentHash: suppliedHash };
}
