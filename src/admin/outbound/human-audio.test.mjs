import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPrepareHumanAudio } from './human-audio.js';

test('prepare only the active, single human line before assignment', () => {
  const session={status:'active',operatingMode:'human',concurrency:1,activeCallIds:['one'],rep:{activeCallId:''}};
  const call={id:'one',status:'ringing',control:{controller:'unassigned'}};
  assert.equal(shouldPrepareHumanAudio(session,call),true);
  for(const patch of [{operatingMode:'hybrid'},{operatingMode:'ai'},{concurrency:2},{status:'ended'},
    {activeCallIds:['another']},{rep:{activeCallId:'another'}}]) {
    assert.equal(shouldPrepareHumanAudio({...session,...patch},call),false);
  }
  for(const status of ['completed','cancelled','failed']) {
    assert.equal(shouldPrepareHumanAudio(session,{...call,status}),false);
  }
  for(const controller of ['ai','human','transitioning','none']) {
    assert.equal(shouldPrepareHumanAudio(session,{...call,control:{controller}}),false);
  }
});
