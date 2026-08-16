import test from 'node:test';
import assert from 'node:assert/strict';
import { addBroadcastUnsubscribe, DEFAULT_EMAIL_TEMPLATES, buildLeadOutreachTemplate, buildMessage, renderTemplate } from './email.js';

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
    'meeting_booked', 'conversation_feedback', 'new_lead_admin', 'manual_lead_admin',
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
  assert.match(manual.Subject, /manually/i);
  assert.match(manual.TextBody, /No BiteSites call or contact is recorded/);
  assert.doesNotMatch(manual.TextBody, /Answered outbound call/i);
  assert.match(answered.Subject, /answered outbound call/i);
  assert.match(answered.TextBody, /Open call:/);
  assert.doesNotMatch(answered.TextBody, /added manually/i);
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
  assert.equal(message.Subject, 'Meeting confirmed');
  assert.match(message.HtmlBody, /Tuesday, July 28 at 2:00 PM EDT/);
  assert.match(message.HtmlBody, /https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.doesNotMatch(message.HtmlBody, /<script>/);
  assert.match(message.TextBody, /Discuss <script>alert\(1\)<\/script>/);
});
