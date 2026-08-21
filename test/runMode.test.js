'use strict';

// runMode: the persisted run mode (panel/software/monitor) and the reserved-display gating that rides
// on it. Pure helpers so this needs no electron — it locks in the migration-safe default (unset ->
// 'panel', so existing installs are unchanged) and that software mode never reserves a display.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRunMode, reservedDisplayEnabled } = require('../app/runMode');

test('resolveRunMode defaults to panel when unset or unknown', () => {
  assert.equal(resolveRunMode(undefined), 'panel');
  assert.equal(resolveRunMode(null), 'panel');
  assert.equal(resolveRunMode({}), 'panel');
  assert.equal(resolveRunMode({ runMode: '' }), 'panel');
  assert.equal(resolveRunMode({ runMode: 'bogus' }), 'panel');
  assert.equal(resolveRunMode({ runMode: 'PANEL' }), 'panel');   // case-sensitive: only exact values pass
});

test('resolveRunMode passes through the three valid modes', () => {
  assert.equal(resolveRunMode({ runMode: 'panel' }), 'panel');
  assert.equal(resolveRunMode({ runMode: 'software' }), 'software');
  assert.equal(resolveRunMode({ runMode: 'monitor' }), 'monitor');
});

test('reservedDisplayEnabled follows the setting in panel/monitor mode', () => {
  assert.equal(reservedDisplayEnabled({ runMode: 'panel', reservedDisplay: true }), true);
  assert.equal(reservedDisplayEnabled({ runMode: 'panel', reservedDisplay: false }), false);
  assert.equal(reservedDisplayEnabled({ runMode: 'monitor', reservedDisplay: true }), true);
  // default (unset) mode is panel, so it still follows the setting
  assert.equal(reservedDisplayEnabled({ reservedDisplay: true }), true);
});

test('reservedDisplayEnabled is always false in software mode', () => {
  assert.equal(reservedDisplayEnabled({ runMode: 'software', reservedDisplay: true }), false);
  assert.equal(reservedDisplayEnabled({ runMode: 'software', reservedDisplay: false }), false);
});
