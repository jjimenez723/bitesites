import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = process.env.PORT || 3000;
const root = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '100kb' }));

app.post('/api/lead', (req, res) => {
  const { name, email, businessSize, services, preferredContactMethod, phone } = req.body ?? {};
  if (!name || !email || !businessSize || !Array.isArray(services) || services.length === 0) {
    return res.status(400).json({ success: false, error: 'Please complete the required fields and select a service.' });
  }
  if (preferredContactMethod === 'phone' && !phone) {
    return res.status(400).json({ success: false, error: 'Please provide a phone number for a phone consultation.' });
  }
  console.log(`[lead] ${new Date().toISOString()} ${email}`, { ...req.body, ip: req.ip });
  return res.json({ success: true });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.use((_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
}

app.listen(port, () => console.log(`BiteSites server running on http://localhost:${port}`));
