'use strict';
// Tests for the AI-panel validator. This is the only gate between untrusted model output and a
// page that can send keystrokes or run shell commands, so the negative cases matter more than the
// happy path: anything unrecognized must degrade to an empty cell rather than reach the config,
// and every executable tile must be reported in risky[] with its literal command text.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePanel, validCombo, normalizeCombo } = require('../app/panelSchema');

const CTX = { id: 'gaipnl1', existingIds: ['default', 'media'] };
const keyTile = (label, value) => ({ label, icon: '⌨', type: 'key', value });

function ok(raw, ctx) {
  const r = validatePanel(raw, ctx || CTX);
  assert.equal(r.ok, true, r.error || 'expected ok');
  return r;
}

test('a well-formed panel passes and keeps its tiles', () => {
  const r = ok({ name: 'Photoshop Masking', cols: 4, rows: 1, tiles: [
    keyTile('Quick Mask', 'q'),
    keyTile('Feather', 'shift+f6'),
    keyTile('Invert', 'control+i'),
    keyTile('Deselect', 'control+d'),
  ] });
  assert.equal(r.page.kind, 'grid');
  assert.equal(r.page.name, 'Photoshop Masking');
  assert.equal(r.page.tiles.length, 4);
  assert.equal(r.page.tiles[1].value, 'shift+f6');
  assert.equal(r.risky.length, 0);
  assert.equal(r.warnings.length, 0);
});

test('tiles are padded to exactly cols*rows', () => {
  const r = ok({ cols: 8, rows: 2, tiles: [keyTile('One', 'a')] });
  assert.equal(r.page.tiles.length, 16);
  assert.equal(r.page.tiles[15].type, '');
});

test('extra tiles beyond the grid are dropped with a warning', () => {
  const tiles = [];
  for (let i = 0; i < 10; i++) tiles.push(keyTile('K' + i, 'a'));
  const r = ok({ cols: 2, rows: 2, tiles });
  assert.equal(r.page.tiles.length, 4);
  assert.match(r.warnings.join(' '), /dropped 6 extra tile/);
});

test('grid size is clamped to the panel maximum', () => {
  const r = ok({ cols: 40, rows: 40, tiles: [keyTile('A', 'a')] });
  assert.equal(r.page.cols, 12);
  assert.equal(r.page.rows, 6);
  assert.match(r.warnings.join(' '), /12×6/);
});

test('unusable key combos are replaced with an empty tile, not passed through', () => {
  for (const bad of ['', 'control+', 'ctrl+shift', '+', 'control+notakey', 'f13', 'ctrl++']) {
    const r = ok({ cols: 1, rows: 2, tiles: [keyTile('Bad', bad), keyTile('Good', 'a')] });
    assert.equal(r.page.tiles[0].type, '', JSON.stringify(bad));
  }
});

test('validCombo accepts the combos the runtime can actually tap', () => {
  for (const good of ['a', 'q', '5', 'f5', 'f12', 'alt+F4', 'win+l', 'control+shift+t', 'ctrl+alt+delete', 'audio_play',
    '[', ']', 'control+;', 'shift+,', '/', 'control+alt+r']) {   // punctuation keys are real shortcuts
    assert.equal(validCombo(good), true, good);
  }
  for (const bad of ['', 'shift', 'control+alt', 'f0', 'f13', 'ctrl+banana']) {
    assert.equal(validCombo(bad), false, JSON.stringify(bad));
  }
});

test('spelled-out punctuation keys are rewritten to the character the device can tap', () => {
  // Models write "control+alt+comma" (OBS Settings). robotjs taps characters, so passing the word
  // through would give a tile that looks right and silently does nothing.
  assert.equal(normalizeCombo('control+alt+comma'), 'control+alt+,');
  assert.equal(normalizeCombo('control+period'), 'control+.');
  assert.equal(normalizeCombo('control+bracketright'), 'control+]');
  assert.equal(normalizeCombo('ctrl+minus'), 'ctrl+-');
  assert.equal(normalizeCombo('control+equals'), 'control+=');
  assert.equal(normalizeCombo('control+slash'), 'control+/');
  assert.equal(normalizeCombo('control+backtick'), 'control+`');
});

test('a generated tile stores the normalized combo, not the model wording', () => {
  const r = ok({ cols: 1, rows: 1, tiles: [{ label: 'Settings', icon: '⚙️', type: 'key', value: 'Control+Alt+Comma' }] });
  assert.equal(r.page.tiles[0].value, 'control+alt+,');
});

test('macro keystroke steps are normalized the same way', () => {
  const r = ok({ cols: 1, rows: 1, tiles: [{ label: 'M', type: 'macro', steps: [
    { kind: 'key', value: 'CONTROL+COMMA' },
  ] }] });
  assert.equal(r.page.tiles[0].steps[0].value, 'control+,');
});

test('only http/https URLs survive', () => {
  for (const bad of ['file:///c:/x', 'javascript:alert(1)', 'ftp://x/y', 'data:text/html,x', 'notaurl', '']) {
    const r = ok({ cols: 1, rows: 2, tiles: [{ label: 'L', type: 'url', value: bad }, keyTile('Good', 'a')] });
    assert.equal(r.page.tiles[0].type, '', JSON.stringify(bad));
  }
  const good = ok({ cols: 1, rows: 1, tiles: [{ label: 'GH', type: 'url', value: 'https://github.com' }] });
  assert.equal(good.page.tiles[0].value, 'https://github.com');
});

test('unknown tile types and step kinds degrade to empty cells', () => {
  const r = ok({ cols: 1, rows: 2, tiles: [
    { label: 'Evil', type: 'eval', value: 'whatever' },
    keyTile('Good', 'a'),
  ] });
  assert.equal(r.page.tiles[0].type, '');
  assert.match(r.warnings.join(' '), /unknown type/);
});

test('go-to-page tiles must reference a page that exists', () => {
  const bad = ok({ cols: 1, rows: 2, tiles: [{ label: 'Go', type: 'page', value: 'nope' }, keyTile('Good', 'a')] });
  assert.equal(bad.page.tiles[0].type, '');
  const good = ok({ cols: 1, rows: 1, tiles: [{ label: 'Go', type: 'page', value: 'media' }] });
  assert.equal(good.page.tiles[0].value, 'media');
});

test('system tiles accept only the four known actions', () => {
  const good = ok({ cols: 1, rows: 1, tiles: [{ label: 'Lock', type: 'system', value: 'lock' }] });
  assert.equal(good.page.tiles[0].value, 'lock');
  const bad = ok({ cols: 1, rows: 2, tiles: [{ label: 'X', type: 'system', value: 'shutdown' }, keyTile('G', 'a')] });
  assert.equal(bad.page.tiles[0].type, '');
});

test('shell-command tiles are allowed but reported as risky with the literal command', () => {
  const r = ok({ cols: 1, rows: 1, tiles: [{ label: 'Backup', type: 'cmd', value: 'robocopy C:\\a C:\\b' }] });
  assert.equal(r.page.tiles[0].type, 'cmd');
  assert.equal(r.risky.length, 1);
  assert.equal(r.risky[0].command, 'robocopy C:\\a C:\\b');
  assert.equal(r.risky[0].type, 'shell command');
});

test('AutoHotkey and shell macro steps are reported as risky too', () => {
  const r = ok({ cols: 1, rows: 1, tiles: [{ label: 'Combo', type: 'macro', steps: [
    { kind: 'key', value: 'control+s' },
    { kind: 'cmd', value: 'del /q C:\\tmp\\*' },
    { kind: 'ahk', value: 'MsgBox "hi"' },
  ] }] });
  assert.equal(r.page.tiles[0].steps.length, 3);
  assert.equal(r.risky.length, 2);
  assert.deepEqual(r.risky.map(x => x.command), ['del /q C:\\tmp\\*', 'MsgBox "hi"']);
});

test('a clean panel reports no risky entries', () => {
  const r = ok({ cols: 2, rows: 1, tiles: [keyTile('A', 'a'), { label: 'Type', type: 'paste_text', value: 'hello' }] });
  assert.equal(r.risky.length, 0);
});

test('macro delays are clamped and bad steps dropped', () => {
  const r = ok({ cols: 1, rows: 1, tiles: [{ label: 'M', type: 'macro', steps: [
    { kind: 'delay', value: '999999' },
    { kind: 'key', value: 'nope' },
    { kind: 'text', value: 'ok' },
  ] }] });
  assert.deepEqual(r.page.tiles[0].steps, [{ kind: 'delay', value: '60000' }, { kind: 'text', value: 'ok' }]);
});

test('icons are forced to emoji so no file or network path is ever taken', () => {
  const r = ok({ cols: 1, rows: 1, tiles: [{ label: 'X', icon: '🎨', type: 'key', value: 'a',
    iconType: 'image', iconImage: 'C:\\evil.png', iconUrl: 'http://evil/x.png', iconCache: 'C:\\cache' }] });
  const t = r.page.tiles[0];
  assert.equal(t.iconType, 'emoji');
  assert.equal(t.iconImage, '');
  assert.equal(t.iconUrl, '');
  assert.equal(t.iconCache, '');
  assert.equal(t.icon, '🎨');
});

test('merge/span fields from the AI are ignored', () => {
  const r = ok({ cols: 2, rows: 1, tiles: [
    Object.assign(keyTile('Wide', 'a'), { w: 2, h: 2 }),
    { cover: 0 },
  ] });
  assert.equal(r.page.tiles[0].w, undefined);
  assert.equal(r.page.tiles[0].h, undefined);
  assert.equal(r.page.tiles[1].cover, undefined);
  assert.match(r.warnings.join(' '), /spanning/);
});

test('junk input is rejected outright', () => {
  for (const bad of [null, undefined, 'a string', 42, [], { cols: 4, rows: 1 }, { tiles: [] }]) {
    const r = validatePanel(bad, CTX);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.error);
  }
});

test('a panel whose tiles are all unusable is rejected rather than saved empty', () => {
  const r = validatePanel({ cols: 2, rows: 1, tiles: [{ type: 'key', value: 'zzz+' }, { type: 'url', value: 'ftp://x' }] }, CTX);
  assert.equal(r.ok, false);
  assert.match(r.error, /usable/);
});

test('a duplicate or missing page id is rejected', () => {
  assert.equal(validatePanel({ tiles: [keyTile('A', 'a')] }, { id: 'media', existingIds: ['media'] }).ok, false);
  assert.equal(validatePanel({ tiles: [keyTile('A', 'a')] }, { id: '', existingIds: [] }).ok, false);
});

test('labels and names are trimmed to a length the panel can show', () => {
  const r = ok({ name: 'x'.repeat(200), cols: 1, rows: 1, tiles: [keyTile('y'.repeat(200), 'a')] });
  assert.equal(r.page.name.length, 40);
  assert.equal(r.page.tiles[0].label.length, 24);
});
