// The 500ms control poll:  npm run test:sideband-poll
//
// This is the hottest read path in the product. The sideband hits it twice a
// second for the whole length of every AI call, so it was trimmed from three
// document reads per tick to one. These tests exist to hold both halves of that
// change at once: the reads really are gone, AND nothing the sideband acts on
// arrives any later than it did before.
//
// The two behaviours under protection are load-bearing for compliance and for
// the smooth-handoff promise:
//   - a rep takeover, or an explicit do-not-call, must be visible on the very
//     next tick — never deferred, never cached;
//   - the handoff phrase must still be the configured one, read fresh at the
//     moment it is about to be spoken.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pollControlPayload, DEFAULT_HANDOFF_PHRASE } =
  await import('./hybrid-sideband-control.js');

/**
 * A Firestore stand-in that records every document it is asked for. The poll
 * payload touches Firestore only through `db.doc(path).get()`, so counting
 * those calls is an exact measure of what a tick costs.
 */
function countingDb(docs = {}) {
  const reads = [];
  return {
    reads,
    doc(path) {
      reads.push(path);
      const data = docs[path];
      return {
        async get() {
          return {
            exists: data !== undefined,
            get: field => field.split('.').reduce((node, key) => node?.[key], data)
          };
        }
      };
    }
  };
}

const callDoc = (overrides = {}) => ({
  sessionId: 'sess-1',
  control: { controller: 'ai' },
  handoff: { state: '', requestedBy: '' },
  ...overrides
});

// ---------------------------------------------------------------- the savings

test('a steady-state tick reads no documents beyond the call already loaded', async () => {
  const db = countingDb();
  await pollControlPayload(db, { callId: 'call-1', call: callDoc() });
  assert.deepEqual(db.reads, [],
    'the idle poll must not read the dialer session or the media job');
});

test('a tick still reports everything the sideband acts on', async () => {
  const db = countingDb();
  const payload = await pollControlPayload(db, {
    callId: 'call-1',
    call: callDoc({ handoff: { state: 'requested', requestedBy: 'prospect' } })
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.controller, 'ai');
  assert.equal(payload.handoff.state, 'requested');
  assert.equal(payload.handoff.requestedBy, 'prospect');
});

// -------------------------------------------------------- takeover must be instant

test('a rep takeover is visible on the tick it happens', async () => {
  const db = countingDb();
  const payload = await pollControlPayload(db, {
    callId: 'call-1',
    call: callDoc({ control: { controller: 'human' } })
  });
  // The sideband hangs up the AI leg on exactly this value.
  assert.equal(payload.controller, 'human');
  assert.deepEqual(db.reads, [], 'a takeover must not cost extra reads either');
});

// Regression: the controller used to be bounded with `clean()`, the scrubber
// for imported contact data, which maps the literal string 'none' to '' because
// a contact whose company is "none" has no company. A call whose controller is
// 'none' very much has a state — it is the terminal one, written when a
// connected call ends up with no operator — and erasing it meant the sideband's
// `controller === 'none'` hangup could never fire, leaving the AI leg live on a
// call Firestore had already marked completed.
test('a call left with no operator is reported as such, so the AI leg is torn down', async () => {
  const payload = await pollControlPayload(countingDb(), {
    callId: 'call-1',
    call: callDoc({ control: { controller: 'none' } })
  });
  assert.equal(payload.controller, 'none',
    "'none' is a real controller state and must survive to the sideband");
});

test('every controller the orchestrator can write survives the round trip', async () => {
  for (const controller of ['ai', 'human', 'transitioning', 'none', 'unassigned']) {
    const payload = await pollControlPayload(countingDb(), {
      callId: 'call-1',
      call: callDoc({ control: { controller } })
    });
    assert.equal(payload.controller, controller, `controller ${controller} was altered in transit`);
  }
});

test('the controller is read from the call document every tick, never remembered', async () => {
  const db = countingDb();
  const call = callDoc();
  const before = await pollControlPayload(db, { callId: 'call-1', call });
  const after = await pollControlPayload(db, {
    callId: 'call-1',
    call: callDoc({ control: { controller: 'human' } })
  });
  assert.equal(before.controller, 'ai');
  assert.equal(after.controller, 'human',
    'a second tick must reflect the newer call document, with nothing cached between them');
});

// ------------------------------------------------------------ the handoff phrase

test('announcing reads the media job and returns the configured phrase', async () => {
  const db = countingDb({
    'aiMediaJobs/call-1': { runtime: { handoffPhrase: 'Let me get Dana for you.' } }
  });
  const payload = await pollControlPayload(db, {
    callId: 'call-1',
    call: callDoc({ handoff: { state: 'announcing', requestedBy: 'rep' } })
  });
  assert.equal(payload.handoff.phrase, 'Let me get Dana for you.');
  assert.deepEqual(db.reads, ['aiMediaJobs/call-1'],
    'the phrase is worth exactly one read, on the tick it is spoken');
});

test('announcing falls back to the default phrase when none is configured', async () => {
  const payload = await pollControlPayload(countingDb({ 'aiMediaJobs/call-1': { runtime: {} } }), {
    callId: 'call-1',
    call: callDoc({ handoff: { state: 'announcing' } })
  });
  assert.equal(payload.handoff.phrase, DEFAULT_HANDOFF_PHRASE);
});

test('announcing still yields a speakable phrase when the media job is missing', async () => {
  const payload = await pollControlPayload(countingDb(), {
    callId: 'call-1',
    call: callDoc({ handoff: { state: 'announcing' } })
  });
  assert.equal(payload.handoff.phrase, DEFAULT_HANDOFF_PHRASE,
    'a missing job must never leave the agent silent mid-handoff');
});

test('a phrase edited mid-call is picked up on the announcing tick, not the prepared copy', async () => {
  const docs = { 'aiMediaJobs/call-1': { runtime: { handoffPhrase: 'Original phrase.' } } };
  const db = countingDb(docs);
  docs['aiMediaJobs/call-1'] = { runtime: { handoffPhrase: 'Updated phrase.' } };
  const payload = await pollControlPayload(db, {
    callId: 'call-1',
    call: callDoc({ handoff: { state: 'announcing' } })
  });
  assert.equal(payload.handoff.phrase, 'Updated phrase.');
});

// ------------------------------------------------------------------- bounding

test('an unrecognised controller is reported as empty rather than passed through', async () => {
  for (const junk of ['x'.repeat(200), 'HUMAN', 42, null, { controller: 'human' }]) {
    const payload = await pollControlPayload(countingDb(), {
      callId: 'call-1',
      call: callDoc({ control: { controller: junk } })
    });
    assert.equal(payload.controller, '', `unexpected controller ${String(junk)} leaked through`);
  }
});

test('untrusted handoff fields are still bounded before they reach the sideband', async () => {
  const payload = await pollControlPayload(countingDb(), {
    callId: 'call-1',
    call: callDoc({ handoff: { state: 'y'.repeat(200), requestedBy: 'z'.repeat(200) } })
  });
  assert.equal(payload.handoff.state.length, 40);
  assert.equal(payload.handoff.requestedBy.length, 40);
});
