// Stripe payment controls for one invoice, mounted by the invoicing UI on the
// invoice detail page:
//
//   <BillingPaymentPanel invoice={invoice} client={client} onChange={refresh} />
//
// Bank first: the Pay Now link and the autopay setup link default to bank
// (ACH) — 0.8% capped at $5 against 2.9% + 30¢ for a card — and card is
// offered as the alternative.
//
// `invoice` and `client` are the Firestore documents (with `id`) from the
// shared contract in STRIPE_BILLING.md. The panel also subscribes to both
// documents, so a webhook that marks the invoice paid or enrolls autopay shows
// up here without the parent having to refetch. Every action goes through a
// Cloud Function; this component never writes Firestore.

import React, { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { DetailRows, Pill } from '../Panel';
import {
  chargeInvoiceNow,
  createAutopaySetupLink,
  errorMessage,
  formatCents,
  formatWhen,
  refreshPayNowLink,
  setAutopay,
  stripeDashboardIsLive,
  stripeDashboardUrl
} from './billing-api';
import './billing.css';

const STATUS_PILL = {
  draft: ['open', 'Draft'],
  finalized: ['open', 'Finalized'],
  sent: ['contacted', 'Sent'],
  paid: ['won', 'Paid'],
  payment_failed: ['failed', 'Payment failed'],
  void: ['lost', 'Void']
};

const CHARGEABLE = ['finalized', 'sent', 'payment_failed'];

// The live document once it arrives; the prop until then, or if the live
// read is refused.
function useLiveDoc(path, fallback) {
  const [live, setLive] = useState(null);
  useEffect(() => {
    setLive(null);
    if (!path) return undefined;
    return onSnapshot(doc(db, path), snapshot => {
      if (snapshot.exists()) setLive({ id: snapshot.id, ...snapshot.data() });
    }, () => setLive(null));
  }, [path]);
  return live || fallback;
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* the field stays selectable for a manual copy */ }
  };
  return (
    <div className="billing-copy">
      <span className="panel-section-label">{label}</span>
      <div className="billing-copy-row">
        <input readOnly value={value} onFocus={event => event.target.select()} aria-label={label} />
        <button className="btn-admin" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

const DashboardLink = ({ kind, id, children }) => (id
  ? <a className="billing-stripe-link" href={stripeDashboardUrl(kind, id)} target="_blank" rel="noreferrer">{children || id} ↗</a>
  : null);

export default function BillingPaymentPanel({ invoice: invoiceProp, client: clientProp, onChange }) {
  const invoiceId = invoiceProp?.id || '';
  const clientId = clientProp?.id || invoiceProp?.clientId || '';
  const invoice = useLiveDoc(invoiceId ? `invoices/${invoiceId}` : '', invoiceProp);
  const client = useLiveDoc(clientId ? `billingClients/${clientId}` : '', clientProp);

  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [setupLink, setSetupLink] = useState(null);
  const [confirmingCharge, setConfirmingCharge] = useState(false);

  if (!invoice || !invoiceId) return null;

  const autopay = client?.autopay || {};
  const payment = invoice.payment || {};
  const hasMethod = Boolean(autopay.stripeCustomerId && autopay.defaultPaymentMethodId);
  const [pillKind, pillLabel] = STATUS_PILL[invoice.status] || ['', invoice.status || 'Unknown'];
  const canCharge = Boolean(invoice.autopay) && autopay.enabled && hasMethod && CHARGEABLE.includes(invoice.status);
  const canRegenerate = !['paid', 'void', 'draft'].includes(invoice.status);

  async function run(name, work) {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      const result = await work();
      onChange?.();
      return result;
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    } finally {
      setBusy('');
    }
  }

  const sendSetupLink = (method = 'bank') => run(method === 'card' ? 'setup-card' : 'setup', async () => {
    const result = await createAutopaySetupLink(clientId, method);
    setSetupLink(result);
  });

  const toggleAutopay = () => run('toggle', async () => {
    const result = await setAutopay(clientId, !autopay.enabled);
    setNotice(result.enabled ? 'Autopay is on for this client.' : 'Autopay is off. The saved payment method is kept.');
  });

  const regenerate = () => run('regenerate', async () => {
    await refreshPayNowLink(invoiceId);
    setNotice('A fresh checkout is behind the Pay Now link. The link itself did not change.');
  });

  const chargeNow = () => run('charge', async () => {
    setConfirmingCharge(false);
    const result = await chargeInvoiceNow(invoiceId);
    const messages = {
      succeeded: 'Charged. The invoice is paid.',
      processing: 'Bank (ACH) debit submitted. It settles in a few business days; the invoice updates automatically.',
      failed: result.reason === 'not_enrolled'
        ? 'Autopay is not set up for this client, so nothing was charged. Send the Pay Now link.'
        : `The charge failed${result.message ? `: ${result.message}` : '.'} A Pay Now link is ready to send.`
    };
    setNotice(messages[result.status] || `Charge result: ${result.status}`);
  });

  const autopayState = autopay.enabled && hasMethod ? ['won', 'On']
    : autopay.pendingSetupIntentId ? ['open', 'Awaiting bank verification']
      : hasMethod ? ['lost', 'Off (method saved)'] : ['lost', 'Not set up'];

  return (
    <section className="billing-panel" aria-label="Stripe payment">
      {/* A div, not <header>: the marketing stylesheet fixes every <header> to the top of the page. */}
      <div className="billing-panel-head">
        <h3>Payment</h3>
        {!stripeDashboardIsLive && <span className="billing-mode">Stripe test mode</span>}
      </div>

      {error && <p className="admin-error">{error}</p>}
      {notice && <p className="billing-notice" role="status">{notice}</p>}

      <div className="billing-block">
        <div className="billing-block-head">
          <span className="panel-section-label">Invoice</span>
          <Pill kind={pillKind}>{pillLabel}</Pill>
        </div>
        <DetailRows rows={[
          ['Amount', formatCents(invoice.totalCents)],
          ['Collection', invoice.autopay ? 'Autopay' : 'Pay Now link'],
          ['Paid', payment.paidAt ? `${formatWhen(payment.paidAt)}${payment.method ? ` · ${payment.method}` : ''}` : ''],
          ['Processing since', !payment.paidAt && payment.processingAt && invoice.status !== 'payment_failed' ? formatWhen(payment.processingAt) : ''],
          ['Last error', invoice.status === 'payment_failed' ? payment.lastError : ''],
          ['Refunded', payment.refundedCents ? `${formatCents(payment.refundedCents)}${payment.fullyRefunded ? ' (full)' : ''}` : ''],
          ['Second payment', payment.duplicatePaymentIntentIds?.length
            ? <span className="billing-warning">{payment.duplicatePaymentIntentIds.length} extra payment(s) received — review for refund</span> : ''],
          ['Payment', payment.stripePaymentIntentId ? <DashboardLink kind="payment_intent" id={payment.stripePaymentIntentId} /> : ''],
          ['Checkout', payment.stripeCheckoutSessionId ? <DashboardLink kind="checkout_session" id={payment.stripeCheckoutSessionId} /> : '']
        ]} />

        {invoice.status !== 'paid' && payment.payNowUrl && (
          <>
            <CopyField label="Pay by bank (ACH) — send this link" value={payment.payNowUrl} />
            <CopyField label="Card alternative" value={`${payment.payNowUrl.split('?')[0]}?method=card`} />
            <p className="admin-note">Bank is the default: 0.8% capped at $5 per payment, against 2.9% + 30¢ by card. The bank page links to the card page and back.</p>
          </>
        )}
        <div className="billing-actions">
          {canRegenerate && (
            <button className="btn-admin" type="button" disabled={Boolean(busy)} onClick={regenerate}>
              {busy === 'regenerate' ? 'Working…' : payment.payNowUrl ? 'Regenerate checkout' : 'Create Pay Now link'}
            </button>
          )}
          {canCharge && !confirmingCharge && (
            <button className="btn-admin primary" type="button" disabled={Boolean(busy)} onClick={() => setConfirmingCharge(true)}>
              {busy === 'charge' ? 'Charging…' : 'Charge now'}
            </button>
          )}
        </div>
        {confirmingCharge && (
          <div className="billing-confirm" role="alertdialog" aria-label="Confirm charge">
            <p>Charge <strong>{formatCents(invoice.totalCents)}</strong> to {client?.name || 'this client'}’s saved payment method now?</p>
            <div className="billing-actions">
              <button className="btn-admin primary" type="button" disabled={Boolean(busy)} onClick={chargeNow}>Yes, charge {formatCents(invoice.totalCents)}</button>
              <button className="btn-admin" type="button" onClick={() => setConfirmingCharge(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="billing-block">
        <div className="billing-block-head">
          <span className="panel-section-label">Autopay · {client?.name || clientId}</span>
          <Pill kind={autopayState[0]}>{autopayState[1]}</Pill>
        </div>
        <DetailRows rows={[
          ['Customer', autopay.stripeCustomerId ? <DashboardLink kind="customer" id={autopay.stripeCustomerId} /> : ''],
          ['Payment method', autopay.defaultPaymentMethodId ? <DashboardLink kind="payment_method" id={autopay.defaultPaymentMethodId} /> : ''],
          ['Updated', formatWhen(autopay.updatedAt)]
        ]} />
        <div className="billing-actions">
          <button className="btn-admin primary" type="button" disabled={Boolean(busy) || !clientId} onClick={() => sendSetupLink('bank')}>
            {busy === 'setup' ? 'Creating…' : hasMethod ? 'New bank (ACH) setup link' : 'Send bank (ACH) setup link'}
          </button>
          <button className="btn-admin" type="button" disabled={Boolean(busy) || !clientId} onClick={() => sendSetupLink('card')}>
            {busy === 'setup-card' ? 'Creating…' : 'Card setup link instead'}
          </button>
          <button className="btn-admin" type="button" disabled={Boolean(busy) || !clientId || (!autopay.enabled && !hasMethod)} onClick={toggleAutopay}
            title={!autopay.enabled && !hasMethod ? 'The client has to save a payment method first.' : undefined}>
            {busy === 'toggle' ? 'Saving…' : autopay.enabled ? 'Turn autopay off' : 'Turn autopay on'}
          </button>
        </div>
        {setupLink && (
          <>
            <CopyField label={setupLink.method === 'card' ? 'Autopay setup link (card)' : 'Autopay setup link (bank / ACH)'} value={setupLink.url} />
            <p className="admin-note">Send this to the client. It expires {formatWhen(setupLink.expiresAt)} (Stripe’s 24-hour limit); create a new one after that. Autopay turns on by itself once they finish.</p>
          </>
        )}
      </div>
    </section>
  );
}
