function $(id) { return document.getElementById(id); }

// Theme — read directly from the served query (musicview.js's pattern, not chatview.html's broken
// hardcoded-dark approach — see docs/claude-voice.md). No options here are secret (confirmed in
// apps.json), so unlike the OWUI chat app there's no /app-config fetch needed at all for config.
var Q = new URLSearchParams(location.search);
// This one page serves EVERY AI Voice backend: the page itself is served at /ai-voice, and every
// server route carries the page's backend as a sub-prefix (/ai-voice/<backend>/turn, ...), so
// requests bind to the right backend host no matter which page is on screen. Backend-specific
// strings (title, modes, models, approval wording) arrive as `meta` on the /state snapshot -- see
// applyMeta() -- so nothing backend-specific is hardcoded here beyond the claude-shaped fallbacks.
var BACKEND = Q.get('backend') || 'claude';
var BASE = '/' + (location.pathname.split('/')[1] || 'ai-voice') + '/' + BACKEND;
(function () {
  document.body.classList.toggle('light', Q.get('_dark') === '0');
  var a = Q.get('_accent') || '';
  if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
  // Contrast-safe foreground for text/icons sitting on the accent (user bubble, buttons, the
  // current-row highlights) -- runtime accents vary, and a dark one made the user's own message
  // unreadable against the fixed near-black text those rules used to hardcode. Same luminance
  // formula as meetingview.js's --accent-fg.
  var hex = /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#7CFFB2';
  var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.style.setProperty('--accent-fg', lum > 0.45 ? '#04120b' : '#f2f7fc');
})();

var projectDir = Q.get('projectDir') || '';
setProjectHeader(projectDir);   // rail label + the Settings overlay's Folder row value

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// Minimal, deliberately small renderer: escape everything, then recognize ```fenced code blocks```
// as copyable <pre><code> and everything else as plain paragraphs. Not a full markdown parser (see
// Phase 8 note in the plan for why: a real one means vendoring a library under this app's strict
// CSP, same as the VAD assets) -- but code/commands, the thing that actually needs to be selectable
// and copyable per the hard requirement, already render correctly with this.
function renderContent(text) {
  var parts = String(text || '').split(/```([\s\S]*?)```/);
  var html = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // fenced block — parts[i] may start with a language tag on its own first line; strip it for display
      var body = parts[i].replace(/^[ \t]*[A-Za-z0-9_+-]*\n/, '');
      html += '<div class="codeblock"><pre><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>' +
        '<button class="copybtn" type="button">Copy</button></div>';
    } else if (parts[i].trim()) {
      html += '<div>' + esc(parts[i]).replace(/\n/g, '<br>') + '</div>';
    }
  }
  return html || esc(text);
}

function wireCopyButtons(container) {
  container.querySelectorAll('.copybtn').forEach(function (btn) {
    btn.onclick = function () {
      var code = btn.previousElementSibling.querySelector('code');
      var text = code ? code.textContent : '';
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied'; btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      }).catch(function () {});
    };
  });
}

var transcript = [];   // [{role:'user'|'assistant', text}]
function renderTranscript() {
  var list = $('list'), empty = $('empty');
  empty.style.display = transcript.length ? 'none' : '';
  // The still-streaming entry keeps its data-live marker across full re-renders -- without this, a
  // message typed mid-reply destroyed the marker and the old reply's text froze on screen while
  // its generation quietly finished.
  list.innerHTML = transcript.map(function (m) {
    return '<div class="msg ' + m.role + '"' + (m === liveMsg ? ' data-live="1"' : '') + '><div class="bubble">' + renderContent(m.text) + '</div></div>';
  }).join('');
  wireCopyButtons(list);
  $('card').scrollTop = $('card').scrollHeight;
}

// Ring states the host (main.js) knows how to render — anything else (idle, error, ...) clears the
// override back to the user's normal theme-driven ring. Keep in sync with RING_STATES in main.js.
var RING_SIGNAL_STATES = { listening: 1, thinking: 1, speaking: 1, approval: 1 };
// Speech-only failure notice (TTS service down/off). Sticky: status changes don't wipe it -- it
// clears only when speech actually plays again or a new session starts. Without this, a dead TTS
// port was indistinguishable from "nothing to say".
var speechErrText = '';
function setStatus(status, errorText) {
  var el = $('status');
  el.textContent = (status || 'idle').toUpperCase();
  el.className = status === 'thinking' ? 'thinking' : status === 'listening' ? 'listening' :
    status === 'error' ? 'error' : status === 'approval' ? 'approval' : '';
  $('err').textContent = errorText || speechErrText || '';
  console.log('OQX_RING::' + (RING_SIGNAL_STATES[status] ? status : 'idle'));
}

// Real streaming: EventSource stays open for the life of the page, pushed by main.js as
// content_block_delta events arrive from the live claude process (see claudevoice-session.js).
// `liveMsg` is the in-progress assistant transcript entry -- created on 'assistant-start', appended
// to on every 'assistant-delta', finalized (and re-rendered once more with the authoritative text)
// on 'turn-complete'.
var liveMsg = null;
function updateLiveBubble() {
  var list = $('list');
  var row = list.querySelector('[data-live="1"]');
  if (!row) return;
  row.querySelector('.bubble').innerHTML = renderContent(liveMsg.text);
  wireCopyButtons(row);
  $('card').scrollTop = $('card').scrollHeight;
}
function connectEvents() {
  var es = new EventSource(BASE + '/events');
  es.onmessage = function (e) {
    var msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.type === 'assistant-start') {
      // Just a status change -- do NOT create a bubble yet. A turn emits message_start for every
      // internal message (tool calls, thinking), most of which never produce any text; creating a
      // bubble here left a trail of empty bars. The bubble appears on the first real text delta.
      setStatus('thinking');
    } else if (msg.type === 'assistant-delta') {
      if (!msg.text) return;
      if (!liveMsg) {
        liveMsg = { role: 'assistant', text: '' };
        transcript.push(liveMsg);
        $('empty').style.display = 'none';
        var row = document.createElement('div');
        row.className = 'msg assistant'; row.setAttribute('data-live', '1');
        row.innerHTML = '<div class="bubble"></div>';
        $('list').appendChild(row);
      }
      liveMsg.text += msg.text;
      updateLiveBubble();
      // Speech is NOT handled here anymore: the main process cuts sentences out of this same delta
      // stream itself and streams one continuous WAV per turn (see claudevoice-speech.js).
    } else if (msg.type === 'turn-complete') {
      var finalText = msg.text;
      if (liveMsg) {
        liveMsg.text = finalText || liveMsg.text;   // authoritative final text wins over accumulated deltas
        var row = $('list').querySelector('[data-live="1"]');
        if (row) row.removeAttribute('data-live');
        updateLiveBubbleFinal(row);
      } else if (finalText) {
        // No live bubble exists -- this turn never streamed (slash commands like /model or /context
        // come back only in the final result event), or the page loaded mid-turn. Render the result
        // as its own assistant message now instead of silently dropping it.
        transcript.push({ role: 'assistant', text: finalText });
        renderTranscript();
      }
      liveMsg = null;
      turnInProgress = false;
      // Speech: the server's per-turn stream keeps playing past turn-complete; when the audio is
      // still active its 'ended' event owns the status handoff back to listening/idle.
      if (msg.error) { stopTurnAudio(); setStatus('error', msg.error); }
      else if (!turnAudio) setStatus(conversationOpen ? 'listening' : 'idle');
    } else if (msg.type === 'error') {
      turnInProgress = false;
      stopTurnAudio();
      setStatus('error', msg.error);
    } else if (msg.type === 'approval-request') {
      showApprovalOverlay(msg.requestId, msg.toolName, msg.toolInput);
    } else if (msg.type === 'approval-decision' || msg.type === 'approval-timeout') {
      if (msg.requestId === pendingApprovalRequestId) hideApprovalOverlay();
    } else if (msg.type === 'panel-review') {
      showPanelReview(msg.panel);
    } else if (msg.type === 'panel-accepted') {
      setStatus(conversationOpen ? 'listening' : 'idle', 'Added "' + (msg.name || 'panel') + '".');
    } else if (msg.type === 'profile') {
      currentProfileId = msg.id || '';
      syncProfileUI();
    } else if (msg.type === 'permission-mode') {
      currentMode = msg.mode || currentMode;
      syncModeUI();
    } else if (msg.type === 'model') {
      liveModel = msg.model || '';   // what's ACTUALLY running, per the session/adapter
      syncPickButtons();
    } else if (msg.type === 'meta') {
      applyMeta(msg.meta);   // live refresh (e.g. codex model discovery finished after page load)
    } else if (msg.type === 'notice') {
      speechErrText = msg.text || '';   // same sticky status-line slot: plain-language guidance
      setStatus($('status').textContent.toLowerCase(), '');
    } else if (msg.type === 'speech-error') {
      speechErrText = msg.error || 'Speech failed.';
      setStatus($('status').textContent.toLowerCase(), '');   // repaint the status line with the sticky notice
    } else if (msg.type === 'turn-speech') {
      // A queued turn just started generating: its speech stream id arrives here rather than on
      // the POST /turn response (that turn was parked behind the previous one -- CLI semantics).
      // speakEnabled is re-checked HERE, not just at send time: a turn can be dispatched by a
      // routine tile (from main, which can't see this page's toggle) or queued behind another and
      // muted in between. The toggle wins in both cases.
      if (msg.speech && speakEnabled) startTurnAudio(msg.speech);
    } else if (msg.type === 'user-turn') {
      // A lazily-started session's session-started broadcast just wiped this page's transcript,
      // taking the freshly-drawn user bubble with it -- the host echoes the turn text back so the
      // first spoken instruction of a session stays visible.
      transcript.push({ role: 'user', text: msg.text });
      renderTranscript();
    } else if (msg.type === 'session-started') {
      // New session (folder switch or fresh start): new conversation, new header, silence.
      // The mode rides along -- the page-load snapshot predates a lazily-started session, so
      // without this the Mode button shows a stale default until the first manual switch.
      if (msg.permissionMode) { currentMode = msg.permissionMode; syncModeUI(); }
      speechErrText = '';
      stopTurnAudio();
      turnInProgress = false;
      transcript = [];
      liveMsg = null;
      renderTranscript();
      setProjectHeader(msg.projectDir);
      setStatus('idle');
    }
  };
  es.onerror = function () { /* EventSource auto-reconnects; nothing to do */ };
}

// ---- Touch approval overlay (Phase 7) ----
// Driven entirely by SSE: main.js's PreToolUse hook holds the tool call open and emits
// 'approval-request'; a tap here POSTs the decision, which resolves that same held-open hook
// response server-side. A reload while a request is in flight won't re-show this overlay (the
// current /claude-voice/state snapshot doesn't carry pending-request detail, only the status text) --
// same acknowledged limitation as the SSE transcript-replay gap noted above.
var pendingApprovalRequestId = null;
function renderApprovalDetail(toolName, toolInput) {
  toolInput = toolInput || {};
  var parts = [];
  var code = typeof toolInput.command === 'string' ? toolInput.command :
    typeof toolInput.content === 'string' ? toolInput.content :
    typeof toolInput.new_string === 'string' ? toolInput.new_string : null;
  if (code != null) parts.push('<pre class="approvalCode">' + esc(code) + '</pre>');
  var where = typeof toolInput.file_path === 'string' ? toolInput.file_path : typeof toolInput.path === 'string' ? toolInput.path : null;
  if (where) parts.push('<div class="approvalPath">in ' + esc(where) + '</div>');
  if (!parts.length) parts.push('<pre class="approvalCode">' + esc(JSON.stringify(toolInput, null, 2)) + '</pre>');
  return parts.join('');
}
function showApprovalOverlay(requestId, toolName, toolInput) {
  pendingApprovalRequestId = requestId;
  $('approvalTool').textContent = toolName || 'a tool';
  $('approvalDetail').innerHTML = renderApprovalDetail(toolName, toolInput);
  $('approvalOverlay').classList.remove('hidden');
  setStatus('approval');
}
function hideApprovalOverlay() {
  pendingApprovalRequestId = null;
  $('approvalOverlay').classList.add('hidden');
  setStatus('thinking');   // control is back with Claude -- it'll either keep working or ask again
}
function decideApproval(decision) {
  var requestId = pendingApprovalRequestId;
  if (!requestId) return;
  hideApprovalOverlay();
  fetch(BASE + '/approval-decision', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: requestId, decision: decision }),
  }).catch(function () { setStatus('error', 'Could not send the approval decision.'); });
}
$('approvalApprove').onclick = function () { decideApproval('allow'); };
$('approvalDeny').onclick = function () { decideApproval('deny'); };
$('approvalAlways').onclick = function () { decideApproval('always'); };   // approve + stop asking this session (meta-gated)
function updateLiveBubbleFinal(row) {
  if (!row || !liveMsg) return;
  row.querySelector('.bubble').innerHTML = renderContent(liveMsg.text);
  wireCopyButtons(row);
}
// Agent-specific strings and pick lists, delivered by the host on /state. The markup ships with
// claude-shaped fallbacks so the page still renders sensibly if the fetch fails; meta replaces
// them wholesale. Mode options are rebuilt as DOM (labels + descriptions differ per agent).
function applyMeta(meta) {
  if (!meta) return;
  if (meta.title) { $('title').textContent = meta.title; document.title = meta.title; }
  if (meta.approvalTitle) $('approvalTitle').textContent = meta.approvalTitle;
  if (meta.turnFailedText) turnFailedText = meta.turnFailedText;
  $('approvalAlways').classList.toggle('hidden', !meta.approvalAlways);   // only agents whose protocol supports session-wide approval
  // Chat-only backends (owui/api) have no working directory and no permission modes -- hide the
  // buttons instead of leaving dead claude-shaped controls on screen.
  // Chat backends (owui/api) have no working directory: hide the rail's folder-name line and the
  // Settings overlay's Folder row.
  $('project').classList.toggle('hidden', meta.hasProject === false);
  $('folderPickBtn').style.display = meta.hasProject === false ? 'none' : '';
  $('vpMode').classList.toggle('hidden', !(meta.modes && meta.modes.length));
  if (meta.modes && meta.modes.length) {
    MODE_LABELS = {};
    var wrap = $('modeOpts');
    wrap.innerHTML = '';
    meta.modes.forEach(function (m) {
      MODE_LABELS[m.id] = m.label;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'modeOpt';
      b.setAttribute('data-mode', m.id);
      b.textContent = m.label;
      if (m.desc) {
        var s = document.createElement('small');
        s.textContent = m.desc;
        b.appendChild(s);
      }
      wireModeOpt(b);
      wrap.appendChild(b);
    });
    syncModeUI();
  }
  if (meta.models && meta.models.length) {
    MODEL_PICKS = meta.models.map(function (m) { return [m.id, m.label]; });
    syncPickButtons();
  }
  if (meta.profiles) {
    PROFILES = meta.profiles;
    if (typeof meta.profile === 'string') currentProfileId = meta.profile;
    syncProfileUI();
  }
}
fetch(BASE + '/state', { cache: 'no-store' }).then(function (r) { return r.json(); })
  .then(function (s) {
    applyMeta(s.meta);
    // Replay the session's transcript (kept by main.js) -- the webview reloads this page on every
    // page switch, so without this a rotate-away-and-back would blank the whole conversation.
    if (s.transcript && s.transcript.length) { transcript = s.transcript.slice(); renderTranscript(); }
    if (s.permissionMode) { currentMode = s.permissionMode; syncModeUI(); }
    if (s.model) { liveModel = s.model; syncPickButtons(); }
    if (s.projectDir) setProjectHeader(s.projectDir);   // live truth beats the (possibly stale) page-load query param
    if (s.panel && s.panel.active) showPanelReview(s.panel);   // rotating away mid-review must not lose the proposal
    setStatus(s.status, s.error);
  }).catch(function () {});
connectEvents();

function autoGrow() {
  var ta = $('textInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}
$('textInput').addEventListener('input', autoGrow);

// Transient line under the transcript. Shares #err with real errors but drops the danger color for
// a confirmation, and clears itself -- the next setStatus would clear it anyway.
var routineNoticeT = null;
function routineNotice(text, ok) {
  var el = $('err');
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
  clearTimeout(routineNoticeT);
  routineNoticeT = setTimeout(function () { el.classList.remove('ok'); el.textContent = speechErrText || ''; }, 4000);
}

// "+ Routine": keep this request for a tile. Sends the message field if there's anything in it,
// otherwise the host falls back to the last request that was actually sent -- so "speak it, watch
// it work, keep it" is one tap. Naming happens on the host (no keyboard here); the generated name
// comes back for the confirmation.
$('routineBtn').onclick = function () {
  var btn = $('routineBtn');
  btn.disabled = true;
  fetch(BASE + '/routine-save', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: $('textInput').value.trim() }),
  }).then(function (r) { return r.json(); })
    .then(function (r) {
      if (r && r.ok) routineNotice('Saved routine: ' + r.name, true);
      else routineNotice((r && r.error) || 'Could not save that routine.', false);
    })
    .catch(function () { routineNotice('Could not reach the panel server.', false); })
    .finally(function () { btn.disabled = false; });
};

var turnInProgress = false;   // a sent turn hasn't seen its turn-complete yet (drives status after audio ends early)
var turnFailedText = 'Turn failed to send — no project set, or claude CLI not found.';   // meta can override per agent
function sendText(text) {
  if (!text) return;
  transcript.push({ role: 'user', text: text });
  renderTranscript();
  turnInProgress = true;
  $('sendBtn').disabled = true;
  fetch(BASE + '/turn', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    // `speak` is decided HERE, per turn, by the SPEAKER toggle alone -- mic and speaker are fully
    // independent (mic off + speaker on = type questions, hear the answers; explicitly required).
    // Tying it to the turn server-side means one turn finishing can never silence a queued next
    // turn's speech (the old lastTurnWasVoice-clobber bug).
    body: JSON.stringify({ text: text, speak: !!speakEnabled }),
  }).then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r || !r.ok) { turnInProgress = false; setStatus('error', turnFailedText); return; }
      if (r.speech) startTurnAudio(r.speech);
    })
    .catch(function () { turnInProgress = false; setStatus('error', 'Could not reach the panel server.'); })
    .finally(function () { $('sendBtn').disabled = false; });
}
function send() {
  var ta = $('textInput');
  var text = ta.value.trim();
  if (!text) return;
  ta.value = ''; autoGrow();
  sendText(text);
}
$('sendBtn').onclick = send;
$('textInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// Speaks `text` via the configured wyoming-piper. Test-speech button ONLY now -- real replies
// stream through the per-turn pipeline below. The server sanitizes the text for speech itself.
// `suppressVAD` is held true for the duration of playback so the mic doesn't hear Claude's own
// voice through the speakers and mistake it for the next user utterance (a real feedback-loop risk
// in a fully hands-free loop -- there's no headset here, just the panel's own mic and speaker).
var suppressVAD = false;
function speak(text, onDone) {
  if (!text) { if (onDone) onDone(); return; }
  stopTurnAudio();   // the Test button supersedes any in-flight turn speech -- never two streams
  suppressVAD = true;
  setStatus('speaking');
  $('spkBtn').classList.add('pulsing');
  var finish = function (errMsg) {
    suppressVAD = false;
    $('spkBtn').classList.remove('pulsing');
    setStatus(conversationOpen ? 'listening' : 'idle', errMsg || '');
    if (onDone) onDone();
  };
  // POST the text first and play by id: reply text can be many KB, far beyond what a GET query
  // string survives (oversized request lines got rejected server-side before any handler ran --
  // the "sometimes replies just aren't spoken" bug). Failures surface in the status line now
  // instead of dying silently.
  fetch(BASE + '/tts', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text }),
  }).then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r || !r.ok || !r.id) { finish('Speech failed to start.'); return; }
      var audio = new Audio(BASE + '/tts-audio?id=' + encodeURIComponent(r.id));
      audio.addEventListener('ended', function () { finish(); });
      audio.addEventListener('error', function () { finish('Speech playback failed.'); });
      applySinkId(audio);
      audio.play().catch(function () { finish('Speech playback failed.'); });
    })
    .catch(function () { finish('Speech failed to start.'); });
}
$('ttsTestBtn').onclick = function () {
  var last = transcript.slice().reverse().find(function (m) { return m.role === 'assistant'; });
  // Match the saved speaker label first (may not have happened yet if no conversation was opened
  // this page load) so the test actually plays on the picked device.
  ensureDeviceIds().then(function () { speak(last ? last.text : 'No reply yet to test with.'); });
};

// ---- Turn speech (v2 -- the user's own architecture, task #26) ----
// ALL speech logic lives in the MAIN process now (claudevoice-speech.js): it cuts sentences out of
// the same delta stream this page renders, sanitizes them for the speaker, synthesizes serially,
// and streams ONE continuous WAV per turn. This page just plays a single <audio> element per voice
// turn -- overlap is structurally impossible, and there are no page-side queues or watchdogs left
// to orphan. Dropping the element's stream (mute, folder switch, page unload) is itself the abort
// signal the server acts on; no separate stop request exists or is needed.
var turnAudio = null;   // the current voice turn's <audio>, or null
function endSpeechUI(errMsg) {
  suppressVAD = false;
  $('spkBtn').classList.remove('pulsing');
  setStatus(turnInProgress ? 'thinking' : conversationOpen ? 'listening' : 'idle', errMsg || '');
}
function stopTurnAudio() {
  if (!turnAudio) return;
  var a = turnAudio;
  turnAudio = null;
  try { a.pause(); } catch (e) {}
  try { a.removeAttribute('src'); a.load(); } catch (e) {}   // closes the HTTP stream -> server aborts synthesis
  endSpeechUI();
}
function startTurnAudio(turnId) {
  stopTurnAudio();
  var a = turnAudio = new Audio(BASE + '/turn-audio?turn=' + encodeURIComponent(turnId));
  var done = function () {   // ended and error land in the same place: release the mic, settle status
    if (turnAudio !== a) return;
    turnAudio = null;
    endSpeechUI();
  };
  a.addEventListener('playing', function () {
    if (turnAudio !== a) return;
    speechErrText = '';   // speech audibly works again -- retire the sticky TTS-failure notice
    suppressVAD = true;   // the mic must never hear Claude's own voice through the speaker
    setStatus('speaking');
    $('spkBtn').classList.add('pulsing');
  });
  a.addEventListener('ended', done);
  a.addEventListener('error', done);
  applySinkId(a);   // route to the picked speaker (no-op on system default)
  a.play().catch(done);
}

// ---- Audio device pickers (Settings overlay) ----
// Picks persist server-side as LABELS ('' = system default) because Chromium salts deviceIds per
// origin and this page's origin (port) changes every app launch -- an id would never match twice.
// Labels only become visible after a getUserMedia grant in this session, so enumeration runs
// lazily (conversation open, settings open, Test speech) via a momentary mic grab that is closed
// again immediately.
var savedMicLabel = Q.get('micDevice') || '';
var savedSpkLabel = Q.get('spkDevice') || '';
var micDeviceId = '', spkDeviceId = '';
var allDevices = [];
var devicesReady = false;
function matchDevices() {
  var mic = allDevices.find(function (d) { return d.kind === 'audioinput' && d.label === savedMicLabel; });
  var spk = allDevices.find(function (d) { return d.kind === 'audiooutput' && d.label === savedSpkLabel; });
  micDeviceId = mic ? mic.deviceId : '';   // saved device missing -> system default (never a hard fail)
  spkDeviceId = spk ? spk.deviceId : '';
}
function ensureDeviceIds(force) {
  if (devicesReady && !force) return Promise.resolve();
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      tmp.getTracks().forEach(function (t) { t.stop(); });
      allDevices = devs || [];
      matchDevices();
      devicesReady = true;
    });
  }).catch(function () {
    // No mic permission/hardware: carry on with system defaults. A real mic failure still
    // surfaces where it matters -- vad.start() reports it on the status line.
    allDevices = [];
    matchDevices();
    devicesReady = true;
  });
}
function applySinkId(audio) {
  if (spkDeviceId && audio.setSinkId) audio.setSinkId(spkDeviceId).catch(function () {});
}
// Model picker state: the pick is an alias ('' = account default) persisted like the device
// labels; `liveModel` is the model ACTUALLY running, reported by the session's init event.
var MODEL_PICKS = [['', 'Default (account setting)'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
var savedModelPick = Q.get('modelPick') || '';
var liveModel = '';
function modelPrettyName(id) {   // 'claude-sonnet-5' -> 'Sonnet' (best-effort; falls back to the raw id)
  var m = MODEL_PICKS.find(function (p) { return p[0] && String(id || '').indexOf(p[0]) >= 0; });
  return m ? m[1] : (id || '');
}
// Settings shows only the CURRENT pick per row (big row, tap to change); the actual list lives
// in its own full-size overlay -- never an always-visible scrolling list inside a dialog.
function syncPickButtons() {
  $('micPickVal').textContent = savedMicLabel || 'System default';
  $('spkPickVal').textContent = savedSpkLabel || 'System default';
  var pick = MODEL_PICKS.find(function (p) { return p[0] === savedModelPick; });
  var label = savedModelPick ? (pick ? pick[1] : savedModelPick) : 'Default';
  if (!savedModelPick && liveModel) label = 'Default — ' + modelPrettyName(liveModel);
  $('modelPickVal').textContent = label;
}
var devOverlayKind = '';   // 'audioinput' | 'audiooutput' | 'model' while the picker overlay is open
function renderDevOverlay() {
  var kind = devOverlayKind;
  var el = $('devList');
  el.innerHTML = '';
  function addRow(label, value, current) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'devRow' + (current ? ' current' : '');
    b.textContent = label;
    b.title = label;
    b.onclick = function () { pickDevice(kind, value); };
    el.appendChild(b);
  }
  if (kind === 'model') {
    MODEL_PICKS.forEach(function (p) { addRow(p[1], p[0], p[0] === savedModelPick); });
    return;
  }
  var savedLabel = kind === 'audioinput' ? savedMicLabel : savedSpkLabel;
  var devs = allDevices.filter(function (d) { return d.kind === kind && d.label; });
  var matched = !!savedLabel && devs.some(function (d) { return d.label === savedLabel; });
  addRow('System default', '', !matched);
  devs.forEach(function (d) { addRow(d.label, d.label, matched && d.label === savedLabel); });
}
function openDevOverlay(kind) {
  devOverlayKind = kind;
  $('devTitle').textContent = kind === 'audioinput' ? 'Microphone' : kind === 'audiooutput' ? 'Speaker' : 'Model';
  renderDevOverlay();                                  // cached entries paint instantly...
  if (kind !== 'model') {                              // (the model list is static -- no mic grab)
    ensureDeviceIds(true).then(function () {           // ...then a fresh enumeration replaces them
      if (devOverlayKind === kind) renderDevOverlay();
    });
  }
  $('devOverlay').classList.remove('hidden');
}
function pickDevice(kind, label) {
  $('devOverlay').classList.add('hidden');
  devOverlayKind = '';
  if (kind === 'model') {
    savedModelPick = label;
    postOption('modelPick', label);   // persists; also what a fresh session start reads
    // Live session: resume-restart onto the new model (same trick as the Mode button, ~2s pause).
    fetch(BASE + '/model', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: label }),
    }).then(function (r) { return r.json(); })
      .then(function (r) { if (!r || !r.ok) setStatus(conversationOpen ? 'listening' : 'idle', 'Model switch failed.'); })
      .catch(function () { setStatus('error', 'Could not reach the panel server.'); });
    syncPickButtons();
    return;
  }
  if (kind === 'audioinput') {
    savedMicLabel = label;
    postOption('micDevice', label);
    matchDevices();
    if (conversationOpen && vad) {   // live conversation: reopen the mic on the new device now
      vad.stop();
      vad.setInputDevice(micDeviceId);
      vad.start(onVADSpeechStart, onVADSpeechEnd, onVADLevel).catch(function (e) {
        setStatus('error', 'Microphone switch failed: ' + (e && e.message ? e.message : e));
      });
    }
  } else {
    savedSpkLabel = label;
    postOption('spkDevice', label);
    matchDevices();
    if (turnAudio) applySinkId(turnAudio);   // mid-reply switch moves the voice immediately
  }
  syncPickButtons();
}
$('micPickBtn').onclick = function () { openDevOverlay('audioinput'); };
$('spkPickBtn').onclick = function () { openDevOverlay('audiooutput'); };
$('modelPickBtn').onclick = function () { openDevOverlay('model'); };
$('devCancel').onclick = function () { $('devOverlay').classList.add('hidden'); devOverlayKind = ''; };

// ---- Tap-to-toggle voice conversation (Phase 5) ----
// Explicitly NOT push-to-talk: one tap opens a continuous conversation (VAD detects each utterance's
// start/end on its own, no holding anything down), a second tap closes it. See the plan's hard
// constraint #4 -- push-to-talk was explicitly rejected.
var conversationOpen = false;
var vadHangoverMs = parseInt(Q.get('vadHangoverMs'), 10) || 400;   // 0.4s default — snappier out of the box (matches LucidType)
var vad = window.createClaudeVoiceVAD ? window.createClaudeVoiceVAD({ hangoverMs: vadHangoverMs }) : null;
function onVADSpeechStart() {
  if (suppressVAD) return;
  setStatus('listening');
}
function onVADSpeechEnd(pcm16) {
  if (suppressVAD) return;
  setStatus('thinking');
  fetch(BASE + '/audio', { method: 'POST', cache: 'no-store', body: pcm16.buffer })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      // Re-check AFTER the async STT round trip: if speech started playing while this was in
      // flight, the utterance may have caught the speaker's first words -- drop it, never
      // ghost-send it as a turn.
      if (suppressVAD) return;
      if (r && r.ok && r.text && r.text.trim()) { sendText(r.text.trim()); }
      else { setStatus(conversationOpen ? 'listening' : 'idle', r && r.error); }
    })
    .catch(function () { setStatus('error', 'Transcription request failed.'); });
}
window.oqxToggleConversation = function () {
  if (!vad) { $('textInput').focus(); return; }   // VAD script failed to load -- fall back to at least focusing input
  if (conversationOpen) {
    conversationOpen = false;
    vad.stop();
    setStatus('idle');
  } else {
    conversationOpen = true;
    setStatus('listening');
    ensureDeviceIds().then(function () {
      if (!conversationOpen) return;   // toggled back off while devices were enumerating
      vad.setInputDevice(micDeviceId);
      return vad.start(onVADSpeechStart, onVADSpeechEnd, onVADLevel);
    }).catch(function (e) {
      conversationOpen = false;
      syncMicUI();
      setStatus('error', 'Microphone access failed: ' + (e && e.message ? e.message : e));
    });
  }
  syncMicUI();
};

// ---- Voice panel (right side): mic + speaker icon toggles, ripples, Project/Settings ----
// The mic icon IS the listening toggle (same action as the knob tap) -- crossed out when off,
// rippling outward when it hears sound. The speaker icon gates the spoken read-back of replies
// (text always renders either way) -- crossed out when off, pulsing while actually speaking.
function syncMicUI() {
  $('micBtn').classList.toggle('on', conversationOpen);
  $('micBtn').classList.toggle('off', !conversationOpen);
}
var speakEnabled = localStorage.getItem('cvSpeakEnabled') !== '0';   // persists across page switches/reloads
function syncSpkUI() {
  $('spkBtn').classList.toggle('on', speakEnabled);
  $('spkBtn').classList.toggle('off', !speakEnabled);
}
$('micBtn').onclick = function () { window.oqxToggleConversation(); };
$('spkBtn').onclick = function () {
  speakEnabled = !speakEnabled;
  localStorage.setItem('cvSpeakEnabled', speakEnabled ? '1' : '0');
  if (!speakEnabled) stopTurnAudio();   // muting mid-reply drops the stream; the server aborts synthesis on the socket close
  syncSpkUI();
};
// Ripples: spawn one expanding ring per level sample above the ripple floor, throttled so a
// sustained voice reads as a steady outward pulse rather than a solid blob.
var lastRippleAt = 0;
function onVADLevel(level) {
  if (!conversationOpen || suppressVAD) return;
  var now = Date.now();
  if (level < 0.012 || now - lastRippleAt < 180) return;
  lastRippleAt = now;
  var r = document.createElement('div');
  r.className = 'ripple';
  $('micRipples').appendChild(r);
  r.addEventListener('animationend', function () { r.remove(); });
}
// ---- Change folder overlay ----
// ("Folder", not "project" -- Claude has its own "projects" concept, so the panel never uses that
// word for directories.) Picks restart the session in the chosen directory (fresh conversation; the
// old session file stays resumable from a terminal). One flowing wall of pill chips: recent folders
// first (accent border), then everything under the root alphabetically; the current folder is the
// single solid accent-filled pill.
function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }
function setProjectHeader(dir) {
  $('project').textContent = dir ? baseName(dir) : '(no folder set)';
  $('folderPickVal').textContent = dir ? baseName(dir) : 'not set';
}
var projRoot = '';
function pickProject(dir) {
  $('projectOverlay').classList.add('hidden');
  setStatus('thinking', '');
  fetch(BASE + '/session/start', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: dir }),
  }).then(function (r) { return r.json(); })
    .then(function (r) { if (!r || !r.ok) setStatus('error', 'Could not start a session in ' + dir); })
    .catch(function () { setStatus('error', 'Could not reach the panel server.'); });
}
// Loads (or reloads) the overlay listing `browsePath` -- omitted on first open, so the server
// falls back to the page's configured root. Tapping folders (rows or Recent chips) only NAVIGATES
// -- into the folder, ⬆ Up back out -- and the overlay stays open; the single commit action is
// "Use this folder", which starts a session at whatever level is being browsed (the standard
// mobile folder-picker pattern, chosen explicitly by the user 2026-08-12).
function openProjectOverlay(browsePath) {
  var url = BASE + '/projects' + (browsePath ? '?path=' + encodeURIComponent(browsePath) : '');
  fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (p) {
      projRoot = p.root || '';
      $('projPath').textContent = projRoot;
      $('projUp').disabled = !p.parent;
      $('projUp').onclick = function () { if (p.parent) openProjectOverlay(p.parent); };
      $('projUse').onclick = function () { pickProject(projRoot); };
      // Recent row: chips COMMIT -- one tap starts a session in that folder and closes the menu
      // (that's the whole point of recents). Only the main list navigates.
      var recentsRow = $('projRecentsRow');
      recentsRow.querySelectorAll('.projChip').forEach(function (c) { c.remove(); });
      var pathEl = $('projPath');
      (p.recents || []).slice(0, 5).forEach(function (dir) {
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'projChip';
        chip.textContent = baseName(dir); chip.title = dir;
        chip.onclick = function () { pickProject(dir); };
        recentsRow.insertBefore(chip, pathEl);
      });
      // Folder taps NAVIGATE into the folder (so sub-folders are reachable); only the
      // "Use this folder" button actually starts a session, at whatever level is being browsed.
      $('projList').innerHTML = '';
      (p.dirs || []).forEach(function (dir) {
        var row = document.createElement('div');
        row.className = 'projRow' + (dir === p.current ? ' current' : '');
        var name = document.createElement('button');
        name.type = 'button'; name.className = 'projName';
        name.textContent = baseName(dir); name.title = dir;
        name.onclick = function () { openProjectOverlay(dir); };
        row.appendChild(name);
        $('projList').appendChild(row);
      });
      $('projNewName').value = '';
      $('projectOverlay').classList.remove('hidden');
    })
    .catch(function () { setStatus('error', 'Could not load the folder list.'); });
}
// ▲/▼ page buttons for scroll regions -- replaced the custom drag-thumb, which only registered
// ~1 in 5 finger drags on the real panel. Tap = one page; hold = keeps paging every 400ms.
function wireScrollButtons(listId, upId, downId) {
  var list = $(listId);
  function step(dir) { list.scrollBy({ top: dir * list.clientHeight * 0.9, behavior: 'smooth' }); }
  [[upId, -1], [downId, 1]].forEach(function (pair) {
    var btn = $(pair[0]);
    var repeat = null;
    btn.addEventListener('pointerdown', function (e) {
      btn.setPointerCapture(e.pointerId);
      step(pair[1]);
      repeat = setInterval(function () { step(pair[1]); }, 400);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      btn.addEventListener(ev, function () { clearInterval(repeat); repeat = null; });
    });
  });
}
wireScrollButtons('projList', 'projScrollUp', 'projScrollDown');
wireScrollButtons('devList', 'devScrollUp', 'devScrollDown');
// Folder lives in Settings (rarely changed) — the row closes Settings and opens the folder picker.
$('folderPickBtn').onclick = function () { $('settingsOverlay').classList.add('hidden'); openProjectOverlay(); };
$('projCancel').onclick = function () { $('projectOverlay').classList.add('hidden'); };
$('projCreate').onclick = function () {
  var name = $('projNewName').value.trim();
  if (!name || !projRoot) return;
  if (/[<>:"|?*\\/]/.test(name)) { setStatus(conversationOpen ? 'listening' : 'idle', 'Folder names can\'t contain < > : " | ? * \\ /'); return; }
  pickProject(projRoot.replace(/[\\/]+$/, '') + '\\' + name);
};
$('vpSettings').onclick = function () {
  syncPickButtons();   // labels come from saved options -- no mic grab needed just to open Settings
  $('settingsOverlay').classList.remove('hidden');
};
$('settingsClose').onclick = function () { $('settingsOverlay').classList.add('hidden'); };

// ---- Panel-tunable settings (persisted server-side into the page's options in config.json) ----
function postOption(key, value) {
  fetch(BASE + '/option', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: key, value: String(value) }),
  }).catch(function () {});
}
// Chat text size: applies live via the --chatFont CSS var (bubbles only; chrome is unaffected).
var chatFontSize = parseInt(Q.get('chatFontSize'), 10) || 16;
function applyChatFont() {
  chatFontSize = Math.max(12, Math.min(32, chatFontSize));
  document.documentElement.style.setProperty('--chatFont', chatFontSize + 'px');
  $('fontVal').textContent = chatFontSize + ' px';
}
$('fontMinus').onclick = function () { chatFontSize -= 1; applyChatFont(); postOption('chatFontSize', chatFontSize); };
$('fontPlus').onclick = function () { chatFontSize += 1; applyChatFont(); postOption('chatFontSize', chatFontSize); };
// Voice pause tolerance: how long a mid-sentence silence can last before the utterance is sent.
function applyPause() {
  vadHangoverMs = Math.max(400, Math.min(2500, vadHangoverMs));
  if (vad && vad.setHangoverMs) vad.setHangoverMs(vadHangoverMs);
  $('pauseVal').textContent = (vadHangoverMs / 1000).toFixed(1) + ' s';
}
$('pauseMinus').onclick = function () { vadHangoverMs -= 100; applyPause(); postOption('vadHangoverMs', vadHangoverMs); };
$('pausePlus').onclick = function () { vadHangoverMs += 100; applyPause(); postOption('vadHangoverMs', vadHangoverMs); };
applyChatFont();
applyPause();

// ---- Permission mode (Mode button + overlay) ----
// Switching restarts the claude process with --resume + the new --permission-mode (mode is a
// launch-only CLI flag; the mid-session control message is undocumented/unsupported). The
// conversation itself carries over -- expect a ~2s pause before the next turn responds.
// ---- AI profile (Smart Profiles): big-card grid picker, list delivered via meta ----
var PROFILES = [];            // [{id, name}] from meta.profiles
var currentProfileId = '';
function syncProfileUI() {
  var cur = null;
  for (var i = 0; i < PROFILES.length; i++) if (PROFILES[i].id === currentProfileId) cur = PROFILES[i];
  $('vpProfile').textContent = cur ? 'Profile: ' + cur.name : 'Profile';
  $('vpProfile').classList.toggle('hidden', !PROFILES.length);
  document.querySelectorAll('.profileOpt').forEach(function (b) {
    b.classList.toggle('current', b.getAttribute('data-profile') === currentProfileId);
  });
}
function renderProfileGrid() {
  var grid = $('profileGrid');
  grid.innerHTML = '';
  PROFILES.forEach(function (p) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'profileOpt';
    b.setAttribute('data-profile', p.id);
    b.textContent = p.name;
    b.onclick = function () {
      $('profileOverlay').classList.add('hidden');
      if (p.id === currentProfileId) return;
      fetch(BASE + '/profile', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id }),
      }).then(function (r) { return r.json(); })
        .then(function (r) { if (!r || !r.ok) setStatus(conversationOpen ? 'listening' : 'idle', 'Profile switch failed.'); })
        .catch(function () { setStatus('error', 'Could not reach the panel server.'); });
    };
    grid.appendChild(b);
  });
  syncProfileUI();
}
$('vpProfile').onclick = function () { renderProfileGrid(); $('profileOverlay').classList.remove('hidden'); };
$('profileCancel').onclick = function () { $('profileOverlay').classList.add('hidden'); };

// ---- Panel Builder review ----
// The Panel Builder profile makes the AI answer with a page rather than prose. The host validates it
// and pushes it here; this draws it as real tiles so what the user sees is what gets saved. Nothing
// reaches the config until Accept — and a panel containing shell/AutoHotkey steps shows the actual
// commands and needs a second, informed yes.
var panelRiskyPending = false;   // true once the risky commands are on screen awaiting confirmation

function showPanelReview(p) {
  var ov = $('panelOverlay');
  if (!p || !p.active) { ov.classList.add('hidden'); panelRiskyPending = false; return; }
  panelRiskyPending = false;
  var warn = $('panelWarn'), risky = $('panelRisky'), grid = $('panelPreview');
  grid.innerHTML = '';

  if (p.status === 'error' || !p.page) {
    $('panelTitle').textContent = "That panel didn't work";
    $('panelNote').textContent = p.error || '';
    risky.classList.add('hidden');
    warn.classList.add('hidden');
    $('panelAccept').style.display = 'none';
    ov.classList.remove('hidden');
    return;
  }

  var page = p.page;
  var used = 0;
  for (var i = 0; i < page.tiles.length; i++) if (page.tiles[i].type) used++;
  $('panelTitle').textContent = page.name;
  $('panelNote').textContent = used + (used === 1 ? ' button' : ' buttons') + ' · ' + page.cols + '×' + page.rows;
  // After a panel has been accepted, the next proposal in the same conversation is almost always a
  // FIX of it ("the tab-1 button does nothing"), so Replace leads and Accept becomes "Add as new".
  var rep = $('panelReplace');
  $('panelAccept').style.display = '';
  if (p.replaces) {
    rep.classList.remove('hidden');
    rep.textContent = 'Replace ' + (p.replaces.name.length > 18 ? p.replaces.name.slice(0, 17) + '…' : p.replaces.name);
    $('panelAccept').textContent = 'Add as new';
    $('panelAccept').classList.add('secondary');
  } else {
    rep.classList.add('hidden');
    $('panelAccept').textContent = 'Accept';
    $('panelAccept').classList.remove('secondary');
  }

  var riskyIdx = {};
  (p.risky || []).forEach(function (r) { riskyIdx[r.index] = true; });
  grid.style.gridTemplateColumns = 'repeat(' + page.cols + ', 1fr)';
  grid.style.gridTemplateRows = 'repeat(' + page.rows + ', 1fr)';
  grid.style.aspectRatio = page.cols + ' / ' + page.rows;   // square cells, like the real panel
  page.tiles.forEach(function (t, idx) {
    var d = document.createElement('div');
    d.className = 'pvTile' + (t.type ? '' : ' empty') + (riskyIdx[idx] ? ' risk' : '');
    if (t.type) {
      var ic = document.createElement('div');
      ic.className = 'pvIcon';
      ic.textContent = t.icon || '▫️';
      var lb = document.createElement('div');
      lb.className = 'pvLabel';
      lb.textContent = t.label || '';
      d.appendChild(ic); d.appendChild(lb);
    }
    grid.appendChild(d);
  });

  if (p.warnings && p.warnings.length) {
    warn.textContent = '· ' + p.warnings.join('; ');
    warn.title = p.warnings.join('\n');       // the header truncates; the full list stays reachable
    warn.classList.remove('hidden');
  } else warn.classList.add('hidden');
  risky.classList.add('hidden');
  ov.classList.remove('hidden');
}

// Second stage for a panel that would run commands: show exactly what runs before asking again.
function showPanelRisky(list) {
  var risky = $('panelRisky');
  risky.innerHTML = '';
  var head = document.createElement('div');
  head.textContent = 'This panel runs commands on your PC. Accept only if you recognize them:';
  risky.appendChild(head);
  list.forEach(function (r) {
    var line = document.createElement('div');
    line.textContent = '• ' + (r.label || 'unnamed') + ' (' + r.type + ')';
    var code = document.createElement('code');
    code.textContent = r.command;
    line.appendChild(code);
    risky.appendChild(line);
  });
  risky.classList.remove('hidden');
  $('panelAccept').textContent = 'Run these — Accept';
  panelRiskyPending = true;
}

function sendPanelAccept(replace) {
  fetch(BASE + '/panel-accept', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: panelRiskyPending, replace: !!replace }),
  }).then(function (r) { return r.json(); })
    .then(function (r) {
      if (r && r.ok) { $('panelOverlay').classList.add('hidden'); panelRiskyPending = false; return; }
      if (r && r.needsConfirm) { panelReplacePending = !!replace; return showPanelRisky(r.risky || []); }
      setStatus(conversationOpen ? 'listening' : 'idle', (r && r.error) || 'That panel could not be added.');
    })
    .catch(function () { setStatus('error', 'Could not reach the panel server.'); });
}
var panelReplacePending = false;   // which button opened the consent stage, so the second yes matches it
$('panelAccept').onclick = function () { sendPanelAccept(panelRiskyPending ? panelReplacePending : false); };
$('panelReplace').onclick = function () { panelReplacePending = true; sendPanelAccept(true); };
$('panelRetry').onclick = function () {
  // Refinement is just the next thing you say — the session still has the context, so a new reply
  // supersedes this proposal. Close the overlay and reopen the mic.
  $('panelOverlay').classList.add('hidden');
  panelRiskyPending = false;
  if (!conversationOpen && window.oqxToggleConversation) window.oqxToggleConversation();
};
$('panelCancel').onclick = function () {
  $('panelOverlay').classList.add('hidden');
  panelRiskyPending = false;
  fetch(BASE + '/panel-cancel', { method: 'POST', cache: 'no-store' }).catch(function () {});
};

var MODE_LABELS = { manual: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', bypassPermissions: 'Full auto' };
var currentMode = '';
function syncModeUI() {
  $('vpMode').textContent = currentMode ? 'Mode: ' + (MODE_LABELS[currentMode] || currentMode) : 'Mode';
  document.querySelectorAll('.modeOpt').forEach(function (b) {
    b.classList.toggle('current', b.getAttribute('data-mode') === currentMode);
  });
}
$('vpMode').onclick = function () { syncModeUI(); $('modeOverlay').classList.remove('hidden'); };
$('modeCancel').onclick = function () { $('modeOverlay').classList.add('hidden'); };
// One wiring path for both the markup's fallback buttons and the meta-built ones (applyMeta).
function wireModeOpt(btn) {
  btn.onclick = function () {
    var mode = btn.getAttribute('data-mode');
    $('modeOverlay').classList.add('hidden');
    if (!mode || mode === currentMode) return;
    fetch(BASE + '/permission-mode', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode }),
    }).then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.ok) setStatus(conversationOpen ? 'listening' : 'idle', 'Mode switch failed — is a session running yet? (Send a message first.)');
      })
      .catch(function () { setStatus('error', 'Could not reach the panel server.'); });
  };
}
document.querySelectorAll('.modeOpt').forEach(wireModeOpt);

syncMicUI();
syncSpkUI();
syncModeUI();
syncPickButtons();
