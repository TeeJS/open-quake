'use strict';

// Shared, electron-free TTS/STT (Wyoming) endpoint config so it can be unit-tested.
//
// Model:
//   - GLOBAL default lives in config.settings.voice = { sttHost, sttPort, ttsHost, ttsPort } — each
//     service (Whisper STT / Piper TTS) has its own host+port so they can be on different servers.
//   - A voice-app PAGE may override the global for just itself via grid.options.voiceOverride +
//     voiceSttHost/voiceSttPort/voiceTtsHost/voiceTtsPort.
// Both are edited in the config editor (global on the TTS/STT tab, override in the page's Advanced).

const { PANEL_PROFILE } = require('./panelGenerate');   // pure: the Panel Builder profile's user-facing half
const routinesLib = require('./routines');              // pure: saved AI routines (shape + list hygiene)

const VOICE_APPS = ['ai-voice'];
// The four pre-consolidation voice app ids, mapped to their AI Voice backend. Pages with these ids
// are rewritten in migrateVoiceConfig; the ids themselves no longer exist in apps.json.
const LEGACY_VOICE_APPS = { 'claude-voice': 'claude', 'codex-voice': 'codex', 'copilot-voice': 'copilot', 'owui-voice': 'owui' };
// Host blank by default (voice stays off until pointed at a server; the editor placeholder is
// 127.0.0.1 for the tts-stt-windows helper). Ports are the standard Wyoming faster-whisper / piper.
const VOICE_DEFAULTS = { sttHost: '', sttPort: '10300', ttsHost: '', ttsPort: '10200' };

function str(x) { return String(x == null ? '' : x).trim(); }

// The global voice endpoints, defaults filled in.
function voiceSettings(settings) {
  const v = (settings && settings.voice) || {};
  return {
    sttHost: str(v.sttHost) || VOICE_DEFAULTS.sttHost,
    sttPort: str(v.sttPort) || VOICE_DEFAULTS.sttPort,
    ttsHost: str(v.ttsHost) || VOICE_DEFAULTS.ttsHost,
    ttsPort: str(v.ttsPort) || VOICE_DEFAULTS.ttsPort,
  };
}

// Effective endpoints for a served voice page. `pageOptions` is grid.options, or null when no such
// page is active — then the endpoints are blank so nothing gets dialed (mirrors the old behavior
// where an inactive app returned an empty host). A page with voiceOverride uses its own values.
function resolveVoiceEndpoints(settings, pageOptions) {
  if (!pageOptions) return { sttHost: '', sttPort: '', ttsHost: '', ttsPort: '' };
  if (pageOptions.voiceOverride) {
    return {
      sttHost: str(pageOptions.voiceSttHost), sttPort: str(pageOptions.voiceSttPort),
      ttsHost: str(pageOptions.voiceTtsHost), ttsPort: str(pageOptions.voiceTtsPort),
    };
  }
  return voiceSettings(settings);
}

// One-time migration of the legacy per-page keys (wyomingHost / wyomingSttPort / wyomingTtsPort, one
// shared host) to the new model: seed the global from the first voice page that has them (its host
// applies to both services), keep any later page whose endpoints differ as an explicit override, and
// drop the legacy keys. Idempotent — with no legacy keys present it changes nothing. Mutates config.
function migrateVoiceConfig(config) {
  if (!config || !Array.isArray(config.grids)) return config;
  // Consolidation (2026-08): the four voice apps became ONE app ('ai-voice') with a per-page
  // backend option. Rewrite old pages in place — everything else about them (options, hotkeys,
  // grid placement) carries over untouched. Idempotent: already-migrated pages don't match.
  for (const g of config.grids) {
    if (!g || !(g.app in LEGACY_VOICE_APPS)) continue;
    if (!g.options) g.options = {};
    if (!g.options.backend) g.options.backend = LEGACY_VOICE_APPS[g.app];
    g.app = 'ai-voice';
  }
  let seeded = !!(config.settings && config.settings.voice);
  for (const g of config.grids) {
    if (!g || !VOICE_APPS.includes(g.app) || !g.options) continue;
    const o = g.options;
    if (!('wyomingHost' in o) && !('wyomingSttPort' in o) && !('wyomingTtsPort' in o)) continue;
    const host = str(o.wyomingHost);
    const sttPort = str(o.wyomingSttPort) || VOICE_DEFAULTS.sttPort;
    const ttsPort = str(o.wyomingTtsPort) || VOICE_DEFAULTS.ttsPort;
    if (!seeded) {
      if (!config.settings) config.settings = {};
      config.settings.voice = { sttHost: host, sttPort, ttsHost: host, ttsPort };
      seeded = true;
    } else {
      const v = voiceSettings(config.settings);
      const differs = host !== v.sttHost || host !== v.ttsHost || sttPort !== v.sttPort || ttsPort !== v.ttsPort;
      if (differs) {
        o.voiceOverride = true;
        o.voiceSttHost = host; o.voiceSttPort = sttPort;
        o.voiceTtsHost = host; o.voiceTtsPort = ttsPort;
      }
    }
    delete o.wyomingHost; delete o.wyomingSttPort; delete o.wyomingTtsPort;
  }
  return config;
}

// Endpoints for LucidType dictation: the first lucidtype grid's own options (honoring its per-page
// override) over the global default. Pure so it's testable without electron — dictation runs in the
// background, so it can't use activeServedAppConfig (which only returns the ACTIVE grid).
function resolveLucidEndpoints(settings, grids) {
  const g = (grids || []).find(x => x && x.kind === 'app' && x.app === 'lucidtype');
  return resolveVoiceEndpoints(settings, (g && g.options) || {});
}

// ---- AI Profiles (Smart Profiles) ----
// A global library of named system-prompt presets for the AI Voice app. Seeded once; the user
// edits them on the Settings -> AI Profiles tab. "General Chat" ships with an EMPTY prompt so the
// default behavior is exactly the pre-feature behavior on every backend.
const DEFAULT_AI_PROFILES = [
  { id: 'chat', name: 'General Chat', prompt: '' },
  { id: 'writer', name: 'Writer', prompt: "You are a skilled writer. Improve, draft, or continue whatever text the user gives you — clear, engaging, and in the user's tone unless asked otherwise. Output only the writing itself, no preamble or explanations." },
  { id: 'translator', name: 'Translator', prompt: 'You are a professional translator. Translate everything the user says into natural, fluent English (or the target language they name), preserving tone and meaning. Output only the translation.' },
  { id: 'summarizer', name: 'Summarizer', prompt: 'Summarize whatever the user provides. Lead with the key point, then up to five short bullets. Be faithful to the source; no opinions, no filler.' },
  { id: 'coder', name: 'Coder', prompt: 'You are an expert programmer. Answer with working code and brief, precise explanations. Prefer minimal, idiomatic solutions; state assumptions in one line.' },
  { id: 'researcher', name: 'Researcher', prompt: 'You are a research assistant. Answer with verifiable facts, note uncertainty explicitly, and structure longer answers with short headings. Be concise and neutral.' },
  { id: 'math', name: 'Math', prompt: 'You are a mathematician. Solve what the user asks, show the essential steps compactly, and end with the result on its own line.' },
  { id: 'email', name: 'Email', prompt: "Turn the user's words into a polished, professional email — greeting, body, sign-off. Keep it brief and courteous. Output only the email text." },
  { id: 'explainer', name: 'Explainer', prompt: 'Explain the topic simply, as to a curious beginner — plain words, one good analogy, no jargon. Keep it under 200 words unless asked for depth.' },
  PANEL_PROFILE,
];

// Adds the Panel Builder profile to a library that predates it. Runs once — the flag means a user
// who deletes the profile keeps it deleted instead of having it grow back every launch.
function ensurePanelProfile(config) {
  if (!config) return config;
  if (!config.settings) config.settings = {};
  const s = config.settings;
  if (s.panelProfileSeeded) return config;
  s.panelProfileSeeded = true;
  if (!Array.isArray(s.aiProfiles)) return config;                       // ensureAiProfiles seeds it whole
  if (s.aiProfiles.some(p => p && p.id === PANEL_PROFILE.id)) return config;
  s.aiProfiles.push(Object.assign({}, PANEL_PROFILE));
  return config;
}

// Seed config.settings.aiProfiles exactly once (idempotent — an existing array, even emptied or
// edited by the user, is never touched). Mutates config, returns it.
function ensureAiProfiles(config) {
  if (!config) return config;
  if (!config.settings) config.settings = {};
  if (!Array.isArray(config.settings.aiProfiles)) {
    config.settings.aiProfiles = DEFAULT_AI_PROFILES.map(p => Object.assign({}, p));
  }
  return config;
}

// Saved AI routines (Settings -> Routines): make sure the list exists and holds only usable
// entries. A hand-edited or half-saved routine with no prompt is dropped here rather than being
// offered in the tile editor's picker, where it would produce a tile that looks right and does
// nothing when tapped.
function ensureRoutines(config) {
  if (!config) return config;
  if (!config.settings) config.settings = {};
  config.settings.routines = routinesLib.normalizeList(config.settings.routines);
  return config;
}

// Resolve a profile id against the library. '' / unknown ids fall back to the FIRST profile
// (General Chat by default), so a deleted profile never breaks a page.
function resolveAiProfile(settings, id) {
  const list = (settings && Array.isArray(settings.aiProfiles)) ? settings.aiProfiles : DEFAULT_AI_PROFILES;
  if (!list.length) return { id: '', name: 'General Chat', prompt: '' };
  return list.find(p => p && p.id === id) || list[0];
}

// Whisper near-silence hallucinations to drop (exact whole-utterance match after normalization, so a
// real sentence that merely contains these words still passes). Mirrors voicepanel-host.js.
const STT_NOISE_PHRASES = ['thanks for watching'];
function isSttNoisePhrase(text) {
  const norm = String(text || '').toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  return STT_NOISE_PHRASES.includes(norm);
}

module.exports = {
  VOICE_APPS, LEGACY_VOICE_APPS, VOICE_DEFAULTS, DEFAULT_AI_PROFILES, ensureAiProfiles, ensurePanelProfile, ensureRoutines, resolveAiProfile, voiceSettings, resolveVoiceEndpoints, resolveLucidEndpoints, migrateVoiceConfig, isSttNoisePhrase };
