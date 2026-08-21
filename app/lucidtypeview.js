function $(id) { return document.getElementById(id); }

// theme — host passes _dark=1/0, _accent=#hex on the page URL (same as meetingview.js).
var Q = new URLSearchParams(location.search);
(function () {
  try {
    document.body.classList.toggle('light', Q.get('_dark') === '0');
    var a = Q.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
    var hex = /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#7CFFB2';
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.style.setProperty('--accent-fg', lum > 0.45 ? '#04121f' : '#f2f7fc');
  } catch (e) {}
})();

var text = $('text');
var lastSeq = -1, userDirty = false, dictating = false, editTimer = null, wasReviewActive = false;

function get(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; }); }

// Push the current textarea to the host so the global Apply hotkey pastes the edited text.
function flushEdit() {
  return fetch('/lucidtype-edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ text: text.value })
  }).catch(function () {});
}

text.addEventListener('input', function () {
  userDirty = true;
  clearTimeout(editTimer);
  editTimer = setTimeout(flushEdit, 250);
});

// Start Dictating (fresh) / Stop; Append Text starts dictation WITHOUT clearing the box.
$('btnDictate').addEventListener('click', function () { get(dictating ? '/lucidtype-dictation/stop' : '/lucidtype-dictation/start?mode=clear').then(pollState); });
$('btnAppend').addEventListener('click', function () { if (!dictating) get('/lucidtype-dictation/start?mode=append').then(pollState); });

// Clear Text (header) — wipe the box and sync the empty transcript to the host.
$('btnClear').addEventListener('click', function () {
  text.value = '';
  userDirty = true;          // don't let a poll/SSE frame repopulate it
  flushEdit();
});

// Settings button -> overlay (like the voice apps); Done closes it. Mode is Phase 2 (no-op for now).
var settingsOvl = $('ltSettingsOverlay');
var curMic = '';   // latest mic label from state, so the picker opens on the current selection
$('btnSettings').addEventListener('click', function () { settingsOvl.classList.remove('hidden'); fillMicPicker(); });
$('btnSettingsClose').addEventListener('click', function () { settingsOvl.classList.add('hidden'); });
settingsOvl.addEventListener('click', function (e) { if (e.target === settingsOvl) settingsOvl.classList.add('hidden'); });

// Populate the overlay mic picker with device labels (lazy grant to reveal labels, like the editor).
// Picking one persists it via /lucidtype-set-mic and applies on the next dictation start.
function fillMicPicker() {
  var sel = $('ltOvlMic');
  function fill(devs) {
    var inputs = (devs || []).filter(function (d) { return d.kind === 'audioinput' && d.label; });
    sel.innerHTML = '<option value="">System default</option>';
    inputs.forEach(function (d) { var o = document.createElement('option'); o.value = d.label; o.textContent = d.label; sel.appendChild(o); });
    if (curMic && !inputs.some(function (d) { return d.label === curMic; })) { var o = document.createElement('option'); o.value = curMic; o.textContent = curMic + ' (not connected)'; sel.appendChild(o); }
    sel.value = curMic;
  }
  navigator.mediaDevices.enumerateDevices().then(function (devs) {
    if ((devs || []).some(function (d) { return d.kind === 'audioinput' && d.label; })) return fill(devs);
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (tmp) { navigator.mediaDevices.enumerateDevices().then(function (d2) { tmp.getTracks().forEach(function (t) { t.stop(); }); fill(d2); }); })
      .catch(function () { fill(devs); });
  }).catch(function () { fill([]); });
}
$('ltOvlMic').addEventListener('change', function (e) { curMic = e.target.value; get('/lucidtype-set-mic/' + encodeURIComponent(e.target.value)); });

// ---- Cleanup / Rewrite (Phase 2) ----
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function postText(url, t) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ text: t }) }).then(function (r) { return r.json(); }).catch(function () { return null; }); }

// word-level LCS diff — marks words the proposal REMOVED from the original (struck red in the Original pane).
function wordDiff(orig, prop) {
  var a = String(orig || '').split(/(\s+)/), b = String(prop || '').split(/(\s+)/);
  var n = a.length, m = b.length, i, j;
  var dp = []; for (i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
  for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  var out = ''; i = 0; j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out += esc(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out += '<span class="del">' + esc(a[i]) + '</span>'; i++; }
    else { j++; }
  }
  while (i < n) { out += '<span class="del">' + esc(a[i]) + '</span>'; i++; }
  return out;
}

var reviewOvl = $('ltReviewOverlay'), modeOvl = $('ltModeOverlay'), revProp = $('revProp');
var propDirty = false, lastRevStatus = '', showOrig = false, rewriteMode = 'professional', lastReview = { active: false };

$('btnCleanup').addEventListener('click', function () { get('/lucidtype-cleanup'); });
$('btnRewrite').addEventListener('click', function () { get('/lucidtype-rewrite'); });
function openModePicker() { renderModePicker(); modeOvl.classList.remove('hidden'); }
$('btnMode').addEventListener('click', openModePicker);
$('modeText').addEventListener('click', openModePicker);   // the plain mode text is also a picker opener
modeOvl.addEventListener('click', function (e) { if (e.target === modeOvl) modeOvl.classList.add('hidden'); });
Array.prototype.forEach.call(modeOvl.querySelectorAll('.moderow'), function (row) {
  row.addEventListener('click', function () { get('/lucidtype-set-mode/' + encodeURIComponent(row.getAttribute('data-mode'))); modeOvl.classList.add('hidden'); });
});
function renderModePicker() {
  Array.prototype.forEach.call(modeOvl.querySelectorAll('.moderow'), function (row) { row.classList.toggle('on', row.getAttribute('data-mode') === rewriteMode); });
}

revProp.addEventListener('input', function () { propDirty = true; });
$('revApply').addEventListener('click', function () { postText('/lucidtype-review/apply', revProp.value); });
$('revRefine').addEventListener('click', function () { propDirty = false; postText('/lucidtype-review/refine', revProp.value); });
$('revCancel').addEventListener('click', function () { get('/lucidtype-review/cancel'); });
function scrollBoth(dy) { $('revOrig').scrollTop += dy; revProp.scrollTop += dy; }
$('revUp').addEventListener('click', function () { scrollBoth(-80); });
$('revDown').addEventListener('click', function () { scrollBoth(80); });

// Header "Show Original" — flip between the review overlay and the plain original text in the box.
$('btnShowOrig').addEventListener('click', function () { showOrig = !showOrig; renderReview(lastReview); });

function renderReview(rev) {
  lastReview = rev || { active: false };
  var active = !!(rev && rev.active);
  $('btnShowOrig').style.display = active ? '' : 'none';
  if (!active) { reviewOvl.classList.add('hidden'); showOrig = false; propDirty = false; lastRevStatus = ''; $('btnShowOrig').textContent = 'Show Original'; return; }
  $('btnShowOrig').textContent = showOrig ? 'Show Review' : 'Show Original';
  reviewOvl.classList.toggle('hidden', showOrig);            // peeking at the original hides the overlay
  $('revTitle').textContent = rev.kind === 'rewrite' ? 'Review — Rewrite (' + cap(rev.mode || rewriteMode) + ')' : 'Review — Cleanup';
  var working = rev.status === 'working', err = rev.status === 'error';
  $('revApply').disabled = working || err;
  $('revRefine').disabled = working;
  revProp.disabled = working;
  if (working) { $('revOrig').innerHTML = esc(rev.original); if (!propDirty) revProp.value = 'Working…'; }
  else if (err) { $('revOrig').innerHTML = esc(rev.original); revProp.value = 'Error: ' + (rev.error || 'failed'); }
  else { $('revOrig').innerHTML = wordDiff(rev.original, rev.proposed); if (lastRevStatus !== 'ready' && !propDirty) revProp.value = rev.proposed || ''; }
  lastRevStatus = rev.status;
}

function applyState(st) {
  if (!st) return;
  var wasDictating = dictating;
  dictating = !!st.dictating;
  document.body.classList.toggle('dictating', dictating);
  if (dictating && !wasDictating) userDirty = false;   // a fresh session owns the box again

  // A Cleanup/Rewrite review just closed (Apply landed the proposal in the host transcript). That is
  // an authoritative change to the box — adopt it even though typing/pasting set userDirty, which
  // otherwise blocks host updates. (Dictating also owns the box; a plain edit does not.)
  var reviewActive = !!(st.review && st.review.active);
  var reviewJustClosed = wasReviewActive && !reviewActive;
  wasReviewActive = reviewActive;

  // Adopt the host transcript on any new sequence, unless the user is mid-edit (and not dictating).
  if (typeof st.seq === 'number' && st.seq !== lastSeq) {
    if (dictating || !userDirty || reviewJustClosed) {
      text.value = st.transcript || '';
      if (reviewJustClosed) userDirty = false;   // the applied result is now the box's clean baseline
    }
    lastSeq = st.seq;
  }

  curMic = st.mic || '';   // remember for the settings picker's current selection
  rewriteMode = st.rewriteMode || 'professional';
  $('modeText').textContent = cap(rewriteMode);
  renderReview(st.review);
  var bd = $('btnDictate');
  bd.textContent = dictating ? 'Stop Dictating' : 'Start Dictating';
  bd.classList.toggle('rec', dictating);
  $('btnAppend').disabled = dictating;   // append only makes sense when idle
  // (no "Listening…"/"Thinking…" header text — the DICTATING indicator + review overlay convey state)
}

function pollState() { return get('/lucidtype-state').then(applyState); }

pollState();   // immediate load

// Real-time updates over SSE — main pushes on every dictation change, so text appears the instant
// Whisper returns (no poll lag). The poll is now only a fallback: it fires when the stream isn't
// open (initial connect gap or a dropped connection), tightened to 400ms so recovery is quick.
var es = null;
try {
  es = new EventSource('/lucidtype-events');
  es.onmessage = function (e) { try { applyState(JSON.parse(e.data)); } catch (_) {} };
  es.onerror = function () { /* EventSource auto-reconnects; the fallback poll covers the gap */ };
} catch (e) { es = null; }
setInterval(function () { if (!es || es.readyState !== 1) pollState(); }, 400);
