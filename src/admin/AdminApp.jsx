// Admin console root.
//
// Loaded lazily from main.jsx so none of this — Firebase Auth, the console
// stylesheet, the charts — reaches a visitor to the marketing site.
//
// The gate below is convenience, not security. Every collection the console
// reads is admin-only in firestore.rules, so a non-admin who forced their way
// past this screen would still get permission-denied on every query.

import React, { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import {
  watchSession, signIn, signInWithGoogle, completeRedirectSignIn,
  signOutUser, resetPassword, friendlyAuthError
} from '../lib/auth';
import logoMark from '../assets/bitesites-logo-mark.webp';
import Overview from './Overview';
import Leads from './Leads';
import Conversations from './Conversations';
import Users from './Users';
import './admin.css';

const Icon = ({ d }) => (
  <svg className="admin-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const NAV = [
  { to: '/admin', end: true, label: 'Overview', icon: 'M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z' },
  { to: '/admin/leads', label: 'Leads', icon: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
  { to: '/admin/conversations', label: 'Conversations', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { to: '/admin/users', label: 'Users', icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }
];

// The official mark, inlined. An <img> to a Google CDN would be a third-party
// request on the login screen and the one asset whose failure to load is most
// likely to make the button look broken.
const GoogleMark = () => (
  <svg className="admin-google-mark" viewBox="0 0 18 18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.65 3.58 9 3.58z" />
  </svg>
);

function SignIn() {
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [busy, setBusy] = useState(false);

  // Only fires on the redirect fallback. A failure there would otherwise drop
  // the user back here with no idea why nothing happened.
  useEffect(() => {
    completeRedirectSignIn().catch(error =>
      setStatus({ text: friendlyAuthError(error), kind: 'error' }));
  }, []);

  const submit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setStatus({ text: '', kind: '' });
    try {
      await signIn(form.get('email'), form.get('password'));
      // watchSession takes over from here and swaps this screen out.
    } catch (error) {
      setStatus({ text: friendlyAuthError(error), kind: 'error' });
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    setStatus({ text: '', kind: '' });
    try {
      await signInWithGoogle();
      // Popup: watchSession swaps this screen out. Redirect: we never get here.
    } catch (error) {
      setStatus({ text: friendlyAuthError(error), kind: 'error' });
      setBusy(false);
    }
  };

  const forgot = event => {
    const email = event.currentTarget.form?.email?.value;
    if (!email) return setStatus({ text: 'Enter your email first, then choose reset.', kind: 'error' });
    resetPassword(email)
      .then(() => setStatus({ text: 'Password reset sent. Check your inbox.', kind: 'success' }))
      .catch(error => setStatus({ text: friendlyAuthError(error), kind: 'error' }));
  };

  return (
    <div className="bs-admin">
      <div className="admin-auth">
        <div className="admin-auth-card">
          <img src={logoMark} alt="" />
          <h1>Console</h1>
          <p>Sign in to see leads, conversations and site activity.</p>

          <button className="admin-google-btn" type="button" onClick={google} disabled={busy}>
            <GoogleMark />
            Continue with Google
          </button>
          <div className="admin-auth-or"><span>or</span></div>

          <form onSubmit={submit}>
            <label className="admin-field">
              <span>Email</span>
              <input name="email" type="email" required autoComplete="email" autoFocus />
            </label>
            <label className="admin-field">
              <span>Password</span>
              <input name="password" type="password" required autoComplete="current-password" />
            </label>
            <button className="admin-auth-submit" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button className="admin-auth-link" type="button" onClick={forgot}>
              Forgot your password?
            </button>
            <p className={`admin-auth-msg ${status.kind}`} aria-live="polite">{status.text}</p>
          </form>
          <Link className="admin-auth-back" to="/">← Back to homepage</Link>
        </div>
      </div>
    </div>
  );
}

function Denied({ email }) {
  return (
    <div className="bs-admin">
      <div className="admin-auth">
        <div className="admin-auth-card admin-denied">
          <h1>No access yet</h1>
          <p>
            <strong>{email}</strong> is signed in but has not been granted a role.
            Roles are stored server-side and cannot be assigned from this screen —
            that is what stops anyone promoting themselves.
          </p>
          <p className="admin-note">
            An existing admin can grant access from the Users tab, or from a terminal:
          </p>
          <div className="chip" style={{ display: 'block', margin: '10px 0 20px', overflowX: 'auto' }}>
            npm run role -- {email} admin
          </div>
          <button className="btn-admin" type="button" onClick={signOutUser}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

export default function AdminApp() {
  const [session, setSession] = useState({ user: null, role: '', profile: null, loading: true });

  useEffect(() => watchSession(setSession), []);

  if (session.loading) return <div className="admin-boot">Checking your session…</div>;
  if (!session.user) return <SignIn />;
  if (session.role !== 'admin') return <Denied email={session.user.email} />;

  const email = session.user.email || '';
  const name = session.profile?.displayName || session.user.displayName || email.split('@')[0];
  const initials = name.slice(0, 2).toUpperCase();

  return (
    <div className="bs-admin">
      <div className="admin-shell">
        <aside className="admin-sidebar">
          <div className="admin-brand">
            <img src={logoMark} alt="" />
            <div>
              <strong>BiteSites</strong>
              <span>Console</span>
            </div>
          </div>

          <nav className="admin-nav">
            <div className="admin-nav-label">Workspace</div>
            {NAV.map(item => (
              <NavLink key={item.label} to={item.to} end={item.end}>
                <Icon d={item.icon} />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="admin-sidebar-foot">
            <div className="admin-account">
              <div className="admin-avatar">{initials}</div>
              <div className="admin-account-id">
                <strong>{name}</strong>
                <span title={email}>{email}</span>
              </div>
            </div>
            <button className="btn-admin" type="button" onClick={signOutUser} style={{ width: '100%' }}>
              Sign out
            </button>
          </div>
        </aside>

        <div className="admin-main">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="leads" element={<Leads />} />
            <Route path="conversations" element={<Conversations />} />
            <Route path="users" element={<Users />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
