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

const { app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, screen, powerSaveBlocker, powerMonitor, ipcMain, shell, dialog, session, net, safeStorage, clipboard, globalShortcut, nativeTheme, Notification } = require('electron');

// Last-resort process backstops. Installed here, before any module below can open a connection or
// schedule async work, so a stray rejection/throw during boot (fire-and-forget chains like the HA
// warmup, OAuth scheduling, or a connector's HID enumeration path) can never hit Electron's silent
// default. This is a safety net, NOT a substitute for local handling; the paths that can throw
// should still guard themselves (see the connector enumeration guards + per-subsystem boot catches).
//
// Policy differs by class, deliberately:
//  - unhandledRejection: log + one generic signal, KEEP RUNNING. A stray rejection rarely corrupts
//    process state, and a tray/panel app should degrade rather than die on an isolated async fault.
//  - uncaughtException: an ESCAPED synchronous throw can leave Node invariants undefined, so we do
//    NOT keep running — log the detail, show one generic signal, then quit cleanly with a hard
//    process.exit fallback if the clean quit hangs.
// The visible signal is intentionally GENERIC (the class name only): the raw error can carry file
// paths or secret payloads and be unreadably long in a modal, so sanitized technical detail (name +
// code + bounded stack frames, no message/reason) goes to the log alone.
const shownFaultKinds = new Set();   // one visible signal per fault CLASS, not per occurrence (fault storms stay quiet)
let faultShuttingDown = false;
// Sanitized fault detail for the log. Deliberately EXCLUDES the raw message/reason: an error message
// or a rejection value can carry a token-bearing URL or a payload fragment, and the repo rule is that
// secrets never reach the log. We keep the error NAME + CODE (both validated to a safe charset) and a
// bounded set of stack FRAMES (the `at …` lines, which are file:line — the message line is dropped).
// A non-Error reason is logged by TYPE only, never by value.
function safeToken(s, fallback) {
  return typeof s === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s) ? s : fallback;
}
function faultDetail(err) {
  if (err instanceof Error) {
    const name = safeToken(err.name, 'Error');
    const code = err.code != null ? ' code=' + safeToken(String(err.code), 'n/a') : '';
    const frames = String(err.stack || '').split('\n').filter(l => /^\s*at\s/.test(l)).slice(0, 5).join(' | ');
    return name + code + (frames ? ' [' + frames + ']' : '');
  }
  return 'non-error reason (' + typeof err + ')';
}
function reportProcessFault(kind, err, fatal) {
  console.log((fatal ? '[fatal] ' : '[process-error] ') + kind + ': ' + faultDetail(err));   // sanitized — no raw message/reason
  if (!shownFaultKinds.has(kind)) {
    shownFaultKinds.add(kind);
    const tail = fatal ? '\n\nThe app will now close.' : '\n\nThe app is still running; some features may be degraded.';
    try { dialog.showErrorBox('open-quake', 'An unexpected background error occurred (' + kind + '). Details are in the log.' + tail); } catch (e) {}
  }
  if (fatal) faultShutdown();
}
function faultShutdown() {
  if (faultShuttingDown) return;
  faultShuttingDown = true;
  try { app.quit(); } catch (e) {}
  const t = setTimeout(() => { try { process.exit(1); } catch (e) {} }, 3000);   // hard fallback if a clean quit hangs
  if (t.unref) t.unref();                                                        // don't let the fallback timer itself keep us alive
}
process.on('uncaughtException', err => reportProcessFault('uncaughtException', err, true));
process.on('unhandledRejection', reason => reportProcessFault('unhandledRejection', reason, false));

// Degradation signals from the local server (sysserver.start's onDiagnostic hook). All NON-FATAL and
// kept NON-MODAL so a burst can't stack dialogs — #6's modal is reserved for true process faults.
// A port change (#9) means served-app pages get a new same-origin, so their per-origin localStorage
// (drop-in saves, high scores, settings) from the old port appears missing under the new origin —
// the data isn't deleted, and since the new port is persisted the old origin can stay inaccessible on
// later launches too — that's worth ONE tray notice. Route/server errors
// (#8) are logged and rate-limited only. The payload is already sanitized by sysserver (route
// pathname + validated error name; no query/body/secrets), so it is safe to log verbatim here.
let sawPortFallbackNotice = false;
let diagLogWindowAt = 0, diagLogCount = 0;
function onSysserverDiagnostic(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'port-fallback') {
    console.log('[sysserver] preferred port ' + ev.preferredPort + ' unavailable (' + ev.reason + '); using an ephemeral port');
    if (!sawPortFallbackNotice) {
      sawPortFallbackNotice = true;
      try { if (Notification.isSupported()) new Notification({ title: 'open-quake', body: 'The panel server changed ports; saved app data (drop-in saves, high scores, settings) may appear missing because the local app origin changed. The data was not deleted.', silent: true }).show(); } catch (e) {}
    }
    return;
  }
  const now = Date.now();                                          // rate-limit: at most 10 log lines / 10s so a failing route can't flood
  if (now - diagLogWindowAt > 10000) { diagLogWindowAt = now; diagLogCount = 0; }
  if (diagLogCount++ >= 10) return;
  if (ev.type === 'request-error') console.log('[sysserver] request failed: ' + ev.method + ' ' + ev.route + ' (' + ev.errorType + ')');
  else if (ev.type === 'server-error') console.log('[sysserver] server error: ' + ev.errorType);
}

// #5 per-subsystem boot isolation. Each optional server-dependent subsystem starts inside its own
// guard so a failure degrades ONLY that feature instead of skipping every subsystem after it. A
// failed stage is logged with SANITIZED detail (faultDetail — no raw message/secret) and collected;
// one non-modal notice at the end of boot names the degraded features. The individual stage refs are
// nulled on failure so the existing cross-stage null-checks (recorder<-highlights, slide<-recorder)
// keep holding.
const bootFailures = [];
function reportBootFailure(stage, err) {
  bootFailures.push(stage);
  console.log('[boot] ' + stage + ' failed to start: ' + faultDetail(err));
}
// Best-effort teardown of a subsystem that threw AFTER partial construction (e.g. ensureWindow /
// startMicMonitor / applySlideHotkeys failed once the object existed). Calls whichever teardown the
// object exposes — recorder + slide have a real dispose() that closes their hidden window; lucid only
// has stop() (halts capture but can't destroy its window), so this reduces, not always eliminates, a
// half-armed leak. All guarded because we're already on a failure path.
function disposeStage(obj) {
  if (!obj) return;
  try {
    if (typeof obj.dispose === 'function') obj.dispose();
    else if (typeof obj.destroy === 'function') obj.destroy();
    else if (typeof obj.stop === 'function') obj.stop();
  } catch (e) {}
}

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const HID = require('node-hid');
const emojilib = require('emojilib');   // emoji -> keyword array (MIT, muan/emojilib) — powers the tile editor's emoji search
const EMOJI_INDEX = Object.entries(emojilib).map(([em, kws]) => [em, kws.join(' ').toLowerCase()]);
const MultiKnob = require('./multiKnob');                                           // owns Aris68Connector + BedrockConnector; routes to whichever device is plugged in
const http = require('http');
const actionRunner = require('./actionRunner');
const { createMediaKeys } = require('./mediaKeys');
const { createSecretStore } = require('./secretStore');
const { OAuthHandler } = require('../src/auth/oauth-handler');
const { TokenStorage } = require('../src/auth/token-storage');
const { providers: oauthProviders, providerFor: oauthProviderFor, registerAppProvider, clearAppProviders, REDIRECT_URI: OAUTH_REDIRECT_URI } = require('../src/auth/providers');
const { GitHubService, GITHUB_ACCESS_SCOPES, normalizeClientId: normalizeGitHubClientId, normalizeSettings: normalizeGitHubSettings, parseRepository: parseGitHubRepository, validRef: validGitHubRef } = require('./githubService');
const { configForRenderer } = require('./oauthConfigBoundary');
const nowplaying = require('./nowplaying');   // same singleton sysserver polls — read its snapshot to target transport
const haClient = require('./haClient');       // Global HA cache (registries + dashboards); per-entity states fetched lazily
const touchSetup = require('./touchSetup');   // Bind a touchscreen to its physical display via tabcal.exe (Windows)
const meetingControl = require('./meetingControl');   // Zoom/Teams call-control keystrokes (Meeting app page)
const { createMeetingRecorder } = require('./meetingRecorder'); // hidden-window meeting recorder (mic + system loopback -> WAV)
const { createMeetingHighlights } = require('./meetingHighlights'); // mid-meeting highlight spans -> the recording's sidecar
const routines = require('./routines');       // saved AI routines: a prompt + which AI Chat page runs it
const deviceDiagnostics = require('./deviceDiagnostics'); // pure: classify the console's Display/Touch/Knob channels
const { shouldSweepIconFile, iconsOffline } = require('./iconCache'); // pure: launch-sweep keep rule + offline-icons gate
const { createSlideCapture } = require('./slideCapture');       // hidden-window slide capture (getDisplayMedia -> screenshots)
const { createLucidDictation } = require('./lucidtypeDictation'); // hidden-window LucidType dictation (mic + VAD -> Wyoming STT -> text)
const lucidWyoming = require('./claudevoice-wyoming');          // Wyoming STT client (transcribe) for dictation
const lucidAImod = require('./lucidtypeAI');                    // LucidType cleanup/rewrite AI routing (agents / OWUI / direct endpoint)
const lucidAI = lucidAImod.createLucidAI({ log: msg => console.log('[lucidtype-ai] ' + msg) });
const { enableLoopbackAudioCapture } = require('./loopback-audio'); // system-audio loopback display-media handler (recorder session only)
const desktopFocus = require('./desktopFocus');   // tracks the PC's OS-level foreground app; auto-switches the panel to a mapped page
const ahk = require('./ahk');                  // macro "ahk" step backend (shells out to an installed AutoHotkey.exe)
const { createReservedDisplay } = require('./reservedDisplay'); // Windows helper that keeps foreign windows off the panel display
const { createVoicePanelHost } = require('./voicepanel-host'); // generic voice-panel app host (state/SSE/speech/STT-TTS plumbing)
const { createClaudeVoiceAdapter } = require('./claudevoice-adapter'); // Claude Code session adapter (CLI spawn, events, approval hook)
const { createCodexVoiceAdapter, findCodexExe } = require('./codexvoice-session'); // OpenAI Codex session adapter (app-server JSON-RPC over stdio)
const { createCopilotVoiceAdapter, findCopilotExe } = require('./copilotvoice-session'); // GitHub Copilot CLI session adapter (ACP JSON-RPC over stdio)
const { findClaudeExe } = require('./claudevoice-session'); // CLI presence probe for the editor's voice-app warning
const { createOwuiVoiceAdapter } = require('./owuivoice-session'); // Open WebUI chat adapter (HTTP/SSE, no CLI)
const { createApiVoiceAdapter } = require('./apivoice-session'); // OpenAI-compatible API chat adapter (bring your own key, no CLI)
const { createLiveTranslateHost } = require('./livetranslate-host'); // Live Translate app host (Soniox token mint + save-to-file, no LLM)
const { createScreensaverHost } = require('./screensaver-host'); // Screensaver app host (media list + name->path resolution, no LLM)
const saverIdle = require('./screensaver-idle'); // pure screensaver auto-start/wake/swallow decisions
const owuiClient = require('./owuiClient'); // shared OWUI URL normalization + model-list probe
const { resolveRunMode, reservedDisplayEnabled } = require('./runMode'); // pure run-mode helpers (panel/software/monitor)
const { activePane, resolvePaneColumns, softwareWindowBounds } = require('./panes');    // pure pane resolution (software-mode page stacks, 1-2 columns)
const voiceConfig = require('./voiceConfig'); // global TTS/STT endpoints + per-page override resolution + legacy migration
const { DiscordService } = require('./discordService'); // local Discord desktop RPC; protocol stays behind this main-process service
const { DiscordOAuth } = require('./discordOAuth');
const { DiscordAppHost } = require('./discordAppHost');
const {
  DEFAULT_DISCORD_APPLICATION_ID, DISCORD_SCOPE_GROUPS, discordApplicationId,
  discordRequestedScopeGroups, discordRequestedScopes, discordUsesCustomApplication, normalizeDiscordSettings,
} = require('./discordSettings');
const { ObsService } = require('./obsService');                 // OBS Studio control (shared service)
const { normalizeObsSettings, obsWsUrl } = require('./obsSettings');
const appRepo = require('./appRepo');                            // pure helpers for repo install/update
const { safeAppEntry, appEntryUrlPath, safeEditorDeclaration } = require('./dropInPaths'); // contained drop-in manifest paths + editor declaration
const { knobDefaultFor, parseCustomRing } = require('./knobRouting');   // generic drop-in knob capability
const claudeVoiceApprovals = require('./claudevoice-approvals'); // required directly ONLY for the boot-time leftover-hook sweep below
const { createPresenceService } = require('./presenceService');           // busy light / HA presence fan-out
const { parseAppList, monitorAllowlist, routeMonitorMessage } = require('./micMonitorRouting');

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
let presenceService = null;   // busy-presence fan-out (Busylight / WLED / HA over MQTT); null until boot
let firstRun = false;     // set by loadConfig when there was no prior config (fresh install)
let micState = false;     // current device mic state (LED follows it)
let lastDeviceState = {};  // cached from the connector's 'state' events (firmware/luminance/mic) for the diagnostics page
let meetingRecorder = null;   // hidden-window meeting recorder (created once the panel server is up)
let slideCapture = null;      // hidden-window slide capture controller (created alongside the recorder)
let meetingHighlights = null; // mid-meeting highlight spans (created alongside the recorder)
let lucidDictation = null;    // hidden-window LucidType dictation controller (created alongside the recorder)
let lucidApplyFocusProc = '';  // foreground process captured at dictation start, so Apply can restore focus in software mode
const completedRecordings = new Set();   // basenames whose finalize (header patch) has finished — the only safe time to rename
let meetingLibrary = null;    // recordings list/delete/resolve for the panel's library screens
let meetingTranscriber = null; // FIFO diarizer-upload queue (meetingTranscribe.js)
let meetingAnalyzer = null;   // transcript → markdown analysis via claude/codex CLI (meetingAnalyze.js)
let micMonitorProc = null;    // native app-scoped mic-in-use monitor child process
let sysVolCache = null, sysVolProc = null, sysVolIdleTimer = null;   // cache of the real system volume (0-100), fed by the persistent watcher
let lastRingEffect = LED_DEFAULT.effect; // remembered so the tray on/off toggle can restore the prior effect
let rotateRunning = false;               // screen-rotation runtime on/off (starts per settings on launch)
let rotationSuspended = false;           // temporarily held off by desktop-focus (a mapped app currently has focus)
let rotTimer = null;
// Screensaver auto-start state. saverActive is ONLY ever set by the idle auto-start path — manual
// visits and rotation stops on the screensaver page never set it, so input is never swallowed there.
let saverActive = false, saverPrevGridId = null;   // auto-entered screensaver: swallow input + where wake returns
let saverSwallowUntil = 0, saverTouchHeld = false; // wake-gesture swallow state (grace window + finger-up tracking)
let saverTimer = null;                             // the 10s idle-check interval
let lastPanelInputAt = Date.now();                 // boot counts as input, so the saver waits one full idle period
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
const initialDiscordSettings = normalizeDiscordSettings((config.settings || {}).discord);
const discordOAuth = new DiscordOAuth({
  getClientId: () => discordApplicationId((config.settings || {}).discord),
  getRequestedScopes: () => discordRequestedScopes((config.settings || {}).discord),
  getTokens: () => oauthStorage.getTokens('discord'), setTokens: value => oauthStorage.setTokens('discord', value), deleteTokens: () => oauthStorage.deleteTokens('discord'),
  openExternal: url => shell.openExternal(url),
});
const discordService = new DiscordService({ clientId: discordApplicationId(initialDiscordSettings), autoReconnect: initialDiscordSettings.autoReconnect, oauth: discordOAuth });
const discordAppHost = new DiscordAppHost(discordService, {
  getSettings: () => normalizeDiscordSettings((config.settings || {}).discord),
  saveSettings: value => {
    if (!config.settings) config.settings = {};
    const previous = config.settings.discord;
    config.settings.discord = normalizeDiscordSettings(value);
    if (saveConfig()) return true;
    config.settings.discord = previous;
    return false;
  },
});
// OBS Studio control service: one shared connection that drives both the served switcher app and
// (Phase 2) the `obs` tile type. Password lives encrypted in config.settings.obs (secretStore).
function obsSettings() { return normalizeObsSettings((config.settings || {}).obs); }
const obsService = new ObsService({
  url: obsWsUrl(obsSettings()), password: obsSettings().password, autoReconnect: obsSettings().autoReconnect,
  getPanicConfig: () => { const o = (config.settings || {}).obs || {}; return { safeScene: o.panicScene || '', muteInputs: Array.isArray(o.panicMutes) ? o.panicMutes : [] }; },
});
// When OBS state changes, re-push the live grid so any `obs` tiles reflect it -- but only if the
// shown page actually has obs tiles, and throttled so a burst of OBS events is one repaint.
let obsPushTimer = null;
obsService.on('update', () => {
  const g = activeGrid();
  if (!g || !((g.tiles || []).some(t => t && t.type === 'obs'))) return;
  if (obsPushTimer) return;
  obsPushTimer = setTimeout(() => { obsPushTimer = null; pushToPanel().catch(() => {}); }, 120);
});
let panelWin = null, configWin = null, tray = null, welcomeWin = null;
let paneViews = [];   // software pane mode: one WebContentsView per stacked page (empty otherwise)
let swBounds = null;  // last NORMAL software-window bounds — rebuilds keep the user's position/size
let swMaximized = false;   // whether the software window was maximized — survives rebuilds too
let dashSession = null, cookieFlushT = null;   // dashboard webview session + a debounced cookie-store flush
const dev = new MultiKnob({ hid: HID });
let reservedRefreshTimer = null;
const reservedDisplay = createReservedDisplay({
  getDisplayState: reservedDisplayState,
  log: message => console.log('[reserved-display] ' + message),
});
// The AI Voice app = ONE app id ('ai-voice') with a per-page backend option, served by one generic
// voice-panel host instance PER BACKEND (state/transcript/SSE/speech/STT-TTS, see
// voicepanel-host.js), each driven by its own session adapter. Requests route to the backend host
// via the /ai-voice/<backend>/* sub-prefix (sysserver.js), and every host's deps only "own" grids
// whose options.backend matches — so a backgrounded backend never reads the active page's endpoints
// or repaints the ring (same isolation the four separate apps had before consolidation).
const claudeVoiceLog = message => console.log('[ai-voice:claude] ' + message);
const claudeVoiceHost = createVoicePanelHost({
  appId: 'ai-voice',
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
  deps: voiceBackendDeps('claude'),
});
const codexVoiceLog = message => console.log('[ai-voice:codex] ' + message);
const codexVoiceHost = createVoicePanelHost({
  appId: 'ai-voice',
  storageKey: 'codexVoice',
  log: codexVoiceLog,
  branding: {
    title: 'Codex',
    approvalTitle: '⚠ Codex wants to do something',
    turnFailedText: 'Turn failed to send — no folder set, or codex CLI not found.',
  },
  adapter: createCodexVoiceAdapter({ log: codexVoiceLog }),
  deps: voiceBackendDeps('codex'),
});
const copilotVoiceLog = message => console.log('[ai-voice:copilot] ' + message);
const copilotVoiceHost = createVoicePanelHost({
  appId: 'ai-voice',
  storageKey: 'copilotVoice',
  log: copilotVoiceLog,
  branding: {
    title: 'Copilot',
    approvalTitle: '⚠ Copilot wants to do something',
    turnFailedText: 'Turn failed to send — no folder set, or copilot CLI not found.',
  },
  adapter: createCopilotVoiceAdapter({ log: copilotVoiceLog }),
  deps: voiceBackendDeps('copilot'),
});
// Open WebUI over its OpenAI-compatible HTTP API — no CLI child, the adapter streams chat
// completions against the shared Auth-tab connection (settings.owui).
const owuiVoiceLog = message => console.log('[ai-voice:owui] ' + message);
const owuiVoiceHost = createVoicePanelHost({
  appId: 'ai-voice',
  storageKey: 'owuiVoice',
  log: owuiVoiceLog,
  branding: {
    title: 'Open WebUI',
    approvalTitle: '⚠ Open WebUI wants to do something',   // never shown — the adapter emits no approvals
    turnFailedText: "Turn failed to send — Open WebUI connection not configured (editor's Auth tab).",
    hasProject: false,
  },
  adapter: createOwuiVoiceAdapter({ resolveOwui: () => owuiSettings(), log: owuiVoiceLog }),
  deps: voiceBackendDeps('owui'),
});
// API endpoint — bring your own OpenAI-compatible endpoint + key (per-page options; the key stays
// in the main process, encrypted at rest).
const apiVoiceLog = message => console.log('[ai-voice:api] ' + message);
const apiVoiceHost = createVoicePanelHost({
  appId: 'ai-voice',
  storageKey: 'apiVoice',
  log: apiVoiceLog,
  branding: {
    title: 'AI Chat',
    approvalTitle: '⚠ The model wants to do something',    // never shown — the adapter emits no approvals
    turnFailedText: 'Turn failed to send — API endpoint not configured (this page’s settings).',
    hasProject: false,
  },
  adapter: createApiVoiceAdapter({ resolveApi: () => apiVoiceSettings(), log: apiVoiceLog }),
  deps: voiceBackendDeps('api'),
});
// The api backend's live connection config: the ACTIVE ai-voice page's options when its backend is
// 'api' (activeServedAppConfig fills manifest defaults and carries decrypted secrets).
function apiVoiceSettings() {
  const c = activeServedAppConfig('ai-voice');
  const o = c && c.options;
  if (!o || (o.backend || 'claude') !== 'api') return {};
  return { apiBaseUrl: o.apiBaseUrl, apiKey: o.apiKey, apiModel: o.apiModel };
}
// Live Translate (Tier 1): a captions page, NOT an agent -- a lightweight host with no LLM adapter,
// just Wyoming STT -> text + optional file save. Reuses the voice-panel deps for STT endpoint
// resolution (global settings.voice, or this page's Advanced override) and config persistence.
const liveTranslateHost = createLiveTranslateHost({
  appId: 'livetranslate',
  log: message => console.log('[livetranslate] ' + message),
  deps: voicePanelDeps('livetranslate'),
});
// Screensaver: media lists + name->path resolution for /screensaver/media (sysserver streams the
// bytes). Photos and videos live in separate folders; the defaults ship empty and are
// auto-created on first use.
const screensaverHost = createScreensaverHost({
  appId: 'screensaver',
  log: message => console.log('[screensaver] ' + message),
  // saverAutoStarted/wakeSaver: on touchscreens without the ARIS-68 touch interface the waking
  // tap lands INSIDE the page (main never sees it), so the page itself asks "did I auto-start?"
  // and posts the wake — see /screensaver/wake.
  deps: Object.assign(voicePanelDeps('screensaver'), {
    saverAutoStarted: () => saverActive,
    // Touch-only consoles (no ARIS-68 panel): tapping is the ONLY input, so any tap on the saver
    // page must leave it — auto-started or not (manual visit, rotation stop, boot-restore). On a
    // DK-QUAKE the knob leaves manual visits, so there tap keeps its advance-the-scene meaning.
    saverTapExits: () => dev.activeName() !== 'aris68',
    wakeSaver: () => {
      if (saverActive) { wakeFromSaver(); return true; }
      const g = activeGrid();
      if (!saverIdle.isScreensaverGrid(g)) return false;
      // Manual visit: no snapshot to restore — land on home / first visible, never the saver.
      let target = saverIdle.saverRestoreTarget(config, null);
      if (target === g.id) {
        const alt = (config.grids || []).find(x => !saverIdle.isScreensaverGrid(x) && !x.hidden);
        target = alt ? alt.id : null;
      }
      if (!target || target === g.id) return false;
      console.log('[screensaver] tap-exit from manual visit -> page ' + target);
      gotoGrid(target, false);
      return true;
    },
  }),
  defaultPhotosDir: path.join(app.getPath('userData'), 'screensaver-media', 'photos'),
  defaultVideosDir: path.join(app.getPath('userData'), 'screensaver-media', 'videos'),
});
// Shared main.js plumbing for a voice-panel host. The ring guards are the two-app arbitration:
// only the ON-SCREEN voice app may drive (or clear) the ring override -- a background app's
// session finishing must never repaint the ring under the active page. (Page changes already
// clear any override via gotoGrid.)
// Effective STT/TTS endpoints for the CURRENTLY-ACTIVE instance of `appId`: the global
// config.settings.voice unless that page overrides it (grid.options.voiceOverride). Returns blank
// hosts when the app isn't the active served page, so a backgrounded app never dials out.
function resolveVoiceEndpoints(appId) {
  return voiceConfig.resolveVoiceEndpoints(config.settings, (activeServedAppConfig(appId) || {}).options || null);
}
function voicePanelDeps(appId) {
  return {
    activeServedAppConfig: id => activeServedAppConfig(id),
    voiceEndpoints: () => resolveVoiceEndpoints(appId),
    activeGrid: () => activeGrid(),
    getConfig: () => config,
    saveConfig: () => saveConfig(),
    setRingState: state => { const g = activeGrid(); if (g && g.kind === 'app' && g.app === appId) setRingState(state); },
    clearRingOverride: () => { const g = activeGrid(); if (g && g.kind === 'app' && g.app === appId) clearRingOverride(); },
    getDocumentsPath: () => app.getPath('documents'),
  };
}
// Backend-scoped deps for the AI Voice hosts: each backend host only "owns" ai-voice grids whose
// options.backend matches, so config resolution, endpoint dialing, and ring overrides stay isolated
// per backend exactly as they were per app before the consolidation.
function aiVoiceOwnsGrid(backend) {
  return g => !!(g && g.kind === 'app' && g.app === 'ai-voice' && ((g.options && g.options.backend) || 'claude') === backend);
}
function voiceBackendDeps(backend) {
  const owns = aiVoiceOwnsGrid(backend);
  return {
    activeServedAppConfig: () => (owns(activeGrid()) ? activeServedAppConfig('ai-voice') : null),
    voiceEndpoints: () => voiceConfig.resolveVoiceEndpoints(config.settings,
      owns(activeGrid()) ? ((activeServedAppConfig('ai-voice') || {}).options || null) : null),
    activeGrid: () => activeGrid(),
    getConfig: () => config,
    saveConfig: () => saveConfig(),
    setRingState: state => { if (aiVoiceOwnsGrid(backend)(activeGrid())) setRingState(state); },
    clearRingOverride: () => { if (aiVoiceOwnsGrid(backend)(activeGrid())) clearRingOverride(); },
    getDocumentsPath: () => app.getPath('documents'),
    ownsGrid: owns,
    // Panel Builder: after the user accepts a generated page, land on it so they see what they built.
    gotoGrid: id => gotoGrid(id, true),
  };
}
function appSettings() { return Object.assign({}, DEFAULT_SETTINGS, config.settings || {}); }
// Persisted run mode: how the app presents itself. 'panel' (frameless on the DK-QUAKE display),
// 'software' (normal resizable desktop window, no hardware needed), or 'monitor' (device shows the
// Windows desktop). Unset defaults to 'panel' so existing installs are unchanged — only a fresh
// install (firstRun) gets the welcome picker. Chosen at first run, changeable in Settings.
function runMode() { return resolveRunMode(config.settings); }
// Keep-display-awake: 'prevent-display-sleep' also stops the Windows screensaver, and there is no
// per-display option — so honor it ONLY in Panel mode and ONLY when the user turns it on in Settings.
// Off by default, so the OS screensaver works normally in Software/Monitor mode (and in Panel until opted in).
let displayBlockerId = -1;
function applyDisplayBlocker() {
  const want = !!(config.settings && config.settings.keepDisplayAwake) && runMode() === 'panel';
  try {
    const active = displayBlockerId !== -1 && powerSaveBlocker.isStarted(displayBlockerId);
    if (want && !active) displayBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    else if (!want && active) { powerSaveBlocker.stop(displayBlockerId); displayBlockerId = -1; }
  } catch (e) {}
}
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
function themePayload(g) { return Object.assign({}, effectiveTheme(g === undefined ? activeGrid() : g), { globalDark: effectiveTheme(null).dark }); }
function pushTheme() {
  const ap = activePaneNow();
  if (ap && paneViews.length) {
    paneViews.forEach((v, i) => { const g = ap.pages[i]; if (v && !v.webContents.isDestroyed() && g) v.webContents.send('theme', themePayload(g)); });
    return;
  }
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
// Panel-side IPC may come from the panel window OR (software pane mode) any of the stacked slot views.
function isFromPanel(e) { return isFrom(e, panelWin) || paneViews.some(v => v && !v.webContents.isDestroyed() && e.sender === v.webContents); }
// Everything currently showing the panel UI: the slot views in pane mode, else the panel window.
function panelSendTargets() {
  if (paneViews.length) return paneViews.filter(v => v && !v.webContents.isDestroyed()).map(v => v.webContents);
  return (panelWin && !panelWin.isDestroyed()) ? [panelWin.webContents] : [];
}

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
  if (!c.settings) c.settings = {};
  if (!Array.isArray(c.panes)) c.panes = [];   // software-mode page stacks (see panes.js)
  c.settings.discord = normalizeDiscordSettings(c.settings.discord);
  c.settings.github = normalizeGitHubSettings(c.settings.github);
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
  voiceConfig.migrateVoiceConfig(c);   // legacy per-page wyoming* -> global config.settings.voice + per-page override
  voiceConfig.ensureAiProfiles(c);     // seed the Smart Profiles library once (user edits are never touched)
  voiceConfig.ensurePanelProfile(c);   // add Panel Builder to libraries that predate it (once — deletions stick)
  voiceConfig.ensureRoutines(c);       // drop half-saved routines so the tile picker never offers a dud
  return c;
}
// SystemView (System Monitor) is RETIRED: its metrics layer spawned continuous PowerShell
// children that endpoint security flags. New pages are never injected; a still-configured page
// keeps working as a URL but the server now serves a "retired" notice at / instead of the
// dashboard. Deleting the page in the editor removes the last trace.
function ensureSystemViewPage(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (!config.grids) config.grids = [];
  const existing = config.grids.find(g => g.id === 'sysview');
  if (existing && existing.url !== url) {                  // refresh the (dynamic) port so the notice renders, not a dead socket
    existing.url = url; saveConfig(); if (config.activeGridId === 'sysview') pushToPanel();
  }
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
// ponytail: first app page with a grid wins if a pane stacks two — upgrade to per-slot routing if hit.
async function getActiveAppTiles() {
  const g = visibleGrids().find(p => p && p.kind === 'app' && Array.isArray(p.tiles) && p.cols && p.rows);
  if (!g) return { cols: 2, rows: 2, tiles: [] };
  const resolved = await resolveGridIcons(Object.assign({}, g, { kind: 'grid' }));   // resolve icons (force the tile path)
  return { cols: g.cols, rows: g.rows, tiles: resolved.tiles || [] };
}
function onAppLaunch(i) {
  const g = visibleGrids().find(p => p && p.kind === 'app' && p.tiles && p.tiles[i]);
  if (g) { runAction(g.tiles[i]); return true; }
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
// Host capabilities a served drop-in may request via app.json "hostCapabilities". Anything not
// listed here is silently ignored at discovery (forward compatibility, and apps can never smuggle
// arbitrary strings into sysserver).
const KNOWN_HOST_CAPABILITIES = new Set(['pick-folder']);
// Host-mediated folder picker for /app-host/pick-folder. The dialog is host-constructed end to end:
// directory-selection only, fixed title, and the app influences nothing but an optional absolute
// defaultPath. Returns only what the user explicitly selected; no path is logged.
async function pickDropInFolder({ appId, defaultPath }) {
  const rec = discoveredServedApps()[appId];
  if (!rec || !Array.isArray(rec.hostCapabilities) || !rec.hostCapabilities.includes('pick-folder')) {
    return { ok: false, code: 'forbidden', error: 'app has not declared the pick-folder capability' };
  }
  const def = loadApps().find(a => a.id === appId);
  const options = { title: 'Choose a folder for ' + ((def && def.name) || appId), properties: ['openDirectory'] };
  if (typeof defaultPath === 'string' && defaultPath.length <= 4096 && /^([A-Za-z]:[\\/]|\\\\)/.test(defaultPath)) options.defaultPath = defaultPath;
  const r = await dialog.showOpenDialog(options);   // unparented: an HTTP request has no trustworthy owning window
  if (r.canceled || !Array.isArray(r.filePaths) || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
}
const appManifestWarnings = new Set();
function warnAppManifest(key, message) {
  if (appManifestWarnings.has(key)) return;
  appManifestWarnings.add(key);
  console.log(message);
}
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
    const editor = safeEditorDeclaration(manifest);
    if (manifest.editor && !editor) warnAppManifest('editor:' + appDir, 'ignoring invalid editor entry for app: ' + id);
    const def = Object.assign({}, manifest, {
      id, name: manifest.name || id, file: entry, entry, server: serverEntry || undefined,
      editor: editor || undefined,
      served: !!manifest.served, options: Array.isArray(manifest.options) ? manifest.options : [],
      _folder: true, _dir: appDir,
    });
    apps.push(def);
    ids.add(id);
    if (def.served) {
      servedApps[id] = {
        root: appDir, proxy: manifest.proxy || null,
        server: serverEntry ? path.join(appDir, serverEntry) : null, autoStart: !!manifest.serverAutoStart,
        // sanitized: only recognized capability names reach sysserver; unknown values are ignored
        hostCapabilities: Array.isArray(manifest.hostCapabilities)
          ? manifest.hostCapabilities.filter(c => KNOWN_HOST_CAPABILITIES.has(c)) : [],
      };
    }
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
// Zip/unzip for app import/export is pure JS (adm-zip) — the old Expand-Archive/Compress-Archive
// path spawned powershell.exe, which is both slower and one more PS event for endpoint security
// to squint at. adm-zip 0.5+ rejects path-traversal ("zip-slip") entry names on extract.
const AdmZip = require('adm-zip');
function unzipTo(zipPath, destDir) {
  try { new AdmZip(zipPath).extractAllTo(destDir, true); return true; }
  catch (e) { console.log('unzip failed: ' + (e && e.message)); return false; }
}
function zipDirTo(dir, zipPath, rootName) {
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(dir, rootName);   // rootName folder at the zip root, matching Compress-Archive -Path <dir>
    zip.writeZip(zipPath);
    return true;
  } catch (e) { console.log('zip failed: ' + (e && e.message)); return false; }
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
  const sources = readAppSources();
  return appCatalog().apps.filter(a => a._folder).map(a => {
    const src = sources[a.id] || null;
    return {
      id: a.id, name: a.name, served: !!a.served, hasServer: !!a.server,
      managed: !!(a._dir && path.resolve(a._dir).startsWith(base)),   // only user-data apps can be deleted/exported
      version: (src && src.version) || (typeof a.version === 'string' ? a.version : ''),
      source: src ? src.url : null,                                    // set = installed from a repo (Update available)
    };
  });
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
// `replaceId` (set only by the repo-update path): overwrite an existing managed app of that id in
// place instead of rejecting the id conflict -- the one code path serves fresh install and update.
async function importDropInApp(zipPath, forceId, confirmExec, replaceId) {
  if (typeof zipPath !== 'string' || !fs.existsSync(zipPath)) return { ok: false, error: 'file not found' };
  const tmp = path.join(USER_DIR, 'import-tmp-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    if (!unzipTo(zipPath, tmp)) return { ok: false, error: 'could not unzip' };
    const appRoot = findAppRoot(tmp);
    if (!appRoot) return { ok: false, error: 'no app.json / manifest.json found in the zip' };
    const mp = manifestPath(appRoot);
    let manifest; try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e) { return { ok: false, error: 'the manifest is not valid JSON' }; }
    const id0 = (manifest && typeof manifest.id === 'string') ? manifest.id.trim() : '';
    // #8: warn before installing anything that runs host code (a server module or bundled binaries/scripts).
    if (!confirmExec && (safeAppEntry(manifest.server) || folderHasExecutable(appRoot))) {
      return { ok: false, warnExec: true, id: id0, server: !!safeAppEntry(manifest.server) };
    }
    if (replaceId && id0 && id0 !== replaceId) return { ok: false, error: 'downloaded app id "' + id0 + '" does not match "' + replaceId + '"' };
    const finalId = ((forceId || id0) || '').trim();
    if (!SAFE_APP_ID.test(finalId)) return { ok: false, error: 'invalid app id (use lowercase letters, digits, _ or -)' };
    const taken = new Set(appCatalog().apps.map(a => a.id));
    const destDir = path.join(dropInDir(), finalId);
    const replacing = !!replaceId && finalId === replaceId;
    if (!replacing && (taken.has(finalId) || fs.existsSync(destDir))) {
      return forceId ? { ok: false, error: 'the id "' + finalId + '" is also taken' } : { ok: false, conflict: true, id: id0 || finalId };
    }
    if (replacing && fs.existsSync(destDir)) { try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: 'could not remove the old version' }; } }
    if (finalId !== id0) { manifest.id = finalId; try { fs.writeFileSync(mp, JSON.stringify(manifest, null, 2)); } catch (e) { return { ok: false, error: 'could not rewrite the manifest id' }; } }
    ensureDropInDir();
    try { fs.renameSync(appRoot, destDir); } catch (e) { copyDirSync(appRoot, destDir); }
    // Updated/installed files must actually run: drop the cached server module (its _shutdown is
    // called) so the next /app-api call loads the fresh server.js instead of the pre-update one,
    // then re-sync the folder map so serverAutoStart apps arm their fresh module immediately.
    try { if (sysserver) sysserver.invalidateAppServer(finalId); } catch (e) {}
    try { if (sysserver && sysserver.setAppFolders) sysserver.setAppFolders(discoveredServedApps()); } catch (e) {}
    return { ok: true, id: finalId, name: manifest.name || finalId };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
}
async function exportDropInApp(id) {
  const dir = folderAppDir(id);
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'app not found' };
  const r = await dialog.showSaveDialog(configWin, { defaultPath: id + '.zip', filters: [{ name: 'Zip', extensions: ['zip'] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const ok = zipDirTo(dir, r.filePath, path.basename(dir));
  return ok ? { ok: true, path: r.filePath } : { ok: false, error: 'could not create the zip' };
}
function deleteDropInApp(id) {
  const dir = folderAppDir(id);
  if (!dir) return { ok: false, error: 'app not found' };
  const base = path.resolve(dropInDir());
  if (!path.resolve(dir).startsWith(base + path.sep)) return { ok: false, error: 'only user-installed drop-in apps can be deleted here' };
  try { if (sysserver) sysserver.invalidateAppServer(id); } catch (e) {}   // shut down its server module (sockets/children)
  try {
    fs.rmSync(path.resolve(dir), { recursive: true, force: true }); setAppSource(id, null);
    try { if (sysserver && sysserver.setAppFolders) sysserver.setAppFolders(discoveredServedApps()); } catch (e) {}
    return { ok: true };
  }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// ---- install / update drop-in apps from a repository -----------------------------------------------
// Provenance registry: a single JSON map <id> -> { url, version } stored beside the drop-in apps (NOT
// inside each app folder, so it survives an in-place update and never ships in an exported zip). An
// entry marks an app as repo-installed and records the installed version, which the update check
// compares against the repo's index.json.
const DEFAULT_APP_REPO = 'https://github.com/TeeJS/open-quake/tree/main/community-apps';
const APP_ZIP_MAX = 25 * 1024 * 1024;
function appSourcesPath() { return path.join(dropInDir(), '.oqsources.json'); }
function readAppSources() { try { return JSON.parse(fs.readFileSync(appSourcesPath(), 'utf8')) || {}; } catch (e) { return {}; } }
function setAppSource(id, entry) {
  const s = readAppSources();
  if (entry) s[id] = entry; else delete s[id];
  try { ensureDropInDir(); fs.writeFileSync(appSourcesPath(), JSON.stringify(s, null, 2)); return true; } catch (e) { return false; }
}
function appRepoSetting() { return (config.settings && typeof config.settings.appRepo === 'string' && config.settings.appRepo.trim()) || DEFAULT_APP_REPO; }

// GET a URL as JSON via Electron's net stack (inherits system proxy/CA). Mirrors app/haClient.js.
async function fetchJson(url) {
  const r = await net.fetch(url, { method: 'GET', headers: { 'User-Agent': 'open-quake/' + app.getVersion(), Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return JSON.parse(await r.text());
}
// Download a URL to a file, size-capped, http(s)-only, redirect-following (modeled on fetchIconToCache).
function downloadToFile(url, dest, maxBytes, headers) {
  url = String(url || '').trim();
  return new Promise(resolve => {
    if (!/^https?:\/\//i.test(url)) return resolve({ ok: false, error: 'Only http(s) URLs are allowed.' });
    let req; try { req = net.request({ url, redirect: 'follow' }); } catch (e) { return resolve({ ok: false, error: 'That URL is not valid.' }); }
    req.setHeader('User-Agent', 'open-quake/' + app.getVersion() + ' (+https://github.com/TeeJS/open-quake)');
    if (headers) Object.keys(headers).forEach(k => req.setHeader(k, headers[k]));
    let done = false;
    const fail = msg => { if (done) return; done = true; try { req.abort(); } catch (e) {} resolve({ ok: false, error: msg }); };
    req.on('error', () => fail('Could not reach the repository.'));
    req.on('response', resp => {
      const status = resp.statusCode;
      if (status < 200 || status >= 300) { resp.resume(); return fail('Download failed (HTTP ' + status + ').'); }
      const chunks = []; let total = 0; const cap = maxBytes || APP_ZIP_MAX;
      resp.on('data', d => { total += d.length; if (total > cap) return fail('That app is too large (over ' + Math.round(cap / 1048576) + ' MB).'); chunks.push(d); });
      resp.on('error', () => fail('Error reading the download.'));
      resp.on('end', () => {
        if (done) return; done = true;
        try { fs.writeFileSync(dest, Buffer.concat(chunks)); resolve({ ok: true, path: dest }); }
        catch (e) { resolve({ ok: false, error: 'Could not write the download.' }); }
      });
    });
    req.end();
  });
}

// raw.githubusercontent.com sits behind a ~5-minute CDN cache; a unique query param makes every
// check/download fetch fresh, so a just-pushed version bump is installable immediately.
function bustCache(url) { return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now(); }
// The connected GitHub app's access token (repo scope), or '' if not connected. Used to read PRIVATE
// app repositories through the authenticated Contents API — the token never leaves the main process.
async function githubRepoToken() {
  try { const t = await oauthHandler.getValidAccessToken('github', GITHUB_ACCESS_SCOPES); return (t && t.accessToken) || ''; }
  catch (e) { return ''; }
}
function githubApiHeaders(token) {
  return { Accept: 'application/vnd.github.raw', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' };
}
async function fetchGithubRawJson(url, token) {
  const r = await net.fetch(url, { method: 'GET', headers: Object.assign({ 'User-Agent': 'open-quake/' + app.getVersion() }, githubApiHeaders(token)) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return JSON.parse(await r.text());
}
async function fetchRepoIndex(settingUrl) {
  if (!appRepo.isAllowedRepoUrl(settingUrl)) return { error: 'Only github.com app repositories are allowed for now.' };
  const base = appRepo.repoRawBase(settingUrl);
  if (!base) return { error: 'The app-repository URL is not a valid http(s) URL.' };
  // Public repos: anonymous raw fetch.
  try { return { base, apps: appRepo.parseIndex(await fetchJson(bustCache(appRepo.indexUrl(base)))) }; }
  catch (e) {
    // raw.githubusercontent 404s for a private repo when unauthenticated. Retry through the Contents API
    // with the connected GitHub app's token; if it works, downloads use the same authenticated path.
    const coords = appRepo.githubContentsCoords(settingUrl);
    const token = coords ? await githubRepoToken() : '';
    if (coords && token) {
      try { return { base, coords, authed: true, apps: appRepo.parseIndex(await fetchGithubRawJson(bustCache(appRepo.githubContentsUrl(coords, 'index.json')), token)) }; }
      catch (e2) { return { base, error: 'Could not load the private repository catalog (HTTP ' + (e2.message || e2) + '). Confirm the GitHub app is connected and has access to this repository.' }; }
    }
    const hint = coords ? ' If it is private, connect the GitHub app first (Settings → the GitHub page).' : '';
    return { base, error: 'Could not load the repository catalog: ' + (e.message || e) + '.' + hint };
  }
}

// List repo apps, annotated against what's installed (available / installed / update). `repoUrl` is the
// editor's current (possibly unsaved) field value; falls back to the saved setting.
async function listRepoApps(repoUrl) {
  const setting = (typeof repoUrl === 'string' && repoUrl.trim()) || appRepoSetting();
  const idx = await fetchRepoIndex(setting);
  if (idx.error) return { ok: false, error: idx.error };
  const byId = {}; listDropInApps().forEach(a => { byId[a.id] = a; });
  const apps = idx.apps.map(a => {
    const inst = byId[a.id];
    let state = 'available';
    if (inst) state = (inst.version && appRepo.cmpVersion(a.version, inst.version) > 0) ? 'update' : 'installed';
    return { id: a.id, name: a.name, description: a.description, version: a.version, server: a.server, installed: !!inst, installedVersion: inst ? inst.version : null, state };
  });
  return { ok: true, base: idx.base, apps };
}

async function downloadAndInstall(idx, entry, settingUrl, replaceId, confirmExec) {
  const tmpZip = path.join(USER_DIR, 'repo-dl-' + Date.now() + '.zip');
  let dl;
  if (idx.authed && idx.coords) {   // private repo: fetch the zip through the authenticated Contents API
    if (/^https?:\/\//i.test(entry.zip || '')) return { ok: false, error: 'A private repository must host each app zip in-repo, not at an external URL.' };
    const token = await githubRepoToken();
    if (!token) return { ok: false, error: 'The GitHub app is not connected.' };
    const zipName = String(entry.zip || (entry.id + '.zip')).replace(/^\/+/, '');
    dl = await downloadToFile(bustCache(appRepo.githubContentsUrl(idx.coords, zipName)), tmpZip, undefined, githubApiHeaders(token));
  } else {
    const url = appRepo.zipUrl(idx.base, entry);
    if (!url) return { ok: false, error: 'no download URL for "' + entry.id + '".' };
    dl = await downloadToFile(bustCache(url), tmpZip);
  }
  if (!dl.ok) return dl;
  try {
    const r = await importDropInApp(tmpZip, null, confirmExec, replaceId);
    if (r && r.ok) setAppSource(r.id, { url: settingUrl, version: entry.version });
    return r;
  } finally { try { fs.rmSync(tmpZip, { force: true }); } catch (e) {} }
}

async function installRepoApp(id, confirmExec, repoUrl) {
  const setting = (typeof repoUrl === 'string' && repoUrl.trim()) || appRepoSetting();
  const idx = await fetchRepoIndex(setting);
  if (idx.error) return { ok: false, error: idx.error };
  const entry = idx.apps.find(a => a.id === id);
  if (!entry) return { ok: false, error: '"' + id + '" is not in the repository.' };
  return downloadAndInstall(idx, entry, setting, null, confirmExec);
}

async function checkDropInUpdate(id) {
  const src = readAppSources()[id];
  if (!src || !src.url) return { ok: false, error: 'This app was not installed from a repository.' };
  const idx = await fetchRepoIndex(src.url);
  if (idx.error) return { ok: false, error: idx.error };
  const entry = idx.apps.find(a => a.id === id);
  if (!entry) return { ok: false, error: '"' + id + '" is no longer in the repository.' };
  return { ok: true, updateAvailable: appRepo.cmpVersion(entry.version, src.version) > 0, installedVersion: src.version, remoteVersion: entry.version };
}

async function updateDropInApp(id, confirmExec) {
  const src = readAppSources()[id];
  if (!src || !src.url) return { ok: false, error: 'This app was not installed from a repository.' };
  const idx = await fetchRepoIndex(src.url);
  if (idx.error) return { ok: false, error: idx.error };
  const entry = idx.apps.find(a => a.id === id);
  if (!entry) return { ok: false, error: '"' + id + '" is no longer in the repository.' };
  if (appRepo.cmpVersion(entry.version, src.version) <= 0) return { ok: true, upToDate: true, version: src.version };
  const r = await downloadAndInstall(idx, entry, src.url, id, confirmExec);
  return (r && r.ok) ? { ok: true, updated: true, id: r.id, name: r.name, version: entry.version } : r;
}
// Re-download and overwrite an installed repo app at whatever version the repo currently offers — the
// update path without the newer-version guard, for fixing a corrupted or half-installed app.
async function reinstallDropInApp(id, confirmExec) {
  const src = readAppSources()[id];
  if (!src || !src.url) return { ok: false, error: 'This app was not installed from a repository.' };
  const idx = await fetchRepoIndex(src.url);
  if (idx.error) return { ok: false, error: idx.error };
  const entry = idx.apps.find(a => a.id === id);
  if (!entry) return { ok: false, error: '"' + id + '" is no longer in the repository.' };
  const r = await downloadAndInstall(idx, entry, src.url, id, confirmExec);
  return (r && r.ok) ? { ok: true, reinstalled: true, id: r.id, name: r.name, version: entry.version } : r;
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

// Drop-in OAuth: a served app can declare an `oauth` block in its app.json ({ name, authUrl, tokenUrl,
// revokeUrl?, scopes[] }); we register it as an `app:<appid>` provider so the shared handler drives the
// whole PKCE/callback/refresh flow. sysserver hands each app's server.js a `context.oauth` bound to its
// OWN app id, so it can never name another app's or a built-in provider. The token is used in the main
// process (server.js), never returned to the renderer.
const OAUTH_APP_PID = id => 'app:' + String(id).toLowerCase();
function syncAppOAuthProviders() {
  clearAppProviders();
  loadApps().forEach(a => {
    const o = a && a._folder && a.served && a.oauth;
    if (!o || typeof o !== 'object') return;
    if (!/^https:\/\//i.test(o.authUrl || '') || !/^https:\/\//i.test(o.tokenUrl || '')) return;   // https endpoints only
    registerAppProvider({
      id: OAUTH_APP_PID(a.id), name: String(o.name || a.name || a.id),
      clientId: String(o.clientId || ''),
      authUrl: o.authUrl, tokenUrl: o.tokenUrl, revokeUrl: /^https:\/\//i.test(o.revokeUrl || '') ? o.revokeUrl : '',
      scopes: Array.isArray(o.scopes) ? o.scopes : [], redirectUri: OAUTH_REDIRECT_URI, usesPkce: true,
      accessTokenExpiresSkewMs: 5 * 60 * 1000,
    });
  });
}
function appOAuthDefinition(appId) {
  const id = String(appId || '').toLowerCase();
  if (!SAFE_APP_ID.test(id)) return null;
  syncAppOAuthProviders();
  return loadApps().find(a => a && a.id === id && a._folder && a.served && a.oauth && typeof a.oauth === 'object') || null;
}
const dropInOAuth = {
  status(appId) { const pid = OAUTH_APP_PID(appId); return oauthProviderFor(pid) ? oauthHandler.status(pid) : { provider: pid, configured: false, connected: false, scopes: [] }; },
  async connect(appId, scopes, creds) {
    const pid = OAUTH_APP_PID(appId);
    if (!oauthProviderFor(pid)) throw new Error('This app declares no OAuth provider');
    if (creds && creds.clientId) oauthStorage.setProviderSettings(pid, { clientId: String(creds.clientId), clientSecret: String(creds.clientSecret || '') });
    return oauthHandler.connect(pid, scopes);
  },
  disconnect(appId) { return oauthHandler.revokeToken(OAUTH_APP_PID(appId)); },
  getAccessToken(appId, scopes) { return oauthHandler.getValidAccessToken(OAUTH_APP_PID(appId), scopes); },
};
const githubService = new GitHubService({
  getSettings: () => Object.assign({}, (config.settings || {}).github, { clientId: oauthStorage.getProviderSettings('github').clientId || '' }),
  oauth: oauthHandler,
  openExternal: async value => openExternalUrl(value),
});
async function openAppServerExternal(value) {
  const raw = String(value || '');
  if (raw === 'ms-teams:' || raw === 'msteams:') {
    return new Promise(resolve => exec('start ' + raw, { windowsHide: true }, err => resolve(!err)));
  }
  let target;
  try { target = new URL(raw); } catch (e) { return false; }
  if (!['http:', 'https:', 'ms-teams:', 'msteams:'].includes(target.protocol)) return false;
  try { await shell.openExternal(target.href); return true; }
  catch (e) { console.log('app server open error:', e.message); return false; }
}
const dropInHost = Object.freeze({
  openExternal: openAppServerExternal,
  // Shared Home Assistant credentials (Settings → Auth) for drop-in server modules, so HA apps
  // don't ask the user to re-enter the URL/token per app. Server modules only — never the page.
  getHaAuth: () => {
    const ha = (config.settings && config.settings.haAuth) || {};
    return { url: ha.url || '', token: ha.token || '', useHa: !!ha.useHa };
  },
  launchApp: value => actionRunner.launchApp(value, actionDeps),
  focusTeams: () => meetingControl.focusTeamsWindow(),
  focusApp: names => meetingControl.focusProcessWindow(names),
  hasAppWindow: names => meetingControl.hasProcessWindow(names),
  tapCombo: combo => mediaKeys.tapCombo(combo),
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
    const capability = !sysserver ? '' : def.id === 'github' ? sysserver.issueGitHubCapability() : '';
    return 'http://127.0.0.1:' + serverPort + '/' + def.id + (qs ? '?' + qs : '') + (capability ? '#_cap=' + encodeURIComponent(capability) : '');
  }
  const file = def._folder ? path.join(def._dir, def.entry || def.file) : path.join(APPS_DIR, def.file);
  const opts = page.options || {};
  const gridHint = page.gridOn ? '_grid=1' : '';   // lets the page (e.g. a clock) make room for the native button strip
  const hash = [appOptionQuery(def, opts, o => o.type !== 'secret' && !o.serverOnly), themeParams(page), gridHint].filter(Boolean).join('&');
  return pathToFileURL(file).href + (hash ? '#' + hash : '');
}
// Optional interactive management page owned by a served drop-in. It stays on that app's
// loopback origin, so its existing /app-api and /app-host calls retain the same Referer and
// same-origin gates as the panel page; only the contained entry and editor surface hint differ.
function appEditorUrl(page) {
  const def = loadApps().find(a => a.id === page.app);
  if (!(def && def._folder && def.served && def.editor && def.editor.entry)) return 'about:blank';
  const opts = page.options || {};
  const qs = [
    appOptionQuery(def, opts, o => o.type !== 'secret' && !o.serverOnly),
    themeParams(page),
    '_surface=editor',
  ].filter(Boolean).join('&');
  return 'http://127.0.0.1:' + serverPort + '/apps/' + encodeURIComponent(def.id) + '/' + appEntryUrlPath(def.editor.entry) + '?' + qs;
}
function activeServedAppConfig(appId) {
  const g = visibleGrids().find(p => p && p.kind === 'app' && p.app === appId);
  if (!g) return null;
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
    // While the screensaver AUTO-started itself, the live activeGridId is the screensaver page —
    // persist the page the user was actually on instead, so a save (option write, editor save)
    // followed by a crash/relaunch never boots the panel into the screensaver. encryptConfig
    // clones, so the overlay object never touches the in-memory config.
    const persisted = (saverActive && saverIdle.isScreensaverGrid(activeGrid()))
      ? Object.assign({}, config, { activeGridId: saverIdle.saverRestoreTarget(config, saverPrevGridId) || config.activeGridId })
      : config;
    const serialized = JSON.stringify(secretStore.encryptConfig(persisted), null, 2);
    fs.writeFileSync(temporaryPath, serialized);
    fs.renameSync(temporaryPath, CONFIG_PATH);
    notifyEditorConfigChanged();
    return true;
  } catch (e) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (cleanupError) {}
    console.log('config save error: secure persistence failed');
    return false;
  }
}
// The editor holds its own snapshot of config and only writes it back on Save, so anything that
// changes config from OUTSIDE the editor (an accepted AI panel, a counter tile, a panel option) is
// invisible to an open editor — and worse, that editor's next Save would write the stale copy back
// and drop the change. Tell it to re-read. Suppressed while the editor's own save is in flight.
let editorSaveInFlight = false;
function notifyEditorConfigChanged() {
  if (editorSaveInFlight) return;
  if (configWin && !configWin.isDestroyed()) {
    try { configWin.webContents.send('configChangedExternally'); } catch (e) {}
  }
}
function activeGrid() { return config.grids.find(g => g.id === config.activeGridId) || config.grids[0] || { cols: 8, rows: 2, tiles: [] }; }
function gridList() { return config.grids.filter(g => !g.hidden).map(g => ({ id: g.id, name: g.name })); }
// Software pane mode: the pane being displayed (null in every other mode/state — see panes.js).
function activePaneNow() { return activePane(config.settings, config.panes, config.grids); }
// Everything that forces a software-window rebuild when a save changes it: pane on/off, which pane,
// and which pages it stacks (page count sets the window height and the number of slot views).
function paneRebuildKey() { const ap = activePaneNow(); return ap ? ap.pane.id + ':' + ap.columns.map(c => c.map(g => g.id).join(',')).join('|') : ''; }
function paneUsable(p) { return resolvePaneColumns(p, config.grids).some(c => c.length); }
// The ☰ selector's entries in pane mode: every pane that resolves to at least one page.
function paneList() { return (config.panes || []).filter(paneUsable).map(p => ({ id: p.id, name: p.name })); }
// Panes cycled by auto-rotation in pane mode: opted in AND resolving to at least one page.
function paneRotationList() { return (config.panes || []).filter(p => p.rotate && paneUsable(p)); }
// Switch the displayed pane — the pane analog of gotoGrid. Used by the top slot's ☰ selector
// (persist), pane hotkeys (persist), rotation and go-home (no persist, like page rotation). Also
// flips the software display to panes, so a pane hotkey works from Pages view too. The window
// rebuilds only when the visible stack actually changes (slot count sets the window height).
function gotoPane(id, persist) {
  if (!(config.panes || []).some(p => p.id === id)) return;
  if (runMode() !== 'software') return;                    // panes only exist in software mode
  if (!config.settings) config.settings = {};
  const before = paneRebuildKey();
  config.settings.softwareDisplay = 'pane';
  config.settings.activePaneId = id;
  if (persist) saveConfig();
  if (paneRebuildKey() !== before) applyPaneLive();
}
// The pages currently on screen: the pane's stacked pages in pane mode, else just the active page.
function visibleGrids() { const ap = activePaneNow(); return ap ? ap.pages : [activeGrid()]; }
// Tell the local server which served page(s) are on screen so it runs only those pages' pollers
// (Music now-playing) and idles the rest — no background polling while hidden.
function syncPollers(g) {
  if (!sysserver) return;
  const pages = monitorMode ? [] : (Array.isArray(g) ? g : g ? [g] : []);   // monitor mode -> panel hidden -> idle everything
  const apps = pages.filter(p => p && p.kind === 'app').map(p => p.app);
  try { sysserver.setActivePage(apps.filter(a => a === 'music' || a === 'office' || a === 'github')); } catch (e) {}
}

function oauthProviderPayload() {
  const standard = Object.keys(oauthProviders).map(id => {
    const p = oauthProviders[id];
    const settings = oauthStorage.getProviderSettings(id);
    return Object.assign({}, oauthHandler.status(id), {
      name: p.name,
      scopes: p.suggestedScopes || p.scopes,
      managedClient: !!p.clientId,
      hasClientSecret: !!settings.clientSecret,
      enabled: false,
    });
  });
  const discordSettings = normalizeDiscordSettings((config.settings || {}).discord);
  const discordTokens = oauthStorage.getTokens('discord');
  const discordConnected = !!(discordTokens && discordTokens.refreshToken);
  const discordGrantedScopes = discordTokens && discordTokens.scope ? String(discordTokens.scope).split(/\s+/).filter(Boolean) : [];
  const discordRequested = discordRequestedScopes(discordSettings);
  const discordGroups = discordRequestedScopeGroups(discordSettings);
  const discordReauthorizationRequired = discordConnected && (discordRequested.some(scope => !discordGrantedScopes.includes(scope))
    || (discordTokens.clientId && String(discordTokens.clientId) !== discordApplicationId(discordSettings)));
  standard.push({
    provider: 'discord', name: 'Discord', configured: !!discordApplicationId(discordSettings), connected: discordConnected,
    expiresAt: discordTokens && discordTokens.expiresAt || null,
    scopes: discordGrantedScopes.length ? discordGrantedScopes : discordRequested,
    requestedScopes: discordRequested, grantedScopes: discordGrantedScopes,
    capabilityGroups: Object.entries(DISCORD_SCOPE_GROUPS).map(([id, scopes]) => ({
      id, requested: discordGroups.includes(id), granted: scopes.every(scope => discordGrantedScopes.includes(scope)), scopes,
    })),
    customApplication: discordUsesCustomApplication(discordSettings),
    managedClient: !discordSettings.applicationIdOverride && !!DEFAULT_DISCORD_APPLICATION_ID,
    enabled: !!discordApplicationId(discordSettings), authState: discordService.getState().authState,
    reauthorizationRequired: discordReauthorizationRequired,
    identity: discordService.getState().authState === 'authenticated' ? discordService.getIdentity() : null,
  });
  return standard;
}

// Device Diagnostics served app: a live snapshot of the console's three physical channels
// (Display / Touch / Knob), device-agnostic across DK-QUAKE and bedrock-console. Reads the current
// HID enumeration + attached displays + cached firmware; the pure classifier decides pass/fail.
function getDeviceDiagnostics() {
  let hidDevices = [];
  try { hidDevices = HID.devices(); } catch (e) {}
  let displays = [];
  try { displays = screen.getAllDisplays().map(d => ({ width: d.bounds.width, height: d.bounds.height, id: d.id })); } catch (e) {}
  let activeName = null;
  try { activeName = dev && dev.activeName ? dev.activeName() : null; } catch (e) {}
  const snap = deviceDiagnostics.classify({ hidDevices, displays, activeName, firmware: lastDeviceState.firmware || null });
  snap.runMode = runMode();   // panel / software / monitor — the page notes when you're not on the device
  return snap;
}

// Short sentence on the panel's flash overlay. The only main-side way to tell someone standing at
// the device that a tap did not do what they expected -- a Windows toast is on the wrong screen.
function panelNotice(text) {
  if (!text) return;
  panelSendTargets().forEach(wc => { try { wc.send('notice', String(text)); } catch (e) {} });
}
// One of the five AI Voice hosts, by the backend its page is set to.
function voiceHostForBackend(backend) {
  return backend === 'codex' ? codexVoiceHost
    : backend === 'copilot' ? copilotVoiceHost
    : backend === 'owui' ? owuiVoiceHost
    : backend === 'api' ? apiVoiceHost
    : claudeVoiceHost;
}
// AI Routine tile (and macro step): switch the panel to the routine's AI Chat page and send its
// saved prompt as an ordinary turn -- so it answers with that agent's real tools and approvals.
//
// Order matters and is not incidental: onTurn refuses unless the target page is ALREADY the active
// grid (activeServedAppConfig), and gotoGrid sets config.activeGridId synchronously, so the two
// must run in this order in the same tick. The webview may still be navigating; that is fine,
// claudevoiceview replays the host-held transcript from /state when it finishes loading.
function runRoutine(routineId) {
  const r = routines.resolveRoutine(routineId, {
    routines: (config.settings || {}).routines,
    grids: config.grids,
  });
  if (!r.ok) { panelNotice(r.error); console.log('[routine] ' + r.error); return; }
  if (r.warning) panelNotice(r.warning);
  gotoGrid(r.pageId, true);
  const page = (config.grids || []).find(g => g.id === r.pageId) || {};
  const host = voiceHostForBackend((page.options && page.options.backend) || 'claude');
  if (!page.options) page.options = {};

  // Apply the routine's profile / mode / folder by writing them onto the page's options and letting
  // the session START read them -- NEVER via the live setProfile / setPermissionMode switches. On
  // claude those restart the process with `--resume <id>` to keep the conversation; before the first
  // turn there is nothing persisted to resume, so that path dies repeatedly with "No conversation
  // found with session ID". A fresh `start()` mints a new id and passes `--permission-mode` /
  // `--append-system-prompt` at launch -- clean, and it can never hit that error.
  let st = {};
  try { st = host.handlers.getState() || {}; } catch (e) {}
  const running = !!st.running;
  const curProfile = page.options.profilePick || '';
  const curMode = running ? (st.permissionMode || '') : (page.options.permissionMode || '');

  const plan = routines.planRoutineRun({ routine: r.routine, folder: r.folder, running, curProfile, curMode });
  Object.assign(page.options, plan.options);
  if (plan.persist) saveConfig();
  // A LIVE session only picks up a new profile / mode / folder by restarting; do it fresh (new id,
  // no `--resume`). A cold page needs no restart -- onTurn's lazy start reads the options just set.
  if (plan.restart) {
    try { host.handlers.sessionStart(r.folder || undefined); } catch (e) { console.log('[routine] session restart failed: ' + e.message); }
  }
  // speak:true -- the page's own speaker toggle decides whether the stream is actually played.
  let sent = null;
  try { sent = host.handlers.onTurn(r.routine.prompt, true); } catch (e) { console.log('[routine] ' + e.message); }
  if (!sent || !sent.ok) panelNotice('Could not start that routine on this page.');
  else console.log('[routine] ran "' + r.routine.name + '" on page ' + r.pageId);
}

async function pushToPanel() {
  const ap = activePaneNow();
  if (ap && paneViews.length) {
    // Pane mode: each slot view gets its own page + theme. The TOP slot also gets the pane list as
    // its "gridList" — its ☰ selector then switches panes the way it normally switches pages
    // (switchGrid arrives with a pane id; see the switchGrid handler). No intro/rotation sends.
    syncPollers(ap.pages);
    for (let i = 0; i < paneViews.length; i++) {
      const v = paneViews[i], g = ap.pages[i];
      if (!v || v.webContents.isDestroyed() || !g) continue;
      v.webContents.send('theme', themePayload(g));
      v.webContents.send('grid', await resolveGridIcons(g));
      if (i === 0) v.webContents.send('gridList', { grids: paneList(), activeId: ap.pane.id });
    }
    return;
  }
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
    if (iconsOffline(config.settings)) return resolve({ ok: false, error: 'Offline mode is on — icon downloads are disabled in Settings → Software.' });
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
  // Delete stale URL-icon downloads, but keep app-managed MDI glyphs (mdi-*.svg) even though no tile
  // records them -- they're a bounded, downloaded-once set, not per-tile orphans. See iconCache.js.
  for (const f of files) { if (shouldSweepIconFile(f, used)) { try { fs.unlinkSync(path.join(ICON_CACHE_DIR, f)); removed++; } catch (e) {} } }
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
  if (iconsOffline(config.settings)) return Promise.resolve({ ok: false, error: 'offline' });   // no outbound fetch; cached hit above still serves, else emoji fallback
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

// Live OBS state for an `obs` tile -> the panel view-model: a state class (colour) + a subtitle, plus
// a default label from the bound resource. Read from the service snapshot (sync); no per-tile I/O.
function applyObsTileState(out, t) {
  const s = obsService.getSnapshot();
  const act = t.obsAction || 'scene';
  out.tileState = ''; out.sub = '';
  if (s.connection !== 'connected') { if (!out.label && (act === 'scene' || act === 'mute')) out.label = t.value || ''; return; }
  if (act === 'scene') {
    if (t.value && t.value === s.programScene) { out.tileState = 'program'; out.sub = 'ON AIR'; }
    else if (s.studioMode && t.value && t.value === s.previewScene) { out.tileState = 'preview'; out.sub = 'PREVIEW'; }
    if (!out.label) out.label = t.value || 'Scene';
  } else if (act === 'mute') {
    const inp = (s.inputs || []).find(i => i.name === t.value);
    if (inp) { out.tileState = inp.muted ? 'muted' : 'live'; out.sub = inp.muted ? 'MUTED' : 'LIVE'; }
    if (!out.label) out.label = t.value || 'Mute';
  } else if (act === 'studioMode') { out.tileState = s.studioMode ? 'on' : ''; out.sub = s.studioMode ? 'STUDIO' : 'STUDIO OFF'; if (!out.label) out.label = 'Studio'; }
  else if (act === 'saveReplay') { out.sub = s.replay.active ? 'CLIP' : 'OFF'; if (!out.label) out.label = 'Save Clip'; }
  else if (act === 'cut') { if (!out.label) out.label = 'Cut'; }
  else if (act === 'auto') { if (!out.label) out.label = 'Auto'; }
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
    if (t.type === 'obs') applyObsTileState(out, t);
    return out;
  }));
}
// Knob behavior is configurable per page TYPE (grid / dashboard / app), with an optional per-page override.
// turn: 'pages' | 'volume' | 'scroll' | 'select' | 'app'   ·   click: 'rotation' | 'mute' | 'enter' | 'app'
// 'app' routes the gesture into the served page's window.oqKnob (generic drop-in knob capability);
// an app page whose manifest declares "knob": true defaults ALL gestures to 'app'. The user's
// per-page-type settings and the per-page override remain the final word.
const KNOB_DEFAULT = { turn: 'pages', click: 'rotation', dblclick: 'selector' };
function pageTypeOf(g) { return g.kind === 'app' ? 'app' : g.kind === 'web' ? 'dashboard' : 'grid'; }
function effectiveKnob(g) {
  const all = (config.settings && config.settings.knob) || {};
  const appDef = (g.kind === 'app' && g.app) ? loadApps().find(a => a.id === g.app) : null;
  const base = Object.assign({}, knobDefaultFor(g, appDef), all[pageTypeOf(g)] || {});
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
  if (a.type === 'obs') {
    // OBS tile: dispatch the picked action (scene/mute/studio/cut/auto/save-clip) to the shared service.
    console.log('launch:', a.label, '-> obs', a.obsAction || 'scene', a.value || '');
    try { await obsService.action(a.obsAction || 'scene', a.value); } catch (e) { console.log('obs action error:', e.message); }
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
    case 'routine': runRoutine(value); break;   // switch to the AI Chat page and send the saved prompt
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
    if (action === 'volup') { mediaKeys.volume(1); return { ok: true }; }      // the volume watcher reports the new level within a second
    if (action === 'voldown') { mediaKeys.volume(-1); return { ok: true }; }
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
const MEETING_DEFAULTS = { folder: '', processedFolder: '', processedByDate: false, transcribeUrl: '', analysisAi: 'claude', micDevice: '', echoGate: false, silenceStopMin: 0, autoRecord: false, recordApps: 'Zoom.exe,Teams.exe,ms-teams.exe', outlookEnabled: false, meetingInfoSource: 'classic', outlookAccount: '', outlookCalendar: 'Calendar', outlookSkipPrefixes: 'Canceled:', transcribeThreshold: '', myName: '', separateRecurring: false, appendMeetingName: false, separateTranscript: false, useDetailsFolder: false, transcribeHooksEnabled: false, preTranscribeCmd: '', postTranscribeCmd: '', taskListEnabled: false, taskListFolder: '', joplinEnabled: false, joplinUrl: '', joplinToken: '', joplinNotebook: 'NW Pipe', slideCaptureEnabled: false, slideAutoStartOnSelect: false, slideNotifications: true, slideHotkeyToggle: 'Ctrl+Alt+S', slideHotkeySelect: 'Ctrl+Alt+W', slideHotkeyManual: 'Ctrl+Alt+C', slideAppFilter: '', slideIdleStopMin: 30, highlightEnabled: false, panelsOpen: '', largeRecordButton: false, busyEnabled: false, busyApps: 'Zoom.exe,Teams.exe,ms-teams.exe,Webex.exe,slack.exe,Discord.exe', busyOnRecording: true, busyOffDelaySec: 5, busyLightEnabled: false, busyLightBusyColor: '#ff0000', busyLightFreeColor: '#00ff00', busyLightBrightness: 100, busyManualColor: '#a020f0', busyLightFreeOff: false, busySchedEnabled: false, busySchedDays: '1,2,3,4,5', busySchedStart: '08:00', busySchedEnd: '17:00', busySchedPerDay: false, busySchedTimes: {}, busyWledEnabled: false, busyWledHost: '', busyMqttEnabled: false, busyMqttUrl: '', busyMqttUser: '', busyMqttPassword: '', busyMqttBaseTopic: 'open-quake' };
function meetingSettings() { return Object.assign({}, MEETING_DEFAULTS, (config.settings || {}).meeting || {}); }
// Open WebUI connection (config.settings.owui, edited on the Auth tab): shared by the meeting
// Analysis-AI backend and the owui-voice panel app. apiKey is a secret — encrypted at rest by
// secretStore, plaintext in memory like haAuth.token.
const OWUI_DEFAULTS = { url: '', apiKey: '', model: '' };
function owuiSettings() { return Object.assign({}, OWUI_DEFAULTS, (config.settings || {}).owui || {}); }
// ---- LucidType dictation (Phase 1) ----
// Settings live on the lucidtype PAGE's own options (grid.options), like every other app — mic,
// hotkeys and notifications are all per-page. Dictation runs in the background, so it reads the
// lucidtype grid's options directly (not activeServedAppConfig, which is only the ACTIVE grid).
const LUCIDTYPE_DEFAULTS = { micDevice: '', notifyColorChange: false, notifyBeep: false, switchOnDictate: true, dictationHotkey: '', applyHotkey: '', applyStopsRecording: true, silenceMs: 400, startMode: 'clear',
  // Phase 2 — cleanup/rewrite AI
  aiBackend: 'claude', useEndpoint: false, endpoint: '', endpointKey: '', overrideModel: false, model: '', aiTimeoutMs: 30000,
  cleanupHotkey: '', cleanupPrompt: '', rewriteHotkey: '', rewriteMode: 'professional', rewriteCustomPrompt: '',
  rewritePromptProfessional: '', rewritePromptConcise: '', rewritePromptConfident: '' };
function lucidtypeGrid() { return (config.grids || []).find(x => x && x.kind === 'app' && x.app === 'lucidtype') || null; }
function lucidtypeSettings() { const g = lucidtypeGrid(); return Object.assign({}, LUCIDTYPE_DEFAULTS, (g && g.options) || {}); }
// STT/TTS endpoints for dictation: the lucidtype page's per-page override (Advanced settings) over the
// global config.settings.voice.
function lucidtypeVoiceEndpoints() { return voiceConfig.resolveLucidEndpoints(config.settings, config.grids); }
// Panel poller/SSE payload: dictation state + review state + the resolved STT endpoint + mic label.
function lucidStateForPanel() {
  const st = lucidDictation ? lucidDictation.state() : { dictating: false, transcript: '', seq: 0, review: { active: false } };
  const ep = lucidtypeVoiceEndpoints();
  const s = lucidtypeSettings();
  return { dictating: !!st.dictating, transcript: st.transcript || '', seq: st.seq || 0,
    review: st.review || { active: false }, rewriteMode: s.rewriteMode || 'professional',
    sttHost: ep.sttHost, sttPort: ep.sttPort, mic: s.micDevice || '' };
}
// Cleanup/Rewrite (Phase 2): kick off the transform, or drive the open review (apply/refine/cancel),
// or set the default rewrite mode from the panel's mode picker.
function onLucidCleanupRequest() { return lucidDictation ? lucidDictation.runCleanup() : { ok: false, error: 'not ready' }; }
function onLucidRewriteRequest() { return lucidDictation ? lucidDictation.runRewrite() : { ok: false, error: 'not ready' }; }
function onLucidReviewRequest(op, text) {
  if (!lucidDictation) return { ok: false, error: 'not ready' };
  if (op === 'apply') {
    const r = lucidDictation.applyReview(text);
    // Applying always drops the result on the clipboard too, so it can be pasted anywhere.
    if (r && r.ok) {
      try { clipboard.writeText(lucidDictation.currentText() || ''); }
      catch (e) { console.log('[lucidtype] clipboard copy on apply failed: ' + e.message); }
    }
    return r;
  }
  if (op === 'refine') return lucidDictation.refineReview(text);
  if (op === 'cancel') return lucidDictation.cancelReview();
  return { ok: false, error: 'unknown review op' };
}
function onLucidSetModeRequest(mode) {
  const m = ['professional', 'concise', 'confident', 'custom'].includes(mode) ? mode : 'professional';
  const g = lucidtypeGrid();
  if (!g) return { ok: false, error: 'no lucidtype page' };
  if (!g.options) g.options = {};
  g.options.rewriteMode = m;
  saveConfig();
  try { if (sysserver && sysserver.lucidBroadcast) sysserver.lucidBroadcast(lucidStateForPanel()); } catch (e) {}
  return { ok: true };
}
// Resolve the system prompt + backend options for a cleanup/rewrite call (injected into the controller).
// Rewrite prompt for a mode: the user's edited prompt for that style if set, else the built-in preset
// (custom falls back to the professional preset if the custom box is empty).
function lucidRewritePrompt(mode, s) {
  if (mode === 'custom') return String(s.rewriteCustomPrompt || '').trim() || lucidAImod.REWRITE_PRESETS.professional;
  const key = 'rewritePrompt' + mode.charAt(0).toUpperCase() + mode.slice(1);
  return String(s[key] || '').trim() || lucidAImod.REWRITE_PRESETS[mode] || lucidAImod.REWRITE_PRESETS.professional;
}
function lucidRunTransform({ kind, mode, text }) {
  const s = lucidtypeSettings();
  const systemPrompt = kind === 'rewrite'
    ? lucidRewritePrompt(mode, s)
    : (String(s.cleanupPrompt || '').trim() || lucidAImod.DEFAULT_CLEANUP_PROMPT);
  return lucidAI.transform(systemPrompt, text, {
    useEndpoint: !!s.useEndpoint, endpoint: s.endpoint, endpointKey: s.endpointKey,
    backend: s.aiBackend, model: (s.overrideModel || s.useEndpoint) ? String(s.model || '') : '',
    timeoutMs: Number(s.aiTimeoutMs) || 30000, owui: owuiSettings(),
  });
}
function onLucidDictationRequest(cmd, mode) {
  if (!lucidDictation) return { ok: false, error: 'not ready' };
  if (cmd === 'start') return lucidDictation.start(mode === 'append' || mode === 'clear' ? mode : '');
  if (cmd === 'stop') return lucidDictation.stop();
  return { ok: false, error: 'unknown command' };
}
function toggleLucidDictation() { if (lucidDictation) lucidDictation.toggle(); }
// Apply-text hotkey — mirrors the on-screen Apply. If a Cleanup/Rewrite review is open (Apply button
// showing), accept its proposal into the box (which also copies it to the clipboard). Otherwise just
// copy the box text to the clipboard so it can be pasted anywhere. No auto-paste at the cursor.
function lucidApply() {
  if (!lucidDictation) return { ok: false, error: 'not ready' };
  // "Apply text stops recording" (default on): end an in-progress dictation before applying.
  if (lucidtypeSettings().applyStopsRecording && lucidDictation.isDictating()) lucidDictation.stop();
  const st = lucidDictation.state();
  if (st.review && st.review.active) {
    if (st.review.status !== 'ready') return { ok: false, error: 'review not ready' };
    return onLucidReviewRequest('apply', st.review.proposed);
  }
  const text = lucidDictation.currentText();
  if (!text) return { ok: false, error: 'nothing to apply' };
  try { clipboard.writeText(text); } catch (e) { console.log('[lucidtype] clipboard write failed: ' + e.message); }
  return { ok: true };
}
function onLucidEditRequest(text) { if (lucidDictation) lucidDictation.setTranscript(text); return { ok: true }; }
// On-panel mic pick (Settings overlay): persist the label on the lucidtype page's options; applies on
// the next dictation start (same store the editor's mic picker writes to).
function onLucidSetMicRequest(label) {
  const g = lucidtypeGrid();
  if (!g) return { ok: false, error: 'no lucidtype page' };
  if (!g.options) g.options = {};
  g.options.micDevice = String(label == null ? '' : label);
  saveConfig();
  try { if (sysserver && sysserver.lucidBroadcast) sysserver.lucidBroadcast(lucidStateForPanel()); } catch (e) {}
  return { ok: true };
}
// State-change hook: capture the paste target + optionally switch to the page on the idle->dictating
// edge, and drive the tray recording indicator. (Tray swap + beep gating land with the settings/hotkey
// step; the tray helper is a safe no-op until then.)
let lucidWasDictating = false;
function onLucidState(st) {
  try { if (sysserver && sysserver.lucidBroadcast) sysserver.lucidBroadcast(lucidStateForPanel()); } catch (e) {}   // real-time push to the page (SSE)
  const now = !!(st && st.dictating);
  if (now && !lucidWasDictating) {
    try { lucidApplyFocusProc = desktopFocus.getCommittedProcess() || ''; } catch (e) { lucidApplyFocusProc = ''; }
    if (lucidtypeSettings().switchOnDictate) { const g = lucidtypeGrid(); if (g) gotoGrid(g.id, true); }
    setLucidTrayRecording(true);
  } else if (!now && lucidWasDictating) {
    setLucidTrayRecording(false);
  }
  lucidWasDictating = now;
}
function setLucidTrayRecording(on) {
  if (!lucidtypeSettings().notifyColorChange || !tray) return;   // only when the user enabled the indicator
  try {
    tray.setImage(on ? (trayImgRecording || trayImgNormal) : (trayImgNormal || nativeImage.createEmpty()));
    tray.setToolTip(on ? 'open-quake — dictating…' : 'open-quake');
  } catch (e) {}
}
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

// Real system-volume read for the meeting OUTPUT rail. ONE persistent `sysvolume.exe watch`
// process streams the level on change — the old path spawned the exe once per panel poll
// (~60 processes/min with the Meeting page open), which endpoint-security tools flag as
// malware-like churn. The watcher is demand-scoped without any page-tracking plumbing: each
// panel poll refreshes an idle timer, and 10s without a poll (page left / panel hidden) stops
// it. Never fabricates a level: cache stays null (panel shows "—") until the helper answers.
function stopVolumeWatcher() {
  if (sysVolIdleTimer) { clearTimeout(sysVolIdleTimer); sysVolIdleTimer = null; }
  if (sysVolProc) { try { sysVolProc.kill(); } catch (e) {} sysVolProc = null; }
  sysVolCache = null;
}
function ensureVolumeWatcher() {
  if (process.platform !== 'win32') return;
  if (sysVolIdleTimer) clearTimeout(sysVolIdleTimer);
  sysVolIdleTimer = setTimeout(stopVolumeWatcher, 10000);
  if (sysVolProc || !fs.existsSync(SYSVOL_EXE)) return;
  // stdin stays open (piped): the helper exits on stdin EOF, so it can never outlive the app.
  try { sysVolProc = spawn(SYSVOL_EXE, ['watch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (e) { sysVolProc = null; return; }
  let buf = '';
  sysVolProc.stdout.on('data', d => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const n = parseInt(buf.slice(0, nl).trim(), 10);
      buf = buf.slice(nl + 1);
      sysVolCache = (Number.isFinite(n) && n >= 0) ? n : null;
    }
  });
  sysVolProc.on('error', () => {});
  sysVolProc.on('close', () => { sysVolProc = null; sysVolCache = null; });   // next panel poll respawns it
}

// State the panel poller reads: recorder runtime state + the configured mic (so the page loads with
// the editor-chosen mic as its default even when idle) + the auto-record flag.
function meetingStateForPanel() {
  const st = meetingRecorder ? meetingRecorder.getState() : { recording: false, startedAt: null, durationMs: 0, file: null, app: null, mic: '' };
  const m = meetingSettings();
  st.mic = st.mic || m.micDevice || '';
  st.autoRecord = !!m.autoRecord;
  ensureVolumeWatcher();       // keeps the persistent volume watcher alive while the panel polls
  st.volume = sysVolCache;     // 0-100, or null when unavailable (panel shows "—")
  st.slide = slideCapture ? slideCapture.getState() : { enabled: false };   // drives the slide-capture column
  st.highlight = meetingHighlights ? meetingHighlights.getState() : { enabled: false };   // drives the highlight column
  st.panelsOpen = m.panelsOpen || '';   // which utility columns to restore on page load
  st.largeRecord = !!m.largeRecordButton;   // show the big Record button
  st.busy = presenceService ? presenceService.getState() : { enabled: false };   // drives the busy column beside Hang Up
  return st;
}
// Panel remote for mid-meeting highlights (start/stop/cancel), reached over HTTP via sysserver.
function onHighlightRequest(cmd) {
  if (!meetingHighlights) return { ok: false, error: 'highlights unavailable' };
  if (cmd === 'start') return { ok: true, state: meetingHighlights.start() };
  if (cmd === 'stop') return { ok: true, state: meetingHighlights.stop() };
  if (cmd === 'cancel') return { ok: true, state: meetingHighlights.cancel() };
  return { ok: false, error: 'unknown highlight command: ' + cmd };
}
// Panel remote for slide capture (windows/select/start/stop/manual), reached over HTTP via sysserver.
async function onSlideRequest(cmd, arg) {
  if (!slideCapture) return { ok: false, error: 'slide capture unavailable' };
  if (cmd === 'windows') return { ok: true, windows: await slideCapture.listWindows() };
  if (cmd === 'select') return slideCapture.selectWindow(arg && arg.id, arg && arg.name), { ok: true, state: slideCapture.getState() };
  if (cmd === 'start') return slideCapture.start();
  if (cmd === 'stop') return slideCapture.stop('panel');
  if (cmd === 'manual') return slideCapture.manual();
  return { ok: false, error: 'unknown slide command: ' + cmd };
}
// Panel remote for the recorder (start/stop/state/setMic), reached over HTTP via sysserver.
function onMeetingRecordRequest(cmd, arg) {
  if (!meetingRecorder) return { ok: false, error: 'recorder unavailable' };
  if (cmd === 'start') return { ok: true, state: meetingRecorder.start('manual') };
  if (cmd === 'stop') return { ok: true, state: meetingRecorder.stop('manual') };
  if (cmd === 'state') return { ok: true, state: meetingStateForPanel() };
  if (cmd === 'setMic') { setMeetingMic(arg); return { ok: true, state: meetingStateForPanel() }; }
  if (cmd === 'setPanels') { setMeetingPanels(arg); return { ok: true, state: meetingStateForPanel() }; }
  // Manual busy override from the meeting panel's Busy column: 'auto' | 'busy' | 'free'.
  if (cmd === 'busyOverride') {
    if (!presenceService) return { ok: false, error: 'presence unavailable' };
    presenceService.setOverride(arg);
    return { ok: true, state: meetingStateForPanel() };
  }
  // Colour for the manual override, picked on the panel. Validated here rather than trusted: this
  // arrives over HTTP and ends up in the config file and in a device write.
  if (cmd === 'busyColor') {
    if (!presenceService) return { ok: false, error: 'presence unavailable' };
    const hex = String(arg || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { ok: false, error: 'expected #rrggbb' };
    if (!config.settings) config.settings = {};
    if (!config.settings.meeting) config.settings.meeting = {};
    config.settings.meeting.busyManualColor = hex;
    presenceService.setManualColor(hex);      // apply now; the light changes under the user's finger
    saveConfig();                             // and persist, so it survives a restart
    return { ok: true, state: meetingStateForPanel() };
  }
  return { ok: false, error: 'unknown record command: ' + cmd };
}
// Which utility columns the meeting page has open, remembered across app restarts. It can't live in
// the page's localStorage: the panel server binds an ephemeral port (listen(0)), so the origin —
// and with it any web storage — is new on every launch.
const PANEL_KEYS = ['ctl', 'slide', 'hl', 'busy'];
function setMeetingPanels(csv) {
  const open = String(csv || '').split(',').map(s => s.trim()).filter(s => PANEL_KEYS.includes(s));
  if (!config.settings) config.settings = {};
  if (!config.settings.meeting) config.settings.meeting = {};
  config.settings.meeting.panelsOpen = open.join(',');
  saveConfig();
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
  // Config-driven name normalization at the one choke point BOTH calendar sources pass through:
  // any organizer/attendee whose name canonically matches the "My name" setting (case and
  // punctuation ignored — "TJ Schmitz" ≈ "T.J. Schmitz") is replaced with the enrolled spelling,
  // so the diarizer's attendee matching sees the exact enrolled form. No hardcoded tables.
  const canon = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fixNames = info => {
    if (!info) return info;
    const mine = String(m.myName || '').trim();
    const fix = n => {
      let t = String(n || '').trim();
      const comma = t.indexOf(',');
      if (comma >= 0) t = (t.slice(comma + 1).trim() + ' ' + t.slice(0, comma).trim()).trim();
      if (mine && canon(t) === canon(mine)) t = mine;
      return t;
    };
    info.organizer = fix(info.organizer);
    if (Array.isArray(info.required_attendees)) info.required_attendees = info.required_attendees.map(fix);
    if (Array.isArray(info.optional_attendees)) info.optional_attendees = info.optional_attendees.map(fix);
    return info;
  };
  const saveInfo = info => {
    try {
      if (!info) { console.log('[meeting] calendar: no meeting scheduled now — no info file'); return; }
      info = fixNames(info);
      const dest = path.join(resolveMeetingFolders().unprocessed, wavName.replace(/\.wav$/i, '') + '.json');
      // The calendar lookup is async and can land after highlights were already flushed to this
      // same sidecar (short recording, or a slow Outlook/Graph call). Carry any spans across so
      // the later writer never wins by wiping the other's field.
      try {
        if (fs.existsSync(dest)) {
          const prior = JSON.parse(fs.readFileSync(dest, 'utf8')) || {};
          if (Array.isArray(prior.highlights) && prior.highlights.length) info.highlights = prior.highlights;
        }
      } catch (e) { /* unreadable prior sidecar — the fresh calendar info still wins */ }
      fs.writeFileSync(dest, JSON.stringify(info, null, 2));
      console.log('[meeting] meeting info saved: ' + path.basename(dest) + ' (' + (info.subject || '') + ')');
      // If the lookup completed after a short recording already FINISHED (onRecordingComplete ran
      // before the sidecar existed), complete the optional rename now. Only then: the WAV merely
      // existing is no signal — it exists, open, for the entire recording, and renaming it before
      // finalize's header patch corrupts it (PR #9 review finding).
      if (completedRecordings.has(wavName)) appendMeetingNameToRecording(wavName);
    } catch (e) { console.log('[meeting] calendar info write failed: ' + e.message); }
  };
  if (m.meetingInfoSource === 'microsoft365') {
    sysserver.callAppServer('office', 'meeting-info', { skipPrefixes: m.outlookSkipPrefixes || '' })
      .then(result => {
        if (!result || !result.ok) throw new Error(result && result.error || 'Microsoft 365 app unavailable');
        saveInfo(result.meeting);
      })
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
  // Belt and braces: never rename a file the recorder is still writing (or finalizing).
  if (!completedRecordings.has(wavName)) return;
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
    // The slide-capture folder is a sidecar too: rename it in lockstep so it stays matched to the WAV.
    try {
      const oldShots = path.join(dir, base + '-screenshots');
      if (fs.existsSync(oldShots)) fs.renameSync(oldShots, path.join(dir, newBase + '-screenshots'));
    } catch (e2) { console.log('[meeting] screenshots-folder rename failed: ' + e2.message); }
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
  // One monitor serves two consumers with different app lists. Windows shared-mode capture lets
  // several apps hold the mic at once, so the monitor reports EVERY match and each consumer filters
  // apps[] against its own list — see app/micMonitorRouting.js for why reading msg.app instead
  // silently breaks auto-record.
  const mset = meetingSettings();
  const recordApps = mset.recordApps || MEETING_DEFAULTS.recordApps;
  const busyOn = !!mset.busyEnabled;
  const allow = monitorAllowlist(recordApps, mset.busyApps, busyOn);   // identical to recordApps when busy is off
  const recordSet = parseAppList(recordApps);
  const busySet = parseAppList(busyOn ? mset.busyApps : '');
  try {
    micMonitorProc = spawn(MIC_MONITOR_EXE, [allow], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { console.log('[meeting] mic monitor spawn failed:', e.message); micMonitorProc = null; return; }
  let buf = '';
  let firstLine = true;   // a freshly spawned monitor announces its initial state before polling
  micMonitorProc.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      const wasFirst = firstLine; firstLine = false;
      const routed = routeMonitorMessage(msg, recordSet, busySet);
      // That opening announcement is a baseline, not a transition. Treating an idle baseline as
      // "the call ended" stopped recordings mid-meeting and split them into a second file every
      // time the monitor was respawned. Only a later idle is a real call-ended.
      if (wasFirst && !msg.active) continue;
      // Deliberately keyed off routed.recordApp, NOT msg.active: with a shared allowlist that flag is
      // true while ANY watched app holds the mic, so a Discord session idling in the background would
      // keep it true forever and a Teams call ending would never auto-stop the recording.
      if (meetingRecorder) {
        if (routed.recordApp) meetingRecorder.autoStart(routed.recordApp);
        else meetingRecorder.autoStop('call-ended');
      }
      if (presenceService) {
        presenceService.setCall(routed.busyActive, routed.busyActive ? (routed.recordApp || routed.apps[0] || null) : null);
      }
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
      if (monitorMode) { pushToPanel(); return; }   // monitor mode was set before first show -> stay hidden (desktop shows)
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

// ---- software mode: the panel UI in a normal desktop window (no QUAKE hardware) ----
// Same served UI as the device panel, loaded with ?mode=software so the page scales its 1920x480
// stage to fit and shows a mouse-driven page menu. Reuses the panelWin variable so every existing
// `panelWin && !panelWin.isDestroyed()` path (touch/knob sends, pushToPanel, meeting IPC) just works.
// The window aspect is locked to 1920:480; closing it drops to the tray (reopen from the tray).
// One pane slot: a full panel renderer (index.html) in its own WebContentsView, fed its page by
// pushToPanel. ?pane=1 hides the per-slot page selector; the top slot's psel=1 keeps it (listing PANES).
function makePaneView(psel) {
  const v = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'panel-preload.js'),
      webviewTag: true,
    },
  });
  try { v.setBackgroundColor('#000000'); } catch (e) {}
  const query = psel ? { mode: 'software', pane: '1', psel: '1' } : { mode: 'software', pane: '1' };
  v.webContents.loadFile(path.join(__dirname, 'index.html'), { query });
  // Re-push once the slot finishes loading; pushToPanel only touches the CURRENT paneViews, so a
  // stale view's late load is harmless.
  v.webContents.on('did-finish-load', () => { pushToPanel(); });
  return v;
}
// Lay the slot views out as the active pane's column grid: each column gets an equal width strip,
// sliced into `rows` equal rows (rows = the taller column, so both columns' slots line up).
// paneViews order is column-major: left column top-to-bottom, then the right column.
function layoutPaneViews() {
  if (!panelWin || panelWin.isDestroyed() || !paneViews.length) return;
  const ap = activePaneNow(); if (!ap) return;
  const b = panelWin.getContentBounds();
  const nCols = ap.columns.length;
  const rows = Math.max(1, ...ap.columns.map(c => c.length));
  let vi = 0;
  ap.columns.forEach((col, ci) => {
    const left = Math.round(b.width * ci / nCols), right = Math.round(b.width * (ci + 1) / nCols);
    col.forEach((_, ri) => {
      const v = paneViews[vi++]; if (!v) return;
      const top = Math.round(b.height * ri / rows), bottom = Math.round(b.height * (ri + 1) / rows);
      try { v.setBounds({ x: left, y: top, width: right - left, height: bottom - top }); } catch (e) {}
    });
  });
}
// rows/cols of the active pane's layout (rows = the taller column).
function paneGridShape(ap) { return { rows: Math.max(1, ...ap.columns.map(c => c.length)), cols: ap.columns.length }; }
// Apply a pane change (switch, edited slots, pages->pane flip) to the EXISTING window — no
// destroy/recreate, so the window's position, size, and maximized state survive. Views are added or
// removed to match the slot count; the window is only resized when it isn't maximized. Falls back to
// a full rebuild when the current window isn't a pane window (or panes just turned off).
function applyPaneLive() {
  const win = panelWin;
  const ap = activePaneNow();
  if (!win || win.isDestroyed() || !ap || !paneViews.length) { applyRunModeLive(); return; }
  const total = ap.pages.length;
  const { rows, cols } = paneGridShape(ap);
  while (paneViews.length > total) {
    const v = paneViews.pop();
    try { win.contentView.removeChildView(v); } catch (e) {}
    try { v.webContents.close(); } catch (e) {}
  }
  while (paneViews.length < total) { const v = makePaneView(false); paneViews.push(v); win.contentView.addChildView(v); }
  try { win.setMinimumSize(760, Math.round(760 * (480 * rows) / (1920 * cols))); } catch (e) {}
  try { win.setAspectRatio((1920 * cols) / (480 * rows)); } catch (e) {}
  if (!win.isMaximized() && !win.isFullScreen()) {
    const cur = win.getBounds();
    win.setBounds(softwareWindowBounds(cur, screen.getDisplayMatching(cur).workArea, rows, cols));
  }
  layoutPaneViews();
  pushToPanel();
  console.log('pane applied live: "' + ap.pane.name + '" ' + cols + 'x' + rows);
}
function createSoftwareWindow() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return; }
  const ap = activePaneNow();                    // pane mode: the pane's rows x cols of slot views
  const shape = ap ? paneGridShape(ap) : { rows: 1, cols: 1 };
  // A full rebuild (mode flip) reuses the window's last position, width, and maximized state instead
  // of recentering on the primary display — only the height follows the slot count.
  const prev = swBounds;
  const wa = prev ? screen.getDisplayMatching(prev).workArea : screen.getPrimaryDisplay().workArea;
  const { x, y, width, height } = softwareWindowBounds(prev, wa, shape.rows, shape.cols);
  panelWin = new BrowserWindow({
    width, height, x, y,
    minWidth: 760, minHeight: Math.round(760 * (480 * shape.rows) / (1920 * shape.cols)),
    title: 'open-quake', frame: true, show: false, resizable: true, movable: true,
    minimizable: true, maximizable: true, fullscreenable: false, autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'panel-preload.js'),
      webviewTag: true,
    },
  });
  const win = panelWin;   // capture: a live mode switch destroys this window while creating another — the
                          // stale window's events must not clobber the module-level panelWin of the new one.
  const rememberBounds = () => {
    if (win.isDestroyed() || panelWin !== win) return;
    try {
      swMaximized = win.isMaximized();
      if (!swMaximized && !win.isFullScreen()) swBounds = win.getBounds();   // keep the last NORMAL bounds for restore
    } catch (e) {}
  };
  rememberBounds();
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);
  try { win.setAspectRatio((1920 * shape.cols) / (480 * shape.rows)); } catch (e) {}
  if (ap) {
    paneViews = ap.pages.map((g, i) => makePaneView(i === 0));   // column-major; view 0 = top-left = ☰ slot
    paneViews.forEach(v => win.contentView.addChildView(v));
    layoutPaneViews();
    win.on('resize', layoutPaneViews);
    win.show(); win.focus();                     // no ready-to-show without window-level content
    if (swMaximized) win.maximize();
  } else {
    win.loadFile(path.join(__dirname, 'index.html'), { query: { mode: 'software' } });
    win.once('ready-to-show', () => { if (win.isDestroyed()) return; win.show(); win.focus(); if (swMaximized) win.maximize(); if (panelWin === win) pushToPanel(); });
  }
  win.on('closed', () => { if (panelWin === win) { panelWin = null; paneViews = []; } });
  console.log('software mode: window created (' + width + 'x' + height + (ap ? ', pane "' + ap.pane.name + '" ' + shape.cols + 'x' + shape.rows : '') + ')');
}

// Create/show the UI window for the current run mode and set reserved-display accordingly. Shared by
// the initial launch and the live mode switch, so both go through exactly the same placement path.
function placeUiForMode() {
  const mode = runMode();
  if (mode === 'software') {
    createSoftwareWindow();                              // a desktop window has no device display to protect
  } else {
    placePanel();                                        // panel + monitor both live on the QUAKE display
    if (mode === 'monitor' && panelWin && !panelWin.isDestroyed()) enterMonitorMode();   // boot straight into monitor mode
  }
  reservedDisplay.setEnabled(reservedDisplayEnabled(appSettings()));   // forced off in software mode; per-setting otherwise
}

// Show the UI per the persisted run mode, then apply the launch-time settings that are mode-independent.
// Called directly on a returning launch, or from the welcome window's Continue on first run.
function applyRunModeAndLaunch() {
  placeUiForMode();
  reservedDisplay.start();
  if (rotationCfg().enabled) setRotation(true);          // auto-start cycling on launch when enabled
  applyFocusFollowSettings();                             // auto-start foreground-app polling on launch when enabled
  applyShortcuts();                                       // register per-page global hotkeys
  applyTheme();                                           // set OS theme source (drives dashboards) + paint panel + knob accent
  const ls = appSettings();
  if (firstRun || ls.launchMode === 'editor') openConfigWindow();
  else if (ls.launchMode === 'minimized') { openConfigWindow(); if (configWin && !configWin.isDestroyed()) configWin.minimize(); }
  // 'tray' -> stay quiet (tray + panel/window only)
}

// Switch run mode WITHOUT relaunching. A relaunch (app.relaunch + app.exit) races the single-instance
// lock — the new process sees the old lock still held and force-exits, leaving no window — and app.exit
// skips before-quit so the device keep-alive dies and the panel goes dark. Instead, tear the current
// window down and rebuild it for the new mode in-process. Persist runMode BEFORE calling this.
function applyRunModeLive() {
  if (monitorMode) { monitorMode = false; reservedDisplay.setSuspended(false); releaseTouch(); }   // drop monitor state without re-showing the old panel
  const old = panelWin; panelWin = null; paneViews = [];   // slot views die with their window
  if (old && !old.isDestroyed()) { try { old.destroy(); } catch (e) {} }
  placeUiForMode();
  refreshTray();
  applyDisplayBlocker();   // leaving Panel releases the blocker; entering Panel re-applies it (if enabled)
  console.log('run mode switched live -> ' + runMode());
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

// Persisted run-mode switch from the tray. Applies live in-process (see applyRunModeLive) — no relaunch.
function switchRunMode(m) {
  if (m !== 'panel' && m !== 'software' && m !== 'monitor') return;
  if (runMode() === m) return;
  if (!config.settings) config.settings = {};
  config.settings.runMode = m;
  saveConfig();
  applyRunModeLive();
}

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

// First-run / re-run run-mode picker. A small centered window; its Continue button invokes the
// setRunMode IPC, which persists the choice, closes this window, and resumes the launch.
function createWelcomeWindow() {
  if (welcomeWin && !welcomeWin.isDestroyed()) { welcomeWin.show(); welcomeWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const width = 800, height = 460;
  welcomeWin = new BrowserWindow({
    width, height,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    title: 'Welcome to open-quake', backgroundColor: '#05080d',
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'welcome-preload.js'),
    },
  });
  welcomeWin.loadFile(path.join(__dirname, 'welcome.html'));
  welcomeWin.on('closed', () => { welcomeWin = null; });
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
  try { dev.setKnobLed(true); } catch (e) {}              // keep the ring from idle-sleeping
  // "All Off" (settings effect 0) is sent to the DEVICE as the last live effect at brightness 0,
  // not as matrix effect 0: with effect 0 the firmware blacks out the whole LED subsystem
  // INCLUDING the mic indicator, so the mic LED stopped following mic toggles (confirmed on
  // hardware — the screenOn+setMic re-assert did not revive it). The ring stays visually dark
  // either way; the stored setting remains 0 so the on/off toggle logic is unchanged.
  const allOff = (L.effect & 0xFF) === 0;
  try { dev.setLedEffect((allOff ? (lastRingEffect || 1) : L.effect) & 0xFF); } catch (e) {}
  try { dev.setLedBrightness((allOff ? 0 : L.brightness) & 0xFF); } catch (e) {}
  try { dev.setLedSpeed(L.speed & 0xFF); } catch (e) {}
  try { dev.setLedColor(hue & 0xFF, sat & 0xFF); } catch (e) {}
  if (L.effect) lastRingEffect = L.effect;
  // "All Off" (effect 0) repaints the matrix dark and can drop the firmware's mic indicator with
  // it (same latch class as the connect-time re-assert below in whenReady). Re-assert the mic
  // state after the effect settles so a lit mic LED survives switching the ring off.
  if ((L.effect & 0xFF) === 0) setTimeout(() => reassertMicLed('ring set to All Off'), 400);
}
// The firmware occasionally drops the mic LED (never the audio toggle) when the LED subsystem is
// asleep or mid-repaint — proven at connect time, and reported again with the ring on "All Off"
// (effect 0). The workaround mirrors the connect path: wake the panel, then re-send the current
// mic state so the LED latches. Harmless when the LED already agrees.
function reassertMicLed(why) {
  try { dev.screenOn(); } catch (e) {}
  try { dev.setMic(micState); } catch (e) {}
  console.log('mic LED re-assert (' + why + '):', micState);
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
let ringOverrideState = null;   // a RING_STATES key, or a {hue,sat,effect,speed} object from OQX_RING::custom:
function applyRingOverride() {
  const s = (ringOverrideState && typeof ringOverrideState === 'object') ? ringOverrideState : RING_STATES[ringOverrideState];
  if (!s) { ringOverrideState = null; applyKnobSettings(); return; }
  try { dev.setKnobLed(true); } catch (e) {}
  try { dev.setLedEffect(s.effect & 0xFF); } catch (e) {}
  try { dev.setLedBrightness(lighting().brightness & 0xFF); } catch (e) {}
  try { dev.setLedSpeed(s.speed & 0xFF); } catch (e) {}
  try { dev.setLedColor(s.hue & 0xFF, s.sat & 0xFF); } catch (e) {}
}
function setRingState(state) {
  if (!state || state === 'idle') { clearRingOverride(); return; }
  // Generic app ring: OQX_RING::custom:{"hue":..,"sat":..,"effect":..,"speed":..} — any served page
  // can drive the full ring while it is active; gotoGrid's clearRingOverride() restores on page change.
  const custom = parseCustomRing(state);
  if (custom) { ringOverrideState = custom; applyRingOverride(); return; }
  if (!RING_STATES[state]) return;   // unrecognized state string — ignore rather than guess at a mapping
  ringOverrideState = state;
  applyRingOverride();
}
function clearRingOverride() {
  if (!ringOverrideState) return;
  ringOverrideState = null;
  applyKnobSettings();
}
function applyMic(on) {
  try { dev.setMic(on); } catch (e) {}
  micState = !!on; refreshTray();
  // With the ring on "All Off" the LED subsystem can be idle and the single setMic above toggles
  // the audio but the mic LED never follows — wake it and re-assert (see reassertMicLed).
  if ((lighting().effect & 0xFF) === 0 && !ringOverrideState) setTimeout(() => reassertMicLed('mic toggle at ring All Off'), 350);
}
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
  // Any OTHER navigation while the screensaver auto-started itself (page hotkey, focus-follow,
  // a tile action) simply ends the saver — no restore, the navigation wins. The saver's own
  // enter/wake calls never trip this: enter sets saverActive after this call, wake clears it before.
  if (saverActive && id !== config.activeGridId) dissolveSaver();
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
  // Per-pane global hotkeys: same contract as page hotkeys, for the software window's panes. Firing
  // one switches to that pane (flipping the window to Panes view if needed); no-op outside software
  // mode. "Disables rotation" works exactly like the page version.
  for (const p of (config.panes || [])) {
    if (!p.shortcut) continue;
    try {
      const ok = globalShortcut.register(p.shortcut, () => {
        if (process.platform === 'win32') modifiersInAccelerator(p.shortcut).forEach(m => mediaKeys.keyUp(m));
        gotoPane(p.id, true);
        if (p.shortcutStopsRotation) setRotation(false);
        else if (rotateRunning) scheduleRotation();
      });
      if (!ok) console.log('shortcut already in use, not registered:', p.shortcut, '-> pane', p.id);
    } catch (e) { console.log('shortcut register error:', p.shortcut, '-', e.message); }
  }
  // Live Translate: a per-page hotkey that toggles translation (start/stop listening). Global, so it
  // fires from any app; if the page isn't on-screen it is switched to first, then the mic toggles.
  for (const g of (config.grids || [])) {
    if (!(g.kind === 'app' && g.app === 'livetranslate' && g.options && g.options.micHotkey)) continue;
    try {
      const ok = globalShortcut.register(g.options.micHotkey, () => {
        if (process.platform === 'win32') modifiersInAccelerator(g.options.micHotkey).forEach(m => mediaKeys.keyUp(m));
        const active = activeGrid();
        if (!(active && active.id === g.id)) gotoGrid(g.id, true);   // bring the page on-screen (loads it)
        panelSendTargets().forEach(wc => wc.send('micToggle'));
      });
      if (!ok) console.log('shortcut already in use, not registered:', g.options.micHotkey, '-> livetranslate toggle', g.id);
    } catch (e) { console.log('shortcut register error:', g.options.micHotkey, '-', e.message); }
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
  // Screen forward/back hotkeys: step the panel through the visible pages from anywhere. No toggle;
  // registered whenever a combo is set.
  const pageStep = pageStepCfg();
  [['nextHotkey', 1, 'page forward'], ['prevHotkey', -1, 'page back']].forEach(function (spec) {
    const combo = pageStep[spec[0]];
    if (!combo) return;
    try {
      const ok = globalShortcut.register(combo, () => {
        if (process.platform === 'win32') modifiersInAccelerator(combo).forEach(m => mediaKeys.keyUp(m));
        stepPage(spec[1]);
      });
      if (!ok) console.log('shortcut already in use, not registered:', combo, '->', spec[2]);
    } catch (e) { console.log('shortcut register error:', combo, '-', e.message); }
  });
  // LucidType dictation hotkeys: toggle dictation + apply text. Global (fire regardless of focus) so
  // dictation starts from any app and Apply pastes into whatever window is foreground.
  const lt = lucidtypeSettings();
  if (lt.dictationHotkey) {
    try {
      const ok = globalShortcut.register(lt.dictationHotkey, () => {
        if (process.platform === 'win32') modifiersInAccelerator(lt.dictationHotkey).forEach(m => mediaKeys.keyUp(m));
        toggleLucidDictation();
      });
      if (!ok) console.log('shortcut already in use, not registered:', lt.dictationHotkey, '-> lucidtype dictation');
    } catch (e) { console.log('shortcut register error:', lt.dictationHotkey, '-', e.message); }
  }
  if (lt.applyHotkey) {
    try {
      const ok = globalShortcut.register(lt.applyHotkey, () => {
        if (process.platform === 'win32') modifiersInAccelerator(lt.applyHotkey).forEach(m => mediaKeys.keyUp(m));
        lucidApply();
      });
      if (!ok) console.log('shortcut already in use, not registered:', lt.applyHotkey, '-> lucidtype apply');
    } catch (e) { console.log('shortcut register error:', lt.applyHotkey, '-', e.message); }
  }
  if (lt.cleanupHotkey) {
    try {
      const ok = globalShortcut.register(lt.cleanupHotkey, () => {
        if (process.platform === 'win32') modifiersInAccelerator(lt.cleanupHotkey).forEach(m => mediaKeys.keyUp(m));
        if (lucidDictation) lucidDictation.runCleanup();
      });
      if (!ok) console.log('shortcut already in use, not registered:', lt.cleanupHotkey, '-> lucidtype cleanup');
    } catch (e) { console.log('shortcut register error:', lt.cleanupHotkey, '-', e.message); }
  }
  if (lt.rewriteHotkey) {
    try {
      const ok = globalShortcut.register(lt.rewriteHotkey, () => {
        if (process.platform === 'win32') modifiersInAccelerator(lt.rewriteHotkey).forEach(m => mediaKeys.keyUp(m));
        if (lucidDictation) lucidDictation.runRewrite();
      });
      if (!ok) console.log('shortcut already in use, not registered:', lt.rewriteHotkey, '-> lucidtype rewrite');
    } catch (e) { console.log('shortcut register error:', lt.rewriteHotkey, '-', e.message); }
  }
  registerSlideHotkeys();   // last, after the unregisterAll above, so a settings change re-arms them
}
// Slide-capture global hotkeys (toggle capture / select window / manual capture). Registered as part
// of applyShortcuts() so an editor save re-applies them; only while the feature is enabled and a combo
// is set. A combo another app owns just fails to register (logged), same as the page hotkeys.
function registerSlideHotkeys() {
  if (!slideCapture) return;
  const m = meetingSettings();
  if (!m.slideCaptureEnabled) return;
  const binds = [
    [m.slideHotkeyToggle, () => { const s = slideCapture.getState(); if (s.capturing) slideCapture.stop('hotkey'); else slideCapture.start(); }],
    [m.slideHotkeySelect, () => slideCapture.requestPicker()],
    [m.slideHotkeyManual, () => slideCapture.manual()],
  ];
  for (const [combo, fn] of binds) {
    if (!combo) continue;
    try {
      const ok = globalShortcut.register(combo, () => {
        if (process.platform === 'win32') modifiersInAccelerator(combo).forEach(k => mediaKeys.keyUp(k));
        fn();
      });
      if (!ok) console.log('shortcut already in use, not registered:', combo, '-> slide capture');
    } catch (e) { console.log('shortcut register error:', combo, '-', e.message); }
  }
}
function applySlideHotkeys() { try { applyShortcuts(); } catch (e) {} }   // re-arm everything (incl. slide combos)
function rotateTick() {
  const ap = activePaneNow();
  if (ap) {
    // Pane mode rotates through opted-in PANES (the page categories don't apply to panes).
    const ids = paneRotationList().map(p => p.id);
    if (ids.length < 2) return;
    gotoPane(ids[(ids.indexOf(ap.pane.id) + 1) % ids.length], false);
    return;
  }
  const ids = rotationList().map(g => g.id);
  if (ids.length < 2) return;                                  // nothing to cycle through
  gotoGrid(ids[(ids.indexOf(config.activeGridId) + 1) % ids.length], false);   // active not in list (-1) -> first
}
function scheduleRotation() {
  if (rotTimer) { clearTimeout(rotTimer); rotTimer = null; }
  // saverActive: auto-rotation holds off while the screensaver auto-started itself (wake re-arms).
  // rotationSuspended stays exclusively owned by focus-follow, which re-derives it.
  if (!rotateRunning || rotationSuspended || saverActive) return;
  rotTimer = setTimeout(() => { rotateTick(); scheduleRotation(); }, rotationCfg().interval * 1000);
}
function pushRotationState(flash) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('rotation', { enabled: rotationCfg().enabled, running: rotateRunning, flash: !!flash });
}
function setRotation(on, flash) { rotateRunning = !!on; scheduleRotation(); refreshTray(); pushRotationState(flash); }
function toggleRotation() { setRotation(!rotateRunning, true); }   // knob/tray/hotkey user toggle -> flash the new state on the panel
// Re-evaluate after a settings change: a fresh off->on starts it, off stops it, on->on keeps the runtime state
// (so a manual pause survives an unrelated save). interval/page changes are picked up by the (re)schedule.
function applyRotationSettings(wasEnabled) {
  const enabled = rotationCfg().enabled;
  if (!enabled) rotateRunning = false;
  else if (!wasEnabled) rotateRunning = true;
  scheduleRotation(); refreshTray(); pushRotationState();
}

// ---- screensaver auto-start (idle -> screensaver page, any input -> back where you were) ----
// All DECISIONS live in screensaver-idle.js (pure, unit-tested); this is the thin stateful shell.
// The 10s interval re-reads live config every tick, so editor changes need no re-arm dance.
function voiceSessionBusy() {
  // The active page mid listening/thinking/speaking/approval drives the ring override (all five
  // ai-voice backends AND Live Translate's captioning set it) — the one main-side signal that a
  // conversation is actually in flight. Backgrounded agent sessions still THINKING are caught via
  // host status; an idle background session deliberately does not block the screensaver.
  if (ringOverrideState) return true;
  return [claudeVoiceHost, codexVoiceHost, copilotVoiceHost, owuiVoiceHost, apiVoiceHost]
    .some(h => {
      try { const s = h.handlers.getState().status; return s === 'thinking' || s === 'approval'; }
      catch (e) { return false; }
    });
}
function saverTick() {
  // Pane mode shows fixed stacked pages — the saver can't take over the view, so don't arm it.
  if (activePaneNow()) { if (saverActive) dissolveSaver(); return; }
  // Self-heal: an editor save can swap the active page without gotoGrid — never keep swallowing.
  if (saverActive && !saverIdle.isScreensaverGrid(activeGrid())) dissolveSaver();
  // Idle stamp: the ARIS-68 panel reports its own touch over HID, so lastPanelInputAt is the
  // whole truth there. Every other setup (Bedrock knob, knobless touchscreen) delivers touch as
  // native Windows input the app never sees — blend in the OS-wide idle clock so tapping the
  // panel counts as presence. (Kept off for aris68 so PC mouse/keyboard use doesn't hold the
  // saver back on a DK-QUAKE, matching shipped behavior.)
  let lastInputAt = lastPanelInputAt;
  if (dev.activeName() !== 'aris68') {
    try { lastInputAt = Math.max(lastInputAt, Date.now() - powerMonitor.getSystemIdleTime() * 1000); } catch (e) {}
  }
  const d = saverIdle.evaluateSaverTick({
    runMode: runMode(), monitorMode, saverActive,
    activeGridId: config.activeGridId, grids: config.grids || [],
    now: Date.now(), lastInputAt,
    voiceBusy: voiceSessionBusy(),
    meetingRecording: !!(meetingRecorder && meetingRecorder.getState().recording),
  });
  if (d.enter) enterSaver(d.enter);
}
function enterSaver(id) {
  console.log('[screensaver] idle auto-start (from page ' + config.activeGridId + ')');
  saverPrevGridId = config.activeGridId;
  gotoGrid(id, false);            // before setting saverActive, so gotoGrid's dissolve guard stays quiet
  saverActive = true;
  scheduleRotation();             // rotation holds off via the saverActive guard
}
function dissolveSaver() {
  saverActive = false; saverPrevGridId = null; saverSwallowUntil = 0; saverTouchHeld = false;
  scheduleRotation();
}
function wakeFromSaver() {
  console.log('[screensaver] wake -> restoring page');
  saverActive = false;            // before gotoGrid, so the dissolve guard doesn't fire
  const target = saverIdle.saverRestoreTarget(config, saverPrevGridId);
  saverPrevGridId = null;
  if (target) gotoGrid(target, false);   // explicit fallback chain — gotoGrid silently no-ops on a dead id
  scheduleRotation();
}
// Runs on every hardware touch/knob event (after monitor-mode handling). Returns true when the
// event must NOT reach the panel renderer: the wake input and its whole gesture get eaten so they
// can't toggle a mic, move the selector, or flip pages on the page being restored.
function saverConsumesInput(kind, evt) {
  if (!saverActive && !saverTouchHeld && !saverSwallowUntil) return false;   // fast path
  const d = saverIdle.swallowDecision({
    saverActive, activeIsSaver: saverIdle.isScreensaverGrid(activeGrid()),
    touchHeld: saverTouchHeld, swallowUntil: saverSwallowUntil,
  }, kind, evt, Date.now());
  saverTouchHeld = d.touchHeld;
  saverSwallowUntil = d.swallowUntil;
  if (d.dissolve) dissolveSaver();
  if (d.wake) wakeFromSaver();
  return d.swallow;
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
  // Each app's OWN hotkeys (not the page-jump shortcut above): action label + the page/app name.
  const apps = [];
  const addApp = (shortcut, action, app) => { if (shortcut) apps.push({ shortcut, action, app }); };
  (config.grids || []).filter(g => g.kind === 'app' && g.app === 'lucidtype').forEach(g => {
    const o = g.options || {}, nm = g.name || 'LucidType';
    addApp(o.dictationHotkey, 'Start / stop dictation', nm);
    addApp(o.applyHotkey, 'Apply text', nm);
    addApp(o.cleanupHotkey, 'Cleanup', nm);
    addApp(o.rewriteHotkey, 'Rewrite', nm);
  });
  const mtg = meetingSettings();
  if (mtg.slideCaptureEnabled) {
    addApp(mtg.slideHotkeyToggle, 'Slide capture — start / stop', 'Meeting');
    addApp(mtg.slideHotkeySelect, 'Slide capture — select window', 'Meeting');
    addApp(mtg.slideHotkeyManual, 'Slide capture — capture now', 'Meeting');
  }
  addApp(dashboardReloadCfg().hotkey, 'Reload the current dashboard', 'Dashboards');
  return {
    rotation: (rot.enabled && rot.hotkey) ? { hotkey: rot.hotkey } : null,
    pages,
    apps,
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
// Screen forward/back global hotkeys: step through the visible pages (gridList already excludes
// hidden ones) in editor order, wrapping. dir = +1 forward, -1 back.
function pageStepCfg() { const p = (config.settings && config.settings.pageStep) || {}; return { nextHotkey: typeof p.nextHotkey === 'string' ? p.nextHotkey : '', prevHotkey: typeof p.prevHotkey === 'string' ? p.prevHotkey : '' }; }
function stepPage(dir) {
  const list = gridList();                       // {id,name}[] of non-hidden pages, config order
  if (!list.length) return;
  let idx = list.findIndex(p => p.id === config.activeGridId);
  if (idx < 0) idx = 0;                           // active page hidden/unknown -> start from the first
  const next = list[((idx + dir) % list.length + list.length) % list.length];
  gotoGrid(next.id, true);
  if (rotateRunning) scheduleRotation();          // a manual step resets the rotation timer, like the knob/tray
}
function reloadActiveDashboard() {
  if (!visibleGrids().some(g => g && g.kind === 'web')) return;
  panelSendTargets().forEach(wc => wc.send('reloadDashboard'));
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
  if (rotationCfg().enabled || rotateRunning) items.push({ label: rotateRunning ? 'Auto-rotate: on — click to pause' : 'Auto-rotate: off — click to start', click: () => toggleRotation() });
  const rm = runMode();
  items.push({
    label: 'Run mode',
    submenu: [
      { label: 'Panel (QUAKE hardware)', type: 'radio', checked: rm === 'panel', click: () => switchRunMode('panel') },
      { label: 'Software window', type: 'radio', checked: rm === 'software', click: () => switchRunMode('software') },
      { label: 'Monitor (device as display)', type: 'radio', checked: rm === 'monitor', click: () => switchRunMode('monitor') },
    ],
  });
  if (rm === 'software') {
    // Software mode: the window may have been closed (app stays in the tray) -> offer to reopen it.
    items.push({ label: (panelWin && !panelWin.isDestroyed()) ? 'Show window' : 'Open window', click: () => createSoftwareWindow() });
  } else {
    items.push(
      { label: monitorMode ? 'Monitor mode: on — click to return to panel' : 'Switch to monitor mode (use device as a normal monitor)', click: () => toggleMonitorMode() },
      { label: 'Re-place panel on device', enabled: !monitorMode, click: () => { try { dev.screenOn(); } catch (e) {} placePanel(); } },
    );
  }
  items.push(
    { type: 'separator' },
    { label: 'Quit', click: () => { try { dev.stop(); } catch (e) {} app.quit(); } },
  );
  return Menu.buildFromTemplate(items);
}
function refreshTray() { if (tray) tray.setContextMenu(trayMenu()); }
let trayImgNormal = null, trayImgRecording = null;
// Red-tinted copy of the tray icon for the LucidType "dictating" state — derived from the app icon at
// startup (no separate asset), so it's unmistakably the same app in a recording state. Windows only;
// the macOS menu-bar icon is a template glyph that can't carry color.
function tintIconRed(img) {
  try {
    const size = img.getSize();
    if (!size.width || !size.height) return img;
    const bmp = img.toBitmap();   // BGRA
    for (let i = 0; i < bmp.length; i += 4) {
      bmp[i] = Math.round(bmp[i] * 0.20);                            // B
      bmp[i + 1] = Math.round(bmp[i + 1] * 0.20);                    // G
      bmp[i + 2] = Math.min(255, Math.round(bmp[i + 2] * 0.5 + 150)); // R (boosted)
    }
    return nativeImage.createFromBitmap(bmp, { width: size.width, height: size.height });
  } catch (e) { return img; }
}
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
  trayImgNormal = img;
  trayImgRecording = process.platform === 'darwin' ? img : tintIconRed(img);
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
  if (runMode() === 'software') createSoftwareWindow(); else placePanel();
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
  const storedDiscordTokens = oauthStorage.getTokens('discord');
  if (normalizeDiscordSettings((config.settings || {}).discord).enabled && storedDiscordTokens && storedDiscordTokens.accessToken) discordService.start();
  // obsService was constructed at module init (above), before decryptConfig could run -- safeStorage
  // needs app-ready -- so it captured the still-ENCRYPTED password. Re-point it at the now-decrypted
  // settings before the first connect, or every boot fails OBS auth until the user re-saves the Auth tab.
  obsService.configure({ url: obsWsUrl(obsSettings()), password: obsSettings().password });
  if (obsSettings().enabled) obsService.start();
  if (secretStore.available()) {
    if (needsMigration) saveConfig();                        // migrate plaintext/legacy config to current at-rest form
  } else if (needsMigration) console.log('secret encryption unavailable — refusing to rewrite config secrets');
  applyDisplayBlocker();   // keep-display-awake only when enabled + in Panel mode; otherwise the screensaver works
  createTray();
  // SystemView: live local metrics server on 127.0.0.1 (OS-assigned port) + ensure the dashboard page.
  // Lazy-required so a metrics/load failure can never crash the rest of the app.
  //
  // #5: this block boots the local server + every server-dependent subsystem. A single silent catch
  // used to swallow it all, so a failure in ANY stage looked identical to total failure with no user
  // signal. Now: the server bring-up is the outer prerequisite (its failure names the stage + raises
  // a visible notice), and each optional server-dependent subsystem below runs inside its OWN guard
  // (reportBootFailure + disposeStage + null the ref), so one failing degrades only that feature
  // instead of skipping the rest — with one aggregated non-modal notice naming any that failed.
  let bootStage = 'the local panel server';
  try {
    sysserver = require('./sysserver');
    // Remember the local server's port across restarts so served-app pages keep the same origin --
    // their localStorage (drop-in saves, high scores, settings) is per-origin and would otherwise be
    // orphaned on every launch when the port changed. sysserver falls back to a fresh port if taken.
    const portFile = path.join(USER_DIR, 'server-port');
    let preferredPort = 0;
    try { const n = parseInt(fs.readFileSync(portFile, 'utf8'), 10); if (n >= 1024 && n <= 65535) preferredPort = n; } catch (e) {}
    syncAppOAuthProviders();                                  // register drop-in apps' declared OAuth providers
    serverPort = await sysserver.start({
      preferredPort, onDiagnostic: onSysserverDiagnostic, oauth: dropInOAuth, appHost: dropInHost, onPickAppFolder: pickDropInFolder,
      onMedia: mediaKey, onLaunch: onAppLaunch, getGridTiles: getActiveAppTiles, getAppConfig: activeServedAppConfig,
      githubApp: githubService,
      onOpenExternal: openExternalUrl, onMeetingAction: onMeetingActionRequest, appFolders: discoveredServedApps(),
      getMeetingState: meetingStateForPanel, onMeetingRecord: onMeetingRecordRequest,
      onMeetingLibrary: onMeetingLibraryRequest, resolveMeetingAudio: resolveMeetingAudioPath,
      onSlide: onSlideRequest, onHighlight: onHighlightRequest,
      getDeviceDiagnostics: getDeviceDiagnostics,
      getLucidState: lucidStateForPanel, onLucidDictation: onLucidDictationRequest,
      onLucidApply: lucidApply, onLucidEdit: onLucidEditRequest, onLucidSetMic: onLucidSetMicRequest,
      onLucidCleanup: onLucidCleanupRequest, onLucidRewrite: onLucidRewriteRequest,
      onLucidReview: onLucidReviewRequest, onLucidSetMode: onLucidSetModeRequest,
      getShortcuts: keyboardShortcutsSnapshot,
      discordApp: discordAppHost,
      obsApp: obsService,
      // Voice-panel app registry: each entry gets the full /<appId>/* route surface (see
      // sysserver.js). voiceToken gates the claude approval hook's /approval-request long-poll.
      voiceApps: {
        // AI Voice: ONE app id, one page, five backends. The page serves at /ai-voice; every other
        // route carries the backend as a sub-prefix (/ai-voice/<backend>/turn, …) so requests bind
        // to the right host with no dependence on which page is active. Only the claude backend has
        // a voiceToken (its approvals arrive from an external hook; the others are in-band or none).
        'ai-voice': {
          htmlFile: 'claudevoiceview.html',
          backends: {
            claude: { handlers: claudeVoiceHost.handlers, voiceToken: claudeVoiceHost.adapter.hookToken() },
            codex: { handlers: codexVoiceHost.handlers },
            copilot: { handlers: copilotVoiceHost.handlers },
            owui: { handlers: owuiVoiceHost.handlers },
            api: { handlers: apiVoiceHost.handlers },
          },
        },
        // Live Translate: a captions page, not an agent. Only transcribe/getState/setOption are
        // implemented; no voiceToken and none of the LLM turn/SSE/speech routes are used.
        'livetranslate': {
          htmlFile: 'livetranslateview.html',
          handlers: liveTranslateHost.handlers,
        },
        // Screensaver: scenes render in the page; the host only lists/streams the media folder
        // (getState/setOption/resolveMedia/getProjects) — no voiceToken, no LLM routes.
        'screensaver': {
          htmlFile: 'screensaverview.html',
          handlers: screensaverHost.handlers,
        },
      },
    });
    if (serverPort && serverPort !== preferredPort) { try { fs.writeFileSync(portFile, String(serverPort)); } catch (e) {} }
    ensureSystemViewPage(serverPort); ensureMusicPage(); ensureDropInDir();
    console.log('SystemView + Music on http://127.0.0.1:' + serverPort);

    // Highlights ride the recorder's state edges (reset on start, auto-close + flush on stop), so
    // build them first — the recorder's onState below hands every change straight over.
    bootStage = 'meeting highlights';
    try {
      meetingHighlights = createMeetingHighlights({
        resolveFolders: resolveMeetingFolders,
        resolveSettings: meetingSettings,
        log: msg => console.log('[meeting] ' + msg),
      });
    } catch (e) { reportBootFailure('meeting highlights', e); disposeStage(meetingHighlights); meetingHighlights = null; }

    // Meeting recorder: hidden capture window on its OWN session partition (persist:recorder) with
    // the loopback handler registered ONLY there (never the shared dashboards session). Created once
    // the server is up so it can load the served /recorder page from a trusted local origin.
    bootStage = 'the meeting recorder';
    try {
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
            if (!st.recording && wasRecording && slideCapture) { try { slideCapture.onRecordingStopped(); } catch (e) {} }
            // Runs on both edges: arms the span list against this recording, and on the stopping
            // edge auto-closes + writes the sidecar. Synchronous, so it lands before the stream-close
            // callback renames that sidecar in appendMeetingNameToRecording.
            if (meetingHighlights) { try { meetingHighlights.onRecordingState(st); } catch (e) {} }
            if (presenceService) { try { presenceService.setRecording(!!st.recording); } catch (e) {} }
            wasRecording = !!st.recording;
          };
        })(),
        onRecordingComplete: name => {
          try {
            completedRecordings.add(name);   // header is patched — renames are safe from here on
            if (completedRecordings.size > 50) completedRecordings.delete(completedRecordings.values().next().value);
            appendMeetingNameToRecording(name);
          } catch (e) {}
        },
        log: msg => console.log('[meeting] ' + msg),
      });
      meetingRecorder.ensureWindow();   // arm the hidden window so a call can start recording instantly
      // Built BEFORE the monitor starts, so the very first call transition has somewhere to go.
      // Guarded on its own: a broken light or an unreachable broker must never cost us the recorder.
      try {
        presenceService = createPresenceService({ log: msg => console.log('[busy] ' + msg) });
        presenceService.applySettings(meetingSettings());
      } catch (e) { console.log('[busy] presence unavailable: ' + e.message); presenceService = null; }
      startMicMonitor();
    } catch (e) { reportBootFailure('the meeting recorder', e); try { stopMicMonitor(); } catch (er) {} disposeStage(meetingRecorder); meetingRecorder = null; }

    // Slide capture: a second hidden window that screen-captures a user-picked window and files
    // settled slides beside the active recording. All optional — guarded like the recorder so a
    // failure can never affect call control or recording.
    bootStage = 'slide capture';
    try {
      slideCapture = createSlideCapture({
        resolveSettings: () => meetingSettings(),
        resolveActiveRecording: () => {   // where slides file: the live recording's folder + basename
          const st = meetingRecorder && meetingRecorder.getState();
          if (!st || !st.recording || !st.file) return null;
          const folder = (meetingSettings().folder && String(meetingSettings().folder).trim()) || defaultMeetingFolder();
          return { folder, base: st.file.replace(/\.wav$/i, '') };
        },
        listApps: () => desktopFocus.listAllWindows(),   // EnumWindows via the helper: every window {processName, title, hwnd, minimized}

        createWindow: () => {
          const sess = session.fromPartition('persist:slidecapture');
          // getDisplayMedia in the hidden page routes here; hand it the window the user picked.
          // The id is fabricated from the HWND ("window:<hwnd>:0") — Electron accepts a plain
          // {id, name} here (verified live), which also covers windows getSources would omit
          // (it excludes minimized ones).
          sess.setDisplayMediaRequestHandler((request, callback) => {
            const id = slideCapture && slideCapture.currentSourceId();
            if (!id) { callback({}); return; }
            callback({ video: { id, name: 'slide-capture-target' }, audio: false });
          }, { useSystemPicker: false });
          const w = new BrowserWindow({
            show: false, width: 320, height: 200, skipTaskbar: true,
            webPreferences: {
              nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
              preload: path.join(__dirname, 'slidecapture-preload.js'), session: sess,
            },
          });
          try { w.loadURL('http://127.0.0.1:' + serverPort + '/slidecapture'); } catch (e) { console.log('[slide] loadURL error: ' + e.message); }
          return w;
        },
        notify: (title, body) => { try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); } catch (e) {} },
        onState: () => {},   // the meeting panel polls /meeting-state (~1s), so no push is needed
        log: msg => console.log('[slide] ' + msg),
      });
      applySlideHotkeys();
    } catch (e) { reportBootFailure('slide capture', e); disposeStage(slideCapture); slideCapture = null; }

    // LucidType dictation: a hidden capture window on its own session (persist:lucidtype) with a mic
    // grant, running the shared VAD; each utterance is transcribed via Wyoming and appended to the
    // running transcript the /lucidtype page shows and Apply pastes. Independent of the meeting recorder.
    bootStage = 'dictation';
    try {
      lucidDictation = createLucidDictation({
        createWindow: () => {
          const sess = session.fromPartition('persist:lucidtype');
          sess.setPermissionRequestHandler(handleDashboardPermissionRequest);   // grants getUserMedia mic for our local page
          const w = new BrowserWindow({
            show: false, width: 320, height: 200, skipTaskbar: true,
            webPreferences: {
              nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
              preload: path.join(__dirname, 'lucidtype-dictate-preload.js'), session: sess,
            },
          });
          try { w.loadURL('http://127.0.0.1:' + serverPort + '/lucidtype-dictate'); } catch (e) { console.log('[lucidtype] loadURL error: ' + e.message); }
          return w;
        },
        resolveSettings: () => { const s = lucidtypeSettings(); return { micDevice: s.micDevice, silenceMs: s.silenceMs, notifyBeep: !!s.notifyBeep, startMode: s.startMode, rewriteMode: s.rewriteMode }; },
        resolveEndpoints: () => lucidtypeVoiceEndpoints(),
        transcribe: async ({ host, port, audio }) => {
          const t = await lucidWyoming.transcribe({ host, port, audio, rate: 16000, width: 2, channels: 1, log: m => console.log('[lucidtype] ' + m) });
          return voiceConfig.isSttNoisePhrase(t) ? '' : t;
        },
        transform: lucidRunTransform,                                    // cleanup/rewrite AI (Phase 2)
        readClipboard: () => { try { return clipboard.readText(); } catch (e) { return ''; } },
        onState: onLucidState,
        log: msg => console.log('[lucidtype] ' + msg),
      });
      lucidDictation.ensureWindow();   // arm the hidden window so a hotkey can start dictation instantly
      ipcMain.on('lucid-pcm', (e, bytes) => { try { if (lucidDictation && bytes) lucidDictation.onUtterance(Buffer.from(bytes)); } catch (er) {} });
      ipcMain.on('lucid-log', (e, msg) => console.log('[lucidtype] ' + msg));
    } catch (e) { reportBootFailure('dictation', e); disposeStage(lucidDictation); lucidDictation = null; }

    // Transcription pipeline: library (list/delete), diarizer upload queue, and CLI analysis.
    // Lazy-required + individually try/caught like the recorder so a failure here can never take
    // down call control or recording.
    bootStage = 'transcription';
    migrateLegacyMeetingWavs();
    try {
      meetingLibrary = require('./meetingLibrary').createMeetingLibrary({
        resolveFolders: resolveMeetingFolders,
        organizeByDate: () => !!meetingSettings().processedByDate,
        log: msg => console.log('[meeting] ' + msg),
      });
      meetingTranscriber = require('./meetingTranscribe').createMeetingTranscriber({
        resolveFolders: resolveMeetingFolders,
        resolveBaseUrl: resolveTranscribeBaseUrl,
        organizeByDate: () => !!meetingSettings().processedByDate,
        resolveThreshold: () => meetingSettings().transcribeThreshold,
        resolveMyName: () => meetingSettings().myName,
        resolveHooks: () => {
          const m = meetingSettings();
          return { enabled: !!m.transcribeHooksEnabled, pre: m.preTranscribeCmd || '', post: m.postTranscribeCmd || '' };
        },
        log: msg => console.log('[meeting] ' + msg),
      });
      meetingAnalyzer = require('./meetingAnalyze').createMeetingAnalyzer({
        resolveFolders: resolveMeetingFolders,
        resolveAi: () => meetingSettings().analysisAi,
        resolveOwui: owuiSettings,
        promptPath: () => fs.existsSync(userMeetingPromptPath()) ? userMeetingPromptPath() : path.join(__dirname, 'meeting-analysis-prompt.md'),
        filingOptions: () => {
          const m = meetingSettings();
          return { separateRecurring: !!m.separateRecurring, separateTranscript: !!m.separateTranscript, useDetailsFolder: !!m.useDetailsFolder };
        },
        resolveTaskList: () => {
          const m = meetingSettings();
          return { enabled: !!m.taskListEnabled, folder: m.taskListFolder || '' };
        },
        resolveJoplin: () => {
          const m = meetingSettings();
          return { enabled: !!m.joplinEnabled, url: m.joplinUrl || '', token: m.joplinToken || '', notebook: m.joplinNotebook || '' };
        },
        log: msg => console.log('[meeting] ' + msg),
      });
    } catch (e) { reportBootFailure('transcription', e); meetingLibrary = null; meetingTranscriber = null; meetingAnalyzer = null; }
  } catch (e) {
    // Name the stage that failed (not a generic 'local panel services') and make it VISIBLE — a
    // silent catch here made a partial boot failure indistinguishable from a working launch.
    console.log('[boot] ' + bootStage + ' failed to start: ' + faultDetail(e));   // sanitized — no raw message/secret
    try {
      if (Notification.isSupported()) new Notification({
        title: 'open-quake',
        body: 'Startup problem: ' + bootStage + ' did not start, so features that depend on it are unavailable this session. Details are in the log.',
        silent: true,
      }).show();
    } catch (er) {}
  }
  // One aggregated, non-modal notice for any OPTIONAL subsystem that failed its own guard (#5). The
  // server + its dependents still came up; only the named features are degraded.
  if (bootFailures.length) {
    try {
      if (Notification.isSupported()) new Notification({
        title: 'open-quake',
        body: 'Some panel features did not start (' + bootFailures.join(', ') + '); the rest are running normally. Details are in the log.',
        silent: true,
      }).show();
    } catch (er) {}
  }
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

  ipcMain.on('launch', (e, a) => { if (!isFromPanel(e)) return; runAction(a); });
  ipcMain.on('volume', (e, v) => { if (!isFromPanel(e)) return; mediaKeys.volume(v); });
  ipcMain.on('media', (e, cmd) => { if (!isFromPanel(e)) return; mediaKey(cmd); });   // knob 'enter' on the music page -> play/pause
  ipcMain.on('switchGrid', (e, id) => {
    if (!isFromPanel(e)) return;
    if (activePaneNow() && (config.panes || []).some(p => p.id === id)) { gotoPane(id, true); if (rotateRunning) scheduleRotation(); return; }   // pane mode: the ☰ lists panes; a manual pick resets the timer
    gotoGrid(id, true); if (rotateRunning) scheduleRotation();   // a manual pick resets the rotation timer
  });
  // Focus a page ON THE DEVICE from the editor. Only pages already in main's config (i.e. saved) can
  // be focused -- the editor blocks this when it has unsaved changes, so an id we don't know is an
  // error, not a silent no-op. This is the one place the editor is allowed to move the live page.
  ipcMain.handle('focusPage', (e, id) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'not authorized' };
    if (!config.grids.some(g => g.id === id)) return { ok: false, error: 'That page is not saved yet.' };
    gotoGrid(String(id), true);
    if (rotateRunning) scheduleRotation();
    return { ok: true };
  });
  ipcMain.on('toggleRotation', (e) => { if (!isFromPanel(e)) return; toggleRotation(); });
  ipcMain.on('startRotation', (e) => { if (!isFromPanel(e)) return; setRotation(true); });
  ipcMain.on('stopRotation', (e) => { if (!isFromPanel(e)) return; setRotation(false); });
  ipcMain.on('gotoHome', (e) => {
    if (!isFromPanel(e)) return;
    if (activePaneNow()) { if (config.homePaneId) gotoPane(config.homePaneId, false); return; }   // pane mode: home = the home pane
    if (config.homePageId) gotoGrid(config.homePageId, false);
  });
  ipcMain.on('openConfig', (e) => { if (!isFromPanel(e) && !isFrom(e, configWin)) return; openConfigWindow(); });
  // Restore input after a native confirm()/alert() in the editor: the dialog steals focus and the
  // window never registers getting it back (electron#31917), leaving inputs/<select>s dead until a
  // blur+refocus cycle.
  ipcMain.on('refocusEditor', (e) => {
    if (!isFrom(e, configWin)) return;
    try { configWin.blur(); configWin.focus(); } catch (err) {}
  });
  ipcMain.on('introDone', (e) => { if (!isFromPanel(e)) return; config.introShown = true; saveConfig(); });   // remember the intro was dismissed
  ipcMain.on('saveTileValue', (e, data) => {
    console.log('[counter] saveTileValue received:', JSON.stringify(data));
    if (!isFromPanel(e)) { console.log('[counter] REJECTED: not from panelWin'); return; }
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
  ipcMain.on('openExternal', (e, url) => { if (!isFromPanel(e) && !isFrom(e, configWin)) return; openExternalUrl(url); });
  ipcMain.on('ringState', (e, state) => { if (!isFromPanel(e)) return; setRingState(state); });
  ipcMain.handle('getConfig', (e) => isFrom(e, configWin) ? configForRenderer(config) : null);
  ipcMain.handle('getAppVersion', (e) => isFrom(e, configWin) ? app.getVersion() : null);
  ipcMain.handle('listOAuthProviders', (e) => isFrom(e, configWin) ? oauthProviderPayload() : []);
  ipcMain.handle('connectOAuthProvider', async (e, provider, scopes) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    try {
      const id = String(provider || '').toLowerCase();
      if (id === 'discord') await discordService.authorize();
      else return { ok: false, error: 'unsupported OAuth provider' };
      return { ok: true, providers: oauthProviderPayload() };
    }
    catch (err) { return { ok: false, error: err.message || String(err), code: err.code || '' }; }
  });
  ipcMain.handle('disconnectOAuthProvider', async (e, provider) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    try {
      const id = String(provider || '').toLowerCase();
      if (id !== 'discord') return { ok: false, error: 'unsupported OAuth provider' };
      discordService.disconnectAuthorization();
      const r = { ok: true };
      return Object.assign({}, r, { providers: oauthProviderPayload() });
    }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
  // App-scoped OAuth lifecycle for the selected drop-in app's own editor. The renderer supplies
  // only an app id; provider identity and scopes are taken from the installed manifest so one app
  // cannot request another provider's tokens or expand its declared permissions.
  ipcMain.handle('getAppOAuthStatus', (e, appId) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    const def = appOAuthDefinition(appId);
    if (!def) return { ok: false, error: 'This installed app does not declare OAuth' };
    return Object.assign({ ok: true, name: String(def.oauth.name || def.name || def.id) }, dropInOAuth.status(def.id));
  });
  ipcMain.handle('connectAppOAuth', async (e, appId) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    try {
      const def = appOAuthDefinition(appId);
      if (!def) return { ok: false, error: 'This installed app does not declare OAuth' };
      const result = await dropInOAuth.connect(def.id, Array.isArray(def.oauth.scopes) ? def.oauth.scopes : []);
      return Object.assign({}, result, { status: dropInOAuth.status(def.id) });
    } catch (err) { return { ok: false, error: err.message || String(err), code: err.code || '' }; }
  });
  ipcMain.handle('disconnectAppOAuth', async (e, appId) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    try {
      const def = appOAuthDefinition(appId);
      if (!def) return { ok: false, error: 'This installed app does not declare OAuth' };
      const result = await dropInOAuth.disconnect(def.id);
      pushToPanel();
      return result;
    } catch (err) { return { ok: false, error: err.message || String(err), code: err.code || '' }; }
  });
  ipcMain.handle('getGitHubStatus', async (e) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    const st = githubService.publicSettings();
    if (st.connected) { try { st.login = await githubService.accountLogin(); } catch (er) {} }
    return st;
  });
  // Editor-only, like every handler around it: isFrom() keeps a drop-in page or a served app from
  // reaching hardware. busyTest drives one output for a couple of seconds and then restores whatever
  // the real presence state is, so pressing Test during a call cannot leave the light lying.
  ipcMain.handle('busyTest', async (e, target) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    if (!presenceService) return { ok: false, error: 'busy status is unavailable' };
    try { return await presenceService.test(String(target || '')); }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('busyStatus', async e => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    return presenceService ? presenceService.getState() : { enabled: false };
  });
  ipcMain.handle('connectGitHub', async e => isFrom(e, configWin) ? githubService.connect() : { ok: false, error: 'unauthorized' });
  ipcMain.handle('pollGitHubConnect', async e => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    const result = await githubService.pollConnect();
    if (result && result.connected) {
      try { sysserver.clearGitHubCapability(); } catch (error) {}
      pushToPanel();
    }
    return result;
  });
  ipcMain.handle('disconnectGitHub', async e => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    const result = await githubService.disconnect();
    if (result && result.ok) {
      try { sysserver.clearGitHubCapability(); } catch (error) {}
      pushToPanel();
    }
    return result;
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
  ipcMain.handle('getEmojiIndex', (e) => isFrom(e, configWin) ? EMOJI_INDEX : null);
  ipcMain.handle('refreshHaCache', (e) => isFrom(e, configWin) ? refreshHaCache() : null);
  // Editor voice-app options: is the page's CLI actually installed? Lets the editor warn at
  // add-time instead of the user discovering a dead page on the panel later.
  ipcMain.handle('probeVoiceCli', (e, backend) => {
    if (!isFrom(e, configWin)) return null;
    try {
      if (backend === 'claude') return findClaudeExe() || null;
      if (backend === 'codex') return findCodexExe() || null;
      if (backend === 'copilot') return findCopilotExe() || null;
      // owui has no CLI — "found" means a usable URL is configured on the Auth tab.
      if (backend === 'owui') {
        const ep = owuiClient.normalizeOwuiUrl(owuiSettings().url);
        return ep ? ep.origin : null;
      }
      // api: nothing to probe here — the page's own URL/key fields carry the connection.
    } catch (err) {}
    return null;
  });
  // "Test connection" for the Auth tab's Open WebUI section: normalize the URL and hit
  // /api/models with the key. Returns the model list so the editor can report a live count.
  ipcMain.handle('probeOwui', async (e, url, apiKey) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    const cfg = owuiSettings();
    const ep = owuiClient.normalizeOwuiUrl(url !== undefined && url !== null && String(url).trim() !== '' ? url : cfg.url);
    if (!ep) return { ok: false, error: 'no usable URL — enter the Open WebUI address first' };
    try {
      const models = await owuiClient.listModels(ep.modelsUrl, String((apiKey !== undefined && apiKey !== null && apiKey !== '' ? apiKey : cfg.apiKey) || ''));
      return { ok: true, origin: ep.origin, models };
    } catch (err) {
      if (err && (err.statusCode === 401 || err.statusCode === 403)) return { ok: false, error: 'Open WebUI rejected the API key (HTTP ' + err.statusCode + ')' };
      return { ok: false, error: (err && err.message) || 'connection failed' };
    }
  });
  // Test-connect to OBS with the SAVED config (same auto-save-then-probe flow as owui). A throwaway
  // client so it never disturbs the live obsService connection.
  ipcMain.handle('probeObs', async (e) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    const s = obsSettings();
    const { OBSWebSocket } = require('obs-websocket-js');
    const client = new OBSWebSocket();
    try {
      const hello = await client.connect(obsWsUrl(s), s.password, { rpcVersion: 1, eventSubscriptions: 0 });
      let sceneCount = 0;
      try { const r = await client.call('GetSceneList'); sceneCount = (r.scenes || []).length; } catch (er) {}
      try { await client.disconnect(); } catch (er) {}
      return { ok: true, obsVersion: (hello && hello.obsWebSocketVersion) || '?', sceneCount };
    } catch (err) {
      try { await client.disconnect(); } catch (er) {}
      const msg = (err && err.message) || 'connection failed';
      if (/authentication|password|4009/i.test(msg)) return { ok: false, error: 'OBS rejected the password — check Tools → WebSocket Server Settings.' };
      if (/ECONNREFUSED|refused|not open|ETIMEDOUT|EHOSTUNREACH/i.test(msg)) return { ok: false, error: 'No OBS at ' + obsWsUrl(s) + ' — is OBS running with the WebSocket server enabled?' };
      return { ok: false, error: msg };
    }
  });
  // Live OBS scenes/inputs for the tile editor's resource pickers (config window only).
  ipcMain.handle('getObsSnapshot', (e) => isFrom(e, configWin) ? obsService.getSnapshot() : { connection: 'disconnected' });
  // Model list for the AI Voice API backend's editor dropdown: hit the endpoint's standard
  // OpenAI-compatible /models with the page's own URL + key (probeOwui's pattern, minus the
  // OWUI-specific URL normalization — the base here is entered verbatim).
  ipcMain.handle('probeApiModels', async (e, url, apiKey) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'unauthorized' };
    const base = String(url || '').trim().replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'no base URL' };
    try {
      const models = await owuiClient.listModels(base + '/models', String(apiKey || ''));
      return { ok: true, models };
    } catch (err) {
      if (err && (err.statusCode === 401 || err.statusCode === 403)) return { ok: false, error: 'the endpoint rejected the key (HTTP ' + err.statusCode + ')' };
      return { ok: false, error: (err && err.message) || 'connection failed' };
    }
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
      try { return await sysserver.callAppServer('office', 'check-connection'); }
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
    syncAppOAuthProviders();
    try { if (sysserver && sysserver.setAppFolders) sysserver.setAppFolders(catalog.servedApps); } catch (er) {}
    return catalog.apps;
  });
  ipcMain.handle('saveConfigFromEditor', (e, newCfg) => {
    if (!isFrom(e, configWin) || !newCfg || typeof newCfg !== 'object' || !Array.isArray(newCfg.grids)) return { ok: false, error: 'invalid configuration' };
    if (!newCfg.settings) newCfg.settings = {};
    const submittedGitHubProvider = newCfg.settings.oauth && newCfg.settings.oauth.providers && newCfg.settings.oauth.providers.github;
    let nextGitHubClientId;
    let nextGitHubSettings;
    try {
      nextGitHubClientId = normalizeGitHubClientId(submittedGitHubProvider && submittedGitHubProvider.clientId);
      nextGitHubSettings = normalizeGitHubSettings(newCfg.settings.github);
      if (nextGitHubSettings.repository) nextGitHubSettings.repository = parseGitHubRepository(nextGitHubSettings.repository).fullName;
      if (nextGitHubSettings.branch) nextGitHubSettings.branch = validGitHubRef(nextGitHubSettings.branch);
    } catch (error) {
      return { ok: false, error: error.message || 'invalid GitHub settings' };
    }
    const previousConfig = config;
    const previousDiscordApplicationId = discordApplicationId((config.settings || {}).discord);
    const previousGitHubClientId = oauthStorage.getProviderSettings('github').clientId || '';
    const previousGitHubSettings = normalizeGitHubSettings((config.settings || {}).github);
    const githubClientChanged = previousGitHubClientId !== nextGitHubClientId;
    const githubSettingsChanged = previousGitHubSettings.repository !== nextGitHubSettings.repository || previousGitHubSettings.branch !== nextGitHubSettings.branch;
    const active = config.activeGridId;                          // the knob owns the live page — editor edits never change it
    const wasRot = rotationCfg().enabled;                        // detect a fresh off->on to auto-start (else keep the runtime pause)
    const prevMode = runMode();                                  // detect a run-mode change to rebuild the window live
    const prevPaneKey = paneRebuildKey();                        // detect a pane display/layout change (window height must change)
    const prevMeeting = meetingSettings();                       // recorder-affecting fields, read before config is swapped
    const oauth = config.settings && config.settings.oauth;
    if (oauth) {
      newCfg.settings.oauth = JSON.parse(JSON.stringify(oauth));
    }
    if (!newCfg.settings.oauth || typeof newCfg.settings.oauth !== 'object') newCfg.settings.oauth = { providers: {}, tokens: {} };
    if (!newCfg.settings.oauth.providers || typeof newCfg.settings.oauth.providers !== 'object') newCfg.settings.oauth.providers = {};
    if (!newCfg.settings.oauth.tokens || typeof newCfg.settings.oauth.tokens !== 'object') newCfg.settings.oauth.tokens = {};
    if (nextGitHubClientId) newCfg.settings.oauth.providers.github = { clientId: nextGitHubClientId };
    else delete newCfg.settings.oauth.providers.github;
    if (githubClientChanged) delete newCfg.settings.oauth.tokens.github;
    newCfg.settings.github = nextGitHubSettings;
    newCfg.settings.discord = normalizeDiscordSettings(newCfg.settings.discord);
    if (previousDiscordApplicationId !== discordApplicationId(newCfg.settings.discord)
      && newCfg.settings.oauth && newCfg.settings.oauth.tokens) delete newCfg.settings.oauth.tokens.discord;
    newCfg.settings.obs = normalizeObsSettings(newCfg.settings.obs);
    config = newCfg;
    if (config.grids.some(g => g.id === active)) config.activeGridId = active;
    else if (!config.grids.some(g => g.id === config.activeGridId)) config.activeGridId = (config.grids[0] || {}).id || null;
    editorSaveInFlight = true;                                   // this save came FROM the editor — don't tell it to re-read
    const saved = saveConfig();
    editorSaveInFlight = false;
    if (!saved) { config = previousConfig; return { ok: false, error: 'secure persistence failed' }; }
    if (githubClientChanged) { oauthHandler.clearRefresh('github'); oauthHandler.cancelDeviceFlow('github'); }
    if (githubClientChanged || githubSettingsChanged) { try { sysserver.clearGitHubCapability(); } catch (error) {} }
    pushToPanel(); applyKnobSettings(); refreshTray(); applyRotationSettings(wasRot); applyFocusFollowSettings(); applyShortcuts(); applyTheme();
    reservedDisplay.setEnabled(reservedDisplayEnabled(appSettings()));   // stays off in software mode
    applyDisplayBlocker();                                               // keep-display-awake: only Panel mode + when enabled
    const discordSettings = normalizeDiscordSettings((config.settings || {}).discord);
    discordAppHost.updateSettings(discordSettings);
    discordService.setAutoReconnect(discordSettings.autoReconnect);
    const discordTokens = oauthStorage.getTokens('discord');
    if (!discordSettings.enabled || !(discordTokens && discordTokens.accessToken)) discordService.stop();
    discordService.configure(discordApplicationId(discordSettings));
    if (discordSettings.enabled && discordTokens && discordTokens.accessToken) {
      if (discordService.getState().state === 'disconnected') discordService.start();
      if (discordAppHost.getSnapshot().capabilities.activity) discordService.setActivity(discordSettings.richPresence ? { details: 'Using open-quake' } : null).catch(() => {});
    }
    const obsCfg = obsSettings();
    obsService.setAutoReconnect(obsCfg.autoReconnect);
    if (!obsCfg.enabled) obsService.stop();
    else { obsService.configure({ url: obsWsUrl(obsCfg), password: obsCfg.password }); if (obsService.getState().state === 'disconnected') obsService.start(); }
    // Both of these disturb a live recording — respawning the monitor makes it re-announce its
    // state, and setMic tears down and re-acquires the capture. Saving unrelated settings (slide
    // capture, theme, anything) must not do either, so they fire only on a real change.
    const nextMeeting = meetingSettings();
    // Re-arm on EITHER list: the monitor now watches the union of record apps and busy apps, so an
    // edit to the busy list changes its argv too, as does toggling the feature on or off.
    if (nextMeeting.recordApps !== prevMeeting.recordApps
      || nextMeeting.busyApps !== prevMeeting.busyApps
      || !!nextMeeting.busyEnabled !== !!prevMeeting.busyEnabled) startMicMonitor();
    if (presenceService) { try { presenceService.applySettings(nextMeeting); } catch (e) { console.log('[busy] applySettings: ' + e.message); } }
    if (meetingRecorder && nextMeeting.micDevice !== prevMeeting.micDevice) {
      meetingRecorder.setMic(nextMeeting.micDevice);                            // push an edited mic to the recorder
    }
    if (runMode() !== prevMode) applyRunModeLive();                 // run mode changed on the Software tab -> rebuild the window in-place
    else if (runMode() === 'software' && paneRebuildKey() !== prevPaneKey) applyPaneLive();   // pane display/slots changed -> adjust the window in place
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
  // Screensaver "Open photos/videos folder": resolve the effective folder (custom or the app's
  // own default for that kind), create it if needed, and show it in Explorer. Directory-only —
  // never opens (= executes) a file.
  ipcMain.handle('openScreensaverMedia', (e, dir, kind) => {
    if (!isFrom(e, configWin)) return { ok: false };
    const dflt = path.join(app.getPath('userData'), 'screensaver-media', kind === 'videos' ? 'videos' : 'photos');
    const target = String(dir || '').trim() || dflt;
    try {
      fs.mkdirSync(target, { recursive: true });
      if (!fs.statSync(target).isDirectory()) return { ok: false };
      shell.openPath(target);
      return { ok: true, dir: target };
    } catch (err) { return { ok: false }; }
  });
  // Drop-in app manager (Settings → Drop-In Apps)
  ipcMain.handle('listDropInApps', (e) => isFrom(e, configWin) ? listDropInApps() : []);
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
  // Install / update drop-in apps from the configured repository (Settings → Drop-In Apps)
  ipcMain.handle('listRepoApps', (e, repoUrl) => isFrom(e, configWin) ? listRepoApps(repoUrl) : { ok: false });
  ipcMain.handle('installRepoApp', (e, id, confirmExec, repoUrl) => isFrom(e, configWin) ? installRepoApp(id, confirmExec, repoUrl) : { ok: false });
  ipcMain.handle('checkDropInUpdate', (e, id) => isFrom(e, configWin) ? checkDropInUpdate(id) : { ok: false });
  ipcMain.handle('updateDropInApp', (e, id, confirmExec) => isFrom(e, configWin) ? updateDropInApp(id, confirmExec) : { ok: false });
  ipcMain.handle('reinstallDropInApp', (e, id, confirmExec) => isFrom(e, configWin) ? reinstallDropInApp(id, confirmExec) : { ok: false });
  // Editor -> drop-in app server bridge (generic): lets the editor host management UI for an app.
  ipcMain.handle('appApiCall', (e, appId, action, body) => (isFrom(e, configWin) && sysserver) ? sysserver.callAppServer(appId, action, body) : { ok: false });
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
  // Slide-capture window -> main, guarded to that window's own webContents.
  const fromSlide = e => slideCapture && slideCapture.isSender(e.sender);
  ipcMain.on('slide-ready', e => { if (fromSlide(e)) slideCapture.onReady(); });
  ipcMain.on('slide-thumb', (e, buf, meta) => { if (fromSlide(e)) slideCapture.onThumb(buf, meta); });
  ipcMain.on('slide-frame', (e, buf) => { if (fromSlide(e)) slideCapture.onFrame(buf); });
  ipcMain.on('slide-status', (e, state, detail) => { if (fromSlide(e)) slideCapture.onStatus(state, detail); });
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
  // Editor page preview: the SAME URL the panel would load for this page (options + theme params),
  // built from the editor's in-progress page object so unsaved option edits preview correctly.
  ipcMain.handle('appPreviewUrl', (e, page) => {
    if (!isFrom(e, configWin)) return 'about:blank';
    if (!page || typeof page !== 'object' || typeof page.app !== 'string') return 'about:blank';
    try { return appPageUrl({ app: page.app, options: page.options || {}, gridOn: !!page.gridOn, appearance: page.appearance, accent: page.accent }); }
    catch (err) { return 'about:blank'; }
  });
  // Interactive drop-in management surface. Unlike the inert scaled preview, this only exists
  // for a sanitized served-app `editor` declaration and never exposes IPC/Node to the iframe.
  ipcMain.handle('appEditorUrl', (e, page) => {
    if (!isFrom(e, configWin)) return 'about:blank';
    if (!page || typeof page !== 'object' || typeof page.app !== 'string') return 'about:blank';
    try { return appEditorUrl({ app: page.app, options: page.options || {}, appearance: page.appearance, accent: page.accent }); }
    catch (err) { return 'about:blank'; }
  });
  // Monitor-mode state + enter action for the editor's Monitor settings page. Enter-only: exiting
  // stays tray-only, since in monitor mode the editor may be on a display the user can't see.
  ipcMain.handle('getMonitorState', (e) => {
    if (!isFrom(e, configWin)) return null;
    return { active: !!monitorMode, hasPanel: !!(panelWin && !panelWin.isDestroyed()) };
  });
  ipcMain.handle('enterMonitorModeFromEditor', (e) => {
    if (!isFrom(e, configWin)) return { ok: false };
    if (monitorMode) return { ok: true };
    if (!panelWin || panelWin.isDestroyed()) return { ok: false, error: 'no panel window — Monitor mode needs the device display' };
    enterMonitorMode();
    return { ok: !!monitorMode };
  });
  ipcMain.handle('getLighting', async (e) => {
    if (!isFrom(e, configWin)) return null;
    let cur = null;
    try { cur = await dev.getLighting(); } catch (er) {}
    // deviceSeen: a connector owns a live device — the editor shows connection state from it.
    const seen = !!dev.active;
    return Object.assign({}, lighting(), cur && Object.keys(cur).length ? cur : {}, { deviceSeen: seen });
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
  // Per-backend permission modes for the Routines tab's Mode picker. Read straight from each
  // backend host's adapter (the same list the panel's Mode button shows) so the editor never
  // duplicates the mode presets. Chat-only backends (owui/api) report [] and get no Mode picker.
  // Run routine NOW from the editor's Routines tab. The editor saves first when dirty, so main's
  // config already holds the on-screen version by the time this fires. resolveRoutine gives the
  // editor a yes/no (e.g. no AI Chat page, empty prompt) to show in its status line; runRoutine does
  // the actual work and shows its own notice on the panel.
  ipcMain.handle('runRoutine', (e, id) => {
    if (!isFrom(e, configWin)) return { ok: false, error: 'not authorized' };
    const r = routines.resolveRoutine(String(id || ''), { routines: (config.settings || {}).routines, grids: config.grids });
    if (!r.ok) return { ok: false, error: r.error };
    try { runRoutine(String(id || '')); } catch (err) { return { ok: false, error: err.message }; }
    return { ok: true, name: r.routine.name || '', page: ((config.grids || []).find(g => g.id === r.pageId) || {}).name || '' };
  });
  ipcMain.handle('getVoiceModes', (e) => {
    if (!isFrom(e, configWin)) return {};
    const modesFor = host => { try { return (host.handlers.getState().meta.modes) || []; } catch (er) { return []; } };
    return {
      claude: modesFor(claudeVoiceHost),
      codex: modesFor(codexVoiceHost),
      copilot: modesFor(copilotVoiceHost),
      owui: [], api: [],
    };
  });

  // ---- run-mode picker (welcome window) + Settings re-run/relaunch ----
  ipcMain.handle('getWelcomeInfo', (e) => {
    if (!isFrom(e, welcomeWin)) return {};
    return { deviceDisplayPresent: !!deviceDisplay(), currentMode: (config.settings || {}).runMode || null };
  });
  ipcMain.handle('setRunMode', (e, mode) => {
    if (!isFrom(e, welcomeWin)) return false;
    const m = (mode === 'software' || mode === 'monitor') ? mode : 'panel';
    if (!config.settings) config.settings = {};
    const uiUp = !!(panelWin && !panelWin.isDestroyed());
    const changed = config.settings.runMode !== m;
    config.settings.runMode = m;
    saveConfig();
    try { if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.close(); } catch (er) {}
    if (!uiUp) applyRunModeAndLaunch();                    // first run: nothing placed yet -> launch now
    else if (changed) applyRunModeLive();                  // re-run while UI is up: rebuild the window in-process
    return true;
  });
  ipcMain.handle('openWelcome', (e) => { if (!isFrom(e, configWin)) return false; createWelcomeWindow(); return true; });

  nativeTheme.on('updated', () => { if (themeGlobal().appearance === 'system') applyTheme(); });   // follow the OS light/dark in System mode
  // First run with no prior config -> ask which run mode before placing any UI; the welcome window's
  // Continue resumes into applyRunModeAndLaunch(). Returning installs (runMode defaults to 'panel')
  // launch straight away.
  if (firstRun) createWelcomeWindow();
  else applyRunModeAndLaunch();

  // Screensaver idle check: one always-running interval; every tick re-reads live config, so page
  // adds/removes and setting edits apply with no re-arm. All gates live in screensaver-idle.js.
  saverTimer = setInterval(saverTick, 10000);

  dev.on('touch', pts => {
    lastPanelInputAt = Date.now();                                             // presence stamp (all modes) — feeds the screensaver idle timer
    if (monitorMode) { const p = pts.find(q => q.action === 1) || pts[0]; if (p) injectTouch(p); return; }   // monitor mode: touch drives the Windows cursor
    if (saverConsumesInput('touch', pts)) return;                              // waking the screensaver eats the whole gesture
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('touch', pts);
  });
  dev.on('knob', k => {
    lastPanelInputAt = Date.now();
    if (monitorMode) return monitorKnob(k);                                    // monitor mode: knob does the configured action (exit is tray-only)
    if (saverConsumesInput('knob', k)) return;                                 // waking the screensaver eats the flick's tail detents too
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
    try { dev.queryFirmware(); } catch (e) {}   // async; the 'state' handler caches the reply for the diagnostics page
    // The mic indicator LED only latches once the panel is fully awake. At connect the device is still
    // mid screen-on activation (screenOn fires at 0/300/800/1500ms), so this first setMic toggles the
    // audio but the LED is dropped. Re-assert after activation settles — screenOn then setMic — which
    // mirrors what a display re-wake does and forces the LED to follow the mic state.
    setTimeout(() => { try { dev.screenOn(); } catch (e) {} applyMic(micState); console.log('mic LED re-assert:', micState); }, 2000);
  });
  dev.on('state', s => { if (s && typeof s === 'object') Object.assign(lastDeviceState, s); });
  dev.on('error', e => console.log('dev error:', e.message));
  dev.start();

  screen.on('display-added', () => {
    dev.screenOn(); refreshReservedDisplay('display added');
    // Panel/monitor mode place the panel when the QUAKE display appears. In monitor mode, enter it
    // once the panel exists so a later-connected device boots into desktop-passthrough as configured.
    setTimeout(() => {
      if (runMode() === 'software') return;
      placePanel();
      if (runMode() === 'monitor' && !monitorMode && panelWin && !panelWin.isDestroyed()) enterMonitorMode();
    }, 800);
  });
  screen.on('display-removed', () => { dev.screenOn(); refreshReservedDisplay('display removed'); });
  screen.on('display-metrics-changed', () => { refreshReservedDisplay('display metrics changed'); setTimeout(placePanel, 500); });
});
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  try { clearInterval(saverTimer); } catch (e) {}             // stop the screensaver idle check
  try { discordService.stop(); } catch (e) {}                 // close Discord IPC and cancel reconnect timers
  try { reservedDisplay.stop(); } catch (e) {}                // release WinEvent hooks and terminate the native helper
  try { claudeVoiceHost.shutdown(); } catch (e) {}       // terminate the claude CLI child, release held approvals, remove the global hook
  try { codexVoiceHost.shutdown(); } catch (e) {}        // terminate the codex app-server child
  try { copilotVoiceHost.shutdown(); } catch (e) {}      // terminate the copilot app-server child
  try { owuiVoiceHost.shutdown(); } catch (e) {}         // abort any in-flight OWUI stream
  try { apiVoiceHost.shutdown(); } catch (e) {}          // abort any in-flight API-endpoint stream
  try { claudeVoiceApprovals.ensureHookRemoved(claudeVoiceLog); } catch (e) {}    // belt-and-braces: never leave our entry behind in the user's global Claude settings
  try { dev.stop(); } catch (e) {}                       // close HID devices + clear keep-alive/rescan timers — an open node-hid handle blocks process exit (Cmd+Q would hang -> force-quit)
  try { oauthHandler.stop(); } catch (e) {}              // stop OAuth callback server + background refresh timers
  try { stopMicMonitor(); } catch (e) {}                 // terminate the native mic-in-use monitor child
  try { if (presenceService) presenceService.stop(); } catch (e) {}      // clear the busy light now rather than waiting for its 30s timeout, and tell HA we are gone
  try { if (meetingRecorder) meetingRecorder.dispose(); } catch (e) {}   // stop any recording + destroy the hidden capture window
  try { if (slideCapture) slideCapture.dispose(); } catch (e) {}         // destroy the hidden slide-capture window
  try { if (sysserver) sysserver.stop(); } catch (e) {}  // stop metrics timers + close the local server
  try { if (dashSession) dashSession.cookies.flushStore(); } catch (e) {}   // commit a fresh webview login to disk before exit
  try { globalShortcut.unregisterAll(); } catch (e) {}   // drop per-page hotkeys
});
