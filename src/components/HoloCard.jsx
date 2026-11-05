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
