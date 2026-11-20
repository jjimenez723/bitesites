// Read-aloud for rep lessons, using the device's own voice (Web Speech API).
// Free, works offline once loaded, and always says exactly what is on screen.
//
// A lesson is spoken one line at a time. That lets the screen highlight the
// line being read, and it avoids two browser problems with long speech:
// Chrome cuts off utterances after about 15 seconds, and pause/resume is
// unreliable on Android. Pause here is "stop and remember the line".

/** The lines a lesson is read as, in the same order the screen shows them. */
export function lessonLines(lesson, { number, total } = {}) {
  if (!lesson) return [];
  const lines = [];
  lines.push({ id: 'title', text: `${number && total ? `Lesson ${number} of ${total}. ` : ''}${lesson.title}.` });
  if (lesson.summary) lines.push({ id: 'summary', text: lesson.summary });
  (lesson.priceGroups || []).forEach((group, groupIndex) => {
    lines.push({ id: `price:${groupIndex}`, text: `${group.label}: ${group.lines.join('. ')}.` });
  });
  (lesson.points || []).forEach((point, index) => lines.push({ id: `point:${index}`, text: point }));
  if (lesson.say?.length) {
    lines.push({ id: 'say-label', text: 'What to say.' });
    lesson.say.forEach((line, index) => lines.push({ id: `say:${index}`, text: line }));
  }
  return lines.map(line => ({ ...line, spoken: forSpeech(line.text) }));
}

/** Small fixes so prices and shorthand are read the way a person would say them. */
export function forSpeech(text) {
  return String(text || '')
    .replace(/\/mo\b/g, ' a month')
    .replace(/\/yr\b/g, ' a year')
    .replace(/\s*\+\s*/g, ' plus ')
    .replace(/\be\.g\.\s*/gi, 'for example, ')
    .replace(/\s*→\s*/g, ', then ')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export const speechSupported = () =>
  typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

// Prefer a natural-sounding English voice when the device has one.
const PREFERRED = [/natural/i, /google us english/i, /samantha/i, /aria/i, /jenny/i, /karen/i, /daniel/i];
export function pickVoice(voices = []) {
  const english = voices.filter(voice => /^en(-|_|$)/i.test(voice.lang));
  for (const pattern of PREFERRED) {
    const match = english.find(voice => pattern.test(voice.name));
    if (match) return match;
  }
  return english.find(voice => /^en-US/i.test(voice.lang)) || english[0] || null;
}
