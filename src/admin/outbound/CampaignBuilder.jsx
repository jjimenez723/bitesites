// Creating and editing a campaign.
//
// The form refuses a combination the provider cannot honour rather than letting
// it save and fail at dial time. `assertSupports` runs on the server too — this
// is the same check rendered early, so an operator sees "Kixie cannot run a
// parallel session" while choosing, not after adding 400 targets.
//
// The calling window defaults are deliberately tighter than the legal maximum.
// An operator who wants 8am–9pm has to choose it.

import React, { useMemo, useState } from 'react';
import { outbound, useAction } from './data';
import { providerLabel } from './SourceBadge';

const MODES = [
  ['power', 'Power dial', 'One call at a time, driven by a person.'],
  ['parallel', 'Parallel dial', 'Up to five lines; the first human answer wins and the rest are cancelled.'],
  ['ai', 'AI calls', 'An AI agent places the call from an approved brief.']
];

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

const CONSENT_BASES = [
  ['not_recorded', 'Not recorded'],
  ['written_opt_in', 'Written opt-in'],
  ['inbound_request', 'Inbound request'],
  ['existing_business_relationship', 'Existing business relationship']
];

const BLANK = {
  name: '', mode: 'power', provider: 'mock', concurrency: 1, callerId: '',
  objective: '', script: '', bookingRules: '', escalationRules: '',
  allowedDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  localStartTime: '09:00', localEndTime: '18:00',
  maxAttempts: 3, retryDelayMinutes: 240, voicemailPolicy: 'retry',
  requireResearchApproval: true, recordingDisclosureRequired: true,
  aiDisclosureRequired: true, consentBasis: 'not_recorded', recordCalls: true
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
  const [form, setForm] = useState(() => ({ ...BLANK, ...(campaign || {}) }));
  const action = useAction();
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  const missing = useMemo(
    () => capabilityGap(providers, form.provider, form.mode, form.concurrency),
    [providers, form.provider, form.mode, form.concurrency]
  );
  const provider = providers.find(entry => entry.id === form.provider);

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
          </label>

          <label className="checkbox-row full">
            <input type="checkbox" checked={form.requireResearchApproval}
              onChange={event => set('requireResearchApproval', event.target.checked)} />
            <span>Require a human to approve each brief before the contact is called</span>
          </label>

          <label className="checkbox-row full">
            <input type="checkbox" checked={form.recordingDisclosureRequired}
              onChange={event => set('recordingDisclosureRequired', event.target.checked)} />
            <span>Disclose that the call is recorded and transcribed</span>
          </label>

          {form.mode === 'ai' && (
            <label className="checkbox-row full">
              <input type="checkbox" checked={form.aiDisclosureRequired}
                onChange={event => set('aiDisclosureRequired', event.target.checked)} />
              <span>Disclose that the caller is an AI assistant</span>
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

        <button className="btn-admin primary" type="submit" disabled={action.busy || missing.length > 0}>
          {action.busy ? 'Saving…' : campaign?.id ? 'Save campaign' : 'Create campaign'}
        </button>
      </form>
    </div>
  );
}
