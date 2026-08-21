'use strict';
// recorderview.js
//
// RENDERER of the hidden meeting-recorder window. Owns the single capture path for the
// whole app: on a 'start' command from main it opens the selected mic + system loopback via
// SystemAudioCapture (system-audio-capture.js), streams interleaved stereo int16 PCM frames
// back to main (which writes the WAV), and reports lifecycle transitions. The visible meeting
// panel page never captures — it's only a remote that reflects main's state.
//
// Mic selection persists app-wide as a LABEL (Chromium salts deviceIds per origin/port), so we
// resolve label -> live deviceId here with a momentary getUserMedia grant, exactly like the
// Claude Voice picker (claudevoiceview.js ensureDeviceIds/matchDevices).

var api = window.recorderAPI;
var statusEl = document.getElementById('s');
function setStatus(t) { if (statusEl) statusEl.textContent = 'recorder ' + t; }

var capture = null;
var captureGen = 0;        // bumped by stopCapture(); identifies a superseded/cancelled capture
var curSession = 0;        // main's recording session id, echoed back on every PCM frame
var curMicLabel = '';      // '' = system default
var curEchoGate = false;   // faithful capture by default (set per command)
var curSampleRate = 16000;

// ---- label -> deviceId resolution (momentary grant then enumerate) ----
function resolveMicDeviceId(label) {
  if (!label) return Promise.resolve('');
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      tmp.getTracks().forEach(function (t) { t.stop(); });
      var d = (devs || []).find(function (x) { return x.kind === 'audioinput' && x.label === label; });
      return d ? d.deviceId : '';   // missing device -> system default, never a hard fail
    });
  }).catch(function () { return ''; });
}

function stopCapture() {
  captureGen++;   // invalidate any startCapture() still resolving its mic deviceId
  if (capture) { try { capture.stop(); } catch (e) {} capture = null; }
}

// Resolving the mic label is async (a momentary getUserMedia + enumerateDevices, slow on
// Bluetooth), and `capture` stays null for that whole window — so a stop arriving mid-flight
// used to be a no-op and the capture went live anyway, orphaned and permanently streaming.
// Every start is therefore stamped with a generation; anything from a stale generation is
// dropped and torn down instead of reaching main.
function startCapture() {
  stopCapture();
  var gen = captureGen;
  var session = curSession;
  setStatus('starting');
  resolveMicDeviceId(curMicLabel).then(function (deviceId) {
    if (gen !== captureGen) return null;   // stopped or superseded while resolving
    var micConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    // deviceId as `ideal`, never `exact`: an unplugged mic falls back to the system
    // default rather than failing the whole recording.
    if (deviceId) micConstraints.deviceId = { ideal: deviceId };

    var c = new window.SystemAudioCapture({
      sampleRate: curSampleRate,
      echoGate: curEchoGate,
      micConstraints: micConstraints,
      onPcm: function (int16, meta) {
        if (gen !== captureGen) return;    // superseded capture — never write into a live file
        // int16 is a freshly-allocated buffer per frame in this build — safe to hand its
        // ArrayBuffer straight to main without copying.
        meta.session = session;
        try { api.sendPcm(int16.buffer, meta); } catch (e) {}
      },
      onSourceEnded: function () { if (gen === captureGen) api.sendEnded(); },
      onError: function (err) { if (gen === captureGen) api.sendError(err && err.message ? err.message : err); },
    });
    return c.start().then(function () {
      // A stop that landed while start() was awaiting its grants leaves us holding a live
      // capture nobody references — shut it down here rather than leaking it.
      if (gen !== captureGen) { try { c.stop(); } catch (e) {} return null; }
      capture = c;
      return c;
    });
  }).then(function (c) {
    if (!c) return;                        // superseded — a newer start owns the status
    setStatus('recording');
    api.sendState('recording');
  }).catch(function (err) {
    if (gen !== captureGen) return;
    stopCapture();
    setStatus('error');
    api.sendState('error', err && err.message ? err.message : String(err));
  });
}

api.onCommand(function (msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'start') {
    curMicLabel = msg.mic || '';
    curEchoGate = !!msg.echoGate;
    curSampleRate = msg.sampleRate || 16000;
    curSession = msg.session || 0;   // stamped onto this recording's frames; setMic restarts keep it
    startCapture();
  } else if (msg.type === 'stop') {
    stopCapture();
    setStatus('idle');
    api.sendState('idle');
  } else if (msg.type === 'setMic') {
    curMicLabel = msg.mic || '';
    // Live device change: restart capture on the new mic if we're currently recording.
    if (capture) startCapture();
  }
});

api.ready();
setStatus('idle');
