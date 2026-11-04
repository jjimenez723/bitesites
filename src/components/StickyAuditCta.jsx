import React, { useEffect, useState } from 'react';

// A persistent "Get a free audit" pill. It appears once the visitor scrolls past
// the first screen and steps aside while the audit form itself is on screen.
// Footers get bottom padding (refresh.css) so the pill never covers their links.
export default function StickyAuditCta({ href = '/#start' }) {
  const [scrolled, setScrolled] = useState(false);
  const [formVisible, setFormVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight * 0.6);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Step aside while the audit form itself is on screen.
  useEffect(() => {
    const targets = [document.getElementById('start')].filter(Boolean);
    if (!targets.length || !('IntersectionObserver' in window)) return undefined;
    const visible = new Set();
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => (entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target)));
      setFormVisible(visible.size > 0);
    }, { threshold: 0.05 });
    targets.forEach(target => observer.observe(target));
    return () => observer.disconnect();
  }, []);

  const shown = scrolled && !formVisible;
  return <a className={`sticky-audit-cta ${shown ? 'is-shown' : ''}`} href={href} aria-hidden={!shown} tabIndex={shown ? undefined : -1}>
    <span className="sticky-audit-dot" aria-hidden="true" />Get a free audit
  </a>;
}
