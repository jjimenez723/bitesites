import { createHmac } from 'node:crypto';
import { clean } from './prospect-normalization.js';

export const conferenceName = (sessionId, targetId) => {
  const token = createHmac('sha256', 'bitesites-conference-v2')
    .update(`${clean(sessionId, 200)}:${clean(targetId, 200)}`).digest('hex').slice(0, 40);
  return `bs_${token}`;
};

const xml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Share the exact room and callback between inline call creation and the
// legacy TwiML endpoint. Supplying this before dialing avoids a function cold
// start and database lookup while the prospect is already saying hello.
export function prospectConferenceTwiml({ sessionId, targetId, publicUrl }) {
  const callback = new URL('/api/twilio-conference-events', publicUrl);
  callback.searchParams.set('sessionId', sessionId);
  callback.searchParams.set('targetId', targetId);
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="" participantLabel="prospect" statusCallback="${xml(callback.toString())}" statusCallbackMethod="POST" statusCallbackEvent="start end join leave mute hold">${xml(conferenceName(sessionId, targetId))}</Conference></Dial></Response>`;
}
