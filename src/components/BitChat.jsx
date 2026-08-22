// Bit's chat window.
//
// This used to be a three-question quiz with a fake 1.8-second "thinking"
// pause: whatever a visitor typed was stored and never read, and the next
// canned question appeared regardless. The shell was good — the full-bleed
// reveal, the mascot, the composer — so the shell is what survived. Everything
// behind it now talks to a real agent in functions/bit-chat.js.
//
// The division of labour is strict, and it is what keeps this file small: the
// server owns the conversation (history, tools, the booking, what Bit is
// allowed to say), and this component owns what a person sees. It sends a
// sentence, renders what comes back, and never decides anything about the
// conversation itself. Two consequences worth knowing:
//
//   * Links are never composed here. A link card exists only because the
//     server returned one from its fixed whitelist, so the model cannot put an
//     arbitrary URL on BiteSites' homepage.
//   * The rotating thinking lines are finally honest. They run while a real
//     round trip is in flight, and they stop when it lands.
//
// The props are unchanged from the scripted version — `onClose`, `origin`,
// `initialAnswer` — so the page's open/close wiring did not have to move.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { BitMascot } from './BitMascot';
import { bitChips } from './BitChatPreview';
import ConversationRating from './ConversationRating';
import { finishChat, logChatMessage, startChat } from '../lib/conversations';
import { sessionId as analyticsSessionId, trackEvent } from '../lib/analytics';
import { finalizeBitSession, openBitSession, sendBitMessage } from '../lib/bit-chat';
import logoWordmark from '../assets/bitesites-logo-wordmark.webp';

const MAX_MESSAGE_CHARS = 2000;

// Kept from the scripted era on purpose: they were always the best part, and
// now they play over genuine latency instead of a setTimeout.
const thinkingLines = [
  'Discombobulating the possibilities…',
  'Perplexing responsibly…',
  'Contemplating in several dimensions…',
  'Consulting the tiny committee in my circuits…',
  'Warming up the idea kiln…',
  'Doing a little digital chin-stroking…',
  'Connecting the delightfully odd dots…',
  'Rummaging through the good ideas drawer…',
  'Mulling it over with great enthusiasm…',
  'Cogitando con estilo…',
  'Réfléchissant à haute voix, mais en silence…',
  'Ein bisschen Gehirn-Yoga…',
  'Pondering the cosmic spreadsheet…',
  'Asking the pixels nicely…',
  'Brewing a fresh batch of useful thoughts…'
];

const UNAVAILABLE_MESSAGE = 'I cannot get to my brain right now — which is embarrassing for an AI. ✦ Grab a time with the team directly and they will pick this up properly.';

const BOOKING_CARD = {
  type: 'link',
  destination: 'booking',
  href: '/book',
  label: 'Book a free 20-minute consultation',
  detail: 'Pick a time on the real calendar. No signup, no obligation.'
};

/** Server chips arrive as { label, send }; the seeded ones are plain strings. */
const asChip = chip => (typeof chip === 'string' ? { label: chip, send: chip } : chip);

export function BitChat({ onClose, origin, initialAnswer }) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState([]);
  const [chips, setChips] = useState(() => bitChips.map(asChip));
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingLine, setThinkingLine] = useState(0);
  const [ended, setEnded] = useState(false);
  const bodyRef = useRef(null);
  const hasRenderedRef = useRef(false);

  // Transcript capture. The chat document is created asynchronously, so turns
  // that happen before it exists are buffered and replayed once it does —
  // otherwise a fast first tap would be missing from the transcript.
  const chatIdRef = useRef('');
  const bufferRef = useRef([]);
  const closedRef = useRef(false);
  const countRef = useRef(0);
  const turnsRef = useRef(0);
  const outcomeRef = useRef('abandoned');
  const leadIdRef = useRef('');
  const sessionRef = useRef(null);
  // The agent session and the visitor's first message race on open, so the
  // send path awaits this promise rather than a piece of state.
  const readyRef = useRef(null);
  const busyRef = useRef(false);

  const record = (role, text, kind = 'text') => {
    if (!text) return;
    countRef.current += 1;
    const turn = { role, text, kind };
    if (chatIdRef.current) logChatMessage(chatIdRef.current, turn);
    else bufferRef.current.push(turn);
  };

  const push = entry => setEntries(current => [...current, { key: `${current.length}-${entry.role}`, ...entry }]);

  useEffect(() => {
    trackEvent('chat_open', { label: 'Bit chat receptionist' });

    startChat().then(id => {
      if (!id) return;
      if (closedRef.current) {
        // Opened and closed before the document landed — close it out now so it
        // is not left hanging as an "open" conversation forever.
        finishChat(id, { outcome: outcomeRef.current, messageCount: countRef.current });
        return;
      }
      chatIdRef.current = id;
      for (const turn of bufferRef.current.splice(0)) logChatMessage(id, turn);
    });

    // The greeting is the server's, not a copy in this bundle — so the words a
    // visitor reads and the words in Bit's persona can never drift apart.
    readyRef.current = openBitSession({
      sid: analyticsSessionId(),
      path: window.location?.pathname || '/'
    }).then(session => {
      if (closedRef.current) {
        finalizeBitSession(session, 'client_ended');
        return null;
      }
      sessionRef.current = session;
      if (session?.greeting) {
        // A visitor who arrived with an opening line gets an answer, not a
        // hello they have already walked past.
        if (!initialAnswer?.label) {
          push({ role: 'bit', text: session.greeting });
          record('bit', session.greeting, 'system');
        }
      } else {
        push({ role: 'bit', text: UNAVAILABLE_MESSAGE });
        push({ role: 'card', card: BOOKING_CARD });
        record('bit', UNAVAILABLE_MESSAGE, 'system');
        setChips([]);
      }
      return session;
    });

    return () => {
      closedRef.current = true;
      finalizeBitSession(sessionRef.current, 'client_ended');
      finishChat(chatIdRef.current, {
        outcome: outcomeRef.current,
        leadId: leadIdRef.current,
        messageCount: countRef.current
      });
    };
  }, []);

  // Opened straight from the preview card with an answer already chosen: that
  // choice is the visitor's opening line, not a stored form value.
  useEffect(() => {
    if (initialAnswer?.label) send(initialAnswer.label);
  }, []);

  useEffect(() => {
    if (!isThinking) return undefined;
    const timer = window.setInterval(() => setThinkingLine(line => (line + 1) % thinkingLines.length), 1100);
    return () => window.clearInterval(timer);
  }, [isThinking]);

  useEffect(() => {
    if (!hasRenderedRef.current) {
      hasRenderedRef.current = true;
      bodyRef.current?.scrollTo({ top: 0 });
      return;
    }
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries, isThinking, chips, ended]);

  useLayoutEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') onClose(); };
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.setProperty('--bit-scrollbar-width', `${scrollbarWidth}px`);
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('bit-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('bit-open');
      document.body.style.removeProperty('--bit-scrollbar-width');
    };
  }, [onClose]);

  async function send(raw) {
    const message = String(raw || '').trim().slice(0, MAX_MESSAGE_CHARS);
    if (!message || busyRef.current || ended) return;

    busyRef.current = true;
    turnsRef.current += 1;
    push({ role: 'visitor', text: message });
    record('visitor', message);
    trackEvent('chat_progress', { step: 'message', value: turnsRef.current });
    setChips([]);
    setIsThinking(true);

    const session = sessionRef.current || await readyRef.current;
    const reply = session ? await sendBitMessage(session, message) : null;

    if (closedRef.current) return;

    if (!reply) {
      push({ role: 'bit', text: UNAVAILABLE_MESSAGE });
      push({ role: 'card', card: BOOKING_CARD });
      record('bit', UNAVAILABLE_MESSAGE, 'system');
      outcomeRef.current = outcomeRef.current === 'converted' ? 'converted' : 'failed';
      setIsThinking(false);
      busyRef.current = false;
      return;
    }

    for (const text of (reply.messages || [])) {
      push({ role: 'bit', text });
      record('bit', text);
    }
    for (const card of (reply.cards || [])) push({ role: 'card', card });
    setChips((reply.chips || []).map(asChip));

    if (reply.leadId && reply.leadId !== leadIdRef.current) {
      leadIdRef.current = reply.leadId;
      outcomeRef.current = 'converted';
      trackEvent('lead_created', { label: 'Bit chat', leadId: reply.leadId, source: 'bit_chat' });
    }
    if (reply.ended) {
      setEnded(true);
      if (outcomeRef.current === 'abandoned') outcomeRef.current = 'converted';
    }

    setIsThinking(false);
    busyRef.current = false;
  }

  // Where a submitted rating gets filed, and whether Bit already asked for one.
  // Both are read off state we already hold, so there is no third place for the
  // answer to be wrong.
  const ratingSource = {
    sourceType: chatIdRef.current ? 'chat' : 'lead',
    sourceId: chatIdRef.current || leadIdRef.current
  };
  const ratingAsked = entries.some(entry => entry.card?.type === 'rating');

  /** Internal navigation only — every href came from the server's whitelist. */
  const followLink = href => {
    const [path, hash] = String(href).split('#');
    onClose();
    navigate(path || '/');
    if (hash) window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }), 140);
  };

  const submit = event => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setDraft('');
    send(message);
  };

  const finishReveal = event => {
    if (event.target === event.currentTarget && event.animationName === 'bitReveal') event.currentTarget.classList.add('bit-ready');
  };

  return <aside
    className="bit-window"
    onAnimationEnd={finishReveal}
    style={{ '--bit-x': `${origin?.x ?? window.innerWidth - 58}px`, '--bit-y': `${origin?.y ?? window.innerHeight - 52}px` }}
    aria-labelledby="receptionist-title"
    role="dialog"
    aria-modal="true"
  >
    <div className="bit-noise" aria-hidden="true" />
    <header className="bit-topbar">
      <a className="bit-wordmark" href="#top" onClick={onClose} aria-label="BiteSites — back to site"><img src={logoWordmark} alt="BiteSites" width="500" height="500" /></a>
      <div className="bit-agent"><span className="chat-presence" /> Bit is here</div>
      <button type="button" className="bit-close" onClick={onClose} aria-label="Close Bit">Close <span>×</span></button>
    </header>

    <div className="bit-stage" ref={bodyRef}>
      <div className="bit-intro">
        <div className="chat-avatar bit-avatar" aria-hidden="true"><BitMascot /></div>
        <p className="bit-kicker">Your BiteSites guide</p>
        <h2 id="receptionist-title">How can I help today?</h2>
        <p>Ask Bit anything — what we build, what it costs, or whether an agent like him would actually help your business.</p>
      </div>

      <div className="bit-conversation">
        {entries.map(entry => {
          if (entry.role === 'visitor') return <div className="bit-message user" key={entry.key}>{entry.text}</div>;
          if (entry.role === 'card') {
            if (entry.card?.type === 'rating') return <ConversationRating key={entry.key} agent="bit" {...ratingSource} />;
            return <BitCard card={entry.card} key={entry.key} onFollow={followLink} />;
          }
          return <div className="bit-turn" key={entry.key}>
            <span className="bit-turn-avatar" aria-hidden="true"><BitMascot /></span>
            <div className="chat-bubble bit-bubble">{entry.text}</div>
          </div>;
        })}

        {isThinking && <div className="bit-thinking" aria-live="polite"><span className="thinking-orb"><i /><i /><i /></span><span>{thinkingLines[thinkingLine]}</span></div>}

        {!isThinking && !ended && chips.length > 0 && <div className="bit-chips">
          {chips.map(chip => <button type="button" key={chip.label} onClick={() => send(chip.send)}>{chip.label}</button>)}
        </div>}

        {ended && !ratingAsked && <ConversationRating agent="bit" {...ratingSource} />}
      </div>
    </div>

    <form className="bit-composer" onSubmit={submit}>
      <textarea
        value={draft}
        maxLength={MAX_MESSAGE_CHARS}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(event); } }}
        placeholder={ended ? 'This chat has wrapped up — thanks for stopping by.' : 'Ask Bit anything…'}
        aria-label="Type your message to Bit"
        disabled={isThinking || ended}
        rows="1"
      />
      <button className="bit-send" type="submit" disabled={!draft.trim() || isThinking || ended} aria-label="Send message">↑</button>
      <p>Press Enter to send <span>·</span> Shift + Enter for a new line</p>
    </form>
  </aside>;
}

/**
 * The two things Bit can put on screen. Both are server-authored: a link card
 * names a destination from a fixed whitelist, and a booked card only exists
 * once the booking engine returned a confirmation reference.
 */
function BitCard({ card, onFollow }) {
  if (card?.type === 'booked') {
    return <div className="bit-card bit-card-booked">
      <span className="bit-card-tag">Booked ✦</span>
      <strong>{card.spoken}</strong>
      {card.confirmationRef && <small>Confirmation {card.confirmationRef} · check your inbox for the invitation</small>}
    </div>;
  }
  if (card?.type !== 'link' || !card.href) return null;
  return <div className="bit-card bit-card-link">
    <div>
      <strong>{card.label}</strong>
      {card.detail && <small>{card.detail}</small>}
    </div>
    <button type="button" onClick={() => onFollow(card.href)}>Open <span aria-hidden="true">→</span></button>
  </div>;
}

export default BitChat;
