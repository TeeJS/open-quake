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
  affects the picker, not pages already built on an app).
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
- **Analysis AI** — **Claude**, **ChatGPT Codex**, **GitHub Copilot**, or **Open WebUI**: what
  turns a transcript into meeting notes. The three CLIs use their own login (no API key stored);
  **Open WebUI** posts to your own server using the connection on the **Auth** tab (URL, API key,
  and default model set there) — the transcript is slimmed to `Speaker: text` lines so local
  models fit it, and an analysis that would be truncated fails loudly instead of writing half
  notes.
- **Auto-record / Call apps / Stop after silence / Echo-gate** — unchanged recording
  behavior options.
- **Busy status** — off by default. Turns a busy light red while a call app has your
  microphone, and back to free when the call ends, replacing the light vendor's own
  software. It uses the same app-scoped detection as auto-record, so it never triggers
  on Claude voice or other microphone use.
  - **Call apps** is a *separate* list from the auto-record one above, because the calls
    worth showing a light for are usually more than the calls worth recording (Discord,
    Slack and Webex are in the default list; the recorder's is not).
  - **Also show busy while open-quake is recording** keeps the light on for a recording
    you started by hand, after the call app has let go of the microphone.
  - **Return to free after** is a short delay before going free. Teams releases and
    retakes the microphone when its meeting window changes; without the delay the light
    visibly blinks mid-meeting. Going *busy* is always immediate.
  - **Busy light (USB)** drives a Kuando Busylight directly. **Kuando's own "Busylight
    for UC" software must be closed or uninstalled** — Windows lets only one program hold
    the device, so with both running the light appears to flicker or ignore open-quake.
    That is the first thing to check if the light misbehaves. **Test light** confirms the
    connection; the status line beside the checkbox reports the model it found.
  - **Busylight schedule** — off by default. Restricts the Busylight to chosen days and
    hours; outside the window it stays off. Tick the days (Mon–Fri by default) and set a
    start and stop time. **Use different hours for each day** replaces the shared pair with
    a start and stop for every ticked day.
    - An end time earlier than the start runs the window **overnight**: `22:00`–`06:00` with
      Friday ticked keeps the light active until 06:00 on Saturday, without ticking Saturday.
      The window belongs to the day it started.
    - Unticking every day means the light never comes on. An unparseable time is ignored and
      the light works as if unscheduled, rather than going mysteriously dark.
    - The schedule applies to the **USB Busylight only**. The Home Assistant entity and any
      WLED light keep reporting your real status outside the window.
  - **DIY light (WLED)** drives an ESP32 running WLED over the network — enter its IP
    address. It uses the same busy and free colours.
  - **Home Assistant (MQTT)** publishes a `binary_sensor.open_quake_busy` entity, created
    automatically through MQTT discovery — nothing to configure on the Home Assistant
    side. Automations trigger on it like any other sensor, and the attributes carry why
    you are busy, which app, and since when. This is independent of the Home Assistant
    connection on the **Auth** tab, which stays read-only. The broker password is
    encrypted at rest.
  - If open-quake stops, crashes, or the PC loses power, the light goes dark on its own
    (the device requires a keep-alive) and the Home Assistant entity goes *unavailable*
    (an MQTT last-will). Neither can get stuck showing you as busy.
  - **Custom colour** is the colour the panel's **Custom** mode shows. Pick it here or on
    the panel itself.
  - On the panel, an opt-in **Busy** column shows the current state and offers four modes:
    - **Auto** — follow the microphone and the recorder. The normal setting.
    - **Busy** — force busy in the ordinary busy colour, for deep work or an in-person
      visitor that no microphone can detect.
    - **Free** — force free, even during a live call.
    - **Custom** — force busy in your own colour, so "busy because I said so" looks
      different from "busy because Teams has the mic". Tap **Custom** to switch to it using
      the colour you last chose; tap it again while it is already active to change that
      colour from eight presets. The choice is saved and survives a restart.

    The state shown at the top of the column is what you *are* right now; the four buttons
    are the mode you have *chosen*. In **Auto** those differ, which is the point.

    The **Busy** button in the panel's top bar gains a red ring while you are busy, so the
    state is visible with the column closed.
- **Advanced → Pull meeting information from my calendar** — off by default. Choose a
  **Calendar source**:
  - **Classic Outlook (this PC)** attaches to the running OUTLOOK.EXE through COM and
    uses its signed-in MAPI profile; no OAuth or app registration is needed. **Check
    Connection** fills the Account dropdown. Set the Calendar folder (usually
    "Calendar"). The new Outlook (olk.exe) has no COM interface.
  - **Microsoft 365 (Graph)** uses the installed Microsoft 365 drop-in app and its app-scoped
    `Calendars.Read` connection. Select that app's page in the editor and use its **Microsoft
    365 account → Connect** control before choosing **Check Connection** here. The panel also
    offers Connect when disconnected. This source does not require classic Outlook or a global
    Microsoft OAuth setting.

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
- **Advanced → Create task-lists for post-analysis processing** — after each analysis
  batch finishes, writes a dated checklist (`2026-08-17_10-42-13.md`) to the
  **Task-list folder** (blank = `task-list` under Processed Recordings): one checkbox
  per analyzed meeting, pointing at its `-analysis.md` (and meeting metadata when the
  calendar integration provided it) — the hand-off for pulling action items onto a
  kanban board. Only successful analyses are listed.
- **Advanced → Create Joplin notes for analyses** — after each analysis, creates a note
  in Joplin through the **Joplin API URL** (the Web Clipper service of Joplin Desktop,
  Tools › Options › Web Clipper — default port 41184) using the **API token** shown
  there (stored encrypted). Title = the recording basename, body = the analysis
  markdown, filed to **Notebook** (default `NW Pipe`), tagged `meeting notes` + the
  year + title keywords. Only tags that already exist in Joplin are applied — none are
  created; skipped tags are logged. Joplin Desktop must be running when the analysis
  finishes; a failed note is reported on the panel but never fails the analysis.
  Analyses also send the calendar meeting-info JSON and any companion Teams `.vtt`
  caption file (same folder, same timestamp prefix) to the AI as speaker-identity
  aids, and the `.vtt` is filed with the recording's other artifacts afterwards.
- **Advanced → Run commands before/after transcription** — start and stop the
  transcription server around each batch (e.g. `ssh root@host "docker start
  meeting-diarizer"` — a loaded diarizer holds ~3.4 GB of GPU memory). **Before** runs
  once when the queue goes active; open-quake then waits up to 5 minutes for the
  server's `/health` before uploading. **After** runs once when the queue drains; jobs
  arriving mid-shutdown wait, then trigger a fresh start — the commands never overlap.
  If the start command or health wait fails, every queued file gets a clear error and
  stays put. Full cmd.exe syntax, multi-line allowed, or call a `.bat`. While idle with
  this on, the panel shows "starts on demand" instead of a server-unreachable error.
- **Advanced → My name** — your enrolled speaker name. When set, it's sent as
  `me_name` with each transcription: since your mic is the isolated left channel, the
  server labels your voice with certainty (channel-guided ID) instead of relying on the
  cosine threshold. Blank = off. In hybrid meetings, in-room voices share your mic
  channel and still go through normal identification.
- **Meeting Slide Capture** (its own collapsible section) — **Enable Meeting Slide
  Capture** turns on automatic slide screenshots during a recording and adds the Slide
  Capture column to the meeting panel (see [meeting.md](meeting.md)). Options:
  **Automatically start capture when a window is selected**; **Show a notification when a
  slide is captured**; three **global hotkeys** (toggle capture / select window / manual
  capture — each needs Ctrl and/or Alt, all three distinct, blank disables one); **Limit
  window picker to app** (a process-name substring, e.g. `ms-teams`; blank shows every
  window); and **Auto-stop after inactive** minutes (0 = never; the clock resets on each
  capture). Slides save into a `<recording>-screenshots\` sidecar folder that travels and
  renames with the WAV.

## Auth (Home Assistant, Open WebUI)

The **Auth** tab holds credentials shared across open-quake features that talk to a
single server — today Home Assistant and Open WebUI.

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

### Open WebUI

One connection shared by the meeting **Analysis AI** (Meeting tab) and the
**[AI Voice](ai-voice.md)** app's Open WebUI backend:

- **URL** — the server's address (e.g. `http://192.168.1.25:3000`). Any pasted form works —
  bare host:port, trailing slash, or a full path; the app derives `/api/chat/completions` and
  `/api/models` from the origin itself.
- **API key** — created in Open WebUI under avatar → Settings → Account → API Keys (an admin may
  need to enable API keys first). Stored **encrypted at rest**, same secret store as the HA token.
- **Default model** — used wherever no per-page model is picked.
- **Test connection** — saves any pending edits, then hits `/api/models` and reports the live
  model count or a clear error (server down vs. bad key).

The existing per-page [Open WebUI chat widget](ai-chat.md) keeps its own endpoint options and is
unaffected.

## AI Profiles

The global library behind the [AI Voice](ai-voice.md) app's **Profile** button: each row is a
name plus the instruction the AI receives for the conversation (Translator, Summarizer, Writer, …).
Rename, rewrite, add, or remove rows here — changes apply the next time a profile is picked (or a
session starts). **General Chat** ships with an empty instruction, which means plain, unmodified
chat. Deleting a profile that a page was using safely falls back to the first one in the list.
