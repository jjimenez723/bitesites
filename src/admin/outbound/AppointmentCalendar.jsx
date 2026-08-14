// The booking calendar the voice agents write into.
//
// A week grid rather than a list, because the question a rep actually asks is
// "how is next week looking" — and because a slot the agent is mid-way through
// holding needs to be visible as occupied before it becomes a meeting.
//
// Everything here reads live: an agent can close a booking while this view is
// open, and the meeting should appear without a refresh.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppointments, calendar, useAction, toDate } from './data';
import { Empty, QueryState } from './SourceBadge';

const DAY_MS = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATUS_LABELS = {
  held: 'Holding',
  booked: 'Booked',
  cancelled: 'Cancelled',
  completed: 'Completed',
  no_show: 'No show'
};

/** Monday of the week containing `ms`, at local midnight. */
function weekStart(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  const offset = (date.getDay() + 6) % 7;
  return date.getTime() - offset * DAY_MS;
}

const timeIn = (date, timezone) => date
  ? new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone || undefined
    }).format(date)
  : '';

const dayLabel = ms => {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
};

const isToday = ms => {
  const now = new Date();
  const date = new Date(ms);
  return now.toDateString() === date.toDateString();
};

function AppointmentCard({ appointment, timezone, onCancel, onOutcome, busy }) {
  const start = toDate(appointment.startAt);
  const attendee = appointment.attendee || {};
  const bySource = appointment.source === 'ai_call' ? 'AI' : 'Rep';

  return (
    <article className={`cal-event cal-event-${appointment.status}`}>
      <header>
        <span className="cal-event-time">{timeIn(start, timezone)}</span>
        <span className="cal-event-source" title={`Booked by ${bySource === 'AI' ? 'a voice agent' : 'a rep'}`}>
          {bySource}
        </span>
      </header>
      <strong>{attendee.company || attendee.name || 'Unnamed'}</strong>
      {attendee.name && attendee.company ? <span className="cal-event-sub">{attendee.name}</span> : null}
      {appointment.confirmationRef ? <span className="cal-event-ref">{appointment.confirmationRef}</span> : null}

      {appointment.googleSyncState === 'failed' ? (
        <span className="cal-event-warn" title={appointment.googleSyncError || ''}>
          Not on Google yet — retrying
        </span>
      ) : null}

      {appointment.status === 'booked' ? (
        <div className="cal-event-actions">
          <button type="button" className="btn-admin cal-btn" disabled={busy}
            onClick={() => onOutcome(appointment.id, 'completed')}>Held</button>
          <button type="button" className="btn-admin cal-btn" disabled={busy}
            onClick={() => onOutcome(appointment.id, 'no_show')}>No show</button>
          <button type="button" className="btn-admin cal-btn danger" disabled={busy}
            onClick={() => onCancel(appointment)}>Cancel</button>
        </div>
      ) : (
        <span className="cal-event-status">{STATUS_LABELS[appointment.status] || appointment.status}</span>
      )}
    </article>
  );
}

function BookingForm({ timezone, onBooked }) {
  const [slots, setSlots] = useState([]);
  const [form, setForm] = useState({ slotId: '', name: '', email: '', company: '', notes: '' });
  const action = useAction();
  const [loaded, setLoaded] = useState(false);

  const loadSlots = useCallback(() => action.run(async () => {
    const result = await calendar.availability({ limit: 12 });
    setSlots(result?.slots || []);
    setLoaded(true);
    return result;
  }), [action]);

  const submit = event => {
    event.preventDefault();
    if (!form.slotId) return;
    action.run(async () => {
      const result = await calendar.book(form);
      setForm({ slotId: '', name: '', email: '', company: '', notes: '' });
      setSlots(current => current.filter(slot => slot.slotId !== form.slotId));
      onBooked?.(result);
      return result;
    }, 'Booked.');
  };

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  return (
    <form className="cal-booking" onSubmit={submit}>
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
function ScheduleSettings({ settings, google, onSaved }) {
  const [draft, setDraft] = useState(settings);
  const action = useAction();
  const [open, setOpen] = useState(false);

  useEffect(() => { setDraft(settings); }, [settings]);
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

  const save = () => action.run(async () => {
    const result = await calendar.saveSettings(draft);
    onSaved?.(result?.settings);
    return result;
  }, 'Schedule saved.');

  return (
    <section className="cal-settings">
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
            <label className="full"><span>Google Calendar ID</span>
              <input value={draft.googleCalendarId || ''} maxLength={300}
                placeholder="you@yourdomain.com"
                onChange={event => set('googleCalendarId', event.target.value)} />
            </label>
          </div>
          <p className="cal-note">
            {google?.hasCredentials
              ? 'Service-account key is installed. Share this calendar with the service account’s email, then paste the calendar ID above.'
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

export default function AppointmentCalendar({ canManage = true }) {
  const [anchor, setAnchor] = useState(() => weekStart(Date.now()));
  const [meta, setMeta] = useState({ settings: null, google: null, error: '' });
  const action = useAction();

  const fromMs = anchor;
  const toMs = anchor + 7 * DAY_MS;
  const { rows, loading, error, refresh } = useAppointments({ fromMs, toMs });

  useEffect(() => {
    let cancelled = false;
    calendar.settings()
      .then(result => { if (!cancelled) setMeta({ settings: result?.settings || null, google: result?.google || null, error: '' }); })
      .catch(caught => { if (!cancelled) setMeta(current => ({ ...current, error: caught?.message || 'Could not load calendar settings.' })); });
    return () => { cancelled = true; };
  }, []);

  const timezone = meta.settings?.timezone || '';

  // Expired holds still sit in Firestore until the sweep runs, and showing one
  // as occupied would be a lie the availability engine does not tell.
  const visible = useMemo(() => {
    const now = Date.now();
    return rows.filter(row => {
      if (row.status !== 'held') return true;
      const expires = toDate(row.holdExpiresAt);
      return expires ? expires.getTime() > now : false;
    });
  }, [rows]);

  const byDay = useMemo(() => {
    const buckets = Array.from({ length: 7 }, () => []);
    for (const row of visible) {
      const start = toDate(row.startAt);
      if (!start) continue;
      const index = Math.floor((start.getTime() - anchor) / DAY_MS);
      if (index >= 0 && index < 7) buckets[index].push(row);
    }
    return buckets;
  }, [visible, anchor]);

  const bookedCount = visible.filter(row => row.status === 'booked').length;
  const aiCount = visible.filter(row => row.status === 'booked' && row.source === 'ai_call').length;

  const cancel = appointment => {
    const who = appointment.attendee?.company || appointment.attendee?.name || 'this meeting';
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Cancel ${who}? This removes it from Google Calendar too.`)) return;
    action.run(() => calendar.cancel(appointment.id, 'cancelled_by_rep'), 'Cancelled.')
      .then(result => { if (result) refresh(); });
  };

  const setOutcome = (appointmentId, outcome) =>
    action.run(() => calendar.setOutcome(appointmentId, outcome), 'Saved.')
      .then(result => { if (result) refresh(); });

  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>Calendar</h3>
          <p>
            Meetings your voice agents and reps book. {meta.google?.connected
              ? 'Synced to Google Calendar.'
              : 'Google Calendar is not connected — bookings still work and will sync once it is.'}
          </p>
        </div>
        <div className="card-head-actions">
          <button className="btn-admin" type="button" onClick={() => setAnchor(value => value - 7 * DAY_MS)}>← Prev</button>
          <button className="btn-admin" type="button" onClick={() => setAnchor(weekStart(Date.now()))}>This week</button>
          <button className="btn-admin" type="button" onClick={() => setAnchor(value => value + 7 * DAY_MS)}>Next →</button>
          <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <div className="cal-summary">
        <span><strong>{bookedCount}</strong> booked this week</span>
        <span><strong>{aiCount}</strong> by a voice agent</span>
        {timezone ? <span>{timezone}</span> : null}
      </div>

      <QueryState loading={loading} error={error} />
      {meta.error ? <p className="admin-error">{meta.error}</p> : null}
      {action.error ? <p className="admin-error">{action.error}</p> : null}

      <div className="cal-week">
        {byDay.map((entries, index) => {
          const dayMs = anchor + index * DAY_MS;
          return (
            <section key={dayMs} className={`cal-day${isToday(dayMs) ? ' cal-day-today' : ''}`}>
              <header className="cal-day-head">{dayLabel(dayMs)}</header>
              {entries.length ? entries.map(appointment => (
                <AppointmentCard
                  key={appointment.id}
                  appointment={appointment}
                  timezone={timezone}
                  busy={action.busy}
                  onCancel={cancel}
                  onOutcome={setOutcome}
                />
              )) : <p className="cal-day-empty">—</p>}
            </section>
          );
        })}
      </div>

      {!loading && !visible.length ? (
        <Empty title="Nothing booked this week">
          <p>Bookings made by a voice agent land here the moment the agent confirms them.</p>
        </Empty>
      ) : null}

      {canManage ? <BookingForm timezone={timezone} onBooked={refresh} /> : null}
      {canManage ? (
        <ScheduleSettings
          settings={meta.settings}
          google={meta.google}
          onSaved={settings => setMeta(current => ({ ...current, settings: settings || current.settings }))}
        />
      ) : null}
    </div>
  );
}
