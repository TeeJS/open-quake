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
  /decline/leave for Zoom and Teams), a **[System Monitor](docs/system-monitor.md)** (live
  CPU/GPU/RAM/disk/network/battery), an **[Open WebUI chat](docs/ai-chat.md)** you can
  **talk to by holding the knob**, and a **[Claude Code](docs/claude-voice.md)** app — a real
  Claude Code session on the panel, tap the knob to start/stop a hands-free conversation, with
  touch approvals and a full text transcript. → [Apps](docs/apps.md)
- **Theming** — a global **light / dark / system** mode and an **accent color** (with savable
  presets) that drives the panel, the bundled apps, and the knob's RGB ring; web dashboards
  follow the light/dark mode, and any page can override the theme in its Advanced settings.
  → [Settings](docs/settings.md)
- **A PC-side editor** — build pages of tiles, merge adjacent tiles into larger buttons,
  drag-and-drop to rearrange, then **Save** to push to the panel. → [Editor](docs/editor.md)
- **Settings** — choose how it launches, **auto-rotate** through pages on a timer, toggle
  the mic, and tune the knob ring; plus a system-tray menu of quick toggles. → [Settings](docs/settings.md)
- **Reserved Display (Windows, optional)** — keep ordinary application windows from
  settling on the Quake when your primary displays disconnect; automatically suspends
  while using the Quake in Monitor Mode. → [Reserved Display](docs/reserved-display.md)

> **Status:** early but capable. Touch, knob (incl. RGB ring + hold-to-talk), grids, merged
> buttons, web dashboards, the bundled apps (clock / world clock / music / meeting / system
> monitor / AI chat), light/dark + accent theming, the on-board mic, and the editor are
> working and validated against real hardware. The panel is
> driven as a normal external monitor (Windows sees a 480×1920 / 1920×480 display); pushing
> frames over the HID resource channel is not implemented.

## 📖 Documentation

Detailed guides live in **[docs/](docs/README.md)**:

- [The editor](docs/editor.md) · [Web dashboards](docs/dashboards.md) · [Bundled apps](docs/apps.md)
- [Music controller](docs/music.md) · [System monitor](docs/system-monitor.md) · [Open WebUI chat + voice](docs/ai-chat.md) · [Claude Code voice + text](docs/claude-voice.md)
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
