// Test transcription on a local audio file, without making a phone call.
// Usage: node transcribe.js path/to/audio.mp3
import 'dotenv/config';
import { transcribeFile } from './stt.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node transcribe.js <path-to-audio>');
  process.exit(1);
}

try {
  const { text, provider } = await transcribeFile(file);
  console.log(`\n[${provider}] transcript:\n${text || '(empty)'}\n`);
} catch (err) {
  console.error('Transcription failed:', err.message);
  process.exit(1);
}
