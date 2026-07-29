import { createHash } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const FUNNEL_EVENT_TYPES = new Set([
  'page_view', 'pricing_view', 'pricing_unlock', 'signup_start', 'signup_complete',
  'form_start', 'form_submit', 'lead_created', 'booking_click', 'chat_open', 'call_open'
]);

const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

export async function aggregateFunnelData(data, db = getFirestore()) {
  if (!data || !FUNNEL_EVENT_TYPES.has(data.type) || !/^\d{4}-\d{2}-\d{2}$/.test(data.day || '')) return false;
  const dailyRef = db.collection('analyticsDaily').doc(data.day);
  const sidHash = createHash('sha256').update(text(data.sid, 80)).digest('hex').slice(0, 32);
  const vidHash = createHash('sha256').update(text(data.vid, 80)).digest('hex').slice(0, 32);
  const sessionRef = dailyRef.collection('sessions').doc(sidHash);
  const visitorRef = dailyRef.collection('visitors').doc(vidHash);

  await db.runTransaction(async tx => {
    const [dailySnapshot, sessionSnapshot, visitorSnapshot] = await Promise.all([
      tx.get(dailyRef), tx.get(sessionRef), tx.get(visitorRef)
    ]);
    const daily = dailySnapshot.data() || {};
    const session = sessionSnapshot.data() || {};
    const eventCounts = { ...(daily.eventCounts || {}) };
    const sessionCounts = { ...(daily.sessionCounts || {}) };
    eventCounts[data.type] = count(eventCounts[data.type]) + 1;
    if (!session.types?.[data.type]) sessionCounts[data.type] = count(sessionCounts[data.type]) + 1;

    tx.set(dailyRef, {
      day: data.day,
      sessions: count(daily.sessions) + (sessionSnapshot.exists ? 0 : 1),
      visitors: count(daily.visitors) + (visitorSnapshot.exists ? 0 : 1),
      eventCounts, sessionCounts, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(sessionRef, {
      types: { ...(session.types || {}), [data.type]: true },
      device: text(data.device, 20), updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (!visitorSnapshot.exists) tx.create(visitorRef, { createdAt: FieldValue.serverTimestamp() });
  });
  return true;
}
