import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';

const MoltenMetal = lazy(() => import('./MoltenMetal'));

export default function MoltenBackdrop({ className = '' }) {
  const host = useRef(null);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const update = () => {
      const active = visible && !motion.matches;
      setEnabled(active);
      if (!active) setReady(false);
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    observer.observe(host.current);
    motion.addEventListener('change', update);
    return () => { observer.disconnect(); motion.removeEventListener('change', update); };
  }, []);

  return <div ref={host} className={`molten-backdrop ${className}`} data-ready={ready} aria-hidden="true">
    {enabled && <Suspense fallback={null}><MoltenMetal
      color1="#5227FF" color2="#FF9FFC" color3="#FFFFFF" speed={.35} scale={4} detail={3}
      glow={1.6} coreSize={.1} swirl={1} fold={-.2} blackPoint={.05} brightness={1.3}
      colorMode="molten" grain grainIntensity={.05} mouseInteraction mouseStrength={.3} opacity={1}
      eventTargetSelector=".revenue-hero, .molten-cta" onReady={() => setReady(true)}
    /></Suspense>}
  </div>;
}
