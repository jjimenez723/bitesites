// The booking calendar the voice agents write into.
//
// Three views because three questions get asked: "what is left today", "how is
// the week looking", "is next month filling up". Day and week are time grids —
// a meeting's position and height are its actual start and duration, so an
// empty afternoon looks empty instead of reading as a short list. Month is a
// density view; it trades exact times for a whole month at a glance.
//
// Everything here reads live: an agent can close a booking while this view is
// open, and the meeting appears without a refresh.
//
// The keyboard is the primary interface for anyone who sits in this screen.
// `t` today, `d`/`w`/`m` the views, `[`/`]` or the arrows to move, `n` to book,
// `?` for the rest. Shortcuts are declared once in SHORTCUTS and both the
// handler and the help sheet read that table, so a key can never work without
// being documented.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppointments, calendar, useAction, toDate } from './data';
// Standalone-safe: this view is also mounted directly at /admin/calendar,
// where OutboundCalls' stylesheet imports never run.
import './outbound.css';
import { Empty, QueryState } from './SourceBadge';
import { ACCOUNTS, ACCOUNT_IDS, LEGACY_ACCOUNT_ID, readAccountId } from '../../../functions/accounts.js';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Indexed by `Date#getDay`, so Sunday first. The settings panel reads it in this order. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Reading order for the grids, which start their weeks on Monday. */
const WEEK_HEADER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_LABELS = {
  held: 'Holding',
  booked: 'Booked',
  cancelled: 'Cancelled',
  completed: 'Completed',
  no_show: 'No show'
};

const VIEWS = ['day', 'week', 'month'];

/** How tall an hour is in the time grid. One number the CSS and the maths share. */
const HOUR_PX = 52;
/** A 20-minute meeting still needs room for a name. */
const MIN_EVENT_PX = 30;

const startOfDay = ms => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** Monday of the week containing `ms`, at local midnight. */
function weekStart(ms) {
  const date = new Date(startOfDay(ms));
  const offset = (date.getDay() + 6) % 7;
  return date.getTime() - offset * DAY_MS;
}

function monthStart(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/** Days the month view paints: whole weeks, Monday-led, covering the month. */
function monthGridRange(ms) {
  const first = monthStart(ms);
  const last = new Date(new Date(first).getFullYear(), new Date(first).getMonth() + 1, 0).getTime();
  const from = weekStart(first);
  const to = weekStart(last) + 7 * DAY_MS;
  return { from, to };
}

const isSameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const isToday = ms => isSameDay(ms, Date.now());

const timeIn = (date, timezone) => date
  ? new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone || undefined
    }).format(date)
  : '';

/** "9 AM" — axis labels drop the always-zero minutes. */
const hourLabel = hour => {
  if (hour === 0) return '12 AM';
  if (hour === 12) return 'Noon';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
};

/** `YYYY-MM-DD` for a local Date, used as a grid column's identity. */
const localDateKey = ms => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/**
 * Where an instant falls on the schedule's own clock.
 *
 * Position, bucketing and the printed time all come from this, so a console
 * open in one timezone and a calendar run in another still agree with each
 * other. A meeting shows on the day it happens for the business, which is the
 * only reading of "Thursday" a rep can act on.
 */
function zonedAt(date, timezone) {
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || undefined, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(date).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = Number(parts.hour) % 24;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute)
  };
}

const attendeeName = appointment => {
  const attendee = appointment.attendee || {};
  return attendee.company || attendee.name || 'Unnamed';
};

/**
 * A calendar id a person can read. Google's secondary calendars are named with
 * a 64-character hash, which is an identifier and not information — the full
 * value stays on the element's title for anyone who needs to check it.
 */
const calendarName = id =>
  /@group\.calendar\.google\.com$/.test(String(id || ''))
    ? 'the shared booking calendar'
    : String(id || '');

// -------------------------------------------------------------- shortcuts

const SHORTCUTS = [
  { keys: ['d'], group: 'View', label: 'Day' },
  { keys: ['w'], group: 'View', label: 'Week' },
  { keys: ['m'], group: 'View', label: 'Month' },
  { keys: ['t'], group: 'View', label: 'Jump to today' },
  { keys: ['j', '←', '['], group: 'Move', label: 'Previous day / week / month' },
  { keys: ['k', '→', ']'], group: 'Move', label: 'Next day / week / month' },
  { keys: ['n'], group: 'Do', label: 'Book a time by hand' },
  { keys: ['r'], group: 'Do', label: 'Refresh' },
  { keys: ['s'], group: 'Do', label: 'Schedule settings' },
  { keys: ['g'], group: 'Do', label: 'Open Google Calendar' },
  { keys: ['?'], group: 'Do', label: 'This list' },
  { keys: ['Esc'], group: 'Do', label: 'Close' }
];

/** True when the keystroke belongs to whatever the user is typing into. */
const isTypingTarget = target => {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
};

function ShortcutSheet({ onClose }) {
  const groups = useMemo(() => {
    const map = new Map();
    for (const shortcut of SHORTCUTS) {
      if (!map.has(shortcut.group)) map.set(shortcut.group, []);
      map.get(shortcut.group).push(shortcut);
    }
    return [...map.entries()];
  }, []);

  return (
    <div className="cal-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="cal-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
        onClick={event => event.stopPropagation()}>
        <header>
          <h4>Keyboard shortcuts</h4>
          <button type="button" className="btn-admin cal-btn" onClick={onClose}>Close</button>
        </header>
        <div className="cal-sheet-groups">
          {groups.map(([group, entries]) => (
            <section key={group}>
              <h5>{group}</h5>
              {entries.map(entry => (
                <div key={entry.label} className="cal-sheet-row">
                  <span className="cal-sheet-keys">
                    {entry.keys.map(key => <kbd key={key}>{key}</kbd>)}
                  </span>
                  <span>{entry.label}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- events

function EventChip({ appointment, timezone, compact = false, onOpen }) {
  const start = toDate(appointment.startAt);
  const bySource = appointment.source === 'ai_call' ? 'AI' : 'Rep';
  const label = `${timeIn(start, timezone)} · ${attendeeName(appointment)}`;

  return (
    <button
      type="button"
      className={`cal-chip cal-chip-${appointment.status}${compact ? ' compact' : ''}`}
      title={`${label} — ${STATUS_LABELS[appointment.status] || appointment.status}`}
      onClick={() => onOpen(appointment)}
    >
      <span className="cal-chip-time">{timeIn(start, timezone)}</span>
      <span className="cal-chip-who">{attendeeName(appointment)}</span>
      {!compact ? <span className="cal-chip-src">{bySource}</span> : null}
    </button>
  );
}

/**
 * One appointment inside a time grid, positioned by its real start and length.
 *
 * `column`/`columns` come from the overlap pass: two meetings at the same time
 * split the width rather than hide one another.
 */
function GridEvent({ appointment, timezone, gridStartHour, column, columns, onOpen }) {
  const start = toDate(appointment.startAt);
  const end = toDate(appointment.endAt);
  const placed = zonedAt(start, timezone);
  if (!start || !placed) return null;

  const startMs = start.getTime();
  const endMs = end ? end.getTime() : startMs + 20 * MINUTE_MS;
  const offsetMinutes = placed.minutes - gridStartHour * 60;
  const durationMinutes = Math.max(5, (endMs - startMs) / MINUTE_MS);

  const top = (offsetMinutes / 60) * HOUR_PX;
  const height = Math.max(MIN_EVENT_PX, (durationMinutes / 60) * HOUR_PX - 2);
  const width = 100 / columns;

  return (
    <button
      type="button"
      className={`cal-grid-event cal-grid-event-${appointment.status}`}
      style={{ top: `${top}px`, height: `${height}px`, left: `${column * width}%`, width: `${width}%` }}
      onClick={() => onOpen(appointment)}
      title={`${timeIn(start, timezone)} — ${attendeeName(appointment)}`}
    >
      <span className="cal-grid-event-time">{timeIn(start, timezone)}</span>
      <span className="cal-grid-event-who">{attendeeName(appointment)}</span>
      {appointment.source === 'ai_call' ? <span className="cal-grid-event-src">AI</span> : null}
    </button>
  );
}

/**
 * Lay overlapping appointments side by side.
 *
 * A greedy sweep: each event takes the first column whose last event has
 * already ended. Enough for a calendar where two or three things collide;
 * anything denser than that is a scheduling problem, not a layout one.
 */
function layoutDay(entries) {
  const sorted = [...entries].sort((a, b) => {
    const aStart = toDate(a.startAt)?.getTime() || 0;
    const bStart = toDate(b.startAt)?.getTime() || 0;
    return aStart - bStart;
  });

  const columnEnds = [];
  const placed = sorted.map(appointment => {
    const start = toDate(appointment.startAt)?.getTime() || 0;
    const end = toDate(appointment.endAt)?.getTime() || start + 20 * MINUTE_MS;
    let column = columnEnds.findIndex(columnEnd => columnEnd <= start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }
    return { appointment, column, start, end };
  });

  // Every event in a colliding run shares the run's width, so a 2-wide cluster
  // does not sit next to a full-width neighbour it actually overlaps.
  return placed.map(entry => {
    const overlapping = placed.filter(other => other.start < entry.end && other.end > entry.start);
    const columns = Math.max(...overlapping.map(other => other.column + 1), 1);
    return { ...entry, columns };
  });
}

/** The hour band a day grid draws: working hours, widened to fit real meetings. */
function gridHours(entries, settings, timezone) {
  let first = 8;
  let last = 18;

  const windows = Object.values(settings?.workingHours || {}).flat();
  for (const window of windows) {
    const open = Number(String(window?.[0] || '').split(':')[0]);
    const close = Number(String(window?.[1] || '').split(':')[0]);
    if (Number.isFinite(open)) first = Math.min(first, open);
    if (Number.isFinite(close)) last = Math.max(last, Math.ceil(close));
  }
  for (const appointment of entries) {
    const start = zonedAt(toDate(appointment.startAt), timezone);
    const end = zonedAt(toDate(appointment.endAt), timezone);
    if (start) first = Math.min(first, Math.floor(start.minutes / 60));
    if (end) last = Math.max(last, Math.ceil(end.minutes / 60));
  }

  return { first: Math.max(0, first - 1), last: Math.min(24, Math.max(last + 1, first + 4)) };
}

function NowLine({ dateKey, timezone, gridStartHour }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const now = zonedAt(new Date(nowMs), timezone);
  if (!now || now.dateKey !== dateKey) return null;
  const top = ((now.minutes - gridStartHour * 60) / 60) * HOUR_PX;
  if (top < 0) return null;
  return <div className="cal-now" style={{ top: `${top}px` }} aria-hidden="true" />;
}

function TimeGrid({ days, byDay, timezone, settings, onOpen }) {
  const scrollRef = useRef(null);
  const allEntries = useMemo(() => byDay.flat(), [byDay]);
  const { first, last } = useMemo(
    () => gridHours(allEntries, settings, timezone), [allEntries, settings, timezone]);
  const hours = useMemo(
    () => Array.from({ length: last - first }, (unused, index) => first + index),
    [first, last]
  );

  // Open on the working day, not on midnight. Runs once per view change:
  // re-scrolling on every live update would fight whoever is reading.
  const scrolledFor = useRef('');
  useEffect(() => {
    const key = `${days[0]}-${first}`;
    if (scrolledFor.current === key || !scrollRef.current) return;
    scrolledFor.current = key;
    const openHour = Math.max(0, (settings?.workingHours?.['1']?.[0]?.[0]
      ? Number(settings.workingHours['1'][0][0].split(':')[0])
      : 9) - first - 0.5);
    scrollRef.current.scrollTop = openHour * HOUR_PX;
  }, [days, first, settings]);

  return (
    <div className="cal-grid">
      <div className="cal-grid-head">
        <span className="cal-grid-gutter" />
        {days.map(dayMs => (
          <div key={dayMs} className={`cal-grid-daylabel${isToday(dayMs) ? ' today' : ''}`}>
            <span className="cal-grid-dow">{WEEKDAYS[new Date(dayMs).getDay()]}</span>
            <span className="cal-grid-date">{new Date(dayMs).getDate()}</span>
          </div>
        ))}
      </div>

      <div className="cal-grid-scroll" ref={scrollRef}>
        <div className="cal-grid-body" style={{ height: `${hours.length * HOUR_PX}px` }}>
          <div className="cal-grid-gutter">
            {hours.map(hour => (
              <span key={hour} className="cal-grid-hour" style={{ height: `${HOUR_PX}px` }}>
                {hourLabel(hour)}
              </span>
            ))}
          </div>

          {days.map((dayMs, index) => (
            <div key={dayMs} className={`cal-grid-col${isToday(dayMs) ? ' today' : ''}`}>
              {hours.map(hour => (
                <div key={hour} className="cal-grid-slot" style={{ height: `${HOUR_PX}px` }} />
              ))}
              <NowLine dateKey={localDateKey(dayMs)} timezone={timezone} gridStartHour={first} />
              {layoutDay(byDay[index] || []).map(({ appointment, column, columns }) => (
                <GridEvent
                  key={appointment.id}
                  appointment={appointment}
                  timezone={timezone}
                  gridStartHour={first}
                  column={column}
                  columns={columns}
                  onOpen={onOpen}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ anchor, byDay, days, timezone, onOpen, onPickDay }) {
  const currentMonth = new Date(anchor).getMonth();

  return (
    <div className="cal-month">
      {WEEK_HEADER.map(label => <span key={label} className="cal-month-head">{label}</span>)}
      {days.map((dayMs, index) => {
        const entries = byDay[index] || [];
        const outside = new Date(dayMs).getMonth() !== currentMonth;
        const shown = entries.slice(0, 3);
        return (
          <div key={dayMs}
            className={`cal-month-cell${outside ? ' outside' : ''}${isToday(dayMs) ? ' today' : ''}`}>
            <button type="button" className="cal-month-date" onClick={() => onPickDay(dayMs)}
              title={`Open ${WEEKDAYS_LONG[new Date(dayMs).getDay()]} ${new Date(dayMs).getDate()}`}>
              {new Date(dayMs).getDate()}
            </button>
            {shown.map(appointment => (
              <EventChip key={appointment.id} appointment={appointment} timezone={timezone}
                compact onOpen={onOpen} />
            ))}
            {entries.length > shown.length ? (
              <button type="button" className="cal-month-more" onClick={() => onPickDay(dayMs)}>
                +{entries.length - shown.length} more
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ detail

function AppointmentDetail({ appointment, timezone, busy, onCancel, onOutcome, onClose }) {
  const start = toDate(appointment.startAt);
  const end = toDate(appointment.endAt);
  const attendee = appointment.attendee || {};

  return (
    <div className="cal-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="cal-sheet cal-detail" role="dialog" aria-modal="true"
        aria-label={`Meeting with ${attendeeName(appointment)}`}
        onClick={event => event.stopPropagation()}>
        <header>
          <h4>{attendeeName(appointment)}</h4>
          <button type="button" className="btn-admin cal-btn" onClick={onClose}>Close</button>
        </header>

        <p className="cal-detail-when">
          {start ? `${WEEKDAYS_LONG[start.getDay()]}, ${start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}` : '—'}
          {' · '}
          {timeIn(start, timezone)}{end ? ` – ${timeIn(end, timezone)}` : ''}
        </p>

        <dl className="cal-detail-rows">
          <div><dt>Status</dt><dd>{STATUS_LABELS[appointment.status] || appointment.status}</dd></div>
          <div><dt>Booked by</dt><dd>{appointment.source === 'ai_call' ? 'Voice agent' : 'A rep'}</dd></div>
          {attendee.name && attendee.company ? <div><dt>Contact</dt><dd>{attendee.name}</dd></div> : null}
          {attendee.email ? <div><dt>Email</dt><dd>{attendee.email}</dd></div> : null}
          {attendee.phone ? <div><dt>Phone</dt><dd>{attendee.phone}</dd></div> : null}
          {appointment.confirmationRef ? <div><dt>Reference</dt><dd>{appointment.confirmationRef}</dd></div> : null}
          {appointment.notes ? <div><dt>Notes</dt><dd>{appointment.notes}</dd></div> : null}
          <div>
            <dt>Google</dt>
            <dd>
              {appointment.googleSyncState === 'synced' ? 'On the calendar'
                : appointment.googleSyncState === 'failed'
                  ? `Not synced — ${appointment.googleSyncError || 'retrying'}`
                  : 'Waiting to sync'}
            </dd>
          </div>
          <div>
            <dt>Video call</dt>
            <dd>
              {appointment.googleMeetUrl
                ? <a href={appointment.googleMeetUrl} target="_blank" rel="noreferrer"
                    className="cal-meet-link">{appointment.googleMeetUrl.replace(/^https?:\/\//, '')}</a>
                : appointment.googleSyncState === 'synced'
                  ? 'No Meet link on this event'
                  : 'Waiting on Google'}
            </dd>
          </div>
        </dl>

        {appointment.status === 'booked' ? (
          <div className="cal-detail-actions">
            <button type="button" className="btn-admin" disabled={busy}
              onClick={() => onOutcome(appointment.id, 'completed')}>Mark held</button>
            <button type="button" className="btn-admin" disabled={busy}
              onClick={() => onOutcome(appointment.id, 'no_show')}>No show</button>
            <button type="button" className="btn-admin danger" disabled={busy}
              onClick={() => onCancel(appointment)}>Cancel meeting</button>
            {appointment.googleMeetUrl ? (
              <a className="btn-admin primary" href={appointment.googleMeetUrl}
                target="_blank" rel="noreferrer">
                Join Meet
              </a>
            ) : null}
            {appointment.googleEventLink ? (
              <a className="btn-admin" href={appointment.googleEventLink} target="_blank" rel="noreferrer">
                Open in Google
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ booking

function BookingForm({ accountId, timezone, onBooked, openRef }) {
  const [slots, setSlots] = useState([]);
  const [form, setForm] = useState({ slotId: '', name: '', email: '', company: '', notes: '' });
  const action = useAction();
  const [loaded, setLoaded] = useState(false);
  const containerRef = useRef(null);

  const loadSlots = useCallback(() => action.run(async () => {
    const result = await calendar.availability(accountId, { limit: 12 });
    setSlots(result?.slots || []);
    setLoaded(true);
    return result;
  }), [accountId, action]);

  // `n` from anywhere on the page: pull the times and put the cursor here.
  useEffect(() => {
    openRef.current = () => {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (!loaded && !action.busy) loadSlots();
      window.setTimeout(() => containerRef.current?.querySelector('select')?.focus(), 120);
    };
    return () => { openRef.current = null; };
  }, [openRef, loaded, action.busy, loadSlots]);

  const submit = event => {
    event.preventDefault();
    if (!form.slotId) return;
    action.run(async () => {
      const result = await calendar.book(accountId, form);
      setForm({ slotId: '', name: '', email: '', company: '', notes: '' });
      setSlots(current => current.filter(slot => slot.slotId !== form.slotId));
      onBooked?.(result);
      return result;
    }, 'Booked.');
  };

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  return (
    <form className="cal-booking" onSubmit={submit} ref={containerRef}>
      <div className="cal-booking-head">
        <h4>Book by hand</h4>
        <button type="button" className="btn-admin cal-btn" disabled={action.busy} onClick={loadSlots}>
          {loaded ? 'Refresh times' : 'Find times'}
        </button>
      </div>

      {loaded && !slots.length ? (
        <p className="cal-note">Nothing open in the booking horizon. Check the schedule below.</p>
      ) : null}

      {slots.length ? (
        <>
          <label className="full">
            <span>Time</span>
            <select className="admin-select" value={form.slotId} onChange={event => set('slotId', event.target.value)}>
              <option value="">Choose a time…</option>
              {slots.map(slot => <option key={slot.slotId} value={slot.slotId}>{slot.spoken}</option>)}
            </select>
          </label>
          <div className="cal-booking-grid">
            <label><span>Name</span>
              <input value={form.name} maxLength={160} onChange={event => set('name', event.target.value)} /></label>
            <label><span>Email</span>
              <input type="email" value={form.email} maxLength={200} onChange={event => set('email', event.target.value)} /></label>
            <label><span>Company</span>
              <input value={form.company} maxLength={200} onChange={event => set('company', event.target.value)} /></label>
            <label><span>Notes</span>
              <input value={form.notes} maxLength={300} onChange={event => set('notes', event.target.value)} /></label>
          </div>
          <button className="btn-admin primary" type="submit" disabled={action.busy || !form.slotId}>
            {action.busy ? 'Booking…' : 'Book'}
          </button>
        </>
      ) : null}

      {action.error ? <p className="admin-error">{action.error}</p> : null}
      {action.message ? <p className="cal-ok">{action.message}</p> : null}
      {timezone ? <p className="cal-note">Times shown in {timezone}.</p> : null}
    </form>
  );
}

/**
 * Schedule and Google connection.
 *
 * The calendar ID lives here rather than in Secret Manager because it is not a
 * secret and because connecting Google should not require a redeploy — only
 * the service-account key is held as a secret.
 */
function ScheduleSettings({ accountId, settings, google, onSaved, openRef }) {
  const [draft, setDraft] = useState(settings);
  const action = useAction();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => { setDraft(settings); }, [settings]);

  useEffect(() => {
    openRef.current = () => {
      setOpen(true);
      window.requestAnimationFrame(() =>
        containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    };
    return () => { openRef.current = null; };
  }, [openRef]);

  if (!draft) return null;

  const set = (field, value) => setDraft(current => ({ ...current, [field]: value }));

  const setDay = (weekday, field, value) => setDraft(current => {
    const hours = { ...(current.workingHours || {}) };
    const existing = hours[String(weekday)]?.[0] || ['09:00', '17:00'];
    const next = field === 'open' ? [value, existing[1]] : [existing[0], value];
    hours[String(weekday)] = [next];
    return { ...current, workingHours: hours };
  });

  const toggleDay = (weekday, enabled) => setDraft(current => {
    const hours = { ...(current.workingHours || {}) };
    if (enabled) hours[String(weekday)] = hours[String(weekday)] || [['09:00', '17:00']];
    else delete hours[String(weekday)];
    return { ...current, workingHours: hours };
  });

  // Applies nine-to-five to the five weekdays and closes the weekend, because
  // that is the schedule people actually mean and setting it by hand is ten
  // controls and a chance to fat-finger one of them.
  const applyWeekdays = () => setDraft(current => ({
    ...current,
    workingHours: {
      1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']],
      4: [['09:00', '17:00']], 5: [['09:00', '17:00']]
    }
  }));

  const save = () => action.run(async () => {
    const result = await calendar.saveSettings(accountId, draft);
    onSaved?.(result?.settings);
    return result;
  }, 'Schedule saved.');

  const busyList = Array.isArray(draft.busyCalendarIds) ? draft.busyCalendarIds.join(', ') : '';

  return (
    <section className="cal-settings" ref={containerRef}>
      <button type="button" className="btn-admin cal-btn" onClick={() => setOpen(value => !value)}
        aria-expanded={open}>
        {open ? 'Hide schedule settings' : 'Schedule settings'}
      </button>

      {open ? (
        <div className="cal-settings-body">
          <div className="cal-booking-grid">
            <label><span>Timezone</span>
              <input value={draft.timezone || ''} maxLength={80}
                onChange={event => set('timezone', event.target.value)} /></label>
            <label><span>Meeting length (min)</span>
              <input type="number" min="5" max="240" value={draft.slotMinutes || 20}
                onChange={event => set('slotMinutes', Number(event.target.value))} /></label>
            <label><span>Gap between (min)</span>
              <input type="number" min="0" max="120" value={draft.bufferMinutes ?? 10}
                onChange={event => set('bufferMinutes', Number(event.target.value))} /></label>
            <label><span>Earliest notice (min)</span>
              <input type="number" min="0" max="10080" value={draft.leadTimeMinutes ?? 120}
                onChange={event => set('leadTimeMinutes', Number(event.target.value))} /></label>
            <label><span>Book up to (days)</span>
              <input type="number" min="1" max="90" value={draft.horizonDays || 14}
                onChange={event => set('horizonDays', Number(event.target.value))} /></label>
            <label><span>Meetings at once</span>
              <input type="number" min="1" max="20" value={draft.capacity || 1}
                onChange={event => set('capacity', Number(event.target.value))} /></label>
          </div>

          <div className="cal-hours">
            <div className="cal-hours-top">
              <span>Working hours</span>
              <button type="button" className="btn-admin cal-btn" onClick={applyWeekdays}>
                9–5, Mon–Fri
              </button>
            </div>
            {WEEKDAYS.map((label, weekday) => {
              const window = draft.workingHours?.[String(weekday)]?.[0];
              return (
                <div key={label} className="cal-hours-row">
                  <label className="cal-hours-day">
                    <input type="checkbox" checked={Boolean(window)}
                      onChange={event => toggleDay(weekday, event.target.checked)} />
                    <span>{label}</span>
                  </label>
                  {window ? (
                    <>
                      <input type="time" value={window[0]}
                        onChange={event => setDay(weekday, 'open', event.target.value)} />
                      <input type="time" value={window[1]}
                        onChange={event => setDay(weekday, 'close', event.target.value)} />
                    </>
                  ) : <span className="cal-note">Closed</span>}
                </div>
              );
            })}
          </div>

          <div className="cal-booking-grid">
            <label className="full"><span>Google Calendar ID — meetings are written here</span>
              <input value={draft.googleCalendarId || ''} maxLength={300}
                placeholder="you@yourdomain.com"
                onChange={event => set('googleCalendarId', event.target.value)} />
            </label>
            <label className="full"><span>Act as (Workspace user) — required for automatic Google Meet links</span>
              <input value={draft.googleImpersonate || ''} maxLength={200}
                placeholder="you@yourdomain.com"
                onChange={event => set('googleImpersonate', event.target.value)} />
            </label>
            <label className="full"><span>Also block time from — read for conflicts, never written to</span>
              <input value={busyList} maxLength={600}
                placeholder="personal@gmail.com, team@yourdomain.com"
                onChange={event => set('busyCalendarIds',
                  event.target.value.split(',').map(entry => entry.trim()).filter(Boolean))} />
            </label>
          </div>
          <p className="cal-note">
            {google?.hasCredentials
              ? 'Service-account key is installed. Share each calendar above with the service account, then save. A calendar we cannot read is skipped, not treated as free. Google Meet links need domain-wide delegation plus an “Act as” user — without them meetings still sync, just without a video link.'
              : 'No service-account key yet. Bookings still work and will sync once GOOGLE_CALENDAR_CREDENTIALS is set.'}
          </p>
          <label className="cal-toggle">
            <input type="checkbox" checked={draft.googleSyncEnabled !== false}
              onChange={event => set('googleSyncEnabled', event.target.checked)} />
            <span>Mirror bookings to Google Calendar</span>
          </label>

          <button type="button" className="btn-admin primary" disabled={action.busy} onClick={save}>
            {action.busy ? 'Saving…' : 'Save schedule'}
          </button>
          {action.error ? <p className="admin-error">{action.error}</p> : null}
          {action.message ? <p className="cal-ok">{action.message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

// -------------------------------------------------------------------- shell

export default function AppointmentCalendar({ canManage = true }) {
  const [accountId, setAccountId] = useState(LEGACY_ACCOUNT_ID);
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [meta, setMeta] = useState({ settings: null, google: null, error: '' });
  const [selected, setSelected] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const action = useAction();

  const openBooking = useRef(null);
  const openSettings = useRef(null);

  // The window each view needs. Month reaches past the month edges because the
  // grid paints whole weeks.
  const { fromMs, toMs, days } = useMemo(() => {
    if (view === 'day') {
      const start = startOfDay(anchor);
      return { fromMs: start, toMs: start + DAY_MS, days: [start] };
    }
    if (view === 'week') {
      const start = weekStart(anchor);
      return {
        fromMs: start,
        toMs: start + 7 * DAY_MS,
        days: Array.from({ length: 7 }, (unused, index) => start + index * DAY_MS)
      };
    }
    const range = monthGridRange(anchor);
    const count = Math.round((range.to - range.from) / DAY_MS);
    return {
      fromMs: range.from,
      toMs: range.to,
      days: Array.from({ length: count }, (unused, index) => range.from + index * DAY_MS)
    };
  }, [view, anchor]);

  // A day either side of the painted range. The grid's columns are calendar
  // dates in the schedule's timezone; a console open in another zone would
  // otherwise lose the meetings sitting on the first and last day's edges.
  const { rows, loading, error, refresh } = useAppointments({
    fromMs: fromMs - DAY_MS, toMs: toMs + DAY_MS
  });

  useEffect(() => {
    let cancelled = false;
    setMeta({ settings: null, google: null, error: '' });
    calendar.settings(accountId)
      .then(result => { if (!cancelled) setMeta({ settings: result?.settings || null, google: result?.google || null, error: '' }); })
      .catch(caught => { if (!cancelled) setMeta(current => ({ ...current, error: caught?.message || 'Could not load calendar settings.' })); });
    return () => { cancelled = true; };
  }, [accountId]);

  const timezone = meta.settings?.timezone || '';

  // Expired holds still sit in Firestore until the sweep runs, and showing one
  // as occupied would be a lie the availability engine does not tell.
  const visible = useMemo(() => {
    const now = Date.now();
    return rows.filter(row => {
      if (readAccountId(row.accountId, { fallback: LEGACY_ACCOUNT_ID }) !== accountId) return false;
      if (row.status !== 'held') return true;
      const expires = toDate(row.holdExpiresAt);
      return expires ? expires.getTime() > now : false;
    });
  }, [rows, accountId]);

  const byDay = useMemo(() => {
    const buckets = days.map(() => []);
    // Keyed by calendar date rather than by `from + n × 24h`: a DST boundary
    // inside the window would otherwise shift every day after it by an hour and
    // drop the last one entirely.
    const index = new Map(days.map((dayMs, position) => [localDateKey(dayMs), position]));
    for (const row of visible) {
      const placed = zonedAt(toDate(row.startAt), timezone);
      if (!placed) continue;
      const position = index.get(placed.dateKey);
      if (position !== undefined) buckets[position].push(row);
    }
    return buckets;
  }, [visible, days, timezone]);

  const step = useCallback(direction => setAnchor(current => {
    if (view === 'day') return startOfDay(current) + direction * DAY_MS;
    if (view === 'week') return weekStart(current) + direction * 7 * DAY_MS;
    const date = new Date(monthStart(current));
    return new Date(date.getFullYear(), date.getMonth() + direction, 1).getTime();
  }), [view]);

  const cancel = useCallback(appointment => {
    const who = attendeeName(appointment);
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Cancel ${who}? This removes it from Google Calendar too.`)) return;
    action.run(() => calendar.cancel(accountId, appointment.id, 'cancelled_by_rep'), 'Cancelled.')
      .then(result => { if (result) { setSelected(null); refresh(); } });
  }, [accountId, action, refresh]);

  const setOutcome = useCallback((appointmentId, outcome) =>
    action.run(() => calendar.setOutcome(accountId, appointmentId, outcome), 'Saved.')
      .then(result => { if (result) { setSelected(null); refresh(); } }),
  [accountId, action, refresh]);

  const googleUrl = meta.settings?.googleCalendarId
    ? `https://calendar.google.com/calendar/u/0/r/week?cid=${encodeURIComponent(meta.settings.googleCalendarId)}`
    : 'https://calendar.google.com/calendar/u/0/r';

  useEffect(() => {
    const onKey = event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape') {
        if (helpOpen) { setHelpOpen(false); event.preventDefault(); }
        else if (selected) { setSelected(null); event.preventDefault(); }
        return;
      }
      // Typing a name into the booking form must not jump the view to Monday.
      if (isTypingTarget(event.target)) return;
      // Nor should a keystroke reshuffle the calendar behind an open dialog.
      // Escape, handled above, is the way out.
      if (helpOpen || selected) return;

      switch (event.key) {
        case 'd': setView('day'); break;
        case 'w': setView('week'); break;
        // Uppercase M too: the shortcut is announced as "M" and shift is a
        // reasonable thing for a finger to be holding.
        case 'm': case 'M': setView('month'); break;
        case 't': case 'T': setAnchor(startOfDay(Date.now())); break;
        case 'j': case 'ArrowLeft': case '[': step(-1); break;
        case 'k': case 'ArrowRight': case ']': step(1); break;
        case 'r': refresh(); break;
        case 'n': if (canManage) openBooking.current?.(); break;
        case 's': if (canManage) openSettings.current?.(); break;
        case 'g': window.open(googleUrl, '_blank', 'noopener'); break;
        case '?': setHelpOpen(true); break;
        default: return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, refresh, canManage, googleUrl, helpOpen, selected]);

  // Counted from what the grid actually paints, not from the widened query.
  const inRange = useMemo(() => byDay.flat(), [byDay]);
  const bookedCount = inRange.filter(row => row.status === 'booked').length;
  const aiCount = inRange.filter(row => row.status === 'booked' && row.source === 'ai_call').length;
  const heldCount = inRange.filter(row => row.status === 'held').length;
  const unsynced = inRange.filter(row => row.status === 'booked' && row.googleSyncState !== 'synced').length;

  const rangeLabel = useMemo(() => {
    if (view === 'day') {
      return new Date(anchor).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      });
    }
    if (view === 'month') {
      return new Date(monthStart(anchor)).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    const start = new Date(days[0]);
    const end = new Date(days[6]);
    const sameMonth = start.getMonth() === end.getMonth();
    const startText = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endText = end.toLocaleDateString('en-US',
      sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
    return `${startText} – ${endText}, ${end.getFullYear()}`;
  }, [view, anchor, days]);

  const periodWord = view === 'day' ? 'today' : view === 'week' ? 'this week' : 'this month';

  // Worth stating on the header line: a conflict calendar that stops blocking
  // is invisible otherwise, and the whole point of it is what it prevents.
  const conflictCount = meta.settings?.busyCalendarIds?.length || 0;
  const conflictNote = conflictCount
    ? `, avoiding ${conflictCount} other calendar${conflictCount === 1 ? '' : 's'}`
    : '';

  return (
    <div className="admin-card cal-card">
      <div className="cal-toolbar">
        <div className="cal-toolbar-title">
          <h3>{ACCOUNTS[accountId].label} calendar</h3>
          <span className={`cal-sync${meta.google?.connected ? ' on' : ''}`}
            title={meta.google?.calendarId || ''}>
            <i aria-hidden="true" />
            {meta.google?.connected
              ? `Synced to ${calendarName(meta.google.calendarId)}${conflictNote}`
              : meta.google?.hasCredentials
                ? 'Google key installed — no calendar ID set'
                : 'Google not connected'}
          </span>
        </div>

        <div className="cal-toolbar-controls">
          <select className="admin-select" value={accountId} aria-label="Entity"
            onChange={event => setAccountId(event.target.value)}>
            {ACCOUNT_IDS.map(id => <option key={id} value={id}>{ACCOUNTS[id].label}</option>)}
          </select>

          <div className="cal-viewswitch" role="group" aria-label="Calendar view">
            {VIEWS.map(name => (
              <button key={name} type="button" aria-pressed={view === name}
                onClick={() => setView(name)}
                title={`${name[0].toUpperCase()}${name.slice(1)} (${name[0]})`}>
                {name[0].toUpperCase()}{name.slice(1)}
              </button>
            ))}
          </div>

          <div className="cal-nav">
            <button type="button" className="btn-admin" onClick={() => step(-1)} aria-label="Previous">‹</button>
            <button type="button" className="btn-admin" onClick={() => setAnchor(startOfDay(Date.now()))}>Today</button>
            <button type="button" className="btn-admin" onClick={() => step(1)} aria-label="Next">›</button>
          </div>

          <button type="button" className="btn-admin" onClick={refresh} title="Refresh (r)">Refresh</button>
          <button type="button" className="btn-admin cal-help" onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
        </div>
      </div>

      <div className="cal-rangebar">
        <strong>{rangeLabel}</strong>
        <span className="cal-stats">
          <span><b>{bookedCount}</b> booked {periodWord}</span>
          <span><b>{aiCount}</b> by a voice agent</span>
          {heldCount ? <span><b>{heldCount}</b> holding</span> : null}
          {unsynced ? <span className="warn"><b>{unsynced}</b> not on Google yet</span> : null}
          {timezone ? <span className="cal-stats-zone">{timezone}</span> : null}
        </span>
      </div>

      <QueryState loading={loading} error={error} />
      {meta.error ? <p className="admin-error">{meta.error}</p> : null}
      {action.error ? <p className="admin-error">{action.error}</p> : null}

      {view === 'month' ? (
        <MonthGrid
          anchor={anchor}
          days={days}
          byDay={byDay}
          timezone={timezone}
          onOpen={setSelected}
          onPickDay={dayMs => { setAnchor(dayMs); setView('day'); }}
        />
      ) : (
        <TimeGrid
          days={days}
          byDay={byDay}
          timezone={timezone}
          settings={meta.settings}
          onOpen={setSelected}
        />
      )}

      {!loading && !inRange.length ? (
        <Empty title={`Nothing booked ${periodWord}`}>
          <p>Bookings made by a voice agent land here the moment the agent confirms them.</p>
        </Empty>
      ) : null}

      {canManage ? (
        <BookingForm accountId={accountId} timezone={timezone} onBooked={refresh} openRef={openBooking} />
      ) : null}
      {canManage ? (
        <ScheduleSettings
          accountId={accountId}
          settings={meta.settings}
          google={meta.google}
          openRef={openSettings}
          onSaved={settings => setMeta(current => ({ ...current, settings: settings || current.settings }))}
        />
      ) : null}

      {selected ? (
        <AppointmentDetail
          appointment={visible.find(row => row.id === selected.id) || selected}
          timezone={timezone}
          busy={action.busy}
          onCancel={cancel}
          onOutcome={setOutcome}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {helpOpen ? <ShortcutSheet onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}
