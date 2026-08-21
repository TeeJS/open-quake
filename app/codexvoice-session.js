'use strict';
// OpenAI Codex session ADAPTER for the generic voice-panel host (voicepanel-host.js) -- the codex
// counterpart of claudevoice-adapter.js, speaking `codex app-server`'s bidirectional JSON-RPC over
// stdio (JSONL; the `jsonrpc` header is omitted on this wire). Protocol verified live against the
// installed codex-cli 0.128.0 (see docs/codex-voice.md): initialize -> thread/start|resume ->
// turn/start, with item/agentMessage/delta streaming text, item/completed carrying the
// authoritative message text, and turn/completed closing the turn. Approvals arrive as
// server-initiated REQUESTS on the same pipe (Phase 6) -- no external hook, no settings.json
// mutation, which is why this adapter has no hook lifecycle at all.
//
// Phase 4 scope: text-only turns, readOnly mode preset locked (approvalPolicy 'never' + sandbox
// 'read-only'), no model picking (account default). Modes/models/approvals expand in later phases.

const childProcess = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

let cachedCodexExe;   // undefined = not looked up yet · null = not found · string = resolved path

// PATH lookup, same discipline as claudevoice-session's findClaudeExe. The resolved path is only
// used as an existence/version check -- the spawn goes through the shell because npm installs
// `codex` as a .cmd shim on Windows.
function findCodexExe(execFileSync) {
  if (cachedCodexExe !== undefined) return cachedCodexExe;
  const run = execFileSync || childProcess.execFileSync;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = run(cmd, ['codex'], { windowsHide: true }).toString();
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    cachedCodexExe = first || null;
  } catch (e) { cachedCodexExe = null; }
  return cachedCodexExe;
}

// Mode presets pair codex's two knobs (approval policy + sandbox) into the single mode id the
// panel's Mode overlay works with. Phase 4 exposes ONLY readOnly -- the others need the approval
// flow (Phase 6) before they are safe to offer on the panel.
// EXACT mirror of the four permission modes the INSTALLED CLI's own menu offers (verified against
// the running binary, not repo archaeology: permissionProfile/list gives the three sandbox
// profiles, and "Approve for me" is the same workspace profile with approvals routed to the
// auto_review subagent -- ApprovalsReviewer enum, which only escalates actions it judges unsafe).
// Labels and descriptions verbatim from the TUI's Update Model Permissions menu. Read Only pairs
// with ON-REQUEST so codex asks to escalate instead of dead-ending when its (Windows-broken)
// sandbox blocks a command. Each preset carries both sandbox param forms: `sandbox` (SandboxMode
// string, thread/start) and `sandboxPolicy` (object, turn/start overrides).
const CODEX_MODE_PRESETS = {
  'read-only': {
    label: 'Read Only',
    desc: 'Codex can read files in the current workspace. Approval is required to edit files or access the internet.',
    approvalPolicy: 'on-request', reviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' },
  },
  'ask-for-approval': {
    label: 'Ask for approval',
    desc: 'Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.',
    approvalPolicy: 'on-request', reviewer: 'user', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' },
  },
  'approve-for-me': {
    label: 'Approve for me',
    desc: 'Only ask for actions detected as potentially unsafe.',
    approvalPolicy: 'on-request', reviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' },
  },
  'full-access': {
    label: 'Full Access',
    desc: 'Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.',
    approvalPolicy: 'never', reviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' },
  },
};
const CODEX_DEFAULT_MODE = 'ask-for-approval';   // "(current)" in the CLI's own menu
// Panel options saved under this app's earlier preset ids keep working.
const CODEX_LEGACY_MODES = { readOnly: 'read-only', manual: 'ask-for-approval', auto: 'ask-for-approval', full: 'full-access' };

// Server chatter that is expected and carries nothing the panel needs (Phase 4).
const IGNORED_NOTIFICATIONS = new Set([
  'remoteControl/status/changed', 'mcpServer/startupStatus/updated', 'account/rateLimits/updated',
  'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'model/rerouted',
]);

function createCodexVoiceAdapter({ log }) {
  const say = log || (() => {});
  const emitter = new EventEmitter();

  let proc = null;
  let nextId = 0;
  let pending = new Map();      // request id -> {resolve, reject}
  let queuedTurns = [];         // sendTurn() calls made before the thread handshake finished
  let profilePrompt = '';       // active AI profile instruction (no protocol slot -> first-turn prefix)
  let profileInjectPending = false;   // true = the next turn carries the profile prefix
  let threadId = null;
  let resumeThreadId = null;    // survive an adapter restart with the conversation intact
  let activeTurnId = null;
  let projectDir = null;
  let mode = CODEX_DEFAULT_MODE;
  let ready = false;            // initialize + thread/start round trips are done
  let turnText = '';            // accumulated deltas for the current turn
  let finalText = null;         // authoritative text from item/completed(agentMessage)
  let lastStderr = '';          // only surfaced when a handshake fails, else stderr is log noise
  let pendingApprovals = new Map();   // requestId(string) -> {id, method} awaiting a panel decision
  let fileChangeItems = new Map();    // itemId -> item, so a fileChange approval can show WHAT changes (capped)
  let modelPick = '';                 // '' = account default; otherwise a Model.model slug, sent per turn
  let modelList = [];                 // discovered via model/list after each handshake

  function send(method, params) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) return Promise.reject(new Error('codex app-server not running'));
    const id = ++nextId;
    const line = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { proc.stdin.write(line + '\n'); } catch (e) { pending.delete(id); reject(e); }
    });
  }
  function respond(id, result) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;
    try { proc.stdin.write(JSON.stringify({ id, result }) + '\n'); } catch (e) {}
  }

  // Retire the current process: null out `proc` FIRST so every handler still attached to the old
  // process (line/exit/stderr) sees itself as stale and stands down -- the folder-switch race where
  // the OLD process's exit event shot down the NEW process's in-flight handshake lived here.
  // Shutdown is stdin-EOF first (the stdio transport's clean exit, which takes the whole shell
  // tree with it), hard kill only as a fallback -- same discipline as claudevoice-session.
  function stopProc(reason) {
    const old = proc;
    proc = null;
    ready = false;
    pending.forEach(p => p.reject(new Error(reason || 'codex app-server stopped')));
    pending = new Map();
    // A dying process invalidates its held-open approval requests; tell the panel so the overlay
    // never sits waiting on a request nobody can answer anymore.
    pendingApprovals.forEach((entry, requestId) => {
      emitter.emit('approval', { type: 'approval-timeout', requestId, decision: 'deny' });
    });
    pendingApprovals = new Map();
    fileChangeItems = new Map();
    if (!old) return;
    try { old.stdin.end(); } catch (e) {}
    const killTimer = setTimeout(() => { try { old.kill(); } catch (e) {} }, 1000);
    if (killTimer.unref) killTimer.unref();
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
    // Server-initiated REQUEST (has both id and method) -- the approval surface, verified against
    // the 0.128.0 protocol schema. Command and file-change approvals go to the panel overlay;
    // everything else fails closed (same posture as the claude hook's timeout).
    if (m.id != null && m.method) {
      const p = m.params || {};
      if (m.method === 'item/commandExecution/requestApproval') {
        const requestId = String(m.id);
        pendingApprovals.set(requestId, { id: m.id, method: m.method });
        emitter.emit('approval', {
          type: 'approval-request', requestId,
          toolName: 'Run command',
          toolInput: { command: p.command || '(command unavailable)', path: p.cwd || undefined, reason: p.reason || undefined },
        });
        return;
      }
      if (m.method === 'item/fileChange/requestApproval') {
        const requestId = String(m.id);
        pendingApprovals.set(requestId, { id: m.id, method: m.method });
        // The request itself carries no diff -- the change detail lives in the fileChange ITEM
        // streamed just before it. Best effort: show the stashed item, else reason/grantRoot.
        const item = p.itemId != null ? fileChangeItems.get(p.itemId) : null;
        emitter.emit('approval', {
          type: 'approval-request', requestId,
          toolName: 'Change files',
          toolInput: item || { reason: p.reason || 'File changes in the working folder', grantRoot: p.grantRoot || undefined },
        });
        return;
      }
      if (m.method === 'item/permissions/requestApproval') {
        // Response shape is a granted-permission PROFILE, not accept/decline -- an empty grant is
        // the schema-valid "no" (no required props). Interactive support is a future item; rare.
        say('permissions request auto-denied (empty grant): ' + JSON.stringify(p.reason || p.permissions || {}).slice(0, 200));
        respond(m.id, { permissions: {} });
        return;
      }
      say('unexpected server request ' + m.method + ' declined');
      respond(m.id, { decision: 'decline' });
      return;
    }
    // Notification.
    const method = m.method || '';
    const params = m.params || {};
    if (IGNORED_NOTIFICATIONS.has(method)) return;
    if (method === 'turn/started') {
      activeTurnId = (params.turn && params.turn.id) || activeTurnId;
      turnText = '';
      finalText = null;
      emitter.emit('assistant-start');
      return;
    }
    if (method === 'item/agentMessage/delta') {
      if (typeof params.delta === 'string' && params.delta) {
        turnText += params.delta;
        emitter.emit('assistant-delta', { text: params.delta });
      }
      return;
    }
    if (method === 'item/started' || method === 'item/updated') {
      const item = params.item || {};
      // Stash fileChange items so a subsequent approval request can show WHAT is changing.
      if (item.type === 'fileChange' && item.id != null) {
        fileChangeItems.set(item.id, item);
        while (fileChangeItems.size > 8) fileChangeItems.delete(fileChangeItems.keys().next().value);
      }
      // A SECOND agentMessage in the same turn (text -> tool/approval -> more text) needs a break,
      // or the two messages' deltas jam together mid-word in the transcript and the speech.
      if (method === 'item/started' && item.type === 'agentMessage' && turnText && !/\n$/.test(turnText)) {
        turnText += '\n\n';
        emitter.emit('assistant-delta', { text: '\n\n' });
      }
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        finalText = item.text;   // authoritative full text for this message
        emitter.emit('assistant-final', { text: item.text });
      }
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn || {};
      activeTurnId = null;
      const err = turn.error ? (turn.error.message || String(turn.error)) : null;
      // Authoritative text = the ACCUMULATED deltas: a turn with tool work (e.g. an approval)
      // produces multiple agentMessages, and item/completed only carries the LAST one -- using it
      // alone discarded everything said before the approval ("approvals are cutting off
      // responses", hardware-reported). turnText spans every message of the turn.
      emitter.emit('turn-complete', { text: turnText || finalText || null, error: err });
      return;
    }
    if (method === 'error') {
      // Per the schema this carries {error, threadId, turnId, willRetry}; only terminal ones matter.
      if (!params.willRetry) emitter.emit('error', { message: (params.error && params.error.message) || 'codex error' });
      return;
    }
  }

  function launch({ cwd, model }) {
    ready = false;
    // npm's codex shim is a .cmd on Windows -- shell:true is what makes this spawn portable.
    // Resolved path (quoted for the shell), never the bare name: with shell:true and an untrusted
    // project folder as cwd, cmd.exe would run a codex.cmd planted in that folder ahead of PATH.
    proc = childProcess.spawn('"' + (findCodexExe() || 'codex') + '"', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true });
    const thisProc = proc;
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', line => {
      if (proc !== thisProc) return;   // buffered output from a replaced process must not touch live state
      if (!line.trim()) return;
      let m; try { m = JSON.parse(line); } catch (e) { return; }
      try { handleMessage(m); } catch (e) { say('event handling failed: ' + e.message); }
    });
    thisProc.stderr.on('data', b => { if (proc === thisProc) lastStderr = String(b).trim().slice(0, 400); });   // codex logs freely here; kept for error surfacing only
    thisProc.on('error', e => {
      if (proc !== thisProc) return;
      say('codex spawn error: ' + e.message);
      emitter.emit('error', { message: 'codex CLI failed to start: ' + e.message });
    });
    thisProc.on('exit', code => {
      if (proc !== thisProc) return;   // intentionally replaced/stopped: stopProc() already cleaned up
      proc = null;
      ready = false;
      pending.forEach(p => p.reject(new Error('codex app-server exited')));
      pending = new Map();
      say('codex app-server exited' + (code == null ? '' : ' (code ' + code + ')'));
      resumeThreadId = threadId || resumeThreadId;   // next start() resumes the conversation
      emitter.emit('exit', { stillRunning: false });
    });
    // Handshake: initialize, then start (or resume) the thread. sendTurn() calls queue until this
    // finishes -- the host's lazy-start-then-send flow stays synchronous from its point of view.
    // Deadline: a wedged handshake (seen live: codex hung on thread/start during a model-registry
    // hiccup) must surface as a panel error, never an eternal silent "thinking".
    const handshakeDeadline = setTimeout(() => {
      if (proc === thisProc && !ready) {
        say('handshake timed out; stopping the app-server');
        stopProc('handshake timed out');
        emitter.emit('error', { message: 'Codex session failed to start: timed out — try switching folders to retry.' });
      }
    }, 30000);
    if (handshakeDeadline.unref) handshakeDeadline.unref();
    const preset = CODEX_MODE_PRESETS[mode] || CODEX_MODE_PRESETS[CODEX_DEFAULT_MODE];
    // experimentalApi unlocks the granular approval policy the Auto preset needs (0.147 gates it
    // behind this capability; verified live: without it turn/start rejects granular outright).
    send('initialize', { clientInfo: { name: 'open-quake', version: '0' }, capabilities: { experimentalApi: true } })
      .then(() => {
        // Required by the protocol contract (MCP-style two-step): acknowledge before anything else.
        try { thisProc.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n'); } catch (e) {}
        if (resumeThreadId) return send('thread/resume', { threadId: resumeThreadId, cwd, approvalPolicy: preset.approvalPolicy, approvalsReviewer: preset.reviewer, sandbox: preset.sandbox });
        return send('thread/start', { cwd, approvalPolicy: preset.approvalPolicy, approvalsReviewer: preset.reviewer, sandbox: preset.sandbox, model: model || null });
      })
      .then(result => {
        clearTimeout(handshakeDeadline);
        threadId = (result && result.thread && result.thread.id) || (result && result.threadId) || null;
        resumeThreadId = null;
        if (!threadId) throw new Error('no thread id in thread/start response');
        ready = true;
        say('codex thread ' + threadId + ' ready (' + mode + ')');
        // Model discovery (best effort): feeds the panel's model picker and the "what's actually
        // running" display. Failure just leaves the picker at "Default".
        send('model/list', {})
          .then(r => {
            modelList = ((r && r.data) || []).filter(m => m && !m.hidden && m.model);
            const def = modelList.find(m => m.isDefault);
            emitter.emit('model', { model: modelPick || (def ? def.model : '') });
            emitter.emit('models-changed', {});
            say('model/list: ' + modelList.length + ' models' + (def ? ', default ' + def.model : ''));
          })
          .catch(e => say('model/list failed (picker stays at Default): ' + e.message));
        const q = queuedTurns; queuedTurns = [];
        q.forEach(text => startTurn(text));
      })
      .catch(e => {
        say('codex handshake failed: ' + e.message + (lastStderr ? ' | stderr: ' + lastStderr : ''));
        emitter.emit('error', { message: 'Codex session failed to start: ' + e.message });
      });
  }

  function isValidModel(pick) {
    if (pick === '') return true;
    if (!modelList.length) return typeof pick === 'string' && pick.length <= 64;   // discovery pending: be lenient, codex validates at turn time
    return modelList.some(m => m.model === pick);
  }

  function startTurn(text) {
    // AI profile: codex's protocol has no instructions slot, so the profile rides as a prefix on
    // the FIRST turn after a session start or profile switch (LucidType's combined-prompt trick).
    // The transcript shows the user's own words — the host records the unprefixed text.
    if (profileInjectPending && profilePrompt) {
      text = '[Instructions for this conversation — follow them in every reply]\n' + profilePrompt + '\n[End of instructions]\n\n' + text;
      profileInjectPending = false;
    }
    // The host serializes turns (CLI semantics: one in flight, later entries queue), so a
    // concurrent turn/start can't happen. turn/interrupt stays available via interrupt() for an
    // explicit Stop control someday -- it is deliberately NOT wired to new turns or mute.
    // The current mode preset rides on EVERY turn: turn-level overrides are the only mechanism
    // that reliably re-arms a live session's policy (thread/resume ignores them once loaded).
    const preset = CODEX_MODE_PRESETS[mode] || CODEX_MODE_PRESETS[CODEX_DEFAULT_MODE];
    send('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      approvalPolicy: preset.approvalPolicy,
      approvalsReviewer: preset.reviewer,
      sandboxPolicy: preset.sandboxPolicy,
      model: modelPick || null,   // null = the account default
    })
      .then(result => { activeTurnId = (result && result.turn && result.turn.id) || activeTurnId; })
      .catch(e => {
        say('turn/start rejected: ' + e.message);   // surfaced to the panel too, but the log is where diagnosis starts
        emitter.emit('turn-complete', { text: null, error: 'turn failed to start: ' + e.message });
      });
  }

  return {
    // ---- lifecycle (host adapter contract; see voicepanel-host.js header) ----
    start({ projectDir: dir, mode: pick, model, profilePrompt: pp }) {
      if (!findCodexExe()) {
        say('codex CLI not found on PATH');
        emitter.emit('error', { message: 'codex CLI not found on PATH' });
        return false;
      }
      stopProc('superseded by a new session');
      profilePrompt = String(pp || '');
      profileInjectPending = !!profilePrompt;
      projectDir = dir;
      pick = CODEX_LEGACY_MODES[pick] || pick;   // earlier panel builds saved different preset ids
      mode = CODEX_MODE_PRESETS[pick] ? pick : CODEX_DEFAULT_MODE;
      threadId = null;
      resumeThreadId = null;   // a fresh start (e.g. folder switch) is a NEW conversation, never a resume of the old folder's
      queuedTurns = [];
      launch({ cwd: dir, model: model || null });
      return true;
    },
    stop() {
      queuedTurns = [];
      resumeThreadId = null;
      threadId = null;
      stopProc('session stopped');
    },
    sendTurn(text) {
      if (!proc) return false;
      if (!ready) { queuedTurns.push(text); return true; }   // handshake still in flight
      startTurn(text);
      return true;
    },
    // AI profile switch mid-session: the new instruction rides on the next turn.
    setProfilePrompt(text) { profilePrompt = String(text || ''); profileInjectPending = !!profilePrompt; return true; },
    isRunning() { return !!proc; },
    sessionId() { return threadId; },
    projectDir() { return projectDir; },
    interrupt() {
      if (!ready || !threadId || !activeTurnId) return false;
      send('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {});
      return true;
    },

    // ---- mode: presets pair approvalPolicy + sandbox. Switching just updates the stored preset;
    // startTurn() sends it as turn-level overrides, which is the mechanism that actually applies
    // to a live session (thread/resume policy params are ignored once a thread is loaded). ----
    setMode(pick) {
      if (!CODEX_MODE_PRESETS[pick]) return false;
      // No session yet -> refuse, same as the claude adapter: a pre-session pick would only be
      // clobbered by the lazy start applying the editor-configured mode (hardware-verified
      // confusion: "switched to auto, asked a question, panel is back to manual"). The page
      // already shows "send a message first" for this.
      if (!proc) return false;
      if (pick !== mode) {
        mode = pick;
        say('mode -> ' + pick + ' (applies from the next turn)');
      }
      return true;
    },
    mode() { return mode; },
    listModes() {
      return Object.entries(CODEX_MODE_PRESETS).map(([id, p]) => ({ id, label: p.label, desc: p.desc }));
    },

    // ---- model: discovered via model/list, applied as a per-turn override (same mechanism as
    // the mode presets -- takes effect from the next message, no restart) ----
    setModel(pick) {
      if (!isValidModel(pick)) return false;
      modelPick = pick;
      const def = modelList.find(m => m.isDefault);
      emitter.emit('model', { model: modelPick || (def ? def.model : '') });
      return true;
    },
    currentModel() {
      if (modelPick) return modelPick;
      const def = modelList.find(m => m.isDefault);
      return def ? def.model : null;
    },
    validModel(pick) { return isValidModel(pick); },
    listModels() {
      return [{ id: '', label: 'Default (account setting)' }]
        .concat(modelList.map(m => ({ id: m.model, label: (m.displayName || m.model) + (m.isDefault ? ' — default' : '') })));
    },

    // ---- approvals (in-band JSON-RPC responses; no external hook, no settings.json) ----
    supportsAlwaysApproval: true,   // acceptForSession: approve + stop asking for similar requests this session
    decideApproval(requestId, decision) {
      const pending = pendingApprovals.get(String(requestId));
      if (!pending) return false;
      pendingApprovals.delete(String(requestId));
      const wire = decision === 'always' ? 'acceptForSession' : decision === 'allow' ? 'accept' : 'decline';
      respond(pending.id, { decision: wire });
      emitter.emit('approval', { type: 'approval-decision', requestId: String(requestId), decision });
      return true;
    },
    cancelApprovals(reason) {
      pendingApprovals.forEach((pending, requestId) => {
        respond(pending.id, { decision: 'decline' });
        emitter.emit('approval', { type: 'approval-timeout', requestId, decision: 'deny' });
      });
      pendingApprovals = new Map();
      if (reason) say('pending approvals declined: ' + reason);
    },

    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

module.exports = { createCodexVoiceAdapter, findCodexExe };
