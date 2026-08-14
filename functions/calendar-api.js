// Dashboard-facing calendar endpoints and the maintenance that keeps the
// Google mirror honest.
//
// Appointments are read directly from Firestore by the console (see
// firestore.rules), so there is no list endpoint here — only the operations
// that must not be forgeable from a browser: booking, moving, cancelling,
// changing the shared schedule, and reconciling Google.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { clean } from './prospect-normalization.js';
import {
  cancelAppointment,
  commitBooking,
  createGoogleCalendarClient,
  expireStaleHolds,
  findAvailability,
  holdSlot,
  loadCalendarSettings,
  normalizeCalendarSettings,
  rescheduleAppointment,
  retryPendingGoogleSync,
  syncAppointmentToGoogle
} from './booking-calendar.js';

const GOOGLE_CALENDAR_CREDENTIALS = defineSecret('GOOGLE_CALENDAR_CREDENTIALS');

const CALENDAR_SECRETS = [GOOGLE_CALENDAR_CREDENTIALS];

const callOptions = { enforceAppCheck: false, maxInstances: 10, secrets: CALENDAR_SECRETS };

const secretValue = secret => {
  try { return secret.value() || ''; } catch { return ''; }
};

async function callerRole(db, auth) {
  const claim = clean(auth?.token?.role, 40);
  if (claim) return claim;
  const snapshot = await db.doc(`roles/${auth.uid}`).get();
  return clean(snapshot.get('role'), 40);
}

/** Anyone who works the dialer may see and book. Only managers reshape the schedule. */
async function requireCalendarAccess(request, { manage = false } = {}) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = getFirestore();
  const role = await callerRole(db, request.auth);
  if (!['admin', 'outbound_rep', 'outbound_manager'].includes(role)) {
    throw new HttpsError('permission-denied', 'This account cannot use the calendar.');
  }
  if (manage && !['admin', 'outbound_manager'].includes(role)) {
    throw new HttpsError('permission-denied', 'This account cannot change the schedule.');
  }
  return { db, uid: request.auth.uid, role, email: clean(request.auth.token?.email, 200) };
}

async function calendarClient(db) {
  const settings = await loadCalendarSettings(db).catch(() => null);
  if (!settings || settings.googleSyncEnabled === false) return null;
  return createGoogleCalendarClient({
    credentialsJson: secretValue(GOOGLE_CALENDAR_CREDENTIALS),
    calendarId: settings.googleCalendarId,
    impersonate: settings.googleImpersonate
  });
}

// ----------------------------------------------------------------- read side

export const getCalendarAvailability = onCall(callOptions, async request => {
  const { db } = await requireCalendarAccess(request);
  const fromMs = Number(request.data?.fromMs) || 0;
  const toMs = Number(request.data?.toMs) || 0;
  const result = await findAvailability(db, {
    requestedWindow: clean(request.data?.requestedWindow, 120),
    fromMs, toMs,
    limit: Math.max(1, Math.min(50, Number(request.data?.limit) || 12)),
    google: await calendarClient(db).catch(() => null)
  });
  return {
    ok: true,
    timezone: result.settings.timezone,
    durationMinutes: result.settings.slotMinutes,
    slots: result.slots
  };
});

export const getCalendarSettings = onCall(callOptions, async request => {
  const { db } = await requireCalendarAccess(request);
  const settings = await loadCalendarSettings(db);
  // A key alone is not a connection: without a calendar to write to there is
  // nothing to sync, and the console should say so rather than imply success.
  const hasKey = Boolean(secretValue(GOOGLE_CALENDAR_CREDENTIALS).replace(/[{}\s]/g, ''));
  return {
    ok: true,
    settings,
    google: {
      connected: Boolean(hasKey && settings.googleCalendarId),
      hasCredentials: hasKey,
      calendarId: settings.googleCalendarId,
      syncEnabled: settings.googleSyncEnabled
    }
  };
});

export const updateCalendarSettings = onCall(callOptions, async request => {
  const { db, uid } = await requireCalendarAccess(request, { manage: true });
  // Normalized before it lands: working hours, timezone and capacity are what
  // the availability engine trusts, so an invalid schedule must never persist.
  const settings = normalizeCalendarSettings(request.data?.settings || {});
  await db.doc('calendarSettings/default').set({
    ...settings, updatedBy: uid, updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true, settings };
});

// ---------------------------------------------------------------- write side

/**
 * Manual booking from the console. Uses the same hold-then-commit path as the
 * voice agent so a rep and an agent cannot both take the same slot.
 */
export const bookAppointment = onCall(callOptions, async request => {
  const { db, uid } = await requireCalendarAccess(request);
  const slotId = clean(request.data?.slotId, 200);
  if (!slotId) throw new HttpsError('invalid-argument', 'A slot is required.');

  const held = await holdSlot(db, {
    slotId,
    contactId: clean(request.data?.contactId, 200),
    contactType: clean(request.data?.contactType, 20),
    offerTrack: clean(request.data?.offerTrack, 60),
    heldBy: 'manual'
  });
  if (!held.ok) {
    throw new HttpsError(held.error === 'slot_taken' ? 'already-exists' : 'failed-precondition',
      held.error === 'slot_taken' ? 'That time was just taken.' : 'That slot is not bookable.');
  }

  const booked = await commitBooking(db, {
    holdId: held.holdId,
    attendee: {
      name: clean(request.data?.name, 160),
      email: clean(request.data?.email, 200),
      phone: clean(request.data?.phone, 40),
      company: clean(request.data?.company, 200)
    },
    notes: clean(request.data?.notes, 1000),
    bookedBy: uid
  });
  if (!booked.ok) throw new HttpsError('failed-precondition', 'That booking could not be completed.');

  await syncAppointmentToGoogle(db, booked.appointmentId, { client: await calendarClient(db).catch(() => null) })
    .catch(() => {});
  return booked;
});

export const rescheduleAppointmentCall = onCall(callOptions, async request => {
  const { db, uid } = await requireCalendarAccess(request);
  const result = await rescheduleAppointment(db, {
    appointmentId: clean(request.data?.appointmentId, 200),
    slotId: clean(request.data?.slotId, 200),
    actor: uid
  });
  if (!result.ok) {
    throw new HttpsError(result.error === 'slot_taken' ? 'already-exists' : 'failed-precondition',
      result.error === 'slot_taken' ? 'That time was just taken.' : 'That appointment could not be moved.');
  }
  await syncAppointmentToGoogle(db, result.appointmentId, { client: await calendarClient(db).catch(() => null) })
    .catch(() => {});
  return result;
});

export const cancelAppointmentCall = onCall(callOptions, async request => {
  const { db, uid } = await requireCalendarAccess(request);
  const result = await cancelAppointment(db, {
    appointmentId: clean(request.data?.appointmentId, 200),
    reason: clean(request.data?.reason, 300),
    actor: uid
  });
  if (!result.ok) throw new HttpsError('failed-precondition', 'That appointment could not be cancelled.');
  await syncAppointmentToGoogle(db, result.appointmentId, { client: await calendarClient(db).catch(() => null) })
    .catch(() => {});
  return result;
});

/** Mark how a meeting actually went, so booking rate and show rate can diverge. */
export const setAppointmentOutcome = onCall(callOptions, async request => {
  const { db, uid } = await requireCalendarAccess(request);
  const appointmentId = clean(request.data?.appointmentId, 200);
  const outcome = clean(request.data?.outcome, 20);
  if (!appointmentId) throw new HttpsError('invalid-argument', 'An appointment is required.');
  if (!['completed', 'no_show'].includes(outcome)) {
    throw new HttpsError('invalid-argument', 'Outcome must be completed or no_show.');
  }
  const ref = db.doc(`appointments/${appointmentId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Appointment not found.');
  if (snapshot.get('status') !== 'booked') {
    throw new HttpsError('failed-precondition', 'Only a booked appointment has an outcome.');
  }
  await ref.set({
    status: outcome, outcomeBy: uid,
    outcomeAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true, status: outcome };
});

// --------------------------------------------------------------- maintenance

/**
 * Two jobs that must not depend on anyone being on a call: releasing holds the
 * agent never committed, and re-pushing appointments Google refused. Both are
 * idempotent, so a missed run costs nothing but latency.
 */
export const calendarMaintenance = onSchedule(
  { schedule: 'every 5 minutes', secrets: CALENDAR_SECRETS, timeoutSeconds: 120, maxInstances: 1 },
  async () => {
    const db = getFirestore();
    const expired = await expireStaleHolds(db, {}).catch(error => {
      console.warn('[calendar] hold sweep failed', error?.message);
      return { expired: 0 };
    });

    const client = await calendarClient(db).catch(() => null);
    const synced = client
      ? await retryPendingGoogleSync(db, { client }).catch(error => {
          console.warn('[calendar] sync retry failed', error?.message);
          return { attempted: 0, synced: 0 };
        })
      : { attempted: 0, synced: 0 };

    if (expired.expired || synced.synced) {
      console.log('[calendar] maintenance', JSON.stringify({ ...expired, ...synced }));
    }
  }
);
