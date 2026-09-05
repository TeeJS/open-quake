'use strict';
// Kuando Busylight driver, spoken directly over USB HID — no Kuando "Busylight for UC" daemon.
//
// IMPORTANT for anyone debugging this: Windows gives one process at a time a usable handle on the
// device. If Kuando's own software is running it will fight us for it, and the symptom is a light
// that flickers or ignores us — which reads as an open-quake bug. Their software must be closed.
//
// PROTOCOL PROVENANCE — the byte layout below started from a community reference implementation
// rather than Kuando documentation, and was then VERIFIED against real hardware: a BUSYLIGHT OMEGA
// (PLENOM A/S, 0x27BB:0x3BCF) showed red, green, blue and off exactly as commanded, from these
// frames, over the 65-byte report-id-prefixed write path. It is isolated in buildReport() so it
// stays correctable in one place, but it is no longer guesswork.
//
// Frame: 64 protocol bytes, written with a leading report id, so 65 bytes on the wire.
//   [0]      report id (0)
//   [1]      0x10  protocol step: jump to step 0, i.e. "show this colour now"
//   [2]      repeat
//   [3..5]   red, green, blue (0..255)
//   [6],[7]  on time, off time in 100ms units — 0 means steady rather than blinking
//   [8]      tone + volume; 0x80 is the documented-quiet value the reference uses for silence
//   [57..62] 0xFF,0xFF,0xFF,0xFF,0x06,0x93  fixed tail the device checks
//   [63]     checksum high byte, [64] checksum low byte — plain sum of bytes [0..62]
//
// KEEPALIVE: the device extinguishes itself roughly 30s after the last write. That is a feature, not
// a nuisance — it means a crashed or killed open-quake cannot leave you showing busy forever. We
// re-send every 20s to stay comfortably inside it and deliberately do not try to defeat it.

// Match on VENDOR only. This is load-bearing, not tidiness: every reference documents the Omega as
// product id 0x3BCD, but a real Omega on this desk enumerates as 0x3BCF. Hardcoding the documented
// product id finds no device at all on actual hardware.
const KUANDO_VENDOR_ID = 0x27bb;
const KEEPALIVE_MS = 20000;
const REPORT_LENGTH = 65;
const SILENT_TONE = 0x80;

// Pure: no device, no node-hid. Everything protocol-shaped lives here so it is testable.
// IF THE TEST LIGHT DOES NOTHING on some other Kuando model, start here: try a bare 64-byte write
// with every index below shifted down by one (drop buf[0]). The 65-byte form is confirmed working on
// an Omega, so suspect the model before you suspect these offsets.
function buildReport(color) {
  const c = color || {};
  const clamp = v => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  const buf = new Array(REPORT_LENGTH).fill(0);
  buf[1] = 0x10;
  buf[3] = clamp(c.r);
  buf[4] = clamp(c.g);
  buf[5] = clamp(c.b);
  buf[6] = 0;              // steady, not blinking
  buf[7] = 0;
  buf[8] = SILENT_TONE;
  buf[57] = 0xff; buf[58] = 0xff; buf[59] = 0xff; buf[60] = 0xff;
  buf[61] = 0x06; buf[62] = 0x93;
  // buf[0] is always 0, so summing [0..62] is arithmetically identical to the reference's
  // slice(0,63) — spelled this way so the range matches the frame description above.
  let sum = 0;
  for (let i = 0; i <= 62; i++) sum += buf[i];
  buf[63] = (sum >> 8) & 0xff;
  buf[64] = sum & 0xff;
  return buf;
}

// '#ff8000' | '#f80' -> {r,g,b}, scaled by brightness percent. Bad input is black rather than a throw:
// a mistyped colour in settings should show nothing, never crash the presence fan-out.
function parseColor(hex, brightnessPercent) {
  const scale = Math.max(0, Math.min(100, Number(brightnessPercent == null ? 100 : brightnessPercent))) / 100;
  let s = String(hex == null ? '' : hex).trim().replace(/^#/, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return { r: 0, g: 0, b: 0 };
  return {
    r: Math.round(parseInt(s.slice(0, 2), 16) * scale),
    g: Math.round(parseInt(s.slice(2, 4), 16) * scale),
    b: Math.round(parseInt(s.slice(4, 6), 16) * scale),
  };
}

// deps.hid is injected so tests can drive the service with a fake; production passes node-hid.
function createBusylightService(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  let hid = d.hid || null;
  let device = null;
  let deviceLabel = null;
  let lastColor = { r: 0, g: 0, b: 0 };
  let keepaliveTimer = null;
  let lastError = null;

  function loadHid() {
    if (hid) return hid;
    // Required lazily: node-hid is a native module, and a machine whose rebuild has not been run
    // should degrade to "no light" rather than take the whole app down at import time.
    try { hid = require('node-hid'); } catch (e) { lastError = 'node-hid unavailable: ' + e.message; }
    return hid;
  }

  function findDevice() {
    const h = loadHid();
    if (!h) return null;
    try {
      return (h.devices() || []).find(x => x && x.vendorId === KUANDO_VENDOR_ID) || null;
    } catch (e) { lastError = e.message; return null; }
  }

  function open() {
    if (device) return true;
    const info = findDevice();
    if (!info) { lastError = lastError || 'no Kuando Busylight found'; return false; }
    try {
      device = hid.HID ? new hid.HID(info.path) : new hid.default.HID(info.path);
      deviceLabel = info.product || 'Busylight';
      lastError = null;
      log('busylight connected: ' + deviceLabel);
      return true;
    } catch (e) {
      // Kuando's own software holding the handle lands here. Say so, because the raw message is
      // opaque and this is by far the most likely cause.
      device = null;
      lastError = 'cannot open Busylight (' + e.message + ') — is Kuando Busylight for UC running?';
      return false;
    }
  }

  function writeReport(color) {
    if (!device && !open()) return false;
    try {
      device.write(buildReport(color));
      return true;
    } catch (e) {
      // Unplugged mid-session, or the handle went stale. Drop it so the next call re-detects rather
      // than writing to a dead handle forever.
      lastError = e.message;
      try { device.close(); } catch (e2) {}
      device = null;
      return false;
    }
  }

  function startKeepalive() {
    if (keepaliveTimer) return;
    keepaliveTimer = setInterval(() => { writeReport(lastColor); }, KEEPALIVE_MS);
    if (keepaliveTimer.unref) keepaliveTimer.unref();
  }
  function stopKeepalive() {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  }

  return {
    setColor(color) {
      lastColor = color || { r: 0, g: 0, b: 0 };
      const ok = writeReport(lastColor);
      // INTENTIONAL: keepalive runs only while showing a non-black colour. An all-black keepalive
      // would hold the device awake forever and defeat its own 30s timeout — which is precisely the
      // crash failsafe this feature relies on to avoid a stuck-busy light.
      if (ok && (lastColor.r || lastColor.g || lastColor.b)) startKeepalive(); else stopKeepalive();
      return ok;
    },
    off() {
      lastColor = { r: 0, g: 0, b: 0 };
      stopKeepalive();
      return writeReport(lastColor);
    },
    isConnected() { return !!device; },
    // Cheap enough to call from the editor for a status line; does not open the device.
    detect() {
      const info = findDevice();
      return info ? { found: true, product: info.product || 'Busylight', path: info.path } : { found: false, error: lastError };
    },
    status() {
      return { connected: !!device, product: deviceLabel, error: lastError };
    },
    close() {
      stopKeepalive();
      if (device) {
        try { device.write(buildReport({ r: 0, g: 0, b: 0 })); } catch (e) {}
        try { device.close(); } catch (e) {}
        device = null;
      }
    },
  };
}

module.exports = {
  createBusylightService, buildReport, parseColor,
  KUANDO_VENDOR_ID, KEEPALIVE_MS, REPORT_LENGTH,
};
