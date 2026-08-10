'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createReservedDisplay } = require('../app/reservedDisplay');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => proc.emit('exit', null, 'SIGTERM');
  return proc;
}

function harness() {
  const processes = [];
  const writes = [];
  const logs = [];
  const state = {
    reserved: { x: 1920, y: 0, width: 1920, height: 480 },
    displays: [{ id: '1', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
  };
  const controller = createReservedDisplay({
    platform: 'win32',
    ownProcessId: 42,
    restartDelay: 5,
    getDisplayState: () => state,
    log: value => logs.push(value),
    spawn: () => {
      const proc = fakeProcess();
      proc.stdin.on('data', chunk => writes.push(...String(chunk).trim().split('\n').filter(Boolean).map(JSON.parse)));
      processes.push(proc);
      return proc;
    },
  });
  return { controller, processes, writes, logs, state };
}

test('starts only when enabled and sends a complete display snapshot', () => {
  const h = harness();
  h.controller.start();
  assert.equal(h.processes.length, 0);
  h.controller.setEnabled(true);
  assert.equal(h.processes.length, 1);
  assert.deepEqual(h.writes[0], {
    command: 'configure',
    sequence: 1,
    enabled: true,
    suspended: false,
    ownProcessId: 42,
    reserved: h.state.reserved,
    displays: h.state.displays,
  });
  h.controller.stop();
});

test('suspends and resumes without terminating the helper', () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.start();
  const proc = h.processes[0];
  h.controller.setSuspended(true);
  h.controller.setSuspended(false);
  assert.equal(h.processes[0], proc);
  assert.deepEqual(h.writes.slice(-2).map(x => x.suspended), [true, false]);
  h.controller.stop();
});

test('refresh replaces topology and disabling stops the helper', () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.start();
  h.state.displays = [];
  h.controller.refresh('display removed');
  assert.deepEqual(h.writes.at(-1).displays, []);
  h.controller.setEnabled(false);
  assert.equal(h.writes.at(-1).command, 'stop');
  assert.equal(h.controller.isRunning(), false);
});

test('does nothing on non-Windows platforms', () => {
  let spawned = false;
  const controller = createReservedDisplay({ platform: 'linux', spawn: () => { spawned = true; } });
  controller.setEnabled(true);
  controller.start();
  assert.equal(spawned, false);
  controller.stop();
});

test('restarts after a helper failure while protection remains enabled', async () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.start();
  h.processes[0].emit('error', new Error('test failure'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.processes.length, 2);
  assert.match(h.logs.join('\n'), /test failure/);
  h.controller.stop();
});
