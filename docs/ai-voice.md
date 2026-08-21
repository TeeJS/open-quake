# AI Voice — one voice + text panel app, five backends

**AI Voice** puts a live AI conversation on the panel: type or talk, watch replies stream in as
text, copy exact commands out with a real cursor selection — and, with an agent backend, approve or
deny anything it wants to do, all from the touchscreen. Add it from the editor via **+ App →
AI Voice**, then pick a **Backend** on the page's options:

| Backend | What it is | Needs |
|---|---|---|
| **Claude Code** | full `claude` CLI agent session — tools, CLAUDE.md, touch approvals | the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), signed in |
| **Codex** | full `codex` CLI agent session | the Codex CLI, signed in |
| **Copilot** | full `copilot` CLI agent session | the Copilot CLI, signed in |
| **Open WebUI** | plain chat against your own Open WebUI server | the connection on **Settings → Auth** |
| **API endpoint** | plain chat against any OpenAI-compatible API — OpenAI, DeepSeek, OpenRouter, a local LiteLLM/Ollama | a base URL + API key (this page's options) |

Pages are per-instance: add several AI Voice pages with different backends (a Claude page and a
GPT page side by side), each with its own settings and jump shortcut.

The CLI backends are the same kind of session you'd get from a terminal — same config files, same
tools, same subscription auth (no API billing). The panel starts and owns its own session; it
doesn't attach to a terminal session. The chat backends (Open WebUI / API endpoint) are plain
conversation — no tools, no file access; those two hide the folder and Mode buttons entirely.

## Setup

Shared fields (all backends):

| Field | What to enter |
|---|---|
| **Backend** | which engine this page talks to (table above) |
| Speech | STT/TTS servers are global — **Settings → TTS/STT** (see [below](#wyoming-sttts)); override per page in **Advanced settings** |

CLI backends (Claude Code / Codex / Copilot) add:

| Field | What to enter |
|---|---|
| **Default folder** | where new sessions start until a folder is picked on the panel |
| **Folders root** | the parent folder the panel's **Change folder** list scans, e.g. `D:\Github` |
| **Permission mode** | that CLI's own permission levels — the choices change with the backend |
| **Touch approval** (Claude Code only) | see [Touch approvals](#touch-approvals) |

API endpoint adds:

| Field | What to enter |
|---|---|
| **Endpoint** | a preset (OpenAI / DeepSeek / OpenRouter) or any OpenAI-compatible base URL — `https://api.deepseek.com`, `http://litellm-host:4000/v1`, `http://ollama-host:11434/v1`, … |
| **API key** | stored encrypted; never reaches the panel page |
| **Model** | e.g. `gpt-4o-mini`, `deepseek-v4-flash`, or whatever your endpoint serves |

Open WebUI has no per-page connection fields — it chats against the URL/key/default model
configured once on **Settings → Auth** (shared with the meeting Analysis AI).

### Permission modes

Your call, per session, exactly as in the CLI itself. Each backend exposes its own levels —
Claude's Manual / Accept edits / Plan / Full auto; Codex's Read Only → Full Access; Copilot's
Manual → Autopilot. Switch anytime with the panel's **Mode** button; the conversation survives.

## Voice — tap the knob to start/stop talking

**One tap opens a continuous conversation; a second tap closes it** — no holding, no per-utterance
gesture: speak whenever you like while the conversation is open, the way voice mode works in the
Claude mobile app. Utterance boundaries are detected automatically (a short pause sends the current
utterance). The knob tap works out of the box on AI Voice pages — no per-page knob override needed.

**Text works at the same time, always.** The message box is never disabled by voice mode — type
mid-conversation whenever a command or variable name is easier to get right by typing, or when
you'd rather read the reply than hear it. A typed message never triggers an unsolicited spoken
reply; only a voice-started turn gets spoken back.

The transcript is real, selectable text — click-drag and Ctrl+C work like any normal page. Fenced
code blocks get a one-tap **Copy** button.

### Ring feedback

The knob's RGB ring mirrors the on-screen status, so you don't have to be looking at the screen:

| State | Ring |
|---|---|
| Idle | your normal configured ring |
| Listening | solid green |
| Thinking | breathing green |
| Speaking | solid blue |
| Awaiting your approval | breathing amber |

The ring reverts to your normal theme-driven setting the moment you leave the page, or whenever
the conversation goes back to idle.

## Touch approvals

Agent backends can ask before acting; the panel shows a full-screen overlay with the exact tool
and its input — never truncated — and large **Approve** / **Deny** buttons.

- **Claude Code** (Permission mode **Manual** + **Touch approval** on): approvals arrive through an
  external hook — see the safety notes below.
- **Codex / Copilot**: approvals are in-band protocol requests; the overlay also offers **✓ Always**
  (approve and stop asking for the rest of the session) where the protocol supports it.
- **Open WebUI / API endpoint**: nothing ever asks — a chat API can't run tools.

### The Claude hook — how it works, and why it's safe for your terminal sessions too

Turning Touch approval on registers a **global** hook in `~/.claude/settings.json` — the settings
file every Claude Code session on this machine reads. That sounds broad, but the hook only does
anything when **both** are true:

1. It's running inside a session this panel started (checked via an environment variable only the
   panel's own session sets — a normal terminal `claude` session never has it).
2. That session's permission mode is **Manual**.

Everywhere else — any terminal, any project, any other permission mode — the hook is a complete,
instant no-op. Install/removal is idempotent and additive (only ever its own entry; your other
hooks are never touched), and the settings file is backed up (timestamped) before any write.
Toggling the checkbox takes effect the next time a panel session starts. If the panel is
unreachable or doesn't respond in time, the request **fails closed** (denied) — never an
unattended auto-allow.

## Profiles (Smart Profiles)

The **Profile** button switches what the AI *is* for this conversation — a named instruction like
Translator, Summarizer, Writer, Coder, Math, or Email. Tap it for a full-screen grid of big cards;
one tap switches. Ships with 9 editable defaults; manage them (rename, rewrite, add, delete) under
**Settings → AI Profiles**. Each AI Voice page remembers its own current profile, and the editor's
**Default profile** row sets what a page starts with.

**General Chat** has an empty instruction — plain, unmodified behavior. How a switch lands depends
on the backend: API and Open WebUI pages apply it instantly mid-conversation; Claude Code quietly
restarts the session (keeping the conversation, like the Mode button); Codex and Copilot carry it
into their next message.

## Models

The panel's **Settings → Model** picker follows the backend: Claude's fixed pick list, Codex and
Copilot's discovered lists, Open WebUI's `/api/models`, or your API endpoint's `/models`. Blank =
that backend's default.

## Wyoming STT/TTS

Speech-to-text and text-to-speech run against [Wyoming](https://github.com/rhasspy/wyoming)
services, configured once under **Settings → TTS/STT** (override per page in Advanced settings):

- **No servers of your own (default):** install [tts-sst](https://github.com/TeeJS/tts-stt-windows),
  a small Windows tray app serving Whisper STT and a Piper voice locally on 127.0.0.1:10300 / 10200.
- **Your own homelab services:** point the host/port fields at your `wyoming-faster-whisper` and
  `wyoming-piper` instances.

Audio sent for transcription is 16kHz/16-bit/mono PCM; the reply's playback format is read from the
server live (Piper's sample rate varies by voice model).

## How it works

A **served** app: the page loads from `http://127.0.0.1:<port>/ai-voice`, which is what makes
`getUserMedia` (the mic) work over plain HTTP as a secure context; every server route carries the
page's backend as a sub-prefix (`/ai-voice/<backend>/…`), so each backend keeps its own session and
transcript. The main process owns one adapter per backend — a persistent CLI child for the agents
(spawned with each CLI's streaming protocol), streaming HTTP for the chat backends — streams
replies to the page over Server-Sent Events, and proxies STT/TTS through your Wyoming host over a
small hand-rolled TCP client.

## Troubleshooting

- **"CLI not found on PATH"** — install that backend's CLI and make sure it resolves from a normal
  terminal first (the editor warns on the page options when it can't find it).
- **Turn fails immediately, no reply** — CLI backends: no project directory set, or the CLI isn't
  authenticated (run it once from a terminal). API endpoint: URL/key/model not set on the page.
- **Voice does nothing on tap** — check the device mic is on (tray → mic).
- **No transcription / no speech playback** — check **Settings → TTS/STT**; confirm the services
  are reachable (with tts-sst, check its tray status — on first run it's downloading models).
- **Approvals never show up (Claude Code)** — Permission mode must be **Manual** *and* Touch
  approval on; toggling either takes effect for the *next* session.
- **Security note** — nothing here stores an agent credential: CLI auth is your existing sign-in,
  Wyoming has no auth. The API backend's key is stored encrypted at rest and used only from the
  main process. The approval hook's per-launch token is never written to disk.

## Hardware regression checklist

Run on the real panel against real Wyoming services for any change to the shared voice-panel
plumbing (host factory, sysserver routes, the shared page files):

1. **Voice turn end-to-end** (each backend) — tap knob, speak, transcript shows your words, reply
   streams, reply is spoken.
2. **Sentence-streaming speech** — a long reply starts speaking before the text finishes streaming;
   no doubled/overlapping voices.
3. **Barge-in** — mute mid-reply cuts speech instantly; folder switch mid-reply silences the old
   session's voice.
4. **Typed turn with speaker on** — mic OFF, type: reply spoken. Speaker OFF: silent, text renders.
5. **Approval overlay** — Claude Manual mode: overlay with full command + amber ring; Approve runs,
   Deny refuses. Codex/Copilot: **✓ Always** appears and sticks for the session.
6. **Mode switch** mid-session per CLI backend; conversation survives.
7. **Model switch** — pick applies; conversation survives.
8. **Folder switch** — recents commit in one tap; "Use this folder" starts fresh; name updates.
9. **Settings persist** — text size, pause tolerance, mic, speaker survive a relaunch.
10. **Transcript survives page switches** — rotate away and back: conversation repaints.
11. **Ring states** — idle → listening → thinking → speaking → approval across one Manual turn.
12. **Hook lifecycle** — during a Claude session `~/.claude/settings.json` has the PreToolUse
    entry; quitting the app removes it.
13. **Backend isolation** — two AI Voice pages (e.g. Claude + API): sessions don't bleed; knob tap
    toggles the right one; switching pages mid-turn leaves the other session intact.
14. **Slash command** — send `/model` typed: reply renders (result-only turns).
