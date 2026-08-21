# Open WebUI chat + knob push-to-talk

A bundled **Open WebUI** app puts a full chat on the panel — type (or **talk**, by holding
the knob) to your own LLM through an [Open WebUI](https://github.com/open-webui/open-webui)
server. Add it from the editor via
**+ App → Open WebUI**. It's named for the provider so you can add other chat backends as
their own apps later.

> Looking for streaming replies, voice via the Wyoming pipeline, a live model picker, and
> multi-turn memory? That's the newer **[AI Voice](ai-voice.md)** app (Open WebUI backend), built
> on the agent-panel framework and configured once on **Settings → Auth**. This widget keeps its
> own per-page endpoint fields for now; a future release may consolidate the two.

## Setup

In the editor, open the **Open WebUI** app page and fill in three fields:

| Field | What to enter |
|---|---|
| **Open WebUI chat URL** | the OpenAI-compatible chat-completions URL (see below) |
| **API key** | your Open WebUI API key (see below) |
| **Model** | a model id that exists on your server — **required** |

### The chat URL

It must be the **chat-completions** endpoint, not the server root:

- **Open WebUI:** `https://your-owui-host/api/chat/completions`
  (use **`/api/chat/completions`** — OWUI's `/v1/chat/completions` exists but rejects POST.)

### The API key

In Open WebUI: **profile/avatar (bottom-left) → Settings → Account → API Keys** —
copy the key or **Create new secret key**. If there's no API Keys section, an admin must
enable it: **Admin Panel → Settings → General → Enable API Key**.

The key is used as a `Bearer` token — you are **not** prompted to log in; the key *is* the auth.

### The model

**Required.** Leave it blank and the widget falls back to a hardcoded `gpt-4o-mini`,
which your server probably doesn't have → you'll get *"Error retrieving response."* Enter a
model id your server actually serves (whatever appears in OWUI's model dropdown).

## Voice — hold the knob to talk

**Press and hold the knob, speak, then release.** open-quake records the on-board mic while
held, sends the clip to your Open WebUI server's transcription endpoint (its **local Whisper**),
and drops the resulting text into the chat input and sends it. A **🎤 listening…** chip shows
while you hold; **… transcribing** on release.

Requirements:
- **OWUI's Speech-to-Text — tested with local Whisper; other STT engines should work.** open-quake
  just posts the audio to OWUI's transcription endpoint and OWUI picks the engine, so whatever STT
  you've configured handles it — only local Whisper is verified, though. Local Whisper is OWUI's
  default: **Admin Panel → Settings → Audio → Speech-to-Text** (engine = Local / Whisper, pick a
  model like `base`/`small`). Token-free, runs in your OWUI container; no separate service.
- **The device mic must be on** (tray → mic, or "on at launch" in [Settings](settings.md)).
- The transcription endpoint is derived from your chat URL's host as
  `…/api/v1/audio/transcriptions` — so the same host serves chat and voice.

The knob's other gestures are unchanged: single-click mutes, double-click opens the page
selector. Only a **hold** triggers voice, so it never clashes.

## How it works

The chat app is a **served** app: open-quake serves its page over a loopback HTTP server at
`http://127.0.0.1:<port>/chat?endpoint=…&api_key=…&model=…`. Serving it this way (rather than
`file://`) means two things matter:

- The widget reads its config from real **`?query` params** (which `file://` would drop).
- `http://127.0.0.1` is a **secure context**, so the browser allows `getUserMedia` (the mic).
  This is why our embedded chat can do voice over plain http, while the *full* Open WebUI web UI
  needs HTTPS when you open it on a LAN IP.

Requests go straight from the panel to your OWUI host; CORS is handled by OWUI (it reflects the
loopback origin). The bundled widget is the
[open-webui-embeddable-widget](https://github.com/taylorwilsdon/open-webui-embeddable-widget)
(MIT), dark-themed to match the panel.

## Troubleshooting

- **"Error retrieving response"** — the server replied, but with no answer. Almost always a
  **wrong model** (blank → `gpt-4o-mini`) or the **wrong path** (use `/api/chat/completions`, not
  `/v1/chat/completions`). The page setup message also shows if the URL/key
  aren't set.
- **Voice does nothing on hold** — make sure you're on the chat page; the device mic is on; and
  OWUI's STT is set to local Whisper.
- **Security note** — the API key is encrypted at rest in `%APPDATA%\open-quake\config.json`
  (DPAPI on Windows, Keychain-backed on macOS), same as the Home Assistant token. It's still
  local to this device and this Windows login — don't ship that config off the device.
