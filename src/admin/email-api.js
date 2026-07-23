import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';

const functions = getFunctions(app, 'us-central1');
const call = name => httpsCallable(functions, name);

export const listTemplates = async () => (await call('listEmailTemplates')()).data.templates;
export const saveTemplate = async template => (await call('saveEmailTemplate')(template)).data;
export const deleteTemplate = async id => (await call('deleteEmailTemplate')({ id })).data;
export const sendTemplateEmail = async data => (await call('sendAdminEmail')(data)).data;
