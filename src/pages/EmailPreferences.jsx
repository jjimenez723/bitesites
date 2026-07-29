import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { feedbackErrorMessage, loadEmailPreferences, saveEmailPreferences } from '../lib/feedback';
import logo from '../assets/bitesites-logo-full.webp';
import '../feedback.css';

export default function EmailPreferences() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState({ loading: true, email: '', broadcasts: true, feedback: true, error: '', saved: false, fatal: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadEmailPreferences(token)
      .then(data => setState({ loading: false, error: '', saved: false, ...data }))
      .catch(error => setState(current => ({ ...current, loading: false, fatal: true, error: feedbackErrorMessage(error, 'This preference link is unavailable.') })));
  }, [token]);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await saveEmailPreferences({ token, broadcasts: state.broadcasts, feedback: state.feedback });
      setState(current => ({ ...current, ...data, saved: true, error: '' }));
    } catch (error) {
      setState(current => ({ ...current, error: feedbackErrorMessage(error, 'We could not update your preferences.') }));
    } finally {
      setBusy(false);
    }
  };

  return <main className="response-page">
    <section className="response-card">
      <Link to="/" className="response-logo" aria-label="BiteSites home"><img src={logo} alt="BiteSites" /></Link>
      {state.loading ? <p>Loading your email preferences…</p> : state.fatal ? <><h1>Preference link unavailable</h1><p className="response-error">{state.error}</p></> : <>
        <p className="response-kicker">Email preferences</p>
        <h1>Choose what reaches you</h1>
        <p>Preferences for <strong>{state.email}</strong>. Account security, password, and requested service messages may still be sent when needed.</p>
        <form className="preference-form" onSubmit={submit}>
          <label className="preference-choice"><input type="checkbox" checked={state.broadcasts} onChange={event => setState(current => ({ ...current, broadcasts: event.target.checked, saved: false }))} /><span><strong>BiteSites announcements</strong><small>Product news, launches, and useful studio updates.</small></span></label>
          <label className="preference-choice"><input type="checkbox" checked={state.feedback} onChange={event => setState(current => ({ ...current, feedback: event.target.checked, saved: false }))} /><span><strong>Conversation feedback</strong><small>Occasional requests to rate a recent conversation with Bit or Byte.</small></span></label>
          <button className="response-submit" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save preferences'}</button>
          {state.saved && <p className="response-success" role="status">Your preferences are saved.</p>}
          {state.error && <p className="response-error" role="status">{state.error}</p>}
        </form>
      </>}
      <Link to="/" className="response-back">Back to BiteSites</Link>
    </section>
  </main>;
}
