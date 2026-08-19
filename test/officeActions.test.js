'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeActions } = require('../app/officeActions');

function harness(options, overrides) {
  const calls = { apps: [], urls: [], combos: [], focus: [], running: [] };
  const focusAppResult = overrides && overrides.focusAppResult;
  const hasAppWindowResult = overrides && overrides.hasAppWindowResult;
  const deps = Object.assign({
    getOptions: () => options || {},
    launchApp: async value => { calls.apps.push(value); return false; },
    openExternal: async value => { calls.urls.push(value); return true; },
    focusTeams: async () => ({ ok: false, error: 'not running' }),
    focusApp: async names => { calls.focus.push(names); return focusAppResult || { ok: false, error: 'not running' }; },
    hasAppWindow: async names => { calls.running.push(names); return hasAppWindowResult || { ok: false, error: 'not running' }; },
    tapCombo: value => { calls.combos.push(value); return true; },
    fs: { existsSync: () => false },
    env: {},
  }, overrides || {});
  return { actions: createOfficeActions(deps), calls };
}

test('Office app slots default to Teams, Outlook, Word, and Excel', async () => {
  const { actions, calls } = harness({}, { focusTeams: async () => ({ ok: true }) });
  const teams = await actions.run('app', 0);
  await actions.run('app', 1);
  await actions.run('app', 2);
  await actions.run('app', 3);

  assert.equal(teams.app, 'teams');
  assert.equal(teams.method, 'desktop');
  assert.deepEqual(calls.apps, ['olk.exe', 'OUTLOOK.EXE', 'WINWORD.EXE', 'EXCEL.EXE']);
  assert.deepEqual(calls.urls, [
    'https://outlook.office.com/mail/',
    'https://www.office.com/launch/word',
    'https://www.office.com/launch/excel',
  ]);
});

test('Office desktop preference opens an installed local app and does not fall back to web', async () => {
  const installed = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE';
  const { actions, calls } = harness({ app1: 'word', mode1: 'prefer-desktop' }, {
    fs: { existsSync: value => value === installed },
    env: { ProgramFiles: 'C:\\Program Files' },
    launchApp: async value => { calls.apps.push(value); return value === installed; },
  });
  const result = await actions.run('app', 0);

  assert.equal(result.ok, true);
  assert.equal(result.method, 'desktop');
  assert.equal(calls.apps.includes(installed), true);
  assert.deepEqual(calls.urls, []);
});

test('Office desktop apps focus an existing window instead of launching another copy', async () => {
  const { actions, calls } = harness({ app1: 'outlook', mode1: 'desktop' }, {
    focusAppResult: { ok: true },
  });
  const result = await actions.run('app', 0);

  assert.equal(result.ok, true);
  assert.equal(result.method, 'desktop');
  assert.equal(result.focused, true);
  assert.deepEqual(calls.focus, [['olk', 'OUTLOOK']]);
  assert.deepEqual(calls.apps, []);
  assert.deepEqual(calls.urls, []);
});

test('Office desktop-only app switch can keep the panel visible when the app is already open', async () => {
  const { actions, calls } = harness({
    app1: 'outlook',
    mode1: 'desktop',
    desktopSwitch1: 'shortcuts',
  }, {
    hasAppWindowResult: { ok: true },
  });
  const result = await actions.run('app', 0);

  assert.equal(result.ok, true);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.focused, false);
  assert.deepEqual(calls.running, [['olk', 'OUTLOOK']]);
  assert.deepEqual(calls.focus, []);
  assert.deepEqual(calls.apps, []);
});

test('Office desktop-only app switch still launches the app when no window is open', async () => {
  const { actions, calls } = harness({
    app1: 'word',
    mode1: 'desktop',
    desktopSwitch1: 'shortcuts',
  }, {
    launchApp: async value => { calls.apps.push(value); return true; },
  });
  const result = await actions.run('app', 0);

  assert.equal(result.ok, true);
  assert.equal(result.focused, false);
  assert.deepEqual(calls.running, [['WINWORD']]);
  assert.deepEqual(calls.focus, []);
  assert.deepEqual(calls.apps, ['WINWORD.EXE']);
});

test('Office desktop-only mode reports a missing app without opening the web version', async () => {
  const { actions, calls } = harness({ app2: 'powerpoint', mode2: 'desktop' });
  const result = await actions.run('app', 1);

  assert.equal(result.ok, false);
  assert.equal(result.method, 'desktop');
  assert.match(result.error, /desktop app was not found/i);
  assert.deepEqual(calls.urls, []);
});

test('Office web mode skips desktop discovery', async () => {
  const { actions, calls } = harness({ app3: 'onedrive', mode3: 'web' });
  const result = await actions.run('app', 2);

  assert.equal(result.ok, true);
  assert.equal(result.method, 'web');
  assert.deepEqual(calls.apps, []);
  assert.deepEqual(calls.urls, ['https://www.office.com/launch/onedrive']);
});

test('Office shortcut slots send configured key combinations and respect cleared slots', async () => {
  const { actions, calls } = harness({ app2: 'powerpoint', app2Shortcut1Keys: 'Ctrl+Shift+S', app2Shortcut2Keys: '' }, {
    focusAppResult: { ok: true },
  });
  const configured = await actions.run('shortcut', 1, 0);
  const cleared = await actions.run('shortcut', 1, 1);

  assert.equal(configured.ok, true);
  assert.equal(configured.combo, 'Ctrl+Shift+S');
  assert.equal(configured.focused, true);
  assert.equal(cleared.ok, false);
  assert.deepEqual(calls.combos, ['Ctrl+Shift+S']);
  assert.deepEqual(calls.focus, [['POWERPNT']]);
});

test('Office shortcut defaults follow the app selected in each header slot', async () => {
  const { actions, calls } = harness({ app3: 'powerpoint' });
  const result = await actions.run('shortcut', 2, 3);

  assert.equal(result.ok, true);
  assert.equal(result.combo, 'F5');
  assert.deepEqual(calls.combos, ['F5']);
});

test('Office app slots support up to eight configured shortcuts and reject hidden slots', async () => {
  const configured = harness({ app1: 'word', app1ShortcutCount: '8', app1Shortcut8Keys: 'Ctrl+Alt+8' });
  const eighth = await configured.actions.run('shortcut', 0, 7);
  const defaultCount = harness({ app1: 'word', app1Shortcut5Keys: 'Ctrl+Alt+5' });
  const hiddenFifth = await defaultCount.actions.run('shortcut', 0, 4);

  assert.equal(eighth.ok, true);
  assert.equal(eighth.combo, 'Ctrl+Alt+8');
  assert.deepEqual(configured.calls.combos, ['Ctrl+Alt+8']);
  assert.equal(hiddenFifth.ok, false);
  assert.deepEqual(defaultCount.calls.combos, []);
});

test('Office web shortcuts focus a browser after a web app is selected', async () => {
  const { actions, calls } = harness({ app1: 'word', mode1: 'web' });
  await actions.run('app', 0);
  await actions.run('shortcut', 0, 1);

  assert.deepEqual(calls.focus, [['msedge', 'chrome', 'firefox', 'brave', 'opera']]);
  assert.deepEqual(calls.combos, ['Ctrl+S']);
});

test('Teams meeting links follow the configured desktop open mode', async () => {
  const { actions, calls } = harness({ app2: 'teams', mode2: 'desktop' });
  const result = await actions.run('meeting', undefined, undefined, 'https://teams.microsoft.com/l/meetup-join/example?tenantId=abc');

  assert.equal(result.ok, true);
  assert.equal(result.method, 'desktop');
  assert.deepEqual(calls.urls, ['msteams://teams.microsoft.com/l/meetup-join/example?tenantId=abc']);
});

test('Teams meeting links follow the configured web open mode', async () => {
  const { actions, calls } = harness({ app1: 'teams', mode1: 'web' });
  const result = await actions.run('meeting', undefined, undefined, 'https://teams.microsoft.com/meet/example');

  assert.equal(result.ok, true);
  assert.equal(result.method, 'web');
  assert.deepEqual(calls.urls, ['https://teams.microsoft.com/meet/example']);
});

test('Teams meeting links fall back to web in prefer-desktop mode', async () => {
  const { actions, calls } = harness({ app1: 'teams', mode1: 'prefer-desktop' }, {
    openExternal: async value => { calls.urls.push(value); return calls.urls.length > 1; },
  });
  const result = await actions.run('meeting', undefined, undefined, 'https://teams.live.com/l/meetup-join/example');

  assert.equal(result.ok, true);
  assert.equal(result.method, 'web');
  assert.deepEqual(calls.urls, [
    'msteams://teams.live.com/l/meetup-join/example',
    'https://teams.live.com/l/meetup-join/example',
  ]);
});

test('Teams meeting action rejects non-Teams and non-meeting URLs', async () => {
  const { actions, calls } = harness({ app1: 'teams', mode1: 'desktop' });
  const foreign = await actions.run('meeting', undefined, undefined, 'https://example.com/l/meetup-join/example');
  const teamsHome = await actions.run('meeting', undefined, undefined, 'https://teams.microsoft.com/v2/');

  assert.equal(foreign.ok, false);
  assert.equal(teamsHome.ok, false);
  assert.deepEqual(calls.urls, []);
});
