'use strict';
// Screensaver idle/wake DECISIONS, kept pure (no electron, no timers, no I/O) so every rule is
// unit-testable. main.js owns the state and the clock; this module only answers questions:
//   - evaluateSaverTick: should the panel auto-start the screensaver right now?
//   - swallowDecision:   what should happen to this touch/knob event (wake? eat it? pass it on?)
//   - saverRestoreTarget: which page should a wake land on?
// The auto-start rules deliberately mirror the manual paths: a manual visit or a rotation stop on
// the screensaver page never sets saverActive, so nothing here ever swallows input on those.

// A screensaver page is any app page running the screensaver app (a config can hold several).
function isScreensaverGrid(g) {
  return !!(g && g.kind === 'app' && g.app === 'screensaver');
}

// Per-page auto-start setting. idleMinutes: 0 = never auto-start; clamped to at most 12 hours.
// A missing/garbage value falls back to the shipped default (30 minutes).
function saverSettings(grid) {
  const o = (grid && grid.options) || {};
  let m = parseInt(o.idleMinutes, 10);
  if (!Number.isFinite(m)) m = 30;
  m = Math.max(0, Math.min(720, m));
  return { idleMinutes: m };
}

// The auto-start target: the first screensaver page with auto-start enabled. Hidden pages are
// allowed on purpose — hiding the page from the knob/grid list while keeping idle auto-start is a
// legitimate "idle-only screensaver" setup (gotoGrid only checks membership, not hidden).
function findSaverGrid(grids) {
  return (grids || []).find(g => isScreensaverGrid(g) && saverSettings(g).idleMinutes > 0) || null;
}

// One idle-timer tick. s = { runMode, monitorMode, saverActive, activeGridId, grids, now,
// lastInputAt, voiceBusy, meetingRecording }. Returns { enter: gridId|null, reason }.
function evaluateSaverTick(s) {
  if (s.runMode !== 'panel') return { enter: null, reason: 'not-panel-mode' };
  if (s.monitorMode) return { enter: null, reason: 'monitor-mode' };
  if (s.saverActive) return { enter: null, reason: 'already-active' };
  const target = findSaverGrid(s.grids);
  if (!target) return { enter: null, reason: 'no-saver-page' };
  const active = (s.grids || []).find(g => g.id === s.activeGridId);
  if (isScreensaverGrid(active)) return { enter: null, reason: 'viewing-saver' };   // incl. manual visits
  if (s.voiceBusy) return { enter: null, reason: 'voice-busy' };
  if (s.meetingRecording) return { enter: null, reason: 'meeting-recording' };
  const idleMs = saverSettings(target).idleMinutes * 60000;
  if (!(s.now - s.lastInputAt >= idleMs)) return { enter: null, reason: 'not-idle-yet' };
  return { enter: target.id, reason: 'idle' };
}

// Where a wake should land: the snapshot page if it still exists, else the configured home page,
// else the first visible page, else anything. Needed because gotoGrid silently no-ops on a dead
// id — without this chain a wake could strand the panel on the screensaver.
function saverRestoreTarget(cfg, prevId) {
  const grids = (cfg && cfg.grids) || [];
  const has = id => !!id && grids.some(g => g.id === id);
  if (has(prevId)) return prevId;
  if (has(cfg && cfg.homePageId)) return cfg.homePageId;
  const visible = grids.find(g => !g.hidden);
  if (visible) return visible.id;
  return grids.length ? grids[0].id : null;
}

// How long after the wake event further input keeps being eaten: covers the remaining detents of
// the knob flick that woke the panel (each detent is its own event) and a fast hold-release.
const WAKE_GRACE_MS = 350;

// One hardware input event while the saver machinery may be involved.
// st = { saverActive, activeIsSaver, touchHeld, swallowUntil }; kind = 'touch'|'knob';
// evt = touch packet array [{action,x,y}] or knob event {type,...}.
// Returns { swallow, wake, dissolve, touchHeld, swallowUntil }.
//   swallow  — do not forward this event to the panel renderer
//   wake     — leave the saver and restore the snapshot page
//   dissolve — the active flag is stale (something else changed the page); clear it, pass input on
function swallowDecision(st, kind, evt, now) {
  const touchStillDown = kind === 'touch' && Array.isArray(evt) && evt.some(p => p && p.action === 1);
  if (st.saverActive) {
    if (!st.activeIsSaver) {
      // Stale flag (e.g. an editor save swapped the page without gotoGrid): never eat real input.
      return { swallow: false, wake: false, dissolve: true, touchHeld: false, swallowUntil: 0 };
    }
    // First input while auto-started: wake, and eat the whole gesture that did it.
    return { swallow: true, wake: true, dissolve: false, touchHeld: touchStillDown, swallowUntil: now + WAKE_GRACE_MS };
  }
  if (st.touchHeld && kind === 'touch') {
    // The waking finger is still down — keep eating until it lifts so the restored page never
    // receives a half-gesture that reads as a tap on whatever sits under the finger.
    return { swallow: true, wake: false, dissolve: false, touchHeld: touchStillDown, swallowUntil: st.swallowUntil };
  }
  if (now < st.swallowUntil) {
    return { swallow: true, wake: false, dissolve: false, touchHeld: false, swallowUntil: st.swallowUntil };
  }
  return { swallow: false, wake: false, dissolve: false, touchHeld: false, swallowUntil: 0 };
}

module.exports = {
  isScreensaverGrid,
  saverSettings,
  findSaverGrid,
  evaluateSaverTick,
  saverRestoreTarget,
  swallowDecision,
  WAKE_GRACE_MS,
};
