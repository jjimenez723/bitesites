# Public meeting hosts

The public `/book` page lists Jensy Jimenez and Jonathan Arroyo. Each selection loads that host’s slots, clears the previously selected time, and retains the client’s contact details. Late responses from another host cannot replace the selected schedule.

Appointments and public-booking leads retain `hostId` and `hostName`. Invitations include the assigned host when `hostEmail` is configured. Confirmation emails use the appointment’s saved host name. Calendar synchronization, cancellation, and retries resolve the assigned host’s calendar. Existing appointments without a host remain assigned to Jensy.

The schedule uses the existing weekday 9–5 Eastern hours unless a host profile overrides them. Hosts have separate capacity and Google busy calendars. The public page does not advertise free slots when Google availability cannot be checked.

## Jonathan’s connection

Jonathan remains marked **Calendar being connected** until his calendar is confirmed and connected. The existing service can access Jensy’s shared booking calendar. A read-only check of `jonathan80azjr@gmail.com` returned Google free/busy `notFound`, so it cannot be used yet. `jonathan@bitesites.org` resolves to Jensy’s primary calendar when impersonated; it is not a separate Jonathan schedule.

After the calendar owner confirms the calendar and grants the booking identity event-editing access, verify free/busy and the events-list `accessRole` before enabling this profile in `calendarSettings/bitesites.bookingHosts.jonathan-arroyo`:

```js
{
  enabled: true,
  hostName: 'Jonathan Arroyo',
  hostEmail: '<confirmed Jonathan email>',
  googleCalendarId: '<confirmed calendar ID>',
  googleImpersonate: 'jensy@bitesites.org',
  googleSyncEnabled: true,
  busyCalendarIds: []
}
```

Set only the profile field with a merge/update, preserving the existing account settings. Jonathan’s `busyCalendarIds` are independent; Jensy’s personal calendar must not be inherited. Do not enable a placeholder calendar or use Jensy’s calendar for both hosts.

Google’s sharing instructions: https://support.google.com/calendar/answer/37082?hl=en

## Validation

- `npm run test:calendar`: all 38 existing calendar regression tests pass.
- `npm run test:booking-hosts`: Firestore emulator coverage of independent availability, legacy Jensy appointments, simultaneous same-host and different-host holds, host-token validation, Google conflicts/outages, invitations, retries, rescheduling/cancellation, and public booking/lead persistence.
- `npm run test:booking-browser`: actual React page with mocked booking transport, covering a full Jensy calendar, selecting Jonathan, delayed-response handling, retained form details, mobile layout, submission locking, and host confirmation.
- `npm run build`: production build.
- `npm run test:byte-web`: all 37 web voice-agent checks pass, including the existing booking flow.

All test appointments and invitations are local fixtures. No live client meeting, calendar invitation, or email was created for verification.
