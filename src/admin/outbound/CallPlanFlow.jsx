import React, { useMemo } from 'react';
import { outbound, useAction } from './data';

const Check = ({ done }) => (
  <span className={`plan-step-check ${done ? 'is-done' : ''}`} aria-hidden="true">
    {done ? '✓' : ''}
  </span>
);

// The Calling mode select sits in the Session configuration card below this
// flow, so the mode has to be restated at the point of no return — a rep who
// works the numbered steps downwards would otherwise start a session on the
// default and only discover the ownership rule when the phone rings.
const MODE_NAMES = { human: 'Human only', hybrid: 'Hybrid', ai: 'AI-led' };
const MODE_SUMMARY = {
  human: 'Every answered call is routed to you.',
  hybrid: 'The first answered call is routed to you; the rest are handled by AI.',
  ai: 'No call is routed to you. The session runs server-side only within its approved plans and safety limits.'
};

export default function CallPlanFlow({ campaign, session, operatingMode = 'hybrid', onOpenQueue, onStartSession, onStartCalls, startDisabled, startBlocker = '', interactive = true, canManage = true }) {
  const action = useAction();
  const counts = campaign?.counts || {};
  const ready = Number(counts.ready) || 0;
  const pending = Number(counts.pending) || 0;
  const approvalRequired = campaign?.requireResearchApproval === true;
  const sessionReady = session?.status === 'active';
  const mode = ['human', 'hybrid', 'ai'].includes(operatingMode) ? operatingMode : 'hybrid';
  const autoDialActive = session?.autoDial?.enabled === true;
  const lastDial = session?.lastDialAttempt || null;

  const phase = useMemo(() => {
    if (lastDial?.state === 'provider_accepted') return 4;
    if (sessionReady) return 3;
    if (ready > 0) return 2;
    if (pending > 0) return 1;
    return 0;
  }, [lastDial?.state, pending, ready, sessionReady]);

  const generate = () => action.run(
    () => outbound.prepareCampaignResearch(campaign.id),
    approvalRequired
      ? 'Call plans generated. Review and approve them before dialing.'
      : 'Call plans generated and ready for preflight.'
  );

  const statusMessage = lastDial?.state === 'blocked'
    ? `Call not placed${lastDial.reason ? ` — ${String(lastDial.reason).replace(/_/g, ' ')}` : ''}.`
    : lastDial?.state === 'provider_accepted'
      ? `${lastDial.startedCallIds?.length || 0} call${lastDial.startedCallIds?.length === 1 ? '' : 's'} accepted by the provider.`
      : '';

  return (
    <section className="call-plan-flow" aria-labelledby="call-plan-flow-title">
      <div className="call-plan-flow-head">
        <div>
          <span className="outbound-eyebrow">Guided calling workflow</span>
          <h3 id="call-plan-flow-title">Prepare every conversation before the phone rings</h3>
          <p>New staff can follow the same safe path every time. Experienced staff see the same gates in a compact, auditable flow.</p>
        </div>
        <div className="plan-readiness">
          <strong>{ready}</strong>
          <span>approved &amp; ready</span>
        </div>
      </div>

      <ol className="call-plan-steps">
        <li className={phase >= 1 ? 'is-complete' : 'is-current'}>
          <Check done={phase >= 1} />
          <div><small>01</small><strong>Create plan</strong><span>Research the business and build a sourced call brief.</span></div>
        </li>
        <li className={phase >= 2 ? 'is-complete' : phase === 1 ? 'is-current' : ''}>
          <Check done={phase >= 2} />
          <div><small>02</small><strong>Review &amp; approve</strong><span>Verify claims, opening, objections, and disclosures.</span></div>
        </li>
        <li className={phase >= 3 ? 'is-complete' : phase === 2 ? 'is-current' : ''}>
          <Check done={phase >= 3} />
          <div><small>03</small><strong>Preflight</strong><span>Confirm provider, audio, compliance, and calling window.</span></div>
        </li>
        <li className={phase >= 4 ? 'is-complete' : phase === 3 ? 'is-current' : ''}>
          <Check done={phase >= 4} />
          <div><small>04</small><strong>Start calls</strong><span>Only a provider-accepted call is labeled as placed.</span></div>
        </li>
      </ol>

      <p className={`call-plan-mode mode-${mode}`}>
        <strong>Calling mode: {MODE_NAMES[mode]}</strong>
        <span>
          {MODE_SUMMARY[mode]}
          {!sessionReady && ' Set it in Session configuration below — it is locked in when you run preflight.'}
        </span>
      </p>

      <div className="call-plan-actions">
        <button className="btn-admin" type="button" disabled={!interactive || !canManage || action.busy || !campaign?.id} onClick={generate}
          title={!canManage ? 'An outbound manager creates and approves call plans' : ''}>
          {!canManage ? 'Plans approved by manager' : action.busy ? 'Creating plans…' : pending ? 'Create pending call plans' : 'Refresh call plans'}
        </button>
        <button className="btn-admin" type="button" disabled={!interactive} onClick={onOpenQueue}>Review call plans</button>
        {!sessionReady ? (
          <button className="btn-admin primary" type="button" disabled={!interactive || startDisabled || ready === 0} onClick={onStartSession}>
            Run preflight
          </button>
        ) : (
          <button className="btn-admin primary" type="button" disabled={!interactive || startDisabled || ready === 0 || autoDialActive} onClick={onStartCalls}>
            {autoDialActive ? 'Auto dialing active' : 'Start auto dialing'}
          </button>
        )}
      </div>

      {approvalRequired && pending > 0 && (
        <p className="call-plan-hint"><strong>{pending} waiting:</strong> generated plans must be reviewed and approved before they become dialable.</p>
      )}
      {startBlocker && (
        <p className="call-plan-hint"><strong>Before {sessionReady ? 'placing calls' : 'preflight'}:</strong> {startBlocker}</p>
      )}
      {statusMessage && (
        <p className={`call-attempt-status state-${lastDial?.state}`} role="status" aria-live="polite">{statusMessage}</p>
      )}
      {action.error && <p className="admin-error" role="alert">{action.error}</p>}
      {action.message && <p className="admin-note" role="status">{action.message}</p>}
    </section>
  );
}
