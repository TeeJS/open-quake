'use strict';
// Soniox real-time speech-translation VALIDATION HARNESS.
// Streams a 16 kHz mono 16-bit WAV to Soniox's real-time WebSocket API with one-way translation,
// paced in ~100 ms chunks so latency reflects live mic use, and prints the live translated captions
// plus latency numbers. Proves quality + latency before any OQ integration.
//
// Run (needs only your Soniox API key + a 16 kHz mono WAV):
//   SONIOX_API_KEY=xxxxx node soniox-test.js german.wav en de
//   arg1 = WAV path (default german.wav)   arg2 = target lang (default en)   arg3 = source hint (optional)
const fs = require('fs');
const WebSocket = require('ws');

const API_KEY = process.env.SONIOX_API_KEY;
if (!API_KEY) { console.error('Set SONIOX_API_KEY=<your key>'); process.exit(1); }
const wavPath = process.argv[2] || 'german.wav';
const target = process.argv[3] || 'en';
const sourceHint = process.argv[4] || null;

// Minimal WAV reader — expects PCM 16-bit. Returns { sampleRate, channels, bits, pcm }.
function readWav(p) {
  const b = fs.readFileSync(p);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    else if (id === 'data') { dataOff = off + 8; dataLen = sz; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt/data chunk');
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, pcm: b.subarray(dataOff, dataOff + dataLen) };
}

let wav;
try { wav = readWav(wavPath); } catch (e) { console.error('WAV error:', e.message); process.exit(1); }
if (wav.bits !== 16 || wav.channels !== 1) {
  console.error(`Expected 16-bit mono WAV; got ${wav.bits}-bit ${wav.channels}ch.`);
  console.error('Convert with:  ffmpeg -i input.mp3 -ar 16000 -ac 1 german.wav');
  process.exit(1);
}
console.log(`WAV: ${wav.sampleRate} Hz mono, ${(wav.pcm.length / 2 / wav.sampleRate).toFixed(1)}s  →  translating to "${target}"${sourceHint ? ` (source hint: ${sourceHint})` : ''}\n`);

const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
let startMs = 0, firstTokenMs = 0, firstTransMs = 0;
let finalOriginal = '', finalTranslation = '';
let doneCalled = false;

ws.on('open', () => {
  const cfg = {
    api_key: API_KEY,
    model: 'stt-rt-v5',
    audio_format: 's16le',
    sample_rate: wav.sampleRate,
    num_channels: 1,
    translation: { type: 'one_way', target_language: target },
  };
  if (sourceHint) cfg.language_hints = [sourceHint];
  ws.send(JSON.stringify(cfg));
  startMs = Date.now();

  // Pace the PCM at real-time (100 ms of audio every 100 ms) so latency is representative of a live mic.
  const bytesPer100ms = Math.floor(wav.sampleRate * 2 * 0.1);   // 16-bit mono
  let pos = 0;
  const timer = setInterval(() => {
    if (pos >= wav.pcm.length) {
      clearInterval(timer);
      try { ws.send(Buffer.alloc(0)); } catch (e) {}   // empty frame signals end-of-audio
      return;
    }
    ws.send(wav.pcm.subarray(pos, Math.min(pos + bytesPer100ms, wav.pcm.length)));
    pos += bytesPer100ms;
  }, 100);
});

ws.on('message', (data) => {
  let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
  if (msg.error_code || msg.error_message) { console.error('\nSoniox error:', msg.error_code, msg.error_message); process.exit(1); }
  let provisional = '';
  for (const t of (msg.tokens || [])) {
    if (!t.text) continue;
    if (!firstTokenMs) firstTokenMs = Date.now();
    if (t.translation_status === 'translation') {
      if (!firstTransMs) firstTransMs = Date.now();
      if (t.is_final) finalTranslation += t.text; else provisional += t.text;
    } else if (t.is_final) {
      finalOriginal += t.text;
    }
  }
  const live = (finalTranslation + provisional).replace(/\s+/g, ' ').trim();
  process.stdout.write('\r\x1b[2K' + target.toUpperCase() + '> ' + live.slice(-170));
  if (msg.finished) done();
});
ws.on('close', () => done());
ws.on('error', (e) => { console.error('\nWS error:', e.message); process.exit(1); });

function done() {
  if (doneCalled) return; doneCalled = true;
  console.log('\n\n=== RESULT ===');
  console.log('Original     :', finalOriginal.replace(/\s+/g, ' ').trim());
  console.log('Translation  :', finalTranslation.replace(/\s+/g, ' ').trim());
  console.log('First word   :', firstTokenMs ? (firstTokenMs - startMs) + ' ms after start' : 'n/a');
  console.log('First translated word:', firstTransMs ? (firstTransMs - startMs) + ' ms after start' : 'n/a');
  console.log('\nJudge: is the translation correct on common words, and did captions appear within ~1–2 s?');
  process.exit(0);
}
