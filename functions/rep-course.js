// The BiteSites sales-rep course: short lessons and a simple quiz, taken before
// the AI practice calls. Answers stay on the server, so the browser can show the
// quiz but cannot mark itself as passed.

import { SERVICE_PRICING } from './service-pricing.js';

const PASS_RATIO = 0.8;

const priceLines = plans => plans.map(([name, , price]) => `${name}: ${price}`);
const priceOf = (plans, name) => plans.find(([plan]) => plan === name)?.[2] || '';

// The one-page sheet a rep keeps open during practice and live calls. It only
// repeats what the lessons teach, and its prices come from the same list.
const BITESITES_FIELD_GUIDE = Object.freeze({
  title: 'BiteSites rep field guide',
  promise: 'We help local businesses stop losing customers they already earned.',
  services: [
    { name: 'Websites', does: 'A site built around one clear next step for the visitor.',
      prices: [`Starter Site ${priceOf(SERVICE_PRICING.web, 'Starter Site').toLowerCase()}`, `Growth Site ${priceOf(SERVICE_PRICING.web, 'Growth Site').toLowerCase()}`] },
    { name: 'Social media', does: 'Steady, on-brand posts that keep the business top of mind.',
      prices: [`Visibility Starter ${priceOf(SERVICE_PRICING.social, 'Visibility Starter').toLowerCase()}`, `Growth Engine ${priceOf(SERVICE_PRICING.social, 'Growth Engine').toLowerCase()}`] },
    { name: 'AI and automation', does: 'Every lead captured, followed up, and routed fast.',
      prices: [`Audit ${priceOf(SERVICE_PRICING.ai, 'Automation Opportunity Audit').toLowerCase()}`, `Lead Flow Automation ${priceOf(SERVICE_PRICING.ai, 'Lead Flow Automation').toLowerCase()}`] },
    { name: 'AI receptionists', does: 'Calls answered at any hour, so none go to voicemail.',
      prices: ['Custom, priced on the strategy call'] }
  ],
  priceNote: 'Starting prices, not quotes. Every project is custom, so ask questions to find the right price.',
  steps: [
    { label: 'Open', line: 'Your name, BiteSites, why you are calling. Ask for a minute.' },
    { label: 'Ask', line: 'One question about their business. Then stop talking.' },
    { label: 'Listen', line: 'Find the one problem they care about most.' },
    { label: 'Connect', line: 'Show how we fix that one problem.' },
    { label: 'Ask for the yes', line: 'Invite them to a 20-minute call. Don’t wait for them to offer.' }
  ],
  script: [
    { label: 'Open', say: 'Hi, this is [your name] with BiteSites. I know I caught you out of the blue. Do you have a quick minute?' },
    { label: 'Ask', say: 'When a call comes in and nobody can pick up, what happens to it right now?' },
    { label: 'Connect', say: 'It sounds like [their problem] is the real issue. That’s exactly what we fix.' },
    { label: 'Ask for the yes', say: 'Can we set up 20 minutes to map out what would work for you? Does Tuesday or Wednesday work better?' },
    { label: 'After the yes', say: 'Perfect, [day] at [time]. Thanks, [name]. Talk soon.' }
  ],
  questions: [
    'When someone lands on your website, what’s the one thing you want them to do?',
    'When a lead comes in on a Saturday, when does it get a reply?',
    'Where do most of your new customers come from right now?'
  ],
  objections: [
    { they: 'I’m busy.', you: 'Totally fair, I’ll be quick. One question: [ask]. Or is there a better time to call back?' },
    { they: 'How much is it?', you: 'Websites start around $1,000, and it depends on what you need, because everything we build is custom. Can I ask a couple of questions?' },
    { they: 'I already have a web person.', you: 'That’s great, I’m not here to replace anyone. What’s working, and what do you wish it did better?' },
    { they: 'Just send me some info.', you: 'Sure. So it’s actually useful, what’s the one thing you’d most want fixed?' },
    { they: 'Not interested.', you: 'No problem at all. Thanks for your time, and have a great day.' },
    { they: 'Take me off your list.', you: 'Understood. I’ll take you off right now. Sorry for the interruption.', action: 'End the call and press Do not call.' }
  ],
  never: [
    'Lie about who you are or why you are calling',
    'Promise results, rankings, revenue, or guarantees',
    'Make up a price, discount, or deadline',
    'Criticize their current vendor',
    'Keep pitching after a clear no',
    'Record a call unless they agree after answering',
    'Mix BiteSites, Stone Bellisimo, and The Fine Line Group customers or information'
  ],
  outcomes: ['Interested', 'Booked a meeting', 'Call back later', 'Not interested', 'Voicemail', 'Wrong number', 'Do not call'],
  remember: 'When you hear yes, stop selling. Lock in the day and time.'
});

const BITESITES_COURSE = Object.freeze({
  fieldGuide: BITESITES_FIELD_GUIDE,
  lessons: [
    {
      id: 'who-we-are',
      title: 'Who we are',
      summary: 'BiteSites helps local businesses stop losing customers they already earned.',
      points: [
        'Most owners do not need more noise. They need calls answered, leads followed up, and a website that turns visitors into customers.',
        'We build websites and local visibility, lead recovery, AI receptionists, follow-up automation, tracking, and AI consulting.',
        'You are calling to find out what is costing this owner business, then see if we can help.'
      ]
    },
    {
      id: 'the-call',
      title: 'How a good call goes',
      summary: 'Five steps. Most calls take a few minutes.',
      points: [
        'Open: say your name, that you are with BiteSites, and why you are calling. Ask if they have a minute.',
        'Ask: one simple question about their business, then stop talking.',
        'Listen: find the one problem they care about most.',
        'Connect: tell them how we would help with that one problem.',
        'Ask for the yes: invite them to the next step. Do not wait for them to offer.'
      ],
      say: [
        'Hi, this is [your name] with BiteSites. I know I caught you out of the blue. Do you have a quick minute?',
        'When a call comes in and nobody can pick up, what happens to it right now?',
        'It sounds like the missed calls are the real problem. We fix exactly that. Can we set up 20 minutes to map out what would work for you?'
      ]
    },
    {
      id: 'pricing',
      title: 'Pricing',
      summary: 'Know the starting prices. Then remember that every project is custom.',
      priceGroups: [
        { label: 'Websites', lines: priceLines(SERVICE_PRICING.web) },
        { label: 'Social media', lines: priceLines(SERVICE_PRICING.social) },
        { label: 'AI and automation', lines: priceLines(SERVICE_PRICING.ai) }
      ],
      points: [
        'These are starting prices, not final quotes. Everyone wants something different, so every price is custom.',
        'When someone asks about price, give the starting range honestly, say it is custom, then ask questions so we can get the right price for them.',
        'Good questions: What do you want this to do for your business? What do you have today? How many pages or channels do you need? What tools does it need to work with? When do you want it live?',
        'Never make up a number, a discount, or a deadline. If you are not sure, say so and bring it to the strategy call.'
      ],
      say: [
        'Websites start around $1,000 and it depends on what you need, because everything we build is custom. Can I ask a couple of questions so we can get you the right price?'
      ]
    },
    {
      id: 'getting-to-yes',
      title: 'When they say yes',
      summary: 'A close is simply getting to yes. When you hear it, stop selling.',
      points: [
        'Pushback is normal. Most interested people push back once or twice before they say yes.',
        'Handle a concern by agreeing with what is fair, asking one question, then asking for the yes again.',
        'When they say yes, stop pitching. Confirm the next step, get a day and time, and thank them.',
        'Talking past a yes is how easy deals get lost.'
      ],
      say: [
        'Totally fair. What would have to be true for this to be worth 20 minutes?',
        'Great. Does Tuesday or Wednesday work better for you?'
      ]
    },
    {
      id: 'handling-no',
      title: 'When they say no',
      summary: 'A clear no is a real answer. Stay kind and move on.',
      points: [
        'One calm question is fine if the no is soft, like “not right now.” After a clear no, thank them and end the call.',
        'Do not argue, guilt, or keep pitching. People remember how you treated them.',
        'If someone says “do not call me” or “take me off your list,” apologize, confirm it, end the call, and press Do not call. No second attempts.',
        'A respectful no is a successful call. You will hear plenty of them.'
      ],
      say: [
        'No problem at all. Thanks for your time, and have a great day.',
        'Understood. I will take you off our list right now. Sorry for the interruption.'
      ]
    },
    {
      id: 'rules',
      title: 'Rules we never break',
      summary: 'These protect our customers, you, and the company.',
      points: [
        'Always be honest about who you are and why you are calling.',
        'Never promise results, rankings, revenue, or guarantees.',
        'Never criticize their current vendor or make up facts.',
        'Only record a call if the person agrees after they answer.',
        'BiteSites, Stone Bellisimo, and The Fine Line Group are separate. Never mix their customers or information.'
      ]
    },
    {
      id: 'the-dialer',
      title: 'Using the dialer',
      summary: 'Calls are placed one at a time and connected straight to you.',
      points: [
        'Press Start dialing and allow your microphone when your browser asks.',
        'Take notes during the call. They save as you type.',
        'After each call, pick the outcome: Interested, Booked a meeting, Call back later, Not interested, Voicemail, Wrong number, or Do not call.',
        'The next call waits until you save the outcome, so you are never rushed.'
      ]
    }
  ],
  quiz: [
    {
      id: 'close-definition',
      question: 'What is a close on our calls?',
      options: ['Getting a credit card on the call', 'Getting the person to yes on the next step', 'Finishing the whole script', 'Sending an email'],
      answer: 1,
      why: 'A close is simply getting to yes.'
    },
    {
      id: 'first-move',
      question: 'What should you do right after you introduce yourself?',
      options: ['List every service', 'Quote a price', 'Ask if they have a minute', 'Ask for their email'],
      answer: 2,
      why: 'Asking permission earns you the conversation.'
    },
    {
      id: 'price-start',
      question: 'A Growth Site starts at what price?',
      options: ['$600', '$1,000', '$2,500', '$7,500'],
      answer: 2,
      why: 'Growth Site starts at $2,500. Starter Site starts at $1,000.'
    },
    {
      id: 'price-social',
      question: 'Where does social media management start?',
      options: ['$600 a month', '$100 a month', '$2,000 a month', 'It is free'],
      answer: 0,
      why: 'Visibility Starter starts at $600 a month.'
    },
    {
      id: 'price-asked',
      question: 'Someone asks, “How much is this?” What is the best answer?',
      options: ['“I can’t talk about price.”', 'Give the starting range, say it is custom, then ask what they need', 'Pick the lowest number to win them over', 'Offer a discount right away'],
      answer: 1,
      why: 'Everyone wants something different, so your questions find the right price.'
    },
    {
      id: 'heard-yes',
      question: 'The person says, “Yes, let’s do it.” What do you do?',
      options: ['Keep explaining the features', 'Stop selling and lock in a day and time', 'Ask them to think about it', 'Hang up and call back'],
      answer: 1,
      why: 'When you hear yes, stop selling and confirm the next step.'
    },
    {
      id: 'pushback',
      question: 'They say, “I already have a web guy.” What is the best move?',
      options: ['Tell them that person is bad', 'End the call', 'Respect it and ask what is working and what is not', 'Promise we are cheaper'],
      answer: 2,
      why: 'Respect the vendor, then ask a question.'
    },
    {
      id: 'clear-no',
      question: 'Someone gives you a clear, polite no. What do you do?',
      options: ['Try three more times', 'Thank them and end the call', 'Ask to speak to someone else', 'Call back in an hour'],
      answer: 1,
      why: 'A clear no is a real answer.'
    },
    {
      id: 'do-not-call',
      question: 'Someone says, “Take me off your list.” What do you do?',
      options: ['Ask why', 'Offer a discount', 'Apologize, end the call, and press Do not call', 'Mark Call back later'],
      answer: 2,
      why: 'Stop right away and record it as Do not call.'
    },
    {
      id: 'promises',
      question: 'Which of these can you say?',
      options: ['“We guarantee you page one of Google.”', '“You will double your revenue.”', '“Every project is custom, so let’s find what fits you.”', '“Your current web person is ripping you off.”'],
      answer: 2,
      why: 'Never promise results or criticize another vendor.'
    }
  ]
});

const COURSES = Object.freeze({ bitesites: BITESITES_COURSE });

export function hasRepCourse(accountId) {
  return Boolean(COURSES[accountId]);
}

/** What the browser may see: lessons and questions, never the answers. */
export function publicRepCourse(accountId) {
  const course = COURSES[accountId];
  if (!course) return null;
  return {
    lessons: course.lessons,
    fieldGuide: course.fieldGuide || null,
    quiz: course.quiz.map(({ id, question, options }) => ({ id, question, options })),
    passMark: Math.ceil(course.quiz.length * PASS_RATIO)
  };
}

export function gradeRepQuiz(accountId, answers = {}) {
  const course = COURSES[accountId];
  if (!course) throw new Error('This seller account has no course.');
  const submitted = answers && typeof answers === 'object' ? answers : {};
  const missed = course.quiz
    .filter(item => submitted[item.id] !== item.answer)
    .map(({ id, question, why }) => ({ id, question, why }));
  const total = course.quiz.length;
  const correct = total - missed.length;
  return { correct, total, passed: correct >= Math.ceil(total * PASS_RATIO), missed };
}
