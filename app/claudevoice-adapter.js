'use strict';
// Claude Code session ADAPTER for the generic voice-panel host (voicepanel-host.js). Everything
// Claude-CLI-specific that used to live inline in main.js is here, verbatim: the persistent
// stream-json child (claudevoice-session.js), the stream-json -> normalized-event translation,
// the PreToolUse approval hook lifecycle (claudevoice-approvals.js, untouched), the permission
// modes and model aliases, and the voice/user prompt assembly. The host consumes only the
// normalized adapter contract documented in voicepanel-host.js -- a codex adapter implements the
// same contract against `codex app-server` without any of the hook machinery.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createClaudeVoiceSession } = require('./claudevoice-session');
const claudeVoiceApprovals = require('./claudevoice-approvals');

// Mid-session permission-mode switch (panel Mode button): restart the claude process with --resume
// against the same session id + the new --permission-mode flag. The documented path -- mode is a
// launch-only CLI flag, and the mid-session control message is explicitly undocumented/unsupported.
const CLAUDE_VOICE_MODES = ['manual', 'acceptEdits', 'plan', 'bypassPermissions'];
const CLAUDE_VOICE_MODE_LABELS = { manual: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', bypassPermissions: 'Full auto' };
// Overlay descriptions, delivered to the page via /state meta (the page has matching fallbacks).
const CLAUDE_VOICE_MODE_DESCS = {
  manual: 'Ask before every action (touch approval)',
  acceptEdits: 'File changes auto-approved',
  plan: "Describe, don't act, until approved",
  bypassPermissions: 'No prompts at all — use with care',
};
const CLAUDE_VOICE_MODEL_LABELS = { '': 'Default (account setting)', fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
// Model aliases the panel may pick ('' = account default, no --model flag). Aliases only, never
// full model ids: aliases track "latest of the family" and can't go stale. All four verified
// accepted by the installed CLI (2.1.228) -- an invalid --model would crash-loop the child.
const CLAUDE_VOICE_MODEL_PICKS = ['', 'fable', 'opus', 'sonnet', 'haiku'];

// User-customizable panel prompt (task #25): a real file in the app's data folder, appended to the
// bundled voice prompt on every session spawn. APPEND, not replace -- the bundled prompt carries
// load-bearing voice behavior, and appended text comes later so the user's instructions win any
// conflict in practice. The seeded template is entirely HTML comments, so it adds nothing until
// actually edited; comments are stripped before the prompt is sent.
const CLAUDE_VOICE_USER_PROMPT_TEMPLATE = `<!--
open-quake Claude voice panel: your custom instructions.

Anything OUTSIDE comment markers like these is appended to the panel session's
system prompt, after open-quake's built-in voice-behavior prompt. Typical uses:
tone, language, brevity rules ("answer in one sentence unless asked"), context
about you or your setup.

Changes apply the next time a panel session STARTS -- a folder switch or an
app restart. (Mode/model switches keep the running session's prompt.) This
file never affects terminal or desktop Claude Code sessions -- only the
open-quake panel.
-->
`;

function createClaudeVoiceAdapter({ getServerPort, getUserDataPath, log }) {
  const say = log || (() => {});
  const emitter = new EventEmitter();
  const session = createClaudeVoiceSession({ log: say });
  // Per-boot random token, handed to the `claude` process via env and echoed back by the PreToolUse
  // hook (Phase 7) so sysserver.js can tell a legitimate hook request from anything else that might
  // guess the loopback port -- the hook has no Origin/Sec-Fetch-Site header to check instead.
  const token = crypto.randomBytes(24).toString('hex');
  // Pending PreToolUse approval requests from the hook (see claudevoice-approvals.js). onChange is
  // forwarded as normalized events; the host drives the SSE broadcast and the ring from them.
  const approvalManager = claudeVoiceApprovals.createApprovalManager({
    onChange: evt => emitter.emit('approval', evt),
  });

  session.on('event', event => {
    if (event.type === 'system' && event.subtype === 'init') {
      // Init reports the model that's ACTUALLY running -- the panel displays this, never the pick.
      emitter.emit('model', { model: event.model || '' });
      return;
    }
    if (event.type === 'stream_event' && event.event) {
      const se = event.event;
      if (se.type === 'message_start') {
        emitter.emit('assistant-start');
      } else if (se.type === 'content_block_delta' && se.delta && se.delta.type === 'text_delta' && se.delta.text) {
        emitter.emit('assistant-delta', { text: se.delta.text });
      }
      return;
    }
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      // Authoritative complete text for this message (stream_event deltas already pushed it live) --
      // used as the fallback if a client only ever polls the /state snapshot and never opens SSE.
      const text = event.message.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
      if (text) emitter.emit('assistant-final', { text });
      return;
    }
    if (event.type === 'result') {
      emitter.emit('turn-complete', {
        text: typeof event.result === 'string' ? event.result : null,
        error: event.is_error ? (event.result || 'error') : null,
      });
      return;
    }
  });
  session.on('error', e => emitter.emit('error', { message: (e && e.message) || 'error' }));
  session.on('exit', () => {
    // A mode switch swaps the child intentionally (isRunning() is already true again by the time the
    // old process's exit event lands) -- only a real crash, with nothing running, should cut speech.
    emitter.emit('exit', { stillRunning: session.isRunning() });
  });

  let currentProfilePrompt = '';   // the active AI profile's instruction; folded into the system prompt

  // Bundled voice prompt + the user's panel prompt file + the active AI profile, in that order.
  function assembleSystemPrompt() {
    let voicePrompt = '';
    try { voicePrompt = fs.readFileSync(path.join(__dirname, 'claudevoice-voice-prompt.md'), 'utf8'); }
    catch (e) { say('voice prompt not loaded: ' + e.message); }
    try {
      const userPrompt = readUserPrompt();
      if (userPrompt) voicePrompt += (voicePrompt ? '\n\n' : '') + userPrompt;
    } catch (e) { say('panel prompt file not loaded: ' + e.message); }
    if (currentProfilePrompt) voicePrompt += (voicePrompt ? '\n\n' : '') + currentProfilePrompt;
    return voicePrompt;
  }

  function userPromptPath() { return path.join(getUserDataPath(), 'claude-panel-prompt.md'); }
  function ensureUserPromptFile() {
    const p = userPromptPath();
    if (!fs.existsSync(p)) fs.writeFileSync(p, CLAUDE_VOICE_USER_PROMPT_TEMPLATE, 'utf8');
    return p;
  }
  function readUserPrompt() {
    const raw = fs.readFileSync(ensureUserPromptFile(), 'utf8');
    return raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  }

  return {
    // ---- lifecycle ----
    // `approvalsEnabled` comes from the app options: the global PreToolUse hook is synced on every
    // session start rather than on checkbox change -- app options save through the generic grid-
    // config path with no per-option event, and re-syncing here is idempotent. A toggle takes
    // effect the next time a session starts.
    start({ projectDir, mode, model, approvalsEnabled, profilePrompt }) {
      try {
        if (approvalsEnabled) claudeVoiceApprovals.ensureHookInstalled(getUserDataPath(), say);
        else claudeVoiceApprovals.ensureHookRemoved(say);
      } catch (e) { say('hook sync failed: ' + e.message); }
      currentProfilePrompt = String(profilePrompt || '');
      session.start({
        projectDir,
        permissionMode: mode || 'manual',   // fail safe: ask, never bypass
        model: CLAUDE_VOICE_MODEL_PICKS.includes(model) ? model : '',
        port: getServerPort(),
        token,
        systemPrompt: assembleSystemPrompt(),
      });
      return true;
    },
    // AI profile switch: the CLI only reads its system prompt at launch, so a live switch swaps
    // the child and resumes the conversation (the Mode/Model button mechanic). Not running -> just
    // remember it for the next start.
    setProfilePrompt(text) {
      currentProfilePrompt = String(text || '');
      if (!session.isRunning()) return true;
      return session.setSystemPromptAppend(assembleSystemPrompt());
    },
    stop() {
      session.stop();
      approvalManager.cancelAll('Session ended.');   // don't leave the hook's HTTP request hanging on a dead session
      // Take the global PreToolUse hook back out now the panel is done with it. It lives in the user's
      // one machine-wide ~/.claude/settings.json, so for as long as it's installed EVERY Claude Code
      // surface on this box spawns a node process before every tool call just to be told "not a panel
      // session, carry on". Install-on-start/remove-on-stop keeps that cost inside the window where
      // the panel actually needs approvals.
      try { claudeVoiceApprovals.ensureHookRemoved(say); } catch (e) { say('hook removal failed: ' + e.message); }
    },
    sendTurn(text) { return session.sendTurn(text); },
    isRunning() { return session.isRunning(); },
    sessionId() { return session.sessionId(); },
    projectDir() { return session.projectDir(); },
    interrupt() { return false; },   // no mid-turn interrupt on the claude CLI; barge-in = the TTS socket close

    // ---- permission mode ----
    setMode(mode) {
      if (!CLAUDE_VOICE_MODES.includes(mode)) return false;
      if (!session.isRunning()) return false;
      return session.setPermissionMode(mode);
    },
    mode() { return session.permissionMode(); },
    listModes() { return CLAUDE_VOICE_MODES.map(id => ({ id, label: CLAUDE_VOICE_MODE_LABELS[id] || id, desc: CLAUDE_VOICE_MODE_DESCS[id] || '' })); },

    // ---- model ----
    // With no session running a valid pick is still a success -- it persists via the modelPick
    // option and the next session start picks it up.
    setModel(model) {
      if (!CLAUDE_VOICE_MODEL_PICKS.includes(model)) return false;
      if (!session.isRunning()) return true;
      return session.setModel(model);
    },
    currentModel() { return session.currentModel(); },
    validModel(model) { return CLAUDE_VOICE_MODEL_PICKS.includes(model); },
    listModels() { return CLAUDE_VOICE_MODEL_PICKS.map(id => ({ id, label: CLAUDE_VOICE_MODEL_LABELS[id] || id })); },

    // ---- approvals (hook-based; claude-only surface) ----
    decideApproval(requestId, decision) { return approvalManager.decide(requestId, decision); },
    handleHookRequest(body, res) { approvalManager.request(body || {}, res); },
    cancelApprovals(reason) { approvalManager.cancelAll(reason); },
    hookToken() { return token; },   // sysserver gates /approval-request on this per-boot secret

    // ---- user prompt file (the editor's "Edit prompt file" button) ----
    ensureUserPromptFile,

    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

module.exports = { createClaudeVoiceAdapter };
