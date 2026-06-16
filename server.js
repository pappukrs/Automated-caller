import 'dotenv/config';
import express from 'express';

const app = express();

// Plivo posts call events as form-urlencoded; parse both just in case.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Greeting spoken to the caller. Keep the recording-consent line — required practice in India.
const GREETING =
  process.env.GREETING ||
  'Hello, and thank you for calling. Please note this call is recorded for quality purposes. ' +
  'Our automated assistant is being set up and will be with you shortly. Goodbye.';

// Indian-English voice. Plivo supports Amazon Polly voices; "Polly.Aditi" is Indian English (female).
const VOICE = process.env.VOICE || 'Polly.Aditi';

// Health check — open this in a browser to confirm the server is up.
app.get('/', (_req, res) => {
  res.json({ status: 'ok', phase: 0, message: 'Automated caller is running.' });
});

/**
 * Plivo "Answer URL" — called when a call connects.
 * We return Plivo XML telling Plivo what to do: speak a greeting, then hang up.
 * Docs: https://www.plivo.com/docs/voice/xml/
 */
app.post('/answer', (req, res) => {
  const from = req.body.From || 'unknown';
  console.log(`[call] incoming from ${from} -> speaking greeting`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="${VOICE}" language="en-IN">${escapeXml(GREETING)}</Speak>
  <Hangup/>
</Response>`;

  res.set('Content-Type', 'text/xml').send(xml);
});

// Plivo posts here after the call ends (optional, useful for logging).
app.post('/hangup', (req, res) => {
  console.log(`[call] ended. duration=${req.body.Duration || '?'}s status=${req.body.CallStatus || '?'}`);
  res.sendStatus(200);
});

// Minimal XML escaping so special characters in the greeting can't break the response.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

app.listen(PORT, () => {
  console.log(`Automated caller (Phase 0) listening on http://localhost:${PORT}`);
  console.log(`  Answer URL (give this to Plivo): <your-public-url>/answer`);
});
