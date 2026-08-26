// The slide-over detail panel.
//
// Detail lives here rather than in a column beside the table so the table keeps
// the full width — these rows have a lot of fields, and a permanent side column
// squeezes both.

import React, { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), '
  + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Panel({ title, subtitle, onClose, children }) {
  const panel = useRef(null);

  // aria-modal="true" tells a screen reader the rest of the page is inert.
  // Without moving focus in and keeping Tab inside, that is simply untrue: the
  // next Tab lands on the table behind the panel with nothing announced.
  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.focus();

    const onKey = event => {
      if (event.key === 'Escape') return onClose();
      if (event.key !== 'Tab') return;
      const stops = [...(panel.current?.querySelectorAll(FOCUSABLE) || [])]
        .filter(node => node.offsetParent !== null);
      if (!stops.length) return event.preventDefault();
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Back to the row that opened the panel, not to the top of the document.
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, [onClose]);

  return (
    <>
      <div className="admin-panel-backdrop" onClick={onClose} />
      <div
        className="admin-panel" ref={panel} tabIndex={-1}
        role="dialog" aria-modal="true" aria-label={title}
      >
        <div className="admin-panel-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="admin-panel-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="admin-panel-body">{children}</div>
      </div>
    </>
  );
}

export function DetailRows({ rows }) {
  const visible = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!visible.length) return null;
  return (
    <dl className="detail-rows">
      {visible.map(([label, value]) => (
        <div className="detail-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const Pill = ({ kind, children }) => (
  <span className={`pill ${kind || ''}`}><i />{children}</span>
);
