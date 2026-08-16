import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAvailableSlots,
  decodeSlotId,
  describeSlotForSpeech,
  encodeSlotId,
  generateConfirmationRef,
  normalizeCalendarSettings,
  resolveRequestedWindow,
  timeZoneOffsetMs,
  zonedParts,
  zonedWallClockToUtc,
  calendarDefaultsForAccount,
  DEFAULT_CALENDAR_SETTINGS
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
