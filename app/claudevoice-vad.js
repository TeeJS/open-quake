'use strict';
// Voice-activity detection for the tap-to-toggle conversation. Deliberate implementation choice
// (documented per the plan's "spike @ricky0123/vad-web, energy-threshold as fallback" item): this
// ships the zero-dependency RMS-energy-with-hangover approach as the actual v1, not the Silero/WASM
// library. Reasoning: a WASM+AudioWorklet library's compatibility inside an Electron <webview> guest
// specifically (not a normal top-level tab, which is what it's usually deployed in) is a real
// unknown that can only be fully verified with a human mic present anyway -- same as this approach.
// Given that, the dependency-free path is the one that's actually finishable and testable without
// the user here, and it can be swapped later without touching any other file (this module's public
// shape -- start(onSpeechStart, onSpeechEnd) / stop() -- is exactly what a Silero-based
// implementation would also expose).
//
// Output format: 16-bit PCM, mono, 16kHz -- matches Wyoming STT's native rate (see
// claudevoice-wyoming.js's header comment), so the server never has to resample.

function createVAD(opts) {
  opts = opts || {};
  const SAMPLE_RATE = 16000;
  const threshold = opts.threshold || 0.02;        // RMS amplitude above which audio counts as speech
  let hangoverMs = opts.hangoverMs || 800;          // sustained silence before an utterance is considered over (user-tunable)
  const minSpeechMs = opts.minSpeechMs || 250;      // ignore blips shorter than this (taps, clicks, breath)
  const bufferSize = 4096;

  let stream = null, audioCtx = null, source = null, processor = null, silentGain = null;
  let speaking = false, speechStartedAt = 0, hangoverTimer = null;
  let chunks = [];   // Float32Array pieces captured since the current utterance began
  let inputDeviceId = '';   // '' = system default; set via setInputDevice() before start()

  function rms(float32) {
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    return Math.sqrt(sum / float32.length);
  }
  function toPCM16(float32Chunks) {
    let total = 0; for (const c of float32Chunks) total += c.length;
    const out = new Int16Array(total);
    let o = 0;
    for (const c of float32Chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]));
        out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    return out;
  }

  // onLevel(rms) fires on every audio buffer (~4 times/second) regardless of speech state -- it
  // drives the mic visualizer's ripples, which should react to ANY sound the mic hears, not just
  // audio that crosses the utterance threshold.
  async function start(onSpeechStart, onSpeechEnd, onLevel) {
    // deviceId as `ideal`, never `exact`: if the picked mic was unplugged, fall back to the system
    // default rather than failing the whole conversation toggle.
    const audio = { channelCount: 1, sampleRate: SAMPLE_RATE };
    if (inputDeviceId) audio.deviceId = { ideal: inputDeviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    // ScriptProcessorNode needs a path to the destination to fire reliably in some engines; route
    // through a silent (gain=0) node so the raw mic is never actually audible (no feedback/echo).
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    processor.onaudioprocess = e => {
      const data = e.inputBuffer.getChannelData(0);
      const level = rms(data);
      if (onLevel) { try { onLevel(level); } catch (err) {} }
      if (level >= threshold) {
        if (!speaking) {
          speaking = true;
          speechStartedAt = Date.now();
          chunks = [];
          if (onSpeechStart) onSpeechStart();
        }
        clearTimeout(hangoverTimer);
        hangoverTimer = null;
        chunks.push(new Float32Array(data));   // copy -- `data` is a reused buffer, would be clobbered next callback
      } else if (speaking && !hangoverTimer) {
        chunks.push(new Float32Array(data));   // keep a little trailing silence too, cheap and harmless
        hangoverTimer = setTimeout(() => {
          hangoverTimer = null;
          speaking = false;
          const durationMs = Date.now() - speechStartedAt;
          const captured = chunks; chunks = [];
          if (durationMs >= minSpeechMs && onSpeechEnd) onSpeechEnd(toPCM16(captured));
        }, hangoverMs);
      } else if (speaking) {
        chunks.push(new Float32Array(data));
      }
    };
  }

  function stop() {
    clearTimeout(hangoverTimer); hangoverTimer = null;
    speaking = false; chunks = [];
    try { if (processor) processor.disconnect(); } catch (e) {}
    try { if (silentGain) silentGain.disconnect(); } catch (e) {}
    try { if (source) source.disconnect(); } catch (e) {}
    try { if (audioCtx) audioCtx.close(); } catch (e) {}
    try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    stream = audioCtx = source = processor = silentGain = null;
  }

  // Live-tunable pause tolerance (the settings overlay's "Voice pause tolerance" stepper): the
  // hangover closure reads the current value on every silence check, so this applies immediately.
  function setHangoverMs(ms) { ms = parseInt(ms, 10); if (ms > 0) hangoverMs = ms; }
  // Mic pick from the settings overlay; takes effect on the next start() (the caller restarts a
  // live conversation itself so the change applies immediately).
  function setInputDevice(id) { inputDeviceId = id || ''; }

  return { start, stop, setHangoverMs, setInputDevice };
}

window.createClaudeVoiceVAD = createVAD;
