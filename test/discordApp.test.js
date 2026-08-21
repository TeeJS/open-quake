'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DiscordAppHost, RECENT_EVENT_LIMIT, RECENT_MESSAGE_LIMIT, RECENT_NOTIFICATION_LIMIT, sanitizeMessage, sanitizeParticipant, sanitizeStatusText, usableTextChannels, usableVoiceChannels } = require('../app/discordAppHost');
const view = require('../app/discordview');
const { DEFAULT_DISCORD_APPLICATION_ID, DEFAULT_DISCORD_SETTINGS, discordApplicationId, normalizeDiscordSettings } = require('../app/discordSettings');

class MockDiscordService extends EventEmitter {
  constructor() {
    super();
    this.state = { state: 'connected', error: null };
    this.capabilities = { voiceSettings: true, voiceChannelControl: true, guildDiscovery: true, channelDiscovery: true, textChannelSelection: true, activity: true, participants: true, speakingEvents: true, perUserVoiceControl: true, connectionQuality: true, messageEvents: true, messageHistory: true, notifications: true, currentUserEvents: true };
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
  getGuilds() { return Promise.resolve({ guilds: [{ id: 'guild', name: 'Open Quake' }, { id: 'other', name: 'Other Server' }] }); }
  getChannels(id) {
    this.calls.push(['guild', id]);
    if (id === 'other') return Promise.resolve({ channels: [{ id: 'lounge', name: 'Lounge', type: 2, guild_id: 'other' }] });
    return Promise.resolve({ channels: [{ id: 'general', name: 'general', type: 0 }, { id: 'voice', name: 'Voice', type: 2 }, { id: 'music', name: 'Music', type: 2 }, { id: 'news', name: 'news', type: 5 }] });
  }
  getChannel(id) { return Promise.resolve({ id, name: id === 'music' ? 'Music' : id, guild_id: id === 'lounge' ? 'other' : 'guild' }); }
  setVoiceSettings(patch) { this.calls.push(['voice', patch]); this.voice = Object.assign({}, this.voice, patch); return Promise.resolve(patch); }
  selectVoiceChannel(id) { this.calls.push(['channel', id]); this.channel = id ? { id, name: id === 'music' ? 'Music' : id, guild_id: id === 'lounge' ? 'other' : 'guild' } : null; return Promise.resolve(this.channel); }
  selectTextChannel(id) { this.calls.push(['chat-channel', id]); return Promise.resolve({ id, name: id === 'general' ? 'general' : id, type: 0 }); }
  clearTextChannel() { this.calls.push(['clear-text']); return Promise.resolve(); }
  setUserVoiceSettings(id, value) { this.calls.push(['participant', id, value]); return Promise.resolve(Object.assign({ user_id: id }, value)); }
  start() { this.calls.push(['start']); }
  stop() { this.calls.push(['stop']); }
  configure(value) { this.calls.push(['configure', value]); }
  setAutoReconnect(value) { this.autoReconnect = value; this.calls.push(['autoReconnect', value]); }
  setActivity(value) { this.calls.push(['activity', value]); return Promise.resolve(); }
}

const connected = service => ({
  connection: service.state, capabilities: service.capabilities, voice: service.voice, channel: service.channel,
  guilds: [{ id: 'guild', name: 'Open Quake' }, { id: 'other', name: 'Other Server' }],
  voiceSelection: { guildId: 'guild', channelId: 'voice', channels: [{ id: 'voice', name: 'General', type: 2 }], initialized: true, status: null, error: null }, participants: [],
});

test('Discord layout is fixed to 1920x480 conventions with large touch controls and truncation', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/discordview.css'), 'utf8');
  assert.match(css, /height:\s*480px/);
  assert.match(css, /min-height:\s*56px/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /overflow:\s*hidden/);
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /:focus-visible/);
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
  assert.match(html, /No participants are exposed/);
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

test('Voice guild selection is independent of the connected guild and survives unrelated live events', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  await host.action('guild', 'other');
  let snapshot = host.getSnapshot();
  assert.equal(snapshot.channel.guild_id, 'guild');
  assert.equal(snapshot.voiceSelection.guildId, 'other');
  assert.equal(snapshot.voiceSelection.channelId, null);
  assert.deepEqual(snapshot.voiceSelection.channels.map(channel => channel.id), ['lounge']);
  service.emit('event', { type: 'VOICE_CONNECTION_STATUS', data: { state: 'VOICE_CONNECTED', last_ping: 18 } });
  service.emit('event', { type: 'SPEAKING_START', data: { user_id: 'someone' } });
  snapshot = host.getSnapshot();
  assert.equal(snapshot.voiceSelection.guildId, 'other');
  assert.equal(snapshot.channel.guild_id, 'guild');
  assert.match(view.voiceView(snapshot), /<option value="other" selected>Other Server<\/option>/);
  await host.action('channel', 'lounge');
  snapshot = host.getSnapshot();
  assert.equal(snapshot.channel.id, 'lounge');
  assert.equal(snapshot.channel.guild_id, 'other');
  assert.equal(snapshot.voiceSelection.channelId, 'lounge');
  assert.deepEqual(service.calls.slice(-2), [['guild', 'other'], ['channel', 'lounge']]);
  host.stop();
});

test('Voice channel discovery exposes loading, error, and empty states without disabling guild discovery', async () => {
  assert.deepEqual(usableVoiceChannels({ channels: [
    { id: 'text', type: 0 }, { id: 'voice', type: 2 }, { id: 'stage', type: 13 }, { id: 'category', type: 4 },
  ] }).map(channel => channel.id), ['voice', 'stage']);
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  let release;
  service.getChannels = id => id === 'other' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ channels: [] });
  const loading = host.action('guild', 'other');
  let snapshot = host.getSnapshot();
  assert.equal(snapshot.voiceSelection.guildId, 'other');
  assert.equal(snapshot.voiceSelection.status, 'Loading voice channels…');
  assert.deepEqual(snapshot.voiceSelection.channels, []);
  assert.match(view.voiceView(snapshot), /Loading voice channels…/);
  release({ channels: [{ id: 'lounge', name: 'Lounge', type: 2 }] });
  await loading;
  assert.deepEqual(host.getSnapshot().voiceSelection.channels.map(channel => channel.id), ['lounge']);

  service.getChannels = () => Promise.reject(new Error('Discovery failed\n    at private.js:1'));
  await host.action('guild', 'other');
  snapshot = host.getSnapshot();
  assert.equal(snapshot.voiceSelection.status, null);
  assert.equal(snapshot.voiceSelection.error, 'Discovery failed');
  assert.deepEqual(snapshot.voiceSelection.channels, []);
  const errorHtml = view.voiceView(snapshot);
  assert.match(errorHtml, /Discovery failed/);
  assert.doesNotMatch(errorHtml, /id="guild"[^>]* disabled/);
  assert.match(errorHtml, /id="channel"[^>]* disabled/);

  service.getChannels = () => Promise.resolve({ channels: [{ id: 'rules', name: 'rules', type: 0 }] });
  await host.action('guild', 'other');
  snapshot = host.getSnapshot();
  assert.equal(snapshot.voiceSelection.error, null);
  assert.deepEqual(snapshot.voiceSelection.channels, []);
  assert.match(view.voiceView(snapshot), /No voice channels are available in this server/);
  host.stop();
});

test('service events push voice and channel changes without polling', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  let updates = 0; host.on('update', () => { updates += 1; });
  service.emit('event', { type: 'VOICE_SETTINGS_UPDATE', data: { mute: true } });
  service.emit('event', { type: 'VOICE_CHANNEL_SELECT', data: { channel_id: 'music', guild_id: 'guild' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.getSnapshot().voice.mute, true);
  assert.equal(host.getSnapshot().channel.name, 'Music');
  assert.ok(updates >= 2);
  host.stop();
});

test('participants render only when explicitly supplied by the service', () => {
  const service = new MockDiscordService();
  const state = connected(service);
  state.participants = [{ id: '1', username: 'Alex', nick: 'Alex', speaking: true, localMute: false, volume: 100 }];
  const html = view.voiceView(state);
  assert.match(html, />Alex</);
  assert.match(html, /participant speaking/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /<output>100%<\/output>/);
  state.participants = [];
  assert.match(view.voiceView(state), /No participants/);
});

test('voice participant events, speaking state, and per-user controls update sanitized state', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  service.emit('event', { type: 'VOICE_STATE_CREATE', data: {
    user: { id: '42', username: 'alex', global_name: 'Alex', avatar: 'hash', email: 'drop' }, nick: 'Alex Q',
    voice_state: { mute: false, deaf: false, self_mute: true, self_deaf: false }, mute: false, volume: 120,
    pan: { left: 0.4, right: 0.6 }, token: 'drop',
  } });
  service.emit('event', { type: 'SPEAKING_START', data: { user_id: '42' } });
  service.emit('event', { type: 'VOICE_STATE_UPDATE', data: { user: { id: '42' }, volume: 130 } });
  let participant = host.getSnapshot().participants[0];
  assert.deepEqual(participant, {
    id: '42', username: 'alex', displayName: 'Alex', nick: 'Alex Q',
    avatarUrl: 'https://cdn.discordapp.com/avatars/42/hash.png', mute: false, deaf: false,
    selfMute: true, selfDeaf: false, localMute: false, volume: 130,
    pan: { left: 0.4, right: 0.6 }, speaking: true,
  });
  await host.action('participant-mute', { userId: '42', value: true });
  await host.action('participant-volume', { userId: '42', value: 175 });
  participant = host.getSnapshot().participants[0];
  assert.equal(participant.localMute, true);
  assert.equal(participant.volume, 175);
  assert.equal(host.getSnapshot().voiceControlLock, true);
  assert.deepEqual(service.calls.slice(-2), [['participant', '42', { mute: true }], ['participant', '42', { volume: 175 }]]);
  service.emit('event', { type: 'SPEAKING_STOP', data: { user_id: '42' } });
  service.emit('event', { type: 'VOICE_STATE_DELETE', data: { user: { id: '42' } } });
  assert.deepEqual(host.getSnapshot().participants, []);
  host.stop();
});

test('navigation renders Voice, Chat, and Activity without panel Settings', () => {
  const service = new MockDiscordService();
  const chat = view.render(connected(service), 'chat');
  assert.match(chat, /data-current-view="chat"/);
  assert.match(chat, /Choose a server/);
  const activity = view.render(connected(service), 'activity');
  assert.match(activity, /data-current-view="activity"/);
  assert.match(activity, /aria-current="page"[\s\S]*?>[\s\S]*?Activity/);
  assert.doesNotMatch(activity, /Not implemented yet/);
  const legacySettings = view.render(Object.assign(connected(service), { settings: DEFAULT_DISCORD_SETTINGS }), 'settings');
  assert.match(legacySettings, /data-current-view="voice"/);
  assert.doesNotMatch(legacySettings, />Settings|data-settings-form/);
  assert.match(view.render(connected(service), 'voice'), /aria-current="page"[\s\S]*?>[\s\S]*?Voice/);
});

test('Chat renders guild navigation and an honest empty message surface without a composer', () => {
  const service = new MockDiscordService();
  const html = view.chatView(Object.assign(connected(service), { chat: { guildId: null, channels: [], selected: null, lastSelected: null } }));
  assert.match(html, /Open Quake/);
  assert.match(html, /Choose a server/);
  assert.match(html, /Recent messages/);
  assert.doesNotMatch(html, /composer|data-action="send"|fake|sample/i);
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

test('Chat consumes historical and live message create/update/delete data with bounded sanitized history', async () => {
  const service = new MockDiscordService();
  service.selectTextChannel = id => Promise.resolve({ id, name: 'general', type: 0, messages: [{ id: 'old', content: 'history', timestamp: '2026-01-01T00:00:00Z', author: { id: '1', username: 'Alex', email: 'drop' } }] });
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  await host.action('chat-guild', 'guild'); await host.action('chat-channel', 'general');
  assert.equal(host.getSnapshot().chat.historyAvailable, true);
  assert.equal(host.getSnapshot().chat.messages[0].content, 'history');
  for (let i = 0; i < RECENT_MESSAGE_LIMIT + 3; i += 1) service.emit('event', { type: 'MESSAGE_CREATE', data: { channel_id: 'general', message: { id: 'm' + i, content: 'message ' + i, author: { id: '2', username: 'Casey', token: 'drop' } } } });
  service.emit('event', { type: 'MESSAGE_UPDATE', data: { channel_id: 'general', message: { id: 'm22', content: 'edited', edited_timestamp: '2026-01-01T00:00:01Z' } } });
  service.emit('event', { type: 'MESSAGE_DELETE', data: { channel_id: 'general', message: { id: 'm22' } } });
  const snapshot = host.getSnapshot();
  assert.equal(snapshot.chat.messages.length, RECENT_MESSAGE_LIMIT);
  const changed = snapshot.chat.messages.find(item => item.id === 'm22');
  assert.equal(changed.deleted, true);
  assert.equal(changed.author.username, 'Casey');
  assert.doesNotMatch(JSON.stringify(snapshot.chat.messages), /token|drop/);
  const html = view.chatView(snapshot);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /Open in Discord/);
  assert.match(html, /<time>/);
  assert.match(html, /Message deleted/);
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

test('live updates wait for an open Voice selector and selector clicks do not dispatch button actions', async () => {
  const service = new MockDiscordService();
  const initial = connected(service);
  const updated = Object.assign({}, initial, { voice: Object.assign({}, initial.voice, { mute: true }) });
  const selectedOther = Object.assign({}, updated, {
    voiceSelection: { guildId: 'other', channelId: null, channels: [], status: 'Loading voice channels…', error: null, initialized: true },
  });
  let subscriber, writes = 0;
  const handlers = {}, actions = [];
  const oldLocation = globalThis.location, oldAdd = globalThis.addEventListener, oldRemove = globalThis.removeEventListener;
  globalThis.location = { search: '' };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  const host = {
    _html: '',
    set innerHTML(value) { this._html = value; writes += 1; },
    get innerHTML() { return this._html; },
    addEventListener(name, fn) { handlers[name] = fn; },
    removeEventListener() {},
    querySelectorAll() { return []; },
  };
  const doc = { documentElement: { dataset: {}, style: { setProperty() {} } }, getElementById: id => id === 'app' ? host : null };
  const mounted = view.mount(doc, {
    action: (name, value) => { actions.push([name, value]); return Promise.resolve(selectedOther); },
    subscribe: onData => { subscriber = onData; return () => {}; },
  });
  const select = { tagName: 'SELECT', type: 'select-one', disabled: false, value: 'other', dataset: { action: 'guild' }, closest: () => null };
  handlers.click({ target: select });
  assert.deepEqual(actions, []);
  handlers.focusin({ target: select });
  subscriber(updated);
  assert.equal(writes, 1);
  assert.equal(view.createRenderController != null, true);
  handlers.change({ target: select });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, [['guild', 'other']]);
  assert.equal(writes, 2);
  assert.match(host.innerHTML, /<option value="other" selected>Other Server<\/option>/);
  mounted.cleanup();
  globalThis.location = oldLocation;
  globalThis.addEventListener = oldAdd;
  globalThis.removeEventListener = oldRemove;
});

test('the reusable live renderer preserves Chat scroll positions across unrelated updates', () => {
  let html = 'first';
  const before = { scrollTop: 86, scrollLeft: 4, getAttribute: () => 'chat-messages' };
  const after = { scrollTop: 0, scrollLeft: 0, getAttribute: () => 'chat-messages' };
  let current = [before];
  const host = {
    set innerHTML(value) { this.value = value; current = [after]; },
    querySelectorAll() { return current; },
  };
  const renderer = view.createRenderController(host, () => html);
  renderer.paint();
  after.scrollTop = 86; after.scrollLeft = 4;
  html = 'second';
  renderer.paint();
  assert.equal(after.scrollTop, 86);
  assert.equal(after.scrollLeft, 4);
});

test('renderer cleanup closes its Discord event subscription', () => {
  let closed = 0, pagehide, removed = 0;
  const oldLocation = globalThis.location, oldAdd = globalThis.addEventListener, oldRemove = globalThis.removeEventListener;
  globalThis.location = { search: '' };
  globalThis.addEventListener = (name, fn) => { if (name === 'pagehide') pagehide = fn; };
  globalThis.removeEventListener = () => {};
  const host = { innerHTML: '', addEventListener() {}, removeEventListener() { removed += 1; } };
  const doc = { documentElement: { dataset: {}, style: { setProperty() {} } }, getElementById: id => id === 'app' ? host : null };
  const mounted = view.mount(doc, { action: () => Promise.resolve({}), subscribe: () => () => { closed += 1; } });
  mounted.cleanup(); mounted.cleanup();
  assert.equal(closed, 1);
  assert.equal(removed, 8);
  assert.equal(typeof pagehide, 'function');
  globalThis.location = oldLocation;
  globalThis.addEventListener = oldAdd;
  globalThis.removeEventListener = oldRemove;
});

test('Activity renders connected account, voice, channel, guild, capabilities, and Rich Presence state', () => {
  const service = new MockDiscordService();
  const state = Object.assign(connected(service), { currentUser: { id: 'me', username: 'cmdr', global_name: 'Cmdr Woodbark' }, settings: Object.assign({}, DEFAULT_DISCORD_SETTINGS, { richPresence: true }) });
  const html = view.activityView(state);
  assert.match(html, />Connected</);
  assert.match(html, /Signed in as[\s\S]*Cmdr Woodbark/);
  assert.match(html, /Open Quake/);
  assert.match(html, /General/);
  assert.match(html, /Mic on · Audio on/);
  assert.match(html, /Enabled/);
  assert.match(html, /14 of 14/);
  assert.match(html, /No live status/);
  assert.doesNotMatch(html, /fake|sample|demo server/i);
});

test('Activity degrades cleanly when disconnected or capabilities are unavailable', () => {
  const html = view.activityView({ connection: { state: 'disconnected' }, capabilities: {}, settings: {}, recentEvents: [] });
  assert.match(html, /Disconnected/);
  assert.match(html, /No active server/);
  assert.match(html, /No voice channel selected/);
  assert.match(html, /Rich Presence[\s\S]*Unavailable/);
  assert.match(html, /0 of 14/);
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

test('voice connection quality and bounded notifications expose only useful sanitized fields', async () => {
  const service = new MockDiscordService();
  const host = new DiscordAppHost(service); host.start(); await host.refresh();
  service.emit('event', { type: 'VOICE_CONNECTION_STATUS', data: { state: 'VOICE_CONNECTED', hostname: 'private.discord.gg', pings: Array.from({ length: 25 }, (_, i) => i), average_ping: 12.5, last_ping: 11 } });
  for (let i = 0; i < RECENT_NOTIFICATION_LIMIT + 2; i += 1) service.emit('event', { type: 'NOTIFICATION_CREATE', data: { channel_id: 'general', title: 'Mention', body: 'Hello ' + i, icon_url: 'https://cdn.discordapp.com/icon.png', secret: 'drop' } });
  const snapshot = host.getSnapshot();
  assert.deepEqual(snapshot.voiceConnection, { state: 'VOICE_CONNECTED', lastPing: 11, averagePing: 12.5, pings: Array.from({ length: 20 }, (_, i) => i + 5) });
  assert.equal(snapshot.notifications.length, RECENT_NOTIFICATION_LIMIT);
  assert.doesNotMatch(JSON.stringify(snapshot), /private\.discord\.gg|secret|drop/);
  assert.match(view.activityView(snapshot), /VOICE_CONNECTED/);
  assert.match(view.activityView(snapshot), /Mention/);
  host.stop();
});

test('Discord data sanitizers reject raw secrets and clamp participant controls', () => {
  assert.deepEqual(sanitizeMessage({ id: 'm', content: '<script>hello</script>\n', author: { id: 'u', username: 'User', token: 'secret' }, token: 'secret' }, 'c').author, { id: 'u', username: 'User', displayName: null, avatarUrl: null });
  const participant = sanitizeParticipant({ user: { id: 'u', username: 'User' }, volume: 999, pan: { left: -1, right: 3 }, token: 'secret' });
  assert.equal(participant.volume, 200);
  assert.deepEqual(participant.pan, { left: 0, right: 1 });
  assert.doesNotMatch(JSON.stringify(participant), /secret|token/);
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
