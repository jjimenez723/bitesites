// Server-only email primitives shared by the auth triggers and admin console.
// Templates live in Firestore so BiteSites staff can edit them without a deploy.
// Delivery goes through Resend (https://resend.com) over its REST API.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const EMAIL_BRAND = {
  name: 'BiteSites',
  // This public app icon is deliberately used instead of a build-hashed asset, so
  // it remains a stable, absolute URL in delivered email.
  logoUrl: 'https://bitesites.org/apple-touch-icon.png'
};

const EMAIL_TEMPLATE_VERSION = 6;
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
const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

export function normalizeEmailActions(input, { max = 8 } = {}) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('Links must be a list.');
  if (input.length > max) throw new Error(`Add no more than ${max} links.`);
  return input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Link ${index + 1} is invalid.`);
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!label || label.length > 80) throw new Error(`Link ${index + 1} needs a label of 80 characters or fewer.`);
    if (/{{|}}/.test(label)) throw new Error(`Link ${index + 1} label cannot contain template placeholders.`);
    if (url.length > 2000) throw new Error(`Link ${index + 1} is too long.`);
    let parsed;
    try { parsed = new URL(url); } catch { /* reported below */ }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error(`Link ${index + 1} must be a secure https:// URL.`);
    }
    return {
      label,
      url: parsed.toString(),
      kind: ['questionnaire', 'booking', 'website', 'meeting', 'custom'].includes(item.kind) ? item.kind : 'custom'
    };
  });
}

const outreachActionsHtml = actions => {
  if (!actions.length) return '';
  return actions.map((action, index) => {
    const label = escapeHtml(action.label);
    const url = escapeHtml(action.url);
    if (index === 0) {
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;"><tr><td style="border-radius:8px;background:#111111;"><a class="email-button" href="${url}" style="display:inline-block;padding:13px 20px;border:1px solid #111111;border-radius:8px;color:#ffffff;font-family:${fontStack};font-size:15px;line-height:20px;font-weight:700;text-decoration:none;">${label}</a></td></tr></table>`;
    }
    if (index === 1) {
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:12px;"><tr><td style="border-radius:8px;background:#ffffff;"><a class="email-button" href="${url}" style="display:inline-block;padding:12px 19px;border:1px solid #b8b8b8;border-radius:8px;color:#222222;font-family:${fontStack};font-size:15px;line-height:20px;font-weight:700;text-decoration:none;">${label}</a></td></tr></table>`;
    }
    return `<p style="margin:${index === 2 ? '20px' : '9px'} 0 0;color:#555555;font-size:14px;line-height:21px;"><a href="${url}" style="color:#333333;text-decoration:underline;">${label}</a></p>`;
  }).join('');
};

export function buildLeadOutreachTemplate({ actions = [], withAction = false, withMeetingTime = false } = {}) {
  const normalizedActions = actions.length ? normalizeEmailActions(actions) : [];
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
      body: `<p style="margin:0 0 16px;">Hi {{first_name}},</p><div style="margin:0;white-space:pre-line;">{{message}}</div>${meeting}${outreachActionsHtml(normalizedActions)}`,
      cta: withAction && !normalizedActions.length
        ? { href: '{{action_url}}', label: '{{action_label}}', note: '{{action_note}}' }
        : null,
      footer: 'This is a personal follow-up from your BiteSites conversation. Reply to this email if you have any questions.'
    }),
    text: `Hi {{first_name}},\n\n{{message}}${withMeetingTime ? '\n\nMeeting time: {{meeting_time}}' : ''}${normalizedActions.length ? `\n\n${normalizedActions.map(action => `${action.label}: ${action.url}`).join('\n')}` : withAction ? '\n\n{{action_label}}: {{action_url}}\n\n{{action_note}}' : ''}\n\nReply to this email if you have any questions.`
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
  meeting_booked: {
    name: 'Meeting confirmed',
    description: 'Confirms a consultation booked by a voice agent or rep, with the day, time, and reference.',
    category: 'transactional',
    subject: 'Confirmed: your BiteSites call — {{meeting_time}}',
    html: shell({
      preheader: 'Your consultation is booked. Here are the details.',
      title: 'Your call is booked',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0 0 16px;">Your {{meeting_title}} is confirmed. A {{host_name}} will call you at the time below.</p><p style="margin:0 0 16px;padding:14px 16px;border:1px solid #e5e5e5;border-radius:10px;background:#fafafa;"><span style="display:block;color:#777777;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Meeting time</span><strong style="display:block;margin-top:3px;color:#222222;font-size:15px;">{{meeting_time}}</strong><span style="display:block;margin-top:8px;color:#777777;font-size:12px;">Confirmation reference: <strong style="color:#222222;">{{confirmation_ref}}</strong></span></p><p style="margin:0;color:#6b6b6b;font-size:13px;line-height:20px;">There is nothing to prepare. If the time stops working, reply to this email and we will move it.</p>',
      cta: null,
      footer: 'This confirms a meeting you booked with BiteSites. Reply to this email to reschedule or cancel.'
    }),
    text: 'Hi {{first_name}},\n\nYour {{meeting_title}} is confirmed. A {{host_name}} will call you at the time below.\n\nMeeting time: {{meeting_time}}\nConfirmation reference: {{confirmation_ref}}\n\nThere is nothing to prepare. If the time stops working, reply to this email and we will move it.'
  },
  // The video twin of `meeting_booked`. Two templates rather than one with a
  // conditional block, because `renderTemplate` only substitutes variables —
  // a single template would have to render a "Join" button whose href is empty
  // whenever Google has not produced a link, and a dead button in a
  // confirmation email is worse than not promising a link at all.
  meeting_booked_video: {
    name: 'Meeting confirmed (video)',
    description: 'Confirms a booked consultation that has a Google Meet link, with the day, time, reference, and join button.',
    category: 'transactional',
    subject: 'Confirmed: your BiteSites call — {{meeting_time}}',
    html: shell({
      preheader: 'Your consultation is booked. Your video link is inside.',
      title: 'Your call is booked',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0 0 16px;">Your {{meeting_title}} is confirmed. You will meet a {{host_name}} on Google Meet at the time below.</p><p style="margin:0 0 16px;padding:14px 16px;border:1px solid #e5e5e5;border-radius:10px;background:#fafafa;"><span style="display:block;color:#777777;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Meeting time</span><strong style="display:block;margin-top:3px;color:#222222;font-size:15px;">{{meeting_time}}</strong><span style="display:block;margin-top:8px;color:#777777;font-size:12px;">Confirmation reference: <strong style="color:#222222;">{{confirmation_ref}}</strong></span></p><p style="margin:0;color:#6b6b6b;font-size:13px;line-height:20px;">There is nothing to prepare. If the time stops working, reply to this email and we will move it.</p>',
      cta: { href: '{{meet_url}}', label: 'Join the video call', note: 'The same link is on the calendar invite, so you can join from either.' },
      footer: 'This confirms a meeting you booked with BiteSites. Reply to this email to reschedule or cancel.'
    }),
    text: 'Hi {{first_name}},\n\nYour {{meeting_title}} is confirmed. You will meet a {{host_name}} on Google Meet at the time below.\n\nMeeting time: {{meeting_time}}\nJoin the video call: {{meet_url}}\nConfirmation reference: {{confirmation_ref}}\n\nThere is nothing to prepare. If the time stops working, reply to this email and we will move it.'
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
  manual_lead_admin: {
    name: 'Prospect added manually — admin notice',
    description: 'Clearly identifies a prospect an admin added to Leads without implying that a BiteSites call connected.',
    category: 'transactional',
    subject: 'Prospect added manually: {{lead_name}}',
    html: shell({
      preheader: 'A prospect was added to Leads by a team member.',
      title: 'Prospect added manually',
      body: '<p style="margin:0 0 14px;"><strong>{{lead_name}}</strong> was manually added to Leads by {{qualified_by}}.</p><p style="margin:0 0 14px;padding:13px 15px;border:1px solid #ead7a2;border-radius:9px;background:#fffaf0;color:#5c4812;"><strong>Call status:</strong> {{contact_status}}</p><p style="margin:0 0 8px;"><strong>Contact:</strong> {{contact}}</p><p style="margin:0 0 8px;"><strong>Reason:</strong> {{manual_reason}}</p><p style="margin:0 0 8px;"><strong>Notes:</strong> {{manual_notes}}</p><p style="margin:0;"><strong>Interest:</strong> {{service_names}}</p>',
      cta: { href: '{{lead_url}}', label: 'Review lead' },
      footer: 'Internal BiteSites notification. Manual qualification is not proof that a BiteSites call connected.'
    }),
    text: 'Prospect added manually\n\nName: {{lead_name}}\nAdded by: {{qualified_by}}\nCall status: {{contact_status}}\nContact: {{contact}}\nReason: {{manual_reason}}\nNotes: {{manual_notes}}\nInterest: {{service_names}}\n\nReview lead: {{lead_url}}'
  },
  outbound_call_lead_admin: {
    name: 'Answered outbound call — admin notice',
    description: 'Notifies the team when a verified outbound conversation creates a lead and links to the call record.',
    category: 'transactional',
    subject: 'Answered outbound call: {{lead_name}} · {{disposition}}',
    html: shell({
      preheader: 'A verified outbound conversation produced a lead.',
      title: 'Outbound conversation captured',
      body: '<p style="margin:0 0 14px;"><strong>{{lead_name}}</strong> became a lead after a verified outbound conversation.</p><p style="margin:0 0 8px;"><strong>Contact:</strong> {{contact}}</p><p style="margin:0 0 8px;"><strong>Outcome:</strong> {{disposition}}</p><p style="margin:0 0 8px;"><strong>Duration:</strong> {{duration}}</p><p style="margin:0 0 8px;"><strong>Operator:</strong> {{operator}}</p><p style="margin:0 0 8px;"><strong>Summary:</strong> {{call_summary}}</p><p style="margin:0;"><strong>Interest:</strong> {{service_names}}</p>',
      cta: { href: '{{call_url}}', label: 'Open call record' },
      footer: 'Internal BiteSites notification linked to a verified outbound call.'
    }),
    text: 'Answered outbound call\n\nName: {{lead_name}}\nContact: {{contact}}\nOutcome: {{disposition}}\nDuration: {{duration}}\nOperator: {{operator}}\nSummary: {{call_summary}}\nInterest: {{service_names}}\n\nOpen call: {{call_url}}\nOpen lead: {{lead_url}}'
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

// ------------------------------------------------------------------ Resend

export const RESEND_API_URL = 'https://api.resend.com';
// Resend's batch endpoint accepts at most 100 messages and no attachments.
export const RESEND_BATCH_LIMIT = 100;

// Resend tag names and values may only contain ASCII letters, numbers,
// underscores and dashes (max 256 chars). Anything else is replaced so a tag
// can never be the reason a send is rejected.
export const resendTagValue = value => String(value ?? '')
  .replace(/[^A-Za-z0-9_-]/g, '_')
  .slice(0, 256) || 'none';

const resendError = (status, result) => {
  const detail = result?.message || result?.error || result?.name || 'send failed';
  const error = new Error(`Resend ${status}: ${detail}`);
  error.status = status;
  error.code = result?.name || '';
  return error;
};

/**
 * Sends one message (POST /emails) or several (POST /emails/batch).
 *
 * Returns `{ id }` for a single message and `[{ id }, ...]` for a batch, in
 * the same order as the input. `idempotencyKey` is forwarded as Resend's
 * `Idempotency-Key` header so a retried request cannot deliver twice.
 */
export async function sendResend(apiKey, messages, { idempotencyKey = '', fetchImpl = fetch } = {}) {
  if (!apiKey || apiKey.length < 10 || apiKey === 'unset') {
    throw new Error('Resend is not configured. Set RESEND_API_KEY.');
  }
  const batch = Array.isArray(messages) ? messages : [messages];
  if (!batch.length) return Array.isArray(messages) ? [] : null;
  if (batch.length > RESEND_BATCH_LIMIT) throw new Error(`Resend accepts at most ${RESEND_BATCH_LIMIT} messages per batch.`);
  const single = !Array.isArray(messages) || batch.length === 1;
  if (!single && batch.some(message => message.attachments?.length)) {
    throw new Error('Resend batch sends cannot include attachments; send those messages one at a time.');
  }
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);
  const response = await fetchImpl(`${RESEND_API_URL}/emails${single ? '' : '/batch'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(single ? batch[0] : batch)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw resendError(response.status, result);
  if (single) {
    const sent = { id: result.id || result.data?.id || '' };
    return Array.isArray(messages) ? [sent] : sent;
  }
  const data = Array.isArray(result.data) ? result.data : [];
  if (Array.isArray(result.errors) && result.errors.length) {
    throw new Error(`Resend rejected ${result.errors.length} message(s): ${result.errors[0]?.message || 'invalid message'}`);
  }
  return data.map(item => ({ id: item?.id || '' }));
}

/** Message ids from a `sendResend` result, whichever shape it returned. */
export const resendIds = result => (Array.isArray(result) ? result : [result])
  .map(item => item?.id || '')
  .filter(Boolean);

/**
 * Renders a stored template into a Resend message.
 *
 * `stream` is kept for call-site compatibility: Resend has no message streams,
 * so the category travels as a tag and broadcast mail is distinguished by its
 * List-Unsubscribe headers instead.
 */
export function buildMessage({ from, to, template, variables, stream = 'outbound', tag, replyTo }) {
  const rendered = renderTemplate(template, {
    brand_url: 'https://bitesites.org',
    logo_url: EMAIL_BRAND.logoUrl,
    ...variables
  });
  const tags = [{ name: 'stream', value: resendTagValue(stream) }];
  if (tag) tags.push({ name: 'category', value: resendTagValue(tag) });
  return {
    from,
    to: Array.isArray(to) ? to : [to],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tags,
    ...(replyTo ? { reply_to: replyTo } : {})
  };
}

// Broadcasts always get a visible preferences link and RFC 8058 headers, even
// when an admin-created template forgot to include {{preference_url}} itself.
export function addBroadcastUnsubscribe(message, preferenceUrl, oneClickUrl = preferenceUrl) {
  if (!preferenceUrl) return message;
  const footer = `<p style="margin:24px 0 0;color:#777777;font-size:12px;line-height:19px;">Don’t want BiteSites announcements? <a href="${escapeHtml(preferenceUrl)}" style="color:#555555;">Manage email preferences</a>.</p>`;
  const html = message.html.includes(preferenceUrl)
    ? message.html
    : message.html.includes('</body>')
      ? message.html.replace('</body>', `${footer}</body>`)
      : `${message.html}${footer}`;
  const text = message.text.includes(preferenceUrl)
    ? message.text
    : `${message.text}\n\nManage email preferences: ${preferenceUrl}`;
  return {
    ...message,
    html,
    text,
    headers: {
      ...(message.headers && typeof message.headers === 'object' ? message.headers : {}),
      'List-Unsubscribe': `<${oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

// ---------------------------------------------------------- Resend webhooks

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a Resend webhook, which Resend signs with Svix.
 *
 * The signed content is `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256
 * keyed with the base64 part of the `whsec_…` secret. `svix-signature` holds one
 * or more space-separated `v1,<base64>` signatures (several during a secret
 * rotation). Returns the parsed JSON payload, or throws.
 */
export function verifyResendWebhook({ payload, headers, secret, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const header = name => {
    if (typeof headers?.get === 'function') return headers.get(name) || '';
    return headers?.[name] || headers?.[name.toLowerCase()] || '';
  };
  const id = String(header('svix-id'));
  const timestamp = String(header('svix-timestamp'));
  const signatures = String(header('svix-signature'));
  if (!secret || !String(secret).startsWith('whsec_')) throw new Error('webhook-secret-not-configured');
  if (!id || !timestamp || !signatures) throw new Error('missing-signature-headers');
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(nowSeconds - sentAt) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error('stale-or-invalid-timestamp');
  }
  const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
  const key = Buffer.from(String(secret).slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  const valid = signatures.split(' ').some(entry => {
    const [version, signature] = entry.split(',');
    if (version !== 'v1' || !signature) return false;
    const provided = Buffer.from(signature, 'base64');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!valid) throw new Error('invalid-signature');
  return JSON.parse(body);
}

/**
 * Maps one Resend webhook event onto the suppression decisions BiteSites keeps
 * in `emailPreferences`. Pure, so the policy is testable without Firestore.
 */
export function resendEventPolicy(event) {
  const type = String(event?.type || '');
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const recipients = (Array.isArray(data.to) ? data.to : [data.to]).filter(Boolean).map(value => String(value).trim().toLowerCase());
  const bounceType = String(data.bounce?.type || '').toLowerCase();
  const update = {};
  if (type === 'email.complained') {
    update.broadcasts = false;
    update.transactionalBlocked = true;
  }
  // A permanent (hard) bounce means the mailbox does not exist; keep sending to
  // it and the sending domain's reputation suffers. Transient bounces retry.
  if (type === 'email.bounced' && bounceType === 'permanent') update.transactionalBlocked = true;
  return {
    type,
    status: type.startsWith('email.') ? type.slice('email.'.length) : type,
    emailId: String(data.email_id || ''),
    recipients,
    occurredAt: String(event?.created_at || data.created_at || ''),
    description: String(data.bounce?.message || data.bounce?.subType || data.failed?.reason || ''),
    preferenceUpdate: Object.keys(update).length ? update : null
  };
}
