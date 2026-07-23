import React, { useEffect, useState } from 'react';
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
import logoMark from '../assets/bitesites-logo-mark.webp';
import '../account-gate.css';

const tabs = [['web', 'Web Development'], ['social', 'Social Media'], ['ai', 'AI Automation']];

function AccountDialog({ onClose }) {
  const [view, setView] = useState('signup');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ kind: '', text: '' });

  useEffect(() => {
    const key = event => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const submit = async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setStatus({ kind: '', text: '' });
    try {
      if (view === 'signup') {
        if (data.get('password') !== data.get('confirmPassword')) {
          throw new Error('Those passwords do not match.');
        }
        await signUp({
          displayName: data.get('displayName'),
          company: data.get('company'),
          email: data.get('email'),
          password: data.get('password')
        });
        setStatus({ kind: 'success', text: 'Account created. Your prices are unlocking now, and a confirmation email is on its way.' });
        window.setTimeout(onClose, 900);
      } else if (view === 'login') {
        await signIn(data.get('email'), data.get('password'));
        onClose();
      } else {
        const result = await resetPassword(data.get('email'));
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
        <span className="account-modal-logo" aria-hidden="true"><img src={logoMark} alt="" /></span>
        <p className="account-modal-kicker">BiteSites member access</p>
        <h2 id="account-modal-title">
          {view === 'signup' ? 'Create your account.' : view === 'login' ? 'Welcome back.' : 'Reset your password.'}
        </h2>
        <p className="account-modal-intro">
          {view === 'signup'
            ? 'Join free to unlock current service pricing and keep your project planning in one place.'
            : view === 'login'
              ? 'Sign in to reveal current pricing.'
              : 'We’ll send a secure reset link through Postmark.'}
        </p>

        {view !== 'reset' && (
          <>
            <button className="account-google" type="button" disabled={busy} onClick={google}>
              <span aria-hidden="true">G</span> Continue with Google
            </button>
            <div className="account-divider"><span>or use email</span></div>
          </>
        )}

        <form className="account-form" onSubmit={submit}>
          {view === 'signup' && (
            <div className="account-field-row">
              <label><span>Your name</span><input name="displayName" required autoComplete="name" /></label>
              <label><span>Company <small>optional</small></span><input name="company" autoComplete="organization" /></label>
            </div>
          )}
          <label><span>Email address</span><input name="email" type="email" required autoComplete="email" autoFocus /></label>
          {view !== 'reset' && <label><span>Password</span><input name="password" type="password" minLength="8" required autoComplete={view === 'signup' ? 'new-password' : 'current-password'} /></label>}
          {view === 'signup' && <label><span>Confirm password</span><input name="confirmPassword" type="password" minLength="8" required autoComplete="new-password" /></label>}
          <button className="account-submit" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : view === 'signup' ? 'Create account & reveal pricing' : view === 'login' ? 'Sign in & reveal pricing' : 'Send secure reset link'}
          </button>
          <p className={`account-status ${status.kind}`} aria-live="polite">{status.text}</p>
        </form>

        <div className="account-switch">
          {view === 'signup' && <><span>Already a member?</span><button type="button" onClick={() => { setView('login'); setStatus({ kind: '', text: '' }); }}>Sign in</button></>}
          {view === 'login' && <><button type="button" onClick={() => { setView('reset'); setStatus({ kind: '', text: '' }); }}>Forgot password?</button><i /><button type="button" onClick={() => { setView('signup'); setStatus({ kind: '', text: '' }); }}>Create account</button></>}
          {view === 'reset' && <button type="button" onClick={() => { setView('login'); setStatus({ kind: '', text: '' }); }}>← Back to sign in</button>}
        </div>
        <p className="account-legal">By continuing, you agree to the BiteSites Terms and acknowledge the Privacy Policy.</p>
      </section>
    </div>
  );
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
    setConfirmation('Sending…');
    try {
      const result = await resendConfirmation();
      setConfirmation(result.alreadyVerified ? 'Email already confirmed' : 'Confirmation sent');
    } catch (err) {
      setConfirmation(err?.message || 'Could not send confirmation');
    }
  };

  return (
    <>
      <div className="pricing-memberbar">
        <span><i /> Pricing unlocked for <strong>{session.user.email}</strong></span>
        <div>{!session.user.emailVerified && <button type="button" onClick={resend}>{confirmation || 'Resend confirmation'}</button>}<button type="button" onClick={signOutUser}>Sign out</button></div>
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
