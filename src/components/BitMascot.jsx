import { useEffect, useId, useMemo, useRef } from 'react';
import bitMascotSvg from '../../Bit.svg?raw';

// One page-level cursor source keeps every Bit instance in sync, including
// avatars that mount after the visitor has already moved their cursor.
let lastPointerPosition = null;
const pointerSubscribers = new Set();
let pointerTrackingStarted = false;

function publishPointerPosition(clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
  lastPointerPosition = { x: clientX, y: clientY };
  pointerSubscribers.forEach(subscriber => subscriber(lastPointerPosition));
}

function startPointerTracking() {
  if (pointerTrackingStarted) return;
  pointerTrackingStarted = true;

  const onPointerMove = event => publishPointerPosition(event.clientX, event.clientY);
  const onTouchMove = event => {
    const touch = event.touches[0];
    if (touch) publishPointerPosition(touch.clientX, touch.clientY);
  };

  // Listen on window so tracking is independent of which page element is
  // currently under the cursor. mousemove is retained for older webviews.
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('mousemove', onPointerMove, { passive: true });
  window.addEventListener('pointerenter', onPointerMove, { passive: true });
  window.addEventListener('mouseenter', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerMove, { passive: true });
  window.addEventListener('touchstart', onTouchMove, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });
}

function subscribeToPointerPosition(subscriber) {
  startPointerTracking();
  pointerSubscribers.add(subscriber);
  if (lastPointerPosition) subscriber(lastPointerPosition);
  return () => pointerSubscribers.delete(subscriber);
}

const taggedMascotSvg = bitMascotSvg
  .replace(
    '<g transform="matrix(1, 0, 0, 1, 138, 158)">',
    '<g data-bit-pupil="left" data-bit-base-transform="matrix(1, 0, 0, 1, 138, 158)" data-bit-center-x="10.48" data-bit-center-y="4" transform="matrix(1, 0, 0, 1, 138, 158)">'
  )
  .replace(
    '<g clip-path="url(#e2a8fad6fe)">',
    '<g data-bit-pupil="right" data-bit-center-x="10.11" data-bit-center-y="5.8" clip-path="url(#e2a8fad6fe)">'
  )
  .replace(
    '<g clip-path="url(#3c89f2a823)">',
    '<g data-bit-pupil="right" data-bit-center-x="10.11" data-bit-center-y="5.8" clip-path="url(#3c89f2a823)">'
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
    if (!root) return undefined;

    const pupils = [...root.querySelectorAll('[data-bit-pupil]')];
    let lastPoint = null;
    let animationFrame = null;
    let restoreFrame = null;
    let mountRefreshTimer = null;

    const movePupils = (x, y) => {
      pupils.forEach(pupil => {
        const centerX = Number(pupil.dataset.bitCenterX);
        const centerY = Number(pupil.dataset.bitCenterY);
        const base = pupil.dataset.bitBaseTransform || '';
        pupil.setAttribute('transform', `${base} translate(${(centerX + x).toFixed(2)} ${(centerY + y).toFixed(2)})`.trim());
      });
    };

    const aimAt = (clientX, clientY) => {
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

      lastPoint = { x: clientX, y: clientY };
      const rect = root.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
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

    const scheduleAim = (clientX, clientY) => {
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
      lastPoint = { x: clientX, y: clientY };
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        if (lastPoint) aimAt(lastPoint.x, lastPoint.y);
      });
    };

    const refreshAim = () => {
      if (lastPoint) scheduleAim(lastPoint.x, lastPoint.y);
    };
    const restoreAimAfterLayout = () => {
      if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
      // Returning from another tab can briefly report stale element geometry.
      // Wait for two paint frames before calculating Bit's new gaze direction.
      restoreFrame = window.requestAnimationFrame(() => {
        restoreFrame = window.requestAnimationFrame(() => {
          restoreFrame = null;
          refreshAim();
        });
      });
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        // Browsers pause queued animation frames in background tabs. Clear the
        // stale handle so a new eye update can be scheduled on return.
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
        if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
        animationFrame = null;
        restoreFrame = null;
        return;
      }
      restoreAimAfterLayout();
    };
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refreshAim);

    const unsubscribeFromPointer = subscribeToPointerPosition(({ x, y }) => scheduleAim(x, y));
    document.addEventListener('scroll', refreshAim, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', restoreAimAfterLayout);
    window.addEventListener('pageshow', restoreAimAfterLayout);
    window.addEventListener('resize', refreshAim, { passive: true });
    window.visualViewport?.addEventListener('resize', refreshAim, { passive: true });
    window.visualViewport?.addEventListener('scroll', refreshAim, { passive: true });
    resizeObserver?.observe(root);
    // The chat avatar mounts inside an entrance animation. Recalculate once
    // that layout motion has settled even if the cursor has not moved again.
    mountRefreshTimer = window.setTimeout(restoreAimAfterLayout, 850);

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
      if (mountRefreshTimer !== null) window.clearTimeout(mountRefreshTimer);
      unsubscribeFromPointer();
      document.removeEventListener('scroll', refreshAim, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', restoreAimAfterLayout);
      window.removeEventListener('pageshow', restoreAimAfterLayout);
      window.removeEventListener('resize', refreshAim);
      window.visualViewport?.removeEventListener('resize', refreshAim);
      window.visualViewport?.removeEventListener('scroll', refreshAim);
      resizeObserver?.disconnect();
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
