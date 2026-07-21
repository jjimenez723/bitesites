// Conversation logging for Bit (chat) and Byte (voice).
//
// Bit is ours, so we hold the whole transcript: every prompt, every quick reply,
// every free-text answer, in order, tied to the lead it produced.
//
// Byte runs on the GoHighLevel/Retell widget, which owns the audio and the
// authoritative transcript. What we can record first-party is the *session* —
// when it started, how the call progressed, how long it lasted, how it ended —
// plus whatever transcript text the widget renders into its own DOM. Anything
// missing is filled in by the `recordVoiceCall` webhook in functions/, which GHL
// posts the finished call summary to.
//
// Every write is best-effort: a logging failure must never break the visitor's
// conversation, so nothing here throws.

import {
  addDoc, collection, doc, serverTimestamp, setDoc, updateDoc
} from 'firebase/firestore';
import { db } from './firebase';
import { sessionId } from './analytics';

const clean = (value, maxLen) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

const context = () => ({
  sid: sessionId(),
  path: clean(window.location?.pathname, 300) || '/',
  referrer: clean(document?.referrer, 400),
  userAgent: clean(navigator?.userAgent, 400)
});

const quiet = (label, promise) =>
  promise.catch(error => { console.warn(`[conversations] ${label} failed`, error); return null; });

// --------------------------------------------------------------- Bit (chat)

/** Opens a transcript document. Returns its id, or '' if logging is unavailable. */
export async function startChat() {
  const reference = await quiet('startChat', addDoc(collection(db, 'chats'), {
    agent: 'bit',
    channel: 'chat',
    status: 'open',
    messageCount: 0,
    startedAt: serverTimestamp(),
    ...context()
  }));
  return reference?.id || '';
}

/**
 * Appends one turn. `role` is 'bit' | 'visitor'.
 * `kind` separates a tapped quick-reply from something they typed themselves,
 * which is the difference between a menu choice and a real answer.
 */
export function logChatMessage(chatId, { role, text, kind = 'text', questionKey = '' }) {
  if (!chatId) return Promise.resolve(null);

  const message = {
    role: role === 'visitor' ? 'visitor' : 'bit',
    kind: ['text', 'choice', 'prompt', 'system'].includes(kind) ? kind : 'text',
    text: clean(text, 2000),
    at: serverTimestamp()
  };
  if (questionKey) message.questionKey = clean(questionKey, 60);

  return quiet('logChatMessage', addDoc(collection(db, 'chats', chatId, 'messages'), message));
}

/** Closes the transcript out with how it ended and what it produced. */
export function finishChat(chatId, { outcome, leadId = '', answers = null, messageCount = 0 }) {
  if (!chatId) return Promise.resolve(null);

  const update = {
    status: ['converted', 'abandoned', 'failed'].includes(outcome) ? outcome : 'abandoned',
    endedAt: serverTimestamp(),
    messageCount
  };
  if (leadId) update.leadId = clean(leadId, 60);
  // The structured answers are what makes a transcript scannable at a glance —
  // the dashboard shows these as chips above the message list.
  if (answers) {
    update.answers = Object.fromEntries(
      Object.entries(answers)
        .filter(([, value]) => typeof value === 'string' && value)
        .slice(0, 8)
        .map(([key, value]) => [clean(key, 40), clean(value, 500)])
    );
  }

  return quiet('finishChat', updateDoc(doc(db, 'chats', chatId), update));
}

// -------------------------------------------------------------- Byte (voice)

/** Opens a call record when the visitor asks Byte to start talking. */
export async function startCall() {
  const reference = await quiet('startCall', addDoc(collection(db, 'calls'), {
    agent: 'byte',
    channel: 'voice',
    status: 'open',
    provider: 'gohighlevel',
    startedAt: serverTimestamp(),
    ...context()
  }));
  return reference?.id || '';
}

/**
 * Records a state transition — connecting, listening, speaking, ended. Together
 * these give the dashboard a timeline of the call without any audio.
 */
export function logCallState(callId, state) {
  if (!callId) return Promise.resolve(null);
  return quiet('logCallState', addDoc(collection(db, 'calls', callId, 'turns'), {
    kind: 'state',
    state: clean(state, 40),
    at: serverTimestamp()
  }));
}

/** Records a line of transcript scraped from the widget, if it renders one. */
export function logCallTranscript(callId, { role, text }) {
  if (!callId || !text) return Promise.resolve(null);
  return quiet('logCallTranscript', addDoc(collection(db, 'calls', callId, 'turns'), {
    kind: 'transcript',
    role: role === 'visitor' ? 'visitor' : 'byte',
    text: clean(text, 2000),
    at: serverTimestamp()
  }));
}

/** Closes the call out. `outcome` explains why it ended. */
export function finishCall(callId, { outcome, durationSec = 0, error = '' }) {
  if (!callId) return Promise.resolve(null);

  const update = {
    status: ['completed', 'abandoned', 'failed', 'blocked'].includes(outcome) ? outcome : 'abandoned',
    endedAt: serverTimestamp(),
    durationSec: Math.max(0, Math.round(durationSec))
  };
  if (error) update.error = clean(error, 300);

  return quiet('finishCall', setDoc(doc(db, 'calls', callId), update, { merge: true }));
}
