'use strict';

// LucidType cleanup/rewrite review state machine (Phase 2). Drives the controller with a mock AI +
// clipboard, verifying: source = box text (else clipboard), working->ready transition, mode passthrough
// for rewrite, and apply/cancel. No electron — createWindow is a stub that's never used by these paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLucidDictation } = require('../app/lucidtypeDictation');

function make(overrides) {
  const o = overrides || {};
  const calls = [];
  const c = createLucidDictation({
    createWindow: () => ({ isDestroyed: () => false, on: () => {}, webContents: { isLoading: () => false, send: () => {} } }),
    transform: async (arg) => { calls.push(arg); return (o.transform ? o.transform(arg) : 'OUT: ' + arg.text); },
    readClipboard: () => (o.clip == null ? '' : o.clip),
    resolveSettings: () => Object.assign({ rewriteMode: 'professional', startMode: 'clear', notifyBeep: false }, o.settings || {}),
    resolveEndpoints: () => ({}),
    transcribe: async () => '',
    onState: () => {},
  });
  return { c, calls };
}

test('runCleanup on an empty box pulls clipboard text into the box and cleans it', async () => {
  const { c, calls } = make({ clip: 'raw clipboard text' });
  const r = await c.runCleanup();
  assert.equal(r.ok, true);
  const st = c.state();
  assert.equal(st.transcript, 'raw clipboard text');          // clipboard adopted into the box
  assert.equal(st.review.active, true);
  assert.equal(st.review.kind, 'cleanup');
  assert.equal(st.review.status, 'ready');
  assert.equal(st.review.original, 'raw clipboard text');
  assert.equal(st.review.proposed, 'OUT: raw clipboard text');
  assert.equal(calls[0].kind, 'cleanup');
});

test('runCleanup with empty box AND empty clipboard is rejected', async () => {
  const { c, calls } = make({ clip: '   ' });
  const r = await c.runCleanup();
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing to cleanup/);
  assert.equal(calls.length, 0);
  assert.equal(c.state().review.active, false);
});

test('runRewrite uses the box text and passes the current rewrite mode', async () => {
  const { c, calls } = make({ settings: { rewriteMode: 'concise' } });
  c.setTranscript('make this shorter please');
  const r = await c.runRewrite();
  assert.equal(r.ok, true);
  assert.equal(calls[0].kind, 'rewrite');
  assert.equal(calls[0].mode, 'concise');
  assert.equal(c.state().review.mode, 'concise');
});

test('applyReview lands the proposal in the box and closes the review', async () => {
  const { c } = make({ transform: () => 'CLEANED.' });
  c.setTranscript('dirty text');
  await c.runCleanup();
  c.applyReview();
  assert.equal(c.currentText(), 'CLEANED.');
  assert.equal(c.state().review.active, false);
});

test('applyReview can accept an edited proposal; cancelReview discards', async () => {
  const { c } = make({});
  c.setTranscript('x');
  await c.runCleanup();
  c.applyReview('hand-edited final');
  assert.equal(c.currentText(), 'hand-edited final');

  c.setTranscript('y');
  await c.runCleanup();
  c.cancelReview();
  assert.equal(c.state().review.active, false);
  assert.equal(c.currentText(), 'y');   // unchanged on cancel
});

test('a failing AI surfaces an error review, not a crash', async () => {
  const { c } = make({ transform: () => { throw new Error('endpoint down'); } });
  c.setTranscript('text');
  const r = await c.runCleanup();
  assert.equal(r.ok, false);
  const st = c.state();
  assert.equal(st.review.active, true);
  assert.equal(st.review.status, 'error');
  assert.match(st.review.error, /endpoint down/);
});
