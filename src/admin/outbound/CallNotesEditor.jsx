import React, { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { outbound } from './data';
import { createCallNotesDraft } from './call-notes-draft';

const drafts = new Map();

export function useCallNotes(call, { demo = false } = {}) {
  const key = `${demo ? 'demo:' : ''}${call.id}`;
  const draft = useMemo(() => {
    if (drafts.has(key)) return drafts.get(key);
    let storage;
    try { if (!demo) storage = window.localStorage; } catch { /* Optional draft backup. */ }
    const entry = createCallNotesDraft({
      callId: call.id, initialText: call.callNotes ?? call.summary ?? '', storage,
      save: demo ? async () => {} : outbound.saveCallNotes
    });
    drafts.set(key, entry);
    return entry;
    // A new call starts its own draft; incoming snapshots never replace typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const state = useSyncExternalStore(draft.subscribe, draft.getState, draft.getState);
  useEffect(() => {
    draft.schedule();
    const flush = () => { void draft.flush(); };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('online', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('online', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      void draft.flush().then(saved => {
        if (saved && !draft.hasSubscribers() && drafts.get(key) === draft) drafts.delete(key);
      });
    };
  }, [draft, key]);
  return { ...state, setText: draft.setText, flush: draft.flush };
}

export function CallNotesField({ draft }) {
  const id = useId();
  const status = draft.status === 'saved' ? 'Saved to call history'
    : draft.status === 'error' ? 'Notes not saved — retry below' : 'Saving…';
  return <section className="outbound-call-notes">
    <div className="outbound-call-notes-head">
      <label htmlFor={id}>Call notes</label>
      <small role="status" aria-live="polite">{status}</small>
    </div>
    <textarea id={id} value={draft.text} maxLength={2000} rows={4}
      onChange={event => draft.setText(event.target.value)} onBlur={() => { void draft.flush(); }}
      placeholder="Who you spoke with, what they need, and what to follow up on…" />
    <div className="outbound-call-notes-hint"><span>Saved with this call, even after it ends.</span><span>{draft.text.length}/2,000</span></div>
    {draft.error && <div className="admin-error" role="alert">
      {draft.error} <button className="btn-admin" type="button" onClick={() => { void draft.flush(); }}>Retry saving notes</button>
    </div>}
  </section>;
}

export default function CallNotesEditor({ call }) {
  const draft = useCallNotes(call);
  return <CallNotesField draft={draft} />;
}
