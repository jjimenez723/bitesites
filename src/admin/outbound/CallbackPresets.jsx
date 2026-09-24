import React from 'react';

export const localDateTimeValue = date => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};

export default function CallbackPresets({ onSelect, disabled = false }) {
  return <div className="outbound-callback-presets" role="group" aria-label="Callback timing">
    <span>Call back in</span>
    {[1, 2, 3].map(weeks => <button key={weeks} className="btn-admin" type="button" disabled={disabled}
      aria-label={`Call back in ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`}
      onClick={() => {
        const date = new Date();
        date.setDate(date.getDate() + weeks * 7);
        onSelect(date.toISOString());
      }}>{weeks} {weeks === 1 ? 'week' : 'weeks'}</button>)}
  </div>;
}
