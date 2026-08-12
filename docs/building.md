# Building & how it works

## How the hardware works

open-quake drives two different knob devices through the same code path, routed by
`app/multiKnob.js`: whichever one is actually plugged in wins, checked in this order —
**Bedrock** (`app/BedrockConnector.js`, the open RP2040 knob — see the companion
[bedrock-console](https://github.com/TeeJS/bedrock-console) project) first, falling back
to **ARIS-68** (`src/Aris68Connector.js`, reverse-engineered) if no Bedrock device is
found. Both connectors emit the same internal knob-event shape, so the rest of the app
(panel, rotation, desktop focus, etc.) doesn't know or care which one is attached.

The DK-QUAKE's screen is a standard external monitor (HDMI or USB-C DisplayPort
alt-mode) recognized by Windows as a 480×1920 portrait display. A separate USB
link handles touch and control/knob/mic interfaces. Video travels over the
display cable; open-quake renders an Electron window onto that monitor, exactly
as DK-Suite did. Unplug the display cable and the panel goes dark, but the USB
side keeps working.

The USB side is two HID interfaces: a control interface (knob, mic/state,
firmware, keep-alive) and a multi-touch interface. The panel ships dark and
idle-blanks; the driver wakes it and sends a periodic keep-alive so it stays on.
The on-board mic enumerates as a standard **"5- USB PnP Audio Device"** — any app
can read it directly; `open-quake` doesn't wrap it.

Full reverse-engineered ARIS-68 protocol: [DEVICE_PROTOCOL.md](DEVICE_PROTOCOL.md).
The Bedrock knob's own (non-reverse-engineered, open) HID protocol is documented in
the bedrock-console repo's `firmware/PROTOCOL.md`.

## Build & run (Windows)

> **Use a Node LTS — 20, 22, or 24** (built and verified on **24**). **Don't use Node 25/26.**
> The native-rebuild toolchain (`@electron/rebuild`) bundles an older `yargs` that won't load
> under Node 25/26 — `npm run rebuild` dies with *"ReferenceError: require is not defined in ES
> module scope."* If you hit that, `node --version`, switch to an LTS, delete `node_modules`, and
> reinstall. (`package.json` declares `"engines": node >=18 <25`; an `.nvmrc` pins 24.)

The app's one compiled native module, **`node-hid`**, must be built for this app's
Electron ABI (**Electron 42**), *not* your host Node. (`@jitsi/robotjs` ships
ABI-stable **N-API** prebuilds, so it needs no rebuild.) A plain `npm install` tries
to build natives against your host Node and can fail, so install without scripts,
fetch the Electron binary, then rebuild `node-hid` against Electron 42:

```powershell
npm install --ignore-scripts            # packages on disk, no native build
node node_modules/electron/install.js   # fetch the Electron 42 binary
npm run rebuild                          # electron-rebuild -v 42.4.1 -f --only node-hid
npm start
```

> If `npm install` fails with `EBUSY … electron.exe`, a copy of the app is still
> running — close it first, then retry.

`npm start` / `npm run dist` also run `node build-smtc.js` first, which compiles two more
native helpers (`native/smtc-art.cs` → album-art reader, `native/smtc-control.cs` → SMTC
transport control) with the .NET Framework `csc.exe` — needs the Windows 10/11 SDK.
It's idempotent (skips already-current builds) and best-effort: a missing/failed build
just means no cover art at runtime, it won't block `npm start`.

Building the natives on modern Windows needs Visual Studio 2022 Build Tools
(Desktop C++ workload) and a Python with `distutils` (`pip install
"setuptools<81"` on Python 3.12+). Set `GYP_MSVS_VERSION=2022` if node-gyp picks
the wrong toolset.

Plug in the DK-QUAKE before `npm start`. The launcher finds the panel display,
places a borderless window on it, wakes the backlight, and starts listening for
touch and knob input.

Set the DK-QUAKE's **display orientation to Landscape** in Windows (Settings →
System → Display) so Windows treats it as a 1920×480 landscape display — that
keeps the mouse and touch aligned with what you see. open-quake auto-rotates its
render if you leave it portrait, but then a desktop mouse moved onto the panel
reads 90° off.

If your taps land on the **wrong monitor** (Windows binds touch to the primary
display by default for any HID touchscreen that doesn't include the proper
Container ID in its USB descriptor — which most generic HDMI touchscreens don't),
open the editor → **Settings → Hardware → Set up touchscreen**. That launches
Windows' built-in `multidigimon -touch` wizard, the same backend tool Tablet PC
Settings → Setup → Touch Input used to fire before Microsoft broke that UI in
Win 11 24H2.

**How to drive the wizard:** Accept the UAC prompt. The wizard shows
*"Tap this screen with a single finger to identify it as a touch screen — if
this is not the touch screen, press Enter to move to the next screen"* on each
display in sequence, starting with your primary. **Press Enter on your keyboard
to skip past every monitor that isn't the panel.** Only when the prompt window
appears on the 480-tall panel itself do you tap the panel with your finger.
That writes a persistent override under
`HKLM\SOFTWARE\Microsoft\Wisp\Pen\Digimon` that survives reboot, sleep, USB
reconnect, and primary-display swaps.

**Clear all calibrations** is only for fixing stale `tabcal` coordinate
calibration (taps land on the right display but slightly off). You don't
normally need it for initial binding — `Set up touchscreen` alone is sufficient.

## Code layout

```
src/Aris68Connector.js   the HID driver (events out, commands in)   [PolyForm NC]
docs/DEVICE_PROTOCOL.md   reverse-engineered protocol spec           [PolyForm NC]
tools/                    standalone HID probe / write-test scripts  [PolyForm NC]
app/                      the Electron launcher + PC grid editor     [MIT]
  main.js                 host: windows, IPC, launch/volume/config
  multiKnob.js            picks Bedrock or ARIS-68, whichever is plugged in
  BedrockConnector.js     the open RP2040 knob's HID driver (mirrors Aris68Connector's shape)
  secretStore.js          encrypts secret-typed config fields at rest (dispatches to backend)
  dpapi.js                Windows secret backend: raw DPAPI, no key file (see Settings & Auth docs)
  index.html              the on-panel UI (grids + web dashboards)
  config.html             the PC editor (pages, tiles, icons)
  config.default.json     seed config (copied to config.json on first run)
  sysmetrics.js           SystemView: live host metrics (systeminformation + GPU counters)
  nowplaying.js           Music: now-playing from Windows SMTC (via PowerShell)
  sysserver.js            localhost server for the served app pages (SystemView, Music, chat)
  sysview.html            SystemView: the on-panel system-monitor dashboard
  musicview.html          Music: now-playing + transport + the embedded app grid
  chatview.html           Open WebUI chat wrapper + knob push-to-talk
  ChatWidget.js           bundled Open WebUI chat widget   [vendored, MIT]
  owui-widget.css         widget styles                    [vendored, MIT]
apps/                     bundled local web apps + apps.json manifest [MIT]
```

Secrets (dashboard/HA tokens, app secret options) are encrypted at rest via `secretStore.js`,
which dispatches to a platform backend: an in-process, first-party raw Windows DPAPI Node-API
binding (`dpapi.js`, per-value, current-user scope, no key file) on Windows, and Electron
`safeStorage` (Keychain-backed) elsewhere. Run `npm run build:dpapi` to build that binding alone;
`npm start`, `npm run rebuild`, and `npm run dist` build it automatically when stale.
