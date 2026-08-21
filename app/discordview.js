'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DiscordView = api; api.mount(document); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const options = (items, selected, empty) => '<option value="">' + esc(empty) + '</option>' + (items || []).map(item => {
    const id = item.id || item.device_id || '';
    const name = item.name || item.label || item.id || item.device_id || 'Unnamed';
    return '<option value="' + esc(id) + '"' + (String(id) === String(selected || '') ? ' selected' : '') + '>' + esc(name) + '</option>';
  }).join('');
  const capability = (state, name) => !!(state.capabilities && state.capabilities[name]);
  const capabilityState = (state, name) => state.capabilityStates && state.capabilityStates[name] || (capability(state, name) ? 'available' : 'unverified');
  const canAttempt = (state, name) => !['unsupported', 'auth-failure'].includes(capabilityState(state, name));
  const disabled = value => value ? ' disabled' : '';
  const actionValue = value => value === undefined ? undefined : value === 'true' ? true : value === 'false' ? false : value;
  const ICONS = {
    voice: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/>',
    chat: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/>',
    activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3M18 19h-1a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h3v4a2 2 0 0 1-2 2ZM6 19H5a2 2 0 0 1-2-2v-4h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2Z"/>',
    leave: '<path d="M6.6 10.8a15.4 15.4 0 0 1 10.8 0l2.1-2.1a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8l-2.2 2.2a2 2 0 0 1-2.3.4l-2.4-1.2a9 9 0 0 0-7.6 0l-2.4 1.2a2 2 0 0 1-2.3-.4l-2.2-2.2a2 2 0 0 1 0-2.8l.4-.4a2 2 0 0 1 2.8 0Z"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/>',
    hash: '<path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    pulse: '<circle cx="12" cy="12" r="9"/><path d="M7 12h3l2-4 2 8 2-4h2"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    spark: '<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/>',
  };
  const icon = name => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || ICONS.spark) + '</svg>';
  const displayName = user => user && (user.nick || user.displayName || user.global_name || user.username || user.id) || 'Unknown user';
  const avatar = (user, className) => user && user.avatarUrl
    ? '<span class="avatar ' + (className || '') + '"><img src="' + esc(user.avatarUrl) + '" alt=""></span>'
    : '<span class="avatar avatar-fallback ' + (className || '') + '" aria-hidden="true">' + esc(displayName(user).slice(0, 1).toUpperCase()) + '</span>';
  const localTime = value => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const qualityDetails = quality => {
    if (!quality || quality.lastPing == null) return { label: 'Quality unavailable', tone: 'unknown', ping: 'No ping data' };
    const ping = Number(quality.lastPing);
    return { label: ping <= 60 ? 'Excellent' : ping <= 120 ? 'Good' : 'Unstable', tone: ping <= 60 ? 'good' : ping <= 120 ? 'fair' : 'poor', ping: Math.round(ping) + ' ms' };
  };
  const accentForeground = hex => {
    const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.42 ? '#07101f' : '#ffffff';
  };

  function connectionView(connection) {
    const state = connection.state || 'disconnected';
    const copy = {
      'not-running': ['Discord is not running', 'Start Discord, then reconnect.'], connecting: connection.authState === 'authorizing' ? ['Authorizing Discord', 'Approve access in Discord to continue.'] : ['Connecting to Discord', 'Establishing the local desktop connection…'],
      reconnecting: ['Reconnecting to Discord', 'The connection was interrupted.'], disconnected: ['Discord disconnected', 'Reconnect when Discord is available.'],
      error: ['Discord connection error', connection.error || 'Discord could not be reached.'],
    }[state] || ['Discord unavailable', 'Discord could not be reached.'];
    const canReconnect = ['not-running', 'disconnected', 'error'].includes(state);
    return '<section class="connection"><div class="connection-mark">' + icon('pulse') + '</div><div class="eyebrow">Discord connection</div><h1>' + esc(copy[0]) + '</h1><p>' + esc(copy[1]) + '</p>' + (canReconnect ? '<button class="accent connection-action" data-action="reconnect">Reconnect</button>' : '') + '</section>';
  }

  const CAPABILITY_LABELS = {
    voiceSettings: 'Voice settings', voiceChannelControl: 'Voice channel control', guildDiscovery: 'Guild discovery',
    channelDiscovery: 'Channel discovery', textChannelSelection: 'Text-channel selection', activity: 'Activity / Rich Presence',
    participants: 'Voice participants', speakingEvents: 'Speaking events', perUserVoiceControl: 'Participant controls',
    connectionQuality: 'Voice connection quality', messageEvents: 'Live messages', messageHistory: 'Message history',
    notifications: 'Notifications', currentUserEvents: 'Account updates',
  };

  function voiceView(state) {
    if (!state.connection || state.connection.state !== 'connected') return connectionView(state.connection || {});
    const voice = state.voice || {}, channel = state.channel || {}, input = voice.input || {}, output = voice.output || {};
    const voiceCap = capability(state, 'voiceSettings'), channelCap = capability(state, 'voiceChannelControl');
    const guildDiscovery = capability(state, 'guildDiscovery'), channelDiscovery = capability(state, 'channelDiscovery');
    const selection = state.voiceSelection || {
      guildId: channel.guild_id || null, channelId: channel.id || null, channels: state.channels || [], status: null, error: null,
    };
    const selectedGuildId = selection.guildId || '';
    const selectedChannelId = selection.channelId || '';
    const voiceChannels = Array.isArray(selection.channels) ? selection.channels : [];
    const loadingChannels = !!selection.status;
    const channelPlaceholder = loadingChannels ? 'Loading channels…'
      : selection.error ? 'Channels unavailable'
        : !selectedGuildId ? 'Select a server first'
          : voiceChannels.length ? 'Select channel' : 'No voice channels';
    const channelFeedback = selection.error || selection.status
      || (selectedGuildId && !voiceChannels.length ? 'No voice channels are available in this server.' : '');
    const participants = Array.isArray(state.participants) ? state.participants : [];
    const participantControls = canAttempt(state, 'perUserVoiceControl');
    const quality = qualityDetails(state.voiceConnection);
    return '<section class="voice">'
      + '<article class="card voice-console"><div class="console-top"><div class="status"><span class="dot"></span>Voice connected</div><div class="quality-pill ' + quality.tone + '">' + icon('pulse') + '<span>' + esc(quality.label) + '</span><strong>' + esc(quality.ping) + '</strong></div></div><div class="channel-context"><div class="eyebrow">Current voice channel</div><div class="channel-name" title="' + esc(channel.name || 'Not connected') + '">' + esc(channel.name || 'Not connected') + '</div><div class="guild-name">' + esc(channel.guild_name || channel.guild && channel.guild.name || 'No active server') + '</div></div>'
      + '<div class="primary-controls">' + (voiceCap
        ? '<button class="control-button ' + (voice.mute ? 'active-state' : '') + '" data-action="mute" data-value="' + (!voice.mute) + '" aria-pressed="' + (!!voice.mute) + '">' + icon('voice') + '<span>' + (voice.mute ? 'Unmute' : 'Mute') + '</span><small>' + (voice.mute ? 'Microphone off' : 'Microphone on') + '</small></button><button class="control-button ' + (voice.deaf ? 'active-state' : '') + '" data-action="deaf" data-value="' + (!voice.deaf) + '" aria-pressed="' + (!!voice.deaf) + '">' + icon('headphones') + '<span>' + (voice.deaf ? 'Undeafen' : 'Deafen') + '</span><small>' + (voice.deaf ? 'Audio off' : 'Audio on') + '</small></button>'
        : '<button class="control-button" disabled>' + icon('voice') + '<span>Microphone</span><small>Unavailable</small></button><button class="control-button" disabled>' + icon('headphones') + '<span>Audio</span><small>Unavailable</small></button>')
      + '<button class="control-button danger" data-action="leave"' + disabled(!channelCap || !channel.id) + '>' + icon('leave') + '<span>Leave</span><small>Voice channel</small></button></div><button class="channel-change" data-focus="' + (selectedGuildId ? 'channel' : 'guild') + '"' + disabled(!guildDiscovery) + '>' + icon('server') + '<span>Change voice channel</span><strong>' + esc(channel.name || 'None selected') + '</strong></button></article>'
      + '<article class="card participants"><div class="section-heading"><div><div class="eyebrow">Voice room</div><h2>Participants</h2></div><span class="count-pill">' + participants.length + '</span></div>' + (participants.length ? '<div class="participant-list" data-preserve-scroll="voice-participants">' + participants.map(p => {
        const participantState = [p.selfMute || p.mute ? 'Muted' : '', p.selfDeaf || p.deaf ? 'Deafened' : '', p.speaking ? 'Speaking' : 'Listening'].filter(Boolean).join(' · ');
        return '<div class="participant ' + (p.speaking ? 'speaking' : '') + '">' + avatar(p, 'participant-avatar') + '<div class="participant-name"><strong>' + esc(displayName(p)) + '</strong><span>' + esc(participantState) + '</span></div>' + (participantControls ? '<button class="participant-mute ' + (p.localMute ? 'active-state' : '') + '" data-participant-action="participant-mute" data-user-id="' + esc(p.id) + '" data-value="' + (!p.localMute) + '" aria-pressed="' + (!!p.localMute) + '">' + (p.localMute ? 'Unmute' : 'Mute') + '</button><label class="participant-volume"><span>Vol</span><input aria-label="Participant volume" data-participant-action="participant-volume" data-user-id="' + esc(p.id) + '" type="range" min="0" max="200" value="' + esc(p.volume == null ? 100 : p.volume) + '"><output>' + esc(p.volume == null ? 100 : p.volume) + '%</output></label>' : '<span class="capability-note">Controls unavailable</span>') + '</div>';
      }).join('') + '</div>' : '<div class="empty-state">' + icon('user') + '<strong>No participants are exposed</strong><span>Discord has not supplied anyone for this voice channel.</span></div>') + (state.voiceControlLock ? '<p class="control-lock">Participant settings stay under open-quake control until RPC disconnects.</p>' : '') + '</article>'
      + '<article class="card mixer"><div class="section-heading"><div><div class="eyebrow">Voice setup</div><h2>Channel &amp; audio</h2></div></div><div class="selectors"><div class="field"><label for="guild">Server</label><select id="guild" data-action="guild"' + disabled(!guildDiscovery) + '>' + options(state.guilds, selectedGuildId, 'Select server') + '</select></div><div class="field"><label for="channel">Voice channel</label><select id="channel" data-action="channel" aria-busy="' + loadingChannels + '"' + disabled(!selectedGuildId || loadingChannels || !!selection.error || !voiceChannels.length || !channelDiscovery || !channelCap) + '>' + options(voiceChannels, selectedChannelId, channelPlaceholder) + '</select></div></div><div class="selector-feedback ' + (selection.error ? 'error' : '') + '" role="status">' + esc(channelFeedback) + '</div>'
      + (voiceCap ? '<div class="devices"><div class="field"><label for="input-device">Microphone</label><select id="input-device" data-action="input-device">' + options(input.available_devices, input.device_id, 'System default') + '</select></div><div class="field"><label for="output-device">Output</label><select id="output-device" data-action="output-device">' + options(output.available_devices, output.device_id, 'System default') + '</select></div></div><div class="volumes"><label class="range-row"><span>Mic level</span><input data-action="input-volume" type="range" min="0" max="200" value="' + esc(input.volume == null ? 100 : input.volume) + '"><output>' + esc(input.volume == null ? 100 : input.volume) + '%</output></label><label class="range-row"><span>Output</span><input data-action="output-volume" type="range" min="0" max="200" value="' + esc(output.volume == null ? 100 : output.volume) + '"><output>' + esc(output.volume == null ? 100 : output.volume) + '%</output></label></div>' : '<div class="empty-state compact-empty">' + icon('headphones') + '<strong>Voice controls unavailable</strong><span>Voice device and volume controls are unavailable in this Discord connection.</span></div>') + '</article></section>';
  }

  function activityView(state) {
    const connection = state.connection || { state: 'disconnected' }, connected = connection.state === 'connected';
    const channel = state.channel || {}, voice = state.voice || {}, settings = state.settings || {};
    const guild = (state.guilds || []).find(item => String(item.id) === String(channel.guild_id || ''));
    const activityState = capabilityState(state, 'activity');
    const activitySupported = connected && canAttempt(state, 'activity');
    const available = Object.keys(CAPABILITY_LABELS).filter(name => capability(state, name)).length;
    const events = Array.isArray(state.recentEvents) ? state.recentEvents.slice(0, 8) : [];
    const quality = state.voiceConnection || {}, qualityState = qualityDetails(quality), notifications = Array.isArray(state.notifications) ? state.notifications.slice(0, 6) : [];
    const currentUser = state.currentUser || {};
    const accountAvailable = !!(currentUser.id || currentUser.username || currentUser.global_name || currentUser.displayName);
    const accountName = accountAvailable ? displayName(currentUser) : 'Identity unavailable';
    const status = { 'not-running': 'Discord not running', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', disconnected: 'Disconnected', error: 'Connection error' }[connection.state] || 'Disconnected';
    return '<section class="activity-view"><article class="card activity-overview"><div class="section-heading"><div><div class="eyebrow">Discord status</div><h2>Connection</h2></div><span class="state-pill ' + (connected ? 'connected' : 'disconnected') + '"><span class="dot ' + (connected ? '' : 'inactive') + '"></span>' + esc(status) + '</span></div><div class="identity-row">' + avatar(accountAvailable ? currentUser : { displayName: 'Account' }, 'identity-avatar') + '<div><span>' + (accountAvailable ? 'Signed in as' : 'Current account') + '</span><strong>' + esc(accountName) + '</strong></div></div><div class="voice-summary"><div><span>Current voice</span><strong title="' + esc(channel.name || 'No voice channel selected') + '">' + esc(channel.name || 'No voice channel selected') + '</strong><small>' + esc(guild && guild.name || channel.guild_name || 'No active server') + '</small></div><div class="quality-tile ' + qualityState.tone + '">' + icon('pulse') + '<span>' + esc(qualityState.label) + '</span><strong>' + esc(qualityState.ping) + '</strong></div></div>' + (connection.error ? '<div class="activity-error" role="status">' + esc(connection.error) + '</div>' : '') + '</article>'
      + '<article class="card presence-card"><div class="section-heading"><div><div class="eyebrow">Voice &amp; presence</div><h2>Live state</h2></div><span class="capability-count">' + available + ' of ' + Object.keys(CAPABILITY_LABELS).length + '</span></div><dl class="activity-facts"><div><dt>Voice</dt><dd>' + (capability(state, 'voiceSettings') ? esc((voice.mute ? 'Muted' : 'Mic on') + ' · ' + (voice.deaf ? 'Deafened' : 'Audio on')) : 'Unavailable') + '</dd></div><div><dt>Connection</dt><dd>' + esc(quality.state || 'No live status') + '</dd></div><div><dt>Last / average ping</dt><dd>' + (quality.lastPing == null ? 'Unavailable' : esc(quality.lastPing + ' / ' + quality.averagePing + ' ms')) + '</dd></div></dl><div class="presence-control"><div><span>Rich Presence</span><strong>' + (activitySupported ? (settings.richPresence ? 'Enabled' : activityState === 'available' ? 'Disabled' : 'Not yet verified') : 'Unavailable') + '</strong><small>' + (activitySupported ? (activityState === 'available' ? 'Publish supported open-quake activity.' : 'Availability will be verified when you change this setting.') : 'This Discord connection does not support activity updates.') + '</small></div>' + (activitySupported ? '<button class="accent" data-action="rich-presence" data-value="' + (!settings.richPresence) + '">' + (settings.richPresence ? 'Disable' : 'Enable') + '</button>' : '') + '</div></article>'
      + '<article class="card recent-card"><div class="feed-column"><div class="feed-heading">' + icon('bell') + '<div><div class="eyebrow">Inbox</div><h2>Notifications</h2></div><span class="count-pill">' + notifications.length + '</span></div>' + (notifications.length ? '<ol class="event-list notification-list" data-preserve-scroll="activity-notifications">' + notifications.map(item => '<li>' + (item.iconUrl ? '<span class="event-icon"><img src="' + esc(item.iconUrl) + '" alt=""></span>' : '<span class="event-icon">' + icon('bell') + '</span>') + '<span class="event-copy"><strong>' + esc(item.title || 'Discord notification') + '</strong><small>' + esc(item.body || '') + '</small></span><time>' + esc(localTime(item.at)) + '</time></li>').join('') + '</ol>' : '<div class="feed-empty">No recent Discord notifications.</div>') + '</div><div class="feed-column"><div class="feed-heading">' + icon('activity') + '<div><div class="eyebrow">RPC stream</div><h2>Recent events</h2></div><span class="count-pill">' + events.length + '</span></div>' + (events.length ? '<ol class="event-list" data-preserve-scroll="activity-events">' + events.slice(0, 5).map(event => '<li><span class="event-icon">' + icon('spark') + '</span><span class="event-copy"><strong>' + esc(event.label || 'Discord activity received') + '</strong><small>' + esc(event.type || 'Discord event') + '</small></span><time>' + esc(localTime(event.at)) + '</time></li>').join('') + '</ol>' : '<div class="feed-empty">No recent Discord events.</div>') + '</div></article></section>';
  }

  function chatView(state) {
    if (!state.connection || state.connection.state !== 'connected') return connectionView(state.connection || {});
    const canBrowse = capability(state, 'guildDiscovery') && capability(state, 'channelDiscovery');
    const canOpen = canAttempt(state, 'textChannelSelection');
    const chat = state.chat || {}, guilds = Array.isArray(state.guilds) ? state.guilds : [];
    const channels = Array.isArray(chat.channels) ? chat.channels : [];
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    const selected = chat.selected || chat.lastSelected;
    if (!canBrowse || !canOpen) return '<section class="connection"><h1>Chat launcher unavailable</h1><p>This Discord connection does not support ' + (!canBrowse ? 'server and channel discovery' : 'opening text channels') + '.</p></section>';
    const selectedGuild = guilds.find(guild => String(guild.id) === String(chat.guildId || ''));
    const streamLabel = chat.historyAvailable === false ? 'Live only' : chat.historyAvailable === true ? 'History + live' : 'Waiting for channel';
    return '<section class="chat-view">'
      + '<article class="card chat-browser"><div class="section-heading"><div><div class="eyebrow">Discord servers</div><h2>Servers</h2></div><span class="status-dot" title="Connected"><span class="dot"></span></span></div>'
      + (guilds.length ? '<div class="touch-list" role="list" data-preserve-scroll="chat-guilds">' + guilds.map(guild => '<button role="listitem" data-action="chat-guild" data-value="' + esc(guild.id) + '"' + (String(guild.id) === String(chat.guildId || '') ? ' aria-current="true"' : '') + '><span class="list-icon">' + icon('server') + '</span><span>' + esc(guild.name || guild.id) + '</span></button>').join('') + '</div>' : '<div class="empty-state list-empty">' + icon('server') + '<strong>No Discord servers</strong><span>No Discord servers are available.</span></div>') + '</article>'
      + '<article class="card chat-channels"><div class="section-heading"><div><div class="eyebrow">' + esc(selectedGuild && selectedGuild.name || 'Text channels') + '</div><h2>' + (chat.guildId ? 'Channels' : 'Select a server') + '</h2></div></div>'
      + (chat.guildId ? (channels.length ? '<div class="touch-list" role="list" data-preserve-scroll="chat-channels">' + channels.map(channel => '<button role="listitem" data-action="chat-channel" data-value="' + esc(channel.id) + '"' + (selected && String(selected.id) === String(channel.id) ? ' aria-current="true"' : '') + '><span class="list-icon">' + icon('hash') + '</span><span>' + esc(channel.name || channel.id) + '</span></button>').join('') + '</div>' : '<div class="empty-state list-empty">' + icon('hash') + '<strong>No usable text channels</strong><span>No usable text channels are available in this server.</span></div>') : '<div class="empty-state list-empty">' + icon('hash') + '<strong>Choose a server</strong><span>Your server\'s text channels will appear here.</span></div>') + '</article>'
      + '<article class="card chat-status"><header class="chat-header"><div class="channel-heading"><span class="channel-icon">' + icon('hash') + '</span><div><div class="eyebrow">Recent messages</div><div class="launch-title" title="' + esc(selected && (selected.name || selected.id) || 'No channel opened') + '">' + (selected ? '#' + esc(selected.name || selected.id) : 'No channel opened') + '</div></div></div><div class="chat-header-actions"><span class="stream-pill ' + (chat.historyAvailable === false ? 'live-only' : '') + '"><span class="dot"></span>' + esc(streamLabel) + '</span>' + (selected ? '<button class="accent open-discord" data-action="chat-channel" data-value="' + esc(selected.id) + '">' + icon('external') + '<span>Open in Discord</span></button>' : '') + '</div></header><div class="stream-status">' + esc(chat.error || chat.status || (chat.historyAvailable === false ? 'Message history is unavailable. New subscribed messages will appear here live.' : selected ? 'Read-only Discord messages. New events appear automatically.' : 'Select a server and text channel to view available messages.')) + '</div>'
      + (messages.length ? '<ol class="message-list" data-preserve-scroll="chat-messages">' + messages.map(message => '<li class="message ' + (message.deleted ? 'deleted' : '') + '">' + avatar(message.author, 'message-avatar') + '<div class="message-copy"><header><strong>' + esc(displayName(message.author)) + '</strong><time>' + esc(localTime(message.timestamp)) + '</time>' + (message.edited ? '<span class="edited">edited</span>' : '') + '</header><p>' + esc(message.deleted ? 'Message deleted' : message.content || '(No text content exposed)') + '</p></div></li>').join('') + '</ol>' : '<div class="empty-state message-empty">' + icon('chat') + '<strong>' + (selected ? 'No messages exposed' : 'Choose a channel') + '</strong><span>' + (selected ? (chat.historyAvailable === false ? 'Live messages will appear here as Discord sends them.' : 'No messages are available for this channel yet.') : 'This is a read-only Discord message surface.') + '</span></div>') + (chat.error ? '<div class="activity-error" role="status">' + esc(chat.error) + '</div>' : '') + '</article></section>';
  }

  function render(state, view) {
    const current = view || 'voice';
    const selected = ['voice', 'chat', 'activity'].includes(current) ? current : 'voice';
    const body = selected === 'voice' ? voiceView(state) : selected === 'activity' ? activityView(state) : chatView(state);
    return '<div class="shell"><nav class="nav" aria-label="Discord views"><div class="brand"><span class="brand-mark">OQ</span><span><strong>Discord</strong><small>Control surface</small></span></div><div class="nav-items">' + ['voice', 'chat', 'activity'].map(name => '<button data-view="' + name + '"' + (name === selected ? ' aria-current="page"' : '') + '>' + icon(name) + '<span>' + name[0].toUpperCase() + name.slice(1) + '</span></button>').join('') + '</div><div class="nav-foot"><span class="dot ' + (state.connection && state.connection.state === 'connected' ? '' : 'inactive') + '"></span><span>' + esc(state.connection && state.connection.state === 'connected' ? 'Connected' : 'Offline') + '</span></div></nav><div class="view" data-current-view="' + selected + '">' + body + '</div></div>';
  }

  function createRenderController(host, renderHtml) {
    let activeControl = null, pending = false, lastHtml = null;
    const captureScroll = () => {
      if (!host.querySelectorAll) return [];
      return Array.from(host.querySelectorAll('[data-preserve-scroll]')).map(element => ({
        key: element.getAttribute('data-preserve-scroll'), top: element.scrollTop, left: element.scrollLeft,
      }));
    };
    const restoreScroll = positions => {
      if (!positions.length || !host.querySelectorAll) return;
      const elements = Array.from(host.querySelectorAll('[data-preserve-scroll]'));
      positions.forEach(position => {
        const element = elements.find(item => item.getAttribute('data-preserve-scroll') === position.key);
        if (element) { element.scrollTop = position.top; element.scrollLeft = position.left; }
      });
    };
    const paint = force => {
      if (activeControl && !force) { pending = true; return false; }
      const html = renderHtml();
      if (html === lastHtml) { pending = false; return false; }
      const scroll = captureScroll();
      host.innerHTML = html;
      restoreScroll(scroll);
      lastHtml = html;
      pending = false;
      return true;
    };
    const beginInteraction = target => { if (target && !target.disabled) activeControl = target; };
    const endInteraction = (target, flush) => {
      if (target && activeControl && target !== activeControl) return;
      activeControl = null;
      if (pending && flush !== false) paint();
    };
    return { paint, beginInteraction, endInteraction, isPending: () => pending };
  }

  function mount(doc, transport) {
    const host = doc.getElementById('app');
    const query = new URLSearchParams((root.location && root.location.search) || '');
    doc.documentElement.dataset.theme = query.get('_dark') === '0' ? 'light' : 'dark';
    const accent = query.get('_accent');
    if (/^#[0-9a-f]{6}$/i.test(accent || '')) {
      doc.documentElement.style.setProperty('--accent', accent);
      doc.documentElement.style.setProperty('--accent-fg', accentForeground(accent));
    }
    let state = { connection: { state: 'connecting' }, capabilities: {}, settings: {} }, view = 'voice', source, userNavigated = false;
    const api = transport || {
      action: (name, value) => fetch('/api/discord/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, value }) }).then(r => r.json()),
      subscribe: onData => { const s = new EventSource('/api/discord/events'); s.onmessage = e => onData(JSON.parse(e.data)); return () => s.close(); },
    };
    const renderer = createRenderController(host, () => render(state, view));
    const paint = force => renderer.paint(force);
    const act = (name, value) => Promise.resolve().then(() => api.action(name, value)).then(next => { if (next && next.connection) state = next; paint(); }).catch(() => { paint(); });
    const protectedControl = target => {
      if (!target) return null;
      if (target.tagName === 'SELECT' || target.tagName === 'BUTTON' || target.type === 'range') return target;
      return target.closest ? target.closest('select,button,input[type="range"]') : null;
    };
    const valueControl = target => {
      const control = protectedControl(target);
      return control && (control.tagName === 'SELECT' || control.type === 'range') ? control : null;
    };
    const onClick = e => {
      const clickedButton = e.target.closest('button');
      if (clickedButton) renderer.endInteraction(clickedButton, false);
      const nav = e.target.closest('[data-view]'); if (nav) { renderer.endInteraction(null, false); view = nav.dataset.view; userNavigated = true; paint(true); return; }
      const participant = e.target.closest('[data-participant-action]'); if (participant && participant.type !== 'range') { act(participant.dataset.participantAction, { userId: participant.dataset.userId, value: actionValue(participant.dataset.value) }); return; }
      const button = e.target.closest('button[data-action]'); if (button) act(button.dataset.action, actionValue(button.dataset.value));
      const focus = e.target.closest('[data-focus]'); if (focus) { const target = doc.getElementById(focus.dataset.focus); if (target) target.focus(); }
    };
    const onChange = e => {
      if (e.target.type === 'range') return;
      renderer.endInteraction(e.target, false);
      if (e.target.dataset.action) act(e.target.dataset.action, e.target.value);
    };
    const onInput = e => { if (e.target.type === 'range') { const out = e.target.nextElementSibling; if (out) out.value = e.target.value; } };
    const onPointerDown = e => { const control = protectedControl(e.target); if (control) renderer.beginInteraction(control); };
    const onFocusIn = e => { const control = valueControl(e.target); if (control) renderer.beginInteraction(control); };
    const onFocusOut = e => { const control = valueControl(e.target); if (control) renderer.endInteraction(control); };
    const onPointerCancel = e => { const control = protectedControl(e.target); if (control) renderer.endInteraction(control); };
    const onPointerUp = e => {
      if (e.target.type !== 'range') return;
      if (e.target.dataset.participantAction) act(e.target.dataset.participantAction, { userId: e.target.dataset.userId, value: Number(e.target.value) });
      else if (e.target.dataset.action) act(e.target.dataset.action, Number(e.target.value));
      renderer.endInteraction(e.target, false);
    };
    const listeners = {
      click: onClick, change: onChange, input: onInput, pointerdown: onPointerDown, pointerup: onPointerUp,
      pointercancel: onPointerCancel, focusin: onFocusIn, focusout: onFocusOut,
    };
    Object.keys(listeners).forEach(name => host.addEventListener(name, listeners[name]));
    paint(); source = api.subscribe(next => { state = next; if (!userNavigated && next.settings && next.settings.defaultView) view = next.settings.defaultView; paint(); });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (source) source();
      source = null;
      Object.keys(listeners).forEach(name => { if (host.removeEventListener) host.removeEventListener(name, listeners[name]); });
      if (root.removeEventListener) root.removeEventListener('pagehide', cleanup);
    };
    root.addEventListener('pagehide', cleanup, { once: true });
    return { cleanup, getView: () => view };
  }
  return { render, voiceView, chatView, activityView, connectionView, createRenderController, mount };
});
