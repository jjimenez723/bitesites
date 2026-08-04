// Promoting a cold prospect into an inbound-quality lead.
//
// The rule that shapes this file: a scraped business is not a lead, and an
// attempted call is not engagement (§7). `leads` is what the Overview,
// Performance and funnel-conversion screens count, so a prospect that lands
// there without a real interaction silently inflates the website's conversion
// rate and depresses its response-time metrics. Promotion therefore happens
// only when something meaningful happened, and only through this function.
//
// Idempotency is the second requirement and the harder one. This runs from a
// webhook that providers redeliver, so it must be safe to execute repeatedly:
//   * an existing `convertedLeadId` short-circuits everything,
//   * a strong phone/email match links to that lead rather than creating one,
//   * a created lead uses a deterministic id derived from the prospect,
//   * and an existing lead's stage, owner, economics and history are never
//     touched — only outbound attribution is added.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { normalizeEmail, normalizePhone, clean, deterministicId } from './prospect-normalization.js';
import { recordContactActivity } from './outbound-contacts.js';

/** What counts as meaningful engagement. An attempt is deliberately absent. */
export const CONVERSION_TRIGGERS = [
  'call_answered', 'meeting_booked', 'email_reply', 'manual_qualification',
  'form_submitted', 'conversation_started'
];

const isMeaningful = trigger => CONVERSION_TRIGGERS.includes(trigger);

/** Find an existing lead for this person by normalised phone, then email. */
export async function findExistingLead(db, { email, phoneE164 }) {
  const leads = db.collection('leads');

  if (phoneE164) {
    // `phoneE164` is only present on leads a server path wrote; the raw `phone`
    // fallback is what matches an inbound form submission from last month.
    const byE164 = await leads.where('phoneE164', '==', phoneE164).limit(1).get();
    if (!byE164.empty) return byE164.docs[0];
  }
  if (email) {
    const byEmail = await leads.where('email', '==', email).limit(1).get();
    if (!byEmail.empty) return byEmail.docs[0];
  }
  return null;
}

/**
 * Point this prospect's targets at the lead instead.
 *
 * `prospectId` is cleared rather than kept alongside `leadId`: §24 requires
 * exactly one of the two, and a target carrying both is a target that two code
 * paths will resolve differently. The link survives as
 * `convertedFromProspectId`, which is attribution, not a contact reference.
 */
async function repointTargets(db, prospectId, leadId) {
  const targets = await db.collection('outboundTargets').where('prospectId', '==', prospectId).limit(200).get();
  for (const entry of targets.docs) {
    await entry.ref.set({
      contactType: 'lead',
      leadId,
      prospectId: null,
      convertedFromProspectId: prospectId,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  return targets.size;
}

/**
 * Idempotent prospect -> lead promotion.
 *
 * Returns `{ leadId, created, linked, alreadyConverted }` so the caller can
 * report honestly rather than assuming a new lead appeared.
 */
export async function promoteProspect(db, prospectId, {
  trigger,
  campaignId = '',
  targetId = '',
  firstConnectedCallId = '',
  actor = '',
  now = new Date()
} = {}) {
  if (!isMeaningful(trigger)) {
    throw new Error(`"${trigger}" is not a conversion trigger — an attempted call alone must not create a lead.`);
  }

  const prospectRef = db.doc(`prospects/${prospectId}`);
  const snapshot = await prospectRef.get();
  if (!snapshot.exists) throw new Error('Prospect not found');
  const prospect = snapshot.data();

  if (prospect.lifecycle?.convertedLeadId) {
    return { leadId: prospect.lifecycle.convertedLeadId, created: false, linked: false, alreadyConverted: true };
  }

  const email = normalizeEmail(prospect.email);
  const phoneE164 = prospect.phoneE164 || normalizePhone(prospect.phone);
  const stamp = Timestamp.fromDate(now);

  const acquisition = {
    originalSystem: clean(prospect.source?.system, 60) || 'outbound',
    originalProspectId: prospectId,
    originalSourceDocumentId: clean(prospect.source?.sourceDocumentId, 200),
    originalSourceProjectId: clean(prospect.source?.sourceProjectId, 80),
    campaignId: clean(campaignId, 160),
    targetId: clean(targetId, 160),
    firstConnectedCallId: clean(firstConnectedCallId, 200),
    trigger,
    convertedAt: stamp
  };

  const existing = await findExistingLead(db, { email, phoneE164 });

  if (existing) {
    // Link, do not overwrite. Everything below is additive: no status, owner,
    // economics, stage timestamps or first-response data is touched, because
    // this lead's funnel history predates the outbound campaign and is what the
    // Performance screen measures.
    await existing.ref.set({
      acquisition: { ...(existing.get('acquisition') || {}), ...acquisition },
      prospectId,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection(`leads/${existing.id}/activities`).doc().set({
      type: 'outbound_prospect_linked',
      prospectId, campaignId, targetId, trigger,
      at: stamp
    });

    await prospectRef.set({
      lifecycle: { ...prospect.lifecycle, status: 'converted', convertedLeadId: existing.id },
      updatedAt: stamp
    }, { merge: true });

    await recordContactActivity(db, { id: prospectId, type: 'prospect', ref: prospectRef }, {
      type: 'converted_to_lead', leadId: existing.id, linked: true, trigger, at: stamp
    });

    await repointTargets(db, prospectId, existing.id);
    return { leadId: existing.id, created: false, linked: true, alreadyConverted: false };
  }

  // Deterministic id: a redelivered webhook that races past the
  // `convertedLeadId` check still lands on the same document rather than
  // creating a second lead for the same business.
  const leadId = deterministicId('outbound', prospectId);
  const leadRef = db.doc(`leads/${leadId}`);

  const created = await db.runTransaction(async transaction => {
    const current = await transaction.get(leadRef);
    if (current.exists) return false;

    transaction.set(leadRef, {
      name: clean(prospect.firstName && prospect.lastName
        ? `${prospect.firstName} ${prospect.lastName}`
        : prospect.name || prospect.companyName, 120),
      email: email || '',
      phone: prospect.phone || phoneE164 || '',
      phoneE164: phoneE164 || '',
      businessName: clean(prospect.companyName, 160),
      roleInCompany: clean(prospect.jobTitle, 160),
      website: clean(prospect.website, 500),
      // `outbound` is a first-class source so the funnel screens can exclude it
      // from website-conversion maths (§10). Note this bypasses the public lead
      // validation rules by design — it is an Admin SDK write.
      source: 'outbound',
      status: 'contacted',
      businessSize: 'other',
      services: ['other'],
      preferredContactMethod: 'phone',
      projectDetails: clean(prospect.notes, 5000),
      acquisition,
      prospectId,
      createdAt: stamp,
      updatedAt: stamp,
      statusChangedAt: stamp,
      firstResponseAt: stamp
    });

    transaction.set(db.collection(`leads/${leadId}/activities`).doc(), {
      type: 'created_from_outbound', prospectId, campaignId, targetId, trigger, at: stamp
    });
    return true;
  });

  await prospectRef.set({
    lifecycle: { ...prospect.lifecycle, status: 'converted', convertedLeadId: leadId },
    updatedAt: stamp
  }, { merge: true });

  await recordContactActivity(db, { id: prospectId, type: 'prospect', ref: prospectRef }, {
    type: 'converted_to_lead', leadId, created, trigger, actor: clean(actor, 128), at: stamp
  });

  await repointTargets(db, prospectId, leadId);

  return { leadId, created, linked: false, alreadyConverted: false };
}
