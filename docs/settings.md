# Settings & knob lighting

The editor's **⚙ Settings** page (top-right) holds the app- and device-level options,
split into a **Software** tab (on launch, screen rotation), a **Hardware** tab (knob
ring, microphone), a **Theme** tab (light/dark + accent color), an **Apps** tab
(which apps appear in the picker), a **Drop-In Apps** tab (manage installed drop-ins),
an **Auth** tab (Home Assistant credentials — see below), and a **Monitor** tab
(Reserved Display protection and what the knob does in monitor mode):

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
