'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DiscordAppHost, RECENT_EVENT_LIMIT, sanitizeStatusText, usableTextChannels } = require('../app/discordAppHost');
const view = require('../app/discordview');
const { DEFAULT_DISCORD_APPLICATION_ID, DEFAULT_DISCORD_SETTINGS, discordApplicationId, normalizeDiscordSettings } = require('../app/discordSettings');

class MockDiscordService extends EventEmitter {
  constructor() {
    super();
    this.state = { state: 'connected', error: null };
    this.capabilities = { voiceSettings: true, voiceChannelControl: true, guildDiscovery: true, channelDiscovery: true, textChannelSelection: true, activity: true };
    this.voice = { mute: false, deaf: false, input: { device_id: 'mic', volume: 80, available_devices: [{ id: 'mic', name: 'Desk microphone' }] }, output: { device_id: 'speakers', volume: 90, available_devices: [{ id: 'speakers', name: 'Speakers' }] } };
    this.channel = { id: 'voice', name: 'General', guild_id: 'guild', guild_name: 'Open Quake' };
    this.calls = [];
    this.autoReconnect = true;
  }
  getState() { return this.state; }
  getCapabilities() { return Object.assign({}, this.capabilities); }
  getCapabilityStates() { return Object.fromEntries(Object.keys(this.capabilities).map(key => [key, this.capabilities[key] ? 'available' : 'unsupported'])); }
  getVoiceSettings() { return Promise.resolve(this.voice); }
  getSelectedVoiceChannel() { return Promise.resolve(this.channel); }
  getGuilds() { return Promise.resolve({ guilds: [{ id: 'guild', name: 'Open Quake' }] }); }
  getChannels(id) { this.calls.push(['guild', id]); return Promise.resolve({ channels: [{ id: 'general', name: 'general', type: 0 }, { id: 'voice', name: 'Voice', type: 2 }, { id: 'news', name: 'news', type: 5 }] }); }
  getChannel(id) { return Promise.resolve({ id, name: id === 'music' ? 'Music' : id, guild_id: 'guild' }); }
  setVoiceSettings(patch) { this.calls.push(['voice', patch]); this.voice = Object.assign({}, this.voice, patch); return Promise.resolve(patch); }
  selectVoiceChannel(id) { this.calls.push(['channel', id]); this.channel = id ? { id, name: id === 'music' ? 'Music' : id, guild_id: 'guild' } : null; return Promise.resolve(this.channel); }
  selectTextChannel(id) { this.calls.push(['chat-channel', id]); return Promise.resolve({ id, name: id === 'general' ? 'general' : id, type: 0 }); }
  start() { this.calls.push(['start']); }
  stop() { this.calls.push(['stop']); }
  configure(value) { this.calls.push(['configure', value]); }
  setAutoReconnect(value) { this.autoReconnect = value; this.calls.push(['autoReconnect', value]); }
  setActivity(value) { this.calls.push(['activity', value]); return Promise.resolve(); }
}

const connected = service => ({ connection: service.state, capabilities: service.capabilities, voice: service.voice, channel: service.channel, guilds: [{ id: 'guild', name: 'Open Quake' }], channels: [{ id: 'voice', name: 'General' }], participants: null });

test('Discord layout is fixed to 1920x480 conventions with large touch controls and truncation', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/discordview.css'), 'utf8');
  assert.match(css, /height:480px/);
  assert.match(css, /min-height:56px/);
  assert.match(css, /text-overflow:ellipsis/);
  assert.match(css, /overflow:hidden/);
  assert.doesNotMatch(css, /:hover/);
});

test('disconnected states render readable status and reconnect where appropriate', () => {
  for (const state of ['not-running', 'disconnected', 'error']) assert.match(view.voiceView({ connection: { state }, capabilities: {} }), /data-action="reconnect"/);
  for (const state of ['connecting', 'reconnecting']) assert.doesNotMatch(view.voiceView({ connection: { state }, capabilities: {} }), /data-action="reconnect"/);
});

test('connected Voice view shows real state and clearly marks unavailable participants', () => {
  const service = new MockDiscordService();
  const html = view.render(connected(service), 'voice');
  assert.match(html, />General</);
  assert.match(html, />Mute</);
  assert.match(html, />Deafen</);
  assert.match(html, /Participant details are not exposed/);
  assert.doesNotMatch(html, /fake|sample user/i);
});

test('capabilities hide voice controls and disable unsupported channel selection', () => {
  const service = new MockDiscordService();
  const state = connected(service);
  state.capabilities.voiceSettings = false;
  state.capabilities.channelDiscovery = false;
  const html = view.voiceView(state);
  assert.doesNotMatch(html, /data-action="mute"/);
  assert.match(html, /Voice device and volume controls are unavailable/);
  assert.match(html, /id="channel"[^>]* disabled/);
});

test('mute, deafen, guild/channel selection, and leaving update through the service', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  await host.action('mute', true); await host.action('deaf', true);
  await host.action('guild', 'guild'); await host.action('channel', 'music');
  assert.equal(host.getSnapshot().channel.name, 'Music');
  await host.action('leave');
  assert.equal(host.getSnapshot().channel, null);
  assert.deepEqual(service.calls.slice(-5), [['voice', { mute: true }], ['voice', { deaf: true }], ['guild', 'guild'], ['channel', 'music'], ['channel', null]]);
  host.stop();
});

test('service events push voice and channel changes without polling', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  let updates = 0; host.on('update', () => { updates += 1; });
  service.emit('event', { type: 'VOICE_SETTINGS_UPDATE', data: { mute: true } });
  service.emit('event', { type: 'VOICE_CHANNEL_SELECT', data: { id: 'music', name: 'Music' } });
  assert.equal(host.getSnapshot().voice.mute, true);
  assert.equal(host.getSnapshot().channel.name, 'Music');
  assert.equal(updates, 2);
  host.stop();
});

test('participants render only when explicitly supplied by the service', () => {
  const service = new MockDiscordService();
  const state = connected(service);
  state.participants = [{ user: { username: 'Alex' } }];
  assert.match(view.voiceView(state), />Alex</);
  state.participants = null;
  assert.match(view.voiceView(state), /not exposed/);
});

test('navigation renders Voice, Chat, and Activity without panel Settings', () => {
  const service = new MockDiscordService();
  const chat = view.render(connected(service), 'chat');
  assert.match(chat, /data-current-view="chat"/);
  assert.match(chat, /Choose a server/);
  const activity = view.render(connected(service), 'activity');
  assert.match(activity, /data-current-view="activity"/);
  assert.match(activity, /aria-current="page">Activity/);
  assert.doesNotMatch(activity, /Not implemented yet/);
  const legacySettings = view.render(Object.assign(connected(service), { settings: DEFAULT_DISCORD_SETTINGS }), 'settings');
  assert.match(legacySettings, /data-current-view="voice"/);
  assert.doesNotMatch(legacySettings, />Settings|data-settings-form/);
  assert.match(view.render(connected(service), 'voice'), /aria-current="page">Voice/);
});

test('Chat renders guild navigation without any message interface or fake message data', () => {
  const service = new MockDiscordService();
  const html = view.chatView(Object.assign(connected(service), { chat: { guildId: null, channels: [], selected: null, lastSelected: null } }));
  assert.match(html, /Open Quake/);
  assert.match(html, /Choose a server/);
  assert.doesNotMatch(html, /message|composer|send|fake|sample/i);
});

test('Chat filters voice and category channels, then opens a selected text channel', async () => {
  assert.deepEqual(usableTextChannels({ channels: [
    { id: 'text', type: 0 }, { id: 'voice', type: 2 }, { id: 'category', type: 4 },
    { id: 'news', type: 5 }, { id: 'stage', type: 13 }, { id: 'unknown' },
  ] }).map(channel => channel.id), ['text', 'news']);
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  await host.action('chat-guild', 'guild');
  let snapshot = host.getSnapshot();
  assert.equal(snapshot.chat.guildId, 'guild');
  assert.deepEqual(snapshot.chat.channels.map(channel => channel.id), ['general', 'news']);
  assert.doesNotMatch(view.chatView(snapshot), /Voice/);
  await host.action('chat-channel', 'general');
  snapshot = host.getSnapshot();
  assert.equal(snapshot.chat.selected.id, 'general');
  assert.equal(snapshot.chat.lastSelected.id, 'general');
  assert.deepEqual(service.calls.slice(-1), [['chat-channel', 'general']]);
  assert.match(view.chatView(snapshot), /Opened #general/);
  host.stop();
});

test('Chat shows unsupported, empty guild, empty channel, and disconnected states', async () => {
  const service = new MockDiscordService();
  assert.match(view.chatView({ connection: { state: 'connected' }, capabilities: {}, guilds: [], chat: {} }), /Chat launcher unavailable/);
  assert.match(view.chatView({ connection: { state: 'connected' }, capabilities: service.capabilities, guilds: [], chat: {} }), /No Discord servers/);
  assert.match(view.chatView({ connection: { state: 'connected' }, capabilities: service.capabilities, guilds: [{ id: 'g', name: 'Guild' }], chat: { guildId: 'g', channels: [] } }), /No usable text channels/);
  assert.match(view.chatView({ connection: { state: 'disconnected' }, capabilities: {}, chat: {} }), /Discord disconnected/);
});

test('Chat permits explicit safe-on-user-action validation only while selection is unverified', () => {
  const service = new MockDiscordService();
  const state = Object.assign(connected(service), {
    capabilityStates: Object.assign(service.getCapabilityStates(), { textChannelSelection: 'unverified' }),
    chat: { guildId: null, channels: [] },
  });
  assert.match(view.chatView(state), /Choose a server/);
  state.capabilityStates.textChannelSelection = 'unsupported';
  assert.match(view.chatView(state), /Chat launcher unavailable/);
});

test('Chat reports discovery and command failures and retains the last successful selection', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  await host.action('chat-guild', 'guild');
  await host.action('chat-channel', 'general');
  service.selectTextChannel = () => Promise.reject(new Error('Selection failed\n    at private.js:1'));
  await host.action('chat-channel', 'news');
  let snapshot = host.getSnapshot();
  assert.equal(snapshot.chat.selected.id, 'general');
  assert.equal(snapshot.chat.lastSelected.id, 'general');
  assert.equal(snapshot.chat.error, 'Selection failed');
  assert.match(view.chatView(snapshot), /#general/);
  service.getChannels = () => Promise.reject(new Error('Discovery failed'));
  await host.action('chat-guild', 'guild');
  snapshot = host.getSnapshot();
  assert.equal(snapshot.chat.error, 'Discovery failed');
  host.stop();
});

test('renderer cleanup closes its Discord event subscription', () => {
  let closed = 0, pagehide;
  const oldLocation = globalThis.location, oldAdd = globalThis.addEventListener;
  globalThis.location = { search: '' };
  globalThis.addEventListener = (name, fn) => { if (name === 'pagehide') pagehide = fn; };
  const host = { innerHTML: '', addEventListener() {} };
  const doc = { documentElement: { dataset: {}, style: { setProperty() {} } }, getElementById: id => id === 'app' ? host : null };
  const mounted = view.mount(doc, { action: () => Promise.resolve({}), subscribe: () => () => { closed += 1; } });
  mounted.cleanup(); mounted.cleanup();
  assert.equal(closed, 1);
  assert.equal(typeof pagehide, 'function');
  globalThis.location = oldLocation;
  globalThis.addEventListener = oldAdd;
});

test('Activity renders connected voice, channel, guild, capabilities, and Rich Presence state', () => {
  const service = new MockDiscordService();
  const state = Object.assign(connected(service), { settings: Object.assign({}, DEFAULT_DISCORD_SETTINGS, { richPresence: true }) });
  const html = view.activityView(state);
  assert.match(html, />Connected</);
  assert.match(html, /Open Quake/);
  assert.match(html, /General/);
  assert.match(html, /Mic on · Audio on/);
  assert.match(html, /Enabled/);
  assert.match(html, /6 of 6/);
  assert.match(html, /Not exposed by Discord/);
  assert.doesNotMatch(html, /fake|sample|demo server/i);
});

test('Activity degrades cleanly when disconnected or capabilities are unavailable', () => {
  const html = view.activityView({ connection: { state: 'disconnected' }, capabilities: {}, settings: {}, recentEvents: [] });
  assert.match(html, /Disconnected/);
  assert.match(html, /No active server/);
  assert.match(html, /No voice channel selected/);
  assert.match(html, /Rich Presence[\s\S]*Unavailable/);
  assert.match(html, /0 of 6/);
  assert.doesNotMatch(html, /data-action="rich-presence"/);
});

test('Activity recent events are bounded and never expose raw event payloads', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  for (let i = 0; i < RECENT_EVENT_LIMIT + 4; i += 1) service.emit('event', { type: 'VOICE_SETTINGS_UPDATE', data: { mute: !!(i % 2), token: 'secret-' + i } });
  const snapshot = host.getSnapshot();
  assert.equal(snapshot.recentEvents.length, RECENT_EVENT_LIMIT);
  assert.equal(Object.hasOwn(snapshot.recentEvents[0], 'data'), false);
  const html = view.activityView(snapshot);
  assert.match(html, /Voice settings updated/);
  assert.doesNotMatch(html, /secret-|token/);
  host.stop();
});

test('Activity Rich Presence toggle uses the supported service action and persists state', async () => {
  const service = new MockDiscordService(); let saved;
  const host = new DiscordAppHost(service, { saveSettings: value => { saved = value; return true; } });
  host.start(); await host.refresh(); await host.action('rich-presence', true);
  assert.equal(saved.richPresence, true);
  assert.equal(host.getSnapshot().settings.richPresence, true);
  assert.deepEqual(service.calls.at(-1), ['activity', { details: 'Using open-quake' }]);
  host.stop();
});

test('Rich Presence remains unverified until the user invokes the non-destructive toggle path', () => {
  const service = new MockDiscordService();
  const state = Object.assign(connected(service), {
    capabilityStates: Object.assign(service.getCapabilityStates(), { activity: 'unverified' }),
    settings: DEFAULT_DISCORD_SETTINGS,
  });
  const html = view.activityView(state);
  assert.match(html, /Not yet verified/);
  assert.match(html, /Availability will be verified/);
  assert.match(html, /data-action="rich-presence"/);
  state.capabilityStates.activity = 'temporary-error';
  assert.match(view.activityView(state), /data-action="rich-presence"/);
  state.capabilityStates.activity = 'unsupported';
  assert.doesNotMatch(view.activityView(state), /data-action="rich-presence"/);
});

test('Activity sanitizes current errors without rendering stack traces or markup', () => {
  const clean = sanitizeStatusText('Local RPC failed\n    at C:\\private\\discord.js:10 <script>alert(1)</script>');
  assert.equal(clean, 'Local RPC failed');
  const html = view.activityView({ connection: { state: 'error', error: clean }, capabilities: {}, settings: {} });
  assert.match(html, /Local RPC failed/);
  assert.doesNotMatch(html, /private|discord\.js|<script>/);
});

test('Discord setting defaults and invalid values are normalised without retaining unknown secrets', () => {
  assert.deepEqual(normalizeDiscordSettings(null), DEFAULT_DISCORD_SETTINGS);
  const clean = normalizeDiscordSettings({ clientId: ' 123 ', defaultView: 'bad', autoReconnect: 'bad', token: 'never-render-me' });
  assert.equal(clean.enabled, true);
  assert.equal(clean.applicationIdOverride, '123');
  assert.equal(clean.defaultView, 'voice');
  assert.equal(Object.hasOwn(clean, 'token'), false);
  assert.doesNotMatch(view.render({ connection: {}, capabilities: {}, settings: clean }, 'activity'), /never-render-me/);
  assert.equal(normalizeDiscordSettings({ enabled: false, defaultView: 'settings' }).defaultView, 'voice');
  assert.equal(normalizeDiscordSettings({ applicationId: ' legacy-id ' }).applicationIdOverride, 'legacy-id');
  assert.equal(normalizeDiscordSettings({ clientId: ' id<script>\u0000 ' }).applicationIdOverride, 'idscript');
  assert.equal(discordApplicationId({}), DEFAULT_DISCORD_APPLICATION_ID);
  assert.equal(DEFAULT_DISCORD_APPLICATION_ID, '1539959318974169088');
  assert.equal(discordApplicationId({ applicationIdOverride: ' developer-id ' }), 'developer-id');
});

test('panel host rejects settings writes while preserving reconnect and disconnect actions', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service, { getSettings: () => ({ clientId: 'old' }) });
  host.start(); await host.refresh();
  await assert.rejects(host.action('settings', { clientId: 'changed' }), /Unsupported Discord UI action/);
  assert.equal(host.getSnapshot().settings.applicationIdOverride, 'old');
  await host.action('reconnect'); await host.action('disconnect');
  assert.deepEqual(service.calls.slice(-3), [['stop'], ['start'], ['stop']]);
  host.stop();
});

test('host cleanup removes every Discord service listener', () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start();
  assert.equal(service.listenerCount('event'), 1);
  host.stop();
  assert.equal(service.listenerCount('state'), 0);
  assert.equal(service.listenerCount('capabilities'), 0);
  assert.equal(service.listenerCount('event'), 0);
});

test('auth errors remain sanitized in the host snapshot and credentials are redacted', () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service, { getSettings: () => ({ clientId: 'id', clientSecret: 'never-render', token: 'never-render' }) });
  host.start();
  service.emit('state', { state: 'error', authState: 'auth-error', error: 'Authorization failed\n    at C:\\private\\discord.js:1' });
  const snapshot = host.getSnapshot();
  assert.equal(snapshot.connection.authState, 'auth-error');
  assert.equal(snapshot.connection.error, 'Authorization failed');
  assert.equal(Object.hasOwn(snapshot.settings, 'clientSecret'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /never-render|private|discord\.js/);
  host.stop();
});

test('refresh distinguishes empty, unsupported, authentication, and command failures', async () => {
  const service = new MockDiscordService();
  service.voice = {}; service.channel = null; service.getGuilds = () => Promise.resolve({ guilds: [] });
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  assert.equal(host.getSnapshot().refresh.status, 'empty');
  service.capabilities = {}; host.snapshot.capabilities = {}; await host.refresh();
  assert.equal(host.getSnapshot().refresh.status, 'unsupported');
  service.capabilities = { guildDiscovery: true }; host.snapshot.capabilities = service.capabilities;
  service.getGuilds = () => Promise.reject(Object.assign(new Error('authorization failed'), { code: 4006 }));
  await host.refresh(); assert.equal(host.getSnapshot().refresh.status, 'authentication-required');
  service.getGuilds = () => Promise.reject(new Error('RPC command failed\n    at private.js:1'));
  await host.refresh();
  assert.deepEqual(host.getSnapshot().refresh, { status: 'command-error', error: 'RPC command failed' });
  host.stop();
});
