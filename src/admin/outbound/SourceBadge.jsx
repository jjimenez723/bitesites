// Small shared pieces used across every outbound screen.
//
// They live together because each is three lines and none of them is worth a
// file — but a `formatWhen` copied into eight components is eight chances for
// two screens to render the same timestamp differently.

import React from 'react';
import { Pill } from '../Panel';
import { toDate } from './data';

const SOURCE_LABELS = {
  watcher_leads: 'Watcher',
  bitesites_leads: 'BiteSites-Leads',
  scraper: 'Discovery',
  csv: 'CSV',
  manual: 'Manual'
};

const PROVIDER_LABELS = {
  mock: 'Mock',
  csv: 'CSV',
  google_places: 'Google Places',
  watcher_workflow: 'Watcher',
  bitesites_leads: 'BiteSites-Leads',
  kixie: 'Kixie',
  gohighlevel: 'GoHighLevel',
  twilio: 'Twilio'
};

export const sourceLabel = source =>
  SOURCE_LABELS[source?.system] || source?.system || 'Unknown';

export const providerLabel = id => PROVIDER_LABELS[id] || id || '—';

/** Where a record came from, plus the provider that produced it. */
export function SourceBadge({ source }) {
  if (!source) return <span className="cell-dim">—</span>;
  const provider = source.provider && source.provider !== source.system ? providerLabel(source.provider) : '';
  return (
    <span className="chip" title={source.sourceUrl || source.sourceDocumentId || ''}>
      <b>{sourceLabel(source)}</b>{provider ? ` · ${provider}` : ''}
    </span>
  );
}

/** A status pill whose class is the status itself — see outbound.css. */
export const StatusPill = ({ status, children }) => (
  <Pill kind={String(status || '').toLowerCase()}>{children || String(status || '—').replace(/_/g, ' ')}</Pill>
);

export const formatWhen = value => {
  const date = toDate(value);
  return date
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—';
};

/** The contact's own wall-clock time — the number that decides "call now?". */
export function localTime(timezone) {
  if (!timezone) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date());
  } catch {
    return '—';
  }
}

export const formatPhone = value => {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value || '');
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : (value || '—');
};

export const formatDuration = seconds => {
  const total = Number(seconds) || 0;
  if (!total) return '—';
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
};

/** One consistent empty state, so eight screens do not invent eight. */
export const Empty = ({ title, children }) => (
  <div className="admin-empty">
    <strong>{title}</strong>
    {children}
  </div>
);

/** Loading / error / capped, rendered the same way everywhere. */
export function QueryState({ loading, error, capped, cap }) {
  if (error) return <p className="admin-error">{error}</p>;
  if (loading) return <p className="admin-note">Loading…</p>;
  if (capped) return <p className="admin-note">Showing the first {cap} rows. Narrow the filter to see the rest.</p>;
  return null;
}
