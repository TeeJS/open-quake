'use strict';

// Transcript analysis: feeds a processed transcript JSON plus the shared prompt
// (meeting-analysis-prompt.md) to the configured Analysis AI — Claude (`claude -p`), ChatGPT
// Codex (`codex exec`), GitHub Copilot (`copilot --acp`, one-shot ACP session — see
// copilotvoice-session.js's runCopilotBatchPrompt), or Open WebUI (HTTP chat completion against
// the Auth-tab connection, see runOwui) — and writes the returned markdown next to the transcript
// as <basename>.md. One job at a time, no queue: analysis takes seconds-to-minutes and the panel
// disables the button while running.
//
// The three CLIs authenticate themselves; the OWUI backend uses the shared settings.owui
// credentials (apiKey encrypted at rest by secretStore). Every backend is tool-free for analysis
// — transcripts are untrusted third-party speech, so nothing they say may reach a shell: the CLIs
// run with tools denied/absent and OWUI is a plain completion API with no tools at all.
// Deps are injected for tests: resolveFolders, resolveAi, resolveOwui, spawn, fs, prompt path, clock.

const path = require('path');
const os = require('os');
const { safeRelPath } = require('./meetingLibrary');
const { runCopilotBatchPrompt } = require('./copilotvoice-session');
const owuiClientMod = require('./owuiClient');
const joplinNotesMod = require('./joplinNotes');

const ANALYZE_TIMEOUT_MS = 10 * 60 * 1000;   // generous; a transcript is small but CLIs cold-start

// Analysis markdown lives beside the transcript, named after the recording: the raw diarizer
// response is <base>-diarizer-response.json (legacy plain <base>.json still accepted), the
// analysis is <base>-analysis.md — matching the naming T.J.'s pre-existing pipeline used, which
// other services key off.
function mdPathFor(jsonPath) {
  return jsonPath.replace(/-diarizer-response\.json$/i, '.json').replace(/\.json$/i, '-analysis.md');
}
// With "Use Details Folder" on, the transcript lives in <home>/details/ while the analysis .md
// belongs at <home>/ — write (and read) the .md one level up when the transcript sits in details.
function mdTargetFor(jsonPath) {
  const p = mdPathFor(jsonPath);
  const dir = path.dirname(p);
  return path.basename(dir).toLowerCase() === 'details' ? path.join(path.dirname(dir), path.basename(p)) : p;
}
// Recurring-meeting folder names, sanitized exactly like the OpenHiNotes pipeline: illegal chars
// and whitespace become hyphens, runs collapse, edges trimmed.
function sanitizeSubjectFolder(subject) {
  let s = String(subject || '');
  for (const c of '/\\:*?"<>|') s = s.split(c).join('-');
  s = s.split(/\s+/).filter(Boolean).join('-');
  while (s.includes('--')) s = s.split('--').join('-');
  return s.replace(/^-+|-+$/g, '');
}

// Mid-meeting highlights → a prompt block, or null when the recording has none. The spans are
// stored as ms offsets from the recording's start; the diarizer reports segment start/end as float
// SECONDS from the same origin (docs/meetings-api.md), so converting here means the model compares
// like with like. mm:ss labels ride along so a human reading the notes can find the moment.
//
// The instruction to emit a Highlights section lives HERE and not only in meeting-analysis-prompt.md
// because main prefers the user's editable copy of that file when one exists — anyone who ever
// customized their prompt would otherwise silently never get the section.
function highlightsBlock(metaText) {
  if (!metaText) return null;
  let spans;
  try { spans = (JSON.parse(metaText) || {}).highlights; } catch (e) { return null; }
  if (!Array.isArray(spans) || !spans.length) return null;
  const clock = ms => {
    const t = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  };
  const rows = spans
    .filter(h => h && Number.isFinite(h.startMs) && Number.isFinite(h.endMs) && h.endMs > h.startMs)
    .map((h, i) => '  ' + (i + 1) + '. ' + clock(h.startMs) + '–' + clock(h.endMs) +
      '  (seconds ' + (h.startMs / 1000).toFixed(1) + '–' + (h.endMs / 1000).toFixed(1) + ')');
  if (!rows.length) return null;
  return '\n\nHighlighted moments follow. During the meeting the user flagged these spans as worth\n' +
    'calling out. Times are seconds from the start of the recording — the same origin as the\n' +
    "diarizer's segment start/end, so match each span against the segments it covers.\n\n" +
    rows.join('\n') +
    '\n\nBecause this input is present, add a "## Highlights" section to the document, placed\n' +
    'immediately after ## Summary. Give one bullet per span, in order, saying what was actually\n' +
    'being discussed there and why it matters, attributed by name, with the mm:ss span in\n' +
    'parentheses. Cover every span. If a span holds nothing substantive, say so plainly rather\n' +
    'than inventing content. Highlights supplement the other sections — a decision or action item\n' +
    'inside a highlighted span still belongs in Decisions or Action Items as well.';
}

// Slim a diarizer response down to `Speaker: text` lines for the OWUI backend — local models
// can't afford the raw JSON's timestamps, speaker_report, and cluster scores (~3-4x the tokens).
// Consecutive segments from the same speaker merge into one line. Unparseable or segment-less
// JSON THROWS: silently analyzing a raw blob the model can't fit would produce a confidently
// wrong summary, and that must never look like success.
// `stamps` prefixes each merged turn with its [m:ss] start — dead weight normally, but highlights
// need something to align to, so the OWUI path turns them on for those runs only.
function slimTranscript(transcriptJson, stamps) {
  let obj;
  try { obj = JSON.parse(transcriptJson); } catch (e) { throw new Error('transcript is not valid JSON: ' + e.message); }
  const segs = obj && Array.isArray(obj.segments) ? obj.segments : null;
  if (!segs) throw new Error('transcript has no segments array');
  const merged = [];
  for (const s of segs) {
    if (!s || typeof s !== 'object') continue;
    const text = String(s.text || '').trim();
    if (!text) continue;
    const speaker = String(s.speaker || '').trim() || 'UNKNOWN';
    if (merged.length && merged[merged.length - 1].speaker === speaker) merged[merged.length - 1].text += ' ' + text;
    else merged.push({ speaker, text, start: Number.isFinite(s.start) ? s.start : null });
  }
  if (!merged.length) throw new Error('transcript has no spoken segments');
  return merged.map(l => (stamps && l.start !== null ? '[' + clockSec(l.start) + '] ' : '') + l.speaker + ': ' + l.text).join('\n');
}

// m:ss from float seconds — the diarizer's unit for segment start/end (docs/meetings-api.md).
function clockSec(sec) {
  const t = Math.max(0, Math.round(sec));
  const m = Math.floor(t / 60), s = t % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function createMeetingAnalyzer(deps) {
  const fsMod = deps.fs || require('fs');
  const fsp = fsMod.promises;
  const spawnImpl = deps.spawn || require('child_process').spawn;
  const resolveFolders = deps.resolveFolders;        // () => { unprocessed, processed }
  const resolveAi = deps.resolveAi;                  // () => 'claude' | 'codex' | 'copilot' | 'owui'
  const resolveOwui = deps.resolveOwui || (() => ({}));   // () => { url, apiKey, model } (settings.owui)
  const owuiClient = deps.owuiClient || owuiClientMod;
  const findClaudeExe = deps.findClaudeExe || require('./claudevoice-session').findClaudeExe;
  const findCodexExe = deps.findCodexExe || require('./codexvoice-session').findCodexExe;
  const findCopilotExe = deps.findCopilotExe || require('./copilotvoice-session').findCopilotExe;
  // promptPath may be a function (main.js prefers the user's editable copy in userData over the
  // bundled template) or a fixed string (tests).
  const promptPath = deps.promptPath || path.join(__dirname, 'meeting-analysis-prompt.md');
  const resolvePromptPath = () => (typeof promptPath === 'function' ? promptPath() : promptPath);
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs || ANALYZE_TIMEOUT_MS;
  // () => { separateRecurring, separateTranscript, useDetailsFolder } — the Advanced filing options.
  const filingOptions = deps.filingOptions || (() => ({}));
  // () => { enabled, folder } — post-analysis batch task lists ('' folder = <processed>/task-list).
  const resolveTaskList = deps.resolveTaskList || (() => ({}));
  // () => { enabled, url, token, notebook } — post-analysis Joplin notes (settings.meeting).
  const resolveJoplin = deps.resolveJoplin || (() => ({}));
  const joplinNotes = deps.joplinNotes || joplinNotesMod;
  const batchDone = [];   // successful analyses in the current batch, flushed to a task list on drain

  const queue = [];      // names waiting (supports the panel's Analyze Selected)
  let running = null;    // { name, ai, startedAt } while a job runs
  let lastError = null;  // { name, error, finishedAt }
  let lastDone = null;   // { name, finishedAt }
  let lastJoplin = null; // { name, ok, error?, applied?, skipped?, finishedAt } for the panel

  function getState() {
    return {
      ok: true,
      running: !!running,
      name: running ? running.name : null,
      startedAt: running ? running.startedAt : null,
      queue: queue.slice(),
      error: lastError,
      lastDone,
      joplin: lastJoplin,
    };
  }

  function start(name) {
    const n = safeRelPath(name);
    if (!n || !/\.json$/i.test(n)) return { ok: false, error: 'bad name' };
    if ((running && running.name === n) || queue.includes(n)) return { ok: false, error: 'already queued' };
    if (!fsMod.existsSync(path.join(resolveFolders().processed, n))) return { ok: false, error: 'not found' };
    queue.push(n);
    pump();
    return Object.assign({}, getState());
  }

  function pump() {
    if (running || !queue.length) return;
    const n = queue.shift();
    const processed = resolveFolders().processed;
    const jsonPath = path.join(processed, n);
    const aiSetting = resolveAi();
    const ai = aiSetting === 'codex' ? 'codex' : aiSetting === 'copilot' ? 'copilot' : aiSetting === 'owui' ? 'owui' : 'claude';
    running = { name: n, ai, startedAt: now() };
    log('analysis started (' + ai + '): ' + n);
    runJob(n, ai, jsonPath)
      .then(() => { lastDone = { name: n, finishedAt: now() }; lastError = null; log('analysis done: ' + n); })
      .catch(e => { lastError = { name: n, error: (e && e.message) || 'failed', finishedAt: now() }; log('analysis failed: ' + n + ' — ' + lastError.error); })
      .finally(() => {
        running = null;
        if (!queue.length) flushTaskList();   // batch drained — write the post-analysis task list
        pump();
      });
  }

  async function runJob(name, ai, jsonPath) {
    const opts = filingOptions() || {};
    const mdPath = mdTargetFor(jsonPath);
    const prompt = await fsp.readFile(resolvePromptPath(), 'utf8');
    const transcript = await fsp.readFile(jsonPath, 'utf8');
    const dir = path.dirname(jsonPath);
    const base = path.basename(jsonPath).replace(/-diarizer-response\.json$/i, '').replace(/\.json$/i, '');

    // Companion speaker-identity sources, when the recording produced them: the calendar
    // meeting-info sidecar (<base>.json — subject/organizer/attendees) and a Teams live-caption
    // .vtt (per-account attribution, far more reliable than voice clustering). Both are optional
    // extras for the prompt's identity rules — a read failure never blocks the analysis.
    let metaText = null, vttText = null;
    try {
      const sidecar = path.join(dir, base + '.json');
      // legacy plain <base>.json transcripts make the sidecar path the transcript itself — skip
      if (sidecar !== jsonPath && fsMod.existsSync(sidecar)) metaText = await fsp.readFile(sidecar, 'utf8');
    } catch (e) { log('meeting-info sidecar unreadable: ' + e.message); }
    try {
      const vttPath = findCompanionVtt(dir, base);
      if (vttPath) { vttText = await fsp.readFile(vttPath, 'utf8'); log('companion VTT found: ' + path.basename(vttPath)); }
    } catch (e) { log('companion VTT unreadable: ' + e.message); }
    // Mid-meeting highlights ride inside that same sidecar (meetingHighlights writes them there).
    const hlText = highlightsBlock(metaText);

    // The CLI trio gets the raw diarizer JSON in one combined prompt (big context windows),
    // plus the metadata and VTT when present; OWUI gets the prompt as the system message and a
    // slimmed Speaker: text transcript (+ the small metadata) as the user message — local models
    // can't afford the raw JSON's 3-4x token overhead, and a whole VTT even less.
    let markdown;
    if (ai === 'owui') {
      markdown = await runOwui({ prompt, transcriptJson: transcript, metaText, hlText });
    } else {
      const input = prompt
        + (metaText ? '\n\nMeeting metadata JSON follows (calendar info — subject, organizer, attendees):\n\n' + metaText : '')
        + (vttText ? '\n\nTeams live-caption VTT transcript follows (speaker-identity aid only — never a replacement for the diarizer text):\n\n' + vttText : '')
        + (hlText || '')
        + '\n\nDiarizer JSON follows:\n\n' + transcript;
      markdown = ai === 'codex' ? await runCodex(input) : ai === 'copilot' ? await runCopilot(input) : await runClaude(input);
    }
    if (!markdown.trim()) throw new Error('AI returned no output');

    // "Separate Clean Transcript": split the AI's output at the ## Transcript heading — notes
    // stay in the .md, the cleaned transcript goes to <base>-clean_transcript.txt. A custom
    // prompt without that heading keeps the combined output (logged, never lost).
    let mdOut = markdown;
    let txtPath = null;
    if (opts.separateTranscript) {
      const m = /^##\s*Transcript\s*$/im.exec(markdown);
      if (m) {
        mdOut = markdown.slice(0, m.index).trimEnd() + '\n';
        const txt = markdown.slice(m.index + m[0].length).trim() + '\n';
        txtPath = path.join(dir, base + '-clean_transcript.txt');
        await fsp.writeFile(txtPath, txt);
      } else {
        log('no "## Transcript" heading in the AI output — keeping the combined .md');
      }
    }
    const tmp = mdPath + '.tmp';
    await fsp.writeFile(tmp, mdOut);
    await fsp.rename(tmp, mdPath);

    const filed = await fileSet(jsonPath, mdPath, txtPath, base, opts);
    if (filed) batchDone.push({ base, md: filed.md, sidecar: filed.sidecar, meta: filed.meta });
    await createJoplinNote(base, mdOut);
  }

  // Post-analysis Joplin note (replaces the retired Cowork pipeline's note step). The body is the
  // analysis markdown — with "Separate Clean Transcript" on that's the notes without the
  // transcript, matching what the old pipeline filed. A Joplin failure never fails the analysis
  // (the .md is already saved); it's logged and surfaced on the panel via getState().joplin.
  async function createJoplinNote(base, markdown) {
    const cfg = resolveJoplin() || {};
    if (!cfg.enabled) return;
    try {
      const r = await joplinNotes.createAnalysisNote({
        url: cfg.url, token: cfg.token, notebook: cfg.notebook, title: base, body: markdown,
      });
      lastJoplin = { name: base, ok: true, applied: r.applied, skipped: r.skipped, finishedAt: now() };
      log('joplin note created: ' + base + ' [' + r.applied.join(', ') + ']'
        + (r.skipped.length ? ' — tag(s) not in Joplin, skipped: ' + r.skipped.join(', ') : ''));
    } catch (e) {
      lastJoplin = { name: base, ok: false, error: (e && e.message) || 'failed', finishedAt: now() };
      log('joplin note failed: ' + base + ' — ' + lastJoplin.error);
    }
  }

  // Locate the Teams .vtt shipped alongside the diarizer JSON. Exact <base>.vtt first; Teams
  // sometimes swaps a separator in the shared date/time prefix (observed: "_" where the JSON has
  // "-"), so fall back to the single .vtt whose normalized 19-char stamp prefix matches. Two
  // ambiguous candidates → none (never guess which meeting a caption file belongs to).
  function findCompanionVtt(dir, base) {
    const exact = path.join(dir, base + '.vtt');
    if (fsMod.existsSync(exact)) return exact;
    const stamp = s => String(s).slice(0, 19).replace(/[_]/g, '-');
    if (!/^\d{4}/.test(base)) return null;   // no leading date stamp — nothing safe to match on
    let found = null;
    let names;
    try { names = fsMod.readdirSync(dir); } catch (e) { return null; }
    for (const f of names) {
      if (!/\.vtt$/i.test(f)) continue;
      if (stamp(f) !== stamp(base)) continue;
      if (found) return null;
      found = path.join(dir, f);
    }
    return found;
  }

  // Post-analysis filing: recurring meetings move to <processed>/YYYY/<Meeting-Name>/, and with
  // "Use Details Folder" everything except the .md tucks into a details/ subfolder. Runs after
  // the .md exists so unanalyzed meetings always stay in the easy-to-find date folders.
  async function fileSet(jsonPath, mdPath, txtPath, base, opts) {
    const dir = path.dirname(jsonPath);
    const inDetails = path.basename(dir).toLowerCase() === 'details';
    let home = inDetails ? path.dirname(dir) : dir;

    // Meeting-info sidecar (when the calendar integration wrote one): drives the recurring-folder
    // decision and feeds the batch task list's title/organizer.
    let meta = null;
    try {
      const sidecar = path.join(dir, base + '.json');
      if (fsMod.existsSync(sidecar)) meta = JSON.parse(await fsp.readFile(sidecar, 'utf8')) || null;
    } catch (e) { log('meeting-info sidecar unreadable: ' + e.message); }

    if (opts.separateRecurring && meta) {
      const folderName = sanitizeSubjectFolder(meta.subject);
      if (meta.is_recurring && folderName) {
        const ym = /^(\d{4})/.exec(base);
        const year = ym ? ym[1] : String(new Date(now()).getFullYear());
        home = path.join(resolveFolders().processed, year, folderName);
      }
    }
    const fileDir = opts.useDetailsFolder ? path.join(home, 'details') : home;

    const mv = async (src, dest) => {
      if (!src || src === dest || !fsMod.existsSync(src)) return;
      if (fsMod.existsSync(dest)) { log('filing skipped (exists): ' + path.basename(dest)); return; }
      try { await fsp.rename(src, dest); }
      catch (e) { await fsp.copyFile(src, dest); await fsp.unlink(src); }
    };
    // The slide-capture folder (<base>-screenshots\) travels with the WAV — same target dir, recursive.
    const mvDir = async (src, dest) => {
      if (!src || src === dest || !fsMod.existsSync(src)) return;
      if (fsMod.existsSync(dest)) { log('filing skipped (exists): ' + path.basename(dest)); return; }
      try { await fsp.rename(src, dest); }
      catch (e) { await fsp.cp(src, dest, { recursive: true }); await fsp.rm(src, { recursive: true, force: true }); }
    };
    try {
      await fsp.mkdir(fileDir, { recursive: true });
      await mv(mdPath, path.join(home, path.basename(mdPath)));
      await mv(jsonPath, path.join(fileDir, path.basename(jsonPath)));
      await mv(path.join(dir, base + '.wav'), path.join(fileDir, base + '.wav'));
      await mv(path.join(dir, base + '.json'), path.join(fileDir, base + '.json'));
      await mv(txtPath, txtPath ? path.join(fileDir, path.basename(txtPath)) : null);
      const vtt = findCompanionVtt(dir, base);   // Teams captions travel with the WAV
      if (vtt) await mv(vtt, path.join(fileDir, path.basename(vtt)));
      await mvDir(path.join(dir, base + '-screenshots'), path.join(fileDir, base + '-screenshots'));
    } catch (e) { log('filing failed (analysis itself is saved): ' + e.message); }
    return {
      md: path.join(home, path.basename(mdPath)),
      sidecar: meta ? path.join(fileDir, base + '.json') : null,
      meta,
    };
  }

  // "Create task-lists for post-analysis processing": one checklist per analysis batch, written
  // when the queue drains — the hand-off T.J.'s kanban ingestion picks up. Mirrors the old
  // diarizer-batch format but points at the finished -analysis.md files. Only successful analyses
  // are listed; failures stay visible on the panel instead.
  function pad2(n) { return String(n).padStart(2, '0'); }
  async function flushTaskList() {
    const items = batchDone.splice(0);
    const cfg = resolveTaskList() || {};
    if (!cfg.enabled || !items.length) return;
    try {
      const processed = resolveFolders().processed;
      const folder = String(cfg.folder || '').trim() || path.join(processed, 'task-list');
      await fsp.mkdir(folder, { recursive: true });
      const d = new Date(now());
      const stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        + '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
      const rel = p => path.relative(processed, p).split(path.sep).join('/');
      const lines = [
        '# Analysis batch — ' + stamp.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2'),
        '',
        items.length + ' meeting(s) analyzed. Paths below are relative to the meetings root. For each item, review the Action Items in the analysis and pick up the ones assigned to you.',
        '',
        '## Meetings',
        '',
      ];
      for (const it of items) {
        const title = (it.meta && String(it.meta.subject || '').trim()) || it.base;
        const tags = it.meta
          ? (it.meta.is_recurring ? ' (recurring)' : '') + (it.meta.organizer ? ' — ' + it.meta.organizer : '')
          : '';
        lines.push('- [ ] **' + title + '**' + tags);
        lines.push('    - Analysis: `' + rel(it.md) + '`');
        if (it.sidecar && fsMod.existsSync(it.sidecar)) lines.push('    - Meeting metadata: `' + rel(it.sidecar) + '`');
      }
      lines.push('');
      let dest = path.join(folder, stamp + '.md');
      for (let i = 1; fsMod.existsSync(dest); i++) dest = path.join(folder, stamp + '_' + i + '.md');
      await fsp.writeFile(dest, lines.join('\n'));
      log('task list written: ' + dest + ' (' + items.length + ' meeting(s))');
    } catch (e) { log('task-list write failed: ' + e.message); }
  }

  function runClaude(input) {
    const exe = findClaudeExe();
    if (!exe) return Promise.reject(new Error('Claude CLI not found on PATH'));
    // `claude -p` with no positional prompt reads the whole prompt from stdin; response on stdout.
    return runProc(exe, ['-p'], input, false).then(r => r.stdout);
  }

  async function runCodex(input) {
    if (!findCodexExe()) throw new Error('Codex CLI not found on PATH');
    // codex exec: `-` = read instructions from stdin; --output-last-message captures just the final
    // reply (stdout carries progress noise); --skip-git-repo-check because the processed folder is
    // not a repo. shell:true because npm's codex shim is a .cmd on Windows (codexvoice-session:249).
    const outFile = path.join(os.tmpdir(), 'oqx-analysis-' + now() + '.md');
    try {
      await runProc('"' + findCodexExe() + '"', ['exec', '-', '--skip-git-repo-check', '--output-last-message', outFile], input, true);
      return await fsp.readFile(outFile, 'utf8');
    } finally {
      try { await fsp.unlink(outFile); } catch (e) {}
    }
  }

  function runCopilot(input) {
    const exe = findCopilotExe();
    if (!exe) return Promise.reject(new Error('Copilot CLI not found on PATH'));
    // Copilot has no plain -p-to-stdout mode -- it's an ACP JSON-RPC session (see
    // copilotvoice-session.js's runCopilotBatchPrompt), not a runProc-shaped stdin/stdout CLI.
    return runCopilotBatchPrompt({ text: input, timeoutMs, log, spawn: spawnImpl, exe });
  }

  // Open WebUI analysis: one non-streaming chat completion against the shared Auth-tab
  // connection (settings.owui). The analysis prompt rides as the system message, the slimmed
  // transcript as the user message. Every failure maps to a wording that names the fix.
  async function runOwui({ prompt, transcriptJson, metaText, hlText }) {
    const cfg = resolveOwui() || {};
    const ep = owuiClient.normalizeOwuiUrl(cfg.url);
    if (!ep) throw new Error("Open WebUI is not configured — set the URL on the editor's Auth tab");
    const model = String(cfg.model || '').trim();
    if (!model) throw new Error("no Open WebUI model set — pick a default model on the editor's Auth tab");
    const slim = slimTranscript(transcriptJson, !!hlText);   // highlights need turn timestamps to align to
    const body = {
      model,
      stream: false,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content:
          (metaText ? 'Meeting metadata JSON follows (calendar info — subject, organizer, attendees):\n\n' + metaText + '\n\n' : '')
          + (hlText ? hlText.trim() + '\n\n' : '')
          + 'Transcript follows' + (hlText ? ' (each turn prefixed with its [m:ss] start)' : '') + ':\n\n' + slim },
      ],
    };
    let res;
    try { res = await owuiClient.postJson(ep.chatUrl, body, String(cfg.apiKey || ''), timeoutMs); }
    catch (e) {
      const msg = String((e && e.message) || 'request failed');
      if (/no response after/.test(msg)) throw new Error('Open WebUI timed out after ' + Math.round(timeoutMs / 60000) + ' min');
      throw new Error('could not reach Open WebUI (' + msg + ') — is Open WebUI running?');
    }
    if (res.status === 401 || res.status === 403) throw new Error('Open WebUI rejected the API key (HTTP ' + res.status + ') — check the key on the Auth tab');
    if (res.status !== 200) throw new Error('Open WebUI error (HTTP ' + res.status + ')' + (res.text ? ': ' + String(res.text).slice(0, 300) : ''));
    let obj;
    try { obj = JSON.parse(res.text); } catch (e) { throw new Error('Open WebUI returned an unparseable response'); }
    // Some OWUI failures come back as 200 with an { error } body — treat those as errors too.
    if (obj && obj.error) throw new Error('Open WebUI error: ' + String((obj.error && obj.error.message) || obj.error).slice(0, 300));
    const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (choice && choice.finish_reason === 'length') {
      throw new Error("the model's context window is too small for this meeting — pick a larger-context model on the Auth tab");
    }
    const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
    if (!content.trim()) throw new Error('Open WebUI returned no output');
    return content;
  }

  function runProc(cmd, args, stdinText, shell) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawnImpl(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: !!shell });
      } catch (e) { return reject(new Error('spawn failed: ' + e.message)); }
      let out = '', err = '', settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch (e) {}
        reject(new Error('timed out after ' + Math.round(timeoutMs / 60000) + ' min'));
      }, timeoutMs);
      const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });
      proc.on('error', e => finish(reject, new Error('spawn failed: ' + e.message)));
      proc.on('close', code => {
        if (code === 0) finish(resolve, { stdout: out });
        else finish(reject, new Error('exited ' + code + (err.trim() ? ': ' + err.trim().slice(0, 300) : '')));
      });
      proc.stdin.on('error', () => {});   // EPIPE if the CLI dies early — close handler reports it
      proc.stdin.end(stdinText);
    });
  }

  // Read a finished analysis for the panel's View action. The .md may live beside the transcript
  // or (details layout) one folder up; legacy plain <base>.md still accepted.
  function result(name) {
    const n = safeRelPath(name);
    if (!n) return { ok: false, error: 'bad name' };
    const jsonAbs = path.join(resolveFolders().processed, n).replace(/\.md$/i, '.json');
    for (const p of [mdTargetFor(jsonAbs), mdPathFor(jsonAbs), mdPathFor(jsonAbs).replace(/-analysis\.md$/i, '.md')]) {
      try { return { ok: true, markdown: fsMod.readFileSync(p, 'utf8') }; } catch (e) { /* next */ }
    }
    return { ok: false, error: 'not analyzed' };
  }

  return { start, getState, result };
}

module.exports = { createMeetingAnalyzer, slimTranscript, highlightsBlock };
