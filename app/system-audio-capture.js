'use strict';
// system-audio-capture.js
//
// RENDERER. Framework-agnostic capture of local mic + system (speaker) audio,
// merged into a single 2-channel stream and delivered as interleaved int16 PCM.
// Requires the main process to have registered the loopback display-media
// handler for this window's session — see loopback-audio.js.
//
//   Channel 0 = microphone   ("you")
//   Channel 1 = system audio (everyone else / whatever the speakers play)
//
// Plain-JS port of the handoff system-audio-capture.ts (types stripped). Exposed
// as window.SystemAudioCapture. Default output rate 16000 (STT-friendly); the
// meeting recorder runs at 16000 for a 16 kHz stereo WAV (mic=L, system=R).
//
// options:
//   sampleRate            output rate of the merged PCM. Default 16000.
//   bufferSize            ScriptProcessor block size (frames). Default 4096.
//   echoGate              mute mic while speakers are loud AND on speakers
//                         (not headphones). Default true. The recorder sets
//                         this false for faithful capture.
//   systemGateThreshold   RMS above which system audio counts as "playing".
//   micConstraints        getUserMedia audio constraints for the mic.
//   onPcm(pcm, meta)      REQUIRED. Interleaved stereo int16 [mic0,sys0,...].
//                         Buffer is reused — copy it if retained past the call.
//   onSourceEnded()       fired once if the shared source ends (Stop sharing).
//   onError(err)          non-fatal error reporting.
// meta = { micRms, systemRms, micGated }.

const HEADPHONE_PATTERNS = [
  'headphone', 'airpod', 'earpod', 'earphone', 'earbud',
  'bluetooth', 'bt_', 'jabra', 'bose', 'sony wh', 'sony wf',
];

// Best-effort: is the default audio output a headset (so echo bleed is a
// non-issue and the mic never needs gating)? Label-based heuristic.
async function usingHeadphones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const def = devices.find(d => d.kind === 'audiooutput' && d.deviceId === 'default');
    const label = (def && def.label ? def.label : '').toLowerCase();
    return HEADPHONE_PATTERNS.some(p => label.includes(p));
  } catch (e) {
    return false;
  }
}

// Reused zero-buffer for gated frames; grown to match the processor's block size
// on first gate. Module-scoped so we don't allocate a fresh array per frame.
let SILENT_FRAME = new Float32Array(0);

class SystemAudioCapture {
  constructor(options) {
    this.state = 'idle';
    this.gen = 0;              // bumped by stop(); lets an in-flight start() detect it was cancelled
    this.micStream = null;
    this.systemStream = null;
    this.audioCtx = null;
    this.processor = null;
    this.endedHandler = null;
    this.opts = {
      sampleRate: options.sampleRate != null ? options.sampleRate : 16000,
      bufferSize: options.bufferSize != null ? options.bufferSize : 4096,
      echoGate: options.echoGate != null ? options.echoGate : true,
      systemGateThreshold: options.systemGateThreshold != null ? options.systemGateThreshold : 0.005,
      onPcm: options.onPcm,
      micConstraints: options.micConstraints,
      onSourceEnded: options.onSourceEnded,
      onError: options.onError,
    };
  }

  isRunning() {
    return this.state === 'running';
  }

  // Acquire both streams, wire up the merge graph, and begin emitting PCM.
  // Resolves once capture is live. Throws if mic or system audio is denied —
  // any partially-acquired resource is cleaned up before throwing.
  async start() {
    if (this.state !== 'idle') return;
    this.state = 'starting';
    const gen = ++this.gen;

    const results = await Promise.allSettled([
      usingHeadphones(),
      navigator.mediaDevices.getUserMedia({
        audio: this.opts.micConstraints || {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
      (async () => {
        // Ask for video too (Electron requires it), then discard it — we only
        // want the loopback audio track the main-process handler attaches.
        const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach(t => t.stop());
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach(t => t.stop());
          throw new Error('getDisplayMedia returned no audio track — is the loopback handler registered on this session?');
        }
        return stream;
      })(),
    ]);
    const headphoneRes = results[0];
    const micRes = results[1];
    const systemRes = results[2];

    if (micRes.status === 'rejected' || systemRes.status === 'rejected') {
      // Roll back whatever succeeded so we never leak a live mic/loopback.
      if (micRes.status === 'fulfilled') micRes.value.getTracks().forEach(t => t.stop());
      if (systemRes.status === 'fulfilled') systemRes.value.getTracks().forEach(t => t.stop());
      this.state = 'idle';
      throw micRes.status === 'rejected' ? micRes.reason : systemRes.reason;
    }

    // stop() may have run while the mic/loopback grants were still in flight. It found every
    // field below still null and tore down nothing, so without this check the capture would go
    // live AFTER being stopped — unreferenced, unstoppable, and streaming PCM into whatever
    // recording starts next. Release the streams and stay idle instead.
    if (gen !== this.gen) {
      micRes.value.getTracks().forEach(t => t.stop());
      systemRes.value.getTracks().forEach(t => t.stop());
      this.state = 'idle';
      return;
    }

    const headphones = headphoneRes.status === 'fulfilled' ? headphoneRes.value : false;
    this.micStream = micRes.value;
    this.systemStream = systemRes.value;

    // Auto-stop when the shared source goes away. On Windows/Linux the track
    // fires "ended"; our own stop() calls track.stop() which does NOT fire
    // "ended", so this won't double-trigger on a manual stop.
    const sysTrack = this.systemStream.getAudioTracks()[0];
    this.endedHandler = () => { if (this.opts.onSourceEnded) this.opts.onSourceEnded(); };
    sysTrack.addEventListener('ended', this.endedHandler);

    // --- merge graph: mic -> ch0, system -> ch1, interleave to int16 ---
    const audioCtx = new AudioContext({ sampleRate: this.opts.sampleRate });
    this.audioCtx = audioCtx;

    const micSource = audioCtx.createMediaStreamSource(this.micStream);
    const systemSource = audioCtx.createMediaStreamSource(this.systemStream);
    const merger = audioCtx.createChannelMerger(2);
    micSource.connect(merger, 0, 0);
    systemSource.connect(merger, 0, 1);

    // ScriptProcessorNode is deprecated but universally supported and has zero
    // bundling ceremony (an AudioWorklet needs a separately-loaded module URL).
    const processor = audioCtx.createScriptProcessor(this.opts.bufferSize, 2, 2);
    this.processor = processor;

    const echoGate = this.opts.echoGate;
    const systemGateThreshold = this.opts.systemGateThreshold;
    const onPcm = this.opts.onPcm;
    const self = this;

    processor.onaudioprocess = (e) => {
      const micRaw = e.inputBuffer.getChannelData(0);
      const sysRaw = e.inputBuffer.getChannelData(1);

      // Per-channel RMS, computed once and reused.
      let micSum = 0;
      for (let i = 0; i < micRaw.length; i++) micSum += micRaw[i] * micRaw[i];
      const micRms = Math.sqrt(micSum / micRaw.length);
      let sysSum = 0;
      for (let i = 0; i < sysRaw.length; i++) sysSum += sysRaw[i] * sysRaw[i];
      const sysRms = Math.sqrt(sysSum / sysRaw.length);

      // Echo gate: mute mic while speakers are loud (unless on headphones).
      let micOut = micRaw;
      let micGated = false;
      if (echoGate && !headphones && sysRms > systemGateThreshold) {
        if (SILENT_FRAME.length !== micRaw.length) SILENT_FRAME = new Float32Array(micRaw.length);
        micOut = SILENT_FRAME;
        micGated = true;
      }

      // Interleave mic (ch0) + system (ch1) into stereo int16.
      const int16 = new Int16Array(micRaw.length * 2);
      for (let i = 0; i < micRaw.length; i++) {
        const s0 = Math.max(-1, Math.min(1, micOut[i]));
        const s1 = Math.max(-1, Math.min(1, sysRaw[i]));
        int16[i * 2] = s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff;
        int16[i * 2 + 1] = s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff;
      }

      try {
        onPcm(int16, { micRms: micRms, systemRms: sysRms, micGated: micGated });
      } catch (err) {
        if (self.opts.onError) self.opts.onError(err);
      }
    };

    merger.connect(processor);
    processor.connect(audioCtx.destination);

    this.state = 'running';
  }

  // Tear down all capture. Safe to call multiple times / from any state.
  stop() {
    this.gen++;                      // cancels a start() still awaiting its device grants
    if (this.state === 'idle') return;
    this.state = 'stopping';

    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.systemStream) {
      const t = this.systemStream.getAudioTracks()[0];
      if (t && this.endedHandler) t.removeEventListener('ended', this.endedHandler);
      this.systemStream.getTracks().forEach(tr => tr.stop());
      this.systemStream = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(tr => tr.stop());
      this.micStream = null;
    }
    this.endedHandler = null;
    this.state = 'idle';
  }
}

if (typeof window !== 'undefined') window.SystemAudioCapture = SystemAudioCapture;
