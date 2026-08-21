# open-quake

> **Disclaimer:** open-quake is an independent third-party community project. It is not affiliated with, endorsed by, maintained by, verified by, certified by, or officially supported by DECOKEE. DK-Suite is the official software for DECOKEE Quake. open-quake is not an official open-source version of DK-Suite. Use of open-quake is at your own risk.

An open driver and touchscreen launcher for the **DK-QUAKE / ARIS-68** — the
1920×480 touchscreen-plus-knob macro device (sold with the closed-source
DK-Suite app). `open-quake` talks to it directly over HID, with no vendor
software running.

![open-quake on the DK-QUAKE](docs/showcase.png)

*From top: the grid launcher · a merged-tile Media grid · the flip-clock app · a [Windy](https://www.windy.com) weather map and a [Home Assistant](https://www.home-assistant.io) dashboard — each with the knob's RGB ring lit a different color.*

### **[⬇ Download for Windows](https://github.com/TeeJS/open-quake/releases/)** &nbsp;·&nbsp; or [build from source](docs/building.md)

> **Switching pages:** the panel shows one page at a time — **double-click the knob** to open the page selector, rotate to highlight a page, then press to switch. open-quake shows this tip right on the panel the first time you launch it.

It gives you:

- **A multi-grid launcher** — each page is a grid of tiles; tap a tile — or click it
  with your PC mouse — to open an app, URL, shell command, file, a system action
  (lock screen), or jump to another open-quake page. Icons can be an emoji, the
  program's own icon, or a custom image. → [Editor](docs/editor.md)
- **Web dashboard pages** — a page can be a live web view (Home Assistant, Grafana,
  a status page…) shown full-screen; the knob scrolls, a tap clicks, logins persist,
  with per-page auth (HA token, Basic, custom headers). → [Dashboards](docs/dashboards.md)
- **Home Assistant integration** — set your HA URL + long-lived token once in
  **Settings → Auth**, and three things light up: a **Home Assistant Dashboard** app
  (pick from your real dashboards in a dropdown, with optional kiosk-mode flags to hide
  HA's header/sidebar), **HA entity tiles** (tap a tile to call a service on a light /
  switch / media player / scene / automation / …, filtered by device type, room, label,
  or favorites), and **real MDI icons** rendered live from jsDelivr so tiles look like HA
  does. → [Home Assistant](docs/home-assistant.md)
- **Knob control** — rotate for volume (or dashboard scroll), single-click to mute,
  **double-click for the page selector**, and **hold to talk** (voice input). The
  knob's **RGB ring** is configurable. → [Settings](docs/settings.md)
- **Bundled apps** — a Flip Clock, a **World Clock** (US time zones or a pick of world
  cities, digital or analog), a **[Music controller](docs/music.md)** (now-playing +
  transport + app grid), a **[Meeting](docs/meeting.md)** app (one-tap mute/video/accept
  /decline/leave for Zoom and Teams, plus recording — see below), a **[System Monitor](docs/system-monitor.md)** (live
  CPU/GPU/RAM/disk/network/battery), an **[Open WebUI chat](docs/ai-chat.md)** you can
  **talk to by holding the knob**, a **[Microsoft 365](docs/apps.md)** panel (sign in with
  your Microsoft account for live profile, presence, and upcoming-calendar view, plus up to
  eight configurable app shortcuts and one-tap **Join meeting**), and **[AI Voice](docs/ai-voice.md)**
  — one app, five backends: a real **Claude Code**, **Codex**, or **Copilot** agent session on the
  panel, or plain chat against your **Open WebUI** server or **any OpenAI-compatible API**
  (OpenAI, DeepSeek, OpenRouter, LiteLLM/Ollama — your own key) — tap the knob to start/stop a
  hands-free conversation, with touch approvals, a full text transcript, and switchable **AI
  profiles** (Translator, Summarizer, Writer, … — editable instructions that reshape the AI in one
  tap). → [Apps](docs/apps.md)
- **Meeting recording → transcript → meeting notes** — the Meeting app **records your
  calls** (your mic on the left channel, everyone else on the right; can auto-start with
  Zoom/Teams calls and auto-stop on silence), then — right from the panel — sends
  recordings to a **diarizing transcription server** ([tts-sst](https://github.com/TeeJS/tts-stt-windows)
  or [meeting-diarizer](https://github.com/TeeJS/meeting-diarizer)) for a **speaker-labeled transcript**, and turns transcripts into
  **AI meeting notes** (summary, attendees, decisions, action items, cleaned transcript)
  with your locally installed **Claude Code, Codex, or Copilot CLI** — no API key — or your
  own **Open WebUI** server (local models). With the
  optional **Outlook calendar integration** (classic Outlook, COM — no tokens), each
  recording also captures its meeting's details (subject, organizer, attendees, join
  link), which sharpens speaker identification (attendee-guided matching, plus your own
  mic channel labeled with certainty) and can **name recordings after the meeting**.
  Filing options: per-date or **per-recurring-meeting folders**, a separate clean
  transcript, and a tidy `details\` layout. Multi-select queues and an on-panel notes
  reader included. → [Meeting](docs/meeting.md)
- **LucidType dictation** — system-wide voice typing: press a **global hotkey**, speak, and
  your words appear in an editable box on the panel; press apply and they paste at your **PC
  cursor** — from any app, whether or not open-quake is focused. Optional one-tap **Cleanup**
  (grammar + filler removal) and **Rewrite** (Professional / Concise / Confident / your own
  prompt) run the text through your locally installed **Claude Code, Codex, or Copilot CLI**
  or **Open WebUI** — no API key — or a direct **OpenAI-compatible endpoint**, and show a
  full-screen **word-diff review** you can refine before applying. Uses the same
  Wyoming/Whisper transcription server as the Meeting app.
- **Live Translate** — real-time speech **translation captions on the panel**: point the mic at a
  conversation, film, or meeting and watch it translated into your language, live, word by word (not
  after a pause). Powered by **[Soniox](https://soniox.com)** (cloud, ~$0.18/hr while translating) —
  paste an API key, pick a target language, done — or bring your own AI key (**DeepSeek, OpenAI, or
  any OpenAI-compatible endpoint**) paired with your local Whisper STT for per-phrase captions with
  cross-sentence context. Optional save-to-file and a global **toggle hotkey**.
  → [Live Translate](docs/live-translate.md)
- **Screensaver** — a screensaver page with **built-in animated scenes** (Waves, Starfield,
  Lava lamp, Fireflies, Flurry — drawn live, no downloads) or **your own photos and videos**
  (separate folders; photos as a crossfading slideshow or a scrapbook **collage**). Starts **by itself** after a configurable idle time and wakes back to
  exactly the page you left on any touch or knob input; also selectable manually or in the page
  rotation like any other page. → [Screensaver](docs/screensaver.md)
- **Theming** — a global **light / dark / system** mode and an **accent color** (with savable
  presets) that drives the panel, the bundled apps, and the knob's RGB ring; web dashboards
  follow the light/dark mode, and any page can override the theme in its Advanced settings.
  → [Settings](docs/settings.md)
- **A PC-side editor** — build pages of tiles, merge adjacent tiles into larger buttons,
  drag-and-drop to rearrange, then **Save** to push to the panel. → [Editor](docs/editor.md)
- **Three run modes** — run it however suits you: **Panel** drives the DK-QUAKE hardware,
  **Software** is a normal resizable desktop window (no device required), and **Monitor** uses
  the QUAKE as an ordinary extra monitor. A **first-run picker** asks which you want; switch
  anytime from **Settings** or the tray's **Run mode** menu. Software mode makes every bundled
  app — dictation, meeting notes, the agent panels — fully usable with no hardware at all.
  → [Settings](docs/settings.md)
- **Settings** — choose how it launches, **auto-rotate** through pages on a timer, toggle
  the mic, and tune the knob ring; plus a system-tray menu of quick toggles. → [Settings](docs/settings.md)
- **Reserved Display (Windows, optional)** — keep ordinary application windows from
  settling on the Quake when your primary displays disconnect; automatically suspends
  while using the Quake in Monitor Mode. → [Reserved Display](docs/reserved-display.md)

> **Status:** early but capable. Touch, knob (incl. RGB ring + hold-to-talk), grids, merged
> buttons, web dashboards, the bundled apps (clock / world clock / music / meeting / system
> monitor / AI chat / Microsoft 365 / AI Voice (Claude Code · Codex · Copilot · Open WebUI · API) / LucidType / Live Translate / Screensaver),
> the three run modes (panel / software / monitor), light/dark + accent theming, the
> on-board mic, and the editor are working and validated against real hardware. The panel is
> driven as a normal external monitor (Windows sees a 480×1920 / 1920×480 display); pushing
> frames over the HID resource channel is not implemented.

## 📖 Documentation

Detailed guides live in **[docs/](docs/README.md)**:

- [The editor](docs/editor.md) · [Web dashboards](docs/dashboards.md) · [Bundled apps](docs/apps.md)
- [Music controller](docs/music.md) · [System monitor](docs/system-monitor.md) · [Open WebUI chat + voice](docs/ai-chat.md) · [AI Voice](docs/ai-voice.md) · [Live Translate](docs/live-translate.md) · [Screensaver](docs/screensaver.md)
- [Home Assistant integration](docs/home-assistant.md) · [Settings & knob lighting](docs/settings.md) · [Reserved Display](docs/reserved-display.md) · [Building & how it works](docs/building.md) · [Device protocol](docs/DEVICE_PROTOCOL.md)

## Companion project

**[Bedrock open desk console](https://github.com/TeeJS/bedrock-console)** — an open-source
hardware project to build your own 1920×480 touchscreen + knob console for use with open-quake.
Generic parts, 3D-printable enclosure, RP2040 firmware for the knob. Firmware is built,
flashed, and verified against real hardware; enclosure parts are printable. Still early —
full assembly/wiring docs are in progress.

## Download

Grab a build from the **[Releases](https://github.com/TeeJS/open-quake/releases)** page (Windows x64):
- **`open-quake-<version>-portable.exe`** — run directly, no install.
- **`open-quake-<version>-setup.exe`** — installer (Start-menu shortcut + uninstaller).

The exe is **code-signed** (Azure Trusted Signing, publisher *Thomas Schmitz*) — so you see a
verified publisher, not "Unknown publisher." Windows SmartScreen may still show a **"Windows
protected your PC"** prompt on first download; that's reputation-based (it eases as a release
gains downloads), not a problem with the file. Confirm the publisher reads **Thomas Schmitz**,
then click **More info → Run anyway**. Plug in the DK-QUAKE, then launch; config is stored in
`%APPDATA%\open-quake`. (Linux/macOS builds would need platform-specific launch/volume work —
not done yet.)

## Licensing

Split-licensed — see **[NOTICE](NOTICE)**:

- **MIT** ([LICENSE](LICENSE)) — the launcher and editor (`app/`), original work.
- **PolyForm Noncommercial 1.0.0** ([src/LICENSE](src/LICENSE)) — every file that
  embeds the reverse-engineered protocol: the driver (`src/Aris68Connector.js`),
  the protocol notes (`docs/DEVICE_PROTOCOL.md`), and the two `tools/` scripts.
  The vendor described the comm protocol as restricted for commercial use; these
  files are **non-commercial only** unless you obtain written commercial
  permission from the protocol holders.

No vendor code, binaries, or API keys are included in this repository.

## Safety

`Aris68Connector.js` knows the firmware-download (DFU) command but never sends
it. **Do not call `enterDfu()`** — it puts the device into firmware-flash mode
and can brick it. The write-test in `tools/` only issues read-only query frames.
