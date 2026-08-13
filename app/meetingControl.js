'use strict';
/*
 * meetingControl.js — call-control actions for Zoom and Microsoft Teams. [MIT]
 *
 * Zoom: sends the keystroke combo the user has configured in the editor's Meeting app
 * options, which must match whatever they've assigned (and enabled "Global Shortcut" for)
 * inside Zoom's own Settings -> Keyboard Shortcuts. No focus-forcing needed -- Zoom's own
 * global-shortcut mechanism handles background operation once set up on Zoom's side.
 *
 * Teams: the local third-party API was retired by Microsoft on 2026-06-30 (see PROJECT.md).
 * The only remaining mechanism is Teams' own keyboard shortcuts, which require Teams to be
 * the focused window -- so we force-focus it first. The naive SetForegroundWindow call is
 * routinely blocked by Windows' foreground-lock protection when called from a background
 * process; AttachThreadInput to the current foreground thread first is the standard workaround.
 */
const { spawn } = require('child_process');

// Fixed Teams shortcuts (Ctrl+Shift+...), confirmed against Microsoft's own support docs.
// Unlike Zoom these aren't user-configurable, so there's nothing to expose in the editor.
const TEAMS_COMBO = {
  mute: 'control+shift+m',
  acceptVideo: 'control+shift+a',
  acceptAudio: 'control+shift+s',
  decline: 'control+shift+d',
  hangup: 'control+shift+h',
  video: 'control+shift+o',
};

// Zoom's real shipped default keybinds (Settings -> Keyboard Shortcuts, before any user
// customization), confirmed against Zoom's own support docs. Used when the Meeting app's "Use
// Zoom's default keymappings" option is on (the default) -- most users never touch Zoom's own
// shortcut settings, so these just work without any setup. "leave" opens Zoom's leave/end
// confirmation dialog rather than leaving instantly; the user still confirms it once in Zoom.
const ZOOM_DEFAULT_COMBO = {
  mute: 'alt+a',
  video: 'alt+v',
  accept: 'control+shift+a',
  decline: 'control+shift+d',
  leave: 'alt+q',
};

// Non-elevated -- focusing a window the signed-in user already owns needs no UAC prompt (unlike
// touchSetup.js's multidigimon/tabcal, which write to HKLM and require admin). Tries new Teams'
// process name first, falls back to classic Teams for any remaining holdouts.
const FOCUS_WINDOW_PS = names => `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OqFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$names = @(${names.map(name => "'" + name + "'").join(',')})
$target = $null
foreach ($n in $names) {
  $p = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $target = $p; break }
}
if (-not $target) { Write-Output 'NOTFOUND'; exit 1 }
$hWnd = $target.MainWindowHandle
$fgWnd = [OqFocus]::GetForegroundWindow()
$fgThread = 0
[OqFocus]::GetWindowThreadProcessId($fgWnd, [ref]$fgThread) | Out-Null
$curThread = [OqFocus]::GetCurrentThreadId()
if ([OqFocus]::IsIconic($hWnd)) { [OqFocus]::ShowWindowAsync($hWnd, 9) | Out-Null }
[OqFocus]::AttachThreadInput($curThread, $fgThread, $true) | Out-Null
[OqFocus]::SetForegroundWindow($hWnd) | Out-Null
[OqFocus]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null
Write-Output 'OK'
`.trim();

function focusProcessWindow(processNames) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Windows only' });
  const names = (Array.isArray(processNames) ? processNames : [])
    .map(name => String(name || '').replace(/\.exe$/i, ''))
    .filter(name => /^[A-Za-z0-9._-]+$/.test(name));
  if (!names.length) return Promise.resolve({ ok: false, error: 'No process names supplied' });
  return new Promise(resolve => {
    let child;
    try { child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FOCUS_WINDOW_PS(names)], { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: 'spawn: ' + e.message }); }
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => resolve({ ok: false, error: 'spawn: ' + e.message }));
    child.on('close', () => {
      const trimmed = out.trim();
      if (trimmed === 'OK') return resolve({ ok: true });
      resolve({ ok: false, error: trimmed === 'NOTFOUND' ? 'Application window not found.' : (err.trim() || 'unknown focus failure') });
    });
  });
}

function focusTeamsWindow() {
  return focusProcessWindow(['ms-teams', 'Teams']);
}

// Force-focus Teams, then send the fixed shortcut. Focus failure doesn't block the keystroke --
// if Teams happens to already be focused, or the user doesn't mind, the keystroke can still land.
async function sendTeamsAction(action, deps) {
  const combo = TEAMS_COMBO[action];
  if (!combo) return { ok: false, error: 'unknown Teams action: ' + action };
  const focus = await focusTeamsWindow();
  await new Promise(r => setTimeout(r, 150));   // let the foreground switch settle before the keystroke
  const sent = deps.mediaKeys.tapCombo(combo);
  return { ok: sent, focused: focus.ok, focusError: focus.ok ? undefined : focus.error };
}

// No focus-forcing -- `combo` is whatever the user configured (and enabled "Global Shortcut"
// for) inside Zoom's own Settings -> Keyboard Shortcuts.
function sendZoomAction(combo, deps) {
  if (!combo) return { ok: false, error: 'no combo configured for this action' };
  const sent = deps.mediaKeys.tapCombo(combo);
  return { ok: sent };
}

module.exports = { TEAMS_COMBO, ZOOM_DEFAULT_COMBO, focusProcessWindow, focusTeamsWindow, sendTeamsAction, sendZoomAction };
