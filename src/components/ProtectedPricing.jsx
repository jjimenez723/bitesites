import React, { useEffect, useRef, useState } from 'react';
import {
  fetchServicePricing,
  friendlyAuthError,
  resetPassword,
  resendConfirmation,
  signIn,
  signInWithGoogle,
  signOutUser,
  signUp,
  watchSession
} from '../lib/auth';
import { BitMascot } from './BitMascot';
import '../account-gate.css';

const tabs = [['web', 'Web Development'], ['social', 'Social Media'], ['ai', 'AI Automation']];

// Google's official four-color "G" mark. Keeping it inline avoids a third-party
// image request in the account flow while preserving the actual brand mark.
const GoogleMark = () => (
  <svg className="account-google-mark" viewBox="0 0 18 18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.65 3.58 9 3.58z" />
  </svg>
);

const EyeIcon = ({ hidden = false }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2.5 12s3.25-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.25 5.5-9.5 5.5S2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.4" />
    {hidden && <path d="m4 4 16 16" />}
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10.5 3.65 3.65L16 5.85" /></svg>
);

function AccountDialog({ onClose }) {
  const [view, setView] = useState('signup');
  const [signupStep, setSignupStep] = useState(1);
  const [signupDirection, setSignupDirection] = useState('forward');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ kind: '', text: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({ displayName: '', company: '', email: '', password: '', confirmPassword: '' });
  const formPanelRef = useRef(null);

  const isSignup = view === 'signup';

  const changeView = nextView => {
    setView(nextView);
    setSignupStep(1);
    setShowPassword(false);
    setStatus({ kind: '', text: '' });
  };

  const changeSignupStep = nextStep => {
    setSignupDirection(nextStep > signupStep ? 'forward' : 'back');
    setSignupStep(nextStep);
    setShowPassword(false);
  };

  const updateField = event => {
    const { name, value } = event.target;
    setForm(current => ({ ...current, [name]: value }));
  };

  useEffect(() => {
    const key = event => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    if (!isSignup) return undefined;
    const focusTimer = window.setTimeout(() => {
      formPanelRef.current?.querySelector('.account-stage-track fieldset:not([disabled]) input')?.focus();
    }, 500);
    return () => window.clearTimeout(focusTimer);
  }, [isSignup, signupStep]);

  const submit = async event => {
    event.preventDefault();
    if (isSignup && signupStep === 1) {
      changeSignupStep(2);
      return;
    }

    setBusy(true);
    setStatus({ kind: '', text: '' });
    try {
      if (isSignup) {
        if (form.password !== form.confirmPassword) {
          throw new Error('Those passwords do not match.');
        }
        await signUp({
          displayName: form.displayName,
          company: form.company,
          email: form.email,
          password: form.password
        });
        setStatus({ kind: 'success', text: 'Account created. Your prices are unlocking now, and a confirmation email is on its way.' });
        window.setTimeout(onClose, 900);
      } else if (view === 'login') {
        await signIn(form.email, form.password);
        onClose();
      } else {
        const result = await resetPassword(form.email);
        setStatus({ kind: 'success', text: result?.message || 'If that address has an account, a reset link is on its way.' });
      }
    } catch (error) {
      setStatus({ kind: 'error', text: error?.code ? friendlyAuthError(error) : error.message || 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    setStatus({ kind: '', text: '' });
    try {
      await signInWithGoogle();
      onClose();
    } catch (error) {
      setStatus({ kind: 'error', text: friendlyAuthError(error) });
      setBusy(false);
    }
  };

  return (
    <div className="account-modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-modal-title">
        <button className="account-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        <aside className="account-welcome" aria-hidden="true">
          <div className="account-brand"><span>&lt;</span> BiteSites <span>/&gt;</span></div>
          <div className={`account-mascot ${showPassword ? 'is-guarding' : ''}`}>
            <span className="account-orbit account-orbit-one" />
            <span className="account-orbit account-orbit-two" />
            <BitMascot eyesClosed={showPassword} />
          </div>
          <div className="account-welcome-copy">
            <p className="account-welcome-kicker">{showPassword ? 'Privacy mode on' : 'Your BiteSites guide'}</p>
            <h3>{showPassword ? 'Bit isn’t looking.' : isSignup ? 'A small step toward a better digital presence.' : 'Good to see you again.'}</h3>
            <p>{showPassword ? 'Your password stays between you and the secure sign-in form.' : 'Create an account to explore current packages and keep your project planning in one place.'}</p>
          </div>
          {isSignup && <ol className="account-steps">
            {['Tell us about you', 'Secure your account'].map((label, index) => {
              const number = index + 1;
              const state = number < signupStep ? 'complete' : number === signupStep ? 'active' : '';
              return <li className={state} key={label}><span>{number < signupStep ? <CheckIcon /> : number}</span>{label}</li>;
            })}
          </ol>}
        </aside>

        <div className="account-form-panel" ref={formPanelRef}>
          <div className={`account-panel-header account-panel-header--${signupDirection}`} key={`${view}-${signupStep}`}>
            <p className="account-modal-kicker">BiteSites member access</p>
            <h2 id="account-modal-title">
              {isSignup ? (signupStep === 1 ? 'Let’s get acquainted.' : 'Make it secure.') : view === 'login' ? 'Welcome back.' : 'Reset your password.'}
            </h2>
            <p className="account-modal-intro">
              {isSignup
                ? (signupStep === 1 ? 'A few details first — this takes less than a minute.' : 'Choose a password only you know. Bit will look away if you need to check it.')
                : view === 'login' ? 'Sign in to pick up where you left off.' : 'We’ll send a secure reset link to your inbox.'}
            </p>
          </div>

          {isSignup && <ol className="account-steps account-steps-mobile" aria-label={`Step ${signupStep} of 2`}>
            {['About you', 'Secure account'].map((label, index) => <li className={index + 1 <= signupStep ? 'active' : ''} key={label}><span>{index + 1}</span>{label}</li>)}
          </ol>}

          {view !== 'reset' && (
            <>
              <button className="account-google" type="button" disabled={busy} onClick={google}>
                <GoogleMark />
                Continue with Google
              </button>
              <div className="account-divider"><span>or continue with email</span></div>
            </>
          )}

          <form className="account-form" onSubmit={submit}>
            {isSignup && <div className={`account-stage-viewport is-step-${signupStep}`}>
              <div className="account-stage-track">
                <fieldset className="account-form-stage" disabled={signupStep !== 1} aria-hidden={signupStep !== 1}>
                  <label><span>Your name</span><input name="displayName" value={form.displayName} onChange={updateField} required autoComplete="name" autoFocus placeholder="Alex Morgan" /></label>
                  <label><span>Work email</span><input name="email" value={form.email} onChange={updateField} type="email" required autoComplete="email" placeholder="alex@company.com" /></label>
                  <label><span>Company <small>optional</small></span><input name="company" value={form.company} onChange={updateField} autoComplete="organization" placeholder="Your company" /></label>
                </fieldset>
                <fieldset className="account-form-stage" disabled={signupStep !== 2} aria-hidden={signupStep !== 2}>
                  <PasswordField value={form.password} onChange={updateField} show={showPassword} onToggle={() => setShowPassword(current => !current)} autoComplete="new-password" />
                  <PasswordField name="confirmPassword" label="Confirm password" value={form.confirmPassword} onChange={updateField} show={showPassword} onToggle={() => setShowPassword(current => !current)} autoComplete="new-password" />
                  <p className="account-password-note">Use at least 8 characters. Bit will close their eyes whenever you reveal it.</p>
                </fieldset>
              </div>
            </div>}

            {view === 'login' && <div className="account-form-stage" key="login">
              <label><span>Email address</span><input name="email" value={form.email} onChange={updateField} type="email" required autoComplete="email" autoFocus placeholder="you@company.com" /></label>
              <PasswordField value={form.password} onChange={updateField} show={showPassword} onToggle={() => setShowPassword(current => !current)} autoComplete="current-password" />
            </div>}

            {view === 'reset' && <div className="account-form-stage" key="reset">
              <label><span>Email address</span><input name="email" value={form.email} onChange={updateField} type="email" required autoComplete="email" autoFocus placeholder="you@company.com" /></label>
            </div>}

            <div className="account-actions">
              {isSignup && signupStep === 2 && <button className="account-back" type="button" onClick={() => changeSignupStep(1)}>Back</button>}
              <button className="account-submit" type="submit" disabled={busy}>
                {busy ? 'Please wait…' : isSignup ? (signupStep === 1 ? 'Continue' : 'Create my account') : view === 'login' ? 'Sign in to BiteSites' : 'Send reset link'}
                {!busy && view !== 'reset' && <span aria-hidden="true">→</span>}
              </button>
            </div>
            <p className={`account-status ${status.kind}`} aria-live="polite">{status.text}</p>
          </form>

          <div className="account-switch">
            {isSignup && <><span>Already have an account?</span><button type="button" onClick={() => changeView('login')}>Sign in</button></>}
            {view === 'login' && <><button type="button" onClick={() => changeView('reset')}>Forgot password?</button><i /><button type="button" onClick={() => changeView('signup')}>Create an account</button></>}
            {view === 'reset' && <button type="button" onClick={() => changeView('login')}>← Back to sign in</button>}
          </div>
          <p className="account-legal">By continuing, you agree to the BiteSites Terms and acknowledge the Privacy Policy.</p>
        </div>
      </section>
    </div>
  );
}

function PasswordField({ name = 'password', label = 'Password', value, onChange, show, onToggle, autoComplete, autoFocus = false }) {
  const id = `account-${name}`;
  return <label className="account-password-field" htmlFor={id}>
    <span>{label}</span>
    <span className="account-input-wrap">
      <input id={id} name={name} value={value} onChange={onChange} type={show ? 'text' : 'password'} minLength="8" required autoComplete={autoComplete} autoFocus={autoFocus} placeholder="••••••••" />
      <button type="button" onClick={onToggle} aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} aria-pressed={show}>
        <EyeIcon hidden={show} />
        <span>{show ? 'Hide' : 'Show'}</span>
      </button>
    </span>
  </label>;
}

function LockedPricing({ onBegin }) {
  return (
    <div className="pricing-locked">
      <div className="pricing-locked-ghost" aria-hidden="true">
        {[0, 1, 2].map(index => <i key={index}><b /><span /><span /><span /></i>)}
      </div>
      <div className="pricing-locked-card">
        <span className="pricing-lock-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
        </span>
        <p>Member pricing</p>
        <h3>Unlock every service package.</h3>
        <span>Create a free BiteSites account or sign in to see current project pricing, package details, and recommended starting points.</span>
        <button type="button" className="btn btn-ai" onClick={onBegin}>Sign up or log in <b>→</b></button>
        <small>Free account · Takes less than a minute</small>
      </div>
    </div>
  );
}

export default function ProtectedPricing({ tab, setTab }) {
  const [session, setSession] = useState({ loading: true, user: null });
  const [pricing, setPricing] = useState(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [resendingConfirmation, setResendingConfirmation] = useState(false);

  useEffect(() => watchSession(next => setSession(next)), []);

  useEffect(() => {
    if (!session.user) {
      setPricing(null);
      return;
    }
    let active = true;
    setError('');
    fetchServicePricing()
      .then(data => active && setPricing(data))
      .catch(err => active && setError(err?.message || 'Pricing could not be loaded.'));
    return () => { active = false; };
  }, [session.user]);

  if (session.loading) return <div className="pricing-gate-loading" aria-label="Checking account access"><i /><i /><i /></div>;
  if (!session.user) return <><LockedPricing onBegin={() => setDialog(true)} />{dialog && <AccountDialog onClose={() => setDialog(false)} />}</>;

  const resend = async () => {
    if (resendingConfirmation) return;
    setResendingConfirmation(true);
    setConfirmation('Sending…');
    try {
      const result = await resendConfirmation();
      setConfirmation(result.alreadyVerified ? 'Email already confirmed' : 'Confirmation email sent — check your inbox or spam folder');
    } catch (err) {
      setConfirmation(err?.message || 'Could not send confirmation');
    } finally {
      setResendingConfirmation(false);
    }
  };

  return (
    <>
      <div className="pricing-memberbar">
        <span><i /> Pricing unlocked for <strong>{session.user.email}</strong></span>
        <div>{!session.user.emailVerified && <button type="button" onClick={resend} disabled={resendingConfirmation}>{confirmation || 'Resend confirmation'}</button>}<button type="button" onClick={signOutUser}>Sign out</button></div>
      </div>
      <div className="tabbar" role="tablist" aria-label="Pricing services">
        {tabs.map(([key, label]) => <button className={`tabbtn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} key={key} type="button" role="tab" aria-selected={tab === key} aria-controls="pricing-options">{label}</button>)}
      </div>
      {error && <div className="pricing-gate-error">{error} <button type="button" onClick={() => window.location.reload()}>Try again</button></div>}
      {!pricing && !error && <div className="pricing-gate-loading"><i /><i /><i /></div>}
      {pricing && <div className="price-grid" id="pricing-options" role="tabpanel" aria-live="polite" aria-label={`${tab === 'web' ? 'Web Development' : tab === 'social' ? 'Social Media' : 'AI Automation'} packages`}>
        {pricing[tab].map(([title, desc, price, items, popular], index) => <article className={`price-card pricing-card-enter ${popular ? 'popular' : ''}`} style={{ animationDelay: `${index * 70}ms` }} key={title}>{popular && <span className="badge">Most Popular</span>}<h4>{title}</h4><p className="plandesc">{desc}</p><div className="price">{price}</div><div className="pricenote">{tab === 'social' ? 'monthly engagement' : 'project scope'}</div><ul>{items.map(item => <li key={item}>{item}</li>)}</ul><a className={`btn ${popular ? 'btn-ai' : 'btn-ghost'}`} href="#start">Grow My Business</a></article>)}
      </div>}
      {pricing && <p className="pricing-note">Every package is a starting point. We’ll shape the scope around your goals, timeline, and current tools.</p>}
    </>
  );
}
