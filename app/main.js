'use strict';
// open-quake launcher: multi-grid panel + PC config editor. Talks to either the DK-QUAKE /
// ARIS-68 panel (via Aris68Connector) or the open Bedrock RP2040 knob (via BedrockConnector),
// routed through MultiKnob which picks whichever device is plugged in.

// Node bundles its own CA list (Mozilla's) and never consults the OS trust store — so on a
// corporate network doing TLS inspection (a re-signed cert chained to a private root the OS
// already trusts), plain Node/`ws` connections (the HA client below) fail with "unable to get
// local issuer certificate" even though the same cert is trusted fine in Chromium-rendered
// pages. win-ca injects whatever Windows already trusts into Node's global TLS trust at
// startup — do this before any module below can open a connection. macOS/Linux untouched
// (Node's default CA list is normally sufficient there); failure here is non-fatal — connections
// just fall back to Node's default behavior, matching how they worked before this existed.
//
// MUST use inject:'+' (not the bare `require('win-ca')` auto-run, which defaults to inject:true).
// inject:true only sets https.globalAgent.options.ca — it covers plain `https` calls but NOT the
// `ws` library's WebSocket connections, which build their own TLS socket via tls.createSecureContext
// directly. inject:'+' patches tls.createSecureContext itself, so it's picked up by every TLS
// connection regardless of which higher-level module opened it. fallback:true skips the native
// N-API cert reader in favor of shelling out. This is unrelated to secret storage: DPAPI operations
// use the in-process first-party binding and never create a PowerShell child process.
if (process.platform === 'win32') {
  try { require('win-ca/api')({ inject: '+', fallback: true }); }
  catch (e) { console.log('win-ca load failed:', e.message); }
}

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, powerSaveBlocker, ipcMain, shell, dialog, session, net, safeStorage, clipboard, globalShortcut, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const HID = require('node-hid');
const MultiKnob = require('./multiKnob');                                           // owns Aris68Connector + BedrockConnector; routes to whichever device is plugged in
const http = require('http');
const actionRunner = require('./actionRunner');
const { createMediaKeys } = require('./mediaKeys');
const { createSecretStore } = require('./secretStore');
const { OAuthHandler } = require('../src/auth/oauth-handler');
const { TokenStorage } = require('../src/auth/token-storage');
const { providers: oauthProviders } = require('../src/auth/providers');
const { createOfficeGraph } = require('./officeGraph');
const { createOfficeActions } = require('./officeActions');
const { officeShortcutImageDataUrl } = require('./officeShortcutIcons');
const { configForRenderer } = require('./oauthConfigBoundary');
const nowplaying = require('./nowplaying');   // same singleton sysserver polls — read its snapshot to target transport
const haschedule = require('./haschedule');   // HA Schedule dev app — fed HA creds from .env, polled while shown
const haClient = require('./haClient');       // Global HA cache (registries + dashboards); per-entity states fetched lazily
const touchSetup = require('./touchSetup');   // Bind a touchscreen to its physical display via tabcal.exe (Windows)
const meetingControl = require('./meetingControl');   // Zoom/Teams call-control keystrokes (Meeting app page)
const { createMeetingRecorder } = require('./meetingRecorder'); // hidden-window meeting recorder (mic + system loopback -> WAV)
const { enableLoopbackAudioCapture } = require('./loopback-audio'); // system-audio loopback display-media handler (recorder session only)
const desktopFocus = require('./desktopFocus');   // tracks the PC's OS-level foreground app; auto-switches the panel to a mapped page
const ahk = require('./ahk');                  // macro "ahk" step backend (shells out to an installed AutoHotkey.exe)
const { createReservedDisplay } = require('./reservedDisplay'); // Windows helper that keeps foreign windows off the panel display
const { createVoicePanelHost } = require('./voicepanel-host'); // generic voice-panel app host (state/SSE/speech/STT-TTS plumbing)
const { createClaudeVoiceAdapter } = require('./claudevoice-adapter'); // Claude Code session adapter (CLI spawn, events, approval hook)
const { createCodexVoiceAdapter, findCodexExe } = require('./codexvoice-session'); // OpenAI Codex session adapter (app-server JSON-RPC over stdio)
const { createCopilotVoiceAdapter, findCopilotExe } = require('./copilotvoice-session'); // GitHub Copilot CLI session adapter (ACP JSON-RPC over stdio)
const { findClaudeExe } = require('./claudevoice-session'); // CLI presence probe for the editor's voice-app warning
const claudeVoiceApprovals = require('./claudevoice-approvals'); // required directly ONLY for the boot-time leftover-hook sweep below
const HA_SCHEDULE_APPS = ['haschedule', 'agenda', 'events'];   // dev apps backed by the shared HA /haschedule-data snapshot

const USER_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DIR, 'config.json');                  // writable — works inside a packaged app too
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config.default.json'); // bundled (read-only)
const LEGACY_CONFIG_PATH = path.join(__dirname, 'config.json');          // pre-userData dev location, migrated once
const APPS_DIR = path.join(__dirname, '..', 'apps').replace('app.asar', 'app.asar.unpacked'); // unpacked when packaged
const SMTC_CTL_EXE = path.join(__dirname, 'native', 'smtc-control.exe').replace('app.asar', 'app.asar.unpacked'); // SMTC transport helper (Windows)
const MIC_MONITOR_EXE = path.join(__dirname, 'native', 'mic-session-monitor.exe').replace('app.asar', 'app.asar.unpacked'); // app-scoped mic-in-use monitor (Windows)
const SYSVOL_EXE = path.join(__dirname, 'native', 'sysvolume.exe').replace('app.asar', 'app.asar.unpacked'); // reads the real system volume for the meeting rail
const OUTLOOK_MEETING_EXE = path.join(__dirname, 'native', 'outlook-meeting.exe').replace('app.asar', 'app.asar.unpacked'); // pulls current-meeting info from classic Outlook over COM
const LED_DEFAULT = { effect: 1, brightness: 200, speed: 128, hue: 128, sat: 255 }; // ring lighting fallback (effect 1 = Solid Color)
const THEME_DEFAULT = { appearance: 'system', accent: '#7CFFB2', presets: ['#7CFFB2', '#38B6FF', '#FF4040', '#FFB000'] };
const DEFAULT_SETTINGS = { launchMode: 'editor', micOnLaunch: false, reservedDisplay: false, lighting: Object.assign({}, LED_DEFAULT), theme: Object.assign({}, THEME_DEFAULT) };
const actionDeps = { fs, shell, exec, execFile, spawn, platform: process.platform, log: message => console.log(message) };
const mediaKeys = createMediaKeys({ log: message => console.log(message) });
let firstRun = false;     // set by loadConfig when there was no prior config (fresh install)
let micState = false;     // current device mic state (LED follows it)
let meetingRecorder = null;   // hidden-window meeting recorder (created once the panel server is up)
let meetingLibrary = null;    // recordings list/delete/resolve for the panel's library screens
let meetingTranscriber = null; // FIFO diarizer-upload queue (meetingTranscribe.js)
let meetingAnalyzer = null;   // transcript → markdown analysis via claude/codex CLI (meetingAnalyze.js)
let micMonitorProc = null;    // native app-scoped mic-in-use monitor child process
let sysVolCache = null, sysVolAt = 0, sysVolBusy = false;   // throttled cache of the real system volume (0-100)
let lastRingEffect = LED_DEFAULT.effect; // remembered so the tray on/off toggle can restore the prior effect
let rotateRunning = false;               // screen-rotation runtime on/off (starts per settings on launch)
let rotationSuspended = false;           // temporarily held off by desktop-focus (a mapped app currently has focus)
let rotTimer = null;
let monitorMode = false;                 // monitor mode: panel UI hidden so the device shows the Windows desktop
// Global HA cache — registries + dashboards in memory, per-entity states populated on demand.
// `ok=false, ts=0` is the "never loaded" initial state. Refreshed on whenReady (if useHa) and on
// explicit Refresh from the Auth tab; no auto-refresh on settings save.
let haCache = { ok: false, ts: 0, error: null, dashboards: [], entities: [], areaRegistry: [], deviceRegistry: [], entityRegistry: [], floorRegistry: [], labelRegistry: [], states: {} };
let haRefreshInFlight = null;            // Promise — coalesces concurrent refresh requests
let touchDown = false, touchIdle = null; // monitor-mode touch -> OS mouse button state
let sysserver = null;                    // SystemView/Music local server (lazy-required in whenReady)
let serverPort = 0;                      // the local server's ephemeral port (for music-page routing)
let config = loadConfig();
let panelWin = null, configWin = null, tray = null;
let dashSession = null, cookieFlushT = null;   // dashboard webview session + a debounced cookie-store flush
const dev = new MultiKnob({ hid: HID });
let reservedRefreshTimer = null;
const reservedDisplay = createReservedDisplay({
  getDisplayState: reservedDisplayState,
  log: message => console.log('[reserved-display] ' + message),
});
// The Claude Code voice app = the generic voice-panel host (state/transcript/SSE/speech/STT-TTS,
// see voicepanel-host.js) driven by the Claude session adapter (CLI spawn, stream-json events,
// approval hook lifecycle -- see claudevoice-adapter.js). A second agent app (codex-voice) is a
// second host instance with its own adapter; the deps are shared closures over main.js state.
const claudeVoiceLog = message => console.log('[claude-voice] ' + message);
const claudeVoiceHost = createVoicePanelHost({
  appId: 'claude-voice',
  storageKey: 'claudeVoice',
  log: claudeVoiceLog,
  branding: {
    title: 'Claude Code',
    approvalTitle: '⚠ Claude wants to do something',
    turnFailedText: 'Turn failed to send — no project set, or claude CLI not found.',
  },
  adapter: createClaudeVoiceAdapter({
    getServerPort: () => serverPort,
    getUserDataPath: () => app.getPath('userData'),
    log: claudeVoiceLog,
  }),
  deps: voicePanelDeps('claude-voice'),
});
const codexVoiceLog = message => console.log('[codex-voice] ' + message);
const codexVoiceHost = createVoicePanelHost({
  appId: 'codex-voice',
  storageKey: 'codexVoice',
  log: codexVoiceLog,
  branding: {
    title: 'Codex',
    approvalTitle: '⚠ Codex wants to do something',
    turnFailedText: 'Turn failed to send — no folder set, or codex CLI not found.',
  },
  adapter: createCodexVoiceAdapter({ log: codexVoiceLog }),
  deps: voicePanelDeps('codex-voice'),
});
const copilotVoiceLog = message => console.log('[copilot-voice] ' + message);
const copilotVoiceHost = createVoicePanelHost({
  appId: 'copilot-voice',
  storageKey: 'copilotVoice',
  log: copilotVoiceLog,
  branding: {
    title: 'Copilot',
    approvalTitle: '⚠ Copilot wants to do something',
    turnFailedText: 'Turn failed to send — no folder set, or copilot CLI not found.',
  },
  adapter: createCopilotVoiceAdapter({ log: copilotVoiceLog }),
  deps: voicePanelDeps('copilot-voice'),
});
// Shared main.js plumbing for a voice-panel host. The ring guards are the two-app arbitration:
// only the ON-SCREEN voice app may drive (or clear) the ring override -- a background app's
// session finishing must never repaint the ring under the active page. (Page changes already
// clear any override via gotoGrid.)
function voicePanelDeps(appId) {
  return {
    activeServedAppConfig: id => activeServedAppConfig(id),
    activeGrid: () => activeGrid(),
    getConfig: () => config,
    saveConfig: () => saveConfig(),
    setRingState: state => { const g = activeGrid(); if (g && g.kind === 'app' && g.app === appId) setRingState(state); },
    clearRingOverride: () => { const g = activeGrid(); if (g && g.kind === 'app' && g.app === appId) clearRingOverride(); },
    getDocumentsPath: () => app.getPath('documents'),
  };
}
function appSettings() { return Object.assign({}, DEFAULT_SETTINGS, config.settings || {}); }
// ---- theme (global light/dark + accent, with per-card overrides) ----
function themeGlobal() { return Object.assign({}, THEME_DEFAULT, (config.settings || {}).theme || {}); }
function isValidHex(h) { return typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h); }
// Effective theme for a page: per-card override -> global -> system. Returns { dark, accent }.
function effectiveTheme(g) {
  const t = themeGlobal();
  let appearance = (g && g.appearance && g.appearance !== 'inherit') ? g.appearance : t.appearance;
  if (appearance !== 'light' && appearance !== 'dark') appearance = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const accent = (g && isValidHex(g.accent)) ? g.accent : (isValidHex(t.accent) ? t.accent : THEME_DEFAULT.accent);
  return { dark: appearance === 'dark', accent };
}
// Apply the global theme: drive the OS theme source (also sets prefers-color-scheme for web dashboards),
// repaint the panel chrome for the active page, and follow the accent on the knob ring (unless overridden).
function applyTheme() {
  const a = themeGlobal().appearance;
  try { nativeTheme.themeSource = (a === 'light' || a === 'dark') ? a : 'system'; } catch (e) {}
  pushTheme();
  applyKnobSettings();
}
// Theme payload: per-card light/dark + accent for the active page, PLUS the global light/dark so the
// panel's page-menu/intro overlays can stay in the user's chosen mode even on a per-card-overridden page.
function themePayload() { return Object.assign({}, effectiveTheme(activeGrid()), { globalDark: effectiveTheme(null).dark }); }
function pushTheme() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('theme', themePayload());
}
// hex -> {hue,sat} (0..255), value fixed full — matches the editor/DK-Suite ring conversion.
function hexToHsv255(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); if (!m) return null;
  const r = parseInt(m[1], 16) / 255, gg = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), d = mx - mn; let h = 0;
  if (d) { if (mx === r) h = ((gg - b) / d) % 6; else if (mx === gg) h = (b - r) / d + 2; else h = (r - gg) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { hue: Math.round((h / 360) * 255), sat: Math.round((mx ? d / mx : 0) * 255) };
}
// IPC hardening: only accept a channel from the window that legitimately owns it. The panel hosts a
// <webview> of arbitrary dashboard pages (its own separate webContents), so comparing against
// panelWin.webContents rejects any guest page — or stray sender — that reaches the preload bridge.
function isFrom(e, win) { return !!(win && !win.isDestroyed() && e.sender === win.webContents); }

// User config lives in the OS user-data dir (writable even inside a packaged app). On first run it's
// seeded from a previous dev config (app/config.json) if present, otherwise the bundled default.
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      firstRun = true;
      fs.mkdirSync(USER_DIR, { recursive: true });
      const seed = fs.existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH : DEFAULT_CONFIG_PATH;
      if (fs.existsSync(seed)) fs.copyFileSync(seed, CONFIG_PATH);
    }
    return migrateConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) { console.log('config load error:', e.message); return { activeGridId: null, grids: [] }; }
}
// Normalize dashboard auth: fold the old per-page `haToken` into the typed `auth` object.
function migrateConfig(c) {
  (c.grids || []).forEach(g => {
    if (g.kind === 'web') {
      if (!g.auth) g.auth = g.haToken ? { type: 'ha', token: g.haToken } : { type: 'none' };
      delete g.haToken;
    }
    if (g.kind === 'app' && g.app === 'office' && g.options) {
      for (let index = 1; index <= 4; index += 1) {
        for (const suffix of ['Label', 'Keys']) {
          const legacyKey = 'shortcut' + index + suffix;
          const appKey = 'app1Shortcut' + index + suffix;
          if (!(appKey in g.options) && legacyKey in g.options) g.options[appKey] = g.options[legacyKey];
          delete g.options[legacyKey];
        }
      }
    }
  });
  return c;
}
// SystemView is a built-in localhost dashboard. Ensure the page exists and its url points at the
// current (ephemeral) server port. Respect deletion: once injected, if the user removes it we don't
// re-add it (tracked via config.sysviewInjected) — so deleting it sticks.
function ensureSystemViewPage(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (!config.grids) config.grids = [];
  const existing = config.grids.find(g => g.id === 'sysview');
  if (existing) {                                          // keep the user's name/rotate; just refresh the (dynamic) port
    if (existing.url !== url) { existing.url = url; saveConfig(); if (config.activeGridId === 'sysview') pushToPanel(); }
    return;
  }
  if (config.sysviewInjected) return;                      // user deleted it on purpose — leave it gone
  config.grids.push({ id: 'sysview', name: 'System Monitor', kind: 'web', url, auth: { type: 'none' }, rotate: false });
  config.sysviewInjected = true;
  saveConfig();
}
// The Music controller is a built-in APP page (kind:'app', app:'music'). Its launcher grid is now the
// optional native button strip (like the clock apps): gridOn + gridAlign 'right' (the strip is always on
// the far right, with album art on the far left). Ensure one exists on first run; respect deletion (musicInjected).
const MUSIC_DEFAULT_TILES = [
  { label: 'Spotify', icon: '🎵', type: 'url', value: 'https://open.spotify.com' },
  { label: 'YT Music', icon: '📺', type: 'url', value: 'https://music.youtube.com' },
  { label: 'Apple Music', icon: '🍎', type: 'url', value: 'https://music.apple.com' },
  { label: 'Tidal', icon: '🌊', type: 'url', value: 'https://listen.tidal.com' },
];
function ensureMusicPage() {
  if (!config.grids) config.grids = [];
  let g = config.grids.find(x => x.id === 'music');
  if (!g) {
    if (config.musicInjected) return;                      // user deleted it on purpose — leave it gone
    g = { id: 'music' }; config.grids.push(g); config.musicInjected = true;
  }
  g.name = g.name || 'Music';
  g.kind = 'app'; g.app = 'music';                         // (re)assert the app shape; migrates the old web-page form
  delete g.url; delete g.auth;
  if (typeof g.cols !== 'number') g.cols = 2;
  if (typeof g.rows !== 'number') g.rows = 2;
  if (!Array.isArray(g.tiles) || !g.tiles.length) g.tiles = MUSIC_DEFAULT_TILES.map(t => Object.assign({}, t));
  if (typeof g.gridOn !== 'boolean') g.gridOn = true;      // migrate the old always-on built-in grid to the toggleable strip
  g.gridAlign = 'right';                                   // music grid is always far right (album art is far left)
  saveConfig();
}
// An app's embedded grid (Music, Agenda, Events, …) is served to the page (resolved icons) and its taps
// launched — generic across any app that defines a grid, keyed to whichever app page is currently shown.
async function getActiveAppTiles() {
  const g = activeGrid();
  if (!(g && g.kind === 'app' && Array.isArray(g.tiles) && g.cols && g.rows)) return { cols: 2, rows: 2, tiles: [] };
  const resolved = await resolveGridIcons(Object.assign({}, g, { kind: 'grid' }));   // resolve icons (force the tile path)
  return { cols: g.cols, rows: g.rows, tiles: resolved.tiles || [] };
}
function onAppLaunch(i) {
  const g = activeGrid();
  if (g && g.kind === 'app' && g.tiles && g.tiles[i]) { runAction(g.tiles[i]); return true; }
  return false;
}
function hostMatches(a, b) { try { return new URL(a).host === new URL(b).host; } catch (e) { return false; } }
function allowedExternalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  } catch (e) {
    return null;
  }
}
function openExternalUrl(value) {
  const url = allowedExternalUrl(value);
  if (!url) return false;
  shell.openExternal(url).catch(e => console.log('openExternal error:', e.message));
  return true;
}
function trustedMediaOrigins() {
  const raw = appSettings().trustedMediaOrigins;
  if (!Array.isArray(raw)) return [];
  return raw.map(origin => {
    try { return new URL(origin).origin; } catch (e) { return null; }
  }).filter(Boolean);
}
function isLocalAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === serverPort;
  } catch (e) {
    return false;
  }
}
function isTrustedMediaRequest(wc, details) {
  const requestingUrl = (details && (details.requestingUrl || details.securityOrigin)) || (wc && wc.getURL && wc.getURL()) || '';
  // Reject an explicit video-only ask (non-empty mediaTypes without audio). getDisplayMedia's
  // system-audio loopback request arrives with mediaTypes [] — that must fall through to the
  // origin trust check below, not be rejected here, or the meeting recorder gets no loopback.
  if (details && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && !details.mediaTypes.includes('audio')) return false;
  if (isLocalAppUrl(requestingUrl)) return true;
  try { return trustedMediaOrigins().includes(new URL(requestingUrl).origin); }
  catch (e) { return false; }
}
function handleDashboardPermissionRequest(wc, permission, cb, details) {
  if (permission === 'media' && isTrustedMediaRequest(wc, details)) return cb(true);
  // setSinkId() -- the speaker picker in the Claude Voice settings -- needs this one; same trust
  // gate as the mic (our own served pages, or an explicitly trusted dashboard origin).
  if (permission === 'speaker-selection' && isTrustedMediaRequest(wc, details)) return cb(true);
  return cb(false);
}

const SAFE_APP_ID = /^[a-z0-9][a-z0-9_-]*$/;
const appManifestWarnings = new Set();
function warnAppManifest(key, message) {
  if (appManifestWarnings.has(key)) return;
  appManifestWarnings.add(key);
  console.log(message);
}
function safeAppEntry(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const rel = value.trim().replace(/\\/g, '/');
  if (rel.includes('..') || rel.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rel) || path.isAbsolute(rel)) return null;
  return rel;
}
function appEntryUrlPath(entry) { return String(entry || '').split('/').map(encodeURIComponent).join('/'); }
function readLegacyApps() {
  try {
    const apps = JSON.parse(fs.readFileSync(path.join(APPS_DIR, 'apps.json'), 'utf8'));
    return Array.isArray(apps) ? apps : [];
  } catch (e) { console.log('apps manifest load error:', e.message); return []; }
}
function readFolderAppManifest(appDir) {
  for (const name of ['app.json', 'manifest.json']) {
    const manifestPath = path.join(appDir, name);
    try {
      if (fs.existsSync(manifestPath)) return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      warnAppManifest('parse:' + manifestPath, 'app manifest load error: ' + manifestPath + ' - ' + e.message);
      return null;
    }
  }
  return null;
}
// User-data drop-in apps folder (survives app updates, unlike the install dir). Location is a setting:
// %APPDATA%\open-quake\apps (default) or %LOCALAPPDATA%\open-quake\apps. This is where the manager imports to.
function dropInDir() {
  const useLocal = (config.settings && config.settings.dropInLocation) === 'localappdata';
  const base = (useLocal ? process.env.LOCALAPPDATA : process.env.APPDATA) || process.env.APPDATA || process.env.LOCALAPPDATA || USER_DIR;
  return path.join(base, 'open-quake', 'apps');
}
function ensureDropInDir() { const d = dropInDir(); try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} return d; }
// Scan one base dir for drop-in app folders, adding valid ones to apps/ids/servedApps (dedup by id, first wins).
function scanAppDir(baseDir, apps, ids, servedApps) {
  let entries = [];
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (e) { return; }
  entries.filter(d => d.isDirectory()).forEach(d => {
    const appDir = path.join(baseDir, d.name);
    const manifest = readFolderAppManifest(appDir);
    if (!manifest) return;
    const id = typeof manifest.id === 'string' ? manifest.id.trim() : '';
    if (!SAFE_APP_ID.test(id)) { warnAppManifest('id:' + appDir, 'skipping app folder with invalid id: ' + appDir); return; }
    const entry = safeAppEntry(manifest.entry || manifest.file);
    if (!entry) { warnAppManifest('entry:' + appDir, 'skipping app folder with invalid entry: ' + id); return; }
    if (ids.has(id)) { warnAppManifest('dup:' + id, 'skipping duplicate app id: ' + id); return; }
    const serverEntry = safeAppEntry(manifest.server);
    const def = Object.assign({}, manifest, {
      id, name: manifest.name || id, file: entry, entry, server: serverEntry || undefined,
      served: !!manifest.served, options: Array.isArray(manifest.options) ? manifest.options : [],
      _folder: true, _dir: appDir,
    });
    apps.push(def);
    ids.add(id);
    if (def.served) servedApps[id] = { root: appDir, proxy: manifest.proxy || null, server: serverEntry ? path.join(appDir, serverEntry) : null };
  });
}
function appCatalog() {
  const apps = readLegacyApps();
  const ids = new Set(apps.map(a => a && a.id).filter(Boolean));
  const servedApps = {};
  // Drop-in apps live ONLY in the user-data folder (%APPDATA%/%LOCALAPPDATA%) so they survive
  // app updates — we deliberately do NOT scan the bundled install dir for drop-in folders.
  scanAppDir(dropInDir(), apps, ids, servedApps);
  return { apps, servedApps };
}
// Bundled local apps (apps/apps.json) plus drop-in app folders (user-data dir only).
function loadApps() { return appCatalog().apps; }
function discoveredServedApps() { return appCatalog().servedApps; }

// ---- drop-in app manager (Settings → Drop-In Apps): list / import (zip) / export (zip) / delete ----
// Zip via Windows' built-in Expand-Archive / Compress-Archive (no extra dependency). Windows-only.
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function runPwsh(cmd) {
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 60000 }, err => resolve(!err)));
}
function manifestPath(dir) { for (const n of ['app.json', 'manifest.json']) { const p = path.join(dir, n); try { if (fs.existsSync(p)) return p; } catch (e) {} } return null; }
// Find the app root in an extracted zip: the dir itself, or a single subdir, that holds a manifest.
function findAppRoot(dir) {
  if (manifestPath(dir)) return dir;
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name)); } catch (e) {}
  for (const s of subs) if (manifestPath(s)) return s;
  return null;
}
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, d.name), t = path.join(dest, d.name);
    if (d.isDirectory()) copyDirSync(s, t); else fs.copyFileSync(s, t);
  }
}
function listDropInApps() {
  const base = path.resolve(dropInDir());
  return appCatalog().apps.filter(a => a._folder).map(a => ({
    id: a.id, name: a.name, served: !!a.served, hasServer: !!a.server,
    managed: !!(a._dir && path.resolve(a._dir).startsWith(base)),   // only user-data apps can be deleted/exported
  }));
}
function folderAppDir(id) { const def = appCatalog().apps.find(a => a._folder && a.id === id); return def ? def._dir : null; }
// Import a .zip. On an app-id conflict, return { conflict, id } so the editor can prompt for a new id and retry with forceId.
// Risky bundled files that execute on the host (a drop-in app's `server` Node module is checked separately).
// Client-side .js runs sandboxed in the webview, so it's NOT flagged here.
const RISKY_EXT = new Set(['.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.wsf', '.wsh', '.jar', '.sh', '.cpl']);
function folderHasExecutable(dir) {
  let found = false;
  (function walk(d) {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (found) return;
      if (ent.isDirectory()) walk(path.join(d, ent.name));
      else if (RISKY_EXT.has(path.extname(ent.name).toLowerCase())) found = true;
    }
  })(dir);
  return found;
}
async function importDropInApp(zipPath, forceId, confirmExec) {
  if (typeof zipPath !== 'string' || !fs.existsSync(zipPath)) return { ok: false, error: 'file not found' };
  const tmp = path.join(USER_DIR, 'import-tmp-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    if (!await runPwsh(`Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(tmp)} -Force`)) return { ok: false, error: 'could not unzip' };
    const appRoot = findAppRoot(tmp);
    if (!appRoot) return { ok: false, error: 'no app.json / manifest.json found in the zip' };
    const mp = manifestPath(appRoot);
    let manifest; try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e) { return { ok: false, error: 'the manifest is not valid JSON' }; }
    const id0 = (manifest && typeof manifest.id === 'string') ? manifest.id.trim() : '';
    // #8: warn before installing anything that runs host code (a server module or bundled binaries/scripts).
    if (!confirmExec && (safeAppEntry(manifest.server) || folderHasExecutable(appRoot))) {
      return { ok: false, warnExec: true, id: id0, server: !!safeAppEntry(manifest.server) };
    }
    const finalId = ((forceId || id0) || '').trim();
    if (!SAFE_APP_ID.test(finalId)) return { ok: false, error: 'invalid app id (use lowercase letters, digits, _ or -)' };
    const taken = new Set(appCatalog().apps.map(a => a.id));
    const destDir = path.join(dropInDir(), finalId);
    if (taken.has(finalId) || fs.existsSync(destDir)) {
      return forceId ? { ok: false, error: 'the id "' + finalId + '" is also taken' } : { ok: false, conflict: true, id: id0 || finalId };
    }
    if (finalId !== id0) { manifest.id = finalId; try { fs.writeFileSync(mp, JSON.stringify(manifest, null, 2)); } catch (e) { return { ok: false, error: 'could not rewrite the manifest id' }; } }
    ensureDropInDir();
    try { fs.renameSync(appRoot, destDir); } catch (e) { copyDirSync(appRoot, destDir); }
    return { ok: true, id: finalId, name: manifest.name || finalId };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
}
async function exportDropInApp(id) {
  const dir = folderAppDir(id);
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'app not found' };
  const r = await dialog.showSaveDialog(configWin, { defaultPath: id + '.zip', filters: [{ name: 'Zip', extensions: ['zip'] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const ok = await runPwsh(`Compress-Archive -Path ${psQuote(dir)} -DestinationPath ${psQuote(r.filePath)} -Force`);
  return ok ? { ok: true, path: r.filePath } : { ok: false, error: 'could not create the zip' };
}
function deleteDropInApp(id) {
  const dir = folderAppDir(id);
  if (!dir) return { ok: false, error: 'app not found' };
  const base = path.resolve(dropInDir());
  if (!path.resolve(dir).startsWith(base + path.sep)) return { ok: false, error: 'only user-installed drop-in apps can be deleted here' };
  try { fs.rmSync(path.resolve(dir), { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
// Secret-at-rest store: encrypts the secret-typed config fields (dashboard tokens / Basic passwords /
// custom header values / app secret options) in config.json. On Windows the backend is raw DPAPI
// (app/dpapi.js) — Electron safeStorage's Chromium key layer lost its key across launches here,
// orphaning stored secrets (2026-07-03); safeStorage remains the backend elsewhere and the decrypt
// path for legacy v1 values. The in-memory `config` stays plaintext; encryption happens only at the
// disk boundary (saveConfig). safeStorage needs app-ready, so decryptConfig runs as the first thing
// in whenReady, not at module load.
const secretStore = createSecretStore({
  safeStorage,
  dpapi: process.platform === 'win32' ? require('./dpapi') : null,
  loadApps,
  log: m => console.log(m),
});
const oauthStorage = new TokenStorage({ getConfig: () => config, saveConfig });
const oauthHandler = new OAuthHandler({ storage: oauthStorage, openExternal: openExternalUrl, log: m => console.log(m) });
const officeGraph = createOfficeGraph({
  getAccessToken: (provider, scopes) => oauthHandler.getValidAccessToken(provider, scopes),
  connectOAuth: (provider, scopes) => oauthHandler.connect(provider, scopes),
});
const officeActions = createOfficeActions({
  getOptions: () => {
    const active = activeServedAppConfig('office');
    return active ? active.options : {};
  },
  launchApp: value => actionRunner.launchApp(value, actionDeps),
  openExternal: async value => {
    // Teams desktop: `start ms-teams:` (via cmd, exactly as a Shell-command tile runs it) is the
    // invocation that reliably restores a CLOSED new-Teams window from the tray. shell.openExternal
    // and `start "" ms-teams:` (empty title) do NOT — they leave the window hidden. User-validated.
    if (value.startsWith('ms-teams:') || value.startsWith('msteams:')) {
      return new Promise(resolve => {
        exec('start ' + value, { windowsHide: true }, err => {
          if (err) console.log('Teams launch error:', err.message);
          resolve(!err);
        });
      });
    }
    return openExternalUrl(value);
  },
  focusTeams: () => meetingControl.focusTeamsWindow(),
  focusApp: names => meetingControl.focusProcessWindow(names),
  hasAppWindow: names => meetingControl.hasProcessWindow(names),
  tapCombo: combo => mediaKeys.tapCombo(combo),
  fs,
});

// Build the file: URL for an app page, encoding its options as a #hash (file:// drops a ?query).
function appOptionQuery(def, opts, include) {
  return (def.options || []).map(o => {
    if (include && !include(o)) return null;
    let v = (o.key in opts) ? opts[o.key] : o.default;
    if (v == null || v === '') return null;
    if (o.type === 'bool') v = v ? '1' : '0';
    return encodeURIComponent(o.key) + '=' + encodeURIComponent(v);
  }).filter(Boolean).join('&');
}
// Theme params every app page receives (effective light/dark + accent for that card).
function themeParams(page) {
  const t = effectiveTheme(page);
  return '_dark=' + (t.dark ? '1' : '0') + '&_accent=' + encodeURIComponent(t.accent);
}
function appPageUrl(page) {
  const def = loadApps().find(a => a.id === page.app);
  if (!def) return 'about:blank';
  if (def.served) {                                                          // served by the local server (live data, same-origin fetch, grid launch)
    const opts = page.options || {};                                         // non-secret options only; secrets are served by /app-config
    const qs = [appOptionQuery(def, opts, o => o.type !== 'secret' && !o.serverOnly), themeParams(page)].filter(Boolean).join('&');
    if (def._folder) return 'http://127.0.0.1:' + serverPort + '/apps/' + encodeURIComponent(def.id) + '/' + appEntryUrlPath(def.entry || def.file) + (qs ? '?' + qs : '');
    const capability = def.id === 'office' && sysserver ? sysserver.issueOfficeCapability() : '';
    return 'http://127.0.0.1:' + serverPort + '/' + def.id + (qs ? '?' + qs : '') + (capability ? '#_cap=' + encodeURIComponent(capability) : '');
  }
  const file = def._folder ? path.join(def._dir, def.entry || def.file) : path.join(APPS_DIR, def.file);
  const opts = page.options || {};
  const gridHint = page.gridOn ? '_grid=1' : '';   // lets the page (e.g. a clock) make room for the native button strip
  const hash = [appOptionQuery(def, opts, o => o.type !== 'secret' && !o.serverOnly), themeParams(page), gridHint].filter(Boolean).join('&');
  return pathToFileURL(file).href + (hash ? '#' + hash : '');
}
function activeServedAppConfig(appId) {
  const g = activeGrid();
  if (!(g && g.kind === 'app' && g.app === appId)) return null;
  const def = loadApps().find(a => a.id === appId);
  if (!(def && def.served)) return null;
  const opts = g.options || {};
  const options = {};
  (def.options || []).forEach(o => {
    // Office shortcut defaults depend on the app chosen for that header slot. When a key has
    // never been saved, leave it absent so both renderer and host action code can select the
    // chosen app's defaults instead of the manifest's original Teams/Outlook/Word/Excel values.
    if (appId === 'office' && /^app[1-4]Shortcut[1-8](IconImage|Icon|Label|Keys)$/.test(o.key) && !(o.key in opts)) return;
    let v = (o.key in opts) ? opts[o.key] : o.default;
    if (o.type === 'bool') v = !!v;
    if (appId === 'office' && /^app[1-4]Shortcut[1-8]IconImage$/.test(o.key)) {
      options[o.key] = '';
      options[o.key + 'Src'] = officeShortcutImageDataUrl(v, fs) || '';
      return;
    }
    options[o.key] = v == null ? '' : v;
  });
  return { app: appId, options };
}
// Persist config with secret fields encrypted at rest. encryptConfig clones, so the in-memory
// `config` keeps its plaintext secrets — consumers (renderer HA token, Basic/header auth, served
// app config) read the live plaintext. Encryption is fail-closed: the existing file is left intact.
function saveConfig() {
  const temporaryPath = CONFIG_PATH + '.tmp';
  try {
    const serialized = JSON.stringify(secretStore.encryptConfig(config), null, 2);
    fs.writeFileSync(temporaryPath, serialized);
    fs.renameSync(temporaryPath, CONFIG_PATH);
    return true;
  } catch (e) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (cleanupError) {}
    console.log('config save error: secure persistence failed');
    return false;
  }
}
function activeGrid() { return config.grids.find(g => g.id === config.activeGridId) || config.grids[0] || { cols: 8, rows: 2, tiles: [] }; }
function gridList() { return config.grids.filter(g => !g.hidden).map(g => ({ id: g.id, name: g.name })); }
// Tell the local server which served page is on screen so it runs only that page's poller
// (SystemView metrics / Music now-playing) and idles the rest — no background polling while hidden.
function syncPollers(g) {
  if (!sysserver) return;
  const which = monitorMode ? null                                  // panel hidden (monitor mode) -> idle every page poller
    : (g && g.id === 'sysview') ? 'sysview'
    : (g && g.kind === 'app' && g.app === 'music') ? 'music'
    : (g && g.kind === 'app' && g.app === 'office') ? 'office'
    : null;
  try { sysserver.setActivePage(which); } catch (e) {}
  // HA-backed dev apps (HA Schedule / Agenda / Events): poll HA only while one is shown, at the page's
  // chosen interval (default 10 min). They share one snapshot, so any of them drives the same poll.
  try {
    if (!monitorMode && g && g.kind === 'app' && HA_SCHEDULE_APPS.includes(g.app)) haschedule.start((parseInt((g.options || {}).interval, 10) || 600) * 1000);
    else haschedule.stop();
  } catch (e) {}
}
// Resolve HA creds for the dev apps (HA Schedule / Agenda / Events) from Settings → Auth.
// Idempotent — safe to call on every settings save. Empty url/token leaves the poller idle and
// the dev apps render their "missing HA URL / token" placeholder.
function configureHaSchedule() {
  const ha = (config.settings && config.settings.haAuth) || {};
  haschedule.configure({ url: ha.url || '', token: ha.token || '' });
  return ha.url || '';
}

function oauthProviderPayload() {
  return Object.keys(oauthProviders).map(id => {
    const p = oauthProviders[id];
    const settings = oauthStorage.getProviderSettings(id);
    return Object.assign({}, oauthHandler.status(id), {
      name: p.name,
      scopes: p.suggestedScopes || p.scopes,
      managedClient: !!p.clientId,
      hasClientSecret: !!settings.clientSecret,
      enabled: id === 'microsoft',
    });
  });
}

async function pushToPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    const g = activeGrid();
    syncPollers(g);                                                // run only the poller the shown page needs (before the webview reloads, so it primes)
    panelWin.webContents.send('theme', themePayload());            // light/dark + accent for this page (chrome paints before the grid renders)
    panelWin.webContents.send('grid', await resolveGridIcons(g));
    panelWin.webContents.send('gridList', { grids: gridList(), activeId: config.activeGridId });
    pushRotationState();
    if (!config.introShown) panelWin.webContents.send('intro');   // one-time "double-click the knob" overlay
  }
}

// Read a local image file into a data: URL so it renders in ANY panel page — including the http-served
// app pages (Music), which (unlike the native grid) cannot load file:// images.
function imageFileToDataUrl(p) {
  try {
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'ico' ? 'image/x-icon' : 'image/' + (ext || 'png');
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) { return null; }
}

// Detect the real image format from the file's magic bytes. Servers sometimes mislabel content-type
// (e.g. clipartmax serves a JPEG as image/png), so we trust the bytes — the cached file needs the TRUE
// extension because imageFileToDataUrl derives the data-URL mime from the extension at render time.
function imageInfoFromBytes(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { mime: 'image/webp', ext: 'webp' };
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) return { mime: 'image/bmp', ext: 'bmp' };
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return { mime: 'image/x-icon', ext: 'ico' };
  if (buf.slice(0, 512).toString('utf8').toLowerCase().includes('<svg')) return { mime: 'image/svg+xml', ext: 'svg' };
  return null;
}

// Download an image URL into the on-disk icon cache and return its local path. For URL tile icons:
// the file is then rendered through the SAME file->data:URL path as local images, so it works offline
// and in the http-served grids. Guardrails: http(s) only, real image bytes only, size-capped.
// Uses net.request (not net.fetch) so we can set a User-Agent — some hosts (e.g. Wikimedia) 403 without one.
const ICON_CACHE_DIR = path.join(USER_DIR, 'iconcache');
const ICON_MAX_BYTES = 3 * 1024 * 1024;
function fetchIconToCache(url) {
  url = (url || '').trim();
  return new Promise(resolve => {
    if (!/^https?:\/\//i.test(url)) return resolve({ ok: false, error: 'Only http(s) URLs are allowed.' });
    let req;
    try { req = net.request({ url, redirect: 'follow' }); }
    catch (e) { return resolve({ ok: false, error: 'That URL is not valid.' }); }
    req.setHeader('User-Agent', 'open-quake/' + app.getVersion() + ' (+https://github.com/TeeJS/open-quake)');
    req.setHeader('Accept', 'image/*');
    let done = false;
    const fail = msg => { if (done) return; done = true; try { req.abort(); } catch (e) {} resolve({ ok: false, error: msg }); };
    req.on('error', () => fail('Could not reach that URL.'));
    req.on('response', resp => {
      const status = resp.statusCode;
      if (status < 200 || status >= 300) { resp.resume(); return fail('Server returned HTTP ' + status + '.'); }
      const raw = resp.headers['content-type'];
      const ctype = String(Array.isArray(raw) ? raw[0] : (raw || '')).split(';')[0].trim().toLowerCase();
      // Reject obvious non-images on the header (avoid downloading an HTML page); allow image/*,
      // octet-stream, or a missing type — then confirm by sniffing the actual bytes below.
      if (ctype && !ctype.startsWith('image/') && ctype !== 'application/octet-stream') { resp.resume(); return fail('That URL is not an image (' + ctype + ').'); }
      const chunks = []; let total = 0;
      resp.on('data', d => { total += d.length; if (total > ICON_MAX_BYTES) return fail('Image is too large (over 3 MB).'); chunks.push(d); });
      resp.on('error', () => fail('Error reading the image.'));
      resp.on('end', () => {
        if (done) return; done = true;
        const buf = Buffer.concat(chunks);
        if (!buf.length) return resolve({ ok: false, error: 'The image was empty.' });
        const info = imageInfoFromBytes(buf);   // trust the real bytes over the (sometimes wrong) content-type header
        if (!info && !ctype.startsWith('image/')) return resolve({ ok: false, error: "That URL doesn't appear to be an image." });
        const mime = info ? info.mime : ctype;
        const ext = info ? info.ext : (ctype === 'image/jpeg' ? 'jpg' : ctype === 'image/svg+xml' ? 'svg' : (ctype === 'image/x-icon' || ctype === 'image/vnd.microsoft.icon') ? 'ico' : (ctype.slice(6).replace(/[^a-z0-9]/g, '') || 'png'));
        try { fs.mkdirSync(ICON_CACHE_DIR, { recursive: true }); } catch (e) {}
        const file = path.join(ICON_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.' + ext);
        try { fs.writeFileSync(file, buf); } catch (e) { return resolve({ ok: false, error: 'Could not save the icon to the cache.' }); }
        resolve({ ok: true, cachePath: file, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') });
      });
    });
    req.end();
  });
}

// On launch, delete cached URL-icon files that no tile references any more (orphaned when a tile's URL
// changed, the tile was deleted, or its icon type switched away from 'url'). Keyed by filename
// (sha1(url)), so a cache file shared by several tiles with the same URL is kept while ANY tile uses it.
function sweepIconCache() {
  let files;
  try { files = fs.readdirSync(ICON_CACHE_DIR); } catch (e) { return; }   // no cache dir yet -> nothing to sweep
  const used = new Set();
  for (const g of (config.grids || [])) for (const t of (g.tiles || [])) {
    if (t && (t.iconType === 'url' || t.iconType === 'ha') && t.iconCache) used.add(path.basename(t.iconCache));
  }
  let removed = 0;
  for (const f of files) { if (!used.has(f)) { try { fs.unlinkSync(path.join(ICON_CACHE_DIR, f)); removed++; } catch (e) {} } }
  if (removed) console.log('icon cache: removed ' + removed + ' orphaned file(s)');
}
// HA's frontend domain-default MDI icons (mirror of FIXED_DOMAIN_ICONS in
// home-assistant/frontend/src/common/const.ts). When an entity has no explicit icon override,
// the editor and the panel both use this to pick the same glyph HA would have drawn.
const HA_DOMAIN_DEFAULT_MDI = {
  air_quality: 'air-filter', alert: 'alert', automation: 'robot',
  calendar: 'calendar', camera: 'video', climate: 'thermostat',
  configurator: 'cog', conversation: 'microphone-message', counter: 'counter',
  date: 'calendar', datetime: 'calendar-clock', demo: 'home-assistant',
  google_assistant: 'google-assistant', group: 'google-circles-communities',
  homeassistant: 'home-assistant', homekit: 'home-automation',
  image_processing: 'image-filter-frames', image: 'image',
  input_boolean: 'toggle-switch-variant', input_button: 'button-pointer',
  input_datetime: 'calendar-clock', input_number: 'ray-vertex',
  input_select: 'format-list-bulleted', input_text: 'form-textbox',
  lawn_mower: 'robot-mower', light: 'lightbulb', mailbox: 'mailbox',
  notify: 'comment-alert', number: 'ray-vertex',
  persistent_notification: 'bell', person: 'account', plant: 'flower',
  proximity: 'apple-safari', remote: 'remote',
  scene: 'palette', schedule: 'calendar-clock', script: 'script-text',
  select: 'format-list-bulleted', sensor: 'eye', binary_sensor: 'eye',
  simple_alarm: 'bell', siren: 'bullhorn', stt: 'microphone-message',
  sun: 'white-balance-sunny', switch: 'toggle-switch-variant',
  text: 'form-textbox', time: 'clock', timer: 'timer-outline',
  todo: 'clipboard-list', tts: 'speaker-message', vacuum: 'robot-vacuum',
  wake_word: 'chat-sleep', weather: 'weather-partly-cloudy', zone: 'map-marker-radius',
  cover: 'window-shutter', lock: 'lock', fan: 'fan',
  media_player: 'cast', alarm_control_panel: 'shield', water_heater: 'water-pump',
  device_tracker: 'crosshairs-gps',
};
// Strip the "mdi:" prefix and return just the icon name (or null if not a valid mdi reference).
function bareMdi(name) {
  if (typeof name !== 'string') return null;
  const m = /^mdi:([a-z0-9-]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : null;
}
// Pick the MDI icon name an entity should render with: explicit registry override > domain default.
// State.attributes.icon would be a third source but main keeps states sparse (lazy), so we don't
// rely on it here -- editor pre-warms states for tiles the user is editing.
function haEntityMdi(entityId) {
  if (haCache && Array.isArray(haCache.entityRegistry)) {
    const reg = haCache.entityRegistry.find(r => r.entity_id === entityId);
    const bare = bareMdi(reg && reg.icon);
    if (bare) return bare;
  }
  return HA_DOMAIN_DEFAULT_MDI[(entityId || '').split('.')[0] || ''] || null;
}

const MDI_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mdi/svg@7/svg/';
const MDI_MAX_BYTES = 200 * 1024;
const mdiInFlight = {};   // bareName -> Promise (coalesces concurrent fetches of the same icon)
// Download an MDI icon's SVG from jsDelivr, recolor it white so it renders on the dark panel and
// editor backgrounds, cache it in the icon-cache dir keyed by name. Idempotent: returns the
// cached file if already present. The recolor injects fill="#ffffff" onto the root <svg> element
// so child paths without explicit fill inherit it (which is how every MDI icon is shaped).
function fetchMdiToCache(name) {
  const bare = bareMdi('mdi:' + (name || '')) || bareMdi(name);
  if (!bare) return Promise.resolve({ ok: false, error: 'invalid mdi name' });
  const file = path.join(ICON_CACHE_DIR, 'mdi-' + bare + '.svg');
  try { if (fs.existsSync(file)) return Promise.resolve({ ok: true, cachePath: file, dataUrl: 'data:image/svg+xml;base64,' + fs.readFileSync(file).toString('base64') }); }
  catch (e) {}
  if (mdiInFlight[bare]) return mdiInFlight[bare];
  const url = MDI_CDN_BASE + bare + '.svg';
  mdiInFlight[bare] = new Promise(resolve => {
    let req;
    try { req = net.request({ url, redirect: 'follow' }); }
    catch (e) { delete mdiInFlight[bare]; return resolve({ ok: false, error: 'invalid url' }); }
    req.setHeader('User-Agent', 'open-quake/' + app.getVersion());
    req.setHeader('Accept', 'image/svg+xml');
    let done = false;
    const finish = result => { if (done) return; done = true; delete mdiInFlight[bare]; resolve(result); };
    req.on('error', () => finish({ ok: false, error: 'CDN unreachable' }));
    req.on('response', resp => {
      if (resp.statusCode !== 200) { resp.resume(); return finish({ ok: false, error: 'CDN ' + resp.statusCode }); }
      const chunks = []; let total = 0;
      resp.on('data', d => { total += d.length; if (total > MDI_MAX_BYTES) { try { req.abort(); } catch (e) {} return finish({ ok: false, error: 'svg too large' }); } chunks.push(d); });
      resp.on('end', () => {
        if (done) return;
        const svg = Buffer.concat(chunks).toString('utf8');
        if (!/<svg\b/i.test(svg)) return finish({ ok: false, error: 'not an svg' });
        const recolored = svg.replace(/<svg\b/i, '<svg fill="#ffffff"');
        try { fs.mkdirSync(ICON_CACHE_DIR, { recursive: true }); } catch (e) {}
        try { fs.writeFileSync(file, recolored, 'utf8'); }
        catch (e) { return finish({ ok: false, error: 'cache write failed' }); }
        finish({ ok: true, cachePath: file, dataUrl: 'data:image/svg+xml;base64,' + Buffer.from(recolored).toString('base64') });
      });
    });
    req.end();
  });
  return mdiInFlight[bare];
}

// Emoji approximations for the most common Home Assistant MDI icon names + per-domain fallbacks.
// Used ONLY as a last-resort when the CDN is unreachable or returns a non-svg. The actual icon is
// the real MDI SVG fetched + recolored via fetchMdiToCache; this is just so a tile never renders
// blank if jsDelivr is down. Pattern matching is exact-or-hyphenated (so "mdi:lockable" never
// falsely matches "mdi:lock"), order is most-specific first.
const HA_MDI_EMOJI = [
  ['mdi:weather-sunny', '☀️'], ['mdi:weather-cloudy', '☁️'], ['mdi:weather-rainy', '🌧️'],
  ['mdi:weather-pouring', '🌧️'], ['mdi:weather-snowy', '❄️'], ['mdi:weather-night', '🌙'],
  ['mdi:lock-open', '🔓'], ['mdi:robot-vacuum', '🧹'], ['mdi:motion-sensor', '🚶'],
  ['mdi:smoke-detector', '🔥'], ['mdi:water-pump', '💧'], ['mdi:garage-open', '🚗'],
  ['mdi:weather', '⛅'], ['mdi:lightbulb', '💡'], ['mdi:lamp', '💡'], ['mdi:bulb', '💡'],
  ['mdi:lock', '🔒'], ['mdi:speaker', '🔊'], ['mdi:volume', '🔊'],
  ['mdi:thermometer', '🌡️'], ['mdi:thermostat', '🌡️'], ['mdi:fan', '🌀'],
  ['mdi:tv', '📺'], ['mdi:television', '📺'], ['mdi:music', '🎵'], ['mdi:play', '▶️'],
  ['mdi:cctv', '📷'], ['mdi:camera', '📷'], ['mdi:garage', '🚗'], ['mdi:car', '🚗'],
  ['mdi:bike', '🚲'], ['mdi:door', '🚪'], ['mdi:fridge', '🧊'], ['mdi:refrigerator', '🧊'],
  ['mdi:battery', '🔋'], ['mdi:vacuum', '🧹'], ['mdi:window', '🪟'],
  ['mdi:blinds', '🪟'], ['mdi:curtains', '🪟'], ['mdi:alarm', '🚨'],
  ['mdi:doorbell', '🔔'], ['mdi:bell', '🔔'], ['mdi:human', '👤'],
  ['mdi:account', '👤'], ['mdi:person', '👤'], ['mdi:home', '🏠'], ['mdi:eye', '👁️'],
  ['mdi:fire', '🔥'], ['mdi:smoke', '🔥'], ['mdi:leak', '💧'], ['mdi:flood', '💧'],
  ['mdi:water', '💧'], ['mdi:sun', '☀️'], ['mdi:moon', '🌙'],
  ['mdi:gauge', '📊'], ['mdi:chart', '📊'], ['mdi:walk', '🚶'], ['mdi:run', '🏃'],
  ['mdi:flash', '⚡'], ['mdi:power', '⚡'], ['mdi:lightning', '⚡'], ['mdi:bookmark', '🔖'],
];
const HA_DOMAIN_EMOJI = {
  light: '💡', switch: '🔌',
  input_boolean: '🔘', input_button: '🔘', input_select: '📋', input_number: '🔢',
  input_text: '✏️', input_datetime: '📅',
  lock: '🔒', media_player: '🔊', cover: '🪟',
  climate: '🌡️', weather: '⛅', fan: '🌀', vacuum: '🧹',
  scene: '🎬', script: '📜', automation: '🤖',
  sensor: '📊', binary_sensor: '🔘',
  camera: '📷', alarm_control_panel: '🚨',
  water_heater: '💧', sun: '☀️',
  person: '👤', device_tracker: '📍', zone: '📍',
  timer: '⏲️', counter: '🔢', notify: '🔔', group: '📁',
};
function haMdiToEmoji(name) {
  if (typeof name !== 'string' || !name) return null;
  const low = name.toLowerCase();
  for (const [pat, em] of HA_MDI_EMOJI) if (low === pat || low.startsWith(pat + '-')) return em;
  return null;
}
function haEntityEmoji(entityId) {
  // Prefer the registry override -> mdi mapping -> domain fallback. State attributes (live mdi)
  // would be richer but main only has them for entities the renderer has touched; for the panel
  // push we go with registry + domain to avoid stalling on per-entity fetches.
  if (haCache && Array.isArray(haCache.entityRegistry)) {
    const reg = haCache.entityRegistry.find(r => r.entity_id === entityId);
    if (reg && reg.icon) { const em = haMdiToEmoji(reg.icon); if (em) return em; }
  }
  return HA_DOMAIN_EMOJI[(entityId || '').split('.')[0] || ''] || '🏠';
}

// Resolve app/image icons to a data: URL the panel renderer can draw (works in native + http pages).
async function resolveTiles(tiles) {
  return Promise.all((tiles || []).map(async t => {
    const out = { ...t };
    if (t.iconType === 'image' && t.iconImage) {
      out.iconSrc = imageFileToDataUrl(t.iconImage);
      if (!out.iconSrc) { try { out.iconSrc = pathToFileURL(t.iconImage).href; } catch (e) {} }   // fallback
    }
    else if (t.iconType === 'url' && t.iconCache) { out.iconSrc = imageFileToDataUrl(t.iconCache); }   // cached download -> data URL; null (gone) -> emoji fallback
    else if (t.iconType === 'ha' && t.value) {
      // HA entity tile resolution order:
      //   1. t.iconCache (entity_picture cached by the editor) — render as image.
      //   2. The entity's MDI icon (registry override -> HA's domain default), fetched from
      //      jsDelivr and cached as a recolored SVG — render as image.
      //   3. Emoji fallback (table mirror of config.js) — only if jsDelivr is unreachable.
      if (t.iconCache) { out.iconSrc = imageFileToDataUrl(t.iconCache); }
      if (!out.iconSrc) {
        const mdi = haEntityMdi(t.value);
        if (mdi) {
          try {
            const r = await fetchMdiToCache(mdi);
            if (r && r.ok && r.dataUrl) out.iconSrc = r.dataUrl;
          } catch (e) {}
        }
      }
      if (!out.iconSrc && !out.icon) out.icon = haEntityEmoji(t.value);
    }
    else if (t.iconType === 'app') { const d = await getAppIconDataUrl(t.value); if (d) out.iconSrc = d; }
    return out;
  }));
}
// Knob behavior is configurable per page TYPE (grid / dashboard / app), with an optional per-page override.
// turn: 'pages' | 'volume' | 'scroll' | 'select'   ·   click: 'rotation' | 'mute' | 'enter'
const KNOB_DEFAULT = { turn: 'pages', click: 'rotation', dblclick: 'selector' };
function pageTypeOf(g) { return g.kind === 'app' ? 'app' : g.kind === 'web' ? 'dashboard' : 'grid'; }
function effectiveKnob(g) {
  const all = (config.settings && config.settings.knob) || {};
  const base = Object.assign({}, KNOB_DEFAULT, all[pageTypeOf(g)] || {});
  if (g.knobOverride && g.knob) return { turn: g.knob.turn || base.turn, click: g.knob.click || base.click, dblclick: g.knob.dblclick || base.dblclick };
  return base;
}
// Place a grid group's tiles into a page's cols x rows, anchored top-left. Cells of the page that
// fall outside the group's footprint stay blank; tiles in the group whose row/col is outside the
// page's bounds are cropped. Merged tiles (w>1 / h>1) whose span would extend past the page are
// dropped entirely so we never emit dangling cover cells. Used by resolveGroupedTiles below and
// mirrored in the editor (anchorGroupTiles in config.js).
function anchorGroupTiles(group, pageCols, pageRows) {
  const gCols = +(group && group.cols) || 0;
  const gRows = +(group && group.rows) || 0;
  const pc = +pageCols || 0, pr = +pageRows || 0;
  if (!gCols || !gRows || !pc || !pr) return [];
  const out = new Array(pc * pr);
  for (let i = 0; i < out.length; i++) out[i] = {};
  const src = (group && Array.isArray(group.tiles)) ? group.tiles : [];
  for (let r = 0; r < gRows; r++) {
    for (let c = 0; c < gCols; c++) {
      if (r >= pr || c >= pc) continue;                  // crop cells outside the page
      const t = src[r * gCols + c];
      if (!t || t.cover != null) continue;               // empty or covered-by-merge — handled by owners
      const w = +t.w || 1, h = +t.h || 1;
      if (c + w > pc || r + h > pr) continue;            // merged tile's span doesn't fit — drop whole tile
      const dstIdx = r * pc + c;
      out[dstIdx] = (w > 1 || h > 1) ? Object.assign({}, t, { w, h }) : Object.assign({}, t);
      for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) {
        if (dr === 0 && dc === 0) continue;
        out[(r + dr) * pc + (c + dc)] = { cover: dstIdx };
      }
    }
  }
  return out;
}
// Return the tile array a page should render — its own g.tiles, or a grid group's tiles
// anchored into the page's cols/rows. A reference to a missing group falls back silently.
function resolveGroupedTiles(g) {
  if (!g || !g.useGroup || !g.groupId) return (g && g.tiles) || [];
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const group = groups.find(x => x && x.id === g.groupId);
  if (!group) return (g.tiles) || [];
  return anchorGroupTiles(group, g.cols || 0, g.rows || 0);
}

async function resolveGridIcons(grid) {
  const knob = effectiveKnob(grid);   // resolved from the ORIGINAL kind (apps get converted to 'web' below)
  const tilesIn = resolveGroupedTiles(grid);
  let out;
  if (grid.kind === 'app') {                                                                          // render the local app in the webview; themed:true -> panel injects live light/dark + accent
    if (grid.app === 'ha-dashboard') {
      // Special-case: translate to a synthetic web dashboard using the global HA creds + the picked dashboard
      // path. Reuses the existing dashboard webview render (incl. localStorage token injection for sign-in
      // persistence). themed:false because HA themes itself.
      const ha = (config.settings || {}).haAuth || {};
      const baseUrl = String(ha.url || '').replace(/\/+$/, '');
      const dash = String((grid.options || {}).dashboard || 'lovelace').replace(/^\/+/, '');
      const opts = grid.options || {};
      const kioskFlags = ['kiosk', 'hideHeader', 'hideSidebar']
        .filter(k => opts[k])
        .map(k => k === 'hideHeader' ? 'hide_header' : k === 'hideSidebar' ? 'hide_sidebar' : k);
      const kioskQuery = kioskFlags.length ? '?' + kioskFlags.join('&') : '';
      const synthetic = { ...grid, kind: 'web', url: baseUrl ? baseUrl + '/' + dash + kioskQuery : '', auth: { type: 'ha', token: ha.token || '' }, themed: false };
      out = grid.gridOn ? { ...synthetic, tiles: await resolveTiles(tilesIn) } : synthetic;
    } else {
      const base = { ...grid, kind: 'web', url: appPageUrl(grid), themed: true };
      out = grid.gridOn ? { ...base, tiles: await resolveTiles(tilesIn) } : base;                     // file/app pages with the native button strip -> resolve its tile icons
    }
  } else if (grid.kind === 'web') {
    // A dashboard's own HA-token field is an OPTIONAL override (e.g. a second HA instance) — left
    // blank, it falls back to the global token from Settings -> Auth, same source the Home
    // Assistant Dashboard app uses, so a plain "Home Assistant token" dashboard just works.
    const g2 = (grid.auth && grid.auth.type === 'ha' && !grid.auth.token)
      ? { ...grid, auth: { ...grid.auth, token: ((config.settings || {}).haAuth || {}).token || '' } }
      : grid;
    out = g2.gridOn ? { ...g2, tiles: await resolveTiles(tilesIn) } : g2;                             // dashboard: resolve the button-grid tile icons, else nothing to resolve
  } else {
    out = { ...grid, tiles: await resolveTiles(tilesIn) };
  }
  return Object.assign({}, out, { _knob: knob });
}

// Extract a program's own icon as a data: URL (best-effort; null if it can't be resolved).
async function getAppIconDataUrl(value) {
  try {
    const p = await resolveAppPath(value);
    if (!p) return null;
    const img = await app.getFileIcon(p, { size: 'large' });
    return (!img || img.isEmpty()) ? null : img.toDataURL();
  } catch (e) { return null; }
}

// Turn an app value into a real file path: full paths used as-is; bare names resolved via `where`.
function resolveAppPath(value) { return actionRunner.resolveAppPath(value, actionDeps); }
function launchAppValue(value) { actionRunner.launchApp(value, actionDeps).catch(e => console.log('app launch error:', e.message)); }
function runShellCommand(value) { return actionRunner.runShellCommand(value, actionDeps); }
function lockWorkstation() { return actionRunner.lockWorkstation(actionDeps); }

// A tile fires either a single action (its type/value) or a macro (an ordered list of steps). Both run
// through runStep, so a plain tile is just a one-step macro. runAction is async (steps can include delays);
// callers fire-and-forget. macroBusy serializes macros so mashing a tile can't overlap runs.
let macroBusy = false;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function runAction(a) {
  if (!a || typeof a.type !== 'string') return;
  if (a.type === 'system' && a.value === 'config') return openConfigWindow();
  if (a.type === 'macro') {
    if (macroBusy) return;                                       // ignore taps while a macro is mid-run
    macroBusy = true;
    console.log('launch macro:', a.label, '(' + ((a.steps || []).length) + ' steps)');
    try { for (const s of (Array.isArray(a.steps) ? a.steps : [])) { try { await runStep(s); } catch (e) { console.log('macro step error:', e.message); } } }
    finally { macroBusy = false; }
    return;
  }
  if (a.type === 'ha') {
    // HA entity tile: fire a service call against the picked entity. Service is "domain.action"
    // (e.g. "light.toggle", "media_player.media_play_pause"). callHaService throws on misconfig
    // or HA error — log and swallow so a misfire never crashes the launch path.
    console.log('launch:', a.label, '-> ha', a.value, 'service=' + (a.service || ''));
    try { await callHaService(a.value, a.service); } catch (e) { console.log('ha action error:', e.message); }
    return;
  }
  if (a.value != null && typeof a.value !== 'string') return;   // value, when present, is a string
  console.log('launch:', a.label, '->', a.type, a.value);
  try { await runStep({ kind: a.type, value: a.value }); } catch (e) { console.log('action error:', e.message); }
}

// POST /api/services/{domain}/{action} with {entity_id}. Used by HA entity tiles; throws on
// any misconfig (Use HA off, missing URL/token, bad service string) or non-2xx response.
async function callHaService(entityId, fullService) {
  if (typeof entityId !== 'string' || !entityId) throw new Error('entity_id missing');
  if (typeof fullService !== 'string' || !fullService) throw new Error('service missing');
  const ha = (config.settings && config.settings.haAuth) || {};
  if (!ha.useHa) throw new Error('Use Home Assistant is off');
  if (!ha.url || !ha.token) throw new Error('HA URL/token missing (Auth tab)');
  const dot = fullService.indexOf('.');
  if (dot < 1) throw new Error('service must be domain.action');
  const domain = fullService.slice(0, dot), action = fullService.slice(dot + 1);
  const u = new URL(ha.url);
  u.pathname = u.pathname.replace(/\/+$/, '') + '/api/services/' + encodeURIComponent(domain) + '/' + encodeURIComponent(action);
  const r = await net.fetch(u.href, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ha.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (!r.ok) throw new Error('HA ' + r.status);
}
// One macro step (also the single-action path). New kinds: key (combo), text (typed), delay (ms).
async function runStep(step) {
  if (!step || typeof step.kind !== 'string') return;
  const value = step.value;
  if (value != null && typeof value !== 'string') return;
  switch (step.kind) {
    case 'url': openExternalUrl(value); break;
    case 'app': launchAppValue(value); break;
    case 'cmd': runShellCommand(value); break;
    case 'open': shell.openPath(value); break;
    case 'page': gotoGrid(value, true); if (rotateRunning) scheduleRotation(); break;   // switch the panel to another page
    case 'system':
      if (value === 'lock') lockWorkstation();
      else if (value === 'mic') toggleMic();
      else if (value === 'monitor') enterMonitorMode();   // hand the device screen to Windows; return via the tray
      else if (value === 'config') openConfigWindow();
      break;
    case 'paste_text': pasteText(value); break;
    case 'key': mediaKeys.tapCombo(value); break;
    case 'text': if (!mediaKeys.typeString(value)) pasteText(value); break;   // type literally; fall back to clipboard paste
    case 'delay': await sleep(Math.max(0, Math.min(60000, parseInt(value, 10) || 0))); break;
    case 'ahk': ahk.run(value, { ahkPath: appSettings().ahkPath }); break;   // AutoHotkey script (inline or .ahk path), Windows-only
    case 'counter': break;   // counter changes are saved by the panel directly via saveTileValue IPC
  }
}

// Paste-text tile: write the configured text to the Windows clipboard, then synthesize Ctrl+V into the
// active foreground window. Clipboard.writeText is built into Electron; the Ctrl+V keystroke uses the
// existing media-keys backend (robotjs via @jitsi/robotjs). Note: this overwrites the user's clipboard.
function pasteText(value) {
  if (typeof value !== 'string' || value === '') return;
  try { clipboard.writeText(value); } catch (e) { console.log('pasteText clipboard error:', e.message); return; }
  // tiny delay so the clipboard has time to settle before Ctrl+V is sent
  setTimeout(() => { try { mediaKeys.pasteShortcut(); } catch (e) { console.log('pasteText keystroke error:', e.message); } }, 30);
}

// Media transport for the Music page. On Windows, drive the *exact* SMTC session the now-playing display
// is showing (matched by its app id) so the buttons control the same source — not whatever app currently
// owns the global media keys (which splits control from the display when several players are open). Fall
// back to the media-key tap if the helper can't act (no session, helper missing) or off-Windows.
const SMTC_CTL_CMDS = { playpause: 1, next: 1, prev: 1 };
function mediaKey(cmd) {
  if (process.platform === 'win32' && SMTC_CTL_CMDS[cmd] && fs.existsSync(SMTC_CTL_EXE)) {
    const snap = nowplaying.getSnapshot();
    const args = (snap && snap.app) ? [cmd, snap.app] : [cmd];   // target the displayed session by app id
    try {
      execFile(SMTC_CTL_EXE, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
        if (err || String(stdout || '').trim() !== 'ok') mediaKeys.transport(cmd);   // helper miss -> media key
      });
      return true;
    } catch (e) { return mediaKeys.transport(cmd); }
  }
  return mediaKeys.transport(cmd);
}

// Meeting app page: routes a button press to the right mechanism. 'system' is OS-level volume
// (platform-agnostic); 'zoom' sends Zoom's default keybind unless the user has turned off "Use
// Zoom's default keymappings" in the app's Options, in which case it sends their custom combo —
// either way, whether it works while Zoom isn't focused depends on Zoom's own "Enable Global
// Shortcut" checkbox for that action; 'teams' force-focuses Teams first since its remaining
// shortcuts require focus (the local API that used to allow background control was retired by
// Microsoft on 2026-06-30 — see PROJECT.md).
const ZOOM_OPTION_KEY = { mute: 'zoomMute', video: 'zoomVideo', accept: 'zoomAccept', decline: 'zoomDecline', leave: 'zoomLeave' };
async function onMeetingActionRequest(platform, action) {
  if (platform === 'system') {
    if (action === 'volup') { mediaKeys.volume(1); sysVolAt = 0; return { ok: true }; }
    if (action === 'voldown') { mediaKeys.volume(-1); sysVolAt = 0; return { ok: true }; }
    return { ok: false, error: 'unknown system action: ' + action };
  }
  // Utility-rail actions. Share fires the app's screen-share shortcut (Zoom Alt+S; Teams
  // Ctrl+Shift+E — both depend on that shortcut being enabled in the app, same as the other
  // keystroke actions here).
  if (action === 'share') {
    if (platform === 'zoom') return meetingControl.sendZoomAction('alt+s', { mediaKeys });
    if (platform === 'teams') {
      const focus = await meetingControl.focusTeamsWindow();
      await new Promise(r => setTimeout(r, 150));
      return { ok: mediaKeys.tapCombo('control+shift+e'), focused: focus.ok };
    }
    return { ok: false, error: 'no share for ' + platform };
  }
  // Full screen is an in-app (not global) shortcut for both, so focus the window first, then tap:
  // Zoom = Alt+F, Teams = F11.
  if (action === 'fullscreen') {
    const combo = platform === 'zoom' ? 'alt+f' : platform === 'teams' ? 'f11' : null;
    if (!combo) return { ok: false, error: 'no fullscreen for ' + platform };
    const focus = platform === 'teams'
      ? await meetingControl.focusTeamsWindow()
      : await meetingControl.focusProcessWindow(['Zoom']);
    await new Promise(r => setTimeout(r, 150));
    return { ok: mediaKeys.tapCombo(combo), focused: focus.ok };
  }
  if (platform === 'zoom') {
    const optKey = ZOOM_OPTION_KEY[action];
    if (!optKey) return { ok: false, error: 'unknown Zoom action: ' + action };
    const cfg = activeServedAppConfig('meeting');
    const opts = (cfg && cfg.options) || {};
    // Default to Zoom's own shipped keybinds (matches Zoom out of the box, no setup needed);
    // only fall through to the user's custom combo when they've explicitly turned defaults off.
    const combo = opts.zoomUseDefaults === false ? opts[optKey] : meetingControl.ZOOM_DEFAULT_COMBO[action];
    return meetingControl.sendZoomAction(combo, { mediaKeys });
  }
  if (platform === 'teams' && action === 'focus') {
    const focused = await meetingControl.focusTeamsWindow();
    if (focused.ok) return focused;
    return {
      ok: openExternalUrl('https://teams.microsoft.com/v2/'),
      focused: false,
      focusError: focused.error,
    };
  }
  if (platform === 'teams') return meetingControl.sendTeamsAction(action, { mediaKeys });
  return { ok: false, error: 'unknown platform: ' + platform };
}

// ---- meeting recording (Phase 1) ----
// Settings live under config.settings.meeting (global, like config.settings.monitor) so auto-record
// works regardless of which app the panel is showing — the meeting page's per-grid options only
// exist while it's the active app, which is useless for background recording.
const MEETING_DEFAULTS = { folder: '', processedFolder: '', processedByDate: false, transcribeUrl: '', analysisAi: 'claude', micDevice: '', echoGate: false, silenceStopMin: 0, autoRecord: false, recordApps: 'Zoom.exe,Teams.exe,ms-teams.exe', outlookEnabled: false, meetingInfoSource: 'classic', outlookAccount: '', outlookCalendar: 'Calendar', outlookSkipPrefixes: 'Canceled:', transcribeThreshold: '', myName: '', separateRecurring: false, appendMeetingName: false, separateTranscript: false, useDetailsFolder: false };
function meetingSettings() { return Object.assign({}, MEETING_DEFAULTS, (config.settings || {}).meeting || {}); }
function defaultMeetingFolder() { return path.join(app.getPath('documents'), 'OpenQuake Meetings', 'unprocessed'); }
function defaultProcessedFolder() { return path.join(app.getPath('documents'), 'OpenQuake Meetings', 'processed'); }
// Blank folder settings mean "use the default", same convention as the recorder.
function resolveMeetingFolders() {
  const m = meetingSettings();
  return {
    unprocessed: String(m.folder || '').trim() || defaultMeetingFolder(),
    processed: String(m.processedFolder || '').trim() || defaultProcessedFolder(),
  };
}
// Analysis prompt: the user-editable copy lives in userData, seeded from the bundled template on
// first use. The analyzer prefers it whenever it exists.
function userMeetingPromptPath() { return path.join(app.getPath('userData'), 'meeting-analysis-prompt.md'); }
function ensureMeetingPromptFile() {
  const p = userMeetingPromptPath();
  if (!fs.existsSync(p)) fs.copyFileSync(path.join(__dirname, 'meeting-analysis-prompt.md'), p);
  return p;
}
// Accept the base URL, the full /transcribe URL, or a bare host:port; always return the base.
function resolveTranscribeBaseUrl() {
  let u = String(meetingSettings().transcribeUrl || '').trim() || 'http://127.0.0.1:10301';
  u = u.replace(/^(https?):\/*/i, '$1://');          // heal "http:/host" and "http:host" typos
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;   // bare "192.168.1.25:10301" entries work too
  u = u.replace(/\/+$/, '');
  if (/\/transcribe$/i.test(u)) u = u.slice(0, -'/transcribe'.length);
  return u;
}
// One-time best-effort migration: the default recording folder used to be the OpenQuake Meetings
// root; it is now the unprocessed\ subfolder. Move stranded root WAVs there so they show up in the
// panel's Unprocessed list. Only runs when the folder setting is blank (explicit folders are the
// user's own business) and never throws.
function migrateLegacyMeetingWavs() {
  if (String(meetingSettings().folder || '').trim()) return;
  try {
    const root = path.join(app.getPath('documents'), 'OpenQuake Meetings');
    const dest = defaultMeetingFolder();
    if (!fs.existsSync(root)) return;
    const wavs = fs.readdirSync(root).filter(n => /\.wav$/i.test(n) && fs.statSync(path.join(root, n)).isFile());
    if (!wavs.length) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const n of wavs) {
      try { fs.renameSync(path.join(root, n), path.join(dest, n)); } catch (e) { console.log('[meeting] migrate skipped ' + n + ': ' + e.message); }
    }
    console.log('[meeting] migrated ' + wavs.length + ' recording(s) into unprocessed\\');
  } catch (e) { console.log('[meeting] legacy folder migration failed: ' + e.message); }
}

// Real system-volume read for the meeting OUTPUT rail — throttled + cached so the 1 s panel poll
// never spawns a process more than ~once a second. Never fabricates a level: cache stays null (panel
// shows "—") until the helper answers, and on any failure.
function refreshSystemVolume() {
  if (process.platform !== 'win32') return;
  const now = Date.now();
  if (sysVolBusy || (now - sysVolAt) < 900 || !fs.existsSync(SYSVOL_EXE)) return;
  sysVolBusy = true; sysVolAt = now;
  execFile(SYSVOL_EXE, [], { timeout: 1500, windowsHide: true }, (err, stdout) => {
    sysVolBusy = false;
    if (err) return;
    const n = parseInt(String(stdout).trim(), 10);
    sysVolCache = (Number.isFinite(n) && n >= 0) ? n : null;
  });
}

// State the panel poller reads: recorder runtime state + the configured mic (so the page loads with
// the editor-chosen mic as its default even when idle) + the auto-record flag.
function meetingStateForPanel() {
  const st = meetingRecorder ? meetingRecorder.getState() : { recording: false, startedAt: null, durationMs: 0, file: null, app: null, mic: '' };
  const m = meetingSettings();
  st.mic = st.mic || m.micDevice || '';
  st.autoRecord = !!m.autoRecord;
  refreshSystemVolume();       // throttled; updates sysVolCache in the background
  st.volume = sysVolCache;     // 0-100, or null when unavailable (panel shows "—")
  return st;
}
// Panel remote for the recorder (start/stop/state/setMic), reached over HTTP via sysserver.
function onMeetingRecordRequest(cmd, arg) {
  if (!meetingRecorder) return { ok: false, error: 'recorder unavailable' };
  if (cmd === 'start') return { ok: true, state: meetingRecorder.start('manual') };
  if (cmd === 'stop') return { ok: true, state: meetingRecorder.stop('manual') };
  if (cmd === 'state') return { ok: true, state: meetingStateForPanel() };
  if (cmd === 'setMic') { setMeetingMic(arg); return { ok: true, state: meetingStateForPanel() }; }
  return { ok: false, error: 'unknown record command: ' + cmd };
}
function setMeetingMic(label) {
  if (!config.settings) config.settings = {};
  if (!config.settings.meeting) config.settings.meeting = {};
  config.settings.meeting.micDevice = label || '';
  saveConfig();
  if (meetingRecorder) meetingRecorder.setMic(label || '');
}

// Meeting info: when a recording starts (and the Advanced setting is on), ask either classic
// Outlook or Microsoft Graph which appointment matches "now" and save its details as
// <recording>.json beside the WAV. Ad-hoc calls with nothing scheduled write nothing; any
// failure is logged and never touches the recording itself.
function writeOutlookMeetingInfo(wavName) {   // wavName = basename (recorder state exposes no path)
  const m = meetingSettings();
  if (!m.outlookEnabled) return;
  const saveInfo = info => {
    try {
      if (!info) { console.log('[meeting] calendar: no meeting scheduled now — no info file'); return; }
      const dest = path.join(resolveMeetingFolders().unprocessed, wavName.replace(/\.wav$/i, '') + '.json');
      fs.writeFileSync(dest, JSON.stringify(info, null, 2));
      console.log('[meeting] meeting info saved: ' + path.basename(dest) + ' (' + (info.subject || '') + ')');
      // If the lookup completed after a short recording stopped, the normal completion callback
      // already ran before the sidecar existed. Complete the optional rename now in that case.
      if (fs.existsSync(path.join(resolveMeetingFolders().unprocessed, wavName))) appendMeetingNameToRecording(wavName);
    } catch (e) { console.log('[meeting] calendar info write failed: ' + e.message); }
  };
  if (m.meetingInfoSource === 'microsoft365') {
    officeGraph.getMeetingInfo({ skipPrefixes: m.outlookSkipPrefixes || '' })
      .then(saveInfo)
      .catch(e => console.log('[meeting] Microsoft 365 lookup failed: ' + (e.message || e)));
    return;
  }
  if (!m.outlookAccount) return;
  if (!fs.existsSync(OUTLOOK_MEETING_EXE)) { console.log('[meeting] outlook-meeting.exe missing — meeting info skipped'); return; }
  execFile(OUTLOOK_MEETING_EXE, ['meeting', m.outlookAccount, m.outlookCalendar || 'Calendar', m.outlookSkipPrefixes || ''],
    { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      try {
        if (err) { console.log('[meeting] outlook lookup failed: ' + err.message); return; }
        const info = JSON.parse(String(stdout));
        if (info && info.ok === false) {
          console.log('[meeting] outlook: ' + (info.none ? 'no meeting scheduled now — no info file' : info.error));
          return;
        }
        saveInfo(info);
      } catch (e) { console.log('[meeting] outlook info write failed: ' + e.message); }
    });
}

// "Append meeting name": once a recording is closed and header-patched, rename the WAV (and its
// Outlook sidecar) from <timestamp>.wav to <timestamp>-<Meeting Name>.wav using the sidecar's
// subject. Illegal filename characters are stripped (spaces kept). No sidecar / no subject /
// feature off -> the timestamp name stays.
function appendMeetingNameToRecording(wavName) {
  const m = meetingSettings();
  if (!m.outlookEnabled || !m.appendMeetingName) return;
  try {
    const dir = resolveMeetingFolders().unprocessed;
    const base = wavName.replace(/\.wav$/i, '');
    const sidecar = path.join(dir, base + '.json');
    if (!fs.existsSync(sidecar)) return;   // ad-hoc call, or the Outlook lookup found nothing
    const rawSubject = (JSON.parse(fs.readFileSync(sidecar, 'utf8')) || {}).subject || '';
    // Same character rules as the library's filename validation — a name the rename produces
    // must be one every panel screen can list.
    const subject = require('./meetingLibrary').sanitizeSubjectForFilename(rawSubject);
    if (!subject) return;
    let newBase = base + '-' + subject;
    for (let i = 1; fs.existsSync(path.join(dir, newBase + '.wav')); i++) newBase = base + '-' + subject + '_' + i;
    fs.renameSync(path.join(dir, wavName), path.join(dir, newBase + '.wav'));
    fs.renameSync(sidecar, path.join(dir, newBase + '.json'));
    console.log('[meeting] recording renamed -> ' + newBase + '.wav');
  } catch (e) { console.log('[meeting] meeting-name rename failed: ' + e.message); }
}

// Panel remote for the recordings library + transcription + analysis screens (Unprocessed /
// Transcription / Analysis overlays), reached over HTTP via sysserver. Same shape as
// onMeetingRecordRequest: every op answers a plain JSON object, never throws.
function onMeetingLibraryRequest(op, params) {
  const p = params || {};
  try {
    if (op === 'files') return meetingLibrary ? meetingLibrary.listFiles(p.kind, p.dir) : { ok: false, error: 'library unavailable' };
    if (op === 'delete') return meetingLibrary ? meetingLibrary.deleteFile(p.kind, p.name) : { ok: false, error: 'library unavailable' };
    if (op === 'transcribeStart') return meetingTranscriber ? meetingTranscriber.enqueue(p.name) : { ok: false, error: 'transcriber unavailable' };
    if (op === 'transcribeState') return meetingTranscriber ? meetingTranscriber.getState() : { ok: false, error: 'transcriber unavailable' };
    if (op === 'analyzeStart') return meetingAnalyzer ? meetingAnalyzer.start(p.name) : { ok: false, error: 'analyzer unavailable' };
    if (op === 'analyzeState') return meetingAnalyzer ? meetingAnalyzer.getState() : { ok: false, error: 'analyzer unavailable' };
    if (op === 'analysisResult') return meetingAnalyzer ? meetingAnalyzer.result(p.name) : { ok: false, error: 'analyzer unavailable' };
    return { ok: false, error: 'unknown library op: ' + op };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Absolute path for /meeting-audio streaming, or null (sysserver answers 404). Validation lives in
// meetingLibrary.resolvePath.
function resolveMeetingAudioPath(kind, name) {
  if (!meetingLibrary || !/\.wav$/i.test(String(name || ''))) return null;
  return meetingLibrary.resolvePath(kind, name);
}

// Native app-scoped monitor: emits a JSON line whenever an allowlisted app (Zoom/Teams) starts or
// stops holding an ACTIVE capture session. That, not raw mic sound, is what auto-starts recording —
// so a Claude-voice session (or any other mic use) never triggers it.
function startMicMonitor() {
  if (process.platform !== 'win32') return;
  stopMicMonitor();
  if (!fs.existsSync(MIC_MONITOR_EXE)) { console.log('[meeting] mic-session-monitor.exe missing — auto-record disabled (manual still works)'); return; }
  const allow = meetingSettings().recordApps || MEETING_DEFAULTS.recordApps;
  try {
    micMonitorProc = spawn(MIC_MONITOR_EXE, [allow], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { console.log('[meeting] mic monitor spawn failed:', e.message); micMonitorProc = null; return; }
  let buf = '';
  micMonitorProc.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      if (!meetingRecorder) continue;
      if (msg.active) meetingRecorder.autoStart(msg.app || null);
      else meetingRecorder.autoStop('call-ended');
    }
  });
  micMonitorProc.on('exit', () => { micMonitorProc = null; });
  console.log('[meeting] mic monitor watching: ' + allow);
}
function stopMicMonitor() {
  if (micMonitorProc) { try { micMonitorProc.kill(); } catch (e) {} micMonitorProc = null; }
}

function isDeviceDisplay(d) {
  return !!(d && ((d.bounds.width === 480 && d.bounds.height === 1920) || (d.bounds.width === 1920 && d.bounds.height === 480)));
}
function deviceDisplay() { return screen.getAllDisplays().find(isDeviceDisplay); }
// Once the panel exists, its actual HWND bounds are a stronger runtime identity than resolution alone.
// Electron display ids remain useful only within this topology snapshot and are never persisted.
function reservedTargetDisplay() {
  if (panelWin && !panelWin.isDestroyed()) {
    try {
      const match = screen.getDisplayMatching(panelWin.getBounds());
      const b = panelWin.getBounds();
      const overlap = Math.max(0, Math.min(b.x + b.width, match.bounds.x + match.bounds.width) - Math.max(b.x, match.bounds.x)) *
        Math.max(0, Math.min(b.y + b.height, match.bounds.y + match.bounds.height) - Math.max(b.y, match.bounds.y));
      // Windows may relocate the panel HWND to a primary monitor after HDMI disconnect. Bounds are
      // authoritative only while the containing display still has the Quake's known geometry.
      if (overlap > 0 && isDeviceDisplay(match)) return match;
    } catch (e) {}
  }
  return deviceDisplay();
}
function reservedDisplayState() {
  const target = reservedTargetDisplay();
  const rect = b => ({ x: b.x, y: b.y, width: b.width, height: b.height });
  if (!target) return {
    reserved: null,
    displays: screen.getAllDisplays().map(d => ({
      id: String(d.id),
      primary: d.id === screen.getPrimaryDisplay().id,
      bounds: rect(d.bounds),
      workArea: rect(d.workArea),
    })),
  };
  return {
    reserved: rect(target.bounds),
    displays: screen.getAllDisplays().filter(d => String(d.id) !== String(target.id)).map(d => ({
      id: String(d.id),
      primary: d.id === screen.getPrimaryDisplay().id,
      bounds: rect(d.bounds),
      workArea: rect(d.workArea),
    })),
  };
}
function refreshReservedDisplay(reason, delay) {
  clearTimeout(reservedRefreshTimer);
  if (!delay) reservedDisplay.refresh(reason);
  reservedRefreshTimer = setTimeout(() => reservedDisplay.refresh(reason + ' (settled)'), delay || 900);
}
function applyPanelDisplayMode(d) {
  panelWin.setBounds(d.bounds);
  panelWin.setMenuBarVisibility(false);
  if (process.platform === 'darwin') panelWin.setSimpleFullScreen(true);
  else panelWin.setFullScreen(true);
}
function placePanel() {
  if (monitorMode) return;                                          // in monitor mode the panel stays hidden — don't re-show it over the desktop
  const d = deviceDisplay();
  if (!d) { console.log('placePanel: DK-QUAKE display not present'); return; }
  if (!panelWin || panelWin.isDestroyed()) {
    panelWin = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, show: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: true, autoHideMenuBar: true,
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'panel-preload.js'),
        webviewTag: true,
      },
    });
    panelWin.loadFile(path.join(__dirname, 'index.html'));
    panelWin.on('move', () => refreshReservedDisplay('panel moved', 350));
    panelWin.on('resize', () => refreshReservedDisplay('panel bounds changed', 350));
    panelWin.once('ready-to-show', () => {
      const dd = deviceDisplay() || d;
      applyPanelDisplayMode(dd); panelWin.setAlwaysOnTop(true); panelWin.show(); panelWin.focus();
      setTimeout(() => panelWin.setAlwaysOnTop(false), 1500);
      pushToPanel();
      console.log('panel display bounds', JSON.stringify(dd.bounds), 'workArea', JSON.stringify(dd.workArea));
      console.log('panel placed at', JSON.stringify(panelWin.getBounds()), 'fullscreen', panelWin.isFullScreen(), 'simpleFullscreen', panelWin.isSimpleFullScreen && panelWin.isSimpleFullScreen());
      refreshReservedDisplay('panel placed', 350);
    });
  } else { applyPanelDisplayMode(d); panelWin.show(); pushToPanel(); refreshReservedDisplay('panel placed', 350); }
}

// ---- monitor mode: use the device as a normal monitor ----
// Hide the launcher window so the Windows desktop shows on the device; the driver keep-alive keeps the
// backlight lit. Touch drives the OS cursor and the knob does a configurable action — both via the trusted
// device input only (mediaKeys / robotjs), never web content. The tray (or a System->monitor tile) toggles it.
function enterMonitorMode() {
  if (monitorMode || !panelWin || panelWin.isDestroyed()) return;
  monitorMode = true;
  reservedDisplay.setSuspended(true);
  try { if (process.platform === 'darwin') panelWin.setSimpleFullScreen(false); else panelWin.setFullScreen(false); } catch (e) {}
  panelWin.hide();
  syncPollers(null);                                                // nothing on the panel is visible -> idle the page pollers
  try { dev.screenOn(); } catch (e) {}                              // keep the backlight on as the desktop takes over
  refreshTray();
  console.log('monitor mode: ON (panel hidden, desktop visible)');
}
function exitMonitorMode(reason) {
  if (!monitorMode) return;
  monitorMode = false;
  reservedDisplay.setSuspended(false);
  releaseTouch();                                                   // drop any held mouse button from an in-progress touch
  if (panelWin && !panelWin.isDestroyed()) {
    const d = deviceDisplay();
    if (d) applyPanelDisplayMode(d);
    panelWin.setAlwaysOnTop(true); panelWin.show(); panelWin.focus();
    setTimeout(() => { try { panelWin.setAlwaysOnTop(false); } catch (e) {} }, 1500);
  }
  syncPollers(activeGrid());                                        // resume the active page's poller
  refreshTray();
  console.log('monitor mode: OFF (' + (reason || '') + ')');
}
function toggleMonitorMode() { monitorMode ? exitMonitorMode('tray') : enterMonitorMode(); }

// Monitor-mode touch -> OS cursor: tap = left-click, drag = move with the button held, lift = release.
// Maps the panel's bottom-left-origin coords (x:0..1920, y:0..480) onto the device monitor's screen rect.
function injectTouch(p) {
  if (!mediaKeys.available()) return;
  const d = deviceDisplay(); if (!d) return;
  const b = d.bounds;
  const x = Math.round(b.x + Math.max(0, Math.min(1920, p.x)));
  const y = Math.round(b.y + Math.max(0, Math.min(480, 480 - p.y)));   // device origin is bottom-left -> flip Y for the top-left screen
  clearTimeout(touchIdle);
  if (p.action === 1) {
    mediaKeys.moveMouse(x, y);
    if (!touchDown) { touchDown = true; mediaKeys.mouseToggle(true, 'left'); }
    touchIdle = setTimeout(releaseTouch, 140);
  } else releaseTouch();
}
function releaseTouch() { clearTimeout(touchIdle); if (touchDown) { touchDown = false; mediaKeys.mouseToggle(false, 'left'); } }

// Knob behavior in monitor mode (configurable on the editor's Monitor settings tab). Turn -> scroll or
// volume; single-tap -> Enter / left-click / right-click / mute. Exit is tray-only (knob stays free).
function monitorCfg() {
  const m = (config.settings || {}).monitor || {};
  return {
    knobTurn: m.knobTurn === 'volume' ? 'volume' : 'scroll',                         // default: scroll
    knobTap: ['leftclick', 'enter', 'rightclick', 'mute'].includes(m.knobTap) ? m.knobTap : 'enter',   // default: enter
  };
}
function monitorKnob(k) {
  const m = monitorCfg();
  if (k.type === 'rotate') {
    if (m.knobTurn === 'scroll') mediaKeys.scroll(k.dir > 0 ? -120 : 120);           // 120 = one wheel notch per detent
    else mediaKeys.volume(k.dir > 0 ? 1 : -1);
  } else if (k.type === 'press' && k.index === 1) {
    if (m.knobTap === 'leftclick') mediaKeys.click('left');
    else if (m.knobTap === 'enter') mediaKeys.tapKey('enter');
    else if (m.knobTap === 'rightclick') mediaKeys.click('right');
    else mediaKeys.volume('mute');
  }
}

function openConfigWindow() {
  if (configWin && !configWin.isDestroyed()) { configWin.show(); configWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;   // full usable screen height (minus taskbar)
  configWin = new BrowserWindow({
    width: 1180, height: wa.height, x: wa.x + 80, y: wa.y, title: 'open-quake Editor',
    backgroundColor: '#11151c',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'config-preload.js'),
    },
  });
  configWin.loadFile(path.join(__dirname, 'config.html'));
  configWin.on('closed', () => { configWin = null; });
  configWin.webContents.on('context-menu', (e, props) => {
    const sel = props.selectionText && props.selectionText.trim().length > 0;
    const editable = props.isEditable;
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: editable && sel },
      { role: 'copy', enabled: sel },
      { role: 'paste', enabled: editable },
      { type: 'separator' },
      { role: 'selectAll', enabled: editable || sel },
    ]);
    menu.popup({ window: configWin });
  });
}

// ---- device settings (knob RGB ring, mic) ----
function lighting() { return Object.assign({}, LED_DEFAULT, (config.settings || {}).lighting || {}); }
function applyKnobSettings() {
  if (ringOverrideState) { applyRingOverride(); return; }
  const L = lighting();
  const lig = (config.settings && config.settings.lighting) || {};
  let hue = L.hue, sat = L.sat;
  if (!lig.accentOverride) { const hs = hexToHsv255(themeGlobal().accent); if (hs) { hue = hs.hue; sat = hs.sat; } }   // ring follows the accent unless its color is overridden
  try { dev.setKnobLed(true); } catch (e) {}              // keep the ring from idle-sleeping (effect 0 = visually off)
  try { dev.setLedEffect(L.effect & 0xFF); } catch (e) {}
  try { dev.setLedBrightness(L.brightness & 0xFF); } catch (e) {}
  try { dev.setLedSpeed(L.speed & 0xFF); } catch (e) {}
  try { dev.setLedColor(hue & 0xFF, sat & 0xFF); } catch (e) {}
  if (L.effect) lastRingEffect = L.effect;
}
// ---- ring override (Claude Code voice states) ----
// A served page signals its state via console.log('OQX_RING::<state>') (caught in index.js, funneled
// through the panelApi.setRingState IPC channel below). While an override is active it wins over the
// normal theme-driven ring on every applyKnobSettings() call (settings changes, app switches, etc. all
// route through that one function) so nothing else can silently clobber it mid-conversation. Colors
// echo the same palette used in claudevoiceview.html's status pill (--accent green / blue / --warn
// amber) so the on-screen status and the ring always agree. Brightness always follows the user's own
// lighting setting -- only hue/sat/effect/speed are state-driven.
const RING_STATES = {
  listening: { hue: 106, sat: 255, effect: 1, speed: 128 },   // solid green — mirrors the app's --accent
  thinking: { hue: 106, sat: 255, effect: 5, speed: 180 },    // breathing green — actively working
  speaking: { hue: 149, sat: 255, effect: 1, speed: 128 },    // solid blue — Claude is talking
  approval: { hue: 28, sat: 255, effect: 5, speed: 220 },     // breathing amber — needs a touch, mirrors --warn
};
let ringOverrideState = null;
function applyRingOverride() {
  const s = RING_STATES[ringOverrideState];
  if (!s) { ringOverrideState = null; applyKnobSettings(); return; }
  try { dev.setKnobLed(true); } catch (e) {}
  try { dev.setLedEffect(s.effect & 0xFF); } catch (e) {}
  try { dev.setLedBrightness(lighting().brightness & 0xFF); } catch (e) {}
  try { dev.setLedSpeed(s.speed & 0xFF); } catch (e) {}
  try { dev.setLedColor(s.hue & 0xFF, s.sat & 0xFF); } catch (e) {}
}
function setRingState(state) {
  if (!state || state === 'idle') { clearRingOverride(); return; }
  if (!RING_STATES[state]) return;   // unrecognized state string — ignore rather than guess at a mapping
  ringOverrideState = state;
  applyRingOverride();
}
function clearRingOverride() {
  if (!ringOverrideState) return;
  ringOverrideState = null;
  applyKnobSettings();
}
function applyMic(on) { try { dev.setMic(on); } catch (e) {} micState = !!on; refreshTray(); }
function toggleMic() { applyMic(!micState); }
function toggleKnobRing() {
  if (!config.settings) config.settings = {};
  const L = config.settings.lighting = lighting();
  if (L.effect === 0) L.effect = lastRingEffect || 1;     // turn back on -> restore the last effect
  else { lastRingEffect = L.effect; L.effect = 0; }        // turn off -> All Off
  saveConfig(); applyKnobSettings(); refreshTray();
}

// ---- screen rotation (auto-cycle pages) ----
function rotationCfg() {
  const r = (config.settings && config.settings.rotation) || {};
  return {
    enabled: !!r.enabled,
    interval: Math.max(5, Math.min(3600, parseInt(r.interval, 10) || 30)),
    cats: Object.assign({ grids: false, dashboards: false, apps: false }, r.cats || {}),
    hotkey: typeof r.hotkey === 'string' ? r.hotkey : '',
  };
}
function pageCategory(g) { return g.kind === 'web' ? 'dashboards' : g.kind === 'app' ? 'apps' : 'grids'; }
function rotationList() { const c = rotationCfg(); return config.grids.filter(g => g.rotate && c.cats[pageCategory(g)] && !g.hidden); }
function gotoGrid(id, persist) {
  if (!config.grids.some(g => g.id === id)) return;
  clearRingOverride();   // leaving whatever page set the override (if any) — always restore the normal ring
  config.activeGridId = id; if (persist) saveConfig(); pushToPanel();
}
// Force the dashboard webview's cookies to commit to disk. Chromium only lazily flushes (~30s / clean
// shutdown), so a login made shortly before the app closes or is replaced by the next build can be lost
// (Electron #8416) — which is why claude.ai logins didn't survive build swaps. Debounced after navigations.
function flushDashCookies() {
  clearTimeout(cookieFlushT);
  cookieFlushT = setTimeout(() => { try { if (dashSession) dashSession.cookies.flushStore(); } catch (e) {} }, 2000);
}
// Parse an Electron accelerator's modifier tokens into the robotjs key names we need to keyUp().
// Win32 RegisterHotKey can leave Ctrl/Shift/Alt/Win "stuck-held" in the OS's view after the hotkey
// fires (the keyup events don't always reach the foreground app), so we synthesize a release for
// each modifier in the accelerator the moment the hotkey fires. No-op on non-Windows.
function modifiersInAccelerator(accel) {
  const out = [];
  const lower = String(accel || '').toLowerCase().split('+').map(t => t.trim());
  if (lower.some(t => t === 'ctrl' || t === 'control' || t === 'commandorcontrol' || t === 'cmdorctrl')) out.push('control');
  if (lower.includes('shift')) out.push('shift');
  if (lower.some(t => t === 'alt' || t === 'option')) out.push('alt');
  if (lower.some(t => t === 'super' || t === 'meta' || t === 'cmd' || t === 'command')) out.push('command');
  return out;
}

// Per-page global hotkeys: register each page's `shortcut` so pressing it (system-wide) jumps the panel
// to that page. Re-applied on launch and after every editor save; a combo another app owns just fails to
// register (logged). Requires app-ready.
function applyShortcuts() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  for (const g of (config.grids || [])) {
    if (!g.shortcut) continue;
    try {
      const ok = globalShortcut.register(g.shortcut, () => {
        // Release any held modifiers BEFORE the gotoGrid work so the OS sees them released
        // immediately, not after async window/IPC churn. See modifiersInAccelerator above.
        if (process.platform === 'win32') modifiersInAccelerator(g.shortcut).forEach(m => mediaKeys.keyUp(m));
        gotoGrid(g.id, true);
        // "Disables rotation": same path as the knob/tray toggle, so tray + panel state update
        // and rotation stays off until the user starts it again.
        if (g.shortcutStopsRotation) setRotation(false);
        else if (rotateRunning) scheduleRotation();
      });
      if (!ok) console.log('shortcut already in use, not registered:', g.shortcut, '->', g.id);
    } catch (e) { console.log('shortcut register error:', g.shortcut, '-', e.message); }
  }
  // Rotation toggle hotkey: same start/stop path as the knob, tray, and panel, so all three stay in sync.
  // Only registered while auto-rotate is enabled — matches the tray item (which hides when it's off) and
  // avoids holding a global combo hostage for a feature that can't run. Page hotkeys register first, so a
  // combo used by both goes to the page.
  const rot = rotationCfg();
  if (rot.enabled && rot.hotkey) {
    try {
      const ok = globalShortcut.register(rot.hotkey, () => {
        if (process.platform === 'win32') modifiersInAccelerator(rot.hotkey).forEach(m => mediaKeys.keyUp(m));
        toggleRotation();
      });
      if (!ok) console.log('shortcut already in use, not registered:', rot.hotkey, '-> rotation toggle');
    } catch (e) { console.log('shortcut register error:', rot.hotkey, '-', e.message); }
  }
  // Dashboard reload hotkey: no on/off toggle (unlike rotation) -- just registers whenever a combo is set.
  const dashReload = dashboardReloadCfg();
  if (dashReload.hotkey) {
    try {
      const ok = globalShortcut.register(dashReload.hotkey, () => {
        if (process.platform === 'win32') modifiersInAccelerator(dashReload.hotkey).forEach(m => mediaKeys.keyUp(m));
        reloadActiveDashboard();
      });
      if (!ok) console.log('shortcut already in use, not registered:', dashReload.hotkey, '-> dashboard reload');
    } catch (e) { console.log('shortcut register error:', dashReload.hotkey, '-', e.message); }
  }
}
function rotateTick() {
  const ids = rotationList().map(g => g.id);
  if (ids.length < 2) return;                                  // nothing to cycle through
  gotoGrid(ids[(ids.indexOf(config.activeGridId) + 1) % ids.length], false);   // active not in list (-1) -> first
}
function scheduleRotation() {
  if (rotTimer) { clearTimeout(rotTimer); rotTimer = null; }
  if (!rotateRunning || rotationSuspended) return;
  rotTimer = setTimeout(() => { rotateTick(); scheduleRotation(); }, rotationCfg().interval * 1000);
}
function pushRotationState() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('rotation', { enabled: rotationCfg().enabled, running: rotateRunning });
}
function setRotation(on) { rotateRunning = !!on && rotationCfg().enabled; scheduleRotation(); refreshTray(); pushRotationState(); }
function toggleRotation() { setRotation(!rotateRunning); }
// Re-evaluate after a settings change: a fresh off->on starts it, off stops it, on->on keeps the runtime state
// (so a manual pause survives an unrelated save). interval/page changes are picked up by the (re)schedule.
function applyRotationSettings(wasEnabled) {
  const enabled = rotationCfg().enabled;
  if (!enabled) rotateRunning = false;
  else if (!wasEnabled) rotateRunning = true;
  scheduleRotation(); refreshTray(); pushRotationState();
}

// ---- keyboard shortcuts (System/Pages/Custom cheat-sheet app) ----
// customShortcuts is a global, shared-across-instances list (not per-page-app-options) — see
// docs/charter-keyshortcuts.md for why. Edited from Settings -> Software.
function customShortcutsCfg() {
  const list = (config.settings && config.settings.customShortcuts) || [];
  if (!Array.isArray(list)) return [];
  return list.map(r => ({
    shortcut: typeof (r && r.shortcut) === 'string' ? r.shortcut : '',
    description: typeof (r && r.description) === 'string' ? r.description : '',
  })).filter(r => r.shortcut || r.description);
}
// Live snapshot for the keyshortcuts app's /shortcuts fetch: the rotation toggle hotkey (the only
// hotkey not tied to a specific page), every page's own jump-to hotkey, and the custom cheat-sheet.
function keyboardShortcutsSnapshot() {
  const rot = rotationCfg();
  const pages = (config.grids || [])
    .filter(g => g.shortcut)
    .map(g => ({ id: g.id, name: g.name || g.id, shortcut: g.shortcut, stopsRotation: !!g.shortcutStopsRotation }));
  return {
    rotation: (rot.enabled && rot.hotkey) ? { hotkey: rot.hotkey } : null,
    pages,
    custom: customShortcutsCfg(),
  };
}

// ---- desktop focus (panel auto-follows the PC's foreground app) ----
function focusFollowCfg() { const f = (config.settings && config.settings.focusFollow) || {}; return { enabled: !!f.enabled, pauseRotation: !!f.pauseRotation }; }

// ---- dashboard reload hotkey ----
// Switching away from a dashboard and back doesn't reload it (index.js keeps the shared webview's
// src unchanged when the URL matches, so sessions/scroll state survive page switches) -- this is the
// deliberate way to force one anyway. Only acts on a currently-showing dashboard/web page.
function dashboardReloadCfg() { const d = (config.settings && config.settings.dashboardReload) || {}; return { hotkey: typeof d.hotkey === 'string' ? d.hotkey : '' }; }
function reloadActiveDashboard() {
  const g = activeGrid();
  if (g && g.kind === 'web' && panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('reloadDashboard');
}
// The page (if any) mapped to whatever app currently holds OS foreground focus, per desktopFocus.js's own
// debounced/committed value — not the raw poll, so this agrees with whatever page onForegroundAppChange last acted on.
function currentFocusMatch() {
  if (!focusFollowCfg().enabled) return null;
  const name = desktopFocus.getCommittedProcess();
  if (!name) return null;
  const lower = name.toLowerCase();
  return (config.grids || []).find(x => !x.hidden && Array.isArray(x.focusApps) && x.focusApps.some(a => String(a).toLowerCase() === lower)) || null;
}
// Re-derives (never toggles blindly) whether rotation should be held off for focus right now, so it self-corrects
// regardless of call order: settings changes, focus changes, and manual rotation on/off can all trigger this.
function refreshFocusRotationPause() {
  const shouldPause = !!(focusFollowCfg().pauseRotation && currentFocusMatch());
  if (shouldPause === rotationSuspended) return;
  rotationSuspended = shouldPause;
  scheduleRotation(); refreshTray(); pushRotationState();
}
// Debounced (desktopFocus.js) foreground-process change -> switch to the first visible page that maps it.
function onForegroundAppChange(procName) {
  if (!focusFollowCfg().enabled) return;
  const match = currentFocusMatch();
  if (match) gotoGrid(match.id, false);
  refreshFocusRotationPause();
}
function applyFocusFollowSettings() {
  if (focusFollowCfg().enabled) desktopFocus.start(onForegroundAppChange); else desktopFocus.stop();
  refreshFocusRotationPause();
}

// Tray icon — the app's desktop presence (the panel window deliberately skips the taskbar).
function trayMenu() {
  const ringOn = lighting().effect !== 0;
  const items = [
    { label: 'open-quake v' + app.getVersion(), enabled: false },
    { type: 'separator' },
    { label: 'Open editor', click: () => openConfigWindow() },
    { label: micState ? 'Mic: on — click to disable' : 'Mic: off — click to enable', click: () => toggleMic() },
    { label: ringOn ? 'Knob ring: on — click to turn off' : 'Knob ring: off — click to turn on', click: () => toggleKnobRing() },
  ];
  if (rotationCfg().enabled) items.push({ label: rotateRunning ? 'Auto-rotate: on — click to pause' : 'Auto-rotate: off — click to start', click: () => toggleRotation() });
  items.push(
    { label: monitorMode ? 'Monitor mode: on — click to return to panel' : 'Switch to monitor mode (use device as a normal monitor)', click: () => toggleMonitorMode() },
    { label: 'Re-place panel on device', enabled: !monitorMode, click: () => { try { dev.screenOn(); } catch (e) {} placePanel(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { try { dev.stop(); } catch (e) {} app.quit(); } },
  );
  return Menu.buildFromTemplate(items);
}
function refreshTray() { if (tray) tray.setContextMenu(trayMenu()); }
function createTray() {
  if (tray) return;
  let img;
  try {
    img = nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'icon.png')));
    if (process.platform === 'darwin') {
      img = img.resize({ width: 18, height: 18 });   // macOS menu bar wants a small icon — the raw 256px app logo rendered as an oversized blob by the notch
      img.setTemplateImage(true);                      // monochrome menu-bar glyph that adapts to light/dark (macOS HIG)
    }
  } catch (e) { img = nativeImage.createEmpty(); }
  tray = new Tray(img);
  tray.setToolTip('open-quake');
  refreshTray();
  tray.on('click', () => openConfigWindow());
}


// Single-instance lock — a 2nd launch must not spawn a rival panel window (it fights the running
// one over the device display → a white panel). Bail out; the running instance re-homes its panel.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);                                           // a copy already runs — force-exit now; this instance inits nothing
} else {
app.on('second-instance', () => {
  try { dev.screenOn(); } catch (e) {}
  placePanel();
  if (configWin && !configWin.isDestroyed()) { configWin.show(); configWin.focus(); }
  else openConfigWindow();
});

// Reload the HA cache from the configured haAuth credentials. Coalesces concurrent calls so the
// Auth-tab Refresh button + a boot-time auto-refresh can fire together without double-loading.
// Always resolves with the current cache (success OR a populated error state) — never rejects.
function refreshHaCache() {
  if (haRefreshInFlight) return haRefreshInFlight;
  const ha = (config.settings && config.settings.haAuth) || {};
  if (!ha.useHa) {
    haCache = { ok: false, ts: Date.now(), error: 'Use Home Assistant is off', dashboards: [], entities: [], areaRegistry: [], deviceRegistry: [], entityRegistry: [], floorRegistry: [], labelRegistry: [], states: {} };
    return Promise.resolve(haCache);
  }
  if (!ha.url || !ha.token) {
    haCache = { ok: false, ts: Date.now(), error: 'HA URL and token required (Auth tab)', dashboards: [], entities: [], areaRegistry: [], deviceRegistry: [], entityRegistry: [], floorRegistry: [], labelRegistry: [], states: {} };
    return Promise.resolve(haCache);
  }
  haRefreshInFlight = haClient.fetchAll(ha.url, ha.token).then(c => {
    haCache = c;
    console.log('[ha] cache: ' + c.dashboards.length + ' dashboards, ' + c.entities.length + ' entities, ' + c.areaRegistry.length + ' areas, ' + c.deviceRegistry.length + ' devices, ' + c.floorRegistry.length + ' floors, ' + c.labelRegistry.length + ' labels');
    return c;
  }).catch(e => {
    haCache = { ok: false, ts: Date.now(), error: e.message || String(e), dashboards: [], entities: [], areaRegistry: [], deviceRegistry: [], entityRegistry: [], floorRegistry: [], labelRegistry: [], states: {} };
    console.log('[ha] cache refresh failed: ' + (e.message || e));
    return haCache;
  }).finally(() => { haRefreshInFlight = null; });
  return haRefreshInFlight;
}

// Fetch a single entity's state (REST), cache it, and patch the synthesized entities[] slot if present.
// Used by phase-2 features that assign an entity to a button; not wired into any UI yet.
async function fetchHaEntityState(entityId) {
  const ha = (config.settings && config.settings.haAuth) || {};
  if (!ha.useHa || !ha.url || !ha.token) throw new Error('HA not configured');
  const s = await haClient.fetchEntityState(ha.url, ha.token, entityId);
  haCache.states[entityId] = s;
  const e = haCache.entities.find(x => x.entityId === entityId);
  if (e) { e.state = s.state; e.supportedFeatures = s.supportedFeatures; }
  return s;
}

app.whenReady().then(async () => {
  // safeStorage requires app-ready, so secrets loaded at module init are still encrypted strings in
  // `config` here — decrypt them in memory before anything reads a secret VALUE. If the on-disk form
  // is stale (plaintext secrets, or legacy v1 values the DPAPI backend should re-wrap as v2) and
  // encryption is available, rewrite it once.
  const needsMigration = secretStore.needsRewrite(config);
  config = secretStore.decryptConfig(config);
  if (secretStore.available()) {
    if (needsMigration) saveConfig();                        // migrate plaintext/legacy config to current at-rest form
  } else if (needsMigration) console.log('secret encryption unavailable — refusing to rewrite config secrets');
  try { powerSaveBlocker.start('prevent-display-sleep'); } catch (e) {}
  createTray();
  // SystemView: live local metrics server on 127.0.0.1 (OS-assigned port) + ensure the dashboard page.
  // Lazy-required so a metrics/load failure can never crash the rest of the app.
  try {
    sysserver = require('./sysserver');
    serverPort = await sysserver.start({
      onMedia: mediaKey, onLaunch: onAppLaunch, getGridTiles: getActiveAppTiles, getAppConfig: activeServedAppConfig,
      getOfficeData: officeGraph.getData, connectOffice: officeGraph.connect, onOfficeAction: officeActions.run,
      onOpenExternal: openExternalUrl, onMeetingAction: onMeetingActionRequest, appFolders: discoveredServedApps(),
      getMeetingState: meetingStateForPanel, onMeetingRecord: onMeetingRecordRequest,
      onMeetingLibrary: onMeetingLibraryRequest, resolveMeetingAudio: resolveMeetingAudioPath,
      getShortcuts: keyboardShortcutsSnapshot,
      // Voice-panel app registry: each entry gets the full /<appId>/* route surface (see
      // sysserver.js). voiceToken gates the claude approval hook's /approval-request long-poll.
      voiceApps: {
        'claude-voice': {
          htmlFile: 'claudevoiceview.html',
          handlers: claudeVoiceHost.handlers,
          voiceToken: claudeVoiceHost.adapter.hookToken(),
        },
        // Same page, same route surface, codex adapter behind it. No voiceToken: codex approvals
        // are in-band protocol requests, so the external-hook route doesn't exist for it.
        'codex-voice': {
          htmlFile: 'claudevoiceview.html',
          handlers: codexVoiceHost.handlers,
        },
        // Same page again, copilot's ACP adapter behind it. No voiceToken: same in-band posture as codex.
        'copilot-voice': {
          htmlFile: 'claudevoiceview.html',
          handlers: copilotVoiceHost.handlers,
        },
      },
    });
    ensureSystemViewPage(serverPort); ensureMusicPage(); ensureDropInDir();
    const haUrl = configureHaSchedule();
    console.log('SystemView + Music on http://127.0.0.1:' + serverPort + (haUrl ? ' · HA Schedule -> ' + haUrl : ''));

    // Meeting recorder: hidden capture window on its OWN session partition (persist:recorder) with
    // the loopback handler registered ONLY there (never the shared dashboards session). Created once
    // the server is up so it can load the served /recorder page from a trusted local origin.
    meetingRecorder = createMeetingRecorder({
      recorderUrl: () => 'http://127.0.0.1:' + serverPort + '/recorder',
      preloadPath: path.join(__dirname, 'recorder-preload.js'),
      setupRecorderSession: (sess) => {
        sess.setPermissionRequestHandler(handleDashboardPermissionRequest);   // grants getUserMedia mic for our local page
        enableLoopbackAudioCapture(sess, { onError: err => console.log('[meeting] loopback handler error:', err && err.message) });
      },
      resolveSettings: () => {
        const m = meetingSettings();
        return { meetingFolder: m.folder, micDevice: m.micDevice, echoGate: !!m.echoGate, silenceStopMin: m.silenceStopMin, autoRecord: !!m.autoRecord };
      },
      defaultFolder: defaultMeetingFolder,
      onState: (() => {   // fires on every state change; fetch calendar info on the idle->recording edge
        let wasRecording = false;
        return st => {
          if (st.recording && !wasRecording && st.file) { try { writeOutlookMeetingInfo(st.file); } catch (e) {} }
          wasRecording = !!st.recording;
        };
      })(),
      onRecordingComplete: name => { try { appendMeetingNameToRecording(name); } catch (e) {} },
      log: msg => console.log('[meeting] ' + msg),
    });
    meetingRecorder.ensureWindow();   // arm the hidden window so a call can start recording instantly
    startMicMonitor();

    // Transcription pipeline: library (list/delete), diarizer upload queue, and CLI analysis.
    // Lazy-required + individually try/caught like the recorder so a failure here can never take
    // down call control or recording.
    migrateLegacyMeetingWavs();
    try {
      meetingLibrary = require('./meetingLibrary').createMeetingLibrary({
        resolveFolders: resolveMeetingFolders,
        log: msg => console.log('[meeting] ' + msg),
      });
      meetingTranscriber = require('./meetingTranscribe').createMeetingTranscriber({
        resolveFolders: resolveMeetingFolders,
        resolveBaseUrl: resolveTranscribeBaseUrl,
        organizeByDate: () => !!meetingSettings().processedByDate,
        resolveThreshold: () => meetingSettings().transcribeThreshold,
        resolveMyName: () => meetingSettings().myName,
        log: msg => console.log('[meeting] ' + msg),
      });
      meetingAnalyzer = require('./meetingAnalyze').createMeetingAnalyzer({
        resolveFolders: resolveMeetingFolders,
        resolveAi: () => meetingSettings().analysisAi,
        promptPath: () => fs.existsSync(userMeetingPromptPath()) ? userMeetingPromptPath() : path.join(__dirname, 'meeting-analysis-prompt.md'),
        filingOptions: () => {
          const m = meetingSettings();
          return { separateRecurring: !!m.separateRecurring, separateTranscript: !!m.separateTranscript, useDetailsFolder: !!m.useDetailsFolder };
        },
        log: msg => console.log('[meeting] ' + msg),
      });
    } catch (e) { console.log('[meeting] transcription services failed to start:', e.message); }
  } catch (e) { console.log('local panel services failed to start:', e.message); }
  sweepIconCache();   // clean up orphaned URL-icon cache files left by prior sessions
  // Same idea for the approval hook: a crash (or a force-kill) skips before-quit's removal and strands
  // our entry in the user's global settings.json, where it would tax every Claude Code session on the
  // machine until the next panel session happened to clean it up. No voice session can be running this
  // early in startup, so anything still installed at boot is by definition a leftover.
  try { claudeVoiceApprovals.ensureHookRemoved(claudeVoiceLog); } catch (e) {}

  // Dashboard auth injection for the webview session. The active page's auth config drives it:
  //  - 'header'  -> add custom header(s) to requests to the dashboard host (bearer / Cloudflare Access / …)
  //  - 'basic'   -> send Authorization: Basic preemptively on every request (below), plus still answer
  //                 a real 401/WWW-Authenticate challenge if one comes (app.on('login') further down)
  // ('ha' token injection is done renderer-side; 'none' does nothing.)
  //
  // Basic Auth used to be challenge-response only (wait for 401 + WWW-Authenticate, then retry with
  // credentials — Electron's app.on('login') only fires on that exact exchange). Reverse-proxy SSO
  // layers like Authelia, Traefik forward-auth, etc. don't issue that challenge for an unauthenticated
  // request — they 302 straight to their own login page instead, so 'login' never fired and the
  // configured credentials never got sent. Sending the header preemptively (what curl -u and
  // wget --http-user do by default) works against both kinds of backend.
  dashSession = session.fromPartition('persist:dashboards');
  dashSession.setPermissionRequestHandler(handleDashboardPermissionRequest);
  dashSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const g = activeGrid();
    if (g && g.kind === 'web' && g.auth && hostMatches(g.url, details.url)) {
      const h = details.requestHeaders;
      if (g.auth.type === 'header') {
        (g.auth.headers || []).forEach(x => { if (x.name) h[x.name] = x.value; });
        return cb({ requestHeaders: h });
      }
      if (g.auth.type === 'basic' && (g.auth.user || g.auth.pass)) {
        h['Authorization'] = 'Basic ' + Buffer.from(`${g.auth.user || ''}:${g.auth.pass || ''}`).toString('base64');
        return cb({ requestHeaders: h });
      }
    }
    cb({});
  });
  app.on('login', (event, webContents, request, authInfo, callback) => {
    if (authInfo.isProxy) return;
    const g = activeGrid();
    if (g && g.kind === 'web' && g.auth && g.auth.type === 'basic' && hostMatches(g.url, request.url)) {
      event.preventDefault();
      callback(g.auth.user || '', g.auth.pass || '');
    }
  });
  app.on('web-contents-created', (e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('did-navigate', flushDashCookies);                             // commit cookies (e.g. a fresh login) to disk after the page settles
  });

  // Boot-time HA cache warmup. Fire and forget — UIs that need the cache (the dashboard picker,
  // future entity pickers) will see ok:false until this resolves; they can also kick a manual
  // refresh from the Auth tab. Skipped when Use HA is off or credentials are missing.
  if ((config.settings && config.settings.haAuth && config.settings.haAuth.useHa)) refreshHaCache();
  oauthHandler.scheduleAll();

  ipcMain.on('launch', (e, a) => { if (!isFrom(e, panelWin)) return; runAction(a); });
  ipcMain.on('volume', (e, v) => { if (!isFrom(e, panelWin)) return; mediaKeys.volume(v); });
  ipcMain.on('media', (e, cmd) => { if (!isFrom(e, panelWin)) return; mediaKey(cmd); });   // knob 'enter' on the music page -> play/pause
  ipcMain.on('switchGrid', (e, id) => { if (!isFrom(e, panelWin)) return; gotoGrid(id, true); if (rotateRunning) scheduleRotation(); });   // a manual pick resets the rotation timer
  ipcMain.on('toggleRotation', (e) => { if (!isFrom(e, panelWin)) return; toggleRotation(); });
  ipcMain.on('startRotation', (e) => { if (!isFrom(e, panelWin)) return; setRotation(true); });
  ipcMain.on('stopRotation', (e) => { if (!isFrom(e, panelWin)) return; setRotation(false); });
  ipcMain.on('gotoHome', (e) => { if (!isFrom(e, panelWin)) return; if (config.homePageId) gotoGrid(config.homePageId, false); });
  ipcMain.on('openConfig', (e) => { if (!isFrom(e, panelWin) && !isFrom(e, configWin)) return; openConfigWindow(); });
  ipcMain.on('introDone', (e) => { if (!isFrom(e, panelWin)) return; config.introShown = true; saveConfig(); });   // remember the intro was dismissed
  ipcMain.on('saveTileValue', (e, data) => {
    console.log('[counter] saveTileValue received:', JSON.stringify(data));
    if (!isFrom(e, panelWin)) { console.log('[counter] REJECTED: not from panelWin'); return; }
    if (!data || typeof data.gridId !== 'string' || !Number.isInteger(data.index) || typeof data.value !== 'string') {
      console.log('[counter] REJECTED: bad shape. gridId-type=', typeof (data&&data.gridId), 'index-type=', typeof (data&&data.index), 'index-isInt=', Number.isInteger(data&&data.index), 'value-type=', typeof (data&&data.value));
      return;
    }
    const g = (config.grids || []).find(x => x.id === data.gridId);
    if (!g) { console.log('[counter] REJECTED: no grid with id', data.gridId, '— grids are:', config.grids.map(x=>x.id)); return; }
    if (!Array.isArray(g.tiles) || !g.tiles[data.index]) { console.log('[counter] REJECTED: tile not found at index', data.index, 'in grid', data.gridId); return; }
    g.tiles[data.index].value = data.value;
    saveConfig();
    console.log('[counter] SAVED: grid', data.gridId, 'tile', data.index, '=', data.value);
  });
  ipcMain.on('openExternal', (e, url) => { if (!isFrom(e, panelWin) && !isFrom(e, configWin)) return; openExternalUrl(url); });
  ipcMain.on('ringState', (e, state) => { if (!isFrom(e, panelWin)) return; setRingState(state); });
  ipcMain.handle('getConfig', (e) => isFrom(e, configWin) ? configForRenderer(config) : null);
  ipcMain.handle('getAppVersion', (e) => isFrom(e, configWin) ? app.getVersion() : null);
  ipcMain.handle('listOAuthProviders', (e) => isFrom(e, configWin) ? oauthProviderPayload() : []);
  ipcMain.handle('connectOAuthProvider', async (e, provider, scopes) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    try { await oauthHandler.connect(provider, scopes); return { ok: true, providers: oauthProviderPayload() }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
  ipcMain.handle('disconnectOAuthProvider', async (e, provider) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    try {
      const r = await oauthHandler.revokeToken(provider);
      if (String(provider || '').toLowerCase() === 'microsoft' && sysserver) {
        sysserver.clearOfficeCapability();
        pushToPanel();
      }
      return Object.assign({}, r, { providers: oauthProviderPayload() });
    }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
  // HA cache: editor reads the registries + dashboards for picker UIs; refresh kicks a new fetchAll.
  // fetchHaEntityState is wired now for phase-2 features that assign an entity to a button.
  // Claude Code voice app: candidate project directories under `root` for the editor's picker
  // (Phase 3). Directories only (not files); silently returns [] for a missing/unreadable root
  // rather than throwing, since the field is free-editable and may not exist yet.
  ipcMain.handle('listProjectDirs', (e, root) => {
    if (!isFrom(e, configWin)) return [];
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(root, d.name))
        .sort((a, b) => a.localeCompare(b));
    } catch (err) { return []; }
  });
  ipcMain.handle('getHaCache', (e) => isFrom(e, configWin) ? haCache : null);
  ipcMain.handle('refreshHaCache', (e) => isFrom(e, configWin) ? refreshHaCache() : null);
  // Editor voice-app options: is the page's CLI actually installed? Lets the editor warn at
  // add-time instead of the user discovering a dead page on the panel later.
  ipcMain.handle('probeVoiceCli', (e, appId) => {
    if (!isFrom(e, configWin)) return null;
    try {
      if (appId === 'claude-voice') return findClaudeExe() || null;
      if (appId === 'codex-voice') return findCodexExe() || null;
      if (appId === 'copilot-voice') return findCopilotExe() || null;
    } catch (err) {}
    return null;
  });
  // "Edit prompt file" in the Claude Code page options: seed the template if needed, then open the
  // file in whatever the user's default .md editor is.
  ipcMain.handle('editClaudeVoicePrompt', (e) => {
    if (!isFrom(e, configWin)) return null;
    try { const p = claudeVoiceHost.adapter.ensureUserPromptFile(); shell.openPath(p); return p; }
    catch (err) { claudeVoiceLog('panel prompt open failed: ' + err.message); return null; }
  });
  // Same pattern for the meeting-analysis prompt: the editable copy lives in userData (the bundled
  // template inside the packaged app can't be edited), seeded on first use.
  ipcMain.handle('editMeetingAnalysisPrompt', (e) => {
    if (!isFrom(e, configWin)) return null;
    try { const p = ensureMeetingPromptFile(); shell.openPath(p); return p; }
    catch (err) { console.log('[meeting] prompt open failed: ' + err.message); return null; }
  });
  // "Check Connection" on the Meeting tab verifies the selected calendar source. Classic Outlook
  // also enumerates accounts/folders; Microsoft 365 reports the delegated signed-in profile.
  ipcMain.handle('checkOutlookMeetings', async (e, source) => {
    if (!isFrom(e, configWin)) return null;
    if (source === 'microsoft365') {
      try { return await officeGraph.checkConnection(); }
      catch (err) { return { ok: false, error: err.message || String(err), code: err.code || '' }; }
    }
    return new Promise(resolve => {
      if (!fs.existsSync(OUTLOOK_MEETING_EXE)) return resolve({ ok: false, error: 'outlook-meeting.exe missing (native helpers not built)' });
      execFile(OUTLOOK_MEETING_EXE, ['check'], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message });
        try { resolve(JSON.parse(String(stdout))); } catch (e2) { resolve({ ok: false, error: 'helper returned unreadable output' }); }
      });
    });
  });
  ipcMain.handle('fetchHaEntityState', (e, entityId) => {
    if (!isFrom(e, configWin)) return null;
    return fetchHaEntityState(entityId).catch(err => ({ error: err.message || String(err) }));
  });
  ipcMain.handle('getApps', (e) => {
    if (!isFrom(e, configWin)) return [];
    const catalog = appCatalog();
    try { if (sysserver && sysserver.setAppFolders) sysserver.setAppFolders(catalog.servedApps); } catch (er) {}
    return catalog.apps;
  });
  ipcMain.handle('saveConfigFromEditor', (e, newCfg) => {
    if (!isFrom(e, configWin) || !newCfg || typeof newCfg !== 'object' || !Array.isArray(newCfg.grids)) return { ok: false, error: 'invalid configuration' };
    const previousConfig = config;
    const active = config.activeGridId;                          // the knob owns the live page — editor edits never change it
    const wasRot = rotationCfg().enabled;                        // detect a fresh off->on to auto-start (else keep the runtime pause)
    const oauth = config.settings && config.settings.oauth;
    if (oauth) {
      if (!newCfg.settings) newCfg.settings = {};
      newCfg.settings.oauth = oauth;
    }
    config = newCfg;
    if (config.grids.some(g => g.id === active)) config.activeGridId = active;
    else if (!config.grids.some(g => g.id === config.activeGridId)) config.activeGridId = (config.grids[0] || {}).id || null;
    if (!saveConfig()) { config = previousConfig; return { ok: false, error: 'secure persistence failed' }; }
    pushToPanel(); applyKnobSettings(); refreshTray(); applyRotationSettings(wasRot); applyFocusFollowSettings(); applyShortcuts(); applyTheme();
    reservedDisplay.setEnabled(!!appSettings().reservedDisplay);
    configureHaSchedule();                                          // pick up any haAuth edits without a restart
    startMicMonitor();                                              // re-arm with any edited app allowlist
    if (meetingRecorder) meetingRecorder.setMic(meetingSettings().micDevice);   // push an edited mic to the recorder
    return { ok: true };
  });
  ipcMain.handle('pickProgram', async (e) => {
    if (!isFrom(e, configWin)) return null;
    const filters = process.platform === 'darwin'
      ? [{ name: 'Applications', extensions: ['app'] }, { name: 'All Files', extensions: ['*'] }]
      : [{ name: 'Programs', extensions: ['exe', 'lnk', 'bat', 'cmd', 'com'] }, { name: 'All Files', extensions: ['*'] }];
    const r = await dialog.showOpenDialog(configWin, { properties: ['openFile'], filters });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
  ipcMain.handle('pickImage', async (e) => {
    if (!isFrom(e, configWin)) return null;
    const r = await dialog.showOpenDialog(configWin, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'] }, { name: 'All Files', extensions: ['*'] }] });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
  // For "Open file/folder" tiles: a plain file picker (any file) and a folder picker. Windows can't show
  // both in one dialog, so the editor offers two buttons.
  ipcMain.handle('pickFile', async (e) => {
    if (!isFrom(e, configWin)) return null;
    const r = await dialog.showOpenDialog(configWin, { properties: ['openFile'], filters: [{ name: 'All Files', extensions: ['*'] }] });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
  ipcMain.handle('pickFolder', async (e) => {
    if (!isFrom(e, configWin)) return null;
    const r = await dialog.showOpenDialog(configWin, { properties: ['openDirectory'] });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
  // Drop-in app manager (Settings → Drop-In Apps)
  ipcMain.handle('listDropInApps', (e) => isFrom(e, configWin) ? listDropInApps() : []);
  ipcMain.handle('pickZip', async (e) => {
    if (!isFrom(e, configWin)) return null;
    const r = await dialog.showOpenDialog(configWin, { properties: ['openFile'], filters: [{ name: 'Zip archive', extensions: ['zip'] }] });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
  ipcMain.handle('importDropInApp', (e, zipPath, forceId, confirmExec) => isFrom(e, configWin) ? importDropInApp(zipPath, forceId, confirmExec) : { ok: false });
  ipcMain.handle('exportDropInApp', (e, id) => isFrom(e, configWin) ? exportDropInApp(id) : { ok: false });
  ipcMain.handle('deleteDropInApp', (e, id) => isFrom(e, configWin) ? deleteDropInApp(id) : { ok: false });
  ipcMain.handle('getDropInInfo', (e) => isFrom(e, configWin) ? { location: (config.settings && config.settings.dropInLocation) || 'appdata', dir: dropInDir() } : null);
  ipcMain.handle('setDropInLocation', (e, loc) => {
    if (!isFrom(e, configWin)) return null;
    if (!config.settings) config.settings = {};
    config.settings.dropInLocation = loc === 'localappdata' ? 'localappdata' : 'appdata';
    saveConfig(); ensureDropInDir();
    return { location: config.settings.dropInLocation, dir: dropInDir() };
  });
  ipcMain.handle('getAppIcon', (e, value) => isFrom(e, configWin) ? getAppIconDataUrl(value) : null);
  // Sync: editor preview reads a local image as a data: URL through main (the config preload is sandboxed,
  // so it can't touch fs). Same conversion the panel uses, so editor previews match the panel.
  ipcMain.on('imageToDataUrl', (e, filePath) => { e.returnValue = isFrom(e, configWin) ? (imageFileToDataUrl(filePath) || '') : ''; });
  // Meeting recorder window -> main. Guarded to the recorder window's own webContents so no other
  // page can inject PCM or spoof capture state.
  const fromRecorder = e => meetingRecorder && meetingRecorder.isRecorderSender(e.sender);
  ipcMain.on('recorder-ready', e => { if (fromRecorder(e)) meetingRecorder.onReady(); });
  ipcMain.on('recorder-pcm', (e, buf, meta) => { if (fromRecorder(e)) meetingRecorder.onPcm(buf, meta); });
  ipcMain.on('recorder-state', (e, state, detail) => { if (fromRecorder(e)) meetingRecorder.onRecorderState(state, detail); });
  ipcMain.on('recorder-ended', e => { if (fromRecorder(e)) meetingRecorder.onEnded(); });
  ipcMain.on('recorder-error', (e, m) => { if (fromRecorder(e)) meetingRecorder.onError(m); });
  ipcMain.handle('fetchIconUrl', (e, url) => isFrom(e, configWin) ? fetchIconToCache(url) : { ok: false, error: 'unauthorized' });
  ipcMain.handle('fetchMdiIcon', (e, name) => isFrom(e, configWin) ? fetchMdiToCache(name) : { ok: false, error: 'unauthorized' });
  // Bind the touchscreen to its physical display via multidigimon -touch (Windows). This launches
  // the built-in "Tap this screen with a single finger to identify it as a touch screen" wizard
  // that Microsoft hid behind the broken-in-24H2 Tablet PC Settings UI. The wizard writes a
  // persistent override under HKLM\SOFTWARE\Microsoft\Wisp\Pen\Digimon that survives primary-
  // display swaps, sleep, and reboot.
  ipcMain.handle('setupTouchscreen', async (e) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    if (process.platform !== 'win32') return { ok: false, error: 'Touchscreen setup is Windows-only.' };
    return touchSetup.runMultidigimon();
  });
  ipcMain.handle('clearTouchCalibration', (e) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    if (process.platform !== 'win32') return { ok: false, error: 'Touchscreen setup is Windows-only.' };
    return touchSetup.clearAllCalibrations();
  });

  // Knob RGB ring (QMK VIA / Bedrock). The editor's Settings page reads the device's current lighting,
  // then live-previews edits as the user drags. Both are gated to the config window (isFrom) like every
  // other device-control channel. (These were dropped by mistake in the b2ae172 security rewrite, which
  // kept the preload channels + renderer callers but lost the main-process handlers.)
  ipcMain.handle('getLighting', async (e) => {
    if (!isFrom(e, configWin)) return null;
    let cur = null;
    try { cur = await dev.getLighting(); } catch (er) {}
    return Object.assign({}, lighting(), cur && Object.keys(cur).length ? cur : {});
  });
  ipcMain.on('setLighting', (e, L) => {
    if (!isFrom(e, configWin)) return;
    if (!L) return;
    if (!config.settings) config.settings = {};
    config.settings.lighting = Object.assign({}, lighting(), L);
    if (config.settings.lighting.effect) lastRingEffect = config.settings.lighting.effect;
    saveConfig();
    try {
      if (L.effect != null) dev.setLedEffect(L.effect & 0xFF);
      if (L.brightness != null) dev.setLedBrightness(L.brightness & 0xFF);
      if (L.speed != null) dev.setLedSpeed(L.speed & 0xFF);
      if (L.hue != null && L.sat != null) dev.setLedColor(L.hue & 0xFF, L.sat & 0xFF);
    } catch (er) {}
    refreshTray();
  });
  ipcMain.handle('saveLightingToDevice', (e) => { if (!isFrom(e, configWin)) return false; try { return dev.saveLighting(); } catch (er) { return false; } });
  ipcMain.handle('listRunningApps', async (e) => isFrom(e, configWin) ? await desktopFocus.listRunningApps() : []);

  placePanel();
  reservedDisplay.setEnabled(!!appSettings().reservedDisplay);
  reservedDisplay.start();
  if (rotationCfg().enabled) setRotation(true);          // auto-start cycling on launch when enabled
  applyFocusFollowSettings();                             // auto-start foreground-app polling on launch when enabled
  applyShortcuts();                                       // register per-page global hotkeys
  applyTheme();                                           // set OS theme source (drives dashboards) + paint panel + knob accent
  nativeTheme.on('updated', () => { if (themeGlobal().appearance === 'system') applyTheme(); });   // follow the OS light/dark in System mode
  const ls = appSettings();
  if (firstRun || ls.launchMode === 'editor') openConfigWindow();
  else if (ls.launchMode === 'minimized') { openConfigWindow(); if (configWin && !configWin.isDestroyed()) configWin.minimize(); }
  // 'tray' -> stay quiet (tray + panel only)

  dev.on('touch', pts => {
    if (monitorMode) { const p = pts.find(q => q.action === 1) || pts[0]; if (p) injectTouch(p); return; }   // monitor mode: touch drives the Windows cursor
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('touch', pts);
  });
  dev.on('knob', k => {
    if (monitorMode) return monitorKnob(k);                                    // monitor mode: knob does the configured action (exit is tray-only)
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('knob', k);   // panel owns knob logic
  });
  dev.on('connect', async i => {
    console.log('connect:', i.iface);
    if (i.iface !== 'control') return;
    // First run: seed lighting from the device so we never change the ring unasked; otherwise the app's config wins.
    if (!config.settings || !config.settings.lighting) {
      try {
        const cur = await dev.getLighting();
        if (cur && Object.keys(cur).length) { if (!config.settings) config.settings = {}; config.settings.lighting = Object.assign({}, LED_DEFAULT, cur); saveConfig(); }
      } catch (e) {}
    }
    applyKnobSettings();
    applyMic(appSettings().micOnLaunch);
    // The mic indicator LED only latches once the panel is fully awake. At connect the device is still
    // mid screen-on activation (screenOn fires at 0/300/800/1500ms), so this first setMic toggles the
    // audio but the LED is dropped. Re-assert after activation settles — screenOn then setMic — which
    // mirrors what a display re-wake does and forces the LED to follow the mic state.
    setTimeout(() => { try { dev.screenOn(); } catch (e) {} applyMic(micState); console.log('mic LED re-assert:', micState); }, 2000);
  });
  dev.on('error', e => console.log('dev error:', e.message));
  dev.start();

  screen.on('display-added', () => { dev.screenOn(); refreshReservedDisplay('display added'); setTimeout(placePanel, 800); });
  screen.on('display-removed', () => { dev.screenOn(); refreshReservedDisplay('display removed'); });
  screen.on('display-metrics-changed', () => { refreshReservedDisplay('display metrics changed'); setTimeout(placePanel, 500); });
});
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  try { reservedDisplay.stop(); } catch (e) {}                // release WinEvent hooks and terminate the native helper
  try { claudeVoiceHost.shutdown(); } catch (e) {}       // terminate the claude CLI child, release held approvals, remove the global hook
  try { codexVoiceHost.shutdown(); } catch (e) {}        // terminate the codex app-server child
  try { copilotVoiceHost.shutdown(); } catch (e) {}      // terminate the copilot app-server child
  try { claudeVoiceApprovals.ensureHookRemoved(claudeVoiceLog); } catch (e) {}    // belt-and-braces: never leave our entry behind in the user's global Claude settings
  try { dev.stop(); } catch (e) {}                       // close HID devices + clear keep-alive/rescan timers — an open node-hid handle blocks process exit (Cmd+Q would hang -> force-quit)
  try { oauthHandler.stop(); } catch (e) {}              // stop OAuth callback server + background refresh timers
  try { stopMicMonitor(); } catch (e) {}                 // terminate the native mic-in-use monitor child
  try { if (meetingRecorder) meetingRecorder.dispose(); } catch (e) {}   // stop any recording + destroy the hidden capture window
  try { if (sysserver) sysserver.stop(); } catch (e) {}  // stop metrics timers + close the local server
  try { if (dashSession) dashSession.cookies.flushStore(); } catch (e) {}   // commit a fresh webview login to disk before exit
  try { globalShortcut.unregisterAll(); } catch (e) {}   // drop per-page hotkeys
});
