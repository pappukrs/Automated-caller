# Automated Caller

Inbound AI telecaller. Someone calls a phone number → it listens, responds, and records.

Built in phases:

- Phase 0 — Answer a call. Pick up, speak a greeting (with recording consent), hang up.
- Phase 1 — Record the caller's message. Greeting → beep → record → save audio + metadata to `recordings/`.
- Phase 2 — Transcribe speech to text (Deepgram or Sarvam) to `<id>.txt`.
- **Phase 3 — Two-way AI conversation (real-time)** ← _you are here_. Live `STT → Claude → TTS` over a WebSocket.
- Phase 4 — Make it useful (booking, tools, call logs in a DB).

Stack: Node.js + Express. Telephony: **Plivo** (India numbers + audio streaming).

---

## Phase 0 — run it

### 1. Install

```bash
cd F:\YT\p\Automated-caller
npm install
cp .env.example .env   # then edit .env if you want to change the greeting/voice
```

### 2. Start the server

```bash
npm run dev
```

Open http://localhost:3000 — you should see `{"status":"ok","phase":0,...}`.

### 3. Expose your local server to the internet

Plivo needs a public URL to reach your machine. Use ngrok (or cloudflared):

```bash
ngrok http 3000
```

Copy the `https://....ngrok-free.app` URL it prints.

### 4. Point a Plivo number at it

1. Sign up at https://console.plivo.com and buy/rent an **India phone number** (needs KYC — start this early).
2. Create an **Application**: set the **Answer URL** to `https://<your-ngrok>.ngrok-free.app/answer` (method: POST), and the **Hangup URL** to `.../hangup`.
3. Assign that Application to your number.

### 5. Call the number

You hear the greeting, then a beep. **Speak a message and press `#`** (or stay silent for 10s).
You then hear "thank you", and the call ends.

- Your terminal logs `[record] done ...` and `[record] saved recordings/<id>.mp3`.
- The audio + a `.json` metadata file appear in `recordings/`.

> Downloading the recording needs `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` in `.env` (Basic auth on the URL).
> Without them, the call still works and the `RecordUrl` is logged — you just won't get a local copy.

That's Phase 1 done — your telecaller now takes messages. ✅

---

## Phase 2 — transcription

After each recording is saved, it's automatically transcribed to `recordings/<id>.txt`, and the
text is added to `<id>.json`. Pick a provider in `.env`:

- `STT_PROVIDER=deepgram` + `DEEPGRAM_API_KEY` — good general accuracy, Hindi/English code-switching.
- `STT_PROVIDER=sarvam` + `SARVAM_API_KEY` — built for Indian languages/accents.

### Test without making a call

Transcribe any local audio file directly:

```bash
npm run transcribe -- recordings/<some-id>.mp3
# or any mp3/wav:
node transcribe.js path/to/audio.mp3
```

You'll see the transcript printed. This is the quickest way to confirm your STT key/provider works. ✅

---

## Phase 3 — live AI conversation

Now the caller has a real two-way conversation. Instead of recording, Plivo streams the call
audio over a WebSocket and the server runs a live loop:

```
caller speaks → Deepgram (live STT) → Claude (streaming) → ElevenLabs (streaming TTS) → caller hears reply
```

Everything is μ-law 8 kHz (the telephony codec) end-to-end, so no audio transcoding is needed.
Barge-in is handled: if the caller talks while the bot is speaking, the bot stops.

### Set up

Add to `.env`:

- `ANTHROPIC_API_KEY` — Claude, the brain (https://console.anthropic.com). Model defaults to `claude-opus-4-8`; set `ANTHROPIC_MODEL=claude-haiku-4-5` for lower latency.
- `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` — text-to-speech (https://elevenlabs.io).
- `DEEPGRAM_API_KEY` — reused from Phase 2 for live STT.
- `AGENT_SYSTEM_PROMPT` — optional; defines the bot's persona.

### Point Plivo at the conversation flow

Change your Plivo Application's **Answer URL** to `https://<your-public-url>/conversation`
(the record flow stays available at `/answer`). Plivo's `<Stream>` connects back to `wss://<your-public-url>/ws`.

### Call the number

Say something — you should hear Claude reply in ElevenLabs' voice within ~1 second.

> ⚠️ The live audio path can only be fully tuned on a real call (latency, turn-taking, the exact
> Plivo stream wire-format). The protocol bits live in `voice-agent.js`, clearly marked, so they're
> easy to adjust. Files: `voice-agent.js` (the call pipeline), `server.js` (`/conversation` + `/ws`).

---

## Notes

- **Recording consent:** the greeting announces the call is recorded. Keep it.
- **Provider swap:** the only Plivo-specific part is the XML in `POST /answer`. Exotel/Twilio use a different markup; the rest of the server stays the same.
- Don't commit `.env` (already gitignored). Keep any clinic/company data out of this personal repo.
