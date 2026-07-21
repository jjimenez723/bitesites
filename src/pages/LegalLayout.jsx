import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { LEGAL } from './legal-details';

// Shared shell for the Terms and Privacy documents: a stripped-back header that
// gets people back to the site, a readable measure for long-form text, and a
// table of contents built from the section list each page passes in.
export function LegalLayout({ title, intro, sections, children }) {
  useEffect(() => {
    document.title = `${title} | ${LEGAL.brand}`;
    window.scrollTo(0, 0);
  }, [title]);

  return (
    <div className="legal-page">
      <header className="legal-header">
        <div className="wrap legal-header-inner">
          <Link to="/" className="legal-back">
            <span aria-hidden="true">←</span> Back to {LEGAL.site}
          </Link>
          <nav className="legal-switch">
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
          </nav>
        </div>
      </header>

      <main className="wrap legal-main">
        <div className="legal-title">
          <h1>{title}</h1>
          <p className="legal-dates">
            Effective {LEGAL.effectiveDate} · Last updated {LEGAL.lastUpdated}
          </p>
          {intro && <p className="legal-intro">{intro}</p>}
        </div>

        {sections?.length > 0 && (
          <nav className="legal-toc" aria-label="Table of contents">
            <h2>Contents</h2>
            <ol>
              {sections.map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`}>{label}</a>
                </li>
              ))}
            </ol>
          </nav>
        )}

        <div className="legal-body">{children}</div>

        <footer className="legal-footer">
          <p>
            Questions about this document? Contact{' '}
            <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>.
          </p>
          <p className="legal-copy">© 2026 {LEGAL.entity}. All rights reserved.</p>
        </footer>
      </main>
    </div>
  );
}

export function Section({ id, heading, children }) {
  return (
    <section className="legal-section" id={id}>
      <h2>{heading}</h2>
      {children}
    </section>
  );
}
