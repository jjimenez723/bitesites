import React, { useEffect, useState } from 'react';
import { outbound } from './data';
import LessonAudio from './LessonAudio';
import { lessonLines } from './lesson-audio';

/** Welcome, lessons, then a short quiz. The server grades it and unlocks practice. */
export default function RepCourse({ accountId, accountName, onPassed }) {
  const [course, setCourse] = useState(null);
  const [problem, setProblem] = useState('');
  const [step, setStep] = useState(-1);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // The line being read aloud, so the lesson can highlight it.
  const [reading, setReading] = useState('');
  // Keep the line being read on screen, so a phone follows along by itself.
  useEffect(() => {
    if (!reading) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.querySelector('.rep-course .is-reading')?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [reading]);

  useEffect(() => {
    let active = true;
    setCourse(null);
    setProblem('');
    outbound.repCourse(accountId)
      .then(data => { if (active) setCourse(data.course); })
      .catch(failure => { if (active) setProblem(failure?.message || 'Could not load your lessons.'); });
    return () => { active = false; };
  }, [accountId]);

  if (problem && !course) return <p className="admin-error" role="alert">{problem}</p>;
  if (!course) return <p role="status">Loading your lessons…</p>;

  const lessons = course.lessons;
  const onQuiz = step >= lessons.length;
  const lesson = lessons[step];
  const answered = course.quiz.every(item => answers[item.id] !== undefined);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setProblem('');
    try {
      const graded = await outbound.submitRepCourseQuiz(accountId, answers);
      setResult(graded);
      if (graded.passed) await onPassed();
    } catch (failure) {
      setProblem(failure?.message || 'Could not submit your quiz. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (step < 0) return <section className="rep-course" aria-label="Welcome">
    <span className="outbound-eyebrow">Welcome</span>
    <h3>We’re really glad you’re here.</h3>
    <p>Thank you for joining {accountName}. This short course gets you ready to talk to real business owners with confidence.</p>
    <ol className="rep-course-steps">
      <li><strong>Learn.</strong> {lessons.length} quick lessons, including what to say and our pricing.</li>
      <li><strong>Quiz.</strong> {course.quiz.length} simple questions. You need {course.passMark} right, and you can retake it.</li>
      <li><strong>Practice.</strong> Talk to AI business owners. Some will say yes, some will say no.</li>
      <li><strong>Go live.</strong> Pass your practice calls and you’re ready for the dialer.</li>
    </ol>
    <button className="btn-admin primary" type="button" onClick={() => setStep(0)}>Start lesson 1</button>
  </section>;

  const read = id => (reading === id ? 'is-reading' : undefined);

  if (!onQuiz) return <section className="rep-course" aria-label={lesson.title}>
    <div className="rep-course-head">
      <div className={read('title')}>
        <span className="outbound-eyebrow">Lesson {step + 1} of {lessons.length}</span>
        <h3>{lesson.title}</h3>
      </div>
      <LessonAudio lines={lessonLines(lesson, { number: step + 1, total: lessons.length })} onLine={setReading} />
    </div>
    <p className={['rep-course-summary', read('summary')].filter(Boolean).join(' ')}>{lesson.summary}</p>
    {lesson.priceGroups && <div className="rep-course-prices">
      {lesson.priceGroups.map((group, groupIndex) => <div key={group.label} className={read(`price:${groupIndex}`)}>
        <strong>{group.label}</strong>
        <ul>{group.lines.map(line => <li key={line}>{line}</li>)}</ul>
      </div>)}
    </div>}
    <ul className="rep-course-points">{lesson.points.map((point, index) => <li key={point} className={read(`point:${index}`)}>{point}</li>)}</ul>
    {lesson.say && <div className="rep-course-say">
      <strong className={read('say-label')}>What to say</strong>
      {lesson.say.map((line, index) => <p key={line} className={read(`say:${index}`)}>“{line}”</p>)}
    </div>}
    <div className="rep-training-actions">
      <button className="btn-admin" type="button" onClick={() => setStep(step - 1)}>Back</button>
      <button className="btn-admin primary" type="button" onClick={() => setStep(step + 1)}>
        {step === lessons.length - 1 ? 'Take the quiz' : 'Next lesson'}
      </button>
    </div>
  </section>;

  return <form className="rep-course" aria-label="Quiz" onSubmit={submit}>
    <span className="outbound-eyebrow">Quiz</span>
    <h3>Let’s see what stuck.</h3>
    {course.quiz.map((item, index) => <fieldset className="rep-course-question" key={item.id}>
      <legend>{index + 1}. {item.question}</legend>
      {item.options.map((option, optionIndex) => <label key={option}>
        <input type="radio" name={item.id} checked={answers[item.id] === optionIndex}
          onChange={() => setAnswers(current => ({ ...current, [item.id]: optionIndex }))} />
        <span>{option}</span>
      </label>)}
    </fieldset>)}
    {problem && <p className="admin-error" role="alert">{problem}</p>}
    {result && !result.passed && <div className="rep-training-feedback is-retry" role="status">
      <div><strong>Almost there. Try again.</strong><span>{result.correct} of {result.total}</span></div>
      <ul>{result.missed.map(item => <li key={item.id}>{item.why}</li>)}</ul>
    </div>}
    <div className="rep-training-actions">
      <button className="btn-admin" type="button" onClick={() => setStep(lessons.length - 1)}>Back to lessons</button>
      <button className="btn-admin primary" type="submit" disabled={busy || !answered}>{busy ? 'Checking…' : 'Submit quiz'}</button>
    </div>
  </form>;
}
