'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'app', name), 'utf8');

test('GitHub authentication and configuration render in the app page editor', () => {
  const source = read('config.js');
  const setup = source.slice(source.indexOf('async function appendGitHubSetup'), source.indexOf('// Screensaver:'));
  assert.match(source, /def\.id === 'github'\) appendGitHubSetup\(el\)/);
  assert.match(setup, /GitHub account/);
  assert.match(setup, /OAuth Client ID/);
  assert.match(setup, /Repository/);
  assert.match(setup, /Branch/);
  assert.match(setup, /These are optional/);
  assert.match(setup, /Device code/);
  assert.match(setup, /http:\/\/127\.0\.0\.1:53682\/callback/);
  assert.match(setup, /Device Flow never contacts it/);
  assert.match(setup, /connectGitHub\(\)/);
  assert.match(setup, /pollGitHubConnect\(\)/);
  assert.match(setup, /disconnectGitHub\(\)/);
  assert.match(setup, /Save your changes first, then connect/);
});

test('editor surfaces GitHub validation failures instead of misreporting secret storage', () => {
  const source = read('config.js');
  const save = source.slice(source.indexOf('async function doSave'), source.indexOf('// ---- tiles / icons'));
  assert.match(save, /result && result\.error/);
  // Assert the SHAPE, not the copy: the failing reason must be interpolated into whatever the footer
  // says, rather than the footer hardcoding one cause. Pinning the exact prefix is what rotted this
  // test — 50c65c7 renamed 'save failed: ' to 'Unable to apply changes: ' to match the footer states
  // in docs/editor-design-system.md, and the assertion was left behind, red on main ever since.
  assert.match(save, /setState\('[^']*' \+ reason/);
  assert.match(save, /detail === 'secure persistence failed'/);
  // The point of the test: a GitHub validation failure must surface as ITSELF, so the secret-storage
  // wording may only ever be a computed fallback, never a literal handed straight to setState.
  assert.doesNotMatch(save, /setState\('[^']*secrets could not be stored securely'/);
});

test('GitHub editor bridge is narrow and tokens remain main-process-only', () => {
  const preload = read('config-preload.js');
  assert.match(preload, /getGitHubStatus/);
  assert.match(preload, /connectGitHub/);
  assert.match(preload, /pollGitHubConnect/);
  assert.match(preload, /disconnectGitHub/);
  assert.doesNotMatch(preload, /getGitHubToken|accessToken|refreshToken/);

  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\('getGitHubStatus'[\s\S]*isFrom\(e, configWin\)/);
  assert.match(main, /ipcMain\.handle\('connectGitHub'/);
  assert.match(main, /ipcMain\.handle\('pollGitHubConnect'/);
  assert.match(main, /ipcMain\.handle\('disconnectGitHub'/);
  const save = main.slice(main.indexOf("ipcMain.handle('saveConfigFromEditor'"), main.indexOf("ipcMain.handle('pickProgram'"));
  assert.match(save, /normalizeGitHubClientId/);
  assert.match(save, /parseGitHubRepository/);
  assert.match(save, /githubClientChanged[\s\S]*delete newCfg\.settings\.oauth\.tokens\.github/);
});

test('GitHub touchscreen panel has operations only and cannot mutate authentication settings', () => {
  const html = read('github.html');
  const script = read('github.js');
  const server = read('sysserver.js');
  assert.doesNotMatch(html, /Settings|settingsButton/);
  assert.doesNotMatch(script, /renderSettings|saveSettings|connectGitHub|OAuth App Client ID|Device Flow/);
  assert.match(script, /Open this GitHub page in the desktop editor/);
  assert.match(html, /repositoryButton/);
  assert.match(html, /repositorySearch/);
  assert.match(script, /api\('repositories'/);
  assert.match(script, /open-quake\.github\.repository/);
  assert.match(script, /repository:state\.settings\.repository/);
  const routes = server.slice(server.indexOf('async function serveGitHubApi'), server.indexOf('async function handler'));
  assert.doesNotMatch(routes, /githubApp\.configure|githubApp\.connect|githubApp\.pollConnect|githubApp\.disconnect/);
});

test('GitHub panel uses large semantic touch controls and contained scrolling', () => {
  const html = read('github.html');
  const script = read('github.js');
  const css = read('github.css');
  assert.match(html, /grid|GitHub views/);
  assert.match(html, /data-view="issues"/);
  assert.match(script, /\[\['open','Open'\],\['assigned','Assigned to me'\],\['closed','Closed'\]\]/);
  assert.match(script, /api\('issues'/);
  assert.match(script, /api\('issue'/);
  assert.match(script, /esc\(selected\.body\)/);
  assert.match(script, /openExternal\(selected\.url\)/);
  assert.match(script, /state\.view !== 'issues' \|\| state\.issueFilter !== filter/);
  assert.match(script, /if \(silent \|\| state\.data\) \{ state\.stale = true/);
  assert.doesNotMatch(script, /createIssue|closeIssue|editIssue|commentIssue/);
  assert.match(script, /<button type="button" class="list-row/);
  assert.match(script, /role="button" tabindex="0" data-go=/);
  assert.match(script, /\.content button:not\(:disabled\)/);
  assert.match(script, /\.content \[role="button"\]/);
  assert.match(script, /#confirmOverlay button:not\(:disabled\)/);
  assert.match(css, /\.app-shell \{ height:480px/);
  assert.match(css, /\.list-row \{[\s\S]*min-height:72px/);
  assert.match(css, /\.repository-dialog \.repository-row \{[\s\S]*min-height:76px/);
  assert.match(css, /touch-action:manipulation/);
  assert.match(css, /\.repository-dialog \.repository-list \{[^}]*touch-action:none/);
  assert.match(html, /<script src="touchDragScroll\.js"><\/script>/);
  assert.match(script, /TouchDragScroll\.attach\(\$\('repositoryList'\)\)/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /\.issue-row \{[^}]*min-height:88px/);
  assert.match(css, /\.issue-body-scroll \{[^}]*overflow-y:auto/);
  assert.match(html, /class="dialog-actions"/);
  assert.doesNotMatch(css, /\.dialog > div:last-child/);
});
