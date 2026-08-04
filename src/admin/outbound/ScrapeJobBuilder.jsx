// Starting a discovery job.
//
// The form is deliberately narrow: a provider, what to look for, where, and a
// hard ceiling on results. Anything a provider does not support is disabled
// rather than hidden, with the reason shown — an operator who cannot see why
// the radius field is greyed out concludes the feature is broken.
//
// Nothing here scrapes. It creates a `scrapeJobs` document through a callable;
// the server decides whether that runs in a function or waits for a local
// worker.

import React, { useState } from 'react';
import { outbound, useAction } from './data';
import { providerLabel } from './SourceBadge';

const DEFAULTS = { keywords: '', category: '', location: '', radiusMiles: 10, maximumResults: 100 };

export default function ScrapeJobBuilder({ sources = [], onCreated }) {
  const [provider, setProvider] = useState('mock');
  const [form, setForm] = useState(DEFAULTS);
  const action = useAction();

  const selected = sources.find(entry => entry.id === provider);
  // A source that ingests through the migration script cannot start a job. It
  // still appears in the list so the operator knows it exists and why.
  const startable = sources.filter(entry => entry.executionMode !== 'local_runner' || entry.id === 'csv');

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  const submit = async event => {
    event.preventDefault();
    const criteria = {
      keywords: form.keywords.split(',').map(word => word.trim()).filter(Boolean),
      category: form.category,
      location: form.location,
      radiusMiles: selected?.supportsRadius ? Number(form.radiusMiles) : 0,
      maximumResults: Number(form.maximumResults)
    };
    const result = await action.run(
      () => outbound.createDiscoveryJob(provider, criteria),
      'Job created. Start it from the list below.'
    );
    if (result?.jobId) { setForm(DEFAULTS); onCreated?.(result.jobId); }
  };

  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>New discovery job</h3>
          <p>Find businesses that match a category and a place. Nothing is called until a campaign selects it.</p>
        </div>
      </div>

      <form className="outbound-form" onSubmit={submit}>
        <div className="outbound-form-grid">
          <label>
            <span>Source</span>
            <select value={provider} onChange={event => setProvider(event.target.value)}>
              {startable.map(entry => (
                <option key={entry.id} value={entry.id}>{providerLabel(entry.id)}</option>
              ))}
            </select>
            {selected?.requiredSecrets?.length > 0 && (
              <small>Needs {selected.requiredSecrets.join(', ')} configured server-side.</small>
            )}
          </label>

          <label>
            <span>Category</span>
            <input
              value={form.category}
              onChange={event => set('category', event.target.value)}
              placeholder="dentist, hvac, restaurant…"
            />
          </label>

          <label className="full">
            <span>Keywords</span>
            <input
              value={form.keywords}
              onChange={event => set('keywords', event.target.value)}
              placeholder="emergency plumber, drain cleaning (comma separated, max 10)"
            />
          </label>

          <label>
            <span>Location</span>
            <input
              value={form.location}
              onChange={event => set('location', event.target.value)}
              placeholder="Bergen County, NJ"
              required
            />
          </label>

          <label>
            <span>Radius (miles)</span>
            <input
              type="number" min="1" max="100"
              value={form.radiusMiles}
              disabled={!selected?.supportsRadius}
              onChange={event => set('radiusMiles', event.target.value)}
            />
            {!selected?.supportsRadius && <small>{providerLabel(provider)} does not support a radius.</small>}
          </label>

          <label>
            <span>Maximum results</span>
            <input
              type="number" min="1" max="1000"
              value={form.maximumResults}
              onChange={event => set('maximumResults', event.target.value)}
            />
            <small>A hard ceiling. Providers bill per result.</small>
          </label>
        </div>

        {action.error && <p className="admin-error">{action.error}</p>}
        {action.message && <p className="admin-note">{action.message}</p>}

        <button className="btn-admin primary" type="submit" disabled={action.busy}>
          {action.busy ? 'Creating…' : 'Create job'}
        </button>
      </form>
    </div>
  );
}
