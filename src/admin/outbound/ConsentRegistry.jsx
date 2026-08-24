// Admin-only review queue for the server-owned AI voice consent ledger.
// A candidate is evidence awaiting a named reviewer; only issuing its grant
// can make a number eligible, and revocation remains visible forever.

import React, { useMemo, useState } from 'react';
import { Panel } from '../Panel';
import { outbound, useAction, useConsentEvidenceCandidates, useConsentGrants } from './data';
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

export default function ConsentRegistry() {
  const candidates = useConsentEvidenceCandidates();
  const grants = useConsentGrants();
  const createAction = useAction();
  const reviewAction = useAction();
  const revokeAction = useAction();
  const [form, setForm] = useState(freshForm);
  const [revokeId, setRevokeId] = useState('');
  const [revokeReason, setRevokeReason] = useState('');

  const pending = useMemo(() => candidates.rows.filter(row => row.status === 'pending_review'), [candidates.rows]);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

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
    </section>
  );
}
