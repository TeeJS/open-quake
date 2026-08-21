'use strict';
// Screensaver media surface: name->path containment (pure), the /screensaver/media Range route
// with its photos/videos folder split (k=p|v), the /state listing, and the generic /projects
// folder browse — through the REAL server and the REAL host, with fake deps pointing the folders
// at temp fixtures. Own process, like meetingRoutes.test.js, so sysserver.start() options don't
// leak into other suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sysserver = require('../app/sysserver');
const { createScreensaverHost, resolveMediaPath, listMedia, IMAGE_EXTS, VIDEO_EXTS } = require('../app/screensaver-host');

let port, photosDir, videosDir, defaultPhotos, defaultVideos;
let active = true;            // deps gate: is the screensaver page the active page?
const grid = { kind: 'app', app: 'screensaver', options: {} };
let saves = 0;

test.before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-saver-'));
  photosDir = path.join(root, 'photos'); fs.mkdirSync(photosDir);
  videosDir = path.join(root, 'videos'); fs.mkdirSync(videosDir);
  defaultPhotos = path.join(root, 'default', 'photos');   // NOT pre-created — the host must mkdir
  defaultVideos = path.join(root, 'default', 'videos');
  fs.writeFileSync(path.join(photosDir, 'a.png'), Buffer.from('0123456789'));   // 10 bytes
  fs.writeFileSync(path.join(photosDir, 'notes.txt'), 'not media');
  fs.writeFileSync(path.join(videosDir, 'clip.mp4'), Buffer.from('MP4DATA'));
  const host = createScreensaverHost({
    deps: {
      activeServedAppConfig: () => (active ? { app: 'screensaver', options: grid.options } : null),
      activeGrid: () => (active ? grid : { kind: 'web' }),
      getConfig: () => ({}),
      saveConfig: () => { saves++; },
      getDocumentsPath: () => root,
    },
    defaultPhotosDir: defaultPhotos,
    defaultVideosDir: defaultVideos,
  });
  grid.options.photosDir = photosDir;
  grid.options.videosDir = videosDir;
  port = await sysserver.start({ voiceApps: { screensaver: { handlers: host.handlers } } });
});
test.after(() => sysserver.stop());

const base = () => 'http://127.0.0.1:' + port;
const pageFetch = (p, opts = {}) =>
  fetch(base() + p, Object.assign({}, opts, { headers: Object.assign({ 'sec-fetch-site': 'same-origin' }, opts.headers || {}) }));

// ---- pure containment matrix (no HTTP) ----

test('resolveMediaPath rejects everything but a plain right-kind name in the folder', () => {
  assert.equal(resolveMediaPath(photosDir, 'a.png', IMAGE_EXTS), path.join(photosDir, 'a.png'));
  assert.equal(resolveMediaPath(videosDir, 'clip.mp4', VIDEO_EXTS), path.join(videosDir, 'clip.mp4'));
  for (const bad of ['../a.png', '..\\a.png', 'sub/a.png', 'sub\\a.png', 'C:\\x\\a.png', 'C:evil.png',
    'file:a.png', '..', '', 'a.txt', 'a', 'a.png.exe']) {
    assert.equal(resolveMediaPath(photosDir, bad, IMAGE_EXTS), null, JSON.stringify(bad));
  }
  assert.equal(resolveMediaPath(photosDir, 'clip.mp4', IMAGE_EXTS), null);   // wrong kind for the folder
  assert.equal(resolveMediaPath(videosDir, 'a.png', VIDEO_EXTS), null);
  assert.equal(resolveMediaPath('', 'a.png', IMAGE_EXTS), null);
  assert.equal(resolveMediaPath(null, 'a.png', IMAGE_EXTS), null);
});

test('listMedia lists only right-kind files, sorted; missing folder is empty', () => {
  assert.deepEqual(listMedia(photosDir, IMAGE_EXTS), ['a.png']);
  assert.deepEqual(listMedia(videosDir, VIDEO_EXTS), ['clip.mp4']);
  assert.deepEqual(listMedia(photosDir, VIDEO_EXTS), []);
  assert.deepEqual(listMedia(path.join(photosDir, 'nope'), IMAGE_EXTS), []);
});

// ---- the HTTP surface ----

test('media route serves per-kind files with the right type and Accept-Ranges', async () => {
  const r = await pageFetch('/screensaver/media?k=p&f=a.png');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/png/);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(await r.text(), '0123456789');
  const v = await pageFetch('/screensaver/media?k=v&f=clip.mp4');
  assert.equal(v.status, 200);
  assert.match(v.headers.get('content-type'), /video\/mp4/);
  const noK = await pageFetch('/screensaver/media?f=a.png');   // k omitted -> photos folder
  assert.equal(noK.status, 200);
});

test('media route honors single byte ranges (206/416)', async () => {
  const r = await pageFetch('/screensaver/media?k=p&f=a.png', { headers: { Range: 'bytes=2-5' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await r.text(), '2345');
  const open = await pageFetch('/screensaver/media?k=p&f=a.png', { headers: { Range: 'bytes=7-' } });
  assert.equal(open.status, 206);
  assert.equal(await open.text(), '789');
  const out = await pageFetch('/screensaver/media?k=p&f=a.png', { headers: { Range: 'bytes=99-' } });
  assert.equal(out.status, 416);
});

test('media route 404s traversal, wrong-kind requests, missing files, and an inactive page', async () => {
  for (const f of ['..%2Fa.png', '..%5Ca.png', 'sub%2Fa.png', 'C%3A%5Ca.png', 'notes.txt', 'missing.png', '']) {
    const r = await pageFetch('/screensaver/media?k=p&f=' + f);
    assert.equal(r.status, 404, JSON.stringify(f));
  }
  assert.equal((await pageFetch('/screensaver/media?k=p&f=clip.mp4')).status, 404);   // video name via photos kind
  assert.equal((await pageFetch('/screensaver/media?k=v&f=a.png')).status, 404);      // photo name via videos kind
  active = false;
  try {
    const r = await pageFetch('/screensaver/media?k=p&f=a.png');
    assert.equal(r.status, 404);   // page not active -> host resolves null (also kills stray post-wake requests)
  } finally { active = true; }
});

test('media route fails closed without same-origin evidence; POST hits the wall', async () => {
  const cross = await fetch(base() + '/screensaver/media?k=p&f=a.png', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const post = await pageFetch('/screensaver/media?k=p&f=a.png', { method: 'POST' });
  assert.equal(post.status, 405);
});

test('foreign Host header rejected (DNS-rebinding gate)', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/screensaver/media?k=p&f=a.png', headers: { Host: 'evil.example' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('/state lists both folders with their files and custom-vs-default flags', async () => {
  const s = await (await pageFetch('/screensaver/state')).json();
  assert.equal(s.ok, true);
  assert.deepEqual(s.photos, { dir: photosDir, usingDefault: false, files: ['a.png'] });
  assert.deepEqual(s.videos, { dir: videosDir, usingDefault: false, files: ['clip.mp4'] });
});

test('blank folder options fall back to the per-kind defaults and auto-create them', async () => {
  grid.options.photosDir = ''; grid.options.videosDir = '';
  try {
    const s = await (await pageFetch('/screensaver/state')).json();
    assert.deepEqual(s.photos, { dir: defaultPhotos, usingDefault: true, files: [] });
    assert.deepEqual(s.videos, { dir: defaultVideos, usingDefault: true, files: [] });
    assert.equal(fs.existsSync(defaultPhotos), true);   // mkdir'd on demand
    assert.equal(fs.existsSync(defaultVideos), true);
  } finally { grid.options.photosDir = photosDir; grid.options.videosDir = videosDir; }
});

test('/projects browse is generic: reaches this host and lists directories', async () => {
  const s = await (await pageFetch('/screensaver/projects?path=' + encodeURIComponent(path.dirname(photosDir)))).json();
  assert.equal(s.root, path.dirname(photosDir));
  assert.ok(s.dirs.includes(photosDir));
  assert.ok(s.dirs.includes(videosDir));
  assert.deepEqual(s.recents, []);
});

test('/option validates and persists panel-tunable keys', async () => {
  const post = (key, value) => pageFetch('/screensaver/option', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }),
  });
  const before = saves;
  assert.equal((await (await post('imageFit', 'contain')).json()).ok, true);
  assert.equal(grid.options.imageFit, 'contain');
  assert.equal((await (await post('showPhotos', '0')).json()).ok, true);        // the Show multiselect toggles
  assert.equal(grid.options.showPhotos, '0');
  assert.equal((await (await post('showPhotos', 'maybe')).json()).ok, false);   // rejected value
  assert.equal((await (await post('source', 'scenes')).json()).ok, false);      // retired key
  assert.equal((await (await post('mediaKind', 'photos')).json()).ok, false);   // retired key
  assert.equal((await (await post('fillMode', 'contain')).json()).ok, false);   // retired key
  assert.equal((await (await post('mediaDir', 'C:\\x')).json()).ok, false);     // retired key
  assert.equal((await (await post('nope', 'x')).json()).ok, false);             // unknown key
  assert.equal((await post('idleMinutes', '0')).status, 200);                   // 0 = never is storable
  assert.equal(grid.options.idleMinutes, '0');
  assert.ok(saves > before);
  grid.options.idleMinutes = '10'; grid.options.imageFit = 'cover'; grid.options.showPhotos = '1';
});
