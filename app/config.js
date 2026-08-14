  const configApi = window.openQuakeConfig;
  let config = { activeGridId: null, grids: [] };
  let gi = 0, ti = -1, selEnd = -1, dragFrom = -1, dirty = false, appDefs = [], view = 'pages', ledState = null, settingsTab = 'software', dashTab = 'page';
  // Left sidebar tab (Pages vs Groups list) + which group is currently being edited when view='groups'.
  let leftTab = 'pages', groupIndex = -1;
  // QMK RGB-Matrix effect names — index is the value written to the device (0 = ring off).
  const LED_EFFECTS = ['All Off (ring off)', 'Solid Color', 'Alphas Mods', 'Gradient Up/Down', 'Gradient Left/Right', 'Breathing', 'Band Sat.', 'Band Val.', 'Pinwheel Sat.', 'Pinwheel Val.', 'Spiral Sat.', 'Spiral Val.', 'Cycle All', 'Cycle Left/Right', 'Cycle Up/Down', 'Rainbow Moving Chevron', 'Cycle Out/In', 'Cycle Out/In Dual', 'Cycle Pinwheel', 'Cycle Spiral', 'Dual Beacon', 'Rainbow Beacon', 'Rainbow Pinwheels', 'Raindrops', 'Jellybean Raindrops', 'Hue Breathing', 'Hue Pendulum', 'Hue Wave', 'Pixel Rain', 'Pixel Flow', 'Pixel Fractal', 'Typing Heatmap', 'Digital Rain', 'Solid Reactive Simple', 'Solid Reactive', 'Solid Reactive Wide', 'Solid Reactive Multi Wide', 'Solid Reactive Cross', 'Solid Reactive Multi Cross', 'Solid Reactive Nexus', 'Solid Reactive Multi Nexus', 'Splash', 'Multi Splash', 'Solid Splash', 'Solid Multi Splash'];
  const LED_DEFAULT = { effect: 1, brightness: 200, speed: 128, hue: 128, sat: 255 };
  // HSV (hue/sat 0-255, value fixed full) <-> #rrggbb — matches DK-Suite's conversion so the picker agrees with the ring.
  function hsvToHex(hue255, sat255) {
    const h = ((hue255 || 0) / 255) * 360, s = (sat255 || 0) / 255, v = 1;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    const hx = n => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return '#' + hx(r) + hx(g) + hx(b);
  }
  function hexToHsv(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); if (!m) return { hue: 0, sat: 0 };
    const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return { hue: Math.round((h / 360) * 255), sat: Math.round((mx ? d / mx : 0) * 255) };
  }
  const appIconCache = {};   // app value -> dataURL | false (failed) | null (in-flight)
  const urlIconPreview = {}; // iconCache path -> dataURL of a just-fetched URL icon (editor preview only; dodges file:// browser-cache staleness on Refresh)
  const TYPES = [['', 'Empty'], ['app', 'App / Program'], ['url', 'Website (URL)'], ['page', 'Go to open-quake page'], ['cmd', 'Shell command'], ['open', 'Open file/folder'], ['system', 'System (lock/config)'], ['counter', 'Counter'], ['paste_text', 'Paste Text'], ['key', 'Send keystroke'], ['macro', 'Macro / Steps'], ['ha', 'HA entity']];
  // Curated per-domain service catalog for HA entity tiles. Lookup falls back to HA_SERVICES_DEFAULT
  // for any domain we don't have a more specific list for. First entry is the default service when
  // the user picks an entity of that domain.
  const HA_SERVICES_BY_DOMAIN = {
    light:         [['toggle', 'Toggle'], ['turn_on', 'Turn on'], ['turn_off', 'Turn off']],
    switch:        [['toggle', 'Toggle'], ['turn_on', 'Turn on'], ['turn_off', 'Turn off']],
    input_boolean: [['toggle', 'Toggle'], ['turn_on', 'Turn on'], ['turn_off', 'Turn off']],
    fan:           [['toggle', 'Toggle'], ['turn_on', 'Turn on'], ['turn_off', 'Turn off']],
    media_player:  [['media_play_pause', 'Play / Pause'], ['media_play', 'Play'], ['media_pause', 'Pause'], ['media_stop', 'Stop'], ['media_next_track', 'Next'], ['media_previous_track', 'Previous'], ['volume_up', 'Volume up'], ['volume_down', 'Volume down'], ['volume_mute', 'Mute']],
    scene:         [['turn_on', 'Activate']],
    script:        [['turn_on', 'Run']],
    automation:    [['trigger', 'Trigger'], ['toggle', 'Toggle'], ['turn_on', 'Enable'], ['turn_off', 'Disable']],
    cover:         [['toggle', 'Toggle'], ['open_cover', 'Open'], ['close_cover', 'Close'], ['stop_cover', 'Stop']],
    lock:          [['lock', 'Lock'], ['unlock', 'Unlock']],
    vacuum:        [['start', 'Start'], ['stop', 'Stop'], ['return_to_base', 'Dock'], ['pause', 'Pause']],
    climate:       [['turn_on', 'Turn on'], ['turn_off', 'Turn off']],
    input_button:  [['press', 'Press']],
  };
  const HA_SERVICES_DEFAULT = [['toggle', 'Toggle'], ['turn_on', 'Turn on'], ['turn_off', 'Turn off']];
  // Step kinds inside a Macro tile (value semantics mirror the matching tile types).
  const STEP_KINDS = [['key', 'Keystroke'], ['text', 'Type text'], ['delay', 'Delay (ms)'], ['app', 'App / Program'], ['open', 'Open file/folder'], ['url', 'Website (URL)'], ['cmd', 'Shell command'], ['page', 'Go to page'], ['system', 'System'], ['ahk', 'AutoHotkey']];
  // Knob behavior options (per page-type, with per-page override). Defaults: turn=Scroll pages, click=Start/stop rotation.
  const KNOB_TURN_OPTS = [['pages', 'Scroll pages'], ['volume', 'System volume'], ['scroll', 'Scroll in window'], ['select', 'Select button']];
  const KNOB_CLICK_OPTS = [
    ['rotation', 'Toggle rotation'],
    ['rotation_start', 'Start rotation'],
    ['rotation_stop', 'Stop rotation'],
    ['mute', 'System audio toggle'],
    ['enter', 'Enter'],
    ['home', 'Go to home page'],
  ];
  // Double-click has the same options as single-click, plus "Page selector" (default) which
  // preserves the historical "double-click opens page selector" behavior.
  const KNOB_DBLCLICK_OPTS = [['selector', 'Page selector']].concat(KNOB_CLICK_OPTS);
  const knobSelHtml = (id, opts, val, extraStyle) => `<select id="${id}"${extraStyle ? ' style="' + extraStyle + '"' : ''}>${opts.map(o => `<option value="${o[0]}" ${o[0] === val ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  function knobOf(type, field) {
    const k = ((config.settings || {}).knob || {})[type] || {};
    if (k[field]) return k[field];
    if (field === 'turn') return 'pages';
    if (field === 'dblclick') return 'selector';
    return 'rotation';
  }
  const uid = () => 'g' + Math.random().toString(36).slice(2, 8);
  // curGrid returns the page being edited (view='pages') OR the group being edited (view='groups').
  // Pages and groups both have {id, name, cols, rows, tiles[]}, so all the existing tile editor
  // machinery (renderTiles, renderForm, mergeAt, flattenAt, ensureTiles, …) works on either.
  const curGrid = () => view === 'groups' ? ((config.groups || [])[groupIndex] || null) : config.grids[gi];
  const curGroup = () => (config.groups || [])[groupIndex] || null;
  // Anchor a grid group's tiles into a page's cols×rows, top-left. Mirror of main.js anchorGroupTiles
  // so the editor's read-only preview matches what the panel will draw. Crops cells past page bounds;
  // drops merged tiles whose span doesn't fit (rather than emitting dangling cover cells).
  function anchorGroupTiles(group, pageCols, pageRows) {
    const gCols = +(group && group.cols) || 0;
    const gRows = +(group && group.rows) || 0;
    const pc = +pageCols || 0, pr = +pageRows || 0;
    if (!gCols || !gRows || !pc || !pr) return [];
    const out = new Array(pc * pr);
    for (let i = 0; i < out.length; i++) out[i] = blankTile();
    const src = (group && Array.isArray(group.tiles)) ? group.tiles : [];
    for (let r = 0; r < gRows; r++) {
      for (let c = 0; c < gCols; c++) {
        if (r >= pr || c >= pc) continue;
        const t = src[r * gCols + c];
        if (!t || t.cover != null) continue;
        const w = +t.w || 1, h = +t.h || 1;
        if (c + w > pc || r + h > pr) continue;
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
  // Find a group by id (or null). Helper for "Use grid group" lookups.
  function groupById(id) { return (config.groups || []).find(g => g && g.id === id) || null; }
  // The "Use grid group" row injected into a page's editor (grid pages, dashboards w/ gridOn,
  // app pages w/ gridOn). Mutually exclusive UI: when the box is on + a group is selected, the
  // page renders the group's tiles instead of its own. Schedule is a disabled placeholder for
  // phase 2 (data only).
  function groupSelectRowHtml(g) {
    const list = config.groups || [];
    const cur = g.groupId || '';
    const missing = !!cur && !list.some(x => x.id === cur);
    return `<div class="row" style="gap:8px; flex-wrap:wrap">
      <label style="width:auto">Group</label>
      <label class="iconopt" style="width:auto"><input type="checkbox" id="gUseGroup" ${(g.useGroup && !missing) ? 'checked' : ''}> Use grid group</label>
      <select id="gGroupId" style="flex:1; min-width:140px">
        <option value="">— pick a group —</option>
        ${list.map(x => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name || '(unnamed)')}</option>`).join('')}
        ${missing ? `<option value="${esc(cur)}" selected>(missing — pick another)</option>` : ''}
      </select>
      <label class="iconopt" style="width:auto; opacity:0.55" title="Schedule support is coming in the next phase."><input type="checkbox" id="gUseSchedule" ${g.useSchedule ? 'checked' : ''} disabled> Use schedule</label>
    </div>`;
  }
  function wireGroupSelectRow(g) {
    const useBox = document.getElementById('gUseGroup');
    const sel = document.getElementById('gGroupId');
    if (useBox) useBox.onchange = e => { g.useGroup = e.target.checked; markDirty(); render(); };
    // Picking a group auto-enables the checkbox so the change is visible immediately. Clearing the
    // selection (empty option) also auto-disables; the user can re-tick once they pick again.
    if (sel) sel.onchange = e => {
      g.groupId = e.target.value || '';
      if (g.groupId && !g.useGroup) g.useGroup = true;
      if (!g.groupId) g.useGroup = false;
      markDirty(); render();
    };
  }
  const esc = s => (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // A masked credential field: a password input + an eyeball to reveal it. attrs = extra input HTML
  // (id / class / data-* / placeholder); wrapStyle = optional style on the wrapper (e.g. a flex weight).
  // RULE: every password / API key / token / secret in the editor goes through this — shown as ••••
  // with an opt-in reveal, never plain text. (See secretInput note in apps.json: option type "secret".)
  function secretInput(value, attrs, wrapStyle) {
    return `<span class="secretwrap"${wrapStyle ? ` style="${wrapStyle}"` : ''}>`
      + `<input type="password" value="${esc(value)}" ${attrs || ''}>`
      + `<button type="button" class="reveal" tabindex="-1" title="Show / hide">👁</button></span>`;
  }
  // One-time delegated handler: an eyeball click toggles its field between hidden (••••) and visible.
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.reveal'); if (!b) return;
    const inp = b.parentElement && b.parentElement.querySelector('input'); if (!inp) return;
    const show = inp.type === 'password'; inp.type = show ? 'text' : 'password';
    b.textContent = show ? '🙈' : '👁';
  });
  const fileUrl = p => configApi.pathToFileURL(p);
  const imgUrl = p => configApi.imageToDataUrl(p) || configApi.pathToFileURL(p);   // data: URL like the panel; file:// fallback
  const urlSrc = t => urlIconPreview[t.iconCache] || imgUrl(t.iconCache);   // URL-icon source: fresh-fetch preview, else the cached file as a data: URL (matches the panel)
  const baseName = p => p.split(/[\\/]/).pop().replace(/\.(exe|lnk|bat|cmd|com)$/i, '');
  const iconTypeOf = t => t.iconType || 'emoji';

  // ---- HA icon resolution (phase 2 quick win) ----
  // When the user picks "HA icon" for an HA entity tile, we resolve to:
  //   1. The entity_picture (album art / snapshot / uploaded photo) -- fetched + cached via
  //      ensureHaEntityPicture, then rendered like a URL icon. Stored in t.iconCache/iconUrl.
  //   2. An emoji mapped from the entity's mdi:* icon (from state attrs OR entity_registry).
  //   3. An emoji mapped from the domain.
  //   4. A generic placeholder.
  // Actual mdi-as-SVG rendering is later phase 2 work; this gets visual icons today with no CDN.
  // Patterns match either exact ("mdi:lock") or the same followed by a hyphen ("mdi:lock-pattern"),
  // so "mdi:lockable" never falsely matches "mdi:lock". Order matters: more specific first.
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
  function mdiToEmoji(name) {
    if (typeof name !== 'string' || !name) return null;
    const low = name.toLowerCase();
    for (const [pat, em] of HA_MDI_EMOJI) if (low === pat || low.startsWith(pat + '-')) return em;
    return null;
  }
  function haDomainEmoji(domain) { return HA_DOMAIN_EMOJI[domain] || '🏠'; }

  // HA's frontend domain-default MDI icons (mirror of FIXED_DOMAIN_ICONS in
  // home-assistant/frontend/src/common/const.ts). Used when an entity has no explicit override
  // -- picks the same glyph HA's UI would draw. Same table as main.js.
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
  function bareMdi(name) {
    if (typeof name !== 'string') return null;
    const m = /^mdi:([a-z0-9-]+)$/i.exec(name.trim());
    return m ? m[1].toLowerCase() : null;
  }
  // Pick the MDI icon name an HA entity tile should render with:
  //   1. Live state.attributes.icon (e.g. a light that swaps icon based on its state).
  //   2. entity_registry override.
  //   3. HA's domain default.
  function haEntityMdiName(t) {
    if (!t || !t.value) return null;
    const state = haStateCache[t.value];
    if (typeof state === 'object' && state && state.attributes) {
      const b = bareMdi(state.attributes.icon);
      if (b) return b;
    }
    if (haCacheLocal && Array.isArray(haCacheLocal.entityRegistry)) {
      const reg = haCacheLocal.entityRegistry.find(r => r.entity_id === t.value);
      const b = bareMdi(reg && reg.icon);
      if (b) return b;
    }
    return HA_DOMAIN_DEFAULT_MDI[(t.value || '').split('.')[0] || ''] || null;
  }
  // Per-renderer cache of MDI fetch results so iconHtml doesn't kick a fetch for every render.
  // Keyed by bare MDI name. Values: a Promise-shaped record { ok, cachePath } (resolved) or null
  // (in-flight). On resolve, render() is called so iconHtml picks up the cached path.
  const mdiCache = {};
  function ensureMdi(name) {
    if (!name || Object.prototype.hasOwnProperty.call(mdiCache, name)) return;
    mdiCache[name] = null;
    configApi.fetchMdiIcon(name).then(r => {
      mdiCache[name] = (r && r.ok) ? r : false;
      render();
    }).catch(() => { mdiCache[name] = false; render(); });
  }

  // Local mirrors of main's haCache + per-entity states. Loaded on init, refreshed when the user
  // clicks Refresh in the Auth tab. iconHtml needs synchronous access, so we keep these here.
  let haCacheLocal = null;
  const haStateCache = {};   // entityId -> state | null (in-flight) | false (failed/none)
  async function ensureHaState(entityId) {
    if (!entityId || Object.prototype.hasOwnProperty.call(haStateCache, entityId)) return;
    haStateCache[entityId] = null;                       // mark in-flight to prevent duplicate fetches
    try {
      const s = await configApi.fetchHaEntityState(entityId);
      haStateCache[entityId] = (s && !s.error) ? s : false;
    } catch (e) { haStateCache[entityId] = false; }
    render();
  }
  // Download an entity's picture into the URL-icon cache and stamp the tile so iconHtml renders it.
  // Idempotent: skips when the cached URL already matches what we'd compute. Refetches when entity
  // changes (the URL differs, so the iconCache check misses and we re-fetch).
  async function ensureHaEntityPicture(t) {
    if (!t || t.iconType !== 'ha' || !t.value) return;
    const state = haStateCache[t.value];
    if (typeof state !== 'object' || !state || !state.attributes) return;
    const pic = state.attributes.entity_picture;
    if (typeof pic !== 'string' || !pic) return;
    const ha = ((config.settings || {}).haAuth) || {};
    const fullUrl = /^https?:\/\//i.test(pic) ? pic : (ha.url || '').replace(/\/+$/, '') + (pic.startsWith('/') ? pic : '/' + pic);
    if (!/^https?:\/\//i.test(fullUrl)) return;
    if (t.iconUrl === fullUrl && t.iconCache) return;   // already cached this exact URL
    try {
      const r = await configApi.fetchIconUrl(fullUrl);
      if (r && r.ok) { t.iconUrl = fullUrl; t.iconCache = r.cachePath; markDirty(); renderTiles(); renderIconPreview(t); }
    } catch (e) {}
  }
  function haResolveEmoji(t) {
    // Look at state first (mdi may differ from registry override at runtime)
    const state = haStateCache[t.value];
    if (typeof state === 'object' && state && state.attributes && typeof state.attributes.icon === 'string') {
      const em = mdiToEmoji(state.attributes.icon);
      if (em) return em;
    }
    if (haCacheLocal && Array.isArray(haCacheLocal.entityRegistry)) {
      const reg = haCacheLocal.entityRegistry.find(r => r.entity_id === t.value);
      if (reg && reg.icon) { const em = mdiToEmoji(reg.icon); if (em) return em; }
    }
    return haDomainEmoji((t.value || '').split('.')[0] || '');
  }

  // ---- screen-rotation per-page opt-in ----
  function rotCatOn(g) { const c = (config.settings && config.settings.rotation && config.settings.rotation.cats) || {}; return !!c[g.kind === 'web' ? 'dashboards' : g.kind === 'app' ? 'apps' : 'grids']; }
  function rotRowHtml(g) {
    if (!rotCatOn(g)) return '';
    return `<div class="row" style="margin-top:6px"><label style="width:auto">Rotation</label>
      <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gRot" ${g.rotate ? 'checked' : ''}> Include in rotation</label></div>`;
  }
  function wireRotRow(g) { const el = document.getElementById('gRot'); if (el) el.onchange = e => { g.rotate = e.target.checked; markDirty(); }; }

  // ---- per-page global shortcut ----
  function shortcutRowHtml(g) {
    return `<div class="row" style="margin-top:6px"><label style="width:auto">Hotkey shortcut</label>
      <input id="gShortcut" readonly placeholder="click, then press keys" value="${esc(g.shortcut || '')}" style="width:200px">
      <button id="gShortcutClear" style="margin-left:8px">Clear</button>
      <label style="width:auto;margin-left:14px;font-weight:normal;cursor:pointer"><input type="checkbox" id="gShortcutNoRot" ${g.shortcutStopsRotation ? 'checked' : ''}> Disables rotation</label></div>
      <p class="hint">Global hotkey that jumps the panel to this page from anywhere. Click the box and press a combo that includes a modifier (e.g. Ctrl+Alt+1). If another app already owns that combo, it just won't fire. <b>Disables rotation</b> turns auto-rotation off when the hotkey fires, so the panel stays on this page until you start rotation again (knob, tray, or panel).</p>`;
  }
  function wireShortcutRow(g) {
    const inp = document.getElementById('gShortcut'); if (!inp) return;
    inp.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { g.shortcut = acc; inp.value = acc; renderGrids(); markDirty(); } };
    const clr = document.getElementById('gShortcutClear');
    if (clr) clr.onclick = () => { delete g.shortcut; inp.value = ''; renderGrids(); markDirty(); };
    const nr = document.getElementById('gShortcutNoRot');
    if (nr) nr.onchange = e => { if (e.target.checked) g.shortcutStopsRotation = true; else delete g.shortcutStopsRotation; markDirty(); };
  }
  // Build an Electron accelerator from a keydown. Global bindings require a modifier;
  // focused-app actions may also use bare keys such as F5.
  function accelFromEvent(e, allowBare) {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;   // wait for the non-modifier key
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    if (!mods.length && !allowBare) return null;
    const arrow = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
    let key = arrow[e.key] || e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else key = key.charAt(0).toUpperCase() + key.slice(1);
    return mods.concat(key).join('+');
  }

  // ---- per-page Advanced: override the global theme for just this page ----
  // appearance: 'inherit' | 'light' | 'dark'   ·   accent: '' (inherit) | '#rrggbb'
  function advRowHtml(g) {
    const hasApr = g.appearance === 'light' || g.appearance === 'dark';
    const hasAcc = /^#[0-9a-fA-F]{6}$/.test(g.accent || '');
    const isHome = config.homePageId === g.id;
    return `<details class="advsec" style="margin-top:12px"${(hasApr || hasAcc || isHome) ? ' open' : ''}>
      <summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Advanced settings</summary>
      <div class="row" style="margin-top:8px"><label style="width:auto">Home page</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="gHome" ${isHome ? 'checked' : ''}> Set as home page</label></div>
      <p class="hint">When set, the knob's <b>Go to home page</b> action (Settings → Hardware) jumps here. Only one page can be the home page at a time.</p>
      <div class="row" style="margin-top:8px"><label style="width:auto">Hidden</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="gHidden" ${g.hidden ? 'checked' : ''}> Hide from page menu &amp; rotation</label></div>
      <p class="hint">Skips this page in the double-tap page menu, knob-turn cycling, and auto-rotation — without deleting it. Still reachable via its keyboard shortcut, if it has one. Handy for a page you want to park (e.g. a media dashboard) and bring back later.</p>
      <div class="row" style="margin-top:8px"><label style="width:auto">Appearance</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="gAprOn" ${hasApr ? 'checked' : ''}> Override</label>
        <select id="gApr" style="width:130px;margin-left:8px" ${hasApr ? '' : 'disabled'}>
          <option value="dark" ${g.appearance === 'dark' ? 'selected' : ''}>Dark</option>
          <option value="light" ${g.appearance === 'light' ? 'selected' : ''}>Light</option>
        </select></div>
      <div class="row"><label style="width:auto">Accent</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="gAccOn" ${hasAcc ? 'checked' : ''}> Override</label>
        <input type="color" id="gAcc" value="${hasAcc ? esc(g.accent) : '#7CFFB2'}" style="width:48px;height:28px;padding:2px;margin-left:8px" ${hasAcc ? '' : 'disabled'}></div>
      <p class="hint">When checked, this page overrides the global theme. (Web dashboards follow the global light/dark only.)</p>
      <div class="row" style="margin-top:8px"><label style="width:auto">Knob</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="gKnobOn" ${g.knobOverride ? 'checked' : ''}> Override</label></div>
      ${g.knobOverride ? `<div class="row"><label style="width:auto">Turn / Click / Dbl</label>${knobSelHtml('gKnobTurn', KNOB_TURN_OPTS, (g.knob && g.knob.turn) || 'pages')} ${knobSelHtml('gKnobClick', KNOB_CLICK_OPTS, (g.knob && g.knob.click) || 'rotation')} ${knobSelHtml('gKnobDblclick', KNOB_DBLCLICK_OPTS, (g.knob && g.knob.dblclick) || 'selector')}</div>` : ''}
      ${focusRowHtml(g)}
      ${advCloneHtml(g)}
    </details>`;
  }
  // ---- per-page Advanced: Desktop focus trigger app(s) ----
  function focusChipsHtml(g) {
    const apps = Array.isArray(g.focusApps) ? g.focusApps : [];
    if (!apps.length) return `<span class="hint" style="margin:0">No apps mapped — this page won't auto-select.</span>`;
    return apps.map((a, i) => `<span class="chip">${esc(a)}<button type="button" data-rm="${i}" title="Remove">✕</button></span>`).join('');
  }
  function focusRowHtml(g) {
    return `<div class="row" style="margin-top:10px; align-items:flex-start"><label style="width:auto">Focus trigger app(s)</label>
        <div style="flex:1; min-width:0">
          <div id="gFocusChips" class="chips">${focusChipsHtml(g)}</div>
          <div class="row" style="margin:6px 0 0">
            <input id="gFocusInput" placeholder="process name, e.g. spotify" style="flex:1">
            <button id="gFocusAdd" type="button">Add</button>
          </div>
          <select id="gFocusPicker" style="margin-top:6px"><option value="">Browse running apps…</option></select>
        </div></div>
      <p class="hint">When <b>Desktop focus</b> is on (Settings → Software), the panel switches to this page whenever one of these apps becomes the focused window on the PC. Matched by process name, not window title.</p>`;
  }
  // ---- Keyboard Shortcuts app: global Custom cheat-sheet (customShortcuts) ----
  // Edited right on the app's own page-config screen (App tab, like World Clock's city picks),
  // but the data itself is a single shared list across every page that has this app — NOT a
  // per-page g.options value — see docs/charter-keyshortcuts.md. Rendering always shows at least
  // one (possibly blank) row; a blank row isn't written to config until the user types into it.
  function shortcutRowsHtml(list) {
    const rows = Array.isArray(list) && list.length ? list : [{ shortcut: '', description: '' }];
    return rows.map((r, i) => `<div class="row" data-idx="${i}" style="margin-top:6px">
        <input class="scShortcut" placeholder="e.g. Ctrl+Shift+E" value="${esc(r.shortcut || '')}" style="width:180px">
        <input class="scDesc" placeholder="what it does" value="${esc(r.description || '')}" style="flex:1;margin-left:8px">
        <button class="scRemove" type="button" data-rm="${i}" title="Remove" style="margin-left:8px">✕</button>
      </div>`).join('');
  }
  function wireShortcutRows() {
    const host = document.getElementById('sShortcutRows');
    if (!host) return;
    const list = () => { if (!config.settings) config.settings = {}; if (!Array.isArray(config.settings.customShortcuts)) config.settings.customShortcuts = []; return config.settings.customShortcuts; };
    const redraw = () => { host.innerHTML = shortcutRowsHtml(list()); wireRows(); };
    function wireRows() {
      host.querySelectorAll('.scShortcut').forEach((inp, i) => {
        inp.oninput = e => { const l = list(); if (!l[i]) l[i] = { shortcut: '', description: '' }; l[i].shortcut = e.target.value; markDirty(); };
      });
      host.querySelectorAll('.scDesc').forEach((inp, i) => {
        inp.oninput = e => { const l = list(); if (!l[i]) l[i] = { shortcut: '', description: '' }; l[i].description = e.target.value; markDirty(); };
      });
      host.querySelectorAll('.scRemove').forEach(btn => {
        btn.onclick = () => { list().splice(parseInt(btn.getAttribute('data-rm'), 10), 1); markDirty(); redraw(); };
      });
    }
    wireRows();
    const addBtn = document.getElementById('sShortcutAdd');
    if (addBtn) addBtn.onclick = () => {
      list().push({ shortcut: '', description: '' });
      markDirty(); redraw();
      const inputs = host.querySelectorAll('.scShortcut');
      if (inputs.length) inputs[inputs.length - 1].focus();
    };
  }
  function officeOptionDefault(def, key) {
    const option = (def.options || []).find(item => item.key === key);
    return option ? option.default : '';
  }
  const OFFICE_SHORTCUT_DEFAULTS = {
    teams: [['Mute', 'Ctrl+Shift+M', '🎙️'], ['Camera', 'Ctrl+Shift+O', '📹'], ['Accept audio', 'Ctrl+Shift+S', '📞'], ['Hang up', 'Ctrl+Shift+H', '📴']],
    outlook: [['New message', 'Ctrl+N', '✉️'], ['Reply', 'Ctrl+R', '↩️'], ['Forward', 'Ctrl+F', '↪️'], ['Send', 'Alt+S', '🚀']],
    word: [['New document', 'Ctrl+N', '📄'], ['Save', 'Ctrl+S', '💾'], ['Find', 'Ctrl+F', '🔍'], ['Undo', 'Ctrl+Z', '↶']],
    excel: [['New workbook', 'Ctrl+N', '📊'], ['Save', 'Ctrl+S', '💾'], ['Find', 'Ctrl+F', '🔍'], ['Undo', 'Ctrl+Z', '↶']],
    powerpoint: [['New presentation', 'Ctrl+N', '🖥️'], ['Save', 'Ctrl+S', '💾'], ['New slide', 'Ctrl+M', '➕'], ['Start slideshow', 'F5', '▶️']],
    onenote: [['New page', 'Ctrl+N', '📝'], ['Search', 'Ctrl+E', '🔍'], ['To-do tag', 'Ctrl+1', '☑️'], ['Undo', 'Ctrl+Z', '↶']],
    onedrive: [['New folder', 'Ctrl+Shift+N', '📁'], ['Copy', 'Ctrl+C', '📋'], ['Paste', 'Ctrl+V', '📥'], ['Refresh', 'F5', '↻']],
    office: [['New', 'Ctrl+N', '✨'], ['Save', 'Ctrl+S', '💾'], ['Find', 'Ctrl+F', '🔍'], ['Undo', 'Ctrl+Z', '↶']],
  };
  function officeShortcutDefault(appId, shortcutIndex, suffix) {
    if (suffix === 'IconImage') return '';
    const set = OFFICE_SHORTCUT_DEFAULTS[appId] || OFFICE_SHORTCUT_DEFAULTS.office;
    const fallback = [`Shortcut ${shortcutIndex}`, '', '⌨'];
    return (set[shortcutIndex - 1] || fallback)[suffix === 'Label' ? 0 : suffix === 'Keys' ? 1 : 2];
  }
  function officeChoiceHtml(def, key, value) {
    const option = (def.options || []).find(item => item.key === key);
    return ((option && option.choices) || []).map(choice => {
      const val = Array.isArray(choice) ? choice[0] : choice;
      const label = Array.isArray(choice) ? choice[1] : choice;
      return `<option value="${esc(val)}" ${String(value) === String(val) ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }
  function officeOptionsHtml(g, def) {
    if (!g.options) g.options = {};
    const value = key => (key in g.options) ? g.options[key] : officeOptionDefault(def, key);
    const shortcutValue = (appIndex, shortcutIndex, suffix) => {
      const key = `app${appIndex}Shortcut${shortcutIndex}${suffix}`;
      return (key in g.options) ? g.options[key] : officeShortcutDefault(value('app' + appIndex), shortcutIndex, suffix);
    };
    const appRows = [1, 2, 3, 4].map(index => {
      const desktopOnly = value('mode' + index) === 'desktop';
      const shortcutCount = Math.max(4, Math.min(8, Number(value('app' + index + 'ShortcutCount')) || 4));
      const shortcuts = Array.from({ length: shortcutCount }, (_, shortcutOffset) => shortcutOffset + 1).map(shortcutIndex => {
        const imagePath = shortcutValue(index, shortcutIndex, 'IconImage');
        const imageSrc = imagePath ? imgUrl(imagePath) : '';
        return `<div class="officeShortcutRow">
          <div class="officeShortcutIconGroup">
            <input class="officeShortcutIcon" data-app-index="${index}" data-shortcut-index="${shortcutIndex}" list="officeShortcutIcons" value="${esc(shortcutValue(index, shortcutIndex, 'Icon'))}" maxlength="8" aria-label="Shortcut ${shortcutIndex} emoji" title="Emoji fallback when no image is selected">
            <button class="officeShortcutImage" data-app-index="${index}" data-shortcut-index="${shortcutIndex}" type="button" title="Choose a PNG, JPG, GIF, WebP, BMP, ICO, or SVG">${imageSrc ? `<img src="${esc(imageSrc)}" alt="Shortcut ${shortcutIndex} image preview">` : 'Image…'}</button>
            <button class="officeShortcutImageClear" data-app-index="${index}" data-shortcut-index="${shortcutIndex}" type="button" title="Remove shortcut image" aria-label="Remove shortcut ${shortcutIndex} image" style="visibility:${imagePath ? 'visible' : 'hidden'}">×</button>
          </div>
          <input class="officeShortcutLabel" data-app-index="${index}" data-shortcut-index="${shortcutIndex}" value="${esc(shortcutValue(index, shortcutIndex, 'Label'))}" placeholder="Button label">
          <input class="officeShortcutKeys" data-app-index="${index}" data-shortcut-index="${shortcutIndex}" readonly value="${esc(shortcutValue(index, shortcutIndex, 'Keys'))}" placeholder="Click, then press keys">
          <button class="officeShortcutClear" data-app-index="${index}" data-shortcut-index="${shortcutIndex}" type="button">Clear keys</button>
        </div>`;
      }).join('');
      return `<fieldset style="border:1px solid #2a3a4e;border-radius:8px;padding:8px 12px;margin:8px 0">
        <legend style="padding:0 6px;color:#9fb3c8;font-size:13px">Header app ${index}</legend>
        <div class="row"><label>Application</label><select class="officeApp" data-index="${index}">${officeChoiceHtml(def, 'app' + index, value('app' + index))}</select></div>
        <div class="row"><label>Open with</label><select class="officeMode" data-index="${index}">${officeChoiceHtml(def, 'mode' + index, value('mode' + index))}</select></div>
        ${desktopOnly ? `<div class="row"><label>When already open</label><select class="officeDesktopSwitch" data-index="${index}">${officeChoiceHtml(def, 'desktopSwitch' + index, value('desktopSwitch' + index))}</select></div>
        <p class="hint" style="margin:4px 0 8px"><b>Keep Office panel visible</b> means tapping this header app will not focus or relaunch it when it already has an open window; it only changes the shortcut buttons below. If the app is closed, it still launches. Tapping a shortcut then focuses the app and sends the configured keys.</p>` : ''}
        <div class="row"><label>Shortcuts</label><select class="officeShortcutCount" data-index="${index}">${officeChoiceHtml(def, 'app' + index + 'ShortcutCount', shortcutCount)}</select></div>
        <p class="hint" style="margin:8px 0 4px">Bottom-row shortcuts when this app is selected. Use an emoji, or choose a local image/SVG; the emoji remains the fallback if the image is unavailable.</p>
        <div class="officeShortcutHead"><span>Icon</span><span>Label</span><span>Keys</span><span>Action</span></div>
        ${shortcuts}
      </fieldset>`;
    }).join('');
    return `<div id="officeOptions" style="margin-top:10px">
        <p class="sectitle">Office header applications</p>
        <p class="hint">These four apps appear in the panel header. Selecting one opens it and shows 4–8 equally sized shortcut buttons for that app. Changing an application restores its shortcut defaults. <b>Prefer desktop</b> falls back to the web app when needed.</p>
        ${appRows}
        <datalist id="officeShortcutIcons">
          ${['🎙️','📹','📞','📴','✉️','↩️','↪️','🚀','📄','💾','🔍','↶','📊','🖥️','➕','▶️','📝','☑️','📁','📋','📥','↻','✨','⚡','⭐','🔒','🔔','✅'].map(icon => `<option value="${icon}">`).join('')}
        </datalist>
      </div>`;
  }
  function wireOfficeOptions(g) {
    if (!g.options) g.options = {};
    document.querySelectorAll('.officeApp').forEach(select => {
      select.onchange = event => {
        const appIndex = event.target.dataset.index;
        g.options['app' + appIndex] = event.target.value;
        [1, 2, 3, 4, 5, 6, 7, 8].forEach(shortcutIndex => {
          ['Icon', 'IconImage', 'Label', 'Keys'].forEach(suffix => {
            const key = `app${appIndex}Shortcut${shortcutIndex}${suffix}`;
            const next = officeShortcutDefault(event.target.value, shortcutIndex, suffix);
            g.options[key] = next;
            const input = document.querySelector(`.officeShortcut${suffix}[data-app-index="${appIndex}"][data-shortcut-index="${shortcutIndex}"]`);
            if (input) input.value = next;
          });
        });
        markDirty();
        render();
      };
    });
    document.querySelectorAll('.officeMode').forEach(select => {
      select.onchange = event => {
        g.options['mode' + event.target.dataset.index] = event.target.value;
        markDirty();
        render();
      };
    });
    document.querySelectorAll('.officeDesktopSwitch').forEach(select => {
      select.onchange = event => {
        g.options['desktopSwitch' + event.target.dataset.index] = event.target.value;
        markDirty();
      };
    });
    document.querySelectorAll('.officeShortcutCount').forEach(select => {
      select.onchange = event => {
        g.options['app' + event.target.dataset.index + 'ShortcutCount'] = event.target.value;
        markDirty();
        render();
      };
    });
    document.querySelectorAll('.officeShortcutLabel').forEach(input => {
      input.oninput = event => {
        const target = event.target;
        g.options[`app${target.dataset.appIndex}Shortcut${target.dataset.shortcutIndex}Label`] = target.value;
        markDirty();
      };
    });
    document.querySelectorAll('.officeShortcutIcon').forEach(input => {
      input.oninput = event => {
        const target = event.target;
        g.options[`app${target.dataset.appIndex}Shortcut${target.dataset.shortcutIndex}Icon`] = target.value;
        markDirty();
      };
    });
    document.querySelectorAll('.officeShortcutImage').forEach(button => {
      button.onclick = async event => {
        const target = event.currentTarget;
        const imagePath = await configApi.pickImage();
        if (!imagePath) return;
        g.options[`app${target.dataset.appIndex}Shortcut${target.dataset.shortcutIndex}IconImage`] = imagePath;
        target.innerHTML = `<img src="${esc(imgUrl(imagePath))}" alt="Shortcut ${esc(target.dataset.shortcutIndex)} image preview">`;
        const clear = document.querySelector(`.officeShortcutImageClear[data-app-index="${target.dataset.appIndex}"][data-shortcut-index="${target.dataset.shortcutIndex}"]`);
        if (clear) clear.style.visibility = 'visible';
        markDirty();
      };
    });
    document.querySelectorAll('.officeShortcutImageClear').forEach(button => {
      button.onclick = event => {
        const target = event.currentTarget;
        g.options[`app${target.dataset.appIndex}Shortcut${target.dataset.shortcutIndex}IconImage`] = '';
        const picker = document.querySelector(`.officeShortcutImage[data-app-index="${target.dataset.appIndex}"][data-shortcut-index="${target.dataset.shortcutIndex}"]`);
        if (picker) picker.textContent = 'Image…';
        target.style.visibility = 'hidden';
        markDirty();
      };
    });
    document.querySelectorAll('.officeShortcutKeys').forEach(input => {
      input.onkeydown = event => {
        event.preventDefault();
        const accelerator = accelFromEvent(event, true);
        if (!accelerator) return;
        g.options[`app${event.target.dataset.appIndex}Shortcut${event.target.dataset.shortcutIndex}Keys`] = accelerator;
        event.target.value = accelerator;
        markDirty();
      };
    });
    document.querySelectorAll('.officeShortcutClear').forEach(button => {
      button.onclick = event => {
        const appIndex = event.currentTarget.dataset.appIndex;
        const shortcutIndex = event.currentTarget.dataset.shortcutIndex;
        g.options[`app${appIndex}Shortcut${shortcutIndex}Keys`] = '';
        const input = document.querySelector(`.officeShortcutKeys[data-app-index="${appIndex}"][data-shortcut-index="${shortcutIndex}"]`);
        if (input) input.value = '';
        markDirty();
      };
    });
  }
  function wireFocusRow(g) {
    const chips = document.getElementById('gFocusChips');
    if (!chips) return;
    const redraw = () => { chips.innerHTML = focusChipsHtml(g); };
    chips.addEventListener('click', e => {
      const btn = e.target.closest('button[data-rm]');
      if (!btn || !Array.isArray(g.focusApps)) return;
      g.focusApps.splice(parseInt(btn.getAttribute('data-rm'), 10), 1);
      markDirty(); redraw();
    });
    const addApp = name => {
      const v = String(name || '').trim().replace(/\.exe$/i, '');
      if (!v) return;
      if (!Array.isArray(g.focusApps)) g.focusApps = [];
      if (g.focusApps.some(a => a.toLowerCase() === v.toLowerCase())) return;
      g.focusApps.push(v);
      markDirty(); redraw();
    };
    const input = document.getElementById('gFocusInput'), add = document.getElementById('gFocusAdd');
    if (input && add) {
      add.onclick = () => { addApp(input.value); input.value = ''; input.focus(); };
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add.onclick(); } };
    }
    const picker = document.getElementById('gFocusPicker');
    if (picker) {
      picker.onmousedown = () => {
        if (picker.dataset.loaded) return;
        picker.dataset.loaded = '1';
        window.openQuakeConfig.listRunningApps().then(apps => {
          for (const a of (apps || [])) {
            const opt = document.createElement('option');
            opt.value = a.processName;
            opt.textContent = a.title ? `${a.processName} — ${a.title}` : a.processName;
            picker.appendChild(opt);
          }
        });
      };
      picker.onchange = () => { if (picker.value) addApp(picker.value); picker.value = ''; };
    }
  }
  // Clone-grid control: on an app page that has an embedded grid, copy another page's grid tiles in.
  function advCloneHtml(g) {
    if (!(g.kind === 'app' && hasGrid(g))) return '';
    const srcs = gridSources(g);
    const tagOf = p => p.kind === 'web' ? '🌐' : p.kind === 'app' ? '🧩' : '▦';
    return `<div class="row" style="margin-top:10px"><label style="width:auto">Clone grid</label>
        <select id="gClone" style="width:180px">
          <option value="">${srcs.length ? '— from another page —' : '— no other grids —'}</option>
          ${srcs.map(p => `<option value="${esc(p.id)}">${tagOf(p)} ${esc(p.name || '(unnamed)')}</option>`).join('')}
        </select>
        <button id="gCloneBtn" style="margin-left:8px" disabled>Clone</button></div>
      <p class="hint">Copies another page's grid tiles into this one, fit to this grid's size. Replaces the current tiles.</p>`;
  }
  function wireAdvRow(g) {
    const aprOn = document.getElementById('gAprOn'), apr = document.getElementById('gApr');
    if (aprOn && apr) {
      aprOn.onchange = e => { g.appearance = e.target.checked ? apr.value : 'inherit'; apr.disabled = !e.target.checked; markDirty(); };
      apr.onchange = e => { if (aprOn.checked) { g.appearance = e.target.value; markDirty(); } };
    }
    const accOn = document.getElementById('gAccOn'), acc = document.getElementById('gAcc');
    if (accOn && acc) {
      accOn.onchange = e => { if (e.target.checked) g.accent = acc.value; else delete g.accent; acc.disabled = !e.target.checked; markDirty(); };
      acc.oninput = e => { if (accOn.checked) { g.accent = e.target.value; markDirty(); } };
    }
    const gh = document.getElementById('gHome');
    if (gh) gh.onchange = e => {
      if (e.target.checked) {
        const cur = config.homePageId;
        if (cur && cur !== g.id) {
          const other = config.grids.find(x => x.id === cur);
          const name = (other && other.name) || cur;
          if (!window.confirm(name + ' is currently set as home page, switch to this one?')) {
            e.target.checked = false;
            return;
          }
        }
        config.homePageId = g.id;
      } else {
        if (config.homePageId === g.id) delete config.homePageId;
      }
      markDirty();
    };
    const ghide = document.getElementById('gHidden');
    if (ghide) ghide.onchange = e => {
      if (e.target.checked && config.homePageId === g.id) {
        window.alert('This page is set as the home page and can\'t be hidden. Pick a new home page first, then hide this one.');
        e.target.checked = false;
        return;
      }
      g.hidden = e.target.checked;
      markDirty();
      renderGrids();
    };
    const kOn = document.getElementById('gKnobOn');
    if (kOn) kOn.onchange = e => { g.knobOverride = e.target.checked; if (g.knobOverride && !g.knob) g.knob = { turn: 'pages', click: 'rotation', dblclick: 'selector' }; markDirty(); render(); };
    const kT = document.getElementById('gKnobTurn'); if (kT) kT.onchange = e => { if (!g.knob) g.knob = {}; g.knob.turn = e.target.value; markDirty(); };
    const kC = document.getElementById('gKnobClick'); if (kC) kC.onchange = e => { if (!g.knob) g.knob = {}; g.knob.click = e.target.value; markDirty(); };
    const kD = document.getElementById('gKnobDblclick'); if (kD) kD.onchange = e => { if (!g.knob) g.knob = {}; g.knob.dblclick = e.target.value; markDirty(); };
    const clone = document.getElementById('gClone'), cloneBtn = document.getElementById('gCloneBtn');
    if (clone && cloneBtn) {
      clone.onchange = () => { cloneBtn.disabled = !clone.value; };
      cloneBtn.onclick = () => {
        const src = config.grids.find(p => p.id === clone.value); if (!src) return;
        const hasContent = (g.tiles || []).some(t => t && t.type);
        if (hasContent && !window.confirm('Replace this grid’s tiles with the ones from “' + (src.name || 'that page') + '”?')) return;
        g.tiles = fitTiles(src.tiles, (g.cols || 1) * (g.rows || 1));
        ti = -1; selEnd = -1; render(); markDirty();
      };
    }
    wireFocusRow(g);
  }

  // ---- save model (no live edit) ----
  function setState(text, cls) { const el = document.getElementById('state'); el.textContent = text; el.className = 'state' + (cls ? ' ' + cls : ''); }
  function markDirty() { dirty = true; setState('● unsaved changes', 'dirty'); document.getElementById('saveBtn').disabled = false; }
  async function doSave() {
    try {
      const result = await configApi.saveConfig(config);
      if (!(result && result.ok)) throw new Error(result && result.error || 'secure persistence failed');
      dirty = false;
      document.getElementById('saveBtn').disabled = true;
      setState('saved ✓', 'saved');
      return true;
    } catch (e) {
      dirty = true;
      document.getElementById('saveBtn').disabled = false;
      setState('save failed: secrets could not be stored securely', 'dirty');
      return false;
    }
  }

  // ---- tiles / icons ----
  function blankTile() { return { label: '', icon: '', type: '', value: '', iconType: 'emoji', iconImage: '', iconUrl: '', iconCache: '' }; }
  function ensureTiles(g) { const need = g.cols * g.rows; while (g.tiles.length < need) g.tiles.push(blankTile()); g.tiles.length = need; }
  // A page carries a tile grid if it has tiles + dimensions: normal grids, app pages with an embedded
  // grid (def.grid), and dashboards with the button grid on.
  function hasGrid(g) { return !!(g && Array.isArray(g.tiles) && +g.cols > 0 && +g.rows > 0); }
  // Other pages whose grid has at least one real tile — the candidates to clone a grid FROM.
  function gridSources(g) { return config.grids.filter(p => p.id !== g.id && hasGrid(p) && (p.tiles || []).some(t => t && t.type)); }
  // Copy a tile list into an n-slot grid: take the first n (deep-copied), pad the rest with blanks.
  function fitTiles(tiles, n) { const out = (tiles || []).slice(0, n).map(t => Object.assign({}, t)); while (out.length < n) out.push(blankTile()); return out; }
  // 2×{1,2,3} button-grid editor bits, shared by dashboards and grid-capable apps so EVERY page exposes the
  // same side + size options. Default is 2×3 (cols 3 × rows 2).
  function enableGrid(g) {
    if (typeof g.cols !== 'number') g.cols = 3;
    if (typeof g.rows !== 'number') g.rows = 2;
    if (!Array.isArray(g.tiles)) g.tiles = [];
    if (!g.gridAlign) g.gridAlign = 'right';
    ensureTiles(g);
  }
  function gridSizeRowHtml(g, hideSide) {
    const cols = g.cols || 3;
    const side = hideSide ? '' : `<label style="width:auto">Side</label><select id="gAlign">
        <option value="right" ${g.gridAlign !== 'left' ? 'selected' : ''}>Right</option>
        <option value="left" ${g.gridAlign === 'left' ? 'selected' : ''}>Left</option></select>
      <label style="width:auto; margin-left:16px">`;
    return `<div class="row">${side}${hideSide ? '<label style="width:auto">' : ''}Size</label><select id="gSize">
        <option value="1" ${cols === 1 ? 'selected' : ''}>2×1</option>
        <option value="2" ${cols === 2 ? 'selected' : ''}>2×2</option>
        <option value="3" ${cols === 3 ? 'selected' : ''}>2×3</option></select></div>`;
  }
  function wireGridSizeRow(g) {
    const al = document.getElementById('gAlign'); if (al) al.onchange = e => { g.gridAlign = e.target.value === 'left' ? 'left' : 'right'; markDirty(); };
    const sz = document.getElementById('gSize'); if (sz) sz.onchange = e => { clearAllMerges(g); g.cols = Math.max(1, Math.min(3, +e.target.value || 3)); g.rows = 2; ensureTiles(g); ti = -1; selEnd = -1; render(); markDirty(); };
  }
  // App-picker visibility (Settings -> Apps). Regular apps default SHOWN (listed in hiddenApps when off);
  // developer apps (apps.json "dev": true) default HIDDEN (listed in shownDevApps when ticked) so releases hide them.
  // devEnabled() is just a UI toggle that reveals the developer list in the editor — it doesn't affect the picker.
  function appHidden(id) { return (((config.settings || {}).hiddenApps) || []).includes(id); }
  function devShown(id) { return (((config.settings || {}).shownDevApps) || []).includes(id); }
  function devEnabled() { return !!((config.settings || {}).devApps); }
  function appVisible(a) {
    if (!a) return false;
    if (a.id === 'ha-dashboard' && !((config.settings || {}).haAuth || {}).useHa) return false;   // hidden until Use HA is on
    return a.dev ? devShown(a.id) : !appHidden(a.id);
  }
  async function refreshApps() {
    try { appDefs = await configApi.getApps(); } catch (e) { appDefs = []; }
    render();
  }

  async function ensureAppIcon(value) {
    if (!value || Object.prototype.hasOwnProperty.call(appIconCache, value)) return;
    appIconCache[value] = null;                 // in-flight, prevents duplicate calls
    appIconCache[value] = (await configApi.getAppIcon(value)) || false;
    render();
  }
  // icon HTML for a tile in a given context: 'cell' (grid preview) or 'prev' (big preview)
  function iconHtml(t, ctx) {
    const type = iconTypeOf(t);
    if (type === 'image' && t.iconImage) return `<img class="${ctx === 'cell' ? 'cimg' : ''}" src="${esc(imgUrl(t.iconImage))}">`;
    if (type === 'url' && t.iconCache) return `<img class="${ctx === 'cell' ? 'cimg' : ''}" src="${esc(urlSrc(t))}">`;
    if (type === 'ha' && t.value) {
      // Trigger lazy state fetch (re-renders on completion) and lazy entity_picture caching.
      if (!Object.prototype.hasOwnProperty.call(haStateCache, t.value)) ensureHaState(t.value);
      if (!t.iconCache) ensureHaEntityPicture(t);
      if (t.iconCache) return `<img class="${ctx === 'cell' ? 'cimg' : ''}" src="${esc(urlSrc(t))}">`;
      // No entity_picture -- resolve the MDI icon name and render the real SVG (recolored white)
      // fetched from jsDelivr. Emoji is only the last-resort fallback if jsDelivr is unreachable.
      const mdi = haEntityMdiName(t);
      if (mdi) {
        const cached = mdiCache[mdi];
        if (cached === undefined) ensureMdi(mdi);
        if (cached && cached.ok && cached.dataUrl) return `<img class="${ctx === 'cell' ? 'cimg' : ''}" src="${esc(cached.dataUrl)}">`;
      }
      const em = haResolveEmoji(t);
      return ctx === 'cell' ? `<div class="ic">${esc(em)}</div>` : `<span class="em">${esc(em)}</span>`;
    }
    if (type === 'app' && t.value) {
      const c = appIconCache[t.value];
      if (c) return `<img class="${ctx === 'cell' ? 'cimg' : ''}" src="${esc(c)}">`;
      ensureAppIcon(t.value);                   // load + re-render; emoji fallback meanwhile
    }
    const em = t.icon || (type === 'app' ? '🚀' : '▫️');
    return ctx === 'cell' ? `<div class="ic">${esc(em)}</div>` : `<span class="em">${esc(em)}</span>`;
  }

  // ---- left grid list ----
  let pageDragFrom = -1;
  function renderGrids() {
    const el = document.getElementById('gridlist'); el.innerHTML = '';
    config.grids.forEach((g, i) => {
      const d = document.createElement('div');
      d.className = 'gridrow' + (i === gi ? ' active' : '');
      const tag = g.kind === 'web' ? '🌐' : g.kind === 'app' ? '🧩' : '▦';
      const left = document.createElement('span'); left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden';
      const grip = document.createElement('span'); grip.className = 'griphandle'; grip.title = 'Drag to reorder'; grip.textContent = '☰';
      const name = document.createElement('span'); name.textContent = `${tag} ${g.name || '(unnamed)'}`; name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' + (g.hidden ? ';opacity:.55;font-style:italic' : '');
      left.appendChild(grip); left.appendChild(name);
      // Top row is name + grip only -- the shortcut badge used to sit in this same row and steal its
      // width, truncating long page names even though the sidebar had room to spare below. It now gets
      // its own row underneath instead of competing for horizontal space.
      const top = document.createElement('span'); top.className = 'gtop'; top.appendChild(left);
      if (g.hidden) { const b = document.createElement('span'); b.className = 'badge'; b.title = 'Hidden from page menu, knob cycling, and rotation'; b.textContent = '🚫👁'; top.appendChild(b); }
      d.appendChild(top);
      if (g.shortcut) { const sub = document.createElement('span'); sub.className = 'gsub badge'; sub.title = 'Hotkey shortcut'; sub.textContent = g.shortcut; d.appendChild(sub); }
      d.onclick = () => { view = 'pages'; gi = i; ti = -1; selEnd = -1; render(); };
      d.draggable = true;
      d.ondragstart = e => { pageDragFrom = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (er) {} };
      d.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; d.classList.add('dragover'); };
      d.ondragleave = () => d.classList.remove('dragover');
      d.ondrop = e => { e.preventDefault(); d.classList.remove('dragover'); movePage(pageDragFrom, i); pageDragFrom = -1; };
      d.ondragend = () => d.classList.remove('dragover');
      el.appendChild(d);
    });
  }
  // Reorder pages by drag — keeps the same page selected (by id) and persists on save. Order drives the
  // knob page-selector and the auto-rotation cycle; the live panel page is unaffected (tracked by id).
  function movePage(from, to) {
    if (from < 0 || to < 0 || from === to || from >= config.grids.length || to >= config.grids.length) return;
    const activeId = (config.grids[gi] || {}).id;
    const [moved] = config.grids.splice(from, 1);
    config.grids.splice(to, 0, moved);
    gi = config.grids.findIndex(x => x.id === activeId); if (gi < 0) gi = 0;
    markDirty(); render();
  }

  // ---- grid meta ----
  function renderMeta() {
    const g = curGrid(); const el = document.getElementById('gridmeta');
    if (!g) { el.innerHTML = '<p class="hint">No grid. Click “+ Add Grid”.</p>'; return; }
    el.innerHTML = `
      <div class="row"><label>Name</label><input id="gName" value="${esc(g.name)}"></div>
      <div class="row"><label>Columns</label><input id="gCols" type="number" min="1" max="12" value="${g.cols}" style="width:90px">
        <label style="width:auto;margin-left:10px">Rows</label><input id="gRows" type="number" min="1" max="6" value="${g.rows}" style="width:90px"></div>
      ${groupSelectRowHtml(g)}
      ${rotRowHtml(g)}
      ${shortcutRowHtml(g)}
      ${advRowHtml(g)}
      <div class="row">
        <button class="danger" id="gDelete">Delete grid</button>
      </div>`;
    document.getElementById('gName').oninput = e => { g.name = e.target.value; renderGrids(); markDirty(); };
    document.getElementById('gCols').onchange = e => { clearAllMerges(g); g.cols = Math.max(1, Math.min(12, +e.target.value || 1)); ensureTiles(g); ti = -1; selEnd = -1; render(); markDirty(); };
    document.getElementById('gRows').onchange = e => { clearAllMerges(g); g.rows = Math.max(1, Math.min(6, +e.target.value || 1)); ensureTiles(g); ti = -1; selEnd = -1; render(); markDirty(); };
    document.getElementById('gDelete').onclick = deleteCurrentPage;
    wireGroupSelectRow(g); wireRotRow(g); wireShortcutRow(g); wireAdvRow(g);
  }

  // ---- tile cells (with merge/span support) ----
  const rc = (g, i) => ({ c: i % g.cols, r: Math.floor(i / g.cols) });
  function selRect(g) {
    if (ti < 0) return null;
    const a = rc(g, ti), b = rc(g, selEnd >= 0 ? selEnd : ti);
    return { c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c), r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r) };
  }
  function renderTiles() {
    const g = curGrid(); const el = document.getElementById('tilegrid');
    if (!g) { el.innerHTML = ''; return; }
    ensureTiles(g);
    const cw = el.clientWidth || el.parentElement && el.parentElement.clientWidth || 600;
    const cell = Math.max(48, Math.min(150, Math.floor((cw - (g.cols - 1) * 6) / g.cols)));   // SQUARE cells, so the editor preview matches the panel's square tiles (capped so big grids don't overflow)
    el.style.gridTemplateColumns = `repeat(${g.cols}, ${cell}px)`;
    el.style.gridTemplateRows = `repeat(${g.rows}, ${cell}px)`;
    el.innerHTML = '';
    const rect = selRect(g);
    g.tiles.forEach((t, i) => {
      if (t && t.cover != null) return;                          // covered by a merged tile
      const { c, r } = rc(g, i), w = (t && t.w) || 1, h = (t && t.h) || 1;
      const empty = !t || !t.type;
      const inSel = selEnd >= 0 && rect && c >= rect.c0 && c <= rect.c1 && r >= rect.r0 && r <= rect.r1;
      const d = document.createElement('div');
      d.className = 'cell' + (i === ti ? ' sel' : '') + (inSel ? ' insel' : '') + (empty ? ' empty' : '') + ((w > 1 || h > 1) ? ' span' : '');
      d.style.gridColumn = `${c + 1} / span ${w}`;
      d.style.gridRow = `${r + 1} / span ${h}`;
      d.innerHTML = empty ? '+' : `${iconHtml(t, 'cell')}<div class="lb">${esc(t.label)}</div>`;
      d.onclick = e => { if (e.shiftKey && ti >= 0) selEnd = i; else { ti = i; selEnd = -1; } render(); };
      d.draggable = true;                                          // drag to rearrange — 1×1 tiles swap, merged blocks move
      d.ondragstart = e => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); };
      d.ondragover = e => { if (dragFrom >= 0 && dragFrom !== i) { e.preventDefault(); d.classList.add('dragover'); } };
      d.ondragleave = () => d.classList.remove('dragover');
      d.ondrop = e => { e.preventDefault(); d.classList.remove('dragover'); handleDrop(g, dragFrom, i); dragFrom = -1; };
      d.ondragend = () => { dragFrom = -1; };
      el.appendChild(d);
    });
    renderMergeBar(g);
  }
  function renderMergeBar(g) {
    const el = document.getElementById('mergebar'); if (!el) return;
    const rect = selRect(g);
    const multi = selEnd >= 0 && rect && (rect.c1 > rect.c0 || rect.r1 > rect.r0);
    const t = ti >= 0 ? g.tiles[ti] : null;
    const merged = t && ((t.w || 1) > 1 || (t.h || 1) > 1);
    el.className = 'mergebar' + ((multi || merged) ? ' active' : '');
    if (multi) {
      el.innerHTML = `<b>${rect.c1 - rect.c0 + 1}×${rect.r1 - rect.r0 + 1} block selected</b><button class="primary" id="mergeBtn">Merge into one button</button><span class="hint">uses the top-left tile’s label / icon / action</span>`;
      document.getElementById('mergeBtn').onclick = () => mergeSelection(g);
    } else if (merged) {
      el.innerHTML = `<b>Merged tile</b><button id="unmergeBtn">Unmerge</button><span class="hint">split back into single cells</span>`;
      document.getElementById('unmergeBtn').onclick = () => unmergeTile(g);
    } else {
      el.innerHTML = `<span class="hint">Tip: click a tile, then <b>Shift-click</b> another to select a block — a Merge button appears here.</span>`;
    }
  }
  function flattenAt(g, idx) {                                    // fully un-merge any merge touching cell idx
    const t = g.tiles[idx]; if (!t) return;
    const owner = (t.cover != null) ? t.cover : idx;
    const o = g.tiles[owner]; if (!o) { g.tiles[idx] = blankTile(); return; }
    const w = o.w || 1, h = o.h || 1;
    if (w > 1 || h > 1) {
      const oc = owner % g.cols, or = Math.floor(owner / g.cols);
      for (let r = or; r < or + h; r++) for (let c = oc; c < oc + w; c++) {
        const ci = r * g.cols + c; if (ci !== owner && g.tiles[ci]) g.tiles[ci] = blankTile();
      }
      o.w = 1; o.h = 1;
    }
  }
  function clearAllMerges(g) { for (let i = 0; i < g.tiles.length; i++) flattenAt(g, i); }
  function mergeSelection(g) {
    const rect = selRect(g); if (!rect) return;
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) flattenAt(g, r * g.cols + c);
    const owner = rect.r0 * g.cols + rect.c0;
    g.tiles[owner].w = rect.c1 - rect.c0 + 1;
    g.tiles[owner].h = rect.r1 - rect.r0 + 1;
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) {
      const idx = r * g.cols + c; if (idx !== owner) g.tiles[idx] = { cover: owner };
    }
    ti = owner; selEnd = -1; render(); markDirty();
  }
  function unmergeTile(g) { flattenAt(g, ti); selEnd = -1; render(); markDirty(); }
  function swapTiles(g, a, b) { const t = g.tiles[a]; g.tiles[a] = g.tiles[b]; g.tiles[b] = t; ti = b; selEnd = -1; render(); markDirty(); }
  function tileFields(t) { return { label: (t && t.label) || '', icon: (t && t.icon) || '', type: (t && t.type) || '', value: (t && t.value) || '', iconType: (t && t.iconType) || 'emoji', iconImage: (t && t.iconImage) || '', iconUrl: (t && t.iconUrl) || '', iconCache: (t && t.iconCache) || '' }; }
  function handleDrop(g, from, to) {
    if (from < 0 || from === to) return;
    const sf = g.tiles[from], sw = (sf && sf.w) || 1, sh = (sf && sf.h) || 1;
    const tt = g.tiles[to], tw = (tt && tt.w) || 1, th = (tt && tt.h) || 1;
    if (sw > 1 || sh > 1) moveBlock(g, from, to % g.cols, Math.floor(to / g.cols));   // move a merged block
    else if (tw === 1 && th === 1) swapTiles(g, from, to);                            // swap two 1×1 tiles
    // (dropping a 1×1 onto a merged block is ignored for now)
  }
  // Move a merged block so its top-left lands at (dc,dr); tiles it lands on slide into the cells it vacated.
  function moveBlock(g, ownerIdx, dc, dr) {
    const w0 = (g.tiles[ownerIdx].w) || 1, h0 = (g.tiles[ownerIdx].h) || 1;
    dc = Math.max(0, Math.min(dc, g.cols - w0));
    dr = Math.max(0, Math.min(dr, g.rows - h0));
    const sc = ownerIdx % g.cols, sr = Math.floor(ownerIdx / g.cols);
    if (sc === dc && sr === dr) return;
    const at = (c, r) => r * g.cols + c;
    const blockContent = tileFields(g.tiles[ownerIdx]);
    const srcSet = new Set(), dstSet = new Set();
    for (let or = 0; or < h0; or++) for (let oc = 0; oc < w0; oc++) { srcSet.add(at(sc + oc, sr + or)); dstSet.add(at(dc + oc, dr + or)); }
    for (const di of dstSet) if (!srcSet.has(di)) flattenAt(g, di);                     // unmerge anything under the destination
    const displaced = [];
    for (const di of dstSet) if (!srcSet.has(di)) displaced.push(tileFields(g.tiles[di]));
    for (const si of srcSet) g.tiles[si] = blankTile();                                 // lift the block out
    const freed = [];
    for (const si of srcSet) if (!dstSet.has(si)) freed.push(si);
    freed.forEach((fi, k) => { if (displaced[k]) g.tiles[fi] = displaced[k]; });         // displaced tiles slide into the vacated cells
    const newOwner = at(dc, dr);
    for (const di of dstSet) g.tiles[di] = (di === newOwner) ? Object.assign(blockContent, { w: w0, h: h0 }) : { cover: newOwner };
    ti = newOwner; selEnd = -1; render(); markDirty();
  }

  // ---- tile form (left) ----
  function renderForm() {
    const g = curGrid(); const el = document.getElementById('tileform');
    if (!g || ti < 0) { el.innerHTML = '<p class="hint">Pick a tile above to edit it.</p>'; document.getElementById('iconpane').innerHTML = ''; return; }
    const t = g.tiles[ti];
    if (t.type === 'macro' && !Array.isArray(t.steps)) t.steps = [];
    let body;
    if (t.type === 'page') body = `<div class="row"><label>Page</label>${pageSelectHtml(t)}</div>`;
    else if (t.type === 'macro') body = `<div class="row"><label>Steps</label></div><div id="macroSteps"></div>`;
    else if (t.type === 'key') body = `<div class="row"><label>Keys</label><input id="tValue" value="${esc(t.value)}" placeholder="${valuePlaceholder('key')}"><button id="tRec" type="button">Record</button></div>`;
    else if (t.type === 'ha') body = haTileBodyHtml(t);
    else body = `<div class="row"><label>Value</label><input id="tValue" value="${esc(t.value)}" placeholder="${valuePlaceholder(t.type)}">${t.type === 'app'
        ? '<button id="tBrowse">Browse…</button>'
        : t.type === 'open'
        ? '<button id="tBrowseFile">File…</button><button id="tBrowseFolder">Folder…</button>'
        : ''}</div>`;
    el.innerHTML = `<div class="form">
      <p class="sectitle">Tile ${ti + 1}</p>
      <div class="row"><label>Label</label><input id="tLabel" value="${esc(t.label)}"></div>
      <div class="row"><label>Type</label><select id="tType">${TYPES.map(([v, n]) => `<option value="${v}" ${v === (t.type || '') ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      ${body}
      <div class="row"><button class="danger" id="tClear">Clear tile</button></div>
      <p class="hint">${typeHint(t.type)}</p>
    </div>`;
    document.getElementById('tLabel').oninput = e => { t.label = e.target.value; renderTiles(); markDirty(); };
    document.getElementById('tType').onchange = e => {
      const prev = t.type; t.type = e.target.value;
      if (t.type === 'page' || prev === 'page' || t.type === 'ha' || prev === 'ha') { t.value = ''; t.service = ''; }
      // Default HA entity tiles to the "HA icon" iconType so the resolved icon shows immediately
      // without the user having to flip it manually.
      if (t.type === 'ha' && (!t.iconType || t.iconType === 'emoji')) { t.iconType = 'ha'; t.iconCache = ''; t.iconUrl = ''; }
      if (t.type === 'macro' && !Array.isArray(t.steps)) t.steps = [];
      render(); markDirty();
    };
    const tv = document.getElementById('tValue');
    if (tv) tv.oninput = e => { t.value = e.target.value; renderTiles(); renderIconPane(); markDirty(); };
    const tp = document.getElementById('tPage');
    if (tp) { if (tp.value && tp.value !== t.value) { t.value = tp.value; markDirty(); } tp.onchange = e => { t.value = e.target.value; renderTiles(); markDirty(); }; }
    document.getElementById('tClear').onclick = () => { flattenAt(g, ti); g.tiles[ti] = blankTile(); render(); markDirty(); };
    const setVal = p => { if (!p) return; t.value = p; if (!t.label) t.label = baseName(p); render(); markDirty(); };
    const br = document.getElementById('tBrowse');
    if (br) br.onclick = async () => setVal(await configApi.pickProgram());
    const bf = document.getElementById('tBrowseFile');
    if (bf) bf.onclick = async () => setVal(await configApi.pickFile());
    const bd = document.getElementById('tBrowseFolder');
    if (bd) bd.onclick = async () => setVal(await configApi.pickFolder());
    const tRec = document.getElementById('tRec');
    if (tRec && tv) tRec.onclick = () => captureCombo(tv, c => { t.value = c; tv.value = c; renderTiles(); markDirty(); });
    if (t.type === 'macro') renderMacroSteps(t);
    if (t.type === 'ha') wireHaTile(t);
    renderIconPane();
  }

  // ---- macro step editor ----
  function stepValuePlaceholder(kind) {
    return kind === 'key' ? 'e.g. control+shift+esc' : kind === 'text' ? 'text to type' : kind === 'delay' ? 'milliseconds, e.g. 500'
      : kind === 'app' ? 'chrome  (or full path)' : kind === 'open' ? 'file or folder path' : kind === 'url' ? 'https://…'
      : kind === 'cmd' ? 'shell command' : kind === 'page' ? '' : kind === 'system' ? 'lock | mic | monitor | config'
      : kind === 'ahk' ? 'path to a .ahk file (or a one-line script)' : '';
  }
  function renderMacroSteps(t) {
    if (!Array.isArray(t.steps)) t.steps = [];
    const host = document.getElementById('macroSteps'); if (!host) return;
    const others = (config.grids || []).filter(g => g.id !== curGrid().id);
    const rowHtml = (s, i) => {
      const kind = s.kind || 'key';
      const field = kind === 'page'
        ? `<select class="msVal" data-i="${i}" style="flex:1">${others.map(g => `<option value="${esc(g.id)}" ${g.id === s.value ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>`
        : `<input class="msVal" data-i="${i}" style="flex:1" value="${esc(s.value || '')}" placeholder="${stepValuePlaceholder(kind)}">`;
      const rec = kind === 'key' ? `<button class="msRec" data-i="${i}" type="button" title="Record a key combo">⌨</button>` : '';
      const brow = (kind === 'app' || kind === 'open' || kind === 'ahk') ? `<button class="msBrowse" data-i="${i}" type="button" title="Browse">…</button>` : '';
      return `<div class="row" style="gap:6px">
        <select class="msKind" data-i="${i}" style="width:120px;flex:none">${STEP_KINDS.map(([v, n]) => `<option value="${v}" ${v === kind ? 'selected' : ''}>${n}</option>`).join('')}</select>
        ${field}${rec}${brow}<button class="msUp" data-i="${i}" type="button" title="Move up">↑</button><button class="msDel" data-i="${i}" type="button" title="Remove">✕</button></div>`;
    };
    host.innerHTML = (t.steps.length ? t.steps.map(rowHtml).join('') : '<p class="hint">No steps yet — add one below.</p>')
      + `<div class="row"><button id="msAdd" type="button">+ add step</button></div>`;
    host.querySelectorAll('.msKind').forEach(el => el.onchange = e => { const i = +e.target.dataset.i; t.steps[i].kind = e.target.value; t.steps[i].value = ''; renderMacroSteps(t); markDirty(); });
    host.querySelectorAll('.msVal').forEach(el => { const h = e => { t.steps[+e.target.dataset.i].value = e.target.value; markDirty(); }; el.oninput = h; el.onchange = h; });
    host.querySelectorAll('.msRec').forEach(el => el.onclick = e => { const i = +e.currentTarget.dataset.i; const inp = host.querySelector(`.msVal[data-i="${i}"]`); if (inp) captureCombo(inp, c => { t.steps[i].value = c; inp.value = c; markDirty(); }); });
    host.querySelectorAll('.msBrowse').forEach(el => el.onclick = async e => { const i = +e.currentTarget.dataset.i; const k = t.steps[i].kind; const p = k === 'app' ? await configApi.pickProgram() : await configApi.pickFile(); if (p) { t.steps[i].value = p; renderMacroSteps(t); markDirty(); } });
    host.querySelectorAll('.msUp').forEach(el => el.onclick = e => { const i = +e.currentTarget.dataset.i; if (i > 0) { const x = t.steps.splice(i, 1)[0]; t.steps.splice(i - 1, 0, x); renderMacroSteps(t); markDirty(); } });
    host.querySelectorAll('.msDel').forEach(el => el.onclick = e => { t.steps.splice(+e.currentTarget.dataset.i, 1); renderMacroSteps(t); markDirty(); });
    document.getElementById('msAdd').onclick = () => { t.steps.push({ kind: 'key', value: '' }); renderMacroSteps(t); markDirty(); };
  }
  // Capture one key combo from a focused input -> "control+shift+c" (matches mediaKeys.tapCombo parsing).
  function keyNameFromEvent(k) {
    if (!k || k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;   // modifier alone: keep waiting
    const map = { ' ': 'space', Escape: 'escape', Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'pageup', PageDown: 'pagedown', Home: 'home', End: 'end' };
    if (map[k]) return map[k];
    return k.toLowerCase();
  }
  function comboFromEvent(e) {
    const key = keyNameFromEvent(e.key); if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('control');
    if (e.shiftKey) mods.push('shift');
    if (e.altKey) mods.push('alt');
    if (e.metaKey) mods.push('command');
    return [...mods, key].join('+');
  }
  function captureCombo(inputEl, apply) {
    const prev = inputEl.value;
    inputEl.value = 'press keys…'; inputEl.focus();
    const onKey = e => {
      e.preventDefault();
      const c = comboFromEvent(e);
      if (!c) return;                                   // modifier-only press: wait for a real key
      inputEl.removeEventListener('keydown', onKey);
      apply(c);
    };
    const onBlur = () => { inputEl.removeEventListener('keydown', onKey); inputEl.removeEventListener('blur', onBlur); if (inputEl.value === 'press keys…') inputEl.value = prev; };
    inputEl.addEventListener('keydown', onKey);
    inputEl.addEventListener('blur', onBlur);
  }

  // ---- icon box (right) ----
  function renderIconPane() {
    const g = curGrid(); const el = document.getElementById('iconpane');
    if (!g || ti < 0) { el.innerHTML = ''; return; }
    const t = g.tiles[ti];
    if (iconTypeOf(t) === 'app' && t.type !== 'app') t.iconType = 'emoji';   // app icon only valid for App type
    if (iconTypeOf(t) === 'ha' && t.type !== 'ha') t.iconType = 'emoji';     // HA icon only valid for HA entity tiles
    const type = iconTypeOf(t), appOk = t.type === 'app', haOk = t.type === 'ha';
    el.innerHTML = `<div class="iconbox">
      <p class="sectitle">Icon</p>
      <label class="iconopt"><input type="radio" name="ic" value="emoji" ${type === 'emoji' ? 'checked' : ''}> Emoji</label>
      <label class="iconopt ${appOk ? '' : 'disabled'}"><input type="radio" name="ic" value="app" ${type === 'app' ? 'checked' : ''} ${appOk ? '' : 'disabled'}> App icon ${appOk ? '' : '<span class="note">(set Type = App)</span>'}</label>
      <label class="iconopt ${haOk ? '' : 'disabled'}"><input type="radio" name="ic" value="ha" ${type === 'ha' ? 'checked' : ''} ${haOk ? '' : 'disabled'}> HA icon ${haOk ? '' : '<span class="note">(set Type = HA entity)</span>'}</label>
      <label class="iconopt"><input type="radio" name="ic" value="image" ${type === 'image' ? 'checked' : ''}> Image</label>
      <label class="iconopt"><input type="radio" name="ic" value="url" ${type === 'url' ? 'checked' : ''}> Image URL</label>
      <div class="icondetail" id="icondetail"></div>
      <div class="iconpreview" id="iconpreview"></div>
    </div>`;
    el.querySelectorAll('input[name=ic]').forEach(r => r.onchange = e => {
      const prev = t.iconType;
      t.iconType = e.target.value;
      // Switching INTO 'ha' clears any prior cached URL icon so we don't render a stale user-set
      // image as if it were the HA icon. Switching AWAY keeps t.iconCache/iconUrl -- they're
      // harmless for emoji/app and useful if the user later picks 'url' or 'image'.
      if (t.iconType === 'ha' && prev !== 'ha') { t.iconCache = ''; t.iconUrl = ''; }
      renderIconPane(); renderTiles(); markDirty();
    });
    renderIconDetail(t);
    renderIconPreview(t);
  }

  function renderIconDetail(t) {
    const el = document.getElementById('icondetail'); if (!el) return;
    const type = iconTypeOf(t);
    if (type === 'emoji') {
      el.innerHTML = `<input id="tIcon" value="${esc(t.icon)}" placeholder="paste an emoji, e.g. 🌐">`;
      document.getElementById('tIcon').oninput = e => { t.icon = e.target.value; renderTiles(); renderIconPreview(t); markDirty(); };
    } else if (type === 'app') {
      el.innerHTML = `<p class="hint">${t.value ? 'Uses this program’s own icon: <b>' + esc(t.value) + '</b>' : 'Set a program in Value first.'}</p>`;
      if (t.value) ensureAppIcon(t.value);
    } else if (type === 'ha') {
      const reg = (haCacheLocal && haCacheLocal.entityRegistry || []).find(r => r.entity_id === t.value);
      const state = haStateCache[t.value];
      const liveIcon = (typeof state === 'object' && state && state.attributes && state.attributes.icon) || null;
      const regIcon = reg && reg.icon || null;
      const hasPic = !!(typeof state === 'object' && state && state.attributes && state.attributes.entity_picture);
      const mdi = !hasPic ? haEntityMdiName(t) : null;
      const cached = mdi ? mdiCache[mdi] : null;
      const fellBackToEmoji = !!(mdi && cached && !cached.ok);
      let body = '';
      if (!t.value) body = 'Pick an HA entity above first.';
      else if (hasPic) body = "Uses Home Assistant's icon for <b>" + esc(t.value) + '</b> — the entity\'s picture.';
      else if (mdi) body = "Uses Home Assistant's icon for <b>" + esc(t.value) + '</b> — <code>mdi:' + esc(mdi) + '</code>' + (liveIcon || regIcon ? ' (from ' + (liveIcon ? 'state' : 'registry') + ')' : ' (domain default)') + (fellBackToEmoji ? ' <span class="hint">— couldn\'t reach jsDelivr; showing emoji fallback.</span>' : '');
      else body = 'No icon mapping for this entity — showing an emoji placeholder.';
      el.innerHTML = `<p class="hint">${body}</p>`;
    } else if (type === 'image') {
      el.innerHTML = `<div class="row"><input id="tImage" value="${esc(t.iconImage)}" placeholder="path to an image" readonly><button id="tImgBrowse">Browse…</button></div>`;
      document.getElementById('tImgBrowse').onclick = async () => { const p = await configApi.pickImage(); if (p) { t.iconImage = p; renderIconDetail(t); renderIconPreview(t); renderTiles(); markDirty(); } };
    } else if (type === 'url') {
      el.innerHTML = `<div class="row"><input id="tUrl" value="${esc(t.iconUrl)}" placeholder="https://…/icon.png" style="flex:1"><button id="tUrlGet">Fetch</button></div>
        <p class="hint" id="tUrlMsg" style="margin:4px 0 0">Paste an image URL, then Fetch — it's downloaded and cached so the icon works offline.</p>`;
      const inp = document.getElementById('tUrl'), msg = () => document.getElementById('tUrlMsg'), btn = () => document.getElementById('tUrlGet');
      // "Refresh" only when the box matches the already-cached URL; any edit (or no cache yet) shows "Fetch", so it's clear there's a change to apply.
      const sync = () => { btn().textContent = (t.iconCache && inp.value.trim() === (t.iconUrl || '')) ? 'Refresh' : 'Fetch'; };
      sync();
      inp.oninput = sync;
      btn().onclick = async () => {
        const url = inp.value.trim(); if (!url) { msg().textContent = 'Enter an image URL first.'; return; }
        msg().textContent = 'Fetching…'; btn().disabled = true;
        const r = await configApi.fetchIconUrl(url);
        btn().disabled = false;
        if (r && r.ok) { t.iconUrl = url; t.iconCache = r.cachePath; if (r.dataUrl) urlIconPreview[r.cachePath] = r.dataUrl; msg().textContent = 'Icon downloaded ✓'; sync(); renderIconPreview(t); renderTiles(); markDirty(); }
        else { msg().textContent = (r && r.error) || 'Could not fetch that image.'; }
      };
    }
  }

  function renderIconPreview(t) {
    const el = document.getElementById('iconpreview'); if (!el) return;
    const type = iconTypeOf(t);
    if (type === 'image' && t.iconImage) el.innerHTML = `<img src="${esc(imgUrl(t.iconImage))}">`;
    else if (type === 'url' && t.iconCache) el.innerHTML = `<img src="${esc(urlSrc(t))}">`;
    else if (type === 'url') el.innerHTML = `<span class="none">fetch an image URL to preview</span>`;
    else if (type === 'ha' && t.value) {
      if (t.iconCache) el.innerHTML = `<img src="${esc(urlSrc(t))}">`;
      else {
        const mdi = haEntityMdiName(t);
        const cached = mdi ? mdiCache[mdi] : null;
        if (cached && cached.ok && cached.dataUrl) el.innerHTML = `<img src="${esc(cached.dataUrl)}">`;
        else { if (mdi) ensureMdi(mdi); el.innerHTML = `<span class="em">${esc(haResolveEmoji(t))}</span>`; }
      }
    }
    else if (type === 'ha') el.innerHTML = `<span class="none">pick an HA entity to preview</span>`;
    else if (type === 'app' && t.value) {
      const c = appIconCache[t.value];
      if (c) el.innerHTML = `<img src="${esc(c)}">`;
      else if (c === false) el.innerHTML = `<span class="none">couldn’t read icon — emoji shown instead</span>`;
      else { el.innerHTML = `<span class="none">resolving…</span>`; ensureAppIcon(t.value); }
    } else if (type === 'app') el.innerHTML = `<span class="none">no program set</span>`;
    else el.innerHTML = t.icon ? `<span class="em">${esc(t.icon)}</span>` : `<span class="none">no emoji</span>`;
  }

  function valuePlaceholder(type) { return type === 'url' ? 'https://…' : type === 'app' ? 'chrome  (or full path)' : type === 'cmd' ? 'start ms-settings:' : type === 'system' ? 'lock  |  config  |  mic  |  monitor' : type === 'counter' ? 'Starting value (e.g. 0)' : type === 'paste_text' ? 'Text to paste on tap' : type === 'key' ? 'e.g. control+shift+esc' : ''; }
  function pageSelectHtml(t) {
    const others = (config.grids || []).filter(g => g.id !== curGrid().id);
    if (!others.length) return '<span class="hint">No other pages to link to yet — add one first.</span>';
    return `<select id="tPage">${others.map(g => `<option value="${g.id}" ${g.id === t.value ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>`;
  }
  function typeHint(type) {
    if (type === 'app') return 'Program name on PATH (chrome, notepad…) or a full .exe path via Browse.';
    if (type === 'url') return 'Opens in your default browser.';
    if (type === 'page') return 'Tapping (or clicking) this tile switches the panel to the chosen page.';
    if (type === 'cmd') return 'Runs a shell command (advanced; only use commands you fully trust).';
    if (type === 'system') return 'lock = lock screen · config = open this editor · mic = toggle the device mic · monitor = hide the panel and use the device as a normal monitor (return via the tray).';
    if (type === 'counter') return 'Tap the left half of the tile to decrement, the right half to increment. The value persists across sessions.';
    if (type === 'paste_text') return 'Tap this tile to paste the text into whatever window is active on your PC (overwrites your clipboard).';
    if (type === 'key') return 'Sends a key combo to the active window. Type it (e.g. control+shift+esc) or click Record and press the keys.';
    if (type === 'macro') return 'Runs the steps in order on tap — keystrokes, typed text, delays, app/command/URL launches, page switches, or AutoHotkey.';
    if (type === 'ha') return 'Calls a Home Assistant service on the picked entity. Filter by device type, room, label, or favorites. Star an entity to add it to favorites.';
    return '';
  }

  // ---- HA entity tile helpers ----
  function haServicesFor(domain) { return HA_SERVICES_BY_DOMAIN[domain] || HA_SERVICES_DEFAULT; }
  function haDefaultService(domain) { return haServicesFor(domain)[0][0]; }
  function haEntityDomain(entityOrService) { const dot = (entityOrService || '').indexOf('.'); return dot > 0 ? entityOrService.slice(0, dot) : ''; }
  function haFavorites() { return ((((config.settings || {}).haAuth) || {}).favorites) || []; }
  function haToggleFavorite(entityId) {
    if (!entityId) return;
    if (!config.settings) config.settings = {};
    if (!config.settings.haAuth) config.settings.haAuth = { url: '', token: '', useHa: false };
    const set = new Set(config.settings.haAuth.favorites || []);
    if (set.has(entityId)) set.delete(entityId); else set.add(entityId);
    config.settings.haAuth.favorites = Array.from(set).sort();
    markDirty();
  }
  // The picker body — populated by wireHaTile after fetching the HA cache from main.
  function haTileBodyHtml() {
    return `<div id="haPicker">
      <div class="row"><label>Device Type</label><select id="haDom" style="flex:1"><option value="">All</option></select></div>
      <div class="row"><label>Room</label><select id="haArea" style="flex:1"><option value="">All</option></select></div>
      <div class="row"><label>Label</label><select id="haLabel" style="flex:1"><option value="">All</option></select></div>
      <div class="row"><label>Favorites</label><label class="iconopt" style="width:auto"><input type="checkbox" id="haFav"> Show only favorites</label></div>
      <div class="row"><label>Entity</label>
        <select id="haEntity" size="8" style="flex:1; font-family:monospace; font-size:12px"></select>
        <button id="haStar" type="button" title="Toggle favorite" style="margin-left:6px">☆</button></div>
      <p class="hint" id="haIconHint" style="margin:2px 0 0; min-height:18px"></p>
      <div class="row"><label>Service</label><select id="haService" style="flex:1"></select></div>
      <p class="hint" id="haTileStatus" style="margin:4px 0 0">Loading entities…</p>
    </div>`;
  }
  async function wireHaTile(t) {
    const status = document.getElementById('haTileStatus'); if (!status) return;
    const cache = await configApi.getHaCache();
    if (!cache || !cache.ok || !cache.entities || !cache.entities.length) {
      status.textContent = cache && cache.error ? 'HA cache not loaded: ' + cache.error + '. Open Settings → Auth and click Refresh Configuration.' : 'HA cache empty. Enable Use Home Assistant in Settings → Auth, then click Refresh Configuration.';
      status.style.color = '#c98';
      return;
    }
    const entities = cache.entities;
    const domSel = document.getElementById('haDom');
    const areaSel = document.getElementById('haArea');
    const labelSel = document.getElementById('haLabel');
    const favBox = document.getElementById('haFav');
    const entSel = document.getElementById('haEntity');
    const svcSel = document.getElementById('haService');
    const starBtn = document.getElementById('haStar');

    const uniqDomains = Array.from(new Set(entities.map(e => e.domain).filter(Boolean))).sort();
    const uniqAreas = Array.from(new Set(entities.map(e => e.area).filter(Boolean))).sort();
    const uniqLabels = Array.from(new Set(entities.flatMap(e => e.labels || []).filter(Boolean))).sort();
    domSel.innerHTML = '<option value="">All</option>' + uniqDomains.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    areaSel.innerHTML = '<option value="">All</option>' + uniqAreas.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    labelSel.innerHTML = '<option value="">All</option>' + uniqLabels.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
    // Pre-select the domain filter to match the saved entity so reopening lands on the same area.
    const savedDomain = haEntityDomain(t.value);
    if (savedDomain && uniqDomains.includes(savedDomain)) domSel.value = savedDomain;

    const refreshStar = () => { starBtn.textContent = haFavorites().includes(t.value) ? '★' : '☆'; starBtn.disabled = !t.value; };
    const refreshServiceList = () => {
      const dom = haEntityDomain(t.value);
      if (!dom) { svcSel.innerHTML = '<option value="" disabled>(pick an entity first)</option>'; return; }
      const svcs = haServicesFor(dom);
      // Reset service if the entity's domain changed (old service might not apply).
      if (!t.service || haEntityDomain(t.service) !== dom) t.service = dom + '.' + haDefaultService(dom);
      svcSel.innerHTML = svcs.map(([v, n]) => `<option value="${esc(dom + '.' + v)}" ${t.service === dom + '.' + v ? 'selected' : ''}>${esc(n)}</option>`).join('');
    };
    const populate = () => {
      const favSet = new Set(haFavorites());
      let list = entities;
      if (domSel.value) list = list.filter(e => e.domain === domSel.value);
      if (areaSel.value) list = list.filter(e => e.area === areaSel.value);
      if (labelSel.value) list = list.filter(e => (e.labels || []).includes(labelSel.value));
      if (favBox.checked) list = list.filter(e => favSet.has(e.entityId));
      list.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
      const opts = list.map(e => {
        const fmark = favSet.has(e.entityId) ? '★ ' : '';
        const sub = e.area ? ' · ' + e.area : '';
        return `<option value="${esc(e.entityId)}" ${e.entityId === t.value ? 'selected' : ''}>${fmark}${esc(e.friendlyName)}${sub} (${esc(e.entityId)})</option>`;
      });
      // Surface a saved entity that's hidden by the current filters (or genuinely missing from the
      // cache) so it stays visible as the current selection. Distinguish the two cases so a saved
      // entity that's filtered out doesn't masquerade as "missing".
      if (t.value && !list.some(e => e.entityId === t.value)) {
        const inCache = entities.find(e => e.entityId === t.value);
        opts.unshift(inCache
          ? `<option value="${esc(t.value)}" selected>${esc(inCache.friendlyName)} (${esc(t.value)}) — hidden by current filters</option>`
          : `<option value="${esc(t.value)}" selected>${esc(t.value)} (not in current cache)</option>`);
      }
      entSel.innerHTML = opts.length ? opts.join('') : '<option value="" disabled>— 0 entities match these filters —</option>';
      refreshServiceList();
      refreshStar();
      status.textContent = list.length + ' entit' + (list.length === 1 ? 'y' : 'ies') + (cache.entities.length === list.length ? '' : ' of ' + cache.entities.length + ' total');
      status.style.color = '#7e93ab';
    };

    entSel.onchange = e => {
      t.value = e.target.value;
      refreshServiceList(); refreshStar();
      // Helpful default: stamp the friendly name as the tile label if the user hasn't named it.
      if (!t.label) { t.label = (entities.find(x => x.entityId === t.value) || {}).friendlyName || t.value; document.getElementById('tLabel').value = t.label; }
      // If the user is using the HA icon, drop the prior entity's cached picture so the new
      // entity's picture (or emoji) takes over on the next render.
      if (t.iconType === 'ha') { t.iconCache = ''; t.iconUrl = ''; delete haStateCache[t.value]; }
      renderTiles(); renderIconPane(); markDirty();
      loadEntityIconHint(t).catch(() => {});                          // background: surface HA icon hint
    };
    svcSel.onchange = e => { t.service = e.target.value; markDirty(); };
    starBtn.onclick = () => { haToggleFavorite(t.value); refreshStar(); if (favBox.checked) populate(); };
    domSel.onchange = populate;
    areaSel.onchange = populate;
    labelSel.onchange = populate;
    favBox.onchange = populate;
    populate();
    if (t.value) loadEntityIconHint(t).catch(() => {});               // pre-load on first render so the hint shows immediately
  }

  // Surface the picked entity's HA icon name (mdi:...) and any entity_picture presence as a hint
  // line in the picker. Also pre-populates haStateCache so iconHtml resolves immediately on first
  // render. Doesn't overwrite the user's icon choice -- the iconType='ha' path owns auto-resolution.
  async function loadEntityIconHint(t) {
    const hintEl = document.getElementById('haIconHint'); if (!hintEl) return;
    hintEl.textContent = '';
    const startedFor = t.value;
    if (!startedFor) return;
    let s;
    try { s = await configApi.fetchHaEntityState(startedFor); } catch (e) { return; }
    if (t.value !== startedFor) return;
    if (!s || s.error) return;
    haStateCache[startedFor] = s;                                     // share the result with iconHtml
    const attrs = s.attributes || {};
    const parts = [];
    if (typeof attrs.icon === 'string' && attrs.icon) parts.push('HA icon: ' + attrs.icon);
    if (typeof attrs.entity_picture === 'string' && attrs.entity_picture) parts.push('entity picture available');
    hintEl.textContent = parts.join(' · ');
    // If the user is on "HA icon" and the state has an entity_picture, kick the fetch so iconHtml
    // renders the image instead of the emoji fallback on the next render.
    if (t.iconType === 'ha') { ensureHaEntityPicture(t); renderTiles(); renderIconPreview(t); }
  }

  // ---- dashboard page (web) ----
  function renderDashboard() {
    const g = curGrid();
    document.getElementById('tilegrid').innerHTML = '';
    document.getElementById('tileform').innerHTML = '';
    document.getElementById('iconpane').innerHTML = '';
    if (!g.auth) g.auth = g.haToken ? { type: 'ha', token: g.haToken } : { type: 'none' };
    delete g.haToken;
    const el = document.getElementById('gridmeta');
    const onButtons = g.gridOn && dashTab === 'buttons';
    // tab bar: the Buttons tab only exists once a grid is enabled (revealed by the Add-grid checkbox)
    const tabBar = `<div class="tabbar">
        <button id="dtPage" class="tab${onButtons ? '' : ' on'}">Dashboard</button>
        ${g.gridOn ? `<button id="dtBtns" class="tab${onButtons ? ' on' : ''}">Buttons</button>` : ''}</div>`;

    if (onButtons) {   // ---- Buttons tab: strip side + size; the tile editor renders below (in render()) ----
      el.innerHTML = tabBar + gridSizeRowHtml(g) + groupSelectRowHtml(g) +
        `<p class="hint">A strip of launcher tiles on the chosen side of the dashboard — 2 rows tall, 1–3 columns wide. Edit the tiles below. Uncheck <b>Add a button grid</b> on the Dashboard tab to remove it.</p>`;
      document.getElementById('dtPage').onclick = () => { dashTab = 'page'; render(); };
      wireGridSizeRow(g); wireGroupSelectRow(g);
      return;
    }

    el.innerHTML = tabBar + `
      <div class="row"><label>Name</label><input id="gName" value="${esc(g.name)}"></div>
      <div class="row"><label>URL</label><input id="gUrl" value="${esc(g.url)}" placeholder="https://…  (dashboard, monitoring page, etc.)"></div>
      <div class="row"><label>Auth</label><select id="gAuth">
        <option value="none" ${g.auth.type === 'none' ? 'selected' : ''}>None</option>
        <option value="ha" ${g.auth.type === 'ha' ? 'selected' : ''}>Home Assistant token</option>
        <option value="basic" ${g.auth.type === 'basic' ? 'selected' : ''}>HTTP Basic Auth</option>
        <option value="header" ${g.auth.type === 'header' ? 'selected' : ''}>Custom header(s)</option>
      </select></div>
      <div id="authFields"></div>
      <div class="row" style="margin-top:10px"><label style="width:auto">Links</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gExt" ${g.linksExternal ? 'checked' : ''}> Open clicked links in my PC browser</label></div>
      <p class="hint">When on, tapping a link inside this page (e.g. a helpdesk ticket) opens it in your PC's default browser instead of on the panel — the page itself stays up on the device.</p>
      <div class="row" style="margin-top:10px"><label style="width:auto">Identity</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gUA" ${g.desktopUA ? 'checked' : ''}> Use a desktop browser identity</label></div>
      <p class="hint">Makes this page look like desktop Chrome instead of an embedded app. Turn on for sites that won't load or let you sign in inside the panel (e.g. claude.ai, chatgpt.com). The panel keeps its own login, separate from your PC browser.</p>
      <div class="row" style="margin-top:10px"><label style="width:auto">Buttons</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gGrid" ${g.gridOn ? 'checked' : ''}> Add a button grid beside the dashboard</label></div>
      <p class="hint">Adds a strip of launcher tiles beside the web view — pick the side, size, and tiles on the <b>Buttons</b> tab that appears.</p>
      ${rotRowHtml(g)}
      ${shortcutRowHtml(g)}
      ${advRowHtml(g)}
      <div class="row" style="margin-top:10px"><button class="danger" id="gDelete">Delete page</button></div>
      <p class="hint" id="authHint"></p>
      <p class="hint">Shown full-screen on the panel. Knob scrolls · tap clicks · double-click the knob returns to the page selector.</p>`;
    const dtb = document.getElementById('dtBtns'); if (dtb) dtb.onclick = () => { dashTab = 'buttons'; render(); };
    document.getElementById('gName').oninput = e => { g.name = e.target.value; renderGrids(); markDirty(); };
    document.getElementById('gUrl').oninput = e => { g.url = e.target.value; markDirty(); };
    document.getElementById('gAuth').onchange = e => { setAuthType(g, e.target.value); renderAuthFields(g); markDirty(); };
    document.getElementById('gDelete').onclick = deleteCurrentPage;
    document.getElementById('gExt').onchange = e => { g.linksExternal = e.target.checked; markDirty(); };
    const gua = document.getElementById('gUA'); if (gua) gua.onchange = e => { g.desktopUA = e.target.checked; markDirty(); };
    document.getElementById('gGrid').onchange = e => {
      g.gridOn = e.target.checked;
      if (g.gridOn) { enableGrid(g); dashTab = 'buttons'; }   // 2×3 default; reveal + jump to the new tab
      else { dashTab = 'page'; }
      ti = -1; selEnd = -1; render(); markDirty();
    };
    wireRotRow(g); wireShortcutRow(g); wireAdvRow(g);
    renderAuthFields(g);
  }
  function setAuthType(g, type) {
    if (type === 'ha') g.auth = { type: 'ha', token: (g.auth && g.auth.token) || '' };
    else if (type === 'basic') g.auth = { type: 'basic', user: (g.auth && g.auth.user) || '', pass: (g.auth && g.auth.pass) || '' };
    else if (type === 'header') g.auth = { type: 'header', headers: (g.auth && g.auth.headers && g.auth.headers.length) ? g.auth.headers : [{ name: '', value: '' }] };
    else g.auth = { type: 'none' };
  }
  function renderAuthFields(g) {
    const el = document.getElementById('authFields'), hint = document.getElementById('authHint');
    const t = g.auth.type;
    if (t === 'ha') {
      el.innerHTML = `<div class="row"><label>Token</label>${secretInput(g.auth.token, 'id="aTok" placeholder="blank = use the global HA token (Settings → Auth)"')}</div>`;
      document.getElementById('aTok').oninput = e => { g.auth.token = e.target.value; markDirty(); };
      hint.innerHTML = 'Leave blank to use the <b>global Home Assistant token</b> you already set in Settings → Auth — the panel signs in automatically. Only fill this in if this specific dashboard needs a <i>different</i> HA token (e.g. a second HA instance): profile → Security → Long-Lived Access Tokens → Create, paste above.';
    } else if (t === 'basic') {
      el.innerHTML = `<div class="row"><label>User</label><input id="aUser" value="${esc(g.auth.user)}"></div>
        <div class="row"><label>Password</label>${secretInput(g.auth.pass, 'id="aPass"')}</div>`;
      document.getElementById('aUser').oninput = e => { g.auth.user = e.target.value; markDirty(); };
      document.getElementById('aPass').oninput = e => { g.auth.pass = e.target.value; markDirty(); };
      hint.innerHTML = 'Sent as an HTTP Basic Auth header to the dashboard host (common behind nginx / a reverse proxy).';
    } else if (t === 'header') {
      el.innerHTML = g.auth.headers.map((h, i) => `<div class="row"><input class="aHN" data-i="${i}" value="${esc(h.name)}" placeholder="Header name" style="flex:2">${secretInput(h.value, `class="aHV" data-i="${i}" placeholder="value"`, 'flex:3')}<button class="aHD" data-i="${i}" title="remove">✕</button></div>`).join('')
        + `<div class="row"><button id="aHAdd">+ header</button></div>`;
      el.querySelectorAll('.aHN').forEach(x => x.oninput = e => { g.auth.headers[+e.target.dataset.i].name = e.target.value; markDirty(); });
      el.querySelectorAll('.aHV').forEach(x => x.oninput = e => { g.auth.headers[+e.target.dataset.i].value = e.target.value; markDirty(); });
      el.querySelectorAll('.aHD').forEach(b => b.onclick = e => { g.auth.headers.splice(+e.currentTarget.dataset.i, 1); if (!g.auth.headers.length) g.auth.headers.push({ name: '', value: '' }); renderAuthFields(g); markDirty(); });
      document.getElementById('aHAdd').onclick = () => { g.auth.headers.push({ name: '', value: '' }); renderAuthFields(g); markDirty(); };
      hint.innerHTML = 'Header(s) added to requests to the dashboard host — e.g. <code>Authorization: Bearer …</code>, or Cloudflare Access <code>CF-Access-Client-Id</code> + <code>CF-Access-Client-Secret</code>.';
    } else {
      el.innerHTML = '';
      hint.innerHTML = 'No authentication — for public pages or anonymous-access dashboards.';
    }
  }
  // ---- app page ----
  function renderAppPage() {
    const g = curGrid();
    const def = appDefs.find(a => a.id === g.app);
    const builtinGrid = !!(def && def.grid);          // music/agenda/events: in-page grid, always on
    const canGrid = !!def && !builtinGrid && g.app !== 'office'; // Office owns four configured app controls; no unrelated generic grid
    const onButtons = canGrid && g.gridOn && dashTab === 'buttons';
    // Tile editor shows for a built-in grid, or on the Buttons tab of an opted-in grid; clear it otherwise.
    if (!builtinGrid && !onButtons) ['tilegrid', 'mergebar', 'tileform', 'iconpane'].forEach(id => { document.getElementById(id).innerHTML = ''; });
    const el = document.getElementById('gridmeta');
    const tabBar = (canGrid && g.gridOn) ? `<div class="tabbar">
        <button id="atPage" class="tab${onButtons ? '' : ' on'}">App</button>
        <button id="atBtns" class="tab${onButtons ? ' on' : ''}">Buttons</button></div>` : '';

    if (onButtons) {   // ---- Buttons tab: side + size; the tile editor renders below (in render()) ----
      el.innerHTML = tabBar + gridSizeRowHtml(g, g.app === 'music') +   // Music's grid is pinned right — hide the Side picker
        groupSelectRowHtml(g) +
        `<p class="hint">A strip of launcher tiles beside the app — 2 rows tall, 1–3 columns wide. Edit the tiles below. Uncheck <b>Add a button grid</b> on the App tab to remove it.</p>`;
      document.getElementById('atPage').onclick = () => { dashTab = 'page'; render(); };
      wireGridSizeRow(g); wireGroupSelectRow(g);
      return;
    }

    // Music groups its three panels (album art / lyrics / button grid) in one box, capped at 2 on.
    const isMusic = g.app === 'music';
    const isHaDash = g.app === 'ha-dashboard';
    const isKeyShortcuts = g.app === 'keyshortcuts';
    const isClaudeVoice = g.app === 'claude-voice';
    const isCodexVoice = g.app === 'codex-voice';
    const isVoiceApp = isClaudeVoice || isCodexVoice;   // both share the hand-rendered options box below
    const isOffice = g.app === 'office';
    const musicBox = `<fieldset style="border:1px solid #2a3a4e; border-radius:8px; padding:6px 14px 10px; margin:10px 0">
        <legend style="padding:0 6px; color:#9fb3c8; font-size:13px">Panels</legend>
        <div><label class="iconopt" style="width:auto"><input type="checkbox" id="pArt" ${optVal(g, 'art', true) ? 'checked' : ''}> Show album art</label></div>
        <div><label class="iconopt" style="width:auto"><input type="checkbox" id="pLyrics" ${optVal(g, 'lyrics', false) ? 'checked' : ''}> Show lyrics</label></div>
        <div><label class="iconopt" style="width:auto"><input type="checkbox" id="gGrid" ${g.gridOn ? 'checked' : ''}> Buttons (grid)</label></div>
        <p class="hint" style="margin:6px 0 0">Only two may be checked at once (screen space). Grid size/tiles are on the <b>Buttons</b> tab.</p>
      </fieldset>`;
    // HA Dashboard: dashboard picker (fetched from HA on render), kiosk-mode flags, then the standard Buttons toggle.
    const curDash = (g.options && g.options.dashboard) || 'lovelace';
    const haBox = `<div id="haDashBox" style="margin-top:10px">
        <div class="row"><label>Dashboard</label>
          <select id="haDashSel" style="flex:1"><option value="${esc(curDash)}" selected>${esc(curDash)} (current)</option></select>
          <button id="haDashRefresh" type="button" title="Reload from HA">Refresh</button></div>
        <p class="hint" id="haDashMsg" style="margin:4px 0 0">Loading dashboards…</p>
        <div class="row" style="margin-top:10px"><label style="width:auto">URL flags</label>
          <label class="iconopt" style="width:auto"><input type="checkbox" id="haKiosk" ${optVal(g, 'kiosk', false) ? 'checked' : ''}> Kiosk mode</label>
          <label class="iconopt" style="width:auto"><input type="checkbox" id="haHideHeader" ${optVal(g, 'hideHeader', false) ? 'checked' : ''}> Hide header</label>
          <label class="iconopt" style="width:auto"><input type="checkbox" id="haHideSidebar" ${optVal(g, 'hideSidebar', false) ? 'checked' : ''}> Hide sidebar</label></div>
        <p class="hint">Requires the <b>kiosk-mode</b> integration installed on your Home Assistant instance — these only set the URL flags it reads. Kiosk mode hides both header and sidebar; the other two hide just one.</p>
      </div>` + (canGrid ? `<div class="row" style="margin-top:10px"><label style="width:auto">Buttons</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gGrid" ${g.gridOn ? 'checked' : ''}> Add a button grid beside the app</label></div>
      <p class="hint">Adds a strip of launcher tiles beside the app — pick the side, size, and tiles on the <b>Buttons</b> tab that appears.</p>` : '');
    // Custom shortcuts cheat-sheet: edited right here, but the list itself is global/shared — see
    // shortcutRowsHtml's comment and docs/charter-keyshortcuts.md.
    const keyShortcutsBox = `<div style="margin-top:10px">
        <p class="hint" style="margin:0 0 8px">Free-text shortcut/description rows for other programs. Shown as
        <b>Custom</b> on the panel, alongside open-quake's own rotation hotkey and every page's jump shortcut.
        This list is shared — editing it here updates every page that has the Keyboard Shortcuts app.</p>
        <div id="sShortcutRows">${shortcutRowsHtml((config.settings || {}).customShortcuts)}</div>
        <button id="sShortcutAdd" type="button" style="margin-top:8px">+ Add another shortcut</button>
      </div>` + (canGrid ? `<div class="row" style="margin-top:10px"><label style="width:auto">Buttons</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gGrid" ${g.gridOn ? 'checked' : ''}> Add a button grid beside the app</label></div>
      <p class="hint">Adds a strip of launcher tiles beside the app — pick the side, size, and tiles on the <b>Buttons</b> tab that appears.</p>` : '');
    // Claude Code voice app: project picker (dynamic dir list -- can't be a static apps.json enum)
    // plus the rest of the app's options, hand-rendered here same as HA Dashboard's box does for its
    // own picker + flags rather than delegating to the generic renderAppOpts(). See docs/claude-voice.md
    // and the plan file for why projectDir specifically needs this (D:\Github\* isn't known at
    // apps.json-authoring time).
    const cvOptDef = key => (def && def.options || []).find(o => o.key === key) || {};
    const cvVal = (key, dflt) => optVal(g, key, dflt);
    const cvPermChoices = (cvOptDef('permissionMode').choices || []);
    const claudeVoiceBox = `<div id="cvBox" style="margin-top:10px">
        <p id="cvCliWarn" class="hint" style="display:none;color:#ff8a8a;font-weight:600"></p>
        <div class="row"><label>Default folder</label>
          <input id="cvProjectPath" value="${esc(cvVal('projectDir', ''))}" style="flex:1">
          <button id="cvProjectPathBrowse" type="button">Browse…</button></div>
        <p class="hint">Where new sessions start until a folder is picked on the panel (Change folder). The panel's pick updates this. Created automatically if it doesn't exist yet.</p>
        <div class="row" style="margin-top:10px"><label style="width:auto">Folders root</label>
          <input id="cvProjectsRoot" value="${esc(cvVal('projectsRoot', ''))}" style="flex:1">
          <button id="cvProjectsRootBrowse" type="button">Browse…</button></div>
        <p class="hint">The folder the panel's Change folder list scans.</p>
        <div class="row"><label>Wyoming host</label><input id="cvWyomingHost" value="${esc(cvVal('wyomingHost', ''))}" style="flex:1"></div>
        <div class="row"><label>STT / TTS ports</label>
          <input id="cvSttPort" value="${esc(cvVal('wyomingSttPort', ''))}" style="width:90px">
          <input id="cvTtsPort" value="${esc(cvVal('wyomingTtsPort', ''))}" style="width:90px;margin-left:8px"></div>
        <p class="hint">Voice needs Piper (TTS) and Whisper (STT) hosts. Please enter the IP of your server or use <a href="#" id="cvTtsLink">tts-stt-windows</a> to provide both on any Windows machine — install it and set the host to <code>127.0.0.1</code>.</p>
        <div class="row" style="margin-top:10px"><label>Permission mode</label>
          <select id="cvPermMode" style="flex:1">${cvPermChoices.map(c => `<option value="${esc(c[0])}" ${cvVal('permissionMode', cvOptDef('permissionMode').default || '') === c[0] ? 'selected' : ''}>${esc(c[1])}</option>`).join('')}</select></div>` + (isClaudeVoice ? `
        <div class="row"><label>Touch approval</label>
          <label class="iconopt" style="width:auto"><input type="checkbox" id="cvApprovals" ${cvVal('approvalsEnabled', false) ? 'checked' : ''}> when in Manual mode</label></div>
        <div class="row" style="margin-top:10px"><label>Panel prompt</label>
          <button id="cvEditPrompt" type="button">Edit prompt file</button></div>
        <p class="hint">Your own instructions for panel sessions (claude-panel-prompt.md, opens in your default editor). Appended to the built-in voice prompt; text inside &lt;!-- comment markers --&gt; is ignored. Applies from the next session start. Never affects terminal Claude Code.</p>` : '') + `
      </div>` + (canGrid ? `<div class="row" style="margin-top:10px"><label style="width:auto">Buttons</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gGrid" ${g.gridOn ? 'checked' : ''}> Add a button grid beside the app</label></div>
      <p class="hint">Adds a strip of launcher tiles beside the app — pick the side, size, and tiles on the <b>Buttons</b> tab that appears.</p>` : '');
    const optsBlock = isMusic ? musicBox : isHaDash ? haBox : isKeyShortcuts ? keyShortcutsBox : isVoiceApp ? claudeVoiceBox : isOffice ? officeOptionsHtml(g, def) : ('<div id="appOpts"></div>' + (canGrid ? `<div class="row" style="margin-top:10px"><label style="width:auto">Buttons</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gGrid" ${g.gridOn ? 'checked' : ''}> Add a button grid beside the app</label></div>
      <p class="hint">Adds a strip of launcher tiles beside the app — pick the side, size, and tiles on the <b>Buttons</b> tab that appears.</p>` : ''));
    el.innerHTML = tabBar + `
      <div class="row"><label>Name</label><input id="gName" value="${esc(g.name)}"></div>
      <div class="row"><label>App</label><select id="gApp" style="flex:1;width:auto">
        <option value="">— choose an app —</option>
        ${appDefs.filter(a => a.id === g.app || appVisible(a)).map(a => `<option value="${esc(a.id)}" ${a.id === g.app ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
      </select><button id="refreshApps" type="button" title="Reload app manifests">Refresh</button></div>
      ${optsBlock}
      ${rotRowHtml(g)}
      ${shortcutRowHtml(g)}
      ${advRowHtml(g)}
      <div class="row" style="margin-top:10px"><button class="danger" id="gDelete">Delete page</button></div>
      <p class="hint">${def ? esc(def.name) + ' runs locally and shows full-screen on the panel.' : 'Pick an app, then set its options below.'}</p>`;
    const atb = document.getElementById('atBtns'); if (atb) atb.onclick = () => { dashTab = 'buttons'; render(); };
    document.getElementById('gName').oninput = e => { g.name = e.target.value; renderGrids(); markDirty(); };
    document.getElementById('gApp').onchange = e => { setApp(g, e.target.value); render(); markDirty(); };
    document.getElementById('refreshApps').onclick = refreshApps;
    document.getElementById('gDelete').onclick = deleteCurrentPage;
    const gg = document.getElementById('gGrid');
    if (gg) gg.onchange = e => {
      g.gridOn = e.target.checked;
      if (g.gridOn) { enableGrid(g); dashTab = 'buttons'; } else { dashTab = 'page'; }   // 2×3 default
      ti = -1; selEnd = -1; render(); markDirty();
    };
    if (isMusic) {
      const pa = document.getElementById('pArt'); if (pa) pa.onchange = e => { if (!g.options) g.options = {}; g.options.art = e.target.checked; markDirty(); enforceMusicCap(g); };
      const pl = document.getElementById('pLyrics'); if (pl) pl.onchange = e => { if (!g.options) g.options = {}; g.options.lyrics = e.target.checked; markDirty(); enforceMusicCap(g); };
    } else if (isHaDash) {
      const sel = document.getElementById('haDashSel');
      const msg = document.getElementById('haDashMsg');
      const ref = document.getElementById('haDashRefresh');
      const fillFromCache = c => {
        if (!c || !c.ok) {
          msg.textContent = c && c.error ? 'HA cache not loaded: ' + c.error + '. Click Refresh, or check the Auth tab.' : 'HA cache not loaded. Click Refresh, or enable Use Home Assistant in the Auth tab.';
          msg.style.color = '#c98';
          return;
        }
        // HA's lovelace/dashboards/list excludes the default Overview dashboard; prepend it so it's pickable.
        const items = [{ url_path: 'lovelace', title: 'Overview (default)' }].concat((c.dashboards || []).map(d => ({ url_path: d.url_path, title: d.title })));
        const cur = (g.options && g.options.dashboard) || 'lovelace';
        sel.innerHTML = items.map(it => `<option value="${esc(it.url_path)}" ${it.url_path === cur ? 'selected' : ''}>${esc(it.title || it.url_path)} (${esc(it.url_path)})</option>`).join('');
        msg.textContent = items.length + ' dashboard' + (items.length === 1 ? '' : 's') + ' available.';
        msg.style.color = '#7e93ab';
      };
      const refresh = async () => {
        ref.disabled = true; msg.textContent = 'Refreshing HA cache…'; msg.style.color = '#7e93ab';
        try { fillFromCache(await configApi.refreshHaCache()); }
        catch (e) { msg.textContent = 'Refresh failed: ' + (e.message || e); msg.style.color = '#c98'; }
        finally { ref.disabled = false; }
      };
      sel.onchange = e => { if (!g.options) g.options = {}; g.options.dashboard = e.target.value; markDirty(); };
      ref.onclick = refresh;
      configApi.getHaCache().then(fillFromCache);   // show whatever's currently cached
      const kiosk = document.getElementById('haKiosk'); if (kiosk) kiosk.onchange = e => { if (!g.options) g.options = {}; g.options.kiosk = e.target.checked; markDirty(); };
      const hideHeader = document.getElementById('haHideHeader'); if (hideHeader) hideHeader.onchange = e => { if (!g.options) g.options = {}; g.options.hideHeader = e.target.checked; markDirty(); };
      const hideSidebar = document.getElementById('haHideSidebar'); if (hideSidebar) hideSidebar.onchange = e => { if (!g.options) g.options = {}; g.options.hideSidebar = e.target.checked; markDirty(); };
    } else if (isKeyShortcuts) {
      wireShortcutRows();
    } else if (isVoiceApp) {
      const setOpt = (key, val) => { if (!g.options) g.options = {}; g.options[key] = val; markDirty(); };
      // Default folder is a plain text box -- actual folder switching happens on the panel
      // (Change folder), which writes its pick back into this same option.
      document.getElementById('cvProjectPath').oninput = e => setOpt('projectDir', e.target.value.trim());
      document.getElementById('cvProjectsRoot').oninput = e => setOpt('projectsRoot', e.target.value.trim());
      document.getElementById('cvProjectPathBrowse').onclick = async () => { const p = await configApi.pickFolder(); if (p) { document.getElementById('cvProjectPath').value = p; setOpt('projectDir', p); } };
      document.getElementById('cvProjectsRootBrowse').onclick = async () => { const p = await configApi.pickFolder(); if (p) { document.getElementById('cvProjectsRoot').value = p; setOpt('projectsRoot', p); } };
      document.getElementById('cvWyomingHost').oninput = e => setOpt('wyomingHost', e.target.value.trim());
      document.getElementById('cvSttPort').oninput = e => setOpt('wyomingSttPort', e.target.value.trim());
      document.getElementById('cvTtsPort').oninput = e => setOpt('wyomingTtsPort', e.target.value.trim());
      document.getElementById('cvPermMode').onchange = e => setOpt('permissionMode', e.target.value);
      const cvApprovals = document.getElementById('cvApprovals');   // claude-only rows
      if (cvApprovals) cvApprovals.onchange = e => setOpt('approvalsEnabled', e.target.checked);
      const cvEditPrompt = document.getElementById('cvEditPrompt');
      if (cvEditPrompt) cvEditPrompt.onclick = () => configApi.editClaudeVoicePrompt();
      const cvTtsLink = document.getElementById('cvTtsLink');
      if (cvTtsLink) cvTtsLink.onclick = e => { e.preventDefault(); configApi.openExternal('https://github.com/TeeJS/tts-stt-windows/releases'); };
      // Warn at add-time if the agent CLI this page drives isn't installed -- otherwise the user
      // only finds out when the panel page errors on first use.
      configApi.probeVoiceCli(g.app).then(p => {
        const warn = document.getElementById('cvCliWarn');
        if (warn && !p) {
          warn.textContent = '⚠ The ' + (isCodexVoice ? 'codex' : 'claude') + ' CLI was not found on PATH — this page won\'t work until it is installed.';
          warn.style.display = '';
        }
      }).catch(() => {});
    } else if (isOffice) {
      wireOfficeOptions(g);
    } else {
      renderAppOpts(g, def);
    }
    wireRotRow(g); wireShortcutRow(g); wireAdvRow(g);
    enforceMusicCap(g);
  }
  // Music: only 2 of {button grid, album art, lyrics} fit at once. Disable the unchecked third.
  function optVal(g, key, dflt) { const o = g.options || {}; return (key in o) ? o[key] : dflt; }
  function musicPanels(g) { return { grid: !!g.gridOn, art: !!optVal(g, 'art', true), lyrics: !!optVal(g, 'lyrics', false) }; }
  function enforceMusicCap(g) {
    if (!g || g.app !== 'music') return;
    const p = musicPanels(g); const full = (p.grid ? 1 : 0) + (p.art ? 1 : 0) + (p.lyrics ? 1 : 0) >= 2;
    const gg = document.getElementById('gGrid'); if (gg) gg.disabled = full && !p.grid;
    const pa = document.getElementById('pArt'); if (pa) pa.disabled = full && !p.art;
    const pl = document.getElementById('pLyrics'); if (pl) pl.disabled = full && !p.lyrics;
  }
  function setApp(g, id) {
    const prev = appDefs.find(a => a.id === g.app);
    g.app = id;
    const def = appDefs.find(a => a.id === id);
    g.options = {};
    if (def) {
      def.options.forEach(o => { g.options[o.key] = o.default; });
      if (!g.name || g.name === 'App' || (prev && g.name === prev.name)) g.name = def.name;  // auto-name from the app
      if (def.grid) {                                       // app embeds a programmable tile grid — seed it
        g.cols = def.grid.cols || 2; g.rows = def.grid.rows || 2;
        if (!Array.isArray(g.tiles) || !g.tiles.length) g.tiles = (def.grid.defaults || []).map(t => Object.assign({}, t));
      }
    }
  }
  function renderAppOpts(g, def) {
    const el = document.getElementById('appOpts'); if (!el) return;
    if (!def) { el.innerHTML = ''; return; }
    if (!g.options) g.options = {};
    const valOf = key => (key in g.options) ? g.options[key] : ((def.options || []).find(x => x.key === key) || {}).default;
    const visible = o => !o.showIf || String(valOf(o.showIf.key)) === String(o.showIf.value);   // conditional option (e.g. city slots only in Cities mode)
    el.innerHTML = (def.options || []).filter(visible).map(o => {
      const v = (o.key in g.options) ? g.options[o.key] : o.default;
      let field;
      if (o.type === 'select') field = `<select class="aopt" data-key="${esc(o.key)}">${o.choices.map(ch => { const val = Array.isArray(ch) ? ch[0] : ch, lab = Array.isArray(ch) ? ch[1] : ch; return `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
      else if (o.type === 'bool') field = `<input type="checkbox" class="aopt" data-key="${esc(o.key)}" ${v ? 'checked' : ''} style="width:auto">`;
      else if (o.type === 'secret') field = secretInput(v, `class="aopt" data-key="${esc(o.key)}"`);
      else field = `<input class="aopt" data-key="${esc(o.key)}" value="${esc(v)}">`;
      const help = o.help ? `<p class="hint" style="margin:-2px 0 10px 78px">${esc(o.help)}</p>` : '';
      return `<div class="row"><label>${esc(o.label)}</label>${field}</div>${help}`;
    }).join('');
    el.querySelectorAll('.aopt').forEach(inp => inp.onchange = e => {
      const o = (def.options || []).find(x => x.key === e.target.dataset.key);
      g.options[e.target.dataset.key] = (o && o.type === 'bool') ? e.target.checked : e.target.value;
      markDirty();
      if (o && (o.type === 'select' || o.type === 'bool')) renderAppOpts(g, def);   // re-evaluate conditional (showIf) options
      enforceMusicCap(g);   // re-apply the 2-of-3 panel cap (grid/art/lyrics)
    });
    enforceMusicCap(g);
  }

  function deleteCurrentPage() {
    if (config.grids.length <= 1) return;
    config.grids.splice(gi, 1); gi = 0; ti = -1;
    if (!config.grids.some(x => x.id === config.activeGridId)) config.activeGridId = config.grids[0].id;
    render(); markDirty();
  }

  function render() {
    renderGrids();
    renderGroups();
    // Sidebar: which list is visible + which + buttons row + which tab is highlighted.
    const groupsTab = leftTab === 'groups';
    const elGL = document.getElementById('gridlist'); if (elGL) elGL.style.display = groupsTab ? 'none' : '';
    const elGRP = document.getElementById('grouplist'); if (elGRP) elGRP.style.display = groupsTab ? '' : 'none';
    const elAP = document.getElementById('addPageBtns'); if (elAP) elAP.style.display = groupsTab ? 'none' : '';
    const elAG = document.getElementById('addGroupBtns'); if (elAG) elAG.style.display = groupsTab ? '' : 'none';
    const tp = document.getElementById('lTabPages'); if (tp) tp.classList.toggle('on', !groupsTab);
    const tg = document.getElementById('lTabGroups'); if (tg) tg.classList.toggle('on', groupsTab);

    if (view === 'settings') { renderSettings(); return; }
    if (view === 'groups') { renderGroupMeta(); renderTiles(); renderForm(); return; }
    const g = curGrid();
    const groupApplied = !!(g && g.useGroup && g.groupId && groupById(g.groupId));
    const showTileEditor = () => { if (groupApplied) renderGroupAppliedPreview(g); else { renderTiles(); renderForm(); } };
    if (g && g.kind === 'web') {
      renderDashboard();
      if (g.gridOn && dashTab === 'buttons') showTileEditor();
    } else if (g && g.kind === 'app') {
      renderAppPage();
      const def = appDefs.find(a => a.id === g.app);
      if ((def && def.grid) || (g.gridOn && dashTab === 'buttons')) showTileEditor();
    } else {
      renderMeta();
      showTileEditor();
    }
  }

  // ---- groups (left list + slim editor) ----
  function renderGroups() {
    const el = document.getElementById('grouplist'); if (!el) return;
    el.innerHTML = '';
    const list = config.groups || [];
    if (!list.length) { el.innerHTML = '<p class="hint" style="margin:6px 4px">No groups yet. Use + Group to create one.</p>'; return; }
    list.forEach((g, i) => {
      const d = document.createElement('div');
      d.className = 'gridrow' + (view === 'groups' && i === groupIndex ? ' active' : '');
      const left = document.createElement('span'); left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden';
      const name = document.createElement('span'); name.textContent = '▦ ' + (g.name || '(unnamed)'); name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      left.appendChild(name); d.appendChild(left);
      d.onclick = () => { view = 'groups'; groupIndex = i; ti = -1; selEnd = -1; render(); };
      el.appendChild(d);
    });
  }
  function renderGroupMeta() {
    const g = curGroup(); const el = document.getElementById('gridmeta');
    if (!g) { el.innerHTML = '<p class="hint">No group selected. Use + Group to create one.</p>'; ['tilegrid','mergebar','tileform','iconpane'].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ''; }); return; }
    el.innerHTML = `
      <div class="row"><label>Name</label><input id="gName" value="${esc(g.name)}"></div>
      <div class="row"><label>Columns</label><input id="gCols" type="number" min="1" max="12" value="${g.cols}" style="width:90px">
        <label style="width:auto;margin-left:10px">Rows</label><input id="gRows" type="number" min="1" max="6" value="${g.rows}" style="width:90px"></div>
      <p class="hint">A reusable button layout. Apply it to any page with a grid (Pages tab → that page's <b>Group</b> row). Pages anchor a group top-left and pad or crop to fit.</p>
      <div class="row"><button class="danger" id="gDelete">Delete group</button></div>`;
    document.getElementById('gName').oninput = e => { g.name = e.target.value; renderGroups(); markDirty(); };
    document.getElementById('gCols').onchange = e => { clearAllMerges(g); g.cols = Math.max(1, Math.min(12, +e.target.value || 1)); ensureTiles(g); ti = -1; selEnd = -1; render(); markDirty(); };
    document.getElementById('gRows').onchange = e => { clearAllMerges(g); g.rows = Math.max(1, Math.min(6, +e.target.value || 1)); ensureTiles(g); ti = -1; selEnd = -1; render(); markDirty(); };
    document.getElementById('gDelete').onclick = deleteCurrentGroup;
  }
  function addGroup() {
    if (!Array.isArray(config.groups)) config.groups = [];
    const g = { id: uid(), name: 'New Group', cols: 3, rows: 2, tiles: [] };
    ensureTiles(g);
    config.groups.push(g);
    groupIndex = config.groups.length - 1; ti = -1; selEnd = -1;
    leftTab = 'groups'; view = 'groups';
    render(); markDirty();
  }
  // Read-only preview: when a page has Use grid group on AND the referenced group exists, render the
  // anchored tiles in #tilegrid (no click handlers) with a banner in the merge-bar slot pointing the
  // user to the group editor. The page's own g.tiles are left intact so unchecking Use grid group
  // restores the manual layout untouched.
  function renderGroupAppliedPreview(g) {
    const group = groupById(g.groupId);
    if (!group) { renderTiles(); renderForm(); return; }
    ['tileform', 'iconpane'].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ''; });
    const el = document.getElementById('tilegrid'); if (!el) return;
    const cw = el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 600;
    const cell = Math.max(48, Math.min(150, Math.floor((cw - (g.cols - 1) * 6) / g.cols)));
    el.style.gridTemplateColumns = `repeat(${g.cols}, ${cell}px)`;
    el.style.gridTemplateRows = `repeat(${g.rows}, ${cell}px)`;
    const tiles = anchorGroupTiles(group, g.cols, g.rows);
    el.innerHTML = '';
    tiles.forEach((t, i) => {
      if (t && t.cover != null) return;
      const c = i % g.cols, r = Math.floor(i / g.cols);
      const w = +(t && t.w) || 1, h = +(t && t.h) || 1;
      const empty = !t || !t.type;
      const d = document.createElement('div');
      d.className = 'cell' + (empty ? ' empty' : '') + ((w > 1 || h > 1) ? ' span' : '');
      d.style.gridColumn = `${c + 1} / span ${w}`;
      d.style.gridRow = `${r + 1} / span ${h}`;
      d.style.cursor = 'default';
      d.style.opacity = '0.85';
      if (!empty) d.innerHTML = iconHtml(t, 'cell') + `<div class="lb">${esc(t.label || '')}</div>`;
      el.appendChild(d);
    });
    const mb = document.getElementById('mergebar');
    if (mb) {
      mb.classList.remove('active');
      mb.innerHTML = `<p class="hint" style="margin:0">Tiles come from group <b>${esc(group.name || '(unnamed)')}</b> — <a href="#" id="goEditGroup" style="color:#7CFFB2">Edit group</a>. Uncheck <b>Use grid group</b> to edit this page's own tiles instead.</p>`;
      const link = document.getElementById('goEditGroup');
      if (link) link.onclick = (ev) => {
        ev.preventDefault();
        const idx = (config.groups || []).findIndex(x => x.id === g.groupId);
        if (idx >= 0) { groupIndex = idx; view = 'groups'; leftTab = 'groups'; ti = -1; selEnd = -1; render(); }
      };
    }
  }
  function deleteCurrentGroup() {
    const list = config.groups || [];
    if (groupIndex < 0 || groupIndex >= list.length) return;
    const removed = list[groupIndex];
    if (!window.confirm('Delete group "' + (removed.name || '(unnamed)') + '"? Any pages using it will fall back to their own tiles.')) return;
    // Clear references on pages that used this group.
    (config.grids || []).forEach(p => { if (p && p.groupId === removed.id) { delete p.groupId; delete p.useGroup; } });
    list.splice(groupIndex, 1);
    if (!list.length) { view = 'pages'; leftTab = 'pages'; groupIndex = -1; }
    else groupIndex = Math.min(groupIndex, list.length - 1);
    ti = -1; selEnd = -1; render(); markDirty();
  }

  // ---- settings page ----
  const DEFAULT_SETTINGS = { launchMode: 'editor', micOnLaunch: false, reservedDisplay: false };
  function appSettings() { return Object.assign({}, DEFAULT_SETTINGS, config.settings || {}); }
  function renderSettings() {
    ['tilegrid', 'mergebar', 'tileform', 'iconpane'].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ''; });
    const s = appSettings();
    const currentRot = () => { const r = Object.assign({ enabled: false, interval: 30 }, (config.settings || {}).rotation || {}); r.cats = Object.assign({ grids: false, dashboards: false, apps: false }, ((config.settings || {}).rotation || {}).cats || {}); return r; };
    const rot = currentRot();
    const currentFocusFollow = () => Object.assign({ enabled: false, pauseRotation: false }, (config.settings || {}).focusFollow || {});
    const focusFollow = currentFocusFollow();
    const currentDashReload = () => Object.assign({ hotkey: '' }, (config.settings || {}).dashboardReload || {});
    const dashReload = currentDashReload();
    const currentMon = () => Object.assign({ knobTurn: 'scroll', knobTap: 'enter' }, (config.settings || {}).monitor || {});
    const mon = currentMon();
    const currentTheme = () => Object.assign({ appearance: 'system', accent: '#7CFFB2', presets: ['#7CFFB2', '#38B6FF', '#FF4040', '#FFB000'] }, (config.settings || {}).theme || {});
    const th = currentTheme();
    // ledState = the device's live lighting (loaded when the page opens); fall back to saved config / defaults.
    const L = Object.assign({}, LED_DEFAULT, (config.settings || {}).lighting || {}, ledState || {});
    const effOpts = LED_EFFECTS.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join('');
    const tab = settingsTab;
    const el = document.getElementById('gridmeta');

    // Software tab — on launch + screen rotation
    const swHtml = `
      <p class="sectitle">On launch</p>
      <div class="row"><label style="width:auto">Editor window</label>
        <select id="sLaunch" style="width:230px">
          <option value="editor">Open the editor window</option>
          <option value="minimized">Open minimized to taskbar</option>
          <option value="tray">Tray only (no window)</option>
        </select></div>
      <p class="hint">The panel always activates on launch — this only controls the PC-side editor window. Tray-only hides it; reopen from the tray icon.</p>

      <p class="sectitle" style="margin-top:22px">Screen rotation</p>
      <div class="row"><label>Auto-rotate</label>
        <input type="checkbox" id="sRot" style="width:auto;flex:none"><span class="hint" style="margin:0 0 0 8px">cycle the panel through pages automatically</span></div>
      <div class="row"><label>Every</label>
        <input type="number" id="sRotInt" min="5" max="3600" value="${rot.interval}" style="width:90px"><span class="hint" style="margin:0 0 0 8px">seconds (5–3600)</span></div>
      <div class="row"><label>Include</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sRotG"> Grids</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sRotD"> Dashboards</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sRotA"> Apps</label></div>
      <div class="row"><label>Hotkey</label>
        <input id="sRotKey" readonly placeholder="click, then press keys" value="${esc(rot.hotkey || '')}" style="width:200px"${rot.enabled ? '' : ' disabled'}>
        <button id="sRotKeyClear" style="margin-left:8px"${rot.enabled ? '' : ' disabled'}>Clear</button></div>
      <p class="hint">A page rotates only if its category is ticked here <i>and</i> that page's own “Include in rotation” box is checked — the box appears on each page once its category is enabled. Start/stop any time from the knob menu (double-click) or the tray.</p>
      <p class="hint">The <b>hotkey</b> starts and pauses rotation from anywhere, even when open-quake isn't focused. Click the box and press a combo that includes a modifier (e.g. Ctrl+Alt+R). It's only live while Auto-rotate is on; if another app — or one of your page hotkeys — already owns the combo, it just won't fire.</p>

      <p class="sectitle" style="margin-top:22px">Desktop focus</p>
      <div class="row"><label>Auto-follow</label>
        <input type="checkbox" id="sFocus" style="width:auto;flex:none"><span class="hint" style="margin:0 0 0 8px">switch the panel to a page when its mapped app becomes focused on the PC</span></div>
      <div class="row"><label>While focused</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sFocusPauseRot" ${focusFollow.enabled ? '' : 'disabled'}> Pause auto-rotation</label></div>
      <p class="hint">Map apps to a page under that page's Advanced settings → “Focus trigger app(s)”. Detection polls in the background and only switches once the newly-focused app has held focus for a couple seconds, so quick alt-tabbing won't cause flicker — and manually navigating the panel away is never overridden; it only re-triggers on the next focus change. With <b>Pause auto-rotation</b> on, rotation holds off the moment a mapped app takes focus and picks back up the moment it loses focus.</p>

      <p class="sectitle" style="margin-top:22px">Dashboards</p>
      <div class="row"><label>Reload hotkey</label>
        <input id="sDashReloadKey" readonly placeholder="click, then press keys" value="${esc(dashReload.hotkey || '')}" style="width:200px">
        <button id="sDashReloadKeyClear" style="margin-left:8px">Clear</button></div>
      <p class="hint">A global combo that force-reloads the current dashboard page from anywhere, even when open-quake isn't focused. Switching away to another page and back does <b>not</b> reload a dashboard (that's what keeps its session/scroll state) — this hotkey is the way to force one. Only acts while a dashboard page is showing; does nothing on a grid or app page.</p>`;

    // Hardware tab — knob ring + microphone
    const hwHtml = `
      <p class="sectitle">Knob ring</p>
      <div class="row"><label>Effect</label>
        <select id="sEffect" style="width:230px">${effOpts}</select></div>
      <div class="row"><label>Color</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sLedOvr"> Override theme accent</label>
        <input type="color" id="sColor" value="${hsvToHex(L.hue, L.sat)}" style="width:48px;height:28px;padding:2px;margin-left:8px">
        <span id="sColorVal" class="hint" style="margin:0 0 0 8px">H${L.hue} S${L.sat}</span></div>
      <p class="hint" style="margin:-4px 0 0">The ring follows your theme accent by default — tick Override to set a fixed color here.</p>
      <div class="row"><label>Brightness</label>
        <input type="range" id="sBright" min="0" max="255" value="${L.brightness}" style="width:200px">
        <span id="sBrightVal" class="hint" style="margin:0 0 0 10px">${L.brightness}</span></div>
      <div class="row"><label>Effect speed</label>
        <input type="range" id="sSpeed" min="0" max="255" value="${L.speed}" style="width:200px">
        <span id="sSpeedVal" class="hint" style="margin:0 0 0 10px">${L.speed}</span></div>
      <div style="margin-top:6px"><label>Knob — turn / click / double-click</label></div>
      <div style="display:grid; grid-template-columns: 110px 1fr 1fr 1fr; gap:8px; align-items:center; margin-top:6px">
        <span></span>
        <span class="hint" style="font-weight:bold">Turn</span>
        <span class="hint" style="font-weight:bold">Click</span>
        <span class="hint" style="font-weight:bold">Double-click</span>
        <label>Grid</label>
        ${knobSelHtml('knGridTurn', KNOB_TURN_OPTS, knobOf('grid', 'turn'), 'width:100%')}
        ${knobSelHtml('knGridClick', KNOB_CLICK_OPTS, knobOf('grid', 'click'), 'width:100%')}
        ${knobSelHtml('knGridDblclick', KNOB_DBLCLICK_OPTS, knobOf('grid', 'dblclick'), 'width:100%')}
        <label>Dashboard</label>
        ${knobSelHtml('knDashTurn', KNOB_TURN_OPTS, knobOf('dashboard', 'turn'), 'width:100%')}
        ${knobSelHtml('knDashClick', KNOB_CLICK_OPTS, knobOf('dashboard', 'click'), 'width:100%')}
        ${knobSelHtml('knDashDblclick', KNOB_DBLCLICK_OPTS, knobOf('dashboard', 'dblclick'), 'width:100%')}
        <label>App</label>
        ${knobSelHtml('knAppTurn', KNOB_TURN_OPTS, knobOf('app', 'turn'), 'width:100%')}
        ${knobSelHtml('knAppClick', KNOB_CLICK_OPTS, knobOf('app', 'click'), 'width:100%')}
        ${knobSelHtml('knAppDblclick', KNOB_DBLCLICK_OPTS, knobOf('app', 'dblclick'), 'width:100%')}
      </div>
      <p class="hint">What turning / clicking the knob does on each kind of page. Any page can override this in its <b>Advanced</b> settings. (“Select button” highlights tiles as you turn; “Enter” activates the highlighted button, play/pauses music, or sends an Enter key.)</p>
      <p class="hint">Changes apply to the ring instantly. <b>Save to device</b> writes them to the device's own memory so they survive a power-cycle. (Effect “All Off” turns the ring off. Animated effects use the color/speed; solid effects ignore speed.)</p>
      <div class="row" style="margin-top:6px"><button id="sSaveLed">Save to device</button><span id="sSaveLedMsg" class="hint" style="margin:0 0 0 10px"></span></div>

      <p class="sectitle" style="margin-top:22px">Microphone</p>
      <div class="row"><label>At launch</label>
        <input type="checkbox" id="sMic" style="width:auto;flex:none"><span class="hint" style="margin:0 0 0 8px">enable the device mic when open-quake starts</span></div>
      <p class="hint">The mic LED and the mic audio are one hardware switch — the light is on whenever the mic is enabled, off when it isn't. Toggle it any time from the tray menu or a “System → mic” tile.</p>

      <p class="sectitle" style="margin-top:22px">Touchscreen</p>
      <p class="hint">If touches land on the wrong monitor, click <b>Set up touchscreen</b>. open-quake launches Windows' built-in touch-identify wizard (the one Microsoft buried behind the broken-in-24H2 Tablet PC Settings UI) — accept the UAC prompt, then <b>press Enter on your keyboard</b> to skip past your other monitors as the prompt cycles through them, and <b>tap the panel with your finger</b> only when the prompt appears on the panel. That writes a persistent binding under <code>HKLM\\…\\Wisp\\Pen\\Digimon</code> that survives reboot, sleep, and primary-display swaps.</p>
      <p class="hint"><b>Clear all calibrations</b> wipes any old <code>tabcal</code> coordinate calibration. You don't normally need it — only run it if your taps land on the right display but are visibly off-target.</p>
      <div class="row" style="gap:8px"><button id="sTouchSetup">Set up touchscreen</button><button id="sTouchClear">Clear all calibrations</button><span id="sTouchMsg" class="hint" style="margin:0 0 0 10px"></span></div>`;

    // Monitor tab — reserved-display protection and intentional normal-monitor behavior
    const monHtml = `
      <p class="sectitle">Reserved Display</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="sReserved" ${s.reservedDisplay ? 'checked' : ''}> Prevent normal application windows from remaining on the Quake display</label></div>
      <p class="hint">Windows only. Windows dragged or relocated onto the Quake are returned to another display. If your other displays disconnect, their positions are held and restored when a display returns. Open Quake, Windows shell surfaces, and secure desktop screens are left alone.</p>
      <p class="hint">Protection is suspended in Monitor Mode and resumes when Monitor Mode exits. This does not change the panel's USB keepalive.</p>

      <p class="sectitle" style="margin-top:22px">Monitor mode</p>
      <p class="hint">Use the device as a normal monitor: it shows your Windows desktop and touch acts as the mouse. Enter it from the tray menu or a “System → monitor” tile; exit from the tray. These set what the knob does while in monitor mode.</p>
      <div class="row"><label>Knob turn</label>
        <select id="sMonTurn" style="width:230px">
          <option value="scroll">Scroll</option>
          <option value="volume">Adjust volume</option>
        </select></div>
      <div class="row"><label>Knob tap</label>
        <select id="sMonTap" style="width:230px">
          <option value="enter">Enter</option>
          <option value="leftclick">Left-click</option>
          <option value="rightclick">Right-click</option>
          <option value="mute">Mute / unmute</option>
        </select></div>
      <p class="hint">A single knob press does the “tap” action. Double-press is unbound in monitor mode.</p>`;

    // Theme tab — global light/dark + accent color
    const thHtml = `
      <p class="sectitle">Appearance</p>
      <div class="row"><label>Mode</label>
        <select id="sAppear" style="width:230px">
          <option value="system">System (follow Windows)</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select></div>
      <p class="hint">Light/dark for the panel, the clocks, and the apps — and passed to web dashboards like a browser's light/dark. Each page can override this in its own <b>Advanced</b> section.</p>
      <p class="sectitle" style="margin-top:22px">Accent color</p>
      <div class="row"><label>Accent</label>
        <input type="color" id="sAccent" value="${esc(th.accent)}" style="width:54px;height:30px;padding:2px">
        <span id="sAccentVal" class="hint" style="margin:0 0 0 10px">${esc(th.accent)}</span></div>
      <div class="row"><label style="width:auto">Presets</label>
        <span id="sPresets" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></span>
        <button id="sPresetSave" style="margin-left:10px">＋ Save current</button></div>
      <p class="hint">Drives the clock digits/hands, the tile-tap highlight, the music play button, and the knob LED ring. Click a preset to apply; <i>Save current</i> stores it (up to 6); right-click a preset to remove it. Changes apply when you Save.</p>`;

    // Apps tab — show/hide which apps appear in the App picker (doesn't touch pages already using an app)
    const appRow = (a, checked) => `<div class="row">
        <label class="iconopt" style="width:auto; gap:9px"><input type="checkbox" class="appShow" data-id="${esc(a.id)}" data-dev="${a.dev ? 1 : 0}" ${checked ? 'checked' : ''}> ${esc(a.name)}</label>
      </div>`;
    const regularApps = appDefs.filter(a => !a.dev), devApps = appDefs.filter(a => a.dev);
    const appsHtml = `
      <p class="sectitle">Apps</p>
      <p class="hint">Untick an app to hide it from the <b>App</b> dropdown when building a page. This only changes what's offered — pages already using a hidden app keep working.</p>
      ${regularApps.length ? regularApps.map(a => appRow(a, !appHidden(a.id))).join('') : '<p class="hint">No apps found.</p>'}
      ${devApps.length ? `
        <label class="iconopt" style="width:auto; gap:9px; margin:22px 0 0"><input type="checkbox" id="devMaster" ${devEnabled() ? 'checked' : ''}> show developer apps</label>
        <p class="hint">Specified in apps.json.</p>
        ${devEnabled() ? devApps.map(a => appRow(a, devShown(a.id))).join('') : ''}` : ''}`;

    // Auth tab — credentials shared across the app (currently just Home Assistant). Token is stored
    // encrypted at rest via secretStore (same path as settings.spotify.refreshToken).
    const ha = (s.haAuth && typeof s.haAuth === 'object') ? s.haAuth : { url: '', token: '', useHa: false };
    const authHtml = `
      <p class="sectitle">Home Assistant</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="sHaUse" ${ha.useHa ? 'checked' : ''}> Use Home Assistant</label>
        <button id="sHaRefresh" type="button" style="margin-left:12px" ${ha.useHa ? '' : 'disabled'}>Refresh Configuration</button>
        <span id="sHaStatus" class="hint" style="margin:0 0 0 10px"></span></div>
      <p class="hint">When on, open-quake caches your HA dashboards, areas, devices, entities, floors, and labels at startup. The Home Assistant Dashboard app and (later) entity-aware features depend on this cache.</p>
      <div class="row"><label>URL</label>
        <input type="text" id="sHaUrl" value="${esc(ha.url || '')}" placeholder="http://homeassistant.local:8123" style="flex:1"></div>
      <div class="row"><label>Long-Lived Access Token</label>
        <input type="password" id="sHaToken" value="${esc(ha.token || '')}" placeholder="paste your long-lived access token" style="flex:1"></div>
      <p class="hint">The token is stored encrypted at rest (same secret store as your dashboard tokens). It only leaves the main process for features that need it.</p>

      <p class="sectitle" style="margin-top:22px">OAuth 2.0</p>
      <p class="hint">Connect services once for built-in integrations. OAuth tokens stay in the main process, are encrypted at rest, and are refreshed before expiry; drop-in apps cannot request them.</p>
      <div id="sOauthList"><p class="hint">Loading OAuth providers...</p></div>`;

    // Drop-In Apps tab — manage user-installed app folders (import/export/delete) + storage location
    const diHtml = `
      <p class="sectitle">Drop-In Apps</p>
      <p class="hint">Self-contained app folders you add yourself — import a .zip, export one to share, or delete it. Bundled / built-in apps aren't listed here.</p>
      <div class="row" style="gap:8px"><button id="diAdd">Add (import .zip)…</button><button id="diRefresh">Refresh</button><button id="diCommunity" style="margin-left:auto">Community apps ↗</button></div>
      <div id="diMsg" class="hint" style="margin:6px 0;min-height:18px"></div>
      <div id="diList"><p class="hint">Loading…</p></div>
      <details class="advsec" style="margin-top:16px"><summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Advanced settings</summary>
        <div class="row" style="margin-top:8px"><label style="width:auto">Storage location</label>
          <select id="diLoc" style="width:auto">
            <option value="appdata">%APPDATA%\\open-quake</option>
            <option value="localappdata">%LOCALAPPDATA%\\open-quake</option>
          </select></div>
        <p class="hint" id="diLocPath" style="margin:2px 0 0"></p>
        <p class="hint">Where imported drop-in apps are stored — this folder survives app updates (the install folder doesn't).</p>
      </details>`;

    el.innerHTML = `
      <p class="sectitle">Settings</p>
      <div class="tabbar">
        <button id="tabSw" class="tab${tab === 'software' ? ' on' : ''}">Software</button>
        <button id="tabHw" class="tab${tab === 'hardware' ? ' on' : ''}">Hardware</button>
        <button id="tabTh" class="tab${tab === 'theme' ? ' on' : ''}">Theme</button>
        <button id="tabApps" class="tab${tab === 'apps' ? ' on' : ''}">Apps</button>
        <button id="tabDi" class="tab${tab === 'dropin' ? ' on' : ''}">Drop-In Apps</button>
        <button id="tabAuth" class="tab${tab === 'auth' ? ' on' : ''}">Auth</button>
        <button id="tabMon" class="tab${tab === 'monitor' ? ' on' : ''}">Monitor</button>
      </div>
      ${tab === 'software' ? swHtml : tab === 'hardware' ? hwHtml : tab === 'theme' ? thHtml : tab === 'apps' ? appsHtml : tab === 'dropin' ? diHtml : tab === 'auth' ? authHtml : monHtml}
      <div class="row" style="margin-top:22px"><button id="sBack">← Back to pages</button></div>`;

    document.getElementById('tabSw').onclick = () => { settingsTab = 'software'; renderSettings(); };
    document.getElementById('tabHw').onclick = () => { settingsTab = 'hardware'; renderSettings(); };
    document.getElementById('tabTh').onclick = () => { settingsTab = 'theme'; renderSettings(); };
    document.getElementById('tabApps').onclick = () => { settingsTab = 'apps'; renderSettings(); };
    document.getElementById('tabDi').onclick = () => { settingsTab = 'dropin'; renderSettings(); };
    document.getElementById('tabAuth').onclick = () => { settingsTab = 'auth'; renderSettings(); };
    document.getElementById('tabMon').onclick = () => { settingsTab = 'monitor'; renderSettings(); };
    document.getElementById('sBack').onclick = () => { view = 'pages'; render(); };
    const setS = (k, v) => { if (!config.settings) config.settings = {}; config.settings[k] = v; markDirty(); };

    if (tab === 'apps') {
      el.querySelectorAll('.appShow').forEach(c => c.onchange = e => {
        const id = e.target.dataset.id, isDev = e.target.dataset.dev === '1';
        if (!config.settings) config.settings = {};
        if (isDev) {   // developer app: tracked when SHOWN (default hidden)
          const shown = (config.settings.shownDevApps || []).filter(x => x !== id);
          if (e.target.checked) shown.push(id);
          config.settings.shownDevApps = shown;
        } else {       // regular app: tracked when HIDDEN (default shown)
          const hidden = (config.settings.hiddenApps || []).filter(x => x !== id);
          if (!e.target.checked) hidden.push(id);
          config.settings.hiddenApps = hidden;
        }
        markDirty();
      });
      const dm = document.getElementById('devMaster');   // master: just reveals the developer-app list in this tab
      if (dm) dm.onchange = e => { if (!config.settings) config.settings = {}; config.settings.devApps = e.target.checked; markDirty(); renderSettings(); };
    }

    if (tab === 'dropin') {
      let importZipPath = null;   // held across an id-conflict rename retry
      const diMsg = (t, bad) => { const m = document.getElementById('diMsg'); if (m) { m.textContent = t || ''; m.style.color = bad ? '#c98' : '#7e93ab'; } };
      const renderList = async () => {
        const host = document.getElementById('diList'); if (!host) return;
        let apps = []; try { apps = (await configApi.listDropInApps()) || []; } catch (e) {}
        if (!apps.length) { host.innerHTML = '<p class="hint">No drop-in apps installed yet.</p>'; return; }
        host.innerHTML = apps.map(a => `<div class="row" style="gap:8px;align-items:center">
            <span style="flex:1">${esc(a.name)} <span class="hint">(${esc(a.id)}${a.served ? ' · served' : ''}${a.hasServer ? ' · server' : ''}${a.managed ? '' : ' · read-only'})</span></span>
            <button class="diExport" data-id="${esc(a.id)}">Export…</button>
            <button class="diDelete danger" data-id="${esc(a.id)}" ${a.managed ? '' : 'disabled'}>Delete</button>
          </div>`).join('');
        host.querySelectorAll('.diExport').forEach(b => b.onclick = async e => { const r = await configApi.exportDropInApp(e.currentTarget.dataset.id); diMsg(r && r.ok ? 'Exported to ' + r.path : (r && r.canceled ? '' : 'Export failed: ' + ((r && r.error) || '')), !(r && r.ok)); });
        host.querySelectorAll('.diDelete').forEach(b => b.onclick = async e => {
          const id = e.currentTarget.dataset.id;
          if (!window.confirm('Delete drop-in app "' + id + '" and its folder?')) return;
          const r = await configApi.deleteDropInApp(id);
          if (r && r.ok) { diMsg('Deleted ' + id); appDefs = await configApi.getApps(); renderList(); } else diMsg('Delete failed: ' + ((r && r.error) || ''), true);
        });
      };
      const promptId = (suggested) => new Promise(resolve => {
        const m = document.getElementById('diMsg'); m.style.color = '#c98';
        m.innerHTML = 'App id "' + esc(suggested) + '" already exists — pick a new id: <input id="diNewId" value="' + esc(suggested) + '" style="width:150px"> <button id="diNewOk">Import</button> <button id="diNewCancel">Cancel</button>';
        const inp = document.getElementById('diNewId'); inp.focus(); inp.select();
        const fin = v => { m.innerHTML = ''; m.style.color = ''; resolve(v); };
        document.getElementById('diNewOk').onclick = () => fin((inp.value || '').trim() || null);
        document.getElementById('diNewCancel').onclick = () => fin(null);
        inp.onkeydown = ev => { if (ev.key === 'Enter') document.getElementById('diNewOk').click(); else if (ev.key === 'Escape') fin(null); };
      });
      const doImport = async (forceId, confirmExec) => {
        if (!importZipPath) importZipPath = await configApi.pickZip();
        if (!importZipPath) return;
        const r = await configApi.importDropInApp(importZipPath, forceId, confirmExec);
        if (r && r.ok) { importZipPath = null; appDefs = await configApi.getApps(); renderList(); diMsg('Imported "' + r.name + '" (' + r.id + ')'); }
        else if (r && r.warnExec && !confirmExec) {
          if (window.confirm('This drop-in app contains executable code' + (r.server ? ' (a server module)' : ' (programs/scripts)') + ' that runs on your PC with full access. Only import it if you trust the source.\n\nImport anyway?')) doImport(forceId, true);
          else importZipPath = null;
        }
        else if (r && r.conflict) { const newId = await promptId(r.id); if (newId) doImport(newId, confirmExec); else importZipPath = null; }
        else { importZipPath = null; diMsg('Import failed: ' + ((r && r.error) || 'unknown error'), true); }
      };
      document.getElementById('diAdd').onclick = () => { importZipPath = null; doImport(); };
      document.getElementById('diRefresh').onclick = () => renderList();
      document.getElementById('diCommunity').onclick = () => configApi.openExternal('https://github.com/TeeJS/open-quake/tree/main/community-apps');
      configApi.getDropInInfo().then(info => { if (!info) return; const s2 = document.getElementById('diLoc'); if (s2) s2.value = info.location; const p = document.getElementById('diLocPath'); if (p) p.textContent = info.dir; });
      document.getElementById('diLoc').onchange = async e => {
        const info = await configApi.setDropInLocation(e.target.value);
        if (!config.settings) config.settings = {}; config.settings.dropInLocation = e.target.value;   // keep the editor copy in sync so a full Save won't revert it
        const p = document.getElementById('diLocPath'); if (info && p) p.textContent = info.dir;
        renderList();
      };
      renderList();
    }

    if (tab === 'auth') {
      const saveHa = patch => {
        if (!config.settings) config.settings = {};
        const cur = (config.settings.haAuth && typeof config.settings.haAuth === 'object') ? config.settings.haAuth : { url: '', token: '', useHa: false };
        config.settings.haAuth = Object.assign({ url: '', token: '', useHa: false }, cur, patch);
        markDirty();
      };
      const useBox = document.getElementById('sHaUse');
      const refBtn = document.getElementById('sHaRefresh');
      const statusEl = document.getElementById('sHaStatus');
      const fmtAge = ts => {
        if (!ts) return 'never';
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.round(s / 60) + ' min ago';
        return Math.round(s / 3600) + ' h ago';
      };
      const showStatus = c => {
        if (!c) { statusEl.textContent = ''; return; }
        if (!c.ts) { statusEl.textContent = 'Not loaded yet.'; statusEl.style.color = '#7e93ab'; return; }
        if (!c.ok) { statusEl.textContent = 'Error: ' + (c.error || 'unknown') + ' (' + fmtAge(c.ts) + ')'; statusEl.style.color = '#c98'; return; }
        statusEl.textContent = (c.dashboards.length + ' dashboards, ' + c.entities.length + ' entities, ' + c.areaRegistry.length + ' areas, ' + c.deviceRegistry.length + ' devices') + (c.floorRegistry.length ? ', ' + c.floorRegistry.length + ' floors' : '') + (c.labelRegistry.length ? ', ' + c.labelRegistry.length + ' labels' : '') + ' (' + fmtAge(c.ts) + ')';
        statusEl.style.color = '#7e93ab';
      };
      const refresh = async () => {
        refBtn.disabled = true;
        // Main reads useHa / URL / token from its in-memory config, which only updates on Save.
        // Auto-save first so toggling Use HA and clicking Refresh "just works" without remembering
        // to Save between. IPC is ordered, so the save (ipc.send) is processed before the refresh
        // (ipc.invoke) reaches main's handler.
        if (dirty) {
          statusEl.textContent = 'Saving, then refreshing…'; statusEl.style.color = '#7e93ab';
          if (!await doSave()) throw new Error('settings were not saved securely');
        }
        else { statusEl.textContent = 'Refreshing…'; statusEl.style.color = '#7e93ab'; }
        try {
          const c = await configApi.refreshHaCache();
          haCacheLocal = c;                                           // keep iconHtml in sync with main
          Object.keys(haStateCache).forEach(k => delete haStateCache[k]);   // states may have changed; force re-fetch on next render
          showStatus(c);
          renderTiles();                                              // any HA-icon tiles re-resolve with the new data
        }
        catch (e) { statusEl.textContent = 'Refresh failed: ' + (e.message || e); statusEl.style.color = '#c98'; }
        finally { refBtn.disabled = !useBox.checked; }
      };
      useBox.onchange = e => {
        saveHa({ useHa: e.target.checked });
        refBtn.disabled = !e.target.checked;
        if (!e.target.checked) { statusEl.textContent = 'Use HA is off. Save to clear the cache on next launch.'; statusEl.style.color = '#7e93ab'; }
        else statusEl.textContent = 'Click Refresh Configuration to load.';
      };
      refBtn.onclick = refresh;
      document.getElementById('sHaUrl').oninput = e => saveHa({ url: e.target.value.trim() });
      document.getElementById('sHaToken').oninput = e => saveHa({ token: e.target.value.trim() });
      configApi.getHaCache().then(showStatus);   // initial status from whatever main has cached

      let oauthPoll = null;
      const oauthMsg = (id, text, bad) => {
        const el = document.getElementById('oauthMsg_' + id);
        if (el) { el.textContent = text || ''; el.style.color = bad ? '#c98' : '#7e93ab'; }
      };
      const fmtExpiry = ts => {
        if (!ts) return 'not connected';
        const mins = Math.round((Number(ts) - Date.now()) / 60000);
        if (mins < 0) return 'expired';
        if (mins < 60) return 'expires in ' + mins + ' min';
        return 'expires in ' + Math.round(mins / 60) + ' h';
      };
      const renderOauth = async () => {
        const host = document.getElementById('sOauthList'); if (!host) return;
        let providers = [];
        try { providers = await configApi.listOAuthProviders(); } catch (e) {}
        if (!providers.length) { host.innerHTML = '<p class="hint">No OAuth providers available.</p>'; return; }
        host.innerHTML = providers.map(p => `
          <div class="advsec" style="margin-top:10px;padding:10px;border:1px solid #213145;border-radius:8px">
            <div class="row" style="gap:8px;align-items:center">
              <label style="width:auto;font-weight:bold">${esc(p.name || p.provider)}</label>
              <span class="hint" style="margin:0">${p.connected ? 'Connected, ' + esc(fmtExpiry(p.expiresAt)) : (p.configured ? 'Ready to connect' : 'Not configured')}</span>
              <span id="oauthMsg_${esc(p.provider)}" class="hint" style="margin:0 0 0 auto"></span>
            </div>
            ${p.managedClient ? '<div class="row"><label>Application</label><span class="hint" style="margin:0">Built into Open-Quake</span></div>' : ''}
            <div class="row"><label>Scopes</label><span class="hint" style="margin:0">${esc((p.scopes || []).join(' '))}</span></div>
            <div class="row" style="gap:8px">
              <button class="oauthConnect" data-provider="${esc(p.provider)}" ${p.enabled ? '' : 'disabled'}>${p.connected ? 'Reconnect' : 'Connect'}</button>
              <button class="oauthDisconnect danger" data-provider="${esc(p.provider)}" ${p.connected && p.enabled ? '' : 'disabled'}>Disconnect</button>
              ${p.enabled ? '' : '<span class="hint" style="margin:0">Framework placeholder</span>'}
            </div>
          </div>`).join('');
        host.querySelectorAll('.oauthConnect').forEach(btn => {
          btn.onclick = async e => {
            const id = e.currentTarget.dataset.provider;
            e.currentTarget.disabled = true;
            oauthMsg(id, 'Opening browser...');
            const r = await configApi.connectOAuthProvider(id, ['User.Read', 'Presence.Read', 'Calendars.Read', 'offline_access']);
            oauthMsg(id, r && r.ok ? 'Finish sign-in in your browser.' : 'Connect failed: ' + ((r && r.error) || ''), !(r && r.ok));
            e.currentTarget.disabled = false;
            if (oauthPoll) clearInterval(oauthPoll);
            let tries = 0;
            oauthPoll = setInterval(() => { tries += 1; renderOauth(); if (tries >= 15) { clearInterval(oauthPoll); oauthPoll = null; } }, 2000);
          };
        });
        host.querySelectorAll('.oauthDisconnect').forEach(btn => {
          btn.onclick = async e => {
            const id = e.currentTarget.dataset.provider;
            if (!window.confirm('Disconnect ' + id + ' and remove stored OAuth tokens?')) return;
            oauthMsg(id, 'Disconnecting...');
            const r = await configApi.disconnectOAuthProvider(id);
            oauthMsg(id, r && r.ok ? 'Disconnected' : 'Disconnect failed: ' + ((r && r.error) || ''), !(r && r.ok));
            renderOauth();
          };
        });
      };
      renderOauth();
    }

    if (tab === 'software') {
      document.getElementById('sLaunch').value = s.launchMode;
      document.getElementById('sLaunch').onchange = e => setS('launchMode', e.target.value);
      const saveRot = r => { if (!config.settings) config.settings = {}; config.settings.rotation = r; markDirty(); };
      const rotKey = document.getElementById('sRotKey'), rotKeyClr = document.getElementById('sRotKeyClear');
      document.getElementById('sRot').checked = !!rot.enabled;
      document.getElementById('sRotG').checked = !!rot.cats.grids;
      document.getElementById('sRotD').checked = !!rot.cats.dashboards;
      document.getElementById('sRotA').checked = !!rot.cats.apps;
      // The hotkey only registers while auto-rotate is on (main.js applyShortcuts), so grey it out with the
      // toggle — same pattern as "Pause auto-rotation" under Desktop focus below.
      document.getElementById('sRot').onchange = e => { const r = currentRot(); r.enabled = e.target.checked; saveRot(r); rotKey.disabled = rotKeyClr.disabled = !e.target.checked; };
      rotKey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { const r = currentRot(); r.hotkey = acc; rotKey.value = acc; saveRot(r); } };
      rotKeyClr.onclick = () => { const r = currentRot(); delete r.hotkey; rotKey.value = ''; saveRot(r); };
      document.getElementById('sRotInt').onchange = e => { const r = currentRot(); r.interval = Math.max(5, Math.min(3600, parseInt(e.target.value, 10) || 30)); e.target.value = r.interval; saveRot(r); };
      document.getElementById('sRotG').onchange = e => { const r = currentRot(); r.cats.grids = e.target.checked; saveRot(r); };
      document.getElementById('sRotD').onchange = e => { const r = currentRot(); r.cats.dashboards = e.target.checked; saveRot(r); };
      document.getElementById('sRotA').onchange = e => { const r = currentRot(); r.cats.apps = e.target.checked; saveRot(r); };
      const saveFocusFollow = f => { if (!config.settings) config.settings = {}; config.settings.focusFollow = f; markDirty(); };
      document.getElementById('sFocus').checked = !!focusFollow.enabled;
      document.getElementById('sFocus').onchange = e => {
        const f = currentFocusFollow(); f.enabled = e.target.checked; saveFocusFollow(f);
        document.getElementById('sFocusPauseRot').disabled = !e.target.checked;
      };
      document.getElementById('sFocusPauseRot').checked = !!focusFollow.pauseRotation;
      document.getElementById('sFocusPauseRot').onchange = e => { const f = currentFocusFollow(); f.pauseRotation = e.target.checked; saveFocusFollow(f); };

      const saveDashReload = d => { if (!config.settings) config.settings = {}; config.settings.dashboardReload = d; markDirty(); };
      const dashReloadKey = document.getElementById('sDashReloadKey'), dashReloadKeyClr = document.getElementById('sDashReloadKeyClear');
      dashReloadKey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { const d = currentDashReload(); d.hotkey = acc; dashReloadKey.value = acc; saveDashReload(d); } };
      dashReloadKeyClr.onclick = () => { const d = currentDashReload(); delete d.hotkey; dashReloadKey.value = ''; saveDashReload(d); };

    } else if (tab === 'hardware') {
      // Lighting writes go straight to the device (and persist in config) via the main process — no Save needed.
      const live = patch => { Object.assign(L, patch); if (!config.settings) config.settings = {}; config.settings.lighting = Object.assign({}, L); configApi.setLighting(patch); markDirty(); };
      const sOvr = document.getElementById('sLedOvr'), sColEl = document.getElementById('sColor');
      const ovrNow = !!(((config.settings || {}).lighting || {}).accentOverride);
      sOvr.checked = ovrNow; sColEl.disabled = !ovrNow;
      sOvr.onchange = e => { live({ accentOverride: e.target.checked }); sColEl.disabled = !e.target.checked; };
      document.getElementById('sEffect').value = String(L.effect);
      document.getElementById('sMic').checked = !!s.micOnLaunch;
      document.getElementById('sMic').onchange = e => setS('micOnLaunch', e.target.checked);
      const tMsg = document.getElementById('sTouchMsg');
      const tBtn = document.getElementById('sTouchSetup');
      const tClr = document.getElementById('sTouchClear');
      if (tBtn) tBtn.onclick = async () => {
        tBtn.disabled = true; tMsg.textContent = 'Launching wizard — accept UAC, then press Enter to skip past other monitors, tap the panel when its prompt appears there.'; tMsg.style.color = '#7e93ab';
        try {
          const r = await configApi.setupTouchscreen();
          if (r && r.ok) { tMsg.textContent = 'Wizard finished. Touch should now go to the panel.'; tMsg.style.color = '#7CFFB2'; }
          else { tMsg.textContent = (r && r.error) || 'Setup failed.'; tMsg.style.color = '#c98'; }
        } catch (e) { tMsg.textContent = 'Setup failed: ' + (e.message || e); tMsg.style.color = '#c98'; }
        finally { tBtn.disabled = false; }
      };
      if (tClr) tClr.onclick = async () => {
        if (!window.confirm('Clear touch calibration on every display? You\'ll need to run Set up touchscreen after.')) return;
        tClr.disabled = true; tMsg.textContent = 'Clearing calibrations…'; tMsg.style.color = '#7e93ab';
        try {
          const r = await configApi.clearTouchCalibration();
          if (r && r.ok) { tMsg.textContent = 'Approve the UAC prompt to clear all calibrations.'; tMsg.style.color = '#7e93ab'; }
          else { tMsg.textContent = (r && r.error) || 'Clear failed.'; tMsg.style.color = '#c98'; }
        } catch (e) { tMsg.textContent = 'Clear failed: ' + (e.message || e); tMsg.style.color = '#c98'; }
        finally { tClr.disabled = false; }
      };
      document.getElementById('sEffect').onchange = e => live({ effect: parseInt(e.target.value, 10) });
      const cv = document.getElementById('sColorVal');
      document.getElementById('sColor').onchange = e => { const { hue, sat } = hexToHsv(e.target.value); cv.textContent = `H${hue} S${sat}`; live({ hue, sat, accentOverride: true }); sOvr.checked = true; sColEl.disabled = false; };
      const bv = document.getElementById('sBrightVal');
      document.getElementById('sBright').oninput = e => { bv.textContent = e.target.value; };
      document.getElementById('sBright').onchange = e => live({ brightness: parseInt(e.target.value, 10) });
      const sv = document.getElementById('sSpeedVal');
      document.getElementById('sSpeed').oninput = e => { sv.textContent = e.target.value; };
      document.getElementById('sSpeed').onchange = e => live({ speed: parseInt(e.target.value, 10) });
      document.getElementById('sSaveLed').onclick = async () => {
        const msg = document.getElementById('sSaveLedMsg'); msg.textContent = 'saving…';
        const ok = await configApi.saveLightingToDevice();
        msg.textContent = ok ? 'saved to device ✓' : 'save failed';
      };
      // Knob behavior per page-type
      const setKnob = (type, field, val) => {
        if (!config.settings) config.settings = {};
        if (!config.settings.knob) config.settings.knob = {};
        if (!config.settings.knob[type]) config.settings.knob[type] = { turn: 'pages', click: 'rotation', dblclick: 'selector' };
        config.settings.knob[type][field] = val; markDirty();
      };
      [['grid', 'knGrid'], ['dashboard', 'knDash'], ['app', 'knApp']].forEach(([type, id]) => {
        document.getElementById(id + 'Turn').onchange = e => setKnob(type, 'turn', e.target.value);
        document.getElementById(id + 'Click').onchange = e => setKnob(type, 'click', e.target.value);
        document.getElementById(id + 'Dblclick').onchange = e => setKnob(type, 'dblclick', e.target.value);
      });
    } else if (tab === 'monitor') {
      // Monitor mode — knob turn/tap behavior (applied by the main process while in monitor mode)
      document.getElementById('sReserved').onchange = e => setS('reservedDisplay', e.target.checked);
      const saveMon = patch => { if (!config.settings) config.settings = {}; config.settings.monitor = Object.assign(currentMon(), patch); markDirty(); };
      document.getElementById('sMonTurn').value = mon.knobTurn;
      document.getElementById('sMonTap').value = mon.knobTap;
      document.getElementById('sMonTurn').onchange = e => saveMon({ knobTurn: e.target.value });
      document.getElementById('sMonTap').onchange = e => saveMon({ knobTap: e.target.value });
    } else {
      // Theme — global appearance + accent (applied on Save, via the main process)
      const saveTheme = patch => { if (!config.settings) config.settings = {}; config.settings.theme = Object.assign(currentTheme(), patch); markDirty(); };
      const av = document.getElementById('sAccentVal');
      document.getElementById('sAppear').value = th.appearance;
      document.getElementById('sAppear').onchange = e => saveTheme({ appearance: e.target.value });
      document.getElementById('sAccent').oninput = e => { av.textContent = e.target.value; };
      document.getElementById('sAccent').onchange = e => saveTheme({ accent: e.target.value });
      const renderPresets = () => {
        const wrap = document.getElementById('sPresets'); wrap.innerHTML = '';
        (currentTheme().presets || []).forEach((p, i) => {
          const b = document.createElement('button');
          b.title = p + ' (right-click to remove)';
          b.style.cssText = 'width:26px;height:26px;padding:0;border-radius:6px;border:1px solid #2b3c50;background:' + p;
          b.onclick = () => { document.getElementById('sAccent').value = p; av.textContent = p; saveTheme({ accent: p }); };
          b.oncontextmenu = ev => { ev.preventDefault(); const pr = (currentTheme().presets || []).slice(); pr.splice(i, 1); saveTheme({ presets: pr }); renderPresets(); };
          wrap.appendChild(b);
        });
      };
      renderPresets();
      document.getElementById('sPresetSave').onclick = () => {
        const cur = document.getElementById('sAccent').value;
        let pr = (currentTheme().presets || []).slice();
        if (!pr.includes(cur)) { pr.push(cur); if (pr.length > 6) pr = pr.slice(pr.length - 6); }
        saveTheme({ presets: pr }); renderPresets();
      };
    }
  }

  function addPage(kind) {
    view = 'pages';
    let g;
    if (kind === 'web') g = { id: uid(), name: 'Dashboard', kind: 'web', url: '', auth: { type: 'none' } };
    else if (kind === 'app') g = { id: uid(), name: 'App', kind: 'app', app: '', options: {} };
    else { g = { id: uid(), name: 'New Grid', kind: 'grid', cols: 8, rows: 2, tiles: [] }; ensureTiles(g); }
    config.grids.push(g); gi = config.grids.length - 1; ti = -1; render(); markDirty();
  }
  document.getElementById('addGrid').onclick = () => addPage('grid');
  document.getElementById('addDash').onclick = () => addPage('web');
  document.getElementById('addApp').onclick = () => addPage('app');
  document.getElementById('addGroup').onclick = () => addGroup();
  document.getElementById('lTabPages').onclick = () => { leftTab = 'pages'; render(); };
  document.getElementById('lTabGroups').onclick = () => { leftTab = 'groups'; render(); };
  document.getElementById('saveBtn').onclick = doSave;
  document.getElementById('settingsBtn').onclick = async () => {
    view = view === 'settings' ? 'pages' : 'settings';
    if (view === 'settings') { ledState = null; try { ledState = await configApi.getLighting(); } catch (e) {} }
    render();
  };
  window.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) doSave(); } });

  // ---- page-list sidebar width: drag #colsplit to resize, remembered across launches ----
  (function wireSidebarResize() {
    const gridsEl = document.querySelector('.grids');
    const split = document.getElementById('colsplit');
    if (!gridsEl || !split) return;
    const MIN = 180, MAX = 480;
    const saved = parseInt(localStorage.getItem('oq_sidebar_width'), 10);
    if (saved >= MIN && saved <= MAX) gridsEl.style.width = saved + 'px';
    let dragging = false, startX = 0, startW = 0;
    split.addEventListener('mousedown', e => {
      dragging = true; startX = e.clientX; startW = gridsEl.getBoundingClientRect().width;
      split.classList.add('dragging'); document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const w = Math.max(MIN, Math.min(MAX, startW + (e.clientX - startX)));
      gridsEl.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; split.classList.remove('dragging'); document.body.style.userSelect = '';
      localStorage.setItem('oq_sidebar_width', Math.round(gridsEl.getBoundingClientRect().width));
    });
  })();

  (async () => {
    config = await configApi.getConfig(); if (!config.grids) config.grids = [];
    if (!Array.isArray(config.groups)) config.groups = [];
    try { const v = await configApi.getAppVersion(); const el = document.getElementById('appVer'); if (el && v) el.textContent = 'v' + v; } catch (e) {}
    try { appDefs = await configApi.getApps(); } catch (e) {}
    try { haCacheLocal = await configApi.getHaCache(); } catch (e) {}   // for iconHtml's HA icon resolution
    render(); setState('');
  })();
