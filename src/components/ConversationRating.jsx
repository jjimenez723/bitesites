import { useState } from 'react';
import { feedbackErrorMessage, submitConversationFeedback } from '../lib/feedback';
import '../conversation-rating.css';

/**
 * The 1–5 rating card shown after a conversation with Bit or Byte.
 *
 * Variants: the default light card (inline after Bit's chat), `compact` (the
 * old dark inline strip), and `panel` — the full post-call screen inside the
 * voice agent shell. `onDone(submitted)` fires once feedback is recorded so
 * the host can advance its flow; it is never called on error.
 */
export default function ConversationRating({ agent, sourceType, sourceId, compact = false, variant = '', onDone = null }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState({ kind: '', text: '' });
  const [busy, setBusy] = useState(false);

  if (!sourceId) return null;
  const variantClass = `${compact ? ' compact' : ''}${variant === 'panel' ? ' panel' : ''}`;

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
      if (onDone) setTimeout(() => onDone(true), 1400);
    } catch (error) {
      setStatus({ kind: 'error', text: feedbackErrorMessage(error, 'We could not save your feedback. Please try again.') });
    } finally {
      setBusy(false);
    }
  };

  if (status.kind === 'success') {
    return <p className={`conversation-rating-thanks${variantClass}`} role="status">{status.text}</p>;
  }

  return <form className={`conversation-rating${variantClass}`} onSubmit={submit}>
    <strong>How did {agent === 'byte' ? 'Byte' : 'Bit'} do?</strong>
    <span>1 is rough, 5 is brilliant</span>
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
    {rating > 0 && <div className="conversation-rating-note">
      <textarea
        value={comment}
        maxLength="2000"
        rows="3"
        onChange={event => setComment(event.target.value)}
        placeholder="Tell us more — what worked, what didn’t? (optional)"
        aria-label="Optional feedback comment"
        autoFocus={variant === 'panel'}
      />
      {comment.length > 0 && <small aria-hidden="true">{comment.length}/2000</small>}
    </div>}
    <button className="conversation-rating-submit" type="submit" disabled={!rating || busy}>
      {busy ? 'Sending…' : 'Send feedback'}
    </button>
    {status.text && <p className={status.kind} role="status">{status.text}</p>}
  </form>;
}
