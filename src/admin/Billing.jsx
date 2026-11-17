// Admin → Billing: monthly client invoices (BILLING_INVOICING.md).
//
// This screen is a view over server state. Every change — numbering, amounts,
// status transitions, sending — goes through the billing Cloud Functions, which
// re-derive and validate everything. firestore.rules lets the browser write
// nothing here except a manual (Zelle/check/other) mark-paid, and this screen
// uses the billingMarkPaid callable even for that.

import React, { Component, useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, Pill } from './Panel';
import {
  createInvoice, finalizeInvoice, invoicePdfUrl, listBilling, markInvoicePaid, refreshLeadCount,
  saveBillingClient, sendInvoice, updateInvoiceDraft, voidInvoice
} from './billing-api';

// Stripe collection (Pay Now links, autopay, charges) for the open invoice.
// Wrapped in PaymentPanelBoundary so a Stripe UI fault never hides the invoice.
import BillingPaymentPanel from './billing/BillingPaymentPanel.jsx';

const STATUSES = ['draft', 'finalized', 'sent', 'payment_failed', 'paid', 'void'];
const STATUS_LABEL = {
  draft: 'Draft', finalized: 'Finalized', sent: 'Sent', payment_failed: 'Payment failed', paid: 'Paid', void: 'Void'
};
const STATUS_PILL = { draft: 'open', finalized: 'new', sent: 'contacted', payment_failed: 'failed', paid: 'won', void: 'lost' };
const OPEN_STATUSES = ['finalized', 'sent', 'payment_failed'];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = cents => usd.format((Number(cents) || 0) / 100);
const toCents = value => Math.round((Number(value) || 0) * 100);
const toDollars = cents => ((Number(cents) || 0) / 100).toFixed(2);
const dateLabel = iso => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const previousMonthKey = () => {
  const now = new Date();
  const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}`;
};

const errorText = error => error?.message?.replace(/^.*?:\s*/, '') || 'Something went wrong.';

class PaymentPanelBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('[billing] payment panel failed', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

function StatusPill({ status }) {
  return <Pill kind={STATUS_PILL[status] || ''}>{STATUS_LABEL[status] || status}</Pill>;
}

function emailState(invoice) {
  const email = invoice.email || {};
  if (email.lastError && !email.sentAt) return { text: 'Send failed', tone: 'finance-negative' };
  if (!email.sentAt) return { text: '—', tone: 'cell-dim' };
  const event = email.lastEvent || 'sent';
  const tone = ['bounced', 'complained', 'failed'].includes(event) ? 'finance-negative' : event === 'delivered' || event === 'opened' ? 'finance-positive' : '';
  return { text: `${event[0].toUpperCase()}${event.slice(1).replace(/_/g, ' ')}${email.sendCount > 1 ? ` · ${email.sendCount}×` : ''}`, tone };
}

function BillingStat({ label, value, foot, tone = '' }) {
  return (
    <div className={`admin-card finance-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{foot}</small>
    </div>
  );
}

// ------------------------------------------------------------------ invoice detail

function LineEditor({ lines, onChange, disabled, leadCount }) {
  const update = (index, key, value) => onChange(lines.map((line, row) => (row === index ? { ...line, [key]: value } : line)));
  return (
    <div className="billing-lines">
      <div className="billing-line billing-line-head" aria-hidden="true">
        <span>Description</span><span>Qty</span><span>Unit</span><span className="num">Amount</span><span />
      </div>
      {lines.map((line, index) => {
        const isLead = line.kind === 'leads';
        return (
          <div className="billing-line" key={index}>
            <input aria-label="Description" value={line.description} disabled={disabled || isLead}
                   onChange={event => update(index, 'description', event.target.value)} />
            <input aria-label="Quantity" type="number" min="0" step="1" value={isLead ? leadCount : line.quantity}
                   disabled={disabled || isLead} title={isLead ? 'Set the lead count above' : undefined}
                   onChange={event => update(index, 'quantity', event.target.value)} />
            <div className="finance-input-affix"><i>$</i>
              <input aria-label="Unit price" type="number" min="0" step="0.01" value={line.unit}
                     disabled={disabled} onChange={event => update(index, 'unit', event.target.value)} />
            </div>
            <span className="num cell-strong">{isLead
              ? (leadCount === '' ? '—' : money(toCents(line.unit) * Number(leadCount)))
              : money(toCents(line.unit) * (Number(line.quantity) || 0))}</span>
            {!disabled && !isLead
              ? <button className="finance-remove-row" type="button" aria-label="Remove line" onClick={() => onChange(lines.filter((_, row) => row !== index))}>×</button>
              : <span />}
          </div>
        );
      })}
    </div>
  );
}

const linesFromInvoice = invoice => (invoice.lineItems || []).map(line => ({
  kind: line.kind || 'custom',
  description: line.description,
  periodLabel: line.periodLabel,
  quantity: line.quantity ?? 1,
  unit: toDollars(line.unitCents ?? line.amountCents),
  pending: line.kind === 'leads' && (invoice.leadCount === null || invoice.leadCount === undefined)
}));

function InvoiceDetail({ invoice, client, onChanged, onNotice }) {
  const isDraft = invoice.status === 'draft';
  const [lines, setLines] = useState(() => linesFromInvoice(invoice));
  const [leadCount, setLeadCount] = useState(invoice.leadCount ?? '');
  const [issueDate, setIssueDate] = useState(invoice.issueDate || '');
  const [dueDate, setDueDate] = useState(invoice.dueDate || '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [payment, setPayment] = useState({ method: 'zelle', paidAt: new Date().toISOString().slice(0, 10), note: '' });

  useEffect(() => {
    setLines(linesFromInvoice(invoice));
    setLeadCount(invoice.leadCount ?? '');
    setIssueDate(invoice.issueDate || '');
    setDueDate(invoice.dueDate || '');
  }, [invoice]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  const leadLine = lines.find(line => line.kind === 'leads');
  const draftTotal = lines.reduce((sum, line) => sum + (line.kind === 'leads'
    ? toCents(line.unit) * (leadCount === '' ? 0 : Number(leadCount))
    : toCents(line.unit) * (Number(line.quantity) || 0)), 0);
  const dirty = isDraft && (
    JSON.stringify(lines) !== JSON.stringify(linesFromInvoice(invoice))
    || String(leadCount) !== String(invoice.leadCount ?? '')
    || issueDate !== invoice.issueDate || dueDate !== invoice.dueDate
  );

  const run = async (label, fn, success) => {
    setBusy(label);
    setError('');
    try {
      const result = await fn();
      if (success) onNotice(success);
      await onChanged();
      return result;
    } catch (caught) {
      setError(errorText(caught));
      return null;
    } finally {
      setBusy('');
    }
  };

  const patch = () => ({
    lineItems: lines.map(line => ({
      kind: line.kind,
      description: line.description,
      periodLabel: line.periodLabel || invoice.periodLabel,
      quantity: line.kind === 'leads' ? 0 : Number(line.quantity),
      unitCents: toCents(line.unit)
    })),
    leadCount: leadCount === '' ? null : Number(leadCount),
    issueDate,
    dueDate
  });

  const saveDraft = () => run('save', () => updateInvoiceDraft(invoice.id, patch()), `Invoice #${invoice.number} saved.`);
  const saveThen = async next => {
    if (dirty && !(await run('save', () => updateInvoiceDraft(invoice.id, patch())))) return;
    await next();
  };

  const openPreview = () => run('preview', async () => {
    const pdf = await invoicePdfUrl(invoice.id);
    setPreview(current => { if (current?.url) URL.revokeObjectURL(current.url); return pdf; });
  });

  const leadPull = invoice.leadPull || {};
  const recipients = client?.billingEmails || [];

  return (
    <div className="billing-detail">
      {error && <p className="admin-error">{error}</p>}

      <div className="billing-detail-summary">
        <div><span>Total</span><strong>{money(isDraft ? draftTotal : invoice.totalCents)}</strong></div>
        <div><span>Status</span><StatusPill status={invoice.status} /></div>
        <div><span>Period</span><b>{invoice.periodLabel}</b></div>
        <div><span>Autopay</span><b>{invoice.status === 'draft' ? (client?.autopay?.enabled ? 'On (card on file)' : 'Off') : (invoice.autopay ? 'On' : 'Off')}</b></div>
      </div>

      {leadLine && (
        <section className="finance-form-section">
          <div className="finance-form-section-head">
            <div>
              <strong>Lead Generation</strong>
              <small>
                {money(toCents(leadLine.unit))} per lead ·{' '}
                {leadPull.status === 'pulled' && `pulled from WordPress ${dateLabel(leadPull.at)}${leadPull.duplicates ? ` · ${leadPull.duplicates} repeat${leadPull.duplicates === 1 ? '' : 's'} collapsed` : ''}`}
                {leadPull.status === 'failed' && `WordPress pull failed: ${leadPull.error}`}
                {leadPull.status === 'manual_override' && 'entered manually'}
                {leadPull.status === 'awaiting_entry' && 'enter the month’s count'}
                {!leadPull.status && 'no pull recorded'}
              </small>
            </div>
            {isDraft && client?.leadSource?.type === 'wordpress' && (
              <button className="btn-admin" type="button" disabled={Boolean(busy)}
                      onClick={() => run('pull', () => refreshLeadCount(invoice.id), 'Lead count pulled from WordPress.')}>
                {busy === 'pull' ? 'Pulling…' : 'Pull from WordPress'}
              </button>
            )}
          </div>
          <div className="finance-form-grid">
            <label>
              <span>Leads this period</span>
              <input type="number" min="0" step="1" value={leadCount} disabled={!isDraft}
                     placeholder="Not set" onChange={event => setLeadCount(event.target.value)} />
            </label>
            <div className="finance-form-preview">
              <span>Lead line</span>
              <strong>{leadCount === '' ? '—' : money(toCents(leadLine.unit) * Number(leadCount))}</strong>
              <small>{leadCount === '' ? 'Required before the invoice can be finalized.' : `${leadCount} × ${money(toCents(leadLine.unit))}`}</small>
            </div>
          </div>
        </section>
      )}

      <section className="finance-form-section">
        <div className="finance-form-section-head">
          <div><strong>Line items</strong><small>{isDraft ? 'Amounts are recalculated on the server when you save.' : 'Locked once finalized.'}</small></div>
          {isDraft && (
            <button className="btn-admin" type="button" onClick={() => setLines(current => [...current.filter(line => line.kind !== 'leads'),
              { kind: 'custom', description: '', periodLabel: invoice.periodLabel, quantity: 1, unit: '0.00' },
              ...current.filter(line => line.kind === 'leads')])}>+ Line</button>
          )}
        </div>
        <LineEditor lines={lines} onChange={setLines} disabled={!isDraft} leadCount={leadCount} />
        <div className="finance-form-grid">
          <label><span>Issue date</span><input type="date" value={issueDate} disabled={!isDraft} onChange={event => setIssueDate(event.target.value)} /></label>
          <label><span>Due date</span><input type="date" value={dueDate} disabled={!isDraft} onChange={event => setDueDate(event.target.value)} /></label>
        </div>
      </section>

      <section className="finance-form-section">
        <div className="finance-form-section-head"><div><strong>Delivery</strong><small>{recipients.length ? `To ${recipients.join(', ')}` : 'No billing email on the client — add one before sending.'}</small></div></div>
        <dl className="detail-rows">
          <div className="detail-row"><dt>Email</dt><dd>{emailState(invoice).text}{invoice.email?.sentAt ? ` · last sent ${dateLabel(invoice.email.sentAt)}` : ''}</dd></div>
          {invoice.email?.lastError && <div className="detail-row"><dt>Last error</dt><dd className="finance-negative">{invoice.email.lastError}</dd></div>}
          <div className="detail-row"><dt>Payment</dt><dd>
            {invoice.status === 'paid'
              ? `Paid ${dateLabel(invoice.payment?.paidAt)} · ${invoice.payment?.method || ''}`
              : invoice.payment?.processingAt ? 'Bank (ACH) payment processing — settles in a few business days'
                : invoice.autopay && invoice.status !== 'payment_failed' ? `Autopay charge${invoice.payment?.autopayError ? ` not completed: ${invoice.payment.autopayError}` : ' after sending'}`
                  : invoice.payment?.payNowUrl ? 'Pay Now link created (bank first, card as backup)' : 'Zelle / check (no online pay link)'}
          </dd></div>
        </dl>
      </section>

      <PaymentPanelBoundary>
        <BillingPaymentPanel invoice={invoice} client={client} onChange={onChanged} />
      </PaymentPanelBoundary>

      {preview && (
        <section className="billing-preview">
          <iframe title={`Invoice ${invoice.number} PDF`} src={preview.url} />
          <a className="btn-admin" href={preview.url} download={preview.filename}>Download PDF</a>
        </section>
      )}

      {OPEN_STATUSES.includes(invoice.status) && (
        <section className="finance-form-section">
          <div className="finance-form-section-head"><div><strong>Record a Zelle or check payment</strong><small>Online bank (ACH) and card payments are recorded automatically by Stripe.</small></div></div>
          <div className="finance-form-grid">
            <label><span>Method</span>
              <select value={payment.method} onChange={event => setPayment(current => ({ ...current, method: event.target.value }))}>
                <option value="zelle">Zelle</option><option value="check">Check</option><option value="other">Other</option>
              </select>
            </label>
            <label><span>Received on</span><input type="date" value={payment.paidAt} onChange={event => setPayment(current => ({ ...current, paidAt: event.target.value }))} /></label>
            <label className="wide"><span>Note (optional)</span><input value={payment.note} placeholder="Check #, Zelle confirmation…" onChange={event => setPayment(current => ({ ...current, note: event.target.value }))} /></label>
          </div>
        </section>
      )}

      <div className="finance-form-actions billing-actions">
        <button className="btn-admin" type="button" disabled={Boolean(busy)} onClick={() => saveThen(openPreview)}>{busy === 'preview' ? 'Rendering…' : 'Preview PDF'}</button>
        {isDraft && <button className="btn-admin" type="button" disabled={Boolean(busy) || !dirty} onClick={saveDraft}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>}
        {isDraft && <button className="btn-admin" type="button" disabled={Boolean(busy)} onClick={() => saveThen(() => run('finalize', () => finalizeInvoice(invoice.id), `Invoice #${invoice.number} finalized.`))}>{busy === 'finalize' ? 'Finalizing…' : 'Finalize'}</button>}
        {(isDraft || invoice.status === 'finalized') && (
          <button className="btn-admin primary" type="button" disabled={Boolean(busy) || !recipients.length}
                  onClick={() => window.confirm(`Send invoice #${invoice.number} (${money(isDraft ? draftTotal : invoice.totalCents)}) to ${recipients.join(', ')}?`)
                    && saveThen(() => run('send', () => sendInvoice(invoice.id), `Invoice #${invoice.number} sent.`))}>
            {busy === 'send' ? 'Sending…' : isDraft ? 'Approve & send' : 'Send'}
          </button>
        )}
        {['sent', 'payment_failed', 'paid'].includes(invoice.status) && (
          <button className="btn-admin" type="button" disabled={Boolean(busy) || !recipients.length}
                  onClick={() => window.confirm(`Send invoice #${invoice.number} again to ${recipients.join(', ')}?`)
                    && run('resend', () => sendInvoice(invoice.id, { resend: true }), `Invoice #${invoice.number} re-sent.`)}>
            {busy === 'resend' ? 'Sending…' : 'Resend'}
          </button>
        )}
        {OPEN_STATUSES.includes(invoice.status) && (
          <button className="btn-admin" type="button" disabled={Boolean(busy)}
                  onClick={() => run('paid', () => markInvoicePaid(invoice.id, payment), `Invoice #${invoice.number} marked paid.`)}>
            {busy === 'paid' ? 'Saving…' : 'Mark paid'}
          </button>
        )}
        {!['paid', 'void'].includes(invoice.status) && (
          <button className="btn-admin danger" type="button" disabled={Boolean(busy)}
                  onClick={() => {
                    const reason = window.prompt(`Void invoice #${invoice.number}? Its number is kept and not reused. Reason (optional):`, '');
                    if (reason !== null) run('void', () => voidInvoice(invoice.id, reason), `Invoice #${invoice.number} voided.`);
                  }}>
            Void
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ client form

function ClientForm({ client, onSaved }) {
  const [form, setForm] = useState(() => ({
    id: client?.id || '',
    name: client?.name || '',
    contactName: client?.contactName || '',
    billingEmails: (client?.billingEmails || []).join(', '),
    address: client?.address || '',
    lineItems: (client?.lineItems || []).map(line => ({ description: line.description, amount: toDollars(line.amountCents) })),
    leadRate: toDollars(client?.leadRateCents ?? 7500),
    leadSourceType: client?.leadSource?.type || 'manual',
    leadEndpoint: client?.leadSource?.endpoint || '',
    approvalMode: client?.approvalMode || 'manual',
    invoiceNumberNext: client?.invoiceNumberNext || 1,
    terms: client?.terms || 'Payment is due within 15-30 days of the invoice dates',
    active: client?.active !== false
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const updateLine = (index, key, value) => field('lineItems', form.lineItems.map((line, row) => (row === index ? { ...line, [key]: value } : line)));
  const monthly = form.lineItems.reduce((sum, line) => sum + toCents(line.amount), 0);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await saveBillingClient(client?.id || '', {
        name: form.name,
        contactName: form.contactName,
        billingEmails: form.billingEmails,
        address: form.address,
        lineItems: form.lineItems.map(line => ({ description: line.description, amountCents: toCents(line.amount) })),
        leadRateCents: toCents(form.leadRate),
        leadSource: form.leadSourceType === 'wordpress' ? { type: 'wordpress', endpoint: form.leadEndpoint } : { type: 'manual' },
        approvalMode: form.approvalMode,
        invoiceNumberNext: Number(form.invoiceNumberNext),
        terms: form.terms,
        active: form.active
      });
      await onSaved(`${form.name} saved.`);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="finance-form" onSubmit={submit}>
      {error && <p className="admin-error">{error}</p>}
      <div className="finance-form-grid">
        <label className="wide"><span>Client name (BILLED TO)</span><input value={form.name} onChange={event => field('name', event.target.value)} required /></label>
        <label><span>Contact name</span><input value={form.contactName} onChange={event => field('contactName', event.target.value)} placeholder="Used in the email greeting" /></label>
        <label><span>Status</span><select value={form.active ? 'active' : 'inactive'} onChange={event => field('active', event.target.value === 'active')}><option value="active">Active — invoiced monthly</option><option value="inactive">Inactive</option></select></label>
        <label className="wide"><span>Billing emails</span><input value={form.billingEmails} onChange={event => field('billingEmails', event.target.value)} placeholder="billing@client.com, owner@client.com" /></label>
        <label className="wide"><span>Address</span><input value={form.address} onChange={event => field('address', event.target.value)} /></label>
      </div>

      <section className="finance-form-section">
        <div className="finance-form-section-head">
          <div><strong>Monthly retainer lines</strong><small>{money(monthly)} per month before leads</small></div>
          <button className="btn-admin" type="button" onClick={() => field('lineItems', [...form.lineItems, { description: '', amount: '0.00' }])}>+ Line</button>
        </div>
        <div className="finance-allocation-editor">
          {form.lineItems.map((line, index) => (
            <div className="finance-allocation-row billing-client-line" key={index}>
              <label><span>Description</span><input value={line.description} onChange={event => updateLine(index, 'description', event.target.value)} required /></label>
              <label><span>Amount</span><div className="finance-input-affix"><i>$</i><input type="number" min="0" step="0.01" value={line.amount} onChange={event => updateLine(index, 'amount', event.target.value)} /></div></label>
              <button className="finance-remove-row" type="button" aria-label="Remove line" onClick={() => field('lineItems', form.lineItems.filter((_, row) => row !== index))}>×</button>
            </div>
          ))}
          {!form.lineItems.length && <p className="finance-inline-empty">No recurring lines yet.</p>}
        </div>
      </section>

      <section className="finance-form-section">
        <div className="finance-form-section-head"><div><strong>Lead Generation</strong><small>Billed per lead each month. Set the rate to 0 to leave the line off.</small></div></div>
        <div className="finance-form-grid">
          <label><span>Rate per lead</span><div className="finance-input-affix"><i>$</i><input type="number" min="0" step="0.01" value={form.leadRate} onChange={event => field('leadRate', event.target.value)} /></div></label>
          <label><span>Lead count source</span><select value={form.leadSourceType} onChange={event => field('leadSourceType', event.target.value)}><option value="manual">Entered manually</option><option value="wordpress">WordPress lead endpoint</option></select></label>
          {form.leadSourceType === 'wordpress' && (
            <label className="wide"><span>Endpoint (BiteSites Lead Count plugin)</span><input type="url" value={form.leadEndpoint} onChange={event => field('leadEndpoint', event.target.value)} placeholder="https://example.com/wp-json/bitesites/v1/lead-count" required /></label>
          )}
        </div>
      </section>

      <section className="finance-form-section">
        <div className="finance-form-section-head"><div><strong>Invoicing</strong><small>Drafts are created at 6:00 AM Eastern on the 1st for the month that just ended.</small></div></div>
        <div className="finance-form-grid">
          <label><span>Approval</span><select value={form.approvalMode} onChange={event => field('approvalMode', event.target.value)}><option value="manual">Manual — review each draft</option><option value="auto">Automatic — send when complete</option></select></label>
          <label><span>Next invoice number</span><input type="number" min="1" step="1" value={form.invoiceNumberNext} onChange={event => field('invoiceNumberNext', event.target.value)} /></label>
          <label className="wide"><span>Terms</span><input value={form.terms} onChange={event => field('terms', event.target.value)} /></label>
        </div>
        <dl className="detail-rows">
          <div className="detail-row"><dt>Autopay</dt><dd>{client?.autopay?.enabled ? 'On — card on file is charged when the invoice is sent' : 'Off — invoices carry a Pay Now link when Stripe is configured'}</dd></div>
        </dl>
      </section>

      <div className="finance-form-actions">
        <button className="btn-admin primary" type="submit" disabled={busy}>{busy ? 'Saving…' : client ? 'Save client' : 'Add client'}</button>
      </div>
    </form>
  );
}

function CreateInvoiceForm({ clients, onCreated }) {
  const active = clients.filter(client => client.active !== false);
  const [clientId, setClientId] = useState(active[0]?.id || '');
  const [month, setMonth] = useState(previousMonthKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await createInvoice(clientId, month);
      await onCreated(result.invoice, result.created ? `Draft #${result.invoice.number} created.` : `Invoice #${result.invoice.number} already exists for that month.`);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="finance-form" onSubmit={submit}>
      {error && <p className="admin-error">{error}</p>}
      <p className="finance-method-note">Creates the same draft the monthly run would: the next invoice number, the client’s retainer lines and, for WordPress clients, a lead-count pull. One invoice per client per month.</p>
      <div className="finance-form-grid">
        <label><span>Client</span><select value={clientId} onChange={event => setClientId(event.target.value)} required>{active.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
        <label><span>Billing month</span><input type="month" value={month} onChange={event => setMonth(event.target.value)} required /></label>
      </div>
      <div className="finance-form-actions"><button className="btn-admin primary" type="submit" disabled={busy || !clientId}>{busy ? 'Creating…' : 'Create draft'}</button></div>
    </form>
  );
}

// ------------------------------------------------------------------ page

export default function Billing() {
  const [data, setData] = useState({ clients: [], invoices: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('invoices');
  const [status, setStatus] = useState('all');
  const [clientFilter, setClientFilter] = useState('all');
  const [panel, setPanel] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listBilling());
      setError('');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const clientsById = useMemo(() => new Map(data.clients.map(client => [client.id, client])), [data.clients]);
  const counts = useMemo(() => data.invoices.reduce((map, invoice) => map.set(invoice.status, (map.get(invoice.status) || 0) + 1), new Map()), [data.invoices]);
  const visible = data.invoices.filter(invoice => (status === 'all' || invoice.status === status)
    && (clientFilter === 'all' || invoice.clientId === clientFilter));
  const outstanding = data.invoices.filter(invoice => OPEN_STATUSES.includes(invoice.status));
  const thisMonth = new Date().toISOString().slice(0, 7);
  const paidThisMonth = data.invoices.filter(invoice => invoice.status === 'paid' && String(invoice.payment?.paidAt || '').slice(0, 7) === thisMonth);
  const openInvoice = panel?.type === 'invoice' ? data.invoices.find(invoice => invoice.id === panel.id) : null;

  const flash = message => { setNotice(message); window.setTimeout(() => setNotice(current => (current === message ? '' : current)), 6000); };

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Billing</h1>
          <p className="admin-topbar-sub">Monthly client invoices — drafted on the 1st, reviewed here, delivered by email with the PDF.</p>
        </div>
        <div className="admin-topbar-spacer" />
        <div className="admin-segment" role="group" aria-label="Billing view">
          <button type="button" aria-pressed={tab === 'invoices'} onClick={() => setTab('invoices')}>Invoices</button>
          <button type="button" aria-pressed={tab === 'clients'} onClick={() => setTab('clients')}>Clients</button>
        </div>
        <button className="btn-admin" type="button" onClick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        {tab === 'invoices'
          ? <button className="btn-admin primary" type="button" disabled={!data.clients.length} onClick={() => setPanel({ type: 'create' })}>+ Invoice</button>
          : <button className="btn-admin primary" type="button" onClick={() => setPanel({ type: 'client', row: null })}>+ Client</button>}
      </header>

      <div className={`admin-body billing-page ${loading ? 'is-refreshing' : ''}`}>
        {error && <p className="admin-error">{error}</p>}
        {notice && <p className="billing-notice" role="status">{notice}</p>}

        <div className="admin-grid cols-4">
          <BillingStat label="Outstanding" value={money(outstanding.reduce((sum, invoice) => sum + (invoice.totalCents || 0), 0))} foot={`${outstanding.length} unpaid invoice${outstanding.length === 1 ? '' : 's'}`} tone="owed" />
          <BillingStat label="Drafts to review" value={counts.get('draft') || 0} foot="Created on the 1st; nothing is sent until approved" tone="expense" />
          <BillingStat label="Paid this month" value={money(paidThisMonth.reduce((sum, invoice) => sum + (invoice.totalCents || 0), 0))} foot={`${paidThisMonth.length} invoice${paidThisMonth.length === 1 ? '' : 's'}`} tone="revenue" />
          <BillingStat label="Payment issues" value={counts.get('payment_failed') || 0} foot="Autopay charges that did not go through" tone="net" />
        </div>

        {tab === 'invoices' && (
          <section className="admin-card">
            <div className="card-head">
              <div><h3>Invoices</h3><p>Newest first. Open an invoice to edit a draft, preview the PDF, send, or record a payment.</p></div>
              <div className="card-head-actions admin-filters">
                <select className="admin-select" aria-label="Invoice status" value={status} onChange={event => setStatus(event.target.value)}>
                  <option value="all">All statuses ({data.invoices.length})</option>
                  {STATUSES.map(value => <option key={value} value={value}>{STATUS_LABEL[value]} ({counts.get(value) || 0})</option>)}
                </select>
                <select className="admin-select" aria-label="Client" value={clientFilter} onChange={event => setClientFilter(event.target.value)}>
                  <option value="all">All clients</option>
                  {data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
                </select>
              </div>
            </div>
            {visible.length ? (
              <div className="admin-table-scroll">
                <table className="admin-table finance-table billing-table">
                  <thead><tr><th>Invoice</th><th>Client</th><th>Period</th><th className="num">Total</th><th>Status</th><th>Email</th><th>Due</th><th /></tr></thead>
                  <tbody>
                    {visible.map(invoice => {
                      const email = emailState(invoice);
                      return (
                        <tr key={invoice.id}>
                          <td className="cell-strong">#{invoice.number}</td>
                          <td>{clientsById.get(invoice.clientId)?.name || invoice.clientName || invoice.clientId}</td>
                          <td>{invoice.periodLabel}{invoice.leadCount === null && invoice.status === 'draft' && <div className="cell-dim finance-negative">Lead count needed</div>}</td>
                          <td className="num cell-strong">{money(invoice.totalCents)}</td>
                          <td><StatusPill status={invoice.status} />{invoice.autopay && <div className="cell-dim">Autopay</div>}</td>
                          <td className={email.tone}>{email.text}</td>
                          <td className="cell-dim">{dateLabel(invoice.dueDate)}</td>
                          <td className="num"><button className="view-toggle" type="button" onClick={() => setPanel({ type: 'invoice', id: invoice.id })}>Open</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="admin-empty">
                <strong>{data.invoices.length ? 'No invoices match these filters' : 'No invoices yet'}</strong>
                {data.clients.length ? 'Drafts appear here on the 1st of each month, or create one with + Invoice.' : 'Add a billing client first.'}
              </div>
            )}
          </section>
        )}

        {tab === 'clients' && (
          <section className="admin-card">
            <div className="card-head"><div><h3>Billing clients</h3><p>Recurring lines, lead billing, approval and numbering per client. Autopay is managed through Stripe.</p></div></div>
            {data.clients.length ? (
              <div className="admin-table-scroll">
                <table className="admin-table finance-table">
                  <thead><tr><th>Client</th><th className="num">Monthly</th><th>Leads</th><th>Approval</th><th>Next #</th><th>Autopay</th><th /></tr></thead>
                  <tbody>
                    {data.clients.map(client => (
                      <tr key={client.id}>
                        <td><div className="cell-strong">{client.name}</div><div className="cell-dim">{(client.billingEmails || []).join(', ') || 'No billing email'}{client.active === false ? ' · inactive' : ''}</div></td>
                        <td className="num">{money((client.lineItems || []).reduce((sum, line) => sum + (line.amountCents || 0), 0))}</td>
                        <td>{client.leadRateCents > 0 ? `${money(client.leadRateCents)}/lead · ${client.leadSource?.type === 'wordpress' ? 'WordPress' : 'manual'}` : '—'}</td>
                        <td>{client.approvalMode === 'auto' ? 'Automatic' : 'Manual'}</td>
                        <td>#{String(client.invoiceNumberNext || 1).padStart(3, '0')}</td>
                        <td>{client.autopay?.enabled ? <Pill kind="won">On</Pill> : <span className="cell-dim">Off</span>}</td>
                        <td className="num"><button className="view-toggle" type="button" onClick={() => setPanel({ type: 'client', row: client })}>Edit</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="admin-empty"><strong>No billing clients yet</strong>Add a client with its monthly lines and lead billing.</div>}
          </section>
        )}
      </div>

      {openInvoice && (
        <Panel title={`Invoice #${openInvoice.number}`} subtitle={`${clientsById.get(openInvoice.clientId)?.name || openInvoice.clientName} · ${openInvoice.periodLabel}`} onClose={() => setPanel(null)}>
          <InvoiceDetail invoice={openInvoice} client={clientsById.get(openInvoice.clientId)} onChanged={refresh} onNotice={flash} />
        </Panel>
      )}
      {panel?.type === 'client' && (
        <Panel title={panel.row ? `Edit ${panel.row.name}` : 'Add billing client'} subtitle="Monthly lines, lead billing and approval" onClose={() => setPanel(null)}>
          <ClientForm client={panel.row} onSaved={async message => { flash(message); setPanel(null); await refresh(); }} />
        </Panel>
      )}
      {panel?.type === 'create' && (
        <Panel title="Create invoice" subtitle="A draft for one client and month" onClose={() => setPanel(null)}>
          <CreateInvoiceForm clients={data.clients} onCreated={async (invoice, message) => { flash(message); await refresh(); setPanel({ type: 'invoice', id: invoice.id }); }} />
        </Panel>
      )}
    </>
  );
}
