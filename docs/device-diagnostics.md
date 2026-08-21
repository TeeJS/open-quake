# Device Diagnostics — build charter & decision log

Autonomous build (2026-08-21) of the **Device Diagnostics panel** — the last "device diagnostics"
gap on `dk-suite-parity.md`. Built without step-by-step intervention; decisions and open questions
logged here per T.J.'s instruction.

## The one thing this must do

Tell the user, at a glance on the panel itself, **which of the console's physical channels are
connected and which failed** — and it must do that identically for the **DK-QUAKE (ARIS-68)**
hardware and the open-source **[bedrock-console](https://github.com/TeeJS/bedrock-console)**,
**with or without a knob**.

DK-Suite's version (v0.4.67/69): a "USB/HDMI dual-channel connection check" that auto-expands
whichever channel failed. Ours covers the same idea, generalized to the three real channels both
consoles actually present.

## Research findings (verified against source + live hardware)

Both consoles present **three independent channels** over separate cables/endpoints:

| Channel | DK-QUAKE (Aris68) | bedrock-console | How we detect it (host-side, device-agnostic) |
|---|---|---|---|
| **Display** (HDMI) | 1920×480 DP-alt/HDMI | 1920×480 HDMI | `screen.getAllDisplays()` has a display whose bounds are 1920×480 or 480×1920 (`isDeviceDisplay` in main.js:1885) |
| **Touch** (HID) | custom "hotlotus" digitizer (`src/Aris68Connector` touch iface, VID 1810/PID 16/usage 0xff73) | standard USB HID touchscreen | `HID.devices()` has an entry with **usagePage 0x0D** (digitizer). Verified: this dev box shows one, product "hotlotus". Generic 0x0D covers both. |
| **Knob / control** (HID) | control iface VID 16728/20811 or 20498/26647, usage 0xff60 | VID 0x1209 / PID 0xBED0 / usage 0xFF00 | `HID.devices()` matches a known **control ident** (list below). The matched ident also tells us **which console** it is. |

Firmware/extra state comes from the connector layer (`multiKnob.js`): `queryFirmware()` → device
name + `X.Y.Z`; Aris68 also has `queryLuminance()` / `queryMic()`. Bedrock reports firmware on
boot/pong. These are enrichment, not the primary signal.

**Why HID enumeration, not just connector connect/disconnect events:** `Aris68Connector` tracks its
own touch iface, but `BedrockConnector` is control-only and never sees bedrock's standard touch HID.
Enumerating `HID.devices()` + `screen` in the main process gives one complete, connector-independent
picture that is correct for **both** consoles and for software mode — and it's synchronous/current,
not dependent on having caught an event.

## Decisions

1. **Surface = a served app** (`apps/diagnostics.html`, id `diagnostics`, "Device Diagnostics"),
   not a settings tab. Rationale: it's status *about the panel*, most useful shown *on* the panel,
   and served apps drop onto any grid and also run in software mode. Matches the meeting/clock apps.
2. **Data path = poll an HTTP endpoint** (`GET /device-diagnostics` on the existing localhost
   sysserver), exactly like the meeting page polls `/meeting-state`. Main computes the snapshot;
   the app renders it. ~2 s poll.
3. **Detection logic is a pure module** (`app/deviceDiagnostics.js`, model = `panelSchema.js`/
   `routines.js`) so it unit-tests without Electron. Main injects the live `HID.devices()`,
   `screen` displays, `activeName()`, and cached firmware; the module classifies.
4. **Knob is optional, never an error by itself.** A console with Display+Touch but no control HID
   is a working touch console — the Knob row reads "Not detected" (neutral/amber), not red. Only a
   missing **Display** or **Touch** is a hard fail (red), since without those the panel is unusable.
   This is how "with and without a knob" is honored.
5. **Auto-expand the worst channel.** Each channel renders as a row; a failed/degraded one expands
   with a plain-language cause + fix. If all three are OK, the header reads healthy and nothing
   expands.
6. **Software mode is a first-class state,** not an error dump: when no console HID/display is
   present, the panel says "Running in software mode — no console detected" and shows the three
   channels as "Not detected" without alarming red.

## Open questions (logged; assumption taken so the build proceeds)

- **Q: Does bedrock's touch always enumerate as usagePage 0x0D?** The README calls it a "USB HID
  touchscreen"; standard digitizers are 0x0D. **Assumption:** yes. If a bedrock unit reports a
  non-standard usage, the Touch row would false-negative; the fix is to widen the touch matcher.
  Flagged as the one cross-device risk to confirm on real bedrock hardware.
- **Q: Should diagnostics live-poll the device (queryFirmware) or read cached state?** Chose
  **cached** — main caches firmware/luminance/mic from the connector's `state` events and a
  connect-time query, so the endpoint never blocks on device I/O. Firmware shows "—" until the
  first report lands.
- **Q: One "knob present" signal, or distinguish "knob HID present" vs "knob turning"?** V1 reports
  presence only (HID enumerated). Live-input liveness (last knob/touch event time) is a possible
  later enrichment; not needed for a connection check.

## Verification

1. `npm test` incl. `test/deviceDiagnostics.test.js` — the pure classifier across: DK-Quake all-3,
   bedrock all-3, each single channel missing, no-knob (display+touch only) = healthy-with-note,
   nothing (software mode), and an unknown control HID.
2. Offscreen render (`reference_offscreen_panel_capture` technique) of `diagnostics.html` at
   1920×480 for: all healthy, a failed Display (auto-expanded), no-knob, and software mode; dark +
   light theme.
3. This dev box currently has a DK-Quake attached (a "hotlotus" digitizer is enumerated), so the
   live endpoint can be sanity-checked against real hardware.
