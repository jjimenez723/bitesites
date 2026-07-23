import { memo, useEffect, useId, useMemo, useRef } from 'react';
import bitMascotSvg from '../../Bit.svg?raw';
import bitClosedEyes from '../assets/bit-closed-eyes.svg';

// One page-level cursor source keeps every Bit instance in sync, including
// avatars that mount after the visitor has already moved their cursor.
let lastPointerPosition = null;
let pointerTrackingStarted = false;

// Every mounted Bit. They are aimed together, from a single frame, so that one
// mascot's DOM write can never force the next one's rect read to re-run layout —
// which is what made three mascots cost three reflows per scrolled frame.
const gazers = new Set();
let gazeFrame = 0;

function runGaze() {
  gazeFrame = 0;
  const point = lastPointerPosition;
  if (!point) return;

  // Phase one: read. Nothing writes to the DOM in this loop.
  const measured = [];
  for (const gazer of gazers) {
    if (!gazer.visible) continue;
    const rect = gazer.root.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    measured.push([gazer, rect]);
  }
  // Phase two: write. Layout is already settled, so none of these force a reflow.
  for (const [gazer, rect] of measured) gazer.aim(rect, point);
}

function scheduleGaze() {
  if (gazeFrame) return;
  gazeFrame = window.requestAnimationFrame(runGaze);
}

function publishPointerPosition(clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
  lastPointerPosition = { x: clientX, y: clientY };
  scheduleGaze();
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
  // currently under the cursor. Pointer events cover mouse, pen and touch, so
  // the mouse* fallbacks are only registered for webviews that lack them —
  // otherwise every desktop cursor move ran this path twice.
  if (window.PointerEvent) {
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerenter', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerMove, { passive: true });
  } else {
    window.addEventListener('mousemove', onPointerMove, { passive: true });
    window.addEventListener('mouseenter', onPointerMove, { passive: true });
  }
  window.addEventListener('touchstart', onTouchMove, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });

  // Scrolling moves the mascots under a stationary cursor, so the gaze has to be
  // recomputed — but one shared listener does it for every instance at once.
  document.addEventListener('scroll', scheduleGaze, { capture: true, passive: true });
  window.addEventListener('resize', scheduleGaze, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleGaze, { passive: true });
  window.visualViewport?.addEventListener('scroll', scheduleGaze, { passive: true });
}

// Returning from another tab can briefly report stale element geometry, so wait
// for two paint frames before recalculating.
function scheduleGazeAfterLayout() {
  window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleGaze));
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

// Memoised because React rewrites dangerouslySetInnerHTML on every re-render,
// which would swap out the pupil elements the gaze effect is animating.
export const BitMascot = memo(function BitMascot({
  className = '',
  decorative = true,
  label = 'Bit, the BiteSites mascot',
  eyesClosed = false
}) {
  const rootRef = useRef(null);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const markup = useMemo(() => makeInstanceSafe(taggedMascotSvg, `bit-${instanceId}`), [instanceId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    // Re-query whenever the markup underneath us is replaced, so the gaze never
    // ends up animating orphaned nodes.
    let pupils = [];
    const livePupils = () => {
      if (!pupils.length || !pupils[0].isConnected) pupils = [...root.querySelectorAll('[data-bit-pupil]')];
      return pupils;
    };

    const movePupils = (x, y) => {
      livePupils().forEach(pupil => {
        const centerX = Number(pupil.dataset.bitCenterX);
        const centerY = Number(pupil.dataset.bitCenterY);
        const base = pupil.dataset.bitBaseTransform || '';
        pupil.setAttribute('transform', `${base} translate(${(centerX + x).toFixed(2)} ${(centerY + y).toFixed(2)})`.trim());
      });
    };

    const gazer = {
      root,
      // Assume visible until the observer reports otherwise, so the very first
      // frame after mount still aims.
      visible: true,
      aim(rect, point) {
        const eyeX = rect.left + rect.width * 0.503;
        const eyeY = rect.top + rect.height * 0.439;
        const deltaX = point.x - eyeX;
        const deltaY = point.y - eyeY;
        const distance = Math.hypot(deltaX, deltaY);
        const strength = Math.min(distance / Math.max(rect.width * 0.45, 44), 1);
        const travel = 8.25 * strength;

        movePupils(
          distance ? (deltaX / distance) * travel : 0,
          distance ? (deltaY / distance) * travel : 0
        );
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) scheduleGazeAfterLayout();
    };
    // A mascot scrolled off screen has no gaze worth computing, and skipping it
    // skips its rect read too.
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      gazer.visible = entry.isIntersecting;
      if (gazer.visible) scheduleGaze();
    }, { threshold: 0 });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleGaze);

    startPointerTracking();
    gazers.add(gazer);
    intersectionObserver.observe(root);
    resizeObserver?.observe(root);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', scheduleGazeAfterLayout);
    window.addEventListener('pageshow', scheduleGazeAfterLayout);
    // The chat avatar mounts inside an entrance animation. Recalculate once
    // that layout motion has settled even if the cursor has not moved again.
    const mountRefreshTimer = window.setTimeout(scheduleGazeAfterLayout, 850);
    scheduleGaze();

    return () => {
      window.clearTimeout(mountRefreshTimer);
      gazers.delete(gazer);
      intersectionObserver.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', scheduleGazeAfterLayout);
      window.removeEventListener('pageshow', scheduleGazeAfterLayout);
    };
  }, []);

  return <span
    ref={rootRef}
    className={`bit-mascot ${eyesClosed ? 'bit-mascot-eyes-closed' : ''} ${className}`.trim()}
    role={decorative ? undefined : 'img'}
    aria-hidden={decorative ? 'true' : undefined}
    aria-label={decorative ? undefined : label}
  >
    <span className="bit-mascot-art" dangerouslySetInnerHTML={{ __html: markup }} />
    <img className="bit-mascot-closed-eyes" src={bitClosedEyes} alt="" aria-hidden="true" />
  </span>;
});
