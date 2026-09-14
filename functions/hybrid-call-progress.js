const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

// Progress callbacks can arrive after AMD or completion. Never let a delayed
// ringing/answer event overwrite an established conversation or a final result.
export function hybridCallProgress(call, eventType) {
  if (TERMINAL.has(call.status)) return {};
  if (call.control?.controller && call.control.controller !== 'unassigned') return {};
  if (['answered', 'machine_answered'].includes(eventType)) return { status: 'open' };
  if (eventType === 'ringing' && !call.answeredAt) return { status: 'ringing' };
  if (eventType === 'dialing' && !call.answeredAt && !call.ringingAt) return { status: 'dialing' };
  return {};
}
