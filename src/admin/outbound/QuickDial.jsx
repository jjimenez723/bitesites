// One-button human dialing.
//
// The guided flow in CallPlanFlow exists because an AI may only speak from an
// approved, sourced call plan. A person does not read from that plan — they
// read the screen — so a human-only session is allowed to dial the same queue
// without one, and this screen is what that looks like: press once, talk to
// whoever answers, mark the outcome, and the server places the next call.
//
// The server still owns everything that matters. Compliance, calling hours,
// suppression, the account boundary and the one-live-line cap are evaluated per
// leg in dialNext regardless of which screen asked for the call. Nothing here
// can widen them; the most this component can do is ask.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { outbound, toDate, useAction, useLiveCalls, useLiveDoc, useSessionHeartbeat } from './data';
import { playDialerCue, primeDialerCue, readDialerSoundPreference, writeDialerSoundPreference, startDialerRingback } from './dialer-cue';
import { formatPhone } from './SourceBadge';
import { hybridVoiceState, joinHybridCall, leaveHybridVoice, prepareHybridVoice, setHybridVoiceMuted } from './voice-client';
import { useHybridVoice } from './use-hybrid-voice';

const TERMINAL = ['completed', 'cancelled', 'failed'];
const isTerminal = call => TERMINAL.includes(call?.status);

// Plain-language versions of the reasons dialNext can decline, for a screen
// whose whole point is that the operator should not have to know the model.
const BLOCKER_COPY = {
  no_eligible_targets: 'Nobody in this list can be called right now.',
  campaign_paused: 'This campaign is paused. A manager resumes it from Campaigns.',
  campaign_cancelled: 'This campaign is cancelled. Pick another one.',
  campaign_safety_lock: 'This campaign is halted by a safety incident. A manager clears it from Campaigns.',
  external_dialing_disabled: 'Outside calling is switched off in this environment, so no call was placed.',
  at_capacity: 'A call is already running on this line.',
  batch_in_progress: 'A call is already running on this line.',
  session_ended: 'That dialing session has ended. Start dialing again.'
};

/** Keep implementation failures out of the operator-facing dialer. */
function startErrorMessage(error) {
  const message = String(error?.message || '');
  if (/accountId[\s\S]*(?:undefined|not a valid Firestore document)|(?:undefined|not a valid Firestore document)[\s\S]*accountId/i.test(message)) {
    return 'This calling list is missing its account assignment, so dialing could not start. No call was placed. Open Advanced, save the campaign, then try again.';
  }
  return message || 'Dialing could not start. No call was placed. Try again, or open Advanced to check the campaign.';
}

const REJECTION_COPY = {
  awaiting_approval: 'waiting for research approval',
  contact_missing: 'missing their contact record',
  do_not_call: 'on the Do Not Call list',
  do_not_contact: 'marked do-not-contact',
  invalid_caller_id: 'blocked because the campaign caller ID is not valid',
  invalid_number: 'not a valid phone number',
  max_attempts_reached: 'already called the maximum number of times',
  no_valid_phone: 'without a phone number',
  outside_allowed_days: 'outside the days this campaign may call',
  outside_calling_hours: 'outside calling hours where they live',
  retry_delay_not_elapsed: 'called too recently to try again',
  suppressed: 'on the suppression list',
  unknown_timezone: 'missing a timezone, so their local hours cannot be checked'
};

/** Why the queue came back empty, in one sentence a person can act on. */
function displayTime(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return '';
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour = hours % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function emptyQueueReason(result, campaign) {
  const availability = result?.availability || {};
  const counts = availability.counts || {};
  const later = Number(counts.callLater) || 0;
  const top = Object.entries(availability.rejectedByReason || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([reason, count]) => `${count} ${REJECTION_COPY[reason] || reason.replace(/_/g, ' ')}`);

  if (top.length) {
    const start = displayTime(campaign?.localStartTime);
    const end = displayTime(campaign?.localEndTime);
    const window = Number(availability.rejectedByReason?.outside_calling_hours) > 0 && start && end
      ? ` This list calls only from ${start} to ${end} in each prospect’s local time.`
      : '';
    return `Nobody can be called right now — ${top.join(', and ')}.${window}`;
  }
  if (later > 0) return `${later} ${later === 1 ? 'person is' : 'people are'} scheduled for later, but none are due yet.`;
  return 'This list has nobody left to call. Add leads to the campaign to keep going.';
}

const clock = seconds => {
  const total = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function localTime(timezone) {
  if (!timezone) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date());
  } catch { return ''; }
}

const placeOf = location => [location?.city, location?.region].filter(Boolean).join(', ')
  || location?.country || '';

const hostOf = website => {
  try { return new URL(website).host.replace(/^www\./, ''); } catch { return website || ''; }
};

/**
 * What their website looks like, without sending the prospect's domain to a
 * screenshot vendor: the rep's own browser loads the page, the same as opening
 * it in a tab. Plenty of sites refuse to be framed, so the link is the promise
 * and the preview is the bonus — it never becomes the only way to see the site.
 */
function WebsitePanel({ website }) {
  const [showPreview, setShowPreview] = useState(true);
  useEffect(() => { setShowPreview(true); }, [website]);

  if (!website) {
    return (
      <div className="quickdial-site is-empty">
        <span>No website on file</span>
        <small>Worth asking whether they have one.</small>
      </div>
    );
  }

  return (
    <div className="quickdial-site">
      <div className="quickdial-site-frame">
        {showPreview ? (
          <iframe
            key={website}
            src={website}
            title={`Website preview for ${hostOf(website)}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : (
          <div className="quickdial-site-fallback"><span>{hostOf(website)}</span></div>
        )}
      </div>
      <div className="quickdial-site-actions">
        <a className="btn-admin primary" href={website} target="_blank" rel="noreferrer noopener">
          Open {hostOf(website)} ↗
        </a>
        <button className="btn-admin" type="button" onClick={() => setShowPreview(value => !value)}>
          {showPreview ? 'Hide preview' : 'Show preview'}
        </button>
      </div>
    </div>
  );
}

/** The five outcomes worth one tap. Anything rarer lives under Advanced. */
function OutcomeRow({ label, busy, onPick }) {
  return (
    <div className="quickdial-outcomes">
      <span className="quickdial-outcomes-label">{label}</span>
      <button className="btn-admin primary" type="button" disabled={busy}
        onClick={() => onPick('booked_meeting')}>Booked a meeting</button>
      <button className="btn-admin" type="button" disabled={busy}
        onClick={() => onPick('call_later')}>Call back later</button>
      <button className="btn-admin" type="button" disabled={busy}
        onClick={() => onPick('not_interested')}>Not interested</button>
      <button className="btn-admin" type="button" disabled={busy}
        onClick={() => onPick('wrong_number')}>Wrong number</button>
      <button className="btn-admin danger" type="button" disabled={busy}
        onClick={() => onPick('do_not_call')}>Do not call</button>
    </div>
  );
}

/** The two outcomes that promise the prospect a specific time need one. */
function FollowUpPrompt({ label, busy, onCancel, onConfirm }) {
  const [value, setValue] = useState('');
  return (
    <div className="quickdial-followup">
      <label>
        <span>{label} — when?</span>
        <input type="datetime-local" value={value} onChange={event => setValue(event.target.value)} />
      </label>
      <button className="btn-admin primary" type="button" disabled={!value || busy}
        onClick={() => onConfirm(new Date(value).toISOString())}>
        Save &amp; call next
      </button>
      <button className="btn-admin" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  );
}

export default function QuickDial({ campaignId, campaigns = [], onSelectCampaign, onOpenAdvanced }) {
  const [sessionId, setSessionId] = useState('');
  const [recovering, setRecovering] = useState(true);
  const [blocker, setBlocker] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [muted, setMuted] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(readDialerSoundPreference);
  // Which call a follow-up time is being picked for, so an outcome can never
  // land on the prospect who happened to be on screen when it was confirmed.
  const [followUp, setFollowUp] = useState({});
  const [now, setNow] = useState(Date.now());
  const lastCuedCallRef = useRef('');
  const action = useAction();
  const voice = useHybridVoice();

  const campaign = campaigns.find(entry => entry.id === campaignId) || null;
  const { data: session } = useLiveDoc(sessionId ? `dialerSessions/${sessionId}` : '');
  useSessionHeartbeat(session?.status === 'active' ? sessionId : '');
  const calls = useLiveCalls(session?.activeCallIds || []);

  const live = useMemo(
    () => calls.rows.filter(entry => !isTerminal(entry))[0] || null,
    [calls.rows]
  );
  // The prospect usually hangs up first, which ends the call before the rep has
  // said what happened. Keep the last unrecorded call on screen until they do,
  // so the outcome buttons do not vanish mid-thought. `humanHandled` is the
  // filter that matters: a leg nobody answered has nothing for a rep to record,
  // and the provider's own disposition already covers it.
  const wrapUp = useMemo(() => calls.rows
    .filter(entry => isTerminal(entry)
      && entry.humanHandled === true
      && !entry.disposition
      && entry.wrapUp?.status !== 'completed')
    .slice(-1)[0] || null, [calls.rows]);
  const call = live || wrapUp;
  const ended = !live && Boolean(wrapUp);
  const controller = call?.control?.controller || '';
  const assignedToRep = controller === 'human' && Boolean(live);
  const onCall = assignedToRep && voice.connected && voice.callId === live.id;
  const running = session?.status === 'active';
  const dialing = running && Boolean(session?.autoDial?.enabled);
  const waitingForTargets = dialing && !live && session?.autoDial?.state === 'waiting_for_targets';
  const findingNext = dialing && !live && !waitingForTargets;
  const ringing = live?.status === 'ringing' && !live?.answeredAt && !assignedToRep;
  const connecting = Boolean(live) && !ringing && !onCall;

  useEffect(() => {
    if (ringing && soundEnabled) return startDialerRingback();
  }, [live?.id, ringing, soundEnabled]);

  useEffect(() => {
    if (voice.callId !== live?.id) return;
    setMuted(voice.muted);
    setVoiceError(voice.error);
  }, [live?.id, voice]);

  useEffect(() => {
    if (!live?.id || lastCuedCallRef.current === live.id) return;
    lastCuedCallRef.current = live.id;
    if (soundEnabled) playDialerCue();
  }, [live?.id, soundEnabled]);

  useEffect(() => {
    if (!running && !call) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, Boolean(call)]);

  // Recover the session this rep already has, so a reload or a tab switch does
  // not strand a live call behind a Start button.
  useEffect(() => {
    let cancelled = false;
    outbound.getActiveHybridSession()
      .then(result => {
        if (cancelled) return;
        const active = result?.session;
        if (active?.sessionId) {
          setSessionId(active.sessionId);
          if (active.campaignId && active.campaignId !== campaignId) onSelectCampaign?.(active.campaignId);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRecovering(false); });
    return () => { cancelled = true; };
    // Mount only: a campaign change must never replace a running session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (session && session.status !== 'active') {
      leaveHybridVoice();
      setSessionId('');
    }
  }, [session?.status]);

  useEffect(() => () => leaveHybridVoice(), []);

  // The server decides who owns a call. Once it hands this one to the rep, put
  // their microphone in it — the browser is following that decision, not making it.
  useEffect(() => {
    if (!live || !assignedToRep || session?.rep?.activeCallId !== live.id) return;
    const voice = hybridVoiceState();
    if (voice.connected && voice.callId === live.id && voice.mode === 'human') return;
    setVoiceError('');
    joinHybridCall(live.id, 'human')
      .then(() => setMuted(hybridVoiceState().muted))
      .catch(error => {
        if (hybridVoiceState().callId === live.id) setVoiceError(error?.message || 'Could not connect your microphone to this call.');
      });
  }, [live?.id, assignedToRep, session?.rep?.activeCallId]);

  // Leaving the audio is keyed on the live call ending, not on the card
  // changing — a wrap-up still on screen has no audio to hold, and clearing the
  // follow-up picker here would close it under the rep mid-entry.
  useEffect(() => {
    if (live) return;
    const voice = hybridVoiceState();
    if (voice.callId) leaveHybridVoice();
    setMuted(false);
  }, [live?.id]);

  const describeResult = useCallback(result => {
    if ((result?.started || []).length) return '';
    if (result?.reason === 'no_eligible_targets') return emptyQueueReason(result, campaign);
    // The one blocker that is a deployment decision rather than a data problem,
    // so it says which decision instead of "no call was placed".
    if (result?.reason === 'external_dialing_disabled') {
      return result?.admission?.reason === 'non_production_environment'
        ? 'This is a non-production environment, which never places outside calls. Nothing was dialed.'
        : 'Outside calling is switched off for this deployment (OUTBOUND_EXTERNAL_DIALING). Nothing was dialed — an owner turns it on at deploy time.';
    }
    return BLOCKER_COPY[result?.reason] || 'No call was placed. Nothing was dialed.';
  }, [campaign]);

  const start = () => action.run(async () => {
    try {
      setBlocker('');
      setVoiceError('');
      // This click is the browser gesture that is allowed to ask for the
      // microphone. Asking later, when the server assigns an answered call,
      // is too late.
      await Promise.all([prepareHybridVoice(), soundEnabled ? primeDialerCue() : Promise.resolve()]);
      const started = await outbound.startHybridSession(campaignId, {
        operatingMode: 'human',
        concurrency: 1,
        agentProfileId: ''
      });
      if (!started?.sessionId) throw new Error('The dialer session did not start.');
      setSessionId(started.sessionId);
      const result = await outbound.dialHybrid(started.sessionId);
      const why = describeResult(result);
      if (why) setBlocker(why);
      return result;
    } catch (error) {
      throw new Error(startErrorMessage(error), { cause: error });
    }
  }, '');

  const dialAgain = () => action.run(async () => {
    setBlocker('');
    await Promise.all([prepareHybridVoice(), soundEnabled ? primeDialerCue() : Promise.resolve()]);
    const result = await outbound.dialHybrid(sessionId);
    const why = describeResult(result);
    if (why) setBlocker(why);
    return result;
  }, '');

  const stop = () => action.run(async () => {
    leaveHybridVoice();
    const result = await outbound.stopHybridSession(sessionId, 'ended');
    setSessionId('');
    setBlocker('');
    return result;
  }, '');

  const hangUp = () => action.run(async () => {
    leaveHybridVoice();
    return outbound.endHybridCall(call.id);
  }, '');

  // One click is the whole wrap-up: record what happened, hang up, and let the
  // server's capacity refill place the next call. A call the prospect already
  // ended is only recorded — asking Twilio to end a finished call is an error,
  // and its replacement was already placed by the terminal-event refill.
  const finish = (target, disposition, followUpAt = '') => action.run(async () => {
    if (!target?.id) return null;
    await outbound.hybridDisposition({ callId: target.id, disposition, followUpAt });
    setFollowUp({});
    if (isTerminal(target)) return { ok: true };
    leaveHybridVoice();
    return outbound.endHybridCall(target.id);
  }, '');

  // Two of the five outcomes promise the prospect a specific time, so they open
  // the picker instead of committing.
  const pick = target => disposition => (
    ['booked_meeting', 'call_later'].includes(disposition)
      ? setFollowUp({ callId: target.id, disposition })
      : finish(target, disposition)
  );

  const toggleMute = () => {
    try { setMuted(setHybridVoiceMuted(!muted)); }
    catch (error) { setVoiceError(error?.message || 'Your microphone is not connected.'); }
  };

  const reconnectAudio = async () => {
    setVoiceError('');
    try {
      await prepareHybridVoice();
      await joinHybridCall(live.id, 'human');
    } catch (error) { setVoiceError(error?.message || 'Could not reconnect audio.'); }
  };

  const toggleSound = async () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    writeDialerSoundPreference(next);
    if (next && await primeDialerCue()) playDialerCue();
  };

  const counts = campaign?.counts || {};
  // Human-only sessions may dial the research-approval queue too, so the number
  // this screen promises is the number this screen can actually reach.
  const toCall = (Number(counts.ready) || 0) + (Number(counts.pending) || 0) + (Number(counts.callLater) || 0);
  const done = (Number(counts.completed) || 0);
  const halted = campaign?.status === 'paused' || campaign?.status === 'cancelled';
  // Only once the campaign has actually loaded. A list still on its way is not
  // a misconfigured one, and saying so is how a screen loses trust.
  const loadingCampaign = !campaign;
  const wrongProvider = Boolean(campaign) && campaign.provider !== 'twilio';

  // A finished call reports the duration the server recorded, not a timer that
  // keeps running while the rep types up what happened.
  const startedAtMs = toDate(call?.connectedAt || call?.answeredAt || call?.startedAt)?.getTime() || 0;
  const seconds = !call ? 0
    : isTerminal(call) ? Math.max(0, Number(call.durationSec) || 0)
      : startedAtMs ? Math.max(0, Math.floor((now - startedAtMs) / 1000)) : 0;
  const place = placeOf(call?.contactLocation);
  const theirTime = localTime(call?.contactLocation?.timezone);
  const ringingSecondsLeft = ringing ? Math.max(0, 25 - seconds) : 0;
  const statusLabel = onCall ? 'On a call'
    : ringing ? 'Ringing'
      : connecting ? 'Connecting'
      : ended ? 'Wrap up'
        : findingNext ? 'Checking list'
          : waitingForTargets ? 'Waiting'
            : running ? 'Ready' : 'Stopped';

  if (!campaignId) {
    return (
      <div className="admin-card quickdial-card">
        <h3>Pick a list to call</h3>
        <select className="admin-select" value="" onChange={event => onSelectCampaign?.(event.target.value)}>
          <option value="">Choose a campaign…</option>
          {campaigns.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </div>
    );
  }

  return (
    <div className="quickdial">
      <div className="quickdial-bar">
        <div className="quickdial-bar-main">
          <select className="admin-select" value={campaignId} disabled={Boolean(sessionId)}
            onChange={event => onSelectCampaign?.(event.target.value)}>
            {campaigns.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <dl className="quickdial-stats">
            <div><dt>To call</dt><dd>{toCall}</dd></div>
            <div><dt>Called</dt><dd>{done}</dd></div>
            <div><dt>Status</dt><dd>{statusLabel}</dd></div>
          </dl>
        </div>
        <div className="quickdial-bar-actions">
          <button
            className={`btn-admin quickdial-sound ${soundEnabled ? 'is-on' : ''}`}
            type="button"
            aria-pressed={soundEnabled}
            onClick={toggleSound}
          >
            {soundEnabled ? 'Sound on' : 'Sound off'}
          </button>
          {running && (
            <button className="btn-admin danger" type="button" disabled={action.busy} onClick={stop}>
              Stop dialing
            </button>
          )}
          <button className="btn-admin" type="button" onClick={onOpenAdvanced}>Advanced</button>
        </div>
      </div>

      {halted && (
        <p className="admin-error">
          This campaign is {campaign.status}. A manager resumes it from Campaigns before anyone can dial it.
        </p>
      )}
      {!halted && wrongProvider && (
        <p className="admin-error">
          This campaign is set to “{campaign?.provider || 'no provider'}”. Calling needs a Twilio campaign.
        </p>
      )}

      {!running && (
        <div className="quickdial-hero">
          <button
            className="quickdial-start"
            type="button"
            disabled={recovering || loadingCampaign || action.busy || halted || wrongProvider || !toCall}
            onClick={start}
          >
            <span className="quickdial-start-icon" aria-hidden="true">▸</span>
            {action.busy ? 'Starting…' : 'Start dialing'}
          </button>
          <p className="quickdial-hero-note">
            {recovering ? 'Checking for a session you already have…'
              : loadingCampaign ? 'Loading this list…'
                : !toCall ? 'This list has nobody left to call. Add leads to it first.'
                  : `${toCall} ${toCall === 1 ? 'person' : 'people'} in this list. Calls are placed one at a time and connected straight to you.`}
          </p>
        </div>
      )}

      {running && (
        <div className={`quickdial-live ${onCall ? 'is-connected' : ''}`}>
          <div className="quickdial-person">
            <div className="quickdial-person-head">
              <span
                className={`quickdial-state ${onCall ? 'is-live' : ringing ? 'is-ringing' : findingNext ? 'is-searching' : waitingForTargets ? 'is-waiting' : ''}`}
                role="status"
                aria-live="polite"
              >
                <span className="quickdial-state-dot" aria-hidden="true" />
                {onCall ? 'On call'
                  : ended ? 'Call ended — say how it went'
                    : ringing ? 'Ringing'
                      : connecting ? (assignedToRep ? 'Connecting your audio' : 'Calling now')
                      : findingNext ? 'Checking the list'
                        : waitingForTargets ? 'Dialer on — no active call' : 'Ready'}
              </span>
              {call && <span className="quickdial-timer">{clock(seconds)}</span>}
            </div>

            {call ? (
              <>
                <h2>{call.companyName || call.displayName || 'Outbound call'}</h2>
                <p className="quickdial-person-meta">
                  {[
                    call.contactName,
                    call.businessCategory,
                    place,
                    theirTime ? `${theirTime} their time` : ''
                  ].filter(Boolean).join(' · ') || 'No other details on file'}
                </p>
                <p className="quickdial-phone">{formatPhone(call.phoneE164)}</p>
                {ringing && (
                  <p className="quickdial-call-progress" role="status">
                    The carrier is ringing this number. {ringingSecondsLeft > 0
                      ? `No answer will move to the next person in about ${ringingSecondsLeft} seconds.`
                      : 'Waiting for the carrier to confirm the result, then the next person is called automatically.'}
                  </p>
                )}
                {connecting && <p className="quickdial-call-progress" role="status">
                  {assignedToRep ? (voiceError ? 'Your audio is disconnected. Reconnect to speak with the lead.' : 'The lead answered. Connecting your microphone…')
                    : call.answeredBy === 'machine' ? 'Voicemail answered. Waiting for the call to finish.'
                      : call.answeredAt ? 'The call was answered. Checking whether a person is on the line…'
                        : 'Placing the call. Waiting for the carrier to confirm ringing…'}
                </p>}
                {onCall && <p className="quickdial-call-progress is-connected">{muted ? 'Connected — your microphone is muted.' : 'Connected — your microphone is live.'}</p>}
                {call.callPlan?.summary && (
                  <p className="quickdial-brief">{call.callPlan.summary}</p>
                )}
              </>
            ) : (
              <>
                <h2>{waitingForTargets ? 'No call is active' : findingNext ? 'Checking who can be called…' : 'Nothing dialing'}</h2>
                <p className="quickdial-person-meta">
                  {waitingForTargets
                    ? (blocker || 'The dialer is on, but nobody in this list is eligible right now.')
                    : findingNext
                      ? 'The dialer is checking the list. A prospect appears here as soon as the carrier starts the call.'
                    : 'Press Call next to keep going.'}
                </p>
                <button className="btn-admin primary" type="button" disabled={action.busy} onClick={dialAgain}>
                  {waitingForTargets ? 'Check again' : 'Call next'}
                </button>
              </>
            )}
          </div>

          <WebsitePanel website={call?.website || ''} />

          {call && (
            <div className="quickdial-controls">
              {!ended && (
                <div className="quickdial-controls-row">
                  {assignedToRep && !onCall && <button className="btn-admin primary" type="button" disabled={voice.connecting} onClick={reconnectAudio}>
                    {voice.connecting ? 'Connecting audio…' : 'Reconnect audio'}
                  </button>}
                  <button className={`btn-admin ${muted ? 'primary' : ''}`} type="button" disabled={!onCall} onClick={toggleMute}>
                    {muted ? 'Unmute' : 'Mute'}
                  </button>
                  <button className="btn-admin" type="button" disabled={action.busy} onClick={hangUp}>
                    Hang up &amp; call next
                  </button>
                </div>
              )}

              {followUp.callId === call.id ? (
                <FollowUpPrompt
                  label={followUp.disposition === 'booked_meeting' ? 'Meeting booked' : 'Call back'}
                  busy={action.busy}
                  onCancel={() => setFollowUp({})}
                  onConfirm={at => finish(call, followUp.disposition, at)}
                />
              ) : (
                <OutcomeRow label="How did it go?" busy={action.busy} onPick={pick(call)} />
              )}
            </div>
          )}

          {/* The server replaces a finished call immediately, so the previous
              one can end while its outcome is still unrecorded. It gets its own
              strip rather than being pushed off screen by the next prospect. */}
          {live && wrapUp && (
            <div className="quickdial-controls quickdial-pending-wrap">
              {followUp.callId === wrapUp.id ? (
                <FollowUpPrompt
                  label={followUp.disposition === 'booked_meeting' ? 'Meeting booked' : 'Call back'}
                  busy={action.busy}
                  onCancel={() => setFollowUp({})}
                  onConfirm={at => finish(wrapUp, followUp.disposition, at)}
                />
              ) : (
                <OutcomeRow
                  label={`Still to record — ${wrapUp.companyName || wrapUp.displayName || 'previous call'}`}
                  busy={action.busy}
                  onPick={pick(wrapUp)}
                />
              )}
            </div>
          )}
        </div>
      )}

      {blocker && (
        <div className="admin-note quickdial-blocker">
          <strong>{blocker}</strong>
          {running && <button className="btn-admin" type="button" disabled={action.busy} onClick={dialAgain}>Try again</button>}
        </div>
      )}
      {voiceError && <p className="admin-error">{voiceError}</p>}
      {action.error && <p className="admin-error">{action.error}</p>}
    </div>
  );
}
