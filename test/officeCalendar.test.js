'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dateLabel, durationLabel, groupEvents, localDateKey } = require('../app/officeCalendar');
const { officeShortcutImageDataUrl } = require('../app/officeShortcutIcons');

function event(id, start, end) {
  return { id, subject: id, start, end, isCancelled: false };
}

test('calendar grouping uses the event calendar date in the selected local timezone', () => {
  const now = new Date('2026-08-13T22:30:00.000Z'); // 23:30 in Europe/London (BST)
  const groups = groupEvents([
    event('today', '2026-08-13T22:45:00.000Z', '2026-08-13T23:00:00.000Z'),
    event('tomorrow-after-local-midnight', '2026-08-13T23:15:00.000Z', '2026-08-13T23:45:00.000Z'),
    event('later', '2026-08-14T23:15:00.000Z', '2026-08-14T23:45:00.000Z'),
  ], now, 'Europe/London');

  assert.deepEqual(groups.map(group => ({ key: group.key, ids: group.events.map(item => item.id) })), [
    { key: '2026-08-13', ids: ['today'] },
    { key: '2026-08-14', ids: ['tomorrow-after-local-midnight'] },
    { key: '2026-08-15', ids: ['later'] },
  ]);
  assert.equal(groups[0].label, 'TODAY');
  assert.equal(groups[1].label, 'TOMORROW');
  assert.ok(groups[2].label);
});

test('UTC midnight does not force a new day when the user is still on the previous local date', () => {
  const now = new Date('2026-08-13T23:30:00.000Z');
  const shortlyAfterUtcMidnight = '2026-08-14T00:15:00.000Z';

  assert.equal(localDateKey(shortlyAfterUtcMidnight, 'America/New_York'), '2026-08-13');
  assert.equal(dateLabel(shortlyAfterUtcMidnight, now, 'America/New_York'), 'TODAY');
});

test('calendar grouping sorts events, excludes cancelled items, and formats durations', () => {
  const now = new Date('2026-08-13T08:00:00.000Z');
  const groups = groupEvents([
    event('second', '2026-08-13T11:00:00.000Z', '2026-08-13T12:30:00.000Z'),
    Object.assign(event('cancelled', '2026-08-13T09:30:00.000Z', '2026-08-13T10:00:00.000Z'), { isCancelled: true }),
    event('first', '2026-08-13T09:00:00.000Z', '2026-08-13T09:45:00.000Z'),
  ], now, 'UTC');

  assert.deepEqual(groups[0].events.map(item => item.id), ['first', 'second']);
  assert.equal(durationLabel(groups[0].events[0].start, groups[0].events[0].end), '45 min');
  assert.equal(durationLabel(groups[0].events[1].start, groups[0].events[1].end), '1 hr 30 min');
});

test('Office touchscreen controls are host-routed and configurable shortcuts are enabled', () => {
  const root = path.join(__dirname, '..', 'app');
  const html = fs.readFileSync(path.join(root, 'office.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'office.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'office.css'), 'utf8');
  const editor = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
  const editorHtml = fs.readFileSync(path.join(root, 'config.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'apps.json'), 'utf8'));
  const office = manifest.find(app => app.id === 'office');

  assert.equal((html.match(/data-shortcut-index=/g) || []).length, 8);
  assert.equal((html.match(/data-app-index=/g) || []).length, 4);
  assert.equal((html.match(/class="header-action(?: selected)?"/g) || []).length, 4);
  assert.equal((html.match(/class="teams-control shortcut-control/g) || []).length, 8);
  assert.deepEqual(office.options.find(option => option.key === 'app1ShortcutCount').choices.map(choice => choice[0]), ['4', '5', '6', '7', '8']);
  assert.deepEqual(office.options.find(option => option.key === 'desktopSwitch1').choices.map(choice => choice[0]), ['focus', 'shortcuts']);
  assert.equal(office.options.filter(option => /^app[1-4]Shortcut[1-8]Keys$/.test(option.key)).length, 32);
  assert.equal(office.options.filter(option => /^app[1-4]Shortcut[1-8]IconImage$/.test(option.key)).length, 32);
  assert.match(html, /id="presenceAvatar"/);
  const meetingStripStart = html.indexOf('<section class="meeting-strip">');
  const meetingStripEnd = html.indexOf('</section>', meetingStripStart);
  const authStart = html.indexOf('id="auth"');
  assert.ok(authStart > meetingStripStart && authStart < meetingStripEnd);
  assert.match(html, /Calendar and presence are optional/);
  assert.match(html, /App switching and shortcuts work without signing in/);
  assert.doesNotMatch(html, /id="moreToggle"/);
  assert.doesNotMatch(script, /window\.open\s*\(/);
  assert.match(script, /\/api\/office\/action\//);
  assert.match(script, /\/office-icons\//);
  assert.match(script, /DEFAULT_SHORTCUTS_BY_APP/);
  assert.match(script, /prefix \+ 'Icon'/);
  assert.match(script, /--shortcut-count/);
  assert.match(script, /IconImageSrc/);
  assert.match(script, /document\.createElement\('img'\)/);
  assert.match(css, /repeat\(var\(--shortcut-count\), minmax\(0, 1fr\)\)/);
  assert.match(editorHtml, /\.officeShortcutRow\s*{[^}]*display:\s*grid/s);
  assert.match(editorHtml, /\.officeShortcutIcon\s*{[^}]*width:\s*80px[^}]*padding-right:\s*26px/s);
  assert.match(editor, /configApi\.pickImage\(\)/);
  assert.match(css, /\.meeting-strip\s*{[^}]*position:\s*relative/s);
  assert.match(css, /\.auth\s*{[^}]*position:\s*absolute/s);
  assert.doesNotMatch(css, /\.auth\s*{[^}]*position:\s*fixed/s);
  assert.match(editor, /Keep Office panel visible.*will not focus or relaunch it/);
  assert.match(editor, /If the app is closed, it still launches/);
});

test('Office header uses bundled deterministic Microsoft product artwork', () => {
  const root = path.join(__dirname, '..', 'app', 'office-icons');
  for (const appId of ['teams', 'outlook', 'word', 'excel', 'powerpoint', 'onenote', 'onedrive', 'office']) {
    const svg = fs.readFileSync(path.join(root, appId + '.svg'), 'utf8');
    assert.match(svg, /^<svg/);
    assert.match(svg, /viewBox="0 0 48 48"/);
  }
});

test('Office shortcut images accept local image formats without exposing file paths', () => {
  const svgPath = path.join(__dirname, '..', 'app', 'office-icons', 'teams.svg');
  const dataUrl = officeShortcutImageDataUrl(svgPath, fs);

  assert.match(dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal(dataUrl.includes(svgPath), false);
  assert.equal(officeShortcutImageDataUrl(path.join(__dirname, '..', 'package.json'), fs), null);
});
