'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPresenceService, wledUrl, wledBody } = require('../app/presenceService');

test('wledUrl accepts a bare IP, a host:port, and a full URL', () => {
  // Users type a bare LAN IP. Rejecting that instead of defaulting the scheme would read as "broken".
  assert.strictEqual(wledUrl('192.168.1.50', '/json/state'), 'http://192.168.1.50/json/state');
  assert.strictEqual(wledUrl('192.168.1.50:8080', '/json/state'), 'http://192.168.1.50:8080/json/state');
  assert.strictEqual(wledUrl('http://wled.local/', '/json/state'), 'http://wled.local/json/state');
  assert.strictEqual(wledUrl('', '/json/state'), null);
});

test('wledBody sends brightness with the colour, not just the colour', () => {
  // WLED gotcha: turning on from off and setting a colour in one request can be ignored unless
  // brightness is sent explicitly.
  const on = wledBody({ r: 255, g: 0, b: 0 }, true);
  assert.strictEqual(on.on, true);
  assert.strictEqual(on.bri, 255);
  assert.deepStrictEqual(on.seg[0].col[0], [255, 0, 0]);
  assert.deepStrictEqual(wledBody({ r: 0, g: 0, b: 0 }, false), { on: false });
});

// ---- orchestration, with every output faked ----

function fakes() {
  const light = { calls: [], closed: 0 };
  const busylight = {
    setColor: c => { light.calls.push(c); return true; },
    off: () => { light.calls.push('off'); return true; },
    close: () => { light.closed++; },
    status: () => ({ connected: true, product: 'BUSYLIGHT OMEGA', error: null }),
    isConnected: () => true,
    detect: () => ({ found: true }),
  };
  const published = [];
  const mqtt = {
    apply: s => published.push(['apply', s]),
    publishState: s => { published.push(['state', s.busy, s.reason]); return true; },
    status: () => ({ enabled: true, connected: true, error: null }),
    stop: () => published.push(['stop']),
  };
  return { busylight, mqtt, light, published };
}

function svc(over, f) {
  const k = f || fakes();
  const s = createPresenceService({ busylight: k.busylight, mqtt: k.mqtt, fetch: null });
  s.applySettings(Object.assign({
    busyEnabled: true, busyLightEnabled: true, busyOffDelaySec: 0,
    busyLightBusyColor: '#ff0000', busyLightFreeColor: '#00ff00', busyLightFreeOff: true,
  }, over || {}));
  return { s, k };
}

test('a call turns the light to the busy colour and publishes ON', () => {
  const { s, k } = svc();
  k.light.calls.length = 0; k.published.length = 0;
  s.setCall(true, 'Teams.exe');
  assert.deepStrictEqual(k.light.calls[0], { r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(k.published.find(p => p[0] === 'state').slice(1), [true, 'call']);
  assert.strictEqual(s.getState().app, 'Teams.exe');
});

test('free with "light off" writes off rather than a colour', () => {
  const { s, k } = svc();
  s.setCall(true, 'Teams.exe');
  k.light.calls.length = 0;
  s.setCall(false, null);
  assert.strictEqual(k.light.calls[0], 'off');
  assert.strictEqual(s.getState().busy, false);
});

test('free with a free colour writes that colour instead', () => {
  const { s, k } = svc({ busyLightFreeOff: false });
  s.setCall(true, 'Teams.exe');
  k.light.calls.length = 0;
  s.setCall(false, null);
  assert.deepStrictEqual(k.light.calls[0], { r: 0, g: 255, b: 0 });
});

test('brightness scales the colour actually written', () => {
  const { s, k } = svc({ busyLightBrightness: 50 });
  k.light.calls.length = 0;
  s.setCall(true, 'Teams.exe');
  assert.deepStrictEqual(k.light.calls[0], { r: 128, g: 0, b: 0 });
});

test('recording alone makes you busy', () => {
  const { s, k } = svc();
  k.published.length = 0;
  s.setRecording(true);
  assert.strictEqual(s.getState().busy, true);
  assert.strictEqual(s.getState().reason, 'recording');
});

test('a manual override drives the outputs and survives a call ending', () => {
  const { s } = svc();
  s.setOverride('busy');
  assert.strictEqual(s.getState().busy, true);
  assert.strictEqual(s.getState().reason, 'manual');
  s.setCall(true, 'Teams.exe');
  s.setCall(false, null);
  assert.strictEqual(s.getState().busy, true, 'the override still holds');
  s.setOverride('auto');
  assert.strictEqual(s.getState().busy, false);
});

test('turning the light off in settings actively clears it', () => {
  // Otherwise whatever it last showed stays lit until the device's own 30s timeout, which reads as
  // "I disabled it and it is still red".
  const f = fakes();
  const { s } = svc({}, f);
  s.setCall(true, 'Teams.exe');
  const before = f.busylight.close ? f.light.closed : 0;
  s.applySettings({ busyEnabled: true, busyLightEnabled: false });
  assert.ok(f.light.closed > before, 'the light was explicitly closed');
});

test('disabling the whole feature stops driving the light', () => {
  const f = fakes();
  const { s } = svc({}, f);
  s.applySettings({ busyEnabled: false });
  f.light.calls.length = 0;
  s.setCall(true, 'Teams.exe');
  assert.strictEqual(f.light.calls.length, 0, 'no writes while disabled');
});

test('a light that throws does not stop MQTT from being published', () => {
  // The isolation rule: one dead output must never take another down.
  const f = fakes();
  f.busylight.setColor = () => { throw new Error('device exploded'); };
  const { s } = svc({}, f);
  f.published.length = 0;
  assert.doesNotThrow(() => s.setCall(true, 'Teams.exe'));
  assert.ok(f.published.some(p => p[0] === 'state' && p[1] === true), 'MQTT still got the state');
  assert.match(s.getState().outputs.light.status, /device exploded/);
});

test('an MQTT publish that throws does not stop the light', () => {
  const f = fakes();
  f.mqtt.publishState = () => { throw new Error('broker gone'); };
  const { s } = svc({}, f);
  f.light.calls.length = 0;
  assert.doesNotThrow(() => s.setCall(true, 'Teams.exe'));
  assert.deepStrictEqual(f.light.calls[0], { r: 255, g: 0, b: 0 }, 'the light still went red');
});

test('stop clears the light and tells HA we are gone', () => {
  const f = fakes();
  const { s } = svc({}, f);
  s.setCall(true, 'Teams.exe');
  s.stop();
  assert.ok(f.light.closed > 0, 'light cleared immediately, not left to the 30s timeout');
  assert.ok(f.published.some(p => p[0] === 'stop'), 'HA told explicitly rather than via the will');
});

test('getState reports per-output status for the settings page', () => {
  const { s } = svc();
  const st = s.getState();
  assert.strictEqual(st.enabled, true);
  assert.ok(st.outputs.light, 'light status present');
  assert.ok(st.outputs.wled, 'wled status present');
  assert.ok(st.outputs.mqtt, 'mqtt status present');
});

test('the off-delay holds the light on across a brief mic drop', async () => {
  const f = fakes();
  const s = createPresenceService({ busylight: f.busylight, mqtt: f.mqtt, fetch: null });
  s.applySettings({ busyEnabled: true, busyLightEnabled: true, busyOffDelaySec: 1, busyLightBusyColor: '#ff0000' });
  s.setCall(true, 'Teams.exe');
  f.light.calls.length = 0;
  s.setCall(false, null);
  assert.strictEqual(s.getState().busy, true, 'still busy immediately after the drop');
  s.setCall(true, 'Teams.exe');   // mic retaken inside the window
  await new Promise(r => setTimeout(r, 1200));
  assert.strictEqual(s.getState().busy, true, 'never went free');
  s.stop();
});

test('custom mode paints the user-picked colour, ordinary busy does not', () => {
  const f = fakes();
  const { s } = svc({ busyManualColor: '#a020f0' }, f);
  f.light.calls.length = 0;
  s.setOverride('custom');
  assert.deepStrictEqual(f.light.calls[0], { r: 160, g: 32, b: 240 }, 'custom colour');
  f.light.calls.length = 0;
  s.setOverride('busy');
  assert.deepStrictEqual(f.light.calls[0], { r: 255, g: 0, b: 0 }, 'plain busy stays red');
});

test('setManualColor applies immediately while custom is active', () => {
  const f = fakes();
  const { s } = svc({ busyManualColor: '#a020f0' }, f);
  s.setOverride('custom');
  f.light.calls.length = 0;
  s.setManualColor('#00c853');
  assert.deepStrictEqual(f.light.calls[0], { r: 0, g: 200, b: 83 });
});
