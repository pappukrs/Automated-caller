// Tiny file-based store for appointments + call transcripts. No DB server needed.
// Swap this module for Postgres/SQLite later without touching the rest of the app.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const CALLS_DIR = path.join(DATA_DIR, 'calls');
const APPTS_FILE = path.join(DATA_DIR, 'appointments.json');
fs.mkdirSync(CALLS_DIR, { recursive: true });

// Clinic hours: hourly slots 09:00–16:00.
const SLOTS = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Slots still free on a given date (YYYY-MM-DD). */
export function getAvailability(date) {
  const appts = readJson(APPTS_FILE, []);
  const taken = new Set(appts.filter((a) => a.date === date).map((a) => a.time));
  return SLOTS.filter((t) => !taken.has(t));
}

/** Book a slot. Returns { ok, reason? }. */
export function bookAppointment({ name, phone, date, time, reason }) {
  if (!getAvailability(date).includes(time)) return { ok: false, reason: 'slot_unavailable' };
  const appts = readJson(APPTS_FILE, []);
  const appt = { id: `appt_${Date.now()}`, name, phone, date, time, reason: reason || '', bookedAt: new Date().toISOString() };
  appts.push(appt);
  writeJson(APPTS_FILE, appts);
  return { ok: true, appt };
}

// ---- Call transcripts -------------------------------------------------------

function callFile(callId) { return path.join(CALLS_DIR, `${callId}.json`); }

export function startCall(callId, meta = {}) {
  writeJson(callFile(callId), { callId, ...meta, startedAt: new Date().toISOString(), turns: [] });
}

export function logCallTurn(callId, speaker, text) {
  const rec = readJson(callFile(callId), { callId, turns: [] });
  rec.turns.push({ speaker, text, at: new Date().toISOString() });
  writeJson(callFile(callId), rec);
}

export function endCall(callId) {
  const rec = readJson(callFile(callId), null);
  if (!rec) return;
  rec.endedAt = new Date().toISOString();
  writeJson(callFile(callId), rec);
}
