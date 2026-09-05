'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The meeting settings defaults are written out TWICE by design: MEETING_DEFAULTS in app/main.js (the
// runtime source of truth) and currentMe() in app/config.js (the editor's copy, which cannot require
// a main-process module). Nothing enforces that by construction, and the failure is quiet in both
// directions:
//
//   key only in main.js   -> the editor drops it on every save, because currentMe() rebuilds the whole
//                            meeting object from its own defaults. The user's value silently reverts.
//   key only in config.js -> main never reads it, so the control saves and persists and does nothing.
//
// Neither throws, neither logs. This test is the only thing standing between a new setting and one of
// those two outcomes, so it compares the key sets directly rather than trusting review.

function readKeys(file, startMarker) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', file), 'utf8');
  const start = src.indexOf(startMarker);
  assert.notStrictEqual(start, -1, 'could not find ' + startMarker + ' in ' + file +
    ' — if it was renamed, update this test rather than deleting it');
  // Walk to the end of the object literal, tracking depth so a nested object cannot end it early.
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notStrictEqual(end, -1, 'unbalanced literal in ' + file);
  const body = src.slice(open + 1, end);
  // Top-level keys only: skip anything nested (there is none today, but be strict rather than lucky).
  const keys = new Set();
  let d = 0;
  body.replace(/\{|\}|([A-Za-z_$][\w$]*)\s*:/g, (m, key, offset) => {
    if (m === '{') d++;
    else if (m === '}') d--;
    else if (key && d === 0) {
      // Only count a key if it is at the start of an entry, not part of a value expression.
      const before = body.slice(0, offset).replace(/\s+$/, '');
      if (before === '' || before.endsWith(',')) keys.add(key);
    }
    return m;
  });
  return keys;
}

test('MEETING_DEFAULTS and the editor currentMe() defaults declare the same keys', () => {
  const main = readKeys('main.js', 'const MEETING_DEFAULTS =');
  const editor = readKeys('config.js', 'const currentMe = ()');

  assert.ok(main.size > 20, 'sanity: parsed ' + main.size + ' keys from main.js');
  assert.ok(editor.size > 20, 'sanity: parsed ' + editor.size + ' keys from config.js');

  const missingInEditor = [...main].filter(k => !editor.has(k));
  const missingInMain = [...editor].filter(k => !main.has(k));

  assert.deepStrictEqual(missingInEditor, [],
    'keys in MEETING_DEFAULTS but not in currentMe(): the editor will silently revert these on save');
  assert.deepStrictEqual(missingInMain, [],
    'keys in currentMe() but not in MEETING_DEFAULTS: these save but nothing ever reads them');
});

test('every busy-presence key is present in both', () => {
  // Named explicitly so a partial paste of this feature fails loudly rather than half-working.
  const expected = [
    'busyEnabled', 'busyApps', 'busyOnRecording', 'busyOffDelaySec',
    'busyLightEnabled', 'busyLightBusyColor', 'busyLightFreeColor', 'busyLightBrightness',
    'busyLightFreeOff', 'busyManualColor', 'busyWledEnabled', 'busyWledHost',
    'busyMqttEnabled', 'busyMqttUrl', 'busyMqttUser', 'busyMqttPassword', 'busyMqttBaseTopic',
  ];
  const main = readKeys('main.js', 'const MEETING_DEFAULTS =');
  const editor = readKeys('config.js', 'const currentMe = ()');
  expected.forEach(k => {
    assert.ok(main.has(k), 'MEETING_DEFAULTS is missing ' + k);
    assert.ok(editor.has(k), 'currentMe() is missing ' + k);
  });
});

test('the MQTT password is registered for encryption at rest', () => {
  // A secret missing from secretStore is written to config.json in cleartext, and the app behaves
  // identically either way — no test that exercises behaviour can catch it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'secretStore.js'), 'utf8');
  assert.match(src, /busyMqttPassword/,
    'busyMqttPassword must be listed in transformSettingsSecrets or it ships in cleartext');
});

// The JS test suite drives CAPTURED monitor output, so it can pass in full while the C# helper that
// produces that output has silently reverted to the single-app version — which is exactly what
// happened during development, via a stray `git checkout main -- .`. Nothing else in the tree notices.
// These assertions are the only link between the JS contract and the native source it depends on.
test('the native monitor still emits every matching app, not just the first', () => {
  const cs = fs.readFileSync(path.join(__dirname, '..', 'native', 'mic-session-monitor.cs'), 'utf8');

  assert.match(cs, /static List<string> ActiveAllowlistedApps\(/,
    'the helper must collect ALL matches; a `static string ActiveAllowlistedApp(` signature means it ' +
    'reverted to returning the first hit, and auto-record silently breaks when a busy-only app holds the mic');

  assert.doesNotMatch(cs, /allow\.Contains\(name\.ToLowerInvariant\(\)\)\) return name;/,
    'returning on the first allowlisted match is the original bug');

  assert.match(cs, /SetEquals\(lastApps\)/,
    'the transition test must compare the whole set — comparing only the first match means a call app ' +
    'joining an already-busy mic emits nothing at all');

  assert.match(cs, /StringComparer\.OrdinalIgnoreCase/,
    'app-name matching must be case-insensitive at the set, not at each use site');

  assert.match(cs, /"apps"/,
    'the emitted JSON must carry the apps array the JS routing reads');
});
