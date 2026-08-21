'use strict';
// HOST for the Screensaver panel app: serves the page its media lists, resolves media-file
// requests (sysserver streams them with Range support), persists panel-tunable options, and backs
// the on-panel folder browser. No LLM/turn/SSE machinery — the page itself renders the built-in
// canvas scenes; this host only deals with the user's media folders.
//
// Photos and videos live in SEPARATE folders (each defaulting to a subfolder of the app's own
// <userData>/screensaver-media). Folder paths are serverOnly (never in the page URL); the page
// addresses files by NAME through /screensaver/media?f=<name>&k=p|v, and this host is the only
// place names become paths — flat folder only, extension-allowlisted per kind, contained exactly
// like the drop-in app static server.
//
// deps (main.js voicePanelDeps('screensaver')): activeServedAppConfig(appId), activeGrid(),
// getConfig(), saveConfig(), getDocumentsPath(). defaultPhotosDir/defaultVideosDir: the
// auto-created default folders used when the page has no custom folders set.
const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.gif': 1, '.webp': 1 };
const VIDEO_EXTS = { '.mp4': 1, '.webm': 1, '.mov': 1 };
const MAX_FILES = 500;

function truthy(v) { return v === true || v === '1' || v === 'true'; }

// Panel-editable options, validated + normalized to the string form stored in g.options
// (livetranslate pattern: strings survive restarts and match the query-string delivery).
const boolOpt = v => (v === true || v === '1' || v === false || v === '0' || v === 'true' || v === 'false')
  ? (truthy(v) ? '1' : '0') : null;
const dirOpt = v => (typeof v === 'string' && v.length <= 500) ? v.trim() : null;   // '' = default folder
const PANEL_OPTIONS = {
  // Show is a flat multiselect of the three groups; all off is a legitimate "nothing" state.
  showScenes: boolOpt,
  showPhotos: boolOpt,
  showVideos: boolOpt,
  // Scene picks are independent toggles (any mix) within the Scenes group.
  sceneWaves: boolOpt,
  sceneStarfield: boolOpt,
  sceneLava: boolOpt,
  sceneFireflies: boolOpt,
  sceneFlurry: boolOpt,
  imageFit: v => (v === 'cover' || v === 'contain') ? v : null,   // images only; videos never crop
  imageStyle: v => (v === 'slide' || v === 'collage') ? v : null, // full-screen slideshow vs scrapbook pile
  intervalSec: v => { const n = parseInt(v, 10); return n >= 3 && n <= 86400 ? String(n) : null; },
  shuffle: boolOpt,
  idleMinutes: v => { const n = parseInt(v, 10); return n >= 0 && n <= 720 ? String(n) : null; },
  photosDir: dirOpt,
  videosDir: dirOpt,
};

// name -> absolute path inside dir, or null. Flat folder only: any separator, drive prefix,
// traversal, or wrong-kind extension is rejected (mirrors sysserver's serveDropInApp containment;
// the scheme regex also catches win32 drive-relative escapes like "C:evil" that isAbsolute misses).
function resolveMediaPath(dir, name, exts) {
  if (!dir || typeof name !== 'string' || !name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(name) || path.isAbsolute(name)) return null;
  if (!exts[path.extname(name).toLowerCase()]) return null;
  const root = path.resolve(dir);
  const abs = path.resolve(root, name);
  if (abs === root || !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// Allowlisted media file names in a folder, name-sorted, capped. Missing/unreadable folder =
// empty list (the page shows its "drop files in" hint instead of erroring).
function listMedia(dir, exts) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter(n => exts[path.extname(n).toLowerCase()] && resolveMediaPath(dir, n, exts))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_FILES);
}

function createScreensaverHost({ appId = 'screensaver', log, deps, defaultPhotosDir, defaultVideosDir }) {
  const say = log || (() => {});

  function pageOptions() {
    const cfg = deps.activeServedAppConfig(appId);
    return (cfg && cfg.options) || null;
  }

  // Effective folder for the ACTIVE screensaver page: the page's custom folder for that kind, or
  // the shipped default (auto-created on first use so the "open folder" links always work).
  function kindDir(kind) {
    const o = pageOptions();
    if (!o) return null;                       // page not active -> no folder, media requests 404
    const custom = String((kind === 'v' ? o.videosDir : o.photosDir) || '').trim();
    if (custom) return custom;
    const dflt = kind === 'v' ? defaultVideosDir : defaultPhotosDir;
    if (dflt) { try { fs.mkdirSync(dflt, { recursive: true }); } catch (e) {} }
    return dflt || null;
  }

  // sysserver's /screensaver/media?f=<name>&k=p|v -> absolute path (it streams with Range) or null.
  function resolveMedia(name, kind) {
    const v = kind === 'v';
    return resolveMediaPath(kindDir(v ? 'v' : 'p'), name, v ? VIDEO_EXTS : IMAGE_EXTS);
  }

  // The page's on-load /state fetch: per-kind file lists + the folders its settings overlay shows.
  function getState() {
    const o = pageOptions();
    if (!o) {
      return { ok: false, status: 'idle', photos: { dir: '', usingDefault: true, files: [] }, videos: { dir: '', usingDefault: true, files: [] } };
    }
    const pd = kindDir('p'), vd = kindDir('v');
    return {
      ok: true,
      status: 'idle',
      photos: { dir: pd || '', usingDefault: !String(o.photosDir || '').trim(), files: pd ? listMedia(pd, IMAGE_EXTS) : [] },
      videos: { dir: vd || '', usingDefault: !String(o.videosDir || '').trim(), files: vd ? listMedia(vd, VIDEO_EXTS) : [] },
    };
  }

  // Folder browser for the page's settings overlay (same generic /projects route the voice apps
  // use). The page passes the folder it wants to start from; recents are not a thing here.
  function getProjects(browsePath) {
    const o = pageOptions();
    if (!o) return { root: '', parent: null, dirs: [], current: '', recents: [] };
    const root = path.resolve(browsePath || kindDir('p') || deps.getDocumentsPath() || '');
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(root, d.name))
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {}
    const up = path.dirname(root);
    return { root, parent: up !== root ? up : null, dirs, current: '', recents: [] };
  }

  // Persist a panel-tunable option into this page's options (only while it is the active page).
  function setOption(key, value) {
    const validate = PANEL_OPTIONS[key];
    if (!validate) return false;
    const v = validate(value);
    if (v == null) return false;
    const g = deps.activeGrid();
    if (!(g && g.kind === 'app' && g.app === appId)) return false;
    if (!g.options) g.options = {};
    g.options[key] = v;
    deps.saveConfig();
    return true;
  }

  return {
    appId,
    handlers: { getState, setOption, resolveMedia, getProjects },
    shutdown() {},   // nothing long-lived to tear down
  };
}

module.exports = { createScreensaverHost, resolveMediaPath, listMedia, IMAGE_EXTS, VIDEO_EXTS };
