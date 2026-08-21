'use strict';
// "Fix that button" behavior: after a panel has been accepted, the next proposal in the same
// conversation should be able to REPLACE it rather than pile up a second copy. The replaced page
// keeps its id so page-tiles, rotation and the home page still point at something real.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPanelReview } = require('../app/panelGenerate');

const PANEL = { name: 'Chrome Shortcuts', cols: 2, rows: 1, tiles: [
  { label: 'New Tab', icon: '➕', type: 'key', value: 'control+t' },
  { label: 'Tab 1', icon: '1️⃣', type: 'key', value: 'control+1' },
] };

function make() {
  let n = 0;
  return createPanelReview({ existingIds: () => ['default'], makeId: () => 'gnew' + (++n) });
}

test('the first proposal has nothing to replace', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  assert.equal(r.state().replaces, null);
});

test('after accepting, the next proposal offers to replace that page', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  const first = r.accept();
  r.offer(JSON.stringify(PANEL));
  const s = r.state();
  assert.equal(s.replaces.id, first.page.id);
  assert.equal(s.replaces.name, 'Chrome Shortcuts');
});

test('replacing keeps the original page id', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  const first = r.accept();
  r.offer(JSON.stringify(PANEL));
  const second = r.accept(false, true);
  assert.equal(second.replaceId, first.page.id);
  assert.equal(second.page.id, first.page.id);
});

test('adding as new instead keeps a distinct id', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  const first = r.accept();
  r.offer(JSON.stringify(PANEL));
  const second = r.accept(false, false);
  assert.equal(second.replaceId, null);
  assert.notEqual(second.page.id, first.page.id);
});

test('the replace target follows the most recent accept', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  r.accept();
  r.offer(JSON.stringify(Object.assign({}, PANEL, { name: 'Second' })));
  const second = r.accept(false, false);        // added as new
  r.offer(JSON.stringify(PANEL));
  assert.equal(r.state().replaces.id, second.page.id);
});

test('forgetAccepted drops the target when the page is gone', () => {
  const r = make();
  r.offer(JSON.stringify(PANEL));
  r.accept();
  r.forgetAccepted();
  r.offer(JSON.stringify(PANEL));
  assert.equal(r.state().replaces, null);
});
