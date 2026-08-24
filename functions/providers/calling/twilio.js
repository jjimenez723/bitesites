// Twilio Programmable Voice — the provider a BiteSites-controlled parallel
// dialer would actually run on.
//
// STATUS: implemented against the documented REST contract, NOT verified
// against a live account from this repository. No Twilio credentials exist
// here, no call has been placed, and the TwiML application that bridges a rep's
// browser to a winning leg has not been created. Treat every capability flag
// below as "documented and implemented" rather than "confirmed working"; the
// verification checklist is in OUTBOUND_CALLING_SETUP.md.
//
// Why it is here at all: §29 asks for the closest viable alternative when the
// preferred provider cannot expose enough control, and Twilio is the one that
// can. It is the only provider in this repository that gives BiteSites all
// four things the parallel state machine needs —
//
//   1. a per-leg call SID at creation time (`POST /Calls` returns it),
//   2. Answering Machine Detection (`MachineDetection=DetectMessageEnd`) so a
//      human answer is distinguishable from a greeting,
//   3. a documented cancel (`POST /Calls/{sid}` with `Status=canceled`) that
//      works while a leg is still queued or ringing,
//   4. request signature validation (`X-Twilio-Signature`) — a real signature,
//      not a shared header secret.
//
// The first-answer-wins transaction itself is NOT here. It lives in
// outbound-calls.js, server-side and provider-neutral, because it is a
// correctness property of BiteSites' own data — a provider adapter that decided
// the winner would put that property behind a vendor.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { CallingProviderAdapter, callEvent } from './adapter.js';
import { clean } from '../../prospect-normalization.js';

const API_BASE = 'https://api.twilio.com/2010-04-01';

export class TwilioError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

export class TwilioDialer extends CallingProviderAdapter {
  static id = 'twilio';
  static label = 'Twilio Programmable Voice';
  static requiredSecrets = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_TWIML_APP_SID'];

  static capabilities = {
    programmaticOutboundCall: true,
    aiAgentCall: false,          // Twilio carries audio; the agent is a separate product
    powerDial: true,
    parallelDial: true,
    maxConcurrency: 5,
    perLegCallIds: true,
    humanAnswerDetection: true,  // AMD
    cancelCallLeg: true,
    browserAudio: true,          // Voice SDK + a TwiML app
    signedWebhooks: true,        // X-Twilio-Signature
    recordings: true,
    dispositions: true
  };

  static limitations = [
    'Unverified against a live Twilio account from this repository — no call has been placed.',
    'Requires a TwiML application and a Voice SDK access-token endpoint before a rep can hear a call in the browser.',
    'AMD adds answer latency and is probabilistic; a machine can still be reported as a human.',
    'Caller-ID registration, A2P/STIR-SHAKEN attestation and per-state calling rules are account-level work outside this code.'
  ];

  constructor(config = {}) {
    super(config);
    this.accountSid = config.accountSid || '';
    this.authToken = config.authToken || '';
    this.twimlAppSid = config.twimlAppSid || '';
    this.statusCallbackUrl = config.statusCallbackUrl || '';
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
  }

  async healthCheck() {
    const missing = [];
    if (!this.accountSid) missing.push('TWILIO_ACCOUNT_SID');
    if (!this.authToken) missing.push('TWILIO_AUTH_TOKEN');
    if (!this.twimlAppSid) missing.push('TWILIO_TWIML_APP_SID');
    if (!this.statusCallbackUrl) missing.push('OUTBOUND_WEBHOOK_URL');
    return { ok: missing.length === 0, missing };
  }

  async #post(path, params) {
    if (!this.accountSid || !this.authToken) throw new TwilioError('Twilio credentials are not configured');
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    let response;
    try {
      response = await this.fetchImpl(`${API_BASE}/Accounts/${this.accountSid}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: new URLSearchParams(params).toString()
      });
    } catch (error) {
      throw new TwilioError(`Could not reach Twilio: ${String(error?.message || error).slice(0, 200)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = `Twilio returned HTTP ${response.status}`;
      try { detail = clean(JSON.parse(text)?.message, 360) || detail; } catch { /* status only */ }
      throw new TwilioError(detail, response.status);
    }
    try { return JSON.parse(text); } catch { throw new TwilioError('Twilio returned an invalid JSON response'); }
  }

  #callParams({ target, campaign, sessionId, legIndex }) {
    const params = {
      To: target.phoneE164,
      From: campaign.callerId,
      ApplicationSid: this.twimlAppSid,
      // AMD is what turns "answered" into "a human answered". Without it the
      // parallel dialer bridges the rep to whichever voicemail picked up first.
      MachineDetection: 'DetectMessageEnd',
      MachineDetectionTimeout: '15',
      AsyncAmd: 'true',
      Timeout: '25',
      TimeLimit: '600',
      StatusCallbackEvent: 'initiated ringing answered completed',
      StatusCallbackMethod: 'POST'
    };
    if (this.statusCallbackUrl) {
      // Identity rides in the callback URL so a redelivered status carries the
      // BiteSites records with it — Twilio echoes the URL, not our metadata.
      const url = new URL(this.statusCallbackUrl);
      url.searchParams.set('campaignId', clean(target.campaignId || campaign.id, 160));
      url.searchParams.set('targetId', clean(target.id, 160));
      if (sessionId) url.searchParams.set('sessionId', clean(sessionId, 160));
      if (Number.isInteger(legIndex)) url.searchParams.set('legIndex', String(legIndex));
      params.StatusCallback = url.toString();
      params.AsyncAmdStatusCallback = url.toString();
    }
    // Recording cannot begin on the outbound create request: consent to the
    // call and consent to persist audio are separate permissions, and nobody
    // has answered this call yet. A later consent-gated command owns starting
    // recording; absent that command this provider deliberately records none.
    return params;
  }

  async startPowerDialSession({ targets, campaign, sessionId }) {
    const target = targets[0];
    if (!target) throw new TwilioError('Power dial needs exactly one target');
    const call = await this.#post('/Calls.json', this.#callParams({ target, campaign, sessionId, legIndex: 0 }));
    return { legs: [{ targetId: target.id, providerCallId: call.sid }] };
  }

  async startParallelDialSession({ targets, campaign, sessionId, concurrency }) {
    const limit = Math.max(1, Math.min(5, Number(concurrency) || 1));
    if (targets.length > limit) throw new TwilioError(`Parallel session asked for ${targets.length} legs above concurrency ${limit}`);

    // Sequential rather than Promise.all: a partial failure has to leave a
    // known set of live legs to cancel. Firing five and losing track of which
    // three started is how a prospect gets a call nobody is on the other end of.
    const legs = [];
    try {
      for (const [legIndex, target] of targets.entries()) {
        const call = await this.#post('/Calls.json', this.#callParams({ target, campaign, sessionId, legIndex }));
        legs.push({ targetId: target.id, providerCallId: call.sid });
      }
    } catch (error) {
      for (const leg of legs) {
        await this.cancelCallLeg(leg.providerCallId, 'session_start_failed').catch(() => {});
      }
      throw error;
    }
    return { legs };
  }

  async cancelCallLeg(providerCallId, reason = 'another_call_connected') {
    if (!providerCallId) return { cancelled: false, reason: 'missing_call_id' };
    try {
      // `canceled` only applies while queued/ringing; an in-progress call has
      // to be `completed` instead. Trying cancel first is correct — the loser
      // legs we want to drop are, by definition, still ringing.
      await this.#post(`/Calls/${encodeURIComponent(providerCallId)}.json`, { Status: 'canceled' });
      return { cancelled: true, reason };
    } catch (error) {
      if (error.status === 404) return { cancelled: false, reason: 'unknown_call' };
      // A 400 here usually means the leg already ended by itself.
      if (error.status === 400) return { cancelled: false, reason: 'already_terminal' };
      throw error;
    }
  }

  async endCall(providerCallId) {
    await this.#post(`/Calls/${encodeURIComponent(providerCallId)}.json`, { Status: 'completed' });
    return { ended: true };
  }

  async getCallStatus(providerCallId) {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const response = await this.fetchImpl(
      `${API_BASE}/Accounts/${this.accountSid}/Calls/${encodeURIComponent(providerCallId)}.json`,
      { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
    );
    if (!response.ok) throw new TwilioError(`Twilio returned HTTP ${response.status}`, response.status);
    const call = await response.json();
    return { status: call.status, durationSec: Number(call.duration) || 0 };
  }

  normalizeWebhookEvent(body = {}, headers = {}) {
    const sid = body.CallSid || body.call_sid;
    if (!sid) return null;

    const status = String(body.CallStatus || body.AmdStatus || '').toLowerCase();
    const amd = String(body.AnsweredBy || '').toLowerCase();

    let type = 'queued';
    if (amd === 'human') type = 'human_answered';
    else if (amd.startsWith('machine') || amd === 'fax') type = 'machine_answered';
    else if (status === 'ringing') type = 'ringing';
    else if (status === 'in-progress') type = 'answered';
    else if (status === 'completed') type = 'completed';
    else if (status === 'busy') type = 'busy';
    else if (status === 'no-answer') type = 'no_answer';
    else if (status === 'canceled') type = 'cancelled';
    else if (status === 'failed') type = 'failed';
    else if (status === 'initiated' || status === 'queued') type = 'dialing';

    const disposition = type === 'human_answered' || type === 'completed' ? 'connected'
      : type === 'machine_answered' ? 'voicemail'
        : ['busy', 'no_answer', 'failed', 'cancelled'].includes(type) ? type : '';

    return callEvent({
      type,
      providerCallId: sid,
      // Twilio echoes the StatusCallback query string, so identity survives a
      // redelivery even though Twilio itself knows nothing about our records.
      targetId: headers.targetId || body.targetId || '',
      campaignId: headers.campaignId || body.campaignId || '',
      sessionId: headers.sessionId || body.sessionId || '',
      status: status || type,
      disposition,
      durationSec: body.CallDuration ?? body.RecordingDuration,
      recordingUrl: body.RecordingUrl ? `${body.RecordingUrl}.mp3` : '',
      at: new Date()
    });
  }

  /**
   * Twilio's documented request signature: HMAC-SHA1 over the full URL with the
   * POST parameters appended in sorted key order, base64-encoded, keyed by the
   * auth token. Real signature verification — not a shared header.
   */
  verifyWebhook(req, secret) {
    const token = secret || this.authToken;
    const signature = String(req?.get?.('x-twilio-signature') || '');
    if (!token || !signature) return false;

    const url = req.originalUrl?.startsWith('http')
      ? req.originalUrl
      : `${req.protocol || 'https'}://${req.get?.('host') || ''}${req.originalUrl || req.url || ''}`;

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const payload = Object.keys(body).sort().reduce((acc, key) => acc + key + body[key], url);
    const expected = createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');

    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
}
