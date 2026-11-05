import React from 'react';

// BiteSites' own icon set, drawn on a 64-unit grid with three layers: a soft fill
// (.ci-soft), a line in currentColor, and one accent (.ci-acc). .ci-on is a mark
// drawn on top of an accent. refresh.css sets the colors for each background.
const S = 'ci-soft';
const A = 'ci-acc';
const O = 'ci-on';

const icons = {
  // The six steps on /services
  found: <>
    <ellipse className={S} cx="32" cy="55" rx="20" ry="5" stroke="none" />
    <path className={S} d="M32 5c-11.6 0-21 9.2-21 20.6C11 40.3 32 55 32 55s21-14.7 21-29.4C53 14.2 43.6 5 32 5Z" />
    <path className={A} d="m32 14 3.4 7.2 7.8 1-5.7 5.4 1.5 7.8-7-3.8-7 3.8 1.5-7.8-5.7-5.4 7.8-1L32 14Z" />
  </>,
  capture: <>
    <rect className={S} x="8" y="6" width="36" height="48" rx="7" />
    <path d="M17 18h18M17 28h12" />
    <rect className={A} x="17" y="37" width="16" height="8" rx="4" stroke="none" />
    <path className={A} d="m38 34 20 7.5-8.5 3.5-3.5 8.5L38 34Z" />
  </>,
  respond: <>
    <path className={S} d="M50 43.5v7a5 5 0 0 1-5.5 5C23.8 53.4 8.6 38.2 6.5 17.5A5 5 0 0 1 11.5 12h7a5 5 0 0 1 4.9 4c.4 2.1 1 4.1 1.8 6a5 5 0 0 1-1.2 5.3l-2.6 2.6a33 33 0 0 0 12.7 12.7l2.6-2.6a5 5 0 0 1 5.3-1.2c1.9.8 3.9 1.4 6 1.8a5 5 0 0 1 4 4.9Z" />
    <path className={A} d="M36 6h18a5 5 0 0 1 5 5v11a5 5 0 0 1-5 5h-9l-7 6v-6h-2a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5Z" />
    <path className={O} d="M38 16.5h.01M45 16.5h.01M52 16.5h.01" />
  </>,
  followup: <>
    <path className={S} d="M58 6 6 27l19 8.5L33.5 55 58 6Z" />
    <path d="M58 6 25 35.5" />
    <path d="M18 44c-3 2.5-6 5-8 9" strokeDasharray="1 7" />
    <circle className={A} cx="9" cy="56" r="4.5" />
  </>,
  book: <>
    <rect className={S} x="7" y="12" width="50" height="45" rx="9" />
    <path d="M7 26h50M21 6v12M43 6v12" />
    <circle className={A} cx="32" cy="41" r="10.5" />
    <path className={O} d="m27 41 3.5 3.5 6.5-7" />
  </>,
  track: <>
    <rect className={S} x="8" y="42" width="11" height="15" rx="3" />
    <rect className={S} x="26.5" y="33" width="11" height="24" rx="3" />
    <rect className={A} x="45" y="24" width="11" height="33" rx="3" />
    <path d="m8 30 13-11 10 6L50 7M39 7h11v11" />
  </>,

  // What we build
  recovery: <>
    <path className={S} d="M10 12h14v21a8 8 0 0 0 16 0V12h14v21a22 22 0 0 1-44 0V12Z" />
    <path className={A} d="M10 12h14v10H10zM40 12h14v10H40z" />
    <circle className={A} cx="32" cy="12" r="4.5" stroke="none" />
    <path d="M32 21v5" strokeDasharray="1 6" />
  </>,
  website: <>
    <rect className={S} x="5" y="9" width="54" height="46" rx="8" />
    <path d="M5 22h54M13 15.5h.01M20 15.5h.01M27 15.5h.01" />
    <path className={A} d="M32 27c-5.5 0-10 4.3-10 9.7C22 43.5 32 50 32 50s10-6.5 10-13.3c0-5.4-4.5-9.7-10-9.7Z" />
    <circle className={O} cx="32" cy="36.5" r="2" />
  </>,
  receptionist: <>
    <rect className={S} x="16" y="20" width="32" height="30" rx="11" />
    <path d="M11 30v-3a21 21 0 0 1 42 0v3" />
    <rect className={A} x="6" y="28" width="9" height="15" rx="4.5" />
    <rect className={A} x="49" y="28" width="9" height="15" rx="4.5" />
    <path d="M54 43c0 8-6 12-14 12" />
    <path d="M26 32v3M38 32v3M26 42c3.5 2.5 8.5 2.5 12 0" />
  </>,
  automation: <>
    <rect className={S} x="6" y="20" width="42" height="34" rx="7" />
    <path d="m6 27 21 14 21-14" />
    <circle className={A} cx="47" cy="19" r="13" />
    <path className={O} d="M47 12v7.5l5 3" />
  </>,
  attribution: <>
    <circle className={S} cx="29" cy="35" r="23" />
    <circle cx="29" cy="35" r="13" />
    <circle className={A} cx="29" cy="35" r="5" />
    <path d="m29 35 24-24M53 11V4M53 11h7" />
  </>,
  consulting: <>
    <path className={S} d="M32 5a21 21 0 0 0-13 37.5c2.5 2 3.5 4 3.5 7h19c0-3 1-5 3.5-7A21 21 0 0 0 32 5Z" />
    <path d="M25 57h14" />
    <path className={A} d="M32 14c1.5 7 3.5 9 10.5 10.5C35.5 26 33.5 28 32 35c-1.5-7-3.5-9-10.5-10.5C28.5 23 30.5 21 32 14Z" />
  </>,

  // Who we help
  contractors: <>
    <path className={S} d="M9 42a23 23 0 0 1 46 0H9Z" />
    <path className={A} d="M5 42h54v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5v-5Z" />
    <path className={A} d="M26 20.5V14a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v6.5" />
    <path d="M18 42V32M46 42V32" />
  </>,
  stone: <>
    <rect className={S} x="11" y="33" width="42" height="24" rx="3" />
    <path d="M32 33v24M25 41v5M39 41v5" />
    <rect className={A} x="5" y="23" width="54" height="10" rx="3" />
    <path className={O} d="m12 28 6-2.5 5 3 5-2M38 28l5-2 5 2.5" />
    <path d="M42 23V12a5.5 5.5 0 0 1 11 0v3" />
  </>,
  trades: <>
    <path className={S} d="M23 7S7 25 7 38a16 16 0 0 0 32 0C39 25 23 7 23 7Z" />
    <path d="M15 39a8 8 0 0 0 8 8" />
    <path className={A} d="M47 5 33 31h10l-5 25 19-32H45l6-19h-4Z" />
  </>,
  roofing: <>
    <path className={S} d="M13 29v28h27V29" />
    <path d="M4 34 26.5 11 49 34M36 16V9h6v13" />
    <path d="M22 57V44h9v13" />
    <circle className={A} cx="51" cy="42" r="9" />
    <path d="M51 51v6M4 57h56" />
  </>,
  property: <>
    <rect className={S} x="7" y="7" width="30" height="50" rx="5" />
    <path d="M16 18h.01M28 18h.01M16 29h.01M28 29h.01M17 57V43h10v14" />
    <circle className={A} cx="49" cy="20" r="9" />
    <circle className={O} cx="49" cy="20" r="2" />
    <path d="M49 29v28M49 44h7M49 52h7" />
  </>,
  appointments: <>
    <path className={S} d="M11 44a21 21 0 0 1 42 0H11Z" />
    <rect className={A} x="6" y="44" width="52" height="9" rx="4.5" />
    <path d="M32 23v-6M26 13h12M22 31a13 13 0 0 1 6-5M53 13l4-4M58 23h4M6 23H2M11 13 7 9" />
  </>,
  // Homepage form
  webdev: <>
    <rect className={S} x="5" y="9" width="54" height="46" rx="8" />
    <path d="M5 22h54M13 15.5h.01M20 15.5h.01M27 15.5h.01M23 31l-8 7.5 8 7.5M41 31l8 7.5-8 7.5" />
    <path className={A} d="M35 29h5L29 48h-5l11-19Z" stroke="none" />
  </>,
  automate: <>
    <circle className={S} cx="32" cy="32" r="19" />
    <path d="M32 5v8M32 51v8M5 32h8M51 32h8M12.9 12.9l5.7 5.7M45.4 45.4l5.7 5.7M12.9 51.1l5.7-5.7M45.4 18.6l5.7-5.7" />
    <path className={A} d="M32 20c1.3 7 4.5 10.7 12 12-7.5 1.3-10.7 5-12 12-1.3-7-4.5-10.7-12-12 7.5-1.3 10.7-5 12-12Z" />
  </>,
  social: <>
    <path className={S} d="M15 7h34a10 10 0 0 1 10 10v22a10 10 0 0 1-10 10H31L18 58v-9h-3A10 10 0 0 1 5 39V17A10 10 0 0 1 15 7Z" />
    <path className={A} d="M32 40S18 31.5 18 23a7.5 7.5 0 0 1 14-3.5A7.5 7.5 0 0 1 46 23c0 8.5-14 17-14 17Z" />
  </>,
  chip: <>
    <rect className={S} x="14" y="14" width="36" height="36" rx="8" />
    <path d="M24 5v9M40 5v9M24 50v9M40 50v9M5 24h9M5 40h9M50 24h9M50 40h9" />
    <path className={A} d="M32 21c1 6 4.5 9.5 11 11-6.5 1.5-10 5-11 11-1-6-4.5-9.5-11-11 6.5-1.5 10-5 11-11Z" stroke="none" />
  </>,

  // What happens when nobody answers?
  incoming: <>
    <path className={S} d="M6 38 15 12h34l9 26v12a7 7 0 0 1-7 7H13a7 7 0 0 1-7-7V38Z" />
    <path className={A} d="M6 38h15l4 7h14l4-7h15v12a7 7 0 0 1-7 7H13a7 7 0 0 1-7-7V38Z" />
    <path d="M32 6v24M23 22l9 9 9-9" />
  </>,
  fast: <>
    <circle className={S} cx="32" cy="36" r="23" />
    <path d="M32 13V6M25 5h14M51 17l4 4" />
    <path className={A} d="M36 21 23 39h8l-3 13 13-19h-8l3-12Z" />
  </>,
  qualified: <>
    <path className={S} d="M6 8h52L38 31v16l-12 9V31L6 8Z" />
    <circle className={A} cx="49" cy="47" r="11.5" />
    <path className={O} d="m43.5 47 4 4 7-7.5" />
  </>,
  booked: <>
    <rect className={S} x="10" y="10" width="44" height="49" rx="8" />
    <rect className={A} x="22" y="5" width="20" height="11" rx="4.5" />
    <path d="m20 30 3.5 3.5 6.5-7M37 30h8M20 45l3.5 3.5 6.5-7M37 45h8" />
  </>,

  // Existing database
  estimate: <>
    <path className={S} d="M14 5h25l15 15v32a7 7 0 0 1-7 7H14a7 7 0 0 1-7-7V12a7 7 0 0 1 7-7Z" />
    <path d="M39 5v15h15M16 20h12" />
    <circle className={A} cx="30" cy="40" r="11" />
    <path className={O} d="M34 36c-1-1.5-2.5-2-4-2-2.5 0-4 1.3-4 3 0 4.5 8 2 8 6.5 0 1.7-1.7 2.5-4 2.5-1.8 0-3.3-.7-4.5-2M30 32v16" />
  </>,
  mailbox: <>
    <path className={S} d="M6 50V30a13 13 0 0 1 13-13h31a8 8 0 0 1 8 8v25H6Z" />
    <path d="M19 17a13 13 0 0 1 13 13v20M32 50v10M13 31h12" />
    <path className={A} d="M43 32V7h13v10H43" />
  </>,
  returning: <>
    <circle className={S} cx="25" cy="21" r="12" />
    <path className={S} d="M5 57c0-12 9-19 20-19s20 7 20 19H5Z" />
    <path className={A} d="M49 30s-11-6.5-11-14a6 6 0 0 1 11-3 6 6 0 0 1 11 3c0 7.5-11 14-11 14Z" />
  </>,

  // How we work
  diagnose: <>
    <circle className={S} cx="27" cy="27" r="21" />
    <path d="m43 43 15 15" />
    <rect className={A} x="23.5" y="14" width="7" height="17" rx="3.5" stroke="none" />
    <circle className={A} cx="27" cy="38" r="3.5" stroke="none" />
  </>,
  team: <>
    <path d="M32 32 32 13M32 32 13 48M32 32 51 48" />
    <circle className={S} cx="32" cy="11" r="7.5" />
    <circle className={S} cx="11" cy="50" r="7.5" />
    <circle className={S} cx="53" cy="50" r="7.5" />
    <circle className={A} cx="32" cy="33" r="9" />
  </>,
  clear: <>
    <path className={S} d="M3 32s11-19 29-19 29 19 29 19-11 19-29 19S3 32 3 32Z" />
    <circle className={A} cx="32" cy="32" r="10" />
    <circle className={O} cx="32" cy="32" r="2.5" />
  </>,
  gauge: <>
    <path className={S} d="M6 48a26 26 0 1 1 52 0H6Z" />
    <path d="M32 22v5M13.5 30l3.5 3.5M50.5 30 47 33.5M32 45l13-14" />
    <circle className={A} cx="32" cy="45" r="6" />
  </>,
};

export function CustomIcon({ name }) {
  return <svg className="ci" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{icons[name]}</svg>;
}
