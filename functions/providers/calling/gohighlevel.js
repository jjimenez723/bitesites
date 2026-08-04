// GoHighLevel — outbound Voice AI through a published workflow.
//
// The existing BiteSites GHL integration is INBOUND: `syncLeadToGoHighLevel`
// posts new leads to an inbound webhook, `recordVoiceCall` receives completed
// browser-widget calls, and `pollVoiceCalls` imports the call log. None of
// those can start a call, and §30 is explicit that the call-log endpoint must
// not be assumed to.
//
// What GoHighLevel does expose, and what the BiteSites-Leads fork already uses
// in production (functions/highlevel.py in ~/Dialer), is:
//
//   POST /contacts/upsert                              -> create/update contact
//   POST /contacts/{contactId}/workflow/{workflowId}   -> enrol in a workflow
//
// If that published workflow's first action is a Voice AI outbound call, the
// enrolment starts the call. That is the mechanism, and it has consequences the
// rest of the stack has to respect:
//
//   * The WORKFLOW owns timing, retries, concurrency and the agent prompt. We
//     hand over a contact and lose control until an event comes back.
//   * There is no per-leg call id at enrolment time, so `providerCallId` is
//     empty until the completed-call webhook arrives.
//   * There is nothing to cancel. Once enrolled, the workflow runs.
//
// Hence `parallelDial: false`. The brief's parallel dialer needs to cancel
// losing legs; a provider that cannot cancel cannot safely run one.
//
// DND is honoured before enrolment — the contact's `dnd`/`dndSettings` are the
// customer's own opt-out and outrank any campaign setting.

import { timingSafeEqual } from 'node:crypto';
import { CallingProviderAdapter, callEvent } from './adapter.js';
import { clean, normalizePhone } from '../../prospect-normalization.js';

const BASE_URL = 'https://services.leadconnectorhq.com';
const CONTACTS_VERSION = '2021-07-28';

export class GoHighLevelError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

export class GoHighLevelDialer extends CallingProviderAdapter {
  static id = 'gohighlevel';
  static label = 'GoHighLevel Voice AI (workflow enrolment)';
  static requiredSecrets = ['GHL_API_TOKEN', 'GHL_OUTBOUND_AGENT_ID'];

  static capabilities = {
    programmaticOutboundCall: true,   // indirectly, via workflow enrolment
    aiAgentCall: true,
    powerDial: false,                 // no browser audio for a human rep
    parallelDial: false,
    maxConcurrency: 1,
    perLegCallIds: false,             // not until the completion event
    humanAnswerDetection: false,
    cancelCallLeg: false,
    browserAudio: false,
    signedWebhooks: false,            // shared secret, as recordVoiceCall already uses
    recordings: true,
    dispositions: true
  };

  static limitations = [
    'Calls start by enrolling a contact in a published workflow — the workflow, not BiteSites, owns timing, retries and the agent prompt.',
    'No call id is returned at enrolment; outbound calls are matched later by contact id plus campaign/target metadata.',
    'An enrolled contact cannot be pulled back out, so there is no leg cancellation and no parallel dialing.',
    'Outbound Voice AI availability, KYC and A2P registration must be confirmed in the target sub-account before use.'
  ];

  constructor(config = {}) {
    super(config);
    this.token = config.token || '';
    this.locationId = config.locationId || '';
    this.workflowId = config.workflowId || '';
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
  }

  async healthCheck() {
    const missing = [];
    if (!this.token) missing.push('GHL_API_TOKEN');
    if (!this.locationId) missing.push('GHL_LOCATION_ID');
    if (!this.workflowId) missing.push('GHL_OUTBOUND_WORKFLOW_ID');
    return { ok: missing.length === 0, missing };
  }

  async #request(method, path, payload, version = CONTACTS_VERSION) {
    if (!this.token) throw new GoHighLevelError('GHL_API_TOKEN is not configured');
    let response;
    try {
      response = await this.fetchImpl(BASE_URL + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          Version: version,
          ...(payload ? { 'Content-Type': 'application/json' } : {})
        },
        body: payload ? JSON.stringify(payload) : undefined
      });
    } catch (error) {
      throw new GoHighLevelError(`Could not reach GoHighLevel: ${String(error?.message || error).slice(0, 200)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = `GoHighLevel returned HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        const message = Array.isArray(parsed?.message) ? parsed.message.join('; ') : parsed?.message;
        if (message) detail = String(message).replace(/\s+/g, ' ').slice(0, 360);
      } catch { /* keep the status-only message */ }
      throw new GoHighLevelError(detail, response.status);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new GoHighLevelError('GoHighLevel returned an invalid JSON response'); }
  }

  /** The customer's own opt-out, global or per-channel. Outranks everything. */
  static contactIsDnd(contact = {}) {
    if (contact.dnd === true) return true;
    const settings = contact.dndSettings;
    if (!settings || typeof settings !== 'object') return false;
    return ['Call', 'SMS', 'all'].some(key =>
      String(settings[key]?.status || '').toLowerCase() === 'active');
  }

  async upsertContact({ contact, target, campaign }) {
    const phone = target.phoneE164 || normalizePhone(contact.phone);
    if (!phone) throw new GoHighLevelError('Target has no dialable phone number');

    const payload = {
      locationId: this.locationId,
      phone,
      source: 'BiteSites outbound',
      country: 'US',
      createNewIfDuplicateAllowed: false,
      // Campaign/target metadata rides along so the completion webhook can be
      // matched deterministically rather than by timestamp proximity (§35).
      customFields: [
        { key: 'bitesites_campaign_id', field_value: clean(target.campaignId || campaign?.id, 160) },
        { key: 'bitesites_target_id', field_value: clean(target.id, 160) },
        { key: 'bitesites_contact_type', field_value: clean(target.contactType, 20) }
      ]
    };
    const name = clean(contact.companyName || contact.name, 120);
    if (name) { payload.name = name; payload.companyName = name; }
    if (contact.firstName) payload.firstName = clean(contact.firstName, 80);
    if (contact.lastName) payload.lastName = clean(contact.lastName, 80);
    if (contact.email) payload.email = clean(contact.email, 254);
    if (contact.website) payload.website = clean(contact.website, 500);

    const response = await this.#request('POST', '/contacts/upsert', payload);
    const contactId = response?.contact?.id;
    if (!contactId) throw new GoHighLevelError('GoHighLevel upsert returned no contact ID');
    return { contactId, contact: response.contact };
  }

  async startAICall({ target, contact, campaign, brief }) {
    if (!this.workflowId) throw new GoHighLevelError('GHL_OUTBOUND_WORKFLOW_ID is not configured');

    const { contactId, contact: remote } = await this.upsertContact({ contact, target, campaign });
    if (GoHighLevelDialer.contactIsDnd(remote)) {
      throw new GoHighLevelError('GoHighLevel reports this contact as do-not-disturb');
    }

    // The brief goes to the workflow as a note on the enrolment request. GHL's
    // workflow builder is where the Voice AI prompt lives, so BiteSites can
    // supply context but cannot override the agent's instructions — that
    // asymmetry is why requireResearchApproval matters for this provider.
    await this.#request('POST', `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(this.workflowId)}`, {
      eventStartTime: new Date().toISOString(),
      bitesites: {
        campaignId: clean(target.campaignId || campaign?.id, 160),
        targetId: clean(target.id, 160),
        objective: clean(brief?.objective, 500),
        summary: clean(brief?.summary, 1500),
        disclosures: (brief?.disclosures || []).slice(0, 5)
      }
    });

    return {
      // Empty on purpose: GHL has not created a call yet. The webhook supplies
      // the real id, and `providerContactId` is how we find this record then.
      providerCallId: '',
      providerContactId: contactId,
      requiresWorkflow: true
    };
  }

  /**
   * GoHighLevel completed-call payloads, normalised.
   *
   * The existing `recordVoiceCall` function keeps owning INBOUND browser-widget
   * calls; this path only interprets a payload that carries BiteSites campaign
   * metadata, so the two cannot fight over the same event.
   */
  normalizeWebhookEvent(body) {
    if (!body || typeof body !== 'object') return null;
    const custom = body.customData || body.custom_data || body.customFields || {};
    const campaignId = clean(custom.bitesites_campaign_id || body.bitesites_campaign_id, 160);
    const targetId = clean(custom.bitesites_target_id || body.bitesites_target_id, 160);
    if (!campaignId && !targetId) return null;   // an inbound call — not ours

    const status = String(body.callStatus || body.status || '').toLowerCase();
    const type = status.includes('answer') || status === 'completed' ? 'completed'
      : status.includes('voicemail') ? 'voicemail'
        : status.includes('busy') ? 'busy'
          : status.includes('noanswer') || status.includes('no-answer') ? 'no_answer'
            : status.includes('fail') ? 'failed' : 'completed';

    const outcome = String(body.outcome || body.disposition || '').toLowerCase();
    const disposition = outcome.includes('book') || outcome.includes('appointment') ? 'booked_meeting'
      : outcome.includes('not') && outcome.includes('interest') ? 'not_interested'
        : outcome.includes('callback') || outcome.includes('later') ? 'call_later'
          : type === 'voicemail' ? 'voicemail'
            : type === 'completed' ? 'connected' : type === 'failed' ? 'failed' : type;

    return callEvent({
      type,
      providerCallId: body.callId || body.call_id || body.messageId || '',
      providerContactId: body.contactId || body.contact_id || '',
      targetId,
      campaignId,
      status: status || type,
      disposition,
      durationSec: body.duration ?? body.callDuration,
      recordingUrl: body.recordingUrl || body.recording_url || '',
      transcript: Array.isArray(body.transcript) ? body.transcript : [],
      at: body.endedAt ? new Date(body.endedAt) : new Date()
    });
  }

  verifyWebhook(req, secret) {
    if (!secret || secret.length < 16 || secret === 'unset') return false;
    const provided = String(req?.get?.('x-webhook-secret') || req?.get?.('x-outbound-secret') || '');
    if (provided.length !== secret.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  }
}
