'use strict';
// deviceDiagnostics.js — the panel's connection check (MAIN PROCESS; pure, no electron)
//
// Reports the three physical channels every open-quake console presents, independent of which
// console it is (DK-QUAKE / ARIS-68, or the open-source bedrock-console) and whether a knob is
// attached:
//   - Display : the 1920x480 panel over HDMI / DP-alt   (from screen.getAllDisplays())
//   - Touch   : the capacitive touchscreen HID           (from HID.devices(), digitizer usage 0x0D)
//   - Knob    : the rotary encoder / control HID         (from HID.devices(), a known control ident)
//
// Pure + electron-free so it unit-tests in isolation (model: panelSchema.js / routines.js). Main
// injects the live HID list, the display list, the active connector name and cached firmware; this
// module classifies. HID enumeration — not connector connect/disconnect events — is the source of
// truth because BedrockConnector is control-only and never sees bedrock's standard touch HID, and
// enumeration is synchronous/current rather than event-history-dependent.

// Control-interface identities. A match here means "the knob/control device is plugged in" AND
// tells us which console it is. VID/PID/usagePage mirror src/Aris68Connector.js + src/BedrockConnector.js.
const CONTROL_IDENTS = [
  { vendorId: 16728, productId: 20811, usagePage: 0xff60, device: 'aris68' },   // QUAKE control
  { vendorId: 20498, productId: 26647, usagePage: 0xff60, device: 'aris68' },   // ARIS-68 control
  { vendorId: 0x1209, productId: 0xbed0, usagePage: 0xff00, device: 'bedrock' },// Bedrock (pid.codes VID)
];
const DEVICE_LABEL = { aris68: 'DK-QUAKE', bedrock: 'Bedrock Console' };
const TOUCH_USAGE_PAGE = 0x0d;   // HID digitizer — DK-QUAKE "hotlotus" and bedrock's touchscreen both

// A panel display is the 1920x480 (landscape) or 480x1920 (portrait) screen the console drives.
function isPanelDisplay(d) {
  const w = d && d.width, h = d && d.height;
  return (w === 1920 && h === 480) || (w === 480 && h === 1920);
}

function matchControl(d) {
  return CONTROL_IDENTS.find(id =>
    d.vendorId === id.vendorId && d.productId === id.productId &&
    (id.usagePage === undefined || d.usagePage === id.usagePage));
}

function hex(n) { return '0x' + Number(n || 0).toString(16).toUpperCase().padStart(4, '0'); }

/**
 * classify({ hidDevices, displays, activeName, firmware }) -> diagnostics snapshot.
 *   hidDevices: node-hid HID.devices() array ({vendorId,productId,usagePage,product,manufacturer,...})
 *   displays:   [{ width, height, id?, label? }]  (main maps screen.getAllDisplays() bounds)
 *   activeName: 'aris68' | 'bedrock' | null (the live connector, an extra corroboration)
 *   firmware:   'X.Y.Z' | null (cached)
 * Returns { device, deviceLabel, mode, firmware, channels:{display,touch,knob}, healthy, expand }.
 * Each channel: { key, label, level:'ok'|'fail'|'note', detected, detail }.
 */
function classify(input) {
  input = input || {};
  const hid = Array.isArray(input.hidDevices) ? input.hidDevices : [];
  const displays = Array.isArray(input.displays) ? input.displays : [];

  const controlHit = hid.find(matchControl) || null;
  const controlIdent = controlHit ? matchControl(controlHit) : null;
  const touchHit = hid.find(d => d.usagePage === TOUCH_USAGE_PAGE) || null;
  const displayHit = displays.find(isPanelDisplay) || null;

  // Which console: the control ident is definitive; fall back to the live connector name.
  const device = (controlIdent && controlIdent.device) || (input.activeName || null);
  const deviceLabel = device ? (DEVICE_LABEL[device] || device) : null;

  const anyPresent = !!(displayHit || touchHit || controlHit);
  const mode = anyPresent ? 'console' : 'software';

  // Display + Touch are load-bearing: without them the panel can't be seen or operated -> hard fail.
  // The Knob is optional (a touch console works without it) -> a neutral note, never red.
  const display = {
    key: 'display', label: 'Display', detected: !!displayHit,
    level: displayHit ? 'ok' : (mode === 'console' ? 'fail' : 'note'),
    detail: displayHit
      ? (displayHit.width + '×' + displayHit.height + ' panel connected')
      : (mode === 'console'
          ? 'No 1920×480 panel display found over HDMI. Check the HDMI/DP cable and that Windows sees the screen.'
          : 'No panel display detected.'),
  };
  const touch = {
    key: 'touch', label: 'Touchscreen', detected: !!touchHit,
    level: touchHit ? 'ok' : (mode === 'console' ? 'fail' : 'note'),
    detail: touchHit
      ? ('Touch HID connected' + (touchHit.product ? ' (' + touchHit.product + ')' : ''))
      : (mode === 'console'
          ? 'No touch HID found. Check the touch USB cable — on the console this is a separate cable from the knob.'
          : 'No touch HID detected.'),
  };
  const knob = {
    key: 'knob', label: 'Knob', detected: !!controlHit,
    level: controlHit ? 'ok' : 'note',
    detail: controlHit
      ? ((deviceLabel ? deviceLabel + ' ' : '') + 'control HID connected (' + hex(controlHit.vendorId) + '/' + hex(controlHit.productId) + ')')
      : 'No knob detected. This is fine if your console has no knob — touch still works. Otherwise check the knob USB cable.',
  };

  const channels = { display, touch, knob };
  const healthy = display.level !== 'fail' && touch.level !== 'fail';
  // Auto-expand the most important thing that isn't OK: a hard fail first, then a note.
  const order = [display, touch, knob];
  const expand = (order.find(c => c.level === 'fail') || order.find(c => c.level === 'note') || null);

  return {
    device, deviceLabel, mode, firmware: input.firmware || null,
    channels, healthy,
    expand: expand ? expand.key : null,
  };
}

module.exports = { classify, isPanelDisplay, matchControl, CONTROL_IDENTS, DEVICE_LABEL, TOUCH_USAGE_PAGE };
