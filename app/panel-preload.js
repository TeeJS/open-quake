'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('openQuakePanel', {
  launch(action) { ipcRenderer.send('launch', action); },
  volume(value) { ipcRenderer.send('volume', value); },
  media(cmd) { ipcRenderer.send('media', cmd); },
  switchGrid(id) { ipcRenderer.send('switchGrid', id); },
  toggleRotation() { ipcRenderer.send('toggleRotation'); },
  startRotation() { ipcRenderer.send('startRotation'); },
  stopRotation() { ipcRenderer.send('stopRotation'); },
  gotoHome() { ipcRenderer.send('gotoHome'); },
  openExternal(url) { ipcRenderer.send('openExternal', url); },
  setRingState(state) { ipcRenderer.send('ringState', state); },
  introDone() { ipcRenderer.send('introDone'); },
  saveTileValue(gridId, index, value) { ipcRenderer.send('saveTileValue', { gridId, index, value }); },
  onTheme(callback) { return on('theme', callback); },
  onGrid(callback) { return on('grid', callback); },
  onGridList(callback) { return on('gridList', callback); },
  onRotation(callback) { return on('rotation', callback); },
  onIntro(callback) { return on('intro', callback); },
  onTouch(callback) { return on('touch', callback); },
  onKnob(callback) { return on('knob', callback); },
  onReloadDashboard(callback) { return on('reloadDashboard', callback); },
});
