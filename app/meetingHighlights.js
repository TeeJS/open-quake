'use strict';
// meetingHighlights.js — MAIN PROCESS
//
// Mid-meeting highlights: tap Start Highlighting to open a span, tap again to close it. Each
// span is a pair of millisecond offsets from the moment the recording started — the SAME clock
// the diarizer's segment start/end use, since both count from sample 0 of the WAV. They line up
// exactly, with none of the drift that limits the Teams VTT to speaker identity only.
//
// Spans are written into the recording's <base>.json sidecar, the same file the Outlook calendar
// lookup writes. That's deliberate: the sidecar is already renamed alongside the WAV
// (appendMeetingNameToRecording), moved to the processed folder with it (meetingTranscribe), and
// deleted with it (meetingLibrary) — highlights inherit all three for free. Both writers
// read-merge-write so a late calendar lookup can't clobber the spans, or vice versa.
//
// Everything is injected (fs, folders, clock) so the module tests without Electron — same pattern
// as meetingLibrary and officeActions.

const path = require('path');

const MIN_SPAN_MS = 1000;   // a start+stop inside one second is a mis-tap, not a highlight

/**
 * deps:
 *   fs               -> node fs (injectable for tests)
 *   resolveFolders() -> { unprocessed }        where the live recording is being written
 *   resolveSettings()-> { highlightEnabled }   the Meetings-tab checkbox
 *   now()            -> epoch ms (injectable clock)
 *   log(msg)         -> optional logger
 */
function createMeetingHighlights(deps) {
  const fsMod = deps.fs || require('fs');
  const now = deps.now || (() => Date.now());
  const log = deps.log || function () {};

  let recording = false;
  let startedAt = null;    // recorder's start epoch — the zero point for every offset
  let base = null;         // recording basename without .wav, i.e. the sidecar's basename
  let spans = [];          // [{ startMs, endMs }] closed spans, in order
  let openStartMs = null;  // offset of the span in progress, or null

  function enabled() {
    const s = (deps.resolveSettings && deps.resolveSettings()) || {};
    return !!s.highlightEnabled;
  }

  function offsetNow() { return startedAt ? Math.max(0, now() - startedAt) : 0; }

  // Called on every recorder state change. The idle->recording edge resets everything and
  // remembers the file we're highlighting; the recording->idle edge auto-closes any span still
  // open (the call ended before a Stop tap — losing the flag is worse than a slightly long span)
  // and flushes to the sidecar. `st.file` is already null on the stopping edge, which is why the
  // basename is captured on the way in.
  function onRecordingState(st) {
    const isRec = !!(st && st.recording);
    if (isRec && !recording) {
      startedAt = st.startedAt || now();
      base = st.file ? String(st.file).replace(/\.wav$/i, '') : null;
      spans = [];
      openStartMs = null;
    } else if (!isRec && recording) {
      if (openStartMs !== null) { closeSpan(offsetNow()); log('highlight auto-closed at recording end'); }
      flush();
      startedAt = null;
      base = null;
    }
    recording = isRec;
  }

  function closeSpan(endMs) {
    const startMs = openStartMs;
    openStartMs = null;
    if (startMs === null) return false;
    if (endMs - startMs < MIN_SPAN_MS) return false;   // mis-tap; drop it silently
    spans.push({ startMs: startMs, endMs: endMs });
    return true;
  }

  function start() {
    if (!enabled()) return getState();
    if (!recording) return getState();          // panel greys the button, but the route is public
    if (openStartMs !== null) return getState();
    openStartMs = offsetNow();
    log('highlight started at ' + openStartMs + 'ms');
    return getState();
  }

  function stop() {
    if (openStartMs === null) return getState();
    const kept = closeSpan(offsetNow());
    log(kept ? 'highlight ended (' + spans.length + ' total)' : 'highlight discarded — under ' + MIN_SPAN_MS + 'ms');
    if (kept) flush();   // survive a crash mid-meeting; the stop edge rewrites the same file
    return getState();
  }

  // "Clear current highlight" — discards the span in progress only. Finished spans stay.
  function cancel() {
    if (openStartMs === null) return getState();
    openStartMs = null;
    log('highlight in progress cleared');
    return getState();
  }

  // Merge the spans into <base>.json without disturbing whatever the calendar lookup put there.
  // Best-effort throughout: a failed write must never affect the recording itself.
  function flush() {
    if (!base || !spans.length) return;
    let dir = '';
    try { dir = ((deps.resolveFolders && deps.resolveFolders()) || {}).unprocessed || ''; } catch (e) {}
    if (!dir) return;
    const file = path.join(dir, base + '.json');
    let obj = {};
    try { if (fsMod.existsSync(file)) obj = JSON.parse(fsMod.readFileSync(file, 'utf8')) || {}; }
    catch (e) { log('sidecar unreadable, rewriting: ' + e.message); obj = {}; }
    obj.highlights = spans.map(s => ({ startMs: s.startMs, endMs: s.endMs }));
    try {
      fsMod.writeFileSync(file, JSON.stringify(obj, null, 2));
      log('wrote ' + spans.length + ' highlight' + (spans.length === 1 ? '' : 's') + ' -> ' + base + '.json');
    } catch (e) { log('highlight write failed: ' + e.message); }
  }

  function getState() {
    return {
      enabled: enabled(),
      canHighlight: recording,
      highlighting: openStartMs !== null,
      spanMs: openStartMs !== null ? Math.max(0, offsetNow() - openStartMs) : 0,
      count: spans.length,
    };
  }

  return { onRecordingState, start, stop, cancel, getState, flush };
}

module.exports = { createMeetingHighlights, MIN_SPAN_MS };
