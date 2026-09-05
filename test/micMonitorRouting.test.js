'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseAppList, monitorAllowlist, routeMonitorMessage } = require('../app/micMonitorRouting');

const RECORD = parseAppList('Zoom.exe,Teams.exe,ms-teams.exe');
const BUSY = parseAppList('Zoom.exe,Teams.exe,ms-teams.exe,Discord.exe,slack.exe');

test('parseAppList splits on commas, spaces and semicolons and lowercases', () => {
  assert.deepStrictEqual([...parseAppList('Zoom.exe, Teams.exe;ms-teams.exe')],
    ['zoom.exe', 'teams.exe', 'ms-teams.exe']);
  assert.deepStrictEqual([...parseAppList('')], []);
  assert.deepStrictEqual([...parseAppList(null)], []);
});

test('sloppy spacing around separators still matches the monitor output', () => {
  // 'Teams.exe , Discord.exe' typed in the settings field must not yield ' Discord.exe', which
  // would lowercase fine and then never match a name the monitor reports.
  const set = parseAppList('Teams.exe , Discord.exe ,, slack.exe');
  assert.deepStrictEqual([...set], ['teams.exe', 'discord.exe', 'slack.exe']);
  const r = routeMonitorMessage({ active: true, apps: ['Discord.exe'] }, RECORD, set);
  assert.strictEqual(r.busyActive, true);
  assert.strictEqual(monitorAllowlist('Zoom.exe , Teams.exe', ' Discord.exe ', true),
    'Zoom.exe,Teams.exe,Discord.exe');
});

test('monitorAllowlist is unchanged from the record list when busy is disabled', () => {
  // Guards the promise that enabling nothing leaves auto-record byte-identical to today.
  assert.strictEqual(monitorAllowlist('Zoom.exe,Teams.exe', 'Discord.exe', false), 'Zoom.exe,Teams.exe');
});

test('monitorAllowlist unions both lists, record apps first, de-duplicated case-insensitively', () => {
  assert.strictEqual(
    monitorAllowlist('Zoom.exe,Teams.exe', 'teams.exe,Discord.exe', true),
    'Zoom.exe,Teams.exe,Discord.exe');
});

test('a busy-only app in the union does not trigger the recorder', () => {
  const r = routeMonitorMessage({ active: true, app: 'Discord.exe', apps: ['Discord.exe'] }, RECORD, BUSY);
  assert.strictEqual(r.recordApp, null);
  assert.strictEqual(r.busyActive, true);
});

test('REGRESSION: Teams starting while Discord holds the mic still triggers the recorder', () => {
  // The original bug. msg.app stays Discord.exe because endpoint enumeration reached it first, so
  // anything reading msg.app would ignore the Teams call entirely.
  const msg = { active: true, app: 'Discord.exe', apps: ['Discord.exe', 'Teams.exe'] };
  const r = routeMonitorMessage(msg, RECORD, BUSY);
  assert.strictEqual(msg.app, 'Discord.exe', 'precondition: the compat field is the wrong app');
  assert.strictEqual(r.recordApp, 'Teams.exe');
  assert.strictEqual(r.busyActive, true);
});

test('REGRESSION: Teams ending while Discord still holds the mic stops the recorder', () => {
  // active stays true because Discord is still capturing. Auto-stop must key off recordApp, not
  // active, or the recording runs until the silence timer.
  const msg = { active: true, app: 'Discord.exe', apps: ['Discord.exe'] };
  const r = routeMonitorMessage(msg, RECORD, BUSY);
  assert.strictEqual(msg.active, true, 'precondition: the top-level flag is still true');
  assert.strictEqual(r.recordApp, null, 'recorder must see no trigger app');
  assert.strictEqual(r.busyActive, true, 'busy light stays on for Discord');
});

test('idle clears both consumers', () => {
  const r = routeMonitorMessage({ active: false, apps: [] }, RECORD, BUSY);
  assert.deepStrictEqual(r.apps, []);
  assert.strictEqual(r.recordApp, null);
  assert.strictEqual(r.busyActive, false);
});

test('matching ignores case', () => {
  const r = routeMonitorMessage({ active: true, apps: ['TEAMS.EXE'] }, RECORD, BUSY);
  assert.strictEqual(r.recordApp, 'TEAMS.EXE');
  assert.strictEqual(r.busyActive, true);
});

test('a stale monitor without apps[] still drives the recorder', () => {
  // A packaged install mid-upgrade could run an older exe. Reporting idle there would silently kill
  // auto-record, so the single-app form is honoured.
  const r = routeMonitorMessage({ active: true, app: 'Teams.exe' }, RECORD, BUSY);
  assert.strictEqual(r.recordApp, 'Teams.exe');
  assert.strictEqual(r.busyActive, true);

  const idle = routeMonitorMessage({ active: false }, RECORD, BUSY);
  assert.strictEqual(idle.recordApp, null);
  assert.strictEqual(idle.busyActive, false);
});

test('junk entries are ignored rather than thrown on', () => {
  const r = routeMonitorMessage({ active: true, apps: ['', null, '  ', 'Teams.exe'] }, RECORD, BUSY);
  assert.deepStrictEqual(r.apps, ['Teams.exe']);
  assert.strictEqual(r.recordApp, 'Teams.exe');
});

test('an empty busy list never reports busy', () => {
  const r = routeMonitorMessage({ active: true, apps: ['Teams.exe'] }, RECORD, parseAppList(''));
  assert.strictEqual(r.recordApp, 'Teams.exe');
  assert.strictEqual(r.busyActive, false);
});
