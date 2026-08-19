// The public consultation booker's data layer.
//
// Deliberately thin: availability and the booking itself are decided by
// `functions/public-booking.js`, which runs the same engine as the voice agents
// and the console. Nothing here may decide what is bookable — a browser that
// disagrees with the server about a free slot loses at commit time anyway.

const callable = async (name, data) => {
  const [{ app }, { getFunctions, httpsCallable }] = await Promise.all([
    import('./firebase'),
    import('firebase/functions')
  ]);
  const call = httpsCallable(getFunctions(app, 'us-central1'), name);
  const result = await call(data);
  return result.data;
};

export const loadBookingSlots = ({ fromMs, toMs }) =>
  callable('getPublicBookingSlots', { fromMs, toMs });

export const bookConsultation = payload =>
  callable('bookPublicAppointment', { ...payload, pagePath: window.location.pathname });

/**
 * Firebase wraps callable errors; show the sentence the function wrote, not the
 * code. The raw error still reaches the console — a visitor gets "try again",
 * but whoever is debugging should not have to guess between a cold function, a
 * failed App Check attestation and a function that was never deployed.
 */
export const bookingErrorMessage = (error, fallback) => {
  console.warn('[booking]', error?.code || '', error?.message || error);
  const message = String(error?.message || '').trim();
  if (!message || /^(internal|not-found|functions\/(internal|not-found))$/i.test(message)) return fallback;
  return message.replace(/^Firebase:\s*/i, '').replace(/\s*\(functions\/[a-z-]+\)\.?$/i, '');
};
