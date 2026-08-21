'use strict';
// Hidden LucidType capture renderer. On a 'start' command it runs the shared energy VAD
// (window.createClaudeVoiceVAD) over the selected mic and streams each trimmed utterance's Int16 PCM
// to main via the preload bridge; on 'stop' it tears the VAD down. Also plays the start/stop beep.
(function () {
  var api = window.lucidDictate;
  var log = function (m) { try { api.log('[dictate] ' + m); } catch (e) {} };
  var vad = null;
  var running = false;

  // Map a saved mic *label* (LucidType stores labels, like the Meeting picker) to a deviceId. Labels
  // are only populated after a getUserMedia grant, so unlock once, enumerate, then match.
  function resolveDeviceId(label) {
    if (!label) return Promise.resolve('');
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
      tmp.getTracks().forEach(function (t) { t.stop(); });
      return navigator.mediaDevices.enumerateDevices().then(function (list) {
        var m = list.find(function (d) { return d.kind === 'audioinput' && d.label === label; });
        return m ? m.deviceId : '';
      });
    }).catch(function () { return ''; });
  }

  function beep(freq) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.value = 0.08;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      setTimeout(function () { try { osc.stop(); ctx.close(); } catch (e) {} }, 120);
    } catch (e) {}
  }

  function startCapture(msg) {
    if (running) return;
    running = true;
    if (msg.beep) beep(800);
    vad = window.createClaudeVoiceVAD({ hangoverMs: msg.silenceMs || 400 });
    resolveDeviceId(msg.micDevice || '').then(function (id) {
      if (!running) return;   // a stop raced in during device resolution
      vad.setInputDevice(id);
      vad.start(
        function () {},                                  // onSpeechStart — nothing to do here
        function (int16) {                               // onSpeechEnd — ship the utterance to main
          try { api.sendPcm(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)); }
          catch (e) { log('sendPcm failed: ' + e.message); }
        },
        null
      ).catch(function (e) { log('vad.start failed: ' + e.message); running = false; });
    });
  }

  function stopCapture(msg) {
    if (!running) return;
    running = false;
    try { if (vad) vad.stop(); } catch (e) {}
    vad = null;
    if (msg && msg.beep) beep(400);
  }

  api.onCommand(function (msg) {
    if (!msg) return;
    if (msg.type === 'start') startCapture(msg);
    else if (msg.type === 'stop') stopCapture(msg);
  });
  log('ready');
})();
