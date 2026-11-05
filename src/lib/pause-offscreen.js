// Decorative loops (orbit, mascots, status dots) keep running after their section
// scrolls away, and several of them run on the main thread, so they compete with
// scrolling. This marks each off-screen section so refresh.css can pause them.
// A data attribute, because React rewrites className on re-render.
export function pauseOffscreenSections(root = document) {
  if (!('IntersectionObserver' in window)) return () => {};
  const observer = new IntersectionObserver(entries => {
    entries.forEach(({ target, isIntersecting }) => {
      target.toggleAttribute('data-offscreen', !isIntersecting);
    });
  }, { rootMargin: '10% 0px' });
  const sections = root.querySelectorAll('section');
  sections.forEach(section => observer.observe(section));
  return () => {
    observer.disconnect();
    sections.forEach(section => section.removeAttribute('data-offscreen'));
  };
}
