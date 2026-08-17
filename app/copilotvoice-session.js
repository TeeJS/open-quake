'use strict';
// GitHub Copilot CLI session ADAPTER for the generic voice-panel host (voicepanel-host.js) -- the
// copilot counterpart of claudevoice-adapter.js / codexvoice-session.js. Drives the CLI's `--acp`
// mode: the open Agent Client Protocol (https://agentclientprotocol.com), bidirectional JSON-RPC 2.0
// over stdio as newline-delimited JSON with no Content-Length framing -- verified live against the
// installed copilot-cli 1.0.80 (spawn `copilot --acp`, pipe stdio, watch the wire). Flow: initialize
// -> session/new -> session/prompt, with session/update notifications carrying agent_message_chunk
// text plus tool_call(_update)/config_option_update/usage_update progress, and
// session/request_permission arriving as a server-initiated REQUEST on the same pipe for approvals --
// same in-band posture as the codex adapter, no external hook, no settings.json mutation.
//
// Two ACP quirks that shaped this file (both confirmed against the live CLI, not the spec alone):
//  - session/prompt's PROMISE only resolves once the WHOLE turn is done (stop reason included) --
//    unlike codex's turn/start (which returns immediately, with turn/completed as a separate
//    notification). So the promise chain IS the turn-complete signal; no separate "done" event.
//  - There is no dedicated model/list call or SessionModeState: session/new's response hands back
//    `models.availableModels` directly, and the session's Mode (agent/plan/autopilot) is just
//    another entry in the generic `configOptions` list (id "mode", value a session-modes URL with a
//    stable #fragment) alongside "model" and the "allow_all" permission toggle -- switched with the
//    same session/set_config_option call for all three, not a dedicated mode endpoint.

const childProcess = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

let cachedCopilotExe;   // undefined = not looked up yet · null = not found · string = resolved path

// PATH lookup, same discipline as claudevoice-session's findClaudeExe / codexvoice-session's
// findCodexExe. Existence/version check only -- the spawn goes through the shell because npm
// installs `copilot` as a .cmd shim on Windows.
function findCopilotExe(execFileSync) {
  if (cachedCopilotExe !== undefined) return cachedCopilotExe;
  const run = execFileSync || childProcess.execFileSync;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = run(cmd, ['copilot'], { windowsHide: true }).toString();
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    cachedCopilotExe = first || null;
  } catch (e) { cachedCopilotExe = null; }
  return cachedCopilotExe;
}

// Mode presets pair the ACP session "mode" config option (agent/plan/autopilot) with the
// "allow_all" permission toggle -- mirrors codex's approach of collapsing two CLI knobs into the
// single preset id the panel's Mode overlay works with. Only the #fragment ("agent"/"plan"/
// "autopilot") is hardcoded -- the CLI's actual config VALUE for each is a full URL, resolved live
// off the session's own configOptions the moment it starts (see recordConfigOptions below), never
// guessed. Labels/descriptions mirror the CLI's own `/mode` and `/permissions` wording (1.0.80).
const COPILOT_MODE_PRESETS = {
  manual: { label: 'Manual', desc: 'Ask before every action (touch approval)', modeFragment: 'agent', allowAll: 'off' },
  plan: { label: 'Plan', desc: "Describe, don't act, until approved", modeFragment: 'plan', allowAll: 'off' },
  auto: { label: 'Approve for me', desc: 'File changes and commands run automatically', modeFragment: 'agent', allowAll: 'on' },
  autopilot: { label: 'Full auto', desc: 'Runs autonomously until the task is done — no prompts at all', modeFragment: 'autopilot', allowAll: 'on' },
};
const COPILOT_DEFAULT_MODE = 'manual';   // matches the CLI's own out-of-the-box state (agent + allow_all off)

// session/request_permission's toolCall.kind, for when the CLI's own title is missing.
const TOOL_KIND_LABELS = {
  execute: 'Run command', edit: 'Change files', delete: 'Delete files', move: 'Move files',
  fetch: 'Access network', search: 'Search', read: 'Read files',
};

function createCopilotVoiceAdapter({ log }) {
  const say = log || (() => {});
  const emitter = new EventEmitter();

  let proc = null;
  let nextId = 0;
  let pending = new Map();          // request id -> {resolve, reject}
  let queuedTurns = [];             // sendTurn() calls made before the handshake finished
  let sessionId = null;
  let projectDir = null;
  let mode = COPILOT_DEFAULT_MODE;
  let ready = false;                // initialize + session/new round trips are done
  let turnText = '';                // accumulated agent_message_chunk text for the current turn
  let turnInFlight = false;         // a session/prompt request is outstanding (interrupt() gate)
  let lastStderr = '';              // only surfaced when a handshake fails, else stderr is log noise
  let pendingApprovals = new Map(); // requestId(string) -> {id, options}
  let modelPick = '';               // '' = follow whatever the CLI's own session already has selected
  let modelList = [];               // [{modelId, name, description}], from session/new's response
  let modeValueByFragment = {};     // 'agent'|'plan'|'autopilot' -> the CLI's real config value (a URL)
  let currentConfigModel = '';      // last-seen "model" config option currentValue (server truth)
  let appliedInitialConfig = false; // apply the persisted mode/model pick exactly once per session

  function send(method, params) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) return Promise.reject(new Error('copilot app-server not running'));
    const id = ++nextId;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { proc.stdin.write(line + '\n'); } catch (e) { pending.delete(id); reject(e); }
    });
  }
  // ACP notifications (session/cancel) carry no id and expect no response.
  function notify(method, params) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;
    try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch (e) {}
  }
  function respond(id, result) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;
    try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch (e) {}
  }
  function respondError(id, code, message) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;
    try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); } catch (e) {}
  }

  // Retire the current process: null out `proc` FIRST so handlers still attached to the old process
  // see themselves as stale and stand down -- same folder-switch race guard as the codex adapter.
  function stopProc(reason) {
    const old = proc;
    proc = null;
    ready = false;
    turnInFlight = false;
    pending.forEach(p => p.reject(new Error(reason || 'copilot app-server stopped')));
    pending = new Map();
    pendingApprovals.forEach((entry, requestId) => {
      emitter.emit('approval', { type: 'approval-timeout', requestId, decision: 'deny' });
    });
    pendingApprovals = new Map();
    if (!old) return;
    try { old.stdin.end(); } catch (e) {}
    const killTimer = setTimeout(() => { try { old.kill(); } catch (e) {} }, 1000);
    if (killTimer.unref) killTimer.unref();
  }

  // Applies the current mode preset's "mode" and "allow_all" config options. Best-effort/fire-and-
  // forget: the panel already shows the optimistic pick (mode()/currentModel() are local state), and
  // a rejected set_config_option call just logs -- same posture as codex's per-turn overrides.
  function applyModeConfig() {
    if (!ready || !sessionId) return;
    const preset = COPILOT_MODE_PRESETS[mode] || COPILOT_MODE_PRESETS[COPILOT_DEFAULT_MODE];
    const modeValue = modeValueByFragment[preset.modeFragment];
    if (modeValue) send('session/set_config_option', { sessionId, configId: 'mode', type: 'value_id', value: modeValue }).catch(e => say('mode set failed: ' + e.message));
    if (preset.allowAll) send('session/set_config_option', { sessionId, configId: 'allow_all', type: 'value_id', value: preset.allowAll }).catch(e => say('permission set failed: ' + e.message));
  }
  function applyModelConfig() {
    if (!ready || !sessionId || !modelPick) return;
    send('session/set_config_option', { sessionId, configId: 'model', type: 'value_id', value: modelPick }).catch(e => say('model set failed: ' + e.message));
  }

  // configOptions arrive as a "select" list per option id; "mode"'s values are the CLI's real
  // config-value URLs, each ending in a #fragment ("agent"/"plan"/"autopilot") -- captured here so
  // applyModeConfig() never has to guess a URL. Runs on every config_option_update (our own
  // set_config_option calls trigger one too), but the initial-config apply is gated to fire once.
  function recordConfigOptions(configOptions) {
    (configOptions || []).forEach(opt => {
      if (opt.id === 'mode' && Array.isArray(opt.options)) {
        opt.options.forEach(o => {
          const frag = String(o.value || '').split('#').pop();
          if (frag) modeValueByFragment[frag] = o.value;
        });
      }
      if (opt.id === 'model' && typeof opt.currentValue === 'string') {
        currentConfigModel = opt.currentValue;
        if (!modelPick) emitter.emit('model', { model: currentConfigModel });
      }
    });
    // First time we learn the real mode-value URLs, apply whatever mode/model this session was
    // started with -- session/new has no params for either, so this is the only way to apply a
    // persisted non-default pick. Doing it any earlier (e.g. straight off session/new's own
    // response) loses the race: that response resolves before this notification's line is even
    // read off the pipe (verified live), so modeValueByFragment would still be empty.
    if (!appliedInitialConfig && Object.keys(modeValueByFragment).length) {
      appliedInitialConfig = true;
      applyModeConfig();
      applyModelConfig();
    }
  }

  function handleMessage(m) {
    // Response to one of our requests.
    if (m.id != null && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
      else p.resolve(m.result);
      return;
    }
    // Server-initiated REQUEST -- the approval surface. Anything else fails closed (same posture as
    // the claude hook's timeout and the codex adapter's unexpected-request handling).
    if (m.id != null && m.method) {
      const p = m.params || {};
      if (m.method === 'session/request_permission') {
        const requestId = String(m.id);
        pendingApprovals.set(requestId, { id: m.id, options: p.options || [] });
        const toolCall = p.toolCall || {};
        const paths = Array.isArray(toolCall.locations) ? toolCall.locations.map(l => l.path).filter(Boolean) : [];
        emitter.emit('approval', {
          type: 'approval-request', requestId,
          toolName: toolCall.title || TOOL_KIND_LABELS[toolCall.kind] || 'Perform action',
          toolInput: Object.assign({}, toolCall.rawInput || {}, paths.length === 1 ? { path: paths[0] } : {}),
        });
        return;
      }
      say('unexpected server request ' + m.method + ' declined');
      respondError(m.id, -32601, 'not supported');
      return;
    }
    // Notification.
    if (m.method !== 'session/update') return;
    const update = (m.params || {}).update || {};
    if (update.sessionUpdate === 'agent_message_chunk') {
      const c = update.content;
      if (c && c.type === 'text' && c.text) {
        turnText += c.text;
        emitter.emit('assistant-delta', { text: c.text });
      }
      return;
    }
    if (update.sessionUpdate === 'config_option_update') { recordConfigOptions(update.configOptions); return; }
    // plan / tool_call / tool_call_update / usage_update / available_commands_update /
    // session_info_update / agent_thought_chunk carry no voice-relevant text -- Phase scope is
    // text-only turns, same as codex's initial cut.
  }

  function launch({ cwd, model }) {
    ready = false;
    // npm's copilot shim is a .cmd on Windows -- shell:true is what makes this spawn portable.
    proc = childProcess.spawn('copilot', ['--acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true });
    const thisProc = proc;
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', line => {
      if (proc !== thisProc) return;   // buffered output from a replaced process must not touch live state
      if (!line.trim()) return;
      let m; try { m = JSON.parse(line); } catch (e) { return; }
      try { handleMessage(m); } catch (e) { say('event handling failed: ' + e.message); }
    });
    thisProc.stderr.on('data', b => { if (proc === thisProc) lastStderr = String(b).trim().slice(0, 400); });
    thisProc.on('error', e => {
      if (proc !== thisProc) return;
      say('copilot spawn error: ' + e.message);
      emitter.emit('error', { message: 'copilot CLI failed to start: ' + e.message });
    });
    thisProc.on('exit', code => {
      if (proc !== thisProc) return;
      proc = null;
      ready = false;
      turnInFlight = false;
      pending.forEach(p => p.reject(new Error('copilot app-server exited')));
      pending = new Map();
      say('copilot app-server exited' + (code == null ? '' : ' (code ' + code + ')'));
      emitter.emit('exit', { stillRunning: false });
    });
    // Handshake: initialize, then session/new. sendTurn() calls queue until this finishes. Deadline
    // mirrors codex's: a wedged handshake must surface as a panel error, never an eternal "thinking".
    const handshakeDeadline = setTimeout(() => {
      if (proc === thisProc && !ready) {
        say('handshake timed out; stopping the app-server');
        stopProc('handshake timed out');
        emitter.emit('error', { message: 'Copilot session failed to start: timed out — try switching folders to retry.' });
      }
    }, 30000);
    if (handshakeDeadline.unref) handshakeDeadline.unref();
    send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
      .then(() => send('session/new', { cwd, mcpServers: [] }))
      .then(result => {
        clearTimeout(handshakeDeadline);
        sessionId = (result && result.sessionId) || null;
        if (!sessionId) throw new Error('no session id in session/new response');
        modelList = ((result.models && result.models.availableModels) || []).filter(m => m && m.modelId);
        if (model) modelPick = model;
        ready = true;
        say('copilot session ' + sessionId + ' ready (' + mode + ')');
        emitter.emit('models-changed', {});
        const q = queuedTurns; queuedTurns = [];
        q.forEach(text => startTurn(text));
      })
      .catch(e => {
        const authy = /auth/i.test(e.message || '');
        say('copilot handshake failed: ' + e.message + (lastStderr ? ' | stderr: ' + lastStderr : ''));
        emitter.emit('error', { message: authy ? 'Copilot session failed to start: not signed in — run `copilot login` in a terminal first.' : 'Copilot session failed to start: ' + e.message });
      });
  }

  function isValidModel(pick) {
    if (pick === '') return true;
    if (!modelList.length) return typeof pick === 'string' && pick.length <= 64;   // discovery pending: be lenient
    return modelList.some(m => m.modelId === pick);
  }

  function startTurn(text) {
    turnText = '';
    turnInFlight = true;
    emitter.emit('assistant-start');
    // Unlike codex's turn/start, this PROMISE only resolves once the whole turn (including any
    // approvals) is done -- so its resolution IS the turn-complete signal, not a separate notification.
    send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      .then(result => {
        turnInFlight = false;
        const stop = (result && result.stopReason) || 'end_turn';
        emitter.emit('turn-complete', { text: turnText || null, error: stop === 'refusal' ? 'refused' : null });
      })
      .catch(e => {
        turnInFlight = false;
        say('session/prompt rejected: ' + e.message);
        emitter.emit('turn-complete', { text: turnText || null, error: 'turn failed: ' + e.message });
      });
  }

  return {
    // ---- lifecycle (host adapter contract; see voicepanel-host.js header) ----
    start({ projectDir: dir, mode: pick, model }) {
      if (!findCopilotExe()) {
        say('copilot CLI not found on PATH');
        emitter.emit('error', { message: 'copilot CLI not found on PATH' });
        return false;
      }
      stopProc('superseded by a new session');
      projectDir = dir;
      mode = COPILOT_MODE_PRESETS[pick] ? pick : COPILOT_DEFAULT_MODE;
      sessionId = null;
      queuedTurns = [];
      modeValueByFragment = {};
      currentConfigModel = '';
      appliedInitialConfig = false;
      launch({ cwd: dir, model: model || null });
      return true;
    },
    stop() {
      queuedTurns = [];
      sessionId = null;
      stopProc('session stopped');
    },
    sendTurn(text) {
      if (!proc) return false;
      if (!ready) { queuedTurns.push(text); return true; }   // handshake still in flight
      startTurn(text);
      return true;
    },
    isRunning() { return !!proc; },
    sessionId() { return sessionId; },
    projectDir() { return projectDir; },
    interrupt() {
      if (!ready || !sessionId || !turnInFlight) return false;
      notify('session/cancel', { sessionId });
      return true;
    },

    // ---- mode: presets pair the "mode" and "allow_all" config options. Switching updates the
    // stored preset and fires the config-option calls immediately (not queued for the next turn --
    // ACP's session/set_config_option applies to the live session right away, unlike codex's
    // per-turn overrides). ----
    setMode(pick) {
      if (!COPILOT_MODE_PRESETS[pick]) return false;
      // No session yet -> refuse, same as codex/claude: a pre-session pick would only be clobbered
      // by the lazy start applying the editor-configured mode.
      if (!proc) return false;
      if (pick !== mode) {
        mode = pick;
        applyModeConfig();
        say('mode -> ' + pick);
      }
      return true;
    },
    mode() { return mode; },
    listModes() {
      return Object.entries(COPILOT_MODE_PRESETS).map(([id, p]) => ({ id, label: p.label, desc: p.desc }));
    },

    // ---- model: the list comes straight from session/new's response (no discovery round trip like
    // codex's model/list). Applied as a live config-option set, same immediacy as mode. ----
    setModel(pick) {
      if (!isValidModel(pick)) return false;
      modelPick = pick;
      applyModelConfig();
      emitter.emit('model', { model: modelPick || currentConfigModel || '' });
      return true;
    },
    currentModel() { return modelPick || currentConfigModel || ''; },
    validModel(pick) { return isValidModel(pick); },
    listModels() {
      return modelList.map(m => ({ id: m.modelId, label: m.name + (m.modelId === 'auto' ? ' — default' : '') }));
    },

    // ---- approvals (in-band JSON-RPC responses to session/request_permission; no external hook) ----
    supportsAlwaysApproval: true,   // ACP's allow_always option kind: approve + stop asking for similar requests this session
    decideApproval(requestId, decision) {
      const req = pendingApprovals.get(String(requestId));
      if (!req) return false;
      pendingApprovals.delete(String(requestId));
      const wantKind = decision === 'always' ? 'allow_always' : decision === 'allow' ? 'allow_once' : 'reject_once';
      const fallbackKind = decision === 'always' ? 'allow_once' : decision === 'allow' ? 'allow_always' : 'reject_always';
      const opt = req.options.find(o => o.kind === wantKind) || req.options.find(o => o.kind === fallbackKind) || req.options[0];
      if (!opt) return false;
      respond(req.id, { outcome: { outcome: 'selected', optionId: opt.optionId } });
      emitter.emit('approval', { type: 'approval-decision', requestId: String(requestId), decision });
      return true;
    },
    cancelApprovals(reason) {
      pendingApprovals.forEach((req, requestId) => {
        respond(req.id, { outcome: { outcome: 'cancelled' } });
        emitter.emit('approval', { type: 'approval-timeout', requestId, decision: 'deny' });
      });
      pendingApprovals = new Map();
      if (reason) say('pending approvals declined: ' + reason);
    },

    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

// One-shot ACP prompt for callers that just want text back (meetingAnalyze.js's Copilot analysis
// backend) -- no panel state, no interactive approvals. allow_all is set BEFORE the turn starts and
// AWAITED (not fire-and-forget like the interactive adapter) so a batch job can never wedge waiting
// on an approval overlay that doesn't exist here; any request that arrives anyway is still
// auto-approved as a fallback. Caller does its own findCopilotExe() presence check first (same
// division of labor as meetingAnalyze.js's runClaude/runCodex).
function runCopilotBatchPrompt({ cwd, text, model, timeoutMs, log, spawn }) {
  const say = log || (() => {});
  const spawnImpl = spawn || childProcess.spawn;
  const resolvedCwd = cwd || process.cwd();
  return new Promise((resolve, reject) => {
    let settled = false;
    let proc;
    const timer = setTimeout(() => finish(reject, new Error('timed out after ' + Math.round((timeoutMs || 600000) / 60000) + ' min')), timeoutMs || 600000);
    if (timer.unref) timer.unref();
    function finish(fn, v) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.stdin.end(); } catch (e) {}
      const killTimer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 500);
      if (killTimer.unref) killTimer.unref();
      fn(v);
    }
    proc = spawnImpl('copilot', ['--acp'], { cwd: resolvedCwd, stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true });
    let nextId = 0;
    const pending = new Map();
    function send(method, params) {
      const id = ++nextId;
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        try { proc.stdin.write(line + '\n'); } catch (e) { pending.delete(id); rej(e); }
      });
    }
    function respond(id, result) { try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch (e) {} }
    let turnText = '';
    let lastStderr = '';
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      let m; try { m = JSON.parse(line); } catch (e) { return; }
      if (m.id != null && !m.method) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
        else p.resolve(m.result);
        return;
      }
      if (m.id != null && m.method) {
        // Fallback only -- the awaited allow_all set below should suppress these in practice.
        if (m.method === 'session/request_permission') {
          const opts = (m.params && m.params.options) || [];
          const opt = opts.find(o => o.kind === 'allow_always') || opts.find(o => o.kind === 'allow_once');
          respond(m.id, { outcome: opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } });
          return;
        }
        respond(m.id, {});
        return;
      }
      if (m.method === 'session/update') {
        const update = (m.params || {}).update || {};
        if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') turnText += update.content.text;
      }
    });
    proc.stderr.on('data', b => { lastStderr = String(b).trim().slice(0, 400); });
    proc.on('error', e => finish(reject, new Error('spawn failed: ' + e.message)));
    proc.on('exit', code => {
      if (settled) return;
      finish(reject, new Error('copilot exited' + (code == null ? '' : ' (code ' + code + ')') + (lastStderr ? ': ' + lastStderr : '')));
    });

    send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
      .then(() => send('session/new', { cwd: resolvedCwd, mcpServers: [] }))
      .then(result => {
        const sessionId = result && result.sessionId;
        if (!sessionId) throw new Error('no session id in session/new response');
        return send('session/set_config_option', { sessionId, configId: 'allow_all', type: 'value_id', value: 'on' })
          .catch(e => say('allow_all set failed (falling back to per-request auto-approve): ' + e.message))
          .then(() => (model ? send('session/set_config_option', { sessionId, configId: 'model', type: 'value_id', value: model }).catch(e => say('model set failed: ' + e.message)) : null))
          .then(() => sessionId);
      })
      .then(sessionId => send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }))
      .then(result => {
        const stop = (result && result.stopReason) || 'end_turn';
        if (stop === 'refusal') { finish(reject, new Error('Copilot refused the request')); return; }
        finish(resolve, turnText);
      })
      .catch(e => finish(reject, e instanceof Error ? e : new Error(String(e))));
  });
}

module.exports = { createCopilotVoiceAdapter, findCopilotExe, runCopilotBatchPrompt };
