// The slide-over detail panel.
//
// Detail lives here rather than in a column beside the table so the table keeps
// the full width — these rows have a lot of fields, and a permanent side column
// squeezes both.

import React, { useEffect } from 'react';

export function Panel({ title, subtitle, onClose, children }) {
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="admin-panel-backdrop" onClick={onClose} />
      <div className="admin-panel" role="dialog" aria-modal="true" aria-label={title}>
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
