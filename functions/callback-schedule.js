// A rep may schedule one additional attempt without resetting call history.
// Once that attempt is placed, its incremented counter consumes the allowance.
export function pendingCallback(target = {}) {
  const callback = target.callback;
  const scheduledFor = callback?.scheduledFor instanceof Date
    ? callback.scheduledFor : callback?.scheduledFor?.toDate?.();
  return callback?.sourceCallId && scheduledFor && Number.isFinite(scheduledFor.getTime())
    && callback.attemptNumber === Number(target.attemptCount || 0) + 1
    ? { ...callback, scheduledFor } : null;
}
