// What each provider can actually do, and what it is missing.
//
// This screen exists because the honest answer to "can we run a parallel dialer
// on Kixie?" is no, and burying that in a document nobody opens is how a
// campaign gets built on an assumption. Every capability is rendered from the
// same flags the server enforces, so this table cannot drift from behaviour.
//
// Secret NAMES are shown; values never leave Secret Manager and are never
// returned by the callable that feeds this page.

import React from 'react';
import { providerLabel } from './SourceBadge';

const CAPABILITY_LABELS = {
  programmaticOutboundCall: 'Start a call on demand',
  aiAgentCall: 'AI agent calls',
  powerDial: 'Power dialing',
  parallelDial: 'BiteSites-controlled parallel dialing',
  perLegCallIds: 'Per-leg call ids',
  humanAnswerDetection: 'Human-answer detection',
  cancelCallLeg: 'Cancel a ringing leg',
  browserAudio: 'Browser audio for the rep',
  signedWebhooks: 'Signed webhooks',
  recordings: 'Recordings',
  dispositions: 'Dispositions'
};

function ProviderCard({ provider }) {
  const capabilities = provider.capabilities || {};
  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>{providerLabel(provider.id)}</h3>
          <p>
            {provider.configured
              ? 'Credentials are present.'
              : `Not configured — missing ${(provider.missingSecrets || provider.requiredSecrets || []).join(', ') || 'credentials'}.`}
          </p>
        </div>
        <div className="card-head-actions">
          <span className={provider.configured ? 'pill ready' : 'pill failed'}>
            <i />{provider.configured ? 'Ready' : 'Not configured'}
          </span>
        </div>
      </div>

      <div className="outbound-capability-grid">
        {Object.entries(CAPABILITY_LABELS).map(([key, label]) => (
          <div key={key} className={capabilities[key] === true ? 'yes' : 'no'}>
            <i />{label}
          </div>
        ))}
        <div className={Number(capabilities.maxConcurrency || 1) > 1 ? 'yes' : 'no'}>
          <i />Up to {capabilities.maxConcurrency || 1} simultaneous line(s)
        </div>
      </div>

      {provider.limitations?.length > 0 && (
        <>
          <div className="panel-section-label" style={{ marginTop: 16 }}>Known limitations</div>
          <ul className="outbound-limitations">
            {provider.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}
          </ul>
        </>
      )}

      {provider.requiredSecrets?.length > 0 && (
        <>
          <div className="panel-section-label" style={{ marginTop: 16 }}>Required secrets</div>
          <div className="chip-row" style={{ marginTop: 8 }}>
            {provider.requiredSecrets.map(secret => <span className="chip" key={secret}>{secret}</span>)}
          </div>
          <p className="admin-note" style={{ marginTop: 8 }}>
            Set with <code>firebase functions:secrets:set NAME</code>. Never in .env, source, or a VITE_ variable.
          </p>
        </>
      )}
    </div>
  );
}

export default function ProviderStatus({ config, loading, error, onRefresh }) {
  if (loading) return <p className="admin-note">Loading provider status…</p>;
  if (error) return <p className="admin-error">{error}</p>;
  if (!config) return null;

  return (
    <div className="admin-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="outbound-compliance-note">
        <strong>These are technical controls, not legal approval.</strong>{' '}
        {config.complianceNotice}
      </div>

      <div className="admin-card">
        <div className="card-head">
          <div>
            <h3>Lead sources</h3>
            <p>Where prospects can come from. Sources marked “migrated” arrive through the migration script rather than a job.</p>
          </div>
          <div className="card-head-actions">
            <button className="btn-admin" type="button" onClick={onRefresh}>Refresh</button>
          </div>
        </div>
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr><th>Source</th><th>Runs</th><th>Radius</th><th>Keywords</th><th>Required secrets</th></tr>
            </thead>
            <tbody>
              {(config.leadSources || []).map(source => (
                <tr key={source.id}>
                  <td className="cell-strong">{providerLabel(source.id)}</td>
                  <td className="cell-dim">
                    {source.executionMode === 'local_runner' ? 'Local worker / migration script' : 'Cloud Function'}
                  </td>
                  <td className="cell-dim">{source.supportsRadius ? 'yes' : 'no'}</td>
                  <td className="cell-dim">{source.supportsKeywords ? 'yes' : 'no'}</td>
                  <td className="cell-dim">{(source.requiredSecrets || []).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(config.callingProviders || []).map(provider => (
        <ProviderCard key={provider.id} provider={provider} />
      ))}
    </div>
  );
}
