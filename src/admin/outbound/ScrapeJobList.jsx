// Discovery jobs and where each one got to.
//
// The progress row is the honest version: discovered, valid, duplicates,
// rejected and imported are five different numbers, and collapsing them into
// one percentage would hide the case that matters — a job that "found 400" and
// imported nine because the rest were already in the corpus.

import React, { useState } from 'react';
import { outbound, useAction, useLiveDoc } from './data';
import { StatusPill, formatWhen, providerLabel, Empty, QueryState } from './SourceBadge';

const RUNNABLE = new Set(['queued', 'running', 'paused']);
const STOPPABLE = new Set(['queued', 'running', 'paused', 'awaiting_local_worker', 'processing']);

function JobRow({ job, onChanged }) {
  const action = useAction();
  // Live only while it is moving — a listener per completed job would be a
  // listener per row, forever.
  const live = useLiveDoc(['running', 'processing', 'queued'].includes(job.status) ? `scrapeJobs/${job.id}` : '');
  const current = live.data || job;
  const progress = current.progress || {};
  const ceiling = current.criteria?.maximumResults || 0;
  const percent = ceiling ? Math.min(100, Math.round((progress.discovered / ceiling) * 100)) : 0;

  const act = (fn, message) => action.run(fn, message).then(() => onChanged?.());

  return (
    <tr>
      <td className="cell-strong">
        {providerLabel(current.provider)}
        <div className="cell-dim" style={{ fontSize: 11 }}>
          {(current.criteria?.keywords || []).join(', ') || current.criteria?.category || '—'}
        </div>
      </td>
      <td className="cell-dim">{current.criteria?.location || '—'}</td>
      <td><StatusPill status={current.status} /></td>
      <td style={{ minWidth: 190 }}>
        <div className="outbound-progress"><i style={{ width: `${percent}%` }} /></div>
        <div className="cell-dim" style={{ fontSize: 11, marginTop: 5 }}>
          {progress.discovered || 0} found · {progress.imported || 0} imported · {progress.duplicates || 0} dupes · {progress.rejected || 0} rejected
        </div>
      </td>
      <td className="cell-dim">{formatWhen(current.createdAt)}</td>
      <td>
        <div className="admin-filters">
          {RUNNABLE.has(current.status) && (
            <button className="btn-admin" type="button" disabled={action.busy}
              onClick={() => act(() => outbound.runDiscoveryJob(current.id), 'Slice finished.')}>
              {action.busy ? 'Running…' : 'Run'}
            </button>
          )}
          {current.status === 'running' && (
            <button className="btn-admin" type="button" disabled={action.busy}
              onClick={() => act(() => outbound.pauseDiscoveryJob(current.id), 'Paused.')}>
              Pause
            </button>
          )}
          {STOPPABLE.has(current.status) && (
            <button className="btn-admin danger" type="button" disabled={action.busy}
              onClick={() => act(() => outbound.cancelDiscoveryJob(current.id), 'Cancelled.')}>
              Cancel
            </button>
          )}
        </div>
        {current.status === 'awaiting_local_worker' && (
          <span className="outbound-stale">Waiting for a local worker to claim it.</span>
        )}
        {action.error && <div className="admin-error" style={{ marginTop: 6 }}>{action.error}</div>}
        {current.error && <div className="cell-dim" style={{ fontSize: 11, marginTop: 5 }}>{current.error}</div>}
      </td>
    </tr>
  );
}

export default function ScrapeJobList({ jobs, loading, error, refresh }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? jobs : jobs.slice(0, 12);

  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>Discovery jobs</h3>
          <p>Each run is bounded and resumable. A job that stops mid-page continues from its cursor.</p>
        </div>
        <div className="card-head-actions">
          {jobs.length > 12 && (
            <button className="view-toggle" type="button" onClick={() => setShowAll(value => !value)}>
              {showAll ? 'Show recent' : `Show all ${jobs.length}`}
            </button>
          )}
          <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <QueryState loading={loading} error={error} />

      {!loading && !jobs.length ? (
        <Empty title="No discovery jobs yet">Create one above to see how the pipeline behaves.</Empty>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Source</th><th>Location</th><th>Status</th><th>Progress</th><th>Created</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(job => <JobRow key={job.id} job={job} onChanged={refresh} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
