import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallNotesDraft } from './call-notes-draft.js';
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

test('saves multiline notes to the original call and clears the local backup only after success', async () => {
  const cache = storage(), writes = [];
  const draft = createCallNotesDraft({ callId: 'call-a', storage: cache, save: async (...args) => writes.push(args) });
  draft.setText('Spoke to Sam.\nFollow up Friday.');
  assert.equal(cache.getItem('bitesites-call-notes:call-a'), draft.getState().text);
  await draft.flush();
  assert.deepEqual(writes, [['call-a', 'Spoke to Sam.\nFollow up Friday.']]);
  assert.equal(cache.getItem('bitesites-call-notes:call-a'), null);
  assert.equal(draft.getState().status, 'saved');
});

test('serializes edits made during a slow save so the latest text wins', async () => {
  const writes = [], releases = [];
  const draft = createCallNotesDraft({ callId: 'call-a', save: (id, notes) => { writes.push([id, notes]); return new Promise(resolve => releases.push(resolve)); } });
  draft.setText('First detail');
  const saving = draft.flush();
  draft.setText('First detail and next steps');
  assert.equal(draft.flush(), saving);
  assert.equal(writes.length, 1);
  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes[1], ['call-a', 'First detail and next steps']);
  releases.shift()();
  await saving;
  assert.equal(draft.getState().status, 'saved');
});

test('failed saves retain a recoverable draft and can retry after the call ends', async () => {
  const cache = storage();
  let fail = true;
  const draft = createCallNotesDraft({ callId: 'ended-call', storage: cache, save: async () => { if (fail) throw new Error('Offline'); } });
  draft.setText('Interested in a new website');
  assert.equal(await draft.flush(), false);
  assert.equal(draft.getState().status, 'error');
  const recovered = createCallNotesDraft({ callId: 'ended-call', storage: cache, save: async () => {} });
  assert.equal(recovered.getState().text, 'Interested in a new website');
  fail = false;
  assert.equal(await draft.flush(), true);
  assert.equal(cache.getItem('bitesites-call-notes:ended-call'), null);
});

test('switching calls keeps both drafts isolated and allows explicitly clearing saved notes', async () => {
  const writes = [];
  const save = async (...args) => writes.push(args);
  const first = createCallNotesDraft({ callId: 'a', initialText: 'Old note', save });
  const next = createCallNotesDraft({ callId: 'b', save });
  first.setText(''); next.setText('Different business');
  await Promise.all([first.flush(), next.flush()]);
  assert.deepEqual(writes, [['a', ''], ['b', 'Different business']]);
});

test('storage restrictions do not prevent server saving', async () => {
  const blocked = () => { throw new Error('Storage blocked'); };
  const draft = createCallNotesDraft({ callId: 'a', storage: { getItem: blocked, setItem: blocked, removeItem: blocked }, save: async () => {} });
  draft.setText('Saved to server');
  assert.equal(await draft.flush(), true);
});
