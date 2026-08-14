// Twilio Programmable Voice adapter with an explicit Hybrid Dialer V2 mode.
//
// Legacy callers retain the old ApplicationSid/status-callback behavior. Hybrid
// V2 callers opt in with `hybridV2: true`, which routes each PSTN leg into its
// own conference and sends AMD/status events to the V2 orchestration endpoint.
// This keeps the existing mock/power/parallel test surface stable while the new
// UI uses the conference-capable path.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { CallingProviderAdapter, callEvent } from './adapter.js';
import { clean } from '../../prospect-normalization.js';

const API_BASE = 'https://api.twilio.com/2010-04-01';

export class HybridTwilioError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

export class HybridTwilioDialer extends CallingProviderAdapter {
  static id = 'twilio';
  static label = 'Twilio Programmable Voice';
  static requiredSecrets = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_TWIML_APP_SID'];

  static capabilities = {
    programmaticOutboundCall: true,
    aiAgentCall: false,
    powerDial: true,
    parallelDial: true,
    maxConcurrency: 5,
    perLegCallIds: true,
    humanAnswerDetection: true,
    cancelCallLeg: true,
    browserAudio: true,
    signedWebhooks: true,
    recordings: true,
    dispositions: true,
    conferenceControl: true,
    listenOnly: true,
    attachAI: true,
    detachAI: true,
    hybridOrchestration: true
  };

  static limitations = [
    'Live carrier behavior still requires verification with a configured Twilio account and controlled test numbers.',
    'AMD is probabilistic and can add answer latency.',
    'Hybrid AI media attachment is handled by the BiteSites media runtime, not by this carrier adapter.',
    'Hybrid browser audio additionally needs TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET.',
    'Caller-ID registration, STIR/SHAKEN attestation, consent and jurisdiction-specific calling rules remain deployment responsibilities.'
  ];

  constructor(config = {}) {
    super(config);
    this.accountSid = config.accountSid || '';
    this.authToken = config.authToken || '';
    this.twimlAppSid = config.twimlAppSid || '';
    this.apiKeySid = config.apiKeySid || '';
    this.apiKeySecret = config.apiKeySecret || '';
    this.statusCallbackUrl = config.statusCallbackUrl || '';
    this.hybridV2 = config.hybridV2 === true;
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
    if (!this.accountSid || !this.authToken) throw new HybridTwilioError('Twilio credentials are not configured');
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
      throw new HybridTwilioError(`Could not reach Twilio: ${String(error?.message || error).slice(0, 200)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = `Twilio returned HTTP ${response.status}`;
      try { detail = clean(JSON.parse(text)?.message, 360) || detail; } catch { /* status only */ }
      throw new HybridTwilioError(detail, response.status);
    }
    try { return JSON.parse(text); } catch { throw new HybridTwilioError('Twilio returned invalid JSON'); }
  }

  #hybridUrl(path, metadata = {}) {
    if (!this.statusCallbackUrl) return '';
    const origin = new URL(this.statusCallbackUrl).origin;
    const url = new URL(path, origin);
    // Firebase Hosting canonicalizes rewritten query strings by key. Twilio
    // signs the exact URL it was given, so generate that same canonical order
    // before Twilio calculates its signature.
    for (const [key, value] of Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  #callbackWithMetadata(metadata = {}) {
    if (!this.statusCallbackUrl) return '';
    const url = new URL(this.statusCallbackUrl);
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  #metadata({ target, campaign, sessionId, legIndex }) {
    return {
      campaignId: clean(target.campaignId || campaign.id, 160),
      targetId: clean(target.id, 160),
      sessionId: clean(sessionId, 160),
      ...(Number.isInteger(legIndex) ? { legIndex } : {})
    };
  }

  #callParams({ target, campaign, sessionId, legIndex }) {
    const metadata = this.#metadata({ target, campaign, sessionId, legIndex });

    if (!this.hybridV2) {
      const callback = this.#callbackWithMetadata(metadata);
      const params = {
        To: target.phoneE164,
        From: campaign.callerId,
        ApplicationSid: this.twimlAppSid,
        MachineDetection: 'DetectMessageEnd',
        MachineDetectionTimeout: '15',
        AsyncAmd: 'true',
        Timeout: '25',
        StatusCallbackEvent: 'initiated ringing answered completed',
        StatusCallbackMethod: 'POST'
      };
      if (callback) {
        params.StatusCallback = callback;
        params.AsyncAmdStatusCallback = callback;
        params.AsyncAmdStatusCallbackMethod = 'POST';
      }
      if (campaign.recordCalls !== false) {
        params.Record = 'true';
        params.RecordingStatusCallback = callback;
      }
      return params;
    }

    const prospectTwiml = this.#hybridUrl('/api/twilio-prospect-twiml', metadata);
    const statusCallback = this.#hybridUrl('/api/hybrid-outbound-events', metadata);
    if (!prospectTwiml || !statusCallback) throw new HybridTwilioError('Hybrid callback URLs are not configured');

    const params = {
      To: target.phoneE164,
      From: campaign.callerId,
      Url: prospectTwiml,
      Method: 'POST',
      MachineDetection: 'DetectMessageEnd',
      MachineDetectionTimeout: '15',
      AsyncAmd: 'true',
      AsyncAmdStatusCallback: statusCallback,
      AsyncAmdStatusCallbackMethod: 'POST',
      Timeout: '25',
      StatusCallback: statusCallback,
      StatusCallbackEvent: 'initiated ringing answered completed',
      StatusCallbackMethod: 'POST'
    };
    if (campaign.recordCalls !== false) {
      params.Record = 'true';
      params.RecordingStatusCallback = statusCallback;
      params.RecordingStatusCallbackMethod = 'POST';
    }
    return params;
  }

  async startPowerDialSession({ targets, campaign, sessionId }) {
    const target = targets[0];
    if (!target) throw new HybridTwilioError('Power dial needs exactly one target');
    const created = await this.#post('/Calls.json', this.#callParams({ target, campaign, sessionId, legIndex: 0 }));
    return { legs: [{ targetId: target.id, providerCallId: created.sid }] };
  }

  async startParallelDialSession({ targets, campaign, sessionId, concurrency }) {
    const limit = Math.max(1, Math.min(5, Number(concurrency) || 1));
    if (targets.length > limit) throw new HybridTwilioError(`Parallel session asked for ${targets.length} legs above concurrency ${limit}`);
    const legs = [];
    try {
      for (const [legIndex, target] of targets.entries()) {
        const created = await this.#post('/Calls.json', this.#callParams({ target, campaign, sessionId, legIndex }));
        legs.push({ targetId: target.id, providerCallId: created.sid });
      }
    } catch (error) {
      for (const leg of legs) await this.cancelCallLeg(leg.providerCallId, 'session_start_failed').catch(() => {});
      throw error;
    }
    return { legs };
  }

  async cancelCallLeg(providerCallId, reason = 'operator_cancelled') {
    if (!providerCallId) return { cancelled: false, reason: 'missing_call_id' };
    try {
      await this.#post(`/Calls/${encodeURIComponent(providerCallId)}.json`, { Status: 'canceled' });
      return { cancelled: true, reason };
    } catch (error) {
      if (error.status === 404) return { cancelled: false, reason: 'unknown_call' };
      if (error.status === 400) return { cancelled: false, reason: 'already_terminal' };
      throw error;
    }
  }

  async endCall(providerCallId) {
    if (!providerCallId) return { ended: false, reason: 'missing_call_id' };
    try {
      await this.#post(`/Calls/${encodeURIComponent(providerCallId)}.json`, { Status: 'completed' });
      return { ended: true };
    } catch (error) {
      if (error.status === 404) return { ended: false, reason: 'unknown_call' };
      if (error.status === 400) return { ended: false, reason: 'already_terminal' };
      throw error;
    }
  }

  async redirectCall(providerCallId, url) {
    if (!providerCallId || !url) throw new HybridTwilioError('Call id and redirect URL are required');
    await this.#post(`/Calls/${encodeURIComponent(providerCallId)}.json`, { Url: url, Method: 'POST' });
    return { redirected: true };
  }

  async updateConferenceParticipant(conferenceSid, participantSid, fields = {}) {
    if (!conferenceSid || !participantSid) throw new HybridTwilioError('Conference and participant SIDs are required');
    const params = {};
    if (typeof fields.muted === 'boolean') params.Muted = fields.muted ? 'true' : 'false';
    if (typeof fields.hold === 'boolean') params.Hold = fields.hold ? 'true' : 'false';
    if (!Object.keys(params).length) return { updated: false };
    await this.#post(`/Conferences/${encodeURIComponent(conferenceSid)}/Participants/${encodeURIComponent(participantSid)}.json`, params);
    return { updated: true };
  }

  async removeConferenceParticipant(conferenceSid, participantSid) {
    if (!conferenceSid || !participantSid) return { removed: false };
    await this.#post(`/Conferences/${encodeURIComponent(conferenceSid)}/Participants/${encodeURIComponent(participantSid)}.json`, { Status: 'completed' });
    return { removed: true };
  }

  async getCallStatus(providerCallId) {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const response = await this.fetchImpl(
      `${API_BASE}/Accounts/${this.accountSid}/Calls/${encodeURIComponent(providerCallId)}.json`,
      { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
    );
    if (!response.ok) throw new HybridTwilioError(`Twilio returned HTTP ${response.status}`, response.status);
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

    // Legacy outbound uses a non-empty status callback URL and historically
    // treated carrier completion as a connected disposition. Hybrid V2's
    // webhook normalizer is instantiated without a callback URL because the
    // callback already arrived at the V2 endpoint; in that path completion must
    // not invent `connected`, especially after AMD classified voicemail.
    const legacyCompletedConnection = type === 'completed' && Boolean(this.statusCallbackUrl);
    const disposition = type === 'human_answered' || legacyCompletedConnection ? 'connected'
      : type === 'machine_answered' ? 'voicemail'
        : ['busy', 'no_answer', 'failed', 'cancelled'].includes(type) ? type : '';

    return callEvent({
      type,
      providerCallId: sid,
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

  verifyWebhook(req, secret) {
    const token = secret || this.authToken;
    const signature = String(req?.get?.('x-twilio-signature') || '');
    if (!token || !signature) return false;
    const publicOrigin = process.env.PUBLIC_APP_URL || `${req.protocol || 'https'}://${req.get?.('host') || ''}`;
    let url;
    try {
      const original = req.originalUrl || req.url || '';
      url = original.startsWith('http') ? original : new URL(original, publicOrigin).toString();
    } catch { return false; }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const payload = Object.keys(body).sort().reduce((acc, key) => acc + key + body[key], url);
    const expected = createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
}
