'use strict';
// Open WebUI session ADAPTER for the generic voice-panel host (voicepanel-host.js header has the
// contract). Unlike the three CLI adapters there is no child process: a "session" is just an
// in-memory conversation history, and each turn is one streaming chat completion against the
// shared Auth-tab connection (settings.owui via resolveOwui). That means:
//   - no modes and no approvals — listModes() is [] (hides the Mode button), decideApproval()
//     is always false, and no 'approval' event is ever emitted;
//   - projectDir() is '' — there is no working directory (the page's folder button is vestigial);
//   - stop/interrupt destroy the in-flight HTTP stream instead of killing a process;
//   - a truncated reply (finish_reason 'length') is a 'notice', not an error — the partial text
//     is already on screen, visibly cut off, which beats discarding it.
//
// Models come from /api/models after start (async — 'models-changed' repaints the picker).
// validModel stays permissive until that list loads: a failed model fetch must never brick the
// page's Settings writes.

const { EventEmitter } = require('events');
const defaultClient = require('./owuiClient');

const HISTORY_MAX = 40;            // messages (user+assistant) kept as context per session
const TURN_TIMEOUT_MS = 600000;    // socket-inactivity budget per turn; streaming resets it per chunk

function createOwuiVoiceAdapter({ resolveOwui, log, client }) {
  const say = log || (() => {});
  const owui = client || defaultClient;
  const emitter = new EventEmitter();

  let running = false;
  let sid = null;            // 'owui-<ts>' once started
  let history = [];          // [{role:'user'|'assistant', content}] — the model's context
  let modelPick = '';        // per-page override ('' = Auth-tab default)
  let modelList = null;      // null until /api/models answers; then an array of id strings
  let stream = null;         // in-flight { destroy() } from streamChat
  let acc = '';              // assistant text accumulated for the current turn
  let profilePrompt = '';    // active AI profile instruction; prepended as a system message per request

  function cfg() { return (resolveOwui && resolveOwui()) || {}; }
  function endpoint() { return owui.normalizeOwuiUrl(cfg().url); }

  function mapError(e) {
    const status = e && e.statusCode;
    if (status === 401 || status === 403) return 'Open WebUI rejected the API key (HTTP ' + status + ') — check the key on the Auth tab';
    if (status) return 'Open WebUI error (HTTP ' + status + ')';
    const msg = String((e && e.message) || 'request failed');
    if (/no response after/.test(msg)) return 'Open WebUI ' + msg;
    return 'could not reach Open WebUI (' + msg + ') — is Open WebUI running?';
  }

  // Fire-and-forget model discovery; failure is logged, never fatal (validModel stays permissive).
  function fetchModels() {
    const ep = endpoint();
    if (!ep) return;
    owui.listModels(ep.modelsUrl, String(cfg().apiKey || ''))
      .then(ids => {
        modelList = ids;
        say('model list loaded (' + ids.length + ')');
        emitter.emit('models-changed', {});
      })
      .catch(e => say('model list unavailable: ' + ((e && e.message) || e)));
  }

  function finishTurn(text, error) {
    stream = null;
    acc = '';
    emitter.emit('turn-complete', { text: text || null, error: error || null });
  }

  return {
    // ---- lifecycle ----
    start({ model, profilePrompt: pp }) {
      if (!endpoint()) {
        say('start refused: no usable Open WebUI URL configured');
        emitter.emit('error', { message: "Open WebUI connection not configured — set the URL on the editor's Auth tab." });
        return false;
      }
      if (stream) { try { stream.destroy(); } catch (e) {} stream = null; }
      running = true;
      sid = 'owui-' + Date.now();
      history = [];
      acc = '';
      modelPick = model || '';
      profilePrompt = String(pp || '');
      fetchModels();
      return true;
    },
    // AI profile switch — takes effect on the next request (system message prepended per send,
    // never evicted by the history cap). Instant, no restart.
    setProfilePrompt(text) { profilePrompt = String(text || ''); return true; },
    stop() {
      if (stream) { try { stream.destroy(); } catch (e) {} stream = null; }
      running = false;
      sid = null;
      history = [];
      acc = '';
    },
    sendTurn(text) {
      if (!running || stream) return false;
      const ep = endpoint();
      if (!ep) return false;
      const model = String(modelPick || cfg().model || '').trim();
      if (!model) {
        // Sendable-but-doomed would confuse the queueing host — accept the turn and fail it
        // with a wording that names the fix.
        emitter.emit('assistant-start');
        setImmediate(() => finishTurn(null, 'no Open WebUI model set — pick one with the Model button, or set a default on the Auth tab'));
        return true;
      }
      history.push({ role: 'user', content: text });
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      acc = '';
      emitter.emit('assistant-start');
      let sawLength = false;
      stream = owui.streamChat(ep.chatUrl, { model, stream: true, messages: (profilePrompt ? [{ role: 'system', content: profilePrompt }] : []).concat(history) }, String(cfg().apiKey || ''), TURN_TIMEOUT_MS, {
        onDelta: t => { acc += t; emitter.emit('assistant-delta', { text: t }); },
        onDone: ({ finishReason }) => {
          sawLength = finishReason === 'length';
          const text = acc;
          if (text) history.push({ role: 'assistant', content: text });
          if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
          emitter.emit('assistant-final', { text });
          if (sawLength) emitter.emit('notice', { text: 'Reply truncated — the model hit its context limit.' });
          finishTurn(text, null);
        },
        onError: e => {
          // Drop the failed user message so a retry doesn't double it in the context.
          if (history.length && history[history.length - 1].role === 'user') history.pop();
          const msg = mapError(e);
          say('turn failed: ' + msg);
          finishTurn(null, msg);
        },
      });
      return true;
    },
    isRunning() { return running; },
    sessionId() { return sid; },
    projectDir() { return ''; },
    interrupt() {
      if (!stream) return false;
      try { stream.destroy(); } catch (e) {}
      // Settle the turn with whatever streamed so far — the host is waiting on turn-complete.
      const partial = acc;
      if (partial) history.push({ role: 'assistant', content: partial });
      emitter.emit('assistant-final', { text: partial });
      finishTurn(partial, null);
      return true;
    },

    // ---- modes: none. '' + [] hide the Mode button on the shared page. ----
    setMode() { return false; },
    mode() { return ''; },
    listModes() { return []; },

    // ---- model: '' = the Auth-tab default; list fills in async after start ----
    setModel(pick) {
      if (!this.validModel(pick)) return false;
      modelPick = String(pick || '');
      emitter.emit('model', { model: modelPick || String(cfg().model || '') });
      return true;
    },
    currentModel() { return modelPick || String(cfg().model || '') || null; },
    validModel(pick) {
      if (pick === '' || pick == null) return true;
      if (typeof pick !== 'string') return false;
      return modelList === null ? true : modelList.includes(pick);   // permissive until the list loads
    },
    listModels() {
      const def = String(cfg().model || '').trim();
      return [{ id: '', label: 'Default' + (def ? ' (' + def + ')' : ' (Auth tab setting)') }]
        .concat((modelList || []).map(id => ({ id, label: id })));
    },

    // ---- approvals: none. The API can't run tools, so nothing ever asks. ----
    supportsAlwaysApproval: false,
    decideApproval() { return false; },
    cancelApprovals() {},

    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

module.exports = { createOwuiVoiceAdapter };
