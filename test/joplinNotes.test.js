'use strict';
// joplinNotes: tag derivation from the basename, URL normalization, and the Data API flow
// (notebook lookup, note create, existing-tags-only attach) against a fake fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalysisNote, tagsFor, normalizeJoplinUrl } = require('../app/joplinNotes');

test('tagsFor: base tags, year, keyword extras, case-insensitive dedupe', () => {
  assert.deepEqual(tagsFor('2026-08-19-09-57-16-Titan coordination meeting'),
    ['meeting notes', '2026', 'Titan']);
  // "Syntax" implies S4 Hana + SAP; "SAP" separately must not duplicate
  assert.deepEqual(tagsFor('2026-08-17-13-59-09-SAP S4 HANA - weekly Syntax check-in'),
    ['meeting notes', '2026', 'SAP', 'S4 Hana']);
  assert.deepEqual(tagsFor('no-stamp G1 review'), ['meeting notes', 'audit']);
});

test('normalizeJoplinUrl: bare host, port, scheme, garbage', () => {
  assert.equal(normalizeJoplinUrl('192.168.1.50:41184'), 'http://192.168.1.50:41184');
  assert.equal(normalizeJoplinUrl('http://box:41184/'), 'http://box:41184');
  assert.equal(normalizeJoplinUrl('https://joplin.example.com'), 'https://joplin.example.com');
  assert.equal(normalizeJoplinUrl(''), null);
});

// Fake Joplin Data API: notebook "NW Pipe", tags "meeting notes" + "titan" exist; records calls.
function fakeApi(overrides) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const method = (opts && opts.method) || 'GET';
    calls.push({ method, path: u.pathname, body: opts && opts.body ? JSON.parse(opts.body) : null, token: u.searchParams.get('token') });
    const ok = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (overrides && overrides[u.pathname]) return overrides[u.pathname]({ method, url: u });
    if (u.pathname === '/folders') return ok({ items: [{ id: 'f1', title: 'NW Pipe' }, { id: 'f2', title: 'Personal' }], has_more: false });
    if (u.pathname === '/notes' && method === 'POST') return ok({ id: 'n1' });
    if (u.pathname === '/tags') return ok({ items: [{ id: 't1', title: 'meeting notes' }, { id: 't2', title: 'titan' }], has_more: false });
    if (/^\/tags\/[^/]+\/notes$/.test(u.pathname)) return ok({});
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  return { calls, fetchImpl };
}

test('createAnalysisNote: files to the notebook, attaches only existing tags', async () => {
  const f = fakeApi();
  const r = await createAnalysisNote({
    url: '192.168.1.50:41184', token: 'tok', notebook: 'nw pipe',
    title: '2026-08-19-09-57-16-Titan coordination meeting', body: '# Meeting Analysis', fetchImpl: f.fetchImpl,
  });
  assert.equal(r.id, 'n1');
  assert.deepEqual(r.applied, ['meeting notes', 'titan']);   // Joplin's own casing echoed back
  assert.deepEqual(r.skipped, ['2026']);                     // wanted, but no such tag in Joplin
  const note = f.calls.find(c => c.path === '/notes');
  assert.equal(note.body.parent_id, 'f1');                   // case-insensitive notebook match
  assert.equal(note.token, 'tok');
  const attaches = f.calls.filter(c => /^\/tags\//.test(c.path));
  assert.deepEqual(attaches.map(c => c.body.id), ['n1', 'n1']);
});

test('createAnalysisNote: missing notebook / token / URL are named errors', async () => {
  const f = fakeApi();
  await assert.rejects(
    createAnalysisNote({ url: 'box:41184', token: 'tok', notebook: 'Nope', title: 't', body: 'b', fetchImpl: f.fetchImpl }),
    /notebook "Nope" not found/);
  await assert.rejects(
    createAnalysisNote({ url: '', token: 'tok', notebook: 'NW Pipe', title: 't', body: 'b', fetchImpl: f.fetchImpl }),
    /Joplin API URL is not set/);
  await assert.rejects(
    createAnalysisNote({ url: 'box:41184', token: '', notebook: 'NW Pipe', title: 't', body: 'b', fetchImpl: f.fetchImpl }),
    /token is not set/);
});

test('createAnalysisNote: 401 maps to token wording, transport error names the fix', async () => {
  const f401 = fakeApi({ '/folders': () => ({ ok: false, status: 401, text: async () => '' }) });
  await assert.rejects(
    createAnalysisNote({ url: 'box:41184', token: 'bad', notebook: 'NW Pipe', title: 't', body: 'b', fetchImpl: f401.fetchImpl }),
    /rejected the API token/);
  const fDown = { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(
    createAnalysisNote({ url: 'box:41184', token: 'tok', notebook: 'NW Pipe', title: 't', body: 'b', fetchImpl: fDown.fetchImpl }),
    /is Joplin Desktop running/);
});

test('createAnalysisNote: paginated folders and tags are walked', async () => {
  const f = fakeApi({
    '/folders': ({ url }) => {
      const page = Number(url.searchParams.get('page') || 1);
      const body = page === 1
        ? { items: [{ id: 'fx', title: 'Other' }], has_more: true }
        : { items: [{ id: 'f1', title: 'NW Pipe' }], has_more: false };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  const r = await createAnalysisNote({
    url: 'box:41184', token: 'tok', notebook: 'NW Pipe', title: 'plain title', body: 'b', fetchImpl: f.fetchImpl,
  });
  assert.equal(r.id, 'n1');
  assert.deepEqual(r.applied, ['meeting notes']);
});
