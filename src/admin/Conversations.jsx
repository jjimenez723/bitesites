// Transcripts for both agents.
//
// Bit (chat) is ours end to end, so `messages` holds the whole exchange.
// Byte (voice) runs on the GoHighLevel widget, which owns the audio — what we
// hold first-party is the session shape: a timeline of state changes, whatever
// transcript the widget rendered, and how the call ended.
//
// Turns load only when a conversation is opened. Fetching every transcript to
// render a table would be a lot of reads for text nobody asked to see.

import React, { useState } from 'react';
import { useConversations, toDate } from './data';
import { Panel, DetailRows, Pill } from './Panel';
import Transcript from './Transcript';

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
              <Transcript collection={tab.key} sub={tab.sub} agent={tab.agent} id={open.id} />
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}
