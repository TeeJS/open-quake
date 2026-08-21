'use strict';
// API-endpoint voice adapter (apivoice-session.js): the OpenAI-compatible bring-your-own-key
// backend of the AI Voice app. Mirrors owuivoiceSession.test.js — a fake client stands in for
// the HTTP layer so every path is deterministic.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiVoiceAdapter } = require('../app/apivoice-session');

function makeClient() {
  const calls = [];
  let active = null;
  return {
    calls,
    finishWith(fn) { fn(active); active = null; },
    listModels: async () => ['m-1', 'm-2'],
    streamChat(url, payload, key, timeout, cbs) {
      calls.push({ url, payload, key });
      active = cbs;
      return { destroy() { active = null; } };
    },
  };
}

function makeAdapter(cfg, client) {
  const events = [];
  const adapter = createApiVoiceAdapter({ resolveApi: () => cfg, log: () => {}, client });
  for (const t of ['assistant-start', 'assistant-delta', 'assistant-final', 'turn-complete', 'error', 'notice', 'model', 'models-changed']) {
    adapter.on(t, e => events.push([t, e]));
  }
  return { adapter, events };
}

const GOOD = { apiBaseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', apiModel: 'm-1' };

test('full host-called contract exists before start', () => {
  const { adapter } = makeAdapter(GOOD, makeClient());
  assert.equal(adapter.isRunning(), false);
  assert.equal(adapter.sessionId(), null);
  assert.equal(adapter.projectDir(), '');
  assert.deepEqual(adapter.listModes(), []);
  assert.equal(adapter.mode(), '');
  assert.equal(adapter.setMode('x'), false);
  assert.equal(adapter.decideApproval('r', 'allow'), false);
  assert.equal(adapter.validModel(''), true);
  assert.equal(adapter.currentModel(), 'm-1');
  adapter.cancelApprovals();   // must not throw
});

test('start refuses without a URL or key and emits a named error', () => {
  for (const cfg of [{}, { apiBaseUrl: 'https://x' }, { apiKey: 'k' }]) {
    const { adapter, events } = makeAdapter(cfg, makeClient());
    assert.equal(adapter.start({}), false);
    assert.equal(events.length, 1);
    assert.equal(events[0][0], 'error');
    assert.match(events[0][1].message, /API endpoint not configured/);
  }
});

test('turn streams deltas and completes with the accumulated text', () => {
  const client = makeClient();
  const { adapter, events } = makeAdapter(GOOD, client);
  assert.equal(adapter.start({}), true);
  assert.equal(adapter.sendTurn('hello'), true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(client.calls[0].key, 'sk-test');
  assert.deepEqual(client.calls[0].payload.messages, [{ role: 'user', content: 'hello' }]);
  client.finishWith(cbs => { cbs.onDelta('Hi '); cbs.onDelta('there.'); cbs.onDone({ finishReason: 'stop' }); });
  const types = events.map(e => e[0]);
  assert.deepEqual(types, ['assistant-start', 'assistant-delta', 'assistant-delta', 'assistant-final', 'turn-complete']);
  assert.deepEqual(events[events.length - 1][1], { text: 'Hi there.', error: null });
  // Next turn carries the history.
  assert.equal(adapter.sendTurn('again'), true);
  assert.deepEqual(client.calls[1].payload.messages, [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi there.' }, { role: 'user', content: 'again' },
  ]);
});

test('history is capped at 40 messages', () => {
  const client = makeClient();
  const { adapter } = makeAdapter(GOOD, client);
  adapter.start({});
  for (let i = 0; i < 30; i++) {
    adapter.sendTurn('turn ' + i);
    client.finishWith(cbs => { cbs.onDelta('r' + i); cbs.onDone({ finishReason: 'stop' }); });
  }
  adapter.sendTurn('last');
  const msgs = client.calls[client.calls.length - 1].payload.messages;
  assert.ok(msgs.length <= 40, 'got ' + msgs.length);
  assert.equal(msgs[msgs.length - 1].content, 'last');
});

test('401 maps to a key-focused message and the failed user message is dropped', () => {
  const client = makeClient();
  const { adapter, events } = makeAdapter(GOOD, client);
  adapter.start({});
  adapter.sendTurn('hello');
  client.finishWith(cbs => { const e = new Error('unauthorized'); e.statusCode = 401; cbs.onError(e); });
  const done = events.find(e => e[0] === 'turn-complete');
  assert.match(done[1].error, /rejected the key/);
  // Retry doesn't double the user message in context.
  adapter.sendTurn('hello');
  assert.deepEqual(client.calls[1].payload.messages, [{ role: 'user', content: 'hello' }]);
});

test('missing model fails the turn with guidance instead of refusing it', () => {
  const client = makeClient();
  const { adapter, events } = makeAdapter({ apiBaseUrl: 'https://x/v1', apiKey: 'k', apiModel: '' }, client);
  adapter.start({});
  assert.equal(adapter.sendTurn('hi'), true);   // accepted (host queues on it), then failed async
  return new Promise(resolve => setImmediate(() => {
    const done = events.find(e => e[0] === 'turn-complete');
    assert.match(done[1].error, /no model set/);
    assert.equal(client.calls.length, 0);
    resolve();
  }));
});

test('interrupt settles the turn with the partial text', () => {
  const client = makeClient();
  const { adapter, events } = makeAdapter(GOOD, client);
  adapter.start({});
  adapter.sendTurn('hello');
  client.finishWith(cbs => cbs.onDelta('par'));
  assert.equal(adapter.interrupt(), true);
  const done = events.find(e => e[0] === 'turn-complete');
  assert.deepEqual(done[1], { text: 'par', error: null });
});

test('stop clears the session', () => {
  const { adapter } = makeAdapter(GOOD, makeClient());
  adapter.start({});
  assert.equal(adapter.isRunning(), true);
  adapter.stop();
  assert.equal(adapter.isRunning(), false);
  assert.equal(adapter.sessionId(), null);
  assert.equal(adapter.sendTurn('x'), false);
});

test('AI profile rides as a system message; switching applies to the next request', () => {
  const client = makeClient();
  const { adapter } = makeAdapter(GOOD, client);
  adapter.start({ profilePrompt: 'You are a translator.' });
  adapter.sendTurn('Hallo');
  assert.deepEqual(client.calls[0].payload.messages[0], { role: 'system', content: 'You are a translator.' });
  assert.deepEqual(client.calls[0].payload.messages[1], { role: 'user', content: 'Hallo' });
  client.finishWith(cbs => { cbs.onDelta('Hello'); cbs.onDone({ finishReason: 'stop' }); });
  // Live switch: next request carries the NEW instruction, still exactly one system message.
  adapter.setProfilePrompt('You are a poet.');
  adapter.sendTurn('again');
  const msgs = client.calls[1].payload.messages;
  assert.deepEqual(msgs[0], { role: 'system', content: 'You are a poet.' });
  assert.equal(msgs.filter(m => m.role === 'system').length, 1);
  // Clearing it removes the system message entirely.
  adapter.setProfilePrompt('');
  client.finishWith(cbs => cbs.onDone({ finishReason: 'stop' }));
  adapter.sendTurn('third');
  assert.equal(client.calls[2].payload.messages.some(m => m.role === 'system'), false);
});

test('the profile system message survives the history cap', () => {
  const client = makeClient();
  const { adapter } = makeAdapter(GOOD, client);
  adapter.start({ profilePrompt: 'Stay terse.' });
  for (let i = 0; i < 30; i++) {
    adapter.sendTurn('turn ' + i);
    client.finishWith(cbs => { cbs.onDelta('r' + i); cbs.onDone({ finishReason: 'stop' }); });
  }
  adapter.sendTurn('last');
  const msgs = client.calls[client.calls.length - 1].payload.messages;
  assert.deepEqual(msgs[0], { role: 'system', content: 'Stay terse.' });   // never evicted
  assert.ok(msgs.length <= 41, 'got ' + msgs.length);                      // 40 history + 1 system
});

test('deepseek models get thinking disabled; others send no thinking field', () => {
  const client = makeClient();
  const { adapter } = makeAdapter({ apiBaseUrl: 'https://x/v1', apiKey: 'k', apiModel: 'deepseek-v4-flash' }, client);
  adapter.start({});
  adapter.sendTurn('hallo');
  assert.deepEqual(client.calls[0].payload.thinking, { type: 'disabled' });
  client.finishWith(cbs => cbs.onDone({ finishReason: 'stop' }));
  const client2 = makeClient();
  const { adapter: a2 } = makeAdapter(GOOD, client2);
  a2.start({});
  a2.sendTurn('hi');
  assert.equal('thinking' in client2.calls[0].payload, false);
});
