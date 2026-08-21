'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { DiscordService } = require('../app/discordService');

class MockTransport extends EventEmitter {
  constructor(connectError) { super(); this.connectError = connectError; this.requests = []; this.responses = new Map(); this.disconnected = false; }
  async connect() { if (this.connectError) throw this.connectError; return {}; }
  request(command, args) {
    this.requests.push({ command, args });
    const value = this.responses.get(command);
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }
  disconnect() { this.disconnected = true; }
}

async function startService(transport, options) {
  const oauth = { accessToken: async () => 'stored-token', exchange: async () => 'new-token', deleteTokens() {} };
  const service = new DiscordService(Object.assign({ clientId: '123', transportFactory: () => transport, oauth }, options));
  const connected = new Promise(resolve => service.on('state', value => { if (value.state === 'connected') resolve(); }));
  service.start();
  await connected;
  return service;
}

test('READY is followed by AUTHENTICATE and capabilities require successful probes/use', async () => {
  const transport = new MockTransport();
  const service = await startService(transport);
  assert.equal(service.getState().state, 'connected');
  assert.equal(transport.requests[0].command, 'AUTHENTICATE');
  assert.deepEqual(new Set(transport.requests.slice(1, 4).map(value => value.command)), new Set(['GET_VOICE_SETTINGS', 'GET_SELECTED_VOICE_CHANNEL', 'GET_GUILDS']));
  assert.equal(service.getState().authState, 'authenticated');
  assert.equal(service.getCapabilities().guildDiscovery, true);
  assert.equal(service.getCapabilities().activity, false);
  assert.equal(service.getCapabilityStates().activity, 'unverified');
  await assert.rejects(service._request('READ_MESSAGES'), error => error.code === 'DISCORD_UNSUPPORTED_COMMAND');
  service.stop();
});

test('browser PKCE authorization completes before RPC AUTHENTICATE', async () => {
  const transport = new MockTransport();
  let authorizations = 0;
  let token = null;
  const oauth = { accessToken: async () => token, authorize: async () => { authorizations += 1; token = 'access-token'; return token; }, deleteTokens() {} };
  const service = new DiscordService({ clientId: '123', transportFactory: () => transport, oauth, autoReconnect: false });
  await service.authorize();
  assert.deepEqual(transport.requests[0], { command: 'AUTHENTICATE', args: { access_token: 'access-token' } });
  assert.equal(authorizations, 1);
  service.stop();
});

test('AUTHENTICATE failure reports auth-error and never probes authenticated commands', async () => {
  const transport = new MockTransport();
  transport.responses.set('AUTHENTICATE', Object.assign(new Error('bad token'), { code: 4006 }));
  const service = new DiscordService({ clientId: '123', transportFactory: () => transport, oauth: { accessToken: async () => 'bad', deleteTokens() {} }, autoReconnect: false });
  service.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getState().authState, 'auth-error');
  assert.equal(service.getState().state, 'error');
  assert.deepEqual(transport.requests.map(value => value.command), ['AUTHENTICATE']);
  service.stop();
});

test('failed explicit public-client authorization transitions from authorizing to auth-error', async () => {
  const transport = new MockTransport();
  const states = [];
  const service = new DiscordService({
    clientId: '123', transportFactory: () => transport, autoReconnect: false,
    oauth: { accessToken: async () => null, authorize: async () => { throw Object.assign(new Error('state mismatch'), { code: 'DISCORD_AUTH_STATE' }); } },
  });
  service.on('state', value => states.push(value.authState));
  await assert.rejects(service.authorize(), error => error.code === 'DISCORD_AUTH_STATE');
  assert.ok(states.includes('authorizing'));
  assert.equal(service.getState().authState, 'auth-error');
  assert.equal(service.getCapabilities().guildDiscovery, false);
  assert.deepEqual(transport.requests, []);
  service.stop();
});

test('authenticated commands reject before auth and 4006 becomes an auth failure', async () => {
  const idle = new DiscordService({ clientId: '123' });
  await assert.rejects(idle.getGuilds(), error => error.code === 'DISCORD_AUTH_REQUIRED');
  const transport = new MockTransport();
  const service = await startService(transport);
  transport.responses.set('GET_GUILDS', Object.assign(new Error('not authenticated'), { code: 4006 }));
  await assert.rejects(service.getGuilds(), error => error.code === 'DISCORD_AUTH_REQUIRED');
  assert.equal(service.getState().authState, 'auth-error');
  assert.equal(service.getCapabilities().guildDiscovery, false);
  service.stop();
});

test('RPC 4006 clears tokens and explicit reconnect performs public-client re-authorization', async () => {
  const transports = [new MockTransport(), new MockTransport()];
  let transportIndex = 0, storedToken = 'stored-token', authorizations = 0;
  const oauth = {
    accessToken: async () => storedToken,
    authorize: async () => { authorizations += 1; storedToken = 'reauthorized-token'; return storedToken; },
    deleteTokens: () => { storedToken = null; },
  };
  const service = await startService(transports[0], {
    oauth, transportFactory: () => transports[transportIndex++], autoReconnect: false,
  });
  transports[0].responses.set('GET_GUILDS', Object.assign(new Error('not authenticated'), { code: 4006 }));
  await assert.rejects(service.getGuilds(), error => error.code === 'DISCORD_AUTH_REQUIRED');
  assert.equal(storedToken, null);
  await service.authorize();
  assert.equal(authorizations, 1);
  assert.deepEqual(transports[1].requests[0], { command: 'AUTHENTICATE', args: { access_token: 'reauthorized-token' } });
  assert.equal(service.getState().authState, 'authenticated');
  service.stop();
});

test('voice settings only preserve schema fields actually present', async () => {
  const transport = new MockTransport();
  transport.responses.set('GET_VOICE_SETTINGS', { mute: true, input: { device_id: 'mic', volume: 80 }, invented: 'drop' });
  transport.responses.set('SET_VOICE_SETTINGS', { mute: false });
  const service = await startService(transport);
  assert.deepEqual(await service.getVoiceSettings(), { input: { device_id: 'mic', volume: 80 }, mute: true });
  assert.deepEqual(await service.setVoiceSettings({ mute: false, invented: true, output: { volume: 50 } }), { mute: false });
  assert.deepEqual(transport.requests.find(value => value.command === 'SET_VOICE_SETTINGS'), { command: 'SET_VOICE_SETTINGS', args: { output: { volume: 50 }, mute: false } });
  service.stop();
});

test('selected voice channel, guilds, and channels use typed command arguments and responses', async () => {
  const transport = new MockTransport();
  transport.responses.set('GET_SELECTED_VOICE_CHANNEL', { id: 'voice' });
  transport.responses.set('GET_GUILDS', { guilds: [{ id: 'g' }] });
  transport.responses.set('GET_GUILD', { id: 'g' });
  transport.responses.set('GET_CHANNELS', { channels: [{ id: 'c' }] });
  transport.responses.set('GET_CHANNEL', { id: 'c' });
  transport.responses.set('SELECT_TEXT_CHANNEL', { id: 'text' });
  const service = await startService(transport);
  assert.deepEqual(await service.getSelectedVoiceChannel(), { id: 'voice' });
  assert.deepEqual(await service.getGuilds(), { guilds: [{ id: 'g' }] });
  assert.deepEqual(await service.getGuild('g'), { id: 'g' });
  assert.deepEqual(await service.getChannels('g'), { channels: [{ id: 'c' }] });
  assert.deepEqual(await service.getChannel('c'), { id: 'c' });
  assert.deepEqual(await service.selectTextChannel('text'), { id: 'text' });
  assert.deepEqual(transport.requests.filter(value => ['GET_GUILD', 'GET_CHANNELS', 'GET_CHANNEL', 'SELECT_TEXT_CHANNEL'].includes(value.command)).slice(-4), [
    { command: 'GET_GUILD', args: { guild_id: 'g' } },
    { command: 'GET_CHANNELS', args: { guild_id: 'g' } },
    { command: 'GET_CHANNEL', args: { channel_id: 'c' } },
    { command: 'SELECT_TEXT_CHANNEL', args: { channel_id: 'text' } },
  ]);
  service.stop();
});

test('Discord errors disable the affected capability', async () => {
  const transport = new MockTransport();
  transport.responses.set('SELECT_TEXT_CHANNEL', Object.assign(new Error('invalid command'), { code: 4002 }));
  const service = await startService(transport);
  await assert.rejects(service.selectTextChannel('c'));
  assert.equal(service.getCapabilities().textChannelSelection, false);
  await assert.rejects(service.selectTextChannel('c'), error => error.code === 'DISCORD_UNSUPPORTED_CAPABILITY');
  service.stop();
});

test('read-only capability probes validate channels while mutating commands stay unverified', async () => {
  const transport = new MockTransport();
  transport.responses.set('GET_GUILDS', { guilds: [{ id: 'guild' }] });
  transport.responses.set('GET_CHANNELS', { channels: [] });
  const service = await startService(transport);
  assert.deepEqual(service.getCapabilityStates(), {
    voiceSettings: 'available', voiceChannelControl: 'available', guildDiscovery: 'available',
    channelDiscovery: 'available', textChannelSelection: 'unverified', activity: 'unverified',
  });
  assert.deepEqual(transport.requests.find(value => value.command === 'GET_CHANNELS'), { command: 'GET_CHANNELS', args: { guild_id: 'guild' } });
  assert.equal(transport.requests.some(value => value.command === 'SELECT_TEXT_CHANNEL' || value.command === 'SET_ACTIVITY'), false);
  await service.selectTextChannel('text');
  await service.setActivity({ details: 'Using open-quake' });
  assert.equal(service.getCapabilityStates().textChannelSelection, 'available');
  assert.equal(service.getCapabilityStates().activity, 'available');
  service.stop();
});

test('capabilities distinguish unsupported, temporary, and authentication failures', async () => {
  const transport = new MockTransport();
  const service = await startService(transport, { autoReconnect: false });
  transport.responses.set('GET_CHANNELS', Object.assign(new Error('invalid command'), { code: 4002 }));
  await assert.rejects(service.getChannels('guild'));
  assert.equal(service.getCapabilityStates().channelDiscovery, 'unsupported');
  transport.responses.set('SET_ACTIVITY', Object.assign(new Error('try again'), { code: 4999 }));
  await assert.rejects(service.setActivity(null));
  assert.equal(service.getCapabilityStates().activity, 'temporary-error');
  transport.responses.set('GET_GUILDS', Object.assign(new Error('permission denied'), { code: 4006 }));
  await assert.rejects(service.getGuilds(), error => error.code === 'DISCORD_AUTH_REQUIRED');
  assert.ok(Object.values(service.getCapabilityStates()).every(state => state === 'auth-failure'));
  service.stop();
});

test('authorization is explicit and disconnect removes tokens and identity', async () => {
  const transport = new MockTransport();
  transport.responses.set('AUTHENTICATE', { user: { id: '42', username: 'alex', global_name: 'Alex', token: 'drop' } });
  let authorized = 0, deleted = 0, stored = false;
  const oauth = {
    accessToken: async () => stored ? 'token' : null,
    authorize: async () => { authorized += 1; stored = true; return 'token'; },
    deleteTokens: () => { deleted += 1; stored = false; },
  };
  const service = new DiscordService({ clientId: '123', transportFactory: () => transport, oauth, autoReconnect: false });
  service.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(authorized, 0);
  assert.equal(service.getState().authState, 'authorization-required');
  await service.authorize();
  assert.equal(authorized, 1);
  assert.deepEqual(service.getIdentity(), { id: '42', username: 'alex', global_name: 'Alex' });
  service.disconnectAuthorization();
  assert.equal(deleted, 1);
  assert.equal(service.getIdentity(), null);
  assert.equal(service.getState().authState, 'authorization-required');
});

test('events dispatch by generic and Discord event names', async () => {
  const transport = new MockTransport();
  const service = await startService(transport);
  const generic = [];
  const voice = [];
  service.on('event', event => generic.push(event));
  service.on('VOICE_CHANNEL_SELECT', data => voice.push(data));
  transport.emit('event', { type: 'VOICE_CHANNEL_SELECT', data: { id: 'v' } });
  assert.deepEqual(generic, [{ type: 'VOICE_CHANNEL_SELECT', data: { id: 'v' } }]);
  assert.deepEqual(voice, [{ id: 'v' }]);
  service.stop();
});

test('disconnect schedules bounded reconnect backoff and cleans old listeners', async () => {
  const timers = [];
  const transports = [new MockTransport(), new MockTransport(), new MockTransport()];
  let index = 0;
  const service = await startService(transports[0], {
    transportFactory: () => transports[index++],
    backoff: [10, 20],
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => {},
  });
  transports[0].emit('disconnect', new Error('closed'));
  assert.equal(service.getState().state, 'reconnecting');
  assert.equal(timers[0].delay, 10);
  assert.equal(transports[0].listenerCount('event'), 0);
  timers.shift().fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transports[1].requests[0].command, 'AUTHENTICATE');
  transports[1].emit('disconnect', new Error('closed again'));
  assert.equal(timers[0].delay, 10); // a successful reconnect resets the backoff
  service.stop();
  assert.equal(transports[1].listenerCount('disconnect'), 0);
});

test('unavailable Discord becomes not-running and retries with increasing delays', async () => {
  const timers = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'DISCORD_NOT_RUNNING' });
  const service = new DiscordService({
    clientId: '123', transportFactory: () => new MockTransport(missing()), oauth: { accessToken: async () => 'token' }, backoff: [5, 10],
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer: () => {},
  });
  service.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getState().state, 'not-running');
  assert.equal(timers[0].delay, 5);
  timers.shift().fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers[0].delay, 10);
  service.stop();
});

test('automatic reconnect can be disabled without leaving a pending retry', async () => {
  const timers = [];
  const transport = new MockTransport();
  const service = await startService(transport, {
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer: id => { timers[id - 1].cleared = true; },
  });
  transport.emit('disconnect', new Error('closed'));
  assert.equal(timers.length, 1);
  service.setAutoReconnect(false);
  assert.equal(timers[0].cleared, true);
  assert.equal(service.getState().state, 'disconnected');
  service.stop();
});
