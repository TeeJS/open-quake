function $(id) { return document.getElementById(id); }

// theme — host passes _dark=1/0 and _accent=#hex via the served query, same as every other app page.
(function () {
  try {
    var q = new URLSearchParams(location.search);
    document.body.classList.toggle('light', q.get('_dark') === '0');
    var a = q.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
  } catch (e) {}
})();

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function emptyRow(msg) { return '<div class="empty">' + esc(msg) + '</div>'; }
function row(key, desc, sub) {
  return '<div class="srow"><div class="key">' + esc(key) + '</div><div class="desc">' + esc(desc)
    + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</div></div>';
}

// One flat list, combined from every source — no separate sections. Order: the rotation toggle,
// per-page jump shortcuts, each app's own hotkeys (LucidType, slide capture, …), then the custom rows.
function render(data) {
  data = data || {};
  var rows = [];
  if (data.rotation && data.rotation.hotkey) rows.push(row(data.rotation.hotkey, 'Start/stop auto-rotation'));
  (Array.isArray(data.pages) ? data.pages : []).forEach(function (p) {
    rows.push(row(p.shortcut, p.name || p.id, p.stopsRotation ? 'Also stops rotation' : ''));
  });
  (Array.isArray(data.apps) ? data.apps : []).forEach(function (a) {
    rows.push(row(a.shortcut, a.action, a.app));
  });
  (Array.isArray(data.custom) ? data.custom : []).forEach(function (c) {
    rows.push(row(c.shortcut, c.description));
  });
  $('list').innerHTML = rows.length ? rows.join('')
    : emptyRow('No shortcuts yet — add a rotation/page hotkey, or a custom row on this app’s page in the editor.');
}

function load() {
  fetch('/shortcuts', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () {});
}

load();
setInterval(load, 4000);
