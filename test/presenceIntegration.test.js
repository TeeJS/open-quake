'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseAppList, monitorAllowlist, routeMonitorMessage } = require('../app/micMonitorRouting');
const { createPresenceService } = require('../app/presenceService');

// End-to-end through the real modules, driven by the EXACT stdout lines a real
// mic-session-monitor.exe emitted on this machine. Only the three outputs are faked; the routing,
// the state machine and the fan-out are the shipping code.
//
// The lines below are not invented. They were captured by running the rebuilt monitor against two
// copies of ffmpeg holding the same physical microphone at once:
//   {"active":true,"app":"discordish.exe","apps":["discordish.exe"]}
//   {"active":true,"app":"discordish.exe","apps":["discordish.exe","teamsish.exe"]}
//   {"active":true,"app":"discordish.exe","apps":["discordish.exe"]}
// with "discordish" standing in for a busy-only app and "teamsish" for a recorded call app.

function harness(settings) {
  const events = { record: [], light: [], mqtt: [] };
  const busylight = {
    setColor: c => { events.light.push(c); return true; },
    off: () => { events.light.push('off'); return true; },
    close: () => {},
    status: () => ({ connected: true, product: 'BUSYLIGHT OMEGA', error: null }),
    isConnected: () => true,
    detect: () => ({ found: true }),
  };
  const mqtt = {
    apply: () => {},
    publishState: s => { events.mqtt.push(s.busy ? 'ON' : 'OFF'); return true; },
    status: () => ({ enabled: true, connected: true, error: null }),
    stop: () => {},
  };
  const svc = createPresenceService({ busylight, mqtt, fetch: null });
  svc.applySettings(Object.assign({
    busyEnabled: true, busyLightEnabled: true, busyOffDelaySec: 0,
    busyLightBusyColor: '#ff0000', busyLightFreeOff: true,
    busyApps: 'teamsish.exe,discordish.exe', recordApps: 'teamsish.exe',
  }, settings || {}));

  // Mirrors startMicMonitor()'s handler in app/main.js.
  const recordSet = parseAppList('teamsish.exe');
  const busySet = parseAppList('teamsish.exe,discordish.exe');
  const recorder = {
    recording: false,
    autoStart(app) { if (!this.recording) { this.recording = true; events.record.push('start:' + app); } },
    autoStop(reason) { if (this.recording) { this.recording = false; events.record.push('stop:' + reason); } },
  };
  let firstLine = true;
  function feed(line) {
    const msg = JSON.parse(line);
    const wasFirst = firstLine; firstLine = false;
    const routed = routeMonitorMessage(msg, recordSet, busySet);
    if (wasFirst && !msg.active) return;
    if (routed.recordApp) recorder.autoStart(routed.recordApp);
    else recorder.autoStop('call-ended');
    svc.setCall(routed.busyActive, routed.busyActive ? (routed.recordApp || routed.apps[0] || null) : null);
  }
  return { feed, events, svc, recorder };
}

test('REAL CAPTURE: Discord idling, Teams joins and leaves — recorder and light both behave', () => {
  const h = harness();

  h.feed('{"active":true,"app":"discordish.exe","apps":["discordish.exe"]}');
  assert.strictEqual(h.recorder.recording, false, 'a busy-only app must not start a recording');
  assert.strictEqual(h.svc.getState().busy, true, 'but it does make you busy');
  assert.deepStrictEqual(h.events.light[h.events.light.length - 1], { r: 255, g: 0, b: 0 });

  h.feed('{"active":true,"app":"discordish.exe","apps":["discordish.exe","teamsish.exe"]}');
  assert.strictEqual(h.recorder.recording, true, 'the call app joining MUST start the recording');
  assert.deepStrictEqual(h.events.record, ['start:teamsish.exe']);

  h.feed('{"active":true,"app":"discordish.exe","apps":["discordish.exe"]}');
  assert.strictEqual(h.recorder.recording, false, 'the call ending MUST stop it, despite active:true');
  assert.deepStrictEqual(h.events.record, ['start:teamsish.exe', 'stop:call-ended']);
  assert.strictEqual(h.svc.getState().busy, true, 'still busy — Discord never let go of the mic');

  h.feed('{"active":false,"apps":[]}');
  assert.strictEqual(h.svc.getState().busy, false);
  assert.strictEqual(h.events.light[h.events.light.length - 1], 'off');
  assert.strictEqual(h.events.mqtt[h.events.mqtt.length - 1], 'OFF');
});

test('the opening idle baseline is still ignored', () => {
  // Guards the comment at main.js:2433 — treating a startup baseline as "call ended" once split
  // recordings into two files.
  const h = harness();
  h.recorder.recording = true;
  h.feed('{"active":false,"apps":[]}');
  assert.strictEqual(h.recorder.recording, true, 'a first-line idle must not stop a live recording');
  assert.deepStrictEqual(h.events.record, []);
});

test('with the feature off, the monitor argv is byte-identical to today', () => {
  assert.strictEqual(
    monitorAllowlist('Zoom.exe,Teams.exe,ms-teams.exe', 'Discord.exe,slack.exe', false),
    'Zoom.exe,Teams.exe,ms-teams.exe');
});

test('a recording started manually keeps you busy after the call app lets go', () => {
  const h = harness();
  h.feed('{"active":true,"app":"teamsish.exe","apps":["teamsish.exe"]}');
  h.svc.setRecording(true);
  h.feed('{"active":false,"apps":[]}');
  assert.strictEqual(h.svc.getState().busy, true);
  assert.strictEqual(h.svc.getState().reason, 'recording');
  h.svc.setRecording(false);
  assert.strictEqual(h.svc.getState().busy, false);
});

test('a manual override from the panel beats the live call state', () => {
  const h = harness();
  h.feed('{"active":true,"app":"teamsish.exe","apps":["teamsish.exe"]}');
  assert.strictEqual(h.svc.getState().busy, true);
  h.svc.setOverride('free');
  assert.strictEqual(h.svc.getState().busy, false, 'forced free during a live call');
  h.svc.setOverride('auto');
  assert.strictEqual(h.svc.getState().busy, true, 'and back, because the call never ended');
});
