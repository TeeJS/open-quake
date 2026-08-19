(function () {
  'use strict';

  var capability = '';
  var officeLoad = null;
  var officeOptions = {};
  var selectedAppIndex = 0;
  var Calendar = window.OfficeCalendar;
  var TEAMS_URLS = {
    teams: 'https://teams.microsoft.com/v2/',
    activity: 'https://teams.microsoft.com/v2/?clientType=web#/activity',
    chat: 'https://teams.microsoft.com/v2/?clientType=web#/chat',
    channels: 'https://teams.microsoft.com/v2/?clientType=web#/conversations',
    calendar: 'https://outlook.office.com/calendar',
    office: 'https://www.office.com/',
  };
  var APP_PRESENTATION = {
    teams: { name: 'Teams', description: 'Open Microsoft Teams', icon: 'T', className: 'teams' },
    outlook: { name: 'Outlook', description: 'Mail and calendar', icon: 'O', className: 'outlook' },
    word: { name: 'Word', description: 'Documents', icon: 'W', className: 'word' },
    excel: { name: 'Excel', description: 'Spreadsheets', icon: 'X', className: 'excel' },
    powerpoint: { name: 'PowerPoint', description: 'Presentations', icon: 'P', className: 'powerpoint' },
    onenote: { name: 'OneNote', description: 'Notes and notebooks', icon: 'N', className: 'onenote' },
    onedrive: { name: 'OneDrive', description: 'Cloud files', icon: '☁', className: 'onedrive' },
    office: { name: 'Microsoft 365', description: 'Office home', icon: '365', className: 'office' },
  };
  var DEFAULT_APPS = ['teams', 'outlook', 'word', 'excel'];
  var DEFAULT_SHORTCUTS_BY_APP = {
    teams: [{ label: 'Mute', keys: 'Alt+Super+K', icon: '🎙️' }, { label: 'Camera', keys: 'Ctrl+Shift+O', icon: '📹' }, { label: 'Accept audio', keys: 'Ctrl+Shift+S', icon: '📞' }, { label: 'Hang up', keys: 'Ctrl+Shift+H', icon: '📴' }],
    outlook: [{ label: 'New message', keys: 'Ctrl+N', icon: '✉️' }, { label: 'Reply', keys: 'Ctrl+R', icon: '↩️' }, { label: 'Forward', keys: 'Ctrl+F', icon: '↪️' }, { label: 'Send', keys: 'Alt+S', icon: '🚀' }],
    word: [{ label: 'New document', keys: 'Ctrl+N', icon: '📄' }, { label: 'Save', keys: 'Ctrl+S', icon: '💾' }, { label: 'Find', keys: 'Ctrl+F', icon: '🔍' }, { label: 'Undo', keys: 'Ctrl+Z', icon: '↶' }],
    excel: [{ label: 'New workbook', keys: 'Ctrl+N', icon: '📊' }, { label: 'Save', keys: 'Ctrl+S', icon: '💾' }, { label: 'Find', keys: 'Ctrl+F', icon: '🔍' }, { label: 'Undo', keys: 'Ctrl+Z', icon: '↶' }],
    powerpoint: [{ label: 'New presentation', keys: 'Ctrl+N', icon: '🖥️' }, { label: 'Save', keys: 'Ctrl+S', icon: '💾' }, { label: 'New slide', keys: 'Ctrl+M', icon: '➕' }, { label: 'Start slideshow', keys: 'F5', icon: '▶️' }],
    onenote: [{ label: 'New page', keys: 'Ctrl+N', icon: '📝' }, { label: 'Search', keys: 'Ctrl+E', icon: '🔍' }, { label: 'To-do tag', keys: 'Ctrl+1', icon: '☑️' }, { label: 'Undo', keys: 'Ctrl+Z', icon: '↶' }],
    onedrive: [{ label: 'New folder', keys: 'Ctrl+Shift+N', icon: '📁' }, { label: 'Copy', keys: 'Ctrl+C', icon: '📋' }, { label: 'Paste', keys: 'Ctrl+V', icon: '📥' }, { label: 'Refresh', keys: 'F5', icon: '↻' }],
    office: [{ label: 'New', keys: 'Ctrl+N', icon: '✨' }, { label: 'Save', keys: 'Ctrl+S', icon: '💾' }, { label: 'Find', keys: 'Ctrl+F', icon: '🔍' }, { label: 'Undo', keys: 'Ctrl+Z', icon: '↶' }],
  };

  try {
    var query = new URLSearchParams(location.search);
    document.body.classList.toggle('light', query.get('_dark') === '0');
    var accent = query.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(accent)) document.documentElement.style.setProperty('--accent', accent);
  } catch (e) {}

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function setStatus(text, bad) {
    var element = $('status');
    element.textContent = text || '';
    element.classList.toggle('bad', !!bad);
  }

  function readCapability() {
    try { return new URLSearchParams(location.hash.slice(1)).get('_cap') || ''; }
    catch (e) { return ''; }
  }

  function rememberCapability(next) {
    if (!next) return;
    capability = next;
    try { history.replaceState(null, '', location.pathname + location.search + '#_cap=' + encodeURIComponent(next)); }
    catch (e) {}
  }

  function officeFetch(path) {
    capability = capability || readCapability();
    if (!capability) return Promise.reject(new Error('Office session authorization is missing.'));
    return fetch(path, {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + capability },
    }).then(function (response) {
      rememberCapability(response.headers.get('X-Open-Quake-Capability'));
      if (!response.ok) {
        throw new Error(response.status === 403
          ? 'Office session authorization expired.'
          : 'Office service failed (HTTP ' + response.status + ').');
      }
      return response.json();
    });
  }

  function formatTime(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--:--';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function relativeStart(event, now) {
    var start = new Date(event.start).getTime();
    var end = new Date(event.end).getTime();
    if (!Number.isFinite(start)) return '';
    if (start <= now && Number.isFinite(end) && end > now) return 'in progress';
    var minutes = Math.max(0, Math.round((start - now) / 60000));
    if (minutes < 1) return 'starting now';
    if (minutes === 1) return 'in 1 minute';
    if (minutes < 60) return 'in ' + minutes + ' minutes';
    var hours = Math.floor(minutes / 60);
    var remainder = minutes % 60;
    return 'in ' + hours + ' hr' + (hours === 1 ? '' : 's') + (remainder ? ' ' + remainder + ' min' : '');
  }

  function meetingSource(event) {
    if (event.isOnlineMeeting || event.joinUrl) return 'Microsoft Teams meeting';
    return event.location || 'Calendar event';
  }

  function initials(profile) {
    var value = String(profile.displayName || profile.userPrincipalName || 'Microsoft 365').trim();
    var words = value.split(/\s+/).filter(Boolean);
    if (words.length > 1) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
    return value.slice(0, 2).toUpperCase();
  }

  function presenceState(presence) {
    if (!presence) return { className: 'offline', label: 'Unavailable' };
    var value = String(presence.activity || presence.availability || '').toLowerCase();
    if (value.indexOf('inacall') >= 0) return { className: 'call', label: 'In a call' };
    if (value.indexOf('inameeting') >= 0) return { className: 'meeting', label: 'In a meeting' };
    if (value.indexOf('donotdisturb') >= 0) return { className: 'dnd', label: 'Do not disturb' };
    if (value.indexOf('busy') >= 0) return { className: 'busy', label: 'Busy' };
    if (value.indexOf('away') >= 0 || value.indexOf('berightback') >= 0) return { className: 'away', label: 'Away' };
    if (value.indexOf('available') >= 0) return { className: 'available', label: 'Available' };
    return { className: 'offline', label: 'Offline' };
  }

  function renderPresence(presence) {
    var state = presenceState(presence);
    var element = $('presence');
    element.textContent = state.label;
    element.className = 'presence ' + state.className;
    $('presenceAvatar').className = 'avatar ' + state.className;
  }

  function openExternal(url) {
    if (!url) return Promise.resolve(false);
    setStatus('Opening…', false);
    return fetch('/api/office/open?url=' + encodeURIComponent(url), { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('Open-Quake could not open that destination.');
      return response.json();
    }).then(function (result) {
      if (!result || !result.ok) throw new Error('Open-Quake could not open that destination.');
      setStatus('', false);
      return true;
    }).catch(function (error) {
      setStatus(error.message || 'Could not open that destination.', true);
      return false;
    });
  }

  function openTeamsApp() {
    setStatus('Opening Microsoft Teams…', false);
    return fetch('/meeting-action/teams/focus', { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('Teams action failed.');
      return response.json();
    }).then(function (result) {
      if (!result || !result.ok) throw new Error((result && result.error) || 'Microsoft Teams could not be opened.');
      setStatus('', false);
      return true;
    }).catch(function () {
      return openExternal(TEAMS_URLS.teams);
    });
  }

  function handleAction(action) {
    if (action === 'teams') return openTeamsApp();
    return openExternal(TEAMS_URLS[action] || TEAMS_URLS.office);
  }

  function runOfficeAction(kind, index, shortcutIndex, target) {
    setStatus(kind === 'app' ? 'Opening Office app…' : kind === 'meeting' ? 'Opening meeting…' : 'Sending keyboard shortcut…', false);
    var path = kind === 'meeting'
      ? '/api/office/action/meeting?url=' + encodeURIComponent(target || '')
      : '/api/office/action/' + kind + '/' + index;
    if (kind === 'shortcut') path += '/' + shortcutIndex;
    return fetch(path, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('Office action failed.');
      return response.json();
    }).then(function (result) {
      if (!result || !result.ok) throw new Error((result && result.error) || 'Office action failed.');
      setStatus('', false);
      return true;
    }).catch(function (error) {
      setStatus(error.message || 'Office action failed.', true);
      return false;
    });
  }

  function shortcutCount(value) {
    var count = Number(value);
    return Number.isInteger(count) && count >= 4 && count <= 8 ? count : 4;
  }

  function shortcutDefault(defaults, index) {
    return defaults[index] || { label: 'Shortcut ' + (index + 1), keys: '', icon: '⌨' };
  }

  function renderConfiguredControls(options) {
    officeOptions = options || {};
    document.querySelectorAll('[data-app-index]').forEach(function (button) {
      var index = Number(button.getAttribute('data-app-index'));
      var appId = APP_PRESENTATION[officeOptions['app' + (index + 1)]] ? officeOptions['app' + (index + 1)] : DEFAULT_APPS[index];
      var app = APP_PRESENTATION[appId];
      var mode = officeOptions['mode' + (index + 1)] || 'prefer-desktop';
      var iconHtml = '<img src="/office-icons/' + encodeURIComponent(appId) + '.svg" alt="">';
      button.className = 'header-action office-app-control ' + app.className + (index === selectedAppIndex ? ' selected' : '');
      button.innerHTML = '<span class="office-app-mark" aria-hidden="true">' + iconHtml + '</span>'
        + '<span class="app-nav-copy"><strong>' + escapeHtml(app.name) + '</strong><small>' + escapeHtml(mode === 'web' ? 'Web' : mode === 'desktop' ? 'Desktop' : 'Desktop / web') + '</small></span>';
    });
    var appNumber = selectedAppIndex + 1;
    var selectedAppId = APP_PRESENTATION[officeOptions['app' + appNumber]] ? officeOptions['app' + appNumber] : DEFAULT_APPS[selectedAppIndex];
    var defaults = DEFAULT_SHORTCUTS_BY_APP[selectedAppId] || DEFAULT_SHORTCUTS_BY_APP.office;
    var count = shortcutCount(officeOptions['app' + appNumber + 'ShortcutCount']);
    document.querySelector('.control-deck').style.setProperty('--shortcut-count', count);
    document.querySelectorAll('[data-shortcut-index]').forEach(function (button) {
      var index = Number(button.getAttribute('data-shortcut-index'));
      var fallback = shortcutDefault(defaults, index);
      var prefix = 'app' + appNumber + 'Shortcut' + (index + 1);
      var label = String(officeOptions[prefix + 'Label'] || fallback.label);
      var keys = String(officeOptions[prefix + 'Keys'] == null ? fallback.keys : officeOptions[prefix + 'Keys']);
      var icon = String(officeOptions[prefix + 'Icon'] || fallback.icon);
      var iconImage = String(officeOptions[prefix + 'IconImageSrc'] || '');
      var glyph = button.querySelector('.shortcut-glyph');
      button.hidden = index >= count;
      glyph.replaceChildren();
      if (/^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|svg\+xml);base64,/i.test(iconImage)) {
        var image = document.createElement('img');
        image.src = iconImage;
        image.alt = '';
        glyph.appendChild(image);
      } else {
        glyph.textContent = icon || '⌨';
      }
      button.querySelector('strong').textContent = label || 'Shortcut ' + (index + 1);
      button.querySelector('small').textContent = keys || 'Not configured';
      button.disabled = !keys;
      button.setAttribute('aria-label', label + (keys ? ', ' + keys : ', not configured'));
    });
  }

  function selectOfficeApp(index) {
    selectedAppIndex = Math.max(0, Math.min(3, Number(index) || 0));
    renderConfiguredControls(officeOptions);
    return runOfficeAction('app', selectedAppIndex);
  }

  function loadOfficeConfig() {
    return fetch('/app-config?app=office', { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('Office configuration unavailable.');
      return response.json();
    }).then(function (config) {
      renderConfiguredControls(config && config.options);
    }).catch(function () {
      renderConfiguredControls({});
    });
  }

  function choosePrimary(events) {
    var now = Date.now();
    var candidates = (events || []).filter(function (event) {
      if (!event || event.isCancelled) return false;
      var start = new Date(event.start).getTime();
      var end = new Date(event.end).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end > now;
    }).sort(function (a, b) {
      return new Date(a.start).getTime() - new Date(b.start).getTime();
    });
    return candidates[0] || null;
  }

  function renderPrimary(event) {
    var actionButton = $('primaryActionBtn');
    var actionLabel = $('primaryActionLabel');
    actionButton.disabled = false;

    if (!event) {
      $('focusLabel').textContent = 'Next meeting';
      $('primaryTime').textContent = '—';
      $('primaryTitle').textContent = 'Calendar clear';
      $('primaryMeta').textContent = 'No more meetings in the current calendar window.';
      actionLabel.textContent = 'Open calendar';
      actionButton.onclick = function () { handleAction('calendar'); };
      return;
    }

    var now = Date.now();
    var start = new Date(event.start).getTime();
    var end = new Date(event.end).getTime();
    var current = start <= now && end > now;
    $('focusLabel').textContent = current ? 'Current meeting' : 'Next meeting';
    $('primaryTime').textContent = formatTime(event.start);
    $('primaryTitle').textContent = event.subject || '(untitled)';

    var meta = [
      relativeStart(event, now),
      Calendar.durationLabel(event.start, event.end),
      meetingSource(event),
    ].filter(Boolean);
    $('primaryMeta').textContent = meta.join(' · ');

    var url = event.joinUrl || event.webLink || TEAMS_URLS.calendar;
    actionLabel.textContent = event.joinUrl ? 'Join meeting' : (event.webLink ? 'Open meeting' : 'Open calendar');
    actionButton.onclick = function () {
      return event.joinUrl ? runOfficeAction('meeting', null, null, event.joinUrl) : openExternal(url);
    };
  }

  function renderAgenda(events, primary) {
    var remaining = (events || []).filter(function (event) { return event !== primary; }).slice(0, 3);
    var groups = Calendar.groupEvents(remaining, new Date());
    if (!groups.length) {
      $('events').innerHTML = '<div class="empty-state">No other upcoming events</div>';
      return;
    }

    var html = '';
    groups.forEach(function (group) {
      html += '<section class="agenda-group"><div class="agenda-date">' + escapeHtml(group.label) + '</div>';
      group.events.forEach(function (event) {
        var secondary = [Calendar.durationLabel(event.start, event.end), event.isOnlineMeeting ? 'Teams' : (event.location || 'Calendar')].filter(Boolean).join(' · ');
        html += '<div class="event"><time datetime="' + escapeHtml(event.start) + '">' + escapeHtml(formatTime(event.start)) + '</time>'
          + '<div class="event-title">' + escapeHtml(event.subject || '(untitled)') + '</div>'
          + '<div class="event-meta">' + escapeHtml(secondary) + '</div></div>';
      });
      html += '</section>';
    });
    $('events').innerHTML = html;
  }

  function renderCalendarError() {
    $('focusLabel').textContent = 'Next meeting';
    $('primaryTime').textContent = '—';
    $('primaryTitle').textContent = 'Calendar unavailable';
    $('primaryMeta').textContent = 'Your schedule could not be loaded.';
    $('events').innerHTML = '<div class="empty-state">Unable to load agenda</div>';
    $('primaryActionLabel').textContent = 'Open Microsoft 365';
    $('primaryActionBtn').disabled = false;
    $('primaryActionBtn').onclick = function () { openExternal(TEAMS_URLS.office); };
  }

  function showAuth(message) {
    $('auth').classList.remove('hidden');
    $('authMsg').textContent = message || '';
  }

  function hideAuth() {
    $('auth').classList.add('hidden');
  }

  function applyState(data) {
    if (!data || !data.ok) {
      setStatus('Microsoft connection needed.', true);
      renderCalendarError();
      showAuth(data && data.error ? data.error : 'Connect Microsoft 365 to show your schedule.');
      return;
    }

    hideAuth();
    var profile = data.profile || {};
    $('name').textContent = profile.displayName || profile.userPrincipalName || 'Office';
    $('avatar').textContent = initials(profile);
    renderPresence(data.presence || null);

    var events = Array.isArray(data.events) ? data.events : [];
    var primary = choosePrimary(events);
    renderPrimary(primary);
    renderAgenda(events, primary);
    setStatus('', false);
  }

  function loadOffice() {
    if (officeLoad) return officeLoad;
    officeLoad = officeFetch('/api/office/data').then(applyState).catch(function (error) {
      setStatus(error.message || 'Could not reach the Open-Quake Office service.', true);
      renderCalendarError();
    }).finally(function () {
      officeLoad = null;
    });
    return officeLoad;
  }

  document.querySelectorAll('[data-action]').forEach(function (button) {
    button.addEventListener('click', function () { handleAction(button.getAttribute('data-action')); });
  });
  document.querySelectorAll('[data-app-index]').forEach(function (button) {
    button.addEventListener('click', function () { selectOfficeApp(Number(button.getAttribute('data-app-index'))); });
  });
  document.querySelectorAll('[data-shortcut-index]').forEach(function (button) {
    button.addEventListener('click', function () { runOfficeAction('shortcut', selectedAppIndex, Number(button.getAttribute('data-shortcut-index'))); });
  });

  $('connect').addEventListener('click', function () {
    var button = $('connect');
    button.disabled = true;
    $('authMsg').textContent = 'Opening Microsoft sign-in…';
    officeFetch('/api/office/connect').then(function (result) {
      $('authMsg').textContent = result && result.ok
        ? 'Finish sign-in in the browser; this deck will refresh automatically.'
        : ((result && result.error) || 'Could not start sign-in.');
      setTimeout(loadOffice, 3000);
    }).catch(function () {
      $('authMsg').textContent = 'Could not start sign-in.';
    }).finally(function () {
      button.disabled = false;
    });
  });

  loadOfficeConfig();
  loadOffice();
  setInterval(loadOffice, 60000);
})();
