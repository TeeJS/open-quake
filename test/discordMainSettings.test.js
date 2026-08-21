'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { configForRenderer } = require('../app/oauthConfigBoundary');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'app', name), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'apps.json'), 'utf8'));

test('Discord app descriptor exposes integration settings only for Discord', () => {
  const discord = manifest.find(app => app.id === 'discord');
  const clock = manifest.find(app => app.id === 'clock');
  assert.equal(discord.settings.key, 'discord');
  assert.deepEqual(discord.settings.options.map(option => option.label), [
    'Enable Discord integration', 'Automatic reconnect', 'Rich Presence enabled',
    'Default Discord view', 'Show/hide unavailable controls', 'Developer Application ID override',
  ]);
  assert.equal(discord.settings.options.find(option => option.key === 'applicationIdOverride').advanced, true);
  assert.equal(discord.settings.options.some(option => option.key === 'clientSecret'), false);
  assert.equal(clock.settings, undefined);
});

test('page editor renders manifest app settings into shared configuration without Discord IPC', () => {
  const source = read('config.js');
  assert.match(source, /def\.settings[\s\S]*config\.settings\[settingDef\.key\]/);
  assert.match(source, /data-app-settings/);
  assert.match(source, /querySelectorAll\('\.aset'\)/);
  assert.doesNotMatch(source, /settings\.discord|g\.app === ['"]discord/);
  const preload = read('config-preload.js');
  assert.doesNotMatch(preload, /getDiscordState|discordAction|onDiscordState/);
});

test('configuration load and editor save normalize the existing Discord settings store', () => {
  const source = read('main.js');
  const migration = source.slice(source.indexOf('function migrateConfig'), source.indexOf('function ensureSystemViewPage'));
  assert.match(migration, /c\.settings\.discord = normalizeDiscordSettings\(c\.settings\.discord\)/);
  const saveHandler = source.slice(source.indexOf("ipcMain.handle('saveConfigFromEditor'"), source.indexOf("ipcMain.handle('pickProgram'"));
  assert.match(saveHandler, /newCfg\.settings\.discord = normalizeDiscordSettings\(newCfg\.settings\.discord\)/);
});

test('Discord panel keeps Voice, Chat, and Activity and has no Settings view', () => {
  const source = read('discordview.js');
  assert.match(source, /\['voice', 'chat', 'activity'\]/);
  assert.doesNotMatch(source, /settingsView|data-settings-form|name="clientId"|Save settings|>Settings</);
  assert.match(source, /data-action="input-device"/);
  assert.match(source, /function activityView/);
});

test('Discord client secret is neither configured nor rendered, including legacy config', () => {
  const clean = configForRenderer({ settings: {
    discord: { clientId: 'public', clientSecret: 'private' },
    oauth: { providers: {}, tokens: { discord: { accessToken: 'access', refreshToken: 'refresh' } } },
  } });
  assert.deepEqual(clean.settings.discord, { clientId: 'public' });
  assert.deepEqual(clean.settings.oauth.tokens, {});
  assert.doesNotMatch(JSON.stringify(clean), /private|access|refresh/);
  assert.doesNotMatch(read('discordSettings.js'), /clientSecret/);
  assert.doesNotMatch(read('secretStore.js'), /settings\.discord\.clientSecret|discord\.clientSecret/);
});

test('Settings Auth renders a Discord provider card with account, scopes, and lifecycle actions', () => {
  const source = read('config.js');
  assert.match(source, /p\.provider === 'discord'/);
  assert.match(source, />Account<\/label>/);
  assert.match(source, /oauthConnect[\s\S]*Reconnect[\s\S]*oauthDisconnect/);
  assert.match(source, /requestedScopes = id === 'microsoft'[\s\S]*provider\.scopes/);
  const main = read('main.js');
  assert.match(main, /provider: 'discord', name: 'Discord'/);
  assert.match(main, /discordService\.authorize\(\)/);
  assert.match(main, /discordService\.disconnectAuthorization\(\)/);
});
