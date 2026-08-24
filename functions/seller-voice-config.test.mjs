import test from 'node:test';
import assert from 'node:assert/strict';

import { compileAgentRuntime } from './agent-runtime.js';
import {
  PARTNER_VOICE_KNOWLEDGE,
  PARTNER_VOICE_PROFILES,
  assertSellerVoiceConfig,
  sellerVoiceConfigFailures
} from './seller-voice-config.js';

const profile = accountId => PARTNER_VOICE_PROFILES.find(entry => entry.accountId === accountId);

test('every partner profile passes the deterministic production gate', () => {
  assert.equal(PARTNER_VOICE_PROFILES.length, 2);
  for (const entry of PARTNER_VOICE_PROFILES) assert.equal(assertSellerVoiceConfig(entry), entry);
});

test('Stone Bellisimo compiles as a showroom setter with no transactional authority', () => {
  const compiled = compileAgentRuntime({
    profile: profile('stone-bellisimo'),
    campaign: { id: 'stone-campaign', accountId: 'stone-bellisimo' }
  });
  assert.match(compiled.instructions, /Stonebellisimo LLC/);
  assert.match(compiled.instructions, /Book a showroom visit/);
  assert.match(compiled.instructions, /618 23rd St, Union City/);
  assert.doesNotMatch(compiled.instructions, /BiteSites L\.L\.C\./);
  assert.equal(compiled.permissions.mayBookMeeting, true);
  assert.equal(compiled.permissions.mayQuotePricing, false);
  assert.equal(compiled.permissions.mayCloseSale, false);
  assert.equal(compiled.permissions.mayCollectPayment, false);
  assert.deepEqual(compiled.offerTracks, []);
});

test('Fine Line compiles only its approved service and public-contact facts', () => {
  const compiled = compileAgentRuntime({
    profile: profile('fine-line-group'),
    campaign: { id: 'fine-line-campaign', accountId: 'fine-line-group' }
  });
  assert.match(compiled.instructions, /The Fine Line Group LLC/);
  assert.match(compiled.instructions, /Book a project assessment/);
  assert.match(compiled.instructions, /\+15517552278/);
  assert.doesNotMatch(compiled.instructions, /BiteSites L\.L\.C\./);
  assert.doesNotMatch(compiled.instructions, /thefinelinegroup\.com/i);
  assert.equal(compiled.permissions.mayQuotePricing, false);
  assert.deepEqual(compiled.offerTracks, []);
});

test('seller knowledge is disjoint and contains the approved conversion boundary', () => {
  for (const entry of PARTNER_VOICE_KNOWLEDGE) {
    assert.ok(entry.documents.length > 0);
    const text = entry.documents.map(document => document.text).join('\n');
    assert.match(text, /does not close|does not close|does not close/i);
    assert.match(text, /Never quote|Never promise/i);
  }
  assert.doesNotMatch(
    PARTNER_VOICE_KNOWLEDGE.find(entry => entry.accountId === 'fine-line-group').documents[0].text,
    /https?:\/\//i
  );
});

test('the gate rejects cross-seller knowledge and commercial authority', () => {
  const unsafe = {
    ...profile('fine-line-group'),
    permissions: { ...profile('fine-line-group').permissions, mayCloseSale: true },
    knowledgeBaseIds: ['stone-bellisimo-sales-playbook']
  };
  const failures = sellerVoiceConfigFailures(unsafe);
  assert.ok(failures.includes('unsafe_permission_mayCloseSale'));
  assert.ok(failures.includes('knowledge_base_not_seller_bound'));
});
