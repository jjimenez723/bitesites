// Server-only email primitives shared by the auth triggers and admin console.
// Templates live in Firestore so BiteSites staff can edit them without a deploy.

export const EMAIL_BRAND = {
  name: 'BiteSites',
  // This public app icon is deliberately used instead of a build-hashed asset, so
  // it remains a stable, absolute URL in delivered email.
  logoUrl: 'https://bitesites.org/apple-touch-icon.png'
};

const EMAIL_TEMPLATE_VERSION = 2;
const fontStack = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const shell = ({ preheader, eyebrow, title, body, cta, footer, accent = '#7c3aed', light = false }) => {
  const background = light ? '#f4f6fb' : '#080b16';
  const card = light ? '#ffffff' : '#111625';
  const copy = light ? '#4c5568' : '#c5ccdb';
  const muted = light ? '#717b8d' : '#99a4b8';
  const line = light ? '#e5e9f1' : '#263047';
  const buttonText = accent === '#e9edff' ? '#111625' : '#ffffff';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<style>@media only screen and (max-width:620px){.email-pad{padding-left:24px !important;padding-right:24px !important;}h1{font-size:28px !important;line-height:34px !important;}}</style>
<!--[if mso]><style>table { border-collapse:collapse; } .email-button { padding:14px 22px !important; }</style><![endif]--></head>
<body style="margin:0;padding:0;background:${background};color:${copy};font-family:${fontStack};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;mso-hide:all;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:${background};">
    <tr><td align="center" style="padding:32px 16px 40px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:620px;">
        <tr><td align="center" style="padding:0 0 18px;">
          <a href="{{brand_url}}" style="display:inline-block;text-decoration:none;">
            <img src="{{logo_url}}" width="42" height="42" alt="BiteSites" style="display:block;width:42px;height:42px;border:0;border-radius:12px;" />
          </a>
        </td></tr>
        <tr><td style="height:4px;background:${accent};border-radius:18px 18px 0 0;font-size:0;line-height:4px;">&nbsp;</td></tr>
        <tr><td style="background:${card};border:1px solid ${line};border-top:0;border-radius:0 0 18px 18px;overflow:hidden;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="padding:38px 40px 12px;" class="email-pad">
              <p style="margin:0 0 14px;color:${accent};font-size:11px;line-height:16px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;">${eyebrow}</p>
              <h1 style="margin:0;color:${light ? '#151a29' : '#ffffff'};font-family:${fontStack};font-size:32px;line-height:38px;font-weight:750;letter-spacing:-.7px;">${title}</h1>
            </td></tr>
            <tr><td style="padding:14px 40px 30px;" class="email-pad">
              <div style="color:${copy};font-size:16px;line-height:26px;">${body}</div>
              ${cta ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;"><tr><td style="border-radius:10px;background:${accent};"><a class="email-button" href="${cta.href}" style="display:inline-block;padding:14px 22px;border:1px solid ${accent};border-radius:10px;color:${buttonText};font-family:${fontStack};font-size:15px;line-height:20px;font-weight:750;text-decoration:none;">${cta.label}&nbsp;&nbsp;→</a></td></tr></table>${cta.note ? `<p style="margin:18px 0 0;color:${muted};font-size:13px;line-height:20px;">${cta.note}</p>` : ''}` : ''}
            </td></tr>
            <tr><td style="padding:22px 40px 26px;border-top:1px solid ${line};" class="email-pad">
              <p style="margin:0;color:${muted};font-size:12px;line-height:19px;">${footer}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:18px 20px 0;color:${light ? '#7b8494' : '#7f8aa0'};font-size:11px;line-height:17px;">
          <a href="{{brand_url}}" style="color:inherit;text-decoration:none;font-weight:700;">BiteSites</a>&nbsp;&nbsp;•&nbsp;&nbsp;Beautiful sites, thoughtful systems, practical AI.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
};

export const DEFAULT_EMAIL_TEMPLATES = {
  welcome: {
    name: 'Account confirmation',
    description: 'Sent when a BiteSites account needs its email address confirmed.',
    category: 'transactional',
    subject: 'Confirm your BiteSites email, {{first_name}}',
    html: shell({
      preheader: 'One quick step and your BiteSites account is ready.',
      eyebrow: 'Account confirmation',
      title: 'You’re almost in.',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">Thanks for creating a BiteSites account. Confirm your email address to finish setting things up and view the service options built for your next stage of growth.</p>',
      cta: { href: '{{verify_url}}', label: 'Confirm email', note: 'Already confirmed? <a href="{{pricing_url}}" style="color:#aebcff;text-decoration:underline;">Explore BiteSites pricing</a>.' },
      footer: 'If you did not create a BiteSites account, you can safely ignore this email.',
      accent: '#8c9cff'
    }),
    text: 'Hi {{first_name}},\n\nThanks for creating a BiteSites account. Confirm your email address here:\n{{verify_url}}\n\nThen explore BiteSites pricing at {{pricing_url}}.\n\nIf you did not create this account, you can safely ignore this email.'
  },
  password_reset: {
    name: 'Password reset',
    description: 'Sent when someone requests a secure password reset.',
    category: 'transactional',
    subject: 'Reset your BiteSites password',
    html: shell({
      preheader: 'Use this secure link to choose a new password.',
      eyebrow: 'Secure account link',
      title: 'Reset your password.',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">We received a request to reset the password for your BiteSites account. Use the secure link below to choose a new one.</p>',
      cta: { href: '{{reset_url}}', label: 'Choose a new password', note: 'For your security, do not forward this email or share this link.' },
      footer: 'If you did not request a password reset, no action is needed. Your current password will remain unchanged.',
      accent: '#df79b5'
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
      eyebrow: 'New account',
      title: 'A visitor joined BiteSites.',
      body: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0;border:1px solid #2b3650;border-radius:12px;background:#161d2d;overflow:hidden;"><tr><td style="padding:13px 16px;border-bottom:1px solid #2b3650;color:#8f9ab0;font-size:12px;font-weight:700;width:30%;">Name</td><td style="padding:13px 16px;border-bottom:1px solid #2b3650;color:#ffffff;font-size:14px;">{{first_name}}</td></tr><tr><td style="padding:13px 16px;border-bottom:1px solid #2b3650;color:#8f9ab0;font-size:12px;font-weight:700;">Email</td><td style="padding:13px 16px;border-bottom:1px solid #2b3650;color:#ffffff;font-size:14px;word-break:break-word;">{{email}}</td></tr><tr><td style="padding:13px 16px;color:#8f9ab0;font-size:12px;font-weight:700;">Company</td><td style="padding:13px 16px;color:#ffffff;font-size:14px;">{{company}}</td></tr></table>`,
      cta: { href: '{{admin_url}}', label: 'Open users dashboard' },
      footer: 'This is an internal BiteSites account notification.',
      accent: '#70d7ef'
    }),
    text: 'A new BiteSites account was created.\n\nName: {{first_name}}\nEmail: {{email}}\nCompany: {{company}}\n\nOpen the Users dashboard: {{admin_url}}'
  },
  announcement: {
    name: 'Client announcement',
    description: 'A polished general-purpose template admins can send from the dashboard.',
    category: 'broadcast',
    subject: '{{headline}}',
    html: shell({
      preheader: 'A note from the BiteSites studio.',
      eyebrow: 'A note from our studio',
      title: '{{headline}}',
      body: '<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">{{message}}</p>',
      cta: { href: '{{cta_url}}', label: '{{cta_label}}' },
      footer: 'You are receiving this because you have a BiteSites account. Questions? Reply to this email and our team will help.',
      accent: '#6c7ff2',
      light: true
    }),
    text: 'Hi {{first_name}},\n\n{{headline}}\n\n{{message}}\n\n{{cta_label}}: {{cta_url}}'
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
