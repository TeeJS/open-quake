# DK-Suite feature parity

What the commercial package advertises versus what open-quake ships. Comparison sources: the
[DECOKEE Quake product page](https://www.decokee.com/products/decokee-quake-desktop-ai-assistant)
plus their [Kickstarter](https://www.kickstarter.com/projects/decokee/decokee-quake-the-ultimate-desktop-ai-copilot)
and [AI-copilot](https://www.decokee.com/pages/quake-ai-copilot) pages (as advertised 2026-08),
cross-checked against a teardown of the installed DK-Suite (v0.4.69, unpacked Electron); the
open-quake side is the current release (v0.6.0). This is the running list of what they have that we
don't — update it when either side changes.

> open-quake is an independent community project, not affiliated with DECOKEE — see the
> [README disclaimer](../README.md). Feature names in the "theirs" column are their marketing terms.

## ✅ Have (or have more)

| DK-Suite advertises | open-quake |
|---|---|
| AI Chat (credit-metered, 100 credits/mo free) | One **AI Voice** app, five backends, **no credits**: real **Claude Code / Codex / Copilot agent sessions** (tools, approvals, your existing plan), **Open WebUI** chat against your own models, or **any OpenAI-compatible API by key** (OpenAI, DeepSeek, OpenRouter, LiteLLM/Ollama). |
| OpenClaw integration ("run your favorite OpenClaw tasks with one tap" — via the OpenAI API server-side) | open-quake runs **real agent sessions natively** — Claude Code, Codex, Copilot — with tools, touch approvals, your own plan; no intermediary service. (Their one-tap *saved routines* idea is a genuine gap — see Missing.) |
| Saved AI routines as tiles (OpenClaw: capture a spoken task, save it, re-run with one tap) | **AI Routine** tiles. Save a request straight from the panel (`+ Routine` beside Send on any AI Chat page) or type one on Settings → Routines, then put it on a tile — or inside a macro. Agent-backed routines carry the **working folder** too, so one tap lands in the right repo. Theirs re-runs an API call; ours re-runs a **real agent turn**, with tools, touch approvals and spoken replies. |
| Mid-meeting [Mark] highlights (tap Mark; the summary extracts the flagged moments) | A **Highlight** column on the meeting panel: tap to open a span, tap to close it. Spans are ms offsets on the diarizer's own clock, stored in the recording's sidecar and handed to the analysis AI, which opens the notes with a **Highlights** section. Theirs marks an instant; ours marks a **range**, auto-closed if the call ends mid-span. |
| Voice commands (press-and-speak) | Knob **hold-to-talk** everywhere + tap-to-toggle conversations; your own local Whisper STT (tts-sst), no cloud dependency. |
| AI Meeting Assistant (record → transcribe → summarize) | Meeting app: stereo-split recording, auto start/stop, **speaker-diarized transcripts** (self-hosted), attendee-guided speaker ID via Outlook calendar, AI notes (summary/decisions/actions), per-meeting filing, **Joplin export**. Materially deeper than the advertised feature. |
| Translation (Silver+ paid tiers) | **Live Translate**: word-by-word streaming captions (Soniox, ~$0.18/hr) or bring-your-own AI key (DeepSeek ≈ $0.10/hr, OpenAI, OpenRouter, LiteLLM/Ollama) with cross-sentence context, save-to-file, global hotkey. Not tier-gated. |
| Instant answers | Any of the AI apps; hold the knob and ask. |
| System monitor (real-time CPU/memory/network) | The **System Monitor** app: live CPU, GPU, RAM, disk, network, battery. |
| Global mic mute (system-level, one tap) | Knob single-click defaults to **mute**; the Meeting app adds per-call mute/video for Zoom and Teams. |
| Drag-and-drop customization / preset app shortcuts | The PC-side editor: tile grids, merged tiles, per-page apps/dashboards, drag-and-drop, hotkeys. |
| Music player | Music controller: now-playing, transport, app grid, lyrics. |
| Smart home hub (use-case example) | First-class **Home Assistant integration**: entity tiles, real dashboards, MDI icons. |
| Stock dashboard / expense automation / 3D-printer control (use-case examples) | Web-dashboard pages + shell/macro tiles + HA cover the same ground generically. |
| LED ring status for recording/translation/AI states | RGB ring is theme-driven and state-driven (listening/thinking/speaking/approval), fully configurable. |
| Knob + touchscreen + gestures | Full knob support (rotate/click/double/hold), touch, page selector. |
| Credit packs / subscriptions | Nothing metered. Costs are only what your own keys/servers cost. |
| 9 Smart Profiles (knob-switchable "modes") | Teardown: their 9 "profiles" are **page layouts** (Discord/MeetAI/SysView/AI Chat/Music/Clock/…) — already open-quake **pages** with the knob selector and per-page hotkeys. The real feature inside their AI Chat — named prompt modes (theirs: 6, Chinese-only) — **shipped as AI Profiles** (PR #23): 9 editable English instruction presets on all five AI Voice backends, switchable from the panel's full-screen Profile picker, remembered per page. |
| AI-generated shortcut panels ("hold the knob and say *create a shortcut set for Photoshop masking*") | **[AI panels](ai-panels.md)**: a **Panel Builder** AI Profile — pick it on an AI Voice page, say what you want, and the proposed page is drawn as real tiles for **Accept / Try again / Cancel**. Works on all five backends; Claude and Codex can look up an app's real shortcuts. Every generated page is schema-validated before it can be saved, and anything that would run a shell/AutoHotkey command shows the literal command and needs a second explicit yes. |
| Wallpapers / screensaver ("Vivid" — teardown: a manually-selected crossfading image/video page, **no idle detection**) | **[Screensaver](screensaver.md)** (PR #24): five built-in live-drawn scenes (Waves, Starfield, Lava lamp, Fireflies, Flurry), your own photos (slideshow or scrapbook **collage**) and videos in separate folders, downloadable loops in [community-wallpapers](../community-wallpapers), and — theirs can't — **idle auto-start** (default 30 min) that wakes back to exactly the page you left. |

## ❌ Missing (the actual todo)

| Feature | What they advertise | Lift for open-quake |
|---|---|---|
| **macOS / Linux support** | Multi-OS: Windows, macOS, Linux | **Large.** The launcher/editor are Electron (portable), but launch/volume/media/loopback-audio/reserved-display code is Windows-specific (README already flags this). Realistic only as a scoped "panel + apps, minus Windows-only extras" port. |
| **Custom emoji generation** | Speak to generate custom emoji for chat apps (their OpenAI-API feature) | **Gimmick.** No equivalent; listed for completeness. |
| **Game voice control** | Mentioned in their showcase | **Unclear scope.** Nearest OQ equivalents: global hotkeys, macros, LucidType. Needs a real definition of what theirs does before it's worth chasing. |
| **Weather on the clock page** | Clock screen shows live weather by city — icon, description, temperature (v0.4.60) | **Small.** OQ already has a Flip Clock app; needs a weather widget (city lookup + icon/description/temp) added to it. |
| **Device diagnostics panel** | USB/HDMI dual-channel connection check, auto-expands whichever failed (v0.4.67/69) | **Small.** `multiKnob.js` already tracks the knob HID connect/reconnect state; add HDMI-present + touch-HID checks and a status page over that existing state. |

## 🔮 Their "coming soon" list

| They promise | open-quake today |
|---|---|
| Discord Game Controls (a Discord panel already exists in DK-Suite's page wheel per teardown; the Kickstarter pitches an always-on overlay) | Workable now with a manual page: key tiles firing Discord's global hotkeys (mute/deafen/overlay). No packaged Discord page yet — easy candidate if demand shows up. |
| OBS Studio Controls | Same today via OBS global hotkeys on key tiles. The real version would be a page speaking **obs-websocket** (scene switching, stream/record status on the panel) — moderate lift, natural fit. |
| Themes | **Already shipped**: light/dark/system + savable accent presets driving the panel, apps, and the knob ring — they're promising what open-quake has. |
| "And more" | Nothing named yet — new items land here as they announce them. |

## Notes

- Their "no cloud subscription required / open-source engine" claim still routes AI through their
  credit system — and their Kickstarter AI disclosure names the backend: everything is the OpenAI
  ChatGPT API, called server-side. open-quake's stance is stronger in practice (your CLIs, your
  servers, your keys).
- Hardware-only items (chassis, stand, transparent window, HDMI/USB wiring) are out of scope — both
  sides run the same device.
