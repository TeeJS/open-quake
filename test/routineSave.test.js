'use strict';
// The panel's "+ Routine" button (beside Send on the AI Chat page) and the config hygiene that
// keeps a half-saved routine out of the tile editor's picker.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoicePanelHost } = require('../app/voicepanel-host');
const { ensureRoutines } = require('../app/voiceConfig');

// Minimal stand-in for a backend adapter: the host only needs the event surface to be constructed.
function fakeAdapter() {
  const handlers = {};
  return {
    on: (evt, fn) => { handlers[evt] = fn; },
    emit: (evt, payload) => { if (handlers[evt]) handlers[evt](payload); },
    isRunning: () => true,
    start: () => true,
    send: () => true,
    sendTurn: () => true,
    stop: () => {},
    setModel: () => {},
    sessionId: () => 'test-session',
    setPermissionMode: () => {},
  };
}

function make(gridOverrides) {
  const grid = Object.assign({ id: 'chat1', name: 'Claude', kind: 'app', app: 'ai-voice', options: {} }, gridOverrides || {});
  const config = { grids: [grid], settings: {} };
  let saves = 0;
  const host = createVoicePanelHost({
    appId: 'ai-voice',
    storageKey: 'testVoice',
    log: () => {},
    adapter: fakeAdapter(),
    branding: {},
    deps: {
      activeServedAppConfig: () => ({ options: grid.options }),
      voiceEndpoints: () => ({}),
      activeGrid: () => grid,
      getConfig: () => config,
      saveConfig: () => { saves++; },
      setRingState: () => {},
      clearRingOverride: () => {},
      getDocumentsPath: () => '.',
    },
  });
  return { host, config, grid, saves: () => saves };
}

test('saves the message-field text, auto-named from its opening words', () => {
  const h = make();
  const r = h.host.handlers.saveRoutine('Summarize my unread email and list anything that needs a reply');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Summarize my unread email and list…');
  assert.equal(h.config.settings.routines.length, 1);
  assert.equal(h.config.settings.routines[0].appPageId, 'chat1');   // the page you saved it on
  assert.equal(h.saves(), 1);                                        // written to disk, not just memory
});

test('an empty field falls back to the last request that was sent', () => {
  const h = make();
  h.host.handlers.onTurn('Run the standup summary', false);   // the turn the user already asked for
  const r = h.host.handlers.saveRoutine('');
  assert.equal(r.ok, true);
  assert.equal(h.config.settings.routines[0].prompt, 'Run the standup summary');
});

test('nothing typed and nothing asked yet is refused with a reason', () => {
  const h = make();
  const r = h.host.handlers.saveRoutine('');
  assert.equal(r.ok, false);
  assert.match(r.error, /Nothing to save/);
  assert.equal(h.config.settings.routines, undefined);   // no empty list conjured
});

test('the page\'s current profile rides along with the routine', () => {
  const h = make({ options: { profilePick: 'prof-translate' } });
  h.host.handlers.saveRoutine('Translate what I say into Spanish');
  assert.equal(h.config.settings.routines[0].profileId, 'prof-translate');
});

test('two saves make two routines, each with its own id', () => {
  const h = make();
  h.host.handlers.saveRoutine('first thing');
  h.host.handlers.saveRoutine('second thing');
  const ids = h.config.settings.routines.map(r => r.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

// ---- config hygiene ----

test('ensureRoutines creates the list and drops rows that would tap to nothing', () => {
  const c = { settings: { routines: [
    { id: 'a', name: 'Good', prompt: 'do it', appPageId: 'chat1' },
    { id: 'b', name: 'Half-typed row', prompt: '', appPageId: 'chat1' },
  ] } };
  ensureRoutines(c);
  assert.deepEqual(c.settings.routines.map(r => r.id), ['a']);

  const fresh = { settings: {} };
  ensureRoutines(fresh);
  assert.deepEqual(fresh.settings.routines, []);
});
