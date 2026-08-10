  const panelApi = window.openQuakePanel;
  const grid = document.getElementById('grid'), vol = document.getElementById('vol'), web = document.getElementById('web');
  const webgrid = document.getElementById('webgrid');   // button strip beside a dashboard
  const selector = document.getElementById('selector'), selitems = document.getElementById('selitems');
  const intro = document.getElementById('intro'), introok = document.getElementById('introok');
  let cfg = { cols: 8, rows: 2, tiles: [] };
  let grids = [], activeId = null, rotEnabled = false, rotRunning = false, introOpen = false;
  let armed = false, idleT = null, lastHit = -1, volT = null;
  let selOpen = false, selIdx = 0, selAutoClose = null;
  let knobSel = -1;   // knob "select button" mode: index of the highlighted tile (-1 = none)
  let pendingRotFlash = false;   // a knob click just toggled rotation -> flash the new state when it comes back
  let webMode = false, curUrl = '', webReady = false, webDown = false, lastWeb = { x: 0, y: 0 }, webIdle = null;
  let haToken = '', haInject = false, webExternalLinks = false, webAttached = false, pendingWebUrl = null;
  let webThemed = false, lastTheme = null;   // our served app pages (Music/Chat): inject live light/dark + accent into the guest
  // dashboard button strip: webRegion = the webview's sub-rect, webStrip = the tile-strip geometry (null = none)
  let webRegion = { left: 0, width: 1920 }, webStrip = null, stripArmed = false, stripIdleT = null, stripLastHit = -1;
  // The <webview> can't be navigated until its first dom-ready — a programmatic src set during the
  // initial about:blank load is silently dropped. Gate the first dashboard navigation on that, so a
  // dashboard set as the start page actually loads instead of sitting on about:blank (a black panel).
  // Per-page "desktop browser identity": some sites (claude.ai, chatgpt.com) refuse to run / sign in
  // inside an embedded webview. Spoofing a desktop-Chrome UA (changes navigator.userAgent too, not just
  // the header — that's what bot checks read) makes them treat the panel as a real browser. defaultUA is
  // captured at first attach, before any override, so a non-spoof page resets cleanly.
  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
  let defaultUA = '', pendingDesktop = false, webDesktop = false;
  function setUA(desktop) { const ua = desktop ? DESKTOP_UA : defaultUA; try { if (ua) web.setUserAgent(ua); } catch (e) {} }
  function navWeb(url, desktop) {
    if (webAttached) { setUA(desktop); web.src = url; }
    else { pendingWebUrl = url; pendingDesktop = desktop; }
  }
  web.addEventListener('dom-ready', () => {
    webReady = true;
    if (!webAttached) {
      webAttached = true;
      try { defaultUA = web.getUserAgent(); } catch (e) {}      // true default (about:blank), before any override
      const u = pendingWebUrl; pendingWebUrl = null;
      if (u) { setUA(pendingDesktop); web.src = u; }
    }
  });
  // Home Assistant has no keyboard on the panel — if a long-lived token is set, seed HA's auth into
  // localStorage so it loads signed-in, then reload into the dashboard. (Standard HA kiosk technique.)
  // Our served app pages (Music/Chat) already encode the theme in their URL, but injecting it on every
  // load (and on every live theme change) makes them bulletproof against a stale cache and lets the
  // theme update without a full reload. Runs in the host's isolated world, so the page CSP doesn't block it.
  function injectWebTheme() {
    if (!webThemed || !webReady || !lastTheme) return;
    const dark = !!lastTheme.dark, accent = lastTheme.accent || '';
    web.executeJavaScript(
      'document.body.classList.toggle("light",' + (!dark) + ');' +
      (accent ? 'document.documentElement.style.setProperty("--accent",' + JSON.stringify(accent) + ');' : '')
    ).catch(function () {});
  }
  web.addEventListener('did-finish-load', injectWebTheme);
  web.addEventListener('did-finish-load', () => {
    if (!haInject || !haToken) return;
    haInject = false;
    let origin = ''; try { origin = new URL(curUrl).origin; } catch (e) { return; }
    const tok = { access_token: haToken, token_type: 'Bearer', expires_in: 315360000, hassUrl: origin, clientId: null, expires: Date.now() + 315360000000, refresh_token: '' };
    web.executeJavaScript(`try{localStorage.setItem('hassTokens', ${JSON.stringify(JSON.stringify(tok))});location.replace(${JSON.stringify(curUrl)});}catch(e){}`).catch(() => {});
  });

  // ---- "open clicked links in my PC browser" (per-dashboard toggle) ----
  // When a dashboard page has linksExternal set, a link the user taps opens in the host's default
  // browser instead of navigating the on-panel webview — e.g. tapping a helpdesk ticket pops it up
  // on the PC while the board stays live on the device. Three paths cover every way a link opens:
  //   • a clicked <a href> — caught in the capture phase by an injected listener, funneled out via a
  //     console-message tag (the guest has no nodeIntegration, so the console is the host channel);
  //   • window.open / target=_blank the page does itself — the webview's new-window event;
  //   • a JS navigation away from the board (location = …) — will-navigate, which we abort + restore.
  web.addEventListener('new-window', (e) => { if (webExternalLinks && e.url) panelApi.openExternal(e.url); });
  web.addEventListener('will-navigate', (e) => {
    if (webExternalLinks && webReady && e.url && e.url !== curUrl) {
      panelApi.openExternal(e.url);
      try { web.stop(); web.src = curUrl; } catch (er) {}       // abort the panel nav, keep the board up
    }
  });
  web.addEventListener('console-message', (e) => {
    if (webExternalLinks && e.message && e.message.indexOf('OQX_OPEN::') === 0) panelApi.openExternal(e.message.slice(10));
  });
  web.addEventListener('did-finish-load', () => {
    if (!webExternalLinks) return;
    web.executeJavaScript("(function(){if(window.__oqx)return;window.__oqx=1;document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a&&/^https?:/i.test(a.href)){e.preventDefault();e.stopPropagation();console.log('OQX_OPEN::'+a.href);}},true);})();").catch(function(){});
  });

  // ---- display orientation: rotate only when the panel is a portrait window ----
  function layoutStage() {
    const stage = document.getElementById('stage');
    const w = window.innerWidth, h = window.innerHeight;
    // Portrait display (e.g. 480x1920): rotate the 1920x480 stage 90° to fill it.
    // Landscape display (1920x480, Windows Orientation = Landscape): no rotation, so the
    // OS mouse cursor and the content agree (otherwise the cursor reads 90° off).
    stage.style.transform = (h > w) ? `translate(${w}px, 0) rotate(90deg)` : 'none';
  }
  window.addEventListener('resize', layoutStage);
  layoutStage();

  // ---- active grid ----
  // Build one tile element (shared by the main grid and the dashboard button strip).
  function makeTile(t, i, cols) {
    const col = i % cols, row = Math.floor(i / cols);
    const w = (t && t.w) || 1, h = (t && t.h) || 1;
    const d = document.createElement('div');
    const empty = !t || !t.type;
    d.className = 'tile' + (empty ? ' empty' : '') + ((w > 1 || h > 1) ? ' span' : '');
    d.dataset.i = i;
    d.style.gridColumn = `${col + 1} / span ${w}`;
    d.style.gridRow = `${row + 1} / span ${h}`;
    if (t && t.type === 'counter') {
      // DOM-build everything (no innerHTML for label/value) so a config-supplied label can't inject markup
      const wrap = document.createElement('div'); wrap.className = 'tile-counter';
      const bMinus = document.createElement('button'); bMinus.className = 'btn-minus'; bMinus.textContent = '-';
      const center = document.createElement('div'); center.className = 'counter-center';
      const title = document.createElement('div'); title.className = 'title'; title.textContent = t.label || '';
      const val = document.createElement('span'); val.className = 'val'; val.textContent = String(parseInt(t.value) || 0);
      center.appendChild(title); center.appendChild(val);
      const bPlus = document.createElement('button'); bPlus.className = 'btn-plus'; bPlus.textContent = '+';
      wrap.appendChild(bMinus); wrap.appendChild(center); wrap.appendChild(bPlus);
      d.appendChild(wrap);
    } else if (!empty) {                                       // build via DOM nodes (never innerHTML) so a config-supplied label/icon can't inject markup
      if (t.iconSrc) { const im = document.createElement('img'); im.className = 'ic-img'; im.src = t.iconSrc; d.appendChild(im); }
      else { const icd = document.createElement('div'); icd.className = 'ic'; icd.textContent = t.icon || '▫️'; d.appendChild(icd); }
      const lb = document.createElement('div'); lb.className = 'lb'; lb.textContent = t.label || ''; d.appendChild(lb);
    }
    return d;
  }
  function build() {
    grid.style.gridTemplateColumns = `repeat(${cfg.cols},1fr)`;
    grid.style.gridTemplateRows = `repeat(${cfg.rows},1fr)`;
    grid.innerHTML = '';
    cfg.tiles.forEach((t, i) => { if (t && t.cover != null) return; grid.appendChild(makeTile(t, i, cfg.cols)); });   // skip cells covered by a merged tile
  }
  // Render the dashboard button strip into #webgrid and size/place it; resize the webview to the rest.
  function buildStrip(g) {
    const cols = g.cols || 2, rows = g.rows || 2;
    const stripW = Math.min(1100, Math.round(cols * (480 / rows)));   // square tiles; cap so the dashboard keeps room
    const left = g.gridAlign === 'left';
    webRegion = { left: left ? stripW : 0, width: 1920 - stripW };
    webStrip = { left: left ? 0 : 1920 - stripW, w: stripW, cols, rows };
    web.style.left = webRegion.left + 'px'; web.style.width = webRegion.width + 'px';
    webgrid.style.left = webStrip.left + 'px'; webgrid.style.width = stripW + 'px';
    webgrid.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    webgrid.style.gridTemplateRows = `repeat(${rows},1fr)`;
    webgrid.innerHTML = '';
    (g.tiles || []).forEach((t, i) => { if (t && t.cover != null) return; webgrid.appendChild(makeTile(t, i, cols)); });
    webgrid.classList.add('show');
  }
  function hideStrip() {   // full-screen webview again
    webStrip = null; webRegion = { left: 0, width: 1920 };
    web.style.left = '0'; web.style.width = '1920px'; webgrid.classList.remove('show');
  }
  panelApi.onGrid(g => {
    cfg = g;
    knobSel = -1;   // drop any knob "select" highlight when the page changes
    if (g && g.kind === 'web') {            // dashboard page -> show the webview
      webMode = true; grid.style.display = 'none'; web.classList.add('show');
      webThemed = !!g.themed;               // our served app page -> inject light/dark + accent on load
      const auth = g.auth || {};
      haToken = auth.type === 'ha' ? (auth.token || '') : '';   // HA seeds localStorage; basic/header handled in main
      webExternalLinks = !!g.linksExternal;                     // route clicked links to the PC browser (per-page toggle)
      const url = g.url || 'about:blank';
      const desktop = !!g.desktopUA;                            // spoof desktop-Chrome identity for this page (per-page toggle)
      if (url !== curUrl || desktop !== webDesktop) {
        // App-page options (World Clock analog/digital, Flip Clock settings, …) ride in the URL fragment
        // (#…). A src/loadURL set to a hash-only-different URL is a same-document fragment nav that never
        // reloads, so the page never re-read its options — the change only showed after leaving and
        // returning. When only the fragment changed on one of our own app pages, drive the guest's
        // location.hash directly: that always fires `hashchange`, and the page re-renders from it live.
        const hashOnly = !!curUrl && desktop === webDesktop && url.split('#')[0] === curUrl.split('#')[0];
        if (hashOnly && webThemed && webAttached) {
          curUrl = url;
          web.executeJavaScript('location.hash=' + JSON.stringify('#' + (url.split('#')[1] || ''))).catch(() => {});
        } else {
          curUrl = url; webDesktop = desktop; webReady = false; haInject = !!haToken; navWeb(url, desktop);
        }
      }
      if (g.gridOn && (g.tiles || []).length) buildStrip(g); else hideStrip();   // optional button strip beside the dashboard
    } else {                                // tile grid
      webMode = false; web.classList.remove('show'); grid.style.display = 'grid'; build();
      hideStrip();
    }
  });
  panelApi.onTheme(t => {
    document.body.classList.toggle('light', !(t && t.dark));            // per-card: grid tiles + webview chrome
    document.body.classList.toggle('glight', !(t && t.globalDark));     // global: page-menu / intro / volume overlays
    if (t && t.accent) document.documentElement.style.setProperty('--accent', t.accent);
    lastTheme = t; injectWebTheme();                                    // push the theme live into a served app page (no reload needed)
  });
  panelApi.onGridList(d => { grids = d.grids; activeId = d.activeId; if (selOpen) renderWheel(); });
  // Global reload hotkey (Settings -> Software -> Dashboards): main already checked the active page
  // is kind:'web' before sending this, but webMode is the renderer's own source of truth for what's
  // actually on screen right now, so gate on it here too.
  panelApi.onReloadDashboard(() => { if (webMode) { try { web.reload(); } catch (e) {} } });
  panelApi.onRotation(r => {
    rotEnabled = !!r.enabled; rotRunning = !!r.running; if (selOpen) renderWheel();
    if (pendingRotFlash) { pendingRotFlash = false; flashVol(rotRunning ? '⟳ Rotation on' : '⛔ Rotation off'); }
  });

  // ---- first-run intro overlay (one-time "double-click the knob" hint) ----
  panelApi.onIntro(() => { if (introOpen) return; introOpen = true; intro.classList.add('open'); });
  function dismissIntro() { if (!introOpen) return; introOpen = false; intro.classList.remove('open'); panelApi.introDone(); }
  introok.addEventListener('click', dismissIntro);   // PC mouse

  // ---- touch -> launch ----
  function tileAt(sx, sy) {
    const col = Math.floor(sx / (1920 / cfg.cols)), row = Math.floor(sy / (480 / cfg.rows));
    if (col < 0 || col >= cfg.cols || row < 0 || row >= cfg.rows) return -1;
    let idx = row * cfg.cols + col;
    const t = cfg.tiles[idx];
    if (t && t.cover != null) idx = t.cover;                  // covered cell -> its merged owner
    return idx;
  }
  function highlight(i) {
    if (i === lastHit) return;
    if (lastHit >= 0) { const p = grid.querySelector(`[data-i="${lastHit}"]`); if (p) p.classList.remove('hit'); }
    if (i >= 0 && cfg.tiles[i] && cfg.tiles[i].type) { const el = grid.querySelector(`[data-i="${i}"]`); if (el) el.classList.add('hit'); }
    lastHit = i;
  }
  panelApi.onTouch(pts => {
    if (introOpen) { if (pts.some(p => p.action === 1)) dismissIntro(); return; }   // any tap dismisses the intro
    if (selOpen) return; // ignore touch while picking a page
    const p = pts.find(p => p.action === 1) || pts[0]; if (!p) return;
    if (webMode) {                          // dashboard: strip taps launch tiles, the rest forwards to the webview
      if (webStrip && p.x >= webStrip.left && p.x < webStrip.left + webStrip.w) return stripTouch(p);
      return webTouch(p);
    }
    const i = tileAt(p.x, 480 - p.y);
    if (i >= 0 && cfg.tiles[i] && cfg.tiles[i].type === 'counter') {
      if (p.action === 1) {
        const tileWidth = 1920 / cfg.cols;
        const isMinus = (p.x % tileWidth) < tileWidth / 2;
        const tileEl = grid.querySelector(`[data-i="${i}"]`);
        if (tileEl) {
          const btn = tileEl.querySelector(isMinus ? '.btn-minus' : '.btn-plus');
          if (btn) { btn.classList.add('btn-hit'); setTimeout(() => btn.classList.remove('btn-hit'), 150); }
        }
        if (!counterLocked) { counterLocked = true; updateCounter(i, isMinus ? -1 : 1); setTimeout(() => { counterLocked = false; }, 150); }
      }
      return;
    }
    highlight(i);
    if (!armed && i >= 0 && cfg.tiles[i] && cfg.tiles[i].type) { armed = true; panelApi.launch(cfg.tiles[i]); }
    clearTimeout(idleT);
    idleT = setTimeout(() => { armed = false; highlight(-1); }, 180);
  });

  // ---- PC mouse -> launch (the panel is a real display; let the cursor click tiles too) ----
  grid.addEventListener('click', (e) => {
    if (selOpen || webMode) return;                  // ignore while picking a page / on dashboards (webview clicks natively)
    const el = e.target.closest && e.target.closest('[data-i]');
    if (!el) return;
    const i = parseInt(el.dataset.i, 10);
    if (i < 0 || !cfg.tiles[i] || !cfg.tiles[i].type) return;
    if (cfg.tiles[i].type === 'counter') {
      // For PC mouse: figure out which half of the tile got clicked, then update
      const rect = el.getBoundingClientRect();
      const isMinus = (e.clientX - rect.left) < rect.width / 2;
      const btn = el.querySelector(isMinus ? '.btn-minus' : '.btn-plus');
      if (btn) { btn.classList.add('btn-hit'); setTimeout(() => btn.classList.remove('btn-hit'), 150); }
      updateCounter(i, isMinus ? -1 : 1);
      return;
    }
    highlight(i);
    panelApi.launch(cfg.tiles[i]);
    setTimeout(() => highlight(-1), 180);
  });
  // PC mouse on the dashboard button strip (the strip overlays the webview region, so it gets its own handler)
  webgrid.addEventListener('click', (e) => {
    if (selOpen || !webStrip) return;
    const el = e.target.closest && e.target.closest('[data-i]');
    if (!el) return;
    const i = parseInt(el.dataset.i, 10);
    if (i < 0 || !cfg.tiles[i] || !cfg.tiles[i].type) return;
    if (cfg.tiles[i].type === 'counter') {
      const rect = el.getBoundingClientRect();
      const isMinus = (e.clientX - rect.left) < rect.width / 2;
      const btn = el.querySelector(isMinus ? '.btn-minus' : '.btn-plus');
      if (btn) { btn.classList.add('btn-hit'); setTimeout(() => btn.classList.remove('btn-hit'), 150); }
      updateCounter(i, isMinus ? -1 : 1);
      return;
    }
    stripHighlight(i);
    panelApi.launch(cfg.tiles[i]);
    setTimeout(() => stripHighlight(-1), 180);
  });

  // ---- dashboard touch -> mouse (tap = click, drag = move) ----
  function webTouch(p) {
    if (!webReady) return;
    // map panel x into the webview's own coordinate space (it may be inset by a button strip)
    const x = Math.max(0, Math.min(webRegion.width, p.x - webRegion.left)), y = Math.max(0, Math.min(480, 480 - p.y));
    lastWeb = { x, y }; clearTimeout(webIdle);
    try {
      if (p.action === 1) {
        if (!webDown) { webDown = true; web.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); }
        else web.sendInputEvent({ type: 'mouseMove', x, y });
        webIdle = setTimeout(webRelease, 140);   // finger lifted without an explicit up frame
      } else { webRelease(); }
    } catch (e) {}
  }
  function webRelease() {
    clearTimeout(webIdle);
    if (webDown) { webDown = false; try { web.sendInputEvent({ type: 'mouseUp', x: lastWeb.x, y: lastWeb.y, button: 'left', clickCount: 1 }); } catch (e) {} }
  }

  // ---- dashboard button strip: a tap in the strip launches its tile (mirrors the main grid touch path) ----
  function stripHighlight(i) {
    if (i === stripLastHit) return;
    if (stripLastHit >= 0) { const p = webgrid.querySelector(`[data-i="${stripLastHit}"]`); if (p) p.classList.remove('hit'); }
    if (i >= 0 && cfg.tiles[i] && cfg.tiles[i].type) { const el = webgrid.querySelector(`[data-i="${i}"]`); if (el) el.classList.add('hit'); }
    stripLastHit = i;
  }
  function stripTouch(p) {
    if (!webStrip) return;
    const sy = 480 - p.y, lx = p.x - webStrip.left;
    const tileW = webStrip.w / webStrip.cols, tileH = 480 / webStrip.rows;
    const col = Math.floor(lx / tileW), row = Math.floor(sy / tileH);
    if (col < 0 || col >= webStrip.cols || row < 0 || row >= webStrip.rows) return;
    let idx = row * webStrip.cols + col;
    let t = cfg.tiles[idx];
    if (t && t.cover != null) { idx = t.cover; t = cfg.tiles[idx]; }   // covered cell -> its merged owner
    if (!t || !t.type) return;
    if (t.type === 'counter') {
      if (p.action === 1) {
        const isMinus = (lx % tileW) < tileW / 2;
        const el = webgrid.querySelector(`[data-i="${idx}"]`);
        if (el) { const btn = el.querySelector(isMinus ? '.btn-minus' : '.btn-plus'); if (btn) { btn.classList.add('btn-hit'); setTimeout(() => btn.classList.remove('btn-hit'), 150); } }
        if (!counterLocked) { counterLocked = true; updateCounter(idx, isMinus ? -1 : 1); setTimeout(() => { counterLocked = false; }, 150); }
      }
      return;
    }
    stripHighlight(idx);
    if (!stripArmed && p.action === 1) { stripArmed = true; panelApi.launch(t); }
    clearTimeout(stripIdleT);
    stripIdleT = setTimeout(() => { stripArmed = false; stripHighlight(-1); }, 180);
  }

  // ---- dial selector ----
  // wheel = a rotation on/off toggle (only when rotation is enabled in settings) + the pages
  function wheelItems() { return (rotEnabled ? [{ rot: true }] : []).concat(grids); }
  function renderWheel() {
    const items = wheelItems();
    selitems.innerHTML = '';
    items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'selitem' + (i === selIdx ? ' sel' : '');
      d.textContent = it.rot ? (rotRunning ? '⏸ Rotation: ON' : '▶ Rotation: OFF') : it.name;
      selitems.appendChild(d);
    });
    selitems.style.transform = `translateY(${-selIdx * 76}px)`;
  }
  function openSelector() {
    const items = wheelItems();
    if (!items.length) return;
    selOpen = true;
    const gi = grids.findIndex(g => g.id === activeId);
    selIdx = gi >= 0 ? (rotEnabled ? 1 : 0) + gi : 0;     // land on the live page (offset past the rotation row)
    selector.classList.add('open'); renderWheel(); resetAutoClose();
  }
  function closeSelector() { selOpen = false; selector.classList.remove('open'); clearTimeout(selAutoClose); }
  function moveSelector(dir) { selIdx = Math.min(wheelItems().length - 1, Math.max(0, selIdx + dir)); renderWheel(); resetAutoClose(); }
  function confirmSelector() {
    const it = wheelItems()[selIdx]; closeSelector();
    if (it && it.rot) panelApi.toggleRotation();
    else if (it) panelApi.switchGrid(it.id);
  }
  function resetAutoClose() { clearTimeout(selAutoClose); selAutoClose = setTimeout(closeSelector, 4500); }

  // ---- knob ----
  // The knob does click-type detection in hardware: press index 1 = single-click, 2 = double-click.
  panelApi.onKnob(k => {
    if (introOpen) {   // teach by doing: a double-click clears the intro and opens the page menu; ignore other knob input
      if (k.type === 'press' && k.index === 2) { dismissIntro(); openSelector(); }
      return;
    }
    if (k.type === 'hold') {   // press-and-hold -> push-to-talk; the served chat page defines window.pttStart/Stop
      if (webMode && webReady) web.executeJavaScript(k.phase === 'start' ? 'window.pttStart&&window.pttStart()' : 'window.pttStop&&window.pttStop()').catch(function () {});
      return;
    }
    if (k.type === 'rotate') {
      if (selOpen) { moveSelector(k.dir > 0 ? -1 : 1); return; }          // CW scrolls down the page list
      const turn = (cfg._knob && cfg._knob.turn) || 'pages';
      if (turn === 'volume') { panelApi.volume(k.dir > 0 ? 1 : -1); flashVol(k.dir > 0 ? '🔊 +' : '🔉 −'); }
      else if (turn === 'scroll') {                                       // native wheel at center -> inner scrollables (Grafana/HA, lyrics) scroll too
        if (webMode && webReady) { try { web.sendInputEvent({ type: 'mouseWheel', x: Math.round(webRegion.width / 2), y: 240, deltaX: 0, deltaY: k.dir > 0 ? -120 : 120, wheelTicksX: 0, wheelTicksY: k.dir > 0 ? -1 : 1, hasPreciseScrollingDeltas: true, canScroll: true }); } catch (e) {} }
      }
      else if (turn === 'select') { selectMove(k.dir > 0 ? 1 : -1); }
      else { cyclePage(k.dir > 0 ? -1 : 1); }                            // 'pages' (default): match the double-click selector's turn direction
      return;
    }
    if (k.type === 'press') {
      if (selOpen) { confirmSelector(); return; }           // any press picks the highlighted grid
      // Single press -> configured click action; double press -> configured dblclick action.
      // Defaults preserve prior behavior: click='rotation' (toggle), dblclick='selector'.
      const action = (k.index === 2)
        ? ((cfg._knob && cfg._knob.dblclick) || 'selector')
        : ((cfg._knob && cfg._knob.click) || 'rotation');
      doKnobAction(action);
    }
  });
  function doKnobAction(a) {
    if (a === 'selector') return openSelector();
    if (a === 'mute') { panelApi.volume('mute'); flashVol('🔇'); return; }
    if (a === 'enter') return knobEnter();
    if (a === 'home') return panelApi.gotoHome();
    if (a === 'rotation_start') return panelApi.startRotation();
    if (a === 'rotation_stop') return panelApi.stopRotation();
    // 'rotation' (default toggle) — flash the new state on the rotation update
    pendingRotFlash = true; panelApi.toggleRotation();
  }
  // ---- knob "scroll pages" / "select button" / "enter" ----
  function cyclePage(dir) {
    if (!grids.length) return;
    let gi = grids.findIndex(g => g.id === activeId); if (gi < 0) gi = 0;
    const next = grids[(gi + dir + grids.length) % grids.length];
    panelApi.switchGrid(next.id);
    flashVol(next.name || '(unnamed)');                 // brief overlay of the page name (same pattern as volume/rotation flashes)
  }
  function selHost() { return (webMode && webStrip) ? webgrid : (!webMode ? grid : null); }   // grid tiles, or a dashboard/app's strip; null on a page with no buttons
  function selButtons() { const out = []; (cfg.tiles || []).forEach((t, i) => { if (t && t.type && t.cover == null) out.push(i); }); return out; }
  function renderSel() {
    document.querySelectorAll('[data-i].ksel').forEach(el => el.classList.remove('ksel'));
    const host = selHost(); if (!host || knobSel < 0) return;
    const el = host.querySelector(`[data-i="${knobSel}"]`); if (el) el.classList.add('ksel');
  }
  function selectMove(dir) {
    const btns = selButtons(); if (!btns.length) { knobSel = -1; return; }
    let pos = btns.indexOf(knobSel); if (pos < 0) pos = dir > 0 ? -1 : 0;
    knobSel = btns[(pos + dir + btns.length) % btns.length];
    renderSel();
  }
  function knobEnter() {
    if (knobSel >= 0 && cfg.tiles[knobSel] && cfg.tiles[knobSel].type) {   // activate the highlighted button
      const inStrip = webMode && webStrip; (inStrip ? stripHighlight : highlight)(knobSel);
      panelApi.launch(cfg.tiles[knobSel]);
      setTimeout(() => { (inStrip ? stripHighlight : highlight)(-1); renderSel(); }, 180);
      return;
    }
    if (cfg && cfg.app === 'music') { panelApi.media('playpause'); return; }   // music: play/pause
    panelApi.launch({ type: 'key', value: 'enter', label: 'knob enter' });     // else: a real Enter keystroke
  }
  let counterLocked = false;
  function updateCounter(idx, delta) {
    const t = cfg.tiles[idx];
    if (!t) return;
    const count = (parseInt(t.value) || 0) + delta;
    t.value = String(count);
    const host = (webMode && webStrip) ? webgrid : grid;   // a counter can live in the dashboard strip too
    const el = host.querySelector(`[data-i="${idx}"] .val`);
    if (el) el.textContent = String(count);
    console.log('[counter] updateCounter: cfg.id=', JSON.stringify(cfg.id), 'idx=', idx, 'count=', count);
    panelApi.saveTileValue(cfg.id, idx, String(count));
  }

  function flashVol(t) { vol.textContent = t; vol.style.opacity = 1; clearTimeout(volT); volT = setTimeout(() => vol.style.opacity = 0, 500); }
