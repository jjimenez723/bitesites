// Why a campaign will not start.
//
// The circuit breaker halts a campaign server-side and refuses every resume
// until an admin resolves the incident. Without this panel that refusal is
// invisible: an operator sees a paused campaign, presses Resume, and gets an
// error they cannot act on. So the incident is shown where the campaign is,
// with the reason in words and the remediation box right there.
//
// Resolving never restarts anything. The campaign returns to a normal paused
// campaign that somebody then chooses to start — that separation is the whole
// point of the breaker, and the copy here says so rather than implying that
// clearing an incident resumes dialing.

import React, { useCallback, useEffect, useState } from 'react';
import { outbound, useAction } from './data';
import { formatWhen } from './SourceBadge';

const REASON_LABELS = {
  ai_media_control_failure: 'The AI lost verified control of a live carrier leg.',
  account_boundary_violation: 'A target was reached under the wrong seller account.',
  compliance_control_failure: 'A required compliance control did not run, or could not be evidenced.',
  unauthorized_commitment: 'The caller attempted something outside its authorised sales ceiling.'
};

const MIN_REMEDIATION = 10;

export default function CampaignIncidents({ campaignId, campaign, onResolved }) {
  const [incidents, setIncidents] = useState(null);
  const [error, setError] = useState('');
  const [remediation, setRemediation] = useState({});
  const action = useAction();

  const load = useCallback(async () => {
    if (!campaignId) return;
    try {
      const result = await outbound.campaignIncidents(campaignId);
      setIncidents(result?.incidents || []);
      setError('');
    } catch (loadError) {
      setError(loadError?.message || 'Could not load incidents.');
      setIncidents([]);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const halted = campaign?.safetyLock?.engaged === true;
  const open = (incidents || []).filter(entry => entry.status === 'open');

  // Nothing to say when the campaign is healthy and has no history.
  if (!halted && !open.length && !(incidents || []).length) return null;

  const resolve = incident => {
    const text = (remediation[incident.id] || '').trim();
    if (text.length < MIN_REMEDIATION) return;
    action.run(async () => {
      const result = await outbound.resolveCampaignIncident(incident.id, text);
      setRemediation(current => ({ ...current, [incident.id]: '' }));
      await load();
      onResolved?.(result);
      return result;
    }, 'Incident resolved. The campaign stays paused until you start it.');
  };

  return (
    <section className={`admin-card incident-panel${halted ? ' is-halted' : ''}`}>
      <div className="card-head">
        <div>
          <h3>{halted ? 'Campaign halted by the safety breaker' : 'Safety incidents'}</h3>
          <p>
            {halted
              ? 'This campaign cannot be started until every incident below is resolved. Resolving records what was done; it does not resume dialing.'
              : 'No unresolved incident is holding this campaign.'}
          </p>
        </div>
        <button className="btn-admin" type="button" onClick={load}>Refresh</button>
      </div>

      {error ? <p className="incident-error">{error}</p> : null}
      {incidents === null ? <p className="cell-dim">Loading incidents…</p> : null}

      <ul className="incident-list">
        {(incidents || []).map(incident => {
          const isOpen = incident.status === 'open';
          const draft = remediation[incident.id] || '';
          return (
            <li key={incident.id} className={`incident${isOpen ? ' is-open' : ' is-resolved'}`}>
              <div className="incident-head">
                <span className={`incident-badge${isOpen ? ' open' : ''}`}>
                  {isOpen ? 'Open' : 'Resolved'}
                </span>
                <strong>{REASON_LABELS[incident.reason] || incident.reason}</strong>
              </div>

              <dl className="incident-facts">
                <div><dt>Detected</dt><dd>{formatWhen(incident.detectedAt)}</dd></div>
                {incident.source ? <div><dt>Reported by</dt><dd>{incident.source}</dd></div> : null}
                {incident.callId ? <div><dt>Call</dt><dd className="mono">{incident.callId}</dd></div> : null}
                {incident.sessionId ? <div><dt>Session</dt><dd className="mono">{incident.sessionId}</dd></div> : null}
                {incident.targetId ? <div><dt>Target</dt><dd className="mono">{incident.targetId}</dd></div> : null}
              </dl>

              {incident.detail ? <p className="incident-detail">{incident.detail}</p> : null}

              {isOpen ? (
                <div className="incident-resolve">
                  <label>
                    <span>What was done about it?</span>
                    <textarea
                      rows={2}
                      maxLength={2000}
                      value={draft}
                      placeholder="The corrective action taken. Recorded permanently against this incident."
                      onChange={event => setRemediation(current => ({ ...current, [incident.id]: event.target.value }))}
                    />
                  </label>
                  <button
                    className="btn-admin primary"
                    type="button"
                    disabled={action.busy || draft.trim().length < MIN_REMEDIATION}
                    onClick={() => resolve(incident)}
                  >
                    Resolve incident
                  </button>
                  {draft.trim().length > 0 && draft.trim().length < MIN_REMEDIATION ? (
                    <small className="cell-dim">Describe the corrective action before resolving.</small>
                  ) : null}
                </div>
              ) : (
                <div className="incident-resolved-by">
                  <span>Resolved {formatWhen(incident.resolvedAt)}</span>
                  {incident.resolvedBy ? <span> by {incident.resolvedBy}</span> : null}
                  {incident.remediation ? <p className="incident-detail">{incident.remediation}</p> : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {halted && !open.length ? (
        <p className="incident-note">
          Every incident is resolved. The campaign is paused and ready to be started
          deliberately — it will not resume on its own.
        </p>
      ) : null}
    </section>
  );
}
