import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { feedbackErrorMessage, loadConversationFeedback, submitConversationFeedback } from '../lib/feedback';
import logo from '../assets/bitesites-logo-full.webp';
import '../feedback.css';

export default function Feedback() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const suggested = Number(params.get('rating'));
  const [rating, setRating] = useState(Number.isInteger(suggested) && suggested >= 1 && suggested <= 5 ? suggested : 0);
  const [comment, setComment] = useState('');
  const [state, setState] = useState({ loading: true, agent: 'Bit', submitted: false, expired: false, error: '', fatal: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadConversationFeedback(token)
      .then(data => setState({ loading: false, error: '', ...data }))
      .catch(error => setState(current => ({ ...current, loading: false, fatal: true, error: feedbackErrorMessage(error, 'This feedback link is unavailable.') })));
  }, [token]);

  const submit = async event => {
    event.preventDefault();
    if (!rating || busy) return;
    setBusy(true);
    try {
      await submitConversationFeedback({ token, rating, comment });
      setState(current => ({ ...current, submitted: true, error: '' }));
    } catch (error) {
      setState(current => ({ ...current, error: feedbackErrorMessage(error, 'We could not save your feedback.') }));
    } finally {
      setBusy(false);
    }
  };

  return <main className="response-page">
    <section className="response-card">
      <Link to="/" className="response-logo" aria-label="BiteSites home"><img src={logo} alt="BiteSites" /></Link>
      {state.loading ? <p>Checking your feedback link…</p> : state.fatal ? <><h1>Feedback link unavailable</h1><p className="response-error">{state.error}</p></> : state.expired ? <><h1>This link has expired</h1><p>Thanks for wanting to help. Feedback links remain active for 30 days.</p></> : state.submitted ? <><h1>Thank you</h1><p>Your feedback is recorded and will help us make future conversations better.</p></> : <>
        <p className="response-kicker">Conversation feedback</p>
        <h1>How did {state.agent} do?</h1>
        <p>Rate the usefulness of your recent conversation. This is about the agent experience—not the work BiteSites may provide afterward.</p>
        <form onSubmit={submit}>
          <div className="response-ratings" role="radiogroup" aria-label="Conversation rating">
            {[1, 2, 3, 4, 5].map(value => <button key={value} type="button" className={rating === value ? 'selected' : ''} role="radio" aria-checked={rating === value} onClick={() => setRating(value)}><b>{value}</b><small>{value === 1 ? 'Not useful' : value === 5 ? 'Very useful' : ''}</small></button>)}
          </div>
          <label><span>Anything else we should know? <small>(optional)</small></span><textarea maxLength="2000" value={comment} onChange={event => setComment(event.target.value)} rows="5" /></label>
          <button className="response-submit" type="submit" disabled={!rating || busy}>{busy ? 'Sending…' : 'Submit feedback'}</button>
          {state.error && <p className="response-error" role="status">{state.error}</p>}
        </form>
      </>}
      <Link to="/" className="response-back">Back to BiteSites</Link>
    </section>
  </main>;
}
