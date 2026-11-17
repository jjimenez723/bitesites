// Server-side invoice PDF, laid out to match the foundation invoice (CAAH #011,
// a Google Docs export): US Letter, one-inch side margins, Montserrat, logo top
// left, issuer block and invoice number top right, a three-column table and a
// right-aligned "Payable to" block. Coordinates are in PDF points and were taken
// from that document's text boxes so a reprint lines up with the original.
//
// The only additions are the payment call to action, which the foundation did
// not have: a "Pay Now" button when autopay is off and a pay link exists, or an
// autopay notice when it is on. Zelle and check details are always printed.

import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BILLING_ISSUER, DEFAULT_TERMS, formatLongDate, formatMoney, formatUsDate, isoDay
} from './billing-math.js';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'billing-assets');
const FONTS = {
  regular: join(ASSETS, 'fonts', 'Montserrat-Regular.ttf'),
  bold: join(ASSETS, 'fonts', 'Montserrat-Bold.ttf'),
  italic: join(ASSETS, 'fonts', 'Montserrat-Italic.ttf')
};
const LOGO = join(ASSETS, 'bitesites-logo.png');

const PAGE = { width: 612, height: 792 };
const LEFT = 72;
const RIGHT = 540;
const BODY = 11;
const LINE = 15.4;
const INK = '#000000';
const MUTED = '#555555';

// Table geometry from the foundation: column rules at these x positions.
const COLUMNS = [99.4, 264.2, 376.6, 526.3];
const CELL_X = 4.8;
const CELL_Y = 6;
const TABLE_TOP = 303.1;
const HEADER_ROW = 36;
const MIN_ROW = 27;

export const invoiceFilename = invoice => `BiteSites-Invoice-${invoice?.number || 'draft'}.pdf`;

/**
 * What the payment area of the invoice says. Shared with the email so the PDF
 * and the message can never disagree.
 */
export function paymentNotice(invoice) {
  if (invoice?.status === 'paid') {
    const paidOn = isoDay(invoice.payment?.paidAt);
    return { kind: 'paid', text: `Paid${paidOn ? ` on ${formatLongDate(paidOn)}` : ''} — thank you.` };
  }
  if (invoice?.status === 'void') return { kind: 'void', text: 'This invoice has been voided. No payment is due.' };
  if (invoice?.autopay) {
    const chargeDate = invoice.autopayChargeDate || invoice.issueDate;
    return { kind: 'autopay', text: `Autopay enabled — your card on file will be charged on ${formatLongDate(chargeDate)}.` };
  }
  const url = invoice?.payment?.payNowUrl;
  if (url && /^https:\/\//.test(url)) return { kind: 'pay_now', url, text: 'Pay Now' };
  return { kind: 'manual', text: '' };
}

const collect = doc => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

const rightText = (doc, text, top, { font = 'regular', size = BODY, color = INK } = {}) => {
  doc.font(font).fontSize(size).fillColor(color)
    .text(text, LEFT, top, { width: RIGHT - LEFT, align: 'right', lineBreak: false });
};

// "LABEL: value" on one line, label bold, matching the foundation's mixed runs.
const labelled = (doc, label, value, x, top, { align = 'left', width = RIGHT - LEFT } = {}) => {
  if (align === 'right') {
    doc.font('regular').fontSize(BODY);
    const valueWidth = doc.widthOfString(value);
    doc.font('bold');
    const labelWidth = doc.widthOfString(label);
    const start = RIGHT - valueWidth - labelWidth;
    doc.fillColor(INK).text(label, start, top, { lineBreak: false });
    doc.font('regular').text(value, start + labelWidth, top, { lineBreak: false });
    return;
  }
  doc.fillColor(INK).font('bold').fontSize(BODY).text(label, x, top, { continued: true, lineBreak: false, width });
  doc.font('regular').text(value, { lineBreak: false });
};

const cellHeight = (doc, text, width, font) => {
  doc.font(font).fontSize(BODY);
  return doc.heightOfString(text || ' ', { width });
};

function drawTable(doc, invoice) {
  const widths = COLUMNS.slice(1).map((x, index) => x - COLUMNS[index] - CELL_X * 2);
  const rows = [
    { cells: ['DESCRIPTION', 'BILLING PERIOD', 'TOTAL'], font: 'bold', header: true },
    ...invoice.lineItems.map(line => ({
      cells: [
        line.description,
        line.periodLabel || invoice.periodLabel || '',
        line.kind === 'leads' && (invoice.leadCount === null || invoice.leadCount === undefined) ? '' : formatMoney(line.amountCents)
      ],
      font: 'regular'
    })),
    { cells: ['Total', '', formatMoney(invoice.totalCents)], font: 'regular' }
  ];

  let top = TABLE_TOP;
  doc.lineWidth(0.75).strokeColor(INK);
  for (const row of rows) {
    const textHeight = Math.max(...row.cells.map((text, index) => cellHeight(doc, text, widths[index], row.font)));
    const height = row.header ? HEADER_ROW : Math.max(MIN_ROW, textHeight + CELL_Y * 2 + 1);
    if (top + height > PAGE.height - 72) {
      doc.addPage({ size: 'LETTER', margin: 0 });
      top = 72;
    }
    row.cells.forEach((text, index) => {
      doc.font(row.font).fontSize(BODY).fillColor(INK)
        .text(text, COLUMNS[index] + CELL_X, top + CELL_Y, { width: widths[index] });
    });
    doc.rect(COLUMNS[0], top, COLUMNS[3] - COLUMNS[0], height).stroke();
    for (const x of COLUMNS.slice(1, 3)) doc.moveTo(x, top).lineTo(x, top + height).stroke();
    top += height;
  }
  return top;
}

function drawPaymentCallToAction(doc, notice, top) {
  if (notice.kind === 'pay_now') {
    const width = 170;
    const height = 38;
    doc.roundedRect(LEFT, top, width, height, 6).fill('#111111');
    doc.font('bold').fontSize(13).fillColor('#ffffff')
      .text('Pay Now', LEFT, top + 11.5, { width, align: 'center', lineBreak: false });
    doc.link(LEFT, top, width, height, notice.url);
    doc.font('regular').fontSize(8.5).fillColor(MUTED)
      .text('Pay securely online by card or bank transfer.', LEFT, top + height + 7, { width: 190 })
      .text('Zelle and checks are welcome too.', LEFT, doc.y + 1, { width: 190 });
    return;
  }
  if (notice.kind === 'autopay' || notice.kind === 'paid' || notice.kind === 'void') {
    const width = 210;
    doc.font('bold').fontSize(10);
    const textHeight = doc.heightOfString(notice.text, { width: width - 24 });
    doc.roundedRect(LEFT, top, width, textHeight + 22, 6).lineWidth(0.75).strokeColor('#bdbdbd').stroke();
    doc.fillColor(INK).text(notice.text, LEFT + 12, top + 11, { width: width - 24 });
  }
}

function drawWatermark(doc, text) {
  doc.save();
  doc.rotate(-30, { origin: [PAGE.width / 2, PAGE.height / 2] });
  doc.font('bold').fontSize(120).fillColor('#000000').fillOpacity(0.06)
    .text(text, 0, PAGE.height / 2 - 70, { width: PAGE.width, align: 'center', lineBreak: false });
  doc.restore();
  doc.fillOpacity(1);
}

/**
 * Renders the invoice to a PDF Buffer.
 *
 * `invoice` follows the shared `invoices/{id}` contract; `client` supplies the
 * BILLED TO block. A draft is watermarked so a preview can never be mistaken
 * for the invoice that was sent.
 */
export async function renderInvoicePdf(invoice, client, { issuer = BILLING_ISSUER } = {}) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 0,
    info: {
      Title: `Invoice #${invoice.number || 'draft'} — ${client?.name || ''}`.trim(),
      Author: issuer.name,
      Subject: `${invoice.periodLabel || ''} services`.trim(),
      Creator: 'BiteSites'
    }
  });
  const done = collect(doc);
  doc.registerFont('regular', FONTS.regular);
  doc.registerFont('bold', FONTS.bold);
  doc.registerFont('italic', FONTS.italic);

  if (invoice.status === 'draft') drawWatermark(doc, 'DRAFT');
  if (invoice.status === 'void') drawWatermark(doc, 'VOID');

  // Logo: the repo's full BiteSites lockup, sized so its artwork spans the same
  // box as the foundation's (x 79–214pt, top 59pt).
  doc.image(LOGO, 74, 48, { width: 145 });

  rightText(doc, issuer.name, 72, { size: 23 });
  [issuer.title, issuer.location, issuer.email, issuer.phone]
    .forEach((line, index) => rightText(doc, line, 110.2 + index * LINE));
  rightText(doc, `INVOICE #${invoice.number || 'DRAFT'}`, 191.9, { size: 20 });

  labelled(doc, 'BILLED TO:  ', client?.name || '', LEFT, 226);
  labelled(doc, 'ADDRESS: ', client?.address || '', LEFT, 226 + LINE);
  labelled(doc, 'DATE: ', formatUsDate(invoice.issueDate), LEFT, 226 + LINE * 2);

  const tableBottom = drawTable(doc, invoice);

  let top = tableBottom + 40.5;
  if (top + 130 > PAGE.height - 36) {
    doc.addPage({ size: 'LETTER', margin: 0 });
    top = 72;
  }
  const notice = paymentNotice(invoice);
  drawPaymentCallToAction(doc, notice, top + 4);

  rightText(doc, 'Payable to:', top, { font: 'bold', size: 17 });
  labelled(doc, 'Zelle: ', issuer.zelle, 0, top + 39.2, { align: 'right' });
  labelled(doc, 'Checks Payable To:   ', issuer.checksPayableTo, 0, top + 39.2 + LINE, { align: 'right' });
  labelled(doc, 'Terms: ', client?.terms || invoice.terms || DEFAULT_TERMS, 0, top + 39.2 + LINE * 2, { align: 'right' });
  // The foundation sets the thank-you line 30.8pt under Terms; a due-date line,
  // when shown, sits in between and pushes it down by one line.
  let thanksTop = top + 39.2 + LINE * 2 + 30.8;
  if (invoice.dueDate && (notice.kind === 'pay_now' || notice.kind === 'manual')) {
    rightText(doc, `Due by ${formatLongDate(invoice.dueDate)}`, top + 39.2 + LINE * 3, { color: MUTED, size: 9.5 });
    thanksTop += LINE;
  }
  rightText(doc, issuer.thankYou, thanksTop, { font: 'italic' });

  doc.end();
  return done;
}
