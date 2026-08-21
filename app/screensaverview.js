'use strict';
// Screensaver page: built-in canvas scenes (drawn live, no assets) + a dual-layer crossfade
// player for the user's own images/videos (DK-Vivid's proven pattern: preload into the idle layer,
// fade opacity, never reflow). Media files are addressed by NAME through /screensaver/media (the
// folder path itself is server-side only). Manual visits: a tap advances and reveals ⚙; when the
// screensaver auto-started, main.js swallows the waking input so none of this ever fires.

(function () {
  var Q = new URLSearchParams(location.search);
  var $ = function (id) { return document.getElementById(id); };

  // ---- theme (overlays only — the stage stays black by design) ----
  var accent = Q.get('_accent') || '#4da3ff';
  document.body.classList.toggle('light', Q.get('_dark') === '0');
  document.documentElement.style.setProperty('--accent', accent);
  // Contrast-safe text on the accent: don't assume every configured accent accepts dark text.
  (function () {
    var m = /^#?([0-9a-f]{6})$/i.exec(accent.trim());
    if (!m) return;
    var n = parseInt(m[1], 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    var yiq = (r * 299 + g * 587 + b * 114) / 1000;
    document.documentElement.style.setProperty('--accent-fg', yiq >= 140 ? '#08121c' : '#ffffff');
  })();

  // ---- options (query-string delivery; panel edits POST /option and update this copy) ----
  var opts = {
    // One flat multiselect: any mix of the three groups (all on by default — empty folders
    // simply contribute nothing until files land in them).
    showScenes: Q.get('showScenes') !== '0',
    showPhotos: Q.get('showPhotos') !== '0',
    showVideos: Q.get('showVideos') !== '0',
    imageFit: Q.get('imageFit') || 'cover',        // cover | contain — photos only; videos never crop
    imageStyle: Q.get('imageStyle') || 'slide',    // slide | collage — how photos are shown
    intervalSec: parseInt(Q.get('intervalSec'), 10) || 10,
    shuffle: Q.get('shuffle') === '1',
    idleMinutes: Q.get('idleMinutes') || '30',
    sceneOn: {},                                   // per-scene include toggles (any mix)
  };
  var SCENES = ['waves', 'starfield', 'lava', 'fireflies', 'flurry'];
  var SCENE_LABELS = { waves: 'Waves', starfield: 'Starfield', lava: 'Lava lamp', fireflies: 'Fireflies', flurry: 'Flurry' };
  function sceneKey(id) { return 'scene' + id.charAt(0).toUpperCase() + id.slice(1); }
  SCENES.forEach(function (id) { opts.sceneOn[id] = Q.get(sceneKey(id)) !== '0'; });   // absent = on
  var photos = [], videos = [];                  // file NAMES from /state (photos + videos folders)
  var photosDirLabel = '', videosDirLabel = '', photosDefault = true, videosDefault = true;
  function mediaUrl(kind, name) { return '/screensaver/media?k=' + (kind === 'video' ? 'v' : 'p') + '&f=' + encodeURIComponent(name); }

  // =====================================================================================
  // Built-in scenes: tiny animation programs drawing 1920x480 frames. Each returns a stop().
  // =====================================================================================
  var W = 1920, H = 480;

  function sceneWaves(cv) {
    var ctx = cv.getContext('2d'), t = 0, run = true;
    var ribbons = [
      { amp: 90, f: 0.0032, speed: 0.012, hue: 150, width: 150, phase: 0 },
      { amp: 130, f: 0.0021, speed: -0.009, hue: 190, width: 190, phase: 2.1 },
      { amp: 70, f: 0.0044, speed: 0.017, hue: 265, width: 120, phase: 4.4 },
      { amp: 110, f: 0.0026, speed: -0.014, hue: 120, width: 170, phase: 5.6 },
    ];
    (function frame() {
      if (!run) return;
      t++;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < ribbons.length; i++) {
        var r = ribbons[i], hue = (r.hue + t * 0.08) % 360;
        var grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, 'hsla(' + hue + ',85%,55%,0)');
        grad.addColorStop(0.5, 'hsla(' + hue + ',85%,55%,0.16)');
        grad.addColorStop(1, 'hsla(' + ((hue + 40) % 360) + ',85%,55%,0)');
        ctx.strokeStyle = grad; ctx.lineWidth = r.width; ctx.lineCap = 'round';
        ctx.beginPath();
        for (var x = -40; x <= W + 40; x += 16) {
          var y = H / 2 + Math.sin(x * r.f + t * r.speed + r.phase) * r.amp
                        + Math.sin(x * r.f * 2.7 + t * r.speed * 1.6) * r.amp * 0.35;
          if (x === -40) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneStarfield(cv) {
    var ctx = cv.getContext('2d'), run = true;
    var N = 420, stars = [];
    for (var i = 0; i < N; i++) stars.push({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() });
    (function frame() {
      if (!run) return;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, W, H);
      for (var i = 0; i < N; i++) {
        var s = stars[i];
        s.z -= 0.004 + s.z * 0.012;
        if (s.z <= 0.02) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; continue; }
        var px = W / 2 + (s.x / s.z) * (W / 2.2);
        var py = H / 2 + (s.y / s.z) * (H / 1.1);
        if (px < 0 || px >= W || py < 0 || py >= H) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; continue; }
        var b = Math.min(1, (1 - s.z) * 1.3), r = Math.max(0.6, (1 - s.z) * 3.2);
        ctx.fillStyle = 'rgba(' + (200 + (55 * b) | 0) + ',' + (210 + (45 * b) | 0) + ',255,' + b.toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(px, py, r, 0, 6.2832); ctx.fill();
      }
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneLava(cv) {
    var ctx = cv.getContext('2d'), run = true, t = 0;
    // Real metaballs, not glow-orbs: each blob contributes a radial falloff to a luminance FIELD;
    // a hard per-pixel threshold turns the summed field into crisp wax shapes that visibly merge
    // and pinch apart. Field + threshold run at 1/4 res (480x120 = 57.6k px) and upscale.
    var FW = 480, FH = 120;
    var field = document.createElement('canvas'); field.width = FW; field.height = FH;
    var fctx = field.getContext('2d', { willReadFrequently: true });
    var mask = document.createElement('canvas'); mask.width = FW; mask.height = FH;
    var mctx = mask.getContext('2d');
    var maskData = mctx.createImageData(FW, FH);
    var blobs = [];
    for (var i = 0; i < 8; i++) {
      blobs.push({
        // Even horizontal bands (+ jitter) so the wax never clumps into one corner for good.
        x: (i + 0.5) * (FW / 8) + (Math.random() - 0.5) * 40,
        y: 20 + Math.random() * 80,
        r: 13 + Math.random() * 15, vy: (Math.random() * 0.14 + 0.04) * (i % 2 ? 1 : -1),
        wob: Math.random() * 6.28,
      });
    }
    (function frame() {
      if (!run) return;
      t++;
      // 1) Luminance field: additive white radial falloffs (roughly 1/r^2-shaped via the gradient).
      fctx.globalCompositeOperation = 'source-over';
      fctx.fillStyle = '#000'; fctx.fillRect(0, 0, FW, FH);
      fctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < blobs.length; i++) {
        var b = blobs[i];
        b.y += b.vy;
        if (b.y < -b.r * 2) { b.y = FH + b.r; b.vy = -(Math.random() * 0.14 + 0.04); b.r = 13 + Math.random() * 15; }
        if (b.y > FH + b.r * 2) { b.y = -b.r; b.vy = Math.random() * 0.14 + 0.04; b.r = 13 + Math.random() * 15; }
        var x = b.x + Math.sin(t * 0.004 + b.wob) * 12;
        var breathe = 1 + Math.sin(t * 0.009 + b.wob) * 0.12;
        var R = b.r * 2.1 * breathe;                       // falloff extent (larger than the visible core)
        var stretch = 1 + Math.min(0.35, Math.abs(b.vy) * 2.2);   // rising/sinking wax elongates vertically
        fctx.save();
        fctx.translate(x, b.y); fctx.scale(1, stretch);
        var g = fctx.createRadialGradient(0, 0, 0, 0, 0, R);
        g.addColorStop(0, 'rgba(255,255,255,0.9)');
        g.addColorStop(0.45, 'rgba(255,255,255,0.32)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        fctx.fillStyle = g;
        fctx.beginPath(); fctx.arc(0, 0, R, 0, 6.2832); fctx.fill();
        fctx.restore();
      }
      // 2) Hard threshold with a 2-3px anti-alias band -> a binary alpha mask of the wax.
      var src = fctx.getImageData(0, 0, FW, FH).data;
      var dst = maskData.data;
      for (var p = 0, n = FW * FH * 4; p < n; p += 4) {
        var lum = src[p];                                  // white-on-black field: red channel = luminance
        var a = (lum - 108) * 7;                           // threshold ~108; ~36-level AA band keeps the upscaled edge smooth
        dst[p] = 255; dst[p + 1] = 255; dst[p + 2] = 255;
        dst[p + 3] = a <= 0 ? 0 : (a >= 255 ? 255 : a);
      }
      mctx.putImageData(maskData, 0, 0);
      // 3) Colorize the mask: molten gradient (deep red up top, hot orange near the lamp base).
      mctx.globalCompositeOperation = 'source-in';
      var wax = mctx.createLinearGradient(0, 0, 0, FH);
      wax.addColorStop(0, 'hsl(4,88%,40%)');
      wax.addColorStop(0.65, 'hsl(14,95%,47%)');
      wax.addColorStop(1, 'hsl(28,100%,54%)');
      mctx.fillStyle = wax; mctx.fillRect(0, 0, FW, FH);
      mctx.globalCompositeOperation = 'source-over';
      // 4) Compose: black lamp + faint heat glow at the base, then the wax upscaled.
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      var glow = ctx.createRadialGradient(W / 2, H + 140, 60, W / 2, H + 140, 560);
      glow.addColorStop(0, 'rgba(255,90,0,0.10)'); glow.addColorStop(1, 'rgba(255,90,0,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(mask, 0, 0, W, H);
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneFireflies(cv) {
    var ctx = cv.getContext('2d'), run = true, t = 0;
    // Grass silhouette pre-rendered once; the flies wander with smooth headings and pulse
    // individually, with the occasional brighter flash.
    var grass = document.createElement('canvas'); grass.width = W; grass.height = H;
    var gctx = grass.getContext('2d');
    for (var layer = 0; layer < 3; layer++) {
      gctx.fillStyle = 'rgba(6,16,8,' + (0.5 + layer * 0.25) + ')';
      gctx.beginPath(); gctx.moveTo(0, H);
      var base = H - 14 - layer * 16;
      for (var x = 0; x <= W; x += 7) {
        gctx.lineTo(x, base - Math.abs(Math.sin(x * 0.05 + layer * 9)) * (16 + layer * 10) * (0.4 + Math.abs(Math.sin(x * 0.011 + layer))));
      }
      gctx.lineTo(W, H); gctx.closePath(); gctx.fill();
    }
    var N = 46, flies = [];
    for (var i = 0; i < N; i++) {
      flies.push({
        x: Math.random() * W, y: 40 + Math.random() * (H - 110),
        a: Math.random() * 6.2832, speed: 0.25 + Math.random() * 0.5,
        phase: Math.random() * 6.2832, rate: 0.015 + Math.random() * 0.02,
        flash: 0,
      });
    }
    (function frame() {
      if (!run) return;
      t++;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(grass, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < N; i++) {
        var f = flies[i];
        f.a += (Math.random() - 0.5) * 0.25;                  // smooth-ish random wander
        f.x += Math.cos(f.a) * f.speed; f.y += Math.sin(f.a) * f.speed * 0.6;
        if (f.x < -20) f.x = W + 20; if (f.x > W + 20) f.x = -20;
        if (f.y < 30) { f.y = 30; f.a = -f.a; }
        if (f.y > H - 40) { f.y = H - 40; f.a = -f.a; }
        if (!f.flash && Math.random() < 0.0012) f.flash = 60;  // occasional bright flare
        var glow = Math.max(0, Math.sin(t * f.rate + f.phase)); glow = glow * glow;
        if (f.flash) { glow = Math.min(1, glow + f.flash / 60); f.flash--; }
        if (glow < 0.03) continue;
        var r = 6 + glow * 11;
        var grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
        grad.addColorStop(0, 'rgba(222,255,150,' + Math.min(1, glow * 1.1).toFixed(3) + ')');
        grad.addColorStop(0.35, 'rgba(190,240,90,' + (0.45 * glow).toFixed(3) + ')');
        grad.addColorStop(1, 'rgba(190,240,90,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneFlurry(cv) {
    var ctx = cv.getContext('2d'), run = true, t = 0, first = true;
    // Flurry-style smoke comets: the canvas is never cleared — each frame fades a few percent
    // toward black (the persistent trails), while glowing streamer arms orbit a smoothly
    // wandering attractor with the palette slowly cycling.
    var ARMS = 5, arms = [];
    for (var i = 0; i < ARMS; i++) {
      arms.push({
        ang: (i / ARMS) * 6.2832, spin: 0.09 + i * 0.016, rad: 56 + i * 20,
        hueOff: i * 26, px: W / 2, py: H / 2,
      });
    }
    // The emitter dashes around the strip — fast incommensurate sines so the path never repeats.
    function attractor(tt) {
      return {
        x: W / 2 + Math.sin(tt * 0.021) * W * 0.34 + Math.sin(tt * 0.057 + 1.7) * W * 0.10,
        y: H / 2 + Math.sin(tt * 0.031 + 0.9) * H * 0.28 + Math.sin(tt * 0.047 + 3.1) * H * 0.14,
      };
    }
    (function frame() {
      if (!run) return;
      t++;
      ctx.globalCompositeOperation = 'source-over';
      if (first) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); first = false; }
      ctx.fillStyle = 'rgba(0,0,0,0.04)'; ctx.fillRect(0, 0, W, H);   // slow fade = long smoke trails
      ctx.globalCompositeOperation = 'lighter';
      var c = attractor(t);
      var baseHue = (t * 0.5) % 360;
      for (var i = 0; i < ARMS; i++) {
        var a = arms[i];
        a.ang += a.spin;
        var wobble = Math.sin(t * 0.02 + i * 2.3) * 14;
        var x = c.x + Math.cos(a.ang) * (a.rad + wobble);
        var y = c.y + Math.sin(a.ang) * (a.rad + wobble) * 0.72;      // squash orbits for the wide strip
        var hue = (baseHue + a.hueOff) % 360;
        // Chain from the arm's last position, step count scaled to the distance covered, so fast
        // sweeps lay down continuous ribbons instead of dotted arcs.
        var dist = Math.sqrt((x - a.px) * (x - a.px) + (y - a.py) * (y - a.py));
        var steps = Math.max(4, Math.min(26, Math.ceil(dist / 6)));
        for (var s = 0; s < steps; s++) {
          var f = (s + 1) / steps;
          var ix = a.px + (x - a.px) * f, iy = a.py + (y - a.py) * f;
          var r = 9 + Math.sin(t * 0.05 + i) * 3;
          var g = ctx.createRadialGradient(ix, iy, 0, ix, iy, r);
          g.addColorStop(0, 'hsla(' + hue + ',100%,72%,0.28)');
          g.addColorStop(0.4, 'hsla(' + hue + ',100%,55%,0.12)');
          g.addColorStop(1, 'hsla(' + hue + ',100%,50%,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(ix, iy, r, 0, 6.2832); ctx.fill();
        }
        a.px = x; a.py = y;
      }
      // A soft bloom where the arms converge sells the "energy source".
      var core = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 34);
      core.addColorStop(0, 'rgba(255,245,230,0.10)');
      core.addColorStop(1, 'rgba(255,245,230,0)');
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(c.x, c.y, 34, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  var SCENE_FNS = { waves: sceneWaves, starfield: sceneStarfield, lava: sceneLava, fireflies: sceneFireflies, flurry: sceneFlurry };

  // =====================================================================================
  // Collage (scrapbook) image style: photos drop in quickly (a random 0.5-1.5s between prints)
  // as tilted white-bordered prints until the board is FULL, then the finished collage holds for
  // the "Change every" interval — after which the cycle moves on (or, media-only, a fresh board
  // starts filling). Fullness is tracked geometrically (a coarse cell grid marked by each
  // print's footprint), so dark photos count as covered just like bright ones.
  // =====================================================================================
  var COLLAGE_MAX_STAMPS = 60;    // hard cap per board, in case random placement keeps missing cells
  var COLLAGE_COLS = 24, COLLAGE_ROWS = 6, COLLAGE_FULL_AT = 0.97;

  function shuffleArr(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0, t = a[i]; a[i] = a[j]; a[j] = t; }
  }

  function drawStamp(ctx, rec) {
    var b = 10;   // white border
    ctx.save();
    ctx.translate(rec.x, rec.y);
    ctx.rotate(rec.rot);
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 22;
    ctx.shadowOffsetX = 5; ctx.shadowOffsetY = 7;
    ctx.fillStyle = '#f4f2ec';
    ctx.fillRect(-rec.w / 2 - b, -rec.h / 2 - b, rec.w + b * 2, rec.h + b * 2);
    ctx.shadowColor = 'transparent';
    ctx.drawImage(rec.img, -rec.w / 2, -rec.h / 2, rec.w, rec.h);
    ctx.restore();
  }

  function runCollage(cv) {
    var ctx = cv.getContext('2d'), run = true, loading = false;
    var order = photos.slice();
    var pos2 = -1;
    var cells, stamps, phase, nextAt = 0, holdUntil = 0;   // phase: 'fill' | 'hold'
    function resetBoard() {
      cells = new Array(COLLAGE_COLS * COLLAGE_ROWS).fill(false);
      stamps = 0; phase = 'fill';
      pos2 = -1;                                 // fresh deck: each photo appears at most ONCE per board
      if (opts.shuffle) shuffleArr(order);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    }
    // Exact rotated-rectangle coverage: a cell counts only when its CENTER lies inside the tilted
    // print (border included). A bounding-box approximation marked corner cells that were still
    // visually black, so the gap-seeker stopped aiming at them and prints piled up at random.
    function eachCoveredCell(rec, fn) {
      var b = 12;   // white border
      var cos = Math.cos(rec.rot || 0), sin = Math.sin(rec.rot || 0);
      var hw = rec.w / 2 + b, hh = rec.h / 2 + b;
      var cw = W / COLLAGE_COLS, ch = H / COLLAGE_ROWS;
      for (var r = 0; r < COLLAGE_ROWS; r++) {
        for (var c = 0; c < COLLAGE_COLS; c++) {
          var dx = (c + 0.5) * cw - rec.x, dy = (r + 0.5) * ch - rec.y;
          var lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;   // into print-local coords
          if (lx >= -hw && lx <= hw && ly >= -hh && ly <= hh) fn(r * COLLAGE_COLS + c);
        }
      }
    }
    function markCells(rec) {
      eachCoveredCell(rec, function (i) { cells[i] = true; });
    }
    function freshCellsCovered(rec) {
      var n = 0;
      eachCoveredCell(rec, function (i) { if (!cells[i]) n++; });
      return n;
    }
    // Spread the pile: audition EVERY board cell as a candidate center (with jitter so nothing
    // looks grid-aligned) and take the spot covering the most still-empty board. Deterministic
    // gap-filling — random auditions kept forming piles with black between them.
    function placePrint(w, h, rot) {
      var cw = W / COLLAGE_COLS, ch = H / COLLAGE_ROWS;
      var best = null, bestScore = -1;
      for (var r = 0; r < COLLAGE_ROWS; r++) {
        for (var c = 0; c < COLLAGE_COLS; c++) {
          var cand = {
            w: w, h: h, rot: rot,
            x: (c + 0.5) * cw + (Math.random() - 0.5) * cw,
            y: (r + 0.5) * ch + (Math.random() - 0.5) * ch,
          };
          var score = freshCellsCovered(cand) + Math.random() * 0.5;   // tiny random tiebreak
          if (score > bestScore) { bestScore = score; best = cand; }
        }
      }
      return best;
    }
    function boardFull() {
      if (stamps >= COLLAGE_MAX_STAMPS) return true;
      var covered = 0;
      for (var i = 0; i < cells.length; i++) if (cells[i]) covered++;
      return covered / cells.length >= COLLAGE_FULL_AT;
    }
    function stampNext() {
      if (loading || !order.length) return;
      loading = true;
      pos2++;
      if (pos2 >= order.length) { loading = false; phase = 'hold'; holdUntil = Date.now() + intervalMs(); return; }   // deck spent — the board is done
      var img = new Image();
      img.onload = function () {
        loading = false;
        if (!run) return;
        // Deck-aware sizing: scale prints so the WHOLE deck can cover the board about 1.7x over —
        // a small library gets big prints instead of a sea of black. Clamped, with ±12% jitter.
        var aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
        var targetArea = (W * H * 1.7) / Math.max(1, order.length);
        var h = Math.sqrt(targetArea / Math.max(0.3, aspect));
        h = Math.max(230, Math.min(450, h)) * (0.88 + Math.random() * 0.24);
        var w = Math.min(640, aspect * h);
        var rot = (Math.random() - 0.5) * 1.047;   // ±30° (±0.524 rad)
        var rec = placePrint(w, h, rot);
        rec.img = img;
        rec.rot = rot;
        drawStamp(ctx, rec);
        markCells(rec);
        stamps++;
        var now = Date.now();
        // A board finishes when it's covered OR when every photo has appeared once — no repeats.
        if (boardFull() || pos2 >= order.length - 1) { phase = 'hold'; holdUntil = now + intervalMs(); }
        else nextAt = now + 500 + Math.random() * 1000;   // the requested 0.5-1.5s beat between prints
      };
      img.onerror = function () { loading = false; nextAt = Date.now() + 500; };
      img.src = mediaUrl('image', order[pos2]);
    }
    resetBoard();
    (function tick() {
      if (!run) return;
      var now = Date.now();
      if (phase === 'fill' && now >= nextAt) stampNext();
      else if (phase === 'hold' && now >= holdUntil) {
        if (playlist.length > 1) { advance(); return; }   // cycle moves on; next visit starts fresh
        resetBoard(); nextAt = now + 500 + Math.random() * 1000;
      }
      requestAnimationFrame(tick);
    })();
    return function () { run = false; };
  }

  // =====================================================================================
  // Playlist + dual-layer player
  // =====================================================================================
  var layers = [$('layerA'), $('layerB')];
  var front = 0;                 // which layer is currently shown
  var stopScene = [null, null];  // per-layer scene stop()
  var playlist = [], order = [], pos = -1;
  var advanceTimer = null, swapping = false;

  function buildPlaylist() {
    var items = [];
    if (opts.showScenes) {
      SCENES.filter(function (n) { return opts.sceneOn[n]; }).forEach(function (n) { items.push({ kind: 'scene', name: n }); });
    }
    if (opts.showPhotos) {
      if (opts.imageStyle === 'collage') {
        // Collage consumes the photos itself (one pseudo-item that stamps prints on its own
        // clock, fills the board, holds, then hands the rotation on).
        if (photos.length) items.push({ kind: 'collage' });
      } else {
        photos.forEach(function (n) { items.push({ kind: 'image', name: n }); });
      }
    }
    if (opts.showVideos) videos.forEach(function (n) { items.push({ kind: 'video', name: n }); });
    playlist = items;
    reshuffle();
  }
  function reshuffle() {
    order = playlist.map(function (_, i) { return i; });
    if (opts.shuffle) for (var i = order.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0, t = order[i]; order[i] = order[j]; order[j] = t;
    }
  }

  function clearTimer() { if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; } }
  function armTimer(ms) { clearTimer(); advanceTimer = setTimeout(function () { advance(); }, ms); }
  function intervalMs() { return Math.max(3, opts.intervalSec) * 1000; }

  // Build the DOM for one playlist item inside a layer; call ready() once it can be shown.
  function loadInto(layerIdx, item, ready) {
    var layer = layers[layerIdx];
    if (stopScene[layerIdx]) { stopScene[layerIdx](); stopScene[layerIdx] = null; }
    layer.innerHTML = '';
    // Crop choice applies to images only — videos always letterbox (a non-native aspect gets
    // bars, a 1920x480 render fills exactly either way). Scenes draw at the native size.
    var fitContain = item.kind === 'video' || opts.imageFit === 'contain';
    layer.classList.toggle('fit-cover', !fitContain);
    layer.classList.toggle('fit-contain', fitContain);
    if (item.kind === 'scene') {
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      layer.appendChild(cv);
      stopScene[layerIdx] = SCENE_FNS[item.name] ? SCENE_FNS[item.name](cv) : null;
      ready();
    } else if (item.kind === 'collage') {
      var ccv = document.createElement('canvas');
      ccv.width = W; ccv.height = H;
      layer.appendChild(ccv);
      stopScene[layerIdx] = runCollage(ccv);
      ready();
    } else if (item.kind === 'image') {
      var img = document.createElement('img');
      var done = false, fin = function () { if (!done) { done = true; ready(); } };
      img.onload = fin; img.onerror = fin;
      img.src = mediaUrl('image', item.name);
      layer.appendChild(img);
      setTimeout(fin, 4000);
    } else {
      var v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      if (playlist.length === 1) v.loop = true;
      else v.addEventListener('ended', function () { advance(); });
      var vdone = false, vfin = function () { if (!vdone) { vdone = true; ready(); } };
      v.addEventListener('canplaythrough', vfin);
      v.addEventListener('error', function () { vfin(); });
      v.src = mediaUrl('video', item.name);
      layer.appendChild(v);
      setTimeout(vfin, 4000);
    }
  }

  function advance() {
    if (swapping || !playlist.length) return;
    swapping = true;
    clearTimer();
    pos++;
    if (pos >= order.length) { pos = 0; reshuffle(); }
    var item = playlist[order[pos]];
    var back = 1 - front;
    loadInto(back, item, function () {
      var was = front;
      layers[back].classList.add('show');
      layers[was].classList.remove('show');
      front = back;
      // After the fade completes, stop the hidden layer's scene / drop its media element.
      setTimeout(function () {
        if (stopScene[was]) { stopScene[was](); stopScene[was] = null; }
        layers[was].innerHTML = '';
        swapping = false;
      }, 900);
      // Images and scenes advance on the interval; videos advance on 'ended' (their own runtime
      // wins over the interval — DK does the same); the collage paces itself (a print per
      // interval, several prints per cycle turn). Single-item playlists just sit there.
      if (playlist.length > 1 && item.kind !== 'video' && item.kind !== 'collage') armTimer(intervalMs());
    });
  }

  function restart() {
    clearTimer();
    swapping = false;
    pos = -1;
    buildPlaylist();
    var empty = !playlist.length;
    $('hint').classList.toggle('show', empty);
    layers.forEach(function (l, i) {
      l.classList.remove('show');
      if (stopScene[i]) { stopScene[i](); stopScene[i] = null; }
      l.innerHTML = '';
    });
    if (!empty) advance();
  }

  function fetchState(cb) {
    fetch('/screensaver/state').then(function (r) { return r.json(); }).then(function (s) {
      var p = (s && s.photos) || {}, v = (s && s.videos) || {};
      photos = p.files || [];
      videos = v.files || [];
      photosDirLabel = p.dir || ''; photosDefault = p.usingDefault !== false;
      videosDirLabel = v.dir || ''; videosDefault = v.usingDefault !== false;
      syncSettingsUI();
      if (cb) cb();
    }).catch(function () { photos = []; videos = []; if (cb) cb(); });
  }

  // =====================================================================================
  // Tap / gear / settings
  // =====================================================================================
  var gearTimer = null;
  function flashGear() {
    $('gear').classList.add('show');
    if (gearTimer) clearTimeout(gearTimer);
    gearTimer = setTimeout(function () { $('gear').classList.remove('show'); }, 5000);
  }
  $('stage').addEventListener('click', function () { advance(); flashGear(); });
  $('hint').addEventListener('click', function () { flashGear(); });
  $('gear').addEventListener('click', function (e) { e.stopPropagation(); openSettings(); });

  function postOption(key, value, cb) {
    fetch('/screensaver/option', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, value: String(value) }),
    }).then(function (r) { return r.json(); }).then(function (j) { if (cb) cb(j && j.ok); })
      .catch(function () { if (cb) cb(false); });
  }

  // Segmented pickers: [value, label] pairs; a current value outside the list gets its own chip.
  function renderSeg(el, pairs, current, onPick) {
    var list = pairs.slice();
    if (!list.some(function (p) { return p[0] === String(current); })) list.push([String(current), String(current)]);
    el.innerHTML = '';
    list.forEach(function (p) {
      var b = document.createElement('button');
      b.textContent = p[1];
      if (p[0] === String(current)) b.classList.add('on');
      b.addEventListener('click', function () { onPick(p[0]); });
      el.appendChild(b);
    });
  }

  function syncSettingsUI() {
    // Show is a flat multiselect: any mix of the three groups.
    (function () {
      var el = $('segShow');
      el.innerHTML = '';
      [['showScenes', 'Scenes'], ['showPhotos', 'Photos'], ['showVideos', 'Videos']].forEach(function (pair) {
        var b = document.createElement('button');
        b.textContent = pair[1];
        if (opts[pair[0]]) b.classList.add('on');
        b.addEventListener('click', function () {
          opts[pair[0]] = !opts[pair[0]];
          postOption(pair[0], opts[pair[0]] ? '1' : '0');
          syncSettingsUI(); restart();
        });
        el.appendChild(b);
      });
    })();
    // Scenes are independent toggles — tap any mix on/off (all off = the honest empty state).
    (function () {
      var el = $('segScene');
      el.innerHTML = '';
      SCENES.forEach(function (id) {
        var b = document.createElement('button');
        b.textContent = SCENE_LABELS[id];
        if (opts.sceneOn[id]) b.classList.add('on');
        b.addEventListener('click', function () {
          opts.sceneOn[id] = !opts.sceneOn[id];
          postOption(sceneKey(id), opts.sceneOn[id] ? '1' : '0');
          syncSettingsUI(); restart();
        });
        el.appendChild(b);
      });
    })();
    renderSeg($('segStyle'), [['slide', 'Slideshow'], ['collage', 'Collage']], opts.imageStyle, function (v) {
      opts.imageStyle = v; postOption('imageStyle', v); syncSettingsUI(); restart();
    });
    renderSeg($('segFill'), [['cover', 'Crop to fill'], ['contain', "Don't crop"]], opts.imageFit, function (v) {
      opts.imageFit = v; postOption('imageFit', v); syncSettingsUI(); restart();
    });
    renderSeg($('segShuffle'), [['0', 'Off'], ['1', 'On']], opts.shuffle ? '1' : '0', function (v) {
      opts.shuffle = v === '1'; postOption('shuffle', v); syncSettingsUI(); restart();
    });
    renderSeg($('segInterval'), [['5', '5s'], ['10', '10s'], ['20', '20s'], ['30', '30s'], ['60', '1m'], ['300', '5m']], String(opts.intervalSec), function (v) {
      opts.intervalSec = parseInt(v, 10) || 10; postOption('intervalSec', v); syncSettingsUI();
    });
    renderSeg($('segIdle'), [['0', 'Never'], ['1', '1m'], ['5', '5m'], ['10', '10m'], ['30', '30m'], ['60', '1h']], String(opts.idleMinutes), function (v) {
      opts.idleMinutes = v; postOption('idleMinutes', v); syncSettingsUI();
    });
    $('rowScene').style.display = opts.showScenes ? '' : 'none';
    $('rowStyle').style.display = opts.showPhotos ? '' : 'none';
    $('rowFill').style.display = (opts.showPhotos && opts.imageStyle === 'slide') ? '' : 'none';   // crop applies to slideshow photos only
    // Folder rows stay visible no matter what's toggled — hiding them by mode just hides
    // configuration people are looking for.
    $('photosVal').textContent = photosDirLabel ? (photosDirLabel + (photosDefault ? '  (default)' : '')) : '—';
    $('videosVal').textContent = videosDirLabel ? (videosDirLabel + (videosDefault ? '  (default)' : '')) : '—';
  }

  function openSettings() { syncSettingsUI(); $('settingsOverlay').classList.add('show'); }
  $('setDone').addEventListener('click', function () { $('settingsOverlay').classList.remove('show'); });
  $('settingsOverlay').addEventListener('click', function (e) { if (e.target === $('settingsOverlay')) $('settingsOverlay').classList.remove('show'); });

  // ---- folder browser (generic /projects route; row taps navigate, one persistent Use action) ----
  var fbRoot = '';
  function fbLoad(p) {
    fetch('/screensaver/projects' + (p ? '?path=' + encodeURIComponent(p) : '')).then(function (r) { return r.json(); }).then(function (s) {
      fbRoot = s.root || '';
      $('fbPath').textContent = fbRoot || '—';
      $('fbUp').disabled = !s.parent;
      $('fbUp').onclick = function () { if (s.parent) fbLoad(s.parent); };
      var list = $('fbList');
      list.innerHTML = '';
      (s.dirs || []).forEach(function (d) {
        var b = document.createElement('button');
        var parts = d.split(/[\\/]/);
        b.textContent = '📁 ' + (parts[parts.length - 1] || d);
        b.addEventListener('click', function () { fbLoad(d); });
        list.appendChild(b);
      });
    }).catch(function () {});
  }
  var fbTarget = 'photosDir';   // which folder option the browser is picking for
  function openFolderBrowser(target, startDir) {
    fbTarget = target;
    $('folderOverlay').classList.add('show');
    fbLoad(startDir || '');
  }
  $('photosBrowse').addEventListener('click', function () { openFolderBrowser('photosDir', photosDirLabel); });
  $('videosBrowse').addEventListener('click', function () { openFolderBrowser('videosDir', videosDirLabel); });
  $('fbClose').addEventListener('click', function () { $('folderOverlay').classList.remove('show'); });
  $('fbUse').addEventListener('click', function () {
    if (!fbRoot) return;
    postOption(fbTarget, fbRoot, function () {
      $('folderOverlay').classList.remove('show');
      fetchState(function () { restart(); });
    });
  });
  $('fbDefault').addEventListener('click', function () {
    postOption(fbTarget, '', function () {
      $('folderOverlay').classList.remove('show');
      fetchState(function () { restart(); });
    });
  });

  // Pause the show while the page isn't visible (native grid shown over the webview); the media
  // pages unload on real page switches, but grid pages only hide us. Videos advance on their own
  // 'ended', so only the image/scene timer needs re-arming.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimer(); return; }
    var cur = playlist.length ? playlist[order[Math.max(0, pos)]] : null;
    if (playlist.length > 1 && cur && cur.kind !== 'video') armTimer(intervalMs());
  });

  // ---- boot ----
  fetchState(function () { restart(); });
})();
