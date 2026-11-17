// Stripe billing against the Firestore emulator with an in-memory Stripe:
//   npm run test:billing
//
// Nothing here reaches Stripe. The fake SDK below records every call so the
// tests can assert on what would have been sent (amounts, payment method
// types, idempotency keys, metadata), and webhook payloads are signed with
// the real Stripe signing scheme so the HTTP handler's verification is
// exercised exactly as in production.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GCLOUD_PROJECT = 'demo-bitesites';
// Synthetic, low-entropy stand-ins: these are not credentials.
const FAKE_SECRET_KEY = ['sk', 'test', 'x'.repeat(24)].join('_');
const FAKE_WEBHOOK_SECRET = ['whsec', 'y'.repeat(24)].join('_');
process.env.STRIPE_WEBHOOK_SECRET = FAKE_WEBHOOK_SECRET;

const { initializeApp } = await import('firebase-admin/app');
initializeApp();
const { getFirestore } = await import('firebase-admin/firestore');
const { default: Stripe } = await import('stripe');
const billing = await import('./billing-stripe.js');
const api = await import('./billing-stripe-api.js');
const db = getFirestore();

// ---------------------------------------------------------------- fake SDK

function fakeStripe() {
  const calls = [];
  const sessions = new Map();
  const intents = new Map();
  const setupIntents = new Map();
  let seq = 0;
  const next = prefix => `${prefix}_${++seq}`;
  const record = (method, params, options) => calls.push({ method, params, options });
  const idempotent = new Map();
  const once = (key, make) => {
    if (!key) return make();
    if (!idempotent.has(key)) idempotent.set(key, make());
    return idempotent.get(key);
  };
  const stripe = {
    calls,
    sessions,
    intents,
    setupIntentStore: setupIntents,
    // What the next paymentIntents.create should do: 'succeeded' |
    // 'processing' | 'requires_action' | 'card_error'.
    nextIntentOutcome: 'succeeded',
    customers: {
      create: async (params, options) => {
        record('customers.create', params, options);
        return once(options?.idempotencyKey, () => ({ id: next('cus'), ...params }));
      },
      update: async (id, params) => { record('customers.update', { id, ...params }); return { id }; }
    },
    checkout: {
      sessions: {
        create: async (params, options) => {
          record('checkout.sessions.create', params, options);
          return once(options?.idempotencyKey, () => {
            const id = next('cs_test');
            const session = {
              id, url: `https://checkout.stripe.test/c/${id}`, status: 'open', mode: params.mode,
              payment_status: 'unpaid', expires_at: params.expires_at, metadata: params.metadata,
              customer: params.customer, client_reference_id: params.client_reference_id
            };
            sessions.set(id, session);
            return session;
          });
        },
        retrieve: async id => {
          record('checkout.sessions.retrieve', { id });
          const session = sessions.get(id);
          if (!session) throw Object.assign(new Error('No such session'), { type: 'StripeInvalidRequestError' });
          return session;
        },
        expire: async id => {
          record('checkout.sessions.expire', { id });
          const session = sessions.get(id);
          session.status = 'expired';
          return session;
        }
      }
    },
    paymentIntents: {
      create: async (params, options) => {
        record('paymentIntents.create', params, options);
        return once(options?.idempotencyKey, () => {
          const id = next('pi');
          const outcome = stripe.nextIntentOutcome;
          if (outcome === 'card_error') {
            const intent = { id, status: 'requires_payment_method', amount: params.amount, metadata: params.metadata };
            intents.set(id, intent);
            const error = new Error('Your card was declined.');
            error.type = 'StripeCardError';
            error.raw = { payment_intent: intent };
            throw error;
          }
          const intent = {
            id, status: outcome, amount: params.amount,
            amount_received: outcome === 'succeeded' ? params.amount : 0,
            metadata: params.metadata, customer: params.customer,
            last_payment_error: outcome === 'requires_action' ? { message: 'Authentication required.' } : null
          };
          intents.set(id, intent);
          return intent;
        });
      },
      retrieve: async id => {
        record('paymentIntents.retrieve', { id });
        const intent = intents.get(id);
        if (!intent) throw Object.assign(new Error('No such payment_intent'), { type: 'StripeInvalidRequestError' });
        return intent;
      }
    },
    setupIntents: {
      retrieve: async id => { record('setupIntents.retrieve', { id }); return setupIntents.get(id); }
    },
    paymentMethodStore: new Map(),
    paymentMethods: {
      retrieve: async id => {
        record('paymentMethods.retrieve', { id });
        return stripe.paymentMethodStore.get(id) || { id, type: 'us_bank_account' };
      }
    },
    // Mirrors an account that starts with only its default configuration.
    configurations: [{ id: 'pmc_default', name: 'Default', is_default: true, active: true,
      card: { display_preference: { preference: 'on' } }, klarna: { display_preference: { preference: 'on' } },
      us_bank_account: { display_preference: { preference: 'off' } } }],
    paymentMethodConfigurations: {
      list: async () => { record('paymentMethodConfigurations.list', {}); return { data: stripe.configurations }; },
      create: async (params, options) => {
        record('paymentMethodConfigurations.create', params, options);
        const config = { id: next('pmc'), active: true, is_default: false, ...params };
        stripe.configurations.push(config);
        return config;
      }
    }
  };
  return stripe;
}

let stripe;
const reset = async () => {
  stripe = fakeStripe();
  billing.__setStripeForTests(stripe);
  const collections = ['billingClients', 'invoices', 'billingPayLinks', 'stripeEvents', 'billingChargeAttempts', 'roles'];
  for (const name of collections) {
    const snapshot = await db.collection(name).get();
    await Promise.all(snapshot.docs.map(doc => doc.ref.delete()));
  }
  await db.doc('roles/admin_uid').set({ role: 'admin' });
  await db.doc('roles/client_uid').set({ role: 'client' });
};

const callsOf = method => stripe.calls.filter(call => call.method === method);

async function seedClient(id = 'client_a', autopay = { enabled: false }) {
  await db.doc(`billingClients/${id}`).set({
    name: 'Example Co', contactName: 'Pat Example', billingEmails: ['billing@example.com'],
    leadRateCents: 5000, active: true, autopay
  });
  return { id, ...(await db.doc(`billingClients/${id}`).get()).data() };
}

async function seedInvoice(id = 'inv_1', overrides = {}) {
  await db.doc(`invoices/${id}`).set({
    clientId: 'client_a', number: 'INV-1001', periodLabel: 'October 2026', totalCents: 240000,
    currency: 'usd', status: 'sent', autopay: false, payment: {}, ...overrides
  });
  return { id, ...(await db.doc(`invoices/${id}`).get()).data() };
}

const readInvoice = async id => (await db.doc(`invoices/${id}`).get()).data();
const readClient = async id => (await db.doc(`billingClients/${id}`).get()).data();

const enrolled = { enabled: true, stripeCustomerId: 'cus_saved', defaultPaymentMethodId: 'pm_saved' };

// ---------------------------------------------------------------- HTTP harness

function fakeRes() {
  const out = { code: 200, body: null, headers: {}, location: '' };
  const res = {
    set(key, value) { out.headers[key] = value; return res; },
    status(code) { out.code = code; return res; },
    json(body) { out.body = body; return res; },
    send(body) { out.body = body; return res; },
    redirect(code, location) { out.code = code; out.location = location; return res; }
  };
  return { res, out };
}

async function deliver(event, { secret = FAKE_WEBHOOK_SECRET, tamper = false } = {}) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const rawBody = Buffer.from(tamper ? payload.replace('"livemode":false', '"livemode":true') : payload);
  const headers = { 'stripe-signature': signature };
  const { res, out } = fakeRes();
  await api.stripeWebhook({ method: 'POST', rawBody, body: JSON.parse(payload), headers, get: name => headers[name.toLowerCase()] }, res);
  return out;
}

let eventSeq = 0;
const event = (type, object, extra = {}) => ({
  id: `evt_test_${++eventSeq}`, object: 'event', type, livemode: false, created: 1_790_000_000,
  data: { object }, ...extra
});

const adminCall = (fn, data, uid = 'admin_uid') => fn.run({ data, auth: { uid, token: {} } });

// ---------------------------------------------------------------- config

test('isStripeConfigured is false without a key and refuses live keys unless authorized', () => {
  billing.__setStripeForTests(null);
  const saved = { key: process.env.STRIPE_SECRET_KEY, live: process.env.STRIPE_LIVE_MODE_AUTHORIZED };
  try {
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(billing.isStripeConfigured(), false);
    process.env.STRIPE_SECRET_KEY = FAKE_SECRET_KEY;
    assert.equal(billing.isStripeConfigured(), true);
    process.env.STRIPE_SECRET_KEY = ['sk', 'live', 'z'.repeat(24)].join('_');
    assert.equal(billing.isStripeConfigured(), false);
    assert.throws(() => billing.getStripe(), /live billing is not authorized/);
    process.env.STRIPE_LIVE_MODE_AUTHORIZED = 'true';
    assert.equal(billing.isStripeConfigured(), true);
    process.env.STRIPE_SECRET_KEY = 'not-a-key';
    assert.equal(billing.isStripeConfigured(), false);
  } finally {
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
    if (saved.live === undefined) delete process.env.STRIPE_LIVE_MODE_AUTHORIZED; else process.env.STRIPE_LIVE_MODE_AUTHORIZED = saved.live;
  }
});

// ---------------------------------------------------------------- Pay Now

test('createPayNowLink creates the customer once, a card + ACH session, and a stable link', async () => {
  await reset();
  const client = await seedClient();
  const invoice = await seedInvoice();
  const first = await billing.createPayNowLink(invoice, client);

  assert.match(first.url, /^https:\/\/bitesites\.org\/api\/pay\/[A-Za-z0-9_-]{32}$/);
  const [create] = callsOf('checkout.sessions.create');
  assert.equal(create.params.mode, 'payment');
  assert.equal(create.params.payment_method_types, undefined, 'Checkout no longer accepts payment_method_types');
  const bankConfig = stripe.configurations.find(c => c.id === create.params.payment_method_configuration);
  assert.equal(bankConfig.name, 'BiteSites invoices — bank (ACH) only');
  assert.equal(bankConfig.us_bank_account.display_preference.preference, 'on');
  assert.equal(bankConfig.card.display_preference.preference, 'off');
  assert.equal(bankConfig.klarna.display_preference.preference, 'off');
  assert.equal(create.params.payment_method_options.us_bank_account.verification_method, 'automatic', 'instant verification, micro-deposits as fallback');
  assert.equal(create.params.line_items[0].price_data.unit_amount, 240000);
  assert.deepEqual(create.params.metadata, { invoiceId: 'inv_1', clientId: 'client_a', invoiceNumber: 'INV-1001', source: 'pay_now', method: 'bank' });
  assert.deepEqual(create.params.payment_intent_data.metadata, create.params.metadata);
  assert.ok(create.params.expires_at - Math.floor(Date.now() / 1000) <= 24 * 3600);
  assert.ok(create.params.expires_at - Math.floor(Date.now() / 1000) > 23 * 3600);
  assert.match(create.params.success_url, /^https:\/\/bitesites\.org\/pay\/success\?/);
  const token = first.url.split('/').pop();
  assert.equal(create.params.cancel_url, `https://bitesites.org/pay/cancel?pay=${token}&method=bank&alt=card`);
  assert.equal(first.cardUrl, `${first.url}?method=card`);

  const stored = await readInvoice('inv_1');
  assert.equal(stored.payment.payNowUrl, first.url);
  assert.equal(stored.payment.stripeCheckoutSessionId, first.sessionId);
  assert.equal(stored.status, 'sent', 'creating a link does not change status');
  assert.equal((await readClient('client_a')).autopay.stripeCustomerId, create.params.customer);
  assert.equal((await readClient('client_a')).autopay.enabled, false);

  // Again: same link, same open session, no new customer.
  const second = await billing.createPayNowLink(await readInvoice('inv_1').then(d => ({ id: 'inv_1', ...d })), await readClient('client_a').then(d => ({ id: 'client_a', ...d })));
  assert.equal(second.url, first.url);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(callsOf('customers.create').length, 1);
  assert.equal(callsOf('checkout.sessions.create').length, 1);
});

test('createPayNowLink refuses void, paid, and sub-minimum invoices', async () => {
  await reset();
  const client = await seedClient();
  for (const [overrides, pattern] of [
    [{ status: 'void' }, /void/], [{ status: 'paid' }, /already paid/],
    [{ totalCents: 10 }, /at least 50/], [{ totalCents: 12.5 }, /whole number/]
  ]) {
    await assert.rejects(billing.createPayNowLink(await seedInvoice('inv_x', overrides), client), pattern);
  }
  assert.equal(callsOf('checkout.sessions.create').length, 0);
});

test('the stable link redirects to the open session, re-mints a lapsed one, and stops once paid', async () => {
  await reset();
  const client = await seedClient();
  const { url, sessionId } = await billing.createPayNowLink(await seedInvoice(), client);
  const token = url.split('/').pop();

  assert.equal(await billing.resolvePayLink(token), stripe.sessions.get(sessionId).url);

  stripe.sessions.get(sessionId).status = 'expired';
  const fresh = await billing.resolvePayLink(token);
  assert.notEqual(fresh, stripe.sessions.get(sessionId).url);
  const link = (await db.doc(`billingPayLinks/${token}`).get()).data();
  assert.equal(link.attempts.bank, 2);
  assert.equal((await readInvoice('inv_1')).payment.payNowUrl, url, 'the emailed URL never changes');

  await db.doc('invoices/inv_1').set({ status: 'paid' }, { merge: true });
  assert.equal(await billing.resolvePayLink(token), 'https://bitesites.org/pay/success?status=paid');
  assert.equal(await billing.resolvePayLink('short'), 'https://bitesites.org/pay/cancel?reason=invalid');
  assert.equal(await billing.resolvePayLink('x'.repeat(32)), 'https://bitesites.org/pay/cancel?reason=invalid');
});

test('a settling bank payment is not offered a second checkout', async () => {
  await reset();
  const client = await seedClient();
  const { url, sessionId } = await billing.createPayNowLink(await seedInvoice(), client);
  Object.assign(stripe.sessions.get(sessionId), { status: 'complete', payment_status: 'unpaid' });
  assert.equal(await billing.resolvePayLink(url.split('/').pop()), 'https://bitesites.org/pay/success?status=processing');
  assert.equal(callsOf('checkout.sessions.create').length, 1);
});

test('billingPayNow redirects with 303 and never leaks an error', async () => {
  await reset();
  const client = await seedClient();
  const { url } = await billing.createPayNowLink(await seedInvoice(), client);
  const path = new URL(url).pathname;
  const { res, out } = fakeRes();
  await api.billingPayNow({ method: 'GET', path, headers: {}, get: () => '' }, res);
  assert.equal(out.code, 303);
  assert.match(out.location, /^https:\/\/checkout\.stripe\.test\//);

  const bad = fakeRes();
  await api.billingPayNow({ method: 'POST', path, headers: {}, get: () => '' }, bad.res);
  assert.equal(bad.out.code, 405);
});

test('refreshPayNowLink expires the old session and keeps the same URL', async () => {
  await reset();
  await seedClient();
  await seedInvoice();
  const before = await billing.createPayNowLink({ id: 'inv_1', ...(await readInvoice('inv_1')) }, { id: 'client_a', ...(await readClient('client_a')) });
  const after = await adminCall(api.refreshPayNowLink, { invoiceId: 'inv_1' });
  assert.equal(after.url, before.url);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.equal(stripe.sessions.get(before.sessionId).status, 'expired');
  assert.equal((await readInvoice('inv_1')).payment.stripeCheckoutSessionId, after.sessionId);
  await assert.rejects(adminCall(api.refreshPayNowLink, { invoiceId: 'inv_1' }, 'client_uid'), { code: 'permission-denied' });
  await assert.rejects(api.refreshPayNowLink.run({ data: { invoiceId: 'inv_1' } }), { code: 'unauthenticated' });
});

// ---------------------------------------------------------------- autopay

test('chargeAutopay charges off-session with the invoice id as the idempotency key', async () => {
  await reset();
  const client = await seedClient('client_a', enrolled);
  const invoice = await seedInvoice('inv_1', { autopay: true });
  const result = await billing.chargeAutopay(invoice, client);

  assert.equal(result.status, 'succeeded');
  const [create] = callsOf('paymentIntents.create');
  assert.equal(create.options.idempotencyKey, 'inv_1');
  assert.equal(create.params.off_session, true);
  assert.equal(create.params.confirm, true);
  assert.equal(create.params.amount, 240000);
  assert.equal(create.params.customer, 'cus_saved');
  assert.equal(create.params.payment_method, 'pm_saved');
  assert.equal(create.params.metadata.source, 'autopay');
  assert.equal(create.params.payment_method_types, undefined);
  assert.equal(stripe.configurations.find(c => c.id === create.params.payment_method_configuration).name, 'BiteSites invoices — bank (ACH) only');

  const stored = await readInvoice('inv_1');
  assert.equal(stored.status, 'paid');
  assert.equal(stored.payment.method, 'stripe');
  assert.equal(stored.payment.stripePaymentIntentId, result.paymentIntentId);
  assert.ok(stored.payment.paidAt);

  // The invoicing side retrying after a timeout must not charge twice.
  const again = await billing.chargeAutopay({ id: 'inv_1', ...invoice }, client);
  assert.equal(again.paymentIntentId, result.paymentIntentId);
  assert.equal(new Set(stripe.intents.keys()).size, 1);
});

test('chargeAutopay that needs the client marks payment_failed and falls back to Pay Now', async () => {
  await reset();
  const client = await seedClient('client_a', enrolled);
  stripe.nextIntentOutcome = 'requires_action';
  const result = await billing.chargeAutopay(await seedInvoice('inv_1', { autopay: true }), client);
  assert.equal(result.status, 'failed');
  assert.match(result.payNowUrl, /\/api\/pay\//);
  const stored = await readInvoice('inv_1');
  assert.equal(stored.status, 'payment_failed');
  assert.equal(stored.payment.payNowUrl, result.payNowUrl);
  assert.equal(stored.payment.lastError, 'Authentication required.');
});

test('a declined card (thrown StripeCardError) marks payment_failed with a Pay Now link', async () => {
  await reset();
  const client = await seedClient('client_a', enrolled);
  stripe.nextIntentOutcome = 'card_error';
  const result = await billing.chargeAutopay(await seedInvoice('inv_1', { autopay: true }), client);
  assert.equal(result.status, 'failed');
  assert.ok(result.paymentIntentId);
  assert.ok(result.payNowUrl);
  assert.equal((await readInvoice('inv_1')).status, 'payment_failed');
});

test('a bank debit is processing: no status change, intent recorded, no second charge', async () => {
  await reset();
  const client = await seedClient('client_a', enrolled);
  stripe.nextIntentOutcome = 'processing';
  const result = await billing.chargeAutopay(await seedInvoice('inv_1', { autopay: true }), client);
  assert.equal(result.status, 'processing');
  const stored = await readInvoice('inv_1');
  assert.equal(stored.status, 'sent');
  assert.equal(stored.payment.stripePaymentIntentId, result.paymentIntentId);

  // Even the admin's deliberate retry refuses while a debit is settling.
  const retry = await adminCall(api.chargeInvoiceNow, { invoiceId: 'inv_1' });
  assert.equal(retry.status, 'processing');
  assert.equal(callsOf('paymentIntents.create').length, 1);
});

test('chargeAutopay without enrollment charges nothing and returns a Pay Now link', async () => {
  await reset();
  const client = await seedClient();
  const result = await billing.chargeAutopay(await seedInvoice('inv_1', { autopay: true }), client);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'not_enrolled');
  assert.ok(result.payNowUrl);
  assert.equal(callsOf('paymentIntents.create').length, 0);
  assert.equal((await readInvoice('inv_1')).status, 'payment_failed');
});

test('chargeInvoiceNow retries a failed charge with a fresh key and is admin-only', async () => {
  await reset();
  await seedClient('client_a', enrolled);
  stripe.nextIntentOutcome = 'card_error';
  await billing.chargeAutopay(await seedInvoice('inv_1', { autopay: true }), await readClient('client_a'));
  assert.equal((await readInvoice('inv_1')).status, 'payment_failed');

  await assert.rejects(adminCall(api.chargeInvoiceNow, { invoiceId: 'inv_1' }, 'client_uid'), { code: 'permission-denied' });
  stripe.nextIntentOutcome = 'succeeded';
  const result = await adminCall(api.chargeInvoiceNow, { invoiceId: 'inv_1' });
  assert.equal(result.status, 'succeeded');
  const keys = callsOf('paymentIntents.create').map(call => call.options.idempotencyKey);
  assert.deepEqual(keys, ['inv_1', 'inv_1:retry-1']);
  assert.equal((await readInvoice('inv_1')).status, 'paid');

  await seedInvoice('inv_manual', { autopay: false });
  await assert.rejects(adminCall(api.chargeInvoiceNow, { invoiceId: 'inv_manual' }), { code: 'failed-precondition' });
});

test('setAutopay refuses on without a saved method, and toggles with one', async () => {
  await reset();
  await seedClient('client_a', { enabled: false, stripeCustomerId: 'cus_saved' });
  await assert.rejects(adminCall(api.setAutopay, { clientId: 'client_a', enabled: true }), { code: 'failed-precondition' });
  await assert.rejects(adminCall(api.setAutopay, { clientId: 'client_a', enabled: 'yes' }), { code: 'invalid-argument' });
  await db.doc('billingClients/client_a').set({ autopay: { defaultPaymentMethodId: 'pm_saved' } }, { merge: true });
  assert.deepEqual(await adminCall(api.setAutopay, { clientId: 'client_a', enabled: true }), { enabled: true });
  assert.equal((await readClient('client_a')).autopay.enabled, true);
  assert.deepEqual(await adminCall(api.setAutopay, { clientId: 'client_a', enabled: false }), { enabled: false });
  const autopay = (await readClient('client_a')).autopay;
  assert.equal(autopay.enabled, false);
  assert.equal(autopay.defaultPaymentMethodId, 'pm_saved', 'turning off keeps the method so it can be turned back on');
});

test('createAutopaySetupLink opens a setup-mode session for card + ACH', async () => {
  await reset();
  await seedClient();
  const result = await adminCall(api.createAutopaySetupLink, { clientId: 'client_a' });
  assert.match(result.url, /^https:\/\/checkout\.stripe\.test\//);
  const [create] = callsOf('checkout.sessions.create');
  assert.equal(create.params.mode, 'setup');
  assert.equal(create.params.payment_method_types, undefined);
  assert.equal(stripe.configurations.find(c => c.id === create.params.payment_method_configuration).name, 'BiteSites invoices — bank (ACH) only');
  assert.equal(create.params.payment_method_options.us_bank_account.verification_method, 'automatic');
  assert.deepEqual(create.params.setup_intent_data.metadata, { clientId: 'client_a', source: 'autopay_setup', method: 'bank' });
  assert.equal(result.method, 'bank');

  const card = await adminCall(api.createAutopaySetupLink, { clientId: 'client_a', method: 'card' });
  assert.equal(card.method, 'card');
  const cardCreate = callsOf('checkout.sessions.create').at(-1);
  assert.equal(stripe.configurations.find(c => c.id === cardCreate.params.payment_method_configuration).name, 'BiteSites invoices — card only');
  assert.equal(cardCreate.params.payment_method_options, undefined);
  assert.equal(callsOf('paymentMethodConfigurations.create').length, 2, 'each configuration is created once, then reused');
  assert.equal((await readClient('client_a')).autopay.enabled, false, 'sending the link does not enable autopay');
  await assert.rejects(adminCall(api.createAutopaySetupLink, { clientId: '../etc' }), { code: 'invalid-argument' });
});

// ---------------------------------------------------------------- webhook

test('webhook rejects a bad signature and a tampered body', async () => {
  await reset();
  const evt = event('payment_intent.succeeded', { id: 'pi_x', metadata: { invoiceId: 'inv_1' } });
  assert.equal((await deliver(evt, { secret: ['whsec', 'w'.repeat(24)].join('_') })).code, 400);
  assert.equal((await deliver(evt, { tamper: true })).code, 400);
  const { res, out } = fakeRes();
  await api.stripeWebhook({ method: 'GET', headers: {}, get: () => '' }, res);
  assert.equal(out.code, 405);
});

test('checkout.session.completed (setup) enrolls autopay; redelivery is a no-op', async () => {
  await reset();
  await seedClient('client_a', { enabled: false, stripeCustomerId: 'cus_saved' });
  stripe.setupIntentStore.set('seti_1', { id: 'seti_1', status: 'succeeded', payment_method: 'pm_new', customer: 'cus_saved' });
  const evt = event('checkout.session.completed', {
    id: 'cs_setup', object: 'checkout.session', mode: 'setup', customer: 'cus_saved',
    setup_intent: 'seti_1', metadata: { clientId: 'client_a', source: 'autopay_setup' }
  });
  const first = await deliver(evt);
  assert.equal(first.code, 200);
  assert.equal(first.body.outcome, 'autopay-enrolled');
  const autopay = (await readClient('client_a')).autopay;
  assert.equal(autopay.enabled, true);
  assert.equal(autopay.defaultPaymentMethodId, 'pm_new');
  assert.equal(autopay.stripeCustomerId, 'cus_saved');
  assert.deepEqual(callsOf('customers.update')[0].params.invoice_settings, { default_payment_method: 'pm_new' });

  const second = await deliver(evt);
  assert.equal(second.body.duplicate, true);
  assert.equal(callsOf('customers.update').length, 1);
  assert.ok((await db.doc(`stripeEvents/${evt.id}`).get()).exists);
});

test('a bank account awaiting micro-deposits enrolls only on setup_intent.succeeded', async () => {
  await reset();
  await seedClient('client_a', { enabled: false, stripeCustomerId: 'cus_saved' });
  stripe.setupIntentStore.set('seti_2', { id: 'seti_2', status: 'requires_action', payment_method: 'pm_bank', customer: 'cus_saved' });
  await deliver(event('checkout.session.completed', {
    id: 'cs_setup2', mode: 'setup', customer: 'cus_saved', setup_intent: 'seti_2', metadata: { clientId: 'client_a', source: 'autopay_setup' }
  }));
  let autopay = (await readClient('client_a')).autopay;
  assert.equal(autopay.enabled, false);
  assert.equal(autopay.pendingSetupIntentId, 'seti_2');

  await deliver(event('setup_intent.succeeded', {
    id: 'seti_2', status: 'succeeded', payment_method: 'pm_bank', customer: 'cus_saved', metadata: { clientId: 'client_a', source: 'autopay_setup' }
  }));
  autopay = (await readClient('client_a')).autopay;
  assert.equal(autopay.enabled, true);
  assert.equal(autopay.defaultPaymentMethodId, 'pm_bank');
  assert.equal(autopay.pendingSetupIntentId, undefined);
});

test('Pay Now by card: checkout.session.completed marks the invoice paid', async () => {
  await reset();
  await seedClient();
  await seedInvoice();
  const out = await deliver(event('checkout.session.completed', {
    id: 'cs_pay', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_card', amount_total: 240000,
    client_reference_id: 'inv_1', metadata: { invoiceId: 'inv_1', clientId: 'client_a', source: 'pay_now' }
  }));
  assert.equal(out.body.outcome, 'invoice-paid');
  const stored = await readInvoice('inv_1');
  assert.equal(stored.status, 'paid');
  assert.equal(stored.payment.method, 'stripe');
  assert.equal(stored.payment.stripePaymentIntentId, 'pi_card');
  assert.equal(stored.payment.stripeCheckoutSessionId, 'cs_pay');
  assert.equal(stored.payment.amountPaidCents, 240000);
});

test('Pay Now by ACH: processing, then async success; a failed debit marks payment_failed', async () => {
  await reset();
  await seedClient();
  await seedInvoice('inv_1');
  await seedInvoice('inv_2');
  const session = (invoiceId, id) => ({
    id, mode: 'payment', payment_status: 'unpaid', payment_intent: `pi_${id}`, amount_total: 240000,
    metadata: { invoiceId, clientId: 'client_a', source: 'pay_now' }
  });

  assert.equal((await deliver(event('checkout.session.completed', session('inv_1', 'cs_a')))).body.outcome, 'invoice-processing');
  assert.equal((await readInvoice('inv_1')).status, 'sent');
  assert.ok((await readInvoice('inv_1')).payment.processingAt);
  await deliver(event('checkout.session.async_payment_succeeded', { ...session('inv_1', 'cs_a'), payment_status: 'paid' }));
  assert.equal((await readInvoice('inv_1')).status, 'paid');

  await deliver(event('checkout.session.completed', session('inv_2', 'cs_b')));
  await deliver(event('checkout.session.async_payment_failed', session('inv_2', 'cs_b')));
  const failed = await readInvoice('inv_2');
  assert.equal(failed.status, 'payment_failed');
  assert.equal(failed.payment.lastError, 'The bank payment failed.');
});

test('payment_intent events: autopay failures count, in-checkout attempts do not', async () => {
  await reset();
  await seedClient('client_a', enrolled);
  await seedInvoice('inv_1', { autopay: true });
  const ignored = await deliver(event('payment_intent.payment_failed', {
    id: 'pi_try', metadata: { invoiceId: 'inv_1', source: 'pay_now' }, last_payment_error: { message: 'Declined' }
  }));
  assert.equal(ignored.body.outcome, 'ignored');
  assert.equal((await readInvoice('inv_1')).status, 'sent');

  // An ACH autopay debit that bounced days later.
  const failed = await deliver(event('payment_intent.payment_failed', {
    id: 'pi_auto', metadata: { invoiceId: 'inv_1', source: 'autopay' }, last_payment_error: { message: 'Insufficient funds' }
  }));
  assert.equal(failed.body.outcome, 'invoice-payment-failed');
  const stored = await readInvoice('inv_1');
  assert.equal(stored.status, 'payment_failed');
  assert.equal(stored.payment.lastError, 'Insufficient funds');
  assert.ok(stored.payment.payNowUrl, 'a Pay Now link is generated as the fallback');

  await deliver(event('payment_intent.succeeded', { id: 'pi_auto2', amount: 240000, amount_received: 240000, metadata: { invoiceId: 'inv_1', source: 'autopay' } }));
  assert.equal((await readInvoice('inv_1')).status, 'paid');

  // payment_failed never overwrites paid.
  await deliver(event('payment_intent.payment_failed', { id: 'pi_late', metadata: { invoiceId: 'inv_1', source: 'autopay' } }));
  assert.equal((await readInvoice('inv_1')).status, 'paid');
});

test('a second payment for a paid invoice is flagged, not overwritten', async () => {
  await reset();
  await seedInvoice('inv_1', { status: 'paid', payment: { method: 'stripe', stripePaymentIntentId: 'pi_first' } });
  await deliver(event('payment_intent.succeeded', { id: 'pi_second', amount: 240000, metadata: { invoiceId: 'inv_1', source: 'pay_now' } }));
  const stored = await readInvoice('inv_1');
  assert.equal(stored.payment.stripePaymentIntentId, 'pi_first');
  assert.deepEqual(stored.payment.duplicatePaymentIntentIds, ['pi_second']);
});

test('charge.refunded records the refund without guessing a status', async () => {
  await reset();
  await seedInvoice('inv_1', { status: 'paid', payment: { method: 'stripe', stripePaymentIntentId: 'pi_r' } });
  stripe.intents.set('pi_r', { id: 'pi_r', metadata: { invoiceId: 'inv_1' } });
  await deliver(event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_r', amount_refunded: 240000, refunded: true, metadata: {} }));
  const stored = await readInvoice('inv_1');
  assert.equal(stored.status, 'paid');
  assert.equal(stored.payment.refundedCents, 240000);
  assert.equal(stored.payment.fullyRefunded, true);
});

test('payment_method.detached turns autopay off for the client using it', async () => {
  await reset();
  await seedClient('client_a', enrolled);
  await seedClient('client_b', { enabled: true, stripeCustomerId: 'cus_b', defaultPaymentMethodId: 'pm_other' });
  const out = await deliver(event('payment_method.detached', { id: 'pm_saved', object: 'payment_method' }));
  assert.equal(out.body.outcome, 'autopay-disabled');
  const a = (await readClient('client_a')).autopay;
  assert.equal(a.enabled, false);
  assert.equal(a.defaultPaymentMethodId, undefined);
  assert.equal((await readClient('client_b')).autopay.enabled, true);
});

test('live-mode events are ignored unless live billing is authorized', async () => {
  await reset();
  await seedInvoice('inv_1');
  const out = await deliver(event('payment_intent.succeeded', { id: 'pi_live', metadata: { invoiceId: 'inv_1' } }, { livemode: true }));
  assert.equal(out.body.outcome, 'ignored-live-mode-not-authorized');
  assert.equal((await readInvoice('inv_1')).status, 'sent');
});

// ---------------------------------------------------------------- bank first

test('the card alternative is a separate card-only checkout behind the same link', async () => {
  await reset();
  const client = await seedClient();
  const { url } = await billing.createPayNowLink(await seedInvoice(), client);
  const token = url.split('/').pop();
  const cardCheckout = await billing.resolvePayLink(token, 'card');
  const cardCreate = callsOf('checkout.sessions.create').at(-1);
  assert.equal(stripe.configurations.find(c => c.id === cardCreate.params.payment_method_configuration).name, 'BiteSites invoices — card only');
  assert.equal(cardCreate.params.metadata.method, 'card');
  assert.equal(cardCreate.params.cancel_url, `https://bitesites.org/pay/cancel?pay=${token}&method=card&alt=bank`);
  assert.equal(cardCheckout, stripe.sessions.get([...stripe.sessions.keys()].at(-1)).url);
  // Asking again reuses each open session rather than minting more.
  assert.equal(await billing.resolvePayLink(token, 'card'), cardCheckout);
  assert.equal((await readInvoice('inv_1')).payment.payNowUrl, url, 'the stored link stays the bank link');
  assert.equal(callsOf('checkout.sessions.create').length, 2);

  const { res, out } = fakeRes();
  await api.billingPayNow({ method: 'GET', path: `/${token}`, query: { method: 'card' }, headers: {}, get: () => '' }, res);
  assert.equal(out.location, cardCheckout);
});

test('payNowOptions lists bank (ACH) first, then card', async () => {
  await reset();
  const client = await seedClient();
  const { url } = await billing.createPayNowLink(await seedInvoice(), client);
  const options = billing.payNowOptions(await readInvoice('inv_1'));
  assert.deepEqual(options.map(option => [option.method, option.label, option.primary]),
    [['bank', 'Pay by bank (ACH)', true], ['card', 'Pay by card', false]]);
  assert.equal(options[0].url, url);
  assert.equal(options[1].url, `${url}?method=card`);
  assert.deepEqual(billing.payNowOptions({ payment: { payNowUrl: 'https://evil.example/pay' } }), []);
});

test('a client paying the bank invoice by card closes the open bank checkout', async () => {
  await reset();
  const client = await seedClient();
  const { url, sessionId: bankSession } = await billing.createPayNowLink(await seedInvoice(), client);
  await billing.resolvePayLink(url.split('/').pop(), 'card');
  const cardSession = [...stripe.sessions.keys()].at(-1);
  await deliver(event('checkout.session.completed', {
    id: cardSession, mode: 'payment', payment_status: 'paid', payment_intent: 'pi_card', amount_total: 240000,
    metadata: { invoiceId: 'inv_1', clientId: 'client_a', source: 'pay_now', method: 'card' }
  }));
  assert.equal((await readInvoice('inv_1')).status, 'paid');
  assert.equal(stripe.sessions.get(bankSession).status, 'expired');
});

test('a card on file is charged through the card-only configuration', async () => {
  await reset();
  const client = await seedClient('client_a', { ...enrolled, defaultPaymentMethodId: 'pm_card' });
  stripe.paymentMethodStore.set('pm_card', { id: 'pm_card', type: 'card' });
  await billing.chargeAutopay(await seedInvoice('inv_1', { autopay: true }), client);
  const [create] = callsOf('paymentIntents.create');
  assert.equal(stripe.configurations.find(c => c.id === create.params.payment_method_configuration).name, 'BiteSites invoices — card only');
});

test('a bad request that is not about the payment method is not blamed on the client', async () => {
  await reset();
  const client = await seedClient('client_a', enrolled);
  stripe.paymentIntents.create = async () => {
    throw Object.assign(new Error('The `payment_method_types` parameter is no longer supported.'), { type: 'StripeInvalidRequestError', param: 'payment_method_types' });
  };
  await assert.rejects(billing.chargeAutopay(await seedInvoice('inv_1', { autopay: true }), client), /no longer supported/);
  assert.equal((await readInvoice('inv_1')).status, 'sent');

  stripe.paymentIntents.create = async () => {
    throw Object.assign(new Error('No such PaymentMethod'), { type: 'StripeInvalidRequestError', param: 'payment_method', code: 'resource_missing' });
  };
  const result = await billing.chargeAutopay(await seedInvoice('inv_2', { autopay: true }), client);
  assert.equal(result.status, 'failed');
  assert.equal((await readInvoice('inv_2')).status, 'payment_failed');
});

test('createPayNowLink accepts a draft being finalized; the link refuses a draft', async () => {
  await reset();
  const client = await seedClient();
  const { url } = await billing.createPayNowLink(await seedInvoice('inv_1', { status: 'draft' }), client);
  assert.equal(await billing.resolvePayLink(url.split('/').pop()), 'https://bitesites.org/pay/cancel?reason=unavailable');
  assert.equal(billing.stripeSecrets, billing.STRIPE_SECRETS, 'the name the invoicing loader looks for');
});
