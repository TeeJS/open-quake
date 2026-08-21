'use strict';

const { EventEmitter } = require('events');
const { normalizeDiscordSettings } = require('./discordSettings');

function list(value, key) {
  if (Array.isArray(value)) return value;
  return value && Array.isArray(value[key]) ? value[key] : [];
}

const TEXT_CHANNEL_TYPES = new Set([0, 5, '0', '5', 'GUILD_TEXT', 'GUILD_ANNOUNCEMENT', 'GUILD_NEWS']);

function usableTextChannels(value) {
  return list(value, 'channels').filter(channel => channel && channel.id && TEXT_CHANNEL_TYPES.has(channel.type));
}

const RECENT_EVENT_LIMIT = 8;

function sanitizeStatusText(value) {
  if (typeof value !== 'string') return null;
  const firstLine = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').split(/\s+at\s+/i)[0].trim();
  return firstLine ? firstLine.slice(0, 160) : null;
}

function eventLabel(type) {
  return {
    VOICE_SETTINGS_UPDATE: 'Voice settings updated', VOICE_CHANNEL_SELECT: 'Voice channel changed',
    VOICE_STATE_CREATE: 'Voice participant joined', VOICE_STATE_UPDATE: 'Voice participant updated',
    VOICE_STATE_DELETE: 'Voice participant left',
  }[type] || 'Discord activity received';
}

function canAttemptCapability(snapshot, capability) {
  const state = snapshot.capabilityStates && snapshot.capabilityStates[capability];
  return state !== 'unsupported' && state !== 'auth-failure';
}

class DiscordAppHost extends EventEmitter {
  constructor(service, options) {
    super();
    const opts = options || {};
    this.service = service;
    this.getSettings = opts.getSettings || (() => ({}));
    this.saveSettings = opts.saveSettings || (() => true);
    this.settings = normalizeDiscordSettings(this.getSettings());
    this.service.setAutoReconnect(this.settings.autoReconnect);
    this.snapshot = {
      connection: this._cleanConnection(service.getState()), capabilities: service.getCapabilities(), capabilityStates: service.getCapabilityStates ? service.getCapabilityStates() : {},
      settings: this._publicSettings(this.settings), voice: {}, channel: null, guilds: [], channels: [], participants: null, recentEvents: [],
      refresh: { status: 'unsupported', error: null },
      chat: { guildId: null, channels: [], selected: null, lastSelected: null, status: null, error: null },
    };
    this.started = false;
    this._onState = value => {
      this.snapshot.connection = this._cleanConnection(value);
      this._recordEvent('connection', 'Connection: ' + (value.state || 'disconnected'));
      this._emit();
      if (value.state === 'connected') this.refresh();
    };
    this._onCapabilities = value => {
      this.snapshot.capabilities = value;
      this.snapshot.capabilityStates = this.service.getCapabilityStates ? this.service.getCapabilityStates() : {};
      this._recordEvent('capabilities', 'Capabilities updated'); this._emit();
    };
    this._onEvent = event => this._applyEvent(event);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.snapshot.connection = this._cleanConnection(this.service.getState());
    this.snapshot.capabilities = this.service.getCapabilities();
    this.snapshot.capabilityStates = this.service.getCapabilityStates ? this.service.getCapabilityStates() : {};
    this.service.on('state', this._onState);
    this.service.on('capabilities', this._onCapabilities);
    this.service.on('event', this._onEvent);
    if (this.snapshot.connection.state === 'connected') this.refresh();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.service.removeListener('state', this._onState);
    this.service.removeListener('capabilities', this._onCapabilities);
    this.service.removeListener('event', this._onEvent);
    this.removeAllListeners();
  }

  getSnapshot() { return JSON.parse(JSON.stringify(this.snapshot)); }

  updateSettings(value) {
    this.settings = normalizeDiscordSettings(value);
    this.snapshot.settings = this._publicSettings(this.settings);
    this.service.setAutoReconnect(this.settings.autoReconnect);
    this._emit();
  }

  async refresh() {
    const caps = this.snapshot.capabilities;
    const tasks = [];
    if (caps.voiceSettings) tasks.push(this.service.getVoiceSettings().then(v => { this.snapshot.voice = v || {}; }));
    if (caps.voiceChannelControl) tasks.push(this.service.getSelectedVoiceChannel().then(v => { this._setChannel(v || null); }));
    if (caps.guildDiscovery) tasks.push(this.service.getGuilds().then(v => { this.snapshot.guilds = list(v, 'guilds'); }));
    const errors = (await Promise.all(tasks.map(task => task.then(() => null, error => error)))).filter(Boolean);
    const authError = errors.find(error => error && (error.code === 'DISCORD_AUTH_REQUIRED' || Number(error.code) === 4006));
    if (authError) {
      this.snapshot.connection = this._cleanConnection({ state: 'error', authState: 'auth-error', error: authError.message });
      this.snapshot.refresh = { status: 'authentication-required', error: sanitizeStatusText(authError.message) };
    } else if (errors.length) this.snapshot.refresh = { status: 'command-error', error: sanitizeStatusText(errors[0].message) || 'Discord command failed' };
    else if (!tasks.length) this.snapshot.refresh = { status: 'unsupported', error: null };
    else this.snapshot.refresh = { status: this.snapshot.guilds.length || Object.keys(this.snapshot.voice).length || this.snapshot.channel ? 'ok' : 'empty', error: null };
    const guildId = this.snapshot.channel && this.snapshot.channel.guild_id;
    if (guildId && caps.channelDiscovery) {
      try { this.snapshot.channels = list(await this.service.getChannels(guildId), 'channels'); }
      catch (error) {
        if (error && (error.code === 'DISCORD_AUTH_REQUIRED' || Number(error.code) === 4006)) {
          this.snapshot.connection = this._cleanConnection({ state: 'error', authState: 'auth-error', error: error.message });
          this.snapshot.refresh = { status: 'authentication-required', error: sanitizeStatusText(error.message) };
        } else this.snapshot.refresh = { status: 'command-error', error: sanitizeStatusText(error && error.message) || 'Discord command failed' };
      }
    }
    this._emit();
    return this.getSnapshot();
  }

  _publicSettings(settings) {
    const clean = Object.assign({}, settings);
    delete clean.clientSecret; delete clean.accessToken; delete clean.refreshToken; delete clean.token;
    return clean;
  }

  async action(name, value) {
    switch (name) {
      case 'reconnect':
        this.service.stop(); this.service.start(); break;
      case 'disconnect': this.service.stop(); break;
      case 'rich-presence': {
        if (!canAttemptCapability(this.snapshot, 'activity')) throw Object.assign(new Error('Discord activity is unavailable'), { code: 'DISCORD_UNSUPPORTED_CAPABILITY' });
        const next = normalizeDiscordSettings(Object.assign({}, this.settings, { richPresence: !!value }));
        if (!this.saveSettings(next)) throw new Error('Discord settings could not be saved');
        await this.service.setActivity(next.richPresence ? { details: 'Using open-quake' } : null);
        this.settings = next; this.snapshot.settings = next;
        this._recordEvent('activity', next.richPresence ? 'Rich Presence enabled' : 'Rich Presence disabled');
        break;
      }
      case 'mute': await this._voicePatch({ mute: !!value }); break;
      case 'deaf': await this._voicePatch({ deaf: !!value }); break;
      case 'input-device': await this._voicePatch({ input: { device_id: String(value) } }); break;
      case 'output-device': await this._voicePatch({ output: { device_id: String(value) } }); break;
      case 'input-volume': await this._voicePatch({ input: { volume: Number(value) } }); break;
      case 'output-volume': await this._voicePatch({ output: { volume: Number(value) } }); break;
      case 'guild': {
        const response = await this.service.getChannels(String(value));
        this.snapshot.channels = list(response, 'channels');
        break;
      }
      case 'chat-guild': {
        const guildId = value == null ? '' : String(value);
        this.snapshot.chat.guildId = guildId || null;
        this.snapshot.chat.selected = null;
        this.snapshot.chat.status = guildId ? 'Loading text channels…' : null;
        this.snapshot.chat.error = null;
        this._emit();
        if (!guildId) { this.snapshot.chat.channels = []; break; }
        try {
          this.snapshot.chat.channels = usableTextChannels(await this.service.getChannels(guildId));
          this.snapshot.chat.status = null;
        } catch (error) {
          this.snapshot.chat.channels = [];
          this.snapshot.chat.status = null;
          this.snapshot.chat.error = sanitizeStatusText(error && error.message) || 'Text channels could not be loaded';
        }
        break;
      }
      case 'chat-channel': {
        const channelId = value == null ? '' : String(value);
        const channel = this.snapshot.chat.channels.find(item => String(item.id) === channelId);
        if (!channel) throw Object.assign(new Error('Select an available text channel'), { code: 'DISCORD_INVALID_CHANNEL' });
        this.snapshot.chat.status = 'Opening #' + (channel.name || channel.id) + '…';
        this.snapshot.chat.error = null;
        this._emit();
        try {
          const response = await this.service.selectTextChannel(channelId);
          const selected = response && response.id ? response : channel;
          this.snapshot.chat.selected = selected;
          this.snapshot.chat.lastSelected = selected;
          this.snapshot.chat.status = 'Opened #' + (selected.name || channel.name || selected.id);
        } catch (error) {
          this.snapshot.chat.status = null;
          this.snapshot.chat.error = sanitizeStatusText(error && error.message) || 'Discord could not open that channel';
        }
        break;
      }
      case 'channel': {
        const response = await this.service.selectVoiceChannel(value == null || value === '' ? null : String(value));
        this._setChannel(response && response.id ? response : (value ? await this.service.getChannel(String(value)) : null));
        break;
      }
      case 'leave': await this.service.selectVoiceChannel(null); this._setChannel(null); break;
      default: throw Object.assign(new Error('Unsupported Discord UI action'), { code: 'DISCORD_UNSUPPORTED_ACTION' });
    }
    this._emit();
    return this.getSnapshot();
  }

  async _voicePatch(patch) {
    const response = await this.service.setVoiceSettings(patch);
    this.snapshot.voice = Object.assign({}, this.snapshot.voice, response || patch);
    if (patch.input) this.snapshot.voice.input = Object.assign({}, this.snapshot.voice.input, patch.input, response && response.input);
    if (patch.output) this.snapshot.voice.output = Object.assign({}, this.snapshot.voice.output, patch.output, response && response.output);
  }

  _setChannel(channel) {
    this.snapshot.channel = channel;
    const exposed = channel && (channel.participants || channel.voice_states);
    this.snapshot.participants = Array.isArray(exposed) ? exposed : null;
  }

  _applyEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'VOICE_SETTINGS_UPDATE') {
      const update = event.data || {};
      this.snapshot.voice = Object.assign({}, this.snapshot.voice, update);
      if (update.input) this.snapshot.voice.input = Object.assign({}, this.snapshot.voice.input, update.input);
      if (update.output) this.snapshot.voice.output = Object.assign({}, this.snapshot.voice.output, update.output);
    }
    if (event.type === 'VOICE_CHANNEL_SELECT') this._setChannel(event.data || null);
    if (event.type === 'VOICE_STATE_CREATE' || event.type === 'VOICE_STATE_UPDATE' || event.type === 'VOICE_STATE_DELETE') {
      // The RPC event proves participant state is exposed, but its shape is not invented here.
      if (Array.isArray(event.data)) this.snapshot.participants = event.data;
    }
    this._recordEvent(event.type, eventLabel(event.type));
    this._emit();
  }

  _cleanConnection(value) {
    return { state: value && value.state || 'disconnected', authState: value && value.authState || null, error: sanitizeStatusText(value && value.error) };
  }

  _recordEvent(type, label) {
    this.snapshot.recentEvents.unshift({ type, label, at: new Date().toISOString() });
    this.snapshot.recentEvents.length = Math.min(this.snapshot.recentEvents.length, RECENT_EVENT_LIMIT);
  }

  _emit() { this.emit('update', this.getSnapshot()); }
}

module.exports = { DiscordAppHost, RECENT_EVENT_LIMIT, canAttemptCapability, sanitizeStatusText, usableTextChannels };
