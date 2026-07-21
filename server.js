// Local preview server for the production build.
//
// Lead capture no longer passes through this process. Both forms write directly
// to Firestore from the browser (see src/lib/leads.js), which is what lets the
// site deploy as a static bundle to Firebase Hosting with no server to run.
// The validation that used to live in the old /api/lead handler now lives in
// firestore.rules, where it is enforced server-side and cannot be bypassed.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = process.env.PORT || 3000;
const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

app.use(express.static(dist));

// SPA fallback so /terms and /privacy resolve on a hard refresh, mirroring the
// rewrite configured in firebase.json.
app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(port, () => console.log(`BiteSites preview running on http://localhost:${port}`));
