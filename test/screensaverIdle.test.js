'use strict';
// screensaver-idle: the pure decision module behind the screensaver's auto-start, wake, and
// input-swallow behavior. Locks in every gate so main.js stays a thin shell around it.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isScreensaverGrid, saverSettings, findSaverGrid, evaluateSaverTick,
  saverRestoreTarget, swallowDecision, WAKE_GRACE_MS,
} = require('../app/screensaver-idle');

const saver = (id, opts) => ({ id, kind: 'app', app: 'screensaver', options: opts });
const page = id => ({ id, kind: 'web', url: 'http://x' });

test('saverSettings clamps and defaults idleMinutes', () => {
  assert.equal(saverSettings(saver('s', { idleMinutes: '10' })).idleMinutes, 10);
  assert.equal(saverSettings(saver('s', { idleMinutes: '0' })).idleMinutes, 0);
  assert.equal(saverSettings(saver('s', { idleMinutes: '99999' })).idleMinutes, 720);
  assert.equal(saverSettings(saver('s', { idleMinutes: '-5' })).idleMinutes, 0);
  assert.equal(saverSettings(saver('s', { idleMinutes: 'garbage' })).idleMinutes, 30);
  assert.equal(saverSettings(saver('s', {})).idleMinutes, 30);
  assert.equal(saverSettings(null).idleMinutes, 30);
});

test('findSaverGrid: first auto-start-enabled screensaver page wins; 0-minutes pages are skipped', () => {
  assert.equal(findSaverGrid([page('a'), saver('s1', { idleMinutes: '0' }), saver('s2', {})]).id, 's2');
  assert.equal(findSaverGrid([saver('s1', { idleMinutes: '5' }), saver('s2', {})]).id, 's1');
  assert.equal(findSaverGrid([page('a')]), null);
  assert.equal(findSaverGrid([saver('s1', { idleMinutes: '0' })]), null);   // 0 = never
  // Hidden screensaver pages are deliberately eligible (idle-only setup).
  const hidden = Object.assign(saver('h', {}), { hidden: true });
  assert.equal(findSaverGrid([page('a'), hidden]).id, 'h');
});

// A baseline state that WOULD auto-start; each gate test breaks exactly one thing.
function readyState(over) {
  return Object.assign({
    runMode: 'panel', monitorMode: false, saverActive: false,
    activeGridId: 'a', grids: [page('a'), saver('s', { idleMinutes: '10' })],
    now: 10 * 60000 + 1000, lastInputAt: 0,
    voiceBusy: false, meetingRecording: false,
  }, over || {});
}

test('evaluateSaverTick enters on the happy path with the target id', () => {
  assert.deepEqual(evaluateSaverTick(readyState()), { enter: 's', reason: 'idle' });
});

test('evaluateSaverTick gates: each blocks alone', () => {
  assert.equal(evaluateSaverTick(readyState({ runMode: 'software' })).enter, null);
  assert.equal(evaluateSaverTick(readyState({ monitorMode: true })).enter, null);
  assert.equal(evaluateSaverTick(readyState({ saverActive: true })).enter, null);
  assert.equal(evaluateSaverTick(readyState({ grids: [page('a')] })).enter, null);                 // no saver page
  assert.equal(evaluateSaverTick(readyState({ grids: [page('a'), saver('s', { idleMinutes: '0' })] })).enter, null);
  assert.equal(evaluateSaverTick(readyState({ activeGridId: 's' })).enter, null);                  // manual visit
  assert.equal(evaluateSaverTick(readyState({ voiceBusy: true })).enter, null);
  assert.equal(evaluateSaverTick(readyState({ meetingRecording: true })).enter, null);
  assert.equal(evaluateSaverTick(readyState({ lastInputAt: 60000 })).enter, null);                 // not idle yet
});

test('evaluateSaverTick idle threshold comes from the target page', () => {
  const s = readyState({ grids: [page('a'), saver('s', { idleMinutes: '1' })], now: 61000, lastInputAt: 0 });
  assert.equal(evaluateSaverTick(s).enter, 's');
  assert.equal(evaluateSaverTick(Object.assign({}, s, { now: 59000 })).enter, null);
});

test('saverRestoreTarget fallback chain: prev -> home -> first visible -> first -> null', () => {
  const cfg = { homePageId: 'h', grids: [Object.assign(page('x'), { hidden: true }), page('h'), page('v')] };
  assert.equal(saverRestoreTarget(cfg, 'v'), 'v');
  assert.equal(saverRestoreTarget(cfg, 'gone'), 'h');                                            // home page
  assert.equal(saverRestoreTarget({ homePageId: 'gone2', grids: cfg.grids }, 'gone'), 'h');      // first visible (x is hidden)
  assert.equal(saverRestoreTarget({ grids: [Object.assign(page('x'), { hidden: true })] }, null), 'x');   // all hidden -> first anyway
  assert.equal(saverRestoreTarget({ grids: [] }, null), null);
  assert.equal(saverRestoreTarget(null, null), null);
});

// ---- swallowDecision ----

const IDLE_ST = { saverActive: false, activeIsSaver: false, touchHeld: false, swallowUntil: 0 };

test('normal input passes through untouched', () => {
  const d = swallowDecision(IDLE_ST, 'knob', { type: 'rotate', dir: 1 }, 1000);
  assert.deepEqual(d, { swallow: false, wake: false, dissolve: false, touchHeld: false, swallowUntil: 0 });
});

test('first input while auto-started wakes and is swallowed; touch-down arms the gesture eater', () => {
  const st = { saverActive: true, activeIsSaver: true, touchHeld: false, swallowUntil: 0 };
  const knob = swallowDecision(st, 'knob', { type: 'press' }, 1000);
  assert.equal(knob.swallow, true); assert.equal(knob.wake, true);
  assert.equal(knob.touchHeld, false); assert.equal(knob.swallowUntil, 1000 + WAKE_GRACE_MS);
  const touch = swallowDecision(st, 'touch', [{ action: 1, x: 5, y: 5 }], 1000);
  assert.equal(touch.wake, true); assert.equal(touch.touchHeld, true);
});

test('stale active flag never eats input — it dissolves and passes through', () => {
  const st = { saverActive: true, activeIsSaver: false, touchHeld: false, swallowUntil: 0 };
  const d = swallowDecision(st, 'touch', [{ action: 1 }], 1000);
  assert.deepEqual(d, { swallow: false, wake: false, dissolve: true, touchHeld: false, swallowUntil: 0 });
});

test('the waking touch gesture is eaten through finger-up, even past the grace window', () => {
  let st = { saverActive: false, activeIsSaver: false, touchHeld: true, swallowUntil: 1350 };
  const mid = swallowDecision(st, 'touch', [{ action: 1, x: 9, y: 9 }], 5000);   // way past grace
  assert.equal(mid.swallow, true); assert.equal(mid.touchHeld, true);
  const up = swallowDecision(st, 'touch', [{ action: 0, x: 9, y: 9 }], 5001);
  assert.equal(up.swallow, true); assert.equal(up.touchHeld, false);             // up itself eaten, then disarmed
  const after = swallowDecision({ saverActive: false, activeIsSaver: false, touchHeld: false, swallowUntil: 1350 }, 'touch', [{ action: 1 }], 5002);
  assert.equal(after.swallow, false);
});

test('knob flick tail detents are eaten inside the grace window, passed after it', () => {
  const st = { saverActive: false, activeIsSaver: false, touchHeld: false, swallowUntil: 1350 };
  assert.equal(swallowDecision(st, 'knob', { type: 'rotate', dir: 1 }, 1200).swallow, true);
  assert.equal(swallowDecision(st, 'knob', { type: 'rotate', dir: 1 }, 1349).swallow, true);
  assert.equal(swallowDecision(st, 'knob', { type: 'rotate', dir: 1 }, 1350).swallow, false);
  assert.equal(swallowDecision(st, 'knob', { type: 'hold', phase: 'end' }, 1400).swallow, false);   // late hold-end is harmless
});
