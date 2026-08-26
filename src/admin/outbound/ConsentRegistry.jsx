// Admin-only review queue for the server-owned AI voice consent ledger, and the
// pre-dial screening that has to follow it.
//
// A candidate is evidence awaiting a named reviewer; only issuing its grant can
// make a number eligible, and revocation remains visible forever.
//
// Screening lives on this screen rather than beside the dialer for two reasons.
// It is gated identically — `requireConsentReviewer`, not merely outbound staff
// — because writing a "cleared" screening record permits an artificial-voice
// call to a specific number just as directly as issuing the grant does. And it
// is strictly downstream of a grant: the reassignment answer is only meaningful
// relative to the date consent was given, and the server compares the two to the
// day. Selecting a grant rather than retyping a number is what keeps those two
// dates from drifting apart.

import React, { useEffect, useMemo, useState } from 'react';
import { Panel } from '../Panel';
import { outbound, toDate, useAction, useConsentEvidenceCandidates, useConsentGrants } from './data';
import { formatPhone, formatWhen } from './SourceBadge';

const SELLERS = [
  ['bitesites', 'BiteSites'],
  ['stone-bellisimo', 'Stone Bellisimo'],
  ['fine-line-group', 'The Fine Line Group']
];

const newIdempotencyKey = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? uuid.replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`;
};

const freshForm = () => ({
  sellerAccountId: 'bitesites', contactType: 'prospect', contactId: '', phoneE164: '',
  subjectName: '', evidenceType: 'signed_web_form', evidenceArtifactId: '',
  disclosureVersion: '', sourceUrl: '', grantedAt: '', expiresAt: '', attestation: '', idempotencyKey: newIdempotencyKey()
});

const display = value => value || '—';

const today = () => new Date().toISOString().slice(0, 10);

const freshScreenForm = () => ({
  grantId: '', providerId: '', dncSnapshotId: '', dncCheckedAt: today(), dncProvider: ''
});

/**
 * The server's refusal codes, in words an operator can act on.
 *
 * Every one of these is a correct answer rather than a failure, and they have
 * genuinely different remedies — authorise a budget, procure a service, pick a
 * different provider, or stop, because this person asked us not to call. A
 * single “screening failed” would send someone to fix the wrong thing.
 */
const SCREEN_REASONS = {
  entity_dnc_suppressed:
    'This number is on our own do-not-call list. That is a stop, not an obstacle — no evidence was written and none should be.',
  non_verifying_provider_in_production:
    'That provider computes its answers locally instead of asking anyone, so it cannot write evidence in production. Choose a verifying provider.',
  paid_screening_not_explicitly_enabled:
    'This provider bills per lookup and the spend is not authorised. PAID_PHONE_SCREENING=enabled must ship on a production deploy first — OUTBOUND_LAUNCH_AUTHORIZATION.md §3.',
  non_production_environment:
    'A paid lookup is refused outside production, so nothing was billed and nothing was written.'
};

export default function ConsentRegistry() {
  const candidates = useConsentEvidenceCandidates();
  const grants = useConsentGrants();
  const createAction = useAction();
  const reviewAction = useAction();
  const revokeAction = useAction();
  const screenAction = useAction();
  const [form, setForm] = useState(freshForm);
  const [revokeId, setRevokeId] = useState('');
  const [revokeReason, setRevokeReason] = useState('');
  const [screenForm, setScreenForm] = useState(freshScreenForm);
  const [providers, setProviders] = useState([]);
  const [screenResult, setScreenResult] = useState(null);

  const pending = useMemo(() => candidates.rows.filter(row => row.status === 'pending_review'), [candidates.rows]);
  const active = useMemo(() => grants.rows.filter(row => row.status === 'active'), [grants.rows]);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const setScreen = (key, value) => setScreenForm(current => ({ ...current, [key]: value }));

  // Capability metadata only — secret names, never values. Failing quietly is
  // right here: an operator who cannot read the provider list can still work the
  // consent half of this screen, which is the half that gates on a human.
  useEffect(() => {
    let live = true;
    outbound.screeningProviders()
      .then(result => { if (live) setProviders(result?.providers || []); })
      .catch(() => { if (live) setProviders([]); });
    return () => { live = false; };
  }, []);

  const create = async event => {
    event.preventDefault();
    const result = await createAction.run(() => outbound.createConsentEvidenceCandidate({
      ...form,
      grantedAt: form.grantedAt ? new Date(form.grantedAt).toISOString() : '',
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : ''
    }), 'Evidence candidate saved for review. It does not authorize a call yet.');
    if (result) { setForm(freshForm()); candidates.refresh(); }
  };

  const issue = async candidateId => {
    const result = await reviewAction.run(
      () => outbound.issueConsentGrant(candidateId),
      'Grant issued and stamped onto the linked contact. Re-import the contact into a campaign to create a new immutable target snapshot.'
    );
    if (result) { candidates.refresh(); grants.refresh(); }
  };

  const screen = async event => {
    event.preventDefault();
    setScreenResult(null);
    const grant = active.find(row => row.id === screenForm.grantId);
    if (!grant) return;
    // The grant owns the seller, the number and the consent date. Retyping any
    // of the three is how a screening record ends up describing a different
    // number, or carrying a consent date that will never match the grant it was
    // written for.
    const grantedAt = toDate(grant.grantedAt);
    const checkedAt = screenForm.dncCheckedAt ? new Date(screenForm.dncCheckedAt) : null;
    if (!grantedAt || !checkedAt || Number.isNaN(checkedAt.getTime())) return;

    const result = await screenAction.run(() => outbound.ingestPreDialScreening({
      sellerAccountId: grant.sellerAccountId,
      phoneE164: grant.phoneE164,
      consentGrantedAt: grantedAt.toISOString(),
      ...(screenForm.providerId ? { providerId: screenForm.providerId } : {}),
      nationalDnc: {
        status: 'clear',
        snapshotId: screenForm.dncSnapshotId,
        checkedAt: checkedAt.toISOString(),
        provider: screenForm.dncProvider
      }
    }));
    if (result) {
      setScreenResult(result);
      // Keep the DNC snapshot fields — ten numbers are screened against one
      // download — and clear only the grant, so the next one is a fresh choice.
      if (result.written) setScreenForm(current => ({ ...current, grantId: '' }));
    }
  };

  const revoke = async event => {
    event.preventDefault();
    const result = await revokeAction.run(() => outbound.revokeConsentGrant(revokeId, revokeReason), 'Grant revoked. Any queued AI call now fails its ledger check.');
    if (result) { setRevokeId(''); setRevokeReason(''); grants.refresh(); candidates.refresh(); }
  };

  return (
    <section className="outbound-stack" aria-label="AI voice consent ledger">
      <Panel title="AI voice consent" subtitle="Written evidence is reviewed by an owner before it can authorize an AI call.">
        <div className="outbound-compliance-note">
          <strong>Permission boundary.</strong> A source label, a CRM checkbox, or a verbal note never authorizes AI voice. Issue a seller- and number-specific grant only after reviewing complete written evidence. Recording remains disabled.
        </div>

        <form className="outbound-form" onSubmit={create}>
          <div className="outbound-form-grid">
            <label><span>Seller</span><select className="admin-select" value={form.sellerAccountId} onChange={event => set('sellerAccountId', event.target.value)}>
              {SELLERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select></label>
            <label><span>Contact record</span><select className="admin-select" value={form.contactType} onChange={event => set('contactType', event.target.value)}><option value="prospect">Prospect</option><option value="lead">Lead</option></select></label>
            <label><span>Contact ID</span><input required value={form.contactId} maxLength={200} onChange={event => set('contactId', event.target.value)} placeholder="Firestore document ID" /></label>
            <label><span>Consented number</span><input required value={form.phoneE164} maxLength={40} onChange={event => set('phoneE164', event.target.value)} placeholder="+1 201 555 0123" /></label>
            <label><span>Subject name <small>(optional)</small></span><input value={form.subjectName} maxLength={160} onChange={event => set('subjectName', event.target.value)} /></label>
            <label><span>Written evidence type</span><select className="admin-select" value={form.evidenceType} onChange={event => set('evidenceType', event.target.value)}>
              <option value="signed_web_form">Signed web form</option><option value="signed_agreement">Signed agreement</option><option value="digital_signature">Digital signature</option><option value="other_documented_written_opt_in">Other documented written opt-in</option>
            </select></label>
            <label><span>Evidence artifact ID</span><input required value={form.evidenceArtifactId} maxLength={200} onChange={event => set('evidenceArtifactId', event.target.value)} placeholder="Form or signed-document ID" /></label>
            <label><span>Disclosure version</span><input required value={form.disclosureVersion} maxLength={120} onChange={event => set('disclosureVersion', event.target.value)} placeholder="ai-voice-consent-v1" /></label>
            <label><span>Granted at</span><input required type="datetime-local" value={form.grantedAt} onChange={event => set('grantedAt', event.target.value)} /></label>
            <label><span>Expires at <small>(optional)</small></span><input type="datetime-local" value={form.expiresAt} onChange={event => set('expiresAt', event.target.value)} /></label>
            <label className="full"><span>Evidence location <small>(optional HTTPS URL)</small></span><input type="url" value={form.sourceUrl} maxLength={1000} onChange={event => set('sourceUrl', event.target.value)} placeholder="https://…" /></label>
            <label className="full"><span>Reviewer attestation</span><textarea required minLength={20} rows={3} value={form.attestation} maxLength={2000} onChange={event => set('attestation', event.target.value)} placeholder="I reviewed the retained written opt-in. It identifies this seller, this number, and the AI/artificial voice disclosure version above." /></label>
          </div>
          {createAction.error && <p className="admin-error">{createAction.error}</p>}
          {createAction.message && <p className="admin-note">{createAction.message}</p>}
          <button className="btn-admin primary" type="submit" disabled={createAction.busy}>{createAction.busy ? 'Saving…' : 'Save evidence candidate'}</button>
        </form>
      </Panel>

      <Panel title={`Evidence awaiting review (${pending.length})`} subtitle="Approval is idempotent and creates one immutable grant plus an audit event.">
        {candidates.loading && <p className="admin-note">Loading evidence…</p>}
        {candidates.error && <p className="admin-error">{candidates.error}</p>}
        {!candidates.loading && !pending.length && <p className="admin-note">No pending evidence candidates.</p>}
        {pending.map(candidate => (
          <article key={candidate.id} className="outbound-card" style={{ marginBottom: 10 }}>
            <div className="outbound-card-head"><div><strong>{SELLERS.find(([id]) => id === candidate.sellerAccountId)?.[1] || candidate.sellerAccountId}</strong><span className="cell-dim"> · {formatPhone(candidate.phoneE164)} · {candidate.evidenceType?.replace(/_/g, ' ')}</span></div><span className="pill pending_review">Pending review</span></div>
            <p className="cell-dim" style={{ margin: '8px 0' }}>Contact: {candidate.contactType} {candidate.contactId} · Artifact: {candidate.evidenceArtifactId} · Disclosure: {candidate.disclosureVersion}</p>
            <p style={{ margin: '8px 0' }}>{candidate.attestation}</p>
            <p className="cell-dim">Granted {formatWhen(candidate.grantedAt)}{candidate.expiresAt ? ` · expires ${formatWhen(candidate.expiresAt)}` : ''}</p>
            {reviewAction.error && <p className="admin-error">{reviewAction.error}</p>}
            <button className="btn-admin primary" type="button" disabled={reviewAction.busy} onClick={() => issue(candidate.id)}>{reviewAction.busy ? 'Issuing…' : 'Review and issue grant'}</button>
          </article>
        ))}
      </Panel>

      <Panel title="Issued grants" subtitle="The evidence body cannot be edited. Revocation appends an audit event and stops future AI attachment.">
        {grants.loading && <p className="admin-note">Loading grants…</p>}
        {grants.error && <p className="admin-error">{grants.error}</p>}
        {!grants.loading && !grants.rows.length && <p className="admin-note">No grants have been issued.</p>}
        {grants.rows.map(grant => (
          <article key={grant.id} className="outbound-card" style={{ marginBottom: 10 }}>
            <div className="outbound-card-head"><div><strong>{formatPhone(grant.phoneE164)}</strong><span className="cell-dim"> · {grant.sellerAccountId} · {grant.id}</span></div><span className={`pill ${grant.status}`}>{grant.status || 'unknown'}</span></div>
            <p className="cell-dim" style={{ margin: '8px 0' }}>Artifact: {grant.evidenceArtifactId} · Disclosure: {grant.disclosureVersion} · reviewed by {display(grant.reviewedBy)} on {formatWhen(grant.reviewedAt)}</p>
            {grant.revocation && <p className="admin-note">Revoked: {grant.revocation.reason}</p>}
            {grant.status === 'active' && <button className="btn-admin danger" type="button" onClick={() => { setRevokeId(grant.id); setRevokeReason(''); }}>Revoke grant</button>}
          </article>
        ))}
        {revokeId && <form className="manual-lead-confirm" onSubmit={revoke} style={{ marginTop: 12 }}>
          <label><span>Why is this permission being revoked?</span><textarea required minLength={5} rows={2} value={revokeReason} maxLength={1000} onChange={event => setRevokeReason(event.target.value)} /></label>
          {revokeAction.error && <p className="admin-error">{revokeAction.error}</p>}
          <div className="admin-filters"><button className="btn-admin danger" type="submit" disabled={revokeAction.busy}>{revokeAction.busy ? 'Revoking…' : 'Confirm revocation'}</button><button className="btn-admin" type="button" disabled={revokeAction.busy} onClick={() => setRevokeId('')}>Cancel</button></div>
        </form>}
      </Panel>

      <Panel title="Pre-dial screening" subtitle="Consent says we may call this person. Screening says the number is still theirs, still real, and not on a do-not-call list.">
        <div className="outbound-compliance-note">
          <strong>One number at a time, and never a list.</strong> A cleared record is valid for 31 days and is bound to one seller and one number. The national do-not-call answer is not something this system can look up — hand in the dated snapshot from the service you enrolled with. There is no default of “clear”, because “we did not check” and “we checked and it is fine” must never look the same.
        </div>

        {!active.length && <p className="admin-note">No active consent grants yet. Screening is always downstream of a grant — issue one above first.</p>}

        {!!active.length && <form className="outbound-form" onSubmit={screen}>
          <div className="outbound-form-grid">
            <label className="full"><span>Consented number</span><select className="admin-select" required value={screenForm.grantId} onChange={event => { setScreen('grantId', event.target.value); setScreenResult(null); }}>
              <option value="">Select an active grant…</option>
              {active.map(grant => <option key={grant.id} value={grant.id}>
                {formatPhone(grant.phoneE164)} · {SELLERS.find(([id]) => id === grant.sellerAccountId)?.[1] || grant.sellerAccountId} · consented {formatWhen(grant.grantedAt)}
              </option>)}
            </select></label>

            <label><span>Screening provider</span><select className="admin-select" value={screenForm.providerId} onChange={event => setScreen('providerId', event.target.value)}>
              <option value="">Server default</option>
              {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </select></label>
            <label><span>National DNC service</span><input required value={screenForm.dncProvider} maxLength={120} onChange={event => setScreen('dncProvider', event.target.value)} placeholder="e.g. ftc_telemarketing_donotcall_gov" /></label>
            <label><span>DNC snapshot ID</span><input required value={screenForm.dncSnapshotId} maxLength={200} onChange={event => setScreen('dncSnapshotId', event.target.value)} placeholder="Subscription account number + download date" /></label>
            <label><span>DNC checked on</span><input required type="date" max={today()} value={screenForm.dncCheckedAt} onChange={event => setScreen('dncCheckedAt', event.target.value)} /></label>
          </div>

          {!!providers.length && <p className="cell-dim" style={{ margin: '4px 0 10px' }}>
            {providers.map(provider => `${provider.id}: ${provider.capabilities?.verifiesExternally ? 'verifies externally' : 'simulated — refused in production'}${provider.capabilities?.paidLookup ? ', bills per lookup' : ', free'}`).join(' · ')}
          </p>}

          {screenAction.error && <p className="admin-error">{screenAction.error}</p>}
          {screenResult && !screenResult.written && <p className="admin-error">
            No evidence was written. {SCREEN_REASONS[screenResult.reason] || screenResult.reason}
          </p>}
          {screenResult?.written && <p className="admin-note">
            Cleared and recorded{screenResult.lineType ? ` as a ${screenResult.lineType} line` : ''}, valid until {formatWhen(screenResult.expiresAt)}. This number now satisfies the screening gate. It still cannot be called until external dialing is enabled on a production deploy and its campaign is unpaused.
          </p>}
          <button className="btn-admin primary" type="submit" disabled={screenAction.busy || !screenForm.grantId}>{screenAction.busy ? 'Screening…' : 'Screen this number'}</button>
        </form>}
      </Panel>
    </section>
  );
}
