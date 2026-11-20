import React, { useEffect, useMemo, useRef, useState } from 'react';
import { outbound } from './data';
import { startPracticeCall } from './practice-call-client';
import RepCourse from './RepCourse';
import RepFieldGuide from './RepFieldGuide';

const transcriptLengthLabel = turns => `${turns.length} transcript turns`;

// The same choices the field guide and the live dialer use. Practice keeps
// them in this browser only: the coach scores the conversation ElevenLabs
// recorded, and nothing here touches a real lead.
const PRACTICE_OUTCOMES = ['Interested', 'Booked a meeting', 'Call back later', 'Not interested', 'Voicemail', 'Wrong number', 'Do not call'];

// Mirrors the server's minimum (functions/rep-training.js): four turns each
// way and about 400 characters, or the coach refuses to score the call.
const scorable = turns => {
  const you = turns.filter(turn => turn.role === 'you').length;
  const them = turns.filter(turn => turn.role === 'agent').length;
  const characters = turns.reduce((total, turn) => total + turn.text.length, 0);
  return you >= 4 && them >= 4 && characters >= 400;
};

export default function RepTraining({ accounts = [], loading = false, error = '', onRefresh = () => {} }) {
  const incomplete = useMemo(() => accounts.filter(account => !account.passed && !account.trainingExempt), [accounts]);
  const [accountId, setAccountId] = useState('');
  const [state, setState] = useState('idle');
  const [scenario, setScenario] = useState(null);
  const [attemptId, setAttemptId] = useState('');
  const [transcript, setTranscript] = useState([]);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrapUp, setWrapUp] = useState({ outcome: '', notes: '', infoSent: false });
  const [logged, setLogged] = useState(null);
  const controllerRef = useRef(null);
  // Set when the rep presses End call, even mid-connect, so a call that is
  // still connecting cannot come back to life after the rep hung up.
  const endRequestedRef = useRef(false);
  // While a call is being scored or skipped, a late hang-up event from the
  // call must not flip the screen back to the wrap-up.
  const finishingRef = useRef(false);
  const transcriptRef = useRef([]);
  const selected = accounts.find(account => account.accountId === accountId) || incomplete[0] || accounts[0] || null;

  useEffect(() => {
    if (!accountId || !accounts.some(account => account.accountId === accountId)) {
      setAccountId(incomplete[0]?.accountId || accounts[0]?.accountId || '');
    }
  }, [accountId, accounts, incomplete]);

  useEffect(() => () => {
    controllerRef.current?.stop().catch(() => {});
  }, []);

  // The field guide comes with the course, so only accounts that have one show it.
  const [guide, setGuide] = useState(null);
  const guideAccountId = selected?.courseRequired ? selected.accountId : '';
  useEffect(() => {
    let active = true;
    setGuide(null);
    if (!guideAccountId) return undefined;
    outbound.repCourse(guideAccountId)
      .then(data => { if (active) setGuide(data?.course?.fieldGuide || null); })
      .catch(() => {});
    return () => { active = false; };
  }, [guideAccountId]);

  const updateTranscript = entry => {
    transcriptRef.current = [...transcriptRef.current, entry].slice(-80);
    setTranscript(transcriptRef.current);
  };

  const start = async () => {
    if (!selected?.ready) return;
    setProblem('');
    setMessage('');
    setResult(null);
    setScenario(null);
    setAttemptId('');
    setWrapUp({ outcome: '', notes: '', infoSent: false });
    setLogged(null);
    endRequestedRef.current = false;
    await controllerRef.current?.stop().catch(() => {});
    controllerRef.current = null;
    transcriptRef.current = [];
    setTranscript([]);
    setBusy(true);
    try {
      const controller = await startPracticeCall({
        accountId: selected.accountId,
        onState: next => {
          if (finishingRef.current || (endRequestedRef.current && next !== 'idle')) return;
          setState(next);
          // The prospect can hang up too; drop the "practice is live" note.
          if (next === 'idle') setMessage('');
        },
        onTranscript: updateTranscript,
        onError: setProblem,
        onSession: session => {
          setAttemptId(session.attemptId || '');
          setScenario(session.scenario || null);
        }
      });
      if (endRequestedRef.current) {
        await controller.stop().catch(() => {});
        setState('idle');
      } else {
        controllerRef.current = controller;
        setMessage('Practice is live. This is a fictional prospect; no campaign leads or phone calls are involved.');
      }
    } catch (failure) {
      setState('idle');
      setProblem(failure?.message || 'Could not start the practice session.');
    } finally {
      setBusy(false);
    }
  };

  // Hang up without scoring yet: the rep wraps up the call first.
  const endCall = async () => {
    endRequestedRef.current = true;
    const controller = controllerRef.current;
    controllerRef.current = null;
    setState('idle');
    setMessage('');
    await controller?.stop().catch(() => {});
  };

  // testerSkip: an admin-approved tester passes the call without scoring.
  const finish = async ({ testerSkip = false } = {}) => {
    if (!attemptId || busy) return;
    endRequestedRef.current = true;
    finishingRef.current = true;
    setLogged(testerSkip ? null : { ...wrapUp });
    setBusy(true);
    setState('scoring');
    setProblem('');
    const currentAttempt = attemptId;
    const controller = controllerRef.current;
    controllerRef.current = null;
    await controller?.stop().catch(() => {});
    setState('scoring');
    setMessage(testerSkip ? 'Recording the tester skip…' : 'The AI coach is reviewing your practice conversation…');
    try {
      const evaluation = await outbound.completeRepTrainingAttempt(currentAttempt, { testerSkip });
      setResult(evaluation);
      setAttemptId('');
      setState('idle');
      setMessage(evaluation.coursePassed
        ? evaluation.assignedCampaign
          ? `Training passed. You now have access to ${evaluation.assignedCampaign.name}.`
          : 'Training passed. A manager needs to choose a default campaign or free up campaign capacity before access can be assigned.'
        : evaluation.testerSkipped
          ? 'Call skipped as a tester. Start the next one when you’re ready.'
          : evaluation.passed
          ? 'Nice work. Keep going with your next practice call.'
          : 'Not quite yet. Read the coach’s notes and try this call again.');
      await onRefresh();
    } catch (failure) {
      setMessage('');
      setProblem(failure?.message || 'The coach could not score this session. You can try submitting again.');
      setState('idle');
    } finally {
      finishingRef.current = false;
      setBusy(false);
    }
  };

  const testerSkipButton = selected?.trainingTester && attemptId && state !== 'scoring'
    ? <button className="btn-admin rep-training-skip" type="button" disabled={busy} onClick={() => finish({ testerSkip: true })}>Pass this call (tester)</button>
    : null;
  const callEnded = Boolean(attemptId) && !['live', 'connecting', 'scoring'].includes(state);
  const canScore = scorable(transcript);
  const inPractice = Boolean(selected?.ready && !selected.trainingExempt && !selected.passed && !(selected.courseRequired && !selected.quizPassed));

  if (loading && !accounts.length) return <div className="admin-card rep-training-card"><p>Loading your training assignments…</p></div>;
  if (error && !accounts.length) return <div className="admin-card rep-training-card">
    <h2>Sales practice</h2><p className="admin-error" role="alert">{error}</p>
    <button className="btn-admin" type="button" onClick={onRefresh}>Try again</button>
  </div>;

  if (!accounts.length) return <div className="admin-card rep-training-card">
    <h2>Sales practice</h2>
    <p>Your account is not assigned to a seller workspace yet. Ask a manager to finish setting up your sales-rep access.</p>
  </div>;

  return (
    <div className="admin-card rep-training-card">
      <div className="card-head">
        <div>
          <span className="outbound-eyebrow">Training status</span>
          <h2>Your sales training</h2>
          <p>Learn the basics, then practice with fictional business owners. Some will say yes and some will say no. Practice never contacts real people or uses live leads.</p>
        </div>
        <button className="btn-admin" type="button" onClick={onRefresh}>Refresh</button>
      </div>

      {accounts.length > 1 && <label className="rep-training-account">
        <span>Seller account</span>
        <select value={selected?.accountId || ''} onChange={event => {
          setAccountId(event.target.value);
          setResult(null);
          setScenario(null);
          setMessage('');
          setProblem('');
        }}>
          {accounts.map(account => <option key={account.accountId} value={account.accountId}>{account.accountName}</option>)}
        </select>
      </label>}

      <div className="rep-training-progress-list">
        {accounts.map(account => (
          <div className={`rep-training-progress ${account.passed || account.trainingExempt ? 'is-passed' : ''}`} key={account.accountId}>
            <div>
              <strong>{account.accountName}</strong>
              <span>{account.trainingExempt ? 'Waived by an admin' : account.passed ? 'Passed' : account.courseRequired && !account.quizPassed ? 'Lessons and quiz' : `${account.completedScenarioIds.length} of ${account.requiredScenarioCount} practice calls passed`}</span>
            </div>
            <span className={`pill ${account.passed || account.trainingExempt ? 'completed' : account.ready ? 'draft' : 'paused'}`}>
              {account.trainingExempt
                ? account.campaignAssigned ? 'Access granted' : 'Waiting for campaign'
                : account.passed
                ? account.campaignAssigned ? 'Access granted' : 'Waiting for campaign'
                : account.ready ? 'Training required' : 'Training setup needed'}
            </span>
          </div>
        ))}
      </div>

      <div className={`rep-training-layout ${guide && inPractice ? 'has-guide' : ''}`}>
        {selected?.trainingExempt ? (
          <div className="rep-training-ready" role="status">
            <strong>An admin waived training for this account.</strong>
            <span>{selected.campaignAssigned
              ? `Your assigned campaign${(selected.assignedCampaign || selected.defaultCampaign)?.name ? `, ${(selected.assignedCampaign || selected.defaultCampaign).name},` : ''} is available in the Dialer tab.`
              : selected.defaultCampaign
                ? `A manager still needs to add you to ${selected.defaultCampaign.name || 'the default campaign'} before campaign access is available.`
                : 'A manager still needs to add you to a campaign before you can call.'}</span>
          </div>
        ) : selected?.passed ? (
          <div className="rep-training-ready" role="status">
            <strong>You passed the required training.</strong>
            <span>{selected.campaignAssigned
              ? `Your assigned campaign${(selected.assignedCampaign || selected.defaultCampaign)?.name ? `, ${(selected.assignedCampaign || selected.defaultCampaign).name},` : ''} is available in the Dialer tab.`
              : 'A manager still needs to add you to a campaign. You’ll be able to call as soon as they do; tap Refresh then.'}</span>
          </div>
        ) : !selected?.ready ? (
          <div className="rep-training-setup" role="status">
            Training scenarios are not configured for {selected?.accountName || 'this account'} yet. Ask a manager to contact BiteSites support.
          </div>
        ) : selected?.courseRequired && !selected.quizPassed ? (
          <RepCourse key={selected.accountId} accountId={selected.accountId} accountName={selected.accountName} onPassed={onRefresh} />
        ) : (
          <section className="rep-training-session" aria-label="Sales practice session">
            <div className="rep-training-scenario">
              <span className="outbound-eyebrow">Next fictional prospect</span>
              {scenario ? <>
                <h3>{scenario.name}, {scenario.age} · {scenario.niche}</h3>
                <p>{scenario.business} · {scenario.gender}</p>
                <p>You’re calling this business for the first time. Get to yes if you can, and take a no well if you can’t.</p>
              </> : <p>Start a role-play to meet the next prospect in your course.</p>}
            </div>
  
            <div className="rep-training-actions">
              {state === 'live' || state === 'connecting'
                ? <button className="btn-admin danger rep-training-end" type="button" onClick={endCall}>End call</button>
                : !callEnded && <button className="btn-admin primary" type="button" disabled={busy || state === 'scoring'} onClick={start}>
                  {state === 'scoring' ? 'Getting feedback…' : result ? (result.passed ? 'Start next call' : 'Try this call again') : 'Start role-play'}
                </button>}
              {state === 'live' && testerSkipButton}
              {state === 'live' && <span className="rep-training-live"><i aria-hidden="true" />Call in progress</span>}
            </div>
  
            {transcript.length > 0 && <div className="rep-training-transcript" aria-label="Practice transcript" aria-live="polite">
              <div className="rep-training-transcript-head"><strong>Practice transcript</strong><span>{transcriptLengthLabel(transcript)}</span></div>
              {transcript.map((turn, index) => (
                <p className={`rep-training-turn is-${turn.role}`} key={`${index}:${turn.text.slice(0, 24)}`}>
                  <strong>{turn.role === 'you' ? 'You' : 'Prospect'}</strong>
                  <span>{turn.text}</span>
                </p>
              ))}
            </div>}
  
            {callEnded && <section className="rep-training-wrapup" aria-label="Wrap up the call">
              <div>
                <strong>Wrap up the call</strong>
                <span>Practice only: nothing here contacts anyone or changes a real lead.</span>
              </div>
              <fieldset>
                <legend>How did it end?</legend>
                <div className="rep-training-outcomes">
                  {PRACTICE_OUTCOMES.map(outcome => <button key={outcome} type="button"
                    className={`rep-training-outcome ${outcome === 'Do not call' ? 'is-dnc' : ''}`}
                    aria-pressed={wrapUp.outcome === outcome}
                    onClick={() => setWrapUp(current => ({ ...current, outcome }))}>{outcome}</button>)}
                </div>
              </fieldset>
              {(wrapUp.outcome === 'Interested' || wrapUp.outcome === 'Booked a meeting') && <div className="rep-training-info">
                {wrapUp.infoSent
                  ? <div className="rep-training-info-preview" role="status">
                    <span className="outbound-eyebrow">Practice email · not sent</span>
                    <strong>Your free demo from BiteSites</strong>
                    <p>Hi{scenario?.name ? ` ${scenario.name}` : ''}, thanks for the time today. Here’s the link we talked about:</p>
                    <span className="rep-training-info-link">bitesites.org/demo/{(scenario?.business || 'your-business').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}</span>
                    <small>On a real call this goes out from the dialer’s email step. In practice nothing is sent.</small>
                  </div>
                  : <button className="btn-admin" type="button" onClick={() => setWrapUp(current => ({ ...current, infoSent: true }))}>Send info link (practice)</button>}
              </div>}
              {wrapUp.outcome === 'Do not call' && <p className="rep-training-dnc">On a real call this adds the number to the do-not-call list, and no one calls it again.</p>}
              <label className="rep-training-notes">
                <span>Notes</span>
                <textarea rows={3} maxLength={1000} value={wrapUp.notes} placeholder="What did they say? What’s the next step?"
                  onChange={event => setWrapUp(current => ({ ...current, notes: event.target.value }))} />
              </label>
              {canScore
                ? <div className="rep-training-actions">
                  <button className="btn-admin primary" type="button" disabled={busy || !wrapUp.outcome} onClick={() => finish()}>Save and get feedback</button>
                  <button className="btn-admin" type="button" disabled={busy} onClick={start}>Discard and start over</button>
                  {testerSkipButton}
                  {!wrapUp.outcome && <span className="rep-training-hint">Pick how the call ended first.</span>}
                </div>
                : <div className="rep-training-short" role="status">
                  <p>This call was too short for the coach to score. It needs at least four back-and-forths. Start a new call and keep the conversation going a little longer.</p>
                  <div className="rep-training-actions">
                    <button className="btn-admin primary" type="button" disabled={busy} onClick={start}>Start a new call</button>
                    {testerSkipButton}
                  </div>
                </div>}
            </section>}

            {message && <p className="rep-training-message" role="status">{message}</p>}
            {problem && <p className="admin-error" role="alert">{problem}</p>}
            {result && <div className={`rep-training-feedback ${result.passed ? 'is-passed' : 'is-retry'}`}>
              <div><strong>{result.testerSkipped ? 'Skipped as a tester' : result.passed ? 'Practice call passed' : 'Try this call again'}</strong><span>{result.testerSkipped ? 'Not scored' : `Score ${result.score}/100`}</span></div>
              <p>{result.summary}</p>
              {!!result.strengths?.length && <div><strong>What went well</strong><ul>{result.strengths.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
              {!!result.improvements?.length && <div><strong>Next time</strong><ul>{result.improvements.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
              {logged?.outcome && <p className="rep-training-logged">You logged: <strong>{logged.outcome}</strong>{logged.infoSent ? ' · info link (practice)' : ''}{logged.notes ? ` · “${logged.notes}”` : ''}</p>}
            </div>}
          </section>
        )}
        {guide && <RepFieldGuide key={`${selected.accountId}:${inPractice}`} guide={guide} defaultOpen={inPractice} />}
      </div>
    </div>
  );
}
