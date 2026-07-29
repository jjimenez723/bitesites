process.env.GCLOUD_PROJECT = 'demo-bitesites';

await import('./index.js');
const { aggregateFunnelData } = await import('./aggregate-funnel.js');
const { getFirestore } = await import('firebase-admin/firestore');
const db = getFirestore();

const emit = data => aggregateFunnelData(data, db);
const base = { day: '2026-07-28', device: 'desktop', vid: 'visitor-1' };

await emit({ ...base, type: 'page_view', sid: 'session-1' });
await emit({ ...base, type: 'page_view', sid: 'session-1' });
await emit({ ...base, type: 'form_start', sid: 'session-1' });
await emit({ ...base, type: 'lead_created', sid: 'session-1' });
await emit({ ...base, type: 'page_view', sid: 'session-2' });
await emit({ ...base, type: 'click', sid: 'session-2' });

const daily = (await db.doc('analyticsDaily/2026-07-28').get()).data();
const checks = [
  ['counts distinct sessions', daily?.sessions === 2, daily?.sessions],
  ['deduplicates visitor-day', daily?.visitors === 1, daily?.visitors],
  ['keeps raw page-view count', daily?.eventCounts?.page_view === 3, daily?.eventCounts?.page_view],
  ['deduplicates page-view sessions', daily?.sessionCounts?.page_view === 2, daily?.sessionCounts?.page_view],
  ['records one lead session', daily?.sessionCounts?.lead_created === 1, daily?.sessionCounts?.lead_created],
  ['ignores noisy event types', !daily?.eventCounts?.click, daily?.eventCounts?.click]
];

for (const [name, pass, detail] of checks) console.log(`${pass ? '  ✓' : '  ✗'} ${name}${pass ? '' : ` — ${detail}`}`);
const failures = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failures.length} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
