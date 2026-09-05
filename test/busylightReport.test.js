'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  buildReport, parseColor, createBusylightService,
  KUANDO_VENDOR_ID, REPORT_LENGTH,
} = require('../app/busylightService');

// These assertions lock in a byte layout taken from a community reference implementation, NOT from
// Kuando documentation. They prove the frame is internally consistent and stable across edits; they
// cannot prove the device agrees. Real hardware is what settles that — see the Test light button.
// If the offsets turn out to be wrong, these expectations move together with buildReport().

test('report is 65 bytes with report id 0 and the protocol step', () => {
  const buf = buildReport({ r: 0, g: 0, b: 0 });
  assert.strictEqual(buf.length, REPORT_LENGTH);
  assert.strictEqual(buf.length, 65);
  assert.strictEqual(buf[0], 0, 'leading report id for the Windows node-hid write path');
  assert.strictEqual(buf[1], 0x10);
});

test('RGB lands at 3,4,5 in that order', () => {
  const buf = buildReport({ r: 0x11, g: 0x22, b: 0x33 });
  assert.strictEqual(buf[3], 0x11);
  assert.strictEqual(buf[4], 0x22);
  assert.strictEqual(buf[5], 0x33);
});

test('steady, not blinking, and silent', () => {
  const buf = buildReport({ r: 255, g: 0, b: 0 });
  assert.strictEqual(buf[6], 0, 'on time 0 = steady');
  assert.strictEqual(buf[7], 0, 'off time 0 = steady');
  assert.strictEqual(buf[8], 0x80, 'silence, deliberately — not a forgotten placeholder');
});

test('the fixed tail the device checks is present', () => {
  const buf = buildReport({ r: 1, g: 2, b: 3 });
  assert.deepStrictEqual(buf.slice(57, 63), [0xff, 0xff, 0xff, 0xff, 0x06, 0x93]);
});

test('checksum is the big-endian sum of bytes 0..62', () => {
  const buf = buildReport({ r: 0x10, g: 0x20, b: 0x30 });
  let sum = 0;
  for (let i = 0; i <= 62; i++) sum += buf[i];
  assert.strictEqual(buf[63], (sum >> 8) & 0xff, 'high byte first');
  assert.strictEqual(buf[64], sum & 0xff);
  // Spot-check the arithmetic independently of the loop above so a bug in both cannot cancel out.
  // step 0x10=16, rgb 16+32+48, tone 0x80=128, tail 4*255=1020 + 6 + 147  ->  1413 = 0x585
  assert.strictEqual(16 + 16 + 32 + 48 + 128 + 1020 + 6 + 147, 1413, 'the arithmetic itself');
  assert.strictEqual((buf[63] << 8) | buf[64], 1413);
  assert.strictEqual(buf[63], 0x05);
  assert.strictEqual(buf[64], 0x85);
});

test('every byte is a valid uint8', () => {
  const buf = buildReport({ r: 999, g: -5, b: 12.7 });
  buf.forEach((b, i) => {
    assert.ok(Number.isInteger(b) && b >= 0 && b <= 255, 'byte ' + i + ' out of range: ' + b);
  });
  assert.strictEqual(buf[3], 255, 'clamped high');
  assert.strictEqual(buf[4], 0, 'clamped low');
  assert.strictEqual(buf[5], 13, 'rounded');
});

test('a missing colour yields a valid black frame rather than throwing', () => {
  const buf = buildReport();
  assert.strictEqual(buf.length, 65);
  assert.deepStrictEqual(buf.slice(3, 6), [0, 0, 0]);
});

test('the off frame is black but otherwise well-formed', () => {
  const off = buildReport({ r: 0, g: 0, b: 0 });
  assert.deepStrictEqual(off.slice(3, 6), [0, 0, 0]);
  assert.deepStrictEqual(off.slice(57, 63), [0xff, 0xff, 0xff, 0xff, 0x06, 0x93]);
  assert.strictEqual((off[63] << 8) | off[64], 0x10 + 0x80 + 0xff * 4 + 0x06 + 0x93);
});

test('parseColor handles 6-digit, 3-digit, and a leading hash', () => {
  assert.deepStrictEqual(parseColor('#ff0000'), { r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(parseColor('00ff00'), { r: 0, g: 255, b: 0 });
  assert.deepStrictEqual(parseColor('#f00'), { r: 255, g: 0, b: 0 });
});

test('parseColor scales by brightness', () => {
  assert.deepStrictEqual(parseColor('#ff0000', 50), { r: 128, g: 0, b: 0 });
  assert.deepStrictEqual(parseColor('#ffffff', 0), { r: 0, g: 0, b: 0 });
  assert.deepStrictEqual(parseColor('#ff0000', 300), { r: 255, g: 0, b: 0 }, 'clamped to 100%');
});

test('a mistyped colour goes black instead of throwing', () => {
  // A bad value in settings must not be able to take down the presence fan-out.
  assert.deepStrictEqual(parseColor('nonsense'), { r: 0, g: 0, b: 0 });
  assert.deepStrictEqual(parseColor(''), { r: 0, g: 0, b: 0 });
  assert.deepStrictEqual(parseColor(null), { r: 0, g: 0, b: 0 });
});

// ---- service behaviour, against a fake HID ----

function fakeHid(opts) {
  const o = opts || {};
  const writes = [];
  const devices = o.devices || [{ vendorId: KUANDO_VENDOR_ID, productId: 0x3bcd, product: 'Busylight UC omega', path: 'fake:1' }];
  let openCount = 0;
  function HIDDevice() {
    openCount++;
    if (o.openThrows) throw new Error(o.openThrows);
    this.write = buf => {
      if (o.writeThrowsAfter != null && writes.length >= o.writeThrowsAfter) throw new Error('device gone');
      writes.push(buf);
      return buf.length;
    };
    this.close = () => {};
  }
  return { devices: () => devices, HID: HIDDevice, _writes: writes, _openCount: () => openCount };
}

test('setColor writes a frame carrying the requested colour', () => {
  const hid = fakeHid();
  const svc = createBusylightService({ hid });
  assert.strictEqual(svc.setColor({ r: 255, g: 0, b: 0 }), true);
  assert.strictEqual(hid._writes.length, 1);
  assert.deepStrictEqual(hid._writes[0].slice(3, 6), [255, 0, 0]);
  svc.close();
});

test('no Kuando device present reports a clear failure rather than throwing', () => {
  const hid = fakeHid({ devices: [{ vendorId: 0x1234, productId: 1, product: 'Something else' }] });
  const svc = createBusylightService({ hid });
  assert.strictEqual(svc.setColor({ r: 255, g: 0, b: 0 }), false);
  assert.strictEqual(svc.isConnected(), false);
  assert.strictEqual(svc.detect().found, false);
  assert.match(svc.status().error, /no Kuando Busylight found/);
});

test('a device held by other software names Kuando in the error', () => {
  // The single most likely support question; the raw HID message alone is useless.
  const hid = fakeHid({ openThrows: 'cannot open device' });
  const svc = createBusylightService({ hid });
  assert.strictEqual(svc.setColor({ r: 255, g: 0, b: 0 }), false);
  assert.match(svc.status().error, /Kuando Busylight for UC/);
});

test('a failed write drops the handle so the next call re-detects', () => {
  // Without this an unplug means the light never works again until a restart.
  const hid = fakeHid({ writeThrowsAfter: 1 });
  const svc = createBusylightService({ hid });
  assert.strictEqual(svc.setColor({ r: 255, g: 0, b: 0 }), true);
  assert.strictEqual(svc.isConnected(), true);
  assert.strictEqual(svc.setColor({ r: 0, g: 255, b: 0 }), false);
  assert.strictEqual(svc.isConnected(), false, 'handle released');
  assert.strictEqual(hid._openCount(), 1);
  svc.setColor({ r: 0, g: 0, b: 255 });
  assert.strictEqual(hid._openCount(), 2, 're-opened rather than writing to a dead handle');
});

test('detect finds the light by vendor id whatever the product id', () => {
  // Omega is 0x3BCD; Alpha and the older UC models differ. Vendor matching keeps them all working.
  const hid = fakeHid({ devices: [{ vendorId: KUANDO_VENDOR_ID, productId: 0x3bca, product: 'Busylight Alpha', path: 'fake:2' }] });
  const svc = createBusylightService({ hid });
  const found = svc.detect();
  assert.strictEqual(found.found, true);
  assert.strictEqual(found.product, 'Busylight Alpha');
});

test('close writes black so quitting does not leave you showing busy', () => {
  const hid = fakeHid();
  const svc = createBusylightService({ hid });
  svc.setColor({ r: 255, g: 0, b: 0 });
  svc.close();
  assert.deepStrictEqual(hid._writes[hid._writes.length - 1].slice(3, 6), [0, 0, 0]);
  assert.strictEqual(svc.isConnected(), false);
});
