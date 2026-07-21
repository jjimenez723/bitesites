// Transcripts for both agents.
//
// Bit (chat) is ours end to end, so `messages` holds the whole exchange.
// Byte (voice) runs on the GoHighLevel widget, which owns the audio — what we
// hold first-party is the session shape: a timeline of state changes, whatever
// transcript the widget rendered, and how the call ended.
//
// Turns load only when a conversation is opened. Fetching every transcript to
// render a table would be a lot of reads for text nobody asked to see.

import React, { useEffect, useState } from 'react';
import { useConversations, loadTurns, toDate } from './data';
import { Panel, DetailRows, Pill } from './Panel';

const TABS = [
  { key: 'chats', label: 'Bit · chat', sub: 'messages', agent: 'Bit' },
  { key: 'calls', label: 'Byte · voice', sub: 'turns', agent: 'Byte' }
];

const when = value => {
  const date = toDate(value);
  return date
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—';
};

const clock = value => {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
};

function duration(row) {
  let seconds = row.durationSec;
  if (typeof seconds !== 'number' || seconds <= 0) {
    const start = toDate(row.startedAt);
    const end = toDate(row.endedAt);
    if (!start || !end) return '';
    seconds = Math.max(0, Math.round((end - start) / 1000));
  }
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function Transcript({ tab, row }) {
  const [turns, setTurns] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setTurns(null);
    setError('');
    loadTurns(tab.key, row.id, tab.sub)
      .then(result => { if (!cancelled) setTurns(result); })
      .catch(err => { if (!cancelled) setError(err?.message || 'Could not load the transcript.'); });
    return () => { cancelled = true; };
  }, [tab.key, tab.sub, row.id]);

  if (error) return <p className="admin-error">{error}</p>;
  if (!turns) return <div className="skeleton" style={{ height: 90 }} />;

  if (!turns.length) {
    return (
      <div className="admin-empty">
        <strong>No transcript</strong>
        {tab.key === 'calls'
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
              <span>{isVisitor ? 'Visitor' : tab.agent}</span>
              {turn.kind === 'choice' && <span>tapped</span>}
              {clock(turn.at) && <span>{clock(turn.at)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Conversations() {
  const [tabIndex, setTabIndex] = useState(0);
  const tab = TABS[tabIndex];
  const { rows, loading, error, refresh } = useConversations(tab.key, 'startedAt');
  const [openId, setOpenId] = useState(null);

  const open = rows.find(row => row.id === openId) || null;

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Conversations</h1>
          <p className="admin-topbar-sub">What people asked the agents, and how it went.</p>
        </div>
        <div className="admin-topbar-spacer" />
        <div className="admin-filters">
          <div className="admin-segment" role="group" aria-label="Agent">
            {TABS.map((entry, index) => (
              <button
                key={entry.key}
                type="button"
                aria-pressed={tabIndex === index}
                onClick={() => { setTabIndex(index); setOpenId(null); }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
        </div>
      </header>

      <div className={`admin-body ${loading ? 'is-refreshing' : ''}`}>
        {error && <p className="admin-error">{error}</p>}

        <div className="admin-card">
          {!rows.length ? (
            <div className="admin-empty">
              <strong>No {tab.key === 'chats' ? 'chats' : 'calls'} yet</strong>
              They appear here as soon as someone talks to {tab.agent}.
            </div>
          ) : (
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Page</th>
                    <th className="num">{tab.key === 'chats' ? 'Messages' : 'Duration'}</th>
                    <th>Outcome</th>
                    <th>Lead</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr
                      key={row.id}
                      className={`clickable ${openId === row.id ? 'selected' : ''}`}
                      onClick={() => setOpenId(row.id)}
                    >
                      <td className="cell-strong">{when(row.startedAt)}</td>
                      <td className="cell-dim cell-wrap">{row.path || '/'}</td>
                      <td className="num">
                        {tab.key === 'chats' ? (row.messageCount || 0) : (duration(row) || '—')}
                      </td>
                      <td><Pill kind={row.status}>{row.status}</Pill></td>
                      <td className="cell-dim">{row.leadId ? 'Converted' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {open && (
        <Panel
          title={`${tab.agent} · ${when(open.startedAt)}`}
          subtitle={open.path || '/'}
          onClose={() => setOpenId(null)}
        >
          <DetailRows
            rows={[
              ['Status', <Pill kind={open.status}>{open.status}</Pill>],
              ['Started', when(open.startedAt)],
              ['Ended', open.endedAt ? when(open.endedAt) : ''],
              ['Duration', duration(open)],
              ['Messages', typeof open.messageCount === 'number' && open.messageCount ? open.messageCount : ''],
              ['Lead', open.leadId],
              ['Error', open.error]
            ]}
          />

          {open.answers && Object.keys(open.answers).length > 0 && (
            <div>
              <div className="panel-section-label">Answers</div>
              <div className="chip-row" style={{ marginTop: 10 }}>
                {Object.entries(open.answers).map(([key, value]) => (
                  <span className="chip" key={key}><b>{key}</b> {value}</span>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="panel-section-label">Transcript</div>
            <div style={{ marginTop: 12 }}>
              <Transcript tab={tab} row={open} />
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}
