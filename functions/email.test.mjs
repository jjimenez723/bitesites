import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
  addBroadcastUnsubscribe, DEFAULT_EMAIL_TEMPLATES, buildLeadOutreachTemplate, buildMessage, normalizeEmailActions,
  renderTemplate, resendEventPolicy, resendIds, resendTagValue, sendResend, verifyResendWebhook
} from './email.js';

test('renders known variables in all message parts', () => {
  const result = renderTemplate({
    subject: 'Hello {{first_name}}',
    html: '<p>{{ first_name }}</p><a href="{{url}}">Go</a>',
    text: 'Hello {{first_name}}: {{url}}'
  }, { first_name: 'Alex', url: 'https://example.com/a?b=1&c=2' });
  assert.equal(result.subject, 'Hello Alex');
  assert.match(result.html, /<p>Alex<\/p>/);
  assert.match(result.html, /b=1&amp;c=2/);
  assert.equal(result.text, 'Hello Alex: https://example.com/a?b=1&c=2');
});

test('escapes admin-provided recipient variables in HTML', () => {
  const result = renderTemplate({ subject: '{{headline}}', html: '<h1>{{headline}}</h1>', text: '{{headline}}' }, {
    headline: '<img src=x onerror=alert(1)>'
  });
  assert.doesNotMatch(result.html, /<img/);
  assert.match(result.html, /&lt;img/);
});

test('builds multipart Resend messages without leaking template markup', () => {
  const message = buildMessage({
    from: 'BiteSites <jensy@bitesites.org>',
    to: 'alex@example.com',
    template: DEFAULT_EMAIL_TEMPLATES.password_reset,
    variables: { first_name: 'Alex', reset_url: 'https://example.com/reset' },
    stream: 'outbound',
    tag: 'password-reset'
  });
  assert.deepEqual(message.to, ['alex@example.com']);
  assert.equal(message.from, 'BiteSites <jensy@bitesites.org>');
  assert.deepEqual(message.tags, [{ name: 'stream', value: 'outbound' }, { name: 'category', value: 'password-reset' }]);
  assert.match(message.html, /https:\/\/example.com\/reset/);
  assert.doesNotMatch(message.text, /{{/);
  assert.equal('HtmlBody' in message, false);
});

test('system templates include the BiteSites logo and resolve branded defaults', () => {
  for (const template of Object.values(DEFAULT_EMAIL_TEMPLATES)) {
    const message = buildMessage({
      from: 'BiteSites <jensy@bitesites.org>',
      to: 'alex@example.com',
      template,
      variables: {
        first_name: 'Alex', email: 'alex@example.com', company: 'Example Co',
        verify_url: 'https://example.com/verify', pricing_url: 'https://example.com/pricing',
        reset_url: 'https://example.com/reset', admin_url: 'https://example.com/admin',
        headline: 'A brighter digital experience', message: 'A short update from BiteSites.',
        cta_label: 'Learn more', cta_url: 'https://example.com'
      }
    });
    assert.match(message.html, /https:\/\/bitesites\.org\/apple-touch-icon\.png/);
    assert.doesNotMatch(message.html, /{{\s*(brand_url|logo_url)\s*}}/);
  }
});

test('system templates use the simple white email layout', () => {
  for (const template of Object.values(DEFAULT_EMAIL_TEMPLATES)) {
    assert.match(template.html, /background:#ffffff/);
    assert.ok(template.html.indexOf('{{logo_url}}') < template.html.indexOf('<h1'));
    assert.doesNotMatch(template.html, /#080b16|#111625|#161d2d|Beautiful sites, thoughtful systems/);
  }
});

test('covers the account, lead, feedback, access, broadcast, and operations lifecycle', () => {
  const expected = [
    'welcome', 'password_reset', 'new_account_admin', 'lead_received',
    'meeting_booked', 'meeting_booked_video', 'conversation_feedback', 'new_lead_admin', 'manual_lead_admin',
    'outbound_call_lead_admin', 'access_granted',
    'access_revoked', 'operational_alert', 'announcement'
  ];
  assert.deepEqual(Object.keys(DEFAULT_EMAIL_TEMPLATES).sort(), expected.sort());
});

test('manual and verified-call lead alerts cannot be confused', () => {
  const manual = buildMessage({
    from: 'BiteSites <jensy@bitesites.org>', to: 'sales@example.com',
    template: DEFAULT_EMAIL_TEMPLATES.manual_lead_admin,
    variables: {
      lead_name: 'H & S Contracting', qualified_by: 'Manager',
      contact_status: 'No BiteSites call or contact is recorded', contact: '(347) 698-6352',
      manual_reason: 'Research-qualified account', manual_notes: 'No conversation yet.',
      service_names: 'Interest not captured', lead_url: 'https://example.com/admin/leads?lead=1'
    }
  });
  const answered = buildMessage({
    from: 'BiteSites <jensy@bitesites.org>', to: 'sales@example.com',
    template: DEFAULT_EMAIL_TEMPLATES.outbound_call_lead_admin,
    variables: {
      lead_name: 'H & S Contracting', contact: '(347) 698-6352', disposition: 'Qualified',
      duration: '4m 12s', operator: 'Jensy', call_summary: 'Asked for a proposal.',
      service_names: 'Web development', call_url: 'https://example.com/admin/outbound?tab=history&call=1',
      lead_url: 'https://example.com/admin/leads?lead=1'
    }
  });
  assert.match(manual.subject, /manually/i);
  assert.match(manual.text, /No BiteSites call or contact is recorded/);
  assert.doesNotMatch(manual.text, /Answered outbound call/i);
  assert.match(answered.subject, /answered outbound call/i);
  assert.match(answered.text, /Open call:/);
  assert.doesNotMatch(answered.text, /added manually/i);
});

test('adds visible and one-click unsubscribe controls to broadcasts', () => {
  const message = addBroadcastUnsubscribe({
    html: '<html><body><p>Hello</p></body></html>',
    text: 'Hello'
  }, 'https://bitesites.org/email-preferences?token=abc', 'https://bitesites.org/api/email-preferences?token=abc');
  assert.match(message.html, /Manage email preferences/);
  assert.match(message.text, /email-preferences\?token=abc/);
  assert.deepEqual(message.headers, {
    'List-Unsubscribe': '<https://bitesites.org/api/email-preferences?token=abc>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  });
});

test('lead follow-ups keep custom copy escaped and include the selected meeting action', () => {
  const template = buildLeadOutreachTemplate({ withAction: true, withMeetingTime: true });
  const message = buildMessage({
    from: 'BiteSites <jensy@bitesites.org>', to: 'alex@example.com', template,
    variables: {
      first_name: 'Alex', subject_line: 'Meeting confirmed', headline: 'Meeting confirmed',
      preheader: 'A follow-up', message: 'Discuss <script>alert(1)</script>\nand next steps.',
      meeting_time: 'Tuesday, July 28 at 2:00 PM EDT',
      action_url: 'https://meet.google.com/abc-defg-hij', action_label: 'Join Google Meet',
      action_note: 'Keep this email handy.'
    }
  });
  assert.equal(message.subject, 'Meeting confirmed');
  assert.match(message.html, /Tuesday, July 28 at 2:00 PM EDT/);
  assert.match(message.html, /https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.text, /Discuss <script>alert\(1\)<\/script>/);
});

test('lead follow-ups render zero links cleanly', () => {
  const message = buildMessage({ from: 'BiteSites <jensy@bitesites.org>', to: 'alex@example.com', template: buildLeadOutreachTemplate(), variables: { first_name: 'Alex', subject_line: 'Hello', headline: 'Hello', preheader: 'Hello', message: 'Just checking in.' } });
  assert.doesNotMatch(message.html, /<a class="email-button"/);
  assert.doesNotMatch(message.text, /https:\/\//);
});

test('lead follow-ups preserve one and multiple links in HTML and text', () => {
  const actions = normalizeEmailActions([
    { label: 'Complete the quick questionnaire', url: 'https://bitesites.org/questionnaire?token=abc', kind: 'questionnaire' },
    { label: 'Choose a time', url: 'https://bitesites.org/book', kind: 'booking' },
    { label: 'Proposal & scope', url: 'https://example.com/proposal?a=1&b=2', kind: 'custom' }
  ]);
  const message = buildMessage({ from: 'BiteSites <jensy@bitesites.org>', to: 'alex@example.com', template: buildLeadOutreachTemplate({ actions }), variables: { first_name: 'Alex', subject_line: 'Next steps', headline: 'Next steps', preheader: 'Next steps', message: 'Here are the links.' } });
  for (const action of actions) {
    assert.match(message.text, new RegExp(action.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(message.html, /Complete the quick questionnaire/);
  assert.match(message.html, /Choose a time/);
  assert.match(message.html, /background:#111111/);
  assert.match(message.html, /border:1px solid #b8b8b8/);
  assert.match(message.html, /Proposal &amp; scope/);
});

test('custom link labels are escaped and invalid URLs are rejected', () => {
  const actions = normalizeEmailActions([{ label: '<img src=x onerror=alert(1)>', url: 'https://example.com', kind: 'custom' }]);
  const template = buildLeadOutreachTemplate({ actions });
  assert.doesNotMatch(template.html, /<img src=x/);
  assert.match(template.html, /&lt;img/);
  assert.throws(() => normalizeEmailActions([{ label: 'Bad', url: 'javascript:alert(1)' }]), /https/);
  assert.throws(() => normalizeEmailActions([{ label: 'Bad', url: 'http:\/\/example.com' }]), /https/);
  assert.throws(() => normalizeEmailActions([{ label: '{{message}}', url: 'https://example.com' }]), /placeholder/);
});

test('Google Meet and questionnaire actions coexist', () => {
  const actions = normalizeEmailActions([
    { label: 'Join Google Meet', url: 'https://meet.google.com/abc-defg-hij', kind: 'meeting' },
    { label: 'Complete the quick questionnaire', url: 'https://bitesites.org/questionnaire?token=abc', kind: 'questionnaire' }
  ]);
  const message = buildMessage({ from: 'BiteSites <jensy@bitesites.org>', to: 'alex@example.com', template: buildLeadOutreachTemplate({ actions, withMeetingTime: true }), variables: { first_name: 'Alex', subject_line: 'Confirmed', headline: 'Confirmed', preheader: 'Confirmed', message: 'See you then.', meeting_time: 'Tuesday at 2 PM' } });
  assert.match(message.text, /Meeting time: Tuesday at 2 PM/);
  assert.match(message.text, /Join Google Meet/);
  assert.match(message.text, /Complete the quick questionnaire/);
});

// ------------------------------------------------------------------ Resend

// A runtime-generated key in the right shape. Never a literal: this file is
// tracked and scanned by scripts/check-no-secrets.mjs.
const fakeApiKey = () => ['re', 'test', randomBytes(12).toString('hex')].join('_');

const recordingFetch = (responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    return { ok: next.status < 300, status: next.status, json: async () => next.body };
  };
  return { calls, fetchImpl };
};

test('sendResend posts a single message with bearer auth and idempotency key', async () => {
  const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { id: 'email_1' } }]);
  const message = buildMessage({ from: 'BiteSites <jensy@bitesites.org>', to: 'a@example.com', template: DEFAULT_EMAIL_TEMPLATES.password_reset, variables: {}, tag: 'password-reset' });
  const key = fakeApiKey();
  const result = await sendResend(key, message, { idempotencyKey: 'invoice-1-send-1', fetchImpl });
  assert.deepEqual(result, { id: 'email_1' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${key}`);
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'invoice-1-send-1');
  assert.deepEqual(calls[0].body.to, ['a@example.com']);
  assert.deepEqual(resendIds(result), ['email_1']);
});

test('sendResend uses the batch endpoint for several messages and keeps order', async () => {
  const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { data: [{ id: 'one' }, { id: 'two' }] } }]);
  const messages = ['a@example.com', 'b@example.com'].map(to => buildMessage({ from: 'x@bitesites.org', to, template: DEFAULT_EMAIL_TEMPLATES.announcement, variables: {} }));
  const result = await sendResend(fakeApiKey(), messages, { fetchImpl });
  assert.equal(calls[0].url, 'https://api.resend.com/emails/batch');
  assert.equal(calls[0].body.length, 2);
  assert.deepEqual(resendIds(result), ['one', 'two']);
});

test('sendResend wraps a one-element array and reports API errors', async () => {
  const ok = recordingFetch([{ status: 200, body: { id: 'solo' } }]);
  assert.deepEqual(await sendResend(fakeApiKey(), [{ to: ['a@example.com'] }], { fetchImpl: ok.fetchImpl }), [{ id: 'solo' }]);
  assert.equal(ok.calls[0].url, 'https://api.resend.com/emails');
  const bad = recordingFetch([{ status: 422, body: { name: 'validation_error', message: 'Invalid `from` field.' } }]);
  await assert.rejects(sendResend(fakeApiKey(), { to: ['a@example.com'] }, { fetchImpl: bad.fetchImpl }), /Resend 422: Invalid `from` field/);
  await assert.rejects(sendResend('', { to: ['a@example.com'] }), /RESEND_API_KEY/);
  await assert.rejects(sendResend(fakeApiKey(), [{ attachments: [{}] }, {}], { fetchImpl: ok.fetchImpl }), /attachments/);
});

test('tag values are reduced to the characters Resend accepts', () => {
  assert.equal(resendTagValue('admin-announcement v2/ok'), 'admin-announcement_v2_ok');
  assert.equal(resendTagValue(''), 'none');
});

const signedWebhook = (secret, body, { id = 'msg_123', timestamp = Math.floor(Date.now() / 1000) } = {}) => {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` };
};

test('verifies Svix-signed Resend webhooks and rejects tampering, staleness and bad secrets', () => {
  const secret = ['whsec', randomBytes(24).toString('base64')].join('_');
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc', to: ['a@example.com'] } });
  const headers = signedWebhook(secret, body);
  assert.equal(verifyResendWebhook({ payload: Buffer.from(body), headers, secret }).type, 'email.delivered');
  // Rotation: several signatures, one valid.
  assert.ok(verifyResendWebhook({ payload: body, headers: { ...headers, 'svix-signature': `v1,AAAA ${headers['svix-signature']}` }, secret }));
  assert.throws(() => verifyResendWebhook({ payload: body.replace('delivered', 'bounced'), headers, secret }), /invalid-signature/);
  assert.throws(() => verifyResendWebhook({ payload: body, headers, secret, nowSeconds: Math.floor(Date.now() / 1000) + 3600 }), /stale/);
  assert.throws(() => verifyResendWebhook({ payload: body, headers: { 'svix-id': 'x' }, secret }), /missing/);
  assert.throws(() => verifyResendWebhook({ payload: body, headers, secret: 'plain-secret' }), /not-configured/);
});

test('webhook policy suppresses complaints and hard bounces only', () => {
  const complained = resendEventPolicy({ type: 'email.complained', created_at: '2026-12-01T12:00:00Z', data: { email_id: 'e1', to: ['A@Example.com'] } });
  assert.deepEqual(complained.preferenceUpdate, { broadcasts: false, transactionalBlocked: true });
  assert.deepEqual(complained.recipients, ['a@example.com']);
  assert.equal(complained.status, 'complained');
  const hard = resendEventPolicy({ type: 'email.bounced', data: { email_id: 'e2', to: ['b@example.com'], bounce: { type: 'Permanent', message: 'No such user' } } });
  assert.deepEqual(hard.preferenceUpdate, { transactionalBlocked: true });
  assert.equal(hard.description, 'No such user');
  const soft = resendEventPolicy({ type: 'email.bounced', data: { email_id: 'e3', to: ['c@example.com'], bounce: { type: 'Transient' } } });
  assert.equal(soft.preferenceUpdate, null);
  assert.equal(resendEventPolicy({ type: 'email.delivered', data: { email_id: 'e4', to: 'd@example.com' } }).preferenceUpdate, null);
});
