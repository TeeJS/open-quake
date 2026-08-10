'use strict';

// Windows-only controller for the persistent native reserved-display helper. Electron owns display
// identification; the helper owns foreign HWND enumeration, filtering, placement caching, and moves.
// Commands are replaceable snapshots so a late/bursty display event cannot leave stale state behind.

const path = require('path');
const readline = require('readline');
const childProcess = require('child_process');

function createReservedDisplay(options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const log = opts.log || (() => {});
  const spawn = opts.spawn || childProcess.spawn;
  const helperPath = opts.helperPath || path.join(__dirname, 'native', 'reserved-display.exe').replace('app.asar', 'app.asar.unpacked');
  const getDisplayState = opts.getDisplayState || (() => null);
  const ownProcessId = opts.ownProcessId || process.pid;
  const restartDelay = opts.restartDelay == null ? 1500 : opts.restartDelay;

  let child = null;
  let started = false;
  let enabled = false;
  let suspended = false;
  let stopping = false;
  let restartTimer = null;
  let sequence = 0;
  let lastResolvedKey = '';

  function active() { return platform === 'win32' && started && enabled; }

  function writeSnapshot() {
    if (!child || !child.stdin || child.stdin.destroyed) return;
    let state = null;
    try { state = getDisplayState(); } catch (e) { log('display state error: ' + e.message); }
    const payload = {
      command: 'configure',
      sequence: ++sequence,
      enabled: !!enabled,
      suspended: !!suspended,
      ownProcessId,
      reserved: state && state.reserved ? state.reserved : null,
      displays: state && Array.isArray(state.displays) ? state.displays : [],
    };
    try {
      child.stdin.write(JSON.stringify(payload) + '\n');
      const key = JSON.stringify(payload.reserved);
      if (payload.reserved && key !== lastResolvedKey) {
        lastResolvedKey = key;
        log('reserved display resolved: ' + key);
      }
    } catch (e) { log('native helper command failed: ' + e.message); }
  }

  function attachOutput(proc) {
    if (!proc.stdout) return;
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); }
      catch (e) { log('native helper output: ' + line); return; }
      const detail = event.message || [
        event.event,
        event.hwnd ? 'hwnd=' + event.hwnd : '',
        event.fallback ? 'fallback=' + event.fallback : '',
      ].filter(Boolean).join(' ');
      if (detail) log(detail);
    });
  }

  function launch() {
    if (!active() || child || stopping) return;
    let proc;
    try {
      proc = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log('native helper start failed: ' + e.message);
      scheduleRestart();
      return;
    }
    child = proc;
    attachOutput(proc);
    if (proc.stdin) proc.stdin.on('error', e => log('native helper input error: ' + e.message));
    if (proc.stderr) proc.stderr.on('data', b => {
      const text = String(b).trim();
      if (text) log('native helper error: ' + text);
    });
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      if (child === proc) child = null;
      if (!stopping && active()) {
        log('native helper exited' + (code == null ? '' : ' (code ' + code + ')') + (signal ? ' (' + signal + ')' : ''));
        scheduleRestart();
      }
    };
    proc.on('error', e => { log('native helper error: ' + e.message); finish(null, null); });
    proc.on('exit', finish);
    proc.on('close', finish);
    writeSnapshot();
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    if (!active() || stopping) return;
    restartTimer = setTimeout(launch, restartDelay);
  }

  function stopChild() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (!child) return;
    const proc = child;
    child = null;
    try { proc.stdin.write(JSON.stringify({ command: 'stop' }) + '\n'); } catch (e) {}
    try { proc.stdin.end(); } catch (e) {}
    const killTimer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 1000);
    if (killTimer.unref) killTimer.unref();
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopping = false;
      if (enabled) launch();
    },
    stop() {
      stopping = true;
      started = false;
      stopChild();
    },
    setEnabled(value) {
      const next = !!value;
      if (enabled === next) { if (next) writeSnapshot(); return; }
      enabled = next;
      log('protection ' + (enabled ? 'enabled' : 'disabled'));
      if (enabled) launch();
      else stopChild();
    },
    setSuspended(value) {
      const next = !!value;
      if (suspended === next) return;
      suspended = next;
      log('Monitor Mode suspension ' + (suspended ? 'enabled' : 'disabled'));
      writeSnapshot();
    },
    refresh(reason) {
      if (reason) log('display topology changed: ' + reason);
      writeSnapshot();
    },
    isRunning() { return !!child; },
  };
}

module.exports = { createReservedDisplay };
