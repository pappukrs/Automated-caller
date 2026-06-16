// Speech-to-text. Two providers, selected by STT_PROVIDER ("deepgram" | "sarvam").
// - Deepgram: great general accuracy, supports Hindi + code-switching.
// - Sarvam:  built for Indian languages/accents (Hindi, Hinglish, regional).
import fs from 'node:fs';

/**
 * Transcribe a local audio file to text.
 * @param {string} audioPath - path to an mp3/wav file
 * @returns {Promise<{ text: string, provider: string, raw: any }>}
 */
export async function transcribeFile(audioPath) {
  const buf = fs.readFileSync(audioPath);
  const provider = (process.env.STT_PROVIDER || 'deepgram').toLowerCase();
  if (provider === 'sarvam') return transcribeWithSarvam(buf);
  return transcribeWithDeepgram(buf);
}

async function transcribeWithDeepgram(buf) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set');

  const model = process.env.DEEPGRAM_MODEL || 'nova-2';
  // "multi" enables Hindi/English code-switching; set to "hi" or "en" if you prefer one.
  const language = process.env.DEEPGRAM_LANGUAGE || 'multi';
  const url = `https://api.deepgram.com/v1/listen?model=${model}&language=${language}&smart_format=true&punctuate=true`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/mpeg' },
    body: buf,
  });
  if (!resp.ok) throw new Error(`Deepgram HTTP ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  return { text, provider: 'deepgram', raw: data };
}

async function transcribeWithSarvam(buf) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('SARVAM_API_KEY is not set');

  // "unknown" lets Sarvam auto-detect the language; set e.g. "hi-IN" to force Hindi.
  const language = process.env.SARVAM_LANGUAGE || 'unknown';
  const model = process.env.SARVAM_MODEL || 'saarika:v2';

  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3');
  fd.append('model', model);
  fd.append('language_code', language);

  const resp = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': key },
    body: fd,
  });
  if (!resp.ok) throw new Error(`Sarvam HTTP ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const text = data?.transcript ?? '';
  return { text, provider: 'sarvam', raw: data };
}
