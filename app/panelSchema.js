'use strict';
// panelSchema.js
//
// Validates and normalizes an AI-authored panel into a real open-quake grid page.
//
// Pure and electron-free on purpose (same reason as runMode.js: main.js pulls in electron and
// node-hid and can't be required in isolation), so every rule here is unit-testable.
//
// The model's output is UNTRUSTED text. Nothing downstream validates a grid — saveConfigFromEditor
// only checks that `grids` is an array — so this module is the only gate between "the AI said so"
// and a page that can send keystrokes or run commands on the user's PC. It therefore:
//   - accepts only known tile types and step kinds, dropping anything else to an empty cell
//   - keeps the tiles array exactly cols*rows long (the panel renderer indexes it positionally)
//   - forces iconType 'emoji' — the only icon path with no filesystem or network dependency
//   - reports every executable tile in `risky[]` WITH its literal command text, so the consent
//     screen can show the user what would actually run rather than a generic warning
//
// Returns { ok, page, warnings[], risky[], error }.

// Mirrors mediaKeys.js:7-8 (tapCombo's parser). Kept as a local copy so this module stays
// dependency-free; if those tables change, change these too.
const MOD_ALIAS = {
  ctrl: 1, control: 1, ctl: 1, shift: 1, alt: 1, option: 1, opt: 1,
  win: 1, cmd: 1, command: 1, meta: 1, super: 1,
};
const NAMED_KEYS = {
  esc: 1, escape: 1, del: 1, 'delete': 1, ins: 1, insert: 1, 'return': 1, enter: 1,
  space: 1, spacebar: 1, tab: 1, backspace: 1, bksp: 1, up: 1, down: 1, left: 1, right: 1,
  pgup: 1, pageup: 1, pgdn: 1, pagedown: 1, home: 1, end: 1, plus: 1,
  audio_play: 1, audio_pause: 1, audio_stop: 1, audio_next: 1, audio_prev: 1,
  audio_mute: 1, audio_vol_up: 1, audio_vol_down: 1,
};
// Models write punctuation keys by name ("control+alt+comma"). robotjs taps CHARACTERS, so a
// spelled-out name reaches the device as an unknown key and the tile silently does nothing — the
// worst failure mode here, since the panel looks perfect. Normalize them to the character instead.
const PUNCT_NAMES = {
  comma: ',', period: '.', dot: '.', fullstop: '.', slash: '/', forwardslash: '/',
  backslash: '\\', semicolon: ';', colon: ';', apostrophe: "'", quote: "'", singlequote: "'",
  grave: '`', backtick: '`', tilde: '`', minus: '-', dash: '-', hyphen: '-',
  equals: '=', equal: '=', bracketleft: '[', leftbracket: '[', openbracket: '[',
  bracketright: ']', rightbracket: ']', closebracket: ']',
};
const TILE_TYPES = ['', 'app', 'url', 'page', 'cmd', 'open', 'system', 'counter', 'paste_text', 'key', 'macro', 'ha'];
const STEP_KINDS = ['key', 'text', 'delay', 'app', 'open', 'url', 'cmd', 'page', 'system', 'ahk'];
const SYSTEM_VALUES = ['lock', 'mic', 'monitor', 'config'];
// Types whose value is executed as code rather than interpreted as data.
const EXECUTABLE_TYPES = ['cmd'];
const EXECUTABLE_STEPS = ['cmd', 'ahk'];

const MAX_COLS = 12, MAX_ROWS = 6;          // editor's own clamps (config.js:963-964)
const MAX_LABEL = 24;                        // tiles are small; longer just truncates visually
const MAX_ICON = 16;                         // an emoji can be several code points
const MAX_VALUE = 500;
const MAX_TEXT = 2000;
const MAX_STEPS = 25;
const MAX_DELAY = 60000;                     // matches main.js:1263

function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Rewrite a combo into what the runtime can actually tap, or null if there's no usable key in it.
// Mirrors tapCombo's parse (mediaKeys.js:51-59): modifiers in any order, last non-modifier is the key.
function normalizeCombo(value) {
  const toks = str(value).split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!toks.length) return null;
  const mods = [];
  let key = null;
  for (const t of toks) {
    if (MOD_ALIAS[t]) { if (mods.indexOf(t) === -1) mods.push(t); continue; }
    key = t;                                  // last non-modifier wins, same as the runtime
  }
  if (!key) return null;
  if (PUNCT_NAMES[key]) key = PUNCT_NAMES[key];
  const usable = NAMED_KEYS[key] || /^f([1-9]|1[0-2])$/.test(key) || Array.from(key).length === 1;
  if (!usable) return null;
  return mods.concat([key]).join('+');
}
function validCombo(value) { return normalizeCombo(value) !== null; }

function validUrl(value) {
  const s = str(value).trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

function blankTile() {
  return { label: '', icon: '', type: '', value: '', iconType: 'emoji', iconImage: '', iconUrl: '', iconCache: '' };
}

// Validate one macro step. Returns { step, risky } or null to drop it.
function normStep(raw, ctx, warn) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = str(raw.kind).trim().toLowerCase();
  if (STEP_KINDS.indexOf(kind) === -1) { warn('dropped a macro step of unknown kind "' + kind + '"'); return null; }
  let value = str(raw.value);
  if (kind === 'delay') value = String(clampInt(value, 0, MAX_DELAY, 0));
  else if (kind === 'key') {
    const combo = normalizeCombo(value);
    if (!combo) { warn('dropped a macro keystroke step with an unusable combo "' + value + '"'); return null; }
    value = combo;
  } else if (kind === 'url') {
    const u = validUrl(value);
    if (!u) { warn('dropped a macro website step with a non-http URL'); return null; }
    value = u;
  } else if (kind === 'page') {
    if (ctx.existingIds.indexOf(value) === -1) { warn('dropped a macro go-to-page step pointing at a page that does not exist'); return null; }
  } else if (kind === 'system') {
    if (SYSTEM_VALUES.indexOf(value) === -1) { warn('dropped a macro system step with an unknown action'); return null; }
  } else if (kind === 'text') {
    value = value.slice(0, MAX_TEXT);
  } else {
    value = value.slice(0, MAX_VALUE);
  }
  if (!value && kind !== 'delay') { warn('dropped an empty macro step'); return null; }
  return { step: { kind, value }, risky: EXECUTABLE_STEPS.indexOf(kind) !== -1 };
}

// Validate one tile. Always returns a tile (an empty one if the input was unusable).
function normTile(raw, index, ctx, warn, addRisky) {
  const t = blankTile();
  if (!raw || typeof raw !== 'object') return t;
  // Merge stubs and spans are not accepted from the AI — the array stays a flat cols*rows list.
  if (raw.cover != null || raw.w != null || raw.h != null) warn('ignored tile spanning/merge fields');

  const type = str(raw.type).trim().toLowerCase();
  if (TILE_TYPES.indexOf(type) === -1) { warn('replaced a tile of unknown type "' + type + '" with an empty one'); return t; }

  t.label = str(raw.label).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  t.icon = str(raw.icon).trim().slice(0, MAX_ICON);
  if (!type) return t;                        // deliberately empty cell — keep the label/icon off it
  t.type = type;

  let value = str(raw.value);
  if (type === 'key') {
    const combo = normalizeCombo(value);
    if (!combo) { warn('replaced the "' + (t.label || 'unnamed') + '" tile — "' + value + '" is not a usable key combo'); return blankTile(); }
    value = combo;
  } else if (type === 'url') {
    const u = validUrl(value);
    if (!u) { warn('replaced the "' + (t.label || 'unnamed') + '" tile — only http/https links are allowed'); return blankTile(); }
    value = u;
  } else if (type === 'page') {
    if (ctx.existingIds.indexOf(value) === -1) { warn('replaced a go-to-page tile pointing at a page that does not exist'); return blankTile(); }
  } else if (type === 'system') {
    if (SYSTEM_VALUES.indexOf(value) === -1) { warn('replaced a system tile with an unknown action'); return blankTile(); }
  } else if (type === 'counter') {
    value = String(clampInt(value, -999999, 999999, 0));
  } else if (type === 'paste_text') {
    value = value.slice(0, MAX_TEXT);
    if (!value) return blankTile();
  } else if (type === 'ha') {
    const service = str(raw.service).trim();
    if (!/^[a-z_]+\.[a-z0-9_]+$/i.test(value) || service.indexOf('.') === -1) {
      warn('replaced a Home Assistant tile — it needs a valid entity and service');
      return blankTile();
    }
    t.service = service;
  } else if (type === 'macro') {
    const rawSteps = Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_STEPS) : [];
    const steps = [];
    for (const rs of rawSteps) {
      const got = normStep(rs, ctx, warn);
      if (!got) continue;
      steps.push(got.step);
      if (got.risky) addRisky({ index, label: t.label, type: 'macro step: ' + got.step.kind, command: got.step.value });
    }
    if (!steps.length) { warn('replaced the "' + (t.label || 'unnamed') + '" macro tile — no usable steps survived'); return blankTile(); }
    t.steps = steps;
    value = '';
  } else {
    value = value.slice(0, MAX_VALUE);
    if (!value) return blankTile();
  }
  t.value = value;
  if (EXECUTABLE_TYPES.indexOf(type) !== -1) addRisky({ index, label: t.label, type: 'shell command', command: value });
  return t;
}

// raw: whatever the model produced (already JSON.parsed).
// ctx: { existingIds: string[], id: string } — id is the new page's id, minted by the caller.
function validatePanel(raw, ctx) {
  const warnings = [];
  const risky = [];
  const warn = m => { if (warnings.indexOf(m) === -1) warnings.push(m); };
  const addRisky = r => risky.push(r);
  const c = { existingIds: (ctx && Array.isArray(ctx.existingIds)) ? ctx.existingIds : [] };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'the AI did not return a panel object', warnings, risky };
  }
  const id = str(ctx && ctx.id).trim();
  if (!id) return { ok: false, error: 'no page id was supplied', warnings, risky };
  if (c.existingIds.indexOf(id) !== -1) return { ok: false, error: 'page id already exists', warnings, risky };

  const cols = clampInt(raw.cols, 1, MAX_COLS, 8);
  const rows = clampInt(raw.rows, 1, MAX_ROWS, 2);
  if (String(raw.cols) !== String(cols) || String(raw.rows) !== String(rows)) {
    warn('adjusted the grid size to ' + cols + '×' + rows + ' (the panel allows up to 12×6)');
  }

  const name = str(raw.name).replace(/\s+/g, ' ').trim().slice(0, 40) || 'AI Panel';
  const want = cols * rows;
  const inTiles = Array.isArray(raw.tiles) ? raw.tiles : [];
  if (!inTiles.length) return { ok: false, error: 'the AI returned no tiles', warnings, risky };
  if (inTiles.length > want) warn('dropped ' + (inTiles.length - want) + ' extra tile(s) that did not fit the grid');

  const tiles = [];
  for (let i = 0; i < want; i++) {
    tiles.push(i < inTiles.length ? normTile(inTiles[i], i, c, warn, addRisky) : blankTile());
  }
  if (!tiles.some(t => t.type)) return { ok: false, error: 'none of the tiles the AI returned were usable', warnings, risky };

  return { ok: true, page: { id, name, kind: 'grid', cols, rows, tiles }, warnings, risky };
}

module.exports = { validatePanel, validCombo, normalizeCombo, blankTile, TILE_TYPES, STEP_KINDS, SYSTEM_VALUES, MAX_COLS, MAX_ROWS };
