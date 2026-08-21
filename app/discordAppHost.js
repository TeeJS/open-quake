'use strict';

const { EventEmitter } = require('events');
const { normalizeDiscordSettings } = require('./discordSettings');

function list(value, key) {
  if (Array.isArray(value)) return value;
  return value && Array.isArray(value[key]) ? value[key] : [];
}

const TEXT_CHANNEL_TYPES = new Set([0, 5, '0', '5', 'GUILD_TEXT', 'GUILD_ANNOUNCEMENT', 'GUILD_NEWS']);
const VOICE_CHANNEL_TYPES = new Set([2, 13, '2', '13', 'GUILD_VOICE', 'GUILD_STAGE_VOICE', 'GUILD_STAGE']);

function usableTextChannels(value) {
  return list(value, 'channels').filter(channel => channel && channel.id && TEXT_CHANNEL_TYPES.has(channel.type));
}

function usableVoiceChannels(value) {
  return list(value, 'channels').filter(channel => channel && channel.id && VOICE_CHANNEL_TYPES.has(channel.type));
}

const RECENT_EVENT_LIMIT = 8;
const RECENT_MESSAGE_LIMIT = 20;
const RECENT_NOTIFICATION_LIMIT = 8;

function cleanString(value, limit) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean ? clean.slice(0, limit || 256) : null;
}

function avatarUrl(user) {
  const id = cleanString(user && user.id, 32);
  const avatar = cleanString(user && user.avatar, 128);
  if (!id || !avatar || !/^[a-zA-Z0-9_]+$/.test(avatar)) return null;
  return 'https://cdn.discordapp.com/avatars/' + id + '/' + avatar + (avatar.startsWith('a_') ? '.gif' : '.png');
}

function sanitizeUser(value) {
  if (!value || typeof value !== 'object') return null;
  const user = {
    id: cleanString(value.id, 32), username: cleanString(value.username, 128),
    displayName: cleanString(value.global_name, 128), avatarUrl: avatarUrl(value),
  };
  return user.id || user.username ? user : null;
}

function sanitizeParticipant(value, previous) {
  if (!value || typeof value !== 'object') return null;
  const user = sanitizeUser(value.user || value) || {};
  const voice = value.voice_state && typeof value.voice_state === 'object' ? value.voice_state : {};
  const id = user.id || cleanString(value.user_id, 32);
  if (!id) return null;
  const number = item => Number.isFinite(Number(item)) ? Number(item) : null;
  const volume = number(value.volume);
  const boolean = (source, key, fallback) => Object.prototype.hasOwnProperty.call(source, key) ? !!source[key] : !!fallback;
  const pan = value.pan && typeof value.pan === 'object' ? {
    left: number(value.pan.left), right: number(value.pan.right),
  } : null;
  return {
    id, username: user.username || previous && previous.username || null, displayName: user.displayName || previous && previous.displayName || null,
    nick: cleanString(value.nick, 128) || previous && previous.nick || null, avatarUrl: user.avatarUrl || previous && previous.avatarUrl || null,
    mute: boolean(voice, 'mute', previous && previous.mute), deaf: boolean(voice, 'deaf', previous && previous.deaf),
    selfMute: boolean(voice, 'self_mute', previous && previous.selfMute), selfDeaf: boolean(voice, 'self_deaf', previous && previous.selfDeaf),
    localMute: boolean(value, 'mute', previous && previous.localMute), volume: volume == null ? previous && previous.volume != null ? previous.volume : null : Math.max(0, Math.min(200, volume)),
    pan: pan && pan.left != null && pan.right != null ? { left: Math.max(0, Math.min(1, pan.left)), right: Math.max(0, Math.min(1, pan.right)) } : previous && previous.pan || null,
    speaking: !!(previous && previous.speaking),
  };
}

function sanitizeMessage(value, channelId) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanString(value.id, 32);
  if (!id) return null;
  const author = sanitizeUser(value.author);
  return {
    id, channelId: cleanString(channelId || value.channel_id, 32), author,
    content: cleanString(value.content, 4000), timestamp: cleanString(value.timestamp, 64),
    editedTimestamp: cleanString(value.edited_timestamp, 64), edited: !!value.edited_timestamp,
    deleted: false,
    mentions: Array.isArray(value.mentions) ? value.mentions.slice(0, 50).map(sanitizeUser).filter(Boolean) : [],
    mentionRoleIds: Array.isArray(value.mention_roles) ? value.mention_roles.slice(0, 50).map(item => cleanString(item, 32)).filter(Boolean) : [],
    mentionEveryone: !!value.mention_everyone,
  };
}

function sanitizeNotification(value) {
  if (!value || typeof value !== 'object') return null;
  const icon = cleanString(value.icon_url, 512);
  return {
    channelId: cleanString(value.channel_id, 32), title: cleanString(value.title, 256),
    body: cleanString(value.body, 1000), iconUrl: icon && /^https:\/\//i.test(icon) ? icon : null,
    message: sanitizeMessage(value.message, value.channel_id), at: new Date().toISOString(),
  };
}

function sanitizeChannel(value) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanString(value.id || value.channel_id, 32);
  if (!id) return null;
  return { id, guild_id: cleanString(value.guild_id, 32), name: cleanString(value.name, 128), type: value.type };
}

function sanitizeStatusText(value) {
  if (typeof value !== 'string') return null;
  const firstLine = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').split(/\s+at\s+/i)[0].trim();
  return firstLine ? firstLine.slice(0, 160) : null;
}

function eventLabel(type) {
  return {
    VOICE_SETTINGS_UPDATE: 'Voice settings updated', VOICE_CHANNEL_SELECT: 'Voice channel changed',
    VOICE_STATE_CREATE: 'Voice participant joined', VOICE_STATE_UPDATE: 'Voice participant updated',
    VOICE_STATE_DELETE: 'Voice participant left', SPEAKING_START: 'Participant started speaking',
    SPEAKING_STOP: 'Participant stopped speaking', VOICE_CONNECTION_STATUS: 'Voice connection updated',
    MESSAGE_CREATE: 'Discord message received', MESSAGE_UPDATE: 'Discord message edited',
    MESSAGE_DELETE: 'Discord message deleted', NOTIFICATION_CREATE: 'Discord notification received',
    CURRENT_USER_UPDATE: 'Discord account updated',
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
      settings: this._publicSettings(this.settings), voice: {}, channel: null, guilds: [], participants: [], recentEvents: [],
      voiceSelection: { guildId: null, channelId: null, channels: [], status: null, error: null, initialized: false },
      voiceConnection: null, notifications: [], currentUser: service.getIdentity ? service.getIdentity() : null, voiceControlLock: false,
      refresh: { status: 'unsupported', error: null },
      chat: { guildId: null, channels: [], selected: null, lastSelected: null, messages: [], historyAvailable: null, status: null, error: null },
    };
    this.voiceGuildRequest = 0;
    this.started = false;
    this._onState = value => {
      this.snapshot.connection = this._cleanConnection(value);
      if (value.state !== 'connected') {
        this.snapshot.participants = [];
        this.snapshot.voiceConnection = null;
        this.snapshot.voiceControlLock = false;
      }
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
    if (caps.guildDiscovery) tasks.push(this.service.getGuilds().then(v => { this.snapshot.guilds = list(v, 'guilds').map(sanitizeChannel).filter(Boolean); }));
    const errors = (await Promise.all(tasks.map(task => task.then(() => null, error => error)))).filter(Boolean);
    const authError = errors.find(error => error && (error.code === 'DISCORD_AUTH_REQUIRED' || Number(error.code) === 4006));
    if (authError) {
      this.snapshot.connection = this._cleanConnection({ state: 'error', authState: 'auth-error', error: authError.message });
      this.snapshot.refresh = { status: 'authentication-required', error: sanitizeStatusText(authError.message) };
    } else if (errors.length) this.snapshot.refresh = { status: 'command-error', error: sanitizeStatusText(errors[0].message) || 'Discord command failed' };
    else if (!tasks.length) this.snapshot.refresh = { status: 'unsupported', error: null };
    else this.snapshot.refresh = { status: this.snapshot.guilds.length || Object.keys(this.snapshot.voice).length || this.snapshot.channel ? 'ok' : 'empty', error: null };
    const connectedGuildId = this.snapshot.channel && this.snapshot.channel.guild_id;
    if (!this.snapshot.voiceSelection.initialized && connectedGuildId && caps.channelDiscovery) {
      await this._loadVoiceGuild(connectedGuildId, {
        emitLoading: false,
        channelId: this.snapshot.channel && this.snapshot.channel.id,
      });
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
      case 'participant-mute': await this._participantPatch(value, 'mute'); break;
      case 'participant-volume': await this._participantPatch(value, 'volume'); break;
      case 'guild': {
        await this._loadVoiceGuild(value);
        break;
      }
      case 'chat-guild': {
        const guildId = value == null ? '' : String(value);
        if (this.service.clearTextChannel) await this.service.clearTextChannel();
        this.snapshot.chat.guildId = guildId || null;
        this.snapshot.chat.selected = null;
        this.snapshot.chat.messages = [];
        this.snapshot.chat.historyAvailable = null;
        this.snapshot.chat.status = guildId ? 'Loading text channels…' : null;
        this.snapshot.chat.error = null;
        this._emit();
        if (!guildId) { this.snapshot.chat.channels = []; break; }
        try {
          this.snapshot.chat.channels = usableTextChannels(await this.service.getChannels(guildId)).map(sanitizeChannel).filter(Boolean);
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
          const selected = sanitizeChannel(response && response.id ? response : channel);
          this.snapshot.chat.selected = selected;
          this.snapshot.chat.lastSelected = selected;
          this._setMessages(response && response.messages, channelId);
          this.snapshot.chat.status = 'Opened #' + (selected.name || channel.name || selected.id);
        } catch (error) {
          this.snapshot.chat.status = null;
          this.snapshot.chat.error = sanitizeStatusText(error && error.message) || 'Discord could not open that channel';
        }
        break;
      }
      case 'channel': {
        const channelId = value == null ? '' : String(value);
        const selected = this.snapshot.voiceSelection.channels.find(channel => String(channel.id) === channelId);
        if (!selected) throw Object.assign(new Error('Select an available voice channel'), { code: 'DISCORD_INVALID_CHANNEL' });
        const response = await this.service.selectVoiceChannel(channelId);
        this._setChannel(response && response.id ? response : await this.service.getChannel(channelId));
        this.snapshot.voiceSelection.channelId = channelId;
        break;
      }
      case 'leave':
        await this.service.selectVoiceChannel(null);
        this._setChannel(null);
        this.snapshot.voiceSelection.channelId = null;
        break;
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

  async _participantPatch(value, field) {
    const userId = cleanString(value && value.userId, 32);
    const participant = this.snapshot.participants.find(item => item.id === userId);
    if (!participant) throw Object.assign(new Error('Select an active voice participant'), { code: 'DISCORD_INVALID_PARTICIPANT' });
    const patch = field === 'mute'
      ? { mute: !!value.value }
      : { volume: Math.max(0, Math.min(200, Number(value.value))) };
    if (field === 'volume' && !Number.isFinite(patch.volume)) throw Object.assign(new Error('Participant volume is invalid'), { code: 'DISCORD_INVALID_VOICE_SETTINGS' });
    const response = await this.service.setUserVoiceSettings(userId, patch);
    if (field === 'mute') participant.localMute = response && Object.prototype.hasOwnProperty.call(response, 'mute') ? !!response.mute : patch.mute;
    else participant.volume = response && Object.prototype.hasOwnProperty.call(response, 'volume') ? Number(response.volume) : patch.volume;
    this.snapshot.voiceControlLock = true;
  }

  async _loadVoiceGuild(value, options) {
    const opts = options || {};
    const guildId = value == null ? '' : String(value);
    const request = ++this.voiceGuildRequest;
    const selection = this.snapshot.voiceSelection;
    selection.initialized = true;
    selection.guildId = guildId || null;
    selection.channelId = opts.channelId || null;
    selection.channels = [];
    selection.status = guildId ? 'Loading voice channels…' : null;
    selection.error = null;
    if (opts.emitLoading !== false) this._emit();
    if (!guildId) return;
    try {
      const channels = usableVoiceChannels(await this.service.getChannels(guildId)).map(sanitizeChannel).filter(Boolean);
      if (request !== this.voiceGuildRequest) return;
      selection.channels = channels;
      selection.status = null;
      if (selection.channelId && !channels.some(channel => channel.id === selection.channelId)) selection.channelId = null;
    } catch (error) {
      if (request !== this.voiceGuildRequest) return;
      selection.channels = [];
      selection.status = null;
      selection.error = sanitizeStatusText(error && error.message) || 'Voice channels could not be loaded';
    }
  }

  _setMessages(value, channelId) {
    if (!Array.isArray(value)) {
      this.snapshot.chat.messages = [];
      this.snapshot.chat.historyAvailable = false;
      return;
    }
    this.snapshot.chat.messages = value.map(item => sanitizeMessage(item, channelId)).filter(Boolean).slice(0, RECENT_MESSAGE_LIMIT);
    this.snapshot.chat.historyAvailable = true;
  }

  _setChannel(channel) {
    this.snapshot.channel = sanitizeChannel(channel);
    const exposed = channel && channel.voice_states;
    this.snapshot.participants = Array.isArray(exposed) ? exposed.map(item => sanitizeParticipant(item)).filter(Boolean) : [];
  }

  _applyEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'VOICE_SETTINGS_UPDATE') {
      const update = event.data || {};
      this.snapshot.voice = Object.assign({}, this.snapshot.voice, update);
      if (update.input) this.snapshot.voice.input = Object.assign({}, this.snapshot.voice.input, update.input);
      if (update.output) this.snapshot.voice.output = Object.assign({}, this.snapshot.voice.output, update.output);
    }
    if (event.type === 'VOICE_CHANNEL_SELECT') {
      const channelId = event.data && event.data.channel_id;
      if (!channelId) this._setChannel(null);
      else this.service.getChannel(String(channelId)).then(channel => { this._setChannel(channel); this._emit(); }).catch(() => {});
    }
    if (event.type === 'VOICE_STATE_CREATE' || event.type === 'VOICE_STATE_UPDATE' || event.type === 'VOICE_STATE_DELETE') {
      const previous = this.snapshot.participants.find(item => item.id === cleanString(event.data && (event.data.user_id || event.data.user && event.data.user.id), 32));
      const participant = sanitizeParticipant(event.data, previous);
      if (participant) {
        const index = this.snapshot.participants.findIndex(item => item.id === participant.id);
        if (event.type === 'VOICE_STATE_DELETE') {
          if (index >= 0) this.snapshot.participants.splice(index, 1);
        } else if (index >= 0) this.snapshot.participants[index] = Object.assign({}, this.snapshot.participants[index], participant);
        else this.snapshot.participants.push(participant);
      }
    }
    if (event.type === 'SPEAKING_START' || event.type === 'SPEAKING_STOP') {
      const userId = cleanString(event.data && event.data.user_id, 32);
      const participant = this.snapshot.participants.find(item => item.id === userId);
      if (participant) participant.speaking = event.type === 'SPEAKING_START';
    }
    if (event.type === 'VOICE_CONNECTION_STATUS') {
      const data = event.data || {};
      const pings = Array.isArray(data.pings) ? data.pings.slice(-20).map(Number).filter(Number.isFinite) : [];
      this.snapshot.voiceConnection = {
        state: cleanString(data.state, 64), lastPing: Number.isFinite(Number(data.last_ping)) ? Number(data.last_ping) : null,
        averagePing: Number.isFinite(Number(data.average_ping)) ? Number(data.average_ping) : null, pings,
      };
    }
    if (event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE' || event.type === 'MESSAGE_DELETE') {
      this._applyMessageEvent(event.type, event.data);
    }
    if (event.type === 'NOTIFICATION_CREATE') {
      const notification = sanitizeNotification(event.data);
      if (notification) {
        this.snapshot.notifications.unshift(notification);
        this.snapshot.notifications.length = Math.min(this.snapshot.notifications.length, RECENT_NOTIFICATION_LIMIT);
      }
    }
    if (event.type === 'CURRENT_USER_UPDATE') {
      this.snapshot.currentUser = sanitizeUser(event.data);
    }
    this._recordEvent(event.type, eventLabel(event.type));
    this._emit();
  }

  _applyMessageEvent(type, data) {
    const channelId = cleanString(data && data.channel_id, 32);
    const selectedId = this.snapshot.chat.selected && this.snapshot.chat.selected.id;
    if (!channelId || channelId !== selectedId) return;
    const message = sanitizeMessage(data && data.message, channelId);
    if (!message) return;
    const index = this.snapshot.chat.messages.findIndex(item => item.id === message.id);
    if (type === 'MESSAGE_DELETE') {
      if (index >= 0) this.snapshot.chat.messages[index] = Object.assign({}, this.snapshot.chat.messages[index], { deleted: true, edited: false });
      else this.snapshot.chat.messages.unshift(Object.assign(message, { deleted: true }));
    } else if (index >= 0) {
      const previous = this.snapshot.chat.messages[index];
      this.snapshot.chat.messages[index] = Object.assign({}, previous, message, {
        author: message.author || previous.author, content: message.content == null ? previous.content : message.content,
        timestamp: message.timestamp || previous.timestamp, edited: type === 'MESSAGE_UPDATE' || message.edited,
      });
    } else this.snapshot.chat.messages.unshift(message);
    this.snapshot.chat.messages.length = Math.min(this.snapshot.chat.messages.length, RECENT_MESSAGE_LIMIT);
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

module.exports = {
  DiscordAppHost, RECENT_EVENT_LIMIT, RECENT_MESSAGE_LIMIT, RECENT_NOTIFICATION_LIMIT, canAttemptCapability,
  sanitizeMessage, sanitizeNotification, sanitizeParticipant, sanitizeStatusText, usableTextChannels, usableVoiceChannels,
};
