'use strict';

const { EventEmitter } = require('events');
const { DiscordRpcTransport } = require('./discordRpcTransport');

const COMMAND_CAPABILITY = Object.freeze({
  GET_VOICE_SETTINGS: 'voiceSettings', SET_VOICE_SETTINGS: 'voiceSettings',
  GET_SELECTED_VOICE_CHANNEL: 'voiceChannelControl', SELECT_VOICE_CHANNEL: 'voiceChannelControl',
  GET_GUILDS: 'guildDiscovery', GET_GUILD: 'guildDiscovery',
  GET_CHANNELS: 'channelDiscovery', GET_CHANNEL: 'channelDiscovery',
  SELECT_TEXT_CHANNEL: 'textChannelSelection', SET_ACTIVITY: 'activity',
});
const CAPABILITIES = Object.freeze([...new Set(Object.values(COMMAND_CAPABILITY))]);
const UNSUPPORTED_CODES = new Set([4001, 4002, 4005]);
const AUTH_CODES = new Set([4006]);
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
    this._onTransportEvent = event => { this.emit('event', event); this.emit(event.type, event.data); };
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
      this._setState('connected');
    } catch (error) {
      if (this.transport !== transport || this.stopped) return;
      this._detachTransport(false);
      this._setCapabilities(this.authState === 'auth-error' ? 'auth-failure' : 'unverified');
      if (error.code === 'DISCORD_NOT_RUNNING' || error.code === 'DISCORD_NOT_CONFIGURED') this._setState('not-running', error);
      else this._setState('error', error);
      if (error.code !== 'DISCORD_NOT_CONFIGURED' && error.code !== 'DISCORD_AUTH_REQUIRED' && this.authState !== 'auth-error') this._scheduleReconnect();
    }
  }

  _handleDisconnect(error) {
    if (this.stopped) return;
    this._detachTransport(false);
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

  _setCapability(capability, state) {
    const available = state === 'available';
    if (this.capabilityState[capability] === state && this.capabilities[capability] === available) return;
    this.capabilityState[capability] = state; this.capabilities[capability] = available;
    this.emit('capabilities', this.getCapabilities());
  }

  async _authenticate(transport) {
    this.authState = 'authorization-required'; this._setState(this.state);
    const token = this.oauth && await this.oauth.accessToken();
    if (!token) throw Object.assign(new Error('Discord authorization is required'), { code: 'DISCORD_AUTH_REQUIRED' });
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
  getSelectedVoiceChannel() { return this._request('GET_SELECTED_VOICE_CHANNEL'); }
  selectVoiceChannel(channelId) { return this._request('SELECT_VOICE_CHANNEL', { channel_id: channelId == null ? null : String(channelId) }); }
  getGuilds() { return this._request('GET_GUILDS'); }
  getGuild(guildId) { return this._request('GET_GUILD', { guild_id: String(guildId) }); }
  getChannels(guildId) { return this._request('GET_CHANNELS', { guild_id: String(guildId) }); }
  getChannel(channelId) { return this._request('GET_CHANNEL', { channel_id: String(channelId) }); }
  selectTextChannel(channelId) { return this._request('SELECT_TEXT_CHANNEL', { channel_id: channelId == null ? null : String(channelId) }); }
  setActivity(activity) { return this._request('SET_ACTIVITY', { pid: process.pid, activity: activity || null }); }
}

module.exports = { DiscordService, COMMAND_CAPABILITY, VOICE_FIELDS, cleanDiscordIdentity, projectPresent };
