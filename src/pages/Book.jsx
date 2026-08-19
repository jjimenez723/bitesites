// Book a consultation — the public replacement for the Google appointment
// schedule the site used to link out to.
//
// Three steps on one page: pick a day, pick a time, say who you are. The month
// grid is the navigation, so a visitor never has to guess which days have
// anything free — a day with no open slot is simply not clickable.
//
// Times come from the server already filtered by working hours, buffers, lead
// time, existing meetings and the owner's other Google calendars. This file
// renders them and nothing more; the slot id is the only thing it sends back.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { bookConsultation, bookingErrorMessage, loadBookingSlots } from '../lib/booking';
import logo from '../assets/bitesites-logo-full.webp';
import '../book.css';

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** `YYYY-MM-DD` for a local calendar cell. Never derived from an instant. */
const dateKey = (year, month, day) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const monthLabel = (year, month) =>
  new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

const longDate = key => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day)
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
};

const timeIn = (ms, timezone) => new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone || undefined
}).format(new Date(ms));

/** The zone abbreviation, so a visitor in another one is not quietly misled. */
const zoneLabel = (ms, timezone) => {
  if (!timezone) return '';
  const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
    .formatToParts(new Date(ms))
    .find(entry => entry.type === 'timeZoneName');
  return part?.value || '';
};

/** Inclusive month window, clamped to now — the server clamps again. */
function monthWindow(year, month) {
  const first = new Date(year, month, 1).getTime();
  const next = new Date(year, month + 1, 1).getTime();
  return { fromMs: Math.max(first, Date.now()), toMs: next };
}

function MonthGrid({ year, month, days, selected, onSelect }) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = (() => {
    const now = new Date();
    return dateKey(now.getFullYear(), now.getMonth(), now.getDate());
  })();

  const cells = [];
  for (let index = 0; index < firstWeekday; index += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);

  return (
    <div className="book-grid" role="grid" aria-label={`${monthLabel(year, month)} availability`}>
      {WEEKDAY_INITIALS.map((initial, index) => (
        <span key={`${initial}-${index}`} className="book-grid-head" aria-hidden="true">{initial}</span>
      ))}
      {cells.map((day, index) => {
        if (!day) return <span key={`pad-${index}`} className="book-grid-pad" />;
        const key = dateKey(year, month, day);
        const open = Boolean(days[key]?.length);
        const classes = ['book-day'];
        if (open) classes.push('open');
        if (key === selected) classes.push('selected');
        if (key === todayKey) classes.push('today');
        return (
          <button
            key={key}
            type="button"
            className={classes.join(' ')}
            disabled={!open}
            aria-pressed={key === selected}
            aria-label={open
              ? `${longDate(key)} — ${days[key].length} time${days[key].length === 1 ? '' : 's'} available`
              : `${longDate(key)} — nothing available`}
            onClick={() => onSelect(key)}
          >
            {day}
          </button>
        );
      })}
    </div>
  );
}

export default function Book() {
  const now = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [meta, setMeta] = useState({
    timezone: '', durationMinutes: 0, meetingTitle: '', hostName: '', horizonEndMs: 0
  });
  const [days, setDays] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [selectedDate, setSelectedDate] = useState('');
  const [slot, setSlot] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', notes: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [confirmed, setConfirmed] = useState(null);

  const detailsRef = useRef(null);

  const fetchMonth = useCallback((year, month) => {
    setLoading(true);
    setLoadError('');
    const { fromMs, toMs } = monthWindow(year, month);
    return loadBookingSlots({ fromMs, toMs })
      .then(data => {
        const next = {};
        for (const entry of data?.days || []) next[entry.date] = entry.slots;
        setDays(next);
        setMeta({
          timezone: data?.timezone || '',
          durationMinutes: data?.durationMinutes || 0,
          meetingTitle: data?.meetingTitle || 'Consultation',
          hostName: data?.hostName || '',
          horizonEndMs: data?.horizonEndMs || 0
        });
        return next;
      })
      .catch(error => {
        setLoadError(bookingErrorMessage(error, 'We could not load available times. Please try again.'));
        setDays({});
        return {};
      })
      .finally(() => setLoading(false));
  }, []);

  // Land on the first day that actually has something, which is usually not
  // today — a visitor should not have to hunt across a grid for it.
  useEffect(() => {
    fetchMonth(cursor.year, cursor.month).then(next => {
      const first = Object.keys(next).sort()[0];
      if (first) setSelectedDate(first);
    });
  }, [cursor, fetchMonth]);

  const times = selectedDate ? days[selectedDate] || [] : [];

  const shiftMonth = delta => {
    setSlot(null);
    setSelectedDate('');
    setCursor(current => {
      const date = new Date(current.year, current.month + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });
  };

  const pickDate = key => {
    setSelectedDate(key);
    setSlot(null);
    setFormError('');
  };

  const pickTime = entry => {
    setSlot(entry);
    setFormError('');
    // The form is below the fold on a phone; move to it rather than leave the
    // visitor wondering whether the tap registered.
    window.requestAnimationFrame(() => {
      detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  const submit = async event => {
    event.preventDefault();
    if (!slot || busy) return;
    setBusy(true);
    setFormError('');
    try {
      const result = await bookConsultation({ slotId: slot.slotId, ...form });
      setConfirmed({ ...result, startMs: slot.startMs });
    } catch (error) {
      setFormError(bookingErrorMessage(error, 'We could not complete that booking. Please try again.'));
      // A slot lost to someone else must disappear from the list, not sit there
      // inviting a second failed attempt.
      if (/just took|no longer bookable/i.test(String(error?.message || ''))) {
        setSlot(null);
        fetchMonth(cursor.year, cursor.month);
      }
    } finally {
      setBusy(false);
    }
  };

  const canGoBack = cursor.year > now.getFullYear()
    || (cursor.year === now.getFullYear() && cursor.month > now.getMonth());

  // Bookings only open a couple of weeks out, so most of next month is not a
  // month with nothing free — it is a month we are not taking yet. Saying so
  // beats letting someone page forward through empty grids.
  const nextMonthStart = new Date(cursor.year, cursor.month + 1, 1).getTime();
  const beyondHorizon = Boolean(meta.horizonEndMs) && nextMonthStart > meta.horizonEndMs;
  const horizonText = meta.horizonEndMs
    ? new Date(meta.horizonEndMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : '';

  if (confirmed) {
    return (
      <main className="book-page">
        <section className="book-card book-card-narrow">
          <Link to="/" className="book-logo" aria-label="BiteSites home"><img src={logo} alt="BiteSites" /></Link>
          <p className="book-kicker">Confirmed</p>
          <h1>You’re booked</h1>
          <p className="book-lede">
            A confirmation is on its way to <strong>{form.email}</strong>. There is nothing to prepare.
          </p>
          <dl className="book-receipt">
            <div><dt>When</dt><dd>
              {longDate(new Intl.DateTimeFormat('en-CA', {
                timeZone: meta.timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit'
              }).format(new Date(confirmed.startMs)))}
              {' at '}
              {timeIn(confirmed.startMs, meta.timezone)} {zoneLabel(confirmed.startMs, meta.timezone)}
            </dd></div>
            <div><dt>Length</dt><dd>{confirmed.durationMinutes || meta.durationMinutes} minutes</dd></div>
            <div><dt>Reference</dt><dd className="book-ref">{confirmed.confirmationRef}</dd></div>
          </dl>
          <p className="book-fineprint">
            Need to move it? Reply to the confirmation email and we will find another time.
          </p>
          <Link to="/" className="book-back">Back to BiteSites</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="book-page">
      <section className="book-card">
        <aside className="book-summary">
          <Link to="/" className="book-logo" aria-label="BiteSites home"><img src={logo} alt="BiteSites" /></Link>
          <p className="book-kicker">Free consultation</p>
          <h1>{meta.meetingTitle || 'Book a consultation'}</h1>
          <ul className="book-facts">
            {meta.durationMinutes ? <li><span aria-hidden="true">◷</span>{meta.durationMinutes} minutes</li> : null}
            <li><span aria-hidden="true">☎</span>Phone call</li>
            {meta.timezone ? <li><span aria-hidden="true">◎</span>{meta.timezone.replace(/_/g, ' ')}</li> : null}
          </ul>
          <p className="book-lede">
            Tell us what you are trying to solve and we will bring a recommendation, not a pitch deck.
            No prep needed — {meta.hostName ? `a ${meta.hostName}` : 'a specialist'} calls you at the time you pick.
          </p>
        </aside>

        <div className="book-picker">
          <header className="book-month">
            <button type="button" onClick={() => shiftMonth(-1)} disabled={!canGoBack || loading}
              aria-label="Previous month">‹</button>
            <strong>{monthLabel(cursor.year, cursor.month)}</strong>
            <button type="button" onClick={() => shiftMonth(1)} disabled={loading || beyondHorizon}
              aria-label="Next month">›</button>
          </header>

          {loadError ? <p className="book-error" role="status">{loadError}</p> : null}

          <MonthGrid
            year={cursor.year}
            month={cursor.month}
            days={days}
            selected={selectedDate}
            onSelect={pickDate}
          />

          {loading ? <p className="book-hint">Checking the calendar…</p>
            : !Object.keys(days).length && !loadError
              ? (
                <p className="book-hint">
                  {horizonText
                    ? `We are booking through ${horizonText}. Nothing is open in this month — try the previous one, or email jensy@bitesites.org and we will make room.`
                    : 'Nothing open this month.'}
                </p>
              )
              : null}
          {!loading && horizonText && Object.keys(days).length
            ? <p className="book-hint">Booking through {horizonText}.</p>
            : null}

          {selectedDate ? (
            <div className="book-times">
              <h2>{longDate(selectedDate)}</h2>
              <div className="book-time-list">
                {times.map(entry => (
                  <button
                    key={entry.slotId}
                    type="button"
                    className={`book-time${slot?.slotId === entry.slotId ? ' selected' : ''}`}
                    aria-pressed={slot?.slotId === entry.slotId}
                    onClick={() => pickTime(entry)}
                  >
                    {timeIn(entry.startMs, meta.timezone)}
                  </button>
                ))}
              </div>
              {times.length && meta.timezone
                ? <p className="book-hint">Times in {zoneLabel(times[0].startMs, meta.timezone)}.</p>
                : null}
            </div>
          ) : null}

          {slot ? (
            <form className="book-form" onSubmit={submit} ref={detailsRef}>
              <h2>
                {longDate(selectedDate)} at {timeIn(slot.startMs, meta.timezone)}
              </h2>
              <div className="book-form-grid">
                <label className="full"><span>Name</span>
                  <input required maxLength={160} autoComplete="name"
                    value={form.name} onChange={event => set('name', event.target.value)} /></label>
                <label className="full"><span>Email</span>
                  <input required type="email" maxLength={200} autoComplete="email"
                    value={form.email} onChange={event => set('email', event.target.value)} /></label>
                <label><span>Phone <small>(optional)</small></span>
                  <input type="tel" maxLength={40} autoComplete="tel"
                    value={form.phone} onChange={event => set('phone', event.target.value)} /></label>
                <label><span>Company <small>(optional)</small></span>
                  <input maxLength={200} autoComplete="organization"
                    value={form.company} onChange={event => set('company', event.target.value)} /></label>
                <label className="full"><span>What would you like to cover? <small>(optional)</small></span>
                  <textarea rows="3" maxLength={1000}
                    value={form.notes} onChange={event => set('notes', event.target.value)} /></label>
              </div>

              {/* Not a real field. Hidden from people and from screen readers;
                  a bot that fills every input identifies itself by filling it. */}
              <div className="book-honeypot" aria-hidden="true">
                <label>Website
                  <input tabIndex={-1} autoComplete="off"
                    value={form.website} onChange={event => set('website', event.target.value)} /></label>
              </div>

              <button className="book-submit" type="submit" disabled={busy}>
                {busy ? 'Booking…' : 'Confirm booking'}
              </button>
              {formError ? <p className="book-error" role="status">{formError}</p> : null}
              <p className="book-fineprint">
                We use your details to run this call and follow up about it. Nothing else.
              </p>
            </form>
          ) : null}
        </div>
      </section>
    </main>
  );
}
