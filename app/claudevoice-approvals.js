'use strict';
// MAIN PROCESS. Two responsibilities:
//  1. Idempotently install/remove the global PreToolUse hook in ~/.claude/settings.json (the one
//     file everywhere Claude Code reads it, for every project) -- gated entirely on the app's own
//     "Touch approval when in Manual mode" option (see apps.json), never touched otherwise.
//  2. Track in-flight approval requests (long-polled HTTP responses held open by sysserver.js) and
//     resolve them when the panel taps Approve/Deny.
const fs = require('fs');
const path = require('path');
const os = require('os');
const HOOK_SOURCE = require('./claudevoice-hook-source');

const HOOK_FILENAME = 'quake-approval-hook.js';
// Identifies our own hooks.PreToolUse entries in the user's global settings.json so install/remove
// only ever touch entries we created -- any other hook the user (or another tool) has registered is
// left completely alone.
const MARKER = HOOK_FILENAME;

function hookScriptPath(userDataDir) { return path.join(userDataDir, HOOK_FILENAME); }

function ensureHookFileWritten(userDataDir, log) {
  const dest = hookScriptPath(userDataDir);
  try {
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    if (existing !== HOOK_SOURCE) fs.writeFileSync(dest, HOOK_SOURCE, 'utf8');
  } catch (e) { (log || (() => {}))('claude-voice: failed to write hook script: ' + e.message); }
  return dest;
}

function claudeSettingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }

// Global CLAUDE.md rule: back up before changing any config outside a git repo. ~/.claude/settings.json
// is the user's real global Claude Code config -- not part of this repo -- so every write here is
// preceded by a timestamped copy alongside it.
function backupSettings(settingsPath, log) {
  try {
    if (!fs.existsSync(settingsPath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(settingsPath, settingsPath + '.bak-' + stamp);
  } catch (e) { (log || (() => {}))('claude-voice: settings.json backup failed: ' + e.message); }
}

function readSettings(settingsPath) {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) { return {}; }
}

function hookCommandFor(hookPath) { return 'node "' + hookPath + '"'; }

function hasOurEntry(preToolUse) {
  return preToolUse.some(entry => Array.isArray(entry.hooks) &&
    entry.hooks.some(h => h && typeof h.command === 'string' && h.command.indexOf(MARKER) !== -1));
}

// Idempotent: safe to call every time a voice session starts. Only appends our own entry, and only if
// an equivalent one (by MARKER) isn't already present -- never overwrites or reorders existing hooks.
function ensureHookInstalled(userDataDir, log) {
  const hookPath = ensureHookFileWritten(userDataDir, log);
  const settingsPath = claudeSettingsPath();
  const settings = readSettings(settingsPath);
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
  if (hasOurEntry(settings.hooks.PreToolUse)) return { changed: false, hookPath };
  settings.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: hookCommandFor(hookPath) }] });
  try { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); } catch (e) {}
  backupSettings(settingsPath, log);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  (log || (() => {}))('claude-voice: installed global PreToolUse hook in ' + settingsPath);
  return { changed: true, hookPath };
}

// Removes only entries matching our MARKER; leaves every other hook entry untouched.
function ensureHookRemoved(log) {
  const settingsPath = claudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return { changed: false };
  const settings = readSettings(settingsPath);
  if (!settings.hooks || !Array.isArray(settings.hooks.PreToolUse)) return { changed: false };
  const before = JSON.stringify(settings.hooks.PreToolUse);
  settings.hooks.PreToolUse = settings.hooks.PreToolUse
    .map(entry => Array.isArray(entry.hooks)
      ? Object.assign({}, entry, { hooks: entry.hooks.filter(h => !(h && typeof h.command === 'string' && h.command.indexOf(MARKER) !== -1)) })
      : entry)
    .filter(entry => !Array.isArray(entry.hooks) || entry.hooks.length > 0);
  if (JSON.stringify(settings.hooks.PreToolUse) === before) return { changed: false };
  backupSettings(settingsPath, log);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  (log || (() => {}))('claude-voice: removed global PreToolUse hook from ' + settingsPath);
  return { changed: true };
}

// ---- pending approval requests (in-memory, this run only -- a restart fails any still-open ones
// closed via cancelAll() rather than leaving a dangling long-poll) ----
function createApprovalManager(opts) {
  const o = opts || {};
  const onChange = o.onChange || (() => {});   // ({type, requestId, ...}) -> void -- caller broadcasts SSE + drives the ring
  const timeoutMs = o.timeoutMs || 585000;      // just under the hook's own 590s client timeout
  const pending = new Map();

  function respond(res, decision, reason) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
    } catch (e) {}
  }

  function request(body, res) {
    const requestId = body && body.requestId;
    if (!requestId || pending.has(requestId)) { try { res.writeHead(400); res.end(); } catch (e) {} return; }
    const entry = { res, toolName: body.toolName, toolInput: body.toolInput, sessionId: body.sessionId };
    entry.timer = setTimeout(() => {
      pending.delete(requestId);
      respond(entry.res, 'deny', 'Approval timed out waiting for a response on the panel.');
      onChange({ type: 'approval-timeout', requestId });
    }, timeoutMs);
    if (entry.timer.unref) entry.timer.unref();
    pending.set(requestId, entry);
    onChange({ type: 'approval-request', requestId, toolName: entry.toolName, toolInput: entry.toolInput });
  }

  function decide(requestId, decision) {
    const entry = pending.get(requestId);
    if (!entry || (decision !== 'allow' && decision !== 'deny')) return false;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    respond(entry.res, decision, decision === 'allow' ? 'Approved on the open-quake panel.' : 'Denied on the open-quake panel.');
    onChange({ type: 'approval-decision', requestId, decision });
    return true;
  }

  function pendingCount() { return pending.size; }
  function cancelAll(reason) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); respond(entry.res, 'deny', reason || 'Session ended.'); }
    pending.clear();
  }

  return { request, decide, pendingCount, cancelAll };
}

module.exports = { ensureHookInstalled, ensureHookRemoved, createApprovalManager, hookScriptPath, claudeSettingsPath };
