import React, { useEffect, useMemo, useRef, useState } from 'react';
import { compact, share } from './charts';

const RAD = Math.PI / 180;

const flagFor = code => {
  if (!/^[A-Z]{2}$/.test(code || '')) return '◌';
  return String.fromCodePoint(...[...code].map(char => 127397 + char.charCodeAt(0)));
};

const locationLabel = point =>
  [point.city, point.region, point.country].filter(Boolean).join(', ') || 'Unknown location';

function Globe({ locations }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;

    const ctx = canvas.getContext('2d');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduceMotion = motion.matches;
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = performance.now();
    let yaw = locations[0] ? -locations[0].lon * RAD : -.7;
    let dragging = false;
    let pointerId = null;
    let previousX = 0;
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
      const tilt = -.18;
      const yy = y * Math.cos(tilt) - z * Math.sin(tilt);
      const zz = y * Math.sin(tilt) + z * Math.cos(tilt);
      return { x: cx + x * radius, y: cy - yy * radius, z: zz };
    };

    const gridLine = (points, radius, cx, cy) => {
      ctx.beginPath();
      let drawing = false;
      for (const [lat, lon] of points) {
        const p = project(lat, lon, radius, cx, cy);
        if (p.z <= .01) {
          drawing = false;
          continue;
        }
        if (!drawing) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        drawing = true;
      }
      ctx.stroke();
    };

    const draw = now => {
      const dt = Math.min(.05, (now - last) / 1000);
      last = now;
      if (!dragging && !reduceMotion) yaw += dt * .095;

      ctx.clearRect(0, 0, width, height);
      const cx = width * .5;
      const cy = height * .51;
      const radius = Math.min(width * .38, height * .405);

      for (const star of stars) {
        ctx.fillStyle = `rgba(190,218,255,${star.a})`;
        ctx.beginPath();
        ctx.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      ctx.shadowColor = 'rgba(54, 173, 255, .28)';
      ctx.shadowBlur = 34;
      const ocean = ctx.createRadialGradient(cx - radius * .35, cy - radius * .42, 0, cx, cy, radius);
      ocean.addColorStop(0, 'rgba(40, 94, 170, .32)');
      ocean.addColorStop(.56, 'rgba(15, 39, 82, .46)');
      ocean.addColorStop(1, 'rgba(5, 14, 35, .88)');
      ctx.fillStyle = ocean;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius - .5, 0, Math.PI * 2);
      ctx.clip();

      ctx.strokeStyle = 'rgba(115, 173, 236, .16)';
      ctx.lineWidth = .75;
      for (let lat = -60; lat <= 60; lat += 30) {
        gridLine(Array.from({ length: 91 }, (_, i) => [lat, -180 + i * 4]), radius, cx, cy);
      }
      for (let lon = -150; lon <= 180; lon += 30) {
        gridLine(Array.from({ length: 61 }, (_, i) => [-90 + i * 3, lon]), radius, cx, cy);
      }

      // A rotating field of surface points gives the sphere texture and makes
      // its direction legible even before location data exists.
      for (let i = 0; i < 260; i += 1) {
        const y = 1 - (i / 259) * 2;
        const lat = Math.asin(y) / RAD;
        const lon = ((i * 137.508) % 360) - 180;
        const p = project(lat, lon, radius, cx, cy);
        if (p.z <= 0) continue;
        ctx.fillStyle = `rgba(130, 190, 244, ${.055 + p.z * .13})`;
        ctx.fillRect(p.x, p.y, 1.1, 1.1);
      }

      projectedMarkers = [];
      const pulse = reduceMotion ? 0 : (Math.sin(now / 520) + 1) / 2;
      [...locations].reverse().forEach(point => {
        const p = project(point.lat, point.lon, radius, cx, cy);
        if (p.z <= .03) return;
        const markerRadius = Math.min(10, 4 + Math.log2(point.value + 1) * 1.25);
        const alpha = .35 + p.z * .65;

        ctx.strokeStyle = `rgba(64, 202, 255, ${(.2 + pulse * .22) * alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, markerRadius + 4 + pulse * 5, 0, Math.PI * 2);
        ctx.stroke();

        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, markerRadius * 2.8);
        glow.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        glow.addColorStop(.24, `rgba(75, 211, 255, ${alpha})`);
        glow.addColorStop(1, 'rgba(90, 111, 255, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, markerRadius * 2.8, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#dff8ff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2, markerRadius * .32), 0, Math.PI * 2);
        ctx.fill();
        projectedMarkers.push({ ...point, screenX: p.x, screenY: p.y, hit: markerRadius + 10 });
      });
      ctx.restore();

      const rim = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      rim.addColorStop(0, 'rgba(130, 201, 255, .72)');
      rim.addColorStop(.5, 'rgba(94, 111, 255, .34)');
      rim.addColorStop(1, 'rgba(255, 94, 156, .42)');
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      frame = window.requestAnimationFrame(draw);
    };

    const pointAt = event => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      return { x, y };
    };

    const onPointerDown = event => {
      dragging = true;
      pointerId = event.pointerId;
      previousX = event.clientX;
      canvas.setPointerCapture?.(event.pointerId);
      wrap.classList.add('is-dragging');
    };
    const onPointerMove = event => {
      if (dragging && event.pointerId === pointerId) {
        yaw += (event.clientX - previousX) * .008;
        previousX = event.clientX;
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
  }, [locations]);

  return (
    <div
      className="geo-globe"
      ref={wrapRef}
      role="img"
      aria-label={locations.length
        ? `Animated globe showing visitor activity in ${locations.map(locationLabel).join('; ')}`
        : 'Animated globe awaiting visitor location data'}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="geo-globe-orbit geo-globe-orbit-a" aria-hidden="true" />
      <div className="geo-globe-orbit geo-globe-orbit-b" aria-hidden="true" />
      <span className="geo-live-badge"><i /> Live geography</span>
      <span className="geo-drag-hint">Drag to explore</span>
      {hovered && (
        <div
          className="geo-tooltip"
          style={{ left: hovered.screenX, top: hovered.screenY }}
          role="status"
        >
          <span>{flagFor(hovered.countryCode)} {hovered.city || hovered.country}</span>
          <strong>{compact(hovered.value)} session{hovered.value === 1 ? '' : 's'}</strong>
        </div>
      )}
      {!locations.length && (
        <div className="geo-globe-empty">
          <strong>Listening worldwide</strong>
          <span>New visitor locations will pulse here.</span>
        </div>
      )}
    </div>
  );
}

export default function GeoOverview({ locations, sessions }) {
  const { countries, cities, tracked } = useMemo(() => {
    const countryMap = new Map();
    let total = 0;
    for (const point of locations) {
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
      cities: [...locations].sort((a, b) => b.value - a.value).slice(0, 5)
    };
  }, [locations]);

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

      <div className="geo-layout">
        <Globe locations={locations} />
        <div className="geo-insights">
          <div className="geo-stats">
            <div><strong>{compact(tracked)}</strong><span>located sessions</span></div>
            <div><strong>{compact(countries.length)}</strong><span>countries</span></div>
            <div><strong>{share(tracked, sessions)}%</strong><span>coverage</span></div>
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
            )) : <div className="geo-list-empty">No location events in this range yet.</div>}
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
