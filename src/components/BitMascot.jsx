import { useEffect, useId, useMemo, useRef } from 'react';
import bitMascotSvg from '../../Bit.svg?raw';

const taggedMascotSvg = bitMascotSvg
  .replace(
    '<g transform="matrix(1, 0, 0, 1, 138, 158)">',
    '<g data-bit-pupil="left" data-bit-base-transform="matrix(1, 0, 0, 1, 138, 158)" data-bit-center-x="10.48" data-bit-center-y="4" transform="matrix(1, 0, 0, 1, 138, 158) translate(10.48 4)">'
  )
  .replace(
    '<g clip-path="url(#e2a8fad6fe)">',
    '<g data-bit-pupil="right" data-bit-center-x="10.11" data-bit-center-y="5.8" transform="translate(10.11 5.8)" clip-path="url(#e2a8fad6fe)">'
  )
  .replace(
    '<g clip-path="url(#3c89f2a823)">',
    '<g data-bit-pupil="right" data-bit-center-x="10.11" data-bit-center-y="5.8" transform="translate(10.11 5.8)" clip-path="url(#3c89f2a823)">'
  );

function makeInstanceSafe(svg, prefix) {
  return svg
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${prefix}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}-${id})`);
}

export function BitMascot({ className = '', decorative = true, label = 'Bit, the BiteSites mascot' }) {
  const rootRef = useRef(null);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const markup = useMemo(() => makeInstanceSafe(taggedMascotSvg, `bit-${instanceId}`), [instanceId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const pupils = [...root.querySelectorAll('[data-bit-pupil]')];
    let lastPoint = null;
    const movePupils = (x, y) => {
      pupils.forEach(pupil => {
        const centerX = Number(pupil.dataset.bitCenterX);
        const centerY = Number(pupil.dataset.bitCenterY);
        const base = pupil.dataset.bitBaseTransform || '';
        pupil.setAttribute('transform', `${base} translate(${(centerX + x).toFixed(2)} ${(centerY + y).toFixed(2)})`.trim());
      });
    };

    const aimAt = (clientX, clientY) => {
      lastPoint = { x: clientX, y: clientY };
      const rect = root.getBoundingClientRect();
      const eyeX = rect.left + rect.width * 0.503;
      const eyeY = rect.top + rect.height * 0.439;
      const deltaX = clientX - eyeX;
      const deltaY = clientY - eyeY;
      const distance = Math.hypot(deltaX, deltaY);
      const strength = Math.min(distance / Math.max(rect.width * 0.45, 44), 1);
      const travel = 8.25 * strength;

      const x = distance ? (deltaX / distance) * travel : 0;
      const y = distance ? (deltaY / distance) * travel : 0;
      movePupils(x, y);
    };

    const onPointerMove = event => aimAt(event.clientX, event.clientY);
    const onTouch = event => {
      const touch = event.touches[0];
      if (touch) aimAt(touch.clientX, touch.clientY);
    };
    const onScroll = () => {
      if (lastPoint) aimAt(lastPoint.x, lastPoint.y);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('touchmove', onTouch, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('touchstart', onTouch);
      window.removeEventListener('touchmove', onTouch);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return <span
    ref={rootRef}
    className={`bit-mascot ${className}`.trim()}
    role={decorative ? undefined : 'img'}
    aria-hidden={decorative ? 'true' : undefined}
    aria-label={decorative ? undefined : label}
    dangerouslySetInnerHTML={{ __html: markup }}
  />;
}
