# Seller calendar checklist

Last updated: 2026-08-24

Everything the booking system needs is built and normalized server-side. What is
missing is data, and it is data only the owner can supply: a calendar id, an
address, and a set of hours are commitments to a prospect, not values an agent
may infer from a code default or a search result.

Today **BiteSites is the only seller with a real calendar**. Stone Bellisimo and
The Fine Line Group would fall back to generic defaults — `America/New_York`,
Monday to Friday nine to five, a 10-minute buffer — that nobody approved. The AI
would book against them anyway, which is the problem.

## How to supply it

Per seller, either the console or the script:

```bash
npm run calendar -- show <accountId>          # what is stored today
npm run calendar -- apply-defaults <accountId> --write
```

Accounts: `bitesites`, `stone-bellisimo`, `fine-line-group`. The admin console
writes the same document through **Outbound → Appointments → Schedule settings**,
which is the only path that normalizes the values. Nothing is browser-writable.

Stored at `calendarSettings/{accountId}`, server-write only
([firestore.rules](./firestore.rules)).

## What each seller needs

| Field | What it means | BiteSites | Stone Bellisimo | Fine Line |
|---|---|---|---|---|
| `googleCalendarId` | Calendar the meeting is written to | ✅ `jensy@bitesites.org` | **needed** | **needed** |
| `busyCalendarIds` | Read for conflicts, never written to | ✅ `jensyjimenez723@gmail.com` | **needed** | **needed** |
| `hostName` | Who the prospect is told they are meeting | ⚠️ generated `"BiteSites specialist"` | **needed** | **needed** |
| `location` | Address on the invitation | blank = video call | **needed** — showroom address | **needed** — decide per assessment |
| `timezone` | Wall-clock for all hours below | ⚠️ default `America/New_York` | **confirm** | **confirm** |
| `workingHours` | When a slot may be offered | ⚠️ default 9–5 Mon–Fri | **needed** — showroom visiting hours | **needed** — assessment coverage |
| `slotMinutes` | Meeting length | ⚠️ default 20 | **confirm** | **confirm** |
| `bufferMinutes` | Gap between meetings | ⚠️ default 10 | **confirm** — travel time between visits? | **confirm** |
| `leadTimeMinutes` | Earliest a prospect may book | ⚠️ default 120 | **confirm** | **confirm** |
| `horizonDays` | How far ahead bookings open | ⚠️ default 14 | **confirm** | **confirm** |
| `capacity` | Meetings at once | ⚠️ default 1 | **confirm** | **confirm** |
| `cancellationPolicy.noticeHours` | Notice expected; 0 = unset | unset | **needed** | **needed** |
| `cancellationPolicy.policy` | What the prospect is told at booking | unset | **needed** | **needed** |
| `blackoutDates` | Holidays and closures | none | **needed** | **needed** |

✅ owner-supplied · ⚠️ a code default nobody affirmed · **needed** absent entirely

## Two that are not calendar fields

- **Who receives the appointment.** Stone's showroom visit and Fine Line's
  assessment go to a person, and there is no roster. This is the same open item
  as the human-handoff recipient list in
  [OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md) §7.
- **Fine Line's emergency escalation contact.** The runtime currently tells a
  caller in a life-safety situation to dial emergency services and stops
  selling, which is right, but there is no escalation number behind it.

## Why an agent will not fill these in

Hours and addresses are findable. That is not the same as being true: a search
result is `reported` evidence, and the readiness plan forbids promoting reported
evidence to something spoken as fact. A stale hour range books a prospect into a
closed showroom, and a stale address sends them to the wrong building — both are
failures the prospect experiences, not ones a test catches.
