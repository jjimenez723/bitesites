// Appointment scheduling for BiteSites — the in-dashboard calendar and its
// Google Calendar mirror.
//
// Two rules shape everything here:
//
// 1. The AI never invents a time. It reads slots this module produced, holds
//    one, then commits it. `computeAvailableSlots` is pure so the same
//    availability the agent speaks aloud is the availability the dashboard
//    draws and the tests assert.
//
// 2. Firestore is the book of record; Google Calendar is a mirror. A booking
//    is committed locally before Google is touched, and a Google failure is
//    recorded on the appointment rather than thrown. A calendar outage must
//    never break a live phone call or lose a confirmed meeting.

import { randomBytes } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { JWT } from 'google-auth-library';

import { clean } from './prospect-normalization.js';
import { ACCOUNTS, LEGACY_ACCOUNT_ID, readAccountId, requireAccountId } from './accounts.js';

const DAY_MS = 86400000;
const MINUTE_MS = 60000;

/** How long a voice-held slot survives without a commit. */
export const HOLD_TTL_MS = 5 * MINUTE_MS;

/** Overlap lookback. No appointment may be longer than this. */
const MAX_APPOINTMENT_MS = 4 * 60 * MINUTE_MS;

export const APPOINTMENT_STATES = Object.freeze([
  'held', 'booked', 'cancelled', 'completed', 'no_show'
]);

/** States that occupy a slot. Cancelled/completed do not block new bookings. */
const BLOCKING_STATES = new Set(['held', 'booked']);

export const DEFAULT_CALENDAR_SETTINGS = Object.freeze({
  timezone: 'America/New_York',
  slotMinutes: 20,
  bufferMinutes: 10,
  leadTimeMinutes: 120,
  horizonDays: 14,
  capacity: 1,
  // 0 = Sunday. Local wall-clock, in `timezone`.
  workingHours: {
    1: [['09:00', '17:00']],
    2: [['09:00', '17:00']],
    3: [['09:00', '17:00']],
    4: [['09:00', '17:00']],
    5: [['09:00', '16:00']]
  },
  blackoutDates: [],
  meetingTitle: 'BiteSites strategy call',
  hostName: 'BiteSites specialist'
});

export function calendarDefaultsForAccount(accountId = LEGACY_ACCOUNT_ID) {
  const id = readAccountId(accountId, { fallback: LEGACY_ACCOUNT_ID });
  const label = ACCOUNTS[id]?.label || ACCOUNTS[LEGACY_ACCOUNT_ID].label;
  return {
    ...DEFAULT_CALENDAR_SETTINGS,
    workingHours: { ...DEFAULT_CALENDAR_SETTINGS.workingHours },
    meetingTitle: `${label} consultation`,
    hostName: `${label} specialist`
  };
}

const pad = value => String(value).padStart(2, '0');
const int = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

// ------------------------------------------------------------------ timezone

/**
 * Offset of `timeZone` from UTC at a given instant, in milliseconds.
 * Node 22 ships full ICU, so `Intl` is the authority on DST rather than a
 * hand-maintained table.
 */
export function timeZoneOffsetMs(utcMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) parts[part.type] = part.value;
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = Number(parts.hour) % 24;
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second)
  );
  return asIfUtc - utcMs;
}

/** Civil date/time fields for an instant, as seen in `timeZone`. */
export function zonedParts(utcMs, timeZone) {
  const offset = timeZoneOffsetMs(utcMs, timeZone);
  const shifted = new Date(utcMs + offset);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  };
}

/**
 * The instant at which a wall-clock time occurs in `timeZone`.
 *
 * Probes the offset twice: the first guess can land on the wrong side of a DST
 * transition, and re-probing with the corrected instant resolves it. Times that
 * do not exist (the spring-forward gap) resolve to the instant the clock jumps
 * to, which is the behaviour a scheduler wants.
 */
export function zonedWallClockToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = timeZoneOffsetMs(naive, timeZone);
  const candidate = naive - firstOffset;
  const secondOffset = timeZoneOffsetMs(candidate, timeZone);
  return firstOffset === secondOffset ? candidate : naive - secondOffset;
}

/** Next civil date. Pure calendar arithmetic — never adds 24h to an instant. */
function nextCivilDate({ year, month, day }) {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    weekday: next.getUTCDay()
  };
}

function civilWeekday({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function parseHourMinute(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// ------------------------------------------------------------------ settings

export function normalizeCalendarSettings(input = {}, { accountId = LEGACY_ACCOUNT_ID } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const defaults = calendarDefaultsForAccount(accountId);
  let timezone = clean(source.timezone, 80) || defaults.timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    timezone = defaults.timezone;
  }

  const workingHours = {};
  const rawHours = source.workingHours && typeof source.workingHours === 'object'
    ? source.workingHours
    : defaults.workingHours;
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const windows = Array.isArray(rawHours[weekday]) ? rawHours[weekday]
      : Array.isArray(rawHours[String(weekday)]) ? rawHours[String(weekday)] : [];
    const safe = [];
    for (const window of windows.slice(0, 4)) {
      const open = parseHourMinute(Array.isArray(window) ? window[0] : window?.open);
      const close = parseHourMinute(Array.isArray(window) ? window[1] : window?.close);
      if (!open || !close) continue;
      const openMinutes = open.hour * 60 + open.minute;
      const closeMinutes = close.hour * 60 + close.minute;
      if (closeMinutes <= openMinutes) continue;
      safe.push([`${pad(open.hour)}:${pad(open.minute)}`, `${pad(close.hour)}:${pad(close.minute)}`]);
    }
    if (safe.length) workingHours[String(weekday)] = safe;
  }

  return {
    timezone,
    slotMinutes: int(source.slotMinutes, 5, 240, defaults.slotMinutes),
    bufferMinutes: int(source.bufferMinutes, 0, 120, defaults.bufferMinutes),
    leadTimeMinutes: int(source.leadTimeMinutes, 0, 10080, defaults.leadTimeMinutes),
    horizonDays: int(source.horizonDays, 1, 90, defaults.horizonDays),
    capacity: int(source.capacity, 1, 20, defaults.capacity),
    workingHours: Object.keys(workingHours).length ? workingHours : { ...defaults.workingHours },
    blackoutDates: (Array.isArray(source.blackoutDates) ? source.blackoutDates : [])
      .map(value => clean(value, 10))
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .slice(0, 200),
    meetingTitle: clean(source.meetingTitle, 200) || defaults.meetingTitle,
    hostName: clean(source.hostName, 120) || defaults.hostName,
    // Neither of these is a secret — a calendar ID is an email address — so
    // they live in settings where an admin can change them without a redeploy.
    // Only the service-account key is held in Secret Manager.
    googleCalendarId: clean(source.googleCalendarId, 300),
    googleImpersonate: clean(source.googleImpersonate, 200),
    googleSyncEnabled: source.googleSyncEnabled !== false
  };
}

// --------------------------------------------------------------- slot tokens

/**
 * Slot IDs are opaque to the model but decodable by the server, and they are
 * re-validated against live availability at hold time. They carry no authority
 * of their own — a forged one simply fails the conflict check.
 */
export function encodeSlotId(startMs, durationMinutes) {
  return `slot_${Buffer.from(`${Math.round(startMs)}:${Math.round(durationMinutes)}`, 'utf8')
    .toString('base64url')}`;
}

export function decodeSlotId(slotId) {
  const token = clean(slotId, 200);
  if (!token.startsWith('slot_')) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(token.slice(5), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(\d{10,16}):(\d{1,3})$/.exec(decoded);
  if (!match) return null;
  const startMs = Number(match[1]);
  const durationMinutes = Number(match[2]);
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  return { startMs, durationMinutes, endMs: startMs + durationMinutes * MINUTE_MS };
}

// ------------------------------------------------------------- availability

function normalizeBusy(busy = []) {
  return (Array.isArray(busy) ? busy : [])
    .map(entry => ({
      startMs: Number(entry?.startMs ?? entry?.start ?? 0),
      endMs: Number(entry?.endMs ?? entry?.end ?? 0)
    }))
    .filter(entry => Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs) && entry.endMs > entry.startMs);
}

function countOverlaps(intervals, startMs, endMs) {
  let count = 0;
  for (const interval of intervals) {
    if (interval.startMs < endMs && interval.endMs > startMs) count += 1;
  }
  return count;
}

/**
 * Bookable slots inside a window, honouring working hours, blackout dates,
 * lead time, booking horizon and existing commitments.
 *
 * Pure: the dashboard, the agent and the tests all read the same function.
 */
export function computeAvailableSlots({
  settings, busy = [], fromMs, toMs, nowMs = Date.now(), limit = 3
} = {}) {
  const config = normalizeCalendarSettings(settings);
  const slotMs = config.slotMinutes * MINUTE_MS;
  const strideMs = (config.slotMinutes + config.bufferMinutes) * MINUTE_MS;
  const maxResults = int(limit, 1, 50, 3);

  const windowStart = Math.max(Number(fromMs) || nowMs, nowMs + config.leadTimeMinutes * MINUTE_MS);
  const windowEnd = Math.min(
    Number(toMs) || (nowMs + config.horizonDays * DAY_MS),
    nowMs + config.horizonDays * DAY_MS
  );
  if (!(windowEnd > windowStart)) return [];

  const intervals = normalizeBusy(busy);
  const slots = [];
  let date = zonedParts(windowStart, config.timezone);

  for (let dayIndex = 0; dayIndex <= config.horizonDays + 1; dayIndex += 1) {
    if (slots.length >= maxResults) break;
    const dateKey = `${date.year}-${pad(date.month)}-${pad(date.day)}`;
    const dayStart = zonedWallClockToUtc({ ...date, hour: 0, minute: 0 }, config.timezone);
    if (dayStart > windowEnd) break;

    if (!config.blackoutDates.includes(dateKey)) {
      const windows = config.workingHours[String(civilWeekday(date))] || [];
      for (const [openText, closeText] of windows) {
        if (slots.length >= maxResults) break;
        const open = parseHourMinute(openText);
        const close = parseHourMinute(closeText);
        if (!open || !close) continue;
        const openMs = zonedWallClockToUtc({ ...date, ...open }, config.timezone);
        const closeMs = zonedWallClockToUtc({ ...date, ...close }, config.timezone);

        for (let start = openMs; start + slotMs <= closeMs; start += strideMs) {
          if (slots.length >= maxResults) break;
          if (start < windowStart || start >= windowEnd) continue;
          if (countOverlaps(intervals, start, start + slotMs) >= config.capacity) continue;
          slots.push({
            slotId: encodeSlotId(start, config.slotMinutes),
            startMs: start,
            endMs: start + slotMs,
            startIso: new Date(start).toISOString(),
            durationMinutes: config.slotMinutes,
            timezone: config.timezone,
            spoken: describeSlotForSpeech(start, config.timezone)
          });
        }
      }
    }

    date = nextCivilDate(date);
  }

  return slots;
}

/**
 * How the agent should say a time out loud. Written for the ear, not the eye:
 * a weekday and a clock time, never an ISO string or a bare date.
 */
export function describeSlotForSpeech(startMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
  });
  return formatter.format(new Date(startMs)).replace(/ /g, ' ');
}

/** Speakable, unambiguous confirmation code. No 0/O/1/I/L. */
export function generateConfirmationRef(bytes = randomBytes(8)) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[bytes[index % bytes.length] % alphabet.length];
  }
  return `BS-${code.slice(0, 3)}-${code.slice(3)}`;
}

/** Free-text window ("tuesday morning", "next week") → a search range. */
export function resolveRequestedWindow(text, { nowMs = Date.now(), settings } = {}) {
  const config = normalizeCalendarSettings(settings);
  const phrase = String(text || '').toLowerCase();
  const horizonEnd = nowMs + config.horizonDays * DAY_MS;
  let fromMs = nowMs;
  let toMs = horizonEnd;

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const namedDay = weekdays.findIndex(day => phrase.includes(day));

  if (phrase.includes('tomorrow')) {
    const today = zonedParts(nowMs, config.timezone);
    const target = nextCivilDate(today);
    fromMs = zonedWallClockToUtc({ ...target, hour: 0, minute: 0 }, config.timezone);
    toMs = fromMs + DAY_MS;
  } else if (namedDay >= 0) {
    let cursor = zonedParts(nowMs, config.timezone);
    for (let step = 0; step <= 14; step += 1) {
      cursor = nextCivilDate(cursor);
      if (civilWeekday(cursor) === namedDay) break;
    }
    fromMs = zonedWallClockToUtc({ ...cursor, hour: 0, minute: 0 }, config.timezone);
    toMs = fromMs + DAY_MS;
  } else if (phrase.includes('next week')) {
    fromMs = nowMs + 7 * DAY_MS;
    toMs = Math.min(fromMs + 7 * DAY_MS, horizonEnd);
  } else if (phrase.includes('this week')) {
    toMs = Math.min(nowMs + 7 * DAY_MS, horizonEnd);
  }

  // A part-of-day qualifier narrows within whatever day range we landed on.
  const dayStartParts = zonedParts(fromMs, config.timezone);
  const clampToHours = (openHour, closeHour) => {
    const open = zonedWallClockToUtc({ ...dayStartParts, hour: openHour, minute: 0 }, config.timezone);
    const close = zonedWallClockToUtc({ ...dayStartParts, hour: closeHour, minute: 0 }, config.timezone);
    fromMs = Math.max(fromMs, open);
    toMs = Math.min(Math.max(toMs, open), close);
  };
  if (phrase.includes('morning')) clampToHours(6, 12);
  else if (phrase.includes('afternoon')) clampToHours(12, 17);
  else if (phrase.includes('evening')) clampToHours(17, 21);

  return { fromMs: Math.max(fromMs, nowMs), toMs: Math.max(toMs, fromMs + MINUTE_MS) };
}

// ------------------------------------------------------------ firestore side

export async function loadCalendarSettings(db, accountId = LEGACY_ACCOUNT_ID) {
  const account = requireAccountId(accountId, { field: 'calendar.accountId' });
  let snapshot = await db.doc(`calendarSettings/${account}`).get();
  // BiteSites used calendarSettings/default before calendars were entity-aware.
  // Read that row only as a compatibility fallback; every new write is scoped.
  if (!snapshot.exists && account === LEGACY_ACCOUNT_ID) {
    snapshot = await db.doc('calendarSettings/default').get();
  }
  return normalizeCalendarSettings(snapshot.exists ? snapshot.data() : {}, { accountId: account });
}

const toMillis = value => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
};

/**
 * Appointments that block a window.
 *
 * Firestore allows a range filter on one field only, so this queries by
 * `startAt` with a lookback of `MAX_APPOINTMENT_MS` and rejects non-overlapping
 * rows in memory. Expired holds are treated as free.
 */
export async function loadBlockingAppointments(db, {
  windowStartMs, windowEndMs, nowMs = Date.now(), accountId = LEGACY_ACCOUNT_ID
}, tx = null) {
  const account = requireAccountId(accountId, { field: 'calendar.accountId' });
  const query = db.collection('appointments')
    .where('startAt', '>=', Timestamp.fromMillis(windowStartMs - MAX_APPOINTMENT_MS))
    .where('startAt', '<', Timestamp.fromMillis(windowEndMs))
    .limit(500);
  const snapshot = tx ? await tx.get(query) : await query.get();

  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(appointment => {
      if (readAccountId(appointment.accountId, { fallback: LEGACY_ACCOUNT_ID }) !== account) return false;
      if (!BLOCKING_STATES.has(appointment.status)) return false;
      if (appointment.status === 'held' && toMillis(appointment.holdExpiresAt) <= nowMs) return false;
      const startMs = toMillis(appointment.startAt);
      const endMs = toMillis(appointment.endAt);
      return endMs > windowStartMs && startMs < windowEndMs;
    })
    .map(appointment => ({
      ...appointment,
      startMs: toMillis(appointment.startAt),
      endMs: toMillis(appointment.endAt)
    }));
}

/**
 * Available slots for a spoken window. Google's own busy times are merged in
 * when the calendar is connected, so a meeting the owner typed into Google
 * directly still blocks the AI — but a Google outage degrades to Firestore-only
 * rather than failing the call.
 */
export async function findAvailability(db, {
  requestedWindow = '', fromMs = 0, toMs = 0, nowMs = Date.now(), limit = 3, google = null,
  accountId = LEGACY_ACCOUNT_ID
} = {}) {
  const account = requireAccountId(accountId, { field: 'calendar.accountId' });
  const settings = await loadCalendarSettings(db, account);
  const resolved = fromMs && toMs
    ? { fromMs, toMs }
    : resolveRequestedWindow(requestedWindow, { nowMs, settings });

  const searchEnd = Math.min(resolved.toMs, nowMs + settings.horizonDays * DAY_MS);
  const appointments = await loadBlockingAppointments(db, {
    windowStartMs: resolved.fromMs, windowEndMs: searchEnd, nowMs, accountId: account
  });
  const busy = appointments.map(entry => ({ startMs: entry.startMs, endMs: entry.endMs }));

  if (google && settings.googleSyncEnabled) {
    const googleBusy = await google.freeBusy(resolved.fromMs, searchEnd)
      .catch(error => {
        console.warn('[calendar] Google free/busy unavailable', error?.message);
        return [];
      });
    busy.push(...googleBusy);
  }

  return {
    settings,
    window: { fromMs: resolved.fromMs, toMs: searchEnd },
    slots: computeAvailableSlots({ settings, busy, fromMs: resolved.fromMs, toMs: searchEnd, nowMs, limit })
  };
}

/**
 * Reserve a slot for a few minutes. This is the transaction that makes
 * double-booking impossible: the conflict check and the write happen together,
 * so two agents offered the same slot cannot both take it.
 */
export async function holdSlot(db, {
  slotId, callId = '', campaignId = '', contactId = '', contactType = '',
  offerTrack = '', heldBy = 'ai', nowMs = Date.now(), accountId = LEGACY_ACCOUNT_ID
} = {}) {
  const account = requireAccountId(accountId, { field: 'calendar.accountId' });
  const slot = decodeSlotId(slotId);
  if (!slot) return { ok: false, error: 'invalid_slot' };

  const settings = await loadCalendarSettings(db, account);
  if (slot.startMs < nowMs + settings.leadTimeMinutes * MINUTE_MS) {
    return { ok: false, error: 'slot_too_soon' };
  }

  const ref = db.collection('appointments').doc();
  const result = await db.runTransaction(async tx => {
    const blocking = await loadBlockingAppointments(
      db, { windowStartMs: slot.startMs, windowEndMs: slot.endMs, nowMs, accountId: account }, tx
    );
    if (countOverlaps(blocking, slot.startMs, slot.endMs) >= settings.capacity) {
      return { ok: false, error: 'slot_taken' };
    }
    tx.set(ref, {
      status: 'held',
      accountId: account,
      startAt: Timestamp.fromMillis(slot.startMs),
      endAt: Timestamp.fromMillis(slot.endMs),
      durationMinutes: slot.durationMinutes,
      timezone: settings.timezone,
      holdExpiresAt: Timestamp.fromMillis(nowMs + HOLD_TTL_MS),
      source: heldBy === 'ai' ? 'ai_call' : 'manual',
      callId: clean(callId, 200),
      campaignId: clean(campaignId, 200),
      contactId: clean(contactId, 200),
      contactType: contactType === 'lead' ? 'lead' : contactType === 'prospect' ? 'prospect' : '',
      offerTrack: clean(offerTrack, 60),
      googleSyncState: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { ok: true };
  });

  if (!result.ok) return result;
  return {
    ok: true,
    holdId: ref.id,
    startIso: new Date(slot.startMs).toISOString(),
    spoken: describeSlotForSpeech(slot.startMs, settings.timezone),
    durationMinutes: slot.durationMinutes,
    expiresInSeconds: Math.round(HOLD_TTL_MS / 1000)
  };
}

const attendeeFrom = (input = {}) => ({
  name: clean(input.name, 160),
  email: clean(input.email, 200).toLowerCase(),
  phone: clean(input.phone, 40),
  company: clean(input.company, 200)
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Commit a held slot. Nothing is promised to a prospect before this returns
 * `ok` with a confirmation reference the agent reads back.
 */
export async function commitBooking(db, {
  holdId, attendee = {}, notes = '', bookedBy = 'ai', nowMs = Date.now()
} = {}) {
  const id = clean(holdId, 200);
  if (!id) return { ok: false, error: 'hold_required' };
  const contact = attendeeFrom(attendee);
  if (contact.email && !EMAIL_PATTERN.test(contact.email)) {
    return { ok: false, error: 'invalid_email' };
  }

  const ref = db.doc(`appointments/${id}`);
  const confirmation = generateConfirmationRef();

  const result = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { ok: false, error: 'hold_not_found' };
    const appointment = snapshot.data() || {};

    if (appointment.status === 'booked') {
      // Idempotent: a retried tool call must not create a second meeting.
      return {
        ok: true, idempotent: true,
        confirmationRef: clean(appointment.confirmationRef, 40),
        startMs: toMillis(appointment.startAt),
        timezone: clean(appointment.timezone, 80)
      };
    }
    if (appointment.status !== 'held') return { ok: false, error: `hold_${clean(appointment.status, 40) || 'missing'}` };
    if (toMillis(appointment.holdExpiresAt) <= nowMs) return { ok: false, error: 'hold_expired' };

    tx.set(ref, {
      status: 'booked',
      attendee: contact,
      notes: clean(notes, 1000),
      confirmationRef: confirmation,
      bookedBy: clean(bookedBy, 40),
      bookedAt: FieldValue.serverTimestamp(),
      holdExpiresAt: FieldValue.delete(),
      googleSyncState: 'pending',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      ok: true, idempotent: false,
      confirmationRef: confirmation,
      startMs: toMillis(appointment.startAt),
      timezone: clean(appointment.timezone, 80)
    };
  });

  if (!result.ok) return result;
  return {
    ...result,
    appointmentId: id,
    spoken: describeSlotForSpeech(result.startMs, result.timezone || DEFAULT_CALENDAR_SETTINGS.timezone),
    startIso: new Date(result.startMs).toISOString()
  };
}

export async function cancelAppointment(db, {
  appointmentId, reason = '', actor = '', accountId = ''
} = {}) {
  const id = clean(appointmentId, 200);
  if (!id) return { ok: false, error: 'appointment_required' };
  const ref = db.doc(`appointments/${id}`);
  const result = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { ok: false, error: 'appointment_not_found' };
    const appointmentAccount = readAccountId(snapshot.get('accountId'), { fallback: LEGACY_ACCOUNT_ID });
    if (accountId && requireAccountId(accountId, { field: 'calendar.accountId' }) !== appointmentAccount) {
      return { ok: false, error: 'account_mismatch' };
    }
    const status = snapshot.get('status');
    if (status === 'cancelled') return { ok: true, idempotent: true };
    if (!BLOCKING_STATES.has(status)) return { ok: false, error: `cannot_cancel_${clean(status, 40)}` };
    tx.set(ref, {
      status: 'cancelled',
      cancelReason: clean(reason, 300),
      cancelledBy: clean(actor, 120),
      cancelledAt: FieldValue.serverTimestamp(),
      googleSyncState: 'pending',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true, idempotent: false, googleEventId: clean(snapshot.get('googleEventId'), 300) };
  });
  return result.ok ? { ...result, appointmentId: id } : result;
}

/**
 * Move a booking. Implemented as hold-then-swap so the new slot is conflict
 * checked exactly like a fresh booking, and the old one is only released once
 * the new one is secured.
 */
export async function rescheduleAppointment(db, {
  appointmentId, slotId, actor = 'ai', nowMs = Date.now(), accountId = ''
} = {}) {
  const id = clean(appointmentId, 200);
  const slot = decodeSlotId(slotId);
  if (!id) return { ok: false, error: 'appointment_required' };
  if (!slot) return { ok: false, error: 'invalid_slot' };

  const ref = db.doc(`appointments/${id}`);
  const current = await ref.get();
  if (!current.exists) return { ok: false, error: 'appointment_not_found' };
  const appointmentAccount = readAccountId(current.get('accountId'), { fallback: LEGACY_ACCOUNT_ID });
  const requestedAccount = accountId ? requireAccountId(accountId, { field: 'calendar.accountId' }) : appointmentAccount;
  if (requestedAccount !== appointmentAccount) return { ok: false, error: 'account_mismatch' };
  const settings = await loadCalendarSettings(db, appointmentAccount);

  const result = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { ok: false, error: 'appointment_not_found' };
    if (snapshot.get('status') !== 'booked') return { ok: false, error: 'not_booked' };

    const blocking = (await loadBlockingAppointments(
      db, {
        windowStartMs: slot.startMs,
        windowEndMs: slot.endMs,
        nowMs,
        accountId: appointmentAccount
      }, tx
    )).filter(entry => entry.id !== id);
    if (countOverlaps(blocking, slot.startMs, slot.endMs) >= settings.capacity) {
      return { ok: false, error: 'slot_taken' };
    }

    tx.set(ref, {
      startAt: Timestamp.fromMillis(slot.startMs),
      endAt: Timestamp.fromMillis(slot.endMs),
      durationMinutes: slot.durationMinutes,
      rescheduledBy: clean(actor, 120),
      rescheduledAt: FieldValue.serverTimestamp(),
      googleSyncState: 'pending',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      ok: true,
      confirmationRef: clean(snapshot.get('confirmationRef'), 40),
      timezone: clean(snapshot.get('timezone'), 80) || settings.timezone
    };
  });

  if (!result.ok) return result;
  return {
    ...result,
    appointmentId: id,
    startIso: new Date(slot.startMs).toISOString(),
    spoken: describeSlotForSpeech(slot.startMs, result.timezone)
  };
}

/**
 * Drop holds nobody committed. Holds already read as free by the availability
 * check; this sweep keeps the collection and the dashboard honest.
 */
export async function expireStaleHolds(db, { nowMs = Date.now(), limit = 200 } = {}) {
  const snapshot = await db.collection('appointments')
    .where('status', '==', 'held')
    .where('holdExpiresAt', '<=', Timestamp.fromMillis(nowMs))
    .limit(limit)
    .get();
  if (snapshot.empty) return { expired: 0 };

  const batch = db.batch();
  for (const doc of snapshot.docs) {
    batch.set(doc.ref, {
      status: 'cancelled',
      cancelReason: 'hold_expired',
      cancelledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  await batch.commit();
  return { expired: snapshot.size };
}

// -------------------------------------------------------------- google sync

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.freebusy'
];
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/**
 * Service-account client for the owner's Google Calendar.
 *
 * Two supported setups: share the calendar with the service account's email
 * (simplest), or grant domain-wide delegation and pass `impersonate` to act as
 * a real user. `googleapis` is deliberately not a dependency — three REST calls
 * do not justify that install size in a Cloud Function.
 */
export function createGoogleCalendarClient({ credentialsJson, calendarId, impersonate = '' } = {}) {
  const rawCredentials = clean(credentialsJson, 20000);
  const targetCalendar = clean(calendarId, 300);
  if (!rawCredentials || !targetCalendar) return null;

  let credentials;
  try {
    credentials = JSON.parse(rawCredentials);
  } catch {
    console.warn('[calendar] GOOGLE_CALENDAR_CREDENTIALS is not valid JSON');
    return null;
  }
  if (!credentials.client_email || !credentials.private_key) {
    console.warn('[calendar] service account JSON is missing client_email/private_key');
    return null;
  }

  const jwt = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GOOGLE_SCOPES,
    subject: clean(impersonate, 200) || undefined
  });

  async function request(path, { method = 'GET', body = null, query = {} } = {}) {
    const { token } = await jwt.getAccessToken();
    const url = new URL(`${CALENDAR_API}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Google Calendar ${method} ${path} failed (${response.status}): ${clean(text, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  return {
    calendarId: targetCalendar,

    async freeBusy(fromMs, toMs) {
      const result = await request('/freeBusy', {
        method: 'POST',
        body: {
          timeMin: new Date(fromMs).toISOString(),
          timeMax: new Date(toMs).toISOString(),
          items: [{ id: targetCalendar }]
        }
      });
      const periods = result?.calendars?.[targetCalendar]?.busy || [];
      return periods
        .map(period => ({
          startMs: new Date(period.start).getTime(),
          endMs: new Date(period.end).getTime()
        }))
        .filter(period => Number.isFinite(period.startMs) && Number.isFinite(period.endMs));
    },

    async upsertEvent(eventId, event) {
      return eventId
        ? request(`/calendars/${encodeURIComponent(targetCalendar)}/events/${encodeURIComponent(eventId)}`,
            { method: 'PATCH', body: event })
        : request(`/calendars/${encodeURIComponent(targetCalendar)}/events`,
            { method: 'POST', body: event });
    },

    async deleteEvent(eventId) {
      if (!eventId) return;
      await request(`/calendars/${encodeURIComponent(targetCalendar)}/events/${encodeURIComponent(eventId)}`,
        { method: 'DELETE' }).catch(error => {
          // A already-deleted event is a success from our side.
          if (!/\(410\)|\(404\)/.test(error.message)) throw error;
        });
    }
  };
}

/** Google Calendar event body for an appointment. */
export function buildGoogleEvent(appointment, settings) {
  const attendee = appointment.attendee || {};
  const accountId = readAccountId(appointment.accountId, { fallback: LEGACY_ACCOUNT_ID });
  const accountLabel = ACCOUNTS[accountId]?.label || 'BiteSites';
  const who = clean(attendee.company || attendee.name, 160) || `${accountLabel} prospect`;
  const lines = [
    `Booked by ${appointment.source === 'ai_call' ? `the ${accountLabel} voice agent` : `a ${accountLabel} rep`}.`,
    appointment.confirmationRef ? `Confirmation: ${appointment.confirmationRef}` : '',
    attendee.name ? `Contact: ${attendee.name}` : '',
    attendee.phone ? `Phone: ${attendee.phone}` : '',
    attendee.email ? `Email: ${attendee.email}` : '',
    appointment.offerTrack ? `Interest: ${appointment.offerTrack}` : '',
    appointment.notes ? `Notes: ${appointment.notes}` : '',
    appointment.callId ? `Call: ${appointment.callId}` : ''
  ].filter(Boolean);

  return {
    summary: `${settings.meetingTitle} — ${who}`,
    description: lines.join('\n'),
    start: { dateTime: new Date(toMillis(appointment.startAt)).toISOString(), timeZone: settings.timezone },
    end: { dateTime: new Date(toMillis(appointment.endAt)).toISOString(), timeZone: settings.timezone },
    status: appointment.status === 'cancelled' ? 'cancelled' : 'confirmed',
    extendedProperties: {
      private: {
        bitesitesAppointmentId: clean(appointment.id, 200),
        accountId
      }
    }
  };
}

/**
 * Push one appointment to Google. Never throws: the local booking already
 * stands, so a sync failure is recorded for the retry sweep and the dashboard
 * rather than surfaced to a caller mid-conversation.
 */
export async function syncAppointmentToGoogle(db, appointmentId, { client, settings } = {}) {
  const id = clean(appointmentId, 200);
  if (!client || !id) return { ok: false, skipped: true };

  const ref = db.doc(`appointments/${id}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { ok: false, skipped: true };
  const appointment = { id, ...snapshot.data() };
  const accountId = readAccountId(appointment.accountId, { fallback: LEGACY_ACCOUNT_ID });

  // A hold is not a commitment. Only booked and cancelled reach the calendar.
  if (!['booked', 'cancelled'].includes(appointment.status)) return { ok: false, skipped: true };

  const config = settings || await loadCalendarSettings(db, accountId);
  const existingEventId = clean(appointment.googleEventId, 300);

  try {
    if (appointment.status === 'cancelled') {
      await client.deleteEvent(existingEventId);
      await ref.set({
        googleSyncState: 'synced', googleEventId: FieldValue.delete(),
        googleSyncedAt: FieldValue.serverTimestamp(), googleSyncError: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { ok: true, removed: true };
    }

    const event = await client.upsertEvent(existingEventId, buildGoogleEvent(appointment, config));
    await ref.set({
      googleEventId: clean(event.id, 300),
      googleEventLink: clean(event.htmlLink, 500),
      googleSyncState: 'synced',
      googleSyncedAt: FieldValue.serverTimestamp(),
      googleSyncError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true, eventId: clean(event.id, 300) };
  } catch (error) {
    console.warn('[calendar] Google sync failed', id, error?.message);
    await ref.set({
      googleSyncState: 'failed',
      googleSyncError: clean(error?.message, 300),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
    return { ok: false, error: clean(error?.message, 300) };
  }
}

/** Retry sweep for appointments Google rejected or never received. */
export async function retryPendingGoogleSync(db, {
  client, limit = 25, accountId = LEGACY_ACCOUNT_ID
} = {}) {
  if (!client) return { attempted: 0 };
  const account = requireAccountId(accountId, { field: 'calendar.accountId' });
  const settings = await loadCalendarSettings(db, account);
  const snapshot = await db.collection('appointments')
    .where('googleSyncState', 'in', ['pending', 'failed'])
    .limit(limit)
    .get();

  let synced = 0;
  let attempted = 0;
  for (const doc of snapshot.docs) {
    if (readAccountId(doc.get('accountId'), { fallback: LEGACY_ACCOUNT_ID }) !== account) continue;
    if (!['booked', 'cancelled'].includes(doc.get('status'))) continue;
    attempted += 1;
    const result = await syncAppointmentToGoogle(db, doc.id, { client, settings });
    if (result.ok) synced += 1;
  }
  return { attempted, synced };
}
