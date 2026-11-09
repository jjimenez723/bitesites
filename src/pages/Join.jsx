import React, { useEffect, useState } from 'react';
import { MarketingShell } from './ServicePage';
import { friendlyAuthError, signIn, signInWithGoogle, signUp, watchSession } from '../lib/auth';
import '../join.css';

const STAFF_ROLES = ['admin', 'outbound_rep', 'outbound_manager'];
const steps = [
  ['Create your account', 'It takes a minute. We’ll turn on your access right after.'],
  ['Learn the basics', 'Short lessons on who we are, what to say, and our pricing.'],
  ['Practice with AI', 'Talk to AI business owners until a real call feels easy.'],
  ['Start calling', 'Pass your practice and you’re ready for the live dialer.']
];

/** The link we send new sales reps: a warm welcome, then their account. */
export default function Join() {
  const [session, setSession] = useState({ user: null, role: '', loading: true });
  const [mode, setMode] = useState('signup');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => watchSession(setSession), []);

  const update = field => event => setForm(current => ({ ...current, [field]: event.target.value }));
  const run = async action => {
    setBusy(true);
    setProblem('');
    try {
      await action();
    } catch (error) {
      setProblem(friendlyAuthError(error));
    } finally {
      setBusy(false);
    }
  };
  const submit = event => {
    event.preventDefault();
    run(() => (mode === 'signup'
      ? signUp({ email: form.email, password: form.password, displayName: form.name })
      : signIn(form.email, form.password)));
  };

  const firstName = (session.user?.displayName || form.name).trim().split(/\s+/)[0];
  const approved = STAFF_ROLES.includes(session.role);

  return <MarketingShell><main className="wrap join-page">
    <p className="eyebrow gradient">Welcome to the team</p>
    <h1>{firstName ? `We’re so glad you’re here, ${firstName}.` : 'We’re so glad you’re here.'}</h1>
    <p className="lead">Thank you for joining BiteSites. We help local businesses stop losing customers they already earned, and you’re about to be a big part of that.</p>
    <p>We’ll train you step by step, so by your first real call you’ll know exactly what to do and what to say.</p>

    <ol className="join-steps">
      {steps.map(([title, text], index) => <li key={title}><span aria-hidden="true">{index + 1}</span><div><strong>{title}</strong><p>{text}</p></div></li>)}
    </ol>

    <section className="join-card" aria-live="polite">
      {session.loading ? <p role="status">One moment…</p>
        : session.user && approved ? <>
          <h2>You’re all set.</h2>
          <p>Your training is ready whenever you are.</p>
          <a className="btn btn-ai" href="/admin/outbound?tab=training">Start your training</a>
        </>
        : session.user ? <>
          <h2>You’re on the list.</h2>
          <p>We’ll turn on your access and email you at {session.user.email}. Then come back to this link to start your training.</p>
        </>
        : <>
          <h2>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
          <button className="btn btn-ghost join-google" type="button" disabled={busy} onClick={() => run(signInWithGoogle)}>Continue with Google</button>
          <form onSubmit={submit}>
            {mode === 'signup' && <label>Your name<input value={form.name} onChange={update('name')} autoComplete="name" required maxLength={120} /></label>}
            <label>Email<input type="email" value={form.email} onChange={update('email')} autoComplete="email" required maxLength={200} /></label>
            <label>Password<input type="password" value={form.password} onChange={update('password')} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 8 : undefined} /></label>
            {problem && <p className="join-error" role="alert">{problem}</p>}
            <button className="btn btn-ai" type="submit" disabled={busy}>{busy ? 'One moment…' : mode === 'signup' ? 'Create my account' : 'Sign in'}</button>
          </form>
          <button className="join-switch" type="button" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setProblem(''); }}>
            {mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </button>
        </>}
    </section>
  </main></MarketingShell>;
}
