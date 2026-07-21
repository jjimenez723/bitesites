// Chart primitives for the console.
//
// Hand-rolled SVG/CSS rather than a charting library — the whole set is a few
// hundred lines and keeps a dependency only the dashboard uses out of the
// marketing bundle. Every class here is defined in admin.css; the colours come
// from its custom properties, never from literals in this file.
//
// The specs those classes encode: 2px lines with round joins, dots ringed in
// the surface colour, hairline recessive gridlines, rounded data-ends, one
// filter row above the cards, a legend whenever more than one series is shown,
// and labels in text tokens rather than the series colour.

import React, { useMemo, useState } from 'react';

// ------------------------------------------------------------- formatting

export function compact(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString();
}

export const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
export const percent = (part, whole) => `${share(part, whole)}%`;

// -------------------------------------------------------------- stat tile

export function StatTile({ label, value, foot, delta, trend }) {
  const points = trend?.length > 1 ? trend : null;
  const max = points ? Math.max(...points, 1) : 1;
  const direction = delta == null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  return (
    <div className="admin-card stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{typeof value === 'number' ? compact(value) : value}</span>
      {(foot || direction) && (
        <span className="stat-foot">
          {direction && (
            <b className={`stat-delta ${direction}`}>
              {delta > 0 ? '+' : ''}{delta}%
            </b>
          )}
          {foot}
        </span>
      )}
      {points && (
        // Context, not a readable series: no axes, no labels, no markers.
        <svg className="stat-spark" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
          <polyline
            className="chart-line"
            points={points.map((p, i) => `${(i / (points.length - 1)) * 100},${32 - (p / max) * 30}`).join(' ')}
            stroke="var(--s1)"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </div>
  );
}

// ------------------------------------------------------------ trend chart

/** One series over time. Crosshair + tooltip on hover; only the last point is dotted. */
export function TrendChart({ data, label = 'Views', height = 220 }) {
  const [hover, setHover] = useState(null);

  const { points, max, width } = useMemo(() => {
    const w = 720;
    const m = Math.max(1, ...data.map(d => d.value));
    const left = 34;
    const right = w - 12;
    return {
      width: w,
      max: m,
      points: data.map((d, i) => ({
        ...d,
        x: data.length === 1 ? (left + right) / 2 : left + (i / (data.length - 1)) * (right - left),
        y: height - 26 - (d.value / m) * (height - 48)
      }))
    };
  }, [data, height]);

  if (!data.length) {
    return <div className="admin-empty"><strong>No activity yet</strong>Traffic will appear here once people visit.</div>;
  }

  const line = points.map(p => `${p.x},${p.y}`).join(' ');
  const last = points[points.length - 1];
  const ticks = [0, Math.round(max / 2), max];
  const bandWidth = (width - 46) / points.length;

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} over time`}>
        <g className="chart-grid">
          {ticks.map(tick => {
            const y = height - 26 - (tick / max) * (height - 48);
            return <line key={tick} x1="34" x2={width - 12} y1={y} y2={y} />;
          })}
        </g>
        <g className="chart-axis">
          {ticks.map(tick => {
            const y = height - 26 - (tick / max) * (height - 48);
            return <text key={tick} x="0" y={y + 3.5}>{compact(tick)}</text>;
          })}
          {points.map((point, index) =>
            index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2) ? (
              <text key={point.key} x={point.x} y={height - 6} textAnchor="middle">{point.short}</text>
            ) : null
          )}
        </g>

        {hover && <line className="chart-crosshair" x1={hover.x} x2={hover.x} y1="6" y2={height - 26} />}

        <polyline className="chart-line" points={line} stroke="var(--s1)" />
        <circle className="chart-dot" cx={last.x} cy={last.y} r="4.5" fill="var(--s1)" />
        {hover && <circle className="chart-dot" cx={hover.x} cy={hover.y} r="4.5" fill="var(--s1)" />}

        {points.map(point => (
          <rect
            key={`hit-${point.key}`}
            x={point.x - bandWidth / 2}
            y="0"
            width={bandWidth}
            height={height - 26}
            fill="transparent"
            onMouseEnter={() => setHover(point)}
          />
        ))}
      </svg>

      {hover && (
        <div className="chart-tooltip" style={{ left: `${(hover.x / width) * 100}%`, top: `${hover.y - 12}px` }} role="status">
          <strong>{hover.full}</strong>
          <span className="chart-tooltip-row">
            <i style={{ background: 'var(--s1)' }} />
            {label}
            <b>{compact(hover.value)}</b>
          </span>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- rank list

/** Ranked magnitude. One series, one colour, value outside the bar end. */
export function RankList({ rows, dead = false, empty = 'Nothing recorded yet.' }) {
  if (!rows.length) return <div className="admin-empty">{empty}</div>;
  const max = Math.max(...rows.map(r => r.value), 1);

  return (
    <div className="rank-list">
      {rows.map(row => (
        <div className={`rank-row ${dead ? 'dead' : ''}`} key={row.key ?? row.label} title={row.label}>
          <span className="rank-name">
            {row.label}
            {row.note && <small> · {row.note}</small>}
          </span>
          <span className="rank-value">{compact(row.value)}</span>
          <span className="rank-track">
            <span className="rank-fill" style={{ width: `${Math.max(1.5, (row.value / max) * 100)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- funnel

/** Ordered stages, so an ordinal ramp — never categorical hues for a sequence. */
export function Funnel({ steps, total }) {
  if (!total) return <div className="admin-empty">No scroll data yet.</div>;

  return (
    <div className="funnel">
      {steps.map((step, index) => {
        const pct = share(step.count, total);
        // Only label inside the bar when the text demonstrably fits.
        const inside = pct >= 22;
        return (
          <div className="funnel-step" key={step.label}>
            <div
              className="funnel-bar"
              style={{ width: `${Math.max(4, pct)}%`, background: `var(--seq-${index + 1})` }}
            >
              {inside && <span>{pct}%</span>}
            </div>
            <div className="funnel-meta">
              <strong>{step.label}</strong>
              <small>{compact(step.count)} sessions{!inside ? ` · ${pct}%` : ''}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------- heat grid

const HEAT_COLS = 18;
const HEAT_ROWS = 12;

/**
 * Click density, binned into a grid. Density is a continuous magnitude, so this
 * is sequential — one hue, stepped. On a dark surface "more" reads as brighter,
 * so the ramp runs from the darkest step at the low end to the lightest at the
 * high end, and the legend states that direction rather than assuming it.
 */
export function HeatMap({ clicks }) {
  const [hover, setHover] = useState(null);

  const { cells, max } = useMemo(() => {
    const grid = new Array(HEAT_COLS * HEAT_ROWS).fill(0);
    const dead = new Array(HEAT_COLS * HEAT_ROWS).fill(0);
    for (const click of clicks) {
      const col = Math.min(HEAT_COLS - 1, Math.max(0, Math.floor(click.x * HEAT_COLS)));
      const row = Math.min(HEAT_ROWS - 1, Math.max(0, Math.floor(click.y * HEAT_ROWS)));
      const index = row * HEAT_COLS + col;
      grid[index] += 1;
      if (!click.interactive) dead[index] += 1;
    }
    return { cells: grid.map((count, i) => ({ count, dead: dead[i] })), max: Math.max(1, ...grid) };
  }, [clicks]);

  if (!clicks.length) {
    return <div className="admin-empty"><strong>No clicks recorded</strong>They appear here as people use the site.</div>;
  }

  // Five buckets: darkest step = least, lightest = most.
  const stepFor = count => {
    if (!count) return null;
    const ratio = count / max;
    if (ratio > .75) return 1;
    if (ratio > .5) return 2;
    if (ratio > .25) return 3;
    if (ratio > .1) return 4;
    return 5;
  };

  return (
    <>
      <div className="heat">
        <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${HEAT_COLS}, 1fr)` }}>
          {cells.map((cell, index) => {
            const step = stepFor(cell.count);
            return (
              <div
                key={index}
                className="heat-cell"
                style={{ background: step ? `var(--seq-${step})` : 'transparent' }}
                onMouseEnter={() => cell.count && setHover({ ...cell, index })}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </div>
        {hover && (
          <div
            className="chart-tooltip"
            style={{
              left: `${((hover.index % HEAT_COLS) + .5) * (100 / HEAT_COLS)}%`,
              top: `${Math.floor(hover.index / HEAT_COLS) * (100 / HEAT_ROWS)}%`
            }}
            role="status"
          >
            <strong>This area</strong>
            <span className="chart-tooltip-row">Clicks<b>{hover.count}</b></span>
            {hover.dead > 0 && <span className="chart-tooltip-row">Hit nothing<b>{hover.dead}</b></span>}
          </div>
        )}
      </div>
      <div className="heat-scale">
        Fewer
        <span className="heat-scale-steps">
          {[5, 4, 3, 2, 1].map(step => (
            <i key={step} style={{ background: `var(--seq-${step})` }} />
          ))}
        </span>
        More
      </div>
    </>
  );
}

// ----------------------------------------------------------------- legend

export function Legend({ items }) {
  return (
    <div className="chart-legend">
      {items.map(item => (
        <span key={item.label}>
          <i style={{ background: item.color }} />
          {item.label}
          {item.value != null && <b>&nbsp;{item.value}</b>}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- share bar

/**
 * Part-to-whole across a few categories. Segments are separated by a gap in the
 * page colour rather than a stroke, and the legend always carries identity so
 * nothing depends on colour matching alone.
 */
export function ShareBar({ segments, total }) {
  const [hover, setHover] = useState(null);
  if (!total) return <div className="admin-empty">No sessions recorded yet.</div>;

  return (
    <div className="chart-wrap">
      <div style={{ display: 'flex', gap: 2, height: 22 }}>
        {segments.filter(s => s.value > 0).map((segment, index) => (
          <div
            key={segment.label}
            style={{
              width: `${(segment.value / total) * 100}%`,
              background: `var(--s${index + 1})`,
              borderRadius: 5,
              cursor: 'default'
            }}
            onMouseEnter={() => setHover(segment)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>
      <Legend
        items={segments.map((segment, index) => ({
          label: segment.label,
          color: `var(--s${index + 1})`,
          value: percent(segment.value, total)
        }))}
      />
      {hover && (
        <div className="chart-tooltip" style={{ left: '50%', top: '-6px' }} role="status">
          <strong>{hover.label}</strong>
          <span className="chart-tooltip-row">Sessions<b>{compact(hover.value)}</b></span>
        </div>
      )}
    </div>
  );
}
