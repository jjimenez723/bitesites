// These tests intentionally use a carrier provider with no credentials. The
// environment gate must return before a target is read, locked or offered to a
// provider, so this is both an emulator test and a no-network test.

process.env.GCLOUD_PROJECT = 'demo-bitesites';
process.env.BITESITES_DEPLOYMENT_ENVIRONMENT = 'staging';
process.env.OUTBOUND_EXTERNAL_DIALING = 'disabled';

import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ projectId: 'demo-bitesites' });
const db = getFirestore();
const { dialNext, runAICampaignSlice } = await import('./outbound-calls.js');
const { attachAIController } = await import('./hybrid-call-orchestration.js');
const { composePreDialScreening, preDialScreeningId } = await import('./pre-dial-screening.js');

async function reset(collection) {
  const snapshot = await db.collection(collection).limit(100).get();
  await Promise.all(snapshot.docs.map(entry => entry.ref.delete()));
}

for (const collection of [
  'outboundCampaigns', 'dialerSessions', 'outboundTargets', 'calls',
  'consentGrants', 'preDialScreenings', 'callAuditEvents'
]) await reset(collection);

test('staging refuses an interactive Twilio dial before target/provider work', async () => {
  const campaignId = 'stage-twilio';
  const sessionId = 'stage-session';
  await db.doc(`outboundCampaigns/${campaignId}`).set({
    status: 'running', provider: 'twilio', accountId: 'bitesites', mode: 'parallel', concurrency: 1
  });
  await db.doc(`dialerSessions/${sessionId}`).set({
    campaignId, status: 'active', provider: 'twilio', mode: 'parallel', concurrency: 1,
    connectedCallId: '', activeCallIds: [], startedAt: Timestamp.now()
  });

  const result = await dialNext(db, sessionId);
  assert.equal(result.reason, 'external_dialing_disabled');
  assert.equal(result.admission.environment, 'staging');
  assert.equal((await db.collection('calls').get()).size, 0);
  assert.equal((await db.collection('outboundTargets').get()).size, 0);
});

test('staging refuses the autonomous AI runner before workflow enrollment', async () => {
  const campaignId = 'stage-ai';
  await db.doc(`outboundCampaigns/${campaignId}`).set({
    status: 'running', provider: 'gohighlevel', accountId: 'bitesites', mode: 'ai'
  });

  const result = await runAICampaignSlice(db, campaignId);
  assert.equal(result.reason, 'external_dialing_disabled');
  assert.equal(result.admission.environment, 'staging');
  assert.equal((await db.doc(`dialerSessions/ai_${campaignId}`).get()).exists, false);
});

test('a later AI attachment cannot bypass missing external screening', async () => {
  const now = new Date('2026-08-24T16:00:00Z');
  const grantedAt = new Date('2026-08-01T12:00:00Z');
  const campaignId = 'attach-screen-campaign';
  const targetId = 'attach-screen-target';
  const callId = 'attach-screen-call';
  const grantId = 'grant_attach_screening';
  const phoneE164 = '+12015550142';
  await db.doc(`outboundCampaigns/${campaignId}`).set({
    status: 'paused', provider: 'twilio', accountId: 'bitesites', mode: 'parallel'
  });
  await db.doc(`outboundTargets/${targetId}`).set({
    campaignId, accountId: 'bitesites', phoneE164, consent: { grantId }
  });
  await db.doc(`consentGrants/${grantId}`).set({
    basis: 'written_opt_in', sellerAccountId: 'bitesites', phoneE164,
    evidenceArtifactId: 'artifact-attach', disclosureVersion: 'ai-voice-v1',
    grantedAt: Timestamp.fromDate(grantedAt), reviewedAt: Timestamp.fromDate(now),
    reviewedBy: 'compliance-owner', status: 'active'
  });
  await db.doc(`calls/${callId}`).set({
    campaignId, targetId, phoneE164, sessionId: 'attach-session',
    control: { controller: 'ai', revision: 1 }
  });

  await assert.rejects(
    () => attachAIController(db, callId, 'realtime-session', { now }),
    /external_screening_missing/
  );
  assert.equal((await db.doc(`calls/${callId}`).get()).get('control.aiSessionId'), undefined);

  const screening = composePreDialScreening({
    sellerAccountId: 'bitesites', phoneE164, consentGrantedAt: grantedAt, now,
    nationalDnc: { status: 'clear', snapshotId: 'dnc-2026-08', provider: 'registry_import' },
    entityDnc: { status: 'clear' },
    lookup: {
      provider: 'twilio_lookup_v2', phoneValid: true, lineType: 'mobile',
      reassignedStatus: 'no', lastVerifiedDate: '20260801'
    }
  });
  await db.doc(`preDialScreenings/${preDialScreeningId('bitesites', phoneE164)}`).set(screening);
  const attached = await attachAIController(db, callId, 'realtime-session', { now });
  assert.equal(attached.ok, true);
  assert.equal((await db.doc(`calls/${callId}`).get()).get('control.aiSessionId'), 'realtime-session');
});
