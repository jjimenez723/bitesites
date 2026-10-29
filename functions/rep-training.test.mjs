// Training access is pure, so this runs with plain `node --test`: no emulator,
// no credentials. Every server gate (campaign reads, sessions, dialing,
// transfers, appointments) asks these two helpers, so a wrong answer here
// either locks out a rep the admin cleared or lets an untrained one dial.
//
//   npm run test:rep-training

import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRepTrainingAccess, hasRepTrainingExemption } from './rep-training.js';

// The helpers accept both a plain role record and a Firestore snapshot.
const snapshot = data => ({ get: field => data[field] });

for (const [shape, wrap] of [['plain record', data => data], ['snapshot', snapshot]]) {
  test(`${shape}: a pass grants access to that seller only`, () => {
    const role = wrap({ trainingPassedAccountIds: ['bitesites'] });
    assert.equal(hasRepTrainingAccess(role, 'bitesites'), true);
    assert.equal(hasRepTrainingAccess(role, 'stone-bellisimo'), false);
    assert.equal(hasRepTrainingExemption(role, 'bitesites'), false, 'a pass is not an exemption');
  });

  test(`${shape}: an exemption grants access to that seller only`, () => {
    const role = wrap({ trainingExemptAccountIds: ['bitesites'] });
    assert.equal(hasRepTrainingAccess(role, 'bitesites'), true);
    assert.equal(hasRepTrainingExemption(role, 'bitesites'), true);
    assert.equal(hasRepTrainingAccess(role, 'the-fine-line-group'), false);
  });

  test(`${shape}: neither a pass nor an exemption means no access`, () => {
    assert.equal(hasRepTrainingAccess(wrap({}), 'bitesites'), false);
    assert.equal(hasRepTrainingAccess(wrap({ trainingPassedAccountIds: [], trainingExemptAccountIds: [] }), 'bitesites'), false);
  });

  test(`${shape}: malformed fields never grant access`, () => {
    for (const value of ['bitesites', { bitesites: true }, null, 1]) {
      const role = wrap({ trainingPassedAccountIds: value, trainingExemptAccountIds: value });
      assert.equal(hasRepTrainingAccess(role, 'bitesites'), false, JSON.stringify(value));
    }
  });
}

test('a missing role record never grants access', () => {
  assert.equal(hasRepTrainingAccess(null, 'bitesites'), false);
  assert.equal(hasRepTrainingAccess(undefined, 'bitesites'), false);
  assert.equal(hasRepTrainingExemption(null, 'bitesites'), false);
});
