  const configApi = window.openQuakeConfig;
  const VOICE_APPS = ['ai-voice'];   // apps with STT/TTS voice (one app, five backends)
  // Mirrors DEFAULT_CLEANUP_PROMPT + REWRITE_PRESETS in lucidtypeAI.js — pre-filled in the editable prompt boxes.
  const LT_DEFAULT_CLEANUP_PROMPT = "Fix the grammar, spelling, and punctuation in the user's text. Preserve the author's original wording, tone, and voice as much as possible. Remove filler words (uh, er, ah, um, mm, like when unnecessary), combine fragmented or run-on sentences into clear ones, and drop false starts and repeated words, while keeping the original meaning and voice. Output only the corrected text, with no preamble, quotes, or explanation.";
  const LT_REWRITE_PRESETS = {
    professional: "Rewrite the user's text in a clear, professional tone suitable for workplace communication. Fix grammar and punctuation, keep the original meaning, and avoid slang. Output only the rewritten text.",
    concise: "Rewrite the user's text to be as concise as possible without losing meaning. Cut redundancy and filler; keep it clear and correct. Output only the rewritten text.",
    confident: "Rewrite the user's text in a confident, direct, assertive tone. Remove hedging and qualifiers, fix grammar, and keep the original meaning. Output only the rewritten text.",
  };
  let config = { activeGridId: null, grids: [] };
  let baseConfig = null;   // config as of the last load/save — the base for merging external writes into a dirty editor
  const snapConfig = o => JSON.parse(JSON.stringify(o));
  let gi = 0, ti = -1, selEnd = -1, dragFrom = -1, dirty = false, appDefs = [], view = 'pages', ledState = null, settingsTab = 'software', dashTab = 'page';
  let voiceModes = null;   // { claude:[{id,label}], codex:[...], copilot:[...], owui:[], api:[] } — lazy-loaded for the Routines tab's Mode picker
  let selRoutineId = null, routineQuery = '';   // Routines tab master-detail: selection tracked by stable id, plus the search box text
  // Left sidebar tab (Pages vs Groups vs Panes list) + which group/pane is being edited.
  let leftTab = 'pages', groupIndex = -1, paneIndex = -1, paneSlotDragFrom = -1, paneSlotDragCol = '';
  // Per-page Advanced <details> open state — persisted across re-renders so toggling an override
  // checkbox inside it (which calls render()) doesn't collapse the section out from under the user.
  let advOpen = false;
  let ltMeterStop = null;   // teardown for the LucidType mic test meter (getUserMedia); stopped on any editor re-render
  let githubAuthPollTimer = null;   // device-flow poll while the GitHub app's editor setup is visible
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
  const TYPES = [['', 'Empty'], ['app', 'App / Program'], ['url', 'Website (URL)'], ['page', 'Go to open-quake page'], ['cmd', 'Shell command'], ['open', 'Open file/folder'], ['system', 'System (lock/config)'], ['counter', 'Counter'], ['paste_text', 'Paste Text'], ['key', 'Send keystroke'], ['macro', 'Macro / Steps'], ['ha', 'HA entity'], ['routine', 'AI Routine'], ['obs', 'OBS Studio']];
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
  const STEP_KINDS = [['key', 'Keystroke'], ['text', 'Type text'], ['delay', 'Delay (ms)'], ['app', 'App / Program'], ['open', 'Open file/folder'], ['url', 'Website (URL)'], ['cmd', 'Shell command'], ['page', 'Go to page'], ['system', 'System'], ['ahk', 'AutoHotkey'], ['routine', 'AI Routine']];
  // Knob behavior options (per page-type, with per-page override). Defaults: turn=Scroll pages, click=Start/stop rotation.
  // 'app' hands the gesture to the served page's window.oqKnob (generic drop-in knob capability);
  // pages that don't handle it fall back to the base behavior, so it's always safe to pick.
  const KNOB_TURN_OPTS = [['pages', 'Scroll pages'], ['volume', 'System volume'], ['scroll', 'Scroll in window'], ['select', 'Select button'], ['app', 'App controlled']];
  const KNOB_CLICK_OPTS = [
    ['rotation', 'Toggle rotation'],
    ['rotation_start', 'Start rotation'],
    ['rotation_stop', 'Stop rotation'],
    ['mute', 'System audio toggle'],
    ['enter', 'Enter'],
    ['home', 'Go to home page'],
    ['app', 'App controlled'],
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
      <select id="gGroupId" style="flex:1; min-width:140px${(g.useGroup && !missing) ? '' : ';display:none'}">
        <option value="">— pick a group —</option>
        ${list.map(x => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name || '(unnamed)')}</option>`).join('')}
        ${missing ? `<option value="${esc(cur)}" selected>(missing — pick another)</option>` : ''}
      </select>
      <label class="iconopt" style="width:auto; opacity:0.55${(g.useGroup && !missing) ? '' : ';display:none'}" title="Schedule support is coming in the next phase."><input type="checkbox" id="gUseSchedule" ${g.useSchedule ? 'checked' : ''} disabled> Use schedule</label>
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

  // ---- Emoji lookup-by-word (the tile editor's emoji search picker) ----
  // Backed by the real emojilib dataset (main process loads it from node_modules and serves it
  // over IPC — config.js runs sandboxed and can't require() it directly). Fetched once and cached.
  let emojiIndexCache = null;
  async function getEmojiIndex() {
    if (!emojiIndexCache) {
      // Tokenize each entry's keyword blob once (split on space AND underscore, since emojilib uses
      // compound keys like "grinning_face"). Ranked search below matches whole tokens, not the blob.
      const raw = (await configApi.getEmojiIndex()) || [];
      emojiIndexCache = raw.map(([em, kw]) => [em, String(kw).split(/[\s_]+/).filter(Boolean)]);
    }
    return emojiIndexCache;
  }
  // Rank a candidate's keyword TOKENS against the query words: exact token (3) beats a prefix (2)
  // beats a mid-word substring (1). Every query word must score, or the candidate is out. Matching
  // whole tokens — not the joined blob — is what keeps "car" off "s-car-ed" and "cat" off
  // "intoxi-cat-ed"; the exact-first ranking is what floats 🚗 above 🥕/🎠 for "car".
  function emojiScore(toks, words) {
    let total = 0;
    for (const w of words) {
      let best = 0;
      for (const t of toks) {
        if (t === w) { best = 3; break; }
        if (t.startsWith(w)) best = best < 2 ? 2 : best;
        else if (t.indexOf(w) !== -1) best = best < 1 ? 1 : best;
      }
      if (!best) return 0;
      total += best;
    }
    return total;
  }
  // Empty query -> a browsable starter set (emojilib's own order, which is Unicode's canonical
  // order -- smileys/people first).
  function emojiSearchIn(index, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return index.slice(0, 40).map(e => e[0]);
    const words = q.split(/\s+/).filter(Boolean);
    return index
      .map(e => [e[0], emojiScore(e[1], words)])
      .filter(x => x[1] > 0)
      .sort((a, b) => b[1] - a[1])   // stable sort keeps Unicode order within a score tier
      .map(x => x[0])
      .slice(0, 60);
  }

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
    return `<div class="row" style="margin-top:6px"><label style="width:auto">Jump-to-page shortcut</label>
      <span class="hkwrap"><input id="gShortcut" readonly placeholder="click, then press keys" value="${esc(g.shortcut || '')}"><button id="gShortcutClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span>
      <label id="gShortcutNoRotLbl" style="width:auto;margin-left:14px;font-weight:normal;cursor:pointer"><input type="checkbox" id="gShortcutNoRot" ${g.shortcutStopsRotation ? 'checked' : ''}> Pause rotation when this shortcut is used</label>
      <span id="gShortcutWarn" class="hint warn" style="margin:0 0 0 8px"></span></div>
      <details class="hint"><summary>Global hotkey that jumps the panel to this page from anywhere.</summary> Click the box and press a combo that includes a modifier (e.g. Ctrl+Alt+1). If another app already owns that combo, it just won't fire. <b>Pause rotation</b> turns auto-rotation off when the shortcut fires, so the panel stays on this page until you start rotation again (knob, tray, or panel).</details>`;
  }
  function wireShortcutRow(g) {
    const inp = document.getElementById('gShortcut'); if (!inp) return;
    const ownLabel = () => 'page \u201c' + (g.name || '(unnamed)') + '\u201d';
    refreshHotkeyWarn('gShortcut', ownLabel());
    inp.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { g.shortcut = acc; inp.value = acc; renderGrids(); markDirty(); refreshHotkeyWarn('gShortcut', ownLabel()); } };
    const clr = document.getElementById('gShortcutClear');
    if (clr) clr.onclick = () => { delete g.shortcut; inp.value = ''; renderGrids(); markDirty(); refreshHotkeyWarn('gShortcut', ownLabel()); };
    const nr = document.getElementById('gShortcutNoRot');
    if (nr) nr.onchange = e => { if (e.target.checked) g.shortcutStopsRotation = true; else delete g.shortcutStopsRotation; markDirty(); };
  }
  // Shared "Page behavior" section: side button strip (when the app supports one), rotation,
  // jump-to-page shortcut, and Advanced settings — identical across grid, dashboard, and app forms.
  function pageBehaviorHtml(g, withGrid) {
    return `<div class="card" style="margin-top:18px"><p class="sectitle">Page behavior</p>`
      + (withGrid ? `<div class="row"><label style="width:auto">Side button strip</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gGrid" ${g.gridOn ? 'checked' : ''}> Add a strip of launcher tiles beside the page</label></div>
      ${g.gridOn ? `<div id="pbStripDeps" style="margin-left:12px">${gridSizeRowHtml(g, g.app === 'music')}<p class="hint" style="margin:2px 0 8px">Tiles are edited on the <b>Buttons</b> tab.</p></div>`
        : `<p class="hint">Placement and size options appear here when enabled; tiles live on the <b>Buttons</b> tab.</p>`}` : '')
      + rotRowHtml(g) + shortcutRowHtml(g) + advRowHtml(g) + `</div>`;
  }
  // Every global hotkey binding in the config, labeled — for conflict warnings beside hotkey fields.
  function allHotkeyBindings() {
    const out = [];
    (config.grids || []).forEach(g => { if (g.shortcut) out.push({ key: g.shortcut, label: 'page “' + (g.name || '(unnamed)') + '”' }); });
    (config.panes || []).forEach(p => { if (p.shortcut) out.push({ key: p.shortcut, label: 'pane “' + (p.name || '(unnamed)') + '”' }); });
    const st = config.settings || {};
    if ((st.rotation || {}).hotkey) out.push({ key: st.rotation.hotkey, label: 'rotation start/pause' });
    const ps = st.pageStep || {};
    if (ps.nextHotkey) out.push({ key: ps.nextHotkey, label: 'Page forward' });
    if (ps.prevHotkey) out.push({ key: ps.prevHotkey, label: 'Page back' });
    if ((st.dashboardReload || {}).hotkey) out.push({ key: st.dashboardReload.hotkey, label: 'Reload dashboard' });
    const me = st.meeting || {};
    [['slideHotkeyToggle', 'slide-capture toggle'], ['slideHotkeySelect', 'slide window select'], ['slideHotkeyManual', 'manual slide capture']]
      .forEach(([k, l]) => { if (me[k]) out.push({ key: me[k], label: l }); });
    // App-page activation hotkeys (LucidType, Live Translate, AI Voice translation) are global too.
    const OPT_HOTKEYS = [['dictationHotkey', 'dictation'], ['applyHotkey', 'apply text'], ['cleanupHotkey', 'cleanup'], ['rewriteHotkey', 'rewrite'], ['micHotkey', 'translation toggle'], ['translateHotkey', 'translation toggle']];
    (config.grids || []).forEach(g => {
      const o = g.options || {};
      OPT_HOTKEYS.forEach(([k, l]) => { if (o[k]) out.push({ key: o[k], label: l + ' on \u201c' + (g.name || '(unnamed)') + '\u201d' }); });
    });
    return out;
  }
  // Warn text when `acc` is already bound elsewhere; ownLabel excludes the field's own binding.
  function hotkeyConflictText(acc, ownLabel) {
    if (!acc) return '';
    const hit = allHotkeyBindings().find(b => b.key === acc && b.label !== ownLabel);
    return hit ? '⚠ also bound to ' + hit.label : '';
  }
  // Refresh the warn span next to a hotkey input (span id = input id + 'Warn', when present).
  function refreshHotkeyWarn(inputId, ownLabel) {
    const inp = document.getElementById(inputId), w = document.getElementById(inputId + 'Warn');
    if (inp && w) w.textContent = hotkeyConflictText(inp.value, ownLabel);
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
    return `<details class="advsec" id="pageAdvSec" style="margin-top:12px"${advOpen ? ' open' : ''}>
      <summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Advanced settings</summary>
      <div class="row" style="margin-top:8px"><label style="width:auto">Home page</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="gHome" ${isHome ? 'checked' : ''}> Set as home page</label></div>
      <p class="hint">When set, the knob's <b>Go to home page</b> action (Settings → Hardware) jumps here. Only one page can be the home page at a time.</p>
      <div class="row" style="margin-top:8px"><label style="width:auto">Hidden</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="gHidden" ${g.hidden ? 'checked' : ''}> Hide from page menu &amp; rotation</label></div>
      <details class="hint"><summary>Skips this page in the double-tap page menu, knob-turn cycling, and auto-rotation — without deleting it.</summary> Still reachable via its keyboard shortcut, if it has one. Handy for a page you want to park (e.g. a media dashboard) and bring back later.</details>
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
      ${(VOICE_APPS.includes(g.app) || g.app === 'lucidtype') ? `
      <div class="row" style="margin-top:8px"><label style="width:auto">STT / TTS</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="gVoiceOn" ${g.options && g.options.voiceOverride ? 'checked' : ''}> Override default TTS/STT servers</label></div>
      ${g.options && g.options.voiceOverride ? `
      <div class="row"><label style="width:auto">STT host / port</label>
        <input id="gVoiceSttHost" value="${esc(optVal(g, 'voiceSttHost', ''))}" placeholder="127.0.0.1" style="flex:1">
        <input id="gVoiceSttPort" value="${esc(optVal(g, 'voiceSttPort', ''))}" placeholder="10300" style="width:90px;margin-left:8px"></div>
      <div class="row"><label style="width:auto">TTS host / port</label>
        <input id="gVoiceTtsHost" value="${esc(optVal(g, 'voiceTtsHost', ''))}" placeholder="127.0.0.1" style="flex:1">
        <input id="gVoiceTtsPort" value="${esc(optVal(g, 'voiceTtsPort', ''))}" placeholder="10200" style="width:90px;margin-left:8px"></div>` : ''}
      <p class="hint">Off = use the global <b>Settings → TTS/STT</b> servers. On = this page dials its own STT/TTS host + port.</p>` : ''}
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
      <details class="hint"><summary>When <b>Desktop focus</b> is on (Settings → Software), the panel switches to this page whenever one of these apps becomes the focused window on the PC.</summary> Matched by process name, not window title.</details>`;
  }
  // ---- Keyboard Shortcuts app: global Custom cheat-sheet (customShortcuts) ----
  // Edited right on the app's own page-config screen (App tab, like World Clock's city picks),
  // but the data itself is a single shared list across every page that has this app — NOT a
  // per-page g.options value — see docs/charter-keyshortcuts.md. Rendering always shows at least
  // one (possibly blank) row; a blank row isn't written to config until the user types into it.
  function shortcutRowsHtml(list) {
    const rows = Array.isArray(list) && list.length ? list : [];
    if (!rows.length) return `<div class="emptystate" style="max-width:420px"><div class="big">No shortcuts yet</div>Add rows to build the cheat-sheet the panel displays.</div>`;
    const seen = new Map();
    rows.forEach(r => { const k = String(r.shortcut || '').trim().toLowerCase(); if (k) seen.set(k, (seen.get(k) || 0) + 1); });
    return `<div class="row" style="margin-top:4px"><span class="hint" style="margin:0;width:180px;text-transform:uppercase;font-size:11px;letter-spacing:.5px">Shortcut</span><span class="hint" style="margin:0 0 0 8px;text-transform:uppercase;font-size:11px;letter-spacing:.5px">Description</span></div>`
      + rows.map((r, i) => {
        const dup = String(r.shortcut || '').trim() && seen.get(String(r.shortcut).trim().toLowerCase()) > 1;
        return `<div class="row" data-idx="${i}" style="margin-top:6px">
        <input class="scShortcut" placeholder="e.g. Ctrl+Shift+E" value="${esc(r.shortcut || '')}" style="width:180px${dup ? ';border-color:#e8b04b' : ''}"${dup ? ' title="Duplicate shortcut"' : ''}>
        <input class="scDesc" placeholder="what it does" value="${esc(r.description || '')}" style="flex:1;margin-left:8px">
        <button class="scRemove" type="button" data-rm="${i}" title="Remove this shortcut" aria-label="Remove shortcut row" style="margin-left:8px">✕</button>
      </div>`;
      }).join('');
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
  // ---- AI Profiles rows (Settings -> AI Profiles): name + prompt per row, add/remove ----
  // Same live-edit model as the custom-shortcut rows: mutate config.settings.aiProfiles in place,
  // markDirty(), Save persists. Ids are stable (never edited); new rows mint one.
  function aiProfileRowsHtml(list) {
    const rows = Array.isArray(list) ? list : [];
    if (!rows.length) return '<p class="hint">No profiles yet — add one below.</p>';
    return rows.map((p, i) => `<div class="row" data-idx="${i}" style="margin-top:10px;align-items:flex-start">
        <input class="apName" placeholder="Profile name" value="${esc(p.name || '')}" style="width:200px">
        <textarea class="apPrompt" placeholder="Instruction for the AI (empty = plain chat)" rows="2" style="flex:1;margin-left:8px;font-family:inherit">${esc(p.prompt || '')}</textarea>
        <button class="apRemove" type="button" data-rm="${i}" title="Remove" style="margin-left:8px">✕</button>
      </div>`).join('');
  }
  function wireAiProfileRows() {
    const host = document.getElementById('sAiProfileRows');
    if (!host) return;
    const list = () => { if (!config.settings) config.settings = {}; if (!Array.isArray(config.settings.aiProfiles)) config.settings.aiProfiles = []; return config.settings.aiProfiles; };
    const redraw = () => { host.innerHTML = aiProfileRowsHtml(list()); wireRows(); };
    function wireRows() {
      host.querySelectorAll('.apName').forEach((inp, i) => {
        inp.oninput = e => { const l = list(); if (l[i]) { l[i].name = e.target.value; markDirty(); } };
      });
      host.querySelectorAll('.apPrompt').forEach((ta, i) => {
        ta.oninput = e => { const l = list(); if (l[i]) { l[i].prompt = e.target.value; markDirty(); } };
      });
      host.querySelectorAll('.apRemove').forEach(btn => {
        btn.onclick = () => { list().splice(parseInt(btn.getAttribute('data-rm'), 10), 1); markDirty(); redraw(); };
      });
    }
    wireRows();
    const addBtn = document.getElementById('sAiProfileAdd');
    if (addBtn) addBtn.onclick = () => {
      list().push({ id: 'p' + Date.now().toString(36), name: '', prompt: '' });
      markDirty(); redraw();
      const inputs = host.querySelectorAll('.apName');
      if (inputs.length) inputs[inputs.length - 1].focus();
    };
  }
  // ---- Routines (Settings -> Routines): searchable master-detail editor ----
  // Presentation only. Storage is unchanged: config.settings.routines, referenced by stable id
  // from tiles. Everything here selects and binds by routine ID, never array position, so filtering
  // or reordering the visible list can never write edits into the wrong routine.
  function aiChatPagesForPicker() {
    return (config.grids || []).filter(g => g && g.kind === 'app' && g.app === 'ai-voice');
  }
  function backendOfPage(page) { return (page && page.options && page.options.backend) || 'claude'; }
  function routineListArr() { if (!config.settings) config.settings = {}; if (!Array.isArray(config.settings.routines)) config.settings.routines = []; return config.settings.routines; }
  function routinePlural(n) { return n + ' routine' + (n === 1 ? '' : 's'); }

  // Search matches name, prompt, target page name, and folder. `q` is already lowercased.
  function routineMatches(r, q, pages) {
    if (!q) return true;
    const page = pages.find(g => g.id === r.appPageId);
    return [r.name, r.prompt, page && page.name, r.folder]
      .map(x => String(x || '').toLowerCase()).join('  ').indexOf(q) !== -1;
  }
  // Keep the selection valid against what's actually visible: if the current pick was filtered out
  // (or never set), fall to the first visible result -- never a hidden or stale id.
  function resolveRoutineSel(filtered) {
    if (!filtered.some(r => r.id === selRoutineId)) selRoutineId = filtered.length ? filtered[0].id : null;
  }
  function routineItemHtml(r, pages) {
    const page = pages.find(g => g.id === r.appPageId);
    const pageName = page ? (page.name || '(unnamed page)') : '(no page)';
    const preview = String(r.prompt || '').replace(/\s+/g, ' ').trim() || '(no prompt yet)';
    return '<div class="rtItem' + (r.id === selRoutineId ? ' sel' : '') + '" data-id="' + esc(r.id) + '">'
      + '<div class="rtiName">' + esc(r.name || '(unnamed routine)') + '</div>'
      + '<div class="rtiSub"><span class="rtiPage">' + esc(pageName) + '</span> · <span class="rtiPrev">' + esc(preview) + '</span></div>'
      + '</div>';
  }
  function routineItemsHtml(filtered, rows, pages) {
    if (filtered.length) return filtered.map(r => routineItemHtml(r, pages)).join('');
    return '<div class="rtEmpty">' + (rows.length ? 'No routines match your search.' : 'No routines yet — add one, or save one from the panel with <b>+ Routine</b>.') + '</div>';
  }
  // Folder + Mode live only on the agent backends (claude/codex/copilot); chat-only pages (owui/api)
  // get the same explanatory note the AI Chat page shows. Detail widgets carry no data-index -- the
  // detail edits exactly one routine, looked up by selRoutineId at event time.
  function routineDetailFolderHtml(r, page) {
    if (['claude', 'codex', 'copilot'].indexOf(backendOfPage(page)) === -1) {
      return '<div class="rtField"><span class="hint" style="margin:0">' + esc(page ? (page.name || 'That page') : 'That page') + ' is chat-only — no folder or permission mode.</span></div>';
    }
    return '<div class="rtField"><label>Folder</label>'
      + '<div class="rtFolderRow">'
      + '<input id="rtdFolder" placeholder="Folder (blank = page’s current)" value="' + esc(r.folder || '') + '">'
      + '<button id="rtdFolderBrowse" type="button" title="Browse">…</button>'
      + '</div></div>';
  }
  function routineDetailModeHtml(r, page) {
    const list = (voiceModes && voiceModes[backendOfPage(page)]) || [];
    if (!list.length) return '';   // chat-only backend, or modes not loaded yet
    return '<div class="rtField"><label>Mode</label>'
      + '<select id="rtdMode"><option value="">(page’s current mode)</option>'
      + list.map(m => '<option value="' + esc(m.id) + '" ' + (m.id === r.mode ? 'selected' : '') + '>' + esc(m.label || m.id) + '</option>').join('')
      + '</select></div>';
  }
  function routineDetailHtml(pages) {
    const r = routineListArr().find(x => x.id === selRoutineId) || null;
    if (!r) {
      return '<div class="rtEmpty">' + (routineQuery.trim() ? 'No routine selected — nothing matches your search.' : 'Select a routine on the left, or add one.') + '</div>';
    }
    const page = pages.find(g => g.id === r.appPageId) || pages[0];
    const profiles = ((config.settings || {}).aiProfiles) || [];
    return ''
      + '<div class="rtDetailHead"><div class="sectitle" style="margin:0">Edit routine</div>'
      + '<div class="rtHeadBtns"><button id="rtdDelete" type="button" class="danger">Delete routine</button>'
      + '<button id="rtdRun" type="button" class="rtRun">Run routine</button></div></div>'
      + '<div class="rtField"><label>Name</label><input id="rtdName" placeholder="Routine name" value="' + esc(r.name || '') + '"></div>'
      + '<div class="rtField"><label>AI Chat page</label>'
      + '<select id="rtdPage">' + pages.map(g => '<option value="' + g.id + '" ' + (g.id === r.appPageId ? 'selected' : '') + '>' + esc(g.name || '(unnamed page)') + '</option>').join('') + '</select></div>'
      + '<div class="rtField"><label>Profile</label>'
      + '<select id="rtdProfile"><option value="">(page’s current profile)</option>' + profiles.map(p => '<option value="' + esc(p.id) + '" ' + (p.id === r.profileId ? 'selected' : '') + '>' + esc(p.name || '(unnamed)') + '</option>').join('') + '</select></div>'
      + routineDetailFolderHtml(r, page)
      + routineDetailModeHtml(r, page)
      + '<div class="rtField"><label>Prompt</label>'
      + '<textarea id="rtdPrompt" rows="6" placeholder="What to ask the AI, e.g. Summarize my unread email and list anything needing a reply" style="font-family:inherit">' + esc(r.prompt || '') + '</textarea></div>';
  }
  function routineEditorHtml() {
    const pages = aiChatPagesForPicker();
    if (!pages.length) return '<p class="hint">No AI Chat page yet — add one (Pages → + App page → AI Voice) and a routine will have somewhere to run.</p>';
    const rows = routineListArr();
    const q = routineQuery.trim().toLowerCase();
    const filtered = rows.filter(r => routineMatches(r, q, pages));
    resolveRoutineSel(filtered);
    const count = q ? (filtered.length + ' of ' + routinePlural(rows.length)) : routinePlural(rows.length);
    return '<div class="rtSplit">'
      + '<div class="rtList">'
      + '<div class="rtListHead"><span class="rtCount" id="rtCount">' + esc(count) + '</span><button id="sRoutineAdd" type="button">+ Add routine</button></div>'
      + '<input id="rtSearch" class="rtSearch" placeholder="Search name, prompt, page, folder" value="' + esc(routineQuery) + '">'
      + '<div class="rtItems" id="rtItems">' + routineItemsHtml(filtered, rows, pages) + '</div>'
      + '</div>'
      + '<div class="rtDetail" id="rtDetail">' + routineDetailHtml(pages) + '</div>'
      + '</div>';
  }
  function wireRoutineRows() {
    const host = document.getElementById('sRoutineRows');
    if (!host) return;
    const list = routineListArr;
    const curRoutine = () => list().find(r => r.id === selRoutineId) || null;

    // Per-backend mode lists come from main; fetch once, then refresh the detail (the only place a
    // Mode picker shows). Rows render fine before it lands -- chat-only routines never need it.
    if (!voiceModes && configApi.getVoiceModes) {
      configApi.getVoiceModes().then(m => { voiceModes = m || {}; if (document.getElementById('sRoutineRows')) renderDetailOnly(); }).catch(() => { voiceModes = {}; });
    }

    function redraw() { host.innerHTML = routineEditorHtml(); wireAll(); }
    function renderDetailOnly() {
      const d = document.getElementById('rtDetail');
      if (!d) return;
      d.innerHTML = routineDetailHtml(aiChatPagesForPicker());
      wireDetail();
    }
    // Rebuild the list items + count in place. The #rtSearch box and #rtDetail pane are untouched,
    // so this is safe to call from a search keystroke, or a name/prompt edit in the detail pane,
    // without stealing focus from whatever field the user is typing in.
    function renderListOnly() {
      const pages = aiChatPagesForPicker();
      const rows = list();
      const q = routineQuery.trim().toLowerCase();
      const filtered = rows.filter(r => routineMatches(r, q, pages));
      const before = selRoutineId;
      resolveRoutineSel(filtered);
      const itemsEl = document.getElementById('rtItems');
      if (itemsEl) itemsEl.innerHTML = routineItemsHtml(filtered, rows, pages);
      const countEl = document.getElementById('rtCount');
      if (countEl) countEl.textContent = q ? (filtered.length + ' of ' + routinePlural(rows.length)) : routinePlural(rows.length);
      wireItems();
      if (selRoutineId !== before) renderDetailOnly();   // the search hid the old pick -> show the new one
    }

    function wireItems() {
      host.querySelectorAll('.rtItem').forEach(el => {
        el.onclick = () => {
          if (el.dataset.id === selRoutineId) return;
          selRoutineId = el.dataset.id;
          host.querySelectorAll('.rtItem').forEach(x => x.classList.toggle('sel', x.dataset.id === selRoutineId));
          renderDetailOnly();
        };
      });
    }
    function wireDetail() {
      const name = document.getElementById('rtdName');
      if (name) name.oninput = e => { const r = curRoutine(); if (r) { r.name = e.target.value; markDirty(); renderListOnly(); } };
      const prompt = document.getElementById('rtdPrompt');
      if (prompt) prompt.oninput = e => { const r = curRoutine(); if (r) { r.prompt = e.target.value; markDirty(); renderListOnly(); } };
      const pagePick = document.getElementById('rtdPage');
      if (pagePick) pagePick.onchange = e => { const r = curRoutine(); if (r) { r.appPageId = e.target.value; markDirty(); renderDetailOnly(); renderListOnly(); } };
      const profile = document.getElementById('rtdProfile');
      if (profile) profile.onchange = e => { const r = curRoutine(); if (r) { r.profileId = e.target.value; markDirty(); } };
      const folder = document.getElementById('rtdFolder');
      if (folder) folder.oninput = e => { const r = curRoutine(); if (r) { r.folder = e.target.value; markDirty(); } };
      const browse = document.getElementById('rtdFolderBrowse');
      if (browse) browse.onclick = async () => {
        const picked = await configApi.pickFolder();
        if (!picked) return;
        const r = curRoutine(); if (!r) return;
        r.folder = picked; markDirty();
        const inp = document.getElementById('rtdFolder'); if (inp) inp.value = picked;
      };
      const mode = document.getElementById('rtdMode');
      if (mode) mode.onchange = e => { const r = curRoutine(); if (r) { r.mode = e.target.value; markDirty(); } };
      const run = document.getElementById('rtdRun');
      if (run) run.onclick = async () => {
        const r = curRoutine(); if (!r) return;
        if (!String(r.prompt || '').trim()) { setState('add a prompt before running this routine', 'dirty'); return; }
        // Run what's on screen: the routine runs from main's config, so commit pending edits first.
        // A brand-new routine only reaches main once saved, so this is required, not just tidy.
        if (dirty) { const ok = await doSave(); if (!ok) return; }
        run.disabled = true;
        try {
          const res = await configApi.runRoutine(r.id);
          if (res && res.ok) setState('▶ running “' + (res.name || r.name || 'routine') + '”' + (res.page ? ' on ' + res.page : '') + ' — check the panel', 'saved');
          else setState((res && res.error) || 'could not run that routine', 'dirty');
        } catch (e) { setState('could not run that routine', 'dirty'); }
        finally { run.disabled = false; }
      };
      const del = document.getElementById('rtdDelete');
      if (del) del.onclick = () => {
        const r = curRoutine(); if (!r) return;
        if (!ask('Delete routine “' + (r.name || '(unnamed)') + '”?\n\nAny tile or macro that uses it will show “routine not found” until you point it elsewhere. This can’t be undone.')) return;
        const l = list(); const idx = l.findIndex(x => x.id === r.id);
        if (idx >= 0) l.splice(idx, 1);
        selRoutineId = null;   // resolveRoutineSel picks the first still-visible routine on redraw
        markDirty(); redraw();
      };
    }
    function wireAdd() {
      const searchEl = document.getElementById('rtSearch');
      if (searchEl) searchEl.oninput = e => { routineQuery = e.target.value; renderListOnly(); };
      const addBtn = document.getElementById('sRoutineAdd');
      if (addBtn) addBtn.onclick = () => {
        const pages = aiChatPagesForPicker();
        const r = { id: 'r' + Date.now().toString(36), name: '', prompt: '', appPageId: pages.length ? pages[0].id : '', profileId: '', folder: '', mode: '' };
        list().push(r);
        routineQuery = '';       // clear any active search so the new (blank, unmatchable) routine is visible
        selRoutineId = r.id;     // ...and selected, with its name focused for immediate typing
        markDirty(); redraw();
        const nameEl = document.getElementById('rtdName'); if (nameEl) nameEl.focus();
      };
    }
    function wireAll() { wireAdd(); wireItems(); wireDetail(); }
    wireAll();
  }
  function officeOptionDefault(def, key) {
    const option = (def.options || []).find(item => item.key === key);
    return option ? option.default : '';
  }
  const OFFICE_SHORTCUT_DEFAULTS = {
    teams: [['Mute', 'Alt+Super+K', '🎙️'], ['Camera', 'Ctrl+Shift+O', '📹'], ['Accept audio', 'Ctrl+Shift+S', '📞'], ['Hang up', 'Ctrl+Shift+H', '📴']],
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
            <input class="officeShortcutIcon" data-app-index="${index}" data-shortcut-index="${shortcutIndex}" list="officeShortcutIcons" value="${esc(shortcutValue(index, shortcutIndex, 'Icon'))}" maxlength="8" aria-label="Shortcut ${shortcutIndex} emoji">
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
        <details class="hint" style="margin:4px 0 8px"><summary><b>Keep Office panel visible</b> means tapping this header app will not focus or relaunch it when it already has an open window; it only changes the shortcut buttons below.</summary> If the app is closed, it still launches. Tapping a shortcut then focuses the app and sends the configured keys.</details>` : ''}
        <div class="row"><label>Shortcuts</label><select class="officeShortcutCount" data-index="${index}">${officeChoiceHtml(def, 'app' + index + 'ShortcutCount', shortcutCount)}</select></div>
        <p class="hint" style="margin:8px 0 4px">Bottom-row shortcuts when this app is selected. Use an emoji, or choose a local image/SVG; the emoji remains the fallback if the image is unavailable.</p>
        <div class="officeShortcutHead"><span>Icon</span><span>Label</span><span>Keys</span><span>Action</span></div>
        ${shortcuts}
      </fieldset>`;
    }).join('');
    return `<div id="officeOptions" style="margin-top:10px">
        <p class="sectitle">Office header applications</p>
        <details class="hint"><summary>These four apps appear in the panel header.</summary> Selecting one opens it and shows 4–8 equally sized shortcut buttons for that app. Changing an application restores its shortcut defaults. <b>Prefer desktop</b> falls back to the web app when needed.</details>
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
          if (!ask(name + ' is currently set as home page, switch to this one?')) {
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
        tell('This page is set as the home page and can\'t be hidden. Pick a new home page first, then hide this one.');
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
    const advSec = document.getElementById('pageAdvSec');   // remember open/closed so an override toggle's render() doesn't collapse it
    if (advSec) advSec.ontoggle = () => { advOpen = advSec.open; };
    const vOn = document.getElementById('gVoiceOn');   // per-page STT/TTS override (voice apps only)
    if (vOn) vOn.onchange = e => { if (!g.options) g.options = {}; g.options.voiceOverride = e.target.checked; markDirty(); render(); };
    const vSetOpt = (key, el) => { const inp = document.getElementById(el); if (inp) inp.oninput = e => { if (!g.options) g.options = {}; g.options[key] = e.target.value.trim(); markDirty(); }; };
    vSetOpt('voiceSttHost', 'gVoiceSttHost'); vSetOpt('voiceSttPort', 'gVoiceSttPort');
    vSetOpt('voiceTtsHost', 'gVoiceTtsHost'); vSetOpt('voiceTtsPort', 'gVoiceTtsPort');
    const clone = document.getElementById('gClone'), cloneBtn = document.getElementById('gCloneBtn');
    if (clone && cloneBtn) {
      clone.onchange = () => { cloneBtn.disabled = !clone.value; };
      cloneBtn.onclick = () => {
        const src = config.grids.find(p => p.id === clone.value); if (!src) return;
        const hasContent = (g.tiles || []).some(t => t && t.type);
        if (hasContent && !ask('Replace this grid’s tiles with the ones from “' + (src.name || 'that page') + '”?')) return;
        g.tiles = fitTiles(src.tiles, (g.cols || 1) * (g.rows || 1));
        ti = -1; selEnd = -1; render(); markDirty();
      };
    }
    wireFocusRow(g);
  }

  // ---- save model (no live edit) ----
  function setState(text, cls) { const el = document.getElementById('state'); el.textContent = text; el.className = 'state' + (cls ? ' ' + cls : ''); }
  function markDirty() {
    dirty = true; setState('● Unsaved changes', 'dirty'); document.getElementById('saveBtn').disabled = false;
    // Any app-page edit re-points the live preview (debounced; only reloads when the URL changed).
    try { const g = curGrid(); if (g && g.kind === 'app') updateAppSurface(g); } catch (e) {}
  }
  // Native confirm()/alert() leave the window's input state broken in Electron — text fields and
  // <select> popups stop responding because the dialog takes focus and the window never registers
  // getting it back (electron#31917 / #41603). Route EVERY dialog through these; main blurs and
  // refocuses the editor window afterwards, which restores input.
  function refocusAfterDialog() { try { if (configApi.refocusEditor) configApi.refocusEditor(); } catch (e) {} }
  function ask(msg) { const r = window.confirm(msg); refocusAfterDialog(); return r; }
  function tell(msg) { window.alert(msg); refocusAfterDialog(); }
  async function doSave() {
    document.getElementById('saveBtn').disabled = true;
    setState('Saving…');
    try {
      const result = await configApi.saveConfig(config);
      if (!(result && result.ok)) throw new Error(result && result.error || 'secure persistence failed');
      baseConfig = snapConfig(config);   // on-disk now matches the editor — new merge base
      dirty = false;
      setState('All changes saved ✓', 'saved');
      return true;
    } catch (e) {
      dirty = true;
      document.getElementById('saveBtn').disabled = false;
      const detail = e && typeof e.message === 'string' ? e.message.trim() : '';
      const reason = !detail || detail === 'secure persistence failed'
        ? 'secrets could not be stored securely'
        : detail.slice(0, 180);
      setState('Unable to apply changes: ' + reason, 'dirty');
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
  // App-picker visibility (Settings -> Apps). Apps default SHOWN (listed in hiddenApps when off).
  function appHidden(id) { return (((config.settings || {}).hiddenApps) || []).includes(id); }
  function appVisible(a) {
    if (!a) return false;
    if (a.id === 'ha-dashboard' && !((config.settings || {}).haAuth || {}).useHa) return false;   // hidden until Use HA is on
    return !appHidden(a.id);
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
  let pageDragFrom = -1, pageFilter = '';
  // Page-type filter (the pulldown under the search box). Session-local view state, not saved.
  const pageKindFilter = { grid: true, appBuiltin: true, appDropin: true, web: true };
  function pageKindOf(g) {
    if (g.kind === 'web') return 'web';
    if (g.kind !== 'app') return 'grid';
    const def = appDefs.find(a => a.id === g.app);
    return def && def._folder ? 'appDropin' : 'appBuiltin';
  }
  function renderGrids() {
    const el = document.getElementById('gridlist'); el.innerHTML = '';
    const q = pageFilter.trim().toLowerCase();
    let shown = 0;
    const kindFiltered = Object.values(pageKindFilter).some(v => !v);
    config.grids.forEach((g, i) => {
      if (q && !String(g.name || '').toLowerCase().includes(q)) return;
      if (!pageKindFilter[pageKindOf(g)]) return;
      shown++;
      const d = document.createElement('div');
      d.className = 'gridrow' + (i === gi ? ' active' : '');
      const left = document.createElement('span'); left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden';
      const grip = document.createElement('span'); grip.className = 'griphandle'; grip.title = 'Drag to reorder — or focus the row and press Alt+↑ / Alt+↓'; grip.textContent = '☰';
      const ptype = document.createElement('span'); ptype.className = 'ptype';
      ptype.textContent = g.kind === 'web' ? 'D' : g.kind === 'app' ? 'A' : 'G';
      ptype.title = g.kind === 'web' ? 'Dashboard page' : g.kind === 'app' ? 'App page' : 'Grid page';
      const name = document.createElement('span'); name.textContent = g.name || '(unnamed)'; name.title = g.name || '';
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' + (g.hidden ? ';opacity:.55;font-style:italic' : '');
      left.appendChild(grip); left.appendChild(ptype); left.appendChild(name);
      // Top row is name + grip only -- the shortcut badge used to sit in this same row and steal its
      // width, truncating long page names even though the sidebar had room to spare below. It now gets
      // its own row underneath instead of competing for horizontal space.
      const top = document.createElement('span'); top.className = 'gtop'; top.appendChild(left);
      if (g.hidden) { const b = document.createElement('span'); b.className = 'stbadge'; b.title = 'Hidden from page menu, knob cycling, and rotation'; b.textContent = 'hidden'; top.appendChild(b); }
      d.appendChild(top);
      if (g.shortcut) { const sub = document.createElement('span'); sub.className = 'gsub badge'; sub.title = 'Hotkey shortcut'; sub.textContent = g.shortcut; d.appendChild(sub); }
      d.onclick = () => { view = 'pages'; gi = i; ti = -1; selEnd = -1; render(); };
      // keyboard access: Tab to a row, Enter/Space selects, Alt+Arrow moves it up/down
      d.tabIndex = 0;
      d.setAttribute('role', 'button');
      d.setAttribute('aria-label', (g.name || '(unnamed)') + (g.hidden ? ', hidden' : ''));
      d.onkeydown = e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.onclick(); }
        else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          const to = i + (e.key === 'ArrowUp' ? -1 : 1);
          movePage(i, to);
          const rows = document.querySelectorAll('#gridlist .gridrow');
          const moved = rows[Math.max(0, Math.min(rows.length - 1, to))];
          if (moved) moved.focus();
        }
      };
      d.draggable = true;
      d.ondragstart = e => { pageDragFrom = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (er) {} };
      d.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; d.classList.add('dragover'); };
      d.ondragleave = () => d.classList.remove('dragover');
      d.ondrop = e => { e.preventDefault(); d.classList.remove('dragover'); movePage(pageDragFrom, i); pageDragFrom = -1; };
      d.ondragend = () => d.classList.remove('dragover');
      el.appendChild(d);
    });
    if (!shown && (q || kindFiltered)) {
      el.innerHTML = '<p class="hint">' + (q ? 'No pages match “' + esc(pageFilter.trim()) + '”.' : 'No pages match the selected types.') + '</p>';
    }
    const kb = document.getElementById('pageKindsBtn');
    if (kb) kb.classList.toggle('filtered', kindFiltered);
    const rb = document.getElementById('pageFilterReset');
    if (rb) rb.disabled = !q && !kindFiltered;   // nothing to reset
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
      <p class="sectitle">Grid layout</p>
      <div class="row"><label>Name</label><input id="gName" value="${esc(g.name)}"></div>
      <div class="row"><label>Columns</label><input id="gCols" type="number" min="1" max="12" value="${g.cols}" style="width:90px">
        <label style="width:auto;margin-left:10px">Rows</label><input id="gRows" type="number" min="1" max="6" value="${g.rows}" style="width:90px">
        <span class="hint" style="margin:0 0 0 12px">shown on the 1920\u00d7480 panel</span></div>
      ${groupSelectRowHtml(g)}
      ${pageBehaviorHtml(g, false)}
      <div class="row"><button id="gFocus">Show on device</button></div>`;
    const pd = document.getElementById('pagedanger');
    if (pd) pd.innerHTML = '<div class="dangerzone"><p class="dzlabel">Danger zone</p><button class="danger" id="gDelete">Delete grid</button></div>';
    document.getElementById('gName').oninput = e => { g.name = e.target.value; renderGrids(); markDirty(); };
    const tilesLostBy = (cols, rows) => (g.tiles || []).filter((t, i) => t && t.type && (Math.floor(i / g.cols) >= rows || (i % g.cols) >= cols)).length;
    document.getElementById('gCols').onchange = e => {
      const next = Math.max(1, Math.min(12, +e.target.value || 1));
      const lost = next < g.cols ? tilesLostBy(next, g.rows) : 0;
      if (lost && !ask('Shrinking to ' + next + ' column' + (next === 1 ? '' : 's') + ' removes ' + lost + ' configured tile' + (lost === 1 ? '' : 's') + '. Continue?')) { e.target.value = g.cols; return; }
      clearAllMerges(g); g.cols = next; ensureTiles(g); ti = -1; selEnd = -1; render(); markDirty();
    };
    document.getElementById('gRows').onchange = e => {
      const next = Math.max(1, Math.min(6, +e.target.value || 1));
      const lost = next < g.rows ? tilesLostBy(g.cols, next) : 0;
      if (lost && !ask('Shrinking to ' + next + ' row' + (next === 1 ? '' : 's') + ' removes ' + lost + ' configured tile' + (lost === 1 ? '' : 's') + '. Continue?')) { e.target.value = g.rows; return; }
      clearAllMerges(g); g.rows = next; ensureTiles(g); ti = -1; selEnd = -1; render(); markDirty();
    };
    document.getElementById('gDelete').onclick = deleteCurrentPage;
    { const fb = document.getElementById('gFocus'); if (fb) fb.onclick = focusCurrentPage; }
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
    if (!el) return;
    // Callers fire this after global refreshes (e.g. Auth-tab HA refresh) regardless of what page is
    // selected; a page without a tile grid (plain dashboard, app without an embedded grid) must be a
    // no-op, not a crash in ensureTiles on g.tiles.length.
    if (!g || !Array.isArray(g.tiles) || !(+g.cols > 0) || !(+g.rows > 0)) { el.innerHTML = ''; return; }
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
    } else if (ti >= 0) {
      // contextual: only offer merging once a first tile is selected
      el.innerHTML = `<span class="hint"><b>Shift-click</b> another tile to merge this one into a bigger button.</span>`;
    } else {
      el.innerHTML = '';
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
    if (!g || ti < 0) { el.innerHTML = '<div class="emptystate"><div class="big">No tile selected</div>Select a tile to edit its action, label, and icon.</div>'; document.getElementById('iconpane').innerHTML = ''; return; }
    const t = g.tiles[ti];
    if (t.type === 'macro' && !Array.isArray(t.steps)) t.steps = [];
    let body;
    if (t.type === 'page') body = `<div class="row"><label>Page</label>${pageSelectHtml(t)}</div>`;
    else if (t.type === 'routine') body = `<div class="row"><label>Routine</label>${routineSelectHtml(t)}</div>`;
    else if (t.type === 'macro') body = `<div class="row"><label>Steps</label></div><div id="macroSteps"></div>`;
    else if (t.type === 'key') body = `<div class="row"><label>Keys</label><input id="tValue" value="${esc(t.value)}" placeholder="${valuePlaceholder('key')}"><button id="tRec" type="button">Record</button></div>`;
    else if (t.type === 'ha') body = haTileBodyHtml(t);
    else if (t.type === 'obs') body = obsTileBodyHtml(t);
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
      if (t.type === 'page' || prev === 'page' || t.type === 'ha' || prev === 'ha' || t.type === 'routine' || prev === 'routine' || t.type === 'obs' || prev === 'obs') { t.value = ''; t.service = ''; }
      if (t.type === 'obs' && !t.obsAction) t.obsAction = 'scene';
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
    const tr = document.getElementById('tRoutine');
    if (tr) { if (tr.value && tr.value !== t.value) { t.value = tr.value; markDirty(); } tr.onchange = e => { t.value = e.target.value; renderTiles(); markDirty(); }; }
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
    if (t.type === 'obs') wireObsTile(t);
    renderIconPane();
  }
  // OBS tile editor: pick an action (scene/mute/studio/cut/auto/save-clip); scene & mute also pick a
  // resource from the LIVE OBS snapshot (like the HA entity picker). Stores t.obsAction + t.value.
  const OBS_TILE_ACTIONS = [['scene', 'Switch to scene'], ['mute', 'Toggle input mute'], ['studioMode', 'Toggle Studio Mode'], ['cut', 'Cut (take Preview)'], ['auto', 'Auto transition'], ['saveReplay', 'Save replay clip']];
  function obsTileBodyHtml(t) {
    const act = t.obsAction || 'scene';
    const needsRes = act === 'scene' || act === 'mute';
    return `<div class="row"><label>Action</label><select id="obsAct" style="flex:1">${OBS_TILE_ACTIONS.map(([v, n]) => `<option value="${v}" ${v === act ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`
      + (needsRes ? `<div class="row"><label>${act === 'mute' ? 'Input' : 'Scene'}</label><select id="obsRes" style="flex:1"><option value="${esc(t.value || '')}">${esc(t.value || '(pick from OBS)')}</option></select></div><p class="hint" id="obsHint"></p>` : '');
  }
  async function wireObsTile(t) {
    const actSel = document.getElementById('obsAct');
    if (actSel) actSel.onchange = e => { t.obsAction = e.target.value; if (t.obsAction !== 'scene' && t.obsAction !== 'mute') t.value = ''; render(); markDirty(); };
    const resSel = document.getElementById('obsRes');
    if (!resSel) return;
    const hint = document.getElementById('obsHint');
    let snap = null; try { snap = await configApi.getObsSnapshot(); } catch (e) {}
    if (!snap || snap.connection !== 'connected') {
      if (hint) hint.textContent = 'Connect OBS (Settings → Auth → OBS Studio) to pick from your live scenes/inputs.';
      resSel.onchange = e => { t.value = e.target.value; renderTiles(); markDirty(); };
      return;
    }
    const items = t.obsAction === 'mute' ? (snap.inputs || []).map(i => i.name) : (snap.scenes || []);
    resSel.innerHTML = ['<option value="">(none)</option>'].concat(items.map(n => `<option value="${esc(n)}" ${n === t.value ? 'selected' : ''}>${esc(n)}</option>`)).join('');
    resSel.onchange = e => { t.value = e.target.value; if (!t.label) t.label = e.target.value; renderTiles(); markDirty(); };
    if (hint) hint.textContent = '';
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
    const routineList = ((config.settings || {}).routines) || [];
    const rowHtml = (s, i) => {
      const kind = s.kind || 'key';
      const field = kind === 'page'
        ? `<select class="msVal" data-i="${i}" style="flex:1">${others.map(g => `<option value="${esc(g.id)}" ${g.id === s.value ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>`
        : kind === 'routine'
        ? (routineList.length
            ? `<select class="msVal" data-i="${i}" style="flex:1">${routineList.map(r => `<option value="${esc(r.id)}" ${r.id === s.value ? 'selected' : ''}>${esc(r.name || '(unnamed routine)')}</option>`).join('')}</select>`
            : `<span class="hint" style="flex:1">No routines saved yet — add one on <b>Settings → Routines</b>.</span>`)
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
    // A <select> field (page / routine) shows its first option straight away — commit that as the
    // step's value so a step the user never touched isn't silently blank.
    host.querySelectorAll('select.msVal').forEach(el => { const i = +el.dataset.i; if (el.value && t.steps[i] && !t.steps[i].value) { t.steps[i].value = el.value; markDirty(); } });
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
      el.innerHTML = `<input id="tIcon" value="${esc(t.icon)}" placeholder="paste an emoji, or type a word to search — rocket, heart, coffee…">
        <div class="emoji-grid" id="emojiResults"></div>`;
      wireEmojiPicker(t);
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

  // One field does both jobs: paste an emoji directly, or type a word and pick a live match below.
  async function wireEmojiPicker(t) {
    const inp = document.getElementById('tIcon');
    const results = document.getElementById('emojiResults');
    if (!inp || !results) return;
    results.innerHTML = '<span class="hint">loading…</span>';
    const index = await getEmojiIndex();
    if (!document.body.contains(inp)) return;   // the editor moved on to something else while this loaded
    const renderResults = () => {
      const list = emojiSearchIn(index, inp.value);
      results.innerHTML = list.length
        ? list.map(em => `<button type="button" class="emoji-btn" title="Use this emoji">${esc(em)}</button>`).join('')
        : '<span class="hint">no matches</span>';
      results.querySelectorAll('.emoji-btn').forEach(b => b.onclick = () => {
        t.icon = b.textContent;
        inp.value = t.icon;
        renderResults();
        renderTiles(); renderIconPreview(t); markDirty();
      });
    };
    inp.oninput = () => {
      // Letters/digits in the box mean it's a search word, not a pasted emoji -- don't clobber the
      // tile's actual icon with that text. Only a real paste (no plain ASCII in it) commits directly.
      if (!/[a-z0-9]/i.test(inp.value)) { t.icon = inp.value; renderTiles(); renderIconPreview(t); markDirty(); }
      renderResults();
    };
    renderResults();
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
  function routineSelectHtml(t) {
    const list = ((config.settings || {}).routines) || [];
    if (!list.length) return '<span class="hint">No routines saved yet — add one on <b>Settings → Routines</b>, or from the panel with <b>+ Routine</b>.</span>';
    return `<select id="tRoutine">${list.map(r => `<option value="${esc(r.id)}" ${r.id === t.value ? 'selected' : ''}>${esc(r.name || '(unnamed routine)')}</option>`).join('')}</select>`;
  }
  function typeHint(type) {
    if (type === 'app') return 'Program name on PATH (chrome, notepad…) or a full .exe path via Browse.';
    if (type === 'url') return 'Opens in your default browser.';
    if (type === 'page') return 'Tapping (or clicking) this tile switches the panel to the chosen page.';
    if (type === 'routine') return 'Tapping this tile switches the panel to the AI Chat page the routine names and sends its saved request — the agent answers with its normal tools and approvals. Manage routines on Settings → Routines.';
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
        `<details class="hint"><summary>A strip of launcher tiles on the chosen side of the dashboard — 2 rows tall, 1–3 columns wide.</summary> Edit the tiles below. Uncheck <b>Add a button grid</b> on the Dashboard tab to remove it.</details>`;
      document.getElementById('dtPage').onclick = () => { dashTab = 'page'; render(); };
      wireGridSizeRow(g); wireGroupSelectRow(g);
      return;
    }

    el.innerHTML = tabBar + `
      <div class="row"><label>Name</label><input id="gName" value="${esc(g.name)}"></div>
      <div class="row"><label>URL</label><input id="gUrl" value="${esc(g.url)}" placeholder="https://…  (dashboard, monitoring page, etc.)"></div>
      <p class="sectitle" style="margin-top:16px">Browser behavior</p>
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
      <div class="row" style="margin-top:10px"><label style="width:auto">Browser profile</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="gUA" ${g.desktopUA ? 'checked' : ''}> Use desktop browser profile</label></div>
      <details class="hint"><summary>Makes this page look like desktop Chrome instead of an embedded app.</summary> Turn on for sites that won't load or let you sign in inside the panel (e.g. claude.ai, chatgpt.com). The panel keeps its own login, separate from your PC browser.</details>
      ${pageBehaviorHtml(g, true)}
      <div class="row" style="margin-top:10px"><button id="gFocus">Show on device</button></div>
      <p class="hint" id="authHint"></p>
      <p class="hint">Shown full-screen on the panel. Knob scrolls · tap clicks · double-click the knob returns to the page selector.</p>
      <div class="dangerzone"><p class="dzlabel">Danger zone</p><button class="danger" id="gDelete">Delete page</button></div>`;
    const dtb = document.getElementById('dtBtns'); if (dtb) dtb.onclick = () => { dashTab = 'buttons'; render(); };
    document.getElementById('gName').oninput = e => { g.name = e.target.value; renderGrids(); markDirty(); };
    document.getElementById('gUrl').oninput = e => { g.url = e.target.value; markDirty(); };
    document.getElementById('gAuth').onchange = e => { setAuthType(g, e.target.value); renderAuthFields(g); markDirty(); };
    document.getElementById('gDelete').onclick = deleteCurrentPage;
    { const fb = document.getElementById('gFocus'); if (fb) fb.onclick = focusCurrentPage; }
    document.getElementById('gExt').onchange = e => { g.linksExternal = e.target.checked; markDirty(); };
    const gua = document.getElementById('gUA'); if (gua) gua.onchange = e => { g.desktopUA = e.target.checked; markDirty(); };
    document.getElementById('gGrid').onchange = e => {
      g.gridOn = e.target.checked;
      if (g.gridOn) { enableGrid(g); dashTab = 'buttons'; }   // 2×3 default; reveal + jump to the new tab
      else { dashTab = 'page'; }
      ti = -1; selEnd = -1; render(); markDirty();
    };
    wireRotRow(g); wireShortcutRow(g); wireAdvRow(g); wireGridSizeRow(g);
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
      hint.innerHTML = '<details class="hint" style="margin:0"><summary>Leave blank to use the <b>global Home Assistant token</b> you already set in Settings → Auth — the panel signs in automatically.</summary> Only fill this in if this specific dashboard needs a <i>different</i> HA token (e.g. a second HA instance): profile → Security → Long-Lived Access Tokens → Create, paste above.</details>';
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
    const canGrid = !!def && !builtinGrid && !def.hideGridInEditor;
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
    const isVoiceApp = g.app === 'ai-voice';   // one app; the hand-rendered box below branches on the page's backend
    const CV_BACKENDS = ['claude', 'codex', 'copilot', 'owui', 'api'];
    const cvBackend = CV_BACKENDS.includes(optVal(g, 'backend', 'claude')) ? optVal(g, 'backend', 'claude') : 'claude';
    const isCliBackend = cvBackend === 'claude' || cvBackend === 'codex' || cvBackend === 'copilot';
    // Permission-mode choice sets differ per CLI backend (they map to each CLI's own flags), so they
    // live here rather than in the single ai-voice apps.json entry.
    // [value, short label, supporting text] — the label is what the closed <select> shows, so it stays
    // short; the supporting text renders as a hint under the field for the selected mode.
    const CV_MODES = {
      claude: { default: 'manual', choices: [
        ['manual', 'Manual', 'Ask before every action (touch approval on the panel).'],
        ['acceptEdits', 'Accept edits', 'Auto-approve file changes; still ask for everything else.'],
        ['plan', 'Plan', "Describe, don't act, until approved."],
        ['bypassPermissions', 'Full auto', 'No prompts — use with care.'],
      ] },
      codex: { default: 'ask-for-approval', choices: [
        ['read-only', 'Read only', 'Codex can read files in the workspace; approval required to edit files or access the internet.'],
        ['ask-for-approval', 'Ask for approval', 'Codex can read, edit, and run commands in the workspace; approval required for the internet or other files.'],
        ['approve-for-me', 'Approve for me', 'Only ask for actions detected as potentially unsafe.'],
        ['full-access', 'Full access', 'Codex can edit files outside the workspace and use the internet without asking — use with caution.'],
      ] },
      copilot: { default: 'manual', choices: [
        ['manual', 'Manual', 'Ask before every action (touch approval on the panel).'],
        ['plan', 'Plan', "Describe, don't act, until approved."],
        ['auto', 'Approve for me', 'File changes and commands run automatically.'],
        ['autopilot', 'Full auto', 'Runs until the task is done, no prompts at all.'],
      ] },
    };
    const isOffice = g.app === 'office';
    const isLucidType = g.app === 'lucidtype';
    const isLiveTranslate = g.app === 'livetranslate';
    const musicBox = `<fieldset style="border:1px solid #2a3a4e; border-radius:8px; padding:6px 14px 10px; margin:10px 0">
        <legend style="padding:0 6px; color:#9fb3c8; font-size:13px">Panels <span id="musicPanelCount" class="hint" style="margin:0"></span></legend>
        <div><label class="iconopt" style="width:auto"><input type="checkbox" id="pArt" ${optVal(g, 'art', true) ? 'checked' : ''}> Show album art</label></div>
        <div><label class="iconopt" style="width:auto"><input type="checkbox" id="pLyrics" ${optVal(g, 'lyrics', false) ? 'checked' : ''}> Show lyrics</label></div>
        <div><label class="iconopt" style="width:auto"><input type="checkbox" id="gGrid" ${g.gridOn ? 'checked' : ''}> Controls grid</label></div>
        <p class="hint" style="margin:6px 0 0">Only two may be checked at once (screen space). Grid size/tiles are on the <b>Buttons</b> tab.</p>
      </fieldset>`;
    // HA Dashboard: dashboard picker (fetched from HA on render), kiosk-mode flags, then the standard Buttons toggle.
    const curDash = (g.options && g.options.dashboard) || 'lovelace';
    const haBox = `<div id="haDashBox" style="margin-top:10px">
        <div class="row"><label>Dashboard</label>
          <select id="haDashSel" style="flex:1"><option value="${esc(curDash)}" selected>${esc(curDash)} (current)</option></select>
          <button id="haDashRefresh" type="button" title="Reload the dashboard list from Home Assistant">Refresh dashboards</button></div>
        <p class="hint" id="haDashMsg" style="margin:4px 0 0">Loading dashboards…</p>
        <p class="sectitle" style="margin-top:14px">Dashboard display</p>
        <div class="row"><label style="width:auto">URL flags</label>
          <label class="iconopt" style="width:auto"><input type="checkbox" id="haKiosk" ${optVal(g, 'kiosk', false) ? 'checked' : ''}> Kiosk mode</label>
          <label class="iconopt" style="width:auto"><input type="checkbox" id="haHideHeader" ${optVal(g, 'hideHeader', false) ? 'checked' : ''}> Hide header</label>
          <label class="iconopt" style="width:auto"><input type="checkbox" id="haHideSidebar" ${optVal(g, 'hideSidebar', false) ? 'checked' : ''}> Hide sidebar</label></div>
        <details class="hint"><summary>Requires the <b>kiosk-mode</b> integration installed on your Home Assistant instance — these only set the URL flags it reads.</summary> Kiosk mode hides both header and sidebar; the other two hide just one.</details>
      </div>`;
    // Custom shortcuts cheat-sheet: edited right here, but the list itself is global/shared — see
    // shortcutRowsHtml's comment and docs/charter-keyshortcuts.md.
    const keyShortcutsBox = `<div style="margin-top:10px">
        <details class="hint" style="margin:0 0 8px"><summary>A cheat-sheet the panel displays — these rows are informational only; open-quake does not bind them.</summary> Shown as
        <b>Custom</b> on the panel, alongside open-quake's own rotation hotkey and every page's jump shortcut.
        This list is shared — editing it here updates every page that has the Keyboard Shortcuts app.</details>
        <div id="sShortcutRows">${shortcutRowsHtml((config.settings || {}).customShortcuts)}</div>
        <button id="sShortcutAdd" type="button" style="margin-top:8px">+ Add shortcut</button>
      </div>`;
    // Claude Code voice app: project picker (dynamic dir list -- can't be a static apps.json enum)
    // plus the rest of the app's options, hand-rendered here same as HA Dashboard's box does for its
    // own picker + flags rather than delegating to the generic renderAppOpts(). See docs/claude-voice.md
    // and the plan file for why projectDir specifically needs this (D:\Github\* isn't known at
    // apps.json-authoring time).
    const cvVal = (key, dflt) => optVal(g, key, dflt);
    const cvModes = CV_MODES[cvBackend] || null;
    const cvMode = (() => {   // stored mode, healed to the backend's default when it isn't one of its choices
      const v = cvVal('permissionMode', '');
      return cvModes && cvModes.choices.some(c => c[0] === v) ? v : (cvModes ? cvModes.default : '');
    })();
    const claudeVoiceBox = `<div id="cvBox" style="margin-top:10px">
        <p class="sectitle">Agent</p>
        <div class="row"><label>Backend</label>
          <select id="cvBackend" style="flex:1">
            <option value="claude" ${cvBackend === 'claude' ? 'selected' : ''}>Claude Code — CLI agent with tools</option>
            <option value="codex" ${cvBackend === 'codex' ? 'selected' : ''}>Codex — CLI agent with tools</option>
            <option value="copilot" ${cvBackend === 'copilot' ? 'selected' : ''}>Copilot — CLI agent with tools</option>
            <option value="owui" ${cvBackend === 'owui' ? 'selected' : ''}>Open WebUI — your server (Auth tab connection)</option>
            <option value="api" ${cvBackend === 'api' ? 'selected' : ''}>API endpoint — your own key (OpenAI, DeepSeek, OpenRouter, …)</option>
          </select></div>
        <p id="cvCliWarn" class="hint" style="display:none;color:#ff8a8a;font-weight:600"></p>` + (cvBackend === 'owui' ? `
        <details class="hint"><summary>Chats against the Open WebUI connection configured on <b>Settings → Auth</b> (URL, API key, default model).</summary> No working folder and no permission modes — the chat API can't touch files or run commands.</details>` : cvBackend === 'api' ? `
        <div class="row"><label>Endpoint</label>
          <select id="cvApiPreset" style="width:230px">
            <option value="openai">OpenAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Custom / LiteLLM / Ollama…</option>
          </select>
          <input id="cvApiUrl" value="${esc(cvVal('apiBaseUrl', 'https://api.openai.com/v1'))}" placeholder="https://api.openai.com/v1" style="flex:1; margin-left:8px"></div>
        <div class="row"><label>API key</label>${secretInput(cvVal('apiKey', ''), 'id="cvApiKey" style="flex:1"')}</div>
        <div class="row"><label>Model</label>
          <input id="cvApiModel" value="${esc(cvVal('apiModel', ''))}" placeholder="e.g. gpt-4o-mini" style="width:320px" autocomplete="off">
          <span class="hint" id="cvApiModelHint" style="margin:0 0 0 8px"></span></div>
        <p class="hint">Any OpenAI-compatible chat endpoint. Plain conversation — no tools, no file access. The key is stored encrypted and never reaches the panel page.</p>` : `
        <p class="sectitle" style="margin-top:14px">Workspace</p>
        <div class="row"><label>Default folder</label>
          <input id="cvProjectPath" value="${esc(cvVal('projectDir', ''))}" style="flex:1">
          <button id="cvProjectPathBrowse" type="button">Browse…</button></div>
        <p class="hint">Where a new session begins. The panel's <b>Change folder</b> pick updates this; created automatically if it doesn't exist yet.</p>
        <div class="row" style="margin-top:10px"><label style="width:auto">Folders root</label>
          <input id="cvProjectsRoot" value="${esc(cvVal('projectsRoot', ''))}" style="flex:1">
          <button id="cvProjectsRootBrowse" type="button">Browse…</button></div>
        <p class="hint">What the panel's folder picker can browse.</p>`) + `
        <p class="hint">Voice STT/TTS servers are set globally under <b>Settings → TTS/STT</b>. Override them for just this page in <b>Advanced settings</b> below.</p>
        <p class="sectitle" style="margin-top:14px">Profile &amp; instructions</p>
        <div class="row"><label>Default profile</label>
          <select id="cvProfile" style="flex:1">${(((config.settings || {}).aiProfiles) || []).map((p, i) => `<option value="${esc(p.id)}" ${(cvVal('profilePick', '') || (((config.settings || {}).aiProfiles) || [{}])[0].id) === p.id ? 'selected' : ''}>${esc(p.name || '(unnamed)')}</option>`).join('')}</select></div>
        <details class="hint"><summary>The AI profile this page starts with — a named instruction that shapes the AI (translate, summarize, write…).</summary> Switch live from the panel's <b>Profile</b> button; manage the list under <b>Settings → AI Profiles</b>.</details>` + (!cvModes ? '' : `
        <p class="sectitle" style="margin-top:14px">Permissions</p>
        <div class="row"><label>Permission mode</label>
          <select id="cvPermMode" style="flex:1">${cvModes.choices.map(c => `<option value="${esc(c[0])}" ${cvMode === c[0] ? 'selected' : ''}>${esc(c[1])}</option>`).join('')}</select></div>
        <p class="hint" id="cvPermModeHint" style="margin:2px 0 0">${esc((cvModes.choices.find(c => c[0] === cvMode) || [])[2] || '')}</p>`) + (cvBackend === 'claude' ? `
        <div class="row" id="cvApprovalsRow"${cvMode === 'manual' ? '' : ' style="display:none"'}><label>Touch approval</label>
          <label class="iconopt" style="width:auto"><input type="checkbox" id="cvApprovals" ${cvVal('approvalsEnabled', false) ? 'checked' : ''}> approve each action by tapping the panel</label></div>
        <div class="row" style="margin-top:10px"><label style="width:auto">Session instructions</label>
          <button id="cvEditPrompt" type="button">Edit prompt file</button></div>
        <details class="hint"><summary>Your own instructions for panel sessions (claude-panel-prompt.md, opens in your default editor).</summary> Appended to the built-in voice prompt; text inside &lt;!-- comment markers --&gt; is ignored. Applies from the next session start. Never affects terminal Claude Code.</details>` : '') + `
      </div>`;
    const lucidTypeBox = `<div style="margin-top:10px">
        <p class="sectitle">Microphone</p>
        <div class="row"><label>Capture device</label>
          <select id="ltMic" style="flex:1"><option value="">System default</option></select></div>
        <div class="row"><button id="ltTest" type="button">Test microphone</button>
          <div id="ltMeterWrap" style="flex:1;height:14px;border-radius:7px;background:#0e1822;border:1px solid #1b2838;overflow:hidden;margin-left:10px"><div id="ltMeter" style="height:100%;width:0%;background:#7CFFB2;transition:width .06s"></div></div></div>
        <p class="hint">The mic used for dictation. Set the input <b>level</b> in Windows Sound settings; speak with the test on and watch the bar.</p>
        <p class="sectitle formsec" style="margin-top:16px">Dictation</p>
        <div class="row"><label style="width:auto">Voice pause tolerance</label>
          <input type="number" id="ltPause" min="400" max="2500" step="100" value="${esc(String(optVal(g, 'silenceMs', 400)))}" style="width:110px">
          <span class="hint" style="margin:0 0 0 8px">ms of silence before a phrase is transcribed (400–2500; 400–800 works well)</span></div>
        <details class="hint"><summary>Lower = snappier; higher = fewer mid-sentence cutoffs.</summary> Applies on the next dictation start.</details>

        <p class="sectitle formsec" style="margin-top:16px">Hotkeys</p>
        <div class="row"><label style="width:auto">Start / stop dictation</label>
          <span class="hkwrap"><input id="ltDictKey" readonly placeholder="click, then press keys" value="${esc(optVal(g, 'dictationHotkey', ''))}"><button id="ltDictKeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span></div>
        <div class="row"><label style="width:auto">When starting a new dictation</label>
          <select id="ltStartMode" style="width:230px">
            <option value="clear" ${optVal(g, 'startMode', 'clear') === 'append' ? '' : 'selected'}>Clears the box and starts fresh</option>
            <option value="append" ${optVal(g, 'startMode', 'clear') === 'append' ? 'selected' : ''}>Appends to the existing text</option>
          </select></div>
        <div class="row"><label style="width:auto">Apply text</label>
          <span class="hkwrap"><input id="ltApplyKey" readonly placeholder="click, then press keys" value="${esc(optVal(g, 'applyHotkey', ''))}"><button id="ltApplyKeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span></div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="ltApplyStops" ${optVal(g, 'applyStopsRecording', true) ? 'checked' : ''}> Apply text also stops recording</label></div>
        <p class="hint">Global combos (need a modifier) that fire from any app. To <b>jump to this page</b>, use the page's <b>Jump-to-page shortcut</b> below. Applies on Save.</p>

        <p class="sectitle formsec" style="margin-top:16px">Notifications</p>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="ltSwitch" ${optVal(g, 'switchOnDictate', true) ? 'checked' : ''}> Switch the panel to this page when dictation starts</label></div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="ltColor" ${optVal(g, 'notifyColorChange', false) ? 'checked' : ''}> Turn the tray icon red while recording</label></div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="ltBeep" ${optVal(g, 'notifyBeep', false) ? 'checked' : ''}> Beep on dictation start/stop</label></div>
        <p class="hint">Transcription server is the global <b>Settings → TTS/STT</b>; override it for this page under <b>Advanced settings</b> below.</p>

        <p class="sectitle formsec" style="margin-top:18px">AI (Cleanup &amp; Rewrite)</p>
        <div class="row"><label style="width:auto">Backend</label>
          <select id="ltAiBackend" style="width:230px">
            <option value="claude">Claude</option><option value="codex">Codex</option>
            <option value="copilot">Copilot</option><option value="owui">Open WebUI</option>
          </select></div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="ltUseEndpoint" ${optVal(g, 'useEndpoint', false) ? 'checked' : ''}> Use a direct OpenAI-compatible endpoint instead</label></div>
        <div id="ltEndpointRows" style="display:${optVal(g, 'useEndpoint', false) ? '' : 'none'}">
          <div class="row"><label>Endpoint URL</label><input id="ltEndpoint" value="${esc(optVal(g, 'endpoint', ''))}" placeholder="https://host/v1" style="flex:1"></div>
          <div class="row"><label>API key</label><input id="ltEndpointKey" type="password" value="${esc(optVal(g, 'endpointKey', ''))}" placeholder="blank if none" style="flex:1"></div>
          <div class="row"><label>Timeout (ms)</label><input type="number" id="ltAiTimeout" min="1000" max="600000" step="1000" value="${esc(String(optVal(g, 'aiTimeoutMs', 30000)))}" style="width:120px"></div>
          <div class="row"><button id="ltEndpointTest" type="button">Check connection</button><span id="ltEndpointTestMsg" class="hint" style="margin:0 0 0 10px"></span></div>
        </div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="ltOverrideModel" ${optVal(g, 'overrideModel', false) ? 'checked' : ''}> Override model</label></div>
        <div id="ltModelRow" style="display:${optVal(g, 'overrideModel', false) ? '' : 'none'}">
          <div class="row"><label>Model</label><input id="ltModel" value="${esc(optVal(g, 'model', ''))}" placeholder="e.g. glm-4.7-flash" style="flex:1"></div>
        </div>
        <details class="hint"><summary>Cleanup/Rewrite send the box text to this AI.</summary> By default the chosen integrated agent (Claude/Codex/Copilot need the CLI on PATH; Open WebUI uses the <b>Auth</b> tab connection). Tick <b>Use Endpoint</b> to POST to an OpenAI-compatible <code>/chat/completions</code> server directly (needs a model — tick Override model).</details>

        <details class="advsec" style="margin-top:14px">
          <summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Cleanup — fix grammar / filler <span class="hint" style="margin:0">${optVal(g, 'cleanupHotkey', '') ? '(' + esc(optVal(g, 'cleanupHotkey', '')) + ')' : '(no hotkey)'}</span></summary>
          <div class="row" style="margin-top:8px"><label style="width:auto">Hotkey</label>
            <span class="hkwrap"><input id="ltCleanupKey" readonly placeholder="click, then press keys" value="${esc(optVal(g, 'cleanupHotkey', ''))}"><button id="ltCleanupKeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span></div>
          <div class="row" style="margin-top:6px"><label style="width:auto">Prompt</label></div>
          <textarea id="ltCleanupPrompt" rows="5" style="width:100%">${esc(optVal(g, 'cleanupPrompt', '') || LT_DEFAULT_CLEANUP_PROMPT)}</textarea>
          <p class="hint">System prompt for Cleanup. Applies on Save.</p>
        </details>

        <details class="advsec" style="margin-top:10px">
          <summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Rewrite — restyle <span class="hint" style="margin:0">${optVal(g, 'rewriteHotkey', '') ? '(' + esc(optVal(g, 'rewriteHotkey', '')) + ')' : '(no hotkey)'}</span></summary>
          <div class="row" style="margin-top:8px"><label style="width:auto">Hotkey</label>
            <span class="hkwrap"><input id="ltRewriteKey" readonly placeholder="click, then press keys" value="${esc(optVal(g, 'rewriteHotkey', ''))}"><button id="ltRewriteKeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span></div>
          <div class="row"><label style="width:auto">Default mode</label>
            <select id="ltRewriteMode" style="width:200px">
              <option value="professional">Professional</option><option value="concise">Concise</option>
              <option value="confident">Confident</option><option value="custom">Custom</option>
            </select></div>
          <p class="hint" style="margin-top:6px">Edit any style's prompt (blank = built-in default). The <b>Default mode</b> is the live one; switch it any time from the panel's <b>Mode</b> button.</p>
          <div class="row"><label style="width:auto">Professional</label></div>
          <textarea id="ltRwProfessional" rows="3" style="width:100%">${esc(optVal(g, 'rewritePromptProfessional', '') || LT_REWRITE_PRESETS.professional)}</textarea>
          <div class="row"><label style="width:auto">Concise</label></div>
          <textarea id="ltRwConcise" rows="3" style="width:100%">${esc(optVal(g, 'rewritePromptConcise', '') || LT_REWRITE_PRESETS.concise)}</textarea>
          <div class="row"><label style="width:auto">Confident</label></div>
          <textarea id="ltRwConfident" rows="3" style="width:100%">${esc(optVal(g, 'rewritePromptConfident', '') || LT_REWRITE_PRESETS.confident)}</textarea>
          <div class="row"><label style="width:auto">Custom</label></div>
          <textarea id="ltRewriteCustom" rows="3" style="width:100%" placeholder="Used when mode = Custom">${esc(optVal(g, 'rewriteCustomPrompt', ''))}</textarea>
        </details>
      </div>`;
    const xlProvider = optVal(g, 'provider', 'soniox') === 'ai' ? 'ai' : 'soniox';
    const liveTranslateBox = `<div style="margin-top:10px">
        <p class="sectitle">Translation service</p>
        <div class="row"><label>Provider</label>
          <select id="xlProvider" style="flex:1">
            <option value="soniox" ${xlProvider === 'soniox' ? 'selected' : ''}>Soniox — cloud real-time translation (recommended)</option>
            <option value="ai" ${xlProvider === 'ai' ? 'selected' : ''}>AI translate — your own API key (DeepSeek, OpenAI, …)</option>
          </select></div>
        ${xlProvider === 'soniox' ? `
        <div class="row"><label>Soniox API key</label>${secretInput(optVal(g, 'sonioxApiKey', ''), 'id="xlSoniKey" style="flex:1"')}</div>
        <p class="hint">From <b>soniox.com</b>. Stored encrypted; the panel uses a short-lived temp key so the real key never leaves this machine. ~$0.18/hr while actively translating.</p>
        <div class="row" style="margin-top:10px"><label>Target language</label>
          <input id="xlTargetLang" value="${esc(optVal(g, 'targetLanguage', 'en'))}" placeholder="en" style="width:120px"></div>
        <div class="row"><label>Source hint</label>
          <input id="xlSourceHint" value="${esc(optVal(g, 'sourceHint', ''))}" placeholder="blank = auto-detect (e.g. de)" style="width:230px"></div>
        <p class="hint">Language codes (en, es, de, …) — <a href="#" id="xlLangLink">browse all Soniox languages ↗</a>. Source hint is optional; Soniox auto-detects otherwise (setting it removes the startup delay).</p>` : `
        <div class="row"><label>Endpoint</label>
          <select id="xlAiPreset" style="width:230px">
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Custom / Open WebUI…</option>
          </select>
          <input id="xlAiUrl" value="${esc(optVal(g, 'aiBaseUrl', 'https://api.deepseek.com'))}" placeholder="https://api.deepseek.com" style="flex:1; margin-left:8px"></div>
        <div class="row"><label>API key</label>${secretInput(optVal(g, 'aiApiKey', ''), 'id="xlAiKey" style="flex:1"')}</div>
        <div class="row"><label>Model</label>
          <input id="xlAiModel" value="${esc(optVal(g, 'aiModel', 'deepseek-v4-flash'))}" placeholder="deepseek-v4-flash" style="width:230px"></div>
        <div class="row" style="margin-top:10px"><label>Target language</label>
          <input id="xlTargetLang" value="${esc(optVal(g, 'targetLanguage', 'en'))}" placeholder="en (or any language name)" style="width:230px"></div>
        <details class="hint"><summary>Any OpenAI-compatible chat endpoint (DeepSeek ≈ $0.10/hr, OpenAI, a local Open WebUI/Ollama…).</summary> Utterances are transcribed by your <b>Settings → TTS/STT</b> server first — its model must be <b>multilingual</b> (Parakeet v3 or Whisper small/medium/large; the Distil-Whisper models are English-only) — then translated with recent-line context, so captions arrive per phrase — a beat behind speech, not word-by-word like Soniox. Key stored encrypted, used only from the main process.</details>`}
        <p class="sectitle" style="margin-top:14px">Microphone &amp; activation</p>
        <div class="row"><label>Capture device</label>
          <select id="xlMic" style="flex:1"><option value="">System default</option></select></div>
        <p class="hint">The mic used for live translation (also selectable from the panel's Settings).</p>
        <div class="row" style="margin-top:10px"><label style="width:auto">Toggle translation shortcut</label>
          <span class="hkwrap"><input id="xlHotkey" readonly placeholder="click, then press keys" value="${esc(optVal(g, 'micHotkey', ''))}"><button id="xlHotkeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span><span id="xlHotkeyWarn" class="hint warn" style="margin:0 0 0 8px"></span></div>
        <p class="hint">Starts/stops translation from any app — it switches to this page and toggles the mic. This is separate from the <b>Jump-to-page shortcut</b> below, which only navigates. Applies on Save.</p>
        <p class="sectitle" style="margin-top:14px">Transcript saving</p>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="xlSave" ${optVal(g, 'saveToFile', false) ? 'checked' : ''}> Save transcript to a file</label></div>
        <div id="xlSaveDeps"${optVal(g, 'saveToFile', false) ? '' : ' style="display:none"'}>
        <div class="row"><label>Save folder</label>
          <input id="xlSaveFolder" value="${esc(optVal(g, 'saveFolder', ''))}" placeholder="Documents\\OpenQuake Translations" readonly style="flex:1">
          <button id="xlSaveFolderBrowse" type="button">Browse…</button></div>
        <p class="hint">Where saved translations are written. Blank = <b>Documents\\OpenQuake Translations</b> (the default).</p>
        </div>
      </div>`;
    const optsBlock = isMusic ? musicBox : isHaDash ? haBox : isKeyShortcuts ? keyShortcutsBox : isVoiceApp ? claudeVoiceBox : isLucidType ? lucidTypeBox : isLiveTranslate ? liveTranslateBox : isOffice ? officeOptionsHtml(g, def) : '<div id="appOpts"></div>';
    el.innerHTML = tabBar + `
      <div class="row"><label>Name</label><input id="gName" value="${esc(g.name)}"></div>
      <div class="row"><label>App</label><select id="gApp" style="flex:1;width:auto">
        <option value="">— choose an app —</option>
        ${appDefs.filter(a => a.id === g.app || appVisible(a)).sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })).map(a => `<option value="${esc(a.id)}" ${a.id === g.app ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
      </select><button id="refreshApps" type="button" title="Reload app manifests">Reload app list</button></div>
      ${def && def.oauth ? '<div id="appOAuth"></div>' : ''}
      ${optsBlock}
      <div id="appPreviewHost"></div>
      ${pageBehaviorHtml(g, canGrid && !isMusic)}
      <div class="row" style="margin-top:10px"><button id="gFocus">Show on device</button></div>
      ${def ? '' : '<p class="hint">Pick an app, then set its options below.</p>'}
      <div class="dangerzone"><p class="dzlabel">Danger zone</p><button class="danger" id="gDelete">Delete page</button></div>`;
    const atb = document.getElementById('atBtns'); if (atb) atb.onclick = () => { dashTab = 'buttons'; render(); };
    document.getElementById('gName').oninput = e => { g.name = e.target.value; renderGrids(); markDirty(); };
    document.getElementById('gApp').onchange = e => { setApp(g, e.target.value); render(); markDirty(); };
    document.getElementById('refreshApps').onclick = refreshApps;
    document.getElementById('gDelete').onclick = deleteCurrentPage;
    { const fb = document.getElementById('gFocus'); if (fb) fb.onclick = focusCurrentPage; }
    if (def && def.oauth) appendDropInOAuthSetup(document.getElementById('appOAuth'), def);
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
      // Backend switch re-renders the box so the backend-specific rows swap in (Live Translate's
      // provider-select pattern). Heal the stored mode to the new backend's default so a stale
      // claude mode never reaches the codex CLI (and vice versa).
      document.getElementById('cvBackend').onchange = e => {
        setOpt('backend', e.target.value);
        const m = CV_MODES[e.target.value];
        setOpt('permissionMode', m ? m.default : '');
        render();
      };
      if (cvModes && cvVal('permissionMode', '') !== cvMode) setOpt('permissionMode', cvMode);   // persist the healed mode
      // Default folder is a plain text box -- actual folder switching happens on the panel
      // (Change folder), which writes its pick back into this same option. The folder and
      // permission-mode rows only exist for CLI backends, hence the existence guards.
      const cvProjectPath = document.getElementById('cvProjectPath');
      if (cvProjectPath) cvProjectPath.oninput = e => setOpt('projectDir', e.target.value.trim());
      const cvProjectsRoot = document.getElementById('cvProjectsRoot');
      if (cvProjectsRoot) cvProjectsRoot.oninput = e => setOpt('projectsRoot', e.target.value.trim());
      const cvProjectPathBrowse = document.getElementById('cvProjectPathBrowse');
      if (cvProjectPathBrowse) cvProjectPathBrowse.onclick = async () => { const p = await configApi.pickFolder(); if (p) { document.getElementById('cvProjectPath').value = p; setOpt('projectDir', p); } };
      const cvProjectsRootBrowse = document.getElementById('cvProjectsRootBrowse');
      if (cvProjectsRootBrowse) cvProjectsRootBrowse.onclick = async () => { const p = await configApi.pickFolder(); if (p) { document.getElementById('cvProjectsRoot').value = p; setOpt('projectsRoot', p); } };
      const cvPermMode = document.getElementById('cvPermMode');
      const CV_DANGER_MODES = ['bypassPermissions', 'full-access', 'autopilot'];
      const syncPermModeUi = mode => {
        const h = document.getElementById('cvPermModeHint');
        if (h && cvModes) {
          const danger = CV_DANGER_MODES.includes(mode);
          h.textContent = danger ? '⚠ Commands run without approval in this mode.'
            : (cvModes.choices.find(c => c[0] === mode) || [])[2] || '';
          h.className = 'hint' + (danger ? ' warn' : '');
        }
        const ar = document.getElementById('cvApprovalsRow');
        if (ar) ar.style.display = mode === 'manual' ? '' : 'none';
      };
      if (cvPermMode) { syncPermModeUi(cvPermMode.value); cvPermMode.onchange = e => { setOpt('permissionMode', e.target.value); syncPermModeUi(e.target.value); }; }
      const cvProfile = document.getElementById('cvProfile');
      if (cvProfile) cvProfile.onchange = e => setOpt('profilePick', e.target.value);
      const cvApprovals = document.getElementById('cvApprovals');   // claude-only rows
      if (cvApprovals) cvApprovals.onchange = e => setOpt('approvalsEnabled', e.target.checked);
      const cvEditPrompt = document.getElementById('cvEditPrompt');
      if (cvEditPrompt) cvEditPrompt.onclick = () => configApi.editClaudeVoicePrompt();
      // API backend rows: preset fills URL+model (stored truth is always apiBaseUrl/apiModel).
      const CV_API_PRESETS = { openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-v4-flash' }, openrouter: { url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' } };
      const cvApiUrl = document.getElementById('cvApiUrl');
      if (cvApiUrl) {
        const preset = document.getElementById('cvApiPreset');
        const cur = cvApiUrl.value.trim();
        preset.value = cur === CV_API_PRESETS.openai.url ? 'openai' : cur === CV_API_PRESETS.deepseek.url ? 'deepseek' : cur === CV_API_PRESETS.openrouter.url ? 'openrouter' : 'custom';
        preset.onchange = e => { const p = CV_API_PRESETS[e.target.value]; if (p) { cvApiUrl.value = p.url; setOpt('apiBaseUrl', p.url); document.getElementById('cvApiModel').value = p.model; setOpt('apiModel', p.model); } };
        cvApiUrl.oninput = e => setOpt('apiBaseUrl', e.target.value.trim());
        document.getElementById('cvApiKey').onchange = e => setOpt('apiKey', e.target.value);
        document.getElementById('cvApiModel').oninput = e => setOpt('apiModel', e.target.value.trim());
        // Fill the Model picker from the endpoint's standard /models. On success the text input is
        // swapped for a real <select> (a datalist filters by the box's current text, so with any
        // value present it looks broken); "Type a model name…" swaps back for unlisted models.
        // Typing always works pre-fetch and on failure. Re-fetched when URL or key change.
        const cvFillModels = () => {
          const hint = document.getElementById('cvApiModelHint');
          const inp = document.getElementById('cvApiModel');
          const url = cvApiUrl.value.trim(), key = document.getElementById('cvApiKey').value;
          if (!url || !key || !inp) { if (hint) hint.textContent = ''; return; }
          if (hint) hint.textContent = 'loading models…';
          configApi.probeApiModels(url, key).then(r => {
            if (!hint || !inp) return;
            if (!(r && r.ok && r.models && r.models.length)) {
              hint.textContent = r && r.error ? 'model list unavailable: ' + r.error : 'model list unavailable';
              return;
            }
            let sel = document.getElementById('cvApiModelSel');
            if (!sel) {
              sel = document.createElement('select');
              sel.id = 'cvApiModelSel';
              sel.style.width = '320px';
              inp.parentElement.insertBefore(sel, inp);
            }
            const cur = inp.value.trim();
            sel.innerHTML = '';
            const add = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label || v; sel.appendChild(o); };
            if (cur && !r.models.includes(cur)) add(cur, cur + ' (not in the list)');
            r.models.forEach(m => add(m));
            add('__custom__', 'Type a model name…');
            sel.value = cur && !r.models.includes(cur) ? cur : (r.models.includes(cur) ? cur : r.models[0]);
            inp.style.display = 'none';
            sel.onchange = e => {
              if (e.target.value === '__custom__') { sel.remove(); inp.style.display = ''; inp.focus(); inp.select(); return; }
              inp.value = e.target.value;
              setOpt('apiModel', e.target.value);
            };
            // The select landing on the first model (empty box case) is a real pick — persist it.
            if (!cur && sel.value) { inp.value = sel.value; setOpt('apiModel', sel.value); }
            hint.textContent = r.models.length + ' models';
          }).catch(() => { if (hint) hint.textContent = 'model list unavailable'; });
        };
        cvFillModels();
        cvApiUrl.onchange = cvFillModels;
        document.getElementById('cvApiKey').addEventListener('change', cvFillModels);
      }
      // Warn at add-time if the backend's CLI isn't installed (or, for owui, if no connection is
      // configured) -- otherwise the user only finds out when the panel page errors on first use.
      if (cvBackend !== 'api') configApi.probeVoiceCli(cvBackend).then(p => {
        const warn = document.getElementById('cvCliWarn');
        if (warn && !p) {
          if (cvBackend === 'owui') {
            warn.textContent = '⚠ Open WebUI connection not configured — set the URL on Settings → Auth or this page won\'t work.';
          } else {
            warn.textContent = '⚠ The ' + cvBackend + ' CLI was not found on PATH — this page won\'t work until it is installed.';
          }
          warn.style.display = '';
        }
      }).catch(() => {});
    } else if (isLucidType) {
      const setOpt = (key, val) => { if (!g.options) g.options = {}; g.options[key] = val; markDirty(); };
      // Live mic test meter — peak level off a getUserMedia AnalyserNode; torn down on re-render (render()).
      function startLtMeter(label) {
        if (ltMeterStop) { ltMeterStop(); }
        const wrap = document.getElementById('ltMeterWrap'), bar = document.getElementById('ltMeter');
        if (wrap) wrap.style.display = '';
        let stream = null, ctx = null, raf = 0, dead = false;
        ltMeterStop = () => { dead = true; try { cancelAnimationFrame(raf); } catch (e) {} try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {} try { if (ctx) ctx.close(); } catch (e) {} if (wrap) wrap.style.display = 'none'; if (bar) bar.style.width = '0%'; ltMeterStop = null; };
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (grant) {
          return (label ? navigator.mediaDevices.enumerateDevices() : Promise.resolve([])).then(function (devs) {
            var m = (devs || []).find(function (d) { return d.kind === 'audioinput' && d.label === label; });
            grant.getTracks().forEach(function (t) { t.stop(); });
            return navigator.mediaDevices.getUserMedia({ audio: m ? { deviceId: { ideal: m.deviceId } } : true });
          });
        }).then(function (s) {
          if (dead) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
          stream = s;
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          var an = ctx.createAnalyser(); an.fftSize = 512;
          ctx.createMediaStreamSource(stream).connect(an);
          var data = new Uint8Array(an.fftSize);
          var tick = function () {
            an.getByteTimeDomainData(data);
            var peak = 0; for (var i = 0; i < data.length; i++) { var v = Math.abs(data[i] - 128); if (v > peak) peak = v; }
            if (bar) bar.style.width = Math.min(100, Math.round((peak / 128) * 140)) + '%';
            raf = requestAnimationFrame(tick);
          };
          tick();
        }).catch(function () { if (ltMeterStop) ltMeterStop(); });
      }
      (function () {
        const sel = document.getElementById('ltMic'); const cur = optVal(g, 'micDevice', '');
        const fill = devs => {
          const inputs = (devs || []).filter(d => d.kind === 'audioinput' && d.label);
          sel.innerHTML = '<option value="">System default</option>';
          inputs.forEach(d => { const o = document.createElement('option'); o.value = d.label; o.textContent = d.label; sel.appendChild(o); });
          if (cur && !inputs.some(d => d.label === cur)) { const o = document.createElement('option'); o.value = cur; o.textContent = cur + ' (not connected)'; sel.appendChild(o); }
          sel.value = cur;
          sel.onchange = e => { setOpt('micDevice', e.target.value); if (ltMeterStop) startLtMeter(e.target.value); };
        };
        navigator.mediaDevices.enumerateDevices().then(devs => {
          if ((devs || []).some(d => d.kind === 'audioinput' && d.label)) return fill(devs);
          navigator.mediaDevices.getUserMedia({ audio: true })
            .then(tmp => navigator.mediaDevices.enumerateDevices().then(d2 => { tmp.getTracks().forEach(t => t.stop()); fill(d2); }))
            .catch(() => fill(devs));
        }).catch(() => fill([]));
      })();
      document.getElementById('ltTest').onclick = e => {
        if (ltMeterStop) { ltMeterStop(); ltMeterStop = null; const b = document.getElementById('ltMeter'); if (b) b.style.width = '0%'; e.target.textContent = 'Test microphone'; }
        else { startLtMeter(document.getElementById('ltMic').value); e.target.textContent = 'Stop test'; }
      };
      const ltDictKey = document.getElementById('ltDictKey'), ltApplyKey = document.getElementById('ltApplyKey');
      ltDictKey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { ltDictKey.value = acc; setOpt('dictationHotkey', acc); } };
      document.getElementById('ltDictKeyClear').onclick = () => { ltDictKey.value = ''; setOpt('dictationHotkey', ''); };
      ltApplyKey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { ltApplyKey.value = acc; setOpt('applyHotkey', acc); } };
      document.getElementById('ltApplyKeyClear').onclick = () => { ltApplyKey.value = ''; setOpt('applyHotkey', ''); };
      document.getElementById('ltSwitch').onchange = e => setOpt('switchOnDictate', e.target.checked);
      document.getElementById('ltColor').onchange = e => setOpt('notifyColorChange', e.target.checked);
      document.getElementById('ltBeep').onchange = e => setOpt('notifyBeep', e.target.checked);
      document.getElementById('ltPause').onchange = e => { const v = Math.max(400, Math.min(2500, parseInt(e.target.value, 10) || 400)); e.target.value = v; setOpt('silenceMs', v); };
      document.getElementById('ltStartMode').onchange = e => setOpt('startMode', e.target.value);
      document.getElementById('ltApplyStops').onchange = e => setOpt('applyStopsRecording', e.target.checked);
      // AI backend + endpoint/model reveals
      const ltAiBackend = document.getElementById('ltAiBackend');
      ltAiBackend.value = optVal(g, 'aiBackend', 'claude');
      ltAiBackend.onchange = e => setOpt('aiBackend', e.target.value);
      document.getElementById('ltUseEndpoint').onchange = e => { setOpt('useEndpoint', e.target.checked); document.getElementById('ltEndpointRows').style.display = e.target.checked ? '' : 'none'; };
      document.getElementById('ltEndpoint').oninput = e => setOpt('endpoint', e.target.value.trim());
      document.getElementById('ltEndpointKey').oninput = e => setOpt('endpointKey', e.target.value);
      document.getElementById('ltOverrideModel').onchange = e => { setOpt('overrideModel', e.target.checked); document.getElementById('ltModelRow').style.display = e.target.checked ? '' : 'none'; };
      document.getElementById('ltModel').oninput = e => setOpt('model', e.target.value.trim());
      document.getElementById('ltAiTimeout').onchange = e => { const v = Math.max(1000, Math.min(600000, parseInt(e.target.value, 10) || 30000)); e.target.value = v; setOpt('aiTimeoutMs', v); };
      // Check connection: probes <endpoint>/models with the values as typed (no Save needed first).
      const ltEpTest = document.getElementById('ltEndpointTest'), ltEpMsg = document.getElementById('ltEndpointTestMsg');
      if (ltEpTest) ltEpTest.onclick = async () => {
        const url = (document.getElementById('ltEndpoint').value || '').trim();
        if (!url) { ltEpMsg.textContent = 'Enter an endpoint URL first.'; ltEpMsg.className = 'hint warn'; return; }
        ltEpTest.disabled = true; ltEpMsg.className = 'hint'; ltEpMsg.textContent = 'Checking…';
        try {
          const r = await configApi.probeApiModels(url, document.getElementById('ltEndpointKey').value || '');
          if (!(r && r.ok)) throw new Error((r && r.error) || 'connection failed');
          ltEpMsg.textContent = 'Connected — ' + (r.models || []).length + ' model(s)';
        } catch (err) { ltEpMsg.textContent = 'Failed: ' + (err.message || err); ltEpMsg.className = 'hint warn'; }
        finally { ltEpTest.disabled = false; }
      };
      // Cleanup section
      const ltCleanupKey = document.getElementById('ltCleanupKey');
      ltCleanupKey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { ltCleanupKey.value = acc; setOpt('cleanupHotkey', acc); } };
      document.getElementById('ltCleanupKeyClear').onclick = () => { ltCleanupKey.value = ''; setOpt('cleanupHotkey', ''); };
      document.getElementById('ltCleanupPrompt').oninput = e => setOpt('cleanupPrompt', e.target.value);
      // Rewrite section
      const ltRewriteKey = document.getElementById('ltRewriteKey');
      ltRewriteKey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { ltRewriteKey.value = acc; setOpt('rewriteHotkey', acc); } };
      document.getElementById('ltRewriteKeyClear').onclick = () => { ltRewriteKey.value = ''; setOpt('rewriteHotkey', ''); };
      const ltRewriteMode = document.getElementById('ltRewriteMode');
      ltRewriteMode.value = optVal(g, 'rewriteMode', 'professional');
      ltRewriteMode.onchange = e => setOpt('rewriteMode', e.target.value);
      document.getElementById('ltRwProfessional').oninput = e => setOpt('rewritePromptProfessional', e.target.value);
      document.getElementById('ltRwConcise').oninput = e => setOpt('rewritePromptConcise', e.target.value);
      document.getElementById('ltRwConfident').oninput = e => setOpt('rewritePromptConfident', e.target.value);
      document.getElementById('ltRewriteCustom').oninput = e => setOpt('rewriteCustomPrompt', e.target.value);
    } else if (isLiveTranslate) {
      const setOpt = (key, val) => { if (!g.options) g.options = {}; g.options[key] = val; markDirty(); };
      document.getElementById('xlProvider').onchange = e => { setOpt('provider', e.target.value); render(); };   // re-render to swap provider-specific fields
      const soniKey = document.getElementById('xlSoniKey'); if (soniKey) soniKey.onchange = e => setOpt('sonioxApiKey', e.target.value);
      const sh = document.getElementById('xlSourceHint'); if (sh) sh.oninput = e => setOpt('sourceHint', e.target.value.trim());
      const xlLangLink = document.getElementById('xlLangLink'); if (xlLangLink) xlLangLink.onclick = e => { e.preventDefault(); configApi.openExternal('https://soniox.com/docs/stt/concepts/supported-languages'); };
      document.getElementById('xlTargetLang').oninput = e => setOpt('targetLanguage', e.target.value.trim());
      document.getElementById('xlSave').onchange = e => { setOpt('saveToFile', e.target.checked); const d = document.getElementById('xlSaveDeps'); if (d) d.style.display = e.target.checked ? '' : 'none'; };
      document.getElementById('xlSaveFolderBrowse').onclick = async () => { const p = await configApi.pickFolder(); if (p) { document.getElementById('xlSaveFolder').value = p; setOpt('saveFolder', p); } };
      // AI provider fields. The endpoint preset is a convenience that fills URL + model; the stored
      // truth is always aiBaseUrl/aiModel, so "Custom" covers Open WebUI, Ollama, or anything else.
      const AI_PRESETS = { deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-v4-flash' }, openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, openrouter: { url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' } };
      const xlAiUrl = document.getElementById('xlAiUrl'), xlAiPreset = document.getElementById('xlAiPreset');
      if (xlAiUrl) {
        const cur = xlAiUrl.value.trim();
        xlAiPreset.value = cur === AI_PRESETS.deepseek.url ? 'deepseek' : cur === AI_PRESETS.openai.url ? 'openai' : cur === AI_PRESETS.openrouter.url ? 'openrouter' : 'custom';
        xlAiPreset.onchange = e => { const p = AI_PRESETS[e.target.value]; if (p) { xlAiUrl.value = p.url; setOpt('aiBaseUrl', p.url); document.getElementById('xlAiModel').value = p.model; setOpt('aiModel', p.model); } };
        xlAiUrl.oninput = e => { setOpt('aiBaseUrl', e.target.value.trim()); };
        document.getElementById('xlAiKey').onchange = e => setOpt('aiApiKey', e.target.value);
        document.getElementById('xlAiModel').oninput = e => setOpt('aiModel', e.target.value.trim());
      }
      const xlHotkey = document.getElementById('xlHotkey');
      if (xlHotkey) {
        const xlOwn = () => 'translation toggle on “' + (g.name || '(unnamed)') + '”';
        refreshHotkeyWarn('xlHotkey', xlOwn());
        xlHotkey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { xlHotkey.value = acc; setOpt('micHotkey', acc); refreshHotkeyWarn('xlHotkey', xlOwn()); } };
        document.getElementById('xlHotkeyClear').onclick = () => { xlHotkey.value = ''; setOpt('micHotkey', ''); refreshHotkeyWarn('xlHotkey', xlOwn()); };
      }
      // Microphone dropdown — the app's default capture device (same pattern as LucidType/Meeting).
      // enumerateDevices exposes labels only after a getUserMedia grant, so grab-then-release once.
      (function () {
        const sel = document.getElementById('xlMic'); const cur = optVal(g, 'micDevice', '');
        const fill = devs => {
          const inputs = (devs || []).filter(d => d.kind === 'audioinput' && d.label);
          sel.innerHTML = '<option value="">System default</option>';
          inputs.forEach(d => { const o = document.createElement('option'); o.value = d.label; o.textContent = d.label; sel.appendChild(o); });
          if (cur && !inputs.some(d => d.label === cur)) { const o = document.createElement('option'); o.value = cur; o.textContent = cur + ' (not connected)'; sel.appendChild(o); }
          sel.value = cur;
          sel.onchange = e => setOpt('micDevice', e.target.value);
        };
        navigator.mediaDevices.enumerateDevices().then(devs => {
          if ((devs || []).some(d => d.kind === 'audioinput' && d.label)) return fill(devs);
          navigator.mediaDevices.getUserMedia({ audio: true })
            .then(tmp => navigator.mediaDevices.enumerateDevices().then(d2 => { tmp.getTracks().forEach(t => t.stop()); fill(d2); }))
            .catch(() => fill(devs));
        }).catch(() => fill([]));
      })();
    } else if (isOffice) {
      wireOfficeOptions(g);
    } else {
      renderAppOpts(g, def);
    }
    wireRotRow(g); wireShortcutRow(g); wireAdvRow(g); wireGridSizeRow(g);
    if (def) {
      const host = document.getElementById('appPreviewHost');
      if (def.editor) appendAppEditorSurface(host, g, def);
      else appendAppPreview(host, g);
    }
    enforceMusicCap(g);
  }
  // OAuth belongs to the installed app, so its lifecycle controls sit with that app's page
  // configuration instead of in the global Settings -> Auth provider list. The main process binds
  // every call to app:<id>; tokens and provider credentials never cross this renderer boundary.
  async function appendDropInOAuthSetup(el, def) {
    if (!el || !def || !def.oauth) return;
    // "selfManaged": the app renders its own connect/disconnect UI, so the editor draws no
    // account chrome at all. Provider registration and the app's ctx.oauth bridge are unchanged.
    if (def.oauth.selfManaged) return;
    const box = document.createElement('div');
    box.className = 'advsec';
    box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #213145;border-radius:8px';
    el.appendChild(box);
    let notice = '';
    let noticeBad = false;
    let expanded = false;   // healthy Connected state collapses to one line until the user clicks Manage

    const expiry = value => {
      if (!value) return '';
      const minutes = Math.round((Number(value) - Date.now()) / 60000);
      if (minutes < 0) return ' · token expired';
      if (minutes < 60) return ' · expires in ' + minutes + ' min';
      return ' · expires in ' + Math.round(minutes / 60) + ' h';
    };
    const draw = async () => {
      if (!box.isConnected) return null;
      let status;
      try { status = await configApi.getAppOAuthStatus(def.id); }
      catch (error) { status = { ok: false, error: error.message || String(error) }; }
      if (!box.isConnected) return status;
      const connected = !!(status && status.ok && status.connected);
      const configured = !!(status && status.ok && status.configured);
      const state = connected ? 'Connected' + expiry(status.expiresAt) : configured ? 'Ready to connect' : 'Not configured';
      const scopes = Array.isArray(def.oauth.scopes) ? def.oauth.scopes.join(' ') : '';
      // Healthy connected account with nothing to report: one summary line. First connect,
      // errors, and expired tokens keep the full card so recovery is never hidden.
      const healthy = connected && !notice && !(status && status.ok === false) && !/expired/.test(state);
      if (healthy && !expanded) {
        box.innerHTML = `<div class="row" style="gap:8px;align-items:center;margin:0">
            <label style="width:auto;font-weight:bold">${esc(def.oauth.name || def.name || 'App')} account</label>
            <span class="hint" style="margin:0">${esc(state)}</span>
            <button id="appOauthManage" style="margin-left:auto">Manage</button>
          </div>`;
        box.querySelector('#appOauthManage').onclick = () => { expanded = true; draw(); };
        return status;
      }
      box.innerHTML = `<div class="row" style="gap:8px;align-items:center">
          <label style="width:auto;font-weight:bold">${esc(def.oauth.name || def.name || 'App')} account</label>
          <span class="hint" style="margin:0">${esc(state)}</span>
          <span id="appOauthMsg" class="hint" style="margin:0 0 0 auto;color:${noticeBad ? '#c98' : '#7e93ab'}">${esc(notice || (status && status.ok ? '' : (status && status.error) || 'OAuth status unavailable'))}</span>
        </div>
        ${def.oauth.clientId ? '<div class="row"><label>Application</label><span class="hint" style="margin:0">Provided by this drop-in app</span></div>' : ''}
        <div class="row"><label>Permissions</label><span class="hint" style="margin:0">${esc(scopes || 'Declared by the app')}</span></div>
        <p class="hint">This account and its encrypted tokens belong only to <b>${esc(def.name || def.id)}</b>; other drop-in apps cannot access them.</p>
        <div class="row" style="gap:8px">
          <button id="appOauthConnect" ${configured ? '' : 'disabled'}>${connected ? 'Reconnect' : 'Connect'}</button>
          <button id="appOauthDisconnect" ${connected ? '' : 'disabled'}>Disconnect</button>
        </div>`;
      const connect = box.querySelector('#appOauthConnect');
      if (connect) connect.onclick = async () => {
        connect.disabled = true; notice = 'Opening ' + (def.oauth.name || def.name || 'account') + ' sign-in…'; noticeBad = false; await draw();
        let result;
        try { result = await configApi.connectAppOAuth(def.id); }
        catch (error) { result = { ok: false, error: error.message || String(error) }; }
        if (!result || !result.ok) {
          notice = 'Connect failed: ' + ((result && result.error) || 'unknown error'); noticeBad = true; await draw(); return;
        }
        notice = 'Finish sign-in in your browser.'; noticeBad = false; await draw();
        let attempts = 0;
        const poll = async () => {
          if (!box.isConnected || attempts++ >= 60) return;
          const next = await draw();
          if (next && next.connected) { notice = 'Connected'; noticeBad = false; await draw(); return; }
          setTimeout(poll, 2000);
        };
        setTimeout(poll, 2000);
      };
      const disconnect = box.querySelector('#appOauthDisconnect');
      if (disconnect) disconnect.onclick = async () => {
        if (!window.confirm('Disconnect ' + (def.oauth.name || def.name || def.id) + ' and remove its stored OAuth tokens?')) return;
        disconnect.disabled = true; notice = 'Disconnecting…'; noticeBad = false; await draw();
        let result;
        try { result = await configApi.disconnectAppOAuth(def.id); }
        catch (error) { result = { ok: false, error: error.message || String(error) }; }
        notice = result && result.ok ? 'Disconnected' : 'Disconnect failed: ' + ((result && result.error) || 'unknown error');
        noticeBad = !(result && result.ok);
        await draw();
      };
      return status;
    };
    await draw();
  }
  // Music: only 2 of {button grid, album art, lyrics} fit at once. Disable the unchecked third.
  function optVal(g, key, dflt) { const o = g.options || {}; return (key in o) ? o[key] : dflt; }
  function musicPanels(g) { return { grid: !!g.gridOn, art: !!optVal(g, 'art', true), lyrics: !!optVal(g, 'lyrics', false) }; }
  function enforceMusicCap(g) {
    if (!g || g.app !== 'music') return;
    const p = musicPanels(g); const count = (p.grid ? 1 : 0) + (p.art ? 1 : 0) + (p.lyrics ? 1 : 0);
    const full = count >= 2;
    const capTip = 'Screen space fits two panels \u2014 untick one to enable this';
    [['gGrid', p.grid], ['pArt', p.art], ['pLyrics', p.lyrics]].forEach(([id, on]) => {
      const el2 = document.getElementById(id); if (!el2) return;
      el2.disabled = full && !on;
      const lbl = el2.closest('label'); if (lbl) lbl.title = el2.disabled ? capTip : '';
    });
    const cnt = document.getElementById('musicPanelCount');
    if (cnt) cnt.textContent = count + ' of 2 panels selected';
  }
  function setApp(g, id) {
    const prev = appDefs.find(a => a.id === g.app);
    g.app = id;
    const def = appDefs.find(a => a.id === id);
    g.options = {};
    if (def) {
      (def.options || []).forEach(o => { g.options[o.key] = o.default; });   // an app may declare no options
      if (!g.name || g.name === 'App' || (prev && g.name === prev.name)) g.name = def.name;  // auto-name from the app
      if (def.grid) {                                       // app embeds a programmable tile grid — seed it
        g.cols = def.grid.cols || 2; g.rows = def.grid.rows || 2;
        if (!Array.isArray(g.tiles) || !g.tiles.length) g.tiles = (def.grid.defaults || []).map(t => Object.assign({}, t));
      }
    }
  }
  // Render a list of manifest options as editor rows against `values`, tagging each control with
  // `cssClass` -- 'aopt' for a page's own g.options, 'aset' for an app's global settings -- so the
  // matching change handler in renderAppOpts picks it up. Selects heal a stale stored value to the
  // manifest default. (#29 wired calls to this helper but never defined it, which threw and broke the
  // whole App-options box -- app settings, incl. Discord's, never rendered; this restores it.)
  function renderOptions(options, values, cssClass) {
    let lastSection = null;
    return (options || []).map(o => {
      let v = (o.key in values) ? values[o.key] : o.default;
      let field;
      const attrs = `class="${cssClass}" data-key="${esc(o.key)}"`;
      if (o.type === 'select') {
        // Heal a stored value that no longer matches any choice to the manifest default.
        if (!o.choices.some(ch => String(Array.isArray(ch) ? ch[0] : ch) === String(v))) {
          v = o.default;
          if (o.key in values && values[o.key] !== o.default) { values[o.key] = o.default; markDirty(); }
        }
        field = `<select ${attrs}>${o.choices.map(ch => { const val = Array.isArray(ch) ? ch[0] : ch, lab = Array.isArray(ch) ? ch[1] : ch; return `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
      }
      else if (o.type === 'bool') field = o.inline
        ? `<label class="iconopt" style="width:auto"><input type="checkbox" ${attrs} ${v ? 'checked' : ''} style="width:auto"> ${esc(o.inline)}</label>`
        : `<input type="checkbox" ${attrs} ${v ? 'checked' : ''} style="width:auto">`;
      else if (o.type === 'secret') field = secretInput(v, attrs);
      else if (o.type === 'folder') field = `<span class="folderopt" style="display:flex;gap:6px;flex:1"><input ${attrs} value="${esc(v)}" placeholder="${esc(o.placeholder || 'No folder chosen')}" style="flex:1"><button type="button" class="folderbrowse" data-for="${esc(o.key)}">Browse…</button></span>`;
      else field = `<input ${attrs} value="${esc(v)}"${o.maxLength ? ` maxlength="${Number(o.maxLength)}"` : ''}>`;
      // help display: helpCollapsed hides ALL help behind a bare More… beside the control;
      // helpSummary shows one sentence with the rest behind More…; help alone stays a plain hint.
      const inlineMore = o.helpCollapsed && o.help
        ? `<details class="hint" style="margin:0 0 0 8px"><summary></summary> ${esc(o.help)}</details>` : '';
      const help = o.helpCollapsed ? ''
        : o.helpSummary
          ? `<details class="hint" style="margin:-2px 0 10px 78px"><summary>${esc(o.helpSummary)}</summary> ${esc(o.help || '')}</details>`
          : o.help ? `<p class="hint" style="margin:-2px 0 10px 78px">${esc(o.help)}</p>` : '';
      let heading = '';
      if (o.section && o.section !== lastSection) { heading = `<p class="sectitle" style="margin-top:16px">${esc(o.section)}</p>`; lastSection = o.section; }
      // bool without inline text: keep the checkbox and its label together in one clickable row
      const rowHtml = (o.type === 'bool' && !o.inline)
        ? `<div class="row"><label class="iconopt" style="width:auto">${field} ${esc(o.label)}</label>${inlineMore}</div>`
        : `<div class="row"><label>${esc(o.label)}</label>${field}${inlineMore}</div>`;
      return heading + rowHtml + help;
    }).join('');
  }
  function renderAppOpts(g, def) {
    const el = document.getElementById('appOpts'); if (!el) return;
    if (!def) { el.innerHTML = ''; return; }
    if (!g.options) g.options = {};
    const settingDef = def.settings && typeof def.settings.key === 'string' && Array.isArray(def.settings.options) ? def.settings : null;
    if (!config.settings) config.settings = {};
    if (settingDef && (!config.settings[settingDef.key] || typeof config.settings[settingDef.key] !== 'object')) config.settings[settingDef.key] = {};
    const appSettings = settingDef ? config.settings[settingDef.key] : null;
    const valOf = key => (key in g.options) ? g.options[key] : ((def.options || []).find(x => x.key === key) || {}).default;
    // Conditional option: equality (city slots only in Cities mode), exclusion ("not": hide the
    // scene pick when the source is media-only), or an array of either form (AND).
    const showIfOk = c => {
      const cur = String(valOf(c.key));
      return ('not' in c) ? cur !== String(c.not) : cur === String(c.value);
    };
    const visible = o => !o.showIf || (Array.isArray(o.showIf) ? o.showIf.every(showIfOk) : showIfOk(o.showIf));
    const pageHtml = renderOptions((def.options || []).filter(o => !o.editorCustom).filter(visible), g.options, 'aopt');
    const regularSettings = settingDef ? settingDef.options.filter(o => !o.advanced) : [];
    const advancedSettings = settingDef ? settingDef.options.filter(o => o.advanced) : [];
    const settingsHtml = settingDef ? `<p class="sectitle" data-app-settings="${esc(def.id)}">${esc(settingDef.title || def.name + ' settings')}</p>${renderOptions(regularSettings, appSettings, 'aset')}${advancedSettings.length ? `<details class="advsec" style="margin-top:12px"><summary>Advanced / developer overrides</summary>${renderOptions(advancedSettings, appSettings, 'aset')}</details>` : ''}` : '';
    // Long manifest descriptions (a full feature paragraph reads fine in the install list but
    // walls off the app page): show only the first sentence, with a native <details> "more…"
    // revealing the rest — no event wiring, survives the innerHTML assignment below.
    const descriptionHtml = def.description ? (() => {
      const full = String(def.description);
      const m = /^[^.!?]*[.!?]/.exec(full);
      const first = (m ? m[0] : full).trim();
      const rest = full.slice(m ? m[0].length : full.length).trim();
      if (!rest) return '<p class="hint" style="margin:4px 0 12px;line-height:1.45">' + esc(first) + '</p>';
      return '<details style="margin:4px 0 12px">' +
        '<summary class="hint" style="cursor:pointer;list-style:none;line-height:1.45">' + esc(first) +
          ' <span style="opacity:.8;text-decoration:underline">more…</span></summary>' +
        '<p class="hint" style="margin:6px 0 0;line-height:1.45">' + esc(rest) + '</p></details>';
    })() : '';
    el.innerHTML = descriptionHtml + pageHtml + settingsHtml;
    el.querySelectorAll('.aopt').forEach(inp => inp.onchange = e => {
      const o = (def.options || []).find(x => x.key === e.target.dataset.key);
      g.options[e.target.dataset.key] = (o && o.type === 'bool') ? e.target.checked : e.target.value;
      markDirty();
      if (o && (o.type === 'select' || o.type === 'bool')) renderAppOpts(g, def);   // re-evaluate conditional (showIf) options
      enforceMusicCap(g);   // re-apply the 2-of-3 panel cap (grid/art/lyrics)
    });
    if (def.id === 'screensaver') {
      // Show: only ever three options, so all three sit as permanent side-by-side checkboxes in
      // one row. Scenes (five options) stays a collapsed multiselect dropdown under it.
      const showRow = appendScreensaverShowRow(el, g, def);
      const scenesOn = (g.options && 'showScenes' in g.options) ? !!g.options.showScenes : true;
      if (scenesOn) appendScreensaverMultiRow(el, g, def, 'Scenes', ['sceneWaves', 'sceneStarfield', 'sceneLava', 'sceneFireflies', 'sceneFlurry'], showRow);
      appendScreensaverExcludeRow(el, g);
      // Browse/Open buttons under each folder text field — always present; hiding folder rows by
      // mode just hides configuration people are looking for.
      appendScreensaverFolderButtons(el, g, 'photosDir', 'photos');
      appendScreensaverFolderButtons(el, g, 'videosDir', 'videos');
    }
    el.querySelectorAll('.aset').forEach(inp => inp.onchange = e => {
      const o = settingDef.options.find(x => x.key === e.target.dataset.key);
      appSettings[e.target.dataset.key] = o && o.type === 'bool' ? e.target.checked : e.target.value;
      markDirty();
    });
    // type:'folder' options -> native folder picker. Sets the sibling input and fires its change so
    // the normal .aopt/.aset handler above persists it (works for both per-page options and settings).
    el.querySelectorAll('.folderbrowse').forEach(btn => btn.onclick = async () => {
      const p = await configApi.pickFolder();
      if (!p) return;
      const inp = Array.prototype.find.call(el.querySelectorAll('input'), i => i.dataset.key === btn.dataset.for);
      if (inp) { inp.value = p; inp.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    if (def.id === 'discord') appendDiscordSetup(el);
    if (def.id === 'github') appendGitHubSetup(el);
    if (def.id === 'deck-host') appendDeckProfiles(el);
    if (def.id === 'dev-services') appendDevServices(el);
    enforceMusicCap(g);
  }
  // Live page preview: the REAL panel page (same URL the panel loads, built by main's appPageUrl \u2014
  // options, theme accent, weather and all) in a scaled iframe. Never a hand-drawn imitation: an
  // approximate mock reads as a different UI and is worse than no preview.
  // Pages whose content is an external site the editor can't authenticate into (the panel injects
  // credentials webview-side) \u2014 a blank preview is worse than none, so they get none.
  const PREVIEW_EXCLUDE = new Set(['ha-dashboard']);
  function appendAppEditorSurface(host, g, def) {
    if (!host) return;
    const label = (def.editor && def.editor.label) || 'Manage app';
    host.innerHTML = `<p class="sectitle" style="margin-top:16px">${esc(label)}</p>
      <div class="appmanage">
        <iframe class="appmanageFrame" title="${esc(label)}" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
      </div>
      <p class="hint" style="margin:4px 0 0">Interactive app management — changes save immediately and appear on the panel without Save &amp; apply.</p>`;
    updateAppEditorSurface(g);
  }
  function updateAppSurface(g) {
    if (document.querySelector('.appmanageFrame')) updateAppEditorSurface(g);
    else updateAppPreview(g);
  }
  let appEditorTimer = null;
  async function updateAppEditorSurface(g) {
    const frame = document.querySelector('.appmanageFrame');
    if (!frame) return;
    clearTimeout(appEditorTimer);
    appEditorTimer = setTimeout(async () => {
      try {
        const url = await configApi.appEditorUrl({ app: g.app, options: g.options || {}, appearance: g.appearance, accent: g.accent });
        const current = document.querySelector('.appmanageFrame');
        if (current && current.src !== url) current.src = url;
      } catch (e) {
        const host = document.getElementById('appPreviewHost');
        if (host) host.innerHTML = '<p class="hint warn">This app\'s management surface could not be loaded.</p>';
      }
    }, 400);
  }
  // Auto-size the management embed to its content: embedded apps post
  // {type:'oq-embed-height', height} on load and on every content resize, killing both the
  // dead area under a short list and the double scrollbar on a long one. e.source pins the
  // message to OUR iframe — every served app shares the loopback origin, so the origin alone
  // proves nothing. The value drives one clamped CSS property and nothing else; apps that
  // predate the contract never post and keep the CSS fallback height. Above the clamp the
  // frame scrolls internally again, which is why scrolling stays enabled.
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.type !== 'oq-embed-height') return;
    const frame = document.querySelector('.appmanageFrame');
    if (!frame || e.source !== frame.contentWindow) return;
    const box = frame.closest('.appmanage');
    const raw = Number(d.height);
    if (!box || !isFinite(raw) || raw <= 0) return;
    box.style.height = Math.max(220, Math.min(1600, Math.ceil(raw))) + 'px';
    box.style.minHeight = '0';
  });
  function appendAppPreview(host, g) {
    if (!host) return;
    if (PREVIEW_EXCLUDE.has(g.app)) { host.innerHTML = ''; return; }
    host.innerHTML = `<p class="sectitle" style="margin-top:16px">Preview</p>
      <div class="apprev"><div class="apprevStage">
        <iframe class="apprevFrame" title="Live page preview" scrolling="no" tabindex="-1"></iframe>
        <div class="apprevStrip" style="display:none"></div>
      </div></div>
      <p class="hint" style="margin:4px 0 0">Live \u2014 exactly what the panel shows with the options above.</p>`;
    updateAppPreview(g);
  }
  // Native button strip composited into the preview with the panel's own geometry (index.js
  // buildStrip: stripW = min(1100, cols\u00b7(480/rows)), left/right per gridAlign) and tile styling.
  function layoutAppPreviewStrip(g) {
    const frame = document.querySelector('.apprevFrame'), strip = document.querySelector('.apprevStrip');
    if (!frame || !strip) return;
    if (!g.gridOn || !(g.tiles || []).length) {
      strip.style.display = 'none';
      frame.style.left = '0'; frame.style.width = '1920px';
      return;
    }
    const cols = g.cols || 2, rows = g.rows || 2;
    const stripW = Math.min(1100, Math.round(cols * (480 / rows)));
    const left = g.gridAlign === 'left';
    frame.style.left = (left ? stripW : 0) + 'px'; frame.style.width = (1920 - stripW) + 'px';
    strip.style.display = 'grid';
    strip.style.left = (left ? 0 : 1920 - stripW) + 'px'; strip.style.width = stripW + 'px';
    strip.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    strip.style.gridTemplateRows = `repeat(${rows},1fr)`;
    strip.innerHTML = (g.tiles || []).map((t, i) => {
      if (t && t.cover != null) return '';
      const w = (t && t.w) || 1, h = (t && t.h) || 1;
      const empty = !t || !t.type;
      const pos = `grid-column:${(i % cols) + 1} / span ${w}; grid-row:${Math.floor(i / cols) + 1} / span ${h}`;
      return `<div class="ptile${empty ? ' empty' : ''}" style="${pos}">${empty ? '' : iconHtml(t, 'strip') + `<div class="lb">${esc(t.label || '')}</div>`}</div>`;
    }).join('');
  }
  // (Re)point the preview iframe at the current in-editor options. Called on append and from the
  // generic option-change handler, so text edits (e.g. weather city) refresh without a re-render.
  let appPreviewTimer = null;
  function updateAppPreview(g) {
    const frame = document.querySelector('.apprevFrame'); if (!frame) return;
    clearTimeout(appPreviewTimer);
    appPreviewTimer = setTimeout(async () => {
      try {
        const url = await configApi.appPreviewUrl({ app: g.app, options: g.options || {}, gridOn: !!g.gridOn, appearance: g.appearance, accent: g.accent });
        const f = document.querySelector('.apprevFrame');           // re-query: a re-render may have replaced it
        if (f && f.src !== url) f.src = url;
        layoutAppPreviewStrip(g);
      } catch (e) {}
    }, 400);
  }
  // Stream Deck Host page: manage profiles from the editor (keyboard for names; the panel only
  // offers quick select/remove). Talks to the app's server through the generic appApiCall bridge.
  async function appendDeckProfiles(el) {
    const box = document.createElement('div');
    box.className = 'advsec';
    box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #213145;border-radius:8px';
    el.appendChild(box);
    const draw = async () => {
      let s = null;
      try { s = await configApi.appApiCall('deck-host', 'state'); } catch (e) {}
      if (!s || !s.ok) { box.innerHTML = '<p class="hint">Deck profiles unavailable' + (s && s.error ? ': ' + esc(s.error) : '') + '</p>'; return; }
      box.innerHTML = `<div class="row"><label style="width:auto;font-weight:bold">Deck profiles</label><span class="hint" style="margin:0">separate key layouts; the knob cycles them on the panel</span></div>`
        + s.profiles.map(p => `<div class="row" style="gap:8px;align-items:center">
            <input class="dkName" data-id="${esc(p.id)}" value="${esc(p.name)}" style="width:220px">
            ${p.id === s.activeProfile ? '<span class="hint" style="margin:0">active</span>' : ''}
            <button class="dkDel danger" data-id="${esc(p.id)}" ${s.profiles.length <= 1 ? 'disabled' : ''} style="margin-left:auto">Remove</button>
          </div>`).join('')
        + `<div class="row" style="gap:8px"><input id="dkNewName" placeholder="New profile name" style="width:220px"><button id="dkAdd">Add profile</button><span id="dkMsg" class="hint" style="margin:0"></span></div>`;
      box.querySelectorAll('.dkName').forEach(inp => inp.onchange = async e => {
        const r = await configApi.appApiCall('deck-host', 'profile-rename', { id: e.target.dataset.id, name: e.target.value });
        if (!(r && r.ok)) { document.getElementById('dkMsg').textContent = 'Rename failed: ' + ((r && r.error) || ''); } else draw();
      });
      box.querySelectorAll('.dkDel').forEach(b => b.onclick = async e => {
        if (!ask('Remove this deck profile and its key assignments?')) return;
        const r = await configApi.appApiCall('deck-host', 'profile-remove', { id: e.currentTarget.dataset.id });
        if (!(r && r.ok)) document.getElementById('dkMsg').textContent = 'Remove failed: ' + ((r && r.error) || '');
        draw();
      });
      box.querySelector('#dkAdd').onclick = async () => {
        const name = (document.getElementById('dkNewName').value || '').trim();
        const r = await configApi.appApiCall('deck-host', 'profile-add', name ? { name } : {});
        if (!(r && r.ok)) document.getElementById('dkMsg').textContent = 'Add failed: ' + ((r && r.error) || '');
        draw();
      };
    };
    draw();
  }
  // Dev Services keeps its service list in app-owned storage so the desktop editor and panel
  // edit the same data. The generic app API retains the main-process trust boundary.
  async function appendDevServices(el) {
    const box = document.createElement('div');
    box.className = 'advsec';
    box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #213145;border-radius:8px';
    box.innerHTML = '<p class="hint" style="margin:0">Loading configured services…</p>';
    el.appendChild(box);
    let state;
    let openIndex = 0;

    const newId = () => 'service-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
    const urlFor = service => {
      const protocol = service.protocol === 'https' ? 'https' : 'http';
      const host = String(service.host || 'localhost').trim() || 'localhost';
      const port = Number(service.port) || 3000;
      const suffix = String(service.path || '').trim().replace(/^\/+/, '');
      return protocol + '://' + host + ':' + port + '/' + suffix;
    };
    const capture = () => {
      if (!state) return;
      box.querySelectorAll('.dsField').forEach(input => {
        const index = Number(input.dataset.index);
        const service = state.services[index];
        if (!service) return;
        service[input.dataset.key] = input.dataset.key === 'port' ? Number(input.value) : input.value;
      });
      const refresh = box.querySelector('#dsRefresh');
      if (refresh) state.refreshSeconds = Number(refresh.value);
    };
    const message = (value, bad) => {
      const target = box.querySelector('#dsMsg');
      if (!target) return;
      target.textContent = value || '';
      target.style.color = bad ? '#c98' : '';
    };
    const draw = () => {
      box.innerHTML = '<div class="row" style="gap:8px;align-items:center">'
        + '<label style="width:auto;font-weight:bold">Configured services</label>'
        + '<span class="hint" style="margin:0">This same ordered list appears on the panel; changes are picked up on its next refresh.</span>'
        + '</div>'
        + '<div class="row"><label>Refresh</label><select id="dsRefresh">'
        + [10, 15, 30, 60].map(seconds => '<option value="' + seconds + '"' + (state.refreshSeconds === seconds ? ' selected' : '') + '>' + seconds + ' seconds</option>').join('')
        + '</select></div>'
        + state.services.map((service, index) => '<details class="advsec dsService" data-index="' + index + '"' + (index === openIndex ? ' open' : '') + ' style="margin-top:8px">'
          + '<summary>' + esc(service.name || 'Service ' + (index + 1)) + ' · ' + esc(urlFor(service)) + '</summary>'
          + '<div class="row"><label>Name</label><input class="dsField" data-index="' + index + '" data-key="name" value="' + esc(service.name) + '" maxlength="80"></div>'
          + '<div class="row"><label>Protocol</label><select class="dsField" data-index="' + index + '" data-key="protocol"><option value="http"' + (service.protocol === 'https' ? '' : ' selected') + '>HTTP</option><option value="https"' + (service.protocol === 'https' ? ' selected' : '') + '>HTTPS</option></select></div>'
          + '<div class="row"><label>Host</label><input class="dsField" data-index="' + index + '" data-key="host" value="' + esc(service.host) + '" maxlength="253" placeholder="localhost"></div>'
          + '<div class="row"><label>Port</label><input class="dsField" data-index="' + index + '" data-key="port" type="number" min="1" max="65535" value="' + esc(String(service.port)) + '"></div>'
          + '<div class="row"><label>Path</label><input class="dsField" data-index="' + index + '" data-key="path" value="' + esc(service.path) + '" maxlength="1024" placeholder="Optional, for example api/health"></div>'
          + '<div class="row"><label>Expected process</label><input class="dsField" data-index="' + index + '" data-key="expectedProcess" value="' + esc(service.expectedProcess) + '" maxlength="260" placeholder="Optional, for example node"></div>'
          + '<p class="hint" style="margin:-2px 0 10px 78px">When ownership can be identified, a different process is shown as an unexpected occupant and cannot be stopped.</p>'
          + '<div class="row"><label>Project folder</label><span class="folderopt" style="display:flex;gap:6px;flex:1"><input class="dsField" data-index="' + index + '" data-key="projectFolder" value="' + esc(service.projectFolder) + '" maxlength="2048" placeholder="Optional folder"><button type="button" class="dsBrowse" data-index="' + index + '">Browse…</button></span></div>'
          + '<div class="row" style="gap:8px"><button type="button" class="dsMove" data-index="' + index + '" data-direction="-1"' + (index === 0 ? ' disabled' : '') + '>Move up</button><button type="button" class="dsMove" data-index="' + index + '" data-direction="1"' + (index === state.services.length - 1 ? ' disabled' : '') + '>Move down</button><button type="button" class="dsRemove danger" data-index="' + index + '" style="margin-left:auto">Remove</button></div>'
          + '</details>').join('')
        + '<div class="row" style="gap:8px;margin-top:10px"><button type="button" id="dsAdd"' + (state.services.length >= 12 ? ' disabled' : '') + '>Add service</button><button type="button" id="dsSave">Save services</button><span id="dsMsg" class="hint" style="margin:0"></span></div>';

      box.querySelectorAll('.dsService').forEach(details => details.ontoggle = () => {
        if (details.open) openIndex = Number(details.dataset.index);
      });
      box.querySelectorAll('.dsBrowse').forEach(button => button.onclick = async () => {
        const folder = await configApi.pickFolder();
        if (!folder) return;
        const input = box.querySelector('.dsField[data-index="' + button.dataset.index + '"][data-key="projectFolder"]');
        if (input) input.value = folder;
      });
      box.querySelectorAll('.dsMove').forEach(button => button.onclick = () => {
        capture();
        const from = Number(button.dataset.index);
        const to = from + Number(button.dataset.direction);
        const moved = state.services.splice(from, 1)[0];
        state.services.splice(to, 0, moved);
        openIndex = to;
        draw();
      });
      box.querySelectorAll('.dsRemove').forEach(button => button.onclick = () => {
        capture();
        const index = Number(button.dataset.index);
        const service = state.services[index];
        if (!ask('Remove ' + (service.name || 'this service') + '?')) return;
        state.services.splice(index, 1);
        openIndex = Math.max(0, Math.min(index, state.services.length - 1));
        draw();
      });
      box.querySelector('#dsAdd').onclick = () => {
        capture();
        if (state.services.length >= 12) return;
        state.services.push({ id: newId(), name: 'Service ' + (state.services.length + 1), port: 3000, protocol: 'http', host: 'localhost', path: '', expectedProcess: '', projectFolder: '' });
        openIndex = state.services.length - 1;
        draw();
      };
      box.querySelector('#dsSave').onclick = async event => {
        capture();
        event.currentTarget.disabled = true;
        message('Saving…');
        let result;
        try { result = await configApi.appApiCall('dev-services', 'save-settings', { settings: state }); }
        catch (error) { result = { ok: false, error: error.message || String(error) }; }
        if (result && result.ok) {
          state = result.settings;
          message('Saved.');
        } else {
          message('Save failed: ' + ((result && result.error) || 'Unknown error'), true);
        }
        event.currentTarget.disabled = false;
      };
    };

    let result;
    try { result = await configApi.appApiCall('dev-services', 'settings', {}); }
    catch (error) { result = { ok: false, error: error.message || String(error) }; }
    if (!result || !result.ok) {
      const error = (result && result.error) || 'Unknown error';
      const stale = String(error).toLowerCase() === 'unknown action';
      box.innerHTML = stale
        ? '<p class="hint">This installed Dev Services version does not support desktop editing. Update or reinstall Dev Services 1.0.1 or later in <b>Settings → Drop-In Apps</b>.</p>'
        : '<p class="hint">Dev Services settings unavailable: ' + esc(error) + '</p>';
      return;
    }
    state = result.settings;
    draw();
  }
  // Discord keeps application configuration and account authorization together in its app settings.
  // The generic option rows cannot represent live provider state or lifecycle actions.
  async function appendDiscordSetup(el) {
    const box = document.createElement('div');
    box.className = 'advsec';
    box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #213145;border-radius:8px';
    el.appendChild(box);
    const guideUrl = 'https://github.com/TeeJS/open-quake/blob/main/docs/discord.md';
    const draw = async () => {
      let provider = null;
      try { provider = (await configApi.listOAuthProviders()).find(value => value.provider === 'discord'); } catch (e) {}
      const connected = !!(provider && provider.connected);
      const reauthorizationRequired = !!(provider && provider.reauthorizationRequired);
      const identity = provider && provider.identity;
      const account = identity && (identity.global_name || identity.username);
      const status = connected
        ? (reauthorizationRequired ? 'Connected · Reconnect to approve updated permissions' : provider.authState === 'authenticated' ? 'Connected and authenticated' : 'Authorized; waiting for Discord')
        : (provider && provider.enabled ? 'Ready to connect' : 'Discord is unavailable');
      const labels = { core: 'Core', voice: 'Voice', messages: 'Messages', notifications: 'Notifications' };
      const permissions = provider && Array.isArray(provider.capabilityGroups) ? provider.capabilityGroups.map(group => {
        const groupStatus = group.granted ? 'granted' : group.requested ? (connected ? 'reconnect required' : 'requested') : 'not requested';
        return `${esc(labels[group.id] || group.id)}: ${esc(groupStatus)}`;
      }).join(' · ') : 'Permission status unavailable';
      box.innerHTML = `<div class="row" style="gap:8px;align-items:center">
          <label style="width:auto;font-weight:bold">Discord account</label>
          <span class="hint" style="margin:0">${esc(status)}</span>
          <span id="dcMsg" class="hint" style="margin:0 0 0 auto"></span>
        </div>
        <div class="row"><label>Application</label><span class="hint" style="margin:0">${provider && provider.customApplication ? 'Custom Discord application' : 'Built into open-quake'}</span></div>
        ${account ? `<div class="row"><label>Account</label><span class="hint" style="margin:0">${esc(account)}${identity.username && identity.global_name ? ' (' + esc(identity.username) + ')' : ''}</span></div>` : ''}
        <div class="row"><label>Permissions</label><span class="hint" style="margin:0">${permissions}</span></div>
        <p class="hint" style="margin:4px 0 8px"><a href="#" id="dcGuide">Discord connection guide ↗</a>${provider && provider.customApplication ? ' · Save changes before connecting or reconnecting so the selected application and permission groups are used.' : ''}</p>
        <div class="row" style="gap:8px">
          <button id="dcConnect"${provider && provider.enabled ? '' : ' disabled'}>${connected ? 'Reconnect' : 'Connect'}</button>
          <button id="dcDisconnect"${connected && provider.enabled ? '' : ' disabled'}>Disconnect</button>
        </div>`;
      const message = (text, bad) => { const target = box.querySelector('#dcMsg'); if (target) { target.textContent = text || ''; target.style.color = bad ? '#c98' : '#7e93ab'; } };
      const guide = box.querySelector('#dcGuide');
      if (guide) guide.onclick = event => { event.preventDefault(); configApi.openExternal(guideUrl); };
      const connect = box.querySelector('#dcConnect');
      if (connect) connect.onclick = async () => {
        if (dirty) { message('Save your changes first, then connect.', true); return; }
        connect.disabled = true; message('Opening browser…');
        let result;
        try { result = await configApi.connectOAuthProvider('discord', (provider && provider.scopes) || []); }
        catch (error) { result = { ok: false, error: error.message || String(error) }; }
        if (!result || !result.ok) {
          const invalidScope = result && result.code === 'DISCORD_AUTH_INVALID_SCOPE';
          const invalidMessage = provider && provider.customApplication
            ? 'The custom Discord application rejected one or more requested permissions. Adjust its enhanced groups, Save, then reconnect.'
            : 'The built-in Discord application rejected one or more requested permissions. Its Discord approval configuration needs attention.';
          message(invalidScope ? invalidMessage : 'Connect failed: ' + ((result && result.error) || ''), true);
          connect.disabled = false;
          return;
        }
        await draw();
      };
      const disconnect = box.querySelector('#dcDisconnect');
      if (disconnect) disconnect.onclick = async () => {
        if (!ask('Disconnect Discord and remove the stored OAuth tokens?')) return;
        disconnect.disabled = true; message('Disconnecting…');
        let result;
        try { result = await configApi.disconnectOAuthProvider('discord'); }
        catch (error) { result = { ok: false, error: error.message || String(error) }; }
        if (!result || !result.ok) { message('Disconnect failed: ' + ((result && result.error) || ''), true); disconnect.disabled = false; return; }
        await draw();
      };
    };
    await draw();
  }
  // GitHub mirrors Discord's app-page setup: configuration and OAuth lifecycle stay in the desktop
  // editor, while the touchscreen page remains an operations surface. Device codes are safe DTOs;
  // access and refresh tokens never cross this renderer boundary.
  async function appendGitHubSetup(el) {
    if (githubAuthPollTimer) { clearTimeout(githubAuthPollTimer); githubAuthPollTimer = null; }
    if (!config.settings) config.settings = {};
    if (!config.settings.github || typeof config.settings.github !== 'object') config.settings.github = { repository: '', branch: '' };
    if (!config.settings.oauth || typeof config.settings.oauth !== 'object') config.settings.oauth = { providers: {}, tokens: {} };
    if (!config.settings.oauth.providers || typeof config.settings.oauth.providers !== 'object') config.settings.oauth.providers = {};
    if (!config.settings.oauth.providers.github || typeof config.settings.oauth.providers.github !== 'object') config.settings.oauth.providers.github = {};

    const box = document.createElement('div');
    box.className = 'advsec';
    box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #213145;border-radius:8px';
    el.appendChild(box);
    const guideUrl = 'https://github.com/TeeJS/open-quake/blob/main/docs/github.md';
    const createUrl = 'https://github.com/settings/applications/new';

    const draw = async notice => {
      if (!box.isConnected) return;
      if (githubAuthPollTimer) { clearTimeout(githubAuthPollTimer); githubAuthPollTimer = null; }
      let status = null;
      try { status = await configApi.getGitHubStatus(); } catch (error) {}
      const connected = !!(status && status.connected);
      const local = config.settings.github;
      const localProvider = config.settings.oauth.providers.github;
      box.innerHTML = `<div class="row" style="gap:8px;align-items:center">
          <label style="width:auto;font-weight:bold">GitHub account</label>
          <span class="hint" style="margin:0">${connected ? 'Connected' + (status && status.login ? ' as ' + esc(status.login) : '') : status && status.configured ? 'Ready to connect' : 'Not configured'}</span>
          <span id="ghMsg" class="hint" style="margin:0 0 0 auto">${esc(notice || '')}</span>
        </div>
        <div class="row" style="gap:8px">
          <button id="ghConnect" ${connected ? '' : 'class="primary"'}>${connected ? 'Change account' : 'Connect'}</button>
          <button id="ghDisconnect"${connected ? '' : ' disabled'}>Disconnect</button>
        </div>
        <div id="ghDevice" class="row" style="display:none"><label>Device code</label><strong id="ghDeviceCode" style="font:700 20px Consolas,monospace;letter-spacing:.12em;color:#9b7cff"></strong><span class="hint" style="margin:0">Enter this in the GitHub page opened in your browser.</span></div>
        <details${connected ? '' : ' open'} style="margin-top:10px">
          <summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Connection settings</summary>
          <div class="row" style="margin-top:8px"><label>OAuth Client ID</label><input id="ghClientId" value="${esc(localProvider.clientId || '')}" placeholder="Iv1…" autocomplete="off" style="flex:1"></div>
          <details class="hint"><summary>Create a GitHub OAuth App, enable <b>Device Flow</b>, and paste its public Client ID.</summary> For GitHub's required callback field, use <code>http://127.0.0.1:53682/callback</code>; Device Flow never contacts it and open-quake does not listen on that port. No client secret is used or stored.</details>
          <div class="row"><label>Permissions</label><span class="hint" style="margin:0">repo · offline_access</span></div>
          <p class="hint" style="margin:4px 0 8px"><a href="#" id="ghGuide">GitHub connection guide ↗</a> · <a href="#" id="ghCreate">Create OAuth App ↗</a> · Save changes before connecting or reconnecting.</p>
        </details>
        <p class="sectitle" style="margin-top:14px">Repository defaults</p>
        <div class="row"><label>Starting repository</label><input id="ghRepository" value="${esc(local.repository || '')}" placeholder="optional owner/repository" autocomplete="off" style="flex:1"><span id="ghRepoWarn" class="hint warn" style="margin:0 0 0 8px"></span></div>
        <div class="row"><label>Starting branch</label><input id="ghBranch" value="${esc(local.branch || '')}" placeholder="optional; blank uses each repository's default" autocomplete="off" style="flex:1"></div>
        <p class="hint">These are optional — blank keeps the last repository and branch selected on the device. The touchscreen GitHub page lists every repository your account can access.</p>`;

      const message = (text, bad) => { const target = box.querySelector('#ghMsg'); if (target) { target.textContent = text || ''; target.style.color = bad ? '#c98' : '#7e93ab'; } };
      box.querySelector('#ghClientId').oninput = event => { localProvider.clientId = event.target.value; markDirty(); };
      box.querySelector('#ghRepository').oninput = event => {
        local.repository = event.target.value; markDirty();
        const w = box.querySelector('#ghRepoWarn'), v = event.target.value.trim();
        if (w) w.textContent = v && !/^[\w.-]+\/[\w.-]+$/.test(v) ? 'expected owner/repository' : '';
      };
      box.querySelector('#ghBranch').oninput = event => { local.branch = event.target.value; markDirty(); };
      box.querySelector('#ghGuide').onclick = event => { event.preventDefault(); configApi.openExternal(guideUrl); };
      box.querySelector('#ghCreate').onclick = event => { event.preventDefault(); configApi.openExternal(createUrl); };

      const showDevice = result => {
        const row = box.querySelector('#ghDevice'); const code = box.querySelector('#ghDeviceCode');
        if (row && code) { code.textContent = result.userCode || ''; row.style.display = 'flex'; }
      };
      const poll = result => {
        showDevice(result);
        githubAuthPollTimer = setTimeout(async () => {
          githubAuthPollTimer = null;
          if (!box.isConnected) return;
          let next;
          try { next = await configApi.pollGitHubConnect(); }
          catch (error) { next = { ok:false, error:error.message || String(error) }; }
          if (!next || !next.ok) { message('Connect failed: ' + ((next && next.error) || ''), true); return; }
          if (next.pending) { message('Waiting for GitHub approval…'); poll(next); return; }
          const account = next.account && next.account.login ? ' as ' + next.account.login : '';
          await draw('Connected' + account);
        }, Math.max(1000, Number(result.retryAfterMs) || 5000));
      };
      box.querySelector('#ghConnect').onclick = async event => {
        if (dirty) { message('Save your changes first, then connect.', true); return; }
        event.currentTarget.disabled = true; message('Opening browser…');
        let result;
        try { result = await configApi.connectGitHub(); }
        catch (error) { result = { ok:false, error:error.message || String(error) }; }
        if (!result || !result.ok) { message('Connect failed: ' + ((result && result.error) || ''), true); event.currentTarget.disabled = false; return; }
        message('Enter the device code in GitHub…'); poll(result);
      };
      box.querySelector('#ghDisconnect').onclick = async event => {
        if (!ask('Disconnect the GitHub account from this device? Repositories stop loading until you connect again.')) return;
        if (!ask('Disconnect GitHub and remove the stored OAuth tokens?')) return;
        event.currentTarget.disabled = true; message('Disconnecting…');
        let result;
        try { result = await configApi.disconnectGitHub(); }
        catch (error) { result = { ok:false, error:error.message || String(error) }; }
        if (!result || !result.ok) { message('Disconnect failed: ' + ((result && result.error) || ''), true); event.currentTarget.disabled = false; return; }
        await draw('Disconnected');
      };
    };
    await draw();
  }
  // Screensaver: the Show group is three permanent side-by-side checkboxes on one row (only ever
  // three options — no dropdown to hunt through). Toggling re-renders the box because these gate
  // the style/crop/Scenes rows. The manifest keeps every pick as an ordinary bool option (query
  // delivery, seeding, panel — all unchanged); `editorCustom` only skips generic rendering here.
  function appendScreensaverShowRow(el, g, def) {
    const opts = (def.options || []).filter(o => ['showScenes', 'showPhotos', 'showVideos'].includes(o.key));
    const on = o => { const go = g.options || {}; return (o.key in go) ? !!go[o.key] : !!o.default; };
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>Show</label>` + opts.map(o =>
      `<label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" data-sk="${esc(o.key)}" ${on(o) ? 'checked' : ''}> ${esc(o.label)}</label>`
    ).join('');
    el.insertAdjacentElement('afterbegin', row);
    row.querySelectorAll('input[data-sk]').forEach(cb => cb.onchange = () => {
      if (!g.options) g.options = {};
      g.options[cb.dataset.sk] = cb.checked;
      markDirty();
      renderAppOpts(g, def);   // these toggles gate the style/crop/Scenes rows
    });
    return row;
  }
  // Scenes (five options) stays behind ONE collapsed multiselect dropdown — five always-visible
  // checkbox rows ate the whole box. Stays open across picks; closes on a click anywhere outside.
  function appendScreensaverMultiRow(el, g, def, rowLabel, keys, afterEl) {
    const opts = (def.options || []).filter(o => keys.includes(o.key));
    if (!opts.length) return null;
    const on = o => { const go = g.options || {}; return (o.key in go) ? !!go[o.key] : !!o.default; };
    // Collapsed label deliberately does NOT echo the picks — a value there reads like a
    // single-choice select. Only the all-off footgun still surfaces.
    const summary = () => opts.some(on) ? `Click to select` : 'None selected — nothing will show';
    const row = document.createElement('div');
    row.className = 'row';
    row.style.position = 'relative';
    row.innerHTML = `<label>${esc(rowLabel)}</label>
      <button type="button" data-ms-btn style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></button>
      <div data-ms-menu style="display:none;position:absolute;left:78px;right:0;top:100%;z-index:30;background:#121a24;border:1px solid #2a3a4e;border-radius:8px;padding:8px 12px">
        ${opts.map(o => `<label class="iconopt" style="display:block;width:auto;margin:4px 0"><input type="checkbox" data-sk="${esc(o.key)}" ${on(o) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}
      </div>`;
    if (afterEl) afterEl.insertAdjacentElement('afterend', row);
    else el.insertAdjacentElement('afterbegin', row);
    const btn = row.querySelector('[data-ms-btn]'), menu = row.querySelector('[data-ms-menu]');
    const setLabel = () => { btn.textContent = '▾ ' + summary(); };
    setLabel();
    btn.onclick = e => {
      e.stopPropagation();
      const opening = menu.style.display === 'none';
      menu.style.display = opening ? '' : 'none';
      // Close on the next click anywhere outside; clicks inside the menu don't bubble this far.
      if (opening) setTimeout(() => document.addEventListener('click', () => { menu.style.display = 'none'; }, { once: true }), 0);
    };
    menu.onclick = e => e.stopPropagation();
    menu.querySelectorAll('input[data-sk]').forEach(cb => cb.onchange = () => {
      if (!g.options) g.options = {};
      g.options[cb.dataset.sk] = cb.checked;
      markDirty();
      setLabel();
    });
    return row;
  }
  // Screensaver: the exclusion list is a multiselect of the OTHER pages — dynamic content
  // apps.json can't express, hence the option is editorCustom and rendered here. Stored as a
  // comma-separated id string in g.options.excludePages; while any picked page is on screen,
  // idle auto-start never fires. Inserted right under the Idle auto-start field it modifies.
  function appendScreensaverExcludeRow(el, g) {
    const pages = (config.grids || []).filter(x => !(x.kind === 'app' && x.app === 'screensaver'));
    const anchorInp = Array.prototype.find.call(el.querySelectorAll('input'), i => i.dataset.key === 'idleMinutes');
    if (!pages.length || !anchorInp) return;
    const picked = () => new Set(String((g.options || {}).excludePages || '').split(',').map(s => s.trim()).filter(Boolean));
    const row = document.createElement('div');
    row.className = 'row';
    row.style.position = 'relative';
    row.innerHTML = `<label>Excluded pages</label>
      <button type="button" data-ms-btn style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></button>
      <div data-ms-menu style="display:none;position:absolute;left:78px;right:0;top:100%;z-index:30;background:#121a24;border:1px solid #2a3a4e;border-radius:8px;padding:8px 12px">
        ${pages.map(p => `<label class="iconopt" style="display:block;width:auto;margin:4px 0"><input type="checkbox" data-xid="${esc(p.id)}" ${picked().has(p.id) ? 'checked' : ''}> ${esc(p.name || '(unnamed page)')}</label>`).join('')}
      </div>`;
    let after = anchorInp.closest('.row');
    if (after.nextElementSibling && after.nextElementSibling.classList.contains('hint')) after = after.nextElementSibling;
    after.insertAdjacentElement('afterend', row);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.cssText = 'margin:-2px 0 10px 78px';
    hint.textContent = 'While any picked page is on screen, idle auto-start never fires — for pages you watch without touching. Leaving the page resumes the countdown; manual starts still work.';
    row.insertAdjacentElement('afterend', hint);
    const btn = row.querySelector('[data-ms-btn]'), menu = row.querySelector('[data-ms-menu]');
    const setLabel = () => { const n = picked().size; btn.textContent = '▾ ' + (n ? n + ' excluded' : 'None'); };
    setLabel();
    btn.onclick = e => {
      e.stopPropagation();
      const opening = menu.style.display === 'none';
      menu.style.display = opening ? '' : 'none';
      if (opening) setTimeout(() => document.addEventListener('click', () => { menu.style.display = 'none'; }, { once: true }), 0);
    };
    menu.onclick = e => e.stopPropagation();
    menu.querySelectorAll('input[data-xid]').forEach(cb => cb.onchange = () => {
      const set = picked();
      if (cb.checked) set.add(cb.dataset.xid); else set.delete(cb.dataset.xid);
      if (!g.options) g.options = {};
      g.options.excludePages = Array.from(set).join(',');
      markDirty();
      setLabel();
    });
  }
  // Screensaver: each media folder needs a real folder picker and an "open in Explorer" shortcut —
  // dynamic things apps.json can't express. Buttons are inserted right under that folder's own
  // text field (inside renderAppOpts, so they survive the re-render select/bool changes trigger)
  // and only when the field itself is visible.
  function appendScreensaverFolderButtons(el, g, key, kind) {
    const inp = el.querySelector(`.aopt[data-key="${key}"]`);
    if (!inp) return;
    const word = kind === 'videos' ? 'videos' : 'photos';
    const exts = kind === 'videos' ? 'mp4/webm/mov' : 'jpg/png/gif/webp';
    // The videos row also links the repo's community-wallpapers folder — ready-made 1920×480
    // loops live there (kept out of the installer so the app stays small).
    const community = kind === 'videos'
      ? `<button type="button" data-ss-community="1">Download wallpapers ↗</button>` : '';
    const row = document.createElement('div');
    row.innerHTML = `<div class="row" style="gap:8px"><label></label>
        <button type="button" data-ss-browse="${key}">Browse…</button>
        <button type="button" data-ss-open="${key}">Open ${word} folder</button>${community}</div>
      <p class="hint" style="margin:-2px 0 10px 78px">Drop ${exts} files in and the screensaver plays them.
      Blank = the app's own screensaver-media\\${word} folder — Open shows whichever folder is in effect.</p>`;
    inp.closest('.row').insertAdjacentElement('afterend', row);
    row.querySelector(`[data-ss-browse="${key}"]`).onclick = async () => {
      const p = await configApi.pickFolder();
      if (!p) return;
      g.options[key] = p; markDirty();
      inp.value = p;
    };
    row.querySelector(`[data-ss-open="${key}"]`).onclick = () => configApi.openScreensaverMedia(optVal(g, key, ''), kind);
    const cb = row.querySelector('[data-ss-community="1"]');
    if (cb) cb.onclick = () => configApi.openExternal('https://github.com/TeeJS/open-quake/tree/main/community-wallpapers');
  }

  // Focus a saved page on the device from the editor. The device only knows SAVED pages, so if the
  // editor has unsaved changes we refuse and tell the user to save first — saving is the user's job,
  // not something we do silently behind a Focus click.
  async function focusCurrentPage() {
    const g = curGrid();
    if (!g) return;
    if (dirty) { tell('Save your changes first. The device only knows about saved pages, so “Focus on device” is unavailable until you Save.'); return; }
    try {
      const r = await configApi.focusPage(g.id);
      if (r && r.ok) setState('focused “' + (g.name || 'page') + '” on the device', 'saved');
      else setState((r && r.error) || 'could not focus that page', 'dirty');
    } catch (e) { setState('could not focus that page', 'dirty'); }
  }
  function deleteCurrentPage() {
    if (config.grids.length <= 1) return;
    const gname = (config.grids[gi] || {}).name || '(unnamed)';
    if (!ask('Delete page \u201c' + gname + '\u201d? It disappears from the panel when you Save & apply.')) return;
    const removedId = (config.grids[gi] || {}).id;
    (config.panes || []).forEach(p => {
      if (Array.isArray(p.slots)) p.slots = p.slots.filter(s => s && s.pageId !== removedId);
      if (Array.isArray(p.slots2)) p.slots2 = p.slots2.filter(s => s && s.pageId !== removedId);
    });
    config.grids.splice(gi, 1); gi = 0; ti = -1;
    if (!config.grids.some(x => x.id === config.activeGridId)) config.activeGridId = config.grids[0].id;
    render(); markDirty();
  }

  function render() {
    if (ltMeterStop) { try { ltMeterStop(); } catch (e) {} ltMeterStop = null; }   // stop the LucidType mic test meter on any re-render
    if (githubAuthPollTimer) { clearTimeout(githubAuthPollTimer); githubAuthPollTimer = null; }
    renderGrids();
    renderGroups();
    renderPanes();
    // Sidebar: which list is visible + which + buttons row + which tab is highlighted.
    const groupsTab = leftTab === 'groups', panesTab = leftTab === 'panes';
    const pagesTab = !groupsTab && !panesTab;
    // Search applies to whichever list is showing; the type Filter pulldown is pages-only.
    const pf = document.getElementById('pageFilter');
    if (pf) pf.placeholder = groupsTab ? 'Search groups…' : panesTab ? 'Search panes…' : 'Search pages…';
    const pk = document.querySelector('.kindwrap'); if (pk) pk.style.display = pagesTab ? '' : 'none';
    const elGL = document.getElementById('gridlist'); if (elGL) elGL.style.display = pagesTab ? '' : 'none';
    const elGRP = document.getElementById('grouplist'); if (elGRP) elGRP.style.display = groupsTab ? '' : 'none';
    const elPN = document.getElementById('panelist'); if (elPN) elPN.style.display = panesTab ? '' : 'none';
    const elAP = document.getElementById('addPageBtns'); if (elAP) elAP.style.display = pagesTab ? '' : 'none';
    const elAG = document.getElementById('addGroupBtns'); if (elAG) elAG.style.display = groupsTab ? '' : 'none';
    const elAPn = document.getElementById('addPaneBtns'); if (elAPn) elAPn.style.display = panesTab ? '' : 'none';
    const tp = document.getElementById('lTabPages'); if (tp) tp.classList.toggle('on', pagesTab);
    const tg = document.getElementById('lTabGroups'); if (tg) tg.classList.toggle('on', groupsTab);
    const tpn = document.getElementById('lTabPanes'); if (tpn) tpn.classList.toggle('on', panesTab);
    // In software Panes mode, panes are the primary unit — their tab moves to the far left.
    if (tpn) tpn.style.order = softwarePaneMode() ? '-1' : '';

    // The below-preview danger zone belongs only to the grid page form; every other view clears it.
    { const pd = document.getElementById('pagedanger'); if (pd) pd.innerHTML = ''; }
    // Settings takes the full window: the Pages sidebar is unrelated to settings tasks, so collapse
    // it (and its splitter) while the settings view is open. The header button doubles as the exit.
    const inSettings = view === 'settings';
    const sidebarEl = document.querySelector('.grids'); if (sidebarEl) sidebarEl.style.display = inSettings ? 'none' : '';
    const splitEl = document.getElementById('colsplit'); if (splitEl) splitEl.style.display = inSettings ? 'none' : '';
    const sBtn = document.getElementById('settingsBtn'); if (sBtn) sBtn.textContent = inSettings ? '← Back to pages' : '⚙ Settings';

    if (view === 'settings') { renderSettings(); return; }
    if (view === 'groups') { renderGroupMeta(); renderTiles(); renderForm(); return; }
    if (view === 'panes') { renderPaneEditor(); return; }
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
    const q = pageFilter.trim().toLowerCase();
    let shown = 0;
    list.forEach((g, i) => {
      if (q && !String(g.name || '').toLowerCase().includes(q)) return;
      shown++;
      const d = document.createElement('div');
      d.className = 'gridrow' + (view === 'groups' && i === groupIndex ? ' active' : '');
      const left = document.createElement('span'); left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden';
      const name = document.createElement('span'); name.textContent = '▦ ' + (g.name || '(unnamed)'); name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      left.appendChild(name); d.appendChild(left);
      d.onclick = () => { view = 'groups'; groupIndex = i; ti = -1; selEnd = -1; render(); };
      el.appendChild(d);
    });
    if (q && !shown) el.innerHTML = '<p class="hint">No groups match “' + esc(pageFilter.trim()) + '”.</p>';
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
    if (!ask('Delete group "' + (removed.name || '(unnamed)') + '"? Any pages using it will fall back to their own tiles.')) return;
    // Clear references on pages that used this group.
    (config.grids || []).forEach(p => { if (p && p.groupId === removed.id) { delete p.groupId; delete p.useGroup; } });
    list.splice(groupIndex, 1);
    if (!list.length) { view = 'pages'; leftTab = 'pages'; groupIndex = -1; }
    else groupIndex = Math.min(groupIndex, list.length - 1);
    ti = -1; selEnd = -1; render(); markDirty();
  }

  // ---- panes (left list + stacked-slot editor) ----
  // A pane stacks 1..5 existing pages vertically for the Software-mode window (Settings -> Software ->
  // Software window). Slots reference pages by id — nothing is duplicated.
  const PANE_MAX_SLOTS = 5;
  function softwarePaneMode() { const s = config.settings || {}; return s.runMode === 'software' && s.softwareDisplay === 'pane'; }
  function curPane() { const list = config.panes || []; return (paneIndex >= 0 && paneIndex < list.length) ? list[paneIndex] : null; }
  function renderPanes() {
    const el = document.getElementById('panelist'); if (!el) return;
    el.innerHTML = '';
    const list = config.panes || [];
    if (!list.length) { el.innerHTML = '<p class="hint" style="margin:6px 4px">No panes yet. Use + Pane to create one.</p>'; return; }
    const q = pageFilter.trim().toLowerCase();
    let shown = 0;
    list.forEach((p, i) => {
      if (q && !String(p.name || '').toLowerCase().includes(q)) return;
      shown++;
      const d = document.createElement('div');
      d.className = 'gridrow' + (view === 'panes' && i === paneIndex ? ' active' : '');
      const left = document.createElement('span'); left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden';
      const name = document.createElement('span'); name.textContent = '▤ ' + (p.name || '(unnamed)'); name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      left.appendChild(name); d.appendChild(left);
      if (p.shortcut) { const sub = document.createElement('span'); sub.className = 'gsub badge'; sub.title = 'Hotkey shortcut'; sub.textContent = p.shortcut; d.appendChild(sub); }
      d.onclick = () => { view = 'panes'; paneIndex = i; ti = -1; selEnd = -1; render(); };
      el.appendChild(d);
    });
    if (q && !shown) el.innerHTML = '<p class="hint">No panes match “' + esc(pageFilter.trim()) + '”.</p>';
  }
  function addPane() {
    if (!Array.isArray(config.panes)) config.panes = [];
    config.panes.push({ id: uid(), name: 'New Pane', slots: [{ pageId: '' }] });
    paneIndex = config.panes.length - 1;
    leftTab = 'panes'; view = 'panes';
    render(); markDirty();
  }
  function renderPaneEditor() {
    ['tilegrid', 'mergebar', 'tileform', 'iconpane'].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ''; });
    const p = curPane(); const el = document.getElementById('gridmeta');
    if (!p) { el.innerHTML = '<p class="hint">No pane selected. Use + Pane to create one.</p>'; return; }
    if (!Array.isArray(p.slots)) p.slots = [];
    if (!Array.isArray(p.slots2)) p.slots2 = [];   // optional right column
    el.innerHTML = `
      <div class="row"><label>Name</label><input id="pnName" value="${esc(p.name)}"></div>
      <div class="row" style="margin-top:6px"><label style="width:auto">Hotkey shortcut</label>
        <span class="hkwrap"><input id="pnShortcut" readonly placeholder="click, then press keys" value="${esc(p.shortcut || '')}"><button id="pnShortcutClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span>
        <label style="width:auto;margin-left:14px;font-weight:normal;cursor:pointer"><input type="checkbox" id="pnShortcutNoRot" ${p.shortcutStopsRotation ? 'checked' : ''}> Disables rotation</label></div>
      <details class="hint"><summary>Global hotkey that switches the software window to this pane from anywhere (flipping it to Panes view if needed).</summary> Press a combo that includes a modifier. <b>Disables rotation</b> turns auto-rotation off when it fires.</details>
      <div class="row" style="margin-top:6px"><label style="width:auto">Rotation</label>
        <label class="iconopt" style="width:auto; white-space:nowrap"><input type="checkbox" id="pnRot" ${p.rotate ? 'checked' : ''}> Include in rotation</label>
        <label class="iconopt" style="width:auto;margin-left:14px"><input type="checkbox" id="pnHome" ${config.homePaneId === p.id ? 'checked' : ''}> Set as home pane</label></div>
      <details class="hint"><summary>In Panes view, auto-rotation cycles through the panes with <b>Include in rotation</b> ticked (Settings → Software → Screen rotation controls the on/off and interval).</summary> The <b>home pane</b> is where a go-home action lands; only one pane can be home.</details>
      <details class="hint"><summary>A pane stacks up to ${PANE_MAX_SLOTS} of your existing pages per column, one or two columns, so the Software-mode window can fill a bigger screen.</summary> Show it via Settings → Software → <b>Software window</b>. Each slot is a full 1920×480 page — the window's shape follows the layout.</details>
      <div style="display:flex; gap:14px; align-items:flex-start">
        <div style="flex:1; min-width:0">
          <p class="sectitle" style="margin:0 0 2px">Left column</p>
          <div id="pnSlots"></div>
          <div class="row" style="margin-top:10px">${p.slots.length < PANE_MAX_SLOTS ? '<button class="primary" id="pnAddSlot">+ Add page</button>' : '<span class="hint" style="margin:0">Column is full (' + PANE_MAX_SLOTS + ').</span>'}</div>
        </div>
        <div style="flex:1; min-width:0">
          <p class="sectitle" style="margin:0 0 2px">Right column <span style="font-weight:normal;opacity:.6">(optional)</span></p>
          <div id="pnSlots2"></div>
          <div class="row" style="margin-top:10px">${p.slots2.length < PANE_MAX_SLOTS ? '<button class="primary" id="pnAddSlot2">+ Add page</button>' : '<span class="hint" style="margin:0">Column is full (' + PANE_MAX_SLOTS + ').</span>'}</div>
        </div>
      </div>
      <div class="row" style="margin-top:10px"><button class="danger" id="pnDelete" style="margin-left:auto">Delete pane</button></div>`;
    document.getElementById('pnName').oninput = e => { p.name = e.target.value; renderPanes(); markDirty(); };
    const pnSc = document.getElementById('pnShortcut');
    pnSc.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { p.shortcut = acc; pnSc.value = acc; renderPanes(); markDirty(); } };
    document.getElementById('pnShortcutClear').onclick = () => { delete p.shortcut; pnSc.value = ''; renderPanes(); markDirty(); };
    document.getElementById('pnShortcutNoRot').onchange = e => { if (e.target.checked) p.shortcutStopsRotation = true; else delete p.shortcutStopsRotation; markDirty(); };
    document.getElementById('pnRot').onchange = e => { p.rotate = e.target.checked; markDirty(); };
    document.getElementById('pnHome').onchange = e => {
      if (e.target.checked) {
        const cur = config.homePaneId;
        if (cur && cur !== p.id) {
          const other = (config.panes || []).find(x => x.id === cur);
          if (!ask(((other && other.name) || cur) + ' is currently set as home pane, switch to this one?')) { e.target.checked = false; return; }
        }
        config.homePaneId = p.id;
      } else if (config.homePaneId === p.id) delete config.homePaneId;
      markDirty();
    };
    const addBtn = document.getElementById('pnAddSlot');
    if (addBtn) addBtn.onclick = () => { p.slots.push({ pageId: '' }); render(); markDirty(); };
    const addBtn2 = document.getElementById('pnAddSlot2');
    if (addBtn2) addBtn2.onclick = () => { p.slots2.push({ pageId: '' }); render(); markDirty(); };
    document.getElementById('pnDelete').onclick = deleteCurrentPane;
    // One builder for both columns; drag moves slots within a column AND across columns (a row drop
    // inserts at that spot, a drop on the column's empty space appends).
    const srcArrOf = () => paneSlotDragCol === 'R' ? p.slots2 : p.slots;
    const moveSlot = (dstArr, dstIndex) => {
      const from = paneSlotDragFrom, srcArr = srcArrOf();
      paneSlotDragFrom = -1; paneSlotDragCol = '';
      if (from < 0 || from >= srcArr.length) return;
      if (srcArr === dstArr && (from === dstIndex || dstIndex > srcArr.length)) return;
      if (srcArr !== dstArr && dstArr.length >= PANE_MAX_SLOTS) return;   // target column full
      const [moved] = srcArr.splice(from, 1);
      dstArr.splice(Math.min(dstIndex, dstArr.length), 0, moved);
      render(); markDirty();
    };
    const buildColumn = (slots, containerId, colKey) => {
      const slotsEl = document.getElementById(containerId);
      // The column itself accepts drops (append) — that's how a slot moves into an EMPTY column.
      slotsEl.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
      slotsEl.ondrop = e => { e.preventDefault(); moveSlot(slots, slots.length); };
      if (!slots.length) { slotsEl.innerHTML = '<p class="hint" style="margin:8px 0 0">(empty — drag a page here)</p>'; return; }
      slots.forEach((s, i) => {
        const opts = ['<option value="">— choose a page —</option>']
          .concat((config.grids || []).map(g => {
            const tag = g.kind === 'web' ? '🌐' : g.kind === 'app' ? '🧩' : '▦';
            return `<option value="${esc(g.id)}"${g.id === s.pageId ? ' selected' : ''}>${tag} ${esc(g.name || '(unnamed)')}</option>`;
          })).join('');
        const d = document.createElement('div');
        d.className = 'row';
        d.style.cssText = 'border:1px solid #2a3a4d;border-radius:8px;padding:10px;margin-top:8px;gap:8px;align-items:center';
        d.innerHTML = `
          <span class="griphandle" title="Drag to reorder" style="cursor:grab" draggable="true">☰</span>
          <select data-pn-page style="flex:1;min-width:0">${opts}</select>
          <button data-pn-del class="danger" title="Remove this page from the pane">×</button>`;
        d.querySelector('[data-pn-page]').onchange = e => { s.pageId = e.target.value; markDirty(); };
        d.querySelector('[data-pn-del]').onclick = () => {
          if (!ask('Remove this page from the pane?')) return;
          slots.splice(i, 1); render(); markDirty();
        };
        // Drag starts on the ☰ grip ONLY — a draggable row swallows mousedown on the <select>,
        // making the page dropdown unpickable.
        d.querySelector('.griphandle').ondragstart = e => { paneSlotDragFrom = i; paneSlotDragCol = colKey; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (er) {} };
        d.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; d.classList.add('dragover'); };
        d.ondragleave = () => d.classList.remove('dragover');
        d.ondrop = e => {
          e.preventDefault(); e.stopPropagation();   // don't also fire the column's append-drop
          d.classList.remove('dragover');
          moveSlot(slots, i);
        };
        d.ondragend = () => d.classList.remove('dragover');
        slotsEl.appendChild(d);
      });
    };
    buildColumn(p.slots, 'pnSlots', 'L');
    buildColumn(p.slots2, 'pnSlots2', 'R');
  }
  function deleteCurrentPane() {
    const list = config.panes || [];
    const p = curPane(); if (!p) return;
    if (!ask('Delete pane "' + (p.name || '(unnamed)') + '"?')) return;
    if (config.settings && config.settings.activePaneId === p.id) config.settings.activePaneId = '';
    if (config.homePaneId === p.id) delete config.homePaneId;
    list.splice(paneIndex, 1);
    if (!list.length) { view = 'pages'; leftTab = 'pages'; paneIndex = -1; }
    else paneIndex = Math.min(paneIndex, list.length - 1);
    ti = -1; selEnd = -1; render(); markDirty();
  }

  // ---- settings page ----
  const DEFAULT_APP_REPO = 'https://github.com/TeeJS/open-quake/tree/main/community-apps';
  const DEFAULT_SETTINGS = { launchMode: 'editor', micOnLaunch: false, reservedDisplay: false, keepDisplayAwake: false, offlineIcons: false, appRepo: DEFAULT_APP_REPO, appRepos: [], multiRepo: false, autoPageOnImport: true };
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
    const currentPageStep = () => Object.assign({ nextHotkey: '', prevHotkey: '' }, (config.settings || {}).pageStep || {});
    const pageStep = currentPageStep();
    const currentMon = () => Object.assign({ knobTurn: 'scroll', knobTap: 'enter' }, (config.settings || {}).monitor || {});
    const mon = currentMon();
    const currentTheme = () => Object.assign({ appearance: 'system', accent: '#7CFFB2', presets: ['#7CFFB2', '#38B6FF', '#FF4040', '#FFB000'] }, (config.settings || {}).theme || {});
    const th = currentTheme();
    // Meeting recording settings (config.settings.meeting) — global so auto-record works regardless of
    // which app the panel is showing. Same shape as MEETING_DEFAULTS in main.js.
    const currentMe = () => Object.assign({ folder: '', processedFolder: '', processedByDate: false, transcribeUrl: '', analysisAi: 'claude', micDevice: '', echoGate: false, silenceStopMin: 0, autoRecord: false, recordApps: 'Zoom.exe,Teams.exe,ms-teams.exe', outlookEnabled: false, meetingInfoSource: 'classic', outlookAccount: '', outlookCalendar: 'Calendar', outlookSkipPrefixes: 'Canceled:', transcribeThreshold: '', myName: '', separateRecurring: false, appendMeetingName: false, separateTranscript: false, useDetailsFolder: false, transcribeHooksEnabled: false, preTranscribeCmd: '', postTranscribeCmd: '', taskListEnabled: false, taskListFolder: '', joplinEnabled: false, joplinUrl: '', joplinToken: '', joplinNotebook: 'NW Pipe', slideCaptureEnabled: false, slideAutoStartOnSelect: false, slideNotifications: true, slideHotkeyToggle: 'Ctrl+Alt+S', slideHotkeySelect: 'Ctrl+Alt+W', slideHotkeyManual: 'Ctrl+Alt+C', slideAppFilter: '', slideIdleStopMin: 30, highlightEnabled: false, panelsOpen: '', largeRecordButton: false, busyEnabled: false, busyApps: 'Zoom.exe,Teams.exe,ms-teams.exe,Webex.exe,slack.exe,Discord.exe', busyOnRecording: true, busyOffDelaySec: 5, busyLightEnabled: false, busyLightBusyColor: '#ff0000', busyLightFreeColor: '#00ff00', busyLightBrightness: 100, busyManualColor: '#a020f0', busyLightFreeOff: false, busySchedEnabled: false, busySchedDays: '1,2,3,4,5', busySchedStart: '08:00', busySchedEnd: '17:00', busySchedPerDay: false, busySchedTimes: {}, busyWledEnabled: false, busyWledHost: '', busyMqttEnabled: false, busyMqttUrl: '', busyMqttUser: '', busyMqttPassword: '', busyMqttBaseTopic: 'open-quake' }, (config.settings || {}).meeting || {});
    const me = currentMe();
    // Day set for the busylight schedule. Built here so the markup below stays readable; the empty
    // guard matters because ''.split(',') yields [''] and Number('') is 0, which would silently
    // pre-tick Sunday for a user who has selected no days at all.
    const schedDays = new Set(String(me.busySchedDays || '').split(/[,\s]+/)
      .filter(x => x !== '').map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6));
    // Global TTS/STT (Wyoming) endpoints (config.settings.voice) — same shape as VOICE_DEFAULTS in
    // voiceConfig.js. Each service has its own host+port so STT and TTS can live on different servers.
    const currentVoice = () => Object.assign({ sttHost: '', sttPort: '10300', ttsHost: '', ttsPort: '10200' }, (config.settings || {}).voice || {});
    const voice = currentVoice();
    // ledState = the device's live lighting (loaded when the page opens); fall back to saved config / defaults.
    const L = Object.assign({}, LED_DEFAULT, (config.settings || {}).lighting || {}, ledState || {});
    const effOpts = LED_EFFECTS.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join('');
    const tab = settingsTab;
    const el = document.getElementById('gridmeta');

    // Software tab — on launch + screen rotation
    const swHtml = `
      <div class="row"><label>Run mode</label>
        <select id="sRunMode" style="width:300px">
          <option value="panel">Panel — QUAKE / open-bedrock hardware</option>
          <option value="software">Software — normal desktop window</option>
          <option value="monitor">Monitor — QUAKE as a regular monitor</option>
        </select></div>
      <details class="hint"><summary><b>Software</b> mode runs in an ordinary desktop window and needs no special hardware — ideal for the meeting workflow on any PC.</summary> <b>Panel</b> and <b>Monitor</b> use the QUAKE display. A mode change applies as soon as you click <b>Save</b> — no restart.</details>

      <div id="sSwDeps"${s.runMode === 'software' ? '' : ' style="display:none"'}>
      <p class="sectitle">Software window</p>
      <div class="row"><label style="width:auto">Show</label>
        <select id="sSwDisplay" style="width:230px">
          <option value="pages">Pages — one page at a time</option>
          <option value="pane">Panes — stacked pages</option>
        </select></div>
      <details class="hint"><summary>Software mode only. A <b>pane</b> (created on the sidebar's Panes tab) stacks several of your pages vertically — the window grows to fit them, so a big screen shows them all at once.</summary> In Panes view the window's ☰ button switches between your panes, just like it switches pages. With no usable pane the window falls back to normal Pages. Applies on <b>Save</b>.</details>
      </div>

      <p class="sectitle">On launch</p>
      <div class="row"><label style="width:auto">Editor window</label>
        <select id="sLaunch" style="width:230px">
          <option value="editor">Open the editor window</option>
          <option value="minimized">Open minimized to taskbar</option>
          <option value="tray">Tray only (no window)</option>
        </select></div>
      <details class="hint"><summary>Controls the PC-side editor window on launch.</summary> In Panel/Monitor mode the device panel always activates too; Tray-only hides the editor — reopen it from the tray icon.</details>

      <p class="sectitle">Screen rotation</p>
      <div class="row"><label>Auto-rotate</label>
        <input type="checkbox" id="sRot" style="width:auto;flex:none"><span class="hint" style="margin:0 0 0 8px">cycle the panel through pages automatically</span></div>
      <div id="sRotDeps"${rot.enabled ? '' : ' style="display:none"'}>
      <div class="row"><label>Every</label>
        <input type="number" id="sRotInt" min="5" max="3600" value="${rot.interval}" style="width:90px"><span class="hint" style="margin:0 0 0 8px">seconds (5–3600)</span></div>
      <div class="row"><label>Include</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sRotG"> Grids</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sRotD"> Dashboards</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sRotA"> Apps</label></div>
      <div class="row"><label>Hotkey</label>
        <span class="hkwrap"><input id="sRotKey" readonly placeholder="click, then press keys" value="${esc(rot.hotkey || '')}"><button id="sRotKeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span><span id="sRotKeyWarn" class="hint warn" style="margin:0 0 0 8px"></span></div>
      <details class="hint"><summary>A page rotates only if its category is ticked here <i>and</i> that page's own “Include in rotation” box is checked — the box appears on each page once its category is enabled.</summary> Start/stop any time from the knob menu (double-click) or the tray.</details>
      <details class="hint"><summary>The <b>hotkey</b> starts and pauses rotation from anywhere, even when open-quake isn't focused.</summary> Click the box and press a combo that includes a modifier (e.g. Ctrl+Alt+R). If another app — or one of your page hotkeys — already owns the combo, it just won't fire.</details>
      </div>

      <p class="sectitle">Global shortcuts</p>
      <div class="row"><label>Page forward</label>
        <span class="hkwrap"><input id="sPageNextKey" readonly placeholder="click, then press keys" value="${esc(pageStep.nextHotkey || '')}"><button id="sPageNextKeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span><span id="sPageNextKeyWarn" class="hint warn" style="margin:0 0 0 8px"></span></div>
      <div class="row"><label>Page back</label>
        <span class="hkwrap"><input id="sPagePrevKey" readonly placeholder="click, then press keys" value="${esc(pageStep.prevHotkey || '')}"><button id="sPagePrevKeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span><span id="sPagePrevKeyWarn" class="hint warn" style="margin:0 0 0 8px"></span></div>
      <details class="hint"><summary>Global hotkeys that step the panel <b>forward</b> / <b>back</b> through your visible pages — in the order they're listed here, wrapping around the ends.</summary> Hidden pages are skipped. These work anytime, independent of rotation.</details>
      <div class="row"><label>Reload dashboard</label>
        <span class="hkwrap"><input id="sDashReloadKey" readonly placeholder="click, then press keys" value="${esc(dashReload.hotkey || '')}"><button id="sDashReloadKeyClear" class="inclear" title="Clear shortcut" aria-label="Clear shortcut">✕</button></span><span id="sDashReloadKeyWarn" class="hint warn" style="margin:0 0 0 8px"></span></div>
      <details class="hint"><summary>A global combo that force-reloads the current dashboard page from anywhere, even when open-quake isn't focused.</summary> Switching away to another page and back does <b>not</b> reload a dashboard (that's what keeps its session/scroll state) — this hotkey is the way to force one. Only acts while a dashboard page is showing; does nothing on a grid or app page.</details>

      <p class="sectitle">Network and icons</p>
      <div class="row"><label>Work offline</label>
        <input type="checkbox" id="sOfflineIcons" style="width:auto;flex:none"><span class="hint" style="margin:0 0 0 8px">never fetch icons from the internet — use cached icons and emoji only</span></div>
      <details class="hint"><summary>Home Assistant tiles pull their glyphs from a public icon CDN (jsDelivr) the first time each one is shown, then cache them for good.</summary> Turn this on for locked-down machines: the panel makes <b>zero</b> outbound icon requests and falls back to the emoji glyph for anything not already cached. Seed the cache first by opening the tiles once on a normal network.</details>

      <p class="sectitle">Desktop focus</p>
      <div class="row"><label>Auto-follow</label>
        <input type="checkbox" id="sFocus" style="width:auto;flex:none"><span class="hint" style="margin:0 0 0 8px">switch the panel to a page when its mapped app becomes focused on the PC</span></div>
      <div class="row"><label>While focused</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sFocusPauseRot" ${focusFollow.enabled ? '' : 'disabled'}> Pause auto-rotation</label></div>
      <details class="hint"><summary>Map apps to a page under that page's Advanced settings → “Focus trigger app(s)”.</summary> Detection polls in the background and only switches once the newly-focused app has held focus for a couple seconds, so quick alt-tabbing won't cause flicker — and manually navigating the panel away is never overridden; it only re-triggers on the next focus change. With <b>Pause auto-rotation</b> on, rotation holds off the moment a mapped app takes focus and picks back up the moment it loses focus.</details>

      <p class="sectitle">Setup &amp; troubleshooting</p>
      <div class="row"><button id="sRunSetup">Re-run first-time setup…</button></div>
      <p class="hint">Reopens the first-launch mode picker and device walkthrough.</p>`;

    // Hardware tab — knob ring + microphone
    const devSeen = !!(ledState && ledState.deviceSeen);
    const hwHtml = `
      <p class="sectitle">Knob ring <span class="stpill ${devSeen ? 'ok' : 'off'}">${devSeen ? 'Device connected' : 'Device not detected'}</span></p>
      <div class="row"><label>Effect</label>
        <select id="sEffect" style="width:230px">${effOpts}</select></div>
      <div class="row"><label>Color</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sLedOvr"> Override theme accent</label>
        <input type="color" id="sColor" value="${hsvToHex(L.hue, L.sat)}" style="width:48px;height:28px;padding:2px;margin-left:8px">
        <span id="sColorVal" class="hint" style="margin:0 0 0 8px">H${L.hue} S${L.sat}</span></div>
      <p class="hint" style="margin:-4px 0 0">The ring follows your theme accent by default — tick Override to set a fixed color here.</p>
      <div class="row"><label>Brightness</label>
        <input type="range" id="sBright" min="0" max="255" value="${L.brightness}" style="width:200px">
        <span id="sBrightVal" class="hint" style="margin:0 0 0 10px">${Math.round(L.brightness / 255 * 100)}%</span></div>
      <div class="row"><label>Effect speed</label>
        <input type="range" id="sSpeed" min="0" max="255" value="${L.speed}" style="width:200px">
        <span id="sSpeedVal" class="hint" style="margin:0 0 0 10px">${Math.round(L.speed / 255 * 100)}%</span></div>
      <details class="hint"><summary>Ring changes preview on the device instantly; <b>Store ring settings on device</b> writes them to its own memory so they survive a power cycle even without the PC.</summary> (Effect “All Off” turns the ring off. Animated effects use the color/speed; solid effects ignore speed.)</details>
      <div class="row" style="margin-top:6px"><button id="sSaveLed"${devSeen ? '' : ' disabled'}>Store ring settings on device</button><span id="sSaveLedMsg" class="hint" style="margin:0 0 0 10px"></span></div>

      <p class="sectitle">Knob controls</p>
      <div class="knobtbl">
        <span class="kth"></span>
        <span class="kth">Turn</span>
        <span class="kth">Press</span>
        <span class="kth">Double-press</span>
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
      <details class="hint"><summary>What turning / pressing the knob does on each kind of page.</summary> Any page can override this in its <b>Advanced</b> settings. (“Select button” highlights tiles as you turn; “Enter” activates the highlighted button, play/pauses music, or sends an Enter key.)</details>
      <div class="row" style="margin-top:6px"><button id="sKnobReset">Reset knob controls to defaults</button></div>

      <p class="sectitle">Microphone</p>
      <div class="row"><label>At launch</label>
        <input type="checkbox" id="sMic" style="width:auto;flex:none"><span class="hint" style="margin:0 0 0 8px">enable the device mic when open-quake starts</span></div>
      <details class="hint"><summary>The mic LED and the mic audio are one hardware switch — the light is on whenever the mic is enabled, off when it isn't.</summary> Toggle it any time from the tray menu or a “System → mic” tile.</details>

      <p class="sectitle">Display</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="sKeepAwake" ${s.keepDisplayAwake ? 'checked' : ''}> Keep the display awake while running (disables the screensaver) — Panel mode only</label></div>
      <details class="hint"><summary>Panel mode only. Keeps the screen from sleeping and stops the Windows screensaver so the QUAKE panel stays lit.</summary> <b>Off by default</b> (and always off in Software/Monitor mode) so your normal screensaver works. Windows has no per-display option, so when on it suppresses the screensaver on all displays.</details>

      <p class="sectitle">Touchscreen</p>
      <details class="hint"><summary>If touches land on the wrong monitor, click <b>Set up touchscreen</b>.</summary> open-quake launches Windows' built-in touch-identify wizard (the one Microsoft buried behind the broken-in-24H2 Tablet PC Settings UI) — accept the UAC prompt, then <b>press Enter on your keyboard</b> to skip past your other monitors as the prompt cycles through them, and <b>tap the panel with your finger</b> only when the prompt appears on the panel. That writes a persistent binding under <code>HKLM\\…\\Wisp\\Pen\\Digimon</code> that survives reboot, sleep, and primary-display swaps.</details>
      <details class="hint"><summary><b>Clear all calibrations</b> wipes any old <code>tabcal</code> coordinate calibration.</summary> You don't normally need it — only run it if your taps land on the right display but are visibly off-target.</details>
      <div class="row" style="gap:8px"><button id="sTouchSetup">Set up touchscreen</button><button id="sTouchClear">Clear all calibrations</button><span id="sTouchMsg" class="hint" style="margin:0 0 0 10px"></span></div>`;

    // Monitor tab — reserved-display protection and intentional normal-monitor behavior
    const monHtml = `
      <p class="sectitle">Reserved Display</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="sReserved" ${s.reservedDisplay ? 'checked' : ''}> Keep application windows off the panel display</label></div>
      <details class="hint"><summary>Windows only. Windows dragged or relocated onto the Quake are returned to another display; protection is suspended while Monitor mode is active and resumes when it exits.</summary> If your other displays disconnect, their positions are held and restored when a display returns. Open Quake, Windows shell surfaces, and secure desktop screens are left alone. This does not change the panel's USB keepalive.</details>

      <p class="sectitle">Monitor mode <span id="sMonPill" class="stpill off">checking…</span></p>
      <details class="hint"><summary>Use the device as a normal monitor: it shows your Windows desktop and touch acts as the mouse.</summary> Enter it below, from the tray menu, or with a “System → monitor” tile; exit from the tray. These set what the knob does while in Monitor mode.</details>
      <div class="row"><button id="sMonEnter" disabled>Enter Monitor mode</button><span id="sMonEnterMsg" class="hint" style="margin:0 0 0 10px"></span></div>
      <div class="row"><label>Knob turn</label>
        <select id="sMonTurn" style="width:230px">
          <option value="scroll">Scroll</option>
          <option value="volume">Adjust volume</option>
        </select></div>
      <div class="row"><label>Knob press</label>
        <select id="sMonTap" style="width:230px">
          <option value="enter">Enter</option>
          <option value="leftclick">Left-click</option>
          <option value="rightclick">Right-click</option>
          <option value="mute">Mute / unmute</option>
        </select></div>
      <div class="row"><label>Double-press</label>
        <select disabled style="width:230px" title="Double-press is not bindable in Monitor mode"><option>No action</option></select></div>`;

    // Meeting tab — recording folder, mic, auto-record + app allowlist, silence auto-stop, echo gate
    const meHtml = `
      <p class="sectitle">Meeting recording</p>
      <div class="row"><label>Unprocessed Recordings</label>
        <input id="meFolder" value="${esc(me.folder)}" placeholder="Documents\\OpenQuake Meetings\\unprocessed" style="flex:1">
        <button id="meFolderBrowse" type="button">Browse…</button></div>
      <details class="hint"><summary>Where new recordings land — one stereo WAV per meeting (your mic = left, everyone else = right), named by date and time.</summary> Leave blank to use Documents\\OpenQuake Meetings\\unprocessed.</details>

      <div class="row" style="margin-top:12px"><label>Processed Recordings</label>
        <input id="meProcessed" value="${esc(me.processedFolder)}" placeholder="Documents\\OpenQuake Meetings\\processed" style="flex:1">
        <button id="meProcessedBrowse" type="button">Browse…</button></div>
      <p class="hint">Transcribed recordings and their transcripts are moved here. Leave blank to use Documents\\OpenQuake Meetings\\processed.</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meByDate" ${me.processedByDate ? 'checked' : ''}> Organize by date</label></div>
      <p class="hint">Files each processed recording into year and month subfolders (e.g. 2026\\08\\) under the folder above, by the date it was processed.</p>

      <div class="row" style="margin-top:12px"><label>Microphone</label>
        <select id="meMic" style="flex:1"><option value="">System default</option></select></div>
      <p class="hint">This must be the same mic you use with Teams</p>

      <p class="sectitle">Transcription Server</p>
      <div class="row"><label>URL</label>
        <input id="meTransUrl" value="${esc(me.transcribeUrl || 'http://127.0.0.1:10301/transcribe')}" style="flex:1"></div>
      <details class="hint"><summary>The tts-sst or meeting-diarizer endpoint that turns recordings into speaker-labeled transcripts.</summary> Edit the host/port to match your server; the panel checks its /health before sending. Remember to Save.</details>
      <div class="row" style="margin-top:12px"><label>Analysis AI</label>
        <select id="meAnalysisAi" style="flex:1">
          <option value="claude" ${['codex', 'copilot', 'owui'].includes(me.analysisAi) ? '' : 'selected'}>Claude</option>
          <option value="codex" ${me.analysisAi === 'codex' ? 'selected' : ''}>ChatGPT Codex</option>
          <option value="copilot" ${me.analysisAi === 'copilot' ? 'selected' : ''}>GitHub Copilot</option>
          <option value="owui" ${me.analysisAi === 'owui' ? 'selected' : ''}>Open WebUI</option>
        </select></div>
      <details class="hint"><summary>What turns a transcript into meeting notes on the Analysis screen.</summary> The CLIs use their own login — no API key needed. Open WebUI runs against the connection on the Auth tab (URL, API key, and default model set there).</details>
      <div class="row" style="margin-top:12px"><label>Analysis prompt</label>
        <button id="meEditPrompt" type="button">Edit prompt file</button></div>
      <p class="hint">The instructions the AI follows when analyzing a transcript (meeting-analysis-prompt.md, opens in your default editor). Changes apply to the next analysis.</p>

      <p class="sectitle">Auto-record</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meAuto" ${me.autoRecord ? 'checked' : ''}> Start recording automatically when a call begins</label></div>
      <details class="hint"><summary>Detects when an app below has an active call (its microphone goes live) and starts recording — even if the panel is on another app.</summary> It never triggers on Claude voice or other microphone use.</details>
      <div id="meAutoDeps"${me.autoRecord ? '' : ' style="display:none"'}>
      <div class="row"><label>Call apps</label>
        <input id="meApps" value="${esc(me.recordApps)}" style="flex:1"></div>
      <p class="hint">Comma-separated Windows process names that count as a call, e.g. Zoom.exe, Teams.exe, ms-teams.exe.</p>
      </div>
      <div class="row" style="margin-top:12px"><label>Stop after silence</label>
        <input type="number" id="meSilence" min="0" step="1" value="${Number(me.silenceStopMin) || 0}" style="width:90px"> <span class="hint" style="margin:0 0 0 8px">minutes (0 = never)</span></div>
      <p class="hint">Automatically stop a recording after this many minutes with no audio on either channel.</p>

      <p class="sectitle">Busy status</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meBusy" ${me.busyEnabled ? 'checked' : ''}> Show a busy indicator while you are on a call</label></div>
      <details class="hint"><summary>Turns a busy light red while an app below has your microphone, and back to free when the call ends — replacing the light vendor's own software.</summary> Uses the same detection as auto-record, so it never triggers on Claude voice or other microphone use. Also publishes your status to Home Assistant if you enable it below.</details>
      <div id="meBusyDeps"${me.busyEnabled ? '' : ' style="display:none"'}>
        <div class="row"><label>Call apps</label>
          <input id="meBusyApps" value="${esc(me.busyApps)}" style="flex:1"></div>
        <p class="hint">Comma-separated Windows process names that count as being on a call. This list is separate from the auto-record list above — you may want the light for calls you do not record.</p>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meBusyRec" ${me.busyOnRecording ? 'checked' : ''}> Also show busy while open-quake is recording</label></div>
        <div class="row" style="margin-top:12px"><label>Return to free after</label>
          <input type="number" id="meBusyDelay" min="0" max="120" step="1" value="${Number(me.busyOffDelaySec) || 0}" style="width:90px"> <span class="hint" style="margin:0 0 0 8px">seconds</span></div>
        <p class="hint">A short delay stops the light flickering when a call app briefly releases the microphone mid-meeting, which Teams does when the meeting window changes.</p>

        <p class="sectitle" style="margin-top:20px">Busy light (USB)</p>
        <div class="row"><label>Kuando Busylight</label><span id="meBusyLightStatus" class="hint" style="margin:0">Checking…</span></div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meBusyLight" ${me.busyLightEnabled ? 'checked' : ''}> Drive a Kuando Busylight over USB</label></div>
        <details class="hint"><summary>Talks to the light directly — Kuando's own Busylight for UC software must not be running.</summary> Windows lets only one program hold the device, so if theirs is running the light will appear to flicker or ignore open-quake. Uninstalling or quitting it is the fix.</details>
        <div class="row"><label>Busy colour</label>
          <input type="color" id="meBusyColor" value="${esc(me.busyLightBusyColor)}" style="width:64px;padding:2px">
          <label style="width:auto;margin-left:16px">Free colour</label>
          <input type="color" id="meFreeColor" value="${esc(me.busyLightFreeColor)}" style="width:64px;padding:2px"></div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meFreeOff" ${me.busyLightFreeOff ? 'checked' : ''}> Turn the light off when free instead of showing the free colour</label></div>
        <div class="row"><label>Custom colour</label>
          <input type="color" id="meManualColor" value="${esc(me.busyManualColor)}" style="width:64px;padding:2px">
          <span class="hint" style="margin:0 0 0 12px">Used by the panel's <b>Custom</b> busy mode; also pickable on the panel.</span></div>
        <div class="row"><label>Brightness</label>
          <input type="number" id="meBusyBright" min="1" max="100" step="1" value="${Number(me.busyLightBrightness) || 100}" style="width:90px"> <span class="hint" style="margin:0 0 0 8px">%</span></div>
        <div class="row"><button id="meBusyTestLight" type="button">Test light</button> <span id="meBusyTestLightResult" class="hint" style="margin:0 0 0 10px"></span></div>
        <div class="row" style="margin-top:14px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meSched" ${me.busySchedEnabled ? 'checked' : ''}> Busylight schedule</label></div>
        <details class="hint"><summary>Only drive the Busylight on the days and between the hours you pick.</summary> Outside the schedule the light stays off; the Home Assistant entity and any WLED light keep reporting normally. An end time earlier than the start time means the window runs overnight.</details>
        <div id="meSchedDeps"${me.busySchedEnabled ? '' : ' style="display:none"'}>
          <div class="row"><label>Days</label>
            <span id="meSchedDays" style="display:flex;gap:14px;flex-wrap:wrap">${
              ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) =>
                `<label class="iconopt" style="width:auto;gap:5px"><input type="checkbox" data-day="${i}" ${schedDays.has(i) ? 'checked' : ''}> ${d}</label>`).join('')
            }</span></div>
          <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meSchedPerDay" ${me.busySchedPerDay ? 'checked' : ''}> Use different hours for each day</label></div>
          <div id="meSchedShared"${me.busySchedPerDay ? ' style="display:none"' : ''}>
            <div class="row"><label>Active from</label>
              <input type="time" id="meSchedStart" value="${esc(me.busySchedStart)}" style="width:130px">
              <label style="width:auto;margin-left:16px">to</label>
              <input type="time" id="meSchedEnd" value="${esc(me.busySchedEnd)}" style="width:130px"></div>
          </div>
          <div id="meSchedPerDayRows"${me.busySchedPerDay ? '' : ' style="display:none"'}>${
            ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => schedDays.has(i)
              ? `<div class="row"><label>${d}</label>
                   <input type="time" data-daystart="${i}" value="${esc((me.busySchedTimes[i] || {}).s || me.busySchedStart)}" style="width:130px">
                   <label style="width:auto;margin-left:16px">to</label>
                   <input type="time" data-dayend="${i}" value="${esc((me.busySchedTimes[i] || {}).e || me.busySchedEnd)}" style="width:130px"></div>`
              : '').join('')
          }</div>
          <p class="hint" id="meSchedSummary"></p>
        </div>

        <p class="sectitle" style="margin-top:20px">DIY light (WLED)</p>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meWled" ${me.busyWledEnabled ? 'checked' : ''}> Drive a WLED light over the network</label></div>
        <div class="row"><label>Address</label>
          <input id="meWledHost" value="${esc(me.busyWledHost)}" placeholder="192.168.1.50" style="flex:1"></div>
        <p class="hint">The ESP32's IP address or hostname. Uses the same busy and free colours as the USB light.</p>
        <div class="row"><button id="meBusyTestWled" type="button">Test light</button> <span id="meBusyTestWledResult" class="hint" style="margin:0 0 0 10px"></span></div>

        <p class="sectitle" style="margin-top:20px">Home Assistant (MQTT)</p>
        <div class="row"><label>Broker</label><span id="meMqttStatus" class="hint" style="margin:0">Not configured</span></div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meMqtt" ${me.busyMqttEnabled ? 'checked' : ''}> Publish your busy status to Home Assistant</label></div>
        <details class="hint"><summary>Creates a <b>binary_sensor.open_quake_busy</b> entity in Home Assistant automatically — no configuration needed on the Home Assistant side.</summary> Automations can trigger on it like any other sensor. If open-quake stops or the PC loses power, the entity goes <i>unavailable</i> on its own, so a light driven from it cannot get stuck showing busy. This is separate from the Home Assistant connection on the Auth tab, which is read-only.</details>
        <div class="row"><label>Broker URL</label>
          <input id="meMqttUrl" value="${esc(me.busyMqttUrl)}" placeholder="mqtt://192.168.1.25:1883" style="flex:1"></div>
        <div class="row"><label>Username</label>
          <input id="meMqttUser" value="${esc(me.busyMqttUser)}" style="flex:1"></div>
        <div class="row"><label>Password</label>${secretInput(me.busyMqttPassword, 'id="meMqttPass" style="flex:1"', 'flex:1')}</div>
        <p class="hint">Stored encrypted at rest. Leave both blank if your broker allows anonymous connections.</p>
        <div class="row"><label>Topic prefix</label>
          <input id="meMqttTopic" value="${esc(me.busyMqttBaseTopic)}" placeholder="open-quake" style="flex:1"></div>
        <div class="row"><button id="meBusyTestMqtt" type="button">Test connection</button> <span id="meBusyTestMqttResult" class="hint" style="margin:0 0 0 10px"></span></div>
      </div>

      <p class="sectitle">Capture</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meEcho" ${me.echoGate ? 'checked' : ''}> Echo-gate your microphone</label></div>
      <details class="hint"><summary>Mutes your mic in the recording while the speakers are loud (and you're not on headphones), to stop the far end bleeding back in.</summary> Off = faithful capture of everything you say, even when others are talking.</details>

      <div class="row" style="margin-top:16px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meHighlight" ${me.highlightEnabled ? 'checked' : ''}> Enable Meeting Highlights</label></div>
      <details class="hint"><summary>Adds a Highlight column to the meeting panel: tap to start flagging a moment, tap again to end it.</summary> The flagged spans are saved with the recording and handed to the analysis AI, which calls them out in a <b>Highlights</b> section of the meeting notes.</details>

      <div class="row" style="margin-top:16px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meLargeRec" ${me.largeRecordButton ? 'checked' : ''}> Large record button</label></div>
      <details class="hint"><summary>Adds a big Record button to the meeting panel, beside the Hang&nbsp;Up button, for one-tap start/stop.</summary> The small Record indicator in the top-right corner is unchanged.</details>

      <details class="advsec" style="margin-top:22px">
      <summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Meeting Slide Capture</summary>
      <div class="row" style="margin-top:10px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meSlide" ${me.slideCaptureEnabled ? 'checked' : ''}> Enable Meeting Slide Capture</label></div>
      <details class="hint"><summary>Watches a window you pick (e.g. the Teams meeting) and saves a screenshot each time its content settles on a new slide — skipping live video, which never settles.</summary> Adds a slide-capture column to the meeting panel. Slides are saved beside the recording in a <b>&lt;recording&gt;-screenshots\\</b> folder that travels and renames with it.</details>
      <div class="slidecfg">
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meSlideAuto" ${me.slideAutoStartOnSelect ? 'checked' : ''}> Automatically start capture when a window is selected</label></div>
        <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meSlideNotify" ${me.slideNotifications ? 'checked' : ''}> Show a notification when a slide is captured</label></div>
        <div class="row" style="margin-top:10px"><label>Toggle capture hotkey</label>
          <input id="meSlideHkToggle" value="${esc(me.slideHotkeyToggle)}" placeholder="Ctrl+Alt+S" style="width:180px"></div>
        <div class="row"><label>Select window hotkey</label>
          <input id="meSlideHkSelect" value="${esc(me.slideHotkeySelect)}" placeholder="Ctrl+Alt+W" style="width:180px"></div>
        <div class="row"><label>Manual capture hotkey</label>
          <input id="meSlideHkManual" value="${esc(me.slideHotkeyManual)}" placeholder="Ctrl+Alt+C" style="width:180px"></div>
        <p class="hint">Global hotkeys (each needs Ctrl and/or Alt, and all three must differ). Leave one blank to disable it. <span id="meSlideHkWarn" style="color:#FF6B6B"></span></p>
        <div class="row" style="margin-top:10px"><label>Limit window picker to app</label>
          <select id="meSlideFilterPick" style="width:280px"><option value="">(All apps)</option></select></div>
        <p class="hint">Pick the APP here (e.g. ms-teams); the panel's Select-window picker then lists only that app's windows.</p>
        <div class="row" style="margin-top:10px"><label>Auto-stop after inactive</label>
          <input type="number" id="meSlideIdle" min="0" max="600" step="1" value="${me.slideIdleStopMin}" style="width:120px">
          <span class="hint" style="margin:0 0 0 8px">minutes (0 = never)</span></div>
        <p class="hint">Stops capture after this long with no new slide, so a forgotten session doesn't run all day. The clock resets on every capture.</p>
      </div>
      </details>

      <details class="advsec" style="margin-top:22px">
      <summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Advanced settings</summary>
      <div class="row" style="margin-top:10px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meOutlook" ${me.outlookEnabled ? 'checked' : ''}> Pull meeting information from my calendar</label></div>
      <details class="hint"><summary>When a recording starts, saves the matching appointment (subject, attendees, organizer, body…) as <b>&lt;recording&gt;.json</b> beside the WAV.</summary> The file travels through transcription, where its attendee list improves speaker identification. Ad-hoc calls with nothing scheduled save nothing.</details>
      <div class="row"><label>Calendar source</label>
        <select id="meInfoSource" style="flex:1"><option value="classic" ${me.meetingInfoSource === 'microsoft365' ? '' : 'selected'}>Classic Outlook (this PC)</option><option value="microsoft365" ${me.meetingInfoSource === 'microsoft365' ? 'selected' : ''}>Microsoft 365 (Graph)</option></select>
        <button id="meOutCheck" type="button">Check Connection</button></div>
      <p class="hint" id="meOutMsg"></p>
      <div id="meClassicSettings">
      <div class="row"><label>Account</label>
        <select id="meOutAcct" style="flex:1">${me.outlookAccount ? `<option value="${esc(me.outlookAccount)}" selected>${esc(me.outlookAccount)}</option>` : '<option value="">— click Check Connection —</option>'}</select>
      </div>
      <div class="row"><label>Calendar folder</label>
        <input id="meOutCal" value="${esc(me.outlookCalendar)}" style="flex:1"></div>
      <p class="hint">The calendar folder inside that account — almost always "Calendar".</p>
      </div>
      <div class="row"><label>Skip prefixes</label>
        <input id="meOutSkip" value="${esc(me.outlookSkipPrefixes)}" style="flex:1"></div>
      <p class="hint">Comma-separated subject prefixes to ignore (e.g. Canceled:, Focus time, Lunch) — keeps calendar entries that aren't real meetings out of the lookup.</p>
      <div class="row" style="margin-top:12px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meSepRec" ${me.separateRecurring ? 'checked' : ''}> Separate recurring meetings</label></div>
      <details class="hint"><summary>When a recurring meeting (per its calendar info) is analyzed, its files move from the date folder to <b>YYYY\\&lt;Meeting-Name&gt;\\</b>.</summary> Un-analyzed meetings stay in the date folders, so they're easy to find.</details>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meAppendName" ${me.appendMeetingName ? 'checked' : ''} ${me.outlookEnabled ? '' : 'disabled'}> Append meeting name to filename</label></div>
      <details class="hint"><summary>Renames a finished recording from &lt;timestamp&gt;.wav to <b>&lt;timestamp&gt;-&lt;Meeting Name&gt;.wav</b> when the calendar matched a meeting; every later file (transcript, analysis…) inherits the name.</summary> Requires meeting information above.</details>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meSepTx" ${me.separateTranscript ? 'checked' : ''}> Separate Clean Transcript</label></div>
      <p class="hint">Leaves the full transcript out of the analysis .md and saves it as <b>&lt;name&gt;-clean_transcript.txt</b> instead.</p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="meTaskList" ${me.taskListEnabled ? 'checked' : ''}> Create task-lists for post-analysis processing</label></div>
      <details class="hint"><summary>After each analysis batch finishes, writes a dated checklist pointing at the new <b>-analysis.md</b> files (plus meeting metadata when available) — the hand-off for pulling your action items onto a board.</summary> One file per batch, named like <b>2026-08-17_10-42-13.md</b>.</details>
      <div class="row"><label>Task-list folder</label>
        <input id="meTaskFolder" value="${esc(me.taskListFolder)}" placeholder="blank = task-list under Processed Recordings" style="flex:1">
        <button id="meTaskFolderBrowse" type="button">Browse…</button></div>
      <div class="row" style="margin-top:12px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meJoplin" ${me.joplinEnabled ? 'checked' : ''}> Create Joplin notes for analyses</label></div>
      <details class="hint"><summary>After each analysis, creates a note in Joplin via the Web Clipper API of Joplin Desktop (Tools › Options › Web Clipper): title = recording name, body = the analysis, tagged <b>meeting notes</b> + the year + title keywords.</summary> Only tags that already exist in Joplin are applied — none are created. Joplin Desktop must be running when the analysis finishes.</details>
      <div class="row"><label>Joplin API URL</label>
        <input id="meJoplinUrl" value="${esc(me.joplinUrl)}" placeholder="e.g. http://192.168.1.50:41184" style="flex:1"></div>
      <div class="row"><label>API token</label>${secretInput(me.joplinToken || '', 'id="meJoplinToken" placeholder="Joplin › Tools › Options › Web Clipper"', 'flex:1')}</div>
      <div class="row"><label>Notebook</label>
        <input id="meJoplinNb" value="${esc(me.joplinNotebook)}" style="width:230px"></div>
      <div class="row" style="margin-top:12px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meDetails" ${me.useDetailsFolder ? 'checked' : ''}> Use Details Folder</label></div>
      <p class="hint">At analysis, everything except the notes .md (WAV, transcript, meeting info, clean transcript) moves into a <b>details\\</b> subfolder of the meeting's folder.</p>
      <div class="row" style="margin-top:12px"><label>Speaker threshold</label>
        <input type="number" id="meThreshold" min="0" max="1" step="0.05" value="${esc(me.transcribeThreshold)}" style="width:120px">
        <span class="hint" style="margin:0 0 0 8px">blank = server default</span></div>
      <details class="hint"><summary>Speaker-identification cosine cutoff (e.g. 0.70) sent with each transcription.</summary> Attendees from the calendar meeting info are sent automatically — the diarizer penalizes enrolled speakers who aren't on the list, cutting false matches.</details>
      <div class="row" style="margin-top:12px"><label>My name</label>
        <input id="meMyName" value="${esc(me.myName)}" placeholder="e.g. T.J. Schmitz" style="flex:1"></div>
      <details class="hint"><summary>Your enrolled speaker name.</summary> When set, it's sent as <b>me_name</b> and the transcription server labels your isolated-mic channel's voice with certainty (channel-guided ID) — no threshold wobble for you. Blank = off. Note: in hybrid meetings, people in the room with you also land on your mic channel and still go through normal identification.</details>
      <div class="row" style="margin-top:12px"><label class="iconopt" style="width:auto"><input type="checkbox" id="meHooks" ${me.transcribeHooksEnabled ? 'checked' : ''}> Run commands before/after transcription</label></div>
      <details class="hint"><summary>Start and stop the transcription server around each batch — e.g. a diarizer container that holds GPU memory while loaded.</summary> <b>Before</b> runs once when the queue starts; open-quake then waits (up to 5 min) for the server's /health before uploading. <b>After</b> runs once when the queue finishes. Full cmd.exe syntax, multi-line OK — or just call a .bat.</details>
      <div class="row"><label>Before</label>
        <textarea id="meHookPre" rows="2" style="flex:1; font-family:inherit" placeholder='e.g. ssh root@192.168.1.25 "docker start meeting-diarizer"'>${esc(me.preTranscribeCmd)}</textarea></div>
      <div class="row" style="margin-top:8px"><label>After</label>
        <textarea id="meHookPost" rows="2" style="flex:1; font-family:inherit" placeholder='e.g. ssh root@192.168.1.25 "docker stop meeting-diarizer"'>${esc(me.postTranscribeCmd)}</textarea></div>
      </details>`;

    // Theme tab — global light/dark + accent color
    const thHtml = `
      <p class="sectitle">Appearance</p>
      <div class="row"><label>Mode</label>
        <select id="sAppear" style="width:230px">
          <option value="system">System (follow Windows)</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select></div>
      <details class="hint"><summary>Light/dark for the panel, the clocks, and the apps — and passed to web dashboards like a browser's light/dark.</summary> Each page can override this in its own <b>Advanced</b> section.</details>
      <p class="sectitle">Accent color</p>
      <div class="row"><label>Accent</label>
        <input type="color" id="sAccent" value="${esc(th.accent)}" style="width:54px;height:30px;padding:2px">
        <input id="sAccentHex" value="${esc(th.accent)}" maxlength="7" spellcheck="false" style="width:100px;font-family:Consolas,monospace">
        <button id="sAccentReset">Reset to default</button></div>
      <div class="row"><label style="width:auto">Presets</label>
        <span id="sPresets" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"></span>
        <button id="sPresetSave" style="margin-left:10px">＋ Save current</button></div>
      <details class="hint"><summary>Drives the clock digits/hands, the tile-tap highlight, the music play button, and the knob LED ring.</summary> Click a preset to apply; <i>Save current</i> stores it (up to 6); hover a preset for its remove button.</details>
      <p class="sectitle">Preview</p>
      <div id="thPreview"></div>
      <p class="hint">The preview is live; the panel itself changes when you <b>Save &amp; apply</b>.</p>`;

    // Apps tab — one compact app-management surface: toolbar, bounded two-column row list with
    // right-aligned Shown/Hidden switches. Hiding only changes what the App picker offers.
    const appRow = (a, on) => `<div class="arow" data-name="${esc(String(a.name || '').toLowerCase())}">
        <span class="abadge" aria-hidden="true">${esc(a.icon || String(a.name || a.id).trim().charAt(0).toUpperCase())}</span>
        <span class="ameta"><span class="amname" title="${esc(a.name)}">${esc(a.name)}</span>${a.description ? `<span class="amdesc" title="${esc(a.description)}">${esc(a.description)}</span>` : ''}</span>
        <label class="aswitch"><input type="checkbox" class="appShow" data-id="${esc(a.id)}" ${on ? 'checked' : ''} aria-label="Show ${esc(a.name)} in the App picker"><span class="swtrack"></span><span class="swstate">${on ? 'Shown' : 'Hidden'}</span></label>
      </div>`;
    const builtinApps = appDefs.filter(a => !a._folder);
    const appsHtml = `
      <div class="amgr">
        <p class="amnote">Hiding an app removes it from the App picker. Existing pages keep working.</p>
        <div class="ambar">
          <input id="appFilter" type="search" placeholder="Search apps…">
          <span id="appCount" class="amcount"></span>
        </div>
        <div class="amhead"><span class="amlabel">Built-in apps</span>
          <span class="ambulk"><button id="appShowAll">Show all</button><button id="appHideAll">Hide all</button></span></div>
        <div class="alist">
          ${builtinApps.length ? builtinApps.map(a => appRow(a, !appHidden(a.id))).join('') : '<p class="amempty" style="display:block">No apps found.</p>'}
          <p class="amempty" id="amNoMatch">No apps match your search.</p>
        </div>
        <p class="amlink">Looking for installed apps? <a id="amGoDropin" href="#" role="button">Manage drop-in apps →</a></p>
      </div>`;

    // Auth tab — credentials shared across the app (Home Assistant, Open WebUI). Token and API key
    // are stored encrypted at rest via secretStore (same path as settings.spotify.refreshToken).
    const ha = (s.haAuth && typeof s.haAuth === 'object') ? s.haAuth : { url: '', token: '', useHa: false };
    const ow = (s.owui && typeof s.owui === 'object') ? s.owui : { url: '', apiKey: '', model: '' };
    const obs = (s.obs && typeof s.obs === 'object') ? s.obs : {};
    const authHtml = `
      <div class="card">
      <p class="sectitle">Home Assistant <span id="sHaPill" class="stpill ${ha.useHa ? 'ok' : 'off'}">${ha.useHa ? 'Enabled' : 'Disabled'}</span></p>
      <div class="row"><label class="iconopt" style="width:auto"><input type="checkbox" id="sHaUse" ${ha.useHa ? 'checked' : ''}> Use Home Assistant</label>
        <button id="sHaRefresh" type="button" style="margin-left:12px" ${ha.useHa ? '' : 'disabled'}>Refresh Configuration</button>
        <span id="sHaStatus" class="hint" style="margin:0 0 0 10px"></span></div>
      <div id="sHaFields"${ha.useHa ? '' : ' style="display:none"'}>
      <details class="hint"><summary>When on, open-quake caches your HA dashboards, areas, devices, entities, floors, and labels at startup.</summary> The Home Assistant Dashboard app and (later) entity-aware features depend on this cache.</details>
      <div class="row"><label>URL</label>
        <input type="text" id="sHaUrl" value="${esc(ha.url || '')}" placeholder="http://homeassistant.local:8123" style="flex:1"></div>
      <div class="row"><label>Long-Lived Access Token</label>
        <input type="password" id="sHaToken" value="${esc(ha.token || '')}" placeholder="paste your long-lived access token" style="flex:1"></div>
      <p class="hint">The token is stored encrypted at rest (same secret store as your dashboard tokens). It only leaves the main process for features that need it.</p>
      </div>
      </div>

      <div class="card">
      <p class="sectitle">Open WebUI <span class="stpill ${ow.url ? 'ok' : 'off'}">${ow.url ? 'Configured' : 'Not configured'}</span></p>
      <div class="row"><label>URL</label>
        <input type="text" id="sOwUrl" value="${esc(ow.url || '')}" placeholder="http://192.168.1.25:3000" style="flex:1"></div>
      <div class="row"><label>API key</label>${secretInput(ow.apiKey || '', 'id="sOwKey" placeholder="paste an Open WebUI API key"', 'flex:1')}</div>
      <div class="row"><label>Default model</label>
        <input type="text" id="sOwModel" value="${esc(ow.model || '')}" placeholder="e.g. llama3.2" style="flex:1">
        <button id="sOwTest" type="button" style="margin-left:8px">Check connection</button></div>
      <p class="hint" id="sOwStatus" style="min-height:16px;margin:2px 0 0"></p>
      <details class="hint"><summary>One connection shared by the meeting <b>Analysis AI</b> (Open WebUI option on the Meeting tab) and the <b>Open WebUI Voice</b> panel app.</summary> The key is stored encrypted at rest. In Open WebUI: avatar (bottom-left) → Settings → Account → API Keys — an admin may need to enable API keys first.</details>
      </div>

      <div class="card">
      <p class="sectitle">OBS Studio <span id="sObsPill" class="stpill ${obs.enabled ? 'ok' : 'off'}">${obs.enabled ? 'Enabled' : 'Disabled'}</span></p>
      <div class="row"><label>Enable</label>
        <input type="checkbox" id="sObsEnabled" style="width:auto;flex:none"><span class="hint" style="margin:0 0 0 8px">connect to OBS for the OBS switcher app and OBS tiles</span></div>
      <div id="sObsFields"${obs.enabled ? '' : ' style="display:none"'}>
      <div class="row"><label>Host</label>
        <input type="text" id="sObsHost" value="${esc(obs.host || '127.0.0.1')}" placeholder="127.0.0.1" style="width:200px">
        <label style="width:auto;margin:0 8px 0 16px">Port</label>
        <input type="text" id="sObsPort" value="${esc(obs.port || '4455')}" placeholder="4455" style="width:90px"></div>
      <div class="row"><label>Password</label>${secretInput(obs.password || '', 'id="sObsPass" placeholder="from OBS → Tools → WebSocket Server Settings"', 'flex:1')}
        <button id="sObsTest" type="button" style="margin-left:8px">Check connection</button></div>
      <div class="row"><label>Reconnect</label>
        <label class="iconopt" style="width:auto"><input type="checkbox" id="sObsAuto" style="width:auto;flex:none"> automatically if OBS restarts</label></div>
      <p class="hint" id="sObsStatus" style="min-height:16px;margin:2px 0 0"></p>
      <details class="hint"><summary>In OBS: <b>Tools → WebSocket Server Settings</b> → enable the server, then <b>Show Connect Info</b> for the port and password.</summary> The password is stored encrypted at rest and never leaves the main process.</details>
      </div>
      </div>

      <div class="card">
      <p class="sectitle">OAuth 2.0</p>
      <details class="hint"><summary>Connect services once for built-in integrations.</summary> OAuth tokens stay in the main process, are encrypted at rest, and are refreshed before expiry; drop-in apps cannot request them.</details>
      <div id="sOauthList"><p class="hint">Loading OAuth providers...</p></div>
      </div>`;

    // Drop-In Apps tab — manage user-installed app folders (import/export/delete) + storage location
    const diHtml = `
      <p class="hint" style="margin-bottom:2px">Self-contained app folders. Manage installed apps, get updates, discover new ones, and configure repositories.</p>
      <div id="diSubbar" class="diSubbar"></div>
      <div id="diMsg" class="hint" style="margin:0 0 10px;min-height:16px"></div>
      <div id="diPane"></div>`;

    const ttsHtml = `
      <p class="sectitle">Speech-to-text (Whisper / STT)</p>
      <div class="row"><label>STT host / port</label>
        <input id="ttsSttHost" value="${esc(voice.sttHost)}" placeholder="127.0.0.1" style="flex:1">
        <input id="ttsSttPort" value="${esc(voice.sttPort)}" placeholder="10300" style="width:90px;margin-left:8px"></div>

      <p class="sectitle">Text-to-speech (Piper / TTS)</p>
      <div class="row"><label>TTS host / port</label>
        <input id="ttsTtsHost" value="${esc(voice.ttsHost)}" placeholder="127.0.0.1" style="flex:1">
        <input id="ttsTtsPort" value="${esc(voice.ttsPort)}" placeholder="10200" style="width:90px;margin-left:8px"></div>

      <details class="hint"><summary>The default STT (Whisper) and TTS (Piper) servers for every voice app and meeting dictation.</summary> Each service has its own host + port, so they can run on different machines. Enter your server's IP, or run <a href="#" id="ttsHelperLink">tts-stt-windows</a> on any Windows box to provide both and set the host to <code>127.0.0.1</code>. A page can override these in its <b>Advanced settings</b>. Remember to Save.</details>`;

    // AI Profiles (Smart Profiles): the global library the AI Voice app's Profile picker offers.
    const apHtml = `
      <details class="hint"><summary>Named instructions for the <b>AI Voice</b> app — pick one on the panel (the Profile button) and the AI behaves accordingly: translate, summarize, write, and so on.</summary> The instruction is sent to the AI as its role for the conversation. An empty instruction (General Chat) means plain, unmodified chat. Every AI Voice page remembers its own current profile. Remember to Save.</details>
      <div id="sAiProfileRows">${aiProfileRowsHtml((config.settings || {}).aiProfiles)}</div>
      <button id="sAiProfileAdd" type="button" style="margin-top:10px">+ Add profile</button>`;

    // Routines: saved prompts an "AI Routine" tile re-runs with one tap. Its own tab rather than a
    // second list under AI Profiles -- that tab is already full.
    const rtHtml = `
      <details class="hint"><summary>A routine is a saved request plus which <b>AI Chat</b> page — and, for the agent backends, which <b>folder</b> — runs it.</summary> Put one on a tile (tile type <b>AI Routine</b>) and tapping it switches the panel to that page and sends the request, with the agent's normal tools and approvals. You can also save one straight from the panel: the <b>+ Routine</b> button beside Send on any AI Chat page keeps whatever you just typed or asked for. Remember to Save.</details>
      <div id="sRoutineRows">${routineEditorHtml()}</div>`;
    // Two-level settings nav: grouped vertical category list instead of a wrapping tab strip.
    const NAV = [
      ['General', [['software', 'Software'], ['theme', 'Theme']]],
      ['Device', [['hardware', 'Hardware'], ['monitor', 'Monitor']]],
      ['Apps', [['apps', 'Apps'], ['dropin', 'Drop-in apps']]],
      ['Integrations', [['auth', 'Auth'], ['ttsstt', 'TTS/STT']]],
      ['Automation', [['aiprofiles', 'AI Profiles'], ['routines', 'Routines'], ['meeting', 'Meeting']]],
    ];
    // Every settings page opens with a normal title + one-sentence purpose; small uppercase labels
    // are reserved for its subsections.
    const TAB_META = {
      software: ['Software', 'Run mode, launch behavior, screen rotation, and global shortcuts.'],
      theme: ['Theme', 'Light/dark appearance and the accent color.'],
      hardware: ['Hardware', 'Knob ring, knob controls, microphone, display, and touchscreen.'],
      monitor: ['Monitor', 'Reserved-display protection and Monitor-mode knob behavior.'],
      apps: ['Apps', 'Choose which apps appear in the page builder.'],
      dropin: ['Drop-in apps', 'Install, update, and manage self-contained app folders.'],
      auth: ['Auth', 'Connections and credentials shared across the app.'],
      ttsstt: ['TTS/STT', 'The default speech-to-text and text-to-speech servers.'],
      aiprofiles: ['AI Profiles', 'Named instructions the AI Voice app can switch between.'],
      routines: ['Routines', 'Saved requests that run on an AI Chat page with one tap.'],
      meeting: ['Meeting', 'Recording, transcription, and analysis workflow.'],
    };
    const meta = TAB_META[tab] || ['Settings', ''];
    el.innerHTML = `
      <div class="setwrap">
        <nav class="setnav">
          <p class="sectitle">Settings</p>
          ${NAV.map(([grp, items]) => `<p class="setgroup">${grp}</p>`
            + items.map(([id, lb]) => `<button class="setitem${tab === id ? ' on' : ''}" data-tab="${id}">${lb}</button>`).join('')).join('')}
        </nav>
        <div class="setbody">
          <h2 class="settitle">${meta[0]}</h2>
          <p class="setdesc">${meta[1]}</p>
          ${tab === 'software' ? swHtml : tab === 'hardware' ? hwHtml : tab === 'theme' ? thHtml : tab === 'apps' ? appsHtml : tab === 'dropin' ? diHtml : tab === 'auth' ? authHtml : tab === 'aiprofiles' ? apHtml : tab === 'routines' ? rtHtml : tab === 'meeting' ? meHtml : tab === 'ttsstt' ? ttsHtml : monHtml}
        </div>
      </div>`;

    el.querySelectorAll('.setitem').forEach(b => b.onclick = () => {
      settingsTab = b.dataset.tab;
      renderSettings();
      const sc = document.querySelector('.col.editor'); if (sc) sc.scrollTop = 0;   // new category opens at its top
    });
    wireAiProfileRows();   // no-op unless the AI Profiles tab is showing
    wireRoutineRows();     // no-op unless the Routines tab is showing
    const setS = (k, v) => { if (!config.settings) config.settings = {}; config.settings[k] = v; markDirty(); };

    if (tab === 'apps') {
      // shown/hidden summary + search + bulk show/hide
      const updateAppCount = () => {
        const boxes = [...el.querySelectorAll('.appShow')];
        const hidden = boxes.filter(c => !c.checked).length;
        const cnt = document.getElementById('appCount');
        if (cnt) cnt.textContent = (boxes.length - hidden) + ' shown · ' + hidden + ' hidden';
      };
      updateAppCount();
      const appFilterEl = document.getElementById('appFilter');
      if (appFilterEl) appFilterEl.oninput = e => {
        const q = e.target.value.trim().toLowerCase();
        let visible = 0;
        el.querySelectorAll('.arow').forEach(r => {
          const show = !q || (r.dataset.name || '').includes(q);
          r.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        const empty = document.getElementById('amNoMatch');
        if (empty) empty.style.display = visible ? '' : 'block';
      };
      const showAllBtn = document.getElementById('appShowAll');
      if (showAllBtn) showAllBtn.onclick = () => {
        if (!config.settings) config.settings = {};
        config.settings.hiddenApps = [];
        markDirty(); renderSettings();
      };
      // no confirmation: the change is reversible and stays pending until Save & apply
      const hideAllBtn = document.getElementById('appHideAll');
      if (hideAllBtn) hideAllBtn.onclick = () => {
        if (!config.settings) config.settings = {};
        config.settings.hiddenApps = appDefs.filter(a => !a._folder).map(a => a.id);
        markDirty(); renderSettings();
      };
      el.querySelectorAll('.appShow').forEach(c => c.onchange = e => {
        const id = e.target.dataset.id;
        if (!config.settings) config.settings = {};
        const hidden = (config.settings.hiddenApps || []).filter(x => x !== id);   // tracked when HIDDEN (default shown)
        if (!e.target.checked) hidden.push(id);
        config.settings.hiddenApps = hidden;
        const state = e.target.closest('.aswitch');
        const lb = state && state.querySelector('.swstate');
        if (lb) lb.textContent = e.target.checked ? 'Shown' : 'Hidden';
        markDirty();
        updateAppCount();
      });
      const goDropin = document.getElementById('amGoDropin');
      if (goDropin) goDropin.onclick = e => {
        e.preventDefault();
        settingsTab = 'dropin';
        renderSettings();
        const sc = document.querySelector('.col.editor'); if (sc) sc.scrollTop = 0;
      };
    }

    if (tab === 'dropin') {
      // Repositories the user can browse/install from. Migrate the legacy single `appRepo` into the array.
      const repos = (Array.isArray(config.settings && config.settings.appRepos) && config.settings.appRepos.length)
        ? config.settings.appRepos.slice()
        : [(config.settings && config.settings.appRepo) || DEFAULT_APP_REPO];
      let multi = !!(config.settings && config.settings.multiRepo);
      const isGithubRepo = u => /^https?:\/\/(github\.com|raw\.githubusercontent\.com)\//i.test(String(u || '').trim());
      const persistRepos = () => { setS('appRepos', repos.slice()); setS('appRepo', repos[0] || DEFAULT_APP_REPO); };
      const diMsg = (t, bad) => { const m = document.getElementById('diMsg'); if (m) { m.textContent = t || ''; m.style.color = bad ? '#c98' : '#7e93ab'; } };
      const repoIndexOf = src => (src ? repos.indexOf(src) : -1);
      const metaOf = a => [a.id, a.served ? 'served' : null, a.hasServer ? 'server' : null, a.managed ? null : 'read-only'].filter(Boolean).join(' · ');
      const fmtAgo = ts => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; return Math.round(s / 3600) + ' h ago'; };
      // Human-readable repository names (editor-only, stored parallel to appRepos). References stay keyed by
      // URL, so renaming never changes what an installed app points at; R0/R1 is muted technical metadata.
      const isPriv = i => /apps-private/i.test(repos[i] || '');
      const defaultRepoName = (url, i) => { const u = String(url || ''); if (/apps-private/i.test(u)) return 'Private Apps'; if (u === DEFAULT_APP_REPO) return 'Community Apps'; return 'Source ' + (i + 1); };
      const savedNames = (config.settings && Array.isArray(config.settings.appRepoNames)) ? config.settings.appRepoNames.slice() : [];
      const repoNames = repos.map((u, i) => (savedNames[i] && String(savedNames[i]).trim()) || defaultRepoName(u, i));
      const persistNames = () => setS('appRepoNames', repoNames.slice());
      const nameOf = i => (i >= 0 ? (repoNames[i] || defaultRepoName(repos[i], i)) : '');
      const nameForSource = src => nameOf(repoIndexOf(src));
      const nameError = (val, i) => { const v = String(val || '').trim(); if (!v) return 'Name can’t be blank'; if (v.length > 40) return 'Max 40 characters'; if (repoNames.some((n, j) => j !== i && String(n || '').trim().toLowerCase() === v.toLowerCase())) return 'Name already in use'; return ''; };
      // Optionally add a ready-to-use page for a freshly installed app. Skipped when a page already exists.
      const maybeAddAppPage = (id, name) => {
        if (!appSettings().autoPageOnImport) return false;
        if ((config.grids || []).some(g => g && g.kind === 'app' && g.app === id)) return false;
        if (!config.grids) config.grids = [];
        config.grids.push({ id: uid(), name: name || id, kind: 'app', app: id, options: {} });
        markDirty(); renderGrids();
        return true;
      };

      // ---- state (persists while the Drop-In Apps settings tab stays open) ----
      let diTab = 'installed';
      let diSearchI = '', diSearchD = '';
      let diSrcFilter = 'all';       // Discover source filter: 'all' or a repo index
      let diHideInstalled = true;    // Discover: hide already-installed apps (on by default)
      const diFilterI = { src: new Set(), st: new Set() };   // Installed filter (by source / status)
      const diSortI = { col: 'name', dir: 1 };               // Installed sort (column + direction)
      const diStatus = {};           // id -> {state:'ok'|'upd'|'err', from, to}
      let diLastChecked = null;
      let diCatalog = null;          // merged repo catalog for Discover (lazy, cached)
      let diInstalled = [];
      const refreshInstalled = async () => { try { diInstalled = (await configApi.listDropInApps()) || []; } catch (e) { diInstalled = []; } };
      const loadCatalog = async (force) => {
        if (diCatalog && !force) return diCatalog;
        const seen = {};
        for (let i = 0; i < repos.length; i++) {
          const url = (repos[i] || '').trim();
          if (!url || !isGithubRepo(url)) continue;
          let r; try { r = await configApi.listRepoApps(url); } catch (e) { continue; }
          if (!r || !r.ok) continue;
          for (const a of r.apps) if (!seen[a.id]) seen[a.id] = Object.assign({}, a, { repoIndex: i });
        }
        diCatalog = Object.values(seen);
        return diCatalog;
      };

      const closeDiMenus = () => document.querySelectorAll('#diPane .diMenu.open, #diPane .diFmenu.open').forEach(m => m.classList.remove('open'));
      if (!window.__diMenuClose) { document.addEventListener('click', closeDiMenus); window.__diMenuClose = true; }

      // ---- actions ----
      // Per-APP executable-code trust: once approved with "don't ask again", installs/updates/
      // reinstalls of THAT app skip the exec-code prompt. New apps always prompt, whatever their
      // repo. Saved immediately (like the install itself) rather than waiting for Save & apply.
      const appTrusted = id => (((config.settings || {}).trustedApps) || []).includes(id);
      const setAppTrusted = (id, on) => {
        if (!config.settings) config.settings = {};
        const t = (config.settings.trustedApps || []).filter(x => x !== id);
        if (on) t.push(id);
        config.settings.trustedApps = t;
        markDirty(); doSave();
      };
      // Three-way exec-code prompt (in-editor dialog — native confirm can only offer two answers,
      // and leaves the editor with the focus-loss bug). Resolves 'once' | 'always' | 'no'.
      const execPrompt = (message, verb) => new Promise(resolve => {
        const ov = document.createElement('div');
        ov.className = 'diTrustOv';
        ov.innerHTML = `<div class="diTrustBox" role="dialog" aria-modal="true"><p style="margin:0 0 4px">${esc(message)}</p>
          <div class="row" style="gap:8px;justify-content:flex-end;margin:16px 0 0;flex-wrap:wrap">
            <button id="dtCancel">Cancel</button>
            <button id="dtOnce">${esc(verb)}</button>
            <button id="dtAlways" class="primary">${esc(verb)} and don't ask again for this app</button>
          </div></div>`;
        document.body.appendChild(ov);
        const onKey = e => { if (e.key === 'Escape') fin('no'); };
        const fin = v => { document.removeEventListener('keydown', onKey); ov.remove(); resolve(v); };
        document.addEventListener('keydown', onKey);
        ov.onclick = e => { if (e.target === ov) fin('no'); };
        ov.querySelector('#dtCancel').onclick = () => fin('no');
        ov.querySelector('#dtOnce').onclick = () => fin('once');
        const always = ov.querySelector('#dtAlways');
        always.onclick = () => fin('always');
        always.focus();
      });
      const doInstall = async (id, confirmExec, repoUrl) => {
        const repo = (repoUrl || '').trim() || repos[0];
        if (!confirmExec && appTrusted(id)) confirmExec = true;
        diMsg('Installing "' + id + '"…');
        const r = await configApi.installRepoApp(id, confirmExec, repo);
        if (r && r.ok) { appDefs = await configApi.getApps(); const added = maybeAddAppPage(r.id, r.name); diCatalog = null; await refreshInstalled(); renderSubtabs(); renderPane(); diMsg('Installed "' + r.name + '" from ' + (nameForSource(repo) || 'the repository') + (added ? ' — added a page' : '') + '.'); }
        else if (r && r.warnExec && !confirmExec) {
          const c = await execPrompt('This app contains executable code' + (r.server ? ' (a server module)' : ' (programs/scripts)') + ' that runs on your PC with full access. Only install it if you trust the source.', 'Install');
          if (c === 'no') return diMsg('');
          if (c === 'always') setAppTrusted(id, true);
          doInstall(id, true, repo);
        }
        else if (r && r.conflict) diMsg('"' + id + '" is already installed — use Update instead.', true);
        else diMsg('Install failed: ' + ((r && r.error) || 'unknown error'), true);
      };
      const doUpdate = async (id, confirmExec) => {
        if (!confirmExec) {
          diMsg('Checking "' + id + '" for updates…');
          const c = await configApi.checkDropInUpdate(id);
          if (!c || !c.ok) return diMsg('Update check failed: ' + ((c && c.error) || ''), true);
          if (!c.updateAvailable) { diStatus[id] = { state: 'ok' }; renderPane(); return diMsg('"' + id + '" is up to date (v' + c.installedVersion + ').'); }
          if (!ask('Update "' + id + '" from v' + c.installedVersion + ' to v' + c.remoteVersion + '?')) return diMsg('');
          if (appTrusted(id)) confirmExec = true;
        }
        diMsg('Updating "' + id + '"…');
        const r = await configApi.updateDropInApp(id, confirmExec);
        if (r && r.ok && r.updated) { diStatus[id] = { state: 'ok' }; appDefs = await configApi.getApps(); diCatalog = null; await refreshInstalled(); renderSubtabs(); renderPane(); diMsg('Updated "' + (r.name || id) + '" to v' + r.version); }
        else if (r && r.ok && r.upToDate) { diStatus[id] = { state: 'ok' }; renderPane(); diMsg('"' + id + '" is up to date.'); }
        else if (r && r.warnExec && !confirmExec) {
          const c = await execPrompt('This update contains executable code' + (r.server ? ' (a server module)' : ' (programs/scripts)') + ' that runs on your PC.', 'Update');
          if (c === 'no') return diMsg('');
          if (c === 'always') setAppTrusted(id, true);
          doUpdate(id, true);
        }
        else diMsg('Update failed: ' + ((r && r.error) || 'unknown error'), true);
      };
      const doReinstall = async (id, confirmExec) => {
        if (!confirmExec) {
          if (!ask('Reinstall "' + id + '"? This re-downloads and overwrites its files.')) return diMsg('');
          if (appTrusted(id)) confirmExec = true;
        }
        diMsg('Reinstalling "' + id + '"…');
        const r = await configApi.reinstallDropInApp(id, confirmExec);
        if (r && r.ok && r.reinstalled) { delete diStatus[id]; appDefs = await configApi.getApps(); diCatalog = null; await refreshInstalled(); renderSubtabs(); renderPane(); diMsg('Reinstalled "' + (r.name || id) + '" (v' + r.version + ').'); }
        else if (r && r.warnExec && !confirmExec) {
          const c = await execPrompt('This app contains executable code that runs on your PC.', 'Reinstall');
          if (c === 'no') return diMsg('');
          if (c === 'always') setAppTrusted(id, true);
          doReinstall(id, true);
        }
        else diMsg('Reinstall failed: ' + ((r && r.error) || 'unknown error'), true);
      };
      const doExport = async id => { const r = await configApi.exportDropInApp(id); diMsg(r && r.ok ? 'Exported to ' + r.path : (r && r.canceled ? '' : 'Export failed: ' + ((r && r.error) || '')), !(r && r.ok)); };
      const doDelete = async id => {
        if (!ask('Delete drop-in app "' + id + '" and its folder?')) return;
        const r = await configApi.deleteDropInApp(id);
        if (r && r.ok) { delete diStatus[id]; diMsg('Deleted ' + id); appDefs = await configApi.getApps(); diCatalog = null; await refreshInstalled(); renderSubtabs(); renderPane(); }
        else diMsg('Delete failed: ' + ((r && r.error) || ''), true);
      };
      const checkAll = async () => {
        await refreshInstalled();
        const withSrc = diInstalled.filter(a => a.source);
        if (!withSrc.length) return diMsg('No apps installed from a repository to check.');
        let upd = 0, done = 0;
        for (const a of withSrc) {
          diMsg('Checking for updates… (' + (++done) + '/' + withSrc.length + ')');
          const c = await configApi.checkDropInUpdate(a.id);
          if (!c || !c.ok) diStatus[a.id] = { state: 'err' };
          else if (c.updateAvailable) { diStatus[a.id] = { state: 'upd', from: c.installedVersion, to: c.remoteVersion }; upd++; }
          else diStatus[a.id] = { state: 'ok' };
        }
        diLastChecked = Date.now();
        if (diTab === 'installed') renderPane();
        diMsg(upd ? upd + ' update(s) available.' : 'All ' + withSrc.length + ' app(s) are up to date.');
      };
      const updateAll = async ids => {
        if (!ids.length) return;
        if (!ask('Update all ' + ids.length + ' app(s) now?')) return;
        let done = 0;
        for (const id of ids) { diMsg('Updating "' + id + '"…'); const r = await configApi.updateDropInApp(id, true); if (r && r.ok && r.updated) { done++; diStatus[id] = { state: 'ok' }; } }
        appDefs = await configApi.getApps(); diCatalog = null; await refreshInstalled(); renderPane();
        diMsg('Updated ' + done + ' of ' + ids.length + ' app(s).', done < ids.length);
      };

      // ---- sub-tab bar ----
      const renderSubtabs = () => {
        const host = document.getElementById('diSubbar'); if (!host) return;
        const btn = (key, label, badge) => `<button class="diSubtab${diTab === key ? ' on' : ''}" data-t="${key}">${label}${badge != null ? `<span class="diSubBadge">${badge}</span>` : ''}</button>`;
        host.innerHTML = btn('installed', 'Installed', diInstalled.length) + btn('discover', 'Discover') + btn('sources', 'Sources');
        host.querySelectorAll('.diSubtab').forEach(b => b.onclick = () => { diTab = b.dataset.t; diMsg(''); renderSubtabs(); renderPane(); });
      };
      const renderPane = () => {
        const pane = document.getElementById('diPane'); if (!pane) return;
        if (diTab === 'installed') return renderInstalledPane(pane);
        if (diTab === 'discover') return renderDiscoverPane(pane);
        return renderSourcesPane(pane);
      };

      // ---- Installed pane (also owns update checks) ----
      const renderInstalledPane = pane => {
        pane.innerHTML = `
          <div class="diToolbar">
            <div class="diSearch"><span class="diMag">\u{1F50D}</span><input id="diSearchI" placeholder="Search installed apps…"></div>
            <span id="diActiveFilters"></span>
            <span style="flex:1"></span>
            <div class="diFilterWrap"><button id="diFilterBtn">Filter</button><div id="diFmenu" class="diFmenu"></div></div>
            <span id="diChecked" class="hint" style="margin:0"></span>
            <button id="diCheckAll">Check for updates</button>
            <span id="diUpdateAllWrap"></span>
          </div>
          <div id="diCount" class="diCount"></div>
          <div id="diIList"></div>`;
        const se = document.getElementById('diSearchI'); se.value = diSearchI; se.oninput = () => { diSearchI = se.value; renderInstalledList(); };
        const ck = document.getElementById('diChecked'); if (ck && diLastChecked) ck.textContent = 'checked ' + fmtAgo(diLastChecked);
        document.getElementById('diFilterBtn').onclick = e => { e.stopPropagation(); document.getElementById('diFmenu').classList.toggle('open'); };
        document.getElementById('diFmenu').onclick = e => e.stopPropagation();
        document.getElementById('diCheckAll').onclick = () => checkAll();
        renderFilterMenu();
        renderInstalledList();
      };
      const renderFilterMenu = () => {
        const m = document.getElementById('diFmenu'); if (!m) return;
        const idxs = Array.from(new Set(diInstalled.map(a => repoIndexOf(a.source)).filter(i => i >= 0))).sort((a, b) => a - b);
        m.innerHTML = (idxs.length ? '<div class="diFh">Source</div>' + idxs.map(i => `<label><input type="checkbox" data-k="src" data-v="${i}" ${diFilterI.src.has(i) ? 'checked' : ''}> ${esc(nameOf(i))}</label>`).join('') : '')
          + '<div class="diFh">Status</div>'
          + `<label><input type="checkbox" data-k="st" data-v="ok" ${diFilterI.st.has('ok') ? 'checked' : ''}> Ready</label>`
          + `<label><input type="checkbox" data-k="st" data-v="upd" ${diFilterI.st.has('upd') ? 'checked' : ''}> Update available</label>`
          + `<label><input type="checkbox" data-k="st" data-v="err" ${diFilterI.st.has('err') ? 'checked' : ''}> Error</label>`;
        m.querySelectorAll('input').forEach(inp => inp.onchange = () => {
          if (inp.dataset.k === 'st') { const v = inp.dataset.v; if (inp.checked) diFilterI.st.add(v); else diFilterI.st.delete(v); }
          else { const val = +inp.dataset.v; if (inp.checked) diFilterI.src.add(val); else diFilterI.src.delete(val); }
          renderActiveChips(); renderInstalledList();
        });
        renderActiveChips();
      };
      const renderActiveChips = () => {
        const host = document.getElementById('diActiveFilters'); if (!host) return;
        const chips = [];
        diFilterI.src.forEach(i => chips.push({ k: 'src', v: i, label: nameOf(i) }));
        const ST_LABELS = { ok: 'Ready', upd: 'Update available', err: 'Error' };
        diFilterI.st.forEach(v => chips.push({ k: 'st', v, label: ST_LABELS[v] }));
        host.innerHTML = chips.map(c => `<span class="diFchip" data-k="${c.k}" data-v="${c.v}">${esc(c.label)}<span class="x">×</span></span>`).join('');
        host.querySelectorAll('.diFchip .x').forEach(x => x.onclick = e => { const c = e.currentTarget.parentElement; if (c.dataset.k === 'st') diFilterI.st.delete(c.dataset.v); else diFilterI.src.delete(+c.dataset.v); renderFilterMenu(); renderInstalledList(); });
      };
      const installedStatusHtml = a => {
        const s = diStatus[a.id];
        if (s && s.state === 'upd') return `<span class="diSt diUpd"><i class="diDot"></i>v${esc(s.from)} → v${esc(s.to)}</span><button class="diUp" data-id="${esc(a.id)}">Update</button>`;
        if (s && s.state === 'err') return '<span class="diSt" style="color:#c98"><i class="diDot" style="background:#8a5a2a"></i>Couldn’t check</span>';
        return '<span class="diSt diReady"><i class="diDot"></i>Ready</span>';
      };
      const renderInstalledList = () => {
        const host = document.getElementById('diIList'); if (!host) return;
        const q = diSearchI.trim().toLowerCase();
        const stateOf = a => (diStatus[a.id] && diStatus[a.id].state) || 'ok';
        const rows = diInstalled.filter(a => {
          const idx = repoIndexOf(a.source);
          if (diFilterI.src.size && !diFilterI.src.has(idx)) return false;
          if (diFilterI.st.size && !diFilterI.st.has(stateOf(a))) return false;
          if (q && !((a.name || '').toLowerCase().includes(q) || (a.id || '').toLowerCase().includes(q))) return false;
          return true;
        });
        // column sort (click a header to toggle)
        const cmpVer = (x, y) => { const pa = String(x || '').split('.').map(Number), pb = String(y || '').split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; };
        const stRank = { upd: 0, err: 1, ok: 2 };
        rows.sort((a, b) => {
          const dir = diSortI.dir;
          let d = 0;
          if (diSortI.col === 'version') d = cmpVer(a.version, b.version);
          else if (diSortI.col === 'source') d = nameOf(repoIndexOf(a.source)).localeCompare(nameOf(repoIndexOf(b.source)));
          else if (diSortI.col === 'status') d = stRank[stateOf(a)] - stRank[stateOf(b)];
          else d = String(a.name || '').localeCompare(String(b.name || ''));
          return d * dir || String(a.name || '').localeCompare(String(b.name || ''));
        });
        const updIds = diInstalled.filter(a => diStatus[a.id] && diStatus[a.id].state === 'upd').map(a => a.id);
        const uaw = document.getElementById('diUpdateAllWrap');
        if (uaw) { uaw.innerHTML = updIds.length ? `<button id="diUpdateAll" class="primary">${updIds.length} update${updIds.length === 1 ? '' : 's'} available — Update all</button>` : ''; const ua = document.getElementById('diUpdateAll'); if (ua) ua.onclick = () => updateAll(updIds); }
        const ckEl = document.getElementById('diChecked'); if (ckEl) ckEl.textContent = diLastChecked ? 'checked ' + fmtAgo(diLastChecked) : '';
        const cnt = document.getElementById('diCount');
        if (cnt) {
          let t = rows.length + ' app' + (rows.length === 1 ? '' : 's') + (rows.length !== diInstalled.length ? ' of ' + diInstalled.length : '');
          if (diLastChecked) t += ' · ' + (updIds.length ? updIds.length + ' update' + (updIds.length === 1 ? '' : 's') + ' available' : 'up to date') + ' · checked ' + fmtAgo(diLastChecked);
          cnt.textContent = t;
        }
        if (!diInstalled.length) { host.innerHTML = '<p class="hint">No drop-in apps installed yet — see the <b>Discover</b> tab.</p>'; return; }
        if (!rows.length) { host.innerHTML = '<p class="hint">No apps match.</p>'; return; }
        const sortTh = (col, label, w) => `<th style="width:${w}"><button class="diThSort" data-col="${col}">${label}${diSortI.col === col ? (diSortI.dir > 0 ? ' ▴' : ' ▾') : ''}</button></th>`;
        host.innerHTML = `<table class="diTbl"><thead><tr>
            ${sortTh('name', 'App', '40%')}${sortTh('version', 'Version', '84px')}${sortTh('source', 'Source', '150px')}${sortTh('status', 'Status', 'auto')}<th style="width:40px"></th>
          </tr></thead><tbody>` + rows.map(a => {
            const idx = repoIndexOf(a.source);
            const src = a.source ? `<span class="diSrcName${isPriv(idx) ? ' priv' : ''}" title="R${idx >= 0 ? idx : '?'}">${esc(nameOf(idx))}</span>` : '';
            const canReinstall = a.source && a.managed;
            const trusted = appTrusted(a.id);
            return `<tr>
              <td><div class="diAppName">${esc(a.name)}${trusted ? ' <span class="stbadge" title="Executable code from this app installs and updates without asking">trusted</span>' : ''}</div><div class="diAppMeta">${esc(metaOf(a))}</div></td>
              <td class="diVer">${a.version ? 'v' + esc(a.version) : ''}</td>
              <td>${src}</td>
              <td>${installedStatusHtml(a)}</td>
              <td class="diKebab"><button class="diKb" title="More actions" aria-label="More actions for ${esc(a.name)}" aria-haspopup="menu" data-id="${esc(a.id)}">⋯</button>
                <div class="diMenu">
                  <button class="diExport" data-id="${esc(a.id)}">Export…</button>
                  ${canReinstall ? `<button class="diReinstall" data-id="${esc(a.id)}">Reinstall</button>` : ''}
                  ${trusted ? `<button class="diUntrust" data-id="${esc(a.id)}">Ask again about executable code</button>` : ''}
                  <div class="diMSep"></div>
                  <button class="diDel${a.managed ? ' del' : ''}" data-id="${esc(a.id)}" ${a.managed ? '' : 'disabled'}>Delete</button>
                </div>
              </td></tr>`;
          }).join('') + '</tbody></table>';
        host.querySelectorAll('.diThSort').forEach(b => b.onclick = () => {
          const col = b.dataset.col;
          if (diSortI.col === col) diSortI.dir = -diSortI.dir; else { diSortI.col = col; diSortI.dir = 1; }
          renderInstalledList();
        });
        host.querySelectorAll('.diKb').forEach(b => b.onclick = e => { e.stopPropagation(); const menu = e.currentTarget.parentElement.querySelector('.diMenu'); const wasOpen = menu.classList.contains('open'); closeDiMenus(); if (!wasOpen) menu.classList.add('open'); });
        host.querySelectorAll('.diMenu').forEach(m => m.onclick = e => e.stopPropagation());
        host.querySelectorAll('.diUp').forEach(b => b.onclick = e => doUpdate(e.currentTarget.dataset.id));
        host.querySelectorAll('.diExport').forEach(b => b.onclick = e => { closeDiMenus(); doExport(e.currentTarget.dataset.id); });
        host.querySelectorAll('.diReinstall').forEach(b => b.onclick = e => { closeDiMenus(); doReinstall(e.currentTarget.dataset.id); });
        host.querySelectorAll('.diUntrust').forEach(b => b.onclick = e => { closeDiMenus(); setAppTrusted(e.currentTarget.dataset.id, false); renderInstalledList(); diMsg('"' + e.currentTarget.dataset.id + '" will ask again before installing executable code.'); });
        host.querySelectorAll('.diDel').forEach(b => b.onclick = e => { closeDiMenus(); doDelete(e.currentTarget.dataset.id); });
      };

      // ---- Discover pane ----
      const renderDiscoverPane = pane => {
        const showSrc = (multi ? repos.length : 1) > 1;   // hide the source filter when there's only one source
        pane.innerHTML = `
          <div class="diToolbar">
            <div class="diSearch"><span class="diMag">\u{1F50D}</span><input id="diSearchD" placeholder="Search apps…"></div>
            ${showSrc ? '<select id="diSrcSel"></select>' : ''}
            <label class="row" style="width:auto;gap:6px;margin:0;color:#91a4ba"><input type="checkbox" id="diHideInst" style="width:auto" ${diHideInstalled ? 'checked' : ''}> Hide installed apps</label>
            <span style="flex:1"></span>
            <span id="diDCount" class="hint" style="margin:0"></span>
          </div>
          <div id="diDList"><p class="hint">Loading apps from your repositories…</p></div>`;
        const se = document.getElementById('diSearchD'); se.value = diSearchD; se.oninput = () => { diSearchD = se.value; renderDiscoverList(); };
        document.getElementById('diHideInst').onchange = e => { diHideInstalled = e.target.checked; renderDiscoverList(); };
        renderSourceSelect();
        loadCatalog().then(() => { renderSourceSelect(); renderDiscoverList(); });
      };
      const renderSourceSelect = () => {
        const sel = document.getElementById('diSrcSel'); if (!sel) return;
        const shown = multi ? repos : repos.slice(0, 1);
        sel.innerHTML = '<option value="all">Source: All sources</option>' + shown.map((u, i) => `<option value="${i}" ${String(diSrcFilter) === String(i) ? 'selected' : ''}>${esc(nameOf(i))}</option>`).join('');
        sel.value = String(diSrcFilter);
        sel.onchange = () => { diSrcFilter = sel.value; renderDiscoverList(); };
      };
      const renderDiscoverList = () => {
        const host = document.getElementById('diDList'); if (!host) return;
        if (!diCatalog) { host.innerHTML = '<p class="hint">Loading…</p>'; return; }
        if (!diCatalog.length) { host.innerHTML = '<p class="hint">No apps found in your repositories — check the <b>Sources</b> tab.</p>'; return; }
        const installedIds = new Set(diInstalled.map(a => a.id));
        const q = diSearchD.trim().toLowerCase();
        let items = diCatalog.slice();
        if (diHideInstalled) items = items.filter(a => !installedIds.has(a.id));
        if (diSrcFilter !== 'all') items = items.filter(a => a.repoIndex === +diSrcFilter);
        if (q) items = items.filter(a => (a.name || '').toLowerCase().includes(q) || (a.id || '').toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q));
        const cntEl = document.getElementById('diDCount'); if (cntEl) cntEl.textContent = items.length + (diHideInstalled ? ' available' : ' app' + (items.length === 1 ? '' : 's'));
        if (!items.length) { host.innerHTML = '<p class="hint">No apps match.</p>'; return; }
        host.innerHTML = items.map(a => {
          const idx = a.repoIndex;
          const btn = a.state === 'installed' ? '<button disabled>Installed</button>'
            : a.state === 'update' ? `<button class="diRepoUpd" data-id="${esc(a.id)}">Update →</button>`
            : `<button class="primary diRepoInst" data-id="${esc(a.id)}" data-i="${idx}">Install</button>`;
          const letter = esc((a.name || a.id || '?').trim().charAt(0).toUpperCase());
          const meta = 'v' + esc(a.version) + ' · ' + esc(nameOf(idx));
          return `<div class="diCatRow"><div class="diTile">${letter}</div><div class="body"><div class="diCatNm">${esc(a.name)}</div>${a.description ? `<div class="diCatDs" title="${esc(a.description)}">${esc(a.description)}</div>` : ''}<div class="diCatMeta">${meta}</div></div>${btn}</div>`;
        }).join('');
        host.querySelectorAll('.diRepoInst').forEach(b => b.onclick = e => doInstall(e.currentTarget.dataset.id, false, repos[+e.currentTarget.dataset.i]));
        host.querySelectorAll('.diRepoUpd').forEach(b => b.onclick = e => doUpdate(e.currentTarget.dataset.id));
      };

      // ---- Sources pane ----
      const renderSrcRows = () => {
        const body = document.getElementById('diSrcBody'); if (!body) return;
        const shown = multi ? repos : repos.slice(0, 1);
        const removable = repos.length > 1;
        body.innerHTML = shown.map((u, i) => `<tr>
            <td><input class="diNameInput diRepoName" data-i="${i}" maxlength="40" value="${esc(repoNames[i] || '')}" placeholder="Name (required)"><span class="diIdMeta">R${i}</span><div class="diNameErr" id="diNameErr${i}"></div></td>
            <td><input class="diRepoUrl" data-i="${i}" value="${esc(u)}" placeholder="${esc(DEFAULT_APP_REPO)}"></td>
            <td><button class="diRepoRefresh" data-i="${i}">Refresh</button>
              <span class="diKebab" style="display:inline-block;position:relative;text-align:left"><button class="diKb" title="More">⋯</button>
                <div class="diMenu">
                  <button class="diBrowseSrc" data-i="${i}">Browse in Discover</button>
                  <div class="diMSep"></div>
                  <button class="diRemoveSrc del" data-i="${i}" ${removable ? '' : 'disabled'}>Remove source</button>
                </div></span></td>
          </tr>`).join('');
        body.querySelectorAll('.diRepoName').forEach(inp => inp.oninput = e => {
          const i = +e.target.dataset.i; const err = nameError(inp.value, i);
          const el = document.getElementById('diNameErr' + i); if (el) el.textContent = err;
          inp.style.borderColor = err ? '#a3354a' : '';
          if (!err) { repoNames[i] = inp.value.trim(); persistNames(); }
        });
        body.querySelectorAll('.diRepoUrl').forEach(inp => inp.oninput = e => { repos[+e.target.dataset.i] = e.target.value.trim(); persistRepos(); diCatalog = null; });
        body.querySelectorAll('.diRepoRefresh').forEach(b => b.onclick = async () => { diMsg('Refreshing sources…'); diCatalog = null; await loadCatalog(true); diMsg('Sources refreshed.'); });
        body.querySelectorAll('.diKb').forEach(b => b.onclick = e => { e.stopPropagation(); const menu = e.currentTarget.parentElement.querySelector('.diMenu'); const wasOpen = menu.classList.contains('open'); closeDiMenus(); if (!wasOpen) menu.classList.add('open'); });
        body.querySelectorAll('.diMenu').forEach(m => m.onclick = e => e.stopPropagation());
        body.querySelectorAll('.diBrowseSrc').forEach(b => b.onclick = e => { closeDiMenus(); diSrcFilter = e.currentTarget.dataset.i; diTab = 'discover'; renderSubtabs(); renderPane(); });
        body.querySelectorAll('.diRemoveSrc').forEach(b => b.onclick = e => { if (b.disabled) return; closeDiMenus(); const i = +e.currentTarget.dataset.i; repos.splice(i, 1); repoNames.splice(i, 1); persistRepos(); persistNames(); diCatalog = null; renderSrcRows(); });
      };
      const renderSourcesPane = pane => {
        pane.innerHTML = `
          <p class="hint" style="margin:0 0 12px;color:#c98">Drop-in apps can access your filesystem and saved open-quake credentials. Only add repositories you trust.</p>
          <table class="diSrcTable"><thead><tr><th style="width:200px">Name</th><th>Repository URL</th><th style="width:130px">Actions</th></tr></thead><tbody id="diSrcBody"></tbody></table>
          ${multi ? '<button id="diRepoAdd" style="margin-top:8px">+ Add source</button>' : ''}
          <p class="hint" style="margin-top:10px">A GitHub folder serving an <code>index.json</code> + app <code>.zip</code>s. Point it at your own fork to install from there.</p>
          <details class="advsec" style="margin-top:16px">
            <summary style="cursor:pointer;color:#9fb3c8;font-size:13px;user-select:none">Advanced settings</summary>
            <label class="row" style="gap:8px;align-items:center;width:auto;margin-top:10px"><input type="checkbox" id="diAutoPage" style="width:auto"> Add a page for newly installed apps</label>
            <label class="row" style="gap:8px;align-items:center;width:auto;margin-top:8px"><input type="checkbox" id="diMulti" style="width:auto"> Allow multiple drop-in app repositories</label>
            <div class="row" style="margin-top:12px"><label style="width:auto">Storage location</label>
              <select id="diLoc" style="width:auto">
                <option value="appdata">%APPDATA%\\open-quake</option>
                <option value="localappdata">%LOCALAPPDATA%\\open-quake</option>
              </select></div>
            <p class="hint" id="diLocPath" style="margin:2px 0 0"></p>
            <p class="hint">Where imported drop-in apps are stored — this folder survives app updates (the install folder doesn't).</p>
          </details>`;
        renderSrcRows();
        const add = document.getElementById('diRepoAdd'); if (add) add.onclick = () => { repos.push(''); repoNames.push(defaultRepoName('', repos.length - 1)); persistRepos(); persistNames(); renderSrcRows(); };
        { const ap = document.getElementById('diAutoPage'); if (ap) { ap.checked = !!appSettings().autoPageOnImport; ap.onchange = () => setS('autoPageOnImport', ap.checked); } }
        { const mb = document.getElementById('diMulti'); if (mb) { mb.checked = multi; mb.onchange = () => { multi = mb.checked; setS('multiRepo', multi); renderSrcRows(); }; } }
        configApi.getDropInInfo().then(info => { if (!info) return; const s2 = document.getElementById('diLoc'); if (s2) s2.value = info.location; const p = document.getElementById('diLocPath'); if (p) p.textContent = info.dir; });
        const loc = document.getElementById('diLoc'); if (loc) loc.onchange = async e => {
          const info = await configApi.setDropInLocation(e.target.value);
          if (!config.settings) config.settings = {}; config.settings.dropInLocation = e.target.value;   // keep the editor copy in sync so a full Save won't revert it
          const p = document.getElementById('diLocPath'); if (info && p) p.textContent = info.dir;
          await refreshInstalled(); renderSubtabs();
        };
      };

      refreshInstalled().then(() => { renderSubtabs(); renderPane(); });
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
        const f = document.getElementById('sHaFields'); if (f) f.style.display = e.target.checked ? '' : 'none';
        const pill = document.getElementById('sHaPill'); if (pill) { pill.textContent = e.target.checked ? 'Enabled' : 'Disabled'; pill.className = 'stpill ' + (e.target.checked ? 'ok' : 'off'); }
        if (!e.target.checked) { statusEl.textContent = 'Use HA is off. Save to clear the cache on next launch.'; statusEl.style.color = '#7e93ab'; }
        else statusEl.textContent = 'Click Refresh Configuration to load.';
      };
      refBtn.onclick = refresh;
      document.getElementById('sHaUrl').oninput = e => saveHa({ url: e.target.value.trim() });
      document.getElementById('sHaToken').oninput = e => saveHa({ token: e.target.value.trim() });
      configApi.getHaCache().then(showStatus);   // initial status from whatever main has cached

      // Open WebUI connection (shared: meeting Analysis AI + owui-voice panel app)
      const saveOwui = patch => {
        if (!config.settings) config.settings = {};
        const cur = (config.settings.owui && typeof config.settings.owui === 'object') ? config.settings.owui : { url: '', apiKey: '', model: '' };
        config.settings.owui = Object.assign({ url: '', apiKey: '', model: '' }, cur, patch);
        markDirty();
      };
      document.getElementById('sOwUrl').oninput = e => saveOwui({ url: e.target.value.trim() });
      document.getElementById('sOwKey').oninput = e => saveOwui({ apiKey: e.target.value.trim() });
      document.getElementById('sOwModel').oninput = e => saveOwui({ model: e.target.value.trim() });
      const owTest = document.getElementById('sOwTest');
      const owStatus = document.getElementById('sOwStatus');
      owTest.onclick = async () => {
        owTest.disabled = true;
        owStatus.textContent = dirty ? 'Saving, then testing…' : 'Testing…'; owStatus.style.color = '#7e93ab';
        try {
          // Same auto-save-first pattern as HA Refresh: main probes with its SAVED config.
          if (dirty && !await doSave()) throw new Error('settings were not saved securely');
          const r = await configApi.probeOwui();
          if (!(r && r.ok)) throw new Error((r && r.error) || 'connection failed');
          const list = r.models || [];
          owStatus.textContent = 'OK — ' + list.length + ' model(s)' + (list.length ? ': ' + list.slice(0, 6).join(', ') + (list.length > 6 ? ', …' : '') : '');
          owStatus.style.color = '#7e93ab';
        } catch (e2) { owStatus.textContent = 'Test failed: ' + (e2.message || e2); owStatus.style.color = '#c98'; }
        finally { owTest.disabled = false; }
      };

      // OBS Studio connection -> config.settings.obs; Test = auto-save-then-probe (same as owui).
      const saveObs = patch => {
        if (!config.settings) config.settings = {};
        const cur = (config.settings.obs && typeof config.settings.obs === 'object') ? config.settings.obs : {};
        config.settings.obs = Object.assign({ host: '127.0.0.1', port: '4455', password: '', enabled: false, autoReconnect: true }, cur, patch);
        markDirty();
      };
      const obsEnabled = document.getElementById('sObsEnabled');
      if (obsEnabled) {
        obsEnabled.checked = obs.enabled === true;
        obsEnabled.onchange = e => {
          saveObs({ enabled: e.target.checked });
          const f = document.getElementById('sObsFields'); if (f) f.style.display = e.target.checked ? '' : 'none';
          const pill = document.getElementById('sObsPill'); if (pill) { pill.textContent = e.target.checked ? 'Enabled' : 'Disabled'; pill.className = 'stpill ' + (e.target.checked ? 'ok' : 'off'); }
        };
      }
      const obsAuto = document.getElementById('sObsAuto');
      if (obsAuto) { obsAuto.checked = obs.autoReconnect !== false; obsAuto.onchange = e => saveObs({ autoReconnect: e.target.checked }); }
      const obsHost = document.getElementById('sObsHost'); if (obsHost) obsHost.oninput = e => saveObs({ host: e.target.value.trim() });
      const obsPort = document.getElementById('sObsPort'); if (obsPort) obsPort.oninput = e => saveObs({ port: e.target.value.trim() });
      const obsPass = document.getElementById('sObsPass'); if (obsPass) obsPass.oninput = e => saveObs({ password: e.target.value });
      const obsTest = document.getElementById('sObsTest');
      const obsStatus = document.getElementById('sObsStatus');
      if (obsTest) obsTest.onclick = async () => {
        obsTest.disabled = true;
        obsStatus.textContent = dirty ? 'Saving, then testing…' : 'Testing…'; obsStatus.style.color = '#7e93ab';
        try {
          if (dirty && !await doSave()) throw new Error('settings were not saved securely');
          const r = await configApi.probeObs();
          if (!(r && r.ok)) throw new Error((r && r.error) || 'connection failed');
          obsStatus.textContent = 'OK — OBS-WebSocket v' + (r.obsVersion || '?') + ', ' + (r.sceneCount || 0) + ' scene(s)';
          obsStatus.style.color = '#7e93ab';
        } catch (e2) { obsStatus.textContent = 'Test failed: ' + (e2.message || e2); obsStatus.style.color = '#c98'; }
        finally { obsTest.disabled = false; }
      };

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
        // Discord and GitHub own their authentication UI inside their built-in apps.
        providers = providers.filter(value => value.provider !== 'discord' && value.provider !== 'github');
        if (!providers.length) { host.innerHTML = '<p class="hint">No OAuth providers available.</p>'; return; }
        const authState = p => p.connected ? 'Connected, ' + fmtExpiry(p.expiresAt) : (p.configured ? 'Ready to connect' : 'Not configured');
        const identity = p => p.identity && (p.identity.global_name || p.identity.username)
          ? `<div class="row"><label>Account</label><span class="hint" style="margin:0">${esc(p.identity.global_name || p.identity.username)}${p.identity.username && p.identity.global_name ? ' (' + esc(p.identity.username) + ')' : ''}</span></div>` : '';
        host.innerHTML = providers.map(p => `
          <div class="advsec" style="margin-top:10px;padding:10px;border:1px solid #213145;border-radius:8px">
            <div class="row" style="gap:8px;align-items:center">
              <label style="width:auto;font-weight:bold">${esc(p.name || p.provider)}</label>
              <span class="hint" style="margin:0">${esc(authState(p))}</span>
              <span id="oauthMsg_${esc(p.provider)}" class="hint" style="margin:0 0 0 auto"></span>
            </div>
            ${p.managedClient ? '<div class="row"><label>Application</label><span class="hint" style="margin:0">Built into Open-Quake</span></div>' : ''}
            ${identity(p)}
            <div class="row"><label>Scopes</label><span class="hint" style="margin:0">${esc((p.scopes || []).join(' '))}</span></div>
            <div class="row" style="gap:8px">
              <button class="oauthConnect" data-provider="${esc(p.provider)}" ${p.enabled ? '' : 'disabled'}>${p.connected ? 'Reconnect' : 'Connect'}</button>
              <button class="oauthDisconnect" data-provider="${esc(p.provider)}" ${p.connected && p.enabled ? '' : 'disabled'}>Disconnect</button>
              ${p.enabled ? '' : '<span class="hint" style="margin:0">Framework placeholder</span>'}
            </div>
          </div>`).join('');
        host.querySelectorAll('.oauthConnect').forEach(btn => {
          btn.onclick = async e => {
            const id = e.currentTarget.dataset.provider;
            e.currentTarget.disabled = true;
            oauthMsg(id, 'Opening browser...');
            const provider = providers.find(value => value.provider === id);
            const requestedScopes = provider && provider.scopes || [];
            const r = await configApi.connectOAuthProvider(id, requestedScopes);
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
            if (!ask('Disconnect ' + id + ' and remove stored OAuth tokens?')) return;
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
      const runModeVal = (s.runMode === 'software' || s.runMode === 'monitor') ? s.runMode : 'panel';
      const runSel = document.getElementById('sRunMode');
      if (runSel) { runSel.value = runModeVal; runSel.onchange = e => { setS('runMode', e.target.value); const d = document.getElementById('sSwDeps'); if (d) d.style.display = e.target.value === 'software' ? '' : 'none'; }; }
      const runSetupBtn = document.getElementById('sRunSetup');
      if (runSetupBtn) runSetupBtn.onclick = () => { try { configApi.openWelcome(); } catch (e) {} };
      // Software window: pages (default) vs stacked panes. Which pane shows is runtime state (the
      // window's ☰ selector), not a setting — mirrors how the active page works.
      const swDisp = document.getElementById('sSwDisplay');
      if (swDisp) {
        swDisp.value = s.softwareDisplay === 'pane' ? 'pane' : 'pages';
        swDisp.onchange = e => setS('softwareDisplay', e.target.value);
      }
      document.getElementById('sLaunch').value = s.launchMode;
      document.getElementById('sLaunch').onchange = e => setS('launchMode', e.target.value);
      const offIcons = document.getElementById('sOfflineIcons');
      if (offIcons) { offIcons.checked = !!s.offlineIcons; offIcons.onchange = e => setS('offlineIcons', e.target.checked); }
      const saveRot = r => { if (!config.settings) config.settings = {}; config.settings.rotation = r; markDirty(); };
      const rotKey = document.getElementById('sRotKey'), rotKeyClr = document.getElementById('sRotKeyClear');
      document.getElementById('sRot').checked = !!rot.enabled;
      document.getElementById('sRotG').checked = !!rot.cats.grids;
      document.getElementById('sRotD').checked = !!rot.cats.dashboards;
      document.getElementById('sRotA').checked = !!rot.cats.apps;
      // The hotkey only registers while auto-rotate is on (main.js applyShortcuts), so grey it out with the
      // toggle — same pattern as "Pause auto-rotation" under Desktop focus below.
      document.getElementById('sRot').onchange = e => { const r = currentRot(); r.enabled = e.target.checked; saveRot(r); const deps = document.getElementById('sRotDeps'); if (deps) deps.style.display = e.target.checked ? '' : 'none'; };
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

      const savePageStep = ps => { if (!config.settings) config.settings = {}; config.settings.pageStep = ps; markDirty(); };
      const pnKey = document.getElementById('sPageNextKey'), pnKeyClr = document.getElementById('sPageNextKeyClear');
      pnKey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { const ps = currentPageStep(); ps.nextHotkey = acc; pnKey.value = acc; savePageStep(ps); } };
      pnKeyClr.onclick = () => { const ps = currentPageStep(); delete ps.nextHotkey; pnKey.value = ''; savePageStep(ps); };
      const ppKey = document.getElementById('sPagePrevKey'), ppKeyClr = document.getElementById('sPagePrevKeyClear');
      ppKey.onkeydown = e => { e.preventDefault(); const acc = accelFromEvent(e); if (acc) { const ps = currentPageStep(); ps.prevHotkey = acc; ppKey.value = acc; savePageStep(ps); } };
      ppKeyClr.onclick = () => { const ps = currentPageStep(); delete ps.prevHotkey; ppKey.value = ''; savePageStep(ps); };

      // Conflict warnings beside each shortcut field — refreshed on render and after every change.
      const SW_HOTKEY_OWNERS = [['sRotKey', 'rotation start/pause'], ['sPageNextKey', 'Page forward'], ['sPagePrevKey', 'Page back'], ['sDashReloadKey', 'Reload dashboard']];
      const refreshAllWarns = () => SW_HOTKEY_OWNERS.forEach(([id, own]) => refreshHotkeyWarn(id, own));
      refreshAllWarns();
      [[rotKey, rotKeyClr], [pnKey, pnKeyClr], [ppKey, ppKeyClr], [dashReloadKey, dashReloadKeyClr]].forEach(([inp, clr]) => {
        const kd = inp.onkeydown, ck = clr.onclick;
        inp.onkeydown = e => { kd(e); refreshAllWarns(); };
        clr.onclick = () => { ck(); refreshAllWarns(); };
      });

    } else if (tab === 'hardware') {
      const keepAwake = document.getElementById('sKeepAwake');
      if (keepAwake) keepAwake.onchange = e => setS('keepDisplayAwake', e.target.checked);
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
        if (!ask('Clear touch calibration on every display? You\'ll need to run Set up touchscreen after.')) return;
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
      const pct = v => Math.round((parseInt(v, 10) || 0) / 255 * 100) + '%';
      const bv = document.getElementById('sBrightVal');
      document.getElementById('sBright').oninput = e => { bv.textContent = pct(e.target.value); };
      document.getElementById('sBright').onchange = e => live({ brightness: parseInt(e.target.value, 10) });
      const sv = document.getElementById('sSpeedVal');
      document.getElementById('sSpeed').oninput = e => { sv.textContent = pct(e.target.value); };
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
      const knobResetBtn = document.getElementById('sKnobReset');
      if (knobResetBtn) knobResetBtn.onclick = () => {
        if (!ask('Reset every knob turn/press/double-press mapping to the defaults?')) return;
        if (config.settings) delete config.settings.knob;
        markDirty(); renderSettings();
      };
    } else if (tab === 'monitor') {
      // Monitor mode — knob turn/press behavior (applied by the main process while in monitor mode)
      document.getElementById('sReserved').onchange = e => setS('reservedDisplay', e.target.checked);
      // Live state pill + direct enter action (enter-only; exit stays on the tray)
      const monPill = document.getElementById('sMonPill'), monBtn = document.getElementById('sMonEnter'), monMsg = document.getElementById('sMonEnterMsg');
      const refreshMonState = async () => {
        let st = null;
        try { st = await configApi.getMonitorState(); } catch (e) {}
        if (!monPill || !st) { if (monPill) { monPill.textContent = 'state unknown'; } return; }
        monPill.textContent = st.active ? 'Active' : 'Not active';
        monPill.className = 'stpill ' + (st.active ? 'ok' : 'off');
        if (monBtn) {
          monBtn.disabled = st.active || !st.hasPanel;
          if (monMsg) monMsg.textContent = st.active ? 'Exit from the tray menu.' : (st.hasPanel ? '' : 'Needs the device display (Panel/Monitor run mode).');
        }
      };
      refreshMonState();
      if (monBtn) monBtn.onclick = async () => {
        monBtn.disabled = true;
        let r = null;
        try { r = await configApi.enterMonitorMode(); } catch (e) {}
        if (!(r && r.ok) && monMsg) monMsg.textContent = (r && r.error) || 'Could not enter Monitor mode.';
        refreshMonState();
      };
      const saveMon = patch => { if (!config.settings) config.settings = {}; config.settings.monitor = Object.assign(currentMon(), patch); markDirty(); };
      document.getElementById('sMonTurn').value = mon.knobTurn;
      document.getElementById('sMonTap').value = mon.knobTap;
      document.getElementById('sMonTurn').onchange = e => saveMon({ knobTurn: e.target.value });
      document.getElementById('sMonTap').onchange = e => saveMon({ knobTap: e.target.value });
    } else if (tab === 'ttsstt') {
      const saveVoice = (k, v) => { if (!config.settings) config.settings = {}; if (!config.settings.voice) config.settings.voice = {}; config.settings.voice[k] = v; markDirty(); };
      document.getElementById('ttsSttHost').oninput = e => saveVoice('sttHost', e.target.value.trim());
      document.getElementById('ttsSttPort').oninput = e => saveVoice('sttPort', e.target.value.trim());
      document.getElementById('ttsTtsHost').oninput = e => saveVoice('ttsHost', e.target.value.trim());
      document.getElementById('ttsTtsPort').oninput = e => saveVoice('ttsPort', e.target.value.trim());
      const helper = document.getElementById('ttsHelperLink');
      if (helper) helper.onclick = e => { e.preventDefault(); configApi.openExternal('https://github.com/TeeJS/tts-stt-windows/releases'); };
    } else if (tab === 'meeting') {
      const saveMe = patch => { if (!config.settings) config.settings = {}; config.settings.meeting = Object.assign(currentMe(), patch); markDirty(); };
      document.getElementById('meFolder').oninput = e => saveMe({ folder: e.target.value.trim() });
      document.getElementById('meFolderBrowse').onclick = async () => {
        const p = await configApi.pickFolder();
        if (p) { document.getElementById('meFolder').value = p; saveMe({ folder: p }); }
      };
      document.getElementById('meProcessed').oninput = e => saveMe({ processedFolder: e.target.value.trim() });
      document.getElementById('meProcessedBrowse').onclick = async () => {
        const p = await configApi.pickFolder();
        if (p) { document.getElementById('meProcessed').value = p; saveMe({ processedFolder: p }); }
      };
      document.getElementById('meByDate').onchange = e => saveMe({ processedByDate: e.target.checked });
      document.getElementById('meLargeRec').onchange = e => saveMe({ largeRecordButton: e.target.checked });
      document.getElementById('meEditPrompt').onclick = () => configApi.editMeetingAnalysisPrompt();
      document.getElementById('meOutlook').onchange = e => {
        saveMe({ outlookEnabled: e.target.checked });
        document.getElementById('meAppendName').disabled = !e.target.checked;   // name-append needs calendar info
      };
      const syncMeetingSource = () => {
        const graph = document.getElementById('meInfoSource').value === 'microsoft365';
        document.getElementById('meClassicSettings').style.display = graph ? 'none' : '';
      };
      document.getElementById('meInfoSource').onchange = e => { saveMe({ meetingInfoSource: e.target.value }); syncMeetingSource(); };
      syncMeetingSource();
      document.getElementById('meSepRec').onchange = e => saveMe({ separateRecurring: e.target.checked });
      document.getElementById('meAppendName').onchange = e => saveMe({ appendMeetingName: e.target.checked });
      document.getElementById('meSepTx').onchange = e => saveMe({ separateTranscript: e.target.checked });
      document.getElementById('meDetails').onchange = e => saveMe({ useDetailsFolder: e.target.checked });
      document.getElementById('meOutAcct').onchange = e => saveMe({ outlookAccount: e.target.value });
      document.getElementById('meOutCal').oninput = e => saveMe({ outlookCalendar: e.target.value.trim() });
      document.getElementById('meOutSkip').oninput = e => saveMe({ outlookSkipPrefixes: e.target.value });
      document.getElementById('meThreshold').onchange = e => saveMe({ transcribeThreshold: e.target.value.trim() });
      document.getElementById('meMyName').oninput = e => saveMe({ myName: e.target.value.trim() });
      document.getElementById('meTaskList').onchange = e => saveMe({ taskListEnabled: e.target.checked });
      document.getElementById('meTaskFolder').oninput = e => saveMe({ taskListFolder: e.target.value.trim() });
      document.getElementById('meTaskFolderBrowse').onclick = async () => {
        const p = await configApi.pickFolder();
        if (p) { document.getElementById('meTaskFolder').value = p; saveMe({ taskListFolder: p }); }
      };
      document.getElementById('meJoplin').onchange = e => saveMe({ joplinEnabled: e.target.checked });
      document.getElementById('meJoplinUrl').oninput = e => saveMe({ joplinUrl: e.target.value.trim() });
      document.getElementById('meJoplinToken').oninput = e => saveMe({ joplinToken: e.target.value.trim() });
      document.getElementById('meJoplinNb').oninput = e => saveMe({ joplinNotebook: e.target.value.trim() });
      document.getElementById('meHooks').onchange = e => saveMe({ transcribeHooksEnabled: e.target.checked });
      document.getElementById('meHookPre').oninput = e => saveMe({ preTranscribeCmd: e.target.value });
      document.getElementById('meHookPost').oninput = e => saveMe({ postTranscribeCmd: e.target.value });
      document.getElementById('meHighlight').onchange = e => saveMe({ highlightEnabled: e.target.checked });
      // ---- Meeting Slide Capture ----
      const slideCfgBox = document.querySelector('.slidecfg');
      const syncSlideEnabled = on => { if (slideCfgBox) slideCfgBox.style.display = on ? '' : 'none'; };
      syncSlideEnabled(document.getElementById('meSlide').checked);
      document.getElementById('meSlide').onchange = e => { saveMe({ slideCaptureEnabled: e.target.checked }); syncSlideEnabled(e.target.checked); };
      document.getElementById('meSlideAuto').onchange = e => saveMe({ slideAutoStartOnSelect: e.target.checked });
      document.getElementById('meSlideNotify').onchange = e => saveMe({ slideNotifications: e.target.checked });
      // "Limit window picker to app": mirrors the original Slide Capture app's combo exactly —
      // "(All apps)" + distinct process NAMES (never window titles; you pick the APP here, the
      // panel picker is where you pick the window). Selection persists visibly in the dropdown.
      const slideFilterPick = document.getElementById('meSlideFilterPick');
      window.openQuakeConfig.listRunningApps().then(apps => {
        const cur = currentMe().slideAppFilter || '';
        const names = (apps || []).map(a => a.processName).filter(Boolean);
        if (cur && !names.some(n => n.toLowerCase() === cur.toLowerCase())) names.push(cur);   // saved app not running — keep it selectable
        names.sort((a, b) => a.localeCompare(b));
        for (const n of names) {
          const opt = document.createElement('option');
          opt.value = n; opt.textContent = n;
          slideFilterPick.appendChild(opt);
        }
        slideFilterPick.value = names.includes(cur) ? cur : '';
      });
      slideFilterPick.onchange = () => saveMe({ slideAppFilter: slideFilterPick.value });
      document.getElementById('meSlideIdle').onchange = e => saveMe({ slideIdleStopMin: Math.max(0, Math.min(600, parseInt(e.target.value, 10) || 0)) });
      // Hotkeys: each (if set) must include Ctrl and/or Alt, and the three must be distinct. A bad
      // combo isn't saved — the field reverts and the reason shows — so we never register junk.
      const slideHk = { toggle: 'meSlideHkToggle', select: 'meSlideHkSelect', manual: 'meSlideHkManual' };
      const slideHkKey = { toggle: 'slideHotkeyToggle', select: 'slideHotkeySelect', manual: 'slideHotkeyManual' };
      const normHk = s => String(s || '').trim().split('+').map(p => p.trim()).filter(Boolean).map(p => p.toLowerCase()).sort().join('+');
      function validateSlideHotkey(which) {
        const warn = document.getElementById('meSlideHkWarn');
        const el = document.getElementById(slideHk[which]);
        const val = el.value.trim();
        if (val && !/(ctrl|alt)/i.test(val)) { warn.textContent = 'Hotkeys must include Ctrl and/or Alt.'; el.value = currentMe()[slideHkKey[which]]; return; }
        const others = Object.keys(slideHk).filter(k => k !== which).map(k => normHk(document.getElementById(slideHk[k]).value));
        if (val && others.includes(normHk(val))) { warn.textContent = 'Each hotkey must be different.'; el.value = currentMe()[slideHkKey[which]]; return; }
        warn.textContent = '';
        saveMe({ [slideHkKey[which]]: val });
      }
      Object.keys(slideHk).forEach(which => { document.getElementById(slideHk[which]).onchange = () => validateSlideHotkey(which); });
      document.getElementById('meOutCheck').onclick = async () => {
        const msg = document.getElementById('meOutMsg');
        const source = document.getElementById('meInfoSource').value;
        msg.textContent = source === 'microsoft365' ? 'Checking Microsoft 365…' : 'Checking — classic Outlook must be running…'; msg.style.color = '';
        const r = await configApi.checkOutlookMeetings(source);
        if (!r || !r.ok) {
          msg.textContent = (r && r.error) || 'Check failed'; msg.style.color = '#c98';
          if (source === 'microsoft365' && r && (r.code === 'not_connected' || r.code === 'consent_required')) {
            msg.textContent = 'Open the installed Microsoft 365 app and choose Connect, then click Check Connection again.';
          }
          return;
        }
        if (source === 'microsoft365') {
          const profile = r.profile || {};
          msg.textContent = 'Connected as ' + (profile.displayName || profile.userPrincipalName || 'Microsoft 365 user') + '. Save to use this calendar.';
          return;
        }
        const sel = document.getElementById('meOutAcct');
        const saved = currentMe().outlookAccount;
        sel.innerHTML = '<option value="">— choose an account —</option>';
        (r.accounts || []).forEach(a => {
          const o = document.createElement('option');
          o.value = a.name; o.textContent = a.name + (a.calendars.length ? '' : ' (no calendar folder!)');
          sel.appendChild(o);
        });
        if (saved && !(r.accounts || []).some(a => a.name === saved)) {
          const o = document.createElement('option'); o.value = saved; o.textContent = saved + ' (not found)'; sel.appendChild(o);
        }
        sel.value = saved || '';
        const acct = (r.accounts || []).find(a => a.name === sel.value);
        const cal = currentMe().outlookCalendar || 'Calendar';
        if (acct && !acct.calendars.some(c => c.toLowerCase() === cal.toLowerCase())) {
          msg.textContent = 'Connected — ' + r.accounts.length + ' account(s). Warning: "' + cal + '" folder not found in ' + acct.name + ' (has: ' + acct.calendars.join(', ') + ')';
          msg.style.color = '#c98';
        } else {
          msg.textContent = 'Connected — ' + r.accounts.length + ' account(s) found. Pick yours, then Save.';
          msg.style.color = '';
        }
      };
      document.getElementById('meTransUrl').oninput = e => saveMe({ transcribeUrl: e.target.value.trim() });
      document.getElementById('meAnalysisAi').onchange = e => saveMe({ analysisAi: e.target.value });
      // --- Busy status ---
      const busyDeps = document.getElementById('meBusyDeps');
      const syncBusyEnabled = on => { if (busyDeps) busyDeps.style.display = on ? '' : 'none'; };
      document.getElementById('meBusy').onchange = e => { saveMe({ busyEnabled: e.target.checked }); syncBusyEnabled(e.target.checked); };
      document.getElementById('meBusyApps').oninput = e => saveMe({ busyApps: e.target.value });
      document.getElementById('meBusyRec').onchange = e => saveMe({ busyOnRecording: e.target.checked });
      document.getElementById('meBusyDelay').oninput = e => saveMe({ busyOffDelaySec: Math.max(0, parseInt(e.target.value, 10) || 0) });
      document.getElementById('meBusyLight').onchange = e => saveMe({ busyLightEnabled: e.target.checked });
      document.getElementById('meBusyColor').oninput = e => saveMe({ busyLightBusyColor: e.target.value });
      document.getElementById('meFreeColor').oninput = e => saveMe({ busyLightFreeColor: e.target.value });
      document.getElementById('meFreeOff').onchange = e => saveMe({ busyLightFreeOff: e.target.checked });
      document.getElementById('meManualColor').oninput = e => saveMe({ busyManualColor: e.target.value });

      // --- Busylight schedule ---
      // Re-rendering the whole tab on every change would steal focus mid-edit, so the per-day rows
      // are rebuilt in place from the current day set instead.
      const schedDeps = document.getElementById('meSchedDeps');
      const schedShared = document.getElementById('meSchedShared');
      const schedRows = document.getElementById('meSchedPerDayRows');
      const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      const readSchedDays = () => Array.from(document.querySelectorAll('#meSchedDays input[data-day]'))
        .filter(c => c.checked).map(c => Number(c.dataset.day)).sort((a, b) => a - b);

      const readSchedTimes = () => {
        const out = {};
        document.querySelectorAll('#meSchedPerDayRows input[data-daystart]').forEach(inp => {
          const d = inp.dataset.daystart;
          const end = document.querySelector('#meSchedPerDayRows input[data-dayend="' + d + '"]');
          out[d] = { s: inp.value, e: end ? end.value : '' };
        });
        return out;
      };

      const renderSchedSummary = () => {
        const el = document.getElementById('meSchedSummary'); if (!el) return;
        const m = currentMe();
        if (!m.busySchedEnabled) { el.textContent = ''; return; }
        const days = readSchedDays();
        if (!days.length) { el.textContent = 'No days selected — the light will never come on.'; return; }
        const names = days.map(d => DAY_LABELS[d]).join(', ');
        if (m.busySchedPerDay) { el.textContent = names + ', with hours set per day.'; return; }
        const overnight = m.busySchedEnd <= m.busySchedStart ? ' (runs overnight)' : '';
        el.textContent = names + ', ' + m.busySchedStart + ' to ' + m.busySchedEnd + overnight + '.';
      };

      const renderPerDayRows = () => {
        if (!schedRows) return;
        const m = currentMe();
        const times = m.busySchedTimes || {};
        schedRows.innerHTML = readSchedDays().map(i =>
          '<div class="row"><label>' + DAY_LABELS[i] + '</label>'
          + '<input type="time" data-daystart="' + i + '" value="' + esc((times[i] || {}).s || m.busySchedStart) + '" style="width:130px">'
          + '<label style="width:auto;margin-left:16px">to</label>'
          + '<input type="time" data-dayend="' + i + '" value="' + esc((times[i] || {}).e || m.busySchedEnd) + '" style="width:130px"></div>').join('');
        schedRows.querySelectorAll('input[type=time]').forEach(inp => {
          inp.oninput = () => { saveMe({ busySchedTimes: readSchedTimes() }); };
        });
      };

      document.getElementById('meSched').onchange = e => {
        saveMe({ busySchedEnabled: e.target.checked });
        if (schedDeps) schedDeps.style.display = e.target.checked ? '' : 'none';
        renderSchedSummary();
      };
      document.querySelectorAll('#meSchedDays input[data-day]').forEach(cb => {
        cb.onchange = () => {
          saveMe({ busySchedDays: readSchedDays().join(',') });
          renderPerDayRows();          // a newly ticked day needs its own time row
          saveMe({ busySchedTimes: readSchedTimes() });
          renderSchedSummary();
        };
      });
      document.getElementById('meSchedPerDay').onchange = e => {
        saveMe({ busySchedPerDay: e.target.checked });
        if (schedShared) schedShared.style.display = e.target.checked ? 'none' : '';
        if (schedRows) schedRows.style.display = e.target.checked ? '' : 'none';
        if (e.target.checked) { renderPerDayRows(); saveMe({ busySchedTimes: readSchedTimes() }); }
        renderSchedSummary();
      };
      document.getElementById('meSchedStart').oninput = e => { saveMe({ busySchedStart: e.target.value }); renderSchedSummary(); };
      document.getElementById('meSchedEnd').oninput = e => { saveMe({ busySchedEnd: e.target.value }); renderSchedSummary(); };
      renderPerDayRows();
      renderSchedSummary();
      document.getElementById('meBusyBright').oninput = e => saveMe({ busyLightBrightness: Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 100)) });
      document.getElementById('meWled').onchange = e => saveMe({ busyWledEnabled: e.target.checked });
      document.getElementById('meWledHost').oninput = e => saveMe({ busyWledHost: e.target.value });
      document.getElementById('meMqtt').onchange = e => saveMe({ busyMqttEnabled: e.target.checked });
      document.getElementById('meMqttUrl').oninput = e => saveMe({ busyMqttUrl: e.target.value });
      document.getElementById('meMqttUser').oninput = e => saveMe({ busyMqttUser: e.target.value });
      document.getElementById('meMqttPass').oninput = e => saveMe({ busyMqttPassword: e.target.value });
      document.getElementById('meMqttTopic').oninput = e => saveMe({ busyMqttBaseTopic: e.target.value });

      // Test buttons drive one output directly. They save first, because testing a value the user has
      // typed but not saved would silently test the OLD value and report a misleading result.
      const busyTest = (target, btnId, outId) => {
        const btn = document.getElementById(btnId); if (!btn) return;
        btn.onclick = async () => {
          const out = document.getElementById(outId);
          btn.disabled = true; if (out) out.textContent = 'Testing…';
          try {
            if (!await doSave()) { if (out) out.textContent = 'Save failed — not tested'; return; }
            const r = await configApi.busyTest(target);
            if (out) out.textContent = r && r.ok ? 'OK' : ('Failed: ' + ((r && (r.error || r.status)) || 'no response'));
          } catch (err) { if (out) out.textContent = 'Failed: ' + (err && err.message ? err.message : String(err)); }
          finally { btn.disabled = false; }
        };
      };
      busyTest('light', 'meBusyTestLight', 'meBusyTestLightResult');
      busyTest('wled', 'meBusyTestWled', 'meBusyTestWledResult');
      busyTest('mqtt', 'meBusyTestMqtt', 'meBusyTestMqttResult');

      // Live status lines, so the page says what it can actually see rather than only what is typed.
      (async () => {
        try {
          const st = await configApi.busyStatus();
          const light = document.getElementById('meBusyLightStatus');
          if (light) {
            const l = st && st.outputs && st.outputs.light;
            light.textContent = l && l.connected ? ('Connected — ' + (l.product || 'Busylight'))
              : (l && l.error ? l.error : 'Not detected');
          }
          const mq = document.getElementById('meMqttStatus');
          if (mq) {
            const m = st && st.outputs && st.outputs.mqtt;
            mq.textContent = !m || !m.enabled ? 'Not configured'
              : (m.connected ? 'Connected' : (m.error ? 'Error: ' + m.error : 'Connecting…'));
          }
        } catch (e) {}
      })();

      document.getElementById('meAuto').onchange = e => { saveMe({ autoRecord: e.target.checked }); const deps = document.getElementById('meAutoDeps'); if (deps) deps.style.display = e.target.checked ? '' : 'none'; };
      document.getElementById('meApps').oninput = e => saveMe({ recordApps: e.target.value });
      document.getElementById('meSilence').onchange = e => saveMe({ silenceStopMin: Math.max(0, parseInt(e.target.value, 10) || 0) });
      document.getElementById('meEcho').onchange = e => saveMe({ echoGate: e.target.checked });
      // Populate the mic dropdown with device LABELS (persisted, not deviceIds). Labels are only
      // visible after a getUserMedia grant, so enumerate first and momentarily grab the mic if the
      // labels come back blank — same lazy-enumeration trick as the panel's picker.
      (function () {
        const sel = document.getElementById('meMic');
        const cur = me.micDevice || '';
        const fill = devs => {
          const inputs = (devs || []).filter(d => d.kind === 'audioinput' && d.label);
          sel.innerHTML = '<option value="">System default</option>';
          inputs.forEach(d => { const o = document.createElement('option'); o.value = d.label; o.textContent = d.label; sel.appendChild(o); });
          if (cur && !inputs.some(d => d.label === cur)) { const o = document.createElement('option'); o.value = cur; o.textContent = cur + ' (not connected)'; sel.appendChild(o); }
          sel.value = cur;
          sel.onchange = e => saveMe({ micDevice: e.target.value });
        };
        navigator.mediaDevices.enumerateDevices().then(devs => {
          if ((devs || []).some(d => d.kind === 'audioinput' && d.label)) return fill(devs);
          navigator.mediaDevices.getUserMedia({ audio: true })
            .then(tmp => navigator.mediaDevices.enumerateDevices().then(d2 => { tmp.getTracks().forEach(t => t.stop()); fill(d2); }))
            .catch(() => fill(devs));
        }).catch(() => fill([]));
      })();
    } else {
      // Theme — global appearance + accent (applied on Save, via the main process)
      const DEFAULT_ACCENT = '#7CFFB2';
      const saveTheme = patch => { if (!config.settings) config.settings = {}; config.settings.theme = Object.assign(currentTheme(), patch); markDirty(); };
      const col = document.getElementById('sAccent'), hexIn = document.getElementById('sAccentHex');
      const validHex = v => /^#[0-9a-fA-F]{6}$/.test(v);
      // Live preview: sample tiles (one selected), clock digits, and a primary button in the accent.
      const renderPreview = () => {
        const t = currentTheme();
        const dark = t.appearance !== 'light';   // 'system' previews dark, matching the editor
        const bg = dark ? '#0a111a' : '#eef2f7', tile = dark ? '#141d29' : '#ffffff',
          bd = dark ? '#233246' : '#c8d4e0', txt = dark ? '#91a4ba' : '#4a5a6a';
        const el = document.getElementById('thPreview');
        if (el) el.innerHTML = `<div class="thprev" style="background:${bg}; border-color:${bd}">
          <div class="thtile" style="background:${tile}; border-color:${bd}"><span style="font-size:20px">🏠</span><span style="color:${txt}">Lights</span></div>
          <div class="thtile" style="background:${tile}; border-color:${t.accent}; box-shadow:0 0 0 2px ${t.accent}55"><span style="font-size:20px">🎵</span><span style="color:${txt}">Music</span></div>
          <div class="thclock" style="color:${t.accent}">12:34</div>
          <button style="background:${t.accent}; border-color:${t.accent}; color:#08131f">Play</button>
        </div>`;
      };
      const setAccent = v => { col.value = v; hexIn.value = v; saveTheme({ accent: v }); renderPresets(); renderPreview(); };
      document.getElementById('sAppear').value = th.appearance;
      document.getElementById('sAppear').onchange = e => { saveTheme({ appearance: e.target.value }); renderPreview(); };
      col.oninput = e => { hexIn.value = e.target.value; };
      col.onchange = e => setAccent(e.target.value);
      hexIn.onchange = e => { const v = e.target.value.trim(); if (validHex(v)) setAccent(v); else e.target.value = currentTheme().accent; };
      document.getElementById('sAccentReset').onclick = () => setAccent(DEFAULT_ACCENT);
      function renderPresets() {
        const wrap = document.getElementById('sPresets'); wrap.innerHTML = '';
        const cur = String(currentTheme().accent || '').toLowerCase();
        (currentTheme().presets || []).forEach((p, i) => {
          const w = document.createElement('span'); w.className = 'presetwrap';
          const b = document.createElement('button');
          b.className = 'pc' + (String(p).toLowerCase() === cur ? ' on' : '');
          b.title = p + (String(p).toLowerCase() === cur ? ' (current accent)' : '');
          b.setAttribute('aria-label', 'Use preset ' + p);
          b.style.cssText = 'width:26px;height:26px;padding:0;border-radius:6px;border:1px solid #2b3c50;background:' + p;
          b.onclick = () => setAccent(p);
          const x = document.createElement('button'); x.className = 'px'; x.textContent = '✕';
          x.title = 'Remove preset'; x.setAttribute('aria-label', 'Remove preset ' + p);
          x.onclick = ev => { ev.stopPropagation(); const pr = (currentTheme().presets || []).slice(); pr.splice(i, 1); saveTheme({ presets: pr }); renderPresets(); };
          w.appendChild(b); w.appendChild(x); wrap.appendChild(w);
        });
      }
      renderPresets();
      renderPreview();
      document.getElementById('sPresetSave').onclick = () => {
        const cur = col.value;
        let pr = (currentTheme().presets || []).slice();
        if (!pr.some(x => String(x).toLowerCase() === cur.toLowerCase())) { pr.push(cur); if (pr.length > 6) pr = pr.slice(pr.length - 6); }
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
  const addPageMenu = document.getElementById('addPageMenu');
  document.getElementById('addPageMenuBtn').onclick = e => { e.stopPropagation(); addPageMenu.classList.toggle('open'); };
  document.addEventListener('click', e => { if (!e.target.closest('.addwrap')) addPageMenu.classList.remove('open'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') addPageMenu.classList.remove('open'); });
  document.getElementById('addGrid').onclick = () => { addPageMenu.classList.remove('open'); addPage('grid'); };
  document.getElementById('addDash').onclick = () => { addPageMenu.classList.remove('open'); addPage('web'); };
  document.getElementById('addApp').onclick = () => { addPageMenu.classList.remove('open'); addPage('app'); };
  document.getElementById('pageFilter').oninput = e => { pageFilter = e.target.value; renderGrids(); renderGroups(); renderPanes(); };
  // Page-type filter pulldown: same open/close behavior as the Add-page menu.
  const pageKindsMenu = document.getElementById('pageKindsMenu');
  const pageKindsBtn = document.getElementById('pageKindsBtn');
  pageKindsBtn.onclick = e => { e.stopPropagation(); const open = pageKindsMenu.classList.toggle('open'); pageKindsBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); };
  document.addEventListener('click', e => { if (!e.target.closest('.kindwrap')) { pageKindsMenu.classList.remove('open'); pageKindsBtn.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { pageKindsMenu.classList.remove('open'); pageKindsBtn.setAttribute('aria-expanded', 'false'); } });
  pageKindsMenu.querySelectorAll('input[data-kind]').forEach(c => c.onchange = e => { pageKindFilter[e.target.dataset.kind] = e.target.checked; renderGrids(); });
  document.getElementById('pageFilterReset').onclick = () => {
    pageFilter = ''; document.getElementById('pageFilter').value = '';
    Object.keys(pageKindFilter).forEach(k => { pageKindFilter[k] = true; });
    pageKindsMenu.querySelectorAll('input[data-kind]').forEach(c => { c.checked = true; });
    renderGrids();
  };
  document.getElementById('addGroup').onclick = () => addGroup();
  document.getElementById('addPane').onclick = () => addPane();
  document.getElementById('lTabPages').onclick = () => { leftTab = 'pages'; render(); };
  document.getElementById('lTabGroups').onclick = () => { leftTab = 'groups'; render(); };
  document.getElementById('lTabPanes').onclick = () => { leftTab = 'panes'; render(); };
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
    if (!Array.isArray(config.panes)) config.panes = [];
    baseConfig = snapConfig(config);
    // In software Panes mode, open on the Panes tab with the currently displayed pane selected.
    if (softwarePaneMode() && config.panes.length) {
      leftTab = 'panes'; view = 'panes';
      const cur = config.panes.findIndex(p => p.id === (config.settings || {}).activePaneId);
      paneIndex = cur >= 0 ? cur : 0;
    }
    try { const v = await configApi.getAppVersion(); const el = document.getElementById('appVer'); if (el && v) el.textContent = 'v' + v; } catch (e) {}
    try { appDefs = await configApi.getApps(); } catch (e) {}
    try { haCacheLocal = await configApi.getHaCache(); } catch (e) {}   // for iconHtml's HA icon resolution
    render(); setState('All changes saved', 'saved');

    // Pages can arrive while the editor is open — an accepted AI panel is added by the main process,
    // not by this window. Re-read so it shows up (and so this window's next Save doesn't write a
    // stale copy back over it). With unsaved edits we must not clobber them, so say so instead.
    if (configApi.onConfigChangedExternally) {
      let extReloadTimer = null;
      const applyExternalReload = async () => {
        // Mid-interaction guard: re-rendering while a <select> popup is open (or an input is focused)
        // destroys the element under the user's click, so their pick silently lands nowhere. Defer
        // until the control loses focus. (Pane mode makes this frequent — many live app pages can
        // persist options at any moment.)
        const ae = document.activeElement;
        if (ae && ['SELECT', 'INPUT', 'TEXTAREA'].includes(ae.tagName)) {
          clearTimeout(extReloadTimer);
          extReloadTimer = setTimeout(applyExternalReload, 1500);
          return;
        }
        const fresh = await configApi.getConfig();
        if (!fresh) return;
        let mergeNote = '';
        if (dirty && baseConfig) {
          // Fold the external write into the unsaved working copy (three-way against the last
          // load/save). Only a unit/key edited BOTH places conflicts — the editor keeps its version.
          const { merged, conflicts } = configMerge.mergeExternalConfig(config, baseConfig, fresh);
          config = merged;
          mergeNote = conflicts.length
            ? ' — panel also changed ' + conflicts.slice(0, 2).join(', ') + (conflicts.length > 2 ? ', …' : '') + '; your edit wins on Save'
            : ' (panel updates merged in)';
        } else {
          config = fresh;
        }
        baseConfig = snapConfig(fresh);
        if (!config.grids) config.grids = [];
        if (!Array.isArray(config.groups)) config.groups = [];
        if (!Array.isArray(config.panes)) config.panes = [];
        if (gi >= config.grids.length) { gi = Math.max(0, config.grids.length - 1); ti = -1; }
        if (paneIndex >= config.panes.length) paneIndex = config.panes.length - 1;
        if (groupIndex >= config.groups.length) groupIndex = config.groups.length - 1;
        render();
        setState(dirty ? '● Unsaved changes' + mergeNote : 'Loaded changes made on the panel', dirty ? 'dirty' : '');
      };
      configApi.onConfigChangedExternally(() => { clearTimeout(extReloadTimer); applyExternalReload(); });
    }
  })();
