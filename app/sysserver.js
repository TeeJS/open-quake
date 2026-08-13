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
const metrics = require('./sysmetrics');
const nowplaying = require('./nowplaying');
const haschedule = require('./haschedule');   // HA Schedule dev app (main.js drives its poll start/stop)
const lyrics = require('./lyrics');           // Music lyrics (LRCLIB), fetched on demand for the now-playing track

const FALLBACK = '<!doctype html><meta charset="utf-8">'
  + '<body style="margin:0;background:#05080d;color:#9fb3c8;font:20px Segoe UI, sans-serif">page asset missing.</body>';
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
  '/sysview.js': 'application/javascript; charset=utf-8',
  '/musicview.js': 'application/javascript; charset=utf-8',
  '/meetingview.js': 'application/javascript; charset=utf-8',
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
};
for (const appId of ['teams', 'outlook', 'word', 'excel', 'powerpoint', 'onenote', 'onedrive', 'office']) {
  STATIC_FILES['/office-icons/' + appId + '.svg'] = 'image/svg+xml; charset=utf-8';
}

let server = null, onMedia = null, onLaunch = null, getGridTiles = null, getAppConfig = null, getOfficeData = null, connectOffice = null, onOpenExternal = null, onMeetingAction = null, onOfficeAction = null, getShortcuts = null;
let sysHtml = FALLBACK, musicHtml = FALLBACK, chatHtml = FALLBACK, officeHtml = FALLBACK, hascheduleHtml = FALLBACK, agendaHtml = FALLBACK, eventsHtml = FALLBACK, meetingHtml = FALLBACK, keyshortcutsHtml = FALLBACK;
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
      || host === 'www.office.com'
      || host === 'office.com';
    return allowed ? parsed.href : null;
  } catch (e) { return null; }
}

async function handler(req, res) {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (!hostOk(req)) { res.writeHead(403); res.end(); return; }   // foreign / DNS-rebinding Host -> reject (all routes)
  const full = req.url || '/';
  const url = full.split('?')[0];
  if (url === '/' || url === '/index.html') return html(res, sysHtml);
  if (url === '/music') return html(res, musicHtml);
  if (url === '/meeting') return html(res, meetingHtml);
  if (url === '/chat') return html(res, chatHtml);
  if (url === '/office') return html(res, officeHtml);
  if (url === '/haschedule') return html(res, hascheduleHtml);
  if (url === '/agenda') return html(res, agendaHtml);
  if (url === '/events') return html(res, eventsHtml);
  if (url === '/keyshortcuts') return html(res, keyshortcutsHtml);
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
  if (url === '/metrics') return json(res, metrics.getSnapshot());
  if (url === '/nowplaying') return json(res, nowplaying.getSnapshot());
  if (url === '/lyrics') { try { await lyrics.ensure(nowplaying.getSnapshot()); } catch (e) {} return json(res, lyrics.getSnapshot()); }   // synced lyrics for the current track
  if (url === '/haschedule-data') return json(res, haschedule.getSnapshot());
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
  if (url.indexOf('/api/office/action/') === 0) {
    const match = /^\/api\/office\/action\/(app)\/([0-3])$/.exec(url)
      || /^\/api\/office\/action\/(shortcut)\/([0-3])\/([0-3])$/.exec(url);
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
  onOfficeAction = opts.onOfficeAction || null;
  getShortcuts = opts.getShortcuts || null;
  setAppFolders(opts.appFolders);
  nowplaying.setProvider(opts.getNowPlaying || null);
  return new Promise((resolve, reject) => {
    if (server) return resolve(server.address().port);
    try { sysHtml = fs.readFileSync(path.join(__dirname, 'sysview.html'), 'utf8'); } catch (e) {}
    try { musicHtml = fs.readFileSync(path.join(__dirname, 'musicview.html'), 'utf8'); } catch (e) {}
    try { meetingHtml = fs.readFileSync(path.join(__dirname, 'meetingview.html'), 'utf8'); } catch (e) {}
    try { chatHtml = fs.readFileSync(path.join(__dirname, 'chatview.html'), 'utf8'); } catch (e) {}
    try { officeHtml = fs.readFileSync(path.join(__dirname, 'office.html'), 'utf8'); } catch (e) {}
    try { hascheduleHtml = fs.readFileSync(path.join(__dirname, 'haschedule.html'), 'utf8'); } catch (e) {}
    try { agendaHtml = fs.readFileSync(path.join(__dirname, 'agenda.html'), 'utf8'); } catch (e) {}
    try { eventsHtml = fs.readFileSync(path.join(__dirname, 'events.html'), 'utf8'); } catch (e) {}
    try { keyshortcutsHtml = fs.readFileSync(path.join(__dirname, 'keyshortcutsview.html'), 'utf8'); } catch (e) {}
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
// active panel page changes. which: 'sysview' (metrics) | 'music' (now-playing) | 'office' | null.
// start()/stop() are idempotent, so this is safe to call on every page push.
function setActivePage(which) {
  if (which !== 'office') clearOfficeCapability();
  if (which === 'sysview') { metrics.start(); nowplaying.stop(); }
  else if (which === 'music') { nowplaying.start(); metrics.stop(); }
  else { metrics.stop(); nowplaying.stop(); }
}

function stop() {
  metrics.stop();
  nowplaying.stop();
  if (server) { try { server.close(); } catch (e) {} server = null; }
  clearOfficeCapability();
  getOfficeData = null;
  connectOffice = null;
  onOfficeAction = null;
  currentTime = Date.now;
  officeCapabilityTtlMs = DEFAULT_OFFICE_CAPABILITY_TTL_MS;
}

module.exports = { start, stop, setActivePage, setAppFolders, issueOfficeCapability, clearOfficeCapability };
