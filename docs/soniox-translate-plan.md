# Live Translate via Soniox (cloud provider) — verified integration plan

Status: **plan + validation harness only.** No OQ renderer code written yet — deliberately gated on
the harness proving Soniox's quality + latency on a real clip first (this session's hard lesson:
never build the pipeline before proving the premise).

## Why cloud / why Soniox
Local CPU can't do live translation well (small streaming ASR + small MT compound errors; proven this
session with whisper-tiny). Even DK-Suite (the commercial DECOKEE app) runs its translate through a
cloud API. Soniox is a purpose-built **real-time speech→translated-text** WebSocket API, ~$0.18/hr,
key-only config. It's the "for the masses" provider; the user's GPU WhisperLive container is the
self-hosted provider behind the same OQ interface.

## Verified Soniox protocol (from docs, 2026-08-19)
- **WS URL:** `wss://stt-rt.soniox.com/transcribe-websocket`
- **Config (first text frame):**
  ```json
  { "api_key": "<key or temp key>", "model": "stt-rt-v5",
    "audio_format": "s16le", "sample_rate": 16000, "num_channels": 1,
    "language_hints": ["de"],
    "translation": { "type": "one_way", "target_language": "en" } }
  ```
- **Audio:** raw binary PCM frames (16-bit LE, 16 kHz, mono) after the config. Soniox does its own
  endpointing — stream continuously, no client-side VAD segmentation.
- **Responses (text frames):** `{ "tokens": [ { "text", "is_final", "translation_status":
  "original"|"translation", "start_ms", "end_ms", "confidence" } ] }`. Render the tokens where
  `translation_status === "translation"`; `is_final:false` = provisional (replace), `true` = committed.
- **End:** send an empty frame → server sends `{ "finished": true }` → closes.
- **Temp key (keeps the real key out of the browser):**
  `POST https://api.soniox.com/v1/auth/temporary-api-key`
  headers `Authorization: Bearer <real key>`, `Content-Type: application/json`
  body `{ "usage_type": "transcribe_websocket", "expires_in_seconds": 300, "max_session_duration_seconds": 3600 }`
  → `{ "api_key": "<temp key>", "expires_at": "…" }`.

## Validation harness (built — `tools/soniox-test.js`)
Streams a 16 kHz mono WAV to Soniox with one-way translation, paced in real-time 100 ms chunks, prints
live target-language captions + latency. Run on SchmitzMegaplex (reuses the `german.wav` already there):
```bash
docker run --rm -e SONIOX_API_KEY=YOURKEY -v "$PWD":/data -w /data node:20-slim \
  sh -c "npm i ws >/dev/null 2>&1 && node soniox-test.js german.wav en de"
```
Judge: is German→English correct on common words, and do captions appear within ~1–2 s? That decides go/no-go.

## OQ integration (to build once the harness passes)
Provider abstraction on the existing Live Translate app. Key handling stays server-side via temp keys.

1. **Config** (`apps/apps.json` livetranslate options + `app/config.js` box): `provider`
   (`wyoming` | `soniox`), `sonioxApiKey` (**secret** → `secretStore.js`, never sent to the renderer),
   `targetLanguage` (default `en`), `sourceHint` (optional). Keep `micDevice` etc.
2. **Main** (`app/livetranslate-host.js`): add `sonioxToken()` — POST the temp-key endpoint with the
   real key from `secretStore`, return `{ api_key, expires_at }`. Wire a `/livetranslate/soniox-token`
   route in `sysserver.js`'s voice dispatch (small addition next to `/state`/`/option`).
3. **Page** (`app/livetranslateview.js`): add a **streaming** mode for `provider==='soniox'`:
   - On start: `GET /livetranslate/soniox-token` → temp key.
   - Open `wss://stt-rt.soniox.com/transcribe-websocket`; send the config (with `translation`).
   - Capture **continuous** mic PCM at 16 kHz mono s16le (getUserMedia + AudioWorklet/ScriptProcessor —
     NOT the VAD utterance path) and send as binary frames.
   - Render `translation_status==='translation'` tokens live into the existing captions view
     (provisional tail + committed lines). Reuse the current caption DOM.
   - On stop: send empty frame, close WS.
4. **The WhisperLive/local provider** later uses the same streaming page path pointed at the local WS
   (its own protocol/adapter) — one interface, two backends; Google deferred.

## Notes / decisions
- Reuses the existing Live Translate page shell (captions view, rail, mic toggle, settings).
- The Wyoming/utterance path is effectively dead for live use; the streaming path replaces it.
- On-demand GPU (start/stop the WhisperLive container from OQ) is a separate, already-scoped piece
  (mirrors the meeting diarizer's pre/post hooks) and only applies to the local provider.
