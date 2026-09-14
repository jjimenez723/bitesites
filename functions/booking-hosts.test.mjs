import assert from 'node:assert/strict';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required.');
process.env.GCLOUD_PROJECT = 'demo-bitesites';
const { initializeApp } = await import('firebase-admin/app');
initializeApp({ projectId: 'demo-bitesites' });
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const { findAvailability, holdSlot, commitBooking, loadCalendarSettings, loadPublicBookingHosts,
  encodeSlotId, decodeSlotId, syncAppointmentToGoogle, retryPendingGoogleSync,
  rescheduleAppointment, cancelAppointment } = await import('./booking-calendar.js');
const { getPublicBookingSlots, bookPublicAppointment } = await import('./public-booking.js');
const db = getFirestore();
const JENSY = 'jensy-jimenez', JONATHAN = 'jonathan-arroyo';
const nowMs = Date.parse('2026-09-14T12:00:00Z');
const fromMs = Date.parse('2026-09-15T13:00:00Z'), toMs = fromMs + 86400000;
const settingsRef = db.doc('calendarSettings/bitesites');
const profile = { enabled: true, hostName: 'Jonathan Arroyo', hostEmail: 'jonathan@example.test',
  googleCalendarId: 'jonathan-calendar', googleImpersonate: 'calendar@example.test', googleSyncEnabled: false };
const fakeClient = (calendarId, writes) => ({ calendarId, freeBusy: async () => [],
  upsertEvent: async (id, event) => { writes.push({ calendarId, event }); return { id: event.id }; },
  deleteEvent: async id => { writes.push({ calendarId, deleted: id }); } });
try {
  await settingsRef.set({ hostName: 'Jensy Jimenez', googleSyncEnabled: false,
    googleCalendarId: 'jensy-calendar', busyCalendarIds: ['jensy-personal'], leadTimeMinutes: 0,
    bookingHosts: { [JONATHAN]: profile } });
  const jensySettings = await loadCalendarSettings(db, 'bitesites');
  const jonathanSettings = await loadCalendarSettings(db, 'bitesites', JONATHAN);
  assert.equal(jensySettings.hostId, JENSY);
  assert.equal(jonathanSettings.googleCalendarId, 'jonathan-calendar');
  assert.deepEqual(jonathanSettings.busyCalendarIds, [], 'Jensy’s private conflicts must not leak into Jonathan’s schedule');
  assert.deepEqual(await loadPublicBookingHosts(db), [
    { id: JENSY, name: 'Jensy Jimenez', available: true },
    { id: JONATHAN, name: 'Jonathan Arroyo', available: true }
  ]);
  await assert.rejects(loadCalendarSettings(db, 'bitesites', 'forged-host'));
  const legacy = db.doc('appointments/legacy-jensy');
  await legacy.set({ status: 'booked', startAt: Timestamp.fromMillis(fromMs), endAt: Timestamp.fromMillis(fromMs + 1200000) });
  const availability = hostId => findAvailability(db, { hostId, fromMs, toMs, nowMs, limit: 5 });
  const jensy = await availability(JENSY), jonathan = await availability(JONATHAN);
  assert.notEqual(jensy.slots[0].startMs, fromMs, 'Legacy bookings still block Jensy');
  assert.equal(jonathan.slots[0].startMs, fromMs, 'Jensy being busy must leave Jonathan free');
  await settingsRef.update({ [`bookingHosts.${JONATHAN}.googleSyncEnabled`]: true });
  const externallyBusy = await findAvailability(db, { hostId: JONATHAN, fromMs, toMs, nowMs,
    strictGoogle: true, google: { freeBusy: async () => [{ startMs: fromMs, endMs: fromMs + 1200000 }] } });
  assert.notEqual(externallyBusy.slots[0].startMs, fromMs, 'Jonathan’s external commitments block Jonathan');
  await assert.rejects(findAvailability(db, { hostId: JONATHAN, fromMs, toMs, nowMs, strictGoogle: true,
    google: { freeBusy: async () => { throw new Error('calendar outage'); } } }), /Calendar unavailable/);
  await settingsRef.update({ [`bookingHosts.${JONATHAN}.googleSyncEnabled`]: false });
  assert.equal(decodeSlotId(jonathan.slots[0].slotId).hostId, JONATHAN);
  assert.equal((await holdSlot(db, { slotId: jonathan.slots[0].slotId, hostId: JENSY, nowMs })).error, 'host_mismatch');
  assert.equal((await holdSlot(db, { slotId: encodeSlotId(fromMs, 240, JONATHAN), nowMs })).error, 'invalid_slot');
  const holds = await Promise.all([1, 2].map(() => holdSlot(db, { slotId: jonathan.slots[0].slotId, nowMs })));
  assert.equal(holds.filter(result => result.ok).length, 1, 'Same-host concurrent holds cannot double-book');
  const held = holds.find(result => result.ok);
  assert.equal((await db.doc(`appointments/${held.holdId}`).get()).get('hostName'), 'Jonathan Arroyo');
  assert.equal((await commitBooking(db, { holdId: held.holdId, nowMs, settings: jensySettings })).error, 'host_mismatch');
  const booked = await commitBooking(db, { holdId: held.holdId, nowMs, attendee: { name: 'Test Client', email: 'client@example.test' } });
  assert.equal(booked.ok, true);
  const writes = [];
  const wrongSync = await syncAppointmentToGoogle(db, booked.appointmentId, { client: fakeClient('jensy-calendar', writes) });
  assert.equal(wrongSync.ok, false);
  assert.equal(writes.length, 0, 'A wrong calendar client must not send anything');
  const retry = await retryPendingGoogleSync(db, { clientForHost: async hostId =>
    fakeClient((await loadCalendarSettings(db, 'bitesites', hostId)).googleCalendarId, writes) });
  assert.equal(retry.synced, 1);
  assert.equal(writes[0].calendarId, 'jonathan-calendar');
  assert.match(writes[0].event.summary, /Jonathan Arroyo/);
  assert.deepEqual(writes[0].event.attendees.map(entry => entry.email), ['client@example.test', 'jonathan@example.test']);
  const nextTime = fromMs + 1800000;
  const [jensyHold, jonathanHold] = await Promise.all([JENSY, JONATHAN].map(hostId =>
    holdSlot(db, { slotId: encodeSlotId(nextTime, 20, hostId), nowMs })));
  assert.ok(jensyHold.ok && jonathanHold.ok, 'Different hosts may hold the same time');
  await cancelAppointment(db, { appointmentId: jonathanHold.holdId, nowMs });
  assert.equal((await rescheduleAppointment(db, { appointmentId: booked.appointmentId,
    slotId: encodeSlotId(nextTime, 20, JENSY), nowMs })).error, 'host_mismatch');
  const moved = await rescheduleAppointment(db, { appointmentId: booked.appointmentId,
    slotId: encodeSlotId(nextTime, 20, JONATHAN), nowMs });
  assert.equal(moved.ok, true, 'Jonathan can move to a time held by Jensy');
  await syncAppointmentToGoogle(db, booked.appointmentId, { client: fakeClient('jonathan-calendar', writes) });
  await cancelAppointment(db, { appointmentId: booked.appointmentId, nowMs });
  await retryPendingGoogleSync(db, { clientForHost: async hostId =>
    fakeClient((await loadCalendarSettings(db, 'bitesites', hostId)).googleCalendarId, writes) });
  assert.equal(writes.at(-1).calendarId, 'jonathan-calendar');
  assert.ok(writes.some(write => write.calendarId === 'jonathan-calendar' && write.deleted));

  // Public callables exercise validation, lead creation, and the saved host.
  await db.recursiveDelete(db.collection('appointments'));
  const getSlots = hostId => getPublicBookingSlots.run({ data: { hostId } });
  const publicTimes = await getSlots(JONATHAN);
  assert.equal(publicTimes.hostId, JONATHAN);
  assert.equal(publicTimes.hostName, 'Jonathan Arroyo');
  assert.equal(JSON.stringify(publicTimes).includes('jonathan-calendar'), false);
  const slot = publicTimes.days[0].slots[0];
  const request = { data: { slotId: slot.slotId, hostId: JONATHAN, name: 'Test Client', email: 'client@example.test', company: 'Test Business' },
    rawRequest: { ip: '192.0.2.1' } };
  await assert.rejects(bookPublicAppointment.run({ ...request, data: { ...request.data, hostId: JENSY } }), { code: 'invalid-argument' });
  const publicBooking = await bookPublicAppointment.run(request);
  assert.equal(publicBooking.hostName, 'Jonathan Arroyo');
  const appointment = (await db.doc(`appointments/${publicBooking.appointmentId}`).get()).data();
  assert.equal(appointment.hostId, JONATHAN);
  const lead = (await db.doc(`leads/${appointment.leadId}`).get()).data();
  assert.equal(lead.booking.hostName, 'Jonathan Arroyo');
  assert.ok((await getSlots(JENSY)).days.some(day => day.slots.some(entry => entry.startMs === slot.startMs)));
  assert.equal((await getSlots(JONATHAN)).days.some(day => day.slots.some(entry => entry.startMs === slot.startMs)), false);
  await settingsRef.update({ [`bookingHosts.${JONATHAN}.enabled`]: false });
  await assert.rejects(getSlots(JONATHAN), { code: 'failed-precondition' });
  await assert.rejects(getSlots('forged-host'), { code: 'invalid-argument' });
  assert.equal((await getSlots(JENSY)).hosts.find(host => host.id === JONATHAN).available, false);
  console.log('Booking hosts passed: legacy compatibility, independent schedules, concurrent holds, host validation, invitations, retry/cancellation routing, and public booking/CRM persistence.');
} finally { await db.terminate(); }
