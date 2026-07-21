// Lazy Firestore access for the marketing page.
//
// Firestore plus the Firebase app shell is the single largest thing in the
// bundle, and nothing the marketing page does at startup needs it: analytics
// does not flush for four seconds, and leads and transcripts only exist once a
// visitor actually interacts with something. Reaching it through a dynamic
// import keeps that parse and compile work off the main thread while the page
// is still painting, which is where the first stall was coming from.
//
// This module deliberately has no static `firebase/*` import — one anywhere in
// the graph reachable from main.jsx would pull the whole SDK back into the entry
// chunk. The admin dashboard still imports ./firebase directly; it is a lazily
// loaded route of its own, so it has nothing left to gain by deferring further.

let pending = null;

/** Resolves to the Firestore SDK namespace plus the shared `db` handle. */
export function firestore() {
  pending ||= Promise.all([import('firebase/firestore'), import('./firebase')])
    .then(([sdk, { db }]) => ({ sdk, db }));
  return pending;
}

/**
 * Starts the download without waiting on it, so that a visitor who leaves within
 * the first few seconds still has an SDK ready to flush their page view with.
 */
export function warmFirestore() {
  const start = () => { firestore().catch(() => {}); };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(start, { timeout: 2500 });
  else window.setTimeout(start, 1200);
}
