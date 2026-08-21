'use strict';

// Preload for the first-run / re-run "welcome" window (run-mode picker). Sandboxed: no fs, no Node —
// only a tiny IPC surface. getInfo() tells the page whether the QUAKE display is present (to pre-select
// a sensible default) and the current mode; choose() persists the picked mode and resumes launch.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openQuakeWelcome', {
  getInfo() { return ipcRenderer.invoke('getWelcomeInfo'); },
  choose(mode) { return ipcRenderer.invoke('setRunMode', mode); },
});
