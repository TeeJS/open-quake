'use strict';

const { EventEmitter } = require('events');
const { DiscordRpcTransport } = require('./discordRpcTransport');

const COMMAND_CAPABILITY = Object.freeze({
  GET_VOICE_SETTINGS: 'voiceSettings', SET_VOICE_SETTINGS: 'voiceSettings',
  SET_USER_VOICE_SETTINGS: 'perUserVoiceControl',
  GET_SELECTED_VOICE_CHANNEL: 'voiceChannelControl', SELECT_VOICE_CHANNEL: 'voiceChannelControl',
  GET_GUILDS: 'guildDiscovery', GET_GUILD: 'guildDiscovery',
  GET_CHANNELS: 'channelDiscovery', GET_CHANNEL: 'channelDiscovery',
  SELECT_TEXT_CHANNEL: 'textChannelSelection', SET_ACTIVITY: 'activity',
});
const SUBSCRIPTION_CAPABILITY = Object.freeze({
  VOICE_STATE_CREATE: 'participants', VOICE_STATE_UPDATE: 'participants', VOICE_STATE_DELETE: 'participants',
  SPEAKING_START: 'speakingEvents', SPEAKING_STOP: 'speakingEvents',
  VOICE_CONNECTION_STATUS: 'connectionQuality',
  MESSAGE_CREATE: 'messageEvents', MESSAGE_UPDATE: 'messageEvents', MESSAGE_DELETE: 'messageEvents',
  NOTIFICATION_CREATE: 'notifications', CURRENT_USER_UPDATE: 'currentUserEvents',
});
const CAPABILITIES = Object.freeze([...new Set([...Object.values(COMMAND_CAPABILITY), ...Object.values(SUBSCRIPTION_CAPABILITY), 'messageHistory'])]);
const UNSUPPORTED_CODES = new Set([4001, 4002, 4005]);
const AUTH_CODES = new Set([4006]);
const VOICE_CHANNEL_EVENTS = Object.freeze(['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP']);
const TEXT_CHANNEL_EVENTS = Object.freeze(['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE']);
const GLOBAL_EVENTS = Object.freeze(['VOICE_CONNECTION_STATUS', 'NOTIFICATION_CREATE', 'CURRENT_USER_UPDATE']);
const VOICE_FIELDS = Object.freeze({
  input: { device_id: true, volume: true, available_devices: true },
  output: { device_id: true, volume: true, available_devices: true },
  mode: { type: true, auto_threshold: true, threshold: true, shortcut: true, delay: true },
  automatic_gain_control: true, echo_cancellation: true, noise_suppression: true,
  qos: true, silence_warning: true, deaf: true, mute: true,
});

function projectPresent(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, child] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    out[key] = child === true ? value[key] : projectPresent(value[key], child);
  }
  return out;
}

function cleanDiscordIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = {};
  for (const key of ['id', 'username', 'global_name', 'discriminator']) {
    if (typeof value[key] === 'string' && value[key]) identity[key] = value[key].slice(0, 128);
  }
  return identity.id || identity.username ? identity : null;
}

class DiscordService extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.clientId = String(opts.clientId || '');
    this.transportFactory = opts.transportFactory || (clientId => new DiscordRpcTransport({ clientId }));
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;
    this.backoff = opts.backoff || [1000, 2000, 5000, 10000, 30000];
    this.state = 'disconnected';
    this.emittedAuthState = null;
    this.lastError = null;
    this.transport = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.stopped = true;
    this.autoReconnect = opts.autoReconnect !== false;
    this.oauth = opts.oauth || null;
    this.authState = 'authorization-required';
    this.identity = null;
    this.capabilities = Object.fromEntries(CAPABILITIES.map(name => [name, false]));
    this.capabilityState = Object.fromEntries(CAPABILITIES.map(name => [name, 'unverified']));
    this.subscriptions = new Map();
    this.activeVoiceChannelId = null;
    this.activeTextChannelId = null;
    this.subscriptionGeneration = 0;
    this.subscriptionQueues = { voice: Promise.resolve(), text: Promise.resolve() };
    this._onTransportEvent = event => this._handleTransportEvent(event);
    this._onTransportDisconnect = error => this._handleDisconnect(error);
    this._onProtocolError = error => this._setState('error', error);
  }

  configure(clientId) {
    const next = String(clientId || '');
    if (next === this.clientId) return;
    const restart = !this.stopped;
    this.stop();
    this.clientId = next;
    if (restart) this.start();
  }

  setAutoReconnect(value) {
    this.autoReconnect = value !== false;
    if (!this.autoReconnect && this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
      if (this.state === 'reconnecting') this._setState('disconnected');
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.retryAttempt = 0;
    this._connect(false);
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this._detachTransport(true);
    this._clearSubscriptions();
    this._setCapabilities('unverified');
    this._setState('disconnected');
  }

  async authorize() {
    if (!this.oauth || !this.oauth.authorize) throw Object.assign(new Error('Discord authorization is unavailable'), { code: 'DISCORD_AUTH_CONFIGURATION' });
    this.authState = 'authorizing'; this._setState(this.state);
    try { await this.oauth.authorize(); }
    catch (error) { this.authState = 'auth-error'; this._setState('error', error); throw error; }
    this.authState = 'authorization-required';
    const restart = !this.stopped;
    this.stop();
    this.stopped = false;
    await this._connect(restart);
    return this.getState();
  }

  disconnectAuthorization() {
    this.stop();
    if (this.oauth && this.oauth.deleteTokens) this.oauth.deleteTokens();
    this.identity = null;
    this.authState = 'authorization-required';
    this._setCapabilities('unverified');
    this._setState('disconnected');
  }

  async _connect(reconnecting) {
    if (this.stopped) return;
    this._setState(reconnecting ? 'reconnecting' : 'connecting');
    const transport = this.transportFactory(this.clientId);
    this.transport = transport;
    transport.on('event', this._onTransportEvent);
    transport.on('disconnect', this._onTransportDisconnect);
    transport.on('protocol-error', this._onProtocolError);
    try {
      await transport.connect();
      if (this.stopped || this.transport !== transport) return;
      this.retryAttempt = 0;
      await this._authenticate(transport);
      if (this.stopped || this.transport !== transport) return;
      await this._probeCapabilities();
      await this._subscribeGlobalEvents();
      if (this.authState !== 'authenticated' || !this.transport) throw Object.assign(new Error('Discord authorization is required'), { code: 'DISCORD_AUTH_REQUIRED' });
      this._setState('connected');
    } catch (error) {
      if (this.transport !== transport || this.stopped) return;
      this._detachTransport(false);
      this._setCapabilities(this.authState === 'auth-error' ? 'auth-failure' : 'unverified');
      if (error.code === 'DISCORD_NOT_RUNNING' || error.code === 'DISCORD_NOT_CONFIGURED') this._setState('not-running', error);
      else this._setState('error', error);
      if (error.code !== 'DISCORD_NOT_CONFIGURED' && error.code !== 'DISCORD_AUTH_REQUIRED' && error.code !== 'DISCORD_REAUTHORIZATION_REQUIRED' && this.authState !== 'auth-error') this._scheduleReconnect();
    }
  }

  _handleDisconnect(error) {
    if (this.stopped) return;
    this._detachTransport(false);
    this._clearSubscriptions();
    this._setCapabilities('unverified');
    this._setState('reconnecting', error);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped || !this.autoReconnect || this.retryTimer) return;
    const delay = this.backoff[Math.min(this.retryAttempt, this.backoff.length - 1)];
    this.retryAttempt += 1;
    this.emit('reconnect-scheduled', { delay, attempt: this.retryAttempt });
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this._connect(true);
    }, delay);
  }

  _detachTransport(disconnect) {
    const transport = this.transport;
    this.transport = null;
    if (!transport) return;
    transport.removeListener('event', this._onTransportEvent);
    transport.removeListener('disconnect', this._onTransportDisconnect);
    transport.removeListener('protocol-error', this._onProtocolError);
    if (disconnect) transport.disconnect();
  }

  _clearSubscriptions() {
    this.subscriptionGeneration += 1;
    this.subscriptions.clear();
    this.activeVoiceChannelId = null;
    this.activeTextChannelId = null;
    this.subscriptionQueues = { voice: Promise.resolve(), text: Promise.resolve() };
  }

  _handleTransportEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'CURRENT_USER_UPDATE') this.identity = cleanDiscordIdentity(event.data);
    if (event.type === 'VOICE_CHANNEL_SELECT') {
      const channelId = event.data && event.data.channel_id;
      this._queueChannelSubscriptions('voice', channelId).catch(() => {});
    }
    this.emit('event', event);
    this.emit(event.type, event.data);
  }

  _setState(state, error) {
    const next = { state, authState: this.authState, error: error ? error.message : null };
    if (this.state === state && this.emittedAuthState === this.authState && !error) return;
    this.state = state;
    this.emittedAuthState = this.authState;
    this.lastError = next.error;
    this.emit('state', next);
  }

  _setCapabilities(state) {
    let changed = false;
    for (const name of CAPABILITIES) {
      const available = state === 'available';
      if (this.capabilityState[name] !== state || this.capabilities[name] !== available) changed = true;
      this.capabilityState[name] = state; this.capabilities[name] = available;
    }
    if (changed) this.emit('capabilities', this.getCapabilities());
  }

  getState() { return { state: this.state, authState: this.authState, error: this.lastError }; }
  getCapabilities() { return Object.assign({}, this.capabilities); }
  getCapabilityStates() { return Object.assign({}, this.capabilityState); }
  getIdentity() { return this.identity && Object.assign({}, this.identity); }

  async _request(command, args) {
    const capability = COMMAND_CAPABILITY[command];
    if (!capability) throw Object.assign(new Error('Unsupported Discord command: ' + command), { code: 'DISCORD_UNSUPPORTED_COMMAND' });
    if (this.authState !== 'authenticated') throw Object.assign(new Error('Discord authorization is required'), { code: 'DISCORD_AUTH_REQUIRED' });
    if (this.capabilityState[capability] === 'unsupported' || !this.transport) throw Object.assign(new Error('Discord capability is unavailable: ' + capability), { code: 'DISCORD_UNSUPPORTED_CAPABILITY', capability });
    try {
      const result = await this.transport.request(command, args);
      this._setCapability(capability, 'available');
      return result;
    }
    catch (error) {
      const rpcCode = Number(error.code);
      if (AUTH_CODES.has(rpcCode)) {
        this.authState = 'auth-error';
        if (this.oauth && this.oauth.deleteTokens) this.oauth.deleteTokens();
        this.identity = null;
        this._setCapabilities('auth-failure');
        this._detachTransport(true);
        this._setState('error', Object.assign(new Error('Discord authorization is required'), { code: 'DISCORD_AUTH_REQUIRED' }));
        error.code = 'DISCORD_AUTH_REQUIRED'; error.capability = capability;
      } else if (UNSUPPORTED_CODES.has(rpcCode)) {
        this._setCapability(capability, 'unsupported');
        error.capability = capability;
      } else {
        this._setCapability(capability, 'temporary-error');
        error.capability = capability;
      }
      throw error;
    }
  }

  async _eventRequest(command, event, args) {
    const capability = SUBSCRIPTION_CAPABILITY[event];
    if (!capability) throw Object.assign(new Error('Unsupported Discord event: ' + event), { code: 'DISCORD_UNSUPPORTED_EVENT' });
    if (this.authState !== 'authenticated') throw Object.assign(new Error('Discord authorization is required'), { code: 'DISCORD_AUTH_REQUIRED' });
    if (this.capabilityState[capability] === 'unsupported' || !this.transport) throw Object.assign(new Error('Discord capability is unavailable: ' + capability), { code: 'DISCORD_UNSUPPORTED_CAPABILITY', capability });
    try {
      const result = await this.transport.request(command, args || {}, event);
      if (command === 'SUBSCRIBE') this._setCapability(capability, 'available');
      return result;
    } catch (error) {
      const rpcCode = Number(error.code);
      if (AUTH_CODES.has(rpcCode)) {
        this.authState = 'auth-error';
        if (this.oauth && this.oauth.deleteTokens) this.oauth.deleteTokens();
        this.identity = null;
        this._setCapabilities('auth-failure');
        this._detachTransport(true);
        this._setState('error', Object.assign(new Error('Discord authorization is required'), { code: 'DISCORD_AUTH_REQUIRED' }));
        error.code = 'DISCORD_AUTH_REQUIRED'; error.capability = capability;
      } else if (UNSUPPORTED_CODES.has(rpcCode)) {
        this._setCapability(capability, 'unsupported'); error.capability = capability;
      } else {
        this._setCapability(capability, 'temporary-error'); error.capability = capability;
      }
      throw error;
    }
  }

  _setCapability(capability, state) {
    const available = state === 'available';
    if (this.capabilityState[capability] === state && this.capabilities[capability] === available) return;
    this.capabilityState[capability] = state; this.capabilities[capability] = available;
    this.emit('capabilities', this.getCapabilities());
  }

  async _authenticate(transport) {
    this.authState = 'authorization-required'; this._setState(this.state);
    const token = this.oauth && await this.oauth.accessToken();
    if (!token) {
      const reauthorize = this.oauth && this.oauth.requiresReauthorization && this.oauth.requiresReauthorization();
      this.authState = reauthorize ? 'reauthorization-required' : 'authorization-required';
      throw Object.assign(new Error(reauthorize ? 'Discord authorization scopes changed; reconnect to approve access' : 'Discord authorization is required'), { code: reauthorize ? 'DISCORD_REAUTHORIZATION_REQUIRED' : 'DISCORD_AUTH_REQUIRED' });
    }
    let authenticated;
    try { authenticated = await transport.request('AUTHENTICATE', { access_token: token }); }
    catch (error) { this.authState = 'auth-error'; if (this.oauth && this.oauth.deleteTokens) this.oauth.deleteTokens(); throw error; }
    this.identity = cleanDiscordIdentity(authenticated && authenticated.user);
    this.authState = 'authenticated'; this._setState(this.state);
  }

  async _probeCapabilities() {
    const guildProbe = this.getGuilds().then(async value => {
      const guilds = Array.isArray(value) ? value : value && Array.isArray(value.guilds) ? value.guilds : [];
      const first = guilds.find(guild => guild && guild.id);
      if (first) await this.getChannels(first.id);
    });
    await Promise.all([this.getVoiceSettings(), this.getSelectedVoiceChannel(), guildProbe].map(probe => probe.catch(() => null)));
    if (this.authState !== 'authenticated' || !this.transport) throw Object.assign(new Error('Discord authorization is required'), { code: 'DISCORD_AUTH_REQUIRED' });
  }

  getVoiceSettings() { return this._request('GET_VOICE_SETTINGS').then(data => projectPresent(data, VOICE_FIELDS)); }
  setVoiceSettings(settings) { return this._request('SET_VOICE_SETTINGS', projectPresent(settings, VOICE_FIELDS)).then(data => projectPresent(data, VOICE_FIELDS)); }
  getSelectedVoiceChannel() {
    return this._request('GET_SELECTED_VOICE_CHANNEL').then(async data => {
      await this._queueChannelSubscriptions('voice', data && data.id);
      this._markChannelData(data, 'voice');
      return data;
    });
  }
  selectVoiceChannel(channelId) {
    return this._request('SELECT_VOICE_CHANNEL', { channel_id: channelId == null ? null : String(channelId) }).then(async data => {
      await this._queueChannelSubscriptions('voice', data && data.id || channelId);
      this._markChannelData(data, 'voice');
      return data;
    });
  }
  setUserVoiceSettings(userId, settings) {
    const value = settings || {};
    const args = { user_id: String(userId) };
    const modifiers = ['mute', 'volume'].filter(key => Object.prototype.hasOwnProperty.call(value, key));
    if (modifiers.length !== 1) throw Object.assign(new Error('Discord supports one participant voice modifier at a time'), { code: 'DISCORD_INVALID_VOICE_SETTINGS' });
    if (modifiers[0] === 'mute') args.mute = !!value.mute;
    else {
      const volume = Number(value.volume);
      if (!Number.isFinite(volume)) throw Object.assign(new Error('Participant volume is invalid'), { code: 'DISCORD_INVALID_VOICE_SETTINGS' });
      args.volume = Math.max(0, Math.min(200, volume));
    }
    return this._request('SET_USER_VOICE_SETTINGS', args);
  }
  getGuilds() { return this._request('GET_GUILDS'); }
  getGuild(guildId) { return this._request('GET_GUILD', { guild_id: String(guildId) }); }
  getChannels(guildId) { return this._request('GET_CHANNELS', { guild_id: String(guildId) }); }
  getChannel(channelId) { return this._request('GET_CHANNEL', { channel_id: String(channelId) }); }
  getTextChannel(channelId) { return this.getChannel(channelId).then(data => { this._markChannelData(data, 'text'); return data; }); }
  selectTextChannel(channelId) {
    return this._request('SELECT_TEXT_CHANNEL', { channel_id: channelId == null ? null : String(channelId) }).then(async data => {
      await this._queueChannelSubscriptions('text', data && data.id || channelId);
      this._markChannelData(data, 'text');
      return data;
    });
  }
  clearTextChannel() { return this._queueChannelSubscriptions('text', null); }
  setActivity(activity) { return this._request('SET_ACTIVITY', { pid: process.pid, activity: activity || null }); }

  _markChannelData(data, kind) {
    if (!data || typeof data !== 'object') return;
    if (kind === 'voice' && Array.isArray(data.voice_states)) this._setCapability('participants', 'available');
    if (kind === 'text') this._setCapability('messageHistory', Array.isArray(data.messages) ? 'available' : 'unsupported');
  }

  async _subscribeGlobalEvents() {
    await Promise.all(GLOBAL_EVENTS.map(event => this._subscribe(event, {}).catch(() => null)));
  }

  async _subscribe(event, args) {
    const key = event + ':' + String(args && args.channel_id || 'global');
    if (this.subscriptions.has(key)) return;
    await this._eventRequest('SUBSCRIBE', event, args);
    this.subscriptions.set(key, { event, args: Object.assign({}, args) });
  }

  async _unsubscribe(event, args) {
    const key = event + ':' + String(args && args.channel_id || 'global');
    if (!this.subscriptions.has(key)) return;
    this.subscriptions.delete(key);
    if (!this.transport || this.authState !== 'authenticated') return;
    try { await this.transport.request('UNSUBSCRIBE', args || {}, event); } catch (error) {}
  }

  async _syncChannelSubscriptions(kind, channelId) {
    const field = kind === 'voice' ? 'activeVoiceChannelId' : 'activeTextChannelId';
    const events = kind === 'voice' ? VOICE_CHANNEL_EVENTS : TEXT_CHANNEL_EVENTS;
    const next = channelId == null || channelId === '' ? null : String(channelId);
    const previous = this[field];
    if (previous === next) return;
    if (previous) await Promise.all(events.map(event => this._unsubscribe(event, { channel_id: previous })));
    this[field] = next;
    if (next) await Promise.all(events.map(event => this._subscribe(event, { channel_id: next }).catch(() => null)));
  }

  _queueChannelSubscriptions(kind, channelId) {
    const generation = this.subscriptionGeneration;
    const queued = this.subscriptionQueues[kind].catch(() => {}).then(() => {
      if (generation !== this.subscriptionGeneration) return;
      return this._syncChannelSubscriptions(kind, channelId);
    });
    this.subscriptionQueues[kind] = queued;
    return queued;
  }
}

module.exports = { DiscordService, COMMAND_CAPABILITY, GLOBAL_EVENTS, SUBSCRIPTION_CAPABILITY, TEXT_CHANNEL_EVENTS, VOICE_CHANNEL_EVENTS, VOICE_FIELDS, cleanDiscordIdentity, projectPresent };
