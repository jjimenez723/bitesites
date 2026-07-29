import { useState } from 'react';
import { feedbackErrorMessage, submitConversationFeedback } from '../lib/feedback';

export default function ConversationRating({ agent, sourceType, sourceId, compact = false }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState({ kind: '', text: '' });
  const [busy, setBusy] = useState(false);

  if (!sourceId) return null;

  const submit = async event => {
    event.preventDefault();
    if (!rating || busy) return;
    setBusy(true);
    setStatus({ kind: '', text: '' });
    try {
      const result = await submitConversationFeedback({
        rating, comment, agent, sourceType, sourceId
      });
      setStatus({
        kind: 'success',
        text: result.alreadySubmitted ? 'Your feedback was already recorded. Thank you.' : 'Thanks — your feedback helps us improve.'
      });
    } catch (error) {
      setStatus({ kind: 'error', text: feedbackErrorMessage(error, 'We could not save your feedback. Please try again.') });
    } finally {
      setBusy(false);
    }
  };

  if (status.kind === 'success') {
    return <p className={`conversation-rating-thanks${compact ? ' compact' : ''}`} role="status">{status.text}</p>;
  }

  return <form className={`conversation-rating${compact ? ' compact' : ''}`} onSubmit={submit}>
    <strong>How did {agent === 'byte' ? 'Byte' : 'Bit'} do?</strong>
    <span>Rate this conversation</span>
    <div className="conversation-rating-buttons" role="radiogroup" aria-label="Conversation rating">
      {[1, 2, 3, 4, 5].map(value => <button
        key={value}
        type="button"
        className={rating === value ? 'selected' : ''}
        role="radio"
        aria-checked={rating === value}
        aria-label={`${value} out of 5`}
        onClick={() => setRating(value)}
      >{value}</button>)}
    </div>
    {rating > 0 && <textarea
      value={comment}
      maxLength="2000"
      onChange={event => setComment(event.target.value)}
      placeholder="Anything else you’d like us to know? (optional)"
      aria-label="Optional feedback comment"
    />}
    <button className="conversation-rating-submit" type="submit" disabled={!rating || busy}>
      {busy ? 'Sending…' : 'Send feedback'}
    </button>
    {status.text && <p className={status.kind} role="status">{status.text}</p>}
  </form>;
}
