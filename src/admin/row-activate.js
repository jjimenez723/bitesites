// Keyboard activation for table rows that open a detail panel.
//
// A `<tr onClick>` is a mouse-only control: there is no way to reach it with a
// keyboard and no way for a screen-reader user to know it does anything. The
// rows stay `<tr>` rather than becoming buttons — turning them into buttons
// would cost the table semantics that make dozens of leads scannable — so they
// take a tab stop and answer Enter and Space instead.
//
// Spread onto the row alongside its className:
//
//   <tr className="clickable" {...activateRow(() => openLead(lead.id))}>

export function activateRow(onActivate) {
  return {
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // Controls inside the row — a checkbox, a button — keep their own keys.
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onActivate();
    }
  };
}
