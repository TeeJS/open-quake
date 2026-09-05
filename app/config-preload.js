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
  getAppOAuthStatus(appId) { return ipcRenderer.invoke('getAppOAuthStatus', appId); },
  connectAppOAuth(appId) { return ipcRenderer.invoke('connectAppOAuth', appId); },
  disconnectAppOAuth(appId) { return ipcRenderer.invoke('disconnectAppOAuth', appId); },
  getGitHubStatus() { return ipcRenderer.invoke('getGitHubStatus'); },
  connectGitHub() { return ipcRenderer.invoke('connectGitHub'); },
  pollGitHubConnect() { return ipcRenderer.invoke('pollGitHubConnect'); },
  disconnectGitHub() { return ipcRenderer.invoke('disconnectGitHub'); },
  pickProgram() { return ipcRenderer.invoke('pickProgram'); },
  pickFile() { return ipcRenderer.invoke('pickFile'); },
  pickFolder() { return ipcRenderer.invoke('pickFolder'); },
  listDropInApps() { return ipcRenderer.invoke('listDropInApps'); },
  openExternal(url) { ipcRenderer.send('openExternal', url); },
  exportDropInApp(id) { return ipcRenderer.invoke('exportDropInApp', id); },
  deleteDropInApp(id) { return ipcRenderer.invoke('deleteDropInApp', id); },
  getDropInInfo() { return ipcRenderer.invoke('getDropInInfo'); },
  setDropInLocation(loc) { return ipcRenderer.invoke('setDropInLocation', loc); },
  listRepoApps(repoUrl) { return ipcRenderer.invoke('listRepoApps', repoUrl); },
  installRepoApp(id, confirmExec, repoUrl) { return ipcRenderer.invoke('installRepoApp', id, confirmExec, repoUrl); },
  checkDropInUpdate(id) { return ipcRenderer.invoke('checkDropInUpdate', id); },
  appApiCall(appId, action, body) { return ipcRenderer.invoke('appApiCall', appId, action, body); },
  updateDropInApp(id, confirmExec) { return ipcRenderer.invoke('updateDropInApp', id, confirmExec); },
  reinstallDropInApp(id, confirmExec) { return ipcRenderer.invoke('reinstallDropInApp', id, confirmExec); },
  pickImage() { return ipcRenderer.invoke('pickImage'); },
  getAppIcon(value) { return ipcRenderer.invoke('getAppIcon', value); },
  fetchIconUrl(url) { return ipcRenderer.invoke('fetchIconUrl', url); },
  fetchMdiIcon(name) { return ipcRenderer.invoke('fetchMdiIcon', name); },
  setupTouchscreen() { return ipcRenderer.invoke('setupTouchscreen'); },
  clearTouchCalibration() { return ipcRenderer.invoke('clearTouchCalibration'); },
  getLighting() { return ipcRenderer.invoke('getLighting'); },
  getMonitorState() { return ipcRenderer.invoke('getMonitorState'); },
  appPreviewUrl(page) { return ipcRenderer.invoke('appPreviewUrl', page); },
  appEditorUrl(page) { return ipcRenderer.invoke('appEditorUrl', page); },
  enterMonitorMode() { return ipcRenderer.invoke('enterMonitorModeFromEditor'); },
  setLighting(lighting) { ipcRenderer.send('setLighting', lighting); },
  saveLightingToDevice() { return ipcRenderer.invoke('saveLightingToDevice'); },
  listRunningApps() { return ipcRenderer.invoke('listRunningApps'); },
  getVoiceModes() { return ipcRenderer.invoke('getVoiceModes'); },
  runRoutine(id) { return ipcRenderer.invoke('runRoutine', id); },
  focusPage(id) { return ipcRenderer.invoke('focusPage', id); },
  // Run-mode picker: reopen the first-run welcome window. A mode change applies live on Save.
  openWelcome() { return ipcRenderer.invoke('openWelcome'); },
  // Global Home Assistant cache: registries + dashboards in main's memory; per-entity states lazy.
  getHaCache() { return ipcRenderer.invoke('getHaCache'); },
  getEmojiIndex() { return ipcRenderer.invoke('getEmojiIndex'); },
  refreshHaCache() { return ipcRenderer.invoke('refreshHaCache'); },
  fetchHaEntityState(entityId) { return ipcRenderer.invoke('fetchHaEntityState', entityId); },
  // Busy status: drive one output on demand from the Test buttons, and read what main can actually
  // see (is a Busylight attached, is the broker connected) rather than only what the user typed.
  busyTest(target) { return ipcRenderer.invoke('busyTest', target); },
  busyStatus() { return ipcRenderer.invoke('busyStatus'); },
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
  probeObs() { return ipcRenderer.invoke('probeObs'); },
  getObsSnapshot() { return ipcRenderer.invoke('getObsSnapshot'); },
  probeApiModels(url, apiKey) { return ipcRenderer.invoke('probeApiModels', url, apiKey); },
  // Screensaver: open the effective photos/videos folder in Explorer (auto-creating it first).
  openScreensaverMedia(dir, kind) { return ipcRenderer.invoke('openScreensaverMedia', dir, kind); },
  // After a native confirm()/alert(): blur+refocus the editor window from main so inputs and
  // <select> popups keep working (electron#31917 focus bug).
  refocusEditor() { ipcRenderer.send('refocusEditor'); },
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
