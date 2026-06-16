import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { transcribeFile } from './stt.js';
import { VoiceAgent } from './voice-agent.js';

const app = express();

// Plivo posts call events as form-urlencoded; parse both just in case.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.resolve('recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Greeting spoken to the caller. Keep the recording-consent line — required practice in India.
const GREETING =
  process.env.GREETING ||
  'Hello, and thank you for calling. Please note this call is recorded. ' +
  'Please leave your message after the beep, and press the hash key when you are done.';

// Indian-English voice. Plivo supports Amazon Polly voices; "Polly.Aditi" is Indian English (female).
const VOICE = process.env.VOICE || 'Polly.Aditi';

// Recording limits.
const MAX_LENGTH = process.env.RECORD_MAX_LENGTH || '120'; // seconds
const SILENCE_TIMEOUT = process.env.RECORD_TIMEOUT || '10'; // seconds of silence to auto-stop

// Health check — open this in a browser to confirm the server is up.
app.get('/', (_req, res) => {
  res.json({ status: 'ok', phase: 4, message: 'Automated caller is running.' });
});

/**
 * Plivo "Answer URL" — called when a call connects.
 * Speak the greeting, then <Record> the caller. When recording finishes,
 * Plivo POSTs the recording info to the `action` URL (/recording) and follows its XML.
 * Docs: https://www.plivo.com/docs/voice/xml/record
 */
app.post('/answer', (req, res) => {
  const from = req.body.From || 'unknown';
  console.log(`[call] incoming from ${from} -> greeting + record`);

  const action = `${baseUrl(req)}/recording`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="${VOICE}" language="en-IN">${escapeXml(GREETING)}</Speak>
  <Record action="${action}" method="POST" maxLength="${MAX_LENGTH}" timeout="${SILENCE_TIMEOUT}" finishOnKey="#" playBeep="true" fileFormat="mp3" redirect="true"/>
  <Speak voice="${VOICE}" language="en-IN">We did not receive a recording. Goodbye.</Speak>
</Response>`;

  res.set('Content-Type', 'text/xml').send(xml);
});

/**
 * Called by Plivo when the recording is complete.
 * Params include RecordUrl, RecordingID, RecordingDuration, From, CallUUID.
 * We download the audio locally, save metadata, then thank the caller and hang up.
 */
app.post('/recording', async (req, res) => {
  const { RecordUrl, RecordingID, RecordingDuration, From, CallUUID } = req.body;
  console.log(`[record] done id=${RecordingID} dur=${RecordingDuration}s from=${From}`);
  console.log(`[record] url=${RecordUrl}`);

  // Respond to the call immediately so the caller isn't left waiting on the download.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="${VOICE}" language="en-IN">Thank you for your message. We will get back to you shortly. Goodbye.</Speak>
  <Hangup/>
</Response>`;
  res.set('Content-Type', 'text/xml').send(xml);

  // Download + persist in the background (don't block the call response).
  if (RecordUrl && RecordingID) {
    try {
      await saveRecording({ RecordUrl, RecordingID, RecordingDuration, From, CallUUID });
    } catch (err) {
      console.error(`[record] save failed for ${RecordingID}:`, err.message);
    }
  }
});

/**
 * Phase 3 — AI conversation. Instead of recording, stream the call audio over a
 * WebSocket so we can run live STT -> Claude -> TTS. Plivo connects to /ws.
 */
app.post('/conversation', (req, res) => {
  console.log(`[call] incoming from ${req.body.From || 'unknown'} -> AI conversation`);
  const wsUrl = `${baseUrl(req).replace(/^http/, 'ws')}/ws`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="${VOICE}" language="en-IN">Hello! This call is recorded. How can I help you today?</Speak>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" audioTrack="inbound">${escapeXml(wsUrl)}</Stream>
</Response>`;
  res.set('Content-Type', 'text/xml').send(xml);
});

// Plivo posts here after the call ends (optional, useful for logging).
app.post('/hangup', (req, res) => {
  console.log(`[call] ended. duration=${req.body.Duration || '?'}s status=${req.body.CallStatus || '?'}`);
  res.sendStatus(200);
});

/** Download the recording audio + write a metadata JSON alongside it. */
async function saveRecording({ RecordUrl, RecordingID, RecordingDuration, From, CallUUID }) {
  const headers = {};
  // Plivo recording URLs may require Basic auth with your API credentials.
  if (process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN) {
    const token = Buffer.from(`${process.env.PLIVO_AUTH_ID}:${process.env.PLIVO_AUTH_TOKEN}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }

  const resp = await fetch(RecordUrl, { headers });
  if (!resp.ok) throw new Error(`download HTTP ${resp.status}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  const audioPath = path.join(RECORDINGS_DIR, `${RecordingID}.mp3`);
  fs.writeFileSync(audioPath, buf);
  console.log(`[record] saved ${audioPath} (${buf.length} bytes)`);

  const meta = { RecordingID, From, CallUUID, RecordingDuration, RecordUrl, savedAt: new Date().toISOString(), bytes: buf.length };

  // Phase 2: transcribe the message. Don't let an STT failure lose the audio.
  try {
    const { text, provider } = await transcribeFile(audioPath);
    meta.transcript = text;
    meta.sttProvider = provider;
    fs.writeFileSync(path.join(RECORDINGS_DIR, `${RecordingID}.txt`), text);
    console.log(`[stt] (${provider}) ${RecordingID}: ${text || '(empty)'}`);
  } catch (err) {
    meta.transcriptError = err.message;
    console.error(`[stt] transcription failed for ${RecordingID}:`, err.message);
  }

  fs.writeFileSync(path.join(RECORDINGS_DIR, `${RecordingID}.json`), JSON.stringify(meta, null, 2));
}

/** Build the public base URL of this server from the incoming request (or PUBLIC_URL override). */
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}`;
}

// Minimal XML escaping so special characters in the greeting can't break the response.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// HTTP + WebSocket on the same server. Plivo's <Stream> connects to /ws.
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('[ws] Plivo media stream connected');
  new VoiceAgent(ws); // drives the whole call; cleans itself up on close
});

server.listen(PORT, () => {
  console.log(`Automated caller (Phase 4) listening on http://localhost:${PORT}`);
  console.log(`  Record flow  Answer URL:  <your-public-url>/answer`);
  console.log(`  AI conversation Answer URL: <your-public-url>/conversation`);
});
