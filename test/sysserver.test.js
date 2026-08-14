'use strict';
// Pins the CURRENT behavior of sysserver's claude-voice HTTP surface before the voice-app
// registry refactor (codex-voice plan, Phase 0). These tests must pass UNCHANGED after the
// refactor phases — they are the tripwire for the security-relevant gating (loopback Host
// check, same-origin gate on side-effecting routes, POST allowlist, approval-request token)
// and for the route contracts the panel page depends on.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sysserver = require('../app/sysserver');

let port;
const calls = [];
const otherCalls = [];   // second registered voice app -- proves per-app isolation
const TOKEN = 'test-voice-token';
const OTHER_TOKEN = 'other-voice-token';

// Handlers follow the voicepanel-host.js `handlers` contract (the registry form).
function makeHandlers(sink) {
  return {
    onTurn: (text, speak) => { sink.push(['turn', text, speak]); return { ok: true, speech: '7' }; },
    getState: () => ({ running: true, status: 'idle' }),
    subscribe: (req, res) => {
      sink.push(['subscribe']);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.end(': connected\n\n');   // the real handler holds this open; ending lets fetch() complete
    },
    transcribe: async pcm => { sink.push(['audio', pcm.length]); return { ok: true, text: 'hi' }; },
    synthesize: (text, res) => {
      sink.push(['synth', text]);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end('RIFF');
    },
    turnAudio: (turnId, req, res) => {
      sink.push(['turn-audio', turnId]);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end();
    },
    approvalRequest: (body, res) => {
      sink.push(['approval-request', body && body.toolName]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    approvalDecision: (id, decision) => { sink.push(['decision', id, decision]); return true; },
    sessionStart: dir => { sink.push(['session-start', dir]); return true; },
    sessionStop: () => { sink.push(['session-stop']); return true; },
    setPermissionMode: mode => { sink.push(['mode', mode]); return true; },
    setModel: model => { sink.push(['model', model]); return true; },
    setOption: (key, value) => { sink.push(['option', key, value]); return true; },
    getProjects: () => ({ root: 'r', parent: null, dirs: [], current: '', recents: [] }),
  };
}

test.before(async () => {
  port = await sysserver.start({
    voiceApps: {
      'claude-voice': { htmlFile: 'claudevoiceview.html', handlers: makeHandlers(calls), voiceToken: TOKEN },
      'other-voice': { htmlFile: 'claudevoiceview.html', handlers: makeHandlers(otherCalls), voiceToken: OTHER_TOKEN },
    },
  });
});
test.after(() => sysserver.stop());
test.beforeEach(() => { calls.length = 0; otherCalls.length = 0; });

const base = () => 'http://127.0.0.1:' + port;
// Browser-shaped request: our served pages always send Sec-Fetch-Site: same-origin.
const pageFetch = (p, opts = {}) =>
  fetch(base() + p, Object.assign({}, opts, { headers: Object.assign({ 'sec-fetch-site': 'same-origin' }, opts.headers || {}) }));
const postJson = (p, body, headers) =>
  pageFetch(p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });

// Raw request with a forged Host header (fetch forbids setting Host).
function rawRequest({ hostHeader, method = 'GET', path = '/' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: hostHeader } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('foreign Host header is rejected on every route (DNS-rebinding gate)', async () => {
  assert.equal(await rawRequest({ hostHeader: 'evil.example', path: '/' }), 403);
  assert.equal(await rawRequest({ hostHeader: 'evil.example', path: '/claude-voice/state' }), 403);
});

test('POST is 405 everywhere except the voice POST allowlist', async () => {
  const r = await pageFetch('/metrics', { method: 'POST' });
  assert.equal(r.status, 405);
});

test('side-effecting voice routes fail closed without same-origin evidence', async () => {
  // No Sec-Fetch-Site and no Origin at all -> 403.
  const bare = await fetch(base() + '/claude-voice/turn', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(bare.status, 403);
  // Explicit cross-site -> 403.
  const cross = await postJson('/claude-voice/turn', { text: 'x' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  assert.deepEqual(calls, []);
});

test('turn POST reaches the callback and returns its {ok, speech}', async () => {
  const r = await postJson('/claude-voice/turn', { text: 'hello', speak: true });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, speech: '7' });
  assert.deepEqual(calls, [['turn', 'hello', true]]);
});

test('approval-request is token-gated, not origin-gated', async () => {
  // Wrong/missing token -> 403, callback NEVER invoked (this is the hook's only gate).
  const noToken = await fetch(base() + '/claude-voice/approval-request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolName: 'Bash' }),
  });
  assert.equal(noToken.status, 403);
  assert.deepEqual(calls, []);
  const withToken = await fetch(base() + '/claude-voice/approval-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-oqx-voice-token': TOKEN },
    body: JSON.stringify({ toolName: 'Bash' }),
  });
  assert.equal(withToken.status, 200);
  assert.deepEqual(calls, [['approval-request', 'Bash']]);
});

test('events route subscribes with SSE headers', async () => {
  const r = await pageFetch('/claude-voice/events');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.deepEqual(calls, [['subscribe']]);
});

test('page and static assets are served with correct types', async () => {
  const page = await pageFetch('/claude-voice');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const js = await pageFetch('/claudevoiceview.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /application\/javascript/);
  const vad = await pageFetch('/claudevoice-vad.js');
  assert.equal(vad.status, 200);
  assert.match(vad.headers.get('content-type'), /application\/javascript/);
});

test('state returns the callback snapshot', async () => {
  const r = await pageFetch('/claude-voice/state');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { running: true, status: 'idle' });
});

test('tts stores text by id and tts-audio synthesizes it', async () => {
  const stored = await postJson('/claude-voice/tts', { text: 'hello world' });
  const { ok, id } = await stored.json();
  assert.equal(ok, true);
  assert.ok(id);
  const audio = await pageFetch('/claude-voice/tts-audio?id=' + encodeURIComponent(id));
  assert.equal(audio.status, 200);
  assert.match(audio.headers.get('content-type'), /audio\/wav/);
  assert.deepEqual(calls, [['synth', 'hello world']]);
});

test('turn-audio hands the turn id to the callback', async () => {
  const r = await pageFetch('/claude-voice/turn-audio?turn=42');
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [['turn-audio', '42']]);
});

test('audio POST delivers the raw PCM body', async () => {
  const pcm = Buffer.alloc(320, 7);
  const r = await pageFetch('/claude-voice/audio', { method: 'POST', body: pcm });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, text: 'hi' });
  assert.deepEqual(calls, [['audio', 320]]);
});

test('option, permission-mode, model, approval-decision, session start/stop round-trip', async () => {
  await postJson('/claude-voice/option', { key: 'chatFontSize', value: '18' });
  await postJson('/claude-voice/permission-mode', { mode: 'manual' });
  await postJson('/claude-voice/model', { model: 'sonnet' });
  await postJson('/claude-voice/approval-decision', { requestId: 'r1', decision: 'allow' });
  await postJson('/claude-voice/session/start', { projectDir: 'D:\\x' });
  await postJson('/claude-voice/session/stop', {});
  assert.deepEqual(calls, [
    ['option', 'chatFontSize', '18'],
    ['mode', 'manual'],
    ['model', 'sonnet'],
    ['decision', 'r1', 'allow'],
    ['session-start', 'D:\\x'],
    ['session-stop'],
  ]);
});

test('model route accepts the empty string (account default) but rejects a missing field', async () => {
  const empty = await postJson('/claude-voice/model', { model: '' });
  assert.deepEqual(await empty.json(), { ok: true });
  const missing = await postJson('/claude-voice/model', {});
  assert.deepEqual(await missing.json(), { ok: false });
  assert.deepEqual(calls, [['model', '']]);
});

// ---- registry semantics (Phase 2): per-app dispatch, isolation, and unknown prefixes ----

test('unregistered voice prefix gets no voice routes (404 fallthrough, 405 for POST)', async () => {
  const state = await pageFetch('/codex-voice/state');
  assert.equal(state.status, 404);
  const turn = await postJson('/codex-voice/turn', { text: 'x' });
  assert.equal(turn.status, 405);   // not in any app's POST allowlist -> the GET-only wall
  assert.deepEqual(calls, []);
  assert.deepEqual(otherCalls, []);
});

test('two registered apps dispatch to their own handlers only', async () => {
  await postJson('/claude-voice/turn', { text: 'to claude', speak: false });
  await postJson('/other-voice/turn', { text: 'to other', speak: true });
  assert.deepEqual(calls, [['turn', 'to claude', false]]);
  assert.deepEqual(otherCalls, [['turn', 'to other', true]]);
});

test('approval tokens do not cross apps', async () => {
  // claude's token against the other app's approval route -> rejected, handler untouched.
  const crossed = await fetch(base() + '/other-voice/approval-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-oqx-voice-token': TOKEN },
    body: JSON.stringify({ toolName: 'Bash' }),
  });
  assert.equal(crossed.status, 403);
  assert.deepEqual(otherCalls, []);
  // the right token still works.
  const ok = await fetch(base() + '/other-voice/approval-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-oqx-voice-token': OTHER_TOKEN },
    body: JSON.stringify({ toolName: 'Bash' }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(otherCalls, [['approval-request', 'Bash']]);
  assert.deepEqual(calls, []);
});

test('both apps serve the page at their own prefix', async () => {
  for (const prefix of ['/claude-voice', '/other-voice']) {
    const r = await pageFetch(prefix);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
  }
});
