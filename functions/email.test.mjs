import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EMAIL_TEMPLATES, buildMessage, renderTemplate } from './email.js';

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
    from: 'BiteSites <hello@bitesites.org>',
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
