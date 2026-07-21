// Behavioural overview, built from the first-party events written by
// src/lib/analytics.js.
//
// Aggregation happens here in the browser rather than in a pipeline. For the
// volumes a marketing site produces that is the right trade: nothing to
// maintain, and the numbers are never stale. Twice the selected window is
// fetched so each figure can be compared against the period before it — a
// number without a direction is hard to act on.

import React, { useMemo, useState } from 'react';
import { useEvents, useLeads, cutoffDay, EVENT_CAP } from './data';
import { StatTile, TrendChart, RankList, Funnel, HeatMap, ShareBar, compact, share } from './charts';

const RANGES = [[7, '7d'], [30, '30d'], [90, '90d']];
const SCROLL_MARKS = [25, 50, 75, 100];

const shortDay = key => {
  const [, month, day] = key.split('-');
  return `${Number(month)}/${Number(day)}`;
};

const fullDay = key =>
  new Date(`${key}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  });

const rank = (map, count = 7) =>
  [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, count);

const delta = (now, before) => {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
};

function summarise(events) {
  const sessions = new Set();
  const visitors = new Set();
  const byDay = new Map();
  const live = new Map();
  const dead = new Map();
  const sections = new Map();
  const devices = new Map([['desktop', 0], ['mobile', 0], ['tablet', 0]]);
  const depth = SCROLL_MARKS.map(() => new Set());
  const clicks = [];
  let pageViews = 0;
  let formStarts = 0;
  let chatOpens = 0;
  let callOpens = 0;

  for (const event of events) {
    if (event.sid) sessions.add(event.sid);
    if (event.vid) visitors.add(event.vid);

    switch (event.type) {
      case 'page_view':
        pageViews += 1;
        byDay.set(event.day, (byDay.get(event.day) || 0) + 1);
        if (devices.has(event.device)) devices.set(event.device, devices.get(event.device) + 1);
        break;
      case 'click': {
        const label = event.label || 'unlabelled';
        const target = event.interactive ? live : dead;
        target.set(label, (target.get(label) || 0) + 1);
        if (typeof event.x === 'number' && typeof event.y === 'number') {
          clicks.push({ x: event.x, y: event.y, interactive: !!event.interactive });
        }
        break;
      }
      case 'section_view':
        if (event.section) sections.set(event.section, (sections.get(event.section) || 0) + 1);
        break;
      case 'scroll_depth': {
        const index = SCROLL_MARKS.indexOf(event.value);
        if (index >= 0 && event.sid) depth[index].add(event.sid);
        break;
      }
      case 'form_start': formStarts += 1; break;
      case 'chat_open': chatOpens += 1; break;
      case 'call_open': callOpens += 1; break;
      default: break;
    }
  }

  return {
    sessions: sessions.size,
    visitors: visitors.size,
    pageViews,
    formStarts,
    chatOpens,
    callOpens,
    trend: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => ({ key, value, short: shortDay(key), full: fullDay(key) })),
    topClicks: rank(live),
    deadClicks: rank(dead, 6),
    sections: rank(sections),
    devices: [
      { label: 'Desktop', value: devices.get('desktop') },
      { label: 'Mobile', value: devices.get('mobile') },
      { label: 'Tablet', value: devices.get('tablet') }
    ],
    depth: SCROLL_MARKS.map((mark, index) => ({ label: `${mark}% of page`, count: depth[index].size })),
    clicks
  };
}

export default function Overview() {
  const [days, setDays] = useState(30);
  // Two windows, so every figure has a period-over-period comparison.
  const { rows: events, loading, error, capped, refresh } = useEvents(days * 2);
  const { rows: leads } = useLeads();

  const { current, previous } = useMemo(() => {
    const start = cutoffDay(days);
    return {
      current: summarise(events.filter(event => event.day >= start)),
      previous: summarise(events.filter(event => event.day < start))
    };
  }, [events, days]);

  const leadCounts = useMemo(() => {
    const now = Date.now();
    const window = days * 86400000;
    let inRange = 0;
    let before = 0;
    for (const lead of leads) {
      const at = lead.createdAt?.toDate?.();
      if (!at) continue;
      const age = now - at.getTime();
      if (age <= window) inRange += 1;
      else if (age <= window * 2) before += 1;
    }
    return { inRange, before };
  }, [leads, days]);

  const deviceTotal = current.devices.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Overview</h1>
          <p className="admin-topbar-sub">How visitors are using the site.</p>
        </div>
        <div className="admin-topbar-spacer" />
        <div className="admin-filters">
          <div className="admin-segment" role="group" aria-label="Date range">
            {RANGES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={days === value}
                onClick={() => setDays(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
        </div>
      </header>

      <div className={`admin-body ${loading ? 'is-refreshing' : ''}`}>
        {error && <p className="admin-error">{error}</p>}
        {capped && (
          <p className="admin-note">
            Showing the most recent {compact(EVENT_CAP)} events. The range holds more, so these
            totals are a floor rather than the full count.
          </p>
        )}

        <div className="admin-grid cols-4">
          <StatTile
            label="Visitors"
            value={current.visitors}
            delta={delta(current.visitors, previous.visitors)}
            foot="unique browsers"
          />
          <StatTile
            label="Sessions"
            value={current.sessions}
            delta={delta(current.sessions, previous.sessions)}
          />
          <StatTile
            label="Page views"
            value={current.pageViews}
            delta={delta(current.pageViews, previous.pageViews)}
            trend={current.trend.map(point => point.value)}
          />
          <StatTile
            label="Leads"
            value={leadCounts.inRange}
            delta={delta(leadCounts.inRange, leadCounts.before)}
            foot={current.sessions ? `${share(leadCounts.inRange, current.sessions)}% of sessions` : undefined}
          />
        </div>

        <div className="admin-card">
          <div className="card-head">
            <div>
              <h3>Page views</h3>
              <p>Daily, across the selected range.</p>
            </div>
          </div>
          <TrendChart data={current.trend} label="Views" />
        </div>

        <div className="admin-grid cols-2">
          <div className="admin-card">
            <div className="card-head">
              <div>
                <h3>Most clicked</h3>
                <p>Controls people actually used.</p>
              </div>
            </div>
            <RankList rows={current.topClicks} empty="No clicks recorded yet." />
          </div>

          <div className="admin-card">
            <div className="card-head">
              <div>
                <h3>Clicks that hit nothing</h3>
                <p>Repeated dead clicks usually mean people expected something to be interactive.</p>
              </div>
            </div>
            <RankList rows={current.deadClicks} dead empty="No dead clicks — good sign." />
          </div>

          <div className="admin-card">
            <div className="card-head">
              <div>
                <h3>Scroll depth</h3>
                <p>Share of sessions reaching each point in the page.</p>
              </div>
            </div>
            <Funnel steps={current.depth} total={current.sessions} />
          </div>

          <div className="admin-card">
            <div className="card-head">
              <div>
                <h3>Sections reached</h3>
                <p>Counted after half a second in view, not a passing glance.</p>
              </div>
            </div>
            <RankList rows={current.sections} empty="No section views recorded yet." />
          </div>

          <div className="admin-card">
            <div className="card-head">
              <div><h3>Devices</h3></div>
            </div>
            <ShareBar segments={current.devices} total={deviceTotal} />
          </div>

          <div className="admin-card">
            <div className="card-head">
              <div>
                <h3>Engagement</h3>
                <p>Where people went beyond reading.</p>
              </div>
            </div>
            <RankList
              rows={[
                { label: 'Started a form', value: current.formStarts },
                { label: 'Opened Bit chat', value: current.chatOpens },
                { label: 'Opened Byte call', value: current.callOpens }
              ]}
              empty="No engagement events yet."
            />
          </div>
        </div>

        <div className="admin-card">
          <div className="card-head">
            <div>
              <h3>Click map</h3>
              <p>Every click, binned by position — horizontal is across the viewport, vertical is depth through the page.</p>
            </div>
          </div>
          <HeatMap clicks={current.clicks} />
        </div>
      </div>
    </>
  );
}
