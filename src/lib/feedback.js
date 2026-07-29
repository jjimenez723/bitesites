const callable = async (name, data) => {
  const [{ app }, { getFunctions, httpsCallable }] = await Promise.all([
    import('./firebase'),
    import('firebase/functions')
  ]);
  const call = httpsCallable(getFunctions(app, 'us-central1'), name);
  const result = await call(data);
  return result.data;
};

export const loadConversationFeedback = token => callable('getConversationFeedback', { token });

export const submitConversationFeedback = payload => callable('submitConversationFeedback', payload);

export const loadEmailPreferences = token => callable('getEmailPreferences', { token });

export const saveEmailPreferences = payload => callable('updateEmailPreferences', payload);

export const feedbackErrorMessage = (error, fallback) => {
  const message = String(error?.message || '').trim();
  if (!message || /^(internal|functions\/internal)$/i.test(message)) return fallback;
  return message.replace(/^Firebase:\s*/i, '').replace(/\s*\(functions\/[a-z-]+\)\.?$/i, '');
};
