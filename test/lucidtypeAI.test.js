'use strict';

// lucidtypeAI: cleanup/rewrite text transform routing. Tests the endpoint + OWUI HTTP paths (mock
// owuiClient) and the rewrite-preset selection. CLI-agent paths use spawn and are covered manually.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLucidAI, REWRITE_PRESETS, rewritePromptFor, DEFAULT_CLEANUP_PROMPT } = require('../app/lucidtypeAI');

function mockOwui(captured, reply) {
  return {
    normalizeOwuiUrl: url => (url ? { chatUrl: String(url).replace(/\/+$/, '') + '/chat/completions' } : null),
    postJson: async (url, body, key, timeout) => { captured.push({ url, body, key, timeout }); return reply; },
  };
}
const okReply = { status: 200, text: JSON.stringify({ choices: [{ message: { content: '  Cleaned up text.  ' } }] }) };

test('rewritePromptFor returns presets, and custom falls back to professional when blank', () => {
  assert.equal(rewritePromptFor('concise'), REWRITE_PRESETS.concise);
  assert.equal(rewritePromptFor('confident'), REWRITE_PRESETS.confident);
  assert.equal(rewritePromptFor('custom', '  '), REWRITE_PRESETS.professional);
  assert.equal(rewritePromptFor('custom', 'Make it sound like a pirate.'), 'Make it sound like a pirate.');
  assert.ok(DEFAULT_CLEANUP_PROMPT.includes('Output only the corrected text'));
});

test('Use Endpoint POSTs to <base>/chat/completions with the model + messages and trims the reply', async () => {
  const captured = [];
  const ai = createLucidAI({ owuiClient: mockOwui(captured, okReply) });
  const out = await ai.transform('SYS PROMPT', 'raw text', { useEndpoint: true, endpoint: 'https://lite.example.com/v1/', endpointKey: 'k', model: 'glm-4', timeoutMs: 5000 });
  assert.equal(out, 'Cleaned up text.');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://lite.example.com/v1/chat/completions');
  assert.equal(captured[0].key, 'k');
  assert.equal(captured[0].body.model, 'glm-4');
  assert.deepEqual(captured[0].body.messages, [{ role: 'system', content: 'SYS PROMPT' }, { role: 'user', content: 'raw text' }]);
});

test('Use Endpoint requires a URL and a model', async () => {
  const ai = createLucidAI({ owuiClient: mockOwui([], okReply) });
  await assert.rejects(ai.transform('s', 'x', { useEndpoint: true, endpoint: '', model: 'm' }), /endpoint URL/);
  await assert.rejects(ai.transform('s', 'x', { useEndpoint: true, endpoint: 'https://e', model: '' }), /model/);
});

test('OWUI backend uses the Auth-tab connection + override model over the chat URL', async () => {
  const captured = [];
  const ai = createLucidAI({ owuiClient: mockOwui(captured, okReply) });
  const out = await ai.transform('S', 'txt', { backend: 'owui', model: 'override-model', owui: { url: 'http://owui.lan', apiKey: 'ok', model: 'default-model' } });
  assert.equal(out, 'Cleaned up text.');
  assert.equal(captured[0].url, 'http://owui.lan/chat/completions');
  assert.equal(captured[0].body.model, 'override-model');   // override wins over owui default
});

test('empty text is rejected before any backend call', async () => {
  const captured = [];
  const ai = createLucidAI({ owuiClient: mockOwui(captured, okReply) });
  await assert.rejects(ai.transform('s', '   ', { useEndpoint: true, endpoint: 'https://e', model: 'm' }), /nothing to transform/);
  assert.equal(captured.length, 0);
});
