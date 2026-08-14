'use strict';
// Speech pipeline: a dead TTS service (every synthesis fails) must surface ONE error per turn and
// still end the stream cleanly -- silent-empty-stream was indistinguishable from "nothing to say".
const test = require('node:test');
const assert = require('node:assert');
const { createSpeechPipeline } = require('../app/claudevoice-speech');
const { wavHeader } = require('../app/claudevoice-wyoming');

function fakeRes() {
  const r = { status: null, chunks: [], ended: false };
  r.writeHead = s => { r.status = s; };
  r.write = b => r.chunks.push(b);
  r.end = () => { r.ended = true; };
  return r;
}
function fakeReq() { return { on() {} }; }
const tick = () => new Promise(r => setTimeout(r, 20));

test('all sentences failing -> one speech error + 204 stream end', async () => {
  const errors = [];
  const p = createSpeechPipeline({
    synthesize: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:10200')),
    wavHeader,
    getTts: () => ({ host: 'x', port: 1 }),
    log: () => {},
    onSpeechError: m => errors.push(m),
  });
  const id = p.beginTurn();
  const res = fakeRes();
  p.attach(id, fakeReq(), res);
  p.feed('First sentence. Second sentence. Third sentence. ');
  await tick();
  p.finish('');
  await tick();
  assert.equal(errors.length, 1, 'exactly one error per turn, not one per sentence');
  assert.match(errors[0], /ECONNREFUSED/);
  assert.equal(res.status, 204);   // nothing was spoken; the stream still closes properly
  assert.equal(res.ended, true);
});

test('working synthesis -> no speech error', async () => {
  const errors = [];
  const p = createSpeechPipeline({
    synthesize: ({ onFormat, onChunk }) => {
      onFormat({ rate: 22050, width: 2, channels: 1 });
      onChunk(Buffer.from('pcm'));
      return Promise.resolve();
    },
    wavHeader,
    getTts: () => ({ host: 'x', port: 1 }),
    log: () => {},
    onSpeechError: m => errors.push(m),
  });
  const id = p.beginTurn();
  const res = fakeRes();
  p.attach(id, fakeReq(), res);
  p.feed('Hello there. ');
  await tick();
  p.finish('');
  await tick();
  assert.equal(errors.length, 0);
  assert.equal(res.status, 200);
  assert.equal(res.ended, true);
});
