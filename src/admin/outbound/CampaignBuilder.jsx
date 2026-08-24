// Creating and editing a campaign.
//
// The form refuses a combination the provider cannot honour rather than letting
// it save and fail at dial time. `assertSupports` runs on the server too — this
// is the same check rendered early, so an operator sees "Kixie cannot run a
// parallel session" while choosing, not after adding 400 targets.
//
// The calling window defaults are deliberately tighter than the legal maximum.
// An operator who wants 8am–9pm has to choose it.
//
// The account selector has no default on purpose. BiteSites and its commission
// clients share one CRM, so `accountId` is the only thing keeping their contacts
// apart, and a pre-selected account is a wrong account nobody reads. It is also
// fixed once saved — the targets underneath were admitted by comparing them
// against it.

import React, { useEffect, useMemo, useState } from 'react';
import { outbound, useAction } from './data';
import { providerLabel } from './SourceBadge';
// The server's registry, imported rather than mirrored: a second copy of this
// list is a second copy that can disagree with the one enforcing the boundary.
import { ACCOUNTS, ACCOUNT_IDS, LEGACY_ACCOUNT_ID, readAccountId } from '../../../functions/accounts.js';

const MODES = [
  ['power', 'Power dial', 'One call at a time, driven by a person.'],
  ['parallel', 'Parallel dial', 'Up to five lines; the first human answer wins and the rest are cancelled.'],
  ['ai', 'AI calls', 'An AI agent places the call from an approved brief.']
];

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

const CONSENT_BASES = [
  ['not_recorded', 'No documented consent'],
  ['written_opt_in', 'Written AI / artificial-voice opt-in'],
  ['inbound_request', 'Inbound request — not AI consent by itself'],
  ['existing_business_relationship', 'Existing relationship — not AI consent by itself']
];

const BLANK = {
  name: '', accountId: '', mode: 'power', provider: 'mock', concurrency: 1, callerId: '',
  agentProfileId: '',
  objective: '', script: '', bookingRules: '', escalationRules: '',
  allowedDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  localStartTime: '09:00', localEndTime: '19:00',
  maxAttempts: 1, retryDelayMinutes: 1440, voicemailPolicy: 'none',
  requireResearchApproval: true, recordingDisclosureRequired: false,
  aiDisclosureRequired: true, consentBasis: 'not_recorded', recordCalls: false
};

/** The client-side mirror of assertSupports — same rules, rendered early. */
function capabilityGap(providers, providerId, mode, concurrency) {
  const provider = providers.find(entry => entry.id === providerId);
  if (!provider) return ['unknown provider'];
  const needed = mode === 'ai' ? ['aiAgentCall']
    : mode === 'power' ? ['powerDial']
      : ['parallelDial', 'perLegCallIds', 'humanAnswerDetection', 'cancelCallLeg'];
  const missing = needed.filter(capability => provider.capabilities?.[capability] !== true);
  if (Number(concurrency) > Number(provider.capabilities?.maxConcurrency || 1)) {
    missing.push(`concurrency above ${provider.capabilities?.maxConcurrency || 1}`);
  }
  return missing;
}

export default function CampaignBuilder({ providers = [], campaign = null, onSaved, onCancel }) {
  const [form, setForm] = useState(() => ({
    ...BLANK,
    ...(campaign || {}),
    // A campaign saved before the account boundary existed carries none, and it
    // belongs to the house account by definition.
    ...(campaign ? { accountId: readAccountId(campaign.accountId, { fallback: LEGACY_ACCOUNT_ID }) } : {})
  }));
  const [agentProfiles, setAgentProfiles] = useState([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const action = useAction();
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  const missing = useMemo(
    () => capabilityGap(providers, form.provider, form.mode, form.concurrency),
    [providers, form.provider, form.mode, form.concurrency]
  );
  const provider = providers.find(entry => entry.id === form.provider);
  const needsAgentProfile = form.provider === 'twilio' && form.mode === 'parallel';

  useEffect(() => {
    let cancelled = false;
    outbound.listAgentProfiles()
      .then(result => {
        if (cancelled) return;
        setAgentProfiles((result?.profiles || []).filter(profile => profile.status !== 'archived'));
      })
      .catch(() => { if (!cancelled) setAgentProfiles([]); })
      .finally(() => { if (!cancelled) setAgentsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Only this account's personas are offerable. The server refuses the rest
  // anyway; showing them invites the operator to pick one and read the refusal
  // as a bug rather than as the boundary working.
  const accountProfiles = useMemo(
    () => (form.accountId
      ? agentProfiles.filter(profile =>
        readAccountId(profile.accountId, { fallback: LEGACY_ACCOUNT_ID }) === form.accountId)
      : []),
    [agentProfiles, form.accountId]
  );

  // Changing the account drops a persona that no longer belongs, rather than
  // leaving a stale id in a field the operator can no longer see.
  useEffect(() => {
    setForm(current => {
      if (!current.agentProfileId) {
        return accountProfiles.length && current.accountId
          ? { ...current, agentProfileId: accountProfiles[0].id }
          : current;
      }
      return accountProfiles.some(profile => profile.id === current.agentProfileId)
        ? current
        : { ...current, agentProfileId: accountProfiles[0]?.id || '' };
    });
  }, [accountProfiles]);

  const submit = async event => {
    event.preventDefault();
    const payload = { ...form, concurrency: Number(form.concurrency), maxAttempts: Number(form.maxAttempts), retryDelayMinutes: Number(form.retryDelayMinutes) };
    const result = campaign?.id
      ? await action.run(() => outbound.updateCampaign(campaign.id, payload), 'Saved.')
      : await action.run(() => outbound.createCampaign(payload), 'Created.');
    if (result) onSaved?.(result.campaignId || campaign?.id);
  };

  const toggleDay = day => set('allowedDays', form.allowedDays.includes(day)
    ? form.allowedDays.filter(entry => entry !== day)
    : [...form.allowedDays, day]);

  return (
    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>{campaign?.id ? 'Edit campaign' : 'New campaign'}</h3>
          <p>Nothing dials until you start it, and a started campaign still honours every setting below on every call.</p>
        </div>
        {onCancel && (
          <div className="card-head-actions">
            <button className="btn-admin" type="button" onClick={onCancel}>Cancel</button>
          </div>
        )}
      </div>

      <form className="outbound-form" onSubmit={submit}>
        <div className="outbound-form-grid">
          <label className="full">
            <span>Campaign name</span>
            <input value={form.name} onChange={event => set('name', event.target.value)} required maxLength={120} />
          </label>

          <label>
            <span>Account</span>
            <select value={form.accountId} required disabled={Boolean(campaign?.id)}
              onChange={event => set('accountId', event.target.value)}>
              <option value="">Select an account…</option>
              {ACCOUNT_IDS.map(id => <option key={id} value={id}>{ACCOUNTS[id].label}</option>)}
            </select>
            <small>
              {campaign?.id
                ? 'Fixed once saved — its targets were admitted against this account.'
                : 'Whose contacts this campaign may call. It cannot be changed later.'}
            </small>
          </label>

          <label>
            <span>Mode</span>
            <select value={form.mode} onChange={event => set('mode', event.target.value)}>
              {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <small>{MODES.find(([value]) => value === form.mode)?.[2]}</small>
          </label>

          <label>
            <span>Provider</span>
            <select value={form.provider} onChange={event => set('provider', event.target.value)}>
              {providers.map(entry => (
                <option key={entry.id} value={entry.id}>
                  {providerLabel(entry.id)}{entry.configured ? '' : ' — not configured'}
                </option>
              ))}
            </select>
            {provider && !provider.configured && (
              <small>Missing server-side secrets: {(provider.missingSecrets || []).join(', ')}</small>
            )}
          </label>

          {form.mode === 'parallel' && (
            <label>
              <span>Simultaneous lines</span>
              <select value={form.concurrency} onChange={event => set('concurrency', Number(event.target.value))}>
                {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}
              </select>
              <small>The first verified human answer connects; every other leg is cancelled.</small>
            </label>
          )}

          <label>
            <span>Caller ID (E.164)</span>
            <input value={form.callerId} onChange={event => set('callerId', event.target.value)} placeholder="+15551234567" />
            <small>Must be a number you are registered to use.</small>
          </label>

          {needsAgentProfile && (
            <label>
              <span>Default AI agent</span>
              <select value={form.agentProfileId} required disabled={agentsLoading || !form.accountId}
                onChange={event => set('agentProfileId', event.target.value)}>
                <option value="">
                  {agentsLoading ? 'Loading agents…'
                    : !form.accountId ? 'Choose an account first…'
                      : accountProfiles.length ? 'Select an agent…'
                        : `No agents belong to ${ACCOUNTS[form.accountId]?.label || 'this account'} yet`}
                </option>
                {accountProfiles.map(profile => (
                  <option key={profile.id} value={profile.id}>{profile.name} · v{profile.version || 1}</option>
                ))}
              </select>
              <small>
                Only this account’s agents are listed. Used for AI overflow by default; an operator can
                still override it for one session.
              </small>
            </label>
          )}

          <label className="full">
            <span>Objective</span>
            <input value={form.objective} onChange={event => set('objective', event.target.value)} maxLength={500}
              placeholder="Book a 15-minute website review" />
          </label>

          <label className="full">
            <span>Script / agent instructions</span>
            <textarea rows={5} value={form.script} onChange={event => set('script', event.target.value)} maxLength={8000} />
            <small>Required disclosures are added automatically and cannot be removed from here.</small>
          </label>

          <label>
            <span>Calling days</span>
            <div className="outbound-day-picker">
              {DAYS.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={form.allowedDays.includes(value)} onClick={() => toggleDay(value)}>
                  {label}
                </button>
              ))}
            </div>
          </label>

          <label>
            <span>Local calling window</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="time" value={form.localStartTime} onChange={event => set('localStartTime', event.target.value)} />
              <input type="time" value={form.localEndTime} onChange={event => set('localEndTime', event.target.value)} />
            </div>
            <small>In the contact’s timezone. A contact with an unknown timezone is never called.</small>
          </label>

          <label>
            <span>Maximum attempts</span>
            <input type="number" min="1" max="10" value={form.maxAttempts} onChange={event => set('maxAttempts', event.target.value)} />
          </label>

          <label>
            <span>Retry delay (minutes)</span>
            <input type="number" min="15" max="10080" value={form.retryDelayMinutes} onChange={event => set('retryDelayMinutes', event.target.value)} />
          </label>

          <label>
            <span>Voicemail</span>
            <select value={form.voicemailPolicy} onChange={event => set('voicemailPolicy', event.target.value)}>
              <option value="retry">Hang up and retry later</option>
              <option value="leave_message">Leave a message</option>
              <option value="none">Hang up, do not retry</option>
            </select>
          </label>

          <label>
            <span>Consent basis</span>
            <select value={form.consentBasis} onChange={event => set('consentBasis', event.target.value)}>
              {CONSENT_BASES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <small>Recorded for the audit trail. It is not a legal determination.</small>
            {form.mode === 'ai' && form.consentBasis !== 'written_opt_in' && (
              <small className="admin-error">AI calling also requires valid seller-specific written consent on each target.</small>
            )}
          </label>

          <label className="checkbox-row full">
            <input type="checkbox" checked={form.requireResearchApproval}
              onChange={event => set('requireResearchApproval', event.target.checked)} />
            <span>Require a human to approve each brief before the contact is called</span>
          </label>

          <div className="admin-note full">Audio recording is disabled until the post-answer consent and retention controls are verified.</div>

          {form.mode === 'ai' && (
            <label className="checkbox-row full">
              <input type="checkbox" checked disabled />
              <span>AI identity disclosure is mandatory</span>
            </label>
          )}
        </div>

        {missing.length > 0 && (
          <p className="admin-error">
            {providerLabel(form.provider)} cannot run a {form.mode} campaign — missing: {missing.join(', ')}.
            {form.mode === 'parallel' && ' Use the mock provider to rehearse, or Twilio for a real BiteSites-controlled parallel session.'}
          </p>
        )}
        {action.error && <p className="admin-error">{action.error}</p>}
        {action.message && <p className="admin-note">{action.message}</p>}

        <button className="btn-admin primary" type="submit"
          disabled={action.busy || missing.length > 0 || (needsAgentProfile && !form.agentProfileId)}>
          {action.busy ? 'Saving…' : campaign?.id ? 'Save campaign' : 'Create campaign'}
        </button>
      </form>
    </div>
  );
}
