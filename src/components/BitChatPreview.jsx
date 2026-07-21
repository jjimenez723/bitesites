import { useEffect, useState } from 'react';
import { BitMascot } from './BitMascot';

// Bit greets visitors before they ever click, so the card cycles a few short
// lines instead of sitting on a single static caption.
const bitGreetings = [
  'Hi there! I’m Bit ✦',
  'What are you dreaming up?',
  'I’ll find your next step!',
  'Psst — my eyes follow you 👀'
];

const bitChips = ['A new website', 'Automate my leads', 'Just saying hi 👋'];

const sparkles = [
  { left: '13%', top: '22%', delay: '0s', size: '13px' },
  { left: '80%', top: '17%', delay: '.9s', size: '10px' },
  { left: '87%', top: '58%', delay: '1.7s', size: '15px' },
  { left: '9%', top: '63%', delay: '2.4s', size: '11px' },
  { left: '30%', top: '11%', delay: '3.1s', size: '9px' }
];

export function BitChatPreview({ onOpen }) {
  const [greeting, setGreeting] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const timer = window.setInterval(() => setGreeting(line => (line + 1) % bitGreetings.length), 3200);
    return () => window.clearInterval(timer);
  }, []);

  return <button className="bitchat-preview" type="button" onClick={onOpen} aria-label="Open Bit, BiteSites' AI chat receptionist">
    <span className="bitchat-glow" aria-hidden="true" />
    <span className="bitchat-sparkles" aria-hidden="true">
      {sparkles.map(sparkle => <i key={sparkle.left + sparkle.top} style={{ left: sparkle.left, top: sparkle.top, animationDelay: sparkle.delay, fontSize: sparkle.size }}>✦</i>)}
    </span>
    <span className="bitchat-tools" aria-hidden="true"><i /><i /><i /></span>
    <span className="bitchat-stage">
      <span className="bitchat-say" key={greeting}>{bitGreetings[greeting]}</span>
      <span className="bitchat-mascot"><BitMascot /></span>
      <span className="bitchat-shadow" aria-hidden="true" />
    </span>
    <span className="bitchat-chips" aria-hidden="true">{bitChips.map(chip => <i key={chip}>{chip}</i>)}</span>
    <span className="bitchat-typing" aria-hidden="true"><i /><i /><i /></span>
    <span className="bitchat-prompt">Click to chat with Bit</span>
    <span className="voice-preview-badge"><i /> AI chat agent demo</span>
  </button>;
}
