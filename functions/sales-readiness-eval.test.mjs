import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BITE_SITES_READINESS_PROFILE,
  SALES_READINESS_PROFILES,
  evaluateSalesReadiness,
  formatSalesReadiness
} from './sales-readiness-eval.js';
import { PARTNER_VOICE_PROFILES } from './seller-voice-config.js';

const seller = (result, id) => result.sellers.find(entry => entry.sellerAccountId === id);
const scenario = (evaluation, id) => evaluation.scenarios.find(entry => entry.id === id);

test('offline sales readiness evaluates all three seller runtimes with no critical failures', () => {
  const result = evaluateSalesReadiness();
  assert.equal(result.kind, 'offline_sales_readiness');
  assert.equal(result.sellers.length, 3);
  assert.deepEqual(result.sellers.map(entry => entry.sellerAccountId), ['bitesites', 'stone-bellisimo', 'fine-line-group']);
  assert.deepEqual(result.criticalFailures, []);
  assert.equal(result.promotionVerdict, 'eligible_for_controlled_backend_rehearsal');
  assert.match(formatSalesReadiness(result), /bitesites: eligible_for_controlled_backend_rehearsal/);
});

test('each seller passes every required offline policy and tool scenario', () => {
  const result = evaluateSalesReadiness();
  const required = [
    'seller_identity', 'appointment_only_authority', 'ai_disclosure', 'do_not_call', 'wrong_party',
    'price_discount_pressure', 'unsupported_research', 'cross_seller_prompt_injection',
    'seller_specific_qualification', 'booking_truthfulness', 'unavailable_tool_behavior',
    'seller_configuration_integrity'
  ];
  for (const evaluation of result.sellers) {
    for (const id of required) {
      assert.equal(scenario(evaluation, id)?.pass, true, `${evaluation.sellerAccountId}:${id}`);
    }
  }
  assert.equal(scenario(seller(result, 'fine-line-group'), 'emergency_life_safety')?.pass, true);
  assert.equal(scenario(seller(result, 'fine-line-group'), 'emergency_life_safety')?.applicable, true);
  for (const id of ['bitesites', 'stone-bellisimo']) {
    assert.equal(scenario(seller(result, id), 'emergency_life_safety')?.applicable, false);
  }
});

test('an unsafe partner profile blocks the promotion verdict even when compiler clamps its runtime permissions', () => {
  const unsafeStone = {
    ...PARTNER_VOICE_PROFILES.find(profile => profile.accountId === 'stone-bellisimo'),
    permissions: {
      ...PARTNER_VOICE_PROFILES.find(profile => profile.accountId === 'stone-bellisimo').permissions,
      mayCloseSale: true
    }
  };
  const result = evaluateSalesReadiness([
    BITE_SITES_READINESS_PROFILE,
    unsafeStone,
    PARTNER_VOICE_PROFILES.find(profile => profile.accountId === 'fine-line-group')
  ]);
  const stone = seller(result, 'stone-bellisimo');
  assert.equal(result.promotionVerdict, 'blocked');
  assert.ok(stone.criticalFailures.includes('seller_configuration_integrity'));
  assert.equal(scenario(stone, 'appointment_only_authority')?.pass, true,
    'runtime permission clamp remains an independent defensive layer');
});

test('removing Fine Line life-safety escalation blocks readiness', () => {
  const weakenedFineLine = {
    ...PARTNER_VOICE_PROFILES.find(profile => profile.accountId === 'fine-line-group'),
    advancedInstructions: 'Qualify the project and offer an assessment. Never quote pricing.'
  };
  const result = evaluateSalesReadiness([
    BITE_SITES_READINESS_PROFILE,
    PARTNER_VOICE_PROFILES.find(profile => profile.accountId === 'stone-bellisimo'),
    weakenedFineLine
  ]);
  const fineLine = seller(result, 'fine-line-group');
  assert.equal(result.promotionVerdict, 'blocked');
  assert.ok(fineLine.criticalFailures.includes('emergency_life_safety'));
});

test('the harness is bounded to canonical seller profiles rather than arbitrary extra entries', () => {
  const result = evaluateSalesReadiness([...SALES_READINESS_PROFILES, { accountId: 'unknown', id: 'ignored' }]);
  assert.equal(result.sellers.length, 3);
  assert.deepEqual(result.sellers.map(entry => entry.profileId), SALES_READINESS_PROFILES.map(entry => entry.id));
});
