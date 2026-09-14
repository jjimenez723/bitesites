// connect() returns before WebRTC is accepted. Share one pending join between
// the card and workspace, and publish the actual audio connection state.
export function createVoiceSession({ getDevice, timeoutMs = 20000 }) {
  const listeners = new Set();
  let active = null;
  let state = { connected: false, connecting: false, callId: '', mode: '', muted: false, error: '' };
  const publish = patch => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const disconnect = call => { try { call?.disconnect(); } catch { /* Already closed. */ } };
  const fail = (request, error) => {
    if (active !== request) return;
    active = null;
    clearTimeout(request.timer);
    const detail = error instanceof Error ? error : new Error(error?.message || 'Could not connect call audio.');
    const message = `${detail.message}${error?.code ? ` (code ${error.code})` : ''}`;
    publish({ connected: false, connecting: false, muted: false, error: message });
    request.reject(new Error(message));
    disconnect(request.call);
  };
  const leave = () => {
    const request = active;
    active = null;
    if (request) {
      clearTimeout(request.timer);
      request.reject(new Error('Audio connection cancelled.'));
      disconnect(request.call);
    }
    publish({ connected: false, connecting: false, callId: '', mode: '', muted: false, error: '' });
  };

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    leave,
    deviceError(error) { if (active) fail(active, error); },
    join(callId, mode = 'human') {
      if (!callId) return Promise.reject(new Error('A call id is required.'));
      if (!['human', 'listen', 'assist', 'coach'].includes(mode)) return Promise.reject(new Error('Invalid audio mode.'));
      if (active?.callId === callId && active.mode === mode) return active.promise;
      leave();
      const request = { callId, mode, call: null };
      request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
      active = request;
      publish({ callId, mode, connecting: true, error: '' });
      request.timer = setTimeout(() => fail(request, new Error('Call audio timed out. Check microphone permission and your connection, then reconnect audio.')), timeoutMs);
      (async () => {
        const device = await getDevice();
        if (active !== request) return;
        // audio:false fails getUserMedia. Monitor modes acquire audio, then
        // mute locally and in the conference TwiML before becoming audible.
        const call = await device.connect({ params: { callId, mode }, rtcConstraints: { audio: true } });
        if (active !== request) { disconnect(call); return; }
        request.call = call;
        if (['listen', 'coach'].includes(mode)) call.mute(true);
        const accepted = () => {
          if (active !== request) return;
          clearTimeout(request.timer);
          publish({ connected: true, connecting: false, muted: Boolean(call.isMuted?.()), error: '' });
          request.resolve(call);
        };
        call.on('accept', accepted);
        call.on('error', error => fail(request, error));
        for (const event of ['disconnect', 'cancel', 'reject']) {
          call.on(event, () => fail(request, new Error('Call audio disconnected. Reconnect audio if the lead is still on the line.')));
        }
        call.on('reconnecting', () => {
          if (active === request) publish({ connected: false, connecting: true, error: 'Audio interrupted. Reconnecting…' });
        });
        call.on('reconnected', accepted);
        call.on('mute', muted => { if (active === request) publish({ muted }); });
        if (call.status?.() === 'open') accepted();
        else if (call.status?.() === 'closed') fail(request, new Error('Call audio closed before connecting.'));
      })().catch(error => fail(request, error));
      return request.promise;
    },
    setMuted(muted) {
      if (!state.connected || !active?.call || !['human', 'assist'].includes(active.mode)) {
        throw new Error('Your microphone is not connected to a live call.');
      }
      active.call.mute(Boolean(muted));
      publish({ muted: active.call.isMuted() });
      return state.muted;
    }
  };
}
