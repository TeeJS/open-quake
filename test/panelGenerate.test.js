'use strict';
// Tests for the Panel Builder review state machine — the half that decides whether a finished AI turn
// was a panel or ordinary conversation, and gates Accept behind informed consent when the panel
// contains anything executable. Kept electron-free so the whole flow runs without a session.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPanelReview, parsePanelJson } = require('../app/panelGenerate');

const PANEL = { name: 'Masking', cols: 2, rows: 1, tiles: [
  { label: 'Quick Mask', icon: '🎭', type: 'key', value: 'q' },
  { label: 'Invert', icon: '🔄', type: 'key', value: 'control+i' },
] };

function make(overrides) {
  let n = 0;
  return createPanelReview(Object.assign({
    existingIds: () => ['default'],
    makeId: () => 'gnew' + (++n),
  }, overrides || {}));
}

test('a plain JSON reply is recognized and held for review', () => {
  const r = make();
  assert.equal(r.offer(JSON.stringify(PANEL)), true);
  const s = r.state();
  assert.equal(s.active, true);
  assert.equal(s.status, 'ready');
  assert.equal(s.page.name, 'Masking');
  assert.equal(s.page.tiles.length, 2);
});

test('JSON wrapped in a markdown fence or prose still parses', () => {
  const wrapped = 'Sure! Here you go:\n\n```json\n' + JSON.stringify(PANEL) + '\n```\n\nEnjoy.';
  const r = make();
  assert.equal(r.offer(wrapped), true);
  assert.equal(r.state().page.name, 'Masking');
});

test('ordinary conversation is left alone', () => {
  const r = make();
  for (const chat of ['Which application did you mean?', '', 'Sure, I can help with that.', '{"answer":"42"}', 'Here is { not json']) {
    assert.equal(r.offer(chat), false, JSON.stringify(chat));
    assert.equal(r.isActive(), false);
  }
});

test('parsePanelJson requires a tiles array', () => {
  assert.equal(parsePanelJson('{"name":"x","cols":2}'), null);
  assert.ok(parsePanelJson(JSON.stringify(PANEL)));
});

test('a panel that fails validation opens the review in an error state, not silently', () => {
  const r = make();
  assert.equal(r.offer('{"name":"Bad","cols":2,"rows":1,"tiles":[{"type":"key","value":"zz+"}]}'), true);
  const s = r.state();
  assert.equal(s.status, 'error');
  assert.equal(s.page, null);
  assert.ok(s.error);
  assert.equal(r.accept(true).ok, false);
});

test('accept returns the page once and clears the review', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  const first = r.accept();
  assert.equal(first.ok, true);
  assert.equal(first.page.kind, 'grid');
  assert.equal(r.isActive(), false);
  assert.equal(r.accept().ok, false);
});

test('a panel containing a shell command needs explicit confirmation', () => {
  const risky = { name: 'Ops', cols: 2, rows: 1, tiles: [
    { label: 'Save', icon: '💾', type: 'key', value: 'control+s' },
    { label: 'Clean', icon: '🧹', type: 'cmd', value: 'del /q C:\\tmp\\*' },
  ] };
  const r = make();
  r.offer(JSON.stringify(risky));

  const blocked = r.accept();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.needsConfirm, true);
  assert.equal(blocked.risky[0].command, 'del /q C:\\tmp\\*');   // the real text, for the consent screen
  assert.equal(r.isActive(), true);                              // still pending, nothing committed

  const allowed = r.accept(true);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.page.tiles[1].type, 'cmd');
});

test('a clean panel does not ask for confirmation', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  assert.equal(r.accept().ok, true);
});

test('cancel drops the pending panel', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  r.cancel();
  assert.equal(r.isActive(), false);
  assert.equal(r.accept(true).ok, false);
});

test('a second offer replaces the first — "try again" supersedes', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  r.offer(JSON.stringify(Object.assign({}, PANEL, { name: 'Second' })));
  assert.equal(r.state().page.name, 'Second');
});

test('state is a copy — callers cannot mutate the pending page', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  const s = r.state();
  s.page.tiles[0].value = 'hacked';
  assert.equal(r.state().page.tiles[0].value, 'q');
});

test('each offer gets a fresh page id', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  const a = r.state().page.id;
  r.offer(JSON.stringify(PANEL));
  assert.notEqual(r.state().page.id, a);
});
