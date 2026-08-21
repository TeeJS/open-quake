'use strict';
// meetingRecorder.js  — MAIN PROCESS
//
// Owns meeting recording end to end: a hidden, main-owned BrowserWindow (the "recorder window")
// is the single audio-capture path for the whole app. This module manages that window's lifecycle,
// tells it when to start/stop capturing the selected mic + system loopback, receives the interleaved
// stereo int16 PCM it streams back, and writes it to a 16 kHz stereo WAV (mic = left, system = right).
//
// Why a dedicated hidden window: audio capture needs a renderer (Web Audio / getUserMedia /
// getDisplayMedia); the main process can't capture. The visible panel is one WebView that navigates
// between apps, so its meeting page unloads the moment you switch apps — useless for background
// recording. This window persists independently and records regardless of what the panel shows.
//
// Security: the recorder window runs on its OWN session partition (persist:recorder) with the
// loopback display-media handler registered ONLY there — never on the shared dashboards session that
// also loads third-party dashboards. deps.setupRecorderSession(session) lets main attach the trust
// (permission) + loopback handlers.

const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');

const SAMPLE_RATE = 16000;   // 16 kHz stereo WAV — matches SystemAudioCapture's output rate
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;  // int16
const SILENCE_RMS = 0.005;   // both channels below this counts as silence for auto-stop

// Two-digit zero pad for the YYYY-MM-DD-HH-MM-SS.wav filename (local time).
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function timestampName(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '-' +
    pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds()) + '.wav';
}

// 44-byte canonical PCM WAV header. Sizes are patched on stop() once the total is known.
function wavHeader(dataBytes) {
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const byteRate = SAMPLE_RATE * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);           // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);            // audio format 1 = PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);   // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/**
 * deps:
 *   recorderUrl()            -> served URL for the recorder page (e.g. http://127.0.0.1:PORT/recorder)
 *   preloadPath              -> absolute path to recorder-preload.js
 *   setupRecorderSession(s)  -> main attaches permission + loopback handlers to the recorder session
 *   resolveSettings()        -> { meetingFolder, micDevice, echoGate, silenceStopMin }
 *   defaultFolder()          -> fallback folder when meetingFolder is empty
 *   onState(state)           -> optional; called whenever recording state changes
 *   log(msg)                 -> optional logger
 */
function createMeetingRecorder(deps) {
  const log = deps.log || function () {};
  let win = null;
  let ready = false;
  let pendingStart = null;     // start request queued until the window reports ready

  // Recording state (also the shape getState() serializes for the panel poller).
  let recording = false;
  let startedAt = null;
  let filePath = null;
  let triggerApp = null;       // which allowlisted app auto-started this, or null for manual
  let micLabel = '';

  // WAV write state.
  let stream = null;
  let dataBytes = 0;
  let lastLoudAt = 0;
  let silenceStopMs = 0;       // 0 = disabled
  let captureSession = 0;      // incremented per recording; frames must carry the current id
  let warnedStaleSession = false;

  function recorderSession() {
    return session.fromPartition('persist:recorder');
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    const sess = recorderSession();
    try { if (deps.setupRecorderSession) deps.setupRecorderSession(sess); } catch (e) { log('recorder session setup error: ' + e.message); }
    win = new BrowserWindow({
      show: false,
      width: 320, height: 200,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,     // keep audio + timers alive while hidden
        preload: deps.preloadPath,
        session: sess,
      },
    });
    ready = false;
    win.on('closed', () => { win = null; ready = false; });
    try { win.loadURL(deps.recorderUrl()); } catch (e) { log('recorder loadURL error: ' + e.message); }
    return win;
  }

  function sendCmd(msg) {
    if (win && !win.isDestroyed() && ready) { try { win.webContents.send('recorder-cmd', msg); return true; } catch (e) {} }
    return false;
  }

  // ---- IPC callbacks, invoked by main's guarded ipcMain handlers ----
  function isRecorderSender(wc) { return win && !win.isDestroyed() && wc === win.webContents; }

  function onReady() {
    ready = true;
    log('recorder window ready');
    if (pendingStart) { const p = pendingStart; pendingStart = null; doStart(p.reason, p.app); }
  }

  function onPcm(buf, meta) {
    if (!recording || !stream) return;
    // Backstop against a capture that outlived its stop: frames are stamped with the session
    // they were started for, so a stale one can never be mixed into a later recording (which
    // is what doubled every block and made the audio echo).
    if (!meta || meta.session !== captureSession) {
      if (!warnedStaleSession) {
        warnedStaleSession = true;
        log('dropping PCM from a stale capture session (expected ' + captureSession +
            ', got ' + (meta ? meta.session : 'none') + ')');
      }
      return;
    }
    try {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      stream.write(b);
      dataBytes += b.length;
    } catch (e) { log('wav write error: ' + e.message); }
    // Silence auto-stop: reset the timer on any loud frame; trip it after N minutes quiet.
    if (meta && (meta.micRms >= SILENCE_RMS || meta.systemRms >= SILENCE_RMS)) lastLoudAt = Date.now();
    else if (silenceStopMs > 0 && lastLoudAt && (Date.now() - lastLoudAt) >= silenceStopMs) stop('silence');
  }

  function onEnded() { if (recording) stop('source-ended'); }
  function onError(message) { log('recorder error: ' + message); if (recording) stop('error'); }
  function onRecorderState(state, detail) {
    if (state === 'error') { log('recorder capture failed: ' + detail); if (recording) finalizeFile('capture-failed'); }
  }

  // ---- start / stop ----
  function start(reason, app) {
    if (recording) return getState();
    ensureWindow();
    if (!ready) { pendingStart = { reason: reason, app: app || null }; return getState(); }
    return doStart(reason, app);
  }

  function doStart(reason, app) {
    const s = (deps.resolveSettings && deps.resolveSettings()) || {};
    const folder = (s.meetingFolder && String(s.meetingFolder).trim()) || (deps.defaultFolder && deps.defaultFolder()) || '.';
    try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { log('meeting folder create error: ' + e.message); }

    micLabel = s.micDevice || '';
    silenceStopMs = (Number(s.silenceStopMin) > 0) ? Number(s.silenceStopMin) * 60000 : 0;

    const now = new Date();
    filePath = path.join(folder, timestampName(now));
    dataBytes = 0;
    try {
      stream = fs.createWriteStream(filePath);
      stream.write(wavHeader(0));   // placeholder sizes; patched on stop
    } catch (e) {
      log('cannot open wav file: ' + e.message);
      stream = null; filePath = null;
      return getState();
    }

    recording = true;
    startedAt = now.getTime();
    triggerApp = app || null;
    lastLoudAt = now.getTime();

    captureSession++;
    warnedStaleSession = false;
    sendCmd({ type: 'start', mic: micLabel, echoGate: !!s.echoGate, sampleRate: SAMPLE_RATE, session: captureSession });
    log('recording started (' + (reason || 'manual') + (app ? ', app=' + app : '') + ') -> ' + filePath);
    emitState();
    return getState();
  }

  function stop(reason) {
    if (!recording) return getState();
    sendCmd({ type: 'stop' });
    finalizeFile(reason);
    return getState();
  }

  function finalizeFile(reason) {
    recording = false;
    const done = filePath;
    if (stream) {
      const closing = stream;
      const bytes = dataBytes;
      stream = null;
      closing.end(() => {
        // Patch RIFF ChunkSize (offset 4) and data Subchunk2Size (offset 40) now the total is known.
        try {
          const fd = fs.openSync(done, 'r+');
          const head = Buffer.alloc(4);
          head.writeUInt32LE(36 + bytes, 0); fs.writeSync(fd, head, 0, 4, 4);
          head.writeUInt32LE(bytes, 0); fs.writeSync(fd, head, 0, 4, 40);
          fs.closeSync(fd);
        } catch (e) { log('wav header patch error: ' + e.message); }
        log('recording stopped (' + (reason || 'manual') + '), ' + bytes + ' data bytes -> ' + done);
        // File is closed and header-patched — safe for callers to rename/move it now.
        try { if (deps.onRecordingComplete) deps.onRecordingComplete(path.basename(done)); } catch (e) {}
      });
    }
    startedAt = null;
    triggerApp = null;
    filePath = null;
    emitState();
  }

  // Auto-start from the native app-scoped monitor (an allowlisted call went active).
  function autoStart(app) {
    const s = (deps.resolveSettings && deps.resolveSettings()) || {};
    if (!s.autoRecord) return getState();   // auto-record disabled -> ignore the signal
    if (recording) return getState();
    return start('auto', app);
  }

  // The allowlisted call ended. Only stops recordings WE auto-started (triggerApp set) — a manual
  // recording keeps going until the user stops it or silence trips.
  function autoStop(reason) {
    if (recording && triggerApp) return stop(reason || 'call-ended');
    return getState();
  }

  function setMic(label) {
    micLabel = label || '';
    // Live device change mid-recording; harmless when idle (page keeps it for next start).
    sendCmd({ type: 'setMic', mic: micLabel });
    return getState();
  }

  function getState() {
    return {
      recording: recording,
      startedAt: startedAt,
      durationMs: recording && startedAt ? (Date.now() - startedAt) : 0,
      file: filePath ? path.basename(filePath) : null,
      app: triggerApp,
      mic: micLabel,
    };
  }

  function emitState() { try { if (deps.onState) deps.onState(getState()); } catch (e) {} }

  function dispose() {
    if (recording) stop('dispose');
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch (e) {} }
    win = null; ready = false;
  }

  return {
    ensureWindow, start, stop, autoStart, autoStop, setMic, getState, dispose,
    isRecorderSender,
    onReady, onPcm, onEnded, onError, onRecorderState,
  };
}

module.exports = { createMeetingRecorder };
