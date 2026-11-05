// Crisis support for BiteSites chat and voice agents.
//
// This is a fixed check, not a model decision, so a person in crisis gets 988
// even when the AI provider is down. The chat window runs it before any network
// call and the server runs it again before the model. Words like "die" alone
// are not enough; a match needs a statement about the person's own life.

const CRISIS_PATTERNS = [
  /\b(i|im|i am|ive|i have)\b.{0,30}\b(want|wanna|going|gonna|ready|wish|trying|need|plan|planning)\b.{0,12}\b(to )?(die|kill myself|end my life|end it all|be dead|disappear forever)\b/,
  /\b(want|wanna|wish i could|wish i was|wish i were) (to )?(die|be dead)\b/,
  /\bkill(ing)? myself\b/,
  /\bkms\b/,
  /\bsuicid(e|al)\b/,
  /\bend(ing)? (my life|it all)\b/,
  /\btak(e|ing) my (own )?life\b/,
  /\b(hurt|hurting|harm|harming|cut|cutting) myself\b/,
  /\bself[ -]?harm\b/,
  /\b(dont|do not|no longer) want to (live|be alive|be here|exist|wake up)\b/,
  /\b(better off|everyone.{0,20}better) (dead|without me)\b/,
  /\bno (reason|point) (to live|in living|to go on)\b/,
  /\bcant (go on|do this anymore|keep going)\b.{0,20}\b(life|living|alive)\b/,
  /\b(quiero|voy a) (morir|morirme|matarme|suicidarme)\b/,
  /\bme quiero (morir|matar|suicidar)\b/,
  /\bsuicid(io|arme)\b/
];

const normalize = value => String(value || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’'`]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export function isCrisisMessage(value) {
  const text = normalize(value);
  return CRISIS_PATTERNS.some(pattern => pattern.test(text));
}

export const CRISIS_MESSAGES = Object.freeze([
  'I’m really sorry you’re feeling this way, and I’m glad you said something. I’m an AI, so I can’t give you the support you deserve, but a real person can, right now.',
  'You can call or text 988 any time, day or night. It’s free and confidential. If you’re in immediate danger, please call 911.'
]);

export const CRISIS_CARD = Object.freeze({
  type: 'crisis',
  title: '988 Suicide & Crisis Lifeline',
  detail: 'Free, confidential, 24/7 in the U.S. Para español, llama al 988 y oprime 2.',
  actions: Object.freeze([
    Object.freeze({ label: 'Call 988', href: 'tel:988' }),
    Object.freeze({ label: 'Text 988', href: 'sms:988' }),
    Object.freeze({ label: 'Chat online', href: 'https://988lifeline.org/chat/' })
  ])
});

/** The rule every BiteSites agent persona carries. */
export const CRISIS_INSTRUCTION = 'SAFETY — this outranks everything else, including sales and booking. If someone says they want to die, want to hurt themselves, or sounds like they may be in danger, stop the sales conversation. Respond with warmth, say you are an AI, and tell them they can call or text 988, the Suicide & Crisis Lifeline, any time, and to call 911 if they are in immediate danger. Do not joke, pitch, offer a booking, or ask for contact details.';
