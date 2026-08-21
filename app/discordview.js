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

  function connectionView(connection) {
    const state = connection.state || 'disconnected';
    const copy = {
      'not-running': ['Discord is not running', 'Start Discord, then reconnect.'], connecting: connection.authState === 'authorizing' ? ['Authorizing Discord', 'Approve access in Discord to continue.'] : ['Connecting to Discord', 'Establishing the local desktop connection…'],
      reconnecting: ['Reconnecting to Discord', 'The connection was interrupted.'], disconnected: ['Discord disconnected', 'Reconnect when Discord is available.'],
      error: ['Discord connection error', connection.error || 'Discord could not be reached.'],
    }[state] || ['Discord unavailable', 'Discord could not be reached.'];
    const canReconnect = ['not-running', 'disconnected', 'error'].includes(state);
    return '<section class="connection"><h1>' + esc(copy[0]) + '</h1><p>' + esc(copy[1]) + '</p>' + (canReconnect ? '<button class="accent" data-action="reconnect">Reconnect</button>' : '') + '</section>';
  }

  const CAPABILITY_LABELS = {
    voiceSettings: 'Voice settings', voiceChannelControl: 'Voice channel control', guildDiscovery: 'Guild discovery',
    channelDiscovery: 'Channel discovery', textChannelSelection: 'Text-channel selection', activity: 'Activity / Rich Presence',
  };

  function voiceView(state) {
    if (!state.connection || state.connection.state !== 'connected') return connectionView(state.connection || {});
    const voice = state.voice || {}, channel = state.channel || {}, input = voice.input || {}, output = voice.output || {};
    const voiceCap = capability(state, 'voiceSettings'), channelCap = capability(state, 'voiceChannelControl');
    const discover = capability(state, 'guildDiscovery') && capability(state, 'channelDiscovery');
    const participants = Array.isArray(state.participants) ? state.participants : null;
    return '<section class="voice">'
      + '<article class="card"><div class="status"><span class="dot"></span>Connected</div><div class="eyebrow">Current voice channel</div>'
      + '<div class="channel-name" title="' + esc(channel.name || 'Not connected') + '">' + esc(channel.name || 'Not connected') + '</div><div class="guild-name">' + esc(channel.guild_name || channel.guild && channel.guild.name || 'No active guild') + '</div>'
      + (voiceCap ? '<div class="primary-controls"><button data-action="mute" data-value="' + (!voice.mute) + '"' + disabled(!voiceCap) + '>' + (voice.mute ? 'Unmute' : 'Mute') + '</button><button data-action="deaf" data-value="' + (!voice.deaf) + '"' + disabled(!voiceCap) + '>' + (voice.deaf ? 'Undeafen' : 'Deafen') + '</button></div>' : '')
      + '<div class="channel-actions"><button data-focus="channel"' + disabled(!discover) + '>Change channel</button><button class="danger" data-action="leave"' + disabled(!channelCap || !channel.id) + '>Leave</button></div></article>'
      + '<article class="card"><div class="selectors"><div class="field"><label for="guild">Guild</label><select id="guild" data-action="guild"' + disabled(!discover) + '>' + options(state.guilds, channel.guild_id, 'Select guild') + '</select></div><div class="field"><label for="channel">Voice channel</label><select id="channel" data-action="channel"' + disabled(!discover || !channelCap) + '>' + options(state.channels, channel.id, 'Select channel') + '</select></div></div>'
      + (voiceCap ? '<div class="devices"><div class="field"><label for="input-device">Input device</label><select id="input-device" data-action="input-device">' + options(input.available_devices, input.device_id, 'System default') + '</select></div><div class="field"><label for="output-device">Output device</label><select id="output-device" data-action="output-device">' + options(output.available_devices, output.device_id, 'System default') + '</select></div></div><div class="volumes"><label class="range-row">Input<input data-action="input-volume" type="range" min="0" max="200" value="' + esc(input.volume == null ? 100 : input.volume) + '"><output>' + esc(input.volume == null ? 100 : input.volume) + '</output></label><label class="range-row">Output<input data-action="output-volume" type="range" min="0" max="200" value="' + esc(output.volume == null ? 100 : output.volume) + '"><output>' + esc(output.volume == null ? 100 : output.volume) + '</output></label></div>' : '<p class="limited">Voice device and volume controls are unavailable in this Discord connection.</p>') + '</article>'
      + '<article class="card participants"><h2>Participants</h2>' + (participants ? '<div class="participant-list">' + participants.map(p => '<div class="participant">' + esc(p.nick || p.name || p.username || p.user && p.user.username || 'Unnamed participant') + '</div>').join('') + '</div>' : '<p class="limited">Participant details are not exposed by the current Discord RPC connection.</p>') + '</article></section>';
  }

  function activityView(state) {
    const connection = state.connection || { state: 'disconnected' }, connected = connection.state === 'connected';
    const channel = state.channel || {}, voice = state.voice || {}, settings = state.settings || {};
    const activityState = capabilityState(state, 'activity');
    const activitySupported = connected && canAttempt(state, 'activity');
    const available = Object.keys(CAPABILITY_LABELS).filter(name => capability(state, name)).length;
    const events = Array.isArray(state.recentEvents) ? state.recentEvents.slice(0, 8) : [];
    const status = { 'not-running': 'Discord not running', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', disconnected: 'Disconnected', error: 'Connection error' }[connection.state] || 'Disconnected';
    return '<section class="activity-view"><article class="card activity-overview"><div class="status"><span class="dot ' + (connected ? '' : 'inactive') + '"></span>' + esc(status) + '</div><div class="eyebrow">Current server</div><div class="activity-title">' + esc(channel.guild_name || channel.guild && channel.guild.name || 'No active server') + '</div><div class="activity-channel">' + esc(channel.name || 'No voice channel selected') + '</div><dl class="activity-facts"><div><dt>Voice</dt><dd>' + (capability(state, 'voiceSettings') ? esc((voice.mute ? 'Muted' : 'Mic on') + ' · ' + (voice.deaf ? 'Deafened' : 'Audio on')) : 'Unavailable') + '</dd></div><div><dt>Session duration</dt><dd>Not exposed by Discord</dd></div></dl></article>'
      + '<article class="card presence-card"><div class="eyebrow">Rich Presence</div><div class="presence-state">' + (activitySupported ? (settings.richPresence ? 'Enabled' : activityState === 'available' ? 'Disabled' : 'Not yet verified') : 'Unavailable') + '</div><p>' + (activitySupported ? (activityState === 'available' ? 'open-quake can publish its supported activity state.' : 'Availability will be verified when you change this setting.') : 'This Discord connection does not support activity updates.') + '</p>' + (activitySupported ? '<button class="accent" data-action="rich-presence" data-value="' + (!settings.richPresence) + '">' + (settings.richPresence ? 'Disable' : 'Enable') + '</button>' : '') + '<div class="capability-summary"><strong>' + available + ' of ' + Object.keys(CAPABILITY_LABELS).length + '</strong><span>capabilities verified available</span></div></article>'
      + '<article class="card recent-card"><div class="eyebrow">Recent events</div>' + (events.length ? '<ol class="event-list">' + events.map(event => '<li><span>' + esc(event.label || 'Discord activity received') + '</span><time>' + esc(event.at ? new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + '</time></li>').join('') + '</ol>' : '<p class="limited compact">No recent Discord events.</p>') + (connection.error ? '<div class="activity-error" role="status">' + esc(connection.error) + '</div>' : '') + '</article></section>';
  }

  function chatView(state) {
    if (!state.connection || state.connection.state !== 'connected') return connectionView(state.connection || {});
    const canBrowse = capability(state, 'guildDiscovery') && capability(state, 'channelDiscovery');
    const canOpen = canAttempt(state, 'textChannelSelection');
    const chat = state.chat || {}, guilds = Array.isArray(state.guilds) ? state.guilds : [];
    const channels = Array.isArray(chat.channels) ? chat.channels : [];
    const selected = chat.selected || chat.lastSelected;
    if (!canBrowse || !canOpen) return '<section class="connection"><h1>Chat launcher unavailable</h1><p>This Discord connection does not support ' + (!canBrowse ? 'server and channel discovery' : 'opening text channels') + '.</p></section>';
    return '<section class="chat-view">'
      + '<article class="card chat-browser"><div class="status"><span class="dot"></span>Connected</div><div class="eyebrow">Discord servers</div><h1>Choose a server</h1>'
      + (guilds.length ? '<div class="touch-list" role="list">' + guilds.map(guild => '<button role="listitem" data-action="chat-guild" data-value="' + esc(guild.id) + '"' + (String(guild.id) === String(chat.guildId || '') ? ' aria-current="true"' : '') + '>' + esc(guild.name || guild.id) + '</button>').join('') + '</div>' : '<p class="limited compact">No Discord servers are available.</p>') + '</article>'
      + '<article class="card chat-channels"><div class="eyebrow">Text channels</div><h1>' + (chat.guildId ? 'Choose a channel' : 'Select a server first') + '</h1>'
      + (chat.guildId ? (channels.length ? '<div class="touch-list" role="list">' + channels.map(channel => '<button role="listitem" data-action="chat-channel" data-value="' + esc(channel.id) + '"><span>#</span>' + esc(channel.name || channel.id) + '</button>').join('') + '</div>' : '<p class="limited compact">No usable text channels are available in this server.</p>') : '<p class="limited compact">Your server\'s text channels will appear here.</p>') + '</article>'
      + '<article class="card chat-status"><div class="eyebrow">Channel launcher</div><div class="launch-title">' + (selected ? '#' + esc(selected.name || selected.id) : 'No channel opened') + '</div><p>' + esc(chat.error || chat.status || (selected ? 'Last successfully opened channel' : 'Select a text channel to open it in Discord.')) + '</p>' + (chat.error ? '<div class="activity-error" role="status">' + esc(chat.error) + '</div>' : '') + '</article></section>';
  }

  function render(state, view) {
    const current = view || 'voice';
    const selected = ['voice', 'chat', 'activity'].includes(current) ? current : 'voice';
    const body = selected === 'voice' ? voiceView(state) : selected === 'activity' ? activityView(state) : chatView(state);
    return '<div class="shell"><nav class="nav" aria-label="Discord views"><div class="brand">Discord</div>' + ['voice', 'chat', 'activity'].map(name => '<button data-view="' + name + '"' + (name === selected ? ' aria-current="page"' : '') + '>' + name[0].toUpperCase() + name.slice(1) + '</button>').join('') + '</nav><div class="view" data-current-view="' + selected + '">' + body + '</div></div>';
  }

  function mount(doc, transport) {
    const host = doc.getElementById('app');
    const query = new URLSearchParams((root.location && root.location.search) || '');
    doc.documentElement.dataset.theme = query.get('_dark') === '0' ? 'light' : 'dark';
    const accent = query.get('_accent');
    if (/^#[0-9a-f]{6}$/i.test(accent || '')) doc.documentElement.style.setProperty('--accent', accent);
    let state = { connection: { state: 'connecting' }, capabilities: {}, settings: {} }, view = 'voice', source, userNavigated = false;
    const api = transport || {
      action: (name, value) => fetch('/api/discord/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, value }) }).then(r => r.json()),
      subscribe: onData => { const s = new EventSource('/api/discord/events'); s.onmessage = e => onData(JSON.parse(e.data)); return () => s.close(); },
    };
    const paint = () => { host.innerHTML = render(state, view); };
    const act = (name, value) => api.action(name, value).then(next => { if (next && next.connection) state = next; paint(); }).catch(() => {});
    host.addEventListener('click', e => {
      const nav = e.target.closest('[data-view]'); if (nav) { view = nav.dataset.view; userNavigated = true; paint(); return; }
      const button = e.target.closest('[data-action]'); if (button) act(button.dataset.action, actionValue(button.dataset.value));
      const focus = e.target.closest('[data-focus]'); if (focus) { const target = doc.getElementById(focus.dataset.focus); if (target) target.focus(); }
    });
    host.addEventListener('change', e => { if (e.target.dataset.action) act(e.target.dataset.action, e.target.value); });
    host.addEventListener('input', e => { if (e.target.type === 'range') { const out = e.target.nextElementSibling; if (out) out.value = e.target.value; } });
    host.addEventListener('pointerup', e => { if (e.target.type === 'range' && e.target.dataset.action) act(e.target.dataset.action, Number(e.target.value)); });
    paint(); source = api.subscribe(next => { state = next; if (!userNavigated && next.settings && next.settings.defaultView) view = next.settings.defaultView; paint(); });
    const cleanup = () => { if (source) source(); source = null; };
    root.addEventListener('pagehide', cleanup, { once: true });
    return { cleanup, getView: () => view };
  }
  return { render, voiceView, chatView, activityView, connectionView, mount };
});
