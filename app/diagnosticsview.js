'use strict';
// diagnosticsview.js — Device Diagnostics served app. Polls /device-diagnostics (main computes the
// snapshot from HID enumeration + attached displays) and renders the three console channels:
// Display / Touchscreen / Knob. Works identically for DK-QUAKE and bedrock-console, with or without
// a knob. Script-src is 'self' (no inline script), so this is a separate file.

var $ = function (id) { return document.getElementById(id); };

// theme: the host passes _dark=1/0 and _accent=#hex (themeParams), same as the other panel pages.
(function () {
  try {
    var Q = new URLSearchParams(location.search);
    document.body.classList.toggle('light', Q.get('_dark') === '0');
    var a = Q.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
  } catch (e) {}
})();

// Tabler-style inline SVGs (stroke set to currentColor via fill). Simple, legible at 40px.
var ICON = {
  display: '<svg viewBox="0 0 24 24"><path d="M3 5h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v8h16V7H4zm5 11h6v2H9v-2z"/></svg>',
  touch:   '<svg viewBox="0 0 24 24"><path d="M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-2.18 2-3.74a4 4 0 1 0-8 0c0 1.56.79 2.93 2 3.74zM18.84 15.87l-4.54-2.26c-.17-.07-.35-.11-.54-.11H13v-6a1.5 1.5 0 0 0-3 0v10.94l-3.54-.74a1 1 0 0 0-.96.27l-.75.76 4.7 4.7c.27.27.65.43 1.05.43h6.32c.75 0 1.38-.56 1.49-1.3l.75-5.23c.1-.68-.27-1.35-.9-1.63z"/></svg>',
  knob:    '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 2a1 1 0 0 1 1 1v4a1 1 0 0 1-2 0V8a1 1 0 0 1 1-1z"/></svg>',
  check:   '<svg viewBox="0 0 24 24"><path d="M9.5 17.5 4 12l1.5-1.5 4 4 9-9L20 11z"/></svg>',
  cross:   '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6l6.3-6.3z"/></svg>',
  dash:    '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>',
};
var STATUS_WORD = { ok: 'Connected', fail: 'Not detected', note: 'Not detected' };
var STATUS_ICON = { ok: 'check', fail: 'cross', note: 'dash' };
var CHANNEL_ICON = { display: 'display', touch: 'touch', knob: 'knob' };
var CHANNEL_ORDER = ['display', 'touch', 'knob'];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function render(d) {
  d = d || {};
  var channels = d.channels || {};
  var mode = d.mode || 'software';

  // header: which console, firmware, run-mode note
  var dName = $('dName'), dSub = $('dSub');
  if (mode === 'software') {
    // Nothing (or nothing console-shaped) is plugged in — not an error, just not on a device.
    dName.textContent = 'No console detected';
    dSub.textContent = d.runMode === 'software' ? 'Running in software mode' : 'Nothing plugged in';
  } else if (d.deviceLabel) {
    dName.textContent = d.deviceLabel;
    dSub.textContent = d.firmware ? ('Firmware ' + d.firmware) : 'Firmware —';
  } else {
    // A console IS present (display/touch) but no knob HID to name it as DK-QUAKE vs Bedrock.
    dName.textContent = 'Console detected';
    dSub.textContent = 'Knob not connected';
  }

  // health pill
  var health = $('health'), healthText = $('healthText');
  health.className = '';
  if (mode === 'software') { health.classList.add('soft'); healthText.textContent = 'Software mode'; }
  else if (d.healthy) { health.classList.add('ok'); healthText.textContent = 'All systems go'; }
  else { health.classList.add('bad'); healthText.textContent = 'Needs attention'; }

  // three channel rows, worst auto-expanded
  var rows = $('rows');
  rows.innerHTML = CHANNEL_ORDER.map(function (key) {
    var c = channels[key] || { key: key, label: key, level: 'note', detail: '' };
    var level = c.level || 'note';
    // in software mode a plain "not detected" reads calmer than an alarming note
    var cls = (mode === 'software' && level !== 'ok') ? 'soft' : level;
    var expand = (d.expand === key) ? ' expand' : '';
    return '<div class="row ' + cls + expand + '">'
      + '<div class="badge"><span class="ic">' + ICON[CHANNEL_ICON[key]] + '</span></div>'
      + '<div class="body"><div class="rname">' + esc(c.label) + '</div>'
      + '<div class="rdetail">' + esc(c.detail) + '</div></div>'
      + '<div class="status"><span>' + (cls === 'soft' ? '—' : STATUS_WORD[level]) + '</span>'
      + '<span class="ic sic">' + ICON[STATUS_ICON[level]] + '</span></div>'
      + '</div>';
  }).join('');
}

var pollTimer = null;
function poll() {
  fetch('/device-diagnostics', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) { render(d); $('foot').textContent = ''; })
    .catch(function () { $('foot').textContent = 'Could not reach the panel server — retrying…'; });
}
poll();
pollTimer = setInterval(poll, 2000);
