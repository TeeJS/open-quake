'use strict';
/*
 * sysserver.js — tiny localhost HTTP server for the on-panel SystemView + Music app pages. [MIT]
 *
 * Bound to 127.0.0.1 ONLY (never exposed on the network), GET-only. Each page is shown as a panel
 * page pointed at http://127.0.0.1:<port>/… , so its fetches are same-origin — no CORS, no
 * mixed-content. OS-assigned ephemeral port (listen(0)); appPageUrl()/ensure* in main.js use the port.
 *
 * Routes:
 *   GET /            -> SystemView page        GET /metrics      -> system metrics JSON
 *   GET /music       -> Music app page         GET /nowplaying   -> SMTC now-playing JSON
 *   GET /agenda /events -> the Agenda/Events dev apps (list + embedded grid; reuse /haschedule-data)
 *   GET /keyshortcuts -> Keyboard Shortcuts app page   GET /shortcuts -> system/page/custom shortcuts JSON
 *   GET /grid-tiles  -> the active app page's embedded grid (resolved icons) — Music/Agenda/Events
 *   GET /api/office/* -> capability-gated Microsoft 365 data/connect operations (tokens stay in main)
 *   GET /media/<cmd> -> transport (play/pause/next/prev) via onMedia
 *   GET /launch?i=N  -> launch the active app grid's tile N via onLaunch (runAction)
 *   GET /apps/<id>/… -> static files for discovered served drop-in apps  ·  /app-proxy /app-api
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nowplaying = require('./nowplaying');
const haschedule = require('./haschedule');   // HA Schedule dev app (main.js drives its poll start/stop)
const lyrics = require('./lyrics');           // Music lyrics (LRCLIB), fetched on demand for the now-playing track

const FALLBACK = '<!doctype html><meta charset="utf-8">'
  + '<body style="margin:0;background:#05080d;color:#9fb3c8;font:20px Segoe UI, sans-serif">page asset missing.</body>';
// System Monitor is retired: its metrics layer (the `systeminformation` package) spawned a
// PowerShell process per WMI query — hundreds per minute with the page open — which endpoint
// security tools flag as malware-like process churn. Any still-configured SystemView page gets
// this notice instead of the dashboard. A churn-free native rebuild may return in a future version.
const RETIRED_HTML = '<!doctype html><meta charset="utf-8"><title>System Monitor</title>'
  + '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:#05080d;color:#9fb3c8;font:26px Segoe UI, sans-serif;text-align:center">'
  + '<div><div style="font-size:44px;margin-bottom:14px">&#128683;</div>'
  + 'The System Monitor page has been retired.<br>'
  + '<span style="font-size:19px;color:#5c7186">Its metrics collection created heavy process activity that security software flags.<br>'
  + 'You can delete this page in the settings editor.</span></div></body>';
const MEDIA_CMDS = { playpause: 1, next: 1, prev: 1 };
const LOCAL_APP_CSP = [
  "default-src 'self' http: https: file: data: blob:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws: wss:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Static page assets served verbatim. Page scripts were moved out-of-line so the pages can run under a
// strict script-src 'self' (no 'unsafe-inline'); each extracted file is served here, keyed by request
// path (the on-disk name is the path minus its leading slash). Content-type per entry.
const STATIC_FILES = {
  '/ChatWidget.js': 'application/javascript; charset=utf-8',
  '/owui-widget.css': 'text/css; charset=utf-8',
  '/musicview.js': 'application/javascript; charset=utf-8',
  '/meetingview.js': 'application/javascript; charset=utf-8',
  '/lucidtypeview.js': 'application/javascript; charset=utf-8',
  '/lucidtype-dictate.js': 'application/javascript; charset=utf-8',
  '/chatview-config.js': 'application/javascript; charset=utf-8',
  '/chatview-main.js': 'application/javascript; charset=utf-8',
  '/chatview-ptt.js': 'application/javascript; charset=utf-8',
  '/office.js': 'application/javascript; charset=utf-8',
  '/officeCalendar.js': 'application/javascript; charset=utf-8',
  '/office.css': 'text/css; charset=utf-8',
  '/haschedule-ui.js': 'application/javascript; charset=utf-8',
  '/schedule.css': 'text/css; charset=utf-8',
  '/schedule-app.js': 'application/javascript; charset=utf-8',
  '/keyshortcutsview.js': 'application/javascript; charset=utf-8',
  '/claudevoiceview.js': 'application/javascript; charset=utf-8',
  '/livetranslateview.js': 'application/javascript; charset=utf-8',
  '/screensaverview.js': 'application/javascript; charset=utf-8',
  '/claudevoice-vad.js': 'application/javascript; charset=utf-8',
  '/recorderview.js': 'application/javascript; charset=utf-8',
  '/system-audio-capture.js': 'application/javascript; charset=utf-8',
  '/slidecapture-view.js': 'application/javascript; charset=utf-8',
  '/diagnosticsview.js': 'application/javascript; charset=utf-8',
};
for (const appId of ['teams', 'outlook', 'word', 'excel', 'powerpoint', 'onenote', 'onedrive', 'office']) {
  STATIC_FILES['/office-icons/' + appId + '.svg'] = 'image/svg+xml; charset=utf-8';
}

let server = null, onMedia = null, onLaunch = null, getGridTiles = null, getAppConfig = null, getOfficeData = null, connectOffice = null, onOpenExternal = null, onMeetingAction = null, onOfficeAction = null, getShortcuts = null;
let getMeetingState = null, onMeetingRecord = null;   // meeting recorder: panel poller + start/stop/setMic remote
let onMeetingLibrary = null, resolveMeetingAudio = null;   // recordings library + transcription/analysis remotes
let onSlide = null;   // slide capture: window list / select / start / stop / manual remote
let onHighlight = null;   // mid-meeting highlights: start / stop / cancel remote
let getDeviceDiagnostics = null;   // Device Diagnostics served app: live Display/Touch/Knob snapshot
let getLucidState = null, onLucidDictation = null, onLucidApply = null, onLucidEdit = null, onLucidSetMic = null;   // LucidType dictation: panel poller + start/stop + apply + edit-sync + on-panel mic pick
let onLucidCleanup = null, onLucidRewrite = null, onLucidReview = null, onLucidSetMode = null;   // LucidType cleanup/rewrite (Phase 2): run + review apply/refine/cancel + rewrite-mode pick
const lucidSubscribers = new Set();   // open SSE responses for the LucidType page (pushed by main via lucidBroadcast)
let diagnosticsHtml = FALLBACK;
let musicHtml = FALLBACK, chatHtml = FALLBACK, officeHtml = FALLBACK, hascheduleHtml = FALLBACK, agendaHtml = FALLBACK, eventsHtml = FALLBACK, meetingHtml = FALLBACK, keyshortcutsHtml = FALLBACK, recorderHtml = FALLBACK, slideHtml = FALLBACK, lucidtypeHtml = FALLBACK, lucidtypeDictateHtml = FALLBACK;
// Claude Code voice app wiring (all optional, supplied via start(opts) -- see main.js).
// Voice-panel app registry: appId (also the URL path prefix) -> { handlers, voiceToken, htmlFile,
// htmlContent }. `handlers` is a voicepanel-host.js handlers object; every voice app shares the
// exact same route suffixes below, so the one shared page works for all of them. `voiceToken`
// (per app, per boot) gates that app's /approval-request route -- entries without one (agents
// whose approvals are in-band) simply have no such route.
let voiceApps = {};
const staticAssets = {};   // request path -> { body, type }; populated at start()
let appFolders = {};        // drop-in served app id -> { root, proxy }; supplied by main.js
const appServers = {};      // app id -> required server module
const DEFAULT_OFFICE_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
let officeCapability = null;
let officeCapabilityTtlMs = DEFAULT_OFFICE_CAPABILITY_TTL_MS;
let currentTime = Date.now;

function headers(type) { return { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': LOCAL_APP_CSP }; }
function html(res, body) { res.writeHead(200, headers('text/html; charset=utf-8')); res.end(body); }
function json(res, obj) { res.writeHead(200, headers('application/json; charset=utf-8')); res.end(JSON.stringify(obj)); }
function done(res, ok) { res.writeHead(ok ? 200 : 400, headers('application/json')); res.end(JSON.stringify({ ok: !!ok })); }
function officeJson(res, obj, nextCapability) {
  const h = headers('application/json; charset=utf-8');
  if (nextCapability) h['X-Open-Quake-Capability'] = nextCapability;
  res.writeHead(200, h);
  res.end(JSON.stringify(obj));
}

function newOfficeCapability() {
  officeCapability = {
    token: crypto.randomBytes(32).toString('base64url'),
    expiresAt: currentTime() + officeCapabilityTtlMs,
  };
  return officeCapability.token;
}

function issueOfficeCapability() {
  if (officeCapability && officeCapability.expiresAt > currentTime()) return officeCapability.token;
  return newOfficeCapability();
}

function clearOfficeCapability() {
  officeCapability = null;
}

function consumeOfficeCapability(req) {
  const auth = String(req.headers.authorization || '');
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth);
  if (!match || !officeCapability) return null;
  if (officeCapability.expiresAt <= currentTime()) {
    clearOfficeCapability();
    return null;
  }
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(officeCapability.token);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  return newOfficeCapability();
}
function setAppFolders(folders) {
  appFolders = {};
  Object.keys(appServers).forEach(id => { if (!folders || !folders[id]) delete appServers[id]; });
  Object.entries(folders || {}).forEach(([id, value]) => {
    appFolders[id] = typeof value === 'string' ? { root: value, proxy: null } : Object.assign({}, value || {});
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',   // plays only when the codecs are H.264/AAC (Electron's ffmpeg)
};
function mimeFor(file) { return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'; }
function serveDropInApp(url, res) {
  const m = /^\/apps\/([A-Za-z0-9_-]+)\/(.+)$/.exec(url);
  if (!m) return false;
  const appInfo = appFolders[m[1]];
  const root = appInfo && appInfo.root;
  if (!root) { res.writeHead(404); res.end(); return true; }
  let rel;
  try { rel = decodeURIComponent(m[2]).replace(/\\/g, '/'); }
  catch (e) { res.writeHead(400); res.end(); return true; }
  if (!rel || rel.includes('..') || rel.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rel) || path.isAbsolute(rel)) {
    res.writeHead(403); res.end(); return true;
  }
  const absRoot = path.resolve(root);
  const file = path.resolve(absRoot, rel);
  if (file !== absRoot && !file.startsWith(absRoot + path.sep)) { res.writeHead(403); res.end(); return true; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); res.end(); return; }
    res.writeHead(200, headers(mimeFor(file)));
    res.end(body);
  });
  return true;
}

// Shared Range-capable file streamer (meeting audio, screensaver media). Chromium <audio>/<video>
// seek with single-range requests, so honor bytes=a-b with a 206; anything else gets the whole
// file. A null path, missing file, or non-file 404s.
function streamFileRange(req, res, filePath, contentType) {
  let st = null;
  if (filePath) { try { st = fs.statSync(filePath); } catch (e) {} }
  if (!st || !st.isFile()) { res.writeHead(404); res.end(); return; }
  const h = headers(contentType);
  h['Accept-Ranges'] = 'bytes';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let first = m[1] ? parseInt(m[1], 10) : st.size - parseInt(m[2], 10);
    let last = (m[1] && m[2]) ? parseInt(m[2], 10) : st.size - 1;
    if (!Number.isFinite(first) || first < 0) first = 0;
    if (!Number.isFinite(last) || last >= st.size) last = st.size - 1;
    if (first > last || first >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
    h['Content-Range'] = 'bytes ' + first + '-' + last + '/' + st.size;
    h['Content-Length'] = last - first + 1;
    res.writeHead(206, h);
    fs.createReadStream(filePath, { start: first, end: last }).pipe(res);
  } else {
    h['Content-Length'] = st.size;
    res.writeHead(200, h);
    fs.createReadStream(filePath).pipe(res);
  }
}

function requestingAppId(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.protocol !== 'http:' || !(u.hostname === '127.0.0.1' || u.hostname === 'localhost') || Number(u.port) !== loopbackPort()) return null;
    const m = /^\/apps\/([A-Za-z0-9_-]+)\//.exec(u.pathname);
    return m && appFolders[m[1]] ? m[1] : null;
  } catch (e) {
    return null;
  }
}
function queryValue(full, key) {
  try { return new URL(full, 'http://127.0.0.1').searchParams.get(key) || ''; }
  catch (e) { return ''; }
}
function queryObject(full) {
  const out = {};
  try { new URL(full, 'http://127.0.0.1').searchParams.forEach((value, key) => { out[key] = value; }); } catch (e) {}
  return out;
}
// Reads a POST body into a Buffer, capped at 10MB (comfortably covers a few seconds of raw 16-bit
// PCM audio at 16kHz mono -- see /claude-voice/audio in Phase 5 -- while still bounding memory use).
function readRawBody(req, maxBytes) {
  const cap = maxBytes || 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > cap) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req, maxBytes) {
  const buf = await readRawBody(req, maxBytes);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}
function privateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(h) || /^10(?:\.\d{1,3}){3}$/.test(h) || /^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
  const m = /^172\.(\d{1,3})(?:\.\d{1,3}){2}$/.exec(h);
  return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}
function proxyAllowed(appId, targetUrl) {
  const appInfo = appFolders[appId];
  const proxy = appInfo && appInfo.proxy;
  if (!proxy) return false;
  if (proxy.methods && Array.isArray(proxy.methods) && !proxy.methods.includes('GET')) return false;
  let target;
  try { target = new URL(targetUrl); } catch (e) { return false; }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  const allow = Array.isArray(proxy.allow) ? proxy.allow : [];
  if (!allow.length) return false;
  return allow.some(rule => {
    if (rule.option) {
      let cfg;
      try { cfg = getAppConfig && getAppConfig(appId); } catch (e) {}
      const baseValue = cfg && cfg.options && cfg.options[rule.option];
      if (!baseValue) return false;
      try {
        const base = new URL(String(baseValue).replace(/\/+$/, '') + '/');
        const basePath = base.pathname === '/' ? '/' : base.pathname.replace(/\/+$/, '/') ;
        return target.origin === base.origin && (basePath === '/' || target.pathname === basePath.slice(0, -1) || target.pathname.startsWith(basePath));
      } catch (e) {
        return false;
      }
    }
    if (privateHost(target.hostname)) return false;
    try { return new RegExp(rule.pattern).test(target.href); }
    catch (e) { return false; }
  });
}
function verifySslFor(appId) {
  const appInfo = appFolders[appId] || {};
  const opt = appInfo.proxy && appInfo.proxy.verifySslOption;
  if (!opt || !getAppConfig) return true;
  try {
    const cfg = getAppConfig(appId);
    return !cfg || !cfg.options || cfg.options[opt] !== false;
  } catch (e) {
    return true;
  }
}
function proxyFetch(targetUrl, verifySsl, redirects, cb) {
  let target;
  try { target = new URL(targetUrl); } catch (e) { return cb(e); }
  const lib = target.protocol === 'https:' ? https : http;
  const req = lib.get(target, {
    timeout: 12000,
    headers: { 'User-Agent': 'open-quake/NewsSpotlight', 'Accept': 'application/rss+xml, application/xml, text/xml, text/html, */*' },
    agent: target.protocol === 'https:' && !verifySsl ? new https.Agent({ rejectUnauthorized: false }) : undefined,
  }, upstream => {
    const location = upstream.headers.location;
    if (location && upstream.statusCode >= 300 && upstream.statusCode < 400 && redirects > 0) {
      upstream.resume();
      let next;
      try { next = new URL(location, target).href; } catch (e) { return cb(e); }
      return proxyFetch(next, verifySsl, redirects - 1, cb);
    }
    const chunks = [];
    let size = 0;
    upstream.on('data', chunk => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) req.destroy(new Error('response too large'));
      else chunks.push(chunk);
    });
    upstream.on('end', () => cb(null, {
      status: upstream.statusCode || 502,
      type: upstream.headers['content-type'] || 'application/octet-stream',
      body: Buffer.concat(chunks),
    }));
  });
  req.on('timeout', () => req.destroy(new Error('request timed out')));
  req.on('error', cb);
}
function serveAppProxy(req, res, full) {
  const appId = requestingAppId(req);
  const target = queryValue(full, 'url');
  if (!appId || !proxyAllowed(appId, target)) { res.writeHead(403); res.end(); return; }
  proxyFetch(target, verifySslFor(appId), 3, (err, result) => {
    if (err) { res.writeHead(502, headers('text/plain; charset=utf-8')); res.end(err.message || 'proxy failed'); return; }
    res.writeHead(result.status, headers(result.type));
    res.end(result.body);
  });
}
function appOptions(appId) {
  try {
    const cfg = getAppConfig && getAppConfig(appId);
    return cfg && cfg.options || {};
  } catch (e) {
    return {};
  }
}
function appServer(appId) {
  const appInfo = appFolders[appId];
  if (!appInfo || !appInfo.server) return null;
  if (appServers[appId]) return appServers[appId];
  const root = path.resolve(appInfo.root);
  const serverFile = path.resolve(appInfo.server);
  if (serverFile !== root && !serverFile.startsWith(root + path.sep)) return null;
  try {
    appServers[appId] = require(serverFile);
    return appServers[appId];
  } catch (e) {
    console.log('app server load error:', appId, '-', e.message);
    return null;
  }
}
async function serveAppApi(req, res, full, url) {
  const appId = requestingAppId(req);
  const action = url.slice('/app-api/'.length);
  if (!appId || !action) { return done(res, false); }
  const mod = appServer(appId);
  if (mod && typeof mod.handle === 'function') {
    try {
      const result = await mod.handle(action, { appId, query: queryObject(full), options: appOptions(appId) });
      const status = result && result.ok === false && result.error === 'unknown action' ? 400 : 200;
      res.writeHead(status, headers('application/json; charset=utf-8'));
      res.end(JSON.stringify(result == null ? { ok: true } : result));
      return;
    } catch (e) {
      res.writeHead(500, headers('application/json; charset=utf-8'));
      res.end(JSON.stringify({ ok: false, error: e.message || 'app server failed' }));
      return;
    }
  }
  if (action !== 'open') { return done(res, false); }
  const target = queryValue(full, 'url');
  let ok = false;
  try {
    const parsed = new URL(target);
    ok = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && typeof onOpenExternal === 'function' && !!onOpenExternal(parsed.href);
  } catch (e) {}
  return done(res, ok);
}

// Loopback-only hardening. The server binds 127.0.0.1, but a malicious web page (or a DNS-rebinding
// hostname that resolves to 127.0.0.1) can still try to reach it. hostOk() rejects any request whose
// Host header isn't our own loopback origin (the browser sets Host from the URL and JS can't forge it,
// so this defeats DNS rebinding). sameOrigin() additionally requires that side-effecting / data /
// secret routes come from our own served page (Sec-Fetch-Site, with an Origin fallback); the static
// page + asset routes stay reachable by the panel webview's top-level navigation.
function loopbackPort() { const a = server && server.address(); return a ? a.port : null; }
function hostOk(req) {
  const port = loopbackPort();
  if (port == null) return false;
  const host = req.headers.host;
  return host === '127.0.0.1:' + port || host === 'localhost:' + port;
}
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';                       // modern Chromium: only our own page's fetches
  const origin = req.headers.origin;
  if (!origin) return false;                                     // no Sec-Fetch AND no Origin: fail closed (our served pages always send Sec-Fetch-Site)
  try { const o = new URL(origin); return o.protocol === 'http:' && (o.hostname === '127.0.0.1' || o.hostname === 'localhost') && Number(o.port) === loopbackPort(); }
  catch (e) { return false; }
}
function allowedOfficeExternalUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    const allowed = host === 'teams.microsoft.com'
      || host === 'teams.live.com'
      || host === 'outlook.office.com'
      || host === 'outlook.office365.com'
      || host === 'outlook.live.com'
      || host === 'www.office.com'
      || host === 'office.com';
    return allowed ? parsed.href : null;
  } catch (e) { return null; }
}
function allowedTeamsMeetingUrl(value) {
  const target = allowedOfficeExternalUrl(value);
  if (!target) return null;
  try {
    const parsed = new URL(target);
    const host = parsed.hostname.toLowerCase();
    return !parsed.port
      && (host === 'teams.microsoft.com' || host === 'teams.live.com')
      && /^\/(?:l|meet)\//i.test(parsed.pathname) ? parsed.href : null;
  } catch (e) { return null; }
}

// Voice-panel apps: the only routes in this server that need a request body (turn text, raw PCM
// audio) rather than a query string -- so they're the only ones allowed to be POST. Everything
// else stays GET-only, unchanged. Suffixes are relative to the app's own prefix (/claude-voice,
// /codex-voice, ...). /approval-request (called by an external hook process, not the browser guest
// page) is intentionally NOT in this set -- it has no Origin/Sec-Fetch-Site header at all and is
// gated separately by the app's per-boot voiceToken (see handler() below).
const VOICE_POST_SUFFIXES = new Set([
  '/turn',
  '/audio',
  '/approval-decision',
  '/session/start',
  '/session/stop',
  '/permission-mode',
  '/profile',
  '/panel-accept',
  '/routine-save',
  '/panel-cancel',
  '/model',
  '/tts',
  '/option',
  '/append-line',
]);

// TTS handoff: reply text can be many KB -- far beyond what fits in a GET query string (Node
// rejects an oversized request line with 431 BEFORE any handler runs, which silently killed
// speech on long replies). The page POSTs the text here, gets a short id, and points its <audio>
// at /claude-voice/tts-audio?id=<id>. Entries are capped; not deleted on read because Chromium
// may issue multiple range requests for one <audio> element.
const ttsTexts = new Map();
let ttsSeq = 0;
function storeTtsText(text) {
  const id = (++ttsSeq) + '-' + Math.random().toString(36).slice(2, 8);
  ttsTexts.set(id, text);
  while (ttsTexts.size > 50) ttsTexts.delete(ttsTexts.keys().next().value);
  return id;
}

// Library route path -> op name passed to onMeetingLibrary (main.js). Kept as one table so the
// handler branch, main.js dispatch, and the tests all agree on the surface.
const MEETING_LIBRARY_OPS = {
  '/meeting-files': 'files',
  '/meeting-file-delete': 'delete',
  '/meeting-transcribe/start': 'transcribeStart',
  '/meeting-transcribe/state': 'transcribeState',
  '/meeting-analyze/start': 'analyzeStart',
  '/meeting-analyze/state': 'analyzeState',
  '/meeting-analysis': 'analysisResult',
};

async function handler(req, res) {
  if (!hostOk(req)) { res.writeHead(403); res.end(); return; }   // foreign / DNS-rebinding Host -> reject (all routes)
  const full = req.url || '/';
  const url = full.split('?')[0];
  // Voice-app dispatch: /<appId>/<suffix> where <appId> is a registered voice-panel app. All voice
  // apps share identical suffixes; everything about the request below is resolved per-app. A
  // multi-backend app (AI Voice) adds one segment: /<appId>/<backend>/<suffix> — the page itself
  // still serves at /<appId>, and an unknown backend segment falls through to 404/405.
  const seg1 = url.split('/')[1] || '';
  let voiceApp = voiceApps[seg1] || null;
  let voicePrefixLen = seg1.length + 1;
  if (voiceApp && voiceApp.backends) {
    const seg2 = url.split('/')[2] || '';
    const backendEntry = voiceApp.backends[seg2] || null;
    if (backendEntry) {
      voiceApp = { handlers: backendEntry.handlers, voiceToken: backendEntry.voiceToken, htmlContent: voiceApp.htmlContent };
      voicePrefixLen += seg2.length + 1;
    } else if (seg2) {
      voiceApp = null;   // /ai-voice/<not-a-backend>/... is nobody's route
    }
    // seg2 === '' -> the bare /<appId> page request; the parent entry (page HTML, no handlers) serves it.
  }
  const voicePath = voiceApp ? (url.slice(voicePrefixLen) || '/') : null;
  const isAllowedPost = (req.method === 'POST' && voiceApp && (VOICE_POST_SUFFIXES.has(voicePath) || voicePath === '/approval-request'))
    || (req.method === 'POST' && (url === '/lucidtype-edit' || url === '/lucidtype-review/apply' || url === '/lucidtype-review/refine'));   // LucidType edit-sync + review apply/refine (same-origin gated below)
  if (req.method !== 'GET' && !isAllowedPost) { res.writeHead(405); res.end(); return; }
  if (url === '/' || url === '/index.html') return html(res, RETIRED_HTML);   // retired SystemView page
  if (url === '/music') return html(res, musicHtml);
  if (url === '/meeting') return html(res, meetingHtml);
  if (url === '/diagnostics') return html(res, diagnosticsHtml);
  if (url === '/lucidtype') return html(res, lucidtypeHtml);
  if (url === '/lucidtype-dictate') return html(res, lucidtypeDictateHtml);   // hidden LucidType capture page
  if (url === '/recorder') return html(res, recorderHtml);   // hidden meeting-recorder capture page
  if (url === '/slidecapture') return html(res, slideHtml);  // hidden slide-capture window
  if (url === '/chat') return html(res, chatHtml);
  if (url === '/office') return html(res, officeHtml);
  if (url === '/haschedule') return html(res, hascheduleHtml);
  if (url === '/agenda') return html(res, agendaHtml);
  if (url === '/events') return html(res, eventsHtml);
  if (url === '/keyshortcuts') return html(res, keyshortcutsHtml);
  if (voiceApp && voicePath === '/') return html(res, voiceApp.htmlContent);
  // /<app>/approval-request: called by an external hook process (e.g. quake-approval-hook.js), a
  // plain Node process with no Origin/Sec-Fetch-Site headers at all -- sameOrigin() below would
  // always reject it, so it's gated here instead by the app's per-boot voiceToken, which the hook
  // receives via its own environment. Apps without a token have no such route.
  if (voiceApp && voicePath === '/approval-request' && req.method === 'POST') {
    const h = voiceApp.handlers;
    const okToken = !!voiceApp.voiceToken && req.headers['x-oqx-voice-token'] === voiceApp.voiceToken;
    if (!okToken) { res.writeHead(403); res.end(); return; }
    return readJsonBody(req).then(body => h.approvalRequest ? h.approvalRequest(body, res) : done(res, false))
      .catch(() => done(res, false));
  }
  const asset = staticAssets[url];
  if (asset) { res.writeHead(200, headers(asset.type)); return res.end(asset.body); }
  if (serveDropInApp(url, res)) return;
  // Below here: side effects (/launch, /media), live data (/metrics, /nowplaying, /musictiles), or
  // secrets (/app-config). Require the request to originate from our own served page — not a
  // cross-site fetch, image, form, or navigation.
  if (!sameOrigin(req)) { res.writeHead(403); res.end(); return; }
  if (url === '/app-config') {
    const m = /[?&]app=([A-Za-z0-9_-]+)/.exec(full);
    const cfg = (m && getAppConfig) ? getAppConfig(m[1]) : null;
    return cfg ? json(res, cfg) : done(res, false);
  }
  if (url === '/app-proxy/config') {
    const appId = requestingAppId(req);
    const cfg = appId && getAppConfig ? getAppConfig(appId) : null;
    return cfg ? json(res, cfg) : done(res, false);
  }
  // Opening a host-owned URL is a non-secret side effect guarded by the same-origin check above.
  // It deliberately does not consume Office's rotating data capability: calendar polling and a
  // touchscreen action may occur concurrently, and sharing the one-time capability would make one
  // request invalidate the other and strand the renderer with an expired token.
  if (url === '/api/office/open') {
    const target = allowedOfficeExternalUrl(queryValue(full, 'url'));
    const ok = !!target && typeof onOpenExternal === 'function' && !!onOpenExternal(target);
    return json(res, { ok });
  }
  if (url === '/api/office/data' || url === '/api/office/connect') {
    const nextCapability = consumeOfficeCapability(req);
    if (!nextCapability) { res.writeHead(403); res.end(); return; }
    const operation = url === '/api/office/data' ? getOfficeData : connectOffice;
    if (typeof operation !== 'function') return officeJson(res, { ok: false, error: 'Office service unavailable' }, nextCapability);
    try { return officeJson(res, await operation(), nextCapability); }
    catch (e) { return officeJson(res, { ok: false, error: e.message || 'Office request failed', code: e.code || '' }, nextCapability); }
  }
  if (url === '/app-proxy') return serveAppProxy(req, res, full);
  if (url.indexOf('/app-api/') === 0) return serveAppApi(req, res, full, url);
  if (url === '/metrics') return json(res, { retired: true });   // graceful null for any stale SystemView client
  if (url === '/nowplaying') return json(res, nowplaying.getSnapshot());
  if (url === '/lyrics') { try { await lyrics.ensure(nowplaying.getSnapshot()); } catch (e) {} return json(res, lyrics.getSnapshot()); }   // synced lyrics for the current track
  if (url === '/haschedule-data') return json(res, haschedule.getSnapshot());
  if (voiceApp) {
    const h = voiceApp.handlers;
    if (voicePath === '/turn' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      const text = body && typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || !h.onTurn) return done(res, false);
      // `speak` = the page wants this turn's reply spoken; the response's `speech` id (when set) is
      // what the page feeds into /<app>/turn-audio to receive that one continuous WAV stream.
      let out = null; try { out = h.onTurn(text, !!body.speak); } catch (e) {}
      return json(res, out && out.ok ? out : { ok: false });
    }
    if (voicePath === '/state') {
      return json(res, h.getState ? h.getState() : { running: false, status: 'idle' });
    }
    if (voicePath === '/events') {
      if (!h.subscribe) { res.writeHead(503); res.end(); return; }
      h.subscribe(req, res);   // keeps res open itself; nothing to return/end here
      return;
    }
    if (voicePath === '/session/start' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { body = {}; }
      let ok = false;
      if (h.sessionStart) { try { ok = !!h.sessionStart(body && body.projectDir); } catch (e) {} }
      return done(res, ok);
    }
    if (voicePath === '/audio' && req.method === 'POST') {
      let pcm; try { pcm = await readRawBody(req); } catch (e) { return done(res, false); }
      if (!pcm.length || !h.transcribe) return json(res, { ok: false, text: '' });
      let result; try { result = await h.transcribe(pcm); } catch (e) { result = { ok: false, error: e.message }; }
      return json(res, result);
    }
    if (voicePath === '/option' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      const key = body && typeof body.key === 'string' ? body.key : '';
      if (!key || body.value == null || !h.setOption) return done(res, false);
      let ok = false; try { ok = !!h.setOption(key, String(body.value)); } catch (e) {}
      return done(res, ok);
    }
    // Live Translate (Soniox provider): mint a short-lived temp key server-side so the real key never
    // reaches the renderer; the page authenticates its Soniox WebSocket with it. GET, same-origin-gated.
    if (voicePath === '/soniox-token') {
      if (!h.sonioxToken) return json(res, { ok: false });
      let out; try { out = await h.sonioxToken(); } catch (e) { out = { ok: false, error: e.message }; }
      return json(res, out || { ok: false });
    }
    // Live Translate (AI provider): pre-flight before the mic starts — is the endpoint configured
    // and the local STT actually listening? Returns the first blocking problem as a human sentence.
    if (voicePath === '/ai-ready') {
      if (!h.aiReady) return json(res, { ok: true });
      let out; try { out = await h.aiReady(); } catch (e) { out = { ok: false, error: e.message }; }
      return json(res, out || { ok: true });
    }
    // Live Translate: persist the streamed translation to the save file (posted on stop).
    if (voicePath === '/append-line' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      const text = body && typeof body.text === 'string' ? body.text : '';
      if (!text || !h.appendLine) return done(res, false);
      let ok = false; try { ok = !!(h.appendLine(text) || {}).ok; } catch (e) {}
      return done(res, ok);
    }
    if (voicePath === '/tts' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      const text = body && typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return done(res, false);
      return json(res, { ok: true, id: storeTtsText(text) });
    }
    if (voicePath === '/tts-audio') {
      const id = queryValue(full, 'id');
      const text = id ? (ttsTexts.get(id) || '') : queryValue(full, 'text');   // ?text= kept for short/manual use
      if (!text || !h.synthesize) { res.writeHead(400); res.end(); return; }
      return h.synthesize(text, res);   // pipes the response itself; nothing to return here
    }
    if (voicePath === '/turn-audio') {
      // One continuous WAV per voice turn, streamed by the main-process speech pipeline while the
      // reply is still being generated. Long-lived response; the page closing it is the barge-in
      // signal that aborts synthesis. A stale/unknown turn id is 404'd by the pipeline itself.
      const turnId = queryValue(full, 'turn');
      if (!turnId || !h.turnAudio) { res.writeHead(404); res.end(); return; }
      h.turnAudio(turnId, req, res);   // holds res open and streams; nothing to return here
      return;
    }
    if (voicePath === '/session/stop' && req.method === 'POST') {
      let ok = false;
      if (h.sessionStop) { try { ok = !!h.sessionStop(); } catch (e) {} }
      return done(res, ok);
    }
    if (voicePath === '/projects') {
      const browsePath = queryValue(full, 'path');
      return json(res, h.getProjects ? h.getProjects(browsePath) : { root: '', parent: null, dirs: [], current: '', recents: [] });
    }
    // Screensaver media: one validated file from the page's configured photos (k=p) or videos
    // (k=v) folder, streamed with Range support for <video> seeking/looping. Name -> path
    // containment lives in the host's resolveMedia; an inactive page (or any rejected name)
    // resolves null and 404s.
    if (voicePath === '/media') {
      let p = null;
      if (h.resolveMedia) { try { p = h.resolveMedia(queryValue(full, 'f'), queryValue(full, 'k')); } catch (e) {} }
      return streamFileRange(req, res, p, p ? mimeFor(p) : 'application/octet-stream');
    }
    if (voicePath === '/permission-mode' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      const mode = body && typeof body.mode === 'string' ? body.mode : '';
      if (!mode || !h.setPermissionMode) return done(res, false);
      let ok = false; try { ok = !!h.setPermissionMode(mode); } catch (e) {}
      return done(res, ok);
    }
    // AI profile switch (Smart Profiles): the page's picker posts the chosen profile id.
    if (voicePath === '/profile' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      const id = body && typeof body.id === 'string' ? body.id : null;
      if (id == null || !h.setProfile) return done(res, false);
      let ok = false; try { ok = !!h.setProfile(id); } catch (e) {}
      return done(res, ok);
    }
    // "+ Routine" beside Send: save what's in the message field, or (empty field) the last request
    // that was sent, as a reusable routine. Returns the auto-generated name for the on-screen
    // confirmation -- the panel has no keyboard, so naming happens here, not in a dialog.
    if (voicePath === '/routine-save' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      if (!h.saveRoutine) return done(res, false);
      let out = null;
      try { out = h.saveRoutine(body && typeof body.text === 'string' ? body.text : ''); } catch (e) { out = { ok: false, error: e.message }; }
      return json(res, out || { ok: false });
    }
    // Panel Builder: accept the page the AI proposed. `confirm` is the user's informed second yes,
    // sent only after the panel has shown them the actual commands a risky panel would run.
    if (voicePath === '/panel-accept' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      if (!h.panelAccept) return done(res, false);
      let r = null; try { r = h.panelAccept(!!(body && body.confirm), !!(body && body.replace)); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(r || { ok: false }));
    }
    if (voicePath === '/panel-cancel' && req.method === 'POST') {
      if (!h.panelCancel) return done(res, false);
      let ok = false; try { ok = !!(h.panelCancel() || {}).ok; } catch (e) {}
      return done(res, ok);
    }
    if (voicePath === '/model' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      const model = body && typeof body.model === 'string' ? body.model : null;   // '' = account default, so null-check not truthiness
      if (model == null || !h.setModel) return done(res, false);
      let ok = false; try { ok = !!h.setModel(model); } catch (e) {}
      return done(res, ok);
    }
    if (voicePath === '/approval-decision' && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch (e) { return done(res, false); }
      const requestId = body && body.requestId, decision = body && body.decision;
      // 'always' = approve and stop asking for similar requests this session (adapters that don't
      // support it never advertise the button, and would treat it as a plain allow at worst).
      if (!requestId || (decision !== 'allow' && decision !== 'deny' && decision !== 'always') || !h.approvalDecision) return done(res, false);
      let ok = false; try { ok = !!h.approvalDecision(requestId, decision); } catch (e) {}
      return done(res, ok);
    }
  }
  if (url === '/shortcuts') return json(res, getShortcuts ? getShortcuts() : { rotation: null, pages: [], custom: [] });
  if (url === '/grid-tiles') {
    let t = { cols: 2, rows: 2, tiles: [] };
    if (getGridTiles) { try { t = await getGridTiles(); } catch (e) {} }
    return json(res, t);
  }
  if (url.indexOf('/media/') === 0) {
    const cmd = url.slice(7);
    let ok = false;
    if (MEDIA_CMDS[cmd] && typeof onMedia === 'function') { try { ok = !!onMedia(cmd); } catch (e) {} }
    return done(res, ok);
  }
  if (url.indexOf('/meeting-action/') === 0) {
    const rest = url.slice('/meeting-action/'.length);
    const slash = rest.indexOf('/');
    const platform = slash < 0 ? '' : rest.slice(0, slash);
    const action = slash < 0 ? '' : rest.slice(slash + 1);
    let result = { ok: false, error: 'not wired' };
    if (platform && action && typeof onMeetingAction === 'function') {
      try { result = await onMeetingAction(platform, action); }
      catch (e) { result = { ok: false, error: e.message || 'meeting action failed' }; }
    }
    return json(res, result);
  }
  // Meeting recorder: the panel page polls /meeting-state and drives start/stop/setMic here.
  if (url === '/device-diagnostics') {
    return json(res, typeof getDeviceDiagnostics === 'function' ? getDeviceDiagnostics() : { mode: 'software', channels: {} });
  }
  if (url === '/meeting-state') {
    return json(res, typeof getMeetingState === 'function' ? getMeetingState() : { recording: false });
  }
  // LucidType dictation: the panel page subscribes to /lucidtype-events (SSE, real-time push) and
  // falls back to polling /lucidtype-state; it drives start/stop/apply/edit here.
  if (url === '/lucidtype-events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    res.write(': connected\n\n');
    if (typeof getLucidState === 'function') { try { res.write('data: ' + JSON.stringify(getLucidState()) + '\n\n'); } catch (e) {} }   // fresh subscriber gets the current state at once
    lucidSubscribers.add(res);
    req.on('close', () => { lucidSubscribers.delete(res); });
    return;
  }
  if (url === '/lucidtype-state') {
    return json(res, typeof getLucidState === 'function' ? getLucidState() : { dictating: false, transcript: '', seq: 0 });
  }
  if (url === '/lucidtype-dictation/start' || url === '/lucidtype-dictation/stop') {
    const cmd = url.endsWith('/start') ? 'start' : 'stop';
    const mode = new URL(full, 'http://local').searchParams.get('mode') || '';   // clear | append (start only)
    let result = { ok: false, error: 'not wired' };
    if (typeof onLucidDictation === 'function') {
      try { result = await onLucidDictation(cmd, mode); } catch (e) { result = { ok: false, error: e.message || 'dictation command failed' }; }
    }
    return json(res, result);
  }
  if (url === '/lucidtype-apply') {
    let result = { ok: false, error: 'not wired' };
    if (typeof onLucidApply === 'function') {
      try { result = await onLucidApply(); } catch (e) { result = { ok: false, error: e.message || 'apply failed' }; }
    }
    return json(res, result);
  }
  if (url.indexOf('/lucidtype-set-mic/') === 0) {
    const label = decodeURIComponent(url.slice('/lucidtype-set-mic/'.length));
    let result = { ok: false, error: 'not wired' };
    if (typeof onLucidSetMic === 'function') {
      try { result = await onLucidSetMic(label); } catch (e) { result = { ok: false, error: e.message || 'set-mic failed' }; }
    }
    return json(res, result);
  }
  if (url === '/lucidtype-edit' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    let result = { ok: false };
    if (typeof onLucidEdit === 'function') {
      try { result = await onLucidEdit(body && typeof body.text === 'string' ? body.text : ''); } catch (e) { result = { ok: false, error: e.message }; }
    }
    return json(res, result);
  }
  // Cleanup / Rewrite (Phase 2): kick off the transform (opens a review), then apply/refine/cancel it.
  if (url === '/lucidtype-cleanup' || url === '/lucidtype-rewrite') {
    const fn = url.endsWith('cleanup') ? onLucidCleanup : onLucidRewrite;
    let result = { ok: false, error: 'not wired' };
    if (typeof fn === 'function') { try { result = await fn(); } catch (e) { result = { ok: false, error: e.message }; } }
    return json(res, result);
  }
  if (url === '/lucidtype-review/apply' || url === '/lucidtype-review/refine') {
    const op = url.endsWith('apply') ? 'apply' : 'refine';
    const body = await readJsonBody(req).catch(() => null);
    let result = { ok: false, error: 'not wired' };
    if (typeof onLucidReview === 'function') {
      try { result = await onLucidReview(op, body && typeof body.text === 'string' ? body.text : undefined); } catch (e) { result = { ok: false, error: e.message }; }
    }
    return json(res, result);
  }
  if (url === '/lucidtype-review/cancel') {
    let result = { ok: false, error: 'not wired' };
    if (typeof onLucidReview === 'function') { try { result = await onLucidReview('cancel'); } catch (e) { result = { ok: false, error: e.message }; } }
    return json(res, result);
  }
  if (url.indexOf('/lucidtype-set-mode/') === 0) {
    const mode = decodeURIComponent(url.slice('/lucidtype-set-mode/'.length));
    let result = { ok: false, error: 'not wired' };
    if (typeof onLucidSetMode === 'function') { try { result = await onLucidSetMode(mode); } catch (e) { result = { ok: false, error: e.message }; } }
    return json(res, result);
  }
  // Slide capture: window list + select/start/stop/manual. GET (matching the recorder remotes),
  // same-origin-gated above. Slide state itself rides in /meeting-state so the column polls with it.
  if (url === '/slide/windows' || url === '/slide/select' || url === '/slide/start' || url === '/slide/stop' || url === '/slide/manual') {
    const cmd = url.slice('/slide/'.length);
    const q = new URL(full, 'http://local').searchParams;
    let result = { ok: false, error: 'not wired' };
    if (typeof onSlide === 'function') {
      try { result = await onSlide(cmd, { id: q.get('id') || '', name: q.get('name') || '' }); }
      catch (e) { result = { ok: false, error: e.message || 'slide command failed' }; }
    }
    return json(res, result);
  }
  // Mid-meeting highlights: start / stop the span in progress, or clear it. GET like the slide and
  // recorder remotes; the state itself rides in /meeting-state so the column polls with everything else.
  if (url === '/highlight/start' || url === '/highlight/stop' || url === '/highlight/cancel') {
    const cmd = url.slice('/highlight/'.length);
    let result = { ok: false, error: 'not wired' };
    if (typeof onHighlight === 'function') {
      try { result = await onHighlight(cmd); } catch (e) { result = { ok: false, error: e.message || 'highlight command failed' }; }
    }
    return json(res, result);
  }
  if (url === '/meeting-record/start' || url === '/meeting-record/stop') {
    const cmd = url.endsWith('/start') ? 'start' : 'stop';
    let result = { ok: false, error: 'not wired' };
    if (typeof onMeetingRecord === 'function') {
      try { result = await onMeetingRecord(cmd); } catch (e) { result = { ok: false, error: e.message || 'record command failed' }; }
    }
    return json(res, result);
  }
  if (url.indexOf('/meeting-set-panels/') === 0) {
    const csv = decodeURIComponent(url.slice('/meeting-set-panels/'.length));
    let result = { ok: false, error: 'not wired' };
    if (typeof onMeetingRecord === 'function') {
      try { result = await onMeetingRecord('setPanels', csv); } catch (e) { result = { ok: false, error: e.message || 'set-panels failed' }; }
    }
    return json(res, result);
  }
  if (url.indexOf('/meeting-set-mic/') === 0) {
    const label = decodeURIComponent(url.slice('/meeting-set-mic/'.length));
    let result = { ok: false, error: 'not wired' };
    if (typeof onMeetingRecord === 'function') {
      try { result = await onMeetingRecord('setMic', label); } catch (e) { result = { ok: false, error: e.message || 'set-mic failed' }; }
    }
    return json(res, result);
  }
  // Recordings library + transcription/analysis remotes for the panel's Unprocessed / Transcription /
  // Analysis overlays. All GET (matching /meeting-record above); filename validation happens in
  // main.js/meetingLibrary — a rejected name comes back as {ok:false} or, for audio, a plain 404.
  if (MEETING_LIBRARY_OPS[url]) {
    const q = new URL(full, 'http://local').searchParams;
    let result = { ok: false, error: 'not wired' };
    if (typeof onMeetingLibrary === 'function') {
      try { result = await onMeetingLibrary(MEETING_LIBRARY_OPS[url], { kind: q.get('kind') || '', name: q.get('name') || '', dir: q.get('dir') || '' }); }
      catch (e) { result = { ok: false, error: e.message || 'library request failed' }; }
    }
    return json(res, result);
  }
  // WAV playback for the panel's <audio>. Chromium seeks with single-range requests, so honor
  // bytes=a-b with a 206; anything else gets the whole file.
  if (url === '/meeting-audio') {
    const q = new URL(full, 'http://local').searchParams;
    const p = typeof resolveMeetingAudio === 'function' ? resolveMeetingAudio(q.get('kind') || '', q.get('name') || '') : null;
    return streamFileRange(req, res, p, 'audio/wav');
  }
  if (url.indexOf('/api/office/action/') === 0) {
    if (url === '/api/office/action/meeting') {
      const target = allowedTeamsMeetingUrl(queryValue(full, 'url'));
      let result = { ok: false, error: 'Invalid Microsoft Teams meeting link.' };
      if (target && typeof onOfficeAction === 'function') {
        try { result = await onOfficeAction('meeting', undefined, undefined, target); }
        catch (e) { result = { ok: false, error: e.message || 'Office action failed' }; }
      }
      return json(res, result);
    }
    const match = /^\/api\/office\/action\/(app)\/([0-3])$/.exec(url)
      || /^\/api\/office\/action\/(shortcut)\/([0-3])\/([0-7])$/.exec(url);
    let result = { ok: false, error: 'unknown Office action' };
    if (match && typeof onOfficeAction === 'function') {
      try { result = await onOfficeAction(match[1], Number(match[2]), match[3] == null ? undefined : Number(match[3])); }
      catch (e) { result = { ok: false, error: e.message || 'Office action failed' }; }
    }
    return json(res, result);
  }
  if (url === '/launch') {
    const m = /[?&]i=(\d+)/.exec(full);
    let ok = false;
    if (m && typeof onLaunch === 'function') { try { ok = !!onLaunch(parseInt(m[1], 10)); } catch (e) {} }
    return done(res, ok);
  }
  res.writeHead(404); res.end();
}

// opts: { onMedia(cmd), onLaunch(i), getGridTiles(), getAppConfig(appId), getNowPlaying() } — all optional.
// getNowPlaying is an async now-playing source (e.g. the Spotify Web API client on macOS); when given,
// it becomes the now-playing provider and replaces the win32 SMTC poll (see nowplaying.setProvider).
function start(opts) {
  opts = opts || {};
  onMedia = opts.onMedia || null;
  onLaunch = opts.onLaunch || null;
  getGridTiles = opts.getGridTiles || null;
  getAppConfig = opts.getAppConfig || null;
  getOfficeData = opts.getOfficeData || null;
  connectOffice = opts.connectOffice || null;
  currentTime = typeof opts.now === 'function' ? opts.now : Date.now;
  officeCapabilityTtlMs = Number.isFinite(opts.officeCapabilityTtlMs) && opts.officeCapabilityTtlMs > 0
    ? opts.officeCapabilityTtlMs : DEFAULT_OFFICE_CAPABILITY_TTL_MS;
  onOpenExternal = opts.onOpenExternal || null;
  onMeetingAction = opts.onMeetingAction || null;
  getMeetingState = opts.getMeetingState || null;
  onMeetingRecord = opts.onMeetingRecord || null;
  onSlide = opts.onSlide || null;
  onHighlight = opts.onHighlight || null;
  getDeviceDiagnostics = opts.getDeviceDiagnostics || null;
  onMeetingLibrary = opts.onMeetingLibrary || null;
  resolveMeetingAudio = opts.resolveMeetingAudio || null;
  getLucidState = opts.getLucidState || null;
  onLucidDictation = opts.onLucidDictation || null;
  onLucidApply = opts.onLucidApply || null;
  onLucidEdit = opts.onLucidEdit || null;
  onLucidSetMic = opts.onLucidSetMic || null;
  onLucidCleanup = opts.onLucidCleanup || null;
  onLucidRewrite = opts.onLucidRewrite || null;
  onLucidReview = opts.onLucidReview || null;
  onLucidSetMode = opts.onLucidSetMode || null;
  onOfficeAction = opts.onOfficeAction || null;
  getShortcuts = opts.getShortcuts || null;
  voiceApps = {};
  Object.entries(opts.voiceApps || {}).forEach(([id, v]) => {
    voiceApps[id] = {
      handlers: (v && v.handlers) || {},
      voiceToken: (v && v.voiceToken) || null,
      htmlFile: (v && v.htmlFile) || null,
      htmlContent: FALLBACK,
      // Multi-backend app (AI Voice): the page serves at /<id>, every other route carries the
      // backend as a sub-prefix (/<id>/<backend>/turn, …) resolved in the dispatch below. Each
      // backend brings its own handlers (and optionally its own voiceToken).
      backends: (v && v.backends)
        ? Object.fromEntries(Object.entries(v.backends).map(([b, e]) => [b, {
            handlers: (e && e.handlers) || {},
            voiceToken: (e && e.voiceToken) || null,
          }]))
        : null,
    };
  });
  setAppFolders(opts.appFolders);
  nowplaying.setProvider(opts.getNowPlaying || null);
  return new Promise((resolve, reject) => {
    if (server) return resolve(server.address().port);
    try { musicHtml = fs.readFileSync(path.join(__dirname, 'musicview.html'), 'utf8'); } catch (e) {}
    try { meetingHtml = fs.readFileSync(path.join(__dirname, 'meetingview.html'), 'utf8'); } catch (e) {}
    try { diagnosticsHtml = fs.readFileSync(path.join(__dirname, 'diagnosticsview.html'), 'utf8'); } catch (e) {}
    try { lucidtypeHtml = fs.readFileSync(path.join(__dirname, 'lucidtypeview.html'), 'utf8'); } catch (e) {}
    try { lucidtypeDictateHtml = fs.readFileSync(path.join(__dirname, 'lucidtype-dictate.html'), 'utf8'); } catch (e) {}
    try { recorderHtml = fs.readFileSync(path.join(__dirname, 'recorderview.html'), 'utf8'); } catch (e) {}
    try { slideHtml = fs.readFileSync(path.join(__dirname, 'slidecapture.html'), 'utf8'); } catch (e) {}
    try { chatHtml = fs.readFileSync(path.join(__dirname, 'chatview.html'), 'utf8'); } catch (e) {}
    try { officeHtml = fs.readFileSync(path.join(__dirname, 'office.html'), 'utf8'); } catch (e) {}
    try { hascheduleHtml = fs.readFileSync(path.join(__dirname, 'haschedule.html'), 'utf8'); } catch (e) {}
    try { agendaHtml = fs.readFileSync(path.join(__dirname, 'agenda.html'), 'utf8'); } catch (e) {}
    try { eventsHtml = fs.readFileSync(path.join(__dirname, 'events.html'), 'utf8'); } catch (e) {}
    try { keyshortcutsHtml = fs.readFileSync(path.join(__dirname, 'keyshortcutsview.html'), 'utf8'); } catch (e) {}
    Object.values(voiceApps).forEach(v => {
      if (v.htmlFile) { try { v.htmlContent = fs.readFileSync(path.join(__dirname, v.htmlFile), 'utf8'); } catch (e) {} }
    });
    for (const [route, type] of Object.entries(STATIC_FILES)) {
      try { staticAssets[route] = { body: fs.readFileSync(path.join(__dirname, route.slice(1)), 'utf8'), type }; } catch (e) {}
    }
    // NB: the pollers are NOT started here. They're gated by which panel page is shown — main.js
    // calls setActivePage() on every page switch so each poller runs only while its page is on screen.
    server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (e) {} }); });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Run only the poller the visible page needs; stop the others. Called by main.js whenever the
// active panel page changes. which: 'music' (now-playing) | 'office' | null.
// start()/stop() are idempotent, so this is safe to call on every page push.
function setActivePage(which) {
  if (which !== 'office') clearOfficeCapability();
  if (which === 'music') nowplaying.start();
  else nowplaying.stop();
}

function stop() {
  nowplaying.stop();
  if (server) { try { server.close(); } catch (e) {} server = null; }
  clearOfficeCapability();
  getOfficeData = null;
  connectOffice = null;
  onOfficeAction = null;
  currentTime = Date.now;
  officeCapabilityTtlMs = DEFAULT_OFFICE_CAPABILITY_TTL_MS;
}

// Push a LucidType state payload to every open /lucidtype-events subscriber (called by main on each
// dictation state change). Dropped writes prune themselves from the set.
function lucidBroadcast(payload) {
  const line = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of lucidSubscribers) { try { res.write(line); } catch (e) { lucidSubscribers.delete(res); } }
}

module.exports = { start, stop, setActivePage, setAppFolders, issueOfficeCapability, clearOfficeCapability, lucidBroadcast };
