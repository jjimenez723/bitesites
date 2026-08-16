// Technical guardrails for calls that come to us.
//
// outbound-compliance.js answers one question — may we dial this person, right
// now — and every rule in it depends on knowing who we are about to call and
// where they are. Inbound inverts all of that. We do not choose who calls, when
// they call, or from which state, and we know none of it until after we have
// already answered. So none of the outbound machinery transfers, and the rules
// that replace it have to hold unconditionally.
//
// Two things follow, and they are the whole of this module.
//
// First, disclosure cannot be conditional. Outbound, recording and AI notices
// are campaign settings evaluated against a known prospect. Inbound, there is
// no campaign and no known prospect at the moment the line opens, so the notice
// is given on every call or it is not reliably given at all.
//
// Second — and this is the gap that actually had teeth — an inbound caller had
// no way to opt out. markDoNotCall() takes a targetId: it suppresses a person
// by way of the record we hold for them. Someone who rings the main line and
// says "take me off your list" may have no target, no prospect, no record of
// any kind, and under the old shape their request had nowhere to land. Worse,
// even a caller we *did* know was only suppressed as long as that record
// survived: buy a list three months later, import the same number under a fresh
// prospect document, and the opt-out was gone.
//
// So suppression here is keyed by the phone number itself and stored
// independently of any contact record. It is the one fact that must outlive
// every document it touches.
//
// IMPORTANT: none of this is legal advice, and the same caveat that opens
// outbound-compliance.js applies with more force inbound — consent, recording
// law, AI disclosure and opt-out handling vary by the caller's jurisdiction,
// which inbound you cannot know in advance. Review by counsel before an AI
// answers a public line.

import { clean, hashKey, normalizePhone } from './prospect-normalization.js';

/** Collection of numbers that must never be dialled, whoever they belong to. */
export const SUPPRESSION_COLLECTION = 'suppressedNumbers';

/**
 * Deterministic id for a suppressed number.
 *
 * Hashed rather than stored raw, matching the convention in
 * prospect-normalization.js: an index that exists to answer "is this number
 * suppressed" does not need to be a readable directory of everyone who has ever
 * asked us to stop calling. The hash is enough to answer the question and
 * useless for anything else.
 */
export const suppressionId = phone => {
  const e164 = normalizePhone(phone);
  return e164 ? hashKey(e164) : '';
};

/**
 * The lines an agent must say on an inbound call, as data rather than prose
 * baked into a prompt — same reasoning as requiredDisclosures() outbound: a
 * script cannot omit by accident what a test can assert the presence of.
 *
 * Every line is unconditional. The outbound version gates the AI notice on
 * `campaign.mode === 'ai'` and the recording notice on a campaign setting,
 * because outbound both are known before the call. Here the only honest default
 * is to disclose, because the alternative is deciding what a stranger is owed
 * after they are already speaking.
 */
export function inboundDisclosures({ recorded = true } = {}) {
  const lines = [
    'State in your first sentence that you are an AI assistant for BiteSites. Never claim or imply that you are a human, and answer honestly and immediately if the caller asks whether they are speaking to a person.'
  ];
  if (recorded) {
    lines.push('State that the call is recorded and transcribed before discussing anything else. If the caller objects, stop recording or end the call — do not continue over an objection.');
  }
  lines.push('If the caller asks not to be contacted again, confirm it plainly, tell them it is done, and do not attempt to overcome the objection or ask why.');
  lines.push('You are speaking to a member of the public who may never have heard of BiteSites. Do not imply an existing relationship, a prior conversation, or a prior agreement.');
  return lines;
}

/**
 * Phrases that mean "stop contacting me" clearly enough to act on without
 * asking the model to adjudicate.
 *
 * This is a safety net beneath the agent's own opt-out tool, not a replacement
 * for it: the tool is the intended path, and this catches the case where the
 * model hears the request and fails to call it. Deliberately narrow — an
 * opt-out wrongly recorded costs one lost lead, but the reverse costs a person
 * their request being ignored, so the list errs toward matching only
 * unambiguous phrasing.
 */
const OPT_OUT_PATTERNS = [
  /\bdo not (?:ever )?(?:call|contact|phone)\b/,
  /\bdon'?t (?:ever )?(?:call|contact|phone) me\b/,
  /\bstop (?:calling|contacting|phoning)\b/,
  // "off your list" and "from your list" are equally common, and a matcher that
  // heard only one of them would ignore half of the people who said it plainly.
  /\b(?:take|remove|delete) me (?:off|from) (?:your |the |any |all )*(?:list|lists|database|records|system|file)\b/,
  /\bunsubscribe me\b/,
  /\bnever (?:call|contact) me\b/,
  /\bput me on (?:your |the )?do.?not.?call\b/,
  /\bopt (?:me )?out\b/
];

/** Does this utterance unambiguously ask us to stop contacting the caller? */
export function detectOptOutRequest(text) {
  const normalized = clean(text, 2000).toLowerCase();
  if (!normalized) return false;
  return OPT_OUT_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Is this number suppressed?
 *
 * One document read against a deterministic id — cheap enough to sit on the
 * dial path and on the import path, which is the point: a suppression that is
 * only checked in one of those two places is a suppression that leaks.
 */
export async function isSuppressed(db, phone) {
  const id = suppressionId(phone);
  if (!id) return false;
  const snapshot = await db.doc(`${SUPPRESSION_COLLECTION}/${id}`).get();
  return snapshot.exists;
}

/**
 * Which of these numbers are suppressed, as a Set of E.164 strings.
 *
 * Batched for the callers that hold a list — an import run, or a dial slice
 * checking its candidates — so neither has to choose between N reads and
 * skipping the check.
 */
export async function loadSuppressedNumbers(db, phones = []) {
  const byId = new Map();
  for (const phone of phones) {
    const e164 = normalizePhone(phone);
    const id = e164 ? hashKey(e164) : '';
    if (id && !byId.has(id)) byId.set(id, e164);
  }
  if (!byId.size) return new Set();

  const suppressed = new Set();
  const ids = [...byId.keys()];
  // getAll is variadic and unbounded in the admin SDK; chunk anyway so an
  // import of ten thousand rows cannot build one enormous request.
  for (let index = 0; index < ids.length; index += 300) {
    const chunk = ids.slice(index, index + 300);
    const snapshots = await db.getAll(...chunk.map(id => db.doc(`${SUPPRESSION_COLLECTION}/${id}`)));
    snapshots.forEach((snapshot, position) => {
      if (snapshot.exists) suppressed.add(byId.get(chunk[position]));
    });
  }
  return suppressed;
}

/**
 * Record that this number must never be dialled again.
 *
 * Writes the standalone suppression record first and unconditionally. That
 * ordering is the whole design: every other effect below depends on finding a
 * record for this person, and the caller who most needs suppressing is
 * precisely the one we have no record of. If the sweep that follows fails, the
 * number is still suppressed, and the dial and import paths will both honour it.
 *
 * Idempotent, and deliberately never un-suppresses: `firstRequestedAt` is
 * preserved across repeat calls, so a later opt-out cannot quietly reset the
 * date on which someone first asked us to stop.
 */
export async function suppressNumber(db, phone, {
  actor = '', reason = 'inbound_request', source = 'inbound', callId = '', now = new Date(), FieldValue
} = {}) {
  const e164 = normalizePhone(phone);
  if (!e164) return { ok: false, reason: 'no_valid_phone' };
  const id = hashKey(e164);
  const ref = db.doc(`${SUPPRESSION_COLLECTION}/${id}`);

  const existing = await ref.get();
  await ref.set({
    phoneE164: e164,
    reason: clean(reason, 120) || 'inbound_request',
    source: clean(source, 60) || 'inbound',
    actor: clean(actor, 160),
    lastCallId: clean(callId, 200),
    requestCount: (existing.exists ? Number(existing.get('requestCount')) || 0 : 0) + 1,
    firstRequestedAt: existing.exists ? existing.get('firstRequestedAt') : toStamp(now, FieldValue),
    lastRequestedAt: toStamp(now, FieldValue),
    updatedAt: toStamp(now, FieldValue)
  }, { merge: true });

  return { ok: true, phoneE164: e164, id, alreadySuppressed: existing.exists };
}

const toStamp = (now, FieldValue) =>
  (FieldValue?.serverTimestamp ? FieldValue.serverTimestamp() : now);

/**
 * Find the most recent outbound call placed to this number.
 *
 * Two uses, and the second is the one that matters. An agent answering a
 * callback can acknowledge it rather than greeting a returning prospect as a
 * stranger — but more importantly, an opt-out spoken on an inbound call can be
 * attached to the target it belongs to, so the person is suppressed in the
 * campaign that called them and not merely in the abstract.
 *
 * Returns null when the caller is genuinely unknown, which is the normal case
 * for a number published on a website and must stay a supported one.
 */
export async function matchInboundCaller(db, phone, { limit = 1 } = {}) {
  const e164 = normalizePhone(phone);
  if (!e164) return null;
  // `phoneE164` on a call document is the number that was dialled — snapshotted
  // at dial time, so it still matches even if the contact was edited since.
  const snapshot = await db.collection('calls')
    .where('direction', '==', 'outbound')
    .where('phoneE164', '==', e164)
    .orderBy('startedAt', 'desc')
    .limit(Math.max(1, Math.min(5, limit)))
    .get()
    .catch(() => null);
  if (!snapshot || snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return {
    callId: doc.id,
    targetId: clean(doc.get('targetId'), 200),
    campaignId: clean(doc.get('campaignId'), 200),
    sessionId: clean(doc.get('sessionId'), 200),
    startedAt: doc.get('startedAt') || null
  };
}
