'use strict';
// deviceDiagnostics.classify: the panel connection check across both consoles (DK-QUAKE / bedrock),
// with and without a knob, and in software mode. Detection is by HID enumeration + display list.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../app/deviceDiagnostics');

// HID.devices()-shaped fixtures
const arisControl  = { vendorId: 16728, productId: 20811, usagePage: 0xff60, product: 'QUAKE' };
const aris2Control = { vendorId: 20498, productId: 26647, usagePage: 0xff60, product: 'ARIS-68' };
const bedrockKnob  = { vendorId: 0x1209, productId: 0xbed0, usagePage: 0xff00, product: 'Bedrock' };
const touch        = { vendorId: 1810, productId: 16, usagePage: 0x0d, product: 'hotlotus' };
const bedrockTouch = { vendorId: 0x0eef, productId: 0x0005, usagePage: 0x0d, product: 'USB Touchscreen' };
const noise        = { vendorId: 0x046d, productId: 0xc52b, usagePage: 0x0001, product: 'Unifying Receiver' };
const panel        = { width: 1920, height: 480, id: 1 };
const portraitPanel= { width: 480, height: 1920, id: 2 };
const laptop       = { width: 2560, height: 1440, id: 3 };

test('DK-QUAKE fully connected: all three OK, identified, healthy', () => {
  const r = classify({ hidDevices: [arisControl, touch, noise], displays: [laptop, panel] });
  assert.equal(r.device, 'aris68');
  assert.equal(r.deviceLabel, 'DK-QUAKE');
  assert.equal(r.mode, 'console');
  assert.equal(r.channels.display.level, 'ok');
  assert.equal(r.channels.touch.level, 'ok');
  assert.equal(r.channels.knob.level, 'ok');
  assert.equal(r.healthy, true);
  assert.equal(r.expand, null);   // nothing to expand when all good
});

test('bedrock-console fully connected: identified as bedrock, healthy', () => {
  const r = classify({ hidDevices: [bedrockKnob, bedrockTouch], displays: [panel] });
  assert.equal(r.device, 'bedrock');
  assert.equal(r.deviceLabel, 'Bedrock Console');
  assert.equal(r.channels.touch.level, 'ok');   // standard 0x0D digitizer, not tracked by any connector
  assert.equal(r.channels.knob.level, 'ok');
  assert.equal(r.healthy, true);
});

test('the second ARIS-68 control ident also identifies aris68', () => {
  const r = classify({ hidDevices: [aris2Control, touch], displays: [panel] });
  assert.equal(r.device, 'aris68');
  assert.equal(r.channels.knob.level, 'ok');
});

test('portrait 480x1920 counts as the panel display', () => {
  const r = classify({ hidDevices: [touch], displays: [portraitPanel] });
  assert.equal(r.channels.display.level, 'ok');
});

test('WITHOUT a knob (display + touch only): healthy, knob is a neutral note not a fail', () => {
  const r = classify({ hidDevices: [touch], displays: [panel] });
  assert.equal(r.channels.display.level, 'ok');
  assert.equal(r.channels.touch.level, 'ok');
  assert.equal(r.channels.knob.level, 'note');    // not 'fail'
  assert.equal(r.channels.knob.detected, false);
  assert.equal(r.healthy, true);                  // a touch console with no knob is fine
  assert.equal(r.expand, 'knob');                 // still surfaced (expanded) but not alarming
  assert.match(r.channels.knob.detail, /no knob/i);
});

test('missing display is a hard fail and auto-expands first', () => {
  const r = classify({ hidDevices: [arisControl, touch], displays: [laptop] });
  assert.equal(r.channels.display.level, 'fail');
  assert.equal(r.healthy, false);
  assert.equal(r.expand, 'display');   // fail beats the knob note
});

test('missing touch is a hard fail', () => {
  const r = classify({ hidDevices: [arisControl], displays: [panel] });
  assert.equal(r.channels.touch.level, 'fail');
  assert.equal(r.healthy, false);
  assert.equal(r.expand, 'touch');
});

test('display fail expands before a touch fail (priority order)', () => {
  const r = classify({ hidDevices: [arisControl], displays: [laptop] });
  assert.equal(r.channels.display.level, 'fail');
  assert.equal(r.channels.touch.level, 'fail');
  assert.equal(r.expand, 'display');
});

test('software mode: nothing connected -> neutral notes, no red, no console', () => {
  const r = classify({ hidDevices: [noise], displays: [laptop] });
  assert.equal(r.mode, 'software');
  assert.equal(r.device, null);
  assert.equal(r.deviceLabel, null);
  assert.equal(r.channels.display.level, 'note');   // not 'fail' — we're just not on a console
  assert.equal(r.channels.touch.level, 'note');
  assert.equal(r.channels.knob.level, 'note');
  assert.equal(r.healthy, true);                    // software mode isn't "unhealthy"
});

test('an unknown control HID is not mistaken for a knob', () => {
  const r = classify({ hidDevices: [{ vendorId: 0x1234, productId: 0x5678, usagePage: 0xff60 }, touch], displays: [panel] });
  assert.equal(r.channels.knob.detected, false);
  assert.equal(r.device, null);
});

test('firmware and activeName pass through; activeName corroborates device when no control HID', () => {
  const r = classify({ hidDevices: [touch], displays: [panel], activeName: 'aris68', firmware: '1.2.3' });
  assert.equal(r.firmware, '1.2.3');
  assert.equal(r.device, 'aris68');   // knob HID gone but the live connector still names it
});
