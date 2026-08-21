'use strict';
// Persistent Claude Code CLI process for the Claude Code voice+text panel app. Mirrors
// app/reservedDisplay.js's shape (spawn/readline-stdout/restart-on-crash/graceful-stop) but adapted
// for `claude -p --input-format stream-json --output-format stream-json`, which stays alive across
// multiple conversational turns fed over stdin (verified empirically: one process handled two
// sequential turns 8s apart with no respawn) rather than reservedDisplay's fixed no-arg helper.
//
// Real event shapes captured from a live `claude --verbose -p --input-format stream-json
// --output-format stream-json --include-partial-messages` run (docs don't fully spell these out):
//   {type:'system', subtype:'init', session_id, cwd, model, permissionMode, ...}   -- turn/session start
//   {type:'stream_event', event:{type:'message_start', message:{...}}}             -- assistant reply begins
//   {type:'stream_event', event:{type:'content_block_start', index,
//    content_block:{type:'text'|'tool_use', ...}}}                                 -- a content block begins
//   {type:'stream_event', event:{type:'content_block_delta', index,
//    delta:{type:'text_delta', text:'<chunk>'}}}                                   -- incremental text (Phase 2's
//                                                                                      real streaming source)
//   {type:'stream_event', event:{type:'content_block_stop'|'message_delta'|'message_stop', ...}}
//   {type:'assistant', message:{content:[{type:'text', text}, ...], ...}, ...}     -- the same reply, complete
//   {type:'system', subtype:'post_turn_summary', status_category, status_detail}   -- informational
//   {type:'result', subtype:'success'|..., result: '<final text>',
//    permission_denials:[...], is_error, ...}                                     -- turn complete, authoritative

const readline = require('readline');
const childProcess = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');

let cachedClaudeExe;   // undefined = not looked up yet · null = looked up, not found · string = resolved path

// Resolve the `claude` binary via PATH (where/which), cached. Mirrors app/ahk.js's findAhkExe()
// discipline -- claude has no fixed conventional install dir the way AutoHotkey does, so a plain
// PATH lookup is the right (and only sensible) approach.
function findClaudeExe(execFileSync) {
  if (cachedClaudeExe !== undefined) return cachedClaudeExe;
  const run = execFileSync || childProcess.execFileSync;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = run(cmd, ['claude'], { windowsHide: true }).toString();
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    cachedClaudeExe = first || null;
  } catch (e) { cachedClaudeExe = null; }
  return cachedClaudeExe;
}
function resetClaudeExeCache() { cachedClaudeExe = undefined; }

function createClaudeVoiceSession(options) {
  const opts = options || {};
  const spawn = opts.spawn || childProcess.spawn;
  const execFileSync = opts.execFileSync || childProcess.execFileSync;
  const log = opts.log || (() => {});
  const restartDelay = opts.restartDelay == null ? 1500 : opts.restartDelay;

  let child = null;
  let stopping = false;
  let restartTimer = null;
  let sessionId = null;
  let resumeSessionId = null;   // when set, launch() resumes this session instead of starting fresh
  let projectDir = null;
  let permissionMode = 'manual';   // fail safe: ask, never bypass
  let model = '';            // '' = account default (no --model flag); alias like 'sonnet' otherwise
  let currentModel = null;   // authoritative model id from the init event (what's ACTUALLY running)
  let voicePort = null;
  let voiceToken = null;
  let systemPromptAppend = '';   // voice-panel behavior prompt, injected on every spawn
  const emitter = new EventEmitter();

  function attachOutput(proc) {
    if (!proc.stdout) return;
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', line => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); }
      catch (e) { log('claude output (unparsed): ' + line.slice(0, 300)); return; }
      // The init event is authoritative for the session id -- on --resume the id normally carries
      // over, but if the CLI ever forks to a new one, tracking init keeps later resumes correct.
      // Same for the model: init reports what's ACTUALLY running (the panel shows this, not the pick).
      if (event.type === 'system' && event.subtype === 'init') {
        if (event.session_id) sessionId = event.session_id;
        if (event.model) currentModel = event.model;
      }
      try { emitter.emit('event', event); } catch (e) {}
    });
  }

  function launch() {
    if (child || stopping) return;
    const exe = findClaudeExe(execFileSync);
    if (!exe) {
      log('claude CLI not found on PATH');
      emitter.emit('error', { message: 'claude CLI not found on PATH' });
      return;
    }
    let proc;
    try {
      proc = spawn(exe, [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',                              // required by the CLI when -p + stream-json output are combined
        '--include-partial-messages',              // real token-level streaming (content_block_delta events)
        '--permission-mode', permissionMode,
        ...(model ? ['--model', model] : []),   // omit entirely for the account default
        // Voice-panel behavior prompt (app/claudevoice-voice-prompt.md), injected per-spawn so it
        // ONLY affects panel sessions -- deliberately NOT a user-level skill, which would leak into
        // the user's normal terminal/app Claude usage.
        ...(systemPromptAppend ? ['--append-system-prompt', systemPromptAppend] : []),
        // Fresh session vs continue-an-existing-one: --resume is how a mid-conversation permission-
        // mode change works (restart the process against the same session file, new mode flag) --
        // the documented path, since mode is a launch-only flag on the CLI.
        ...(resumeSessionId ? ['--resume', resumeSessionId] : ['--session-id', sessionId]),
      ], {
        cwd: projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
          OQX_VOICE_SESSION: '1',
          OQX_VOICE_PORT: String(voicePort || ''),
          OQX_VOICE_TOKEN: voiceToken || '',
        }),
      });
    } catch (e) {
      log('claude spawn failed: ' + e.message);
      scheduleRestart();
      return;
    }
    child = proc;
    attachOutput(proc);
    if (proc.stdin) proc.stdin.on('error', e => log('claude stdin error: ' + e.message));
    if (proc.stderr) proc.stderr.on('data', b => {
      const text = String(b).trim();
      if (text) log('claude stderr: ' + text);
    });
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      if (child === proc) child = null;
      emitter.emit('exit', { code, signal });
      if (!stopping) {
        log('claude process exited' + (code == null ? '' : ' (code ' + code + ')') + (signal ? ' (' + signal + ')' : ''));
        scheduleRestart();
      }
    };
    proc.on('error', e => { log('claude process error: ' + e.message); finish(null, null); });
    proc.on('exit', finish);
    proc.on('close', finish);
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    if (stopping) return;
    restartTimer = setTimeout(launch, restartDelay);
  }

  function stopChild() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (!child) return;
    const proc = child;
    child = null;
    try { proc.stdin.end(); } catch (e) {}
    const killTimer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 1000);
    if (killTimer.unref) killTimer.unref();
  }

  return {
    // Starts a fresh session (new session-id) scoped to `dir`. If a session is already running
    // (e.g. switching projects), it's stopped first -- one active claude process at a time, matching
    // "the session lives entirely on the Quake" (no multi-session juggling in v1).
    start({ projectDir: dir, permissionMode: mode, model: pick, port, token, systemPrompt }) {
      stopping = true; stopChild(); stopping = false;
      sessionId = crypto.randomUUID();
      resumeSessionId = null;
      projectDir = dir;
      permissionMode = mode || 'manual';
      model = pick || '';
      currentModel = null;
      voicePort = port;
      voiceToken = token;
      systemPromptAppend = systemPrompt || '';
      launch();
      return sessionId;
    },
    // Restarts the current session with a different permission mode, keeping the conversation:
    // stop the child, relaunch with --resume against the same session id. No-op without a session.
    setPermissionMode(mode) {
      if (!sessionId || !mode) return false;
      stopping = true; stopChild(); stopping = false;
      permissionMode = mode;
      resumeSessionId = sessionId;
      launch();
      return true;
    },
    permissionMode() { return permissionMode; },
    // Same resume-restart trick for the system-prompt append (AI profile switches): the CLI only
    // reads --append-system-prompt at launch, so swap the child and resume the conversation.
    setSystemPromptAppend(text) {
      if (!sessionId) return false;
      stopping = true; stopChild(); stopping = false;
      systemPromptAppend = text || '';
      resumeSessionId = sessionId;
      launch();
      return true;
    },
    // Same resume-restart trick for the model ('' switches back to the account default).
    setModel(pick) {
      if (!sessionId) return false;
      stopping = true; stopChild(); stopping = false;
      model = pick || '';
      resumeSessionId = sessionId;
      launch();
      return true;
    },
    currentModel() { return currentModel; },
    stop() {
      stopping = true;
      stopChild();
    },
    // Sends one user turn into the live session's stdin. Returns false if there's no running process
    // to write to (caller should treat this as "no session started").
    sendTurn(text) {
      if (!child || !child.stdin || child.stdin.destroyed) return false;
      try {
        // content as a plain STRING, not an array of blocks: this is the documented stream-json
        // input form, and it's what makes slash commands (/compact, /clear, custom commands) get
        // interpreted as commands -- sent as a content-block array they reach the model as literal
        // text instead.
        child.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: text },
        }) + '\n');
        return true;
      } catch (e) { log('claude sendTurn failed: ' + e.message); return false; }
    },
    isRunning() { return !!child; },
    sessionId() { return sessionId; },
    projectDir() { return projectDir; },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

module.exports = { createClaudeVoiceSession, findClaudeExe, resetClaudeExeCache };
