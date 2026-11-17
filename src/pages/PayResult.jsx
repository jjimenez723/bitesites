import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import logoMark from '../assets/bitesites-logo-mark.webp';

// Where Stripe Checkout returns a client after paying an invoice or setting up
// autopay (success_url / cancel_url in functions/billing-stripe.js), and where
// /api/pay/{token} lands when there is nothing to pay. The page reads only
// the query string; it never looks up the invoice, so it shows nothing a
// stranger with the URL could not already know.

const SUCCESS = {
  setup: {
    eyebrow: 'Autopay set up',
    title: 'Your payment method is saved.',
    message: 'Future BiteSites invoices will be charged to it automatically. You will still receive every invoice by email. If you connected a bank account that needs a quick verification, autopay starts once it is verified.'
  },
  processing: {
    eyebrow: 'Bank payment submitted',
    title: 'Your payment is on its way.',
    message: 'Bank (ACH) payments take a few business days to clear. There is no need to pay again.'
  },
  paid: {
    eyebrow: 'Nothing due',
    title: 'This invoice is already paid.',
    message: 'Thank you. There is nothing more to do here.'
  },
  default: {
    eyebrow: 'Payment received',
    title: 'Thank you for your payment.',
    message: 'Card payments clear right away. Bank (ACH) payments take a few business days to settle. There is no need to pay again.'
  }
};

const CANCEL = {
  setup: {
    eyebrow: 'Autopay not set up',
    title: 'Nothing was saved.',
    message: 'Autopay setup was canceled. You can use the same setup link again while it is valid, or ask us for a new one.'
  },
  invalid: {
    eyebrow: 'Link not recognised',
    title: 'This payment link is not valid.',
    message: 'Check that the whole link from your invoice email was opened, or reply to that email and we will send a fresh one.'
  },
  unavailable: {
    eyebrow: 'Invoice unavailable',
    title: 'This invoice can no longer be paid online.',
    message: 'It may have been replaced or cancelled. Reply to your invoice email and we will sort it out.'
  },
  error: {
    eyebrow: 'Checkout unavailable',
    title: 'We could not open checkout just now.',
    message: 'Nothing was charged. Please try the link in your invoice email again in a minute.'
  },
  default: {
    eyebrow: 'Payment canceled',
    title: 'Nothing was charged.',
    message: 'You can pay any time with the link in your invoice email. It stays valid until the invoice is paid.'
  }
};

export default function PayResult({ outcome }) {
  const [params] = useSearchParams();
  const table = outcome === 'success' ? SUCCESS : CANCEL;
  const key = params.get('setup') === '1' ? 'setup' : (params.get('status') || params.get('reason') || 'default');
  const copy = table[key] || table.default;

  useEffect(() => { window.scrollTo(0, 0); }, []);

  return (
    <main className="thank-you-page">
      <div className="thank-you-aurora" aria-hidden="true"><i /><i /><i /></div>
      <Link className="thank-you-brand" to="/" aria-label="BiteSites home">
        <img src={logoMark} alt="" width="500" height="500" />
        <span>BiteSites</span>
      </Link>
      <section className="thank-you-card" aria-labelledby="pay-result-title">
        {outcome === 'success' && <div className="thank-you-confirmation" aria-hidden="true"><span>✓</span></div>}
        <p className="thank-you-eyebrow"><i />{copy.eyebrow}</p>
        <h1 id="pay-result-title">{copy.title}</h1>
        <p className="thank-you-message">{copy.message}</p>
        <div className="thank-you-divider" />
        <Link className="thank-you-home-button" to="/">Go to homepage <b aria-hidden="true">→</b></Link>
      </section>
      <p className="thank-you-footnote">Payments are processed securely by Stripe. Questions about an invoice? Reply to the invoice email.</p>
    </main>
  );
}
