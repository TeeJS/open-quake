'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isActive, describe: describeSched, toMinutes, parseDays } = require('../app/busySchedule');

// 2026-09-07 is a Monday, so +n days walks the week predictably.
const MON = 1, TUE = 2, FRI = 5, SAT = 6, SUN = 0;
function at(dayOffset, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 8, 7 + dayOffset, h, m, 0);
}
const WEEKDAYS = { enabled: true, days: '1,2,3,4,5', start: '08:00', end: '17:00' };

test('toMinutes parses valid times and rejects nonsense', () => {
  assert.strictEqual(toMinutes('08:30'), 510);
  assert.strictEqual(toMinutes('00:00'), 0);
  assert.strictEqual(toMinutes('23:59'), 1439);
  assert.strictEqual(toMinutes('24:00'), null);
  assert.strictEqual(toMinutes('8:5'), null);
  assert.strictEqual(toMinutes(''), null);
  assert.strictEqual(toMinutes(null), null);
});

test('parseDays tolerates spacing and ignores out-of-range values', () => {
  assert.deepStrictEqual([...parseDays('1,2, 3')], [1, 2, 3]);
  assert.deepStrictEqual([...parseDays('0,6')], [0, 6]);
  assert.deepStrictEqual([...parseDays('7,-1,x')], []);
});

test('a disabled schedule is always active', () => {
  assert.strictEqual(isActive(at(SAT, '03:00'), { enabled: false, days: '', start: '', end: '' }), true);
});

test('inside and outside the weekday window', () => {
  assert.strictEqual(isActive(at(0, '09:00'), WEEKDAYS), true, 'Monday morning');
  assert.strictEqual(isActive(at(0, '07:59'), WEEKDAYS), false, 'just before start');
  assert.strictEqual(isActive(at(0, '08:00'), WEEKDAYS), true, 'start is inclusive');
  assert.strictEqual(isActive(at(0, '16:59'), WEEKDAYS), true, 'just before end');
  assert.strictEqual(isActive(at(0, '17:00'), WEEKDAYS), false, 'end is exclusive');
});

test('an unticked day is never active', () => {
  assert.strictEqual(isActive(at(5, '09:00'), WEEKDAYS), false, 'Saturday');
  assert.strictEqual(isActive(at(6, '09:00'), WEEKDAYS), false, 'Sunday');
});

test('OVERNIGHT: a window that wraps midnight works in both halves', () => {
  // The classic bug: start <= now < end is false for every minute of a wrapped window, so the light
  // works only during the hours you deliberately excluded.
  const night = { enabled: true, days: '1,2,3,4,5', start: '22:00', end: '06:00' };
  assert.strictEqual(isActive(at(0, '22:30'), night), true, 'Monday evening');
  assert.strictEqual(isActive(at(0, '23:59'), night), true);
  assert.strictEqual(isActive(at(1, '01:00'), night), true, 'Tuesday small hours, from Monday window');
  assert.strictEqual(isActive(at(1, '05:59'), night), true);
  assert.strictEqual(isActive(at(1, '06:00'), night), false, 'end is exclusive');
  assert.strictEqual(isActive(at(1, '12:00'), night), false, 'midday is outside');
});

test('OVERNIGHT: the tail belongs to the day the window STARTED', () => {
  // Friday 22:00-06:00 ticked, Saturday NOT ticked. 01:00 Saturday is still Friday's window.
  const fri = { enabled: true, days: '5', start: '22:00', end: '06:00' };
  assert.strictEqual(isActive(at(4, '23:00'), fri), true, 'Friday night');
  assert.strictEqual(isActive(at(5, '01:00'), fri), true, "Saturday 1am is Friday's tail");
  assert.strictEqual(isActive(at(5, '23:00'), fri), false, 'Saturday night is not ticked');
  // And the converse: Saturday ticked must NOT light up on Saturday morning from an unticked Friday.
  const sat = { enabled: true, days: '6', start: '22:00', end: '06:00' };
  assert.strictEqual(isActive(at(5, '01:00'), sat), false, 'Saturday 1am belongs to Friday');
  assert.strictEqual(isActive(at(5, '23:00'), sat), true);
});

test('per-day times override the shared pair, and only for the days that have one', () => {
  const s = {
    enabled: true, days: '1,2,3,4,5', start: '08:00', end: '17:00', perDay: true,
    times: { 1: { s: '06:00', e: '10:00' }, 5: { s: '08:00', e: '12:00' } },
  };
  assert.strictEqual(isActive(at(0, '07:00'), s), true, 'Monday uses its own early start');
  assert.strictEqual(isActive(at(0, '11:00'), s), false, 'and its own early end');
  assert.strictEqual(isActive(at(1, '09:00'), s), true, 'Tuesday falls back to the shared window');
  assert.strictEqual(isActive(at(1, '07:00'), s), false);
  assert.strictEqual(isActive(at(4, '11:00'), s), true, 'Friday uses its own');
  assert.strictEqual(isActive(at(4, '13:00'), s), false);
});

test('per-day times are ignored when the per-day switch is off', () => {
  const s = { enabled: true, days: '1', start: '08:00', end: '17:00', perDay: false,
    times: { 1: { s: '06:00', e: '07:00' } } };
  assert.strictEqual(isActive(at(0, '06:30'), s), false, 'stale per-day data must not leak in');
  assert.strictEqual(isActive(at(0, '09:00'), s), true);
});

test('a broken time FAILS OPEN rather than disabling the light', () => {
  // A light that mysteriously never comes on is far worse to diagnose than one that shows outside
  // hours, so an unparseable time is treated as no restriction.
  const s = { enabled: true, days: '1,2,3,4,5', start: 'nonsense', end: '17:00' };
  assert.strictEqual(isActive(at(0, '03:00'), s), true);
});

test('but an explicitly empty day list means never, not always', () => {
  // The user actively unticked every day. That is an instruction, not a broken value.
  assert.strictEqual(isActive(at(0, '09:00'), { enabled: true, days: '', start: '08:00', end: '17:00' }), false);
});

test('describe summarises what was configured', () => {
  assert.strictEqual(describeSched({ enabled: false }), 'Always active');
  assert.strictEqual(describeSched(WEEKDAYS), 'Mon, Tue, Wed, Thu, Fri 08:00–17:00');
  assert.match(describeSched({ enabled: true, days: '1', start: '22:00', end: '06:00' }), /overnight/);
  assert.match(describeSched({ enabled: true, days: '', start: '08:00', end: '17:00' }), /never come on/);
  assert.match(describeSched({ enabled: true, days: '1', start: 'x', end: 'y' }), /always active/);
});
