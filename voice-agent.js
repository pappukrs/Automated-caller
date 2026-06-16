// One live phone conversation: Plivo audio <-> Deepgram STT -> Claude -> ElevenLabs TTS.
//
// Audio codec is mu-law (G.711 u-law) at 8 kHz end-to-end, the telephony standard —
// Plivo, Deepgram, and ElevenLabs are all told to use it, so no transcoding is needed.
//
// Pipeline per turn:
//   caller speaks -> Plivo "media" frames -> Deepgram (live STT)
//   Deepgram final transcript -> Claude (streaming) -> sentences -> ElevenLabs (streaming TTS)
//   TTS mu-law bytes -> Plivo "playAudio" frames -> caller hears the reply
//
// NOTE: the live audio path can only be fully validated on a real call. The protocol
// details (Plivo event names, Deepgram params) are isolated in clearly marked spots.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, executeTool } from './tools.js';
import * as store from './store.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

// Spoken-reply system prompt. Kept short and "voice-first" so replies are concise.
// (Thinking is left OFF for latency; we instruct it to answer with only the spoken line.)
const SYSTEM_PROMPT =
  process.env.AGENT_SYSTEM_PROMPT ||
  `You are a friendly dental-clinic phone receptionist. You are speaking out loud on a live ` +
  `phone call, so reply with ONLY the words to be spoken — no markdown, no lists, no stage ` +
  `directions. Keep replies to one or two short sentences and ask one question at a time. ` +
  `You can check appointment availability, book appointments, and send an SMS confirmation ` +
  `using your tools. Always check availability before offering a time, and confirm the ` +
  `caller's name and the slot before booking.`;

export class VoiceAgent {
  /** @param {WebSocket} plivoWs - the Plivo media-stream socket for this call */
  constructor(plivoWs) {
    this.plivo = plivoWs;
    this.anthropic = null; // created lazily on first turn (reads ANTHROPIC_API_KEY)
    this.history = []; // [{role, content}] conversation so far
    this.callId = randomUUID();
    this.callerNumber = '';
    store.startCall(this.callId);
    this.deepgram = null;
    this.speaking = false; // is the bot currently sending TTS audio?
    this.ttsAbort = null; // AbortController for the in-flight TTS request
    this.claudeStream = null; // in-flight Claude stream (for barge-in)

    this.openDeepgram();
    this.wirePlivo();
  }

  // ---- Plivo side -----------------------------------------------------------

  wirePlivo() {
    this.plivo.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.event) {
        case 'start':
          this.callerNumber = msg.start?.from || msg.start?.callerNumber || '';
          console.log(`[call] media stream started (callId ${this.callId})`);
          break;
        case 'media':
          // Plivo sends base64 mu-law in msg.media.payload — forward raw bytes to Deepgram.
          if (msg.media?.payload && this.deepgram?.readyState === WebSocket.OPEN) {
            this.deepgram.send(Buffer.from(msg.media.payload, 'base64'));
          }
          break;
        case 'stop':
          console.log('[call] media stream stopped');
          this.cleanup();
          break;
      }
    });

    this.plivo.on('close', () => this.cleanup());
  }

  /** Send a chunk of mu-law audio to the caller. */
  sendAudio(mulawBuf) {
    if (this.plivo.readyState !== WebSocket.OPEN) return;
    this.plivo.send(JSON.stringify({
      event: 'playAudio',
      media: { contentType: 'audio/x-mulaw', sampleRate: '8000', payload: mulawBuf.toString('base64') },
    }));
  }

  /** Tell Plivo to drop any audio it has buffered (used for barge-in). */
  clearAudio() {
    if (this.plivo.readyState !== WebSocket.OPEN) return;
    this.plivo.send(JSON.stringify({ event: 'clearAudio' }));
  }

  // ---- Deepgram live STT ----------------------------------------------------

  openDeepgram() {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) { console.error('[stt] DEEPGRAM_API_KEY not set — STT disabled'); return; }

    const language = process.env.DEEPGRAM_LANGUAGE || 'multi';
    const model = process.env.DEEPGRAM_MODEL || 'nova-2';
    const params = new URLSearchParams({
      encoding: 'mulaw', sample_rate: '8000', model, language,
      punctuate: 'true', interim_results: 'true', endpointing: '300', vad_events: 'true',
    });

    this.deepgram = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${key}` },
    });

    this.deepgram.on('open', () => console.log('[stt] Deepgram connected'));
    this.deepgram.on('error', (e) => console.error('[stt] Deepgram error:', e.message));
    this.deepgram.on('message', (raw) => this.onDeepgram(JSON.parse(raw.toString())));
  }

  onDeepgram(data) {
    // Caller started talking while the bot was speaking -> barge in.
    if (data.type === 'SpeechStarted' && this.speaking) this.bargeIn();

    if (data.type !== 'Results') return;
    const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;

    // Only act on a finalized utterance (speech_final = caller paused).
    if (data.is_final && data.speech_final) {
      console.log(`[caller] ${transcript}`);
      this.handleUtterance(transcript);
    }
  }

  // ---- The turn: Claude -> TTS ----------------------------------------------

  async handleUtterance(text) {
    if (!process.env.ANTHROPIC_API_KEY) { console.error('[claude] ANTHROPIC_API_KEY not set — brain disabled'); return; }
    this.anthropic ??= new Anthropic();
    this.history.push({ role: 'user', content: text });
    store.logCallTurn(this.callId, 'caller', text);
    this.speaking = true;

    try {
      // Tool-use loop: Claude may call a tool, we run it, then it speaks the result.
      for (let round = 0; round < 5; round++) {
        const finalMsg = await this.streamClaudeTurn();
        this.history.push({ role: 'assistant', content: finalMsg.content });

        if (finalMsg.stop_reason !== 'tool_use') break;

        const results = [];
        for (const block of finalMsg.content) {
          if (block.type !== 'tool_use') continue;
          const out = await executeTool(block.name, block.input, { phone: this.callerNumber });
          console.log(`[tool] ${block.name}(${JSON.stringify(block.input)}) -> ${out}`);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
        }
        this.history.push({ role: 'user', content: results });
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.error('[claude] error:', err.message);
    }
  }

  /** Stream one Claude turn, flushing speech sentence-by-sentence. Returns the final message. */
  async streamClaudeTurn() {
    let buffer = '';
    let full = '';

    const stream = this.anthropic.messages.stream({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: this.history,
    });
    this.claudeStream = stream;

    stream.on('text', (delta) => {
      buffer += delta;
      full += delta;
      const match = buffer.match(/^(.*?[.!?])\s+(.*)$/s);
      if (match) {
        this.speak(match[1]);
        buffer = match[2];
      }
    });

    try {
      const finalMsg = await stream.finalMessage();
      if (buffer.trim()) this.speak(buffer); // flush remainder
      if (full.trim()) {
        store.logCallTurn(this.callId, 'bot', full.trim());
        console.log(`[bot] ${full.trim()}`);
      }
      return finalMsg;
    } finally {
      this.claudeStream = null;
    }
  }

  /** Synthesize one piece of text with ElevenLabs and stream it to the caller. */
  async speak(text) {
    const key = process.env.ELEVENLABS_API_KEY;
    const voice = process.env.ELEVENLABS_VOICE_ID;
    if (!key || !voice) { console.error('[tts] ELEVENLABS_API_KEY/VOICE_ID not set — TTS disabled'); return; }

    this.ttsAbort = new AbortController();
    try {
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=ulaw_8000`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5' }),
          signal: this.ttsAbort.signal,
        },
      );
      if (!resp.ok) { console.error('[tts] ElevenLabs HTTP', resp.status, await resp.text()); return; }

      // Stream mu-law bytes straight to Plivo as they arrive.
      for await (const chunk of resp.body) {
        this.sendAudio(Buffer.from(chunk));
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.error('[tts] error:', err.message);
    }
  }

  /** Caller interrupted: stop talking immediately. */
  bargeIn() {
    console.log('[call] barge-in — caller interrupted');
    this.speaking = false;
    this.clearAudio();
    this.ttsAbort?.abort();
    this.claudeStream?.abort?.();
  }

  cleanup() {
    store.endCall(this.callId);
    try { this.deepgram?.close(); } catch {}
    try { this.ttsAbort?.abort(); } catch {}
    try { this.claudeStream?.abort?.(); } catch {}
  }
}
