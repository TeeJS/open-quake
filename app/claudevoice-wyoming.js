'use strict';
// Hand-rolled Wyoming protocol client (STT via wyoming-faster-whisper, TTS via wyoming-piper). No
// maintained JS/npm client exists for this protocol -- but this codebase already has a working
// reference: lucidtype/transcriber.go (a separate project of the user's), whose readEvent() this
// mirrors exactly. Wire format per event, confirmed against both that Go client and the reference
// Python `wyoming` package's event.py:
//
//   <header-json>\n
//   <data-json bytes>      (only if header.data_length > 0 -- a SEPARATE block, not inline)
//   <binary payload bytes> (only if header.payload_length > 0, immediately after the data block)
//
// The header's own "data" field is only ever inline when WE write it (outbound requests -- Wyoming's
// reader accepts either form). Every reply FROM a real Wyoming server externalizes its data into the
// data_length block instead -- audio-start's {rate,width,channels}, transcript's {text}, all of it.
// An earlier version of this reader only understood inline header.data and payload_length, silently
// dropping every data_length block. That desyncs the stream on the very first reply that carries one
// (audio-start), corrupting everything after it -- which is exactly the "one audio-chunk arrives,
// then nothing, timeout" symptom this was debugged from against the user's real wyoming-piper.
//
// STT sample rate/width/channels (16000Hz, 16-bit, mono): the standard Whisper/Wyoming convention.
// TTS format is NOT assumed the same way -- Piper voices differ in sample rate, so synthesize() reads
// the real {rate, width, channels} back from audio-start rather than guessing.

const net = require('net');

function writeMessage(socket, type, data, payload) {
  const header = { type };
  if (data !== undefined) header.data = data;
  if (payload) header.payload_length = payload.length;
  socket.write(JSON.stringify(header) + '\n');
  if (payload) socket.write(payload);
}

// Feeds `socket`'s data events through the header/data-block/payload-block framing, calling
// onMessage({type, data, payload}) once per complete message. `data` is the merged result of the
// data_length block (if any) falling back to inline header.data (if any) -- see file header comment.
function createReader(socket, onMessage, log) {
  const say = log || (() => {});
  let buf = Buffer.alloc(0);
  let totalBytes = 0;
  let pending = null;   // { header, dataBlock } while assembling one event across multiple 'data' events
  function pump() {
    for (;;) {
      if (!pending) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) { if (buf.length) say('waiting for header newline: have ' + buf.length + ' bytes buffered, no \\n yet'); return; }
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        if (!line.trim()) continue;
        let header;
        try { header = JSON.parse(line); } catch (e) { say('header JSON parse failed on: ' + JSON.stringify(line.slice(0, 200))); continue; }
        pending = { header, dataBlock: null };
        continue;
      }
      if (pending.header.data_length && pending.dataBlock === null) {
        const need = pending.header.data_length;
        if (buf.length < need) { say('waiting for data block: have ' + buf.length + '/' + need + ' bytes'); return; }
        const raw = buf.subarray(0, need); buf = buf.subarray(need);
        try { pending.dataBlock = JSON.parse(raw.toString('utf8')); } catch (e) { say('data block JSON parse failed'); pending.dataBlock = {}; }
        continue;
      }
      const need = pending.header.payload_length || 0;
      if (buf.length < need) { say('waiting for payload: have ' + buf.length + '/' + need + ' bytes'); return; }
      const payload = need ? buf.subarray(0, need) : null;
      buf = buf.subarray(need);
      const header = pending.header;
      const data = pending.dataBlock !== null ? pending.dataBlock : header.data;
      pending = null;
      onMessage({ type: header.type, data, payload });
    }
  }
  socket.on('data', chunk => { totalBytes += chunk.length; say('raw data: +' + chunk.length + ' bytes (total ' + totalBytes + ')'); buf = Buffer.concat([buf, chunk]); pump(); });
}

// One-shot STT: transcribe/audio-start/audio-chunk(+PCM)/audio-stop -> resolves with the transcript
// text. `audio` is a single Buffer of the whole (VAD-trimmed) utterance -- fine to send as one chunk
// for utterance-length clips (a few seconds); no need to sub-chunk for something this short. The
// leading `transcribe` event (declaring the language) matches lucidtype/transcriber.go's sequence --
// wyoming-faster-whisper uses it to configure the session before audio arrives.
function transcribe({ host, port, audio, rate, width, channels, language, timeoutMs, log }) {
  const say = log || (() => {});
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    const finish = (err, text) => {
      if (settled) return; settled = true;
      try { socket.destroy(); } catch (e) {}
      err ? reject(err) : resolve(text);
    };
    socket.on('error', e => { say('STT socket error: ' + e.message); finish(e); });
    socket.on('close', () => finish(new Error('Wyoming STT: connection closed before a transcript arrived')));
    socket.setTimeout(timeoutMs || 20000, () => finish(new Error('Wyoming STT request timed out')));
    createReader(socket, msg => {
      say('STT <- ' + msg.type + (msg.payload ? ' (' + msg.payload.length + ' bytes)' : ''));
      if (msg.type === 'transcript') finish(null, (msg.data && msg.data.text) || '');
    }, say);
    socket.on('connect', () => {
      say('STT connected to ' + host + ':' + port + ', sending ' + audio.length + ' bytes');
      const fmt = { rate: rate || 16000, width: width || 2, channels: channels || 1 };
      writeMessage(socket, 'transcribe', { language: language || '' });
      writeMessage(socket, 'audio-start', fmt);
      writeMessage(socket, 'audio-chunk', fmt, audio);
      writeMessage(socket, 'audio-stop', {});
    });
  });
}

// One-shot TTS: synthesize -> audio-start (carries the real format)/audio-chunk(s)+PCM/audio-stop.
// `onFormat({rate,width,channels})` fires once, as soon as audio-start arrives, so a caller (the
// /claude-voice/tts-audio/:id route) can write a correctly-sized WAV header before any audio bytes
// exist yet. `onChunk(buffer)` fires per audio-chunk, for piping straight into an HTTP response.
// `registerCancel(fn)` hands the caller an abort function (kills the socket, rejects) -- the
// per-turn speech pipeline uses it to cut off a sentence mid-synthesis on barge-in.
function synthesize({ host, port, text, onFormat, onChunk, timeoutMs, log, registerCancel }) {
  const say = log || (() => {});
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    let format = null;
    const finish = (err) => {
      if (settled) return; settled = true;
      try { socket.destroy(); } catch (e) {}
      err ? reject(err) : resolve(format);
    };
    if (registerCancel) registerCancel(() => finish(new Error('cancelled')));
    socket.on('error', e => { say('TTS socket error: ' + e.message); finish(e); });
    socket.on('close', () => { if (!settled) finish(new Error('Wyoming TTS: connection closed before audio-stop')); });
    socket.setTimeout(timeoutMs || 30000, () => finish(new Error('Wyoming TTS request timed out')));
    createReader(socket, msg => {
      say('TTS <- ' + msg.type + (msg.payload ? ' (' + msg.payload.length + ' bytes)' : '') + (msg.data ? ' data=' + JSON.stringify(msg.data) : ''));
      if (msg.type === 'audio-start') { format = msg.data || {}; if (onFormat) onFormat(format); }
      else if (msg.type === 'audio-chunk' && msg.payload) { if (onChunk) onChunk(msg.payload); }
      else if (msg.type === 'audio-stop') finish(null);
    }, say);
    socket.on('connect', () => {
      say('TTS connected to ' + host + ':' + port + ', sending synthesize for ' + JSON.stringify(text.slice(0, 60)));
      writeMessage(socket, 'synthesize', { text });
    });
  });
}

// 44-byte canonical WAV/PCM header for streaming playback where the total length isn't known yet
// (we're piping audio-chunk payloads straight through as they arrive from Wyoming). The RIFF and
// data chunk sizes use the standard "streaming" sentinel (0xFFFFFFFF) -- browsers play a WAV with an
// oversized declared length just fine as long as the byte stream itself ends when the HTTP response
// does, which is exactly what happens here once Wyoming's audio-stop closes out the pipe.
function wavHeader({ rate, width, channels }) {
  const numChannels = channels || 1, bitsPerSample = (width || 2) * 8, sampleRate = rate || 22050;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0); buf.writeUInt32LE(0xFFFFFFFF, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(blockAlign, 32); buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36); buf.writeUInt32LE(0xFFFFFFFF, 40);
  return buf;
}

module.exports = { transcribe, synthesize, wavHeader };
