// Read or repair a stored calendar schedule.
//
//   npm run calendar -- show
//   npm run calendar -- show fine-line-group
//   npm run calendar -- apply-defaults            (dry run, prints the diff)
//   npm run calendar -- apply-defaults --write
//
// Why this exists: `calendarDefaultsForAccount` only supplies fields a stored
// settings document has never written. Once someone saves the schedule in the
// console, that document is the authority — so changing the code default does
// nothing to a calendar already in use. This is how the stored copy is brought
// back in line, deliberately and visibly, rather than by a deploy quietly
// reaching into live data.
//
// Uses your gcloud Application Default Credentials. If it complains:
//
//   gcloud auth application-default login

const PROJECT_ID = 'bitesites-org';

// ADC carries whatever quota project gcloud was last pointed at, which is often
// some other project and makes every call 403. Pin it before the auth library
// loads — hence the dynamic imports below, which ESM would otherwise hoist.
process.env.GOOGLE_CLOUD_QUOTA_PROJECT ||= PROJECT_ID;

const { initializeApp, applicationDefault } = await import('firebase-admin/app');
const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
const { ACCOUNT_IDS, LEGACY_ACCOUNT_ID } = await import('../functions/accounts.js');
const { calendarDefaultsForAccount, normalizeCalendarSettings } =
  await import('../functions/booking-calendar.js');

const args = process.argv.slice(2);
const command = args[0] || 'show';
const write = args.includes('--write');
const accountId = args.slice(1).find(value => !value.startsWith('--')) || LEGACY_ACCOUNT_ID;

if (!['show', 'apply-defaults'].includes(command) || !ACCOUNT_IDS.includes(accountId)) {
  console.error('Usage: npm run calendar -- <show|apply-defaults> [accountId] [--write]');
  console.error(`       accounts: ${ACCOUNT_IDS.join(', ')}`);
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const describeHours = hours => WEEKDAYS
  .map((label, weekday) => {
    const windows = hours?.[String(weekday)] || hours?.[weekday] || [];
    if (!windows.length) return `${label} closed`;
    return `${label} ${windows.map(([open, close]) => `${open}–${close}`).join(', ')}`;
  })
  .join('  ');

function describe(settings) {
  return [
    `  timezone         ${settings.timezone}`,
    `  meeting          ${settings.slotMinutes} min, ${settings.bufferMinutes} min gap, ` +
      `${settings.capacity} at once`,
    `  notice / horizon ${settings.leadTimeMinutes} min ahead, ${settings.horizonDays} days out`,
    `  hours            ${describeHours(settings.workingHours)}`,
    `  google calendar  ${settings.googleCalendarId || '(not connected)'}`,
    `  also blocks      ${settings.busyCalendarIds?.length ? settings.busyCalendarIds.join(', ') : '(none)'}`,
    `  sync enabled     ${settings.googleSyncEnabled}`
  ].join('\n');
}

// Read the raw document, not the normalized view: the whole question is which
// fields the stored copy actually asserts.
const ref = db.doc(`calendarSettings/${accountId}`);
let snapshot = await ref.get();
let readFrom = ref.path;
if (!snapshot.exists && accountId === LEGACY_ACCOUNT_ID) {
  const legacy = await db.doc('calendarSettings/default').get();
  if (legacy.exists) {
    snapshot = legacy;
    readFrom = legacy.ref.path;
  }
}

const stored = snapshot.exists ? snapshot.data() : {};
const current = normalizeCalendarSettings(stored, { accountId });

console.log(`\n${accountId} — ${snapshot.exists ? readFrom : 'no stored document (code defaults apply)'}`);
console.log(describe(current));

if (command === 'show') process.exit(0);

// Working hours are what this command exists to reset. A live Google
// connection is not: whatever calendar the account is actually writing to wins
// over the code default, or running this to fix a schedule would silently
// repoint every future booking at a different calendar.
const defaults = calendarDefaultsForAccount(accountId);
const intended = normalizeCalendarSettings({
  ...stored,
  workingHours: defaults.workingHours,
  googleCalendarId: stored.googleCalendarId || defaults.googleCalendarId || '',
  busyCalendarIds: stored.busyCalendarIds?.length
    ? stored.busyCalendarIds
    : defaults.busyCalendarIds || []
}, { accountId });

const changed = JSON.stringify(current) !== JSON.stringify(intended);
if (!changed) {
  console.log('\nAlready matches the account defaults. Nothing to do.\n');
  process.exit(0);
}

console.log('\nwould become');
console.log(describe(intended));

if (!write) {
  console.log('\nDry run. Re-run with --write to save.\n');
  process.exit(0);
}

await ref.set({
  ...intended, accountId, updatedBy: 'scripts/calendar-settings.mjs',
  updatedAt: FieldValue.serverTimestamp()
}, { merge: true });

console.log(`\nSaved to ${ref.path}.\n`);
process.exit(0);
