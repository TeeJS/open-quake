'use strict';
// Routing for mic-session-monitor.exe lines, split out of main.js so it can be unit-tested without a
// child process or a microphone.
//
// One monitor watches the UNION of two allowlists — the meeting recorder's call apps and the busy
// light's call apps — because Windows shared-mode capture lets several apps hold the same microphone
// at once, so a single "which app has the mic" answer is not enough. Each consumer therefore has to
// re-derive its own answer from the full apps[] array:
//
//   - the recorder wants the first app that is on ITS list, and nothing else
//   - the busy light only wants to know whether ANY app on its list is present
//
// The two traps this exists to avoid, both found in review and both since reproduced against real
// capture sessions:
//
//   1. Reading msg.app. That is whichever process endpoint enumeration reached first, not the
//      caller's app of interest. With Discord idling and Teams starting a call, msg.app stays
//      "Discord.exe" and the recorder never fires.
//   2. Driving auto-stop off msg.active. That flag is true while ANY watched app holds the mic, so
//      with Discord permanently open a Teams call ending never produces active:false and the
//      recording runs until the silence timer. Auto-stop must key off recordApp going undefined.

// 'Zoom.exe, Teams.exe' -> Set { 'zoom.exe', 'teams.exe' }. Accepts comma/space/semicolon
// separators, matching what mic-session-monitor.exe itself parses out of argv.
function parseAppList(csv) {
  const out = new Set();
  String(csv == null ? '' : csv).split(/[,;\s]+/).forEach(part => {
    const name = part.trim().toLowerCase();
    if (name) out.add(name);
  });
  return out;
}

// The allowlist argument for the monitor: every app either consumer cares about, de-duplicated but
// keeping the recorder's entries first so msg.app stays a record app in the common case (nothing
// reads it, but it keeps the logs legible).
function monitorAllowlist(recordApps, busyApps, busyEnabled) {
  const seen = new Set();
  const out = [];
  const add = csv => String(csv == null ? '' : csv).split(/[,;\s]+/).forEach(part => {
    const name = part.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  add(recordApps);
  if (busyEnabled) add(busyApps);
  return out.join(',');
}

// One parsed monitor line -> what each consumer should do about it.
//
// `recordApp` is the app the recorder should treat as the trigger, or null. `busyActive` is whether
// the busy light should consider a call in progress. Neither is `msg.active`, deliberately.
//
// Older monitor builds emit no apps[] (only app). Falling back to [msg.app] keeps a stale
// app/native/mic-session-monitor.exe working as it does today rather than silently reporting idle:
// build-smtc.js regenerates the exe, but a packaged install could be mid-upgrade.
function routeMonitorMessage(msg, recordSet, busySet) {
  const m = msg || {};
  const apps = Array.isArray(m.apps)
    ? m.apps
    : (m.active && m.app ? [m.app] : []);
  const names = apps.map(a => String(a || '').trim()).filter(Boolean);
  const recordApp = names.find(a => recordSet.has(a.toLowerCase())) || null;
  const busyActive = names.some(a => busySet.has(a.toLowerCase()));
  return { apps: names, recordApp, busyActive };
}

module.exports = { parseAppList, monitorAllowlist, routeMonitorMessage };
