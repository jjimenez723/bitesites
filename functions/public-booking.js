// The public consultation booking page, server side.
//
// This replaces the Google appointment-schedule link the site used to point at.
// It runs on the same availability engine as the voice agents and the console —
// `computeAvailableSlots` decides what is bookable exactly once, so what a
// visitor sees on bitesites.org is what Byte offers on a call and what the
// dashboard draws.
//
// Two constraints separate this from `calendar-api.js`:
//
// 1. Nobody is signed in. App Check keeps the endpoints attached to a real
//    browser on our own origin, and a per-IP quota keeps a passing bot from
//    filling the week. Neither is a substitute for the hold-then-commit
//    transaction, which is what actually makes double booking impossible.
//
// 2. A booking here is also a lead. Someone who books a consultation without
//    ever filling in the intake form must still reach the CRM, or the meeting
//    arrives in the calendar with nobody behind it.

import { createHash } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { clean } from './prospect-normalization.js';
import { LEGACY_ACCOUNT_ID } from './accounts.js';
import {
  commitBooking,
  createGoogleCalendarClient,
  findAvailability,
  holdSlot,
  loadCalendarSettings,
  syncAppointmentToGoogle
} from './booking-calendar.js';

const GOOGLE_CALENDAR_CREDENTIALS = defineSecret('GOOGLE_CALENDAR_CREDENTIALS');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Public bookings are BiteSites' own. Partner entities book through their reps. */
const PUBLIC_ACCOUNT_ID = LEGACY_ACCOUNT_ID;

const MAX_BOOKINGS_PER_HOUR = 3;
const MAX_BOOKINGS_PER_DAY = 6;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const options = {
  enforceAppCheck: true,
  maxInstances: 10,
  secrets: [GOOGLE_CALENDAR_CREDENTIALS]
};

const secretValue = () => {
  try { return GOOGLE_CALENDAR_CREDENTIALS.value() || ''; } catch { return ''; }
};

async function calendarClient(db, settings) {
  if (!settings || settings.googleSyncEnabled === false) return null;
  return createGoogleCalendarClient({
    credentialsJson: secretValue(),
    calendarId: settings.googleCalendarId,
    impersonate: settings.googleImpersonate,
    busyCalendarIds: settings.busyCalendarIds
  });
}

function clientIp(request) {
  const raw = request.rawRequest;
  const forwarded = String(raw?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(raw?.ip || '');
}

const ipHashOf = ip => createHash('sha256')
  .update(`bitesites-public-booking:${ip}`)
  .digest('hex')
  .slice(0, 32);

/**
 * Rolling hour/day booking cap per IP, bumped inside a transaction so parallel
 * requests cannot each read the same count. One small document per IP hash and
 * no cleanup job: a stale doc is simply stale.
 */
async function consumeQuota(db, ipHash, nowMs) {
  const ref = db.doc(`publicBookingQuota/${ipHash}`);
  try {
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const quota = snapshot.exists ? snapshot.data() : {};
      const hourStartMs = quota.hourStartMs && nowMs - quota.hourStartMs < HOUR_MS ? quota.hourStartMs : nowMs;
      const hourCount = hourStartMs === quota.hourStartMs ? (quota.hourCount || 0) : 0;
      const dayStartMs = quota.dayStartMs && nowMs - quota.dayStartMs < DAY_MS ? quota.dayStartMs : nowMs;
      const dayCount = dayStartMs === quota.dayStartMs ? (quota.dayCount || 0) : 0;
      if (hourCount >= MAX_BOOKINGS_PER_HOUR || dayCount >= MAX_BOOKINGS_PER_DAY) {
        const error = new Error('quota');
        error.rateLimited = true;
        throw error;
      }
      tx.set(ref, {
        hourStartMs, hourCount: hourCount + 1,
        dayStartMs, dayCount: dayCount + 1,
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    return true;
  } catch (error) {
    if (error?.rateLimited) return false;
    throw error;
  }
}

/** `YYYY-MM-DD` as seen in the schedule's timezone, so days group the way a visitor reads them. */
function dateKeyIn(startMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(startMs));
  return parts;
}

// --------------------------------------------------------------------- read

/**
 * Open times for a window, grouped by local day.
 *
 * The page asks for a month at a time so the date picker can grey out days with
 * nothing free without a request per day.
 */
export const getPublicBookingSlots = onCall(options, async request => {
  const db = getFirestore();
  const nowMs = Date.now();
  const settings = await loadCalendarSettings(db, PUBLIC_ACCOUNT_ID);

  const requestedFrom = Number(request.data?.fromMs) || 0;
  const requestedTo = Number(request.data?.toMs) || 0;
  const horizonEnd = nowMs + settings.horizonDays * DAY_MS;
  const fromMs = Math.max(requestedFrom || nowMs, nowMs);
  const toMs = Math.min(Math.max(requestedTo || horizonEnd, fromMs + DAY_MS), horizonEnd);

  const result = await findAvailability(db, {
    accountId: PUBLIC_ACCOUNT_ID,
    fromMs,
    toMs,
    nowMs,
    limit: 600,
    maxLimit: 600,
    google: await calendarClient(db, settings).catch(() => null)
  });

  const days = new Map();
  for (const slot of result.slots) {
    const key = dateKeyIn(slot.startMs, settings.timezone);
    if (!days.has(key)) days.set(key, []);
    // Only what the page draws. The slot id is the authority; everything else
    // is re-derived server side when the booking is committed.
    days.get(key).push({ slotId: slot.slotId, startMs: slot.startMs });
  }

  return {
    ok: true,
    timezone: settings.timezone,
    durationMinutes: settings.slotMinutes,
    meetingTitle: settings.meetingTitle,
    hostName: settings.hostName,
    horizonEndMs: horizonEnd,
    window: { fromMs, toMs },
    days: [...days.entries()].map(([date, slots]) => ({ date, slots }))
  };
});

// -------------------------------------------------------------------- write

/**
 * The lead behind a public booking.
 *
 * Written with the Admin SDK, so `firestore.rules` does not gate it — which is
 * the point: a browser must not be able to forge a lead that claims a meeting
 * is on the books. Shape matches the intake form so the dashboard, the CRM
 * sync, and the notification email need no special case.
 */
async function createBookingLead(db, { attendee, notes, appointment, pagePath }) {
  const leadRef = db.collection('leads').doc();
  await leadRef.set({
    name: attendee.name || 'Consultation booking',
    email: attendee.email || '',
    phone: attendee.phone || '',
    businessSize: '',
    services: [],
    preferredContactMethod: attendee.phone && !attendee.email ? 'phone' : 'email',
    source: 'booking_page',
    status: 'new',
    accountId: PUBLIC_ACCOUNT_ID,
    createdAt: FieldValue.serverTimestamp(),
    pagePath: pagePath || '/book',
    ...(attendee.company ? { businessName: attendee.company } : {}),
    ...(notes ? { projectDetails: notes } : {}),
    booking: {
      appointmentId: appointment.appointmentId,
      confirmationRef: appointment.confirmationRef,
      startIso: appointment.startIso
    }
  });
  return leadRef.id;
}

/**
 * Take a slot the page offered.
 *
 * Hold-then-commit, the same two steps a voice agent runs, so a visitor and an
 * agent racing for the last slot on Thursday cannot both win it. Nothing is
 * confirmed to the visitor until the commit returns a reference.
 */
export const bookPublicAppointment = onCall(options, async request => {
  const db = getFirestore();
  const nowMs = Date.now();

  const slotId = clean(request.data?.slotId, 200);
  const name = clean(request.data?.name, 160);
  const email = clean(request.data?.email, 200).toLowerCase();
  const phone = clean(request.data?.phone, 40);
  const company = clean(request.data?.company, 200);
  const notes = clean(request.data?.notes, 1000);

  if (!slotId) throw new HttpsError('invalid-argument', 'Pick a time first.');
  if (!name) throw new HttpsError('invalid-argument', 'A name is required.');
  if (!EMAIL_PATTERN.test(email)) throw new HttpsError('invalid-argument', 'A valid email is required.');

  // A honeypot field no person sees. Bots fill every input on the form.
  if (clean(request.data?.website, 200)) {
    throw new HttpsError('invalid-argument', 'That booking could not be completed.');
  }

  const ipHash = ipHashOf(clientIp(request));
  if (!await consumeQuota(db, ipHash, nowMs)) {
    throw new HttpsError('resource-exhausted',
      'That is a lot of bookings from one place. Email jensy@bitesites.org and we will sort it out.');
  }

  const held = await holdSlot(db, {
    slotId, accountId: PUBLIC_ACCOUNT_ID, heldBy: 'manual', nowMs
  });
  if (!held.ok) {
    throw new HttpsError(held.error === 'slot_taken' ? 'already-exists' : 'failed-precondition',
      held.error === 'slot_taken'
        ? 'Someone just took that time. Pick another and we will get you in.'
        : 'That time is no longer bookable. Pick another.');
  }

  const booked = await commitBooking(db, {
    holdId: held.holdId,
    attendee: { name, email, phone, company },
    notes,
    bookedBy: 'public_booking_page',
    nowMs
  });
  if (!booked.ok) throw new HttpsError('failed-precondition', 'That booking could not be completed.');

  const settings = await loadCalendarSettings(db, PUBLIC_ACCOUNT_ID).catch(() => null);

  // Neither of these is allowed to fail the booking: the meeting is already
  // committed in Firestore, and the maintenance sweep re-pushes Google.
  // The return value carries the Meet link so the confirmation screen can show
  // it immediately. A failure here still leaves the booking standing — the
  // maintenance sweep re-pushes, and the confirmation email carries the link.
  const synced = await syncAppointmentToGoogle(db, booked.appointmentId, {
    client: await calendarClient(db, settings).catch(() => null),
    settings
  }).catch(() => null);

  const leadId = await createBookingLead(db, {
    attendee: { name, email, phone, company },
    notes,
    appointment: booked,
    pagePath: clean(request.data?.pagePath, 300)
  }).catch(error => {
    console.error('[public-booking] lead write failed', error?.message);
    return '';
  });

  if (leadId) {
    await db.doc(`appointments/${booked.appointmentId}`)
      .set({ leadId, contactType: 'lead', contactId: leadId }, { merge: true })
      .catch(() => {});
  }

  // The attendee's confirmation email is sent by `sendMeetingBookedEmails`,
  // which fires on the appointment reaching `booked` — one send path for every
  // way a meeting can be made.
  return {
    ok: true,
    appointmentId: booked.appointmentId,
    confirmationRef: booked.confirmationRef,
    startIso: booked.startIso,
    spoken: booked.spoken,
    timezone: settings?.timezone || '',
    durationMinutes: settings?.slotMinutes || 0,
    meetUrl: synced?.meetUrl || ''
  };
});
