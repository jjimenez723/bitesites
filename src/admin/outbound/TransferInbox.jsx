import React, { useMemo, useState } from 'react';
import { outbound, useAction, useIncomingHybridTransfers, useLiveDoc } from './data';
import { joinHybridCall, leaveHybridVoice, prepareHybridVoice } from './voice-client';
import LiveCallWorkspace from './LiveCallWorkspace';

const LIVE_STATES = new Set(['requested', 'accepted', 'completed']);
const terminal = call => ['completed', 'cancelled', 'failed'].includes(call?.status);

export default function TransferInbox({ currentUid }) {
  const transfers = useIncomingHybridTransfers(currentUid);
  const action = useAction();
  const [workspaceCallId, setWorkspaceCallId] = useState('');
  const live = useMemo(() => transfers.rows
    .filter(call => !terminal(call) && LIVE_STATES.has(call.staffTransfer?.state))
    .sort((a, b) => Number(b.staffTransfer?.state === 'requested') - Number(a.staffTransfer?.state === 'requested')),
  [transfers.rows]);
  const call = live.find(entry => entry.id === workspaceCallId) || null;
  const session = useLiveDoc(call?.sessionId ? `dialerSessions/${call.sessionId}` : '').data;
  const pending = live[0] || null;

  const join = async (entry, accept = false) => {
    const ready = await action.run(async () => {
      await prepareHybridVoice();
      if (accept) await outbound.acceptStaffTransfer(entry.id);
      try {
        await joinHybridCall(entry.id, 'assist');
      } catch (error) {
        if (accept) await outbound.declineStaffTransfer(entry.id, 'recipient_audio_failed').catch(() => {});
        throw error;
      }
      return true;
    }, accept ? 'You joined the warm handoff. Introduce yourself before the current rep leaves.' : 'You rejoined the handoff.');
    if (ready) setWorkspaceCallId(entry.id);
  };

  const decline = async entry => {
    const result = await action.run(() => outbound.declineStaffTransfer(entry.id, 'recipient_declined'), 'Handoff declined.');
    if (result) setWorkspaceCallId('');
  };

  const disposition = async (entry, value, context = {}) => Boolean(await action.run(
    () => outbound.hybridDisposition({
      callId: entry.id, disposition: value,
      notes: context.notes || '', followUpAt: context.followUpAt || ''
    }),
    'Disposition recorded.'
  ));

  if (!pending && !call) return null;

  return (
    <>
      {!call && pending && (
        <section className="transfer-inbox" aria-live="assertive">
          <div className="transfer-inbox-icon" aria-hidden="true">↗</div>
          <div>
            <span className="outbound-eyebrow">Warm handoff</span>
            <strong>{pending.staffTransfer?.fromName || 'A teammate'} needs you on {pending.displayName || pending.companyName || 'a live call'}</strong>
            <p>{pending.staffTransfer?.handoffSummary || pending.staffTransfer?.note || 'Join the live call, receive a verbal introduction, then take ownership when both of you are ready.'}</p>
          </div>
          <div className="transfer-inbox-actions">
            {pending.staffTransfer?.state === 'requested' ? (
              <>
                <button className="btn-admin primary" type="button" disabled={action.busy} onClick={() => join(pending, true)}>Accept & join call</button>
                <button className="btn-admin" type="button" disabled={action.busy} onClick={() => decline(pending)}>Decline</button>
              </>
            ) : (
              <button className="btn-admin primary" type="button" disabled={action.busy} onClick={() => join(pending, false)}>Rejoin handoff</button>
            )}
          </div>
          {action.error && <span className="admin-error">{action.error}</span>}
        </section>
      )}

      {call && (
        <LiveCallWorkspace
          call={call}
          session={session}
          participationMode="assist"
          onClose={() => { leaveHybridVoice(); setWorkspaceCallId(''); }}
          onDisposition={disposition}
        />
      )}
    </>
  );
}
