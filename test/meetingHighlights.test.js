'use strict';
// meetingHighlights: span open/close/cancel, the recording-state edges that arm and flush them,
// and the read-merge-write into the recording's sidecar. Real fs in a temp dir, injected clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingHighlights, MIN_SPAN_MS } = require('../app/meetingHighlights');

function harness(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-hl-'));
  const clock = { t: 1000000 };
  const h = createMeetingHighlights({
    fs,
    resolveFolders: () => ({ unprocessed: dir }),
    resolveSettings: () => ({ highlightEnabled: (opts && 'enabled' in opts) ? opts.enabled : true }),
    now: () => clock.t,
  });
  const sidecar = () => path.join(dir, 'rec.json');
  const read = () => JSON.parse(fs.readFileSync(sidecar(), 'utf8'));
  // Mirrors what meetingRecorder.getState() hands main's onState on each edge.
  const startRec = () => h.onRecordingState({ recording: true, startedAt: clock.t, file: 'rec.wav' });
  const stopRec = () => h.onRecordingState({ recording: false, startedAt: null, file: null });
  return { dir, clock, h, sidecar, read, startRec, stopRec };
}

test('a closed span is written to the sidecar as ms offsets from recording start', () => {
  const t = harness();
  t.startRec();
  t.clock.t += 30000;
  t.h.start();
  t.clock.t += 45000;
  t.h.stop();
  assert.deepEqual(t.read().highlights, [{ startMs: 30000, endMs: 75000 }]);
});

test('multiple spans accumulate in order', () => {
  const t = harness();
  t.startRec();
  t.clock.t += 10000; t.h.start();
  t.clock.t += 5000;  t.h.stop();
  t.clock.t += 20000; t.h.start();
  t.clock.t += 8000;  t.h.stop();
  assert.deepEqual(t.read().highlights, [
    { startMs: 10000, endMs: 15000 },
    { startMs: 35000, endMs: 43000 },
  ]);
});

test('an unclosed span is auto-closed at the recording end', () => {
  const t = harness();
  t.startRec();
  t.clock.t += 60000;
  t.h.start();
  t.clock.t += 90000;
  t.stopRec();                       // call ended, no Stop tap
  assert.deepEqual(t.read().highlights, [{ startMs: 60000, endMs: 150000 }]);
});

test('cancel discards the span in progress but keeps finished ones', () => {
  const t = harness();
  t.startRec();
  t.clock.t += 5000;  t.h.start();
  t.clock.t += 9000;  t.h.stop();          // keeper
  t.clock.t += 3000;  t.h.start();
  t.clock.t += 4000;  t.h.cancel();        // mis-tap, thrown away
  t.stopRec();
  assert.deepEqual(t.read().highlights, [{ startMs: 5000, endMs: 14000 }]);
  assert.equal(t.h.getState().highlighting, false);
});

test('a start+stop inside the minimum span is dropped as a mis-tap', () => {
  const t = harness();
  t.startRec();
  t.clock.t += 4000; t.h.start();
  t.clock.t += MIN_SPAN_MS - 1; t.h.stop();
  t.stopRec();
  assert.equal(fs.existsSync(t.sidecar()), false);   // nothing to write, so no sidecar invented
});

test('flush merges into an existing sidecar without touching the calendar fields', () => {
  const t = harness();
  fs.writeFileSync(t.sidecar(), JSON.stringify({ subject: 'Weekly sync', organizer: 'T.J. Schmitz' }));
  t.startRec();
  t.clock.t += 1000; t.h.start();
  t.clock.t += 6000; t.h.stop();
  const obj = t.read();
  assert.equal(obj.subject, 'Weekly sync');
  assert.equal(obj.organizer, 'T.J. Schmitz');
  assert.deepEqual(obj.highlights, [{ startMs: 1000, endMs: 7000 }]);
});

test('a new recording starts from an empty span list', () => {
  const t = harness();
  t.startRec();
  t.clock.t += 2000; t.h.start();
  t.clock.t += 5000; t.h.stop();
  t.stopRec();
  assert.equal(t.read().highlights.length, 1);
  t.startRec();                                  // second recording, same folder
  assert.equal(t.h.getState().count, 0);
});

test('start is refused while nothing is recording', () => {
  const t = harness();
  t.h.start();
  assert.equal(t.h.getState().highlighting, false);
  assert.equal(t.h.getState().canHighlight, false);
});

test('start is refused while the feature is disabled', () => {
  const t = harness({ enabled: false });
  t.startRec();
  t.h.start();
  assert.equal(t.h.getState().highlighting, false);
  assert.equal(t.h.getState().enabled, false);
});

test('a second start while highlighting does not restart the span', () => {
  const t = harness();
  t.startRec();
  t.clock.t += 3000; t.h.start();
  t.clock.t += 4000; t.h.start();          // double tap
  t.clock.t += 4000; t.h.stop();
  assert.deepEqual(t.read().highlights, [{ startMs: 3000, endMs: 11000 }]);
});

test('getState reports the running span length while highlighting', () => {
  const t = harness();
  t.startRec();
  t.clock.t += 1000; t.h.start();
  t.clock.t += 12000;
  const st = t.h.getState();
  assert.equal(st.highlighting, true);
  assert.equal(st.spanMs, 12000);
});

test('an unreadable sidecar is rewritten rather than losing the spans', () => {
  const t = harness();
  fs.writeFileSync(t.sidecar(), '{ this is not json');
  t.startRec();
  t.clock.t += 1000; t.h.start();
  t.clock.t += 5000; t.h.stop();
  assert.deepEqual(t.read().highlights, [{ startMs: 1000, endMs: 6000 }]);
});
