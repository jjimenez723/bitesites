process.env.LEAD_LIFECYCLE_WEBHOOK_SECRET = 'a-long-enough-lifecycle-test-secret';
process.env.GCLOUD_PROJECT = 'demo-bitesites';

const { recordLeadLifecycle } = await import('./index.js');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const db = getFirestore();

function fakeRes() {
  const out = { code: 0, body: null, headers: {} };
  const res = {
    set(key, value) { out.headers[key] = value; return res; },
    status(code) { out.code = code; return res; },
    json(body) { out.body = body; return res; }
  };
  return { res, out };
}

async function post(body, secret = 'a-long-enough-lifecycle-test-secret') {
  const { res, out } = fakeRes();
  await recordLeadLifecycle({
    method: 'POST', body,
    get: name => name.toLowerCase() === 'x-webhook-secret' ? secret : undefined
  }, res);
  return out;
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const leadRef = db.collection('leads').doc('lifecycle-lead');
await leadRef.set({
  name: 'Casey Morgan', email: 'casey@example.com', phone: '+15550100',
  source: 'intake_form', status: 'new', createdAt: Timestamp.now(),
  economics: { contractValue: 0 }
});

check('rejects a bad secret', (await post({ leadId: leadRef.id }, 'wrong')).code === 401);
check('rejects an invalid stage', (await post({ leadId: leadRef.id, status: 'anything' })).code === 400);

const response = await post({
  eventId: 'opportunity-1', leadId: leadRef.id, status: 'won',
  appointmentStatus: 'attended', scheduledFor: '2026-08-01T14:00:00Z',
  contractValue: 12000, cashCollected: 6000, loadedLaborCost: 3200,
  contractorCost: 800, softwareCost: 200, lostReason: ''
});
check('accepts a lifecycle update', response.code === 200, JSON.stringify(response.body));
const lead = (await leadRef.get()).data();
check('updates stage', lead.status === 'won', lead.status);
check('sets first response time', Boolean(lead.firstResponseAt));
check('records appointment outcome', lead.appointment?.status === 'attended', lead.appointment?.status);
check('computes gross profit', lead.economics?.grossProfit === 7800, String(lead.economics?.grossProfit));
check('computes gross margin', lead.economics?.grossMargin === 65, String(lead.economics?.grossMargin));
check('writes idempotent activity', (await leadRef.collection('activities').get()).size === 1);

await post({ eventId: 'opportunity-1', leadId: leadRef.id, status: 'won' });
check('redelivery does not duplicate activity', (await leadRef.collection('activities').get()).size === 1);

const failures = results.filter(result => !result.pass);
console.log(`\n${results.length - failures.length} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
