import React, { useEffect, useRef } from 'react';

// Content-card adaptation of the supplied HoloCard interaction: foil, glare,
// edge light and tilt. No image dependency or continuously running animation.
export default function HoloCard({ as: Element = 'div', children, className = '', tone = 'blue', tiltMax = 5, hoverScale = 1.02, style, ...props }) {
  const card = useRef(null);
  const frame = useRef(0);
  const bounds = useRef(null);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function reset() {
    cancelAnimationFrame(frame.current);
    bounds.current = null;
    if (!card.current) return;
    for (const name of ['--holo-x', '--holo-y', '--holo-rx', '--holo-ry']) card.current.style.removeProperty(name);
    delete card.current.dataset.tracking;
  }

  function move(event) {
    if (event.pointerType === 'touch' || !window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches) return;
    const node = card.current;
    const rect = bounds.current || (bounds.current = node.getBoundingClientRect());
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      node.style.setProperty('--holo-x', `${(x * 100).toFixed(1)}%`);
      node.style.setProperty('--holo-y', `${(y * 100).toFixed(1)}%`);
      node.style.setProperty('--holo-rx', `${((0.5 - y) * tiltMax * 2).toFixed(2)}deg`);
      node.style.setProperty('--holo-ry', `${((x - 0.5) * tiltMax * 2).toFixed(2)}deg`);
      node.dataset.tracking = 'true';
    });
  }

  return <Element {...props} ref={card} className={`holo-card ${className}`} data-tone={tone}
    style={{ '--holo-scale': hoverScale, ...style }} onPointerEnter={move} onPointerMove={move}
    onPointerLeave={reset} onPointerCancel={reset}>
    {children}
  </Element>;
}

export function RevenueIcon({ name, ...props }) {
  const paths = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M8 10.5h5m-2.5-2.5v5" /></>,
    capture: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h5m-4 5 2 2 4-4" /></>,
    respond: <><path d="M4 12a8 8 0 0 1 16 0v5a3 3 0 0 1-3 3h-3" /><rect x="3" y="11" width="4" height="7" rx="2" /><rect x="17" y="11" width="4" height="7" rx="2" /></>,
    followup: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
    booking: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 10h18m-13 5 3 3 5-5" /></>,
    tracking: <><path d="M4 3v18h17M8 16v-4m5 4V8m5 8V5" /></>,
    home: <><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7" /></>,
    stone: <><path d="m3 8 9-5 9 5v9l-9 4-9-4V8Zm0 0 9 5 9-5m-9 5v8M7 6l9 5" /></>,
    tools: <><path d="m14 6 4 4M3 21l8-8m4-10a6 6 0 0 0-7 8l-5 5a3 3 0 0 0 4 4l5-5a6 6 0 0 0 8-7l-4 4-4-4 3-5Z" /></>,
    leaf: <><path d="M5 19C-1 6 13 3 21 3c0 9-3 19-14 15M3 21 16 8m-5 5h6m-6 0V8" /></>,
    property: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h1m6 0h1M8 11h1m6 0h1m-6 10v-6h4v6" /></>,
    team: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m5 10v-3a6 6 0 0 0-3-5" /></>,
    clarity: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></>,
  };
  return <svg {...props} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.capture}</svg>;
}
