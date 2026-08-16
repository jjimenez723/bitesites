// Keeping the Realtime sideband warm for exactly as long as it could be needed.
//
// The sideband is attached late by design. Its media job is only written once a
// prospect has picked up and Twilio has verified a human answer — see the
// `human_answered` branch in hybrid-dialer-api.js — so the whole attach chain
// runs while a real person is already holding a live handset. Container start
// time there is not latency, it is silence after someone says "Hello?".
//
// The service used to be pinned with minScale=1, which bought that readiness at
// the price of a 1-vCPU container billed every second of every day, including
// nights and weekends, to stay ready for calls that can only happen while a rep
// has the dialer open.
//
// The dialer already announces itself. A session heartbeats every 45 seconds
// for its whole life, starting the moment a rep opens the dialer — minutes
// before the first prospect ever answers. Warming from that signal keeps the
// instance up across exactly the window where a call is possible, and lets the
// service scale to zero the rest of the time.
//
// Everything here is best-effort. A warm-up that fails, times out, or is
// misconfigured must cost nothing but a cold start; it must never fail a
// heartbeat, delay a dial, or surface an error to a rep.

const DEFAULT_SIDEBAND_URL = 'https://bitesites-realtime-sideband-pjcms3h6aq-uc.a.run.app';

// Long enough to reach Cloud Run and trigger a cold start, short enough that a
// hung sideband cannot noticeably slow the heartbeat that carries this.
const WARM_TIMEOUT_MS = 2000;

/** Operating modes that can hand a live call to the AI, and so need the sideband. */
const AI_CAPABLE_OPERATING_MODES = new Set(['ai', 'hybrid']);

export const sidebandHealthUrl = (base = process.env.SIDEBAND_URL) => {
  const origin = String(base || DEFAULT_SIDEBAND_URL).trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s]+$/.test(origin) ? `${origin}/health` : '';
};

/**
 * Does this session need a warm sideband?
 *
 * Both writers of a session record state this positively, so the check can be
 * exact rather than defensive: startHybridDialerSession always writes an
 * `operatingMode`, and the autonomous runner in runAICampaignSlice always
 * writes `mode: 'ai'` on the synthetic `ai_<campaignId>` session it dials
 * under. Anything asserting neither is a legacy human dialer.
 *
 * Defaulting the unknown case to "warm anyway" would be the expensive mistake
 * rather than the safe one: a human-only power-dialing session would then hold
 * a container alive for its whole length to serve an AI that is never attached
 * — which is the bill this whole change exists to remove.
 */
export function sessionNeedsSideband(session) {
  if (!session || session.status === 'ended' || session.status === 'stopped') return false;
  const operatingMode = typeof session.operatingMode === 'string' ? session.operatingMode.trim() : '';
  if (operatingMode) return AI_CAPABLE_OPERATING_MODES.has(operatingMode);
  const mode = typeof session.mode === 'string' ? session.mode.trim() : '';
  return mode === 'ai';
}

/**
 * Nudge the sideband so an instance exists before a call needs one.
 *
 * Awaited rather than left dangling: a Cloud Functions instance can be frozen
 * as soon as it responds, and a promise that never settles is a warm-up that
 * never happened. The wait is bounded and swallowed, so the worst case is that
 * the heartbeat takes an extra couple of seconds in the background.
 *
 * Returns what it did, for tests and logs — never throws.
 */
export async function warmSideband({ fetchImpl = fetch, url = sidebandHealthUrl() } = {}) {
  // A run pointed at the Firestore emulator is a test or a local rehearsal, and
  // must not reach across to the deployed sideband — both because a test suite
  // that quietly spins up production infrastructure is a bad test suite, and
  // because it would bill for an instance nobody asked for.
  if (process.env.FIRESTORE_EMULATOR_HOST) return { warmed: false, reason: 'emulated' };
  if (!url) return { warmed: false, reason: 'not_configured' };
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(WARM_TIMEOUT_MS)
    });
    return { warmed: response.ok, reason: response.ok ? '' : `status_${response.status}` };
  } catch (error) {
    // A cold start that outruns the timeout still counts: the request reached
    // Cloud Run, which is the only part that matters for scheduling an instance.
    return { warmed: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

/** Warm the sideband for a session, if that session could ever need it. */
export async function warmSidebandForSession(session, options = {}) {
  if (!sessionNeedsSideband(session)) return { warmed: false, reason: 'not_ai_capable' };
  return warmSideband(options);
}
