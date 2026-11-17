// The invoice email: branded HTML + plain text, PDF attached, sent through Resend.
//
// The payment area mirrors the PDF exactly (see paymentNotice in billing-pdf.js):
// a Pay Now button when autopay is off and a pay link exists, an autopay notice
// when it is on, and Zelle/check details either way.

import { BILLING_ISSUER, formatLongDate, formatMoney } from './billing-math.js';
import { invoiceFilename, paymentNotice } from './billing-pdf.js';
import { resendTagValue } from './email.js';

// Served from Firebase Hosting (public/email/). Absolute and unhashed so it
// keeps resolving in mail that is opened months later.
export const INVOICE_LOGO_URL = 'https://bitesites.org/email/bitesites-invoice-logo.png';

const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const lineAmount = (invoice, line) => (line.kind === 'leads' && (invoice.leadCount === null || invoice.leadCount === undefined)
  ? '—'
  : formatMoney(line.amountCents));

export const invoiceSubject = invoice =>
  `Invoice #${invoice.number} from BiteSites — ${invoice.periodLabel} — ${formatMoney(invoice.totalCents)}`;

/**
 * Builds the Resend message for an invoice.
 * `pdf` is the rendered PDF Buffer; it is attached as base64.
 */
export function buildInvoiceEmail({ invoice, client, pdf, from, to = client?.billingEmails, replyTo = BILLING_ISSUER.email, issuer = BILLING_ISSUER, logoUrl = INVOICE_LOGO_URL }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) throw new Error('This client has no billing email address.');
  if (!pdf?.length) throw new Error('The invoice PDF is missing.');
  const notice = paymentNotice(invoice);
  const greetingName = String(client?.contactName || '').trim().split(/\s+/)[0] || client?.name || 'there';
  const subject = invoiceSubject(invoice);
  const due = formatLongDate(invoice.dueDate);

  const rows = invoice.lineItems.map(line => `<tr>
      <td style="padding:12px 12px 12px 0;border-bottom:1px solid #e8e8e8;color:#222222;font-size:14px;line-height:20px;">${escapeHtml(line.description)}<div style="color:#8a8a8a;font-size:12px;line-height:18px;">${escapeHtml(line.periodLabel || invoice.periodLabel)}</div></td>
      <td align="right" style="padding:12px 0;border-bottom:1px solid #e8e8e8;color:#222222;font-size:14px;line-height:20px;white-space:nowrap;">${escapeHtml(lineAmount(invoice, line))}</td>
    </tr>`).join('');

  const payNow = notice.kind === 'pay_now'
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0;"><tr><td style="border-radius:8px;background:#111111;"><a href="${escapeHtml(notice.url)}" style="display:inline-block;padding:15px 34px;border:1px solid #111111;border-radius:8px;color:#ffffff;font-family:${font};font-size:16px;line-height:20px;font-weight:700;text-decoration:none;">Pay Now</a></td></tr></table><p style="margin:12px 0 0;color:#6b6b6b;font-size:13px;line-height:20px;">Pay securely online by card or bank transfer. Zelle and checks are welcome too.</p>`
    : '';
  const banner = ['autopay', 'paid', 'void'].includes(notice.kind)
    ? `<p style="margin:28px 0 0;padding:14px 16px;border:1px solid #e1e1e1;border-radius:10px;background:#fafafa;color:#222222;font-size:14px;line-height:21px;font-weight:600;">${escapeHtml(notice.text)}</p>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:#222222;font-family:${font};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">Invoice #${escapeHtml(invoice.number)} for ${escapeHtml(invoice.periodLabel)}: ${escapeHtml(formatMoney(invoice.totalCents))}${due && notice.kind !== 'autopay' ? `, due ${escapeHtml(due)}` : ''}.&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#ffffff;">
    <tr><td align="center" style="padding:40px 24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;">
        <tr><td style="padding:0 0 24px;border-bottom:1px solid #e8e8e8;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td valign="middle"><a href="https://bitesites.org" style="text-decoration:none;"><img src="${escapeHtml(logoUrl)}" width="112" height="112" alt="BiteSites" style="display:block;width:112px;height:112px;border:0;" /></a></td>
            <td valign="middle" align="right" style="color:#555555;font-size:12px;line-height:18px;">
              <strong style="display:block;color:#111111;font-size:15px;letter-spacing:.04em;">${escapeHtml(issuer.name)}</strong>
              ${escapeHtml(issuer.title)}<br>${escapeHtml(issuer.location)}<br>${escapeHtml(issuer.email)}<br>${escapeHtml(issuer.phone)}
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:36px 0 8px;">
          <p style="margin:0 0 6px;color:#777777;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Invoice #${escapeHtml(invoice.number)}</p>
          <h1 style="margin:0 0 18px;color:#111111;font-size:28px;line-height:35px;font-weight:700;letter-spacing:-.4px;">${escapeHtml(formatMoney(invoice.totalCents))} for ${escapeHtml(invoice.periodLabel)}</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:26px;color:#3f3f3f;">Hi ${escapeHtml(greetingName)},</p>
          <p style="margin:0;font-size:16px;line-height:26px;color:#3f3f3f;">Your invoice for ${escapeHtml(invoice.periodLabel)} is attached as a PDF.${due && notice.kind !== 'autopay' && notice.kind !== 'paid' ? ` Payment is due by <strong style="color:#222222;">${escapeHtml(due)}</strong>.` : ''}</p>
          ${payNow}${banner}
        </td></tr>
        <tr><td style="padding:28px 0 0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #e8e8e8;">
            ${rows}
            <tr><td style="padding:14px 12px 0 0;color:#111111;font-size:15px;font-weight:700;">Total</td><td align="right" style="padding:14px 0 0;color:#111111;font-size:15px;font-weight:700;white-space:nowrap;">${escapeHtml(formatMoney(invoice.totalCents))}</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:32px 0 0;">
          <p style="margin:0 0 6px;color:#111111;font-size:14px;font-weight:700;">Payable to</p>
          <p style="margin:0;color:#3f3f3f;font-size:14px;line-height:22px;"><strong>Zelle:</strong> ${escapeHtml(issuer.zelle)}<br><strong>Checks payable to:</strong> ${escapeHtml(issuer.checksPayableTo)}<br><strong>Terms:</strong> ${escapeHtml(client?.terms || invoice.terms || '')}</p>
        </td></tr>
        <tr><td style="padding:32px 0 0;">
          <p style="margin:0 0 22px;color:#3f3f3f;font-size:15px;line-height:24px;font-style:italic;">${escapeHtml(issuer.thankYou)}</p>
          <p style="margin:0;padding:20px 0 0;border-top:1px solid #e8e8e8;color:#777777;font-size:12px;line-height:19px;">Questions about this invoice? Reply to this email or write to ${escapeHtml(issuer.email)}. BiteSites · ${escapeHtml(issuer.location)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textLines = invoice.lineItems.map(line => `- ${line.description} (${line.periodLabel || invoice.periodLabel}): ${lineAmount(invoice, line)}`);
  const text = [
    `Hi ${greetingName},`,
    '',
    `Invoice #${invoice.number} for ${invoice.periodLabel} is attached as a PDF.`,
    '',
    ...textLines,
    `Total: ${formatMoney(invoice.totalCents)}`,
    '',
    notice.kind === 'pay_now' ? `Pay Now: ${notice.url}` : notice.text,
    due && notice.kind !== 'autopay' && notice.kind !== 'paid' && notice.kind !== 'void' ? `Due by ${due}.` : '',
    '',
    'Payable to:',
    `Zelle: ${issuer.zelle}`,
    `Checks payable to: ${issuer.checksPayableTo}`,
    `Terms: ${client?.terms || invoice.terms || ''}`,
    '',
    issuer.thankYou,
    '',
    `${issuer.name} — ${issuer.title}`,
    `${issuer.email} · ${issuer.phone}`
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');

  return {
    from,
    to: recipients,
    subject,
    html,
    text,
    reply_to: replyTo,
    attachments: [{ filename: invoiceFilename(invoice), content: Buffer.from(pdf).toString('base64') }],
    tags: [
      { name: 'stream', value: 'transactional' },
      { name: 'category', value: 'invoice' },
      { name: 'invoice', value: resendTagValue(`${invoice.clientId || 'client'}-${invoice.number}`) }
    ]
  };
}
