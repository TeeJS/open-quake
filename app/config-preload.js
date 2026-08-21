'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('openQuakeConfig', {
  getConfig() { return ipcRenderer.invoke('getConfig'); },
  getAppVersion() { return ipcRenderer.invoke('getAppVersion'); },
  getApps() { return ipcRenderer.invoke('getApps'); },
  saveConfig(config) { return ipcRenderer.invoke('saveConfigFromEditor', config); },
  // Fired when something outside the editor changed config (an accepted AI panel, a counter tile).
  onConfigChangedExternally(cb) { ipcRenderer.on('configChangedExternally', () => cb()); },
  listOAuthProviders() { return ipcRenderer.invoke('listOAuthProviders'); },
  connectOAuthProvider(provider, scopes) { return ipcRenderer.invoke('connectOAuthProvider', provider, scopes); },
  disconnectOAuthProvider(provider) { return ipcRenderer.invoke('disconnectOAuthProvider', provider); },
  pickProgram() { return ipcRenderer.invoke('pickProgram'); },
  pickFile() { return ipcRenderer.invoke('pickFile'); },
  pickFolder() { return ipcRenderer.invoke('pickFolder'); },
  listDropInApps() { return ipcRenderer.invoke('listDropInApps'); },
  pickZip() { return ipcRenderer.invoke('pickZip'); },
  importDropInApp(zipPath, forceId, confirmExec) { return ipcRenderer.invoke('importDropInApp', zipPath, forceId, confirmExec); },
  openExternal(url) { ipcRenderer.send('openExternal', url); },
  exportDropInApp(id) { return ipcRenderer.invoke('exportDropInApp', id); },
  deleteDropInApp(id) { return ipcRenderer.invoke('deleteDropInApp', id); },
  getDropInInfo() { return ipcRenderer.invoke('getDropInInfo'); },
  setDropInLocation(loc) { return ipcRenderer.invoke('setDropInLocation', loc); },
  pickImage() { return ipcRenderer.invoke('pickImage'); },
  getAppIcon(value) { return ipcRenderer.invoke('getAppIcon', value); },
  fetchIconUrl(url) { return ipcRenderer.invoke('fetchIconUrl', url); },
  fetchMdiIcon(name) { return ipcRenderer.invoke('fetchMdiIcon', name); },
  setupTouchscreen() { return ipcRenderer.invoke('setupTouchscreen'); },
  clearTouchCalibration() { return ipcRenderer.invoke('clearTouchCalibration'); },
  getLighting() { return ipcRenderer.invoke('getLighting'); },
  setLighting(lighting) { ipcRenderer.send('setLighting', lighting); },
  saveLightingToDevice() { return ipcRenderer.invoke('saveLightingToDevice'); },
  listRunningApps() { return ipcRenderer.invoke('listRunningApps'); },
  getVoiceModes() { return ipcRenderer.invoke('getVoiceModes'); },
  runRoutine(id) { return ipcRenderer.invoke('runRoutine', id); },
  // Run-mode picker: reopen the first-run welcome window. A mode change applies live on Save.
  openWelcome() { return ipcRenderer.invoke('openWelcome'); },
  // Global Home Assistant cache: registries + dashboards in main's memory; per-entity states lazy.
  getHaCache() { return ipcRenderer.invoke('getHaCache'); },
  getEmojiIndex() { return ipcRenderer.invoke('getEmojiIndex'); },
  refreshHaCache() { return ipcRenderer.invoke('refreshHaCache'); },
  fetchHaEntityState(entityId) { return ipcRenderer.invoke('fetchHaEntityState', entityId); },
  // Claude Code voice app: candidate project directories under the configured projects root (Phase 3).
  listProjectDirs(root) { return ipcRenderer.invoke('listProjectDirs', root); },
  // Claude Code voice app: open the user-customizable panel prompt file in the default editor.
  editClaudeVoicePrompt() { return ipcRenderer.invoke('editClaudeVoicePrompt'); },
  // Meeting analysis: open the user-customizable analysis prompt file in the default editor.
  editMeetingAnalysisPrompt() { return ipcRenderer.invoke('editMeetingAnalysisPrompt'); },
  // Meeting tab: verify the selected classic-Outlook or Microsoft 365 calendar source.
  checkOutlookMeetings(source) { return ipcRenderer.invoke('checkOutlookMeetings', source); },
  // Voice apps: resolved CLI path for the app's agent (claude/codex), or null if not installed.
  probeVoiceCli(appId) { return ipcRenderer.invoke('probeVoiceCli', appId); },
  // Auth tab: test the saved Open WebUI connection (normalize URL + list models with the key).
  probeOwui(url, apiKey) { return ipcRenderer.invoke('probeOwui', url, apiKey); },
  probeApiModels(url, apiKey) { return ipcRenderer.invoke('probeApiModels', url, apiKey); },
  // Screensaver: open the effective photos/videos folder in Explorer (auto-creating it first).
  openScreensaverMedia(dir, kind) { return ipcRenderer.invoke('openScreensaverMedia', dir, kind); },
  pathToFileURL(filePath) {
    try { return pathToFileURL(filePath).href; }
    catch (e) { return ''; }
  },
  // Read a local image into a data: URL — the same thing the panel does (main.js imageFileToDataUrl), so
  // the editor preview matches the panel and doesn't depend on the renderer being allowed to load file://.
  // The read happens in main (this preload is sandboxed: no fs), via a synchronous IPC so the render path
  // that builds the icon HTML stays synchronous.
  imageToDataUrl(filePath) {
    try { return ipcRenderer.sendSync('imageToDataUrl', filePath) || ''; }
    catch (e) { return ''; }
  },
});
