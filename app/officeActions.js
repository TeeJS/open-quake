'use strict';

const path = require('path');

const OFFICE_APPS = Object.freeze({
  teams: {
    web: 'https://teams.microsoft.com/v2/',
    executables: ['ms-teams.exe', 'Teams.exe'],
    processes: ['ms-teams', 'Teams'],
  },
  outlook: {
    web: 'https://outlook.office.com/mail/',
    executables: ['olk.exe', 'OUTLOOK.EXE'],
    processes: ['olk', 'OUTLOOK'],
  },
  word: {
    web: 'https://www.office.com/launch/word',
    executables: ['WINWORD.EXE'],
    processes: ['WINWORD'],
  },
  excel: {
    web: 'https://www.office.com/launch/excel',
    executables: ['EXCEL.EXE'],
    processes: ['EXCEL'],
  },
  powerpoint: {
    web: 'https://www.office.com/launch/powerpoint',
    executables: ['POWERPNT.EXE'],
    processes: ['POWERPNT'],
  },
  onenote: {
    web: 'https://www.office.com/launch/onenote',
    executables: ['ONENOTE.EXE'],
    processes: ['ONENOTE'],
  },
  onedrive: {
    web: 'https://www.office.com/launch/onedrive',
    executables: ['OneDrive.exe'],
    processes: ['OneDrive'],
  },
  office: {
    web: 'https://www.office.com/',
    executables: ['msoffice.exe'],
    processes: ['msoffice'],
  },
});

const DEFAULT_APPS = ['teams', 'outlook', 'word', 'excel'];
const BROWSER_PROCESSES = ['msedge', 'chrome', 'firefox', 'brave', 'opera'];
const DEFAULT_SHORTCUTS_BY_APP = Object.freeze({
  teams: [
    { label: 'Mute', combo: 'Ctrl+Shift+M', icon: '🎙️' },
    { label: 'Camera', combo: 'Ctrl+Shift+O', icon: '📹' },
    { label: 'Accept audio', combo: 'Ctrl+Shift+S', icon: '📞' },
    { label: 'Hang up', combo: 'Ctrl+Shift+H', icon: '📴' },
  ],
  outlook: [
    { label: 'New message', combo: 'Ctrl+N' },
    { label: 'Reply', combo: 'Ctrl+R' },
    { label: 'Forward', combo: 'Ctrl+F' },
    { label: 'Send', combo: 'Alt+S' },
  ],
  word: [
    { label: 'New document', combo: 'Ctrl+N' },
    { label: 'Save', combo: 'Ctrl+S' },
    { label: 'Find', combo: 'Ctrl+F' },
    { label: 'Undo', combo: 'Ctrl+Z' },
  ],
  excel: [
    { label: 'New workbook', combo: 'Ctrl+N' },
    { label: 'Save', combo: 'Ctrl+S' },
    { label: 'Find', combo: 'Ctrl+F' },
    { label: 'Undo', combo: 'Ctrl+Z' },
  ],
  powerpoint: [
    { label: 'New presentation', combo: 'Ctrl+N' },
    { label: 'Save', combo: 'Ctrl+S' },
    { label: 'New slide', combo: 'Ctrl+M' },
    { label: 'Start slideshow', combo: 'F5' },
  ],
  onenote: [
    { label: 'New page', combo: 'Ctrl+N' },
    { label: 'Search', combo: 'Ctrl+E' },
    { label: 'To-do tag', combo: 'Ctrl+1' },
    { label: 'Undo', combo: 'Ctrl+Z' },
  ],
  onedrive: [
    { label: 'New folder', combo: 'Ctrl+Shift+N' },
    { label: 'Copy', combo: 'Ctrl+C' },
    { label: 'Paste', combo: 'Ctrl+V' },
    { label: 'Refresh', combo: 'F5' },
  ],
  office: [
    { label: 'New', combo: 'Ctrl+N' },
    { label: 'Save', combo: 'Ctrl+S' },
    { label: 'Find', combo: 'Ctrl+F' },
    { label: 'Undo', combo: 'Ctrl+Z' },
  ],
});

function officeInstallCandidates(executable, env, fs) {
  const candidates = [executable];
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  roots.forEach(root => {
    candidates.push(path.join(root, 'Microsoft Office', 'root', 'Office16', executable));
    candidates.push(path.join(root, 'Microsoft Office', 'Office16', executable));
  });
  if (executable.toLowerCase() === 'onedrive.exe' && env.LOCALAPPDATA) {
    candidates.unshift(path.join(env.LOCALAPPDATA, 'Microsoft', 'OneDrive', 'OneDrive.exe'));
  }
  if ((executable.toLowerCase() === 'ms-teams.exe' || executable.toLowerCase() === 'teams.exe') && env.LOCALAPPDATA) {
    candidates.unshift(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'ms-teams.exe'));
    candidates.unshift(path.join(env.LOCALAPPDATA, 'Microsoft', 'Teams', 'current', 'Teams.exe'));
  }
  return candidates.filter((candidate, index, all) => index === 0 || fs.existsSync(candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
}

function normalizeMode(value) {
  return value === 'web' || value === 'desktop' ? value : 'prefer-desktop';
}

function normalizeShortcutCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 4 && count <= 8 ? count : 4;
}

function createOfficeActions({ getOptions, launchApp, openExternal, focusTeams, focusApp, hasAppWindow, tapCombo, fs, env = process.env }) {
  if (typeof getOptions !== 'function') throw new TypeError('getOptions is required');
  if (typeof launchApp !== 'function') throw new TypeError('launchApp is required');
  if (typeof openExternal !== 'function') throw new TypeError('openExternal is required');
  if (typeof tapCombo !== 'function') throw new TypeError('tapCombo is required');
  if (!fs) throw new TypeError('fs is required');
  const lastMethods = {};

  async function launchDesktop(appId, focusExisting) {
    const app = OFFICE_APPS[appId];
    if (!focusExisting) {
      const running = typeof hasAppWindow === 'function' ? await hasAppWindow(app.processes) : { ok: false };
      if (running && running.ok) return { ok: true, method: 'desktop', focused: false, alreadyRunning: true };
    }

    if (appId === 'teams') {
      if (focusExisting) {
        const focused = typeof focusTeams === 'function' ? await focusTeams() : { ok: false };
        if (focused && focused.ok) return { ok: true, method: 'desktop', focused: true };
      }
      const opened = await openExternal('msteams://teams.microsoft.com');
      return { ok: !!opened, method: 'desktop', focused: false, error: opened ? undefined : 'Teams desktop app was not found.' };
    }

    if (focusExisting) {
      const focused = typeof focusApp === 'function' ? await focusApp(app.processes) : { ok: false };
      if (focused && focused.ok) return { ok: true, method: 'desktop', focused: true };
    }
    for (const executable of app.executables) {
      for (const candidate of officeInstallCandidates(executable, env, fs)) {
        if (await launchApp(candidate)) return { ok: true, method: 'desktop', focused: false };
      }
    }
    return { ok: false, method: 'desktop', focused: false, error: 'The ' + appId + ' desktop app was not found.' };
  }

  async function runApp(index) {
    if (!Number.isInteger(index) || index < 0 || index > 3) return { ok: false, error: 'unknown Office app slot' };
    const options = getOptions() || {};
    const appId = OFFICE_APPS[options['app' + (index + 1)]] ? options['app' + (index + 1)] : DEFAULT_APPS[index];
    const mode = normalizeMode(options['mode' + (index + 1)]);
    if (mode !== 'web') {
      const keepPanelForRunningApp = mode === 'desktop' && options['desktopSwitch' + (index + 1)] === 'shortcuts';
      const local = await launchDesktop(appId, !keepPanelForRunningApp);
      if (local.ok || mode === 'desktop') {
        if (local.ok) lastMethods[index] = 'desktop';
        return Object.assign({ app: appId }, local);
      }
    }
    const ok = await openExternal(OFFICE_APPS[appId].web);
    if (ok) lastMethods[index] = 'web';
    return { ok: !!ok, app: appId, method: 'web', error: ok ? undefined : 'The Office web app could not be opened.' };
  }

  async function runShortcut(appIndex, shortcutIndex) {
    if (!Number.isInteger(appIndex) || appIndex < 0 || appIndex > 3
      || !Number.isInteger(shortcutIndex) || shortcutIndex < 0 || shortcutIndex > 7) {
      return { ok: false, error: 'unknown Office shortcut slot' };
    }
    const options = getOptions() || {};
    const appId = OFFICE_APPS[options['app' + (appIndex + 1)]] ? options['app' + (appIndex + 1)] : DEFAULT_APPS[appIndex];
    const shortcutCount = normalizeShortcutCount(options['app' + (appIndex + 1) + 'ShortcutCount']);
    if (shortcutIndex >= shortcutCount) return { ok: false, error: 'unknown Office shortcut slot' };
    const fallback = DEFAULT_SHORTCUTS_BY_APP[appId][shortcutIndex] || { combo: '' };
    const key = 'app' + (appIndex + 1) + 'Shortcut' + (shortcutIndex + 1) + 'Keys';
    const combo = String(Object.prototype.hasOwnProperty.call(options, key) ? options[key] : fallback.combo).trim();
    if (!combo) return { ok: false, error: 'No key combination is configured.' };
    const mode = lastMethods[appIndex] || (normalizeMode(options['mode' + (appIndex + 1)]) === 'web' ? 'web' : 'desktop');
    const focus = typeof focusApp === 'function'
      ? await focusApp(mode === 'web' ? BROWSER_PROCESSES : OFFICE_APPS[appId].processes)
      : { ok: false, error: 'Application focusing is unavailable.' };
    await new Promise(resolve => setTimeout(resolve, 150));
    const ok = !!tapCombo(combo);
    return { ok, combo, focused: !!focus.ok, focusError: focus.ok ? undefined : focus.error, error: ok ? undefined : 'The key combination could not be sent.' };
  }

  async function run(kind, index, shortcutIndex) {
    if (kind === 'app') return runApp(index);
    if (kind === 'shortcut') return runShortcut(index, shortcutIndex);
    return { ok: false, error: 'unknown Office action' };
  }

  return { run };
}

module.exports = { DEFAULT_APPS, DEFAULT_SHORTCUTS_BY_APP, OFFICE_APPS, createOfficeActions, normalizeMode, normalizeShortcutCount, officeInstallCandidates };
