// The interface every calling provider implements.
//
// Own module for the same reason as the lead-source base class: the registry
// imports the adapters and the adapters extend this, so co-locating them makes
// an import cycle that fails at deploy time.
//
// The shape of the contract is the important part. Everything above this layer
// — the AI campaign runner, the power dialer, the parallel dialer, the queue,
// the webhook handler — deals in *normalised* events:
//
//   { type, providerCallId, targetId, campaignId, sessionId, status,
//     disposition, durationSec, recordingUrl, transcript, at, raw? }
//
// so that no part of BiteSites depends on a Kixie, HighLevel or Twilio payload.
// A provider that cannot produce a given event says so through `capabilities`
// rather than faking it — a dialer that pretends it can detect a human answer
// is a dialer that connects a rep to a voicemail greeting.

export const CALL_EVENT_TYPES = [
  'queued', 'dialing', 'ringing', 'answered', 'human_answered', 'machine_answered',
  'voicemail', 'busy', 'no_answer', 'failed', 'cancelled', 'completed', 'disposition'
];

export const CALL_DISPOSITIONS = [
  'connected', 'not_interested', 'call_later', 'wrong_number', 'no_answer',
  'voicemail', 'busy', 'do_not_call', 'booked_meeting', 'qualified',
  'invalid_number', 'failed', 'cancelled'
];

export class CallingProviderAdapter {
  static id = 'abstract';
  static label = 'Abstract calling provider';
  static requiredSecrets = [];

  /**
   * What this provider can actually do, verified against its documentation.
   * Every flag defaults to false: an unverified capability must never read as
   * supported, because the parallel dialer's safety depends on `cancelCallLeg`
   * and `humanAnswerDetection` being real.
   */
  static capabilities = {
    programmaticOutboundCall: false,
    aiAgentCall: false,
    powerDial: false,
    parallelDial: false,
    maxConcurrency: 1,
    perLegCallIds: false,
    humanAnswerDetection: false,
    cancelCallLeg: false,
    browserAudio: false,
    signedWebhooks: false,
    recordings: false,
    dispositions: false
  };

  constructor(config = {}) { this.config = config; }

  /** `{ ok, missing: [] }` — never throws, so the UI can render a status badge. */
  // eslint-disable-next-line class-methods-use-this
  async healthCheck() { return { ok: false, missing: ['not implemented'] }; }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async startAICall(request) { throw new Error('startAICall is not supported by this provider'); }
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async startPowerDialSession(request) { throw new Error('startPowerDialSession is not supported by this provider'); }
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async startParallelDialSession(request) { throw new Error('startParallelDialSession is not supported by this provider'); }
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async cancelCallLeg(providerCallId, reason) { throw new Error('cancelCallLeg is not supported by this provider'); }
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async endCall(providerCallId) { throw new Error('endCall is not supported by this provider'); }
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async getCallStatus(providerCallId) { throw new Error('getCallStatus is not supported by this provider'); }

  /** Raw provider webhook body -> normalised event, or null if unrecognised. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  normalizeWebhookEvent(body, headers) { return null; }

  /** Constant-time-ish shared-secret / signature check. Fails closed. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  verifyWebhook(req, secret) { return false; }
}

/** A single place to build the normalised event, so every adapter agrees. */
export function callEvent({
  type,
  providerCallId = '',
  targetId = '',
  campaignId = '',
  sessionId = '',
  status = '',
  disposition = '',
  durationSec = null,
  recordingUrl = '',
  transcript = [],
  at = new Date(),
  providerContactId = '',
  errorMessage = ''
}) {
  return {
    type: CALL_EVENT_TYPES.includes(type) ? type : 'failed',
    providerCallId: String(providerCallId || '').slice(0, 200),
    targetId: String(targetId || '').slice(0, 200),
    campaignId: String(campaignId || '').slice(0, 200),
    sessionId: String(sessionId || '').slice(0, 200),
    status: String(status || '').slice(0, 60),
    disposition: CALL_DISPOSITIONS.includes(disposition) ? disposition : '',
    durationSec: Number.isFinite(Number(durationSec)) ? Math.max(0, Math.trunc(Number(durationSec))) : null,
    // Only https recordings are stored. A provider that hands back an http or
    // relative URL is handing back something we would then render as a link.
    recordingUrl: /^https:\/\//.test(recordingUrl || '') ? String(recordingUrl).slice(0, 1000) : '',
    transcript: Array.isArray(transcript) ? transcript.slice(0, 400) : [],
    providerContactId: String(providerContactId || '').slice(0, 200),
    errorMessage: String(errorMessage || '').replace(/\s+/g, ' ').slice(0, 400),
    at: at instanceof Date ? at : new Date()
  };
}

/**
 * Deterministic event id, so a provider redelivery is a no-op.
 * Every webhook handler writes through this — timestamp-based ids would make
 * the second delivery a second call record.
 */
export const eventId = (provider, providerCallId, type, at) =>
  `${provider}_${String(providerCallId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}_${type}_${Math.floor(new Date(at || Date.now()).getTime() / 1000)}`;
