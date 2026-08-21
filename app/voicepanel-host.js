'use strict';
// Generic voice-panel HOST: everything the Claude Code voice app's main.js cluster did that is not
// specific to any one CLI -- per-app state, transcript history, SSE fan-out, the per-turn speech
// pipeline, STT/TTS plumbing, folder browsing, panel-option persistence -- factored out verbatim
// (codex-voice plan, Phase 1) so a second agent app is just a second host instance with its own
// session ADAPTER. One host = one app id = one page.
//
// The session adapter contract (see claudevoice-adapter.js for the reference implementation):
//   start({projectDir, mode, model, approvalsEnabled}) -> bool     stop()
//   sendTurn(text) -> bool      isRunning()   sessionId()   projectDir()
//   interrupt() -> bool         (false = no mid-turn interrupt; barge-in stays TTS-socket-close)
//   setMode(id) -> bool         mode()        listModes() -> [{id,label}]
//   setModel(pick) -> bool      currentModel()              validModel(pick) -> bool
//   decideApproval(requestId, decision) -> bool
//   handleHookRequest(body,res)   (optional -- claude's external-hook route only)
//   cancelApprovals(reason)       ensureUserPromptFile()    (optional)
//   events: 'assistant-start' | 'assistant-delta'{text} | 'assistant-final'{text} |
//           'turn-complete'{text,error} | 'model'{model} | 'approval'{type,requestId,...} |
//           'error'{message} | 'exit'{stillRunning}

const fs = require('fs');
const path = require('path');
const speechLib = require('./claudevoice-speech');   // pure: sentence cutter + sanitizer + per-turn WAV pipeline
const wyoming = require('./claudevoice-wyoming');    // pure: Wyoming STT/TTS protocol client
const { resolveAiProfile } = require('./voiceConfig'); // pure: AI-profile library lookup (Smart Profiles)
const { createPanelReview, PANEL_SYSTEM_PROMPT, PANEL_PROFILE } = require('./panelGenerate'); // pure: Panel Builder review
const routinesLib = require('./routines');            // pure: saved AI routines (shape + auto-name)

// Whisper hallucinates stock phrases on background noise/near-silence ("thanks for watching" is the
// classic, from YouTube training data). Exact-phrase blocklist, compared case/punctuation-insensitively --
// deliberately NOT a fuzzy match, so real dictation containing these words inside a sentence still goes
// through. Dropped utterances return ok+empty text, which the page treats as "heard nothing".
const STT_NOISE_PHRASES = ['thanks for watching'];
function isSttNoisePhrase(text) {
  const norm = String(text || '').toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  return STT_NOISE_PHRASES.includes(norm);
}

// deps: { activeServedAppConfig(appId), activeGrid(), getConfig(), saveConfig(),
//         setRingState(state), clearRingOverride(), getDocumentsPath() }
// branding: { title, approvalTitle, turnFailedText } -- agent-specific page strings, delivered to
// the shared page as `meta` on the /state snapshot together with the adapter's mode/model lists.
function createVoicePanelHost({ appId, storageKey, log, adapter, branding, deps }) {
  const say = log || (() => {});
  const brand = branding || {};
  // Which grids belong to THIS host. deps.ownsGrid narrows beyond the app id (the AI Voice app runs
  // one host per backend under a single id); without it the id alone decides, as it always did.
  const ownsGrid = deps.ownsGrid || (g => !!(g && g.kind === 'app' && g.app === appId));

  // Accumulated view of the current turn, for the /<app>/state snapshot (initial page load and
  // SSE-reconnect recovery -- a fresh subscriber knows the current status immediately, before any
  // new event arrives). Real-time updates go out over SSE via `subscribers`.
  let state = { running: false, status: 'idle', lastUserText: '', lastAssistantText: '', error: null };
  const subscribers = new Set();   // open SSE response objects (see subscribe below)
  // Transcript history for the current session, owned HERE rather than by the guest page: the
  // webview reloads its page on every page switch, so anything only the page remembers is lost the
  // moment the user rotates away and back. getState() returns this so a freshly-(re)loaded page can
  // repaint the whole conversation before subscribing to live SSE events. Cleared on new-session
  // start only -- an ended session's transcript stays readable until a new one replaces it.
  let transcript = [];   // [{role:'user'|'assistant', text}]
  // CLI-like turn queueing: exactly one turn in flight; later entries wait for its turn-complete.
  let turnActive = false;
  let turnQueue = [];             // [{text, speak}] in arrival order
  let queuedSpeakPending = false; // a dequeued turn wants speech; its stream opens on first delta

  function broadcast(payload) {
    const line = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const res of subscribers) { try { res.write(line); } catch (e) { subscribers.delete(res); } }
  }

  // Per-turn speech pipeline (the user's own v2 design): sentences are cut and synthesized HERE, in
  // the main process, and streamed to the page as ONE continuous WAV per turn -- the page just
  // plays a single <audio> element. See claudevoice-speech.js.
  const speech = speechLib.createSpeechPipeline({
    synthesize: wyoming.synthesize,
    wavHeader: wyoming.wavHeader,
    getTts: () => {
      const e = deps.voiceEndpoints();
      return e.ttsHost && e.ttsPort ? { host: e.ttsHost, port: e.ttsPort } : null;
    },
    log: say,
    // A dead/disabled TTS service must never be a SILENT nothing (it fails every sentence and the
    // turn ends as an empty stream) -- surface the first failure on the panel's status line.
    onSpeechError: message => broadcast({ type: 'speech-error', error: 'Speech failed: ' + message }),
  });

  // ---- adapter events -> state/speech/SSE (moved verbatim from the main.js event handlers) ----
  adapter.on('model', ({ model }) => broadcast({ type: 'model', model }));
  adapter.on('models-changed', () => broadcast({ type: 'meta', meta: buildMeta() }));
  adapter.on('notice', ({ text }) => broadcast({ type: 'notice', text }));   // plain-language user guidance on the status line
  // Panel Builder turns stream JSON. It is buffered here rather than shown, and doubles as the
  // turn's text for backends whose turn-complete carries none (codex streams deltas and finishes
  // with no final text — without this buffer its panels were never detected at all).
  let panelTurnText = '';
  adapter.on('assistant-start', () => {
    state.status = 'thinking';
    panelTurnText = '';
    broadcast({ type: 'assistant-start' });
    if (panelProfileActive()) broadcast({ type: 'notice', text: 'Building your panel…' });
  });
  adapter.on('assistant-delta', ({ text }) => {
    // Never stream a panel's JSON into the chat: the user should see a panel appear, not a wall of
    // braces. A prose reply on this profile (a clarifying question) still renders at turn-complete.
    if (panelProfileActive()) { panelTurnText += (text || ''); return; }
    // A dequeued turn's speech starts on its FIRST delta, not at dispatch -- so the previous
    // reply's spoken tail gets to finish (CLI semantics: complete the current task, then answer).
    if (queuedSpeakPending) {
      queuedSpeakPending = false;
      broadcast({ type: 'turn-speech', speech: speech.beginTurn() });
    }
    speech.feed(text);   // no-op unless this turn was started with speak
    broadcast({ type: 'assistant-delta', text });
  });
  adapter.on('assistant-final', ({ text }) => {
    state.status = 'thinking';
    state.lastAssistantText = text;
  });
  adapter.on('turn-complete', ({ text, error }) => {
    state.status = 'idle';
    // THIS turn's text only: a turn that died without producing anything must broadcast null, not
    // echo the previous reply out of lastAssistantText (which made every errored turn "answer"
    // with the prior response, hardware-observed as the agent repeating itself).
    let turnFinalText = typeof text === 'string' ? text : null;
    // A Panel Builder turn whose backend reports no final text still has the deltas we buffered.
    if (!turnFinalText && panelTurnText) turnFinalText = panelTurnText;
    if (turnFinalText != null) state.lastAssistantText = turnFinalText;
    state.error = error;
    // Panel Builder: while that profile is active a JSON reply is a PROPOSED PAGE, not something to
    // read aloud or print. Detect it before any speech starts, so Piper never narrates raw JSON.
    // Ordinary conversation on the same profile (e.g. a clarifying question) parses as nothing and
    // falls through untouched.
    let panelOffered = false;
    if (!state.error && turnFinalText && panelProfileActive()) {
      try { panelOffered = panelReview.offer(turnFinalText); }
      catch (e) { say('panel review failed: ' + ((e && e.message) || e)); }
    }
    // A JSON-shaped reply on this profile that we could NOT turn into a panel (truncated, wrong
    // shape) must not be pasted at the user as braces — that is the "gibberish" case. Say something
    // human instead, and speak that rather than the JSON.
    let shownText = turnFinalText;
    if (!panelOffered && turnFinalText && panelProfileActive()) {
      const t = turnFinalText.trim();
      if (t.charAt(0) === '{' || t.slice(0, 3) === '```') {
        shownText = "I couldn't build that panel. Try saying it again, or describe it a bit differently.";
        say('panel reply was JSON-shaped but unusable; showed a plain message instead');
      }
    }
    // A dequeued result-only turn (no deltas ever streamed) still owes its speech: open its stream
    // now so the whole-text finish below lands in it.
    if (queuedSpeakPending) {
      queuedSpeakPending = false;
      if (!error && text && !panelOffered) broadcast({ type: 'turn-speech', speech: speech.beginTurn() });
    }
    // Speech: flush the pipeline's remainder (or speak the whole result for turns that never
    // streamed deltas, e.g. slash commands); errored turns get their speech cut instead.
    if (state.error) speech.abortActive('turn ended in error');
    else if (panelOffered) speech.abortActive('panel proposals are shown, not spoken');
    else speech.finish(shownText);
    if (shownText && !state.error && !panelOffered) transcript.push({ role: 'assistant', text: shownText });
    if (panelOffered) {
      const ps = panelReview.state();
      transcript.push({ role: 'assistant', text: ps.status === 'ready'
        ? 'Proposed "' + ps.page.name + '" — review it on screen.'
        : 'That panel could not be used: ' + ps.error });
      broadcast({ type: 'panel-review', panel: ps });
    }
    panelTurnText = '';
    broadcast({ type: 'turn-complete', text: panelOffered ? null : shownText, error: state.error });
    // CLI semantics: the finished turn hands off to the next queued entry, in order.
    turnActive = false;
    if (turnQueue.length) {
      const next = turnQueue.shift();
      dispatchTurn(next.text, next.speak, true);
    }
  });
  adapter.on('error', ({ message }) => {
    state.status = 'error'; state.error = message;
    turnActive = false;
    turnQueue = [];
    queuedSpeakPending = false;
    speech.abortActive('session error');
    broadcast({ type: 'error', error: state.error });
  });
  adapter.on('exit', ({ stillRunning }) => {
    state.running = false;
    if (!stillRunning) {
      turnActive = false;
      turnQueue = [];
      queuedSpeakPending = false;
      speech.abortActive('agent process exited');
    }
  });
  // Approval flow (normalized from whatever mechanism the adapter uses -- external hook for claude,
  // in-band protocol requests for codex): drives status, the ring, and the panel overlay.
  adapter.on('approval', evt => {
    if (evt.type === 'approval-request') {
      state.status = 'approval';
      deps.setRingState('approval');
      broadcast({ type: 'approval-request', requestId: evt.requestId, toolName: evt.toolName, toolInput: evt.toolInput });
    } else if (evt.type === 'approval-decision' || evt.type === 'approval-timeout') {
      state.status = 'thinking';   // control returns to the agent, which keeps working or asks again
      deps.setRingState('thinking');
      broadcast({ type: evt.type, requestId: evt.requestId, decision: evt.decision });
    }
  });

  // Panel-tunable options (Settings overlay): whitelist + validation. Written into the page's own
  // options in config.json so they persist across app restarts (the page's localStorage can't --
  // the server port, and so the origin, changes every launch).
  const PANEL_OPTIONS = {
    chatFontSize: v => { const n = parseInt(v, 10); return n >= 12 && n <= 32 ? String(n) : null; },
    vadHangoverMs: v => { const n = parseInt(v, 10); return n >= 300 && n <= 3000 ? String(n) : null; },
    // Device picks are stored as LABELS, not deviceIds -- Chromium's deviceIds are salted per origin
    // and the served origin's port changes every launch, so an id would never match twice. The page
    // re-matches label -> id at startup. Empty string = system default.
    micDevice: v => typeof v === 'string' && v.length <= 200 ? v : null,
    spkDevice: v => typeof v === 'string' && v.length <= 200 ? v : null,
    modelPick: v => adapter.validModel(v) ? v : null,
  };

  // Ensures a session is running for the panel's currently-active page (starting one on first
  // use), then sends the turn. `speak` is decided by the page PER TURN -- when set, the reply gets
  // a speech stream and `speech` carries its id for the page's <audio>. Returns {ok:false} if the
  // active page isn't this app's page or the turn couldn't be sent.
  function onTurn(text, speak) {
    const opts = deps.activeServedAppConfig(appId);
    if (!opts) return { ok: false };
    const lazyStart = !adapter.isRunning();
    if (lazyStart && !startSession()) return { ok: false };
    // CLI semantics (explicitly required): a turn sent while one is in flight WAITS -- the current
    // reply finishes its text and speech, then the queued entry dispatches. Its speech-stream id
    // is announced later via the 'turn-speech' broadcast (there is no id to hand back yet).
    if (turnActive) {
      turnQueue.push({ text, speak });
      return { ok: true, queued: true, speech: null };
    }
    const speechId = dispatchTurn(text, speak, false);
    if (speechId === false) return { ok: false };
    // A lazy session start just broadcast session-started, which wipes the page's local transcript
    // -- INCLUDING the user bubble the page drew for this very turn ("my first spoken instruction
    // flashes then disappears"). Send the turn text back so the page can redraw it.
    if (lazyStart) broadcast({ type: 'user-turn', text });
    return { ok: true, speech: speechId };
  }
  // "+ Routine" beside Send. Saves `text` (the message field) as a reusable routine, or — when the
  // field is empty — the last request that was actually sent, so you can speak a task, watch it
  // work, and keep it. The routine is named from its own opening words: the panel has no on-screen
  // keyboard, so a "name it" dialog would be a dead end. Rename it on Settings -> Routines.
  function saveRoutine(text) {
    const prompt = String(text || '').trim() || String(state.lastUserText || '').trim();
    if (!prompt) return { ok: false, error: 'Nothing to save yet — type a request, or ask for something first.' };
    const grid = deps.activeGrid && deps.activeGrid();
    if (!grid || !grid.id) return { ok: false, error: 'Open an AI Chat page first.' };
    const config = deps.getConfig();
    if (!config.settings) config.settings = {};
    if (!Array.isArray(config.settings.routines)) config.settings.routines = [];
    const routine = routinesLib.normalizeRoutine({
      prompt: prompt,
      appPageId: grid.id,
      profileId: (grid.options && grid.options.profilePick) || '',   // the profile this page is on right now
      // ...and the folder it's in right now, so re-running lands in the same place. Chat-only
      // backends have no working directory; normalizeRoutine keeps the blank.
      folder: routinesLib.allowsFolder(grid) ? ((grid.options && grid.options.projectDir) || '') : '',
      // ...and the permission mode the page is running under -- the same truth the Mode button
      // shows: the live session's mode if one is running, else the page's stored pick. Backends
      // with no modes report '' and it stays blank.
      mode: (adapter.isRunning() && adapter.mode ? adapter.mode() : ((grid.options && grid.options.permissionMode) || '')),
    });
    if (!routine) return { ok: false, error: 'Nothing to save yet.' };
    config.settings.routines.push(routine);
    deps.saveConfig();
    say('routine saved: "' + routine.name + '"');
    return { ok: true, name: routine.name };
  }

  // Sends one turn to the adapter. Returns false on send failure, else the speech-stream id (or
  // null). Queued dispatches defer their speech to the first delta (see the assistant-delta
  // handler) so the previous reply's spoken tail is never cut off.
  function dispatchTurn(text, speak, fromQueue) {
    state.status = 'thinking';
    state.lastUserText = text;
    const sent = adapter.sendTurn(text);
    if (!sent) return false;
    turnActive = true;
    transcript.push({ role: 'user', text });
    if (fromQueue) {
      queuedSpeakPending = !!speak;
      return null;
    }
    // Immediate turn: any previous reply is long done; a still-open speech stream is stale.
    let speechId = null;
    if (speak) speechId = speech.beginTurn();
    else speech.abortActive('a new turn was sent');
    return speechId;
  }

  // The active page's AI profile (Smart Profiles): per-page pick resolved against the global
  // library; '' or a deleted id falls back to the library's first entry (General Chat).
  function currentProfile() {
    const opts = deps.activeServedAppConfig(appId);
    const settings = (deps.getConfig() || {}).settings;
    return resolveAiProfile(settings, (opts && opts.options.profilePick) || '');
  }
  function panelProfileActive() { return currentProfile().id === PANEL_PROFILE.id; }
  // The Panel Builder's JSON contract lives in CODE and is appended to whatever the (user-editable)
  // profile text says, so editing the profile can change its wording but never break generation.
  function profilePromptFor(prof) {
    const base = (prof && prof.prompt) || '';
    if (!prof || prof.id !== PANEL_PROFILE.id) return base;
    return (base ? base + '\n\n' : '') + PANEL_SYSTEM_PROMPT;
  }

  // Panel Builder review: holds an AI-authored page until the user Accepts it on the panel.
  const panelReview = createPanelReview({
    existingIds: () => ((deps.getConfig() || {}).grids || []).map(g => g && g.id).filter(Boolean),
    makeId: () => {
      const used = ((deps.getConfig() || {}).grids || []).map(g => g && g.id);
      let id;
      do { id = 'g' + Math.random().toString(36).slice(2, 8); } while (used.indexOf(id) !== -1);
      return id;
    },
    log: say,
  });

  // Panel Profile picker: persist the pick on the page, hand the prompt to the adapter (chat
  // backends apply it on the next request; claude quietly restarts-with-resume; codex/copilot
  // prefix their next turn), and tell every subscribed page.
  function setProfile(id) {
    if (typeof id !== 'string' || id.length > 64) return false;
    const g = deps.activeGrid();
    if (!ownsGrid(g)) return false;
    if (!g.options) g.options = {};
    g.options.profilePick = id;
    deps.saveConfig();
    const prof = currentProfile();
    if (adapter.setProfilePrompt) adapter.setProfilePrompt(profilePromptFor(prof));
    // Leaving Panel Builder drops any panel still awaiting review — it can't be accepted from
    // another mode, and a stale proposal reappearing later would be baffling.
    if (prof.id !== PANEL_PROFILE.id && panelReview.isActive()) {
      panelReview.cancel();
      broadcast({ type: 'panel-review', panel: panelReview.state() });
    }
    broadcast({ type: 'profile', id: prof.id, name: prof.name });
    return true;
  }

  function getState() {
    const opts = deps.activeServedAppConfig(appId);
    return Object.assign({}, state, {
      running: adapter.isRunning(),
      sessionId: adapter.sessionId(),
      // Before a session exists the adapter only knows its built-in default -- the page's
      // CONFIGURED mode is the truth the panel should show (the lazy first-turn start uses it).
      permissionMode: adapter.isRunning() ? adapter.mode() : ((opts && opts.options.permissionMode) || adapter.mode()),
      model: adapter.currentModel(),
      projectDir: adapter.projectDir() || (opts && opts.options.projectDir) || '',
      transcript,
      meta: buildMeta(),
      // A page reloaded mid-review (rotation, relaunch) repaints the pending panel from here.
      panel: panelReview.state(),
    });
  }
  // Agent-specific page strings + pick lists; the shared page applies these over its claude-shaped
  // markup fallbacks (see applyMeta in claudevoiceview.js). Delivered on /state and re-pushed over
  // SSE whenever the adapter's lists change (e.g. codex model discovery finishing after page load).
  function buildMeta() {
    return {
      title: brand.title || '',
      approvalTitle: brand.approvalTitle || '',
      turnFailedText: brand.turnFailedText || '',
      modes: adapter.listModes ? adapter.listModes() : [],
      models: adapter.listModels ? adapter.listModels() : [],
      approvalAlways: !!adapter.supportsAlwaysApproval,   // "Always" = approve + stop asking this session (codex acceptForSession)
      // Backends without a working directory (owui/api chat) hide the page's folder button.
      hasProject: brand.hasProject !== false,
      // Smart Profiles: the global library (names only) + this page's current pick.
      profiles: ((((deps.getConfig() || {}).settings || {}).aiProfiles) || []).map(p => ({ id: p.id, name: p.name })),
      profile: currentProfile().id,
    };
  }

  // Data for the Change-folder overlay. `browsePath` (optional) is the directory currently being
  // browsed -- the overlay can walk Up a level or into subfolders anywhere on disk, starting from
  // the page's configured root. Scanned fresh on each request so new clones just show up. `parent`
  // is null at a filesystem root (Up gets disabled there).
  function getProjects(browsePath) {
    const opts = deps.activeServedAppConfig(appId);
    if (!opts) return { root: '', parent: null, dirs: [], current: '', recents: [] };
    // Folders-root default: empty option -> the user's Documents folder, resolved at runtime so
    // nothing machine-specific is baked into the shipped defaults.
    const root = path.resolve(browsePath || opts.options.projectsRoot || deps.getDocumentsPath() || '');
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(root, d.name))
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {}
    const up = path.dirname(root);
    const config = deps.getConfig();
    const store = (config.settings && config.settings[storageKey]) || {};
    return {
      root,
      parent: up !== root ? up : null,
      dirs,
      current: adapter.projectDir() || opts.options.projectDir || '',
      recents: store.recentProjects || [],
    };
  }

  function setOption(key, value) {
    const validate = PANEL_OPTIONS[key];
    if (!validate) return false;
    const v = validate(value);
    if (v == null) return false;
    const g = deps.activeGrid();
    if (!ownsGrid(g)) return false;
    if (!g.options) g.options = {};
    g.options[key] = v;
    deps.saveConfig();
    return true;
  }

  // Commit the panel the user just approved: append it to the page list and persist. This is the
  // only path from model output into config.grids, and it runs only after an explicit Accept (plus a
  // second confirmation when the panel contains anything executable).
  function panelAccept(confirmRisky, replace) {
    const config = deps.getConfig();
    if (!Array.isArray(config.grids)) return { ok: false, error: 'no page list to add to' };
    // The page we'd replace may have been deleted in the editor since; fall back to adding.
    const target = panelReview.state().replaces;
    if (replace && (!target || !config.grids.some(g => g && g.id === target.id))) {
      panelReview.forgetAccepted();
      replace = false;
    }
    const r = panelReview.accept(!!confirmRisky, !!replace);
    if (!r.ok) return r;
    const at = r.replaceId ? config.grids.findIndex(g => g && g.id === r.replaceId) : -1;
    if (at >= 0) config.grids[at] = r.page; else config.grids.push(r.page);
    deps.saveConfig();
    say('panel accepted: "' + r.page.name + '" ' + (at >= 0 ? 'replaced page ' : 'added as page ') + r.page.id);
    broadcast({ type: 'panel-review', panel: panelReview.state() });
    broadcast({ type: 'panel-accepted', id: r.page.id, name: r.page.name });
    if (deps.gotoGrid) { try { deps.gotoGrid(r.page.id); } catch (e) {} }   // land on what was just built
    return { ok: true, id: r.page.id, name: r.page.name };
  }
  function panelCancel() {
    panelReview.cancel();
    broadcast({ type: 'panel-review', panel: panelReview.state() });
    return { ok: true };
  }

  function setPermissionMode(mode) {
    const ok = adapter.setMode(mode);
    if (ok) broadcast({ type: 'permission-mode', mode });
    return ok;
  }

  // Explicit session start/stop: switching folders on the panel, or the first turn of a fresh page,
  // both want "start now" / "end this conversation" rather than onTurn's implicit lazy-start.
  // `dir` overrides the app page's own configured projectDir when given.
  function startSession(dir) {
    const opts = deps.activeServedAppConfig(appId);
    if (!opts) return false;
    const projectDir = dir || opts.options.projectDir || deps.getDocumentsPath();
    try { fs.mkdirSync(projectDir, { recursive: true }); } catch (e) {}
    // Persist the pick: the page's own options stay the single source of truth (so the editor
    // always shows the real current folder, and it survives app restarts), and the recents list
    // feeds the picker overlay's quick row. One combined saveConfig below.
    const g = deps.activeGrid();
    let cfgDirty = false;
    if (ownsGrid(g)) {
      if (!g.options) g.options = {};
      if (g.options.projectDir !== projectDir) { g.options.projectDir = projectDir; cfgDirty = true; }
    }
    const config = deps.getConfig();
    if (!config.settings) config.settings = {};
    const store = config.settings[storageKey] = config.settings[storageKey] || {};
    const recents = [projectDir].concat((store.recentProjects || []).filter(p => p !== projectDir)).slice(0, 5);
    if (JSON.stringify(recents) !== JSON.stringify(store.recentProjects || [])) { store.recentProjects = recents; cfgDirty = true; }
    if (cfgDirty) deps.saveConfig();
    adapter.start({
      projectDir,
      // '' (the consolidated manifest's neutral default) must read as "adapter's own default",
      // not as a real mode string.
      mode: opts.options.permissionMode || undefined,
      model: opts.options.modelPick,
      approvalsEnabled: !!opts.options.approvalsEnabled,
      profilePrompt: profilePromptFor(currentProfile()),
    });
    state = { running: true, status: 'idle', lastUserText: '', lastAssistantText: '', error: null };
    turnActive = false;
    turnQueue = [];
    queuedSpeakPending = false;
    transcript = [];   // new session, fresh conversation
    speech.abortActive('new session started');   // a folder switch mid-reply silences the old folder's voice
    // permissionMode rides along so the page's Mode button is corrected the moment a lazy first-turn
    // start lands (the page-load /state snapshot predates the session and can go stale).
    broadcast({ type: 'session-started', projectDir, permissionMode: adapter.mode() });
    return true;
  }

  function stopSession() {
    adapter.stop();
    turnActive = false;
    turnQueue = [];
    queuedSpeakPending = false;
    speech.abortActive('session stopped');
    state = { running: false, status: 'idle', lastUserText: '', lastAssistantText: '', error: null };
    deps.clearRingOverride();
    broadcast({ type: 'session-stopped' });
    return true;
  }

  // SSE subscribe: keeps the response open, pushes every broadcast() call as a `data:` line,
  // removes itself when the page navigates away/reloads/closes. A fresh subscriber gets the
  // /state snapshot for "where things stand right now" and then only future events.
  function subscribe(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    res.write(': connected\n\n');
    subscribers.add(res);
    req.on('close', () => { subscribers.delete(res); });
  }

  // Transcribes one VAD-trimmed utterance (raw 16kHz/16-bit/mono PCM, matching the page's mic
  // pipeline -- see claudevoice-vad.js) via the configured wyoming-faster-whisper host/port.
  async function transcribe(pcmBuffer) {
    const { sttHost: host, sttPort: port } = deps.voiceEndpoints();
    if (!host || !port) return { ok: false, error: 'STT host/port not configured (Settings → TTS/STT)' };
    try {
      const text = await wyoming.transcribe({ host, port, audio: pcmBuffer, rate: 16000, width: 2, channels: 1, log: say });
      if (isSttNoisePhrase(text)) {
        say('STT dropped a known noise-hallucination phrase: ' + JSON.stringify(text));
        return { ok: true, text: '' };
      }
      return { ok: true, text };
    } catch (e) {
      say('STT error: ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // Streams synthesized speech for `text` straight into `res` as a WAV, via the configured
  // wyoming-piper host/port. Writes the WAV header the moment Wyoming's audio-start reply tells
  // us the real sample rate/width/channels (Piper's rate can vary by voice model). Used by the
  // Test-speech button; real replies stream through the per-turn pipeline instead.
  async function synthesize(text, res) {
    const { ttsHost: host, ttsPort: port } = deps.voiceEndpoints();
    text = speechLib.prepWholeSpeech(text);   // speech-only markdown cleanup lives server-side
    if (!host || !port || !text) { res.writeHead(400); res.end(); return; }
    let headerWritten = false;
    try {
      await wyoming.synthesize({
        host, port, text, log: say,
        onFormat: fmt => {
          headerWritten = true;
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
          res.write(wyoming.wavHeader(fmt));
        },
        onChunk: buf => { try { res.write(buf); } catch (e) {} },
      });
    } catch (e) {
      say('TTS error: ' + e.message);
      if (!headerWritten) { try { res.writeHead(502); } catch (er) {} }
    }
    try { res.end(); } catch (e) {}
  }

  // App-quit teardown: terminate the agent child, release any held approval request, and (for
  // adapters that install one) remove the external hook.
  function shutdown() {
    try { adapter.stop(); } catch (e) {}
    try { adapter.cancelApprovals('App is quitting.'); } catch (e) {}
  }

  return {
    appId,
    adapter,
    handlers: {
      onTurn,
      getState,
      getProjects,
      setOption,
      setPermissionMode,
      setProfile,
      panelAccept,
      panelCancel,
      saveRoutine,
      setModel: model => adapter.setModel(model),
      sessionStart: startSession,
      sessionStop: stopSession,
      subscribe,
      transcribe,
      synthesize,
      turnAudio: (turnId, req, res) => speech.attach(turnId, req, res),
      approvalDecision: (requestId, decision) => adapter.decideApproval(requestId, decision),
      // claude-only extra: the external PreToolUse hook's long-poll entry point. Wired solely to
      // this app's /approval-request route (token-gated); adapters without hooks fail it closed.
      approvalRequest: (body, res) => {
        if (adapter.handleHookRequest) return adapter.handleHookRequest(body, res);
        try { res.writeHead(403); res.end(); } catch (e) {}
      },
    },
    shutdown,
  };
}

module.exports = { createVoicePanelHost };
