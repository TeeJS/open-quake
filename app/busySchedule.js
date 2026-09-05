'use strict';
// "Only drive the busy light during these hours, on these days."
//
// Pure and dependency-free: it answers "is the schedule active at this instant" and "when should I
// look again", and nothing else. The two things that make schedules wrong are handled here rather
// than at the call site:
//
//   1. OVERNIGHT WINDOWS. 22:00-06:00 is a legitimate window that wraps midnight. Comparing
//      start <= now < end gets it backwards and the light works only during the hours you excluded.
//      A window whose end is at or before its start is treated as wrapping.
//   2. WHICH DAY A WRAPPED WINDOW BELONGS TO. For 22:00-06:00 with Friday ticked, 01:00 on Saturday
//      is inside Friday's window — the day is the day the window STARTED, not the day it is now.
//
// Days are 0=Sunday..6=Saturday, matching Date.getDay().

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_DAYS = '1,2,3,4,5';        // Mon-Fri
const DEFAULT_START = '08:00';
const DEFAULT_END = '17:00';

// '08:30' -> 510 minutes. Anything unparseable is null so callers can fall back rather than silently
// treating a typo as midnight.
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm == null ? '' : hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function parseDays(csv) {
  const out = new Set();
  String(csv == null ? '' : csv).split(/[,\s]+/).forEach(p => {
    // The empty-string guard is load-bearing: ''.split() yields [''] and Number('') is 0, so without
    // it an empty day list silently means "Sundays" instead of "no days".
    if (p === '') return;
    const n = Number(p);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  });
  return out;
}

// The start/end pair in force for a given day: the per-day entry when per-day times are on and that
// day has one, otherwise the shared pair.
function windowFor(sched, day) {
  const s = sched || {};
  if (s.perDay && s.times && s.times[day]) {
    const t = s.times[day];
    const a = toMinutes(t.s), b = toMinutes(t.e);
    if (a != null && b != null) return { start: a, end: b };
  }
  const a = toMinutes(s.start), b = toMinutes(s.end);
  if (a == null || b == null) return null;
  return { start: a, end: b };
}

// Is `date` inside the schedule? A schedule that is disabled, or whose times cannot be parsed, is
// treated as ALWAYS ACTIVE — a broken schedule must not silently disable the light the user asked
// for. Failing open is the safer direction here: the worst case is the light shows outside hours,
// which is visible and fixable, versus a light that mysteriously never comes on.
function isActive(date, sched) {
  const s = sched || {};
  if (!s.enabled) return true;
  const days = parseDays(s.days);
  if (days.size === 0) return false;      // an explicit empty day set means "never", not "always"

  const d = date instanceof Date ? date : new Date(date);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const today = d.getDay();
  const yesterday = (today + 6) % 7;

  // Unparseable times mean no usable window at all -> fail open (see the note above) rather than
  // leaving the user with a light that never comes on and no clue why.
  if (!windowFor(s, today) && !windowFor(s, yesterday)) return true;

  // A window that starts today.
  if (days.has(today)) {
    const w = windowFor(s, today);
    if (w) {
      if (w.end > w.start) { if (nowMin >= w.start && nowMin < w.end) return true; }
      else if (nowMin >= w.start) return true;          // wrapped: the evening part, today
    }
  }
  // The tail of a wrapped window that started yesterday.
  if (days.has(yesterday)) {
    const w = windowFor(s, yesterday);
    if (w && w.end <= w.start && nowMin < w.end) return true;
  }
  return false;
}

// A human summary for the settings page, so the user can see what they configured without doing the
// arithmetic themselves.
function describe(sched) {
  const s = sched || {};
  if (!s.enabled) return 'Always active';
  const days = [...parseDays(s.days)].sort();
  if (!days.length) return 'No days selected — the light will never come on';
  const names = days.map(d => DAY_NAMES[d]).join(', ');
  if (s.perDay) return names + ', times set per day';
  const a = toMinutes(s.start), b = toMinutes(s.end);
  if (a == null || b == null) return names + ', times invalid — treated as always active';
  const wrap = b <= a ? ' (overnight)' : '';
  return names + ' ' + s.start + '–' + s.end + wrap;
}

module.exports = { isActive, describe, toMinutes, parseDays, windowFor, DAY_NAMES, DEFAULT_DAYS, DEFAULT_START, DEFAULT_END };
