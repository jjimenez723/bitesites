import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAvailableSlots,
  decodeSlotId,
  describeSlotForSpeech,
  encodeSlotId,
  generateConfirmationRef,
  normalizeCalendarSettings,
  parseSpokenClockTime,
  resolveRequestedWindow,
  timeZoneOffsetMs,
  zonedParts,
  zonedWallClockToUtc,
  calendarDefaultsForAccount,
  normalizeBusyCalendarIds,
  DEFAULT_CALENDAR_SETTINGS,
  buildGoogleEvent,
  googleSyncOptions,
  googleEventIdForAppointment,
  GOOGLE_ADMISSION_VERSION,
  HOLD_TTL_MS,
  preflightGoogleAdmission,
  commitBooking,
  syncAppointmentToGoogle
} from './booking-calendar.js';

const ZONE = 'America/New_York';
const iso = ms => new Date(ms).toISOString();

// A Monday, 08:00 EDT.
const MONDAY_8AM_EDT = Date.parse('2026-06-15T12:00:00Z');

const settings = overrides => normalizeCalendarSettings({
  timezone: ZONE,
  slotMinutes: 20,
  bufferMinutes: 10,
  leadTimeMinutes: 120,
  horizonDays: 14,
  workingHours: { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']] },
  ...overrides
});

// ------------------------------------------------------------------ timezone

test('zone offset tracks daylight saving rather than a fixed guess', () => {
  assert.equal(timeZoneOffsetMs(Date.parse('2026-06-15T12:00:00Z'), ZONE), -4 * 3600000);
  assert.equal(timeZoneOffsetMs(Date.parse('2026-12-15T12:00:00Z'), ZONE), -5 * 3600000);
});

test('a wall-clock time resolves to the right instant on both sides of a DST change', () => {
  // 2026-11-01 is when US clocks go back. 9am local is a different UTC instant
  // either side of it, which is exactly what a naive +24h scheduler gets wrong.
  const beforeFallBack = zonedWallClockToUtc({ year: 2026, month: 10, day: 30, hour: 9, minute: 0 }, ZONE);
  const afterFallBack = zonedWallClockToUtc({ year: 2026, month: 11, day: 2, hour: 9, minute: 0 }, ZONE);
  assert.equal(iso(beforeFallBack), '2026-10-30T13:00:00.000Z');
  assert.equal(iso(afterFallBack), '2026-11-02T14:00:00.000Z');
});

test('wall clock and parts round-trip through the zone', () => {
  const instant = zonedWallClockToUtc({ year: 2026, month: 3, day: 9, hour: 14, minute: 30 }, ZONE);
  const parts = zonedParts(instant, ZONE);
  assert.deepEqual(
    { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute },
    { year: 2026, month: 3, day: 9, hour: 14, minute: 30 }
  );
});

// --------------------------------------------------------------- slot tokens

test('slot IDs round-trip and forged ones are rejected', () => {
  const startMs = Date.parse('2026-06-16T14:00:00Z');
  const decoded = decodeSlotId(encodeSlotId(startMs, 20));
  assert.equal(decoded.startMs, startMs);
  assert.equal(decoded.durationMinutes, 20);
  assert.equal(decoded.endMs, startMs + 20 * 60000);

  for (const bad of ['', 'slot_', 'nope', 'slot_!!!!', Buffer.from('x:y').toString('base64url')]) {
    assert.equal(decodeSlotId(bad), null, `accepted a bad slot id: ${bad}`);
  }
});

// -------------------------------------------------------------- availability

test('each entity receives its own calendar identity defaults', () => {
  assert.equal(calendarDefaultsForAccount('bitesites').meetingTitle, 'BiteSites consultation');
  assert.equal(calendarDefaultsForAccount('fine-line-group').meetingTitle, 'The Fine Line Group consultation');
  assert.equal(calendarDefaultsForAccount('stone-bellisimo').meetingTitle, 'Stone Bellisimo consultation');
});

test('BiteSites defaults to nine-to-five weekdays; the partner entities are untouched', () => {
  const bitesites = calendarDefaultsForAccount('bitesites');
  for (const weekday of ['1', '2', '3', '4', '5']) {
    assert.deepEqual(bitesites.workingHours[weekday], [['09:00', '17:00']],
      `weekday ${weekday} is not 9–5`);
  }
  assert.equal(bitesites.workingHours['0'], undefined, 'Sunday should be closed');
  assert.equal(bitesites.workingHours['6'], undefined, 'Saturday should be closed');

  // The partner calendars still read from the shared default, so changing the
  // BiteSites schedule cannot silently reschedule someone else's business.
  assert.deepEqual(
    calendarDefaultsForAccount('fine-line-group').workingHours,
    DEFAULT_CALENDAR_SETTINGS.workingHours
  );
});

test('BiteSites writes meetings to the business calendar and reads the personal one for conflicts', () => {
  const defaults = calendarDefaultsForAccount('bitesites');
  assert.equal(defaults.googleCalendarId, 'jensy@bitesites.org');
  assert.deepEqual(defaults.busyCalendarIds, ['jensyjimenez723@gmail.com']);
  // A partner entity inherits neither — those are one owner's calendars.
  assert.equal(calendarDefaultsForAccount('stone-bellisimo').googleCalendarId, '');
  assert.deepEqual(calendarDefaultsForAccount('stone-bellisimo').busyCalendarIds, []);
});

test('an account default fills a field the stored settings never wrote, and only that', () => {
  // Nothing stored: the account default applies.
  assert.equal(
    normalizeCalendarSettings({}, { accountId: 'bitesites' }).googleCalendarId,
    'jensy@bitesites.org'
  );
  // Cleared on purpose in the console: disconnection must survive a redeploy.
  assert.equal(
    normalizeCalendarSettings({ googleCalendarId: '' }, { accountId: 'bitesites' }).googleCalendarId,
    ''
  );
  assert.deepEqual(
    normalizeCalendarSettings({ busyCalendarIds: [] }, { accountId: 'bitesites' }).busyCalendarIds,
    []
  );
  // A stored value always wins over the default.
  assert.equal(
    normalizeCalendarSettings({ googleCalendarId: 'other@example.com' }, { accountId: 'bitesites' })
      .googleCalendarId,
    'other@example.com'
  );
});

test('conflict-only calendar ids are deduped, lowercased and bounded', () => {
  assert.deepEqual(
    normalizeBusyCalendarIds([' One@Example.com ', 'one@example.com', '', 'two@example.com']),
    ['one@example.com', 'two@example.com']
  );
  // The console offers a single comma-separated field.
  assert.deepEqual(
    normalizeBusyCalendarIds('a@example.com, b@example.com'),
    ['a@example.com', 'b@example.com']
  );
  assert.equal(normalizeBusyCalendarIds(null).length, 0);
  assert.equal(
    normalizeBusyCalendarIds(Array.from({ length: 40 }, (unused, i) => `c${i}@example.com`)).length,
    10
  );
});

test('a busy period on another calendar removes the slot', () => {
  const config = settings({ leadTimeMinutes: 0 });
  const open = computeAvailableSlots({
    settings: config, busy: [], nowMs: MONDAY_8AM_EDT, limit: 1
  });
  assert.equal(iso(open[0].startMs), '2026-06-15T13:00:00.000Z', 'expected the 09:00 EDT slot');

  // The same window, with the personal calendar busy over it. `freeBusy` merges
  // every calendar into this one list, so blocking is not conditional on which
  // calendar the commitment came from.
  const blocked = computeAvailableSlots({
    settings: config,
    busy: [{ startMs: open[0].startMs, endMs: open[0].endMs }],
    nowMs: MONDAY_8AM_EDT,
    limit: 1
  });
  assert.notEqual(blocked[0].startMs, open[0].startMs);
});

test('first offered slot respects lead time, not just opening hours', () => {
  const slots = computeAvailableSlots({
    settings: settings(), busy: [], nowMs: MONDAY_8AM_EDT, limit: 3
  });
  // Doors open 09:00, but a two-hour lead time from 08:00 pushes the first
  // bookable slot to 10:00.
  assert.equal(iso(slots[0].startMs), '2026-06-15T14:00:00.000Z');
  assert.equal(slots[0].durationMinutes, 20);
});

test('slots step by duration plus buffer', () => {
  const slots = computeAvailableSlots({
    settings: settings(), busy: [], nowMs: MONDAY_8AM_EDT, limit: 3
  });
  assert.equal(slots[1].startMs - slots[0].startMs, 30 * 60000);
  assert.equal(slots[2].startMs - slots[1].startMs, 30 * 60000);
});

test('a busy interval removes exactly the slots it overlaps', () => {
  const open = computeAvailableSlots({ settings: settings(), nowMs: MONDAY_8AM_EDT, limit: 3 });
  const taken = open[1];
  const slots = computeAvailableSlots({
    settings: settings(),
    busy: [{ startMs: taken.startMs, endMs: taken.endMs }],
    nowMs: MONDAY_8AM_EDT,
    limit: 3
  });
  assert.ok(!slots.some(slot => slot.startMs === taken.startMs), 'offered a slot that was already taken');
  assert.equal(slots[0].startMs, open[0].startMs);
});

test('a booking that merely touches a slot boundary does not block it', () => {
  const open = computeAvailableSlots({ settings: settings(), nowMs: MONDAY_8AM_EDT, limit: 2 });
  const slots = computeAvailableSlots({
    settings: settings(),
    // Ends exactly when the first slot begins.
    busy: [{ startMs: open[0].startMs - 20 * 60000, endMs: open[0].startMs }],
    nowMs: MONDAY_8AM_EDT,
    limit: 2
  });
  assert.equal(slots[0].startMs, open[0].startMs);
});

test('capacity allows concurrent meetings up to the configured limit', () => {
  const open = computeAvailableSlots({ settings: settings(), nowMs: MONDAY_8AM_EDT, limit: 1 });
  const overlap = { startMs: open[0].startMs, endMs: open[0].endMs };

  const single = computeAvailableSlots({
    settings: settings({ capacity: 1 }), busy: [overlap], nowMs: MONDAY_8AM_EDT, limit: 1
  });
  assert.notEqual(single[0].startMs, open[0].startMs);

  const paired = computeAvailableSlots({
    settings: settings({ capacity: 2 }), busy: [overlap], nowMs: MONDAY_8AM_EDT, limit: 1
  });
  assert.equal(paired[0].startMs, open[0].startMs, 'second concurrent booking should still fit');
});

test('closed days and blackout dates produce no slots', () => {
  // Thursday and Friday are not configured as working days here.
  const thursday = Date.parse('2026-06-18T12:00:00Z');
  const slots = computeAvailableSlots({
    settings: settings({ horizonDays: 1 }), nowMs: thursday, limit: 5
  });
  assert.deepEqual(slots, []);

  const blacked = computeAvailableSlots({
    settings: settings({ blackoutDates: ['2026-06-15', '2026-06-16'] }),
    nowMs: MONDAY_8AM_EDT,
    limit: 1
  });
  assert.equal(zonedParts(blacked[0].startMs, ZONE).day, 17);
});

test('availability never runs past the booking horizon', () => {
  const slots = computeAvailableSlots({
    settings: settings({ horizonDays: 1 }),
    busy: [],
    nowMs: MONDAY_8AM_EDT,
    toMs: MONDAY_8AM_EDT + 30 * 86400000,
    limit: 50
  });
  const limit = MONDAY_8AM_EDT + 86400000;
  assert.ok(slots.length > 0);
  assert.ok(slots.every(slot => slot.startMs <= limit), 'offered a slot beyond the horizon');
});

test('slots keep their local wall-clock time across a DST boundary', () => {
  // Friday 2026-10-30 (EDT) and Monday 2026-11-02 (EST) both open at 09:00
  // local, four and five hours behind UTC respectively.
  const weekdays = { 1: [['09:00', '17:00']], 5: [['09:00', '17:00']] };
  const before = computeAvailableSlots({
    settings: settings({ workingHours: weekdays, leadTimeMinutes: 0, horizonDays: 1 }),
    nowMs: Date.parse('2026-10-30T08:00:00Z'),
    limit: 1
  });
  const after = computeAvailableSlots({
    settings: settings({ workingHours: weekdays, leadTimeMinutes: 0, horizonDays: 1 }),
    nowMs: Date.parse('2026-11-02T09:00:00Z'),
    limit: 1
  });
  assert.equal(zonedParts(before[0].startMs, ZONE).hour, 9);
  assert.equal(zonedParts(after[0].startMs, ZONE).hour, 9);
  assert.equal(iso(before[0].startMs), '2026-10-30T13:00:00.000Z');
  assert.equal(iso(after[0].startMs), '2026-11-02T14:00:00.000Z');
});

// ------------------------------------------------------------------ settings

test('settings normalization rejects nonsense without throwing', () => {
  const safe = normalizeCalendarSettings({
    timezone: 'Not/AZone',
    slotMinutes: 9999,
    bufferMinutes: -5,
    capacity: 0,
    workingHours: { 1: [['17:00', '09:00']], 2: [['bad', '17:00']], 3: [['09:00', '12:00']] },
    blackoutDates: ['2026-06-15', 'nope']
  });
  assert.equal(safe.timezone, DEFAULT_CALENDAR_SETTINGS.timezone);
  assert.equal(safe.slotMinutes, 240);
  assert.equal(safe.bufferMinutes, 0);
  assert.equal(safe.capacity, 1);
  assert.deepEqual(safe.blackoutDates, ['2026-06-15']);
  // Inverted and unparseable windows are dropped; the valid one survives.
  assert.deepEqual(Object.keys(safe.workingHours), ['3']);
});

// -------------------------------------------------------- spoken + windows

test('a slot is described for the ear, not the eye', () => {
  const spoken = describeSlotForSpeech(Date.parse('2026-06-16T18:30:00Z'), ZONE);
  assert.match(spoken, /Tuesday/);
  assert.match(spoken, /2:30/);
  assert.doesNotMatch(spoken, /2026-06-16T/);
});

test('a named weekday resolves to that day, not today', () => {
  const window = resolveRequestedWindow('how about wednesday', {
    nowMs: MONDAY_8AM_EDT, settings: settings()
  });
  assert.equal(zonedParts(window.fromMs, ZONE).weekday, 3);
  assert.ok(window.toMs > window.fromMs);
});

test('a part-of-day qualifier narrows the window', () => {
  const morning = resolveRequestedWindow('tuesday morning', { nowMs: MONDAY_8AM_EDT, settings: settings() });
  const afternoon = resolveRequestedWindow('tuesday afternoon', { nowMs: MONDAY_8AM_EDT, settings: settings() });
  assert.ok(zonedParts(morning.toMs, ZONE).hour <= 12);
  assert.ok(zonedParts(afternoon.fromMs, ZONE).hour >= 12);
});

test('a spoken clock time parses the way a caller means it', () => {
  assert.deepEqual(parseSpokenClockTime('can we do 2 p.m.'), { hour: 14, minute: 0 });
  assert.deepEqual(parseSpokenClockTime('wednesday at 2pm'), { hour: 14, minute: 0 });
  // Bare business hours: 1–7 reads as afternoon, 8–12 as morning.
  assert.deepEqual(parseSpokenClockTime('2:30'), { hour: 14, minute: 30 });
  assert.deepEqual(parseSpokenClockTime('9:30'), { hour: 9, minute: 30 });
  assert.deepEqual(parseSpokenClockTime('noon works'), { hour: 12, minute: 0 });
  assert.deepEqual(parseSpokenClockTime('12am'), { hour: 0, minute: 0 });
  // A bare number with no time marker is a date or a stray word, not a time.
  assert.equal(parseSpokenClockTime('wednesday the 19'), null);
  assert.equal(parseSpokenClockTime('lets do 10'), null);
  assert.equal(parseSpokenClockTime('thursday afternoon'), null);
});

test('a specific spoken time yields a target instant on the requested day', () => {
  const window = resolveRequestedWindow('wednesday at 2pm', {
    nowMs: MONDAY_8AM_EDT, settings: settings()
  });
  const target = zonedParts(window.targetMs, ZONE);
  assert.equal(target.weekday, 3);
  assert.equal(target.hour, 14);
  assert.equal(target.minute, 0);
  // The day window stays whole so closest alternatives can come from either side.
  assert.ok(window.fromMs <= window.targetMs && window.targetMs < window.toMs);
});

test('an unparseable window falls back to the whole horizon rather than failing', () => {
  const window = resolveRequestedWindow('whenever suits you', { nowMs: MONDAY_8AM_EDT, settings: settings() });
  assert.equal(window.fromMs, MONDAY_8AM_EDT);
  assert.ok(window.toMs > window.fromMs);
});

test('confirmation references avoid characters that mishear over a phone', () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ref = generateConfirmationRef();
    assert.match(ref, /^BS-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    assert.doesNotMatch(ref.slice(3), /[OIL01]/);
  }
});

// -------------------------------------------------------------- Google sync

const googleAppointment = overrides => ({
  id: 'appointment-123',
  accountId: 'bitesites',
  status: 'booked',
  startAt: '2026-06-16T14:00:00.000Z',
  endAt: '2026-06-16T14:20:00.000Z',
  attendee: { name: 'Dana Example', email: 'dana@example.com' },
  ...overrides
});

function bookingDb(record) {
  const snapshot = () => ({
    exists: true,
    data: () => ({ ...record }),
    get: key => record[key]
  });
  const ref = {
    get: async () => snapshot(),
    set: async (patch, options = {}) => {
      if (options.merge) Object.assign(record, patch);
      else Object.assign(record, patch);
    }
  };
  return {
    record,
    db: {
      doc: path => {
        assert.equal(path, 'appointments/hold-123');
        return ref;
      },
      runTransaction: async work => work({
        get: async () => snapshot(),
        set: (_ref, patch, options = {}) => {
          if (options.merge) Object.assign(record, patch);
          else Object.assign(record, patch);
        }
      })
    }
  };
}

const heldAppointment = overrides => ({
  id: 'hold-123',
  accountId: 'bitesites',
  status: 'held',
  startAt: '2026-06-16T14:00:00.000Z',
  endAt: '2026-06-16T14:20:00.000Z',
  holdExpiresAt: '2026-06-16T13:55:00.000Z',
  ...overrides
});

const committedCalendarSettings = () => settings({
  googleCalendarId: 'team@example.com', busyCalendarIds: ['owner@example.com']
});

// ------------------------------------------------------- Google admission

test('Google admission marks a configured calendar unavailable rather than assuming it is free', async () => {
  const result = await preflightGoogleAdmission({
    google: null,
    settings: committedCalendarSettings(),
    startMs: Date.parse('2026-06-16T14:00:00.000Z'),
    endMs: Date.parse('2026-06-16T14:20:00.000Z'),
    nowMs: Date.parse('2026-06-16T12:00:00.000Z')
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'google_admission_unavailable');
  assert.equal(result.audit.state, 'unavailable');
  assert.equal(result.audit.version, GOOGLE_ADMISSION_VERSION);
});

test('external Google conflict cancels the hold and never commits a booking', async () => {
  const nowMs = Date.parse('2026-06-16T12:00:00.000Z');
  const { db, record } = bookingDb(heldAppointment({
    holdExpiresAt: new Date(nowMs + HOLD_TTL_MS).toISOString()
  }));
  const result = await commitBooking(db, {
    holdId: 'hold-123', attendee: { email: 'dana@example.com' }, nowMs,
    settings: committedCalendarSettings(),
    google: { freeBusy: async () => [{
      startMs: Date.parse('2026-06-16T14:05:00.000Z'),
      endMs: Date.parse('2026-06-16T14:25:00.000Z')
    }] }
  });
  assert.deepEqual(result, { ok: false, error: 'google_slot_taken' });
  assert.equal(record.status, 'cancelled');
  assert.equal(record.cancelReason, 'google_admission_conflict');
  assert.equal(record.googleAdmission.state, 'conflict');
  assert.equal(record.googleAdmission.version, GOOGLE_ADMISSION_VERSION);
});

test('Google outage preserves the hold for retry, then a retry admits and commits exactly once', async () => {
  const nowMs = Date.parse('2026-06-16T12:00:00.000Z');
  const { db, record } = bookingDb(heldAppointment({
    holdExpiresAt: new Date(nowMs + HOLD_TTL_MS).toISOString()
  }));
  const request = {
    holdId: 'hold-123', attendee: { name: 'Dana', email: 'dana@example.com' }, nowMs,
    settings: committedCalendarSettings()
  };
  const unavailable = await commitBooking(db, {
    ...request,
    google: { freeBusy: async () => { throw new Error('upstream outage'); } }
  });
  assert.equal(unavailable.error, 'google_admission_unavailable');
  assert.equal(record.status, 'held');
  assert.equal(record.googleAdmission.state, 'unavailable');

  let checks = 0;
  const admitted = await commitBooking(db, {
    ...request,
    google: { freeBusy: async () => { checks += 1; return []; } }
  });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.idempotent, false);
  assert.equal(record.status, 'booked');
  assert.equal(record.googleAdmission.state, 'admitted');

  const retry = await commitBooking(db, {
    ...request,
    google: { freeBusy: async () => { checks += 1; return [{ startMs: 0, endMs: 1 }]; } }
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
  assert.equal(checks, 1, 'an already-booked hold must not re-check or rebook');
});

test('a deliberately disconnected Google calendar retains Firestore-only booking', async () => {
  const nowMs = Date.parse('2026-06-16T12:00:00.000Z');
  const { db, record } = bookingDb(heldAppointment({
    holdExpiresAt: new Date(nowMs + HOLD_TTL_MS).toISOString()
  }));
  const result = await commitBooking(db, {
    holdId: 'hold-123', attendee: { email: 'dana@example.com' }, nowMs,
    settings: settings({ googleCalendarId: '', googleSyncEnabled: true }), google: null
  });
  assert.equal(result.ok, true);
  assert.equal(record.status, 'booked');
  assert.equal(record.googleAdmission.state, 'not_configured');
});

test('a confirmed booking creates a real Google attendee invitation', () => {
  const event = buildGoogleEvent(googleAppointment(), settings());
  assert.equal(event.id, googleEventIdForAppointment('appointment-123'));
  assert.match(event.id, /^bs[0-9a-f]{48}$/);
  assert.deepEqual(event.attendees, [{ email: 'dana@example.com', displayName: 'Dana Example' }]);
  assert.deepEqual(googleSyncOptions(googleAppointment()), {
    sendUpdates: 'all', markInvitationSent: true
  });
});

test('holds and cancellations never turn into a new attendee invitation', () => {
  const held = googleAppointment({ status: 'held' });
  const cancelled = googleAppointment({ status: 'cancelled' });
  assert.equal(buildGoogleEvent(held, settings()).attendees, undefined);
  assert.equal(buildGoogleEvent(cancelled, settings()).attendees, undefined);
  assert.deepEqual(googleSyncOptions(held), { sendUpdates: 'none', markInvitationSent: false });
  assert.deepEqual(googleSyncOptions(cancelled), { sendUpdates: 'none', markInvitationSent: false });
});

test('Google sync retries stay silent after an invitation, while reschedules notify it', () => {
  const invited = googleAppointment({ googleInviteSentAt: '2026-06-01T12:00:00.000Z' });
  assert.deepEqual(googleSyncOptions(invited), { sendUpdates: 'none', markInvitationSent: false });
  assert.deepEqual(googleSyncOptions({ ...invited, googleSyncReason: 'rescheduled' }), {
    sendUpdates: 'all', markInvitationSent: false
  });
  assert.deepEqual(googleSyncOptions({ ...invited, status: 'cancelled', googleSyncReason: 'cancelled' }), {
    sendUpdates: 'all', markInvitationSent: false
  });
});

test('a sync lease admits only one concurrent Google invitation', async () => {
  const record = googleAppointment({ googleSyncState: 'pending' });
  let transactionTail = Promise.resolve();
  const snapshot = () => ({
    exists: true,
    data: () => ({ ...record }),
    get: key => record[key]
  });
  const ref = {
    get: async () => snapshot(),
    set: async update => Object.assign(record, update)
  };
  const db = {
    doc: path => {
      assert.equal(path, 'appointments/appointment-123');
      return ref;
    },
    runTransaction: async work => {
      let release;
      const predecessor = transactionTail;
      transactionTail = new Promise(resolve => { release = resolve; });
      await predecessor;
      try {
        return await work({
          get: async () => snapshot(),
          set: (_ref, update) => Object.assign(record, update)
        });
      } finally {
        release();
      }
    }
  };
  let providerWrites = 0;
  const client = {
    upsertEvent: async (_existingId, event) => {
      providerWrites += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return { id: event.id, htmlLink: 'https://calendar.example/event' };
    },
    freeBusy: async () => [{
      startMs: Date.parse(record.startAt), endMs: Date.parse(record.endAt)
    }]
  };

  const [first, second] = await Promise.all([
    syncAppointmentToGoogle(db, 'appointment-123', { client, settings: settings() }),
    syncAppointmentToGoogle(db, 'appointment-123', { client, settings: settings() })
  ]);

  assert.equal(providerWrites, 1);
  assert.equal([first, second].filter(result => result.ok).length, 1);
  assert.equal([first, second].find(result => result.skipped)?.reason, 'sync_in_progress');
  assert.equal(record.googleAdmissionReconciliation.state, 'reconciled');
});
