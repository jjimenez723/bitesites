// The call brief, and its approval gate.
//
// The verified/unverified split is the whole design. A fact the system read
// somewhere is shown with the source it came from and can be clicked through;
// something it merely suspects is rendered in the demoted style and labelled.
// A rep reading this at speed has to be able to tell, in one glance, which
// sentences they can say out loud.
//
// Approval edits the prose and nothing else. `verifiedFacts` and `sources` are
// not editable from here — an approver who could type a new "fact" would defeat
// the sourcing rule the AI prompt depends on.

import React, { useEffect, useState } from 'react';
import { outbound, useAction, loadResearchDoc } from './data';
import { formatWhen } from './SourceBadge';

export default function LeadResearchPanel({ contactType, contactId, compact = false, onApproved }) {
  const [research, setResearch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ summary: '', suggestedOpening: '' });
  const action = useAction();

  const key = contactId ? `${contactType}_${contactId}` : '';

  useEffect(() => {
    let cancelled = false;
    if (!key) { setResearch(null); setLoading(false); return undefined; }
    setLoading(true);
    loadResearchDoc(key)
      .then(doc => { if (!cancelled) { setResearch(doc); setLoading(false); } })
      .catch(() => { if (!cancelled) { setResearch(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [key]);

  const generate = async (refresh = false) => {
    const result = await action.run(() => outbound.research(contactType, contactId, refresh), '');
    if (result?.research) {
      setResearch(result.research);
      setDraft({ summary: result.research.summary || '', suggestedOpening: result.research.suggestedOpening || '' });
    }
  };

  const approve = async () => {
    const edits = editing ? draft : null;
    const result = await action.run(() => outbound.approveResearch(key, edits), 'Approved.');
    if (result) {
      setResearch(current => ({ ...current, ...(edits || {}), approved: true, approvedAt: new Date() }));
      setEditing(false);
      onApproved?.();
    }
  };

  if (loading) return <p className="admin-note">Loading research…</p>;

  if (!research) {
    return (
      <div>
        <p className="admin-note">No research yet for this contact.</p>
        <button className="btn-admin primary" type="button" style={{ marginTop: 10 }} disabled={action.busy} onClick={() => generate(false)}>
          {action.busy ? 'Researching…' : 'Research this business'}
        </button>
        {action.error && <p className="admin-error" style={{ marginTop: 10 }}>{action.error}</p>}
      </div>
    );
  }

  const sourceById = new Map((research.sources || []).map(source => [source.id, source]));
  const expiresAt = research.expiresAt?.toDate?.() || null;
  const stale = expiresAt && expiresAt.getTime() < Date.now();

  return (
    <div className="outbound-brief">
      <div className="admin-filters">
        <span className={research.approved ? 'pill approved' : 'pill needs_review'}>
          <i />{research.approved ? 'Approved' : 'Not approved'}
        </span>
        <span className="cell-dim" style={{ fontSize: 11.5 }}>
          {(research.verifiedFacts || []).length} sourced facts · confidence {Math.round((research.confidence || 0) * 100)}%
        </span>
        {stale && <span className="outbound-stale">Expired — regenerate before calling.</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn-admin" type="button" disabled={action.busy} onClick={() => generate(true)}>
            {action.busy ? 'Working…' : 'Regenerate'}
          </button>
          {!research.approved && (
            <>
              <button className="btn-admin" type="button" onClick={() => {
                setDraft({ summary: research.summary || '', suggestedOpening: research.suggestedOpening || '' });
                setEditing(value => !value);
              }}>
                {editing ? 'Cancel edit' : 'Edit'}
              </button>
              <button className="btn-admin primary" type="button" disabled={action.busy} onClick={approve}>
                Approve
              </button>
            </>
          )}
        </div>
      </div>

      {action.error && <p className="admin-error">{action.error}</p>}

      <div>
        <h4>Summary</h4>
        {editing ? (
          <div className="outbound-form-grid">
            <label className="full">
              <textarea rows={3} value={draft.summary} onChange={event => setDraft({ ...draft, summary: event.target.value })} />
            </label>
          </div>
        ) : (
          <p style={{ fontSize: 13, lineHeight: 1.6 }}>{research.summary || '—'}</p>
        )}
      </div>

      <div>
        <h4>Suggested opening</h4>
        {editing ? (
          <div className="outbound-form-grid">
            <label className="full">
              <textarea rows={3} value={draft.suggestedOpening} onChange={event => setDraft({ ...draft, suggestedOpening: event.target.value })} />
            </label>
          </div>
        ) : (
          <div className="outbound-opening">{research.suggestedOpening || '—'}</div>
        )}
      </div>

      <div>
        <h4>Verified facts — each one has a source</h4>
        {(research.verifiedFacts || []).length ? (
          (research.verifiedFacts || []).map(fact => {
            const source = sourceById.get(fact.sourceId);
            return (
              <div className="outbound-fact" key={fact.id}>
                <span className="outbound-fact-source" title={source?.url || source?.title || ''}>
                  {source?.title?.slice(0, 22) || 'source'}
                </span>
                <span>{fact.text}</span>
              </div>
            );
          })
        ) : (
          <p className="admin-note">Nothing could be verified about this business.</p>
        )}
      </div>

      {(research.hypotheses || []).length > 0 && (
        <div>
          <h4>Unverified — do not state these as fact</h4>
          {research.hypotheses.map(item => <p className="outbound-hypothesis" key={item}>{item}</p>)}
        </div>
      )}

      {!compact && (research.talkingPoints || []).length > 0 && (
        <div>
          <h4>Talking points</h4>
          <ul style={{ margin: '0 0 0 16px', padding: 0 }}>
            {research.talkingPoints.map(point => (
              <li key={point} style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-2)' }}>{point}</li>
            ))}
          </ul>
        </div>
      )}

      {!compact && (research.likelyObjections || []).length > 0 && (
        <div>
          <h4>Likely objections</h4>
          <ul style={{ margin: '0 0 0 16px', padding: 0 }}>
            {research.likelyObjections.map(item => (
              <li key={item} style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-3)' }}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4>Sources</h4>
        <div className="outbound-source-list">
          {(research.sources || []).map(source => (
            source.url
              ? <a key={source.id} href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a>
              : <span key={source.id} className="cell-dim" style={{ fontSize: 11.5 }}>{source.title}</span>
          ))}
        </div>
        <p className="admin-note" style={{ marginTop: 8 }}>
          Generated {formatWhen(research.generatedAt)}
          {research.approvedBy ? ` · approved by ${research.approvedBy}` : ''}
        </p>
      </div>
    </div>
  );
}
