import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import logoMark from '../assets/bitesites-logo-mark.webp';

const REDIRECT_SECONDS = 12;

const confirmations = {
  byte: {
    eyebrow: 'Conversation complete',
    title: 'Thanks for talking with Byte.',
    message: 'We hope the conversation gave you a clearer next step. If you shared your details, our team will take it from here.'
  },
  bit: {
    eyebrow: 'Message received',
    title: 'Thanks for chatting with Bit.',
    message: 'Your project notes made it to our team. We’ll review the details and follow up with a thoughtful next step.'
  },
  form: {
    eyebrow: 'Project request received',
    title: 'Your project is in good hands.',
    message: 'Thanks for telling us what you’re building. Our team will review your request and get back to you soon.'
  },
  default: {
    eyebrow: 'Thank you',
    title: 'We’re glad you reached out.',
    message: 'Your message is with the BiteSites team. We’ll review it and follow up with the right next step.'
  }
};

export default function ThankYou() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [remaining, setRemaining] = useState(REDIRECT_SECONDS);
  const source = searchParams.get('source')?.toLowerCase() || 'default';
  const confirmation = confirmations[source] || confirmations.default;

  useEffect(() => {
    document.title = 'Thank You | BiteSites';
    window.scrollTo(0, 0);

    const deadline = Date.now() + REDIRECT_SECONDS * 1000;
    const updateCountdown = () => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) navigate('/', { replace: true });
    };
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [navigate]);

  const progress = useMemo(() => `${(remaining / REDIRECT_SECONDS) * 360}deg`, [remaining]);

  return (
    <main className="thank-you-page">
      <div className="thank-you-aurora" aria-hidden="true"><i /><i /><i /></div>

      <Link className="thank-you-brand" to="/" aria-label="BiteSites home">
        <img src={logoMark} alt="" width="500" height="500" />
        <span>BiteSites</span>
      </Link>

      <section className="thank-you-card" aria-labelledby="thank-you-title">
        <div className="thank-you-confirmation" aria-hidden="true"><span>✓</span></div>
        <p className="thank-you-eyebrow"><i />{confirmation.eyebrow}</p>
        <h1 id="thank-you-title">{confirmation.title}</h1>
        <p className="thank-you-message">{confirmation.message}</p>

        <div className="thank-you-divider" />

        <div className="thank-you-return">
          <div
            className="thank-you-timer"
            style={{ '--timer-progress': progress }}
            role="timer"
            aria-live="polite"
            aria-label={`Returning to the homepage in ${remaining} seconds`}
          >
            <div className="thank-you-timer-face">
              <strong>{remaining}</strong>
              <span>{remaining === 1 ? 'second' : 'seconds'}</span>
            </div>
          </div>

          <div className="thank-you-return-copy">
            <p>Taking you back home</p>
            <span>You’ll be redirected automatically when the timer reaches zero.</span>
            <Link className="thank-you-home-button" to="/">
              Go to homepage <b aria-hidden="true">→</b>
            </Link>
          </div>
        </div>
      </section>

      <p className="thank-you-footnote"><span>✓</span> Your information was sent securely.</p>
    </main>
  );
}
