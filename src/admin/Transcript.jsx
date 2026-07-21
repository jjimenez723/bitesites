// One conversation's turns, rendered as a thread.
//
// Shared by Conversations (browsing chats and calls) and Leads (a Byte lead
// carries the call it came from, and the transcript is the context that makes
// it worth acting on). Turns load on demand — fetching every transcript to draw
// a table would be a lot of reads for text nobody asked to see.

import React, { useEffect, useState } from 'react';
import { loadTurns, toDate } from './data';

const clock = value => {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
};

export default function Transcript({ collection, sub, agent, id }) {
  const [turns, setTurns] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setTurns(null);
    setError('');
    loadTurns(collection, id, sub)
      .then(result => { if (!cancelled) setTurns(result); })
      .catch(err => { if (!cancelled) setError(err?.message || 'Could not load the transcript.'); });
    return () => { cancelled = true; };
  }, [collection, sub, id]);

  if (error) return <p className="admin-error">{error}</p>;
  if (!turns) return <div className="skeleton" style={{ height: 90 }} />;

  if (!turns.length) {
    return (
      <div className="admin-empty">
        <strong>No transcript</strong>
        {collection === 'calls'
          ? 'The widget did not render one, and no call summary has been posted back.'
          : 'No messages were recorded for this chat.'}
      </div>
    );
  }

  return (
    <div className="transcript">
      {turns.map(turn => {
        if (turn.kind === 'state') {
          return (
            <div className="turn state" key={turn.id}>
              <div className="turn-bubble">{turn.state}</div>
            </div>
          );
        }
        const isVisitor = turn.role === 'visitor';
        return (
          <div className={`turn ${isVisitor ? 'visitor' : 'agent'}`} key={turn.id}>
            <div className="turn-bubble">{turn.text}</div>
            <div className="turn-meta">
              <span>{isVisitor ? 'Visitor' : agent}</span>
              {turn.kind === 'choice' && <span>tapped</span>}
              {clock(turn.at) && <span>{clock(turn.at)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
