'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dateLabel, durationLabel, groupEvents, localDateKey } = require('../app/officeCalendar');

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

  assert.deepEqual(groups.map(group => ({ label: group.label, ids: group.events.map(item => item.id) })), [
    { label: 'TODAY', ids: ['today'] },
    { label: 'TOMORROW', ids: ['tomorrow-after-local-midnight'] },
    { label: 'SAT 15 AUG', ids: ['later'] },
  ]);
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

  assert.equal((html.match(/data-shortcut-index=/g) || []).length, 4);
  assert.equal((html.match(/data-app-index=/g) || []).length, 4);
  assert.equal((html.match(/class="header-action(?: selected)?"/g) || []).length, 4);
  assert.equal((html.match(/class="teams-control shortcut-control/g) || []).length, 4);
  assert.match(html, /id="presenceAvatar"/);
  assert.doesNotMatch(html, /id="moreToggle"/);
  assert.doesNotMatch(script, /window\.open\s*\(/);
  assert.match(script, /\/api\/office\/action\//);
  assert.match(script, /\/office-icons\//);
  assert.match(script, /DEFAULT_SHORTCUTS_BY_APP/);
  assert.match(script, /prefix \+ 'Icon'/);
});

test('Office header uses bundled deterministic Microsoft product artwork', () => {
  const root = path.join(__dirname, '..', 'app', 'office-icons');
  for (const appId of ['teams', 'outlook', 'word', 'excel', 'powerpoint', 'onenote', 'onedrive', 'office']) {
    const svg = fs.readFileSync(path.join(root, appId + '.svg'), 'utf8');
    assert.match(svg, /^<svg/);
    assert.match(svg, /viewBox="0 0 48 48"/);
  }
});
