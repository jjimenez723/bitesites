import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';

const functions = getFunctions(app, 'us-central1');

// Read-only by construction: the server exposes nothing but this snapshot.
export const fetchFineLineCrm = async ({ refresh = false } = {}) =>
  (await httpsCallable(functions, 'getFineLineCrm')({ refresh })).data;
