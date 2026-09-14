// Each draft owns one call ID. Requests are serialized so an older save can
// never arrive last and replace newer text, even when dialing moves on.
export function createCallNotesDraft({ callId, initialText = '', save, storage, delay = 700 }) {
  const key = `bitesites-call-notes:${callId}`;
  let local = null;
  try { local = storage?.getItem(key); } catch { /* Storage may be unavailable. */ }
  let saved = initialText;
  let state = { text: local ?? initialText, status: local !== null && local !== initialText ? 'pending' : 'saved', error: '' };
  let timer, inFlight;
  const listeners = new Set();
  const publish = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const cache = text => { try { storage?.setItem(key, text); } catch { /* Server save still works. */ } };

  function flush() {
    clearTimeout(timer);
    if (inFlight) return inFlight;
    if (state.text === saved) {
      try { storage?.removeItem(key); } catch { /* Optional backup. */ }
      publish({ status: 'saved', error: '' }); return Promise.resolve(true);
    }
    inFlight = (async () => {
      while (state.text !== saved) {
        const text = state.text;
        publish({ status: 'saving', error: '' });
        try { await save(callId, text); }
        catch (error) {
          publish({ status: 'error', error: error?.message || 'Could not save notes. Please retry.' });
          return false;
        }
        saved = text;
      }
      try { storage?.removeItem(key); } catch { /* Keep the server copy. */ }
      publish({ status: 'saved', error: '' });
      return true;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule() {
    clearTimeout(timer);
    if (state.text !== saved) timer = setTimeout(flush, delay);
  }

  return {
    getState: () => state,
    hasSubscribers: () => listeners.size > 0,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setText(text) {
      cache(text);
      publish({ text, status: 'pending', error: '' });
      schedule();
    },
    schedule,
    flush
  };
}
