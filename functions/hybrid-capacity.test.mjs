import test from 'node:test';
import assert from 'node:assert/strict';

import { hybridVacancies } from './hybrid-capacity.js';

test('hybrid capacity fills only missing live slots', () => {
  assert.equal(hybridVacancies(3, []), 3);
  assert.equal(hybridVacancies(3, [{ status: 'open' }]), 2);
  assert.equal(hybridVacancies(3, [{ status: 'ringing' }, { status: 'connected' }, { status: 'open' }]), 0);
});

test('terminal calls do not consume hybrid capacity', () => {
  assert.equal(hybridVacancies(3, [
    { status: 'completed' },
    { status: 'cancelled' },
    { status: 'failed' },
    { status: 'ringing' }
  ]), 2);
});

test('human-only mode fans out while free and collapses to the connected rep call', () => {
  assert.equal(hybridVacancies(3, [], 'human', false), 3);
  assert.equal(hybridVacancies(3, [{ status: 'connected' }], 'human', true), 0);
});
