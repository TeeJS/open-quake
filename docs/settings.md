# Settings & knob lighting

The editor's **⚙ Settings** page (top-right) holds the app- and device-level options,
split into a **Software** tab (on launch, screen rotation), a **Hardware** tab (knob
ring, microphone), a **Theme** tab (light/dark + accent color), an **Apps** tab
(which apps appear in the picker), a **Drop-In Apps** tab (manage installed drop-ins),
an **Auth** tab (Home Assistant credentials — see below), a **Meeting** tab (recording
folders, mic, transcription — see below), and a **Monitor** tab (Reserved Display
protection and what the knob does in monitor mode):

- **On launch** — open the editor window, start **minimized** to the taskbar, or run
  **tray-only** (panel + system tray, no window). open-quake always sits in the system
  tray with quick toggles (mic, knob ring, re-place panel on the device).
- **Screen rotation** — auto-cycle the panel through chosen pages on a timer. Turn it on,
  set the interval (5–3600 s), and pick which **categories** to include (grids, dashboards,
  apps); then tick **Include in rotation** on each page you want in the loop (a page rotates
  only when both its category and its own box are checked). Start or pause it any time from
  the knob's page selector (double-click), the tray menu, or a **hotkey** — click the Hotkey
  box and press a combo with a modifier (e.g. Ctrl+Alt+R) to get a global start/stop that
  works even when open-quake isn't focused. The hotkey is only live while Auto-rotate is on,
  and a combo another app (or one of your page hotkeys) already owns simply won't fire.
- **Hotkey shortcut** (per page, in that page's settings) — a global combo that jumps the
  panel to the page from anywhere, even when open-quake isn't focused. Tick **Disables
  rotation** next to it and firing the hotkey also turns auto-rotation off, so the panel
  stays put on that page until you start rotation again (knob, tray, or panel) — handy for
  a page you jump to when you need it to stay on screen.
- **Desktop focus** — auto-switch the panel to a page when a chosen desktop app becomes
  the focused window on the PC. Turn on **Auto-follow**, then add one or more **Focus
  trigger app(s)** to any page's **Advanced settings** (type a process name, or pick one
  from the **browse running apps** list). Detection polls in the background and only
  switches after the new app holds focus for a couple seconds, so quick alt-tabbing won't
  cause flicker — and manually navigating away is never overridden, since it only
  re-triggers on the next focus change. Tick **Pause auto-rotation** to hold rotation off
  for as long as a mapped app stays focused, picking back up the moment it loses focus.
- **Dashboards → Reload hotkey** — a global combo that force-reloads whatever dashboard
  page is currently showing, from anywhere, even when open-quake isn't focused. Switching
  away to another page and back does **not** reload a dashboard on its own (that's what
  keeps its session/scroll state across page switches) — this hotkey is the way to force
  one. Only acts while a dashboard page is on screen; does nothing on a grid or app page.
- **Knob ring** — the RGB ring around the knob. Pick an **effect** (the 44 QMK
  RGB-matrix modes, or *All Off* to turn it off), a **color**, **brightness**, and
  **effect speed**. By default the ring **follows the Theme accent** (below); tick
  **Override theme accent** to set its hue/saturation by hand instead. Changes apply to
  the ring **instantly**; **Save to device** writes them to the device's own memory so
  they persist across power-cycles.
- **Knob behavior** (under the ring controls) — what **turning** and **clicking** the knob
  does, set per page **kind** (grid / dashboard / app):
  - **Turn** — *Scroll pages* (default: previous/next page), *System volume*, *Scroll in
    window* (scrolls the page, e.g. a dashboard or the Music lyrics), or *Select button*
    (highlights tiles one-by-one with a thick accent border; wraps around).
  - **Click** — *Start/stop rotation* (default; shows an on-screen indicator), *System audio
    toggle* (mute), or *Enter* (activates the highlighted button, play/pauses the Music app,
    or otherwise sends a real Enter key to the PC).
  - **Per-page override** — any page can override its kind's defaults in that page's
    **Advanced settings** (tick *Knob → Override*). A **double-click** always opens the page
    selector regardless.
- **Microphone** — the on-board mic's LED lights whenever the mic is enabled (it's a
  single hardware switch). Choose whether it's on at launch, and toggle it any time from
  the tray menu or a **System → mic** tile.
- **Theme** — one global look for everything on the panel:
  - **Appearance** — *System* (follow Windows light/dark), *Light*, or *Dark*. Applies to
    the panel grid, the clocks, and the bundled apps, and is passed to web dashboards as the
    browser light/dark (`prefers-color-scheme`).
  - **Accent color** — a single accent with up to **6 savable presets** (*＋ Save current*
    stores the picker's color, click a preset to apply it, right-click a preset to remove
    it). The accent drives the clock digits/hands, the tile-tap highlight, the music play
    button, and the **knob LED ring**.
  - **Per-page override** — any page can override the global appearance and/or accent for
    just itself, in that page's **Advanced settings** in the editor (e.g. one light page
    while the rest stays dark). Web dashboards follow the global light/dark only.
  - Theme changes apply when you **Save**.
- **Apps** — show or hide each bundled app in the editor's **+ App** picker (it only
  affects the picker, not pages already built on an app). A **show developer apps**
  toggle reveals extra developer-built apps, hidden by default.
- **Reserved Display** (Monitor tab, Windows only) — prevents ordinary application
  windows from remaining on the Quake while the panel is active. A window dropped there
  is returned to a non-Quake display. If every other display disconnects, eligible
  windows are recoverably minimized with their last placement cached, then restored when a
  display returns. Open Quake windows, shell/taskbar surfaces, tool windows, cloaked
  windows, and secure-desktop UI are excluded. This setting is off by default.
- **Monitor Mode** — intentionally exposes the Quake as a normal Windows desktop
  monitor. Reserved Display protection is suspended for the duration of Monitor Mode and
  resumes when it exits; the USB panel keepalive continues in either mode.

The ring is driven over the device's QMK VIA lighting channel; settings are stored in
`%APPDATA%\open-quake` and re-applied on connect.

## Meeting

Recording and transcription for the Meeting panel (details in [meeting.md](meeting.md)):

- **Unprocessed Recordings** — where new recordings land. Blank =
  `Documents\OpenQuake Meetings\unprocessed`. (Recordings from before v0.4.8 that sat in
  the old default `Documents\OpenQuake Meetings` root are moved into `unprocessed\`
  automatically at launch, only when this setting is blank.)
- **Processed Recordings** — where transcribed recordings and their transcripts are
  moved. Blank = `Documents\OpenQuake Meetings\processed`.
- **Organize by date** — files each processed recording into `YYYY\MM\` subfolders under
  the Processed folder, keyed to the date it was processed.
- **Microphone** — the mic recorded as your channel. This must be the same mic you use
  with Teams; it can also be changed from the panel's Settings row.
- **Transcription Server** — the tts-sst / meeting-diarizer URL (either the base URL or
  the full `/transcribe` URL works; default `http://127.0.0.1:10301/transcribe`). Wire
  protocol: [meetings-api.md](meetings-api.md). Changes apply when you **Save** (button
  at the top of the settings page and in the footer).
- **Analysis AI** — **Claude**, **ChatGPT Codex**, or **GitHub Copilot**: which locally installed CLI turns a
  transcript into meeting notes. Uses that tool's own login; open-quake stores no API key.
- **Auto-record / Call apps / Stop after silence / Echo-gate** — unchanged recording
  behavior options.
- **Advanced → Pull meeting information from my calendar** — off by default. Choose a
  **Calendar source**:
  - **Classic Outlook (this PC)** attaches to the running OUTLOOK.EXE through COM and
    uses its signed-in MAPI profile; no OAuth or app registration is needed. **Check
    Connection** fills the Account dropdown. Set the Calendar folder (usually
    "Calendar"). The new Outlook (olk.exe) has no COM interface.
  - **Microsoft 365 (Graph)** reads the signed-in user's Microsoft 365 calendar with the
    existing delegated Microsoft connection and `Calendars.Read`. **Check Connection**
    starts browser sign-in when needed; complete it and check again. This source does not
    require classic Outlook to be running. Microsoft sign-in and encrypted token storage
    are shared with the Office panel and can also be managed on the Auth tab.

  Both sources select the meeting the same way: if the next :00/:30 boundary is under
  5 minutes away, the meeting starting then wins; otherwise the meeting containing the
  current time wins. They save subject, organizer, attendees, body, join link, and other
  metadata as `<recording>.json` beside the WAV. The file travels through transcription,
  and its attendee names improve speaker identification. An ad-hoc call with nothing
  scheduled saves nothing. Optional comma-separated **Skip prefixes** (for example
  `Canceled:, Focus time`) keep non-meetings out of either lookup.
- **Advanced → Separate recurring meetings** — when a recurring meeting (per its
  calendar info) is analyzed, its file set moves from the date folder to
  `YYYY\<Meeting-Name>\` (name sanitized like the OpenHiNotes pipeline). Un-analyzed
  meetings stay in the date folders so they're easy to find.
- **Advanced → Append meeting name to filename** — renames a finished recording to
  `<timestamp>-<Meeting Name>.wav` (sidecar too) when the calendar matched a meeting; all
  later files inherit the name. Requires calendar meeting info; the rename happens when
  the recording stops (an open file can't be renamed).
- **Advanced → Separate Clean Transcript** — the analysis `.md` keeps the notes only;
  the cleaned transcript saves as `<name>-clean_transcript.txt`. (The split keys off
  the prompt's `## Transcript` heading — a custom prompt without it falls back to the
  combined file.)
- **Advanced → Use Details Folder** — at analysis, everything except the notes `.md`
  (WAV, transcript JSON, meeting info, clean transcript) moves into a `details\`
  subfolder of the meeting's folder — date folders and recurring-meeting folders alike.
- **Advanced → Speaker threshold** — optional speaker-identification cosine cutoff
  (e.g. `0.70`) sent with each transcription; blank = the server's default. When a
  recording has calendar meeting info, its attendee list (organizer + required +
  optional) is sent along automatically — the diarizer penalizes enrolled speakers not
  on the list, reducing false speaker matches.
- **Advanced → My name** — your enrolled speaker name. When set, it's sent as
  `me_name` with each transcription: since your mic is the isolated left channel, the
  server labels your voice with certainty (channel-guided ID) instead of relying on the
  cosine threshold. Blank = off. In hybrid meetings, in-room voices share your mic
  channel and still go through normal identification.

## Auth (Home Assistant)

The **Auth** tab holds credentials shared across open-quake features that talk to a
single server. Today that's just Home Assistant.

- **Use Home Assistant** — off by default. When on, open-quake caches your HA
  configuration (dashboards, areas, devices, entities, floors, labels) at launch and
  exposes the **Home Assistant Dashboard** app and **HA entity** tile type.
- **URL** — your HA base URL (e.g. `https://ha.example.com` or `http://homeassistant.local:8123`).
- **Long-Lived Access Token** — create one in HA (profile → Security → bottom of the
  page). Stored **encrypted at rest** — on Windows via per-value DPAPI (tied to your
  Windows login, no key file to lose across restarts), the same secret store
  per-dashboard HA tokens and app secret options use. macOS uses Keychain-backed
  Electron `safeStorage` instead.
- **Refresh Configuration** — pulls a fresh copy of the registries from HA. If you
  toggle Use HA or change credentials, click Refresh — it auto-saves first so the
  refresh sees your edits.
- Status line shows what loaded (`12 dashboards, 487 entities, 24 areas, …`) or any
  error.

The full HA integration guide — what gets cached, the Dashboard app, entity tiles, the
service catalog, icon resolution, memory footprint — lives in
[Home Assistant integration](home-assistant.md).
