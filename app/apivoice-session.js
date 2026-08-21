'use strict';
// OpenAI-compatible API session ADAPTER for the generic voice-panel host (voicepanel-host.js header
// has the contract; owuivoice-session.js is the sibling this is modeled on). Backend for the AI
// Voice app's "API endpoint" mode: bring your own key — OpenAI, DeepSeek, OpenRouter, Groq, a local
// LiteLLM/Ollama/vLLM — anything speaking the OpenAI chat-completions protocol. Like the OWUI
// adapter there is no child process: a "session" is an in-memory conversation history and each turn
// is one streaming chat completion. No modes, no approvals, no project folder.
//
// Connection config is PER PAGE (grid.options: apiBaseUrl / apiKey / apiModel), resolved live via
// resolveApi() so editor changes apply on the next turn. The key never reaches the page — it stays
// in main-process memory (encrypted at rest by secretStore).

const { EventEmitter } = require('events');
const defaultClient = require('./owuiClient');   // generic OpenAI-shaped SSE/JSON helpers

const HISTORY_MAX = 40;            // messages (user+assistant) kept as context per session
const TURN_TIMEOUT_MS = 600000;    // socket-inactivity budget per turn; streaming resets it per chunk

function createApiVoiceAdapter({ resolveApi, log, client }) {
  const say = log || (() => {});
  const api = client || defaultClient;
  const emitter = new EventEmitter();

  let running = false;
  let sid = null;            // 'api-<ts>' once started
  let history = [];          // [{role:'user'|'assistant', content}] — the model's context
  let modelPick = '';        // per-page Settings override ('' = the page's configured apiModel)
  let modelList = null;      // null until /models answers; then an array of id strings
  let stream = null;         // in-flight { destroy() } from streamChat
  let acc = '';              // assistant text accumulated for the current turn
  let profilePrompt = '';    // active AI profile instruction; prepended as a system message per request

  function cfg() { return (resolveApi && resolveApi()) || {}; }
  function baseUrl() { return String(cfg().apiBaseUrl || '').trim().replace(/\/+$/, ''); }
  function chatUrl() { const b = baseUrl(); return b ? b + '/chat/completions' : ''; }
  function modelsUrl() { const b = baseUrl(); return b ? b + '/models' : ''; }

  function mapError(e) {
    const status = e && e.statusCode;
    if (status === 401 || status === 403) return 'The API endpoint rejected the key (HTTP ' + status + ') — check the API key in this page’s settings';
    if (status) return 'API endpoint error (HTTP ' + status + ')';
    const msg = String((e && e.message) || 'request failed');
    if (/no response after/.test(msg)) return 'API endpoint ' + msg;
    return 'could not reach the API endpoint (' + msg + ') — check the URL in this page’s settings';
  }

  // Fire-and-forget model discovery; failure is logged, never fatal (validModel stays permissive).
  function fetchModels() {
    const u = modelsUrl();
    if (!u) return;
    api.listModels(u, String(cfg().apiKey || ''))
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
      if (!baseUrl() || !String(cfg().apiKey || '').trim()) {
        say('start refused: API endpoint or key not configured');
        emitter.emit('error', { message: 'API endpoint not configured — set the URL and key in this page’s settings (config editor).' });
        return false;
      }
      if (stream) { try { stream.destroy(); } catch (e) {} stream = null; }
      running = true;
      sid = 'api-' + Date.now();
      history = [];
      acc = '';
      modelPick = model || '';
      profilePrompt = String(pp || '');
      fetchModels();
      return true;
    },
    // AI profile switch — takes effect on the next request (the system message is prepended per
    // send, so it can never be evicted by the history cap). Instant, no restart.
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
      const u = chatUrl();
      if (!u) return false;
      const model = String(modelPick || cfg().apiModel || '').trim();
      if (!model) {
        // Sendable-but-doomed would confuse the queueing host — accept the turn and fail it
        // with a wording that names the fix.
        emitter.emit('assistant-start');
        setImmediate(() => finishTurn(null, 'no model set — pick one with the Model button, or set it in this page’s settings'));
        return true;
      }
      history.push({ role: 'user', content: text });
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      acc = '';
      emitter.emit('assistant-start');
      let sawLength = false;
      const payload = { model, stream: true, messages: (profilePrompt ? [{ role: 'system', content: profilePrompt }] : []).concat(history) };
      // DeepSeek v4 defaults to thinking mode (long reasoning delays, answer can land outside
      // content). Disable it; only for DeepSeek models — true-OpenAI endpoints reject unknown params.
      if (/deepseek/i.test(model)) payload.thinking = { type: 'disabled' };
      stream = api.streamChat(u, payload, String(cfg().apiKey || ''), TURN_TIMEOUT_MS, {
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

    // ---- model: '' = the page's configured apiModel; list fills in async after start ----
    setModel(pick) {
      if (!this.validModel(pick)) return false;
      modelPick = String(pick || '');
      emitter.emit('model', { model: modelPick || String(cfg().apiModel || '') });
      return true;
    },
    currentModel() { return modelPick || String(cfg().apiModel || '') || null; },
    validModel(pick) {
      if (pick === '' || pick == null) return true;
      if (typeof pick !== 'string') return false;
      return modelList === null ? true : modelList.includes(pick);   // permissive until the list loads
    },
    listModels() {
      const def = String(cfg().apiModel || '').trim();
      return [{ id: '', label: 'Default' + (def ? ' (' + def + ')' : '') }]
        .concat((modelList || []).map(id => ({ id, label: id })));
    },

    // ---- approvals: none. A plain chat API runs no tools, so nothing ever asks. ----
    supportsAlwaysApproval: false,
    decideApproval() { return false; },
    cancelApprovals() {},

    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

module.exports = { createApiVoiceAdapter };
