'use strict';
// routines: storage shaping, auto-naming, and resolving a tile's routine id into something
// runnable — including the cases where the routine or its AI Chat page has been deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { autoName, normalizeRoutine, normalizeList, resolveRoutine, aiVoicePages } = require('../app/routines');

const ids = (() => { let n = 0; return () => 'r' + (++n); })();
const chat = (id, name) => ({ id, name, kind: 'app', app: 'ai-voice' });
const grid = (id, name) => ({ id, name, kind: 'grid', tiles: [] });

// ---- auto-naming (the panel has no keyboard, so this is the only name a routine gets there) ----

test('autoName takes the opening words and marks the truncation', () => {
  assert.equal(autoName('Summarize my unread email'), 'Summarize my unread email');
  assert.equal(
    autoName('Summarize my unread email and list anything that needs a reply today'),
    'Summarize my unread email and list…');
});

test('autoName returns empty for an empty prompt', () => {
  assert.equal(autoName(''), '');
  assert.equal(autoName('   '), '');
  assert.equal(autoName(null), '');
});

// ---- storage shaping ----

test('normalizeRoutine fills a name from the prompt and mints an id', () => {
  const r = normalizeRoutine({ prompt: '  Run the standup summary  ' }, ids);
  assert.equal(r.prompt, 'Run the standup summary');
  assert.equal(r.name, 'Run the standup summary');
  assert.equal(r.id, 'r1');
  assert.equal(r.appPageId, '');
  assert.equal(r.profileId, '');
});

test('normalizeRoutine keeps a user-given name and existing id', () => {
  const r = normalizeRoutine({ id: 'keepme', name: 'Standup', prompt: 'do the thing', appPageId: 'p1', profileId: 'prof2' }, ids);
  assert.deepEqual(r, { id: 'keepme', name: 'Standup', prompt: 'do the thing', appPageId: 'p1', profileId: 'prof2', folder: '', mode: '' });
});

test('normalizeRoutine rejects an empty prompt — nothing may be saved that would do nothing', () => {
  assert.equal(normalizeRoutine({ prompt: '' }, ids), null);
  assert.equal(normalizeRoutine({ prompt: '   ', name: 'Looks fine' }, ids), null);
  assert.equal(normalizeRoutine(null, ids), null);
  assert.equal(normalizeRoutine('nope', ids), null);
});

test('normalizeList drops unusable rows and duplicate ids', () => {
  const out = normalizeList([
    { id: 'a', prompt: 'one' },
    { id: 'b', prompt: '' },          // half-saved row
    { id: 'a', prompt: 'dupe' },      // same id
    null,
    { id: 'c', prompt: 'two' },
  ], ids);
  assert.deepEqual(out.map(r => r.id), ['a', 'c']);
});

// ---- finding AI Chat pages ----

test('aiVoicePages picks only ai-voice app pages, in config order', () => {
  const grids = [grid('g1', 'Home'), chat('c1', 'Claude'), grid('g2', 'Media'), chat('c2', 'Codex')];
  assert.deepEqual(aiVoicePages(grids).map(g => g.id), ['c1', 'c2']);
  assert.deepEqual(aiVoicePages(null), []);
});

// ---- resolving a tile tap ----

const ROUTINES = [
  { id: 'r-standup', name: 'Standup', prompt: 'Summarize yesterday', appPageId: 'c1', profileId: '' },
  { id: 'r-gone', name: 'Orphan', prompt: 'do a thing', appPageId: 'deleted-page', profileId: 'prof1' },
  { id: 'r-blank', name: 'Blank', prompt: '', appPageId: 'c1', profileId: '' },
];

test('resolves to its own AI Chat page when that page still exists', () => {
  const r = resolveRoutine('r-standup', { routines: ROUTINES, grids: [grid('g1', 'Home'), chat('c1', 'Claude')] });
  assert.equal(r.ok, true);
  assert.equal(r.pageId, 'c1');
  assert.equal(r.routine.prompt, 'Summarize yesterday');
  assert.equal(r.warning, undefined);
});

test('falls back to the first AI Chat page when the saved one is gone, and says so', () => {
  const r = resolveRoutine('r-gone', { routines: ROUTINES, grids: [chat('c1', 'Claude'), chat('c2', 'Codex')] });
  assert.equal(r.ok, true);
  assert.equal(r.pageId, 'c1');
  assert.match(r.warning, /page is gone/);
  assert.match(r.warning, /Claude/);
});

test('unknown routine id reports it instead of doing nothing', () => {
  const r = resolveRoutine('r-nope', { routines: ROUTINES, grids: [chat('c1', 'Claude')] });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

test('no AI Chat page anywhere is an error, not a fallback', () => {
  const r = resolveRoutine('r-standup', { routines: ROUTINES, grids: [grid('g1', 'Home')] });
  assert.equal(r.ok, false);
  assert.match(r.error, /No AI Chat page/);
});

test('a routine whose prompt was emptied by hand is refused at run time too', () => {
  const r = resolveRoutine('r-blank', { routines: ROUTINES, grids: [chat('c1', 'Claude')] });
  assert.equal(r.ok, false);
  assert.match(r.error, /no prompt/);
});

test('a stale profileId is carried through — the host falls back on its own', () => {
  const r = resolveRoutine('r-gone', { routines: ROUTINES, grids: [chat('c1', 'Claude')] });
  assert.equal(r.routine.profileId, 'prof1');
});

// ---- working directory ----
// Only claude/codex/copilot pages have one; owui/api are plain chat. A folder is reported to the
// runner only when it actually differs from where the page already is, so a routine that names the
// folder you're already in doesn't restart the session (and wipe the conversation) for nothing.

const chatB = (id, name, backend, dir) => ({ id, name, kind: 'app', app: 'ai-voice', options: { backend, projectDir: dir } });

test('normalizeRoutine carries a folder and trims it', () => {
  const r = normalizeRoutine({ prompt: 'go', folder: '  D:/Github/open-quake  ' }, ids);
  assert.equal(r.folder, 'D:/Github/open-quake');
  assert.equal(normalizeRoutine({ prompt: 'go' }, ids).folder, '');
});

test('a folder that differs from the page is reported so the session restarts there', () => {
  const list = [{ id: 'r1', prompt: 'build it', appPageId: 'c1', folder: 'D:/Github/open-quake' }];
  const r = resolveRoutine('r1', { routines: list, grids: [chatB('c1', 'Claude', 'claude', 'D:/Github/other')] });
  assert.equal(r.ok, true);
  assert.equal(r.folder, 'D:/Github/open-quake');
});

test('a folder the page is already in is NOT reported — no needless session restart', () => {
  const list = [{ id: 'r1', prompt: 'build it', appPageId: 'c1', folder: 'D:/Github/open-quake' }];
  const r = resolveRoutine('r1', { routines: list, grids: [chatB('c1', 'Claude', 'claude', 'D:/Github/open-quake')] });
  assert.equal(r.folder, '');
});

test('a chat-only backend ignores a folder even if one was stored', () => {
  const list = [{ id: 'r1', prompt: 'summarize', appPageId: 'c1', folder: 'D:/Github/open-quake' }];
  for (const backend of ['owui', 'api']) {
    const r = resolveRoutine('r1', { routines: list, grids: [chatB('c1', 'Chat', backend, '')] });
    assert.equal(r.folder, '', backend + ' should have no folder');
  }
});

test('codex and copilot pages do take a folder', () => {
  const list = [{ id: 'r1', prompt: 'build it', appPageId: 'c1', folder: 'D:/repo' }];
  for (const backend of ['codex', 'copilot']) {
    const r = resolveRoutine('r1', { routines: list, grids: [chatB('c1', 'Agent', backend, '')] });
    assert.equal(r.folder, 'D:/repo', backend + ' should take a folder');
  }
});

test('the fallback page decides folder applicability, not the deleted one', () => {
  const list = [{ id: 'r1', prompt: 'go', appPageId: 'gone', folder: 'D:/repo' }];
  const r = resolveRoutine('r1', { routines: list, grids: [chatB('c9', 'Open WebUI', 'owui', '')] });
  assert.equal(r.pageId, 'c9');
  assert.equal(r.folder, '');            // landed on a chat-only page — the folder is meaningless there
  assert.match(r.warning, /page is gone/);
});

// ---- permission mode ----
// Parallel to folder: a routine records the page's permission mode and re-applies it on run.
// resolveRoutine just carries the stored mode through; main sets it after any folder restart.

test('normalizeRoutine carries a mode and trims it, blank by default', () => {
  assert.equal(normalizeRoutine({ prompt: 'go', mode: '  plan  ' }, ids).mode, 'plan');
  assert.equal(normalizeRoutine({ prompt: 'go' }, ids).mode, '');
});

test('resolveRoutine passes the stored mode through untouched', () => {
  const list = [{ id: 'r1', prompt: 'refactor', appPageId: 'c1', mode: 'plan' }];
  const r = resolveRoutine('r1', { routines: list, grids: [chatB('c1', 'Claude', 'claude', '')] });
  assert.equal(r.routine.mode, 'plan');
});

// ---- planRoutineRun: how a routine applies to the page it runs on ----
// Regression guard for the crash where applying a routine's mode/profile via the live mid-session
// switches restarted claude with --resume and died on "No conversation found". The plan applies
// context through page OPTIONS and only asks for a FRESH restart when a live session must change.
const { planRoutineRun } = require('../app/routines');

test('cold page: set options, no restart (the lazy first-turn start reads them)', () => {
  const plan = planRoutineRun({ routine: { profileId: 'p2', mode: 'plan' }, folder: '', running: false, curProfile: '', curMode: '' });
  assert.deepEqual(plan.options, { profilePick: 'p2', permissionMode: 'plan' });
  assert.equal(plan.persist, true);
  assert.equal(plan.restart, false);
});

test('live session on a different mode: fresh restart', () => {
  const plan = planRoutineRun({ routine: { mode: 'plan' }, folder: '', running: true, curProfile: '', curMode: 'manual' });
  assert.equal(plan.options.permissionMode, 'plan');
  assert.equal(plan.restart, true);
});

test('live session already on the routine mode/profile: append, no restart', () => {
  const plan = planRoutineRun({ routine: { profileId: 'p2', mode: 'plan' }, folder: '', running: true, curProfile: 'p2', curMode: 'plan' });
  assert.equal(plan.restart, false);
});

test('a folder always forces a fresh restart on a live session, and lands in that folder', () => {
  const plan = planRoutineRun({ routine: { mode: 'plan' }, folder: 'D:/repo', running: true, curProfile: '', curMode: 'plan' });
  assert.equal(plan.options.projectDir, 'D:/repo');
  assert.equal(plan.restart, true);
});

test('prompt-only routine on a live session: nothing to set, no restart', () => {
  const plan = planRoutineRun({ routine: {}, folder: '', running: true, curProfile: 'p2', curMode: 'plan' });
  assert.deepEqual(plan.options, {});
  assert.equal(plan.persist, false);
  assert.equal(plan.restart, false);
});

test('a live profile change with no mode change still restarts fresh (no --resume)', () => {
  const plan = planRoutineRun({ routine: { profileId: 'p3' }, folder: '', running: true, curProfile: 'p2', curMode: 'plan' });
  assert.equal(plan.options.profilePick, 'p3');
  assert.equal(plan.restart, true);   // the point: fresh start, never setProfile's resume-restart
});
