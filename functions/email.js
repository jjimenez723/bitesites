// Server-only email primitives shared by the auth triggers and admin console.
// Templates live in Firestore so BiteSites staff can edit them without a deploy;
// the defaults below are the safe, styled fallback and are seeded on first use.

export const DEFAULT_EMAIL_TEMPLATES = {
  welcome: {
    name: 'Account confirmation',
    description: 'Sent after a visitor creates a BiteSites account.',
    category: 'transactional',
    subject: 'Welcome to BiteSites, {{first_name}}',
    html: `<!doctype html><html><body style="margin:0;background:#08090d;color:#f7f7fb;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:radial-gradient(circle at top left,#142c55 0,#08090d 42%);padding:42px 18px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#14151c;border:1px solid #292b37;border-radius:24px;overflow:hidden;box-shadow:0 28px 80px rgba(0,0,0,.4)"><tr><td style="height:7px;background:linear-gradient(90deg,#0071e3,#7c3aed,#ff5e9c,#34c9eb)"></td></tr><tr><td style="padding:38px 42px 12px"><div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#65bff0;font-weight:700">BiteSites account</div><h1 style="margin:15px 0 12px;font-size:34px;line-height:1.08;letter-spacing:-.03em">Your next growth move starts here.</h1><p style="margin:0;color:#b7b8c5;font-size:16px;line-height:1.7">Hi {{first_name}}, your BiteSites account is ready. Confirm your email, then return to the pricing section to explore the service package that fits you.</p></td></tr><tr><td style="padding:24px 42px"><a href="{{verify_url}}" style="display:inline-block;background:linear-gradient(115deg,#0071e3,#7c3aed 54%,#ff5e9c);color:#fff;text-decoration:none;font-weight:750;padding:15px 24px;border-radius:12px">Confirm my email</a><p style="margin:18px 0 0;color:#7f8190;font-size:13px;line-height:1.6">Already verified? <a href="{{pricing_url}}" style="color:#71c7f0">View BiteSites pricing</a>.</p></td></tr><tr><td style="padding:22px 42px 34px;border-top:1px solid #262833;color:#747685;font-size:12px;line-height:1.6">BiteSites · Beautiful sites, thoughtful systems, practical AI.<br>If you did not create this account, you can safely ignore this email.</td></tr></table></td></tr></table></body></html>`,
    text: `Hi {{first_name}},\n\nYour BiteSites account is ready. Confirm your email here:\n{{verify_url}}\n\nThen view pricing at {{pricing_url}}.\n\nIf you did not create this account, you can ignore this email.`
  },
  password_reset: {
    name: 'Password reset',
    description: 'Sent when someone requests a secure password reset.',
    category: 'transactional',
    subject: 'Reset your BiteSites password',
    html: `<!doctype html><html><body style="margin:0;background:#08090d;color:#f7f7fb;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:radial-gradient(circle at 85% 0,#281a4c 0,#08090d 43%);padding:42px 18px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#14151c;border:1px solid #292b37;border-radius:24px;overflow:hidden"><tr><td style="height:7px;background:linear-gradient(90deg,#34c9eb,#0071e3,#7c3aed,#ff5e9c)"></td></tr><tr><td style="padding:40px 42px 16px"><div style="display:inline-block;background:#242333;border:1px solid #39364d;border-radius:999px;padding:7px 11px;color:#beadff;font-size:12px;font-weight:700">SECURE ACCOUNT LINK</div><h1 style="margin:18px 0 12px;font-size:32px;line-height:1.1;letter-spacing:-.03em">Reset your password.</h1><p style="margin:0;color:#b7b8c5;font-size:16px;line-height:1.7">Hi {{first_name}}, use the secure link below to choose a new BiteSites password. This link is unique to your account.</p></td></tr><tr><td style="padding:20px 42px 28px"><a href="{{reset_url}}" style="display:inline-block;background:linear-gradient(115deg,#0071e3,#7c3aed 55%,#ff5e9c);color:#fff;text-decoration:none;font-weight:750;padding:15px 24px;border-radius:12px">Choose a new password</a><p style="margin:20px 0 0;color:#7f8190;font-size:13px;line-height:1.6">For your security, do not forward this email or share the link.</p></td></tr><tr><td style="padding:22px 42px 34px;border-top:1px solid #262833;color:#747685;font-size:12px;line-height:1.6">If you did not request a password reset, no action is needed and your password will stay the same.</td></tr></table></td></tr></table></body></html>`,
    text: `Hi {{first_name}},\n\nUse this secure link to reset your BiteSites password:\n{{reset_url}}\n\nIf you did not request this, no action is needed.`
  },
  new_account_admin: {
    name: 'New account — admin notice',
    description: 'Notifies the BiteSites team when a new account is created.',
    category: 'transactional',
    subject: 'New BiteSites account: {{email}}',
    html: `<!doctype html><html><body style="margin:0;background:#0b0b10;color:#f4f4f7;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:36px 16px;background:#0b0b10"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#17171e;border:1px solid #2b2b36;border-radius:20px"><tr><td style="padding:34px 38px"><div style="color:#ff77aa;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase">New account</div><h1 style="font-size:29px;letter-spacing:-.03em;margin:12px 0 24px">A visitor joined BiteSites.</h1><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#20202a;border-radius:14px;color:#c6c6d0"><tr><td style="padding:14px 16px;border-bottom:1px solid #30303c;color:#77798b;width:100px">Name</td><td style="padding:14px 16px;border-bottom:1px solid #30303c">{{first_name}}</td></tr><tr><td style="padding:14px 16px;border-bottom:1px solid #30303c;color:#77798b">Email</td><td style="padding:14px 16px;border-bottom:1px solid #30303c">{{email}}</td></tr><tr><td style="padding:14px 16px;color:#77798b">Company</td><td style="padding:14px 16px">{{company}}</td></tr></table><a href="{{admin_url}}" style="display:inline-block;margin-top:24px;background:#f4f4f7;color:#14141a;text-decoration:none;font-weight:750;padding:13px 20px;border-radius:11px">Open the Users dashboard</a></td></tr></table></td></tr></table></body></html>`,
    text: `A new BiteSites account was created.\n\nName: {{first_name}}\nEmail: {{email}}\nCompany: {{company}}\n\nOpen the Users dashboard: {{admin_url}}`
  },
  announcement: {
    name: 'Client announcement',
    description: 'A polished general-purpose template admins can send from the dashboard.',
    category: 'broadcast',
    subject: '{{headline}}',
    html: `<!doctype html><html><body style="margin:0;background:#f2f4f8;color:#171922;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:44px 18px;background:linear-gradient(145deg,#edf5ff,#f6efff 55%,#fff1f6)"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border-radius:26px;overflow:hidden;box-shadow:0 24px 70px rgba(43,53,84,.14)"><tr><td style="padding:38px 44px;background:#11131a;color:#fff"><div style="font-weight:850;font-size:19px;letter-spacing:-.02em">BiteSites<span style="color:#66c8f2">.</span></div><div style="margin-top:30px;color:#7acdf2;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase">A note from our studio</div><h1 style="font-size:36px;line-height:1.08;letter-spacing:-.035em;margin:12px 0 0">{{headline}}</h1></td></tr><tr><td style="padding:38px 44px"><p style="font-size:16px;line-height:1.75;color:#505463;margin:0 0 18px">Hi {{first_name}},</p><p style="font-size:16px;line-height:1.75;color:#505463;margin:0 0 26px">{{message}}</p><a href="{{cta_url}}" style="display:inline-block;background:linear-gradient(115deg,#0071e3,#7c3aed 54%,#ff5e9c);color:#fff;text-decoration:none;font-weight:750;padding:15px 24px;border-radius:12px">{{cta_label}}</a></td></tr><tr><td style="padding:22px 44px;background:#f8f9fc;color:#858897;font-size:12px;line-height:1.6">You are receiving this because you have a BiteSites account. Questions? Reply to this email and our team will help.</td></tr></table></td></tr></table></body></html>`,
    text: `Hi {{first_name}},\n\n{{headline}}\n\n{{message}}\n\n{{cta_label}}: {{cta_url}}`
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
  if (snapshot.exists) return { id, ...fallback, system: true, ...snapshot.data() };
  await reference.set({ ...fallback, system: true, createdAt: new Date(), updatedAt: new Date() });
  return { id, ...fallback, system: true };
}

export async function seedEmailTemplates(db) {
  const results = [];
  for (const id of Object.keys(DEFAULT_EMAIL_TEMPLATES)) {
    results.push(await getEmailTemplate(db, id));
  }
  return results;
}

export async function sendPostmark(token, messages) {
  if (!token || token.length < 10) throw new Error('Postmark is not configured. Set POSTMARK_SERVER_TOKEN.');
  const batch = Array.isArray(messages) ? messages : [messages];
  const endpoint = batch.length === 1 ? 'https://api.postmarkapp.com/email' : 'https://api.postmarkapp.com/email/batch';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': token
    },
    body: JSON.stringify(batch.length === 1 ? batch[0] : batch)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Postmark ${response.status}: ${result.Message || 'send failed'}`);
  const failures = (Array.isArray(result) ? result : [result]).filter(item => item.ErrorCode);
  if (failures.length) throw new Error(`Postmark rejected ${failures.length} message(s): ${failures[0].Message}`);
  return result;
}

export function buildMessage({ from, to, template, variables, stream = 'outbound', tag }) {
  const rendered = renderTemplate(template, variables);
  return {
    From: from,
    To: to,
    Subject: rendered.subject,
    HtmlBody: rendered.html,
    TextBody: rendered.text,
    MessageStream: stream,
    Tag: tag,
    TrackOpens: true,
    TrackLinks: 'HtmlOnly'
  };
}
