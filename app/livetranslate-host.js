'use strict';
// Lightweight HOST for the "Live Translate" panel app. No turn/SSE/speech machinery. Two providers:
//   soniox — the page streams mic PCM to Soniox's realtime-translation WebSocket itself; this host
//            only mints short-lived temp keys (/soniox-token) so the real key never leaves main.
//   ai     — "bring your own key": the page VAD-chunks utterances and POSTs the PCM to /audio; this
//            host transcribes via the configured Wyoming/Whisper STT (Settings → TTS/STT — needs a
//            multilingual Whisper model, not English-only Parakeet), then translates the text through
//            any OpenAI-compatible chat endpoint (DeepSeek / OpenAI / Open WebUI / …) with a rolling
//            context of recent lines so pronouns resolve across sentences.
// Both append finalized translations to a running text file when Save-to-file is on. API keys are
// plaintext in memory, encrypted at rest by secretStore, and never reach the renderer.
//
// deps (reuses main.js's voicePanelDeps('livetranslate')):
//   voiceEndpoints() -> { sttHost, sttPort }   activeServedAppConfig(appId)
//   activeGrid()   saveConfig()   getDocumentsPath()
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');                         // Soniox temp-key mint + AI chat endpoint
const wyoming = require('./claudevoice-wyoming');       // pure Wyoming STT protocol client
const { isSttNoisePhrase } = require('./voiceConfig');  // drops whisper's near-silence hallucinations

function truthy(v) { return v === true || v === '1' || v === 'true'; }

// Panel-editable options, validated + normalized to the string form stored in config.json's g.options
// (so they survive app restarts and match how the query-string delivery re-reads them).
const PANEL_OPTIONS = {
  saveToFile: v => (v === true || v === '1' || v === false || v === '0' || v === 'true' || v === 'false')
    ? (truthy(v) ? '1' : '0') : null,
  vadHangoverMs: v => { const n = parseInt(v, 10); return n >= 400 && n <= 2500 ? String(n) : null; },
  // Mic pick is stored as a LABEL, not a deviceId (Chromium salts ids per origin, and the served
  // origin's port changes every launch); the page re-matches label -> id at startup. '' = default.
  micDevice: v => typeof v === 'string' && v.length <= 200 ? v : null,
};

// Rolling AI-translate context: how many recent (source, translation) pairs ride along in each
// request, and how long a silence resets the conversation (new topic, new context).
const AI_CONTEXT_PAIRS = 6;
const AI_CONTEXT_RESET_MS = 120000;
const AI_SYSTEM_PROMPT = target => 'You are a live interpreter. Translate everything the user says into ' +
  target + '. Output ONLY the translation — no quotes, no notes, no romanization. Keep names and numbers ' +
  'as spoken. Use the conversation so far to resolve pronouns and context.';

function createLiveTranslateHost({ appId = 'livetranslate', log, deps }) {
  const say = log || (() => {});
  let currentSavePath = '';   // file the current Save-to-file session appends to (stamped on first line)

  function pageOptions() {
    const cfg = deps.activeServedAppConfig(appId);
    return (cfg && cfg.options) || null;
  }
  // Two-digit-padded local timestamp for the save filename (app code, so Date is fine to use here).
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' +
      p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
  }
  function saveFolder() {
    const o = pageOptions();
    const custom = o && String(o.saveFolder || '').trim();
    return custom || path.join(deps.getDocumentsPath() || '', 'OpenQuake Translations');
  }

  // Append one finalized line to the running file when Save-to-file is on. One file per save session:
  // the name is stamped when the first line lands and reused until saving is toggled off.
  function maybeSave(line) {
    const o = pageOptions();
    if (!o || !truthy(o.saveToFile)) { currentSavePath = ''; return; }
    try {
      const dir = saveFolder();
      fs.mkdirSync(dir, { recursive: true });
      if (!currentSavePath) currentSavePath = path.join(dir, 'translation-' + stamp() + '.txt');
      fs.appendFileSync(currentSavePath, line + '\r\n');
    } catch (e) { say('Save-to-file failed: ' + e.message); }
  }

  // Mint a SHORT-LIVED Soniox temporary API key from the page's stored key. The renderer
  // authenticates its Soniox WebSocket with this temp key, so the real key never leaves main.
  function sonioxToken() {
    const o = pageOptions();
    const key = o && String(o.sonioxApiKey || '').trim();
    if (!key) return Promise.resolve({ ok: false, error: 'Soniox API key not set (this page’s settings)' });
    const body = JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 300, max_session_duration_seconds: 3600 });
    return new Promise(resolve => {
      const req = https.request('https://api.soniox.com/v1/auth/temporary-api-key', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let data = ''; res.on('data', d => data += d); res.on('end', () => {
          let j = null; try { j = JSON.parse(data); } catch (e) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && j && j.api_key) resolve({ ok: true, apiKey: j.api_key, expiresAt: j.expires_at });
          else { say('Soniox token mint failed: ' + res.statusCode + ' ' + data.slice(0, 200)); resolve({ ok: false, error: (j && (j.error_message || j.message)) || ('Soniox HTTP ' + res.statusCode) }); }
        });
      });
      req.on('error', e => { say('Soniox token error: ' + e.message); resolve({ ok: false, error: e.message }); });
      req.write(body); req.end();
    });
  }

  // Append finalized translation to the save file (the page posts the session text on stop).
  function appendLine(text) { const t = String(text || '').trim(); if (t) maybeSave(t); return { ok: true }; }

  // ---- AI provider: Wyoming STT -> OpenAI-compatible chat translation ----
  let aiPairs = [];        // rolling (src, tgt) context for the current conversation
  let aiLastAt = 0;        // last successful translation, for the silence-gap context reset

  function aiConfig() {
    const o = pageOptions() || {};
    return {
      baseUrl: String(o.aiBaseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(o.aiApiKey || '').trim(),
      model: String(o.aiModel || '').trim(),
      target: String(o.targetLanguage || 'en').trim() || 'en',
    };
  }

  // One chat-completion call. Returns the translated string or throws.
  function aiChat(cfg, messages) {
    const payload = { model: cfg.model, messages, stream: false, max_tokens: 300 };
    // DeepSeek v4 defaults to thinking mode (effort high) — seconds of reasoning overhead per
    // request and the answer can land in reasoning_content, leaving content empty. Disable it;
    // only for DeepSeek models, since OpenAI rejects unknown request params.
    if (/deepseek/i.test(cfg.model)) payload.thinking = { type: 'disabled' };
    const body = JSON.stringify(payload);
    const u = new URL(cfg.baseUrl + '/chat/completions');
    const mod = u.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request(u, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 20000,
      }, res => {
        let data = ''; res.on('data', d => data += d); res.on('end', () => {
          let j = null; try { j = JSON.parse(data); } catch (e) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && j && j.choices && j.choices[0] && j.choices[0].message)
            resolve(String(j.choices[0].message.content || '').trim());
          else reject(new Error('AI endpoint HTTP ' + res.statusCode + ((j && j.error && j.error.message) ? ': ' + j.error.message : '')));
        });
      });
      req.on('timeout', () => { req.destroy(new Error('AI endpoint timed out (20s)')); });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }

  // Translate one utterance with the rolling context (exported for tests via _aiTranslate).
  async function aiTranslate(text) {
    const cfg = aiConfig();
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) throw new Error('AI endpoint not configured (this page’s settings)');
    if (Date.now() - aiLastAt > AI_CONTEXT_RESET_MS) aiPairs = [];   // long silence = new conversation
    const messages = [{ role: 'system', content: AI_SYSTEM_PROMPT(cfg.target) }];
    for (const p of aiPairs.slice(-AI_CONTEXT_PAIRS)) {
      messages.push({ role: 'user', content: p.src }, { role: 'assistant', content: p.tgt });
    }
    messages.push({ role: 'user', content: text });
    const out = await aiChat(cfg, messages);
    if (out) { aiPairs.push({ src: text, tgt: out }); if (aiPairs.length > 24) aiPairs = aiPairs.slice(-24); aiLastAt = Date.now(); }
    return out;
  }

  // Quick TCP probe: is anything actually LISTENING at the configured STT endpoint? Configured and
  // reachable are different failures, and the user needs to know which one they have.
  function probePort(host, port, timeoutMs) {
    return new Promise(resolve => {
      const s = net.connect({ host, port: parseInt(port, 10) });
      const done = ok => { try { s.destroy(); } catch (e) {} resolve(ok); };
      s.setTimeout(timeoutMs || 800, () => done(false));
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
    });
  }

  function sttDownMessage(host, port) {
    return 'STT server not reachable at ' + host + ':' + port + ' — start the tts-sst tray app (with a multilingual model, e.g. Parakeet v3), or fix the endpoint in Settings → TTS/STT.';
  }

  // AI provider's /audio flow: one VAD-trimmed utterance -> Whisper STT (source language) -> AI
  // translation -> caption text (saved when Save-to-file is on).
  async function transcribe(pcmBuffer) {
    const { sttHost: host, sttPort: port } = deps.voiceEndpoints();
    if (!host || !port) {
      return { ok: false, error: 'STT not configured — set the Wyoming/Whisper endpoint in Settings → TTS/STT (a multilingual Whisper model, not Parakeet)' };
    }
    try {
      const text = await wyoming.transcribe({ host, port, audio: pcmBuffer, rate: 16000, width: 2, channels: 1, log: say });
      if (isSttNoisePhrase(text)) { say('STT dropped a known noise-hallucination phrase: ' + JSON.stringify(text)); return { ok: true, text: '' }; }
      const clean = String(text || '').trim();
      if (!clean) return { ok: true, text: '' };
      say('heard: ' + JSON.stringify(clean));   // the STT diagnostic — bad captions? read what it heard
      const translated = await aiTranslate(clean);
      if (translated) maybeSave(translated);
      return { ok: true, text: translated, original: clean };
    } catch (e) {
      say('AI translate error: ' + e.message);
      // Raw socket errors are useless on the panel — translate the common one into the actual fix.
      const msg = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timed out/i.test(e.message) && !/AI endpoint/i.test(e.message)
        ? sttDownMessage(host, port) : e.message;
      return { ok: false, error: msg };
    }
  }

  // Pre-flight for the page's mic tap (AI provider): is everything in place to translate? Returns
  // the FIRST blocking problem as a human sentence, so the user is told before speaking, not after.
  async function aiReady() {
    const o = pageOptions() || {};
    if ((o.provider === 'ai' ? 'ai' : 'soniox') !== 'ai') return { ok: true };
    const cfg = aiConfig();
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) return { ok: false, error: 'AI endpoint not configured — set the endpoint, key, and model in this page’s settings (config editor).' };
    const { sttHost: host, sttPort: port } = deps.voiceEndpoints();
    if (!host || !port) return { ok: false, error: 'STT not configured — set the Wyoming/Whisper endpoint in Settings → TTS/STT.' };
    if (!(await probePort(host, port))) return { ok: false, error: sttDownMessage(host, port) };
    return { ok: true };
  }

  // Snapshot for the page's on-load /state fetch: provider, configured?, target language, save state.
  function getState() {
    const o = pageOptions() || {};
    const cfg = aiConfig();
    const { sttHost, sttPort } = deps.voiceEndpoints();
    return {
      ok: true,
      status: 'idle',
      provider: o.provider === 'ai' ? 'ai' : 'soniox',
      sonioxConfigured: !!String(o.sonioxApiKey || '').trim(),
      aiConfigured: !!(cfg.baseUrl && cfg.apiKey && cfg.model),
      sttConfigured: !!(sttHost && sttPort),
      sttEndpoint: sttHost && sttPort ? (sttHost + ':' + sttPort) : '',
      targetLanguage: o.targetLanguage || 'en',
      targetLangLabel: o.targetLangLabel || '',
      saveToFile: truthy(o.saveToFile),
      savePath: currentSavePath || '',
    };
  }

  // Persist a panel-tunable option into this page's options in config.json (only when livetranslate is
  // the active page). Toggling save OFF ends the current file so the next ON starts a fresh one.
  function setOption(key, value) {
    const validate = PANEL_OPTIONS[key];
    if (!validate) return false;
    const v = validate(value);
    if (v == null) return false;
    const g = deps.activeGrid();
    if (!(g && g.kind === 'app' && g.app === appId)) return false;
    if (!g.options) g.options = {};
    g.options[key] = v;
    if (key === 'saveToFile' && v === '0') currentSavePath = '';
    deps.saveConfig();
    return true;
  }

  return {
    appId,
    handlers: { getState, setOption, sonioxToken, appendLine, transcribe, aiReady },
    _aiTranslate: aiTranslate,   // exposed for unit tests
    shutdown() {},   // nothing long-lived to tear down
  };
}

module.exports = { createLiveTranslateHost };
