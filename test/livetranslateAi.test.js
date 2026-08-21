'use strict';
// AI-translate provider (Live Translate host): request shaping, rolling context, and config gating.
// Runs a real local HTTP server standing in for the OpenAI-compatible endpoint.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createLiveTranslateHost } = require('../app/livetranslate-host');

function makeHost(options, voiceEndpoints) {
  return createLiveTranslateHost({
    appId: 'livetranslate',
    log: () => {},
    deps: {
      activeServedAppConfig: () => ({ options }),
      activeGrid: () => null,
      saveConfig: () => {},
      getDocumentsPath: () => null,
      voiceEndpoints: () => voiceEndpoints || {},
    },
  });
}

// Local stand-in endpoint: records each request body, answers with a canned translation.
function startEndpoint(replies) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: replies[Math.min(seen.length - 1, replies.length - 1)] } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('aiTranslate sends an OpenAI-compatible request and returns the translation', async () => {
  const { server, seen, port } = await startEndpoint(['The coffee is cold.']);
  try {
    const host = makeHost({ provider: 'ai', aiBaseUrl: 'http://127.0.0.1:' + port, aiApiKey: 'sk-test', aiModel: 'test-model', targetLanguage: 'en' });
    const out = await host._aiTranslate('Der Kaffee ist kalt.');
    assert.equal(out, 'The coffee is cold.');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/chat/completions');
    assert.equal(seen[0].auth, 'Bearer sk-test');
    assert.equal(seen[0].body.model, 'test-model');
    assert.equal(seen[0].body.stream, false);
    const msgs = seen[0].body.messages;
    assert.equal(msgs[0].role, 'system');
    assert.ok(msgs[0].content.includes('into en'));
    assert.deepEqual(msgs[msgs.length - 1], { role: 'user', content: 'Der Kaffee ist kalt.' });
  } finally { server.close(); }
});

test('rolling context carries prior pairs into the next request', async () => {
  const { server, seen, port } = await startEndpoint(['The coffee is cold.', 'Is it cold?']);
  try {
    const host = makeHost({ provider: 'ai', aiBaseUrl: 'http://127.0.0.1:' + port, aiApiKey: 'k', aiModel: 'm', targetLanguage: 'en' });
    await host._aiTranslate('Der Kaffee ist kalt.');
    await host._aiTranslate('Ist er kalt?');
    const msgs = seen[1].body.messages;
    // system + prior (user, assistant) pair + current user
    assert.equal(msgs.length, 4);
    assert.deepEqual(msgs[1], { role: 'user', content: 'Der Kaffee ist kalt.' });
    assert.deepEqual(msgs[2], { role: 'assistant', content: 'The coffee is cold.' });
    assert.deepEqual(msgs[3], { role: 'user', content: 'Ist er kalt?' });
  } finally { server.close(); }
});

test('context window is capped at 6 pairs per request', async () => {
  const { server, seen, port } = await startEndpoint(['x']);
  try {
    const host = makeHost({ provider: 'ai', aiBaseUrl: 'http://127.0.0.1:' + port, aiApiKey: 'k', aiModel: 'm', targetLanguage: 'en' });
    for (let i = 0; i < 9; i++) await host._aiTranslate('Satz ' + i + '.');
    const msgs = seen[8].body.messages;
    assert.equal(msgs.length, 1 + 6 * 2 + 1);   // system + 6 pairs + current
    assert.equal(msgs[1].content, 'Satz 2.');   // oldest surviving pair is #2 (0 and 1 rolled off)
  } finally { server.close(); }
});

test('unconfigured AI endpoint rejects with a clear error', async () => {
  const host = makeHost({ provider: 'ai', aiBaseUrl: '', aiApiKey: '', aiModel: '' });
  await assert.rejects(() => host._aiTranslate('Hallo.'), /not configured/);
});

test('transcribe without an STT endpoint reports the settings path, not a crash', async () => {
  const host = makeHost({ provider: 'ai', aiBaseUrl: 'http://x', aiApiKey: 'k', aiModel: 'm' }, {});
  const r = await host.handlers.transcribe(Buffer.alloc(320));
  assert.equal(r.ok, false);
  assert.match(r.error, /TTS\/STT/);
});

test('aiReady reports each blocking problem as a human sentence', async () => {
  // Not the AI provider -> always ready (soniox handles its own errors).
  assert.deepEqual(await makeHost({}).handlers.aiReady(), { ok: true });
  // AI provider, endpoint unconfigured.
  const r1 = await makeHost({ provider: 'ai' }).handlers.aiReady();
  assert.equal(r1.ok, false); assert.match(r1.error, /AI endpoint not configured/);
  // Configured but no STT endpoint set.
  const r2 = await makeHost({ provider: 'ai', aiBaseUrl: 'http://x', aiApiKey: 'k', aiModel: 'm' }, {}).handlers.aiReady();
  assert.equal(r2.ok, false); assert.match(r2.error, /STT not configured/);
  // STT set but nothing listening on the port -> the "start tts-sst" message.
  const dead = await makeHost({ provider: 'ai', aiBaseUrl: 'http://x', aiApiKey: 'k', aiModel: 'm' },
    { sttHost: '127.0.0.1', sttPort: '1' }).handlers.aiReady();
  assert.equal(dead.ok, false); assert.match(dead.error, /not reachable at 127\.0\.0\.1:1/);
  // Something actually listening -> ready.
  const srv = http.createServer(() => {});
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  try {
    const live = await makeHost({ provider: 'ai', aiBaseUrl: 'http://x', aiApiKey: 'k', aiModel: 'm' },
      { sttHost: '127.0.0.1', sttPort: String(srv.address().port) }).handlers.aiReady();
    assert.deepEqual(live, { ok: true });
  } finally { srv.close(); }
});

test('getState reports provider + aiConfigured + sttConfigured', () => {
  const host = makeHost(
    { provider: 'ai', aiBaseUrl: 'https://api.deepseek.com', aiApiKey: 'k', aiModel: 'deepseek-v4-flash', targetLanguage: 'de' },
    { sttHost: '127.0.0.1', sttPort: '10300' });
  const s = host.handlers.getState();
  assert.equal(s.provider, 'ai');
  assert.equal(s.aiConfigured, true);
  assert.equal(s.sttConfigured, true);
  assert.equal(s.targetLanguage, 'de');
  const s2 = makeHost({ provider: 'ai', aiBaseUrl: '', aiApiKey: '', aiModel: '' }).handlers.getState();
  assert.equal(s2.aiConfigured, false);
  const s3 = makeHost({}).handlers.getState();
  assert.equal(s3.provider, 'soniox');
});
