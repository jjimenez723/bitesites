import React, { useEffect, useMemo, useRef, useState } from 'react';
import { geoGraticule10, geoOrthographic, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import worldTopology from 'world-atlas/countries-110m.json';
import { compact, share } from './charts';

const RAD = Math.PI / 180;
const TILT = -.18;
const MAX_TILT = Math.PI * .42;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WORLD_LAND = feature(worldTopology, worldTopology.objects.land);
const WORLD_BORDERS = mesh(
  worldTopology,
  worldTopology.objects.countries,
  (countryA, countryB) => countryA !== countryB
);
const WORLD_GRATICULE = geoGraticule10();
const TIME_WINDOWS = [
  { key: '24h', label: '24h', duration: DAY },
  { key: '7d', label: '7d', duration: 7 * DAY },
  { key: 'all', label: 'All', duration: null }
];

const flagFor = code => {
  if (!/^[A-Z]{2}$/.test(code || '')) return '◌';
  return String.fromCodePoint(...[...code].map(char => 127397 + char.charCodeAt(0)));
};

const locationLabel = point =>
  [point.city, point.region, point.country].filter(Boolean).join(', ') || 'Unknown location';

const formatMoment = at => new Date(at).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
});

const formatTimelineEdge = at => new Date(at).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric'
});

function buildTimeline(history, windowKey, rangeDays, now) {
  const selectedWindow = TIME_WINDOWS.find(option => option.key === windowKey) || TIME_WINDOWS[2];
  const duration = selectedWindow.duration || rangeDays * DAY;
  const step = duration <= DAY ? HOUR : duration <= 7 * DAY ? 6 * HOUR : duration <= 31 * DAY ? DAY : 3 * DAY;
  const binCount = Math.max(1, Math.ceil(duration / step));
  const end = now;
  const start = end - binCount * step;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    start: start + index * step,
    end: start + (index + 1) * step,
    count: 0
  }));
  const samples = history.filter(sample => sample.at >= start && sample.at <= end);

  for (const sample of samples) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((sample.at - start) / step)));
    bins[index].count += 1;
  }

  return { bins, samples, start, end };
}

function aggregateLocations(samples) {
  const points = new Map();
  for (const sample of samples) {
    const key = `${sample.lat}|${sample.lon}|${sample.city || ''}|${sample.countryCode || ''}`;
    const point = points.get(key) || {
      ...sample,
      key,
      value: 0,
      firstAt: sample.at,
      latestAt: sample.at
    };
    point.value += 1;
    point.firstAt = Math.min(point.firstAt || sample.at, sample.at);
    point.latestAt = Math.max(point.latestAt || sample.at, sample.at);
    points.set(key, point);
  }
  return [...points.values()].sort((a, b) => b.value - a.value);
}

function Globe({ locations, timeLabel }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const locationsRef = useRef(locations);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    locationsRef.current = locations;
    setHovered(null);
  }, [locations]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;

    const ctx = canvas.getContext('2d');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const projection = geoOrthographic().clipAngle(90).precision(.55);
    const mapPath = geoPath(projection, ctx);
    let reduceMotion = motion.matches;
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = performance.now();
    let yaw = locationsRef.current[0] ? -locationsRef.current[0].lon * RAD : -.7;
    let tilt = TILT;
    let dragging = false;
    let pointerId = null;
    let previousX = 0;
    let previousY = 0;
    let hoverKey = '';
    let projectedMarkers = [];

    const stars = Array.from({ length: 48 }, (_, index) => ({
      x: ((index * 67) % 101) / 100,
      y: ((index * 43 + 17) % 97) / 96,
      r: .35 + (index % 4) * .18,
      a: .12 + (index % 5) * .045
    }));

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const project = (lat, lon, radius, cx, cy) => {
      const phi = lat * RAD;
      const lambda = lon * RAD + yaw;
      const x = Math.cos(phi) * Math.sin(lambda);
      const y = Math.sin(phi);
      const z = Math.cos(phi) * Math.cos(lambda);
      const yy = y * Math.cos(tilt) - z * Math.sin(tilt);
      const zz = y * Math.sin(tilt) + z * Math.cos(tilt);
      return { x: cx + x * radius, y: cy - yy * radius, z: zz };
    };

    const draw = now => {
      const dt = Math.min(.05, (now - last) / 1000);
      last = now;
      if (!dragging && !reduceMotion) yaw += dt * .075;

      ctx.clearRect(0, 0, width, height);
      const cx = width * .5;
      const cy = height * .51;
      const radius = Math.min(width * .38, height * .405);
      projection
        .translate([cx, cy])
        .scale(radius)
        .rotate([yaw / RAD, -tilt / RAD]);

      for (const star of stars) {
        ctx.fillStyle = `rgba(190,218,255,${star.a})`;
        ctx.beginPath();
        ctx.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      ctx.shadowColor = 'rgba(54, 173, 255, .3)';
      ctx.shadowBlur = 34;
      const ocean = ctx.createRadialGradient(cx - radius * .35, cy - radius * .42, 0, cx, cy, radius);
      ocean.addColorStop(0, 'rgba(43, 102, 181, .56)');
      ocean.addColorStop(.58, 'rgba(15, 43, 88, .72)');
      ocean.addColorStop(1, 'rgba(4, 13, 32, .96)');
      ctx.fillStyle = ocean;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius - .4, 0, Math.PI * 2);
      ctx.clip();

      ctx.strokeStyle = 'rgba(117, 180, 236, .12)';
      ctx.lineWidth = .65;
      ctx.beginPath();
      mapPath(WORLD_GRATICULE);
      ctx.stroke();

      const landFill = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      landFill.addColorStop(0, 'rgba(73, 151, 166, .78)');
      landFill.addColorStop(.5, 'rgba(38, 103, 126, .82)');
      landFill.addColorStop(1, 'rgba(23, 57, 83, .92)');
      ctx.fillStyle = landFill;
      ctx.beginPath();
      mapPath(WORLD_LAND);
      ctx.fill();

      ctx.strokeStyle = 'rgba(152, 217, 220, .34)';
      ctx.lineWidth = .75;
      ctx.beginPath();
      mapPath(WORLD_LAND);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(169, 218, 226, .16)';
      ctx.lineWidth = .45;
      ctx.beginPath();
      mapPath(WORLD_BORDERS);
      ctx.stroke();

      const shade = ctx.createRadialGradient(
        cx - radius * .42, cy - radius * .46, radius * .08,
        cx + radius * .14, cy + radius * .1, radius * 1.18
      );
      shade.addColorStop(0, 'rgba(153, 229, 255, .08)');
      shade.addColorStop(.56, 'rgba(3, 9, 24, .03)');
      shade.addColorStop(1, 'rgba(1, 5, 18, .7)');
      ctx.fillStyle = shade;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

      projectedMarkers = [];
      const pulse = reduceMotion ? .35 : (Math.sin(now / 520) + 1) / 2;
      [...locationsRef.current].reverse().forEach(point => {
        const p = project(point.lat, point.lon, radius, cx, cy);
        if (p.z <= .03) return;
        const markerRadius = Math.min(8, 3.3 + Math.log2(point.value + 1) * 1.05);
        const alpha = .38 + p.z * .62;

        ctx.strokeStyle = `rgba(80, 218, 255, ${(.2 + pulse * .25) * alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, markerRadius + 4 + pulse * 4.5, 0, Math.PI * 2);
        ctx.stroke();

        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, markerRadius * 2.15);
        glow.addColorStop(0, `rgba(109, 231, 255, ${.55 * alpha})`);
        glow.addColorStop(.28, `rgba(55, 191, 244, ${.22 * alpha})`);
        glow.addColorStop(1, 'rgba(55, 130, 255, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, markerRadius * 2.15, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = `rgba(163, 239, 255, ${.72 * alpha})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, markerRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#e8fbff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.6, markerRadius * .27), 0, Math.PI * 2);
        ctx.fill();
        projectedMarkers.push({ ...point, screenX: p.x, screenY: p.y, hit: markerRadius + 11 });
      });
      ctx.restore();

      const rim = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      rim.addColorStop(0, 'rgba(155, 224, 255, .8)');
      rim.addColorStop(.5, 'rgba(94, 130, 255, .38)');
      rim.addColorStop(1, 'rgba(245, 88, 162, .38)');
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.45;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      frame = window.requestAnimationFrame(draw);
    };

    const pointAt = event => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = event => {
      dragging = true;
      pointerId = event.pointerId;
      previousX = event.clientX;
      previousY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
      wrap.classList.add('is-dragging');
    };
    const onPointerMove = event => {
      if (dragging && event.pointerId === pointerId) {
        yaw += (event.clientX - previousX) * .008;
        tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, tilt + (event.clientY - previousY) * .008));
        previousX = event.clientX;
        previousY = event.clientY;
        return;
      }
      const point = pointAt(event);
      const nearest = projectedMarkers
        .map(marker => ({ marker, distance: Math.hypot(point.x - marker.screenX, point.y - marker.screenY) }))
        .filter(entry => entry.distance <= entry.marker.hit)
        .sort((a, b) => a.distance - b.distance)[0]?.marker;
      const key = nearest?.key || '';
      if (key !== hoverKey) {
        hoverKey = key;
        setHovered(nearest || null);
      }
    };
    const onPointerUp = event => {
      if (event.pointerId !== pointerId) return;
      dragging = false;
      pointerId = null;
      canvas.releasePointerCapture?.(event.pointerId);
      wrap.classList.remove('is-dragging');
    };
    const onPointerLeave = () => {
      if (!dragging && hoverKey) {
        hoverKey = '';
        setHovered(null);
      }
    };
    const onMotion = event => { reduceMotion = event.matches; };

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    frame = window.requestAnimationFrame(draw);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    motion.addEventListener?.('change', onMotion);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      motion.removeEventListener?.('change', onMotion);
    };
  }, []);

  return (
    <div
      className="geo-globe"
      ref={wrapRef}
      role="img"
      aria-label={locations.length
        ? `World map showing visitor activity in ${locations.map(locationLabel).join('; ')} ${timeLabel}`
        : `World map with no visitor locations ${timeLabel}`}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="geo-globe-orbit geo-globe-orbit-a" aria-hidden="true" />
      <div className="geo-globe-orbit geo-globe-orbit-b" aria-hidden="true" />
      <span className="geo-live-badge"><i /> Activity map</span>
      <span className="geo-drag-hint">Drag any direction to explore</span>
      {hovered && (
        <div
          className="geo-tooltip"
          style={{ left: hovered.screenX, top: hovered.screenY }}
          role="status"
        >
          <span>{flagFor(hovered.countryCode)} {hovered.city || hovered.country}</span>
          <strong>{compact(hovered.value)} session{hovered.value === 1 ? '' : 's'}</strong>
          {hovered.latestAt && <small>Last seen {formatMoment(hovered.latestAt)}</small>}
        </div>
      )}
      {!locations.length && (
        <div className="geo-globe-empty">
          <strong>No activity in this moment</strong>
          <span>Move the timeline or choose a wider window.</span>
        </div>
      )}
    </div>
  );
}

export default function GeoOverview({
  locations,
  history = [],
  sessionHistory = [],
  sessions,
  rangeDays = 30
}) {
  const [windowKey, setWindowKey] = useState('all');
  const [timelineNow, setTimelineNow] = useState(() => Date.now());
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);

  const timeline = useMemo(
    () => buildTimeline(history, windowKey, rangeDays, timelineNow),
    [history, windowKey, rangeDays, timelineNow]
  );

  useEffect(() => {
    setTimelineNow(Date.now());
  }, [history, rangeDays]);

  useEffect(() => {
    setCursor(Math.max(0, timeline.bins.length - 1));
    setPlaying(false);
  }, [windowKey, timeline.bins.length, timeline.start]);

  useEffect(() => {
    if (!playing || timeline.bins.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setCursor(current => {
        if (current >= timeline.bins.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [playing, timeline.bins.length]);

  const cursorEnd = timeline.bins[cursor]?.end || timeline.end;
  const visibleLocations = useMemo(() => {
    if (!history.length) return locations;
    return aggregateLocations(timeline.samples.filter(sample => sample.at <= cursorEnd));
  }, [history, locations, timeline.samples, cursorEnd]);

  const visibleSessions = history.length
    ? sessionHistory.filter(session => {
      const firstAt = typeof session === 'number' ? session : session.firstAt;
      const lastAt = typeof session === 'number' ? session : session.lastAt;
      return lastAt >= timeline.start && firstAt <= cursorEnd;
    }).length
    : sessions;

  const { countries, cities, tracked } = useMemo(() => {
    const countryMap = new Map();
    let total = 0;
    for (const point of visibleLocations) {
      total += point.value;
      const key = point.countryCode || point.country || 'unknown';
      const current = countryMap.get(key) || {
        key,
        label: point.country || 'Unknown country',
        code: point.countryCode,
        value: 0
      };
      current.value += point.value;
      countryMap.set(key, current);
    }
    return {
      tracked: total,
      countries: [...countryMap.values()].sort((a, b) => b.value - a.value),
      cities: [...visibleLocations].sort((a, b) => b.value - a.value).slice(0, 5)
    };
  }, [visibleLocations]);

  const maxBin = Math.max(1, ...timeline.bins.map(bin => bin.count));
  const timeLabel = history.length ? `through ${formatMoment(cursorEnd)}` : 'for the selected range';

  const togglePlayback = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (cursor >= timeline.bins.length - 1) setCursor(0);
    setPlaying(true);
  };

  return (
    <section className="admin-card geo-card">
      <div className="card-head geo-card-head">
        <div>
          <span className="geo-eyebrow">Audience geography</span>
          <h3>Where visitors connect</h3>
          <p>Approximate city-level location derived from IP. Precise GPS and IP addresses are not stored.</p>
        </div>
        <span className="geo-privacy-pill">Privacy-safe · city scale</span>
      </div>

      <div className="geo-time-panel">
        <div className="geo-time-controls">
          <div className="geo-time-windows" role="group" aria-label="Location activity window">
            {TIME_WINDOWS.map(option => (
              <button
                type="button"
                key={option.key}
                aria-pressed={windowKey === option.key}
                onClick={() => setWindowKey(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            className="geo-play"
            type="button"
            onClick={togglePlayback}
            disabled={!history.length || timeline.bins.length < 2}
            aria-label={playing ? 'Pause location timeline' : 'Play location timeline'}
          >
            <i aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</i>
            {playing ? 'Pause' : 'Play'}
          </button>
          <div className="geo-time-copy" aria-live="polite">
            <span>Activity through</span>
            <strong>{formatMoment(cursorEnd)}</strong>
          </div>
        </div>

        <div className={`geo-timeline ${history.length ? '' : 'is-disabled'}`}>
          <div className="geo-timeline-bars" aria-hidden="true">
            {timeline.bins.map((bin, index) => (
              <i
                key={bin.start}
                className={index <= cursor ? 'is-seen' : ''}
                style={{ height: `${Math.max(8, (bin.count / maxBin) * 100)}%` }}
              />
            ))}
          </div>
          <input
            type="range"
            min="0"
            max={Math.max(0, timeline.bins.length - 1)}
            value={Math.min(cursor, Math.max(0, timeline.bins.length - 1))}
            onChange={event => {
              setPlaying(false);
              setCursor(Number(event.target.value));
            }}
            disabled={!history.length}
            aria-label="Location activity time"
            aria-valuetext={formatMoment(cursorEnd)}
          />
          <div className="geo-timeline-edges">
            <span>{formatTimelineEdge(timeline.start)}</span>
            <span>{formatTimelineEdge(timeline.end)}</span>
          </div>
        </div>
      </div>

      <div className="geo-layout">
        <Globe locations={visibleLocations} timeLabel={timeLabel} />
        <div className="geo-insights">
          <div className="geo-stats">
            <div><strong>{compact(tracked)}</strong><span>located sessions</span></div>
            <div><strong>{compact(countries.length)}</strong><span>countries</span></div>
            <div><strong>{Math.min(100, share(tracked, visibleSessions))}%</strong><span>coverage to this time</span></div>
          </div>

          <div className="geo-list-block">
            <div className="geo-list-head"><span>Top countries</span><span>Sessions</span></div>
            {countries.length ? countries.slice(0, 5).map(country => (
              <div className="geo-rank-row" key={country.key}>
                <span className="geo-flag" aria-hidden="true">{flagFor(country.code)}</span>
                <span>{country.label}</span>
                <i><b style={{ width: `${share(country.value, tracked)}%` }} /></i>
                <strong>{compact(country.value)}</strong>
              </div>
            )) : <div className="geo-list-empty">No location events in this time window yet.</div>}
          </div>

          {!!cities.length && (
            <div className="geo-city-strip">
              <span>Active cities</span>
              <div>
                {cities.map(city => (
                  <span key={city.key} title={locationLabel(city)}>
                    <i />{city.city || city.region || city.country}
                    <b>{compact(city.value)}</b>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
