// A one-line human session can prepare its browser conference while the phone
// rings. Assignment and answer detection remain server-owned; hybrid/AI and
// parallel sessions must wait for an explicit assignment to avoid the wrong leg.
export function shouldPrepareHumanAudio(session, call) {
  return Boolean(call?.id
    && session?.status === 'active'
    && session.operatingMode === 'human'
    && Number(session.concurrency) === 1
    && session.activeCallIds?.includes(call.id)
    && (!session.rep?.activeCallId || session.rep.activeCallId === call.id)
    && ['dialing', 'ringing', 'open'].includes(call.status)
    && (!call.control?.controller || call.control.controller === 'unassigned'));
}
