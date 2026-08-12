(function () {
  var capability = '';
  var officeLoad = null;
  var lastState = null;

  try {
    var q = new URLSearchParams(location.search);
    document.body.classList.toggle('light', q.get('_dark') === '0');
    var a = q.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
  } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function status(text, bad) {
    var st = $('status');
    st.textContent = text || '';
    st.classList.toggle('bad', !!bad);
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
      headers: { Authorization: 'Bearer ' + capability }
    }).then(function (r) {
      rememberCapability(r.headers.get('X-Open-Quake-Capability'));
      if (!r.ok) throw new Error(r.status === 403 ? 'Office session authorization expired.' : 'Office service failed (HTTP ' + r.status + ').');
      return r.json();
    });
  }
  function fmtTime(value) {
    if (!value) return '';
    try {
      var d = new Date(value);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'Now';
    var totalMin = Math.max(1, Math.round(ms / 60000));
    if (totalMin < 60) return 'in ' + totalMin + ' min';
    var hours = Math.floor(totalMin / 60);
    var mins = totalMin % 60;
    return 'in ' + hours + 'h ' + mins + 'm';
  }
  function fmtRange(startIso, endIso) {
    if (!startIso || !endIso) return '';
    var start = new Date(startIso);
    var end = new Date(endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
    return fmtTime(startIso) + ' – ' + fmtTime(endIso);
  }
  function getPresenceState(value) {
    var v = String(value || '').toLowerCase();
    if (v.indexOf('inacall') >= 0 || v.indexOf('in a call') >= 0) return { className: 'call', label: 'In a call' };
    if (v.indexOf('inameeting') >= 0 || v.indexOf('in a meeting') >= 0) return { className: 'meeting', label: 'In a meeting' };
    if (v.indexOf('donotdisturb') >= 0 || v.indexOf('do not disturb') >= 0) return { className: 'dnd', label: 'Do not disturb' };
    if (v.indexOf('busy') >= 0) return { className: 'busy', label: 'Busy' };
    if (v.indexOf('away') >= 0) return { className: 'away', label: 'Away' };
    if (v.indexOf('offline') >= 0) return { className: 'offline', label: 'Offline' };
    if (v.indexOf('available') >= 0) return { className: 'available', label: 'Available' };
    return { className: '', label: 'Unknown' };
  }
  function getCurrentPresence(presence) {
    if (!presence) return { className: 'available', label: 'Available' };
    var availability = presence.availability || presence.activity || '';
    return getPresenceState(availability);
  }
  function getMeetingState(events) {
    var now = Date.now();
    var upcoming = [];
    for (var i = 0; i < (events || []).length; i++) {
      var ev = events[i];
      if (!ev || ev.isCancelled) continue;
      var startMs = ev.start ? new Date(ev.start).getTime() : null;
      var endMs = ev.end ? new Date(ev.end).getTime() : null;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      upcoming.push({ event: ev, startMs: startMs, endMs: endMs });
    }
    upcoming.sort(function (a, b) { return a.startMs - b.startMs; });
    var current = null;
    var next = null;
    for (var j = 0; j < upcoming.length; j++) {
      var candidate = upcoming[j];
      if (candidate.startMs <= now && candidate.endMs > now) {
        current = candidate.event;
        break;
      }
      if (!next && candidate.startMs > now) {
        next = candidate.event;
      }
    }
    if (!current && !next) return { current: null, next: null, activeWindow: null };
    return { current: current || next, next: next || current, activeWindow: current ? 'current' : 'next' };
  }
  function openAction(url) {
    if (!url) return;
    try {
      var win = window.open(url, '_blank', 'noopener,noreferrer');
      if (win) win.opener = null;
    } catch (e) {}
  }
  function getPrimaryAction(event) {
    if (!event) return { label: 'Open Microsoft 365', url: 'https://www.office.com' };
    if (event.joinUrl) return { label: 'Join Teams meeting', url: event.joinUrl };
    if (event.webLink) return { label: 'Open meeting', url: event.webLink };
    return { label: 'Open calendar', url: 'https://outlook.office.com/calendar' };
  }
  function renderPresence(presence) {
    var state = getCurrentPresence(presence);
    var el = $('presence');
    el.textContent = state.label;
    el.className = 'presence ' + state.className;
  }
  function renderPrimary(event, presence) {
    var focusState = getMeetingState(lastState && lastState.events ? lastState.events : []);
    if (!event) {
      $('focusLabel').textContent = 'Now';
      $('primaryEvent').innerHTML = '<div class="title">No more meetings today</div><div class="meta">Your calendar is clear for the rest of the day.</div>';
      $('primaryActionBtn').textContent = 'Open Microsoft 365';
      $('primaryActionBtn').onclick = function () { openAction('https://www.office.com'); };
      return;
    }

    var now = Date.now();
    var startMs = new Date(event.start).getTime();
    var endMs = new Date(event.end).getTime();
    var isCurrent = startMs <= now && endMs > now;
    var minutesUntil = Math.max(0, Math.round((startMs - now) / 60000));
    var timeLabel = isCurrent ? 'In progress' : (minutesUntil <= 30 ? 'Meeting in ' + minutesUntil + ' min' : 'Next up');
    var focusLabel = isCurrent ? 'Now' : (minutesUntil <= 10 ? 'Meeting soon' : 'Next');
    $('focusLabel').textContent = focusLabel;
    $('primaryEvent').innerHTML = '<div class="time">' + esc(timeLabel) + '</div>' +
      '<div class="title">' + esc(event.subject || '(untitled)') + '</div>' +
      '<div class="meta">' + esc(fmtRange(event.start, event.end)) + (event.location ? ' · ' + esc(event.location) : '') + '</div>';
    var action = getPrimaryAction(event);
    $('primaryActionBtn').textContent = action.label;
    $('primaryActionBtn').onclick = function () { openAction(action.url); };
    if (presence && String(presence.availability || presence.activity || '').toLowerCase().indexOf('inacall') >= 0) {
      $('primaryEvent').innerHTML = '<div class="time">In a call</div><div class="title">' + esc(event.subject || '(untitled)') + '</div><div class="meta">' + esc(fmtRange(event.start, event.end)) + (event.location ? ' · ' + esc(event.location) : '') + '</div>';
    }
  }
  function renderAgenda(items) {
    items = items || [];
    var html = '';
    var shown = 0;
    for (var i = 0; i < items.length && shown < 4; i++) {
      var ev = items[i];
      if (!ev || ev.isCancelled) continue;
      var start = ev.start ? fmtTime(ev.start) : '';
      var where = ev.location || '';
      html += '<div class="event"><div class="time">' + esc(start) + '</div><div><div class="title">' + esc(ev.subject || '(untitled)') + '</div><div class="meta">' + esc(where || (ev.isOnlineMeeting ? 'Teams meeting' : 'Calendar')) + '</div></div></div>';
      shown += 1;
    }
    if (!html) html = '<div class="empty-state">No more meetings today</div>';
    $('events').innerHTML = html;
  }
  function renderEventError() {
    $('focusLabel').textContent = 'Now';
    $('primaryEvent').innerHTML = '<div class="title">Calendar unavailable</div><div class="meta">Your schedule could not be loaded.</div>';
    $('events').innerHTML = '<div class="empty-state">Unable to load agenda</div>';
    $('primaryActionBtn').textContent = 'Open Microsoft 365';
    $('primaryActionBtn').onclick = function () { openAction('https://www.office.com'); };
  }
  function showAuth(message) {
    $('auth').classList.remove('hidden');
    $('authMsg').textContent = message || '';
  }
  function hideAuth() {
    $('auth').classList.add('hidden');
  }
  function renderGrid(d) {
    var host = $('grid'), cols = d.cols || 2, rows = d.rows || 2, n = cols * rows, tiles = d.tiles || [];
    host.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)';
    host.style.gridTemplateRows = 'repeat(' + rows + ',1fr)';
    var html = '';
    for (var i = 0; i < n; i++) {
      var t = tiles[i];
      if (t && t.type && t.cover == null) {
        var ic = t.iconSrc ? '<div class="ic"><img src="' + esc(t.iconSrc) + '"></div>' : '<div class="ic">' + esc(t.icon || '□') + '</div>';
        html += '<div class="tile" data-i="' + i + '">' + ic + '<div class="lb">' + esc(t.label || '') + '</div></div>';
      } else {
        html += '<div class="tile empty"></div>';
      }
    }
    host.innerHTML = html;
    host.querySelectorAll('.tile[data-i]').forEach(function (el) {
      el.onclick = function () { fetch('/launch?i=' + el.getAttribute('data-i'), { cache: 'no-store' }).catch(function () {}); };
    });
  }
  function pollGrid() {
    fetch('/grid-tiles', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(renderGrid).catch(function () {});
  }
  function handleAction(action) {
    if (action === 'teams') openAction('https://teams.microsoft.com');
    else if (action === 'chat') openAction('https://teams.microsoft.com/l/chat/0/0');
    else if (action === 'activity') openAction('https://www.office.com/');
    else if (action === 'calendar') openAction('https://outlook.office.com/calendar');
    else if (action === 'meet') openAction('https://teams.microsoft.com/l/meetup-join');
    else if (action === 'outlook') openAction('https://outlook.office.com');
    else openAction('https://www.office.com');
  }
  function bindActionButtons() {
    document.querySelectorAll('.mini-action, .shortcut-item').forEach(function (button) {
      button.onclick = function () {
        handleAction(button.getAttribute('data-action'));
      };
    });

    var drawerToggle = $('drawerToggle');
    var drawerClose = $('drawerClose');
    if (drawerToggle) {
      drawerToggle.onclick = function () {
        var wrap = document.getElementById('wrap');
        var open = wrap.classList.toggle('drawer-open');
        drawerToggle.setAttribute('aria-expanded', String(open));
      };
    }
    if (drawerClose) {
      drawerClose.onclick = function () {
        var wrap = document.getElementById('wrap');
        wrap.classList.remove('drawer-open');
        if (drawerToggle) drawerToggle.setAttribute('aria-expanded', 'false');
      };
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        var wrap = document.getElementById('wrap');
        wrap.classList.remove('drawer-open');
        if (drawerToggle) drawerToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }
  function applyState(data) {
    if (!data || !data.ok) {
      status('Microsoft connection needed.', true);
      renderEventError();
      showAuth(data && data.error ? data.error : '');
      return;
    }
    hideAuth();
    var me = data.profile || {};
    var presence = data.presence || {};
    $('name').textContent = me.displayName || me.userPrincipalName || 'Office';
    renderPresence(presence);
    var events = Array.isArray(data.events) ? data.events : [];
    var next = null;
    var now = Date.now();
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev || ev.isCancelled) continue;
      var startMs = ev.start ? new Date(ev.start).getTime() : null;
      var endMs = ev.end ? new Date(ev.end).getTime() : null;
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= now && endMs > now) {
        next = ev;
        break;
      }
      if (!next && Number.isFinite(startMs) && startMs > now) next = ev;
    }
    if (!next) {
      renderPrimary(null, presence);
      renderAgenda(events);
      status('');
      lastState = { events: events || [] };
      return;
    }
    renderPrimary(next, presence);
    renderAgenda(events.filter(function (ev) { return ev && ev.id !== next.id; }));
    status('');
    lastState = { events: events || [] };
  }
  function loadOffice() {
    if (officeLoad) return officeLoad;
    officeLoad = officeFetch('/api/office/data').then(function (data) {
      applyState(data);
    }).catch(function (e) {
      status(e.message || 'Could not reach the Open-Quake Office service.', true);
      renderEventError();
    }).finally(function () {
      officeLoad = null;
    });
    return officeLoad;
  }
  $('connect').onclick = function () {
    $('connect').disabled = true;
    $('authMsg').textContent = 'Opening Microsoft sign-in...';
    officeFetch('/api/office/connect').then(function (r) {
      $('authMsg').textContent = r && r.ok ? 'Finish sign-in in the browser, then this deck will refresh.' : ((r && r.error) || 'Could not start sign-in.');
      setTimeout(loadOffice, 3000);
    }).catch(function () {
      $('authMsg').textContent = 'Could not start sign-in.';
    }).finally(function () {
      $('connect').disabled = false;
    });
  };
  bindActionButtons();
  pollGrid();
  loadOffice();
  setInterval(loadOffice, 60000);
  setInterval(pollGrid, 3000);
})();
