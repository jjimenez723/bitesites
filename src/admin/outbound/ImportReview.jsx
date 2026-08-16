// CSV import, and the queue of records a human has to decide about.
//
// The upload is preview-first and cannot be otherwise: the button that parses
// the file sends `dryRun: true`, and the button that writes only appears after
// a preview has come back. An importer whose first action is a write is an
// importer that lands 3,000 malformed rows before anyone can look.
//
// The file never leaves the browser except as the body of an authenticated
// callable — it is not uploaded to Storage, so there is no bucket holding a
// list of strangers' phone numbers.

import React, { useState } from 'react';
import { useNeedsReview, useReviewQueue, useImportRuns, outbound, useAction } from './data';
import { SourceBadge, StatusPill, formatWhen, formatPhone, Empty, QueryState } from './SourceBadge';
// The server's registry, imported rather than mirrored — see CampaignBuilder.
import { ACCOUNTS, ACCOUNT_IDS } from '../../../functions/accounts.js';

function CsvImport({ onImported }) {
  const [preview, setPreview] = useState(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  // No default. A spreadsheet of Hudson County property managers is either a
  // client list or a house list, and only the person uploading it knows which.
  const [accountId, setAccountId] = useState('');
  const action = useAction();

  const readFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    const content = await file.text();
    setText(content);
    const result = await action.run(() => outbound.importCsv(content, true, accountId), '');
    if (result) setPreview(result);
  };

  const commit = async () => {
    const result = await action.run(() => outbound.importCsv(text, false, accountId), 'Imported.');
    if (result) {
      setPreview(result);
      setText('');
      setFileName('');
      onImported?.();
    }
  };

  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>Import a CSV</h3>
          <p>Previewed first, always. Phone numbers are normalised to E.164 and every row is deduplicated against prospects and leads before anything is written.</p>
        </div>
      </div>

      <label style={{ display: 'block', marginBottom: 12 }}>
        <span>Import into</span>
        <select value={accountId} onChange={event => { setAccountId(event.target.value); setPreview(null); }}>
          <option value="">Select an account…</option>
          {ACCOUNT_IDS.map(id => <option key={id} value={id}>{ACCOUNTS[id].label}</option>)}
        </select>
        <small>Only this account’s campaigns will be able to call these prospects.</small>
      </label>

      <div className="outbound-drop">
        {accountId
          ? 'Drop a CSV with columns like name, company, phone, email, website, city, state.'
          : 'Choose an account above before uploading.'}
        <input type="file" accept=".csv,text/csv" onChange={readFile} disabled={!accountId}
          aria-label="Choose a CSV file" />
        {fileName && <div style={{ marginTop: 8 }}>{fileName}</div>}
      </div>

      {action.busy && <p className="admin-note" style={{ marginTop: 12 }}>Working…</p>}
      {action.error && <p className="admin-error" style={{ marginTop: 12 }}>{action.error}</p>}

      {preview && (
        <div style={{ marginTop: 16 }}>
          <div className="outbound-metric-row">
            <div className="outbound-metric"><strong>{preview.rows}</strong><span>rows read</span></div>
            <div className="outbound-metric"><strong>{preview.counts.mapped}</strong><span>usable</span></div>
            <div className="outbound-metric"><strong>{preview.counts.created}</strong><span>would create</span></div>
            <div className="outbound-metric"><strong>{preview.counts.updated}</strong><span>would update</span></div>
            <div className="outbound-metric"><strong>{preview.counts.duplicates}</strong><span>duplicates</span></div>
            <div className="outbound-metric"><strong>{preview.counts.invalid}</strong><span>invalid</span></div>
          </div>

          {preview.unmappedColumns?.length > 0 && (
            <p className="admin-note" style={{ marginTop: 10 }}>
              Ignored columns: {preview.unmappedColumns.join(', ')}
            </p>
          )}

          {preview.samples?.length > 0 && (
            <div className="admin-table-scroll" style={{ marginTop: 12 }}>
              <table className="admin-table">
                <thead><tr><th>Action</th><th>Business</th><th>Phone</th><th>Duplicate</th></tr></thead>
                <tbody>
                  {preview.samples.map(sample => (
                    <tr key={sample.id}>
                      <td className="cell-dim">{sample.action}</td>
                      <td className="cell-strong">{sample.name || '(no name)'}</td>
                      <td className="cell-dim">{formatPhone(sample.phoneE164)}</td>
                      <td className="cell-dim">{sample.duplicate || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.dryRun && text && (
            <button className="btn-admin primary" type="button" style={{ marginTop: 14 }} disabled={action.busy} onClick={commit}>
              Import {preview.counts.created + preview.counts.updated} prospects
            </button>
          )}
          {!preview.dryRun && <p className="admin-note" style={{ marginTop: 12 }}>Imported. Run id {preview.runId}.</p>}
        </div>
      )}
    </div>
  );
}

function ReviewTable({ title, description, query, onOpen }) {
  const { rows, loading, error, refresh } = query;
  const action = useAction();

  const resolve = async (id, choice) => {
    const result = await action.run(() => outbound.resolveDuplicate(id, choice), '');
    if (result) refresh();
  };

  return (
    <div className="admin-card">
      <div className="card-head">
        <div><h3>{title}</h3><p>{description}</p></div>
        <div className="card-head-actions">
          <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <QueryState loading={loading} error={error} />
      {action.error && <p className="admin-error">{action.error}</p>}

      {!loading && !rows.length ? (
        <Empty title="Nothing to review">Records land here when a match needs a human decision.</Empty>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr><th>Business</th><th>Phone</th><th>Why</th><th>Confidence</th><th>Source</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="clickable" onClick={() => onOpen?.(row.id)}>
                  <td className="cell-strong cell-wrap">{row.companyName || row.name || '(no name)'}</td>
                  <td className="cell-dim">{formatPhone(row.phoneE164)}</td>
                  <td className="cell-dim cell-wrap">
                    {(row.duplicate?.matchReasons || []).join(', ')
                      || (row.contactability?.complianceReasons || []).join(', ')
                      || '—'}
                  </td>
                  <td className="num">
                    {row.duplicate?.matchConfidence ? `${Math.round(row.duplicate.matchConfidence * 100)}%` : '—'}
                  </td>
                  <td><SourceBadge source={row.source} /></td>
                  <td onClick={event => event.stopPropagation()}>
                    {row.duplicate?.status === 'possible' ? (
                      <div className="admin-filters">
                        <button className="btn-admin" type="button" disabled={action.busy} onClick={() => resolve(row.id, 'keep')}>Keep</button>
                        <button className="btn-admin danger" type="button" disabled={action.busy} onClick={() => resolve(row.id, 'merge')}>Duplicate</button>
                      </div>
                    ) : (
                      <StatusPill status={row.lifecycle?.status} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImportRuns() {
  const { rows, loading, error, refresh } = useImportRuns();
  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>Import runs</h3>
          <p>Every migration and CSV import, with the counts it produced. Errors live in a subcollection, not in the run document.</p>
        </div>
        <div className="card-head-actions"><button className="btn-admin" type="button" onClick={refresh}>Refresh</button></div>
      </div>

      <QueryState loading={loading} error={error} />

      {!loading && !rows.length ? (
        <Empty title="No import runs yet">A dry run writes nothing at all, including this record.</Empty>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Source</th><th>Mode</th><th>Status</th>
                <th className="num">Created</th><th className="num">Updated</th>
                <th className="num">Dupes</th><th className="num">Invalid</th>
                <th className="num">Airbnb excluded</th><th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(run => (
                <tr key={run.id}>
                  <td className="cell-strong">{run.sourceSystem}</td>
                  <td className="cell-dim">{run.mode}</td>
                  <td><StatusPill status={run.status} /></td>
                  <td className="num">{run.counts?.created ?? 0}</td>
                  <td className="num">{run.counts?.updated ?? 0}</td>
                  <td className="num">{run.counts?.duplicates ?? 0}</td>
                  <td className="num">{run.counts?.invalid ?? 0}</td>
                  <td className="num">{run.counts?.airbnbExcluded ?? 0}</td>
                  <td className="cell-dim">{formatWhen(run.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ImportReview({ onOpen }) {
  const duplicates = useReviewQueue();
  const needsReview = useNeedsReview();

  return (
    <div className="admin-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <CsvImport onImported={() => { duplicates.refresh(); needsReview.refresh(); }} />
      <ReviewTable
        title="Possible duplicates"
        description="A fuzzy match never merges on its own. These need a person to say whether they are the same business."
        query={duplicates}
        onOpen={onOpen}
      />
      <ReviewTable
        title="Needs review"
        description="Records that cannot join a campaign yet — no dialable number, a compliance block, or a prior relationship worth checking."
        query={needsReview}
        onOpen={onOpen}
      />
      <ImportRuns />
    </div>
  );
}
