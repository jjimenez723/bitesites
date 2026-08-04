// A dialer that never dials.
//
// This is the provider the entire outbound stack is developed and tested
// against, and the one a new campaign defaults to. It implements every
// capability — including parallel legs, human-answer detection and leg
// cancellation — so the first-answer-wins transaction, the cancel fan-out and
// the Call Later requeue are all exercised without a telephone network.
//
// It is deterministic: an outcome is derived from a hash of the destination
// number and the leg index, so a test can pin "leg 2 answers, the rest are
// cancelled" without a clock or a random seed. `scriptedOutcomes` overrides it
// entirely when a test wants to force simultaneous answers.

import { createHash } from 'node:crypto';
import { CallingProviderAdapter, callEvent } from './adapter.js';

const OUTCOMES = ['human_answered', 'voicemail', 'no_answer', 'busy', 'machine_answered'];

const hashIndex = (value, modulo) =>
  parseInt(createHash('sha256').update(String(value)).digest('hex').slice(0, 8), 16) % modulo;

export class MockDialer extends CallingProviderAdapter {
  static id = 'mock';
  static label = 'Mock dialer (no telephone network)';
  static requiredSecrets = [];

  static capabilities = {
    programmaticOutboundCall: true,
    aiAgentCall: true,
    powerDial: true,
    parallelDial: true,
    maxConcurrency: 5,
    perLegCallIds: true,
    humanAnswerDetection: true,
    cancelCallLeg: true,
    browserAudio: true,
    signedWebhooks: true,
    recordings: true,
    dispositions: true
  };

  constructor(config = {}) {
    super(config);
    this.calls = new Map();
    this.scriptedOutcomes = config.scriptedOutcomes || null;
  }

  async healthCheck() { return { ok: true, missing: [] }; }

  #place({ target, campaignId, sessionId, legIndex = 0, operator }) {
    const providerCallId = `mock_${campaignId || 'c'}_${target.id}_${Date.now().toString(36)}_${legIndex}`;
    const outcome = this.scriptedOutcomes
      ? (this.scriptedOutcomes[legIndex] ?? this.scriptedOutcomes[target.id] ?? 'no_answer')
      : OUTCOMES[hashIndex(`${target.phoneE164}:${legIndex}`, OUTCOMES.length)];

    this.calls.set(providerCallId, {
      providerCallId, targetId: target.id, campaignId, sessionId, outcome,
      operator, status: 'dialing', startedAt: new Date()
    });
    return { providerCallId, outcome };
  }

  async startAICall({ target, campaignId, sessionId = '', brief = {} }) {
    const { providerCallId } = this.#place({ target, campaignId, sessionId, operator: 'ai' });
    return {
      providerCallId,
      providerContactId: `mock_contact_${target.id}`,
      // Echoed back so a test can assert the disclosures actually reached the
      // agent rather than only being computed.
      acceptedBrief: { disclosures: brief.disclosures || [], objective: brief.objective || '' }
    };
  }

  async startPowerDialSession({ targets, campaignId, sessionId }) {
    const target = targets[0];
    if (!target) throw new Error('Power dial needs exactly one target');
    const { providerCallId } = this.#place({ target, campaignId, sessionId, operator: 'human' });
    return { legs: [{ targetId: target.id, providerCallId }] };
  }

  async startParallelDialSession({ targets, campaignId, sessionId, concurrency }) {
    const limit = Math.max(1, Math.min(5, Number(concurrency) || 1));
    if (targets.length > limit) throw new Error(`Parallel session asked for ${targets.length} legs above concurrency ${limit}`);
    const legs = targets.map((target, index) => {
      const { providerCallId } = this.#place({ target, campaignId, sessionId, legIndex: index, operator: 'human' });
      return { targetId: target.id, providerCallId };
    });
    return { legs };
  }

  async cancelCallLeg(providerCallId, reason = 'another_call_connected') {
    const call = this.calls.get(providerCallId);
    if (!call) return { cancelled: false, reason: 'unknown_call' };
    // A call that already reached a terminal state is not cancellable. Saying
    // otherwise would let the parallel dialer "cancel" the leg that just won.
    if (['completed', 'cancelled'].includes(call.status)) return { cancelled: false, reason: call.status };
    call.status = 'cancelled';
    call.cancellationReason = reason;
    return { cancelled: true, reason };
  }

  async endCall(providerCallId) {
    const call = this.calls.get(providerCallId);
    if (!call) return { ended: false };
    call.status = 'completed';
    return { ended: true };
  }

  async getCallStatus(providerCallId) {
    const call = this.calls.get(providerCallId);
    return call ? { status: call.status, outcome: call.outcome } : { status: 'unknown', outcome: '' };
  }

  /**
   * Drive a call to its scripted outcome and return the events a real provider
   * would have delivered by webhook. Tests feed these straight into
   * `recordOutboundCallEvent`, which is what makes the mock a genuine substitute
   * rather than a stub with different semantics.
   */
  advance(providerCallId, { at = new Date() } = {}) {
    const call = this.calls.get(providerCallId);
    if (!call) return [];
    if (call.status === 'cancelled') {
      return [callEvent({
        type: 'cancelled', providerCallId, targetId: call.targetId,
        campaignId: call.campaignId, sessionId: call.sessionId,
        status: 'cancelled', disposition: 'cancelled', at
      })];
    }

    const base = {
      providerCallId, targetId: call.targetId,
      campaignId: call.campaignId, sessionId: call.sessionId, at
    };
    const events = [callEvent({ ...base, type: 'ringing', status: 'ringing' })];

    if (call.outcome === 'human_answered') {
      call.status = 'connected';
      events.push(callEvent({ ...base, type: 'human_answered', status: 'answered' }));
      events.push(callEvent({
        ...base, type: 'completed', status: 'completed', disposition: 'connected',
        durationSec: 132, recordingUrl: `https://mock.invalid/recordings/${providerCallId}.mp3`,
        transcript: [
          { role: 'agent', text: 'Hi, this is the BiteSites assistant. This call is recorded.' },
          { role: 'contact', text: 'Sure, go ahead.' }
        ]
      }));
    } else if (call.outcome === 'machine_answered' || call.outcome === 'voicemail') {
      call.status = 'completed';
      events.push(callEvent({ ...base, type: 'voicemail', status: 'voicemail', disposition: 'voicemail', durationSec: 21 }));
      events.push(callEvent({ ...base, type: 'completed', status: 'completed', disposition: 'voicemail', durationSec: 21 }));
    } else {
      call.status = 'completed';
      const disposition = call.outcome === 'busy' ? 'busy' : 'no_answer';
      events.push(callEvent({ ...base, type: call.outcome, status: call.outcome, disposition, durationSec: 0 }));
      events.push(callEvent({ ...base, type: 'completed', status: 'completed', disposition, durationSec: 0 }));
    }
    return events;
  }

  normalizeWebhookEvent(body = {}) {
    if (!body || typeof body !== 'object' || !body.providerCallId) return null;
    return callEvent({
      type: body.type,
      providerCallId: body.providerCallId,
      targetId: body.targetId,
      campaignId: body.campaignId,
      sessionId: body.sessionId,
      status: body.status,
      disposition: body.disposition,
      durationSec: body.durationSec,
      recordingUrl: body.recordingUrl,
      transcript: body.transcript,
      at: body.at ? new Date(body.at) : new Date()
    });
  }

  verifyWebhook(req, secret) {
    if (!secret || secret.length < 16) return false;
    const provided = String(req?.get?.('x-outbound-secret') || '');
    return provided.length === secret.length && provided === secret;
  }
}
