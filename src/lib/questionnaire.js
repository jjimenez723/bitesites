const callable = async (name, data) => {
  const [{ app }, { getFunctions, httpsCallable }] = await Promise.all([
    import('./firebase'), import('firebase/functions')
  ]);
  return (await httpsCallable(getFunctions(app, 'us-central1'), name)(data)).data;
};

export const loadQuestionnaire = token => callable('getQuestionnaireSession', { token });
export const submitQuestionnaire = (token, answers) => callable('submitQuestionnaire', { token, answers });

export const questionnaireErrorMessage = (error, fallback) => {
  const message = String(error?.message || '').trim();
  if (!message || /^(internal|functions\/internal)$/i.test(message)) return fallback;
  return message.replace(/^Firebase:\s*/i, '').replace(/\s*\(functions\/[a-z-]+\)\.?$/i, '');
};
