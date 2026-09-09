import { createHash, randomBytes } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const QUESTIONNAIRE_CHOICES = Object.freeze({
  helpWith: Object.freeze(['website', 'voice_ai', 'automation', 'lead_generation', 'crm_followup', 'custom', 'not_sure']),
  obstacles: Object.freeze(['not_enough_leads', 'low_conversion', 'missed_calls', 'slow_followup', 'weak_website', 'manual_work', 'credibility', 'disconnected_systems', 'other']),
  wins: Object.freeze(['booked_appointments', 'qualified_leads', 'fewer_missed_calls', 'professional_website', 'automate_work', 'better_conversion', 'scale_team', 'other']),
  timing: Object.freeze(['asap', 'within_month', 'one_to_three_months', 'exploring']),
  budget: Object.freeze(['', 'under_2k', '2k_5k', '5k_10k', '10k_plus'])
});

const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const exactClean = (value, max, field) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} is too long.`);
  return trimmed;
};
const tokenHash = token => createHash('sha256').update(String(token || '')).digest('hex');
const allowedKeys = new Set([
  'helpWith', 'businessName', 'businessSummary', 'website', 'location',
  'obstacles', 'obstacleDetails', 'wins', 'winDetails', 'timing', 'budget',
  'links', 'anythingElse'
]);

const safeHttpsUrl = (value, field, { optional = true } = {}) => {
  const raw = exactClean(value, 1000, field);
  if (!raw && optional) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { /* handled below */ }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`${field} must be a secure https:// URL.`);
  }
  return parsed.toString();
};

const choices = (value, field, { min = 1, max = 8 } = {}) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`Choose ${min ? 'at least one' : 'valid'} option for ${field}.`);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length || unique.some(item => !QUESTIONNAIRE_CHOICES[field].includes(item))) {
    throw new Error(`${field} contains an invalid option.`);
  }
  return unique;
};

export function validateQuestionnaireAnswers(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Questionnaire answers are required.');
  const unknown = Object.keys(input).filter(key => !allowedKeys.has(key));
  if (unknown.length) throw new Error(`Unknown questionnaire field: ${unknown[0]}.`);

  const businessName = exactClean(input.businessName, 160, 'Business name');
  const businessSummary = exactClean(input.businessSummary, 700, 'Business summary');
  if (!businessName) throw new Error('Business name is required.');
  if (!businessSummary) throw new Error('Tell us briefly what the business does.');
  const timing = exactClean(input.timing, 40, 'Timing');
  if (!QUESTIONNAIRE_CHOICES.timing.includes(timing)) throw new Error('Choose a timing option.');
  const budget = exactClean(input.budget, 80, 'Budget');
  if (!QUESTIONNAIRE_CHOICES.budget.includes(budget)) throw new Error('Budget contains an invalid option.');

  const linksInput = input.links == null ? [] : input.links;
  if (!Array.isArray(linksInput) || linksInput.length > 6) throw new Error('Add no more than six reference links.');
  const links = linksInput.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Reference link ${index + 1} is invalid.`);
    const unknownLinkKey = Object.keys(item).find(key => !['label', 'url'].includes(key));
    if (unknownLinkKey) throw new Error(`Unknown reference-link field: ${unknownLinkKey}.`);
    return {
      label: exactClean(item.label, 80, `Reference link ${index + 1} label`) || `Reference ${index + 1}`,
      url: safeHttpsUrl(item.url, `Reference link ${index + 1}`)
    };
  });

  return {
    helpWith: choices(input.helpWith, 'helpWith', { max: 7 }),
    businessName,
    businessSummary,
    website: safeHttpsUrl(input.website, 'Website'),
    location: exactClean(input.location, 180, 'Location'),
    obstacles: choices(input.obstacles, 'obstacles', { max: 9 }),
    obstacleDetails: exactClean(input.obstacleDetails, 700, 'Obstacle details'),
    wins: choices(input.wins, 'wins', { max: 8 }),
    winDetails: exactClean(input.winDetails, 500, 'Win details'),
    timing,
    budget,
    links,
    anythingElse: exactClean(input.anythingElse, 1200, 'Additional context')
  };
}

const roleFor = async (db, auth) => {
  if (!auth?.uid) return '';
  const snapshot = await db.doc(`roles/${auth.uid}`).get();
  return snapshot.exists ? snapshot.get('role') || '' : auth.token?.role || '';
};

const requireAdmin = async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  if (await roleFor(db, request.auth) !== 'admin') throw new HttpsError('permission-denied', 'Only an admin can create questionnaire links.');
  return db;
};

export const sessionForToken = async (db, token, nowMs = Date.now()) => {
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) throw new HttpsError('not-found', 'This questionnaire link is invalid or expired.');
  const ref = db.doc(`questionnaireSessions/${tokenHash(token)}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'This questionnaire link is invalid or expired.');
  const session = snapshot.data();
  if ((session.expiresAt?.toMillis?.() || 0) <= nowMs) throw new HttpsError('deadline-exceeded', 'This questionnaire link has expired. Ask your BiteSites contact for a new one.');
  return { ref, snapshot, session };
};

export async function createQuestionnaireSessionCore(db, { leadId, uid, appUrl = 'https://bitesites.org', nowMs = Date.now(), token = randomBytes(32).toString('base64url') }) {
  const leadRef = db.doc(`leads/${leadId}`);
  const leadSnapshot = await leadRef.get();
  if (!leadSnapshot.exists) throw new HttpsError('not-found', 'Lead not found.');
  const lead = leadSnapshot.data();
  const existingUrl = clean(lead.questionnaire?.url, 2000);
  const existingExpiry = lead.questionnaire?.expiresAt?.toMillis?.() || 0;
  if (existingUrl && existingExpiry > nowMs && lead.questionnaire?.status !== 'completed') {
    return { url: existingUrl, status: lead.questionnaire?.status || 'ready', expiresAt: existingExpiry };
  }
  const id = tokenHash(token);
  const url = `${String(appUrl).replace(/\/$/, '')}/questionnaire?token=${encodeURIComponent(token)}`;
  const expiresAt = Timestamp.fromMillis(nowMs + SESSION_TTL_MS);
  const sessionRef = db.doc(`questionnaireSessions/${id}`);
  const rawWebsite = clean(lead.website, 1000);
  let website = '';
  try { website = rawWebsite ? safeHttpsUrl(/^https:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`, 'Website') : ''; }
  catch { website = ''; }
  const prefill = {
    firstName: clean(lead.name, 120).split(/\s+/)[0] || '',
    businessName: clean(lead.businessName, 160),
    website,
    location: clean(lead.location || lead.serviceArea, 180)
  };
  const batch = db.batch();
  batch.create(sessionRef, { leadId, status: 'ready', prefill, createdAt: Timestamp.fromMillis(nowMs), expiresAt, createdBy: uid });
  batch.set(leadRef, { questionnaire: { status: 'ready', url, sessionId: id, expiresAt, createdAt: Timestamp.fromMillis(nowMs), createdBy: uid }, updatedAt: Timestamp.fromMillis(nowMs) }, { merge: true });
  await batch.commit();
  return { url, status: 'ready', expiresAt: expiresAt.toMillis() };
}

export async function getQuestionnaireSessionCore(db, { token, nowMs = Date.now() }) {
  const { session } = await sessionForToken(db, token, nowMs);
  return { status: session.status === 'completed' ? 'completed' : 'ready', prefill: session.status === 'completed' ? {} : {
    firstName: clean(session.prefill?.firstName, 120), businessName: clean(session.prefill?.businessName, 160),
    website: clean(session.prefill?.website, 1000), location: clean(session.prefill?.location, 180)
  } };
}

export async function submitQuestionnaireCore(db, { token, answers: input, nowMs = Date.now() }) {
  const answers = validateQuestionnaireAnswers(input);
  const { ref: sessionRef, session } = await sessionForToken(db, token, nowMs);
  const leadRef = db.doc(`leads/${session.leadId}`);
  const responseRef = db.doc(`questionnaireResponses/${sessionRef.id}`);
  const activityRef = leadRef.collection('activities').doc(`questionnaire_${sessionRef.id}`);
  const result = await db.runTransaction(async tx => {
    const current = await tx.get(sessionRef);
    if (!current.exists) throw new HttpsError('not-found', 'This questionnaire link is invalid or expired.');
    if (current.get('status') === 'completed') return { alreadyCompleted: true };
    if ((current.get('expiresAt')?.toMillis?.() || 0) <= nowMs) throw new HttpsError('deadline-exceeded', 'This questionnaire link has expired.');
    const lead = await tx.get(leadRef);
    if (!lead.exists) throw new HttpsError('not-found', 'The associated lead no longer exists.');
    const completedAt = Timestamp.fromMillis(nowMs);
    tx.create(responseRef, { leadId: session.leadId, sessionId: sessionRef.id, answers, completedAt, source: 'prospect_questionnaire' });
    tx.update(sessionRef, { status: 'completed', completedAt });
    tx.set(leadRef, { questionnaire: { ...(lead.get('questionnaire') || {}), status: 'completed', responseId: responseRef.id, completedAt, answers }, updatedAt: completedAt }, { merge: true });
    tx.create(activityRef, { type: 'questionnaire_completed', at: completedAt });
    return { alreadyCompleted: false };
  });
  return { ok: true, ...result };
}

export const createQuestionnaireSession = onCall(
  { enforceAppCheck: true, timeoutSeconds: 15, maxInstances: 10 },
  async request => {
    const db = await requireAdmin(request);
    const leadId = clean(request.data?.leadId, 200);
    if (!leadId || leadId.includes('/')) throw new HttpsError('invalid-argument', 'Choose a lead first.');
    const appUrl = String(process.env.PUBLIC_APP_URL || 'https://bitesites.org').replace(/\/$/, '');
    return createQuestionnaireSessionCore(db, { leadId, uid: request.auth.uid, appUrl });
  }
);

export const getQuestionnaireSession = onCall(
  { enforceAppCheck: true, timeoutSeconds: 10, maxInstances: 20 },
  async request => {
    const db = getFirestore();
    const token = clean(request.data?.token, 200);
    return getQuestionnaireSessionCore(db, { token });
  }
);

export const submitQuestionnaire = onCall(
  { enforceAppCheck: true, timeoutSeconds: 15, maxInstances: 20 },
  async request => {
    const db = getFirestore();
    const token = clean(request.data?.token, 200);
    try { return await submitQuestionnaireCore(db, { token, answers: request.data?.answers }); }
    catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('invalid-argument', error.message);
    }
  }
);
