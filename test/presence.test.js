'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPresence } = require('../app/presence');

// A controllable clock: evaluate() only ever asks for now(), so advancing this and calling tick()
// reproduces exactly what presenceService's timer does, with no sleeping.
function clock(start) {
  let t = start || 1000;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('a call makes you busy immediately, with the app name', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  assert.strictEqual(p.getState().busy, false);
  p.setCall(true, 'Teams.exe');
  const s = p.getState();
  assert.strictEqual(s.busy, true);
  assert.strictEqual(s.reason, 'call');
  assert.strictEqual(s.app, 'Teams.exe');
  assert.strictEqual(s.since, 1000);
});

test('going free waits for the off-delay', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  p.setCall(true, 'Teams.exe');
  assert.strictEqual(p.setCall(false, null), true, 'an off-delay should be pending');
  assert.strictEqual(p.getState().busy, true, 'still busy during the delay');

  c.advance(4999);
  assert.strictEqual(p.tick(), true);
  assert.strictEqual(p.getState().busy, true);

  c.advance(1);
  assert.strictEqual(p.tick(), false);
  assert.strictEqual(p.getState().busy, false);
});

test('a mid-meeting mic blip never reaches the light', () => {
  // The reason the debounce exists: Teams drops and retakes the mic when the meeting window changes.
  const c = clock();
  const changes = [];
  const p = createPresence({ now: c.now, offDelayMs: 5000, onChange: s => changes.push(s.busy) });
  p.setCall(true, 'Teams.exe');
  c.advance(60000);
  p.setCall(false, null);      // blip starts
  c.advance(800);
  p.tick();
  p.setCall(true, 'Teams.exe');  // mic retaken well inside the delay
  c.advance(60000);
  p.tick();
  assert.strictEqual(p.getState().busy, true);
  assert.deepStrictEqual(changes, [true], 'exactly one transition: one continuous busy span');
});

test('recording alone makes you busy and outranks a call', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  p.setRecording(true);
  assert.strictEqual(p.getState().reason, 'recording');
  p.setCall(true, 'Zoom.exe');
  assert.strictEqual(p.getState().reason, 'recording', 'recording outranks call');
  p.setRecording(false);
  assert.strictEqual(p.getState().reason, 'call', 'falls back to the still-live call');
  assert.strictEqual(p.getState().busy, true);
});

test('recording keeps you busy after the call app releases the mic', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  p.setCall(true, 'Teams.exe');
  p.setRecording(true);
  p.setCall(false, null);
  c.advance(60000);
  p.tick();
  assert.strictEqual(p.getState().busy, true, 'a manual recording outlives the call');
  assert.strictEqual(p.getState().reason, 'recording');
});

test('busyOnRecording off stops recording from counting', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 0, busyOnRecording: false });
  p.setRecording(true);
  assert.strictEqual(p.getState().busy, false);
  p.setRecordingCounts(true);
  assert.strictEqual(p.getState().busy, true);
});

test('a busy override wins over every input, including none', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  p.setOverride('busy');
  assert.strictEqual(p.getState().busy, true);
  assert.strictEqual(p.getState().reason, 'manual');
  assert.strictEqual(p.getState().app, null, 'a manual busy is not attributed to an app');
  p.setCall(true, 'Teams.exe');
  assert.strictEqual(p.getState().reason, 'manual', 'override still wins while a call runs');
});

test('a free override wins over a live call and applies at once', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  p.setCall(true, 'Teams.exe');
  p.setRecording(true);
  assert.strictEqual(p.setOverride('free'), false, 'no debounce on a deliberate act');
  assert.strictEqual(p.getState().busy, false);
});

test('returning to auto restores whatever the inputs still say', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  p.setCall(true, 'Teams.exe');
  p.setOverride('free');
  assert.strictEqual(p.getState().busy, false);
  p.setOverride('auto');
  assert.strictEqual(p.getState().busy, true, 'the call never went away');
  assert.strictEqual(p.getState().reason, 'call');
});

test('an unknown override mode falls back to auto rather than pinning a state', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 0 });
  p.setOverride('nonsense');
  assert.strictEqual(p.getState().override, 'auto');
});

test('switching call apps re-emits so the panel can show the new one', () => {
  const c = clock();
  const seen = [];
  const p = createPresence({ now: c.now, offDelayMs: 5000, onChange: s => seen.push(s.app) });
  p.setCall(true, 'Teams.exe');
  p.setCall(true, 'Zoom.exe');
  assert.deepStrictEqual(seen, ['Teams.exe', 'Zoom.exe']);
  assert.strictEqual(p.getState().since, 1000, 'one continuous busy span, not a restart');
});

test('a zero off-delay goes free immediately', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 0 });
  p.setCall(true, 'Teams.exe');
  assert.strictEqual(p.setCall(false, null), false);
  assert.strictEqual(p.getState().busy, false);
});

test('a throwing onChange never breaks the state machine', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 0, onChange: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => p.setCall(true, 'Teams.exe'));
  assert.strictEqual(p.getState().busy, true);
});

test('custom is a distinct busy mode with its own reason', () => {
  // 'custom' must not collapse into 'manual': the fan-out keys the user-picked colour off the reason,
  // so if they were the same reason an ordinary manual busy would take the custom colour too.
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 0 });
  p.setOverride('custom');
  assert.strictEqual(p.getState().busy, true);
  assert.strictEqual(p.getState().reason, 'custom');
  p.setOverride('busy');
  assert.strictEqual(p.getState().reason, 'manual');
  p.setOverride('auto');
  assert.strictEqual(p.getState().busy, false);
});

test('custom outranks a live call, like the other overrides', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 0 });
  p.setCall(true, 'Teams.exe');
  p.setOverride('custom');
  assert.strictEqual(p.getState().reason, 'custom');
  assert.strictEqual(p.getState().app, null, 'a deliberate state is not attributed to an app');
});

test('a recording ending goes free instantly — the debounce is only for mic blips', () => {
  // The off-delay exists for a call app releasing and retaking the mic mid-meeting. A recording
  // stopping is a discrete event from our own recorder; waiting on it just looks broken.
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  p.setRecording(true);
  assert.strictEqual(p.getState().reason, 'recording');
  assert.strictEqual(p.setRecording(false), false, 'no pending off-delay');
  assert.strictEqual(p.getState().busy, false, 'free immediately');
});

test('but a call ending still waits, and a recording over a call still waits for the call', () => {
  const c = clock();
  const p = createPresence({ now: c.now, offDelayMs: 5000 });
  p.setCall(true, 'Teams.exe');
  p.setRecording(true);
  p.setRecording(false);
  assert.strictEqual(p.getState().busy, true, 'the call is still live');
  assert.strictEqual(p.getState().reason, 'call');
  assert.strictEqual(p.setCall(false, null), true, 'now the call debounce applies');
  assert.strictEqual(p.getState().busy, true);
});
