// Server-only email primitives shared by the auth triggers and admin console.
// Templates live in Firestore so BiteSites staff can edit them without a deploy.

export const EMAIL_BRAND = {
  name: 'BiteSites',
  // This public app icon is deliberately used instead of a build-hashed asset, so
  // it remains a stable, absolute URL in delivered email.
  logoUrl: 'https://bitesites.org/apple-touch-icon.png'
};

const EMAIL_TEMPLATE_VERSION = 4;
const fontStack = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const shell = ({ preheader, title, body, cta, footer }) => {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<style>:root{color-scheme:light;supported-color-schemes:light;}@media only screen and (max-width:620px){.email-wrap{padding:24px 20px !important;}.email-content{padding-top:32px !important;padding-bottom:32px !important;}h1{font-size:26px !important;line-height:32px !important;}}</style>
<!--[if mso]><style>table { border-collapse:collapse; } .email-button { padding:13px 20px !important; }</style><![endif]--></head>
<body style="margin:0;padding:0;background:#ffffff;color:#222222;font-family:${fontStack};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;mso-hide:all;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#ffffff;">
    <tr><td align="center" class="email-wrap" style="padding:40px 24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;">
        <tr><td align="center" style="padding:0 0 28px;border-bottom:1px solid #e8e8e8;">
          <a href="{{brand_url}}" style="display:inline-block;text-decoration:none;">
            <img src="{{logo_url}}" width="74" height="74" alt="BiteSites" style="display:block;width:74px;height:74px;border:0;" />
          </a>
        </td></tr>
        <tr><td class="email-content" style="padding:40px 0 36px;">
          <h1 style="margin:0 0 20px;color:#111111;font-family:${fontStack};font-size:30px;line-height:37px;font-weight:700;letter-spacing:-.5px;">${title}</h1>
          <div style="color:#3f3f3f;font-size:16px;line-height:26px;">${body}</div>
          ${cta ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;"><tr><td style="border-radius:8px;background:#111111;"><a class="email-button" href="${cta.href}" style="display:inline-block;padding:13px 20px;border:1px solid #111111;border-radius:8px;color:#ffffff;font-family:${fontStack};font-size:15px;line-height:20px;font-weight:700;text-decoration:none;">${cta.label}</a></td></tr></table>${cta.note ? `<p style="margin:16px 0 0;color:#6b6b6b;font-size:13px;line-height:20px;">${cta.note}</p>` : ''}` : ''}
        </td></tr>
        <tr><td style="padding:22px 0 0;border-top:1px solid #e8e8e8;">
          <p style="margin:0;color:#777777;font-size:12px;line-height:19px;">${footer}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
};

// One-to-one sales emails intentionally use the same dependable HTML shell as
// lifecycle mail, while keeping the admin's note as escaped plain text. The
// white-space style preserves paragraphs without allowing arbitrary HTML into
// a message sent from the dashboard.
export function buildLeadOutreachTemplate({ withAction = false, withMeetingTime = false } = {}) {
  const meeting = withMeetingTime
    ? '<p style="margin:20px 0 0;padding:14px 16px;border:1px solid #e5e5e5;border-radius:10px;background:#fafafa;"><span style="display:block;color:#777777;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Meeting time</span><strong style="display:block;margin-top:3px;color:#222222;font-size:15px;">{{meeting_time}}</strong></p>'
    : '';
  return {
    name: 'Lead follow-up',
    category: 'transactional',
    subject: '{{subject_line}}',
    html: shell({
      preheader: '{{preheader}}',
      title: '{{headline}}',
      body: `<p style="margin:0 0 16px;">Hi {{first_name}},</p><div style="margin:0;white-space:pre-line;">{{message}}</div>${meeting}`,
      cta: withAction ? { href: '{{action_url}}', label: '{{action_label}}', note: '{{action_note}}' } : null,
      footer: 'This is a personal follow-up from your BiteSites conversation. Reply to this email if you have any questions.'
    }),
    text: `Hi {{first_name}},\n\n{{message}}${withMeetingTime ? '\n\nMeeting time: {{meeting_time}}' : ''}${withAction ? '\n\n{{action_label}}: {{action_url}}\n\n{{action_note}}' : ''}\n\nReply to this email if you have any questions.`
  };
}

export const DEFAULT_EMAIL_TEMPLATES = {
  welcome: {
    name: 'Account confirmation',
    description: 'Sent when a BiteSites account needs its email address confirmed.',
    category: 'transactional',
    subject: 'Confirm your BiteSites email, {{first_name}}',
    html: shell({
      preheader: 'Confirm your email to finish creating your BiteSites account.',
      title: 'Confirm your email',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">Thanks for creating a BiteSites account. Confirm your email address to finish setting it up.</p>',
      cta: { href: '{{verify_url}}', label: 'Confirm email' },
      footer: 'If you did not create this account, you can safely ignore this email.'
    }),
    text: 'Hi {{first_name}},\n\nThanks for creating a BiteSites account. Confirm your email address to finish setting it up:\n{{verify_url}}\n\nIf you did not create this account, you can safely ignore this email.'
  },
  password_reset: {
    name: 'Password reset',
    description: 'Sent when someone requests a secure password reset.',
    category: 'transactional',
    subject: 'Reset your BiteSites password',
    html: shell({
      preheader: 'Use this secure link to choose a new password.',
      title: 'Reset your password',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">We received a request to reset your BiteSites password. Use the link below to choose a new one.</p>',
      cta: { href: '{{reset_url}}', label: 'Choose a new password', note: 'For your security, do not forward this email or share this link.' },
      footer: 'If you did not request a password reset, no action is needed. Your current password will remain unchanged.'
    }),
    text: 'Hi {{first_name}},\n\nWe received a request to reset your BiteSites password. Choose a new password here:\n{{reset_url}}\n\nFor your security, do not forward this email or share this link. If you did not request this, no action is needed.'
  },
  new_account_admin: {
    name: 'New account — admin notice',
    description: 'Notifies the BiteSites team when a new account is created.',
    category: 'transactional',
    subject: 'New BiteSites account: {{email}}',
    html: shell({
      preheader: 'A new visitor has created a BiteSites account.',
      title: 'New account created',
      body: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0;border-top:1px solid #e8e8e8;"><tr><td style="padding:14px 12px 14px 0;border-bottom:1px solid #e8e8e8;color:#777777;font-size:13px;font-weight:600;width:28%;">Name</td><td style="padding:14px 0;border-bottom:1px solid #e8e8e8;color:#222222;font-size:14px;">{{first_name}}</td></tr><tr><td style="padding:14px 12px 14px 0;border-bottom:1px solid #e8e8e8;color:#777777;font-size:13px;font-weight:600;">Email</td><td style="padding:14px 0;border-bottom:1px solid #e8e8e8;color:#222222;font-size:14px;word-break:break-word;">{{email}}</td></tr><tr><td style="padding:14px 12px 14px 0;border-bottom:1px solid #e8e8e8;color:#777777;font-size:13px;font-weight:600;">Company</td><td style="padding:14px 0;border-bottom:1px solid #e8e8e8;color:#222222;font-size:14px;">{{company}}</td></tr></table>`,
      cta: { href: '{{admin_url}}', label: 'Open users dashboard' },
      footer: 'Internal BiteSites account notification.'
    }),
    text: 'A new BiteSites account was created.\n\nName: {{first_name}}\nEmail: {{email}}\nCompany: {{company}}\n\nOpen the Users dashboard: {{admin_url}}'
  },
  lead_received: {
    name: 'Inquiry received',
    description: 'Confirms that BiteSites received a project inquiry from a form, Bit, or Byte.',
    category: 'transactional',
    subject: 'We received your BiteSites inquiry, {{first_name}}',
    html: shell({
      preheader: 'Your notes are safely with the BiteSites team.',
      title: 'Your inquiry is in',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0 0 16px;">Thanks for speaking with {{source_label}}. We received your inquiry and the BiteSites team will review it shortly.</p><p style="margin:0;"><strong>Interested in:</strong> {{service_names}}</p>',
      cta: { href: '{{consultation_url}}', label: 'Schedule a consultation', note: 'Need to correct or add something? Reply to this email and your note will reach our team.' },
      footer: 'This is a confirmation of an inquiry you submitted to BiteSites.'
    }),
    text: 'Hi {{first_name}},\n\nThanks for speaking with {{source_label}}. We received your BiteSites inquiry and will review it shortly.\n\nInterested in: {{service_names}}\n\nSchedule a consultation: {{consultation_url}}\n\nNeed to correct or add something? Reply to this email.'
  },
  conversation_feedback: {
    name: 'Conversation feedback',
    description: 'Asks a visitor to rate a completed conversation with Bit or Byte.',
    category: 'transactional',
    subject: 'How was your conversation with {{agent_name}}?',
    html: shell({
      preheader: 'A quick rating helps us make every BiteSites conversation better.',
      title: 'How did {{agent_name}} do?',
      body: '<p style="margin:0 0 18px;">Hi {{first_name}},</p><p style="margin:0 0 20px;">Thanks for talking with {{agent_name}}. How useful was the conversation?</p><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-right:7px;"><a href="{{rating_1_url}}" style="display:block;padding:10px 12px;border:1px solid #dddddd;border-radius:8px;color:#222222;text-decoration:none;font-weight:700;">1</a></td><td style="padding-right:7px;"><a href="{{rating_2_url}}" style="display:block;padding:10px 12px;border:1px solid #dddddd;border-radius:8px;color:#222222;text-decoration:none;font-weight:700;">2</a></td><td style="padding-right:7px;"><a href="{{rating_3_url}}" style="display:block;padding:10px 12px;border:1px solid #dddddd;border-radius:8px;color:#222222;text-decoration:none;font-weight:700;">3</a></td><td style="padding-right:7px;"><a href="{{rating_4_url}}" style="display:block;padding:10px 12px;border:1px solid #dddddd;border-radius:8px;color:#222222;text-decoration:none;font-weight:700;">4</a></td><td><a href="{{rating_5_url}}" style="display:block;padding:10px 12px;border:1px solid #111111;border-radius:8px;color:#ffffff;background:#111111;text-decoration:none;font-weight:700;">5</a></td></tr></table><p style="margin:18px 0 0;color:#6b6b6b;font-size:13px;line-height:20px;">1 means not useful; 5 means very useful. Your choice opens a confirmation page where you can add an optional comment.</p>',
      cta: { href: '{{feedback_url}}', label: 'Leave detailed feedback' },
      footer: 'This feedback request relates to your recent BiteSites conversation. <a href="{{preference_url}}" style="color:#555555;">Manage feedback email preferences</a>.'
    }),
    text: 'Hi {{first_name}},\n\nThanks for talking with {{agent_name}}. How useful was the conversation?\n\nRate it or leave a comment: {{feedback_url}}\n\nManage feedback email preferences: {{preference_url}}'
  },
  new_lead_admin: {
    name: 'New lead — admin notice',
    description: 'Notifies the BiteSites team when an intake form, Bit, or Byte creates a lead.',
    category: 'transactional',
    subject: 'New {{source_label}} lead: {{lead_name}}',
    html: shell({
      preheader: 'A new BiteSites inquiry is ready for review.',
      title: 'New lead received',
      body: '<p style="margin:0 0 8px;"><strong>{{lead_name}}</strong> came through {{source_label}}.</p><p style="margin:0 0 8px;"><strong>Contact:</strong> {{contact}}</p><p style="margin:0;"><strong>Interested in:</strong> {{service_names}}</p>',
      cta: { href: '{{lead_url}}', label: 'Open lead' },
      footer: 'Internal BiteSites lead notification.'
    }),
    text: 'New BiteSites lead\n\nName: {{lead_name}}\nSource: {{source_label}}\nContact: {{contact}}\nInterested in: {{service_names}}\n\nOpen lead: {{lead_url}}'
  },
  access_granted: {
    name: 'Account access granted',
    description: 'Tells an account holder that an admin approved their BiteSites access.',
    category: 'transactional',
    subject: 'Your BiteSites access is ready',
    html: shell({
      preheader: 'Your BiteSites account has been approved.',
      title: 'You’re approved',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">Your BiteSites account now has {{role_label}} access. Sign in again to refresh your secure session and open the tools available to you.</p>',
      cta: { href: '{{sign_in_url}}', label: 'Sign in to BiteSites' },
      footer: 'You are receiving this account notice because an administrator approved your BiteSites access.'
    }),
    text: 'Hi {{first_name}},\n\nYour BiteSites account now has {{role_label}} access. Sign in again to refresh your secure session:\n{{sign_in_url}}'
  },
  access_revoked: {
    name: 'Account access removed',
    description: 'Security notice sent when an administrator removes BiteSites access.',
    category: 'transactional',
    subject: 'Your BiteSites access has changed',
    html: shell({
      preheader: 'An administrator removed access from your BiteSites account.',
      title: 'Account access removed',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">An administrator removed portal access from your BiteSites account. Your account remains pending, but protected dashboard data is no longer available.</p>',
      cta: { href: 'mailto:{{support_email}}', label: 'Contact support', note: 'If you expected this change, no action is needed.' },
      footer: 'This is a security notice about your BiteSites account.'
    }),
    text: 'Hi {{first_name}},\n\nAn administrator removed portal access from your BiteSites account. If you did not expect this, contact {{support_email}}.'
  },
  operational_alert: {
    name: 'Operational alert — admin',
    description: 'Internal alert for email, CRM, and voice-import failures that need attention.',
    category: 'transactional',
    subject: 'BiteSites alert: {{alert_title}}',
    html: shell({
      preheader: 'A BiteSites integration needs attention.',
      title: '{{alert_title}}',
      body: '<p style="margin:0 0 16px;">{{alert_message}}</p><p style="margin:0;color:#6b6b6b;font-size:13px;line-height:20px;"><strong>Component:</strong> {{component}}<br><strong>Reference:</strong> {{reference}}</p>',
      cta: { href: '{{admin_url}}', label: 'Open BiteSites admin' },
      footer: 'Internal BiteSites operational notification. Duplicate alerts are automatically throttled.'
    }),
    text: 'BiteSites operational alert\n\n{{alert_title}}\n{{alert_message}}\n\nComponent: {{component}}\nReference: {{reference}}\n\nOpen admin: {{admin_url}}'
  },
  announcement: {
    name: 'Client announcement',
    description: 'A polished general-purpose template admins can send from the dashboard.',
    category: 'broadcast',
    subject: '{{headline}}',
    html: shell({
      preheader: 'A note from the BiteSites studio.',
      title: '{{headline}}',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">{{message}}</p>',
      cta: { href: '{{cta_url}}', label: '{{cta_label}}' },
      footer: 'You are receiving this because you have a BiteSites account. Questions? Reply to this email. <a href="{{preference_url}}" style="color:#555555;">Manage email preferences</a>.'
    }),
    text: 'Hi {{first_name}},\n\n{{headline}}\n\n{{message}}\n\n{{cta_label}}: {{cta_url}}\n\nManage email preferences: {{preference_url}}'
  }
};

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

export function renderTemplate(template, variables = {}) {
  const replace = (source, html) => String(source || '').replace(
    /{{\s*([a-zA-Z0-9_]+)\s*}}/g,
    (_, key) => html ? escapeHtml(variables[key]) : String(variables[key] ?? '')
  );
  return {
    subject: replace(template.subject, false).slice(0, 2000),
    html: replace(template.html, true),
    text: replace(template.text, false)
  };
}

export async function getEmailTemplate(db, id) {
  const fallback = DEFAULT_EMAIL_TEMPLATES[id];
  if (!fallback) return null;
  const reference = db.doc(`emailTemplates/${id}`);
  const snapshot = await reference.get();
  const stored = snapshot.data();
  // A system template that nobody has edited in the studio gets the latest
  // baseline automatically. Templates with updatedBy are deliberate edits.
  if (snapshot.exists && !(stored.system && !stored.updatedBy && (stored.defaultVersion || 0) < EMAIL_TEMPLATE_VERSION)) {
    return { id, ...fallback, system: true, ...stored };
  }
  const now = new Date();
  await reference.set({
    ...fallback,
    system: true,
    defaultVersion: EMAIL_TEMPLATE_VERSION,
    createdAt: stored?.createdAt || now,
    updatedAt: now
  }, { merge: true });
  return { id, ...fallback, system: true, defaultVersion: EMAIL_TEMPLATE_VERSION };
}

export async function seedEmailTemplates(db) {
  const results = [];
  for (const id of Object.keys(DEFAULT_EMAIL_TEMPLATES)) results.push(await getEmailTemplate(db, id));
  return results;
}

export async function sendPostmark(token, messages) {
  if (!token || token.length < 10) throw new Error('Postmark is not configured. Set POSTMARK_SERVER_TOKEN.');
  const batch = Array.isArray(messages) ? messages : [messages];
  const endpoint = batch.length === 1 ? 'https://api.postmarkapp.com/email' : 'https://api.postmarkapp.com/email/batch';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
    body: JSON.stringify(batch.length === 1 ? batch[0] : batch)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Postmark ${response.status}: ${result.Message || 'send failed'}`);
  const failures = (Array.isArray(result) ? result : [result]).filter(item => item.ErrorCode);
  if (failures.length) throw new Error(`Postmark rejected ${failures.length} message(s): ${failures[0].Message}`);
  return result;
}

export function buildMessage({ from, to, template, variables, stream = 'outbound', tag }) {
  const rendered = renderTemplate(template, {
    brand_url: 'https://bitesites.org',
    logo_url: EMAIL_BRAND.logoUrl,
    ...variables
  });
  return {
    From: from, To: to, Subject: rendered.subject, HtmlBody: rendered.html, TextBody: rendered.text,
    MessageStream: stream, Tag: tag, TrackOpens: true, TrackLinks: 'HtmlOnly'
  };
}

// Broadcasts always get a visible preferences link and RFC 8058 headers, even
// when an admin-created template forgot to include {{preference_url}} itself.
export function addBroadcastUnsubscribe(message, preferenceUrl, oneClickUrl = preferenceUrl) {
  if (!preferenceUrl) return message;
  const footer = `<p style="margin:24px 0 0;color:#777777;font-size:12px;line-height:19px;">Don’t want BiteSites announcements? <a href="${escapeHtml(preferenceUrl)}" style="color:#555555;">Manage email preferences</a>.</p>`;
  const html = message.HtmlBody.includes(preferenceUrl)
    ? message.HtmlBody
    : message.HtmlBody.includes('</body>')
      ? message.HtmlBody.replace('</body>', `${footer}</body>`)
      : `${message.HtmlBody}${footer}`;
  const text = message.TextBody.includes(preferenceUrl)
    ? message.TextBody
    : `${message.TextBody}\n\nManage email preferences: ${preferenceUrl}`;
  return {
    ...message,
    HtmlBody: html,
    TextBody: text,
    Headers: [
      ...(Array.isArray(message.Headers) ? message.Headers : []),
      { Name: 'List-Unsubscribe', Value: `<${oneClickUrl}>` },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }
    ]
  };
}
