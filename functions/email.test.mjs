import test from 'node:test';
import assert from 'node:assert/strict';
import { addBroadcastUnsubscribe, DEFAULT_EMAIL_TEMPLATES, buildMessage, renderTemplate } from './email.js';

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

test('builds multipart Postmark messages without leaking template markup', () => {
  const message = buildMessage({
    from: 'BiteSites <jensy@bitesites.org>',
    to: 'alex@example.com',
    template: DEFAULT_EMAIL_TEMPLATES.password_reset,
    variables: { first_name: 'Alex', reset_url: 'https://example.com/reset' },
    stream: 'outbound',
    tag: 'password-reset'
  });
  assert.equal(message.To, 'alex@example.com');
  assert.equal(message.MessageStream, 'outbound');
  assert.match(message.HtmlBody, /https:\/\/example.com\/reset/);
  assert.doesNotMatch(message.TextBody, /{{/);
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
    assert.match(message.HtmlBody, /https:\/\/bitesites\.org\/apple-touch-icon\.png/);
    assert.doesNotMatch(message.HtmlBody, /{{\s*(brand_url|logo_url)\s*}}/);
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
    'conversation_feedback', 'new_lead_admin', 'access_granted',
    'access_revoked', 'operational_alert', 'announcement'
  ];
  assert.deepEqual(Object.keys(DEFAULT_EMAIL_TEMPLATES).sort(), expected.sort());
});

test('adds visible and one-click unsubscribe controls to broadcasts', () => {
  const message = addBroadcastUnsubscribe({
    HtmlBody: '<html><body><p>Hello</p></body></html>',
    TextBody: 'Hello'
  }, 'https://bitesites.org/email-preferences?token=abc', 'https://bitesites.org/api/email-preferences?token=abc');
  assert.match(message.HtmlBody, /Manage email preferences/);
  assert.match(message.TextBody, /email-preferences\?token=abc/);
  assert.deepEqual(message.Headers, [
    { Name: 'List-Unsubscribe', Value: '<https://bitesites.org/api/email-preferences?token=abc>' },
    { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }
  ]);
});
