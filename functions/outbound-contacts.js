// One contact abstraction over `leads` and `prospects`.
//
// An outbound target points at exactly one of them (§24). Without this module
// every caller — the dialer, the AI runner, the webhook handler, the research
// pipeline, the disposition writer — would need its own `if (contactType ===
// 'lead')`, and the two branches would drift. They would drift in the direction
// that matters most: a disposition written to a prospect but not a lead is a
// prospect that gets called again tomorrow.
//
// Also home to target locking. The lock is a Firestore transaction plus a
// heartbeat, because the failure it prevents — two reps dialling the same
// person at once — is invisible in the data afterwards.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export const TARGET_STATES = [
  'pending', 'researching', 'awaiting_approval', 'ready', 'dialing', 'connected',
  'completed', 'call_later', 'no_answer', 'voicemail', 'busy', 'failed',
  'invalid_number', 'do_not_call', 'cancelled'
];

/** States a target can be picked up from. Everything else is resolved or blocked. */
export const DIALABLE_STATES = ['ready', 'call_later', 'no_answer', 'voicemail', 'busy'];

// A session that stops heartbeating has crashed, been closed, or lost its
// network. Five minutes is long enough that a slow call is never stolen and
// short enough that a rep who reloaded the tab is not locked out of their queue.
export const LOCK_TTL_MS = 5 * 60 * 1000;

const asDate = value => (value?.toDate ? value.toDate() : value instanceof Date ? value : null);

/**
 * The contact behind a target, in one shape, whichever collection it lives in.
 * Returns null when the referenced document is gone — a target whose prospect
 * was deleted must not be dialled from stale target fields.
 */
export async function loadContactForTarget(db, target) {
  if (!target) return null;

  if (target.contactType === 'lead' && target.leadId) {
    const snapshot = await db.doc(`leads/${target.leadId}`).get();
    if (!snapshot.exists) return null;
    const lead = snapshot.data();
    return {
      id: snapshot.id,
      type: 'lead',
      ref: snapshot.ref,
      accountId: lead.accountId || 'bitesites',
      name: lead.name || '',
      firstName: (lead.name || '').split(' ')[0] || '',
      lastName: (lead.name || '').split(' ').slice(1).join(' '),
      companyName: lead.businessName || '',
      jobTitle: lead.roleInCompany || '',
      email: lead.email || '',
      phone: lead.phone || '',
      phoneE164: lead.phoneE164 || '',
      website: lead.website || '',
      address: lead.address || {},
      location: { timezone: lead.timezone || '' },
      notes: lead.projectDetails || '',
      lifecycle: { status: lead.status || 'new' },
      contactability: {
        doNotCall: lead.doNotCall === true,
        doNotEmail: lead.doNotEmail === true
      },
      // Consent grants are stamped by the server-owned ledger.  Preserve the
      // same target-level admission shape for a lead as for a prospect; before
      // this, a grant attached to a lead was silently invisible to the dialer.
      consent: lead.consent && typeof lead.consent === 'object' ? lead.consent : {},
      providerContactId: lead.crm?.contactId || '',
      raw: lead
    };
  }

  if (target.contactType === 'prospect' && target.prospectId) {
    const snapshot = await db.doc(`prospects/${target.prospectId}`).get();
    if (!snapshot.exists) return null;
    const prospect = snapshot.data();
    // Spread FIRST. A prospect document carries its own `type:
    // "outbound_prospect"` field, and spreading it after these keys silently
    // overwrote the lead/prospect discriminator every caller branches on — so
    // `updateContactAfterAttempt` stopped writing prospect lifecycle statuses
    // while appearing to succeed.
    return { ...prospect, id: snapshot.id, type: 'prospect', ref: snapshot.ref, raw: prospect };
  }

  return null;
}

/** Append-only activity, on whichever contact the target points at. */
export async function recordContactActivity(db, contact, activity) {
  if (!contact?.ref) return null;
  const parent = contact.type === 'lead' ? 'leads' : 'prospects';
  const ref = db.collection(`${parent}/${contact.id}/activities`).doc();
  await ref.set({
    ...activity,
    type: String(activity.type || 'note').slice(0, 60),
    at: activity.at || FieldValue.serverTimestamp()
  });
  return ref.id;
}

// A call attempt maps onto a prospect lifecycle status. Only outcomes that
// actually say something about intent move the record — a no-answer is not a
// signal, and treating it as one would quietly retire half a campaign.
const LIFECYCLE_FROM_DISPOSITION = {
  connected: 'connected',
  qualified: 'qualified',
  booked_meeting: 'qualified',
  not_interested: 'not_interested',
  call_later: 'call_later',
  do_not_call: 'do_not_contact',
  wrong_number: 'invalid',
  invalid_number: 'invalid'
};

/**
 * Write the outcome of one attempt back to the contact.
 *
 * Deliberately narrow for leads: an inbound lead has a funnel stage, an owner,
 * economics and a response-time history that the outbound engine has no
 * business rewriting (§10.11). So a lead gets an activity and its
 * do-not-call/last-outbound fields, and nothing else.
 */
export async function updateContactAfterAttempt(db, contact, { disposition, callId, campaignId, at = new Date() }) {
  if (!contact?.ref) return;

  const stamp = Timestamp.fromDate(at instanceof Date ? at : new Date());
  const shared = {
    lastOutboundCallId: String(callId || '').slice(0, 200),
    lastOutboundDisposition: String(disposition || '').slice(0, 60),
    lastOutboundAt: stamp,
    updatedAt: FieldValue.serverTimestamp()
  };

  // Nested objects, not dotted key strings. `set({ merge: true })` deep-merges
  // maps but treats `'lifecycle.status'` as a field literally named that — the
  // write succeeds, the status never changes, and nothing reports an error.
  // Dotted paths only mean what they look like inside `update()`.
  if (disposition === 'do_not_call') {
    if (contact.type === 'lead') shared.doNotCall = true;
    else shared.contactability = { doNotCall: true };
  }

  if (contact.type === 'prospect') {
    const status = LIFECYCLE_FROM_DISPOSITION[disposition];
    if (status) shared.lifecycle = { ...(shared.lifecycle || {}), status };
  }

  await contact.ref.set(shared, { merge: true });

  await recordContactActivity(db, contact, {
    type: disposition === 'connected' || disposition === 'booked_meeting' ? 'call_connected' : 'call_attempted',
    disposition: String(disposition || '').slice(0, 60),
    callId: String(callId || '').slice(0, 200),
    campaignId: String(campaignId || '').slice(0, 200),
    at: stamp
  });
}

// ------------------------------------------------------------------- locking

/** Has this target's lock expired? A crashed session must not hold it forever. */
export function lockIsStale(target, now = new Date()) {
  if (!target?.lockedBySessionId) return true;
  const lockedAt = asDate(target.lockedAt);
  if (!lockedAt) return true;
  return now.getTime() - lockedAt.getTime() > LOCK_TTL_MS;
}

/**
 * Claim one target for a session, atomically.
 *
 * The transaction is the whole point: two power-dialer sessions polling the
 * same campaign will read the same "next" target, and only a transaction that
 * re-reads inside the commit can make exactly one of them win.
 */
export async function claimTarget(db, targetId, sessionId, { now = new Date() } = {}) {
  const ref = db.doc(`outboundTargets/${targetId}`);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { claimed: false, reason: 'missing' };
    const target = snapshot.data();

    if (target.lockedBySessionId && target.lockedBySessionId !== sessionId && !lockIsStale(target, now)) {
      return { claimed: false, reason: 'locked' };
    }
    if (!DIALABLE_STATES.includes(target.state)) {
      return { claimed: false, reason: `state_${target.state}` };
    }

    transaction.update(ref, {
      lockedBySessionId: sessionId,
      lockedAt: Timestamp.fromDate(now),
      state: 'dialing',
      updatedAt: FieldValue.serverTimestamp()
    });
    return { claimed: true, target: { id: targetId, ...target, state: 'dialing' } };
  });
}

/** Give a target back — on skip, on session end, or on stale-lock cleanup. */
export async function releaseTarget(db, targetId, { state = 'ready', nextAttemptAt = null, extra = {} } = {}) {
  const update = {
    lockedBySessionId: '',
    lockedAt: null,
    state,
    updatedAt: FieldValue.serverTimestamp(),
    ...extra
  };
  if (nextAttemptAt) update.nextAttemptAt = Timestamp.fromDate(nextAttemptAt);
  await db.doc(`outboundTargets/${targetId}`).set(update, { merge: true });
}

/**
 * Eligible targets for a campaign, most urgent first.
 *
 * `nextAttemptAt` is the ordering key rather than `priority` alone: a target
 * scheduled for 2pm must not be handed out at 11am just because it is high
 * priority. Locked targets are filtered in memory — Firestore cannot express
 * "unlocked OR lock older than five minutes" in a single query, and the
 * alternative (a scheduled sweep that clears stale locks) also exists, in
 * outbound-calls.js, so this filter is belt and braces.
 */
export async function eligibleTargets(db, campaignId, { limit = 10, now = new Date(), contactType = '' } = {}) {
  let query = db.collection('outboundTargets')
    .where('campaignId', '==', campaignId)
    .where('state', 'in', DIALABLE_STATES);
  if (contactType) query = query.where('contactType', '==', contactType);

  const snapshot = await query
    .orderBy('nextAttemptAt', 'asc')
    .orderBy('priority', 'desc')
    .limit(limit * 4)
    .get();

  const out = [];
  for (const entry of snapshot.docs) {
    const target = { id: entry.id, ...entry.data() };
    const nextAttemptAt = asDate(target.nextAttemptAt);
    if (nextAttemptAt && nextAttemptAt.getTime() > now.getTime()) continue;
    if (target.lockedBySessionId && !lockIsStale(target, now)) continue;
    out.push(target);
    if (out.length >= limit) break;
  }
  return out;
}
