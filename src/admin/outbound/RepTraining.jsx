import React, { useEffect, useMemo, useRef, useState } from 'react';
import { outbound } from './data';
import { startAgentPreview } from './agent-preview-client';

const transcriptLengthLabel = turns => `${turns.length} transcript turns`;

export default function RepTraining({ accounts = [], loading = false, error = '', onRefresh = () => {} }) {
  const incomplete = useMemo(() => accounts.filter(account => !account.passed), [accounts]);
  const [accountId, setAccountId] = useState('');
  const [state, setState] = useState('idle');
  const [scenario, setScenario] = useState(null);
  const [attemptId, setAttemptId] = useState('');
  const [transcript, setTranscript] = useState([]);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const audioRef = useRef(null);
  const controllerRef = useRef(null);
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
    transcriptRef.current = [];
    setTranscript([]);
    setBusy(true);
    try {
      const controller = await startAgentPreview({
        mode: 'training',
        accountId: selected.accountId,
        audioElement: audioRef.current,
        onState: setState,
        onTranscript: updateTranscript,
        onError: setProblem,
        onSession: session => {
          setAttemptId(session.attemptId || '');
          setScenario(session.scenario || null);
        }
      });
      controllerRef.current = controller;
      setMessage('Practice is live. This is a fictional prospect; no campaign leads or phone calls are involved.');
    } catch (failure) {
      setState('idle');
      setProblem(failure?.message || 'Could not start the practice session.');
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!attemptId || busy) return;
    setBusy(true);
    setState('scoring');
    setProblem('');
    setMessage('The AI coach is reviewing your practice conversation…');
    const currentTranscript = transcriptRef.current;
    const currentAttempt = attemptId;
    const controller = controllerRef.current;
    controllerRef.current = null;
    await controller?.stop().catch(() => {});
    setState('scoring');
    try {
      const evaluation = await outbound.completeRepTrainingAttempt(currentAttempt, currentTranscript);
      setResult(evaluation);
      setAttemptId('');
      setMessage(evaluation.coursePassed
        ? evaluation.assignedCampaign
          ? `Training passed. You now have access to ${evaluation.assignedCampaign.name}.`
          : 'Training passed. A manager needs to choose a default campaign or free up campaign capacity before access can be assigned.'
        : evaluation.passed
          ? 'Scenario passed. Continue with the next practice scenario to complete training.'
          : 'This scenario needs another attempt. Review the coach’s notes and try again.');
      await onRefresh();
    } catch (failure) {
      setMessage('');
      setProblem(failure?.message || 'The coach could not score this session. You can try submitting again.');
      setState('idle');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="admin-card rep-training-card"><p>Loading your training assignments…</p></div>;
  if (error) return <div className="admin-card rep-training-card">
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
          <span className="outbound-eyebrow">Required before campaign access</span>
          <h2>AI sales practice</h2>
          <p>Role-play fictional prospects, practice objections, and get coaching. Practice never contacts real people or uses live leads.</p>
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
          <div className={`rep-training-progress ${account.passed ? 'is-passed' : ''}`} key={account.accountId}>
            <div>
              <strong>{account.accountName}</strong>
              <span>{account.passed ? 'Passed' : `${account.completedScenarioIds.length} of ${account.requiredScenarioCount} scenarios passed`}</span>
            </div>
            <span className={`pill ${account.passed ? 'completed' : account.ready ? 'draft' : 'paused'}`}>
              {account.passed
                ? account.campaignAssigned ? 'Access granted' : 'Waiting for campaign'
                : account.ready ? 'Training required' : 'Training setup needed'}
            </span>
          </div>
        ))}
      </div>

      {selected?.passed ? (
        <div className="rep-training-ready" role="status">
          <strong>You passed the required training.</strong>
          <span>{selected.campaignAssigned
            ? `Your assigned campaign${selected.defaultCampaign?.name ? `, ${selected.defaultCampaign.name},` : ''} is available in the Dialer tab.`
            : 'A manager must choose a default campaign or free up campaign capacity before campaign access can be assigned.'}</span>
        </div>
      ) : !selected?.ready ? (
        <div className="rep-training-setup" role="status">
          Training scenarios are not configured for {selected?.accountName || 'this account'} yet. Ask a manager to contact BiteSites support.
        </div>
      ) : (
        <section className="rep-training-session" aria-label="Sales practice session">
          <div className="rep-training-scenario">
            <span className="outbound-eyebrow">Next fictional prospect</span>
            {scenario ? <>
              <h3>{scenario.name}, {scenario.age} · {scenario.niche}</h3>
              <p>{scenario.business} · {scenario.gender} · voice: {scenario.voice}</p>
              <strong>Practice objection</strong>
              <p>{scenario.objection}</p>
            </> : <p>Start a role-play to meet the next prospect in your course.</p>}
          </div>

          <div className="rep-training-actions">
            <button className="btn-admin primary" type="button" disabled={busy || state === 'live'} onClick={start}>
              {state === 'connecting' ? 'Connecting…' : state === 'live' ? 'Practice in progress' : 'Start role-play'}
            </button>
            <button className="btn-admin" type="button"
              disabled={busy || !attemptId || transcript.length < 8}
              onClick={finish}>
              {state === 'scoring' ? 'Getting feedback…' : 'Finish and get feedback'}
            </button>
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

          {message && <p className="rep-training-message" role="status">{message}</p>}
          {problem && <p className="admin-error" role="alert">{problem}</p>}
          {result && <div className={`rep-training-feedback ${result.passed ? 'is-passed' : 'is-retry'}`}>
            <div><strong>{result.passed ? 'Scenario passed' : 'Try this scenario again'}</strong><span>Score {result.score}/100</span></div>
            <p>{result.summary}</p>
            {!!result.strengths?.length && <div><strong>What went well</strong><ul>{result.strengths.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
            {!!result.improvements?.length && <div><strong>Next time</strong><ul>{result.improvements.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
          </div>}
        </section>
      )}
      <audio ref={audioRef} autoPlay playsInline className="rep-training-audio" />
    </div>
  );
}
